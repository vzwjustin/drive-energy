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
});

console.log(`\n${pass} passed`);
