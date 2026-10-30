// Run: node tests/app.test.js — boots the real app.js on a stub page against a fake adapter and a fake Tessie.
const assert = require("assert"), vm = require("vm"), fs = require("fs"), path = require("path");
const D = require("../decode.js");
const ROOT = path.join(__dirname, "..");
const wait = ms => new Promise(r => setTimeout(r, ms));

// Minimal page: every element accepts writes; click(id) runs the element's click handler, fire(type) a document event.
// scale speeds up the app's own timers (scale 20: Tessie's 10 s poll runs every 0.5 s).
// storage may be a plain object or the Map from an earlier boot (a reload).
function boot({ storage = {}, serial = null, fetch = null, scale = 1, wakeLock = null, idb = null, ua = "", vibrate = null } = {}) {
  const els = {}, timers = [], docOn = {}, files = [];
  let reloads = 0;
  const el = () => ({ dataset: {}, style: { setProperty() {} }, classList: { toggle() {} }, children: [{ style: {} }, { style: {} }],
    textContent: "", innerHTML: "", hidden: false, value: "", checked: false, open: false, clientWidth: 0, clientHeight: 0, on: {},
    addEventListener(t, f) { this.on[t] = f; }, showModal() { this.open = true; }, close() { this.open = false; }, setAttribute() {}, focus() {}, scrollIntoView() {}, replaceChildren() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [], click() {}, remove() {} });
  const store = storage instanceof Map ? storage : new Map(Object.entries(storage).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const later = fn => (f, ms, ...a) => { const id = fn(f, (ms || 0) / scale, ...a); timers.push(id); return id; };
  class PageURL extends URL {}
  PageURL.createObjectURL = b => { files.push(b); return "blob:test"; }; PageURL.revokeObjectURL = () => {};
  const document = { getElementById: id => (els[id] ||= el()), querySelector: () => el(), querySelectorAll: () => [], createElement: el,
    addEventListener(t, f) { (docOn[t] ||= []).push(f); }, documentElement: el(), body: el(), hidden: false, activeElement: null };
  const ctx = {
    console, performance, TextEncoder, TextDecoder, Blob, fetch, URL: PageURL,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    setTimeout: later(setTimeout), setInterval: later(setInterval), clearTimeout, clearInterval,
    requestAnimationFrame: () => 0, getComputedStyle: () => ({ getPropertyValue: () => "" }), addEventListener() {},
    location: { protocol: "http:", reload: () => reloads++ }, navigator: { userAgent: ua, ...(serial && { serial }), ...(wakeLock && { wakeLock }), ...(vibrate && { vibrate }) },
    document, ...(idb && { indexedDB: idb.indexedDB, IDBKeyRange: idb.IDBKeyRange }),
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  };
  ctx.window = ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ["decode.js", "elm.js", "sim.js", "units.js", "coach.js", "drives.js", "stops.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  return {
    el: id => (els[id] ||= el()), text: id => els[id].textContent, html: id => els[id].innerHTML, click: id => els[id].on.click(),
    fire: type => (docOn[type] || []).forEach(f => f({})), document, store, files, reloads: () => reloads,
    stop: () => timers.forEach(clearTimeout),
  };
}

// STN adapter on a parked car: pack power and speed every 10 ms, lifetime kWh and odometer only every 500 ms.
const OUT = 9100, IN = 6400, ODO_KM = 30000, ODO_MI = ODO_KM / 1.609344;
const hexFrame = (id, fill) => { const b = new Array(8).fill(0); fill(b); return id.toString(16).toUpperCase() + b.map(x => x.toString(16).toUpperCase().padStart(2, "0")).join(""); };
const FAST = [hexFrame(0x132, b => { D.setBits(b, 0, 16, 350 / 0.01); D.setBits(b, 16, 16, 2 / -0.1); }), hexFrame(0x257, b => D.setBits(b, 12, 12, 40 / 0.08))];
const SLOW = [hexFrame(0x3D2, b => { D.setBits(b, 0, 32, OUT / 0.001); D.setBits(b, 32, 32, IN / 0.001); }), hexFrame(0x3B6, b => D.setBits(b, 0, 32, ODO_KM / 0.001))];
function fakePort(name = "A") {
  let ctrl = null, rs = null, buf = "", streams = [];
  const say = s => { try { ctrl.enqueue(new TextEncoder().encode(s)); } catch (e) {} };
  const stop = () => { streams.forEach(clearInterval); streams = []; };
  function handle(c) {
    if (streams.length) { stop(); return say("STOPPED\r\r>"); }
    if (c === "STI") return say("STN2255 v5.10.3\r\r>");
    if (c === "STM") { streams = [setInterval(() => FAST.forEach(f => say(f + "\r")), 10), setInterval(() => SLOW.forEach(f => say(f + "\r")), 500)]; return; }
    say(c ? "OK\r\r>" : ">");
  }
  return {
    name, opens: 0, failOpens: 0, forgotten: false,
    getInfo: () => ({ bluetoothServiceClassId: "00001101-0000-1000-8000-00805f9b34fb" }),
    async open() { if (this.failOpens > 0) { this.failOpens--; throw new Error("Failed to open serial port."); } this.opens++; rs = new ReadableStream({ start(c) { ctrl = c; } }); },
    async close() { stop(); },
    get readable() { return rs; },
    writable: new WritableStream({ write(chunk) {
      buf += new TextDecoder().decode(chunk);
      let i; while ((i = buf.indexOf("\r")) >= 0) { const c = buf.slice(0, i).trim(); buf = buf.slice(i + 1); setTimeout(() => handle(c), 2); }
    } }),
    drop() { stop(); ctrl.error(new Error("link lost")); },     // Bluetooth link drops
    async forget() { this.forgotten = true; },
  };
}
// Granted ports; the chooser picks the last one.
function fakeSerial(...ports) {
  if (!ports.length) ports = [fakePort()];
  return { ports, getPorts: async () => ports.filter(p => !p.forgotten), requestPort: async () => ports[ports.length - 1], addEventListener() {} };
}

// car: readings a test can change between polls; car.idles is the parked-stretch log. Commands (POSTs) are recorded in cmds; one named in refuse gets
// { result: false, reason } back, the rest succeed.
function fakeTessie({ failFirst = false, cars = [{ vin: "VIN1" }] } = {}) {
  const calls = [], cmds = [], refuse = {}, car = { odometer: 10000, energy: 50, level: 66, outside: 25, setC: 21, climateOn: false, speed: 0, gear: null, idles: [] };
  const fetch = async (url, opts = {}) => {
    calls.push(url);
    if (failFirst && calls.length === 1) throw new TypeError("Failed to fetch");
    if (opts.method === "POST") {
      cmds.push(url.replace("https://api.tessie.com/", "")); const why = refuse[url.split("/command/")[1].split("?")[0]];
      return { ok: true, status: 200, json: async () => (why ? { result: false, reason: why } : { result: true }) };
    }
    const body = /vehicles/.test(url) ? { results: cars }
      : /idles/.test(url) ? { results: car.idles }
      : /battery/.test(url) ? { pack_voltage: 350, pack_current: 1, energy_remaining: car.energy, nominal_full_pack_energy: 75, battery_level: car.level, battery_range: 200, timestamp: Date.now() / 1000 }
      : { state: "online", drive_state: { power: 0, speed: car.speed, shift_state: car.gear }, vehicle_state: { odometer: car.odometer }, charge_state: {},
          climate_state: { outside_temp: car.outside, driver_temp_setting: car.setC, is_climate_on: car.climateOn } };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls, cmds, car, refuse };
}

// Screen wake lock: counts the locks still held.
function fakeWakeLock() {
  const locks = [];
  return { locks, held: () => locks.filter(l => !l.released).length,
    request: async () => { const l = { released: false, release: async () => { l.released = true; } }; locks.push(l); return l; } };
}

// Just enough IndexedDB for the CSV store: put / delete(upperBound) / clear / getAll, numeric keys.
function fakeIDB() {
  const data = new Map(), soon = f => setTimeout(f, 1);
  const os = { put(v, k) { data.set(k, v); }, delete(r) { for (const k of [...data.keys()]) if (k <= r.upper) data.delete(k); }, clear() { data.clear(); },
    getAll() { return { result: [...data.keys()].sort((a, b) => a - b).map(k => data.get(k)) }; } };
  const db = { createObjectStore() {}, transaction() { const tx = { objectStore: () => os }; soon(() => tx.oncomplete && tx.oncomplete()); return tx; } };
  return { data, IDBKeyRange: { upperBound: upper => ({ upper }) },
    indexedDB: { open() { const r = {}; soon(() => { r.result = db; r.onupgradeneeded && r.onupgradeneeded(); r.onsuccess(); }); return r; } } };
}

// A 12 mi trip saved earlier, matching the fake car's counters (parked since).
const carTrip = { t0: 1, src: "co", odo0: ODO_MI - 12, lastOdo: ODO_MI, lastNet: OUT - IN, lastIn: IN, drive: 3.1, park: 0.2, regen: 0.6, charged: 0, D: [0, 12], E: [0, 3.1] };

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log("ok -", name); } catch (e) { fail++; console.log("not ok -", name, "·", e.message); }
};

(async () => {
  await test("a saved trip survives connecting the adapter (power arrives before the kWh/odometer frames)", async () => {
    const app = boot({ storage: { "de.trip.v1": carTrip }, serial: fakeSerial() });
    await wait(3500);                                     // auto-connect at 0.8 s, init, then several counter frames
    assert.strictEqual(app.text("chipText"), "Live");
    assert.ok(app.html("tMi").startsWith("12.0"), "trip miles " + app.html("tMi"));
    assert.strictEqual(app.text("tDrive"), "3.10 kWh");
    app.stop();
  });

  await test("Demo started while the adapter is live shows as Demo", async () => {
    const app = boot({ serial: fakeSerial() });
    await wait(2500); assert.strictEqual(app.text("chipText"), "Live");
    app.click("demoBtn"); await wait(500);
    assert.strictEqual(app.text("chipText"), "Demo · 8× speed");
    app.stop();
  });

  await test("Tessie keeps retrying when its first request fails", async () => {
    const tes = fakeTessie({ failFirst: true });
    const app = boot({ storage: { "de.tessie.v1": "tok" }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(1500);
    assert.ok(/^Tessie · /.test(app.text("chipText")), "chip " + app.text("chipText"));
    app.stop();
  });

  await test("Demo stops Tessie and gives the adapter's trip back afterwards", async () => {
    const tes = fakeTessie();
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.trip.v1": carTrip }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(300);
    app.click("demoBtn"); await wait(300);
    app.click("demoBtn"); await wait(300);
    assert.ok(app.html("tMi").startsWith("12.0"), "trip miles " + app.html("tMi"));
    app.stop();
  });

  await test("Tessie uses the car picked in Settings when the account has several", async () => {
    const tes = fakeTessie({ cars: [{ vin: "VIN1" }, { vin: "VIN2" }] });
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.cfg.v1": { tessieVin: "VIN2" } }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(300);
    assert.ok(tes.calls.some(u => u.includes("VIN2/battery")) && !tes.calls.some(u => u.includes("VIN1/")), tes.calls.join(" "));
    assert.strictEqual(app.el("cfgVinRow").hidden, false, "car picker shown");
    app.stop();
  });

  await test("screen wake: one lock at a time, released when Drive view and the connection both end", async () => {
    const wl = fakeWakeLock();
    const app = boot({ storage: { "de.cfg.v1": { drive: true } }, serial: fakeSerial(), wakeLock: wl });
    await wait(2500); assert.strictEqual(app.text("chipText"), "Live");
    assert.strictEqual(wl.held(), 1, "locks held while live in Drive view");
    app.click("driveBtn"); app.click("disconnectBtn"); await wait(500);
    assert.strictEqual(wl.held(), 0, "locks held after Drive view off + disconnect");
    app.stop();
  });

  await test("a dropped Bluetooth link reconnects quietly, keeping the remembered adapter", async () => {
    const serial = fakeSerial(), port = serial.ports[0];
    const app = boot({ serial, scale: 5 });                 // 2.5 s retry → 0.5 s; 15 s auto-connect → 3 s
    await wait(800); assert.strictEqual(app.text("chipText"), "Live");
    port.failOpens = 1; port.drop(); await wait(1400);     // first retry finds the adapter out of range
    assert.notStrictEqual(app.el("notice").dataset.tone, "bad", "no error after a missed retry: " + app.text("noticeText"));
    assert.strictEqual(app.text("chipText"), "Looking for the adapter…");
    await wait(1600);                                       // the 15 s auto-connect finds it again
    assert.strictEqual(app.text("chipText"), "Live"); assert.strictEqual(port.opens, 2);
    app.stop();
  });

  await test("Reset trip needs a second tap", async () => {
    const app = boot({ storage: { "de.trip.v1": carTrip } });
    await wait(400); assert.ok(app.html("tMi").startsWith("12.0"));
    app.click("resetTrip"); await wait(300);
    assert.ok(app.html("tMi").startsWith("12.0"), "one tap kept the trip");
    app.click("resetTrip"); await wait(300);
    assert.ok(app.html("tMi").startsWith("0.0"), "second tap reset it: " + app.html("tMi"));
    app.stop();
  });

  await test("choosing an adapter forgets the other granted ones (auto-connect can't open the wrong one)", async () => {
    const serial = fakeSerial(fakePort("vLinker"), fakePort("OBDLink"));
    const app = boot({ serial, storage: { "de.cfg.v1": { autoConnect: false } } });
    app.click("chooseBtn"); await wait(2000);
    assert.strictEqual(serial.ports[0].forgotten, true); assert.strictEqual(serial.ports[1].forgotten, false);
    assert.strictEqual(app.text("chipText"), "Live"); assert.strictEqual(serial.ports[1].opens, 1);
    app.stop();
  });

  await test("an interrupted CSV recording is recovered after a reload", async () => {
    const idb = fakeIDB();
    const app = boot({ idb });
    app.click("demoBtn"); app.click("recBtn"); await wait(2300);    // two rows
    app.document.hidden = true; app.fire("visibilitychange"); await wait(50);
    app.stop();
    const again = boot({ storage: app.store, idb }); await wait(300);
    assert.ok(/Recovered/.test(again.text("noticeText")), "notice: " + again.text("noticeText"));
    assert.strictEqual(again.el("dlBtn").hidden, false, "Download CSV offered");
    again.stop();
  });

  await test("backup: export leaves out the Tessie token; import keeps only clean data, then reloads", async () => {
    const drive = { t0: 7, t1: 8, mi: 5, kwh: 1.2, wh: 240, heavy: 1, friction: 0, regenKWh: 0.1, parkKWh: 0, accelKWh: 0.2, cruiseKWh: 0.9, stops: 2, maxMph: 40 };
    const app = boot({ storage: { "de.tessie.v1": "secret-token", "de.drives.v1": [drive], "de.trip.v1": carTrip,
      "de.cfg.v1": { alerts: "both", brick: 12, tab: "trip", goal: { mi: 20, at: 1 } } } });
    app.click("exportBtn"); await wait(50);
    const text = await app.files[0].text(), out = JSON.parse(text);
    assert.ok(!text.includes("secret-token"), "token exported");
    assert.strictEqual(out.drives.length, 1); assert.strictEqual(out.trip.drive, 3.1);
    assert.strictEqual(out.settings.alerts, "both"); assert.strictEqual(out.settings.brick, 12);
    assert.ok(!("tab" in out.settings) && !("goal" in out.settings), "per-outing state left out");

    const evil = { app: "drive-energy", drives: [{ ...drive, habit: { tone: "good", text: "<img src=x onerror=alert(1)>" } }, { t0: "x" }],
      speed: { "55|60-79": { kwh: 2, mi: 8 }, "<b>|x": { kwh: 1, mi: 1 }, "60|x": { kwh: "1", mi: 1 } }, trip: { ...carTrip, drive: "3" },
      settings: { alerts: "loud", brick: 50, win: 7, plan: { mi: 30, res: 20, x: "<b>" }, health: { target: 20 } } };
    app.el("importFile").on.change({ target: { files: [{ text: async () => JSON.stringify(evil) }], value: "" } }); await wait(50);
    const drives = JSON.parse(app.store.get("de.drives.v1")), speed = JSON.parse(app.store.get("de.speed.v1"));
    assert.strictEqual(drives.length, 1); assert.ok(!/</.test(drives[0].habit.text));
    assert.deepStrictEqual(Object.keys(speed), ["55|60-79"]);
    assert.strictEqual(app.store.get("de.trip.v1"), "null", "malformed trip dropped");
    assert.strictEqual(app.store.get("de.tessie.v1"), "secret-token", "token untouched");
    const c = JSON.parse(app.store.get("de.cfg.v1"));
    assert.deepStrictEqual([c.alerts, c.brick, c.win, c.plan, c.health], ["both", 50, 15, { mi: 30, res: 20 }, undefined], "only valid settings imported");
    assert.strictEqual(app.reloads(), 1);
    app.el("importFile").on.change({ target: { files: [{ text: async () => "not json" }], value: "" } }); await wait(50);
    assert.strictEqual(app.reloads(), 1); assert.strictEqual(app.el("notice").dataset.tone, "bad");
    app.stop();
  });

  await test("tabs: the last one is remembered, Drive view shows the cockpit, Tessie without a token opens Setup", async () => {
    const app = boot({ storage: { "de.cfg.v1": { tab: "battery" } } });
    const shown = () => ["cockpit", "trip", "battery", "health", "setup"].filter(n => !app.el(`view-${n}`).hidden);
    assert.deepStrictEqual(shown(), ["battery"]);
    app.click("tab-trip");
    assert.deepStrictEqual(shown(), ["trip"]); assert.strictEqual(JSON.parse(app.store.get("de.cfg.v1")).tab, "trip");
    app.click("driveBtn"); assert.deepStrictEqual(shown(), ["cockpit"]);
    app.click("driveBtn"); app.click("tessieBtn"); await wait(50);
    assert.deepStrictEqual(shown(), ["setup"]); assert.ok(/token/.test(app.text("noticeText")));
    app.stop();
  });

  await test("brick heatmap: all 108 bricks with voltages, the watched one outlined", async () => {
    const app = boot({ storage: { "de.cfg.v1": { brick: 38, oneBased: true, tab: "battery" } } });
    assert.strictEqual((app.html("bricks").match(/class="bk none/g) || []).length, 108, "empty grid before data");
    app.click("demoBtn"); await wait(2500);
    const html = app.html("bricks");
    assert.strictEqual((html.match(/class="bk/g) || []).length, 108);
    assert.ok(!/bk none/.test(html), "every brick reported");
    assert.ok(/class="bk w"[^>]*title="Brick 38: 3\.\d{3} V">38</.test(html), "brick 38 outlined");
    assert.ok(/^Lowest · #\d+$/.test(app.text("bMinLbl")), app.text("bMinLbl"));
    app.stop();
  });

  await test("range goal: set before connecting it counts from the first odometer reading; a day later it clears", async () => {
    const tes = fakeTessie();
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.cfg.v1": { goal: { mi: 20, odo0: null, at: Date.now() } } }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(300);
    assert.strictEqual(JSON.parse(app.store.get("de.cfg.v1")).goal.odo0, 10000);
    assert.strictEqual(app.text("gGoalL"), "Goal 20 mi · 20.0 left");
    app.stop();
    const old = boot({ storage: { "de.cfg.v1": { goal: { mi: 20, odo0: 9990, at: Date.now() - 2 * 864e5 } } } });
    await wait(400);
    assert.strictEqual(JSON.parse(old.store.get("de.cfg.v1")).goal, null); assert.strictEqual(old.text("gGoalV"), "Set a goal");
    old.stop();
  });

  await test("charge plan weighs recent drives by distance", async () => {
    const tes = fakeTessie(), drives = [{ id: "1", t0: 1, mi: 0.5, kwh: 0.225, wh: 450, score: 50 }, { id: "2", t0: 2, mi: 60, kwh: 14.4, wh: 240, score: 90 }];
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.drives.v1": drives, "de.cfg.v1": { tab: "battery" } }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(1300);                // the plan redraws once a second
    assert.ok(/at 242 Wh\/mi/.test(app.html("planRows")) && /your last 2 drives/.test(app.html("planRows")), app.html("planRows"));
    app.stop();
  });

  await test("drive list shows 8 drives with Show all for the rest", async () => {
    const drives = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), t0: i + 1, mi: 10, kwh: 2.5, wh: 250, score: 70 }));
    const app = boot({ storage: { "de.drives.v1": drives } });
    const rows = () => (app.html("driveList").match(/class="drow"/g) || []).length;
    assert.strictEqual(rows(), 8); assert.ok(/Show all 12/.test(app.html("driveList")));
    app.click("driveMore");
    assert.strictEqual(rows(), 12); assert.ok(/Show fewer/.test(app.html("driveList")));
    app.stop();
  });

  await test("header: Disconnect shows while Tessie runs (not for Demo); the cruise switch waits for live pedal data", async () => {
    const tes = fakeTessie();
    const app = boot({ storage: { "de.tessie.v1": "tok" }, fetch: tes.fetch, scale: 20 });
    assert.strictEqual(app.el("disconnectBtn").hidden, true); assert.strictEqual(app.el("cruiseBtn").hidden, true);
    app.click("tessieBtn"); await wait(300);
    assert.strictEqual(app.el("disconnectBtn").hidden, false, "Disconnect stops Tessie from the header");
    assert.strictEqual(app.el("cruiseBtn").hidden, true, "no pedal data from Tessie");
    assert.strictEqual(app.text("tessieLbl"), "Stop Tessie");
    app.click("disconnectBtn"); await wait(100);
    assert.strictEqual(app.el("disconnectBtn").hidden, true); assert.strictEqual(app.text("tessieLbl"), "Start Tessie");
    app.click("demoBtn"); await wait(800);
    assert.strictEqual(app.el("cruiseBtn").hidden, false, "live pedal data in Demo");
    assert.strictEqual(app.el("disconnectBtn").hidden, true, "Demo stops from its own button");
    app.stop();
  });

  await test("health test prep: plan out-and-back, turn around, stop at the target and undo the climate it switched on", async () => {
    const tes = fakeTessie(), drives = [{ id: "1", t0: 1, mi: 40, kwh: 10, wh: 250, score: 80 }, { id: "2", t0: 2, mi: 40, kwh: 10, wh: 250, score: 80 }];
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.drives.v1": drives, "de.cfg.v1": { tab: "health" } }, fetch: tes.fetch, scale: 20 });
    const cfg = () => JSON.parse(app.store.get("de.cfg.v1")), step = async f => { f(); await wait(1300); };   // a poll, then the once-a-second redraw
    app.click("tessieBtn"); await wait(1300);
    // 66% → 20% of a 75 kWh pack = 34.5 kWh = 138 mi at 250 Wh/mi: 69 out, 69 back.
    assert.ok(/~138 mi at 250 Wh\/mi/.test(app.html("hRows")) && /~69 mi/.test(app.html("hRows")), app.html("hRows"));
    assert.strictEqual(app.el("burnFull").disabled, true, "nothing to burn toward before Start");
    app.click("hStart"); assert.deepStrictEqual([cfg().health.target, cfg().health.odo0, cfg().health.phase], [20, 10000, "out"]);
    app.click("burnFull"); await wait(200);
    assert.deepStrictEqual(tes.cmds, ["VIN1/command/start_climate", "VIN1/command/set_temperatures?temperature=15"], "warm out: AC at LO");
    // 10 mi out on 2.5 kWh (250 Wh/mi). Tessie just stepped down to 62%, so the charge is taken as 62.5%:
    // 31.875 kWh above 20% = 127.5 mi; turn around in (127.5 − 10) / 2 = 58.75 mi.
    await step(() => Object.assign(tes.car, { odometer: 10010, energy: 47.5, level: 62 }));
    assert.strictEqual(app.text("tip"), "62% → 20% · turn around in 58.8 mi."); assert.ok(/58\.8 mi/.test(app.html("hRows")));
    // Still 62% on Tessie, but 0.5 kWh more used: the countdown follows energy remaining instead of waiting for 61%.
    // 61.83% → 31.375 kWh = 125.5 mi; (125.5 − 12) / 2 = 56.75.
    await step(() => Object.assign(tes.car, { odometer: 10012, energy: 47 }));
    assert.strictEqual(app.text("tip"), "62% → 20% · turn around in 56.8 mi.");
    // 70 mi out, just stepped to 30% (taken as 30.5%): 7.875 kWh = 31.5 mi left, less than the 70 back: head home.
    await step(() => Object.assign(tes.car, { odometer: 10070, energy: 32.5, level: 30 }));
    assert.strictEqual(cfg().health.phase, "back"); assert.strictEqual(app.text("tip"), "Head home · 31.5 mi of driving left until 20%.");
    await step(() => Object.assign(tes.car, { odometer: 10100, energy: 25, level: 20 }));
    assert.strictEqual(cfg().health.phase, "done"); assert.strictEqual(app.text("tip"), "At 20%: ready for the battery health test.");
    assert.deepStrictEqual(tes.cmds.slice(2), ["VIN1/command/set_temperatures?temperature=21", "VIN1/command/stop_climate"], "only what it switched on, temperature put back");
    app.click("hStart"); assert.strictEqual(cfg().health, null);
    app.stop();
  });

  await test("health test prep in the cold: HI with seat and wheel heaters; Turn off undoes them, climate last", async () => {
    const tes = fakeTessie(); Object.assign(tes.car, { outside: 2, climateOn: false, setC: 20 });
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.cfg.v1": { tab: "health" } }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(300);
    app.click("hStart"); app.click("burnFull"); await wait(200);
    assert.deepStrictEqual(tes.cmds.map(c => c.slice(13)), ["start_climate", "set_temperatures?temperature=28", "set_seat_heat?seat=front_left&level=3",
      "set_seat_heat?seat=front_right&level=3", "start_steering_wheel_heater"]);
    app.click("burnOff"); await wait(200);
    assert.deepStrictEqual(tes.cmds.slice(5).map(c => c.slice(13)), ["stop_steering_wheel_heater", "set_seat_heat?seat=front_left&level=0",
      "set_seat_heat?seat=front_right&level=0", "set_temperatures?temperature=20", "stop_climate"]);
    assert.ok(/off again/.test(app.text("burnMsg")));
    app.stop();
  });

  await test("health test prep: a refused command is named and stops the sequence; Turn off undoes the rest", async () => {
    const tes = fakeTessie(); Object.assign(tes.car, { outside: 2, setC: 20 }); tes.refuse.set_seat_heat = "user_present";
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.cfg.v1": { tab: "health" } }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(300);
    app.click("hStart"); app.click("burnFull"); await wait(200);
    assert.deepStrictEqual(tes.cmds.map(c => c.slice(13)), ["start_climate", "set_temperatures?temperature=28", "set_seat_heat?seat=front_left&level=3"]);
    assert.strictEqual(app.text("burnMsg"), "Driver seat heater didn't work: user_present.");
    app.click("burnOff"); await wait(200);
    assert.deepStrictEqual(tes.cmds.slice(3).map(c => c.slice(13)), ["set_temperatures?temperature=20", "stop_climate"]);
    app.el("diag").open = true; app.el("diag").on.toggle();
    assert.ok(/set_seat_heat\?seat=front_left&level=3  failed: user_present/.test(app.text("diagText")), "command log in diagnostics");
    app.stop();
  });

  await test("health test prep clears itself after a day and switches off the climate it turned on", async () => {
    const tes = fakeTessie(), at = Date.now() - 2 * 864e5;
    const health = { target: 20, at, odo0: 10000, e0: 50, phase: "out", burn: { did: ["climate"], prevC: 21, wasOn: false, cold: false } };
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.cfg.v1": { tab: "health", health } }, fetch: tes.fetch, scale: 20 });
    await wait(300);
    assert.strictEqual(JSON.parse(app.store.get("de.cfg.v1")).health, null); assert.deepStrictEqual(tes.cmds, ["VIN1/command/stop_climate"]);
    app.stop();
  });

  await test("Tessie keeps polling with the screen off only while a health test prep runs", async () => {
    const tes = fakeTessie();
    const app = boot({ storage: { "de.tessie.v1": "tok" }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(300);
    app.document.hidden = true; let n = tes.calls.length; await wait(1200);
    assert.strictEqual(tes.calls.length, n, "no polling with the screen off normally");
    app.click("hStart"); n = tes.calls.length; await wait(1200);
    assert.ok(tes.calls.length > n, "polling continues during the prep");
    app.stop();
  });

  await test("health test prep in Demo never sends commands and doesn't carry over to the car", async () => {
    const tes = fakeTessie();
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.cfg.v1": { tab: "health" } }, fetch: tes.fetch, scale: 20 });
    app.click("demoBtn"); await wait(1300);
    app.click("hStart"); assert.strictEqual(JSON.parse(app.store.get("de.cfg.v1")).health.demo, true);
    await wait(1100); assert.strictEqual(app.el("burnFull").disabled, true);
    app.click("burnFull"); await wait(100); assert.deepStrictEqual(tes.cmds, []);
    app.click("demoBtn"); app.click("tessieBtn"); await wait(800);
    assert.strictEqual(JSON.parse(app.store.get("de.cfg.v1")).health, null, "the Demo prep is dropped once real data arrives");
    app.stop();
  });

  await test("adapter frames keep the trip math running when the browser stalls the page's timers", async () => {
    const app = boot({ serial: fakeSerial() });
    await wait(2500); assert.strictEqual(app.text("chipText"), "Live");
    app.stop(); app.el("chipText").textContent = "";        // every app timer gone, as when Chrome throttles a background page
    await wait(1500);
    assert.strictEqual(app.text("chipText"), "Live", "a frame ran the update the stalled timer missed");
  });

  await test("health test prep: the banner and the tab add the driving time at this outing's pace", async () => {
    const tes = fakeTessie(), drives = [{ id: "1", t0: 1, mi: 40, kwh: 10, wh: 250, score: 80 }, { id: "2", t0: 2, mi: 40, kwh: 10, wh: 250, score: 80 }];
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.drives.v1": drives, "de.cfg.v1": { tab: "health" } }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(300);
    app.click("hStart"); await wait(300);
    assert.strictEqual(app.text("tip"), "66% → 20% · turn around in 69.0 mi.", "no time before the car has moved");
    // Same numbers as the walk-through above, now at a steady 25 mph: 58.75 mi takes 2 h 21 min.
    Object.assign(tes.car, { odometer: 10010, energy: 47.5, level: 62, speed: 25 }); await wait(1300);
    assert.strictEqual(app.text("tip"), "62% → 20% · turn around in 58.8 mi · ~2 h 21 min.");
    assert.ok(/58\.8 mi/.test(app.html("hRows")) && /Time at this pace<\/span><span>~2 h 21 min/.test(app.html("hRows")), app.html("hRows"));
    app.el("cfgUnits").on.change({ target: { value: "km" } });
    assert.strictEqual(app.text("tip"), "62% → 20% · turn around in 94.5 km · ~2 h 21 min.");
    app.stop();
  });

  await test("units: Kilometers converts the screen and typed distances; saved data stays in miles", async () => {
    const tes = fakeTessie(), drives = [{ id: "1", t0: 1, mi: 40, kwh: 10, wh: 250, score: 80 }, { id: "2", t0: 2, mi: 40, kwh: 10, wh: 250, score: 80 }];
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.drives.v1": drives, "de.cfg.v1": { units: "km", tab: "battery" } }, fetch: tes.fetch, scale: 20 });
    const cfg = () => JSON.parse(app.store.get("de.cfg.v1"));
    assert.strictEqual(app.el("planMi").value, "48", "the 30 mi default plan, in km");
    assert.ok(/64\.4 km/.test(app.html("driveList")) && /155 Wh\/km/.test(app.html("driveList")), app.html("driveList"));
    app.click("exportBtn"); await wait(50);
    assert.strictEqual(JSON.parse(await app.files[0].text()).settings.units, "km", "the setting is backed up");
    app.click("tessieBtn"); await wait(1300);
    assert.strictEqual(app.html("proj"), "322<small>km</small>", "200 mi rated range");
    assert.ok(/Energy for 48 km/.test(app.html("planRows")) && /at 155 Wh\/km/.test(app.html("planRows")), app.html("planRows"));
    app.el("planMi").on.change({ target: { value: "100" } });
    assert.ok(Math.abs(cfg().plan.mi - 62.137) < 0.001, "100 km plan kept as miles");
    app.el("goalMi").value = "50"; app.el("goalForm").on.submit({ preventDefault() {} });
    assert.ok(Math.abs(cfg().goal.mi - 31.069) < 0.001, "50 km goal kept as miles");
    assert.strictEqual(app.text("gGoalL"), "Goal 50 km · 50.0 left");
    app.el("cfgUnits").on.change({ target: { value: "mi" } });
    assert.strictEqual(cfg().units, "mi"); assert.strictEqual(app.html("proj"), "200<small>mi</small>");
    assert.strictEqual(app.el("planMi").value, "62"); assert.strictEqual(app.text("gGoalL"), "Goal 31 mi · 31.1 left");
    assert.ok(/40\.0 mi/.test(app.html("driveList")) && /250 Wh\/mi/.test(app.html("driveList")));
    app.stop();
  });

  await test("coach: a tip holds 8 s, a new one must lead 2 s first, a warning cuts in at once", async () => {
    const c = require("../coach.js").createCoach({});
    let now = 0;
    const run = (sec, x) => { for (let i = 0; i < sec * 4; i++) c.update({ mph: 40, kw: 10, gear: "D", grade: 0, ...(typeof x === "function" ? x(i) : x) }, 0.25, (now += 250)); return c.state.headline.kind; };
    assert.strictEqual(run(1, { pedal: 0 }), "pedal.coast");
    assert.strictEqual(run(12, i => ({ pedal: i % 2 ? 0 : 60 })), "pedal.coast", "a pedal flicking on and off doesn't flip the tip");
    assert.strictEqual(c.state.second, null, "nor the second line");
    assert.strictEqual(run(1.75, { pedal: 60 }), "pedal.coast", "not before the new tip has led 2 s");
    assert.strictEqual(run(0.5, { pedal: 60 }), "pedal.heavy");
    assert.strictEqual(run(7, { pedal: 0 }), "pedal.heavy", "held 8 s");
    assert.strictEqual(run(1.25, { pedal: 0 }), "pedal.coast");
    assert.strictEqual(run(6, i => ({ pedal: 0, mph: i % 2 ? 2 : 8 })), "pedal.coast", "creeping in traffic doesn't flip to Stopped.");
    assert.strictEqual(run(0.25, { pedal: 0, mph: 0, gear: "P" }), "parked", "shifting into P switches at once");
    run(0.25, { pedal: 0 });
    assert.strictEqual(run(0.25, { pedal: 60, soc: 10, kw: 70 }), "soc.lowDraw", "a warning switches at once");
  });

  await test("units: coach tips and drive habits use the picked units", async () => {
    const Units = require("../units.js"), Coach = require("../coach.js"), Drives = require("../drives.js");
    try {
      Units.set("km");
      const tips = Coach.cues({ tMin: 5, outsideC: 2, mph: 75, kw: 20 }).map(q => q.text).join(" | ");
      assert.ok(/Pack is cold \(5 °C\)/.test(tips) && /Cold air \(2 °C\): higher Wh\/km/.test(tips) && /Above ~110 km\/h/.test(tips), tips);
      assert.strictEqual(Drives.habit({ cruiseBand: 70, sweetBand: 55 }).text, "Most of this drive was at 113–120 km/h. Your data says 89–96 km/h is your most efficient band.");
      assert.strictEqual(Units.tempBand("40-59"), "4–15 °C");
      Units.set("mi");
      assert.ok(/Pack is cold \(41 °F\)/.test(Coach.cues({ tMin: 5 }).map(q => q.text).join(" ")));
      assert.strictEqual(Drives.habit({ cruiseBand: 70, sweetBand: 55 }).text, "Most of this drive was at 70–74 mph. Your data says 55–59 mph is your most efficient band.");
    } finally { Units.set("mi"); }
  });

  await test("Cockpit: the Charge tile shows the charge and kWh left (power stays on the flow bar)", async () => {
    const tes = fakeTessie();
    const app = boot({ storage: { "de.tessie.v1": "tok" }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(300);
    assert.strictEqual(app.html("kSoc"), "66<small>%</small>"); assert.strictEqual(app.text("kSocSub"), "50.0 kWh left");
    tes.car.level = 15; await wait(700);
    assert.strictEqual(app.el("kSoc").dataset.tone, "warn");
    app.stop();
  });

  await test("Pack & bricks: the watched brick's sag is measured against its frame-mates; tap a brick to watch it", async () => {
    const app = boot({ storage: { "de.cfg.v1": { tab: "battery", brick: 38, oneBased: true } }, scale: 20 });
    app.click("demoBtn"); await wait(3000);
    const sag = parseFloat(app.html("bSag"));
    assert.ok(sag > 4.5 && sag < 7.5, app.html("bSag"));         // the demo's brick 38 sags 6 mV more per 100 A
    assert.strictEqual(app.text("bSagSub"), "per 100 A vs bricks 37 & 39"); assert.strictEqual(app.el("bSag").dataset.tone, "warn");
    assert.strictEqual(app.html("bRegen"), "62<small>kW</small>");
    app.el("bricks").on.click({ target: { closest: () => ({ dataset: { i: "10" } }) } });
    assert.strictEqual(JSON.parse(app.store.get("de.cfg.v1")).brick, 11); assert.strictEqual(app.text("bWatchLbl"), "Brick 11");
    assert.strictEqual(app.html("bSag"), "—", "a newly watched brick is measured afresh");
    app.stop();
  });

  await test("Parked: Tessie's idle log fills the card (newest first, place text escaped, Sentry's draw compared)", async () => {
    const tes = fakeTessie(), now = Math.floor(Date.now() / 1000), h = 3600;
    tes.car.idles = [
      { started_at: now - 30 * h, ended_at: now - 20 * h, location: "Work <b>Lot</b>, City", energy_used: 1.0, rated_range_used: 3.5, sentry_fraction: 0, climate_fraction: 0 },
      { started_at: now - 10 * h, ended_at: now - 6 * h, location: "Home, City", energy_used: 1.2, rated_range_used: 4, sentry_fraction: 1, climate_fraction: 0 },
    ];
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.cfg.v1": { tab: "trip" } }, fetch: tes.fetch, scale: 20 });
    await wait(400);
    assert.ok(tes.calls.some(u => /VIN1\/idles\?from=\d+/.test(u)), "asked Tessie for the log without starting Tessie");
    assert.ok(app.html("pkLast").startsWith("1.20"), "latest " + app.html("pkLast"));
    assert.strictEqual(app.text("pkLastSub"), "4 h 0 min · 300 W · Sentry 100%");
    assert.ok(app.html("pkWeek").startsWith("2.2"), "week " + app.html("pkWeek"));
    const rows = app.html("pkRows");
    assert.ok(rows.indexOf("Home") < rows.indexOf("Work"), "newest first");
    assert.ok(rows.includes("Work &lt;b&gt;Lot&lt;/b&gt;") && !rows.includes("<b>"), "place text escaped");
    assert.ok(/Sentry on.* 300 W.* 100 W/.test(app.text("pkNote")), app.text("pkNote"));
    app.stop();
  });

  await test("car screen: Tessie starts on its own and Connect car means Tessie (no Web Serial there)", async () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Tesla/2026.32.3";
    const tes = fakeTessie();
    const app = boot({ storage: { "de.tessie.v1": "tok" }, fetch: tes.fetch, scale: 20, ua });
    await wait(300);
    assert.ok(/^Tessie · /.test(app.text("chipText")), "chip " + app.text("chipText"));
    assert.strictEqual(app.el("connectBtn").hidden, true, "nothing to connect while Tessie runs");
    app.click("disconnectBtn"); await wait(50);
    assert.strictEqual(app.el("connectBtn").hidden, false);
    app.click("connectBtn"); await wait(300);
    assert.ok(/^Tessie · /.test(app.text("chipText")), "Connect car restarted Tessie: " + app.text("chipText"));
    app.stop();
    const bare = boot({ ua }); await wait(50);
    assert.ok(/Tessie API token/.test(bare.text("noticeText")), "no token: " + bare.text("noticeText"));
    bare.stop();
  });

  await test("Tessie: picking another car forgets the old one, so climate commands go to the car picked", async () => {
    const tes = fakeTessie({ cars: [{ vin: "VIN1" }, { vin: "VIN2" }] });
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.cfg.v1": { tab: "health" } }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn"); await wait(300); app.click("tessieBtn"); await wait(50);      // ran on VIN1, now stopped
    app.click("hStart");
    await app.el("cfgVin").on.change({ target: { value: "VIN2" } });
    app.click("burnFull"); await wait(300);
    assert.ok(tes.cmds.length && tes.cmds.every(c => c.startsWith("VIN2/")), tes.cmds.join(", "));
    app.stop();
  });

  await test("Tessie: outside temperature and gear come through, tips that don't need the pedal show, drives are scored", async () => {
    const tes = fakeTessie(); Object.assign(tes.car, { speed: 80, gear: "D", outside: 2 });
    const app = boot({ storage: { "de.tessie.v1": "tok" }, fetch: tes.fetch, scale: 20 });
    app.click("tessieBtn");
    for (let i = 0; i < 6; i++) { await wait(500); tes.car.odometer += 1; tes.car.energy -= 0.25; }   // 250 Wh/mi
    assert.ok(/^Cold air \(36 °F\)/.test(app.text("tip")), "tip: " + app.text("tip"));
    assert.ok(/aero drag/.test(app.text("tip2")), "tip2: " + app.text("tip2"));
    Object.assign(tes.car, { speed: 0 }); await wait(600);
    assert.strictEqual(app.text("inst"), "Stopped", "in D, not moving");
    tes.car.gear = "P"; await wait(600);
    assert.strictEqual(app.text("inst"), "Parked");
    app.click("endDrive"); await wait(50);
    const d = (JSON.parse(app.store.get("de.drives.v1") || "[]"))[0];
    assert.ok(d && d.mi >= 4 && Math.round(d.wh) === 250 && d.score != null, JSON.stringify(d));
    assert.strictEqual(app.store.get("de.speed.v1"), undefined, "Tessie's readings don't teach the speed table");
    app.stop();
  });

  await test("health test prep alerts at the target even with eyes-free alerts off", async () => {
    const tes = fakeTessie(), buzz = [];
    const app = boot({ storage: { "de.tessie.v1": "tok", "de.cfg.v1": { tab: "health" } }, fetch: tes.fetch, scale: 20, vibrate: p => buzz.push(p) });
    app.click("tessieBtn"); await wait(300); app.click("hStart");
    Object.assign(tes.car, { odometer: 10100, energy: 25, level: 20 }); await wait(1300);
    assert.strictEqual(JSON.parse(app.store.get("de.cfg.v1")).health.phase, "done");
    assert.strictEqual(JSON.stringify(buzz), "[[150,80,150,80,300]]", "the turn pattern, once");
    app.stop();
  });

  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ""}`);
  process.exit(fail ? 1 : 0);                             // exit explicitly: the fake adapters' streams are still ticking
})().catch(e => { console.error(e); process.exit(1); });
