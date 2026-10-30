// Run: node tests/decode.test.js
const assert = require("assert");
const D = require("../decode.js");
const { createSim } = require("../sim.js");
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("ok -", name); };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

t("bits/setBits round-trip, signed and unsigned", () => {
  const b = [0, 0, 0, 0, 0, 0, 0, 0];
  D.setBits(b, 16, 16, -1234); assert.strictEqual(D.bits(b, 16, 16, true), -1234);
  D.setBits(b, 44, 11, 1500); assert.strictEqual(D.bits(b, 44, 11), 1500);
  D.setBits(b, 0, 32, 4000000000); assert.strictEqual(D.bits(b, 0, 32), 4000000000);
});

t("parseLine accepts STN monitor lines and rejects noise", () => {
  assert.deepStrictEqual(D.parseLine("132 A0 8C"), { id: 0x132, bytes: [0xA0, 0x8C] });
  assert.strictEqual(D.parseLine("BUFFER FULL"), null);
  assert.strictEqual(D.parseLine("STOPPED"), null);
  assert.strictEqual(D.parseLine("132ABC"), null); // odd nibble count
});

t("0x132 pack voltage/current/power (discharge positive)", () => {
  const dec = D.createDecoder(), b = new Array(8).fill(0);
  D.setBits(b, 0, 16, 35210); D.setBits(b, 16, 16, -500); // 352.10 V, raw -500 * -0.1 = +50 A
  dec.decode(0x132, b);
  near(dec.state.packV, 352.1, 1e-9, "V"); near(dec.state.packA, 50, 1e-9, "A"); near(dec.state.powerKW, 17.605, 1e-6, "kW");
});

t("0x352 pre-2021 layout", () => {
  const dec = D.createDecoder(), b = new Array(8).fill(0);
  D.setBits(b, 0, 11, 559); D.setBits(b, 11, 11, 412); D.setBits(b, 55, 8, 17);
  dec.decode(0x352, b);
  assert.strictEqual(dec.meta.fmt352, "old");
  near(dec.state.fullPackKWh, 55.9, 1e-9, "full"); near(dec.state.energyRemainingKWh, 41.2, 1e-9, "rem"); near(dec.state.bufferKWh, 1.7, 1e-9, "buf");
});

t("0x352 2021+ muxed layout is detected and decoded", () => {
  const dec = D.createDecoder();
  const m0 = new Array(8).fill(0); m0[0] = 0; D.setBits(m0, 16, 16, 55.9 / 0.02); D.setBits(m0, 32, 16, 41.2 / 0.02);
  const m1 = new Array(8).fill(0); m1[0] = 1; D.setBits(m1, 16, 16, 170); D.setBits(m1, 15, 1, 1);
  dec.decode(0x352, m0); dec.decode(0x352, m1); dec.decode(0x352, m0);
  assert.strictEqual(dec.meta.fmt352, "new");
  near(dec.state.fullPackKWh, 55.9, 0.02, "full"); near(dec.state.energyRemainingKWh, 41.2, 0.02, "rem");
  near(dec.state.bufferKWh, 1.7, 1e-9, "buf"); assert.strictEqual(dec.state.fullChargeComplete, true);
});

t("0x401 brick voltages land at mux*3+k", () => {
  const dec = D.createDecoder(), b = new Array(8).fill(0);
  b[0] = 12; D.setBits(b, 16, 16, 33050); D.setBits(b, 32, 16, 33040); D.setBits(b, 48, 16, 30760);
  dec.decode(0x401, b);
  near(dec.state.bricks[36], 3.305, 1e-9, "b36"); near(dec.state.bricks[38], 3.076, 1e-9, "b38");
});

t("0x118 accelerator pedal, brake, gear", () => {
  const dec = D.createDecoder(), b = new Array(8).fill(0);
  D.setBits(b, 32, 8, 63); D.setBits(b, 19, 2, 1); D.setBits(b, 21, 3, 4);
  dec.decode(0x118, b);
  near(dec.state.pedalPct, 25.2, 1e-9, "pedal"); assert.strictEqual(dec.state.brakeOn, true); assert.strictEqual(dec.state.gear, "D");
  D.setBits(b, 32, 8, 255); dec.decode(0x118, b); assert.strictEqual(dec.state.pedalPct, null);
});

t("grade, ambient temp, compressor power", () => {
  const dec = D.createDecoder();
  let b = new Array(8).fill(0); D.setBits(b, 33, 7, -4); dec.decode(0x267, b); assert.strictEqual(dec.state.gradePct, -4);
  b = new Array(8).fill(0); D.setBits(b, 40, 8, (21.5 + 40) / 0.5); dec.decode(0x321, b); near(dec.state.outsideC, 21.5, 1e-9, "ambient");
  b = new Array(8).fill(0); D.setBits(b, 21, 11, 123); dec.decode(0x2A8, b); near(dec.state.compressorKW, 1.23, 1e-9, "cmpd");
});

t("coach: pedal zones match EcoLab (15–40%, 1% hysteresis, uphill exemption)", () => {
  const C = require("../coach.js");
  assert.strictEqual(C.rawZone(1), "OFF"); assert.strictEqual(C.rawZone(10), "LIGHT"); assert.strictEqual(C.rawZone(30), "RIGHT"); assert.strictEqual(C.rawZone(45), "TOO_MUCH");
  assert.strictEqual(C.pedalZone(40.5, 1, 0, "RIGHT"), "RIGHT");        // within hysteresis of the 40% edge
  assert.strictEqual(C.pedalZone(41.5, 1, 0, "RIGHT"), "TOO_MUCH");
  assert.strictEqual(C.pedalZone(55, 0.1, 4, null), "RIGHT");           // holding speed uphill
});

t("coach: cues follow EcoLab priorities", () => {
  const C = require("../coach.js");
  const base = { pedal: 0, kw: -40, mph: 40, brake: false, soc: 60, tMin: 25, tMax: 27, hvacKw: 0.5, regenLimitKw: 42, accelMs2: -1, grade: 0, outsideC: 20 };
  assert.strictEqual(C.cues(base)[0].kind, "pedal.regenAtLimit");
  assert.strictEqual(C.cues({ ...base, kw: 30, pedal: 55, accelMs2: 0.5 })[0].kind, "pedal.heavy");
  assert.strictEqual(C.cues({ ...base, kw: 45, pedal: 55, tMin: 5 })[0].kind, "pack.coldDraw");   // WARN sorts first
  const br = C.cues({ ...base, brake: true, kw: 2, pedal: 0 }).map(q => q.kind);   // EcoLab order: GOOD before TIP
  assert.ok(br.includes("brake.friction") && br.indexOf("pedal.coast") < br.indexOf("brake.friction"));
  const l = C.cues({ ...base, mph: 0 }); assert.strictEqual(l[l.length - 1].kind, "coast");
});

t("odometer, totals, speed", () => {
  const dec = D.createDecoder();
  let b = new Array(4).fill(0); D.setBits(b, 0, 32, 56013.123 / 0.001); dec.decode(0x3B6, b);
  near(dec.state.odoMi, 56013.123 / 1.609344, 1e-6, "odo");
  b = new Array(8).fill(0); D.setBits(b, 0, 32, 9100123); D.setBits(b, 32, 32, 6400456); dec.decode(0x3D2, b);
  near(dec.state.totalOutKWh, 9100.123, 1e-9, "out"); near(dec.state.totalInKWh, 6400.456, 1e-9, "in");
  b = new Array(8).fill(0); D.setBits(b, 12, 12, (100 + 40) / 0.08); dec.decode(0x257, b);
  near(dec.state.speedMph, 100 / 1.609344, 0.06, "mph");
});

t("simulator → parser → decoder end to end", () => {
  const sim = createSim(), dec = D.createDecoder();
  let n = 0;
  for (let i = 0; i < 20 * 120; i++) for (const l of sim.step(0.05)) { const f = D.parseLine(l); assert.ok(f, "parse " + l); dec.decode(f.id, f.bytes); n++; }
  const s = dec.state;
  assert.ok(n > 5000, "frames");
  assert.ok(s.speedMph > 20, "moving after 2 min: " + s.speedMph);
  assert.ok(s.packV > 300 && s.packV < 400, "voltage");
  assert.strictEqual(dec.meta.fmt352, "new");
  assert.ok(s.bricks.every(v => v > 3 && v < 3.6), "all 108 bricks present");
  assert.ok(s.pedalPct >= 0 && s.pedalPct <= 100 && s.gear === "D", "pedal + gear decoded");
});

t("drives: segment ends after 20 s in P and summarizes deltas", () => {
  const Dr = require("../drives.js");
  const saved = []; const d = Dr.createDrives({ load: () => [], save: h => saved.push(h.length) });
  let x = { odo: 100, mph: 0, gear: "P", drive: 5, park: 1, regen: 2, climateKWh: 0.5, heavy: 1, friction: 0, pressedSec: 0, rightSec: 0, rated: 220, sweetBand: 55 };
  assert.strictEqual(d.update(x, 1, 0), null);
  let out = null, t0 = 1;
  for (let i = 0; i < 600; i++) {               // 10 min at 60 mph, 230 Wh/mi, pedal 80% in range
    x = { ...x, mph: 60, gear: "D", odo: x.odo + 60 / 3600, drive: x.drive + 0.23 * 60 / 3600, regen: x.regen + 0.0002, pressedSec: x.pressedSec + 1, rightSec: x.rightSec + 0.8 };
    out = d.update(x, 1, t0 + i) || out;
  }
  assert.ok(d.active && !out);
  for (let i = 0; i < 25; i++) out = d.update({ ...x, mph: 0, gear: "P" }, 1, 700 + i) || out;
  assert.ok(out && !d.active);
  near(out.mi, 10, 0.02, "mi"); near(out.wh, 230, 1, "wh"); assert.strictEqual(out.pedalPct, 80);
  assert.strictEqual(out.vsRatedPct, 5); near(out.rangeDeltaMi, 10 - 2300 / 220, 0.05, "range delta");
  assert.strictEqual(out.score, Dr.score(out.wh, 220, 80)); assert.strictEqual(out.cruiseBand, 60);
  assert.strictEqual(saved.length, 1);
});

t("drives: habit picks the biggest issue", () => {
  const Dr = require("../drives.js");
  assert.ok(/Lift off earlier/.test(Dr.habit({ friction: 4, heavy: 5, pedalPct: 40 }).text));
  assert.ok(/Speeding up took 40%/.test(Dr.habit({ friction: 0, heavy: 1, pedalPct: 80, accelKWh: 0.4, cruiseKWh: 0.6 }).text));
  assert.ok(/Ease take-offs/.test(Dr.habit({ friction: 0, heavy: 5, pedalPct: 40 }).text));
  assert.ok(/60–64 mph/.test(Dr.habit({ friction: 0, heavy: 0, pedalPct: 80, cruiseBand: 70, sweetBand: 60 }).text));
  assert.strictEqual(Dr.habit({ friction: 0, heavy: 0, pedalPct: 85, vsRatedPct: -3 }).tone, "good");
});

t("drives: clean() rebuilds an imported drive from numbers only", () => {
  const Dr = require("../drives.js");
  const d = Dr.clean({ t0: 5, mi: 10, kwh: 2.3, wh: 230, rated: 220, pedalPct: 80, heavy: "<b>", habit: { tone: "x\" onclick=\"y", text: "<img src=x onerror=alert(1)>" }, id: "<i>", score: "<s>" });
  assert.strictEqual(d.id, "5"); assert.strictEqual(d.heavy, 0); assert.strictEqual(d.score, Dr.score(230, 220, 80));
  assert.deepStrictEqual(d.habit, Dr.habit(d)); assert.ok(!/[<>"]/.test(d.habit.text + d.habit.tone));
  assert.strictEqual(Dr.clean({ t0: 5, mi: "10", kwh: 2, wh: 200 }), null);     // required numbers must be numbers
  assert.strictEqual(Dr.clean({ t0: 5, mi: 0, kwh: 0, wh: 0 }), null);
});

t("stops: regen capture of a slowdown from 50 to 0 mph", () => {
  const S = require("../stops.js"), st = S.createStops();
  let out = null, mph = 50;
  for (let i = 0; i < 5; i++) st.update({ mph, kw: 10 }, 1);                  // cruising
  const k = S.kineticKWh(50, 0);
  for (let i = 0; i < 50; i++) { mph = Math.max(0, mph - 1); out = st.update({ mph, kw: -(0.65 * k * 3600) / 50, brake: false }, 1) || out; }
  assert.ok(out && out.stop); assert.ok(Math.abs(out.pct - 65) <= 2, "capture " + out.pct); assert.strictEqual(out.tone, "good");
  assert.ok(Math.abs(st.avg() - 65) <= 2);
});

console.log(`\n${pass} passed`);
