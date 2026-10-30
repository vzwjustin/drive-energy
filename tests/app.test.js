// Run: node tests/app.test.js — boots the real app.js on a stub page against a fake adapter and a fake Tessie.
const assert = require("assert"), vm = require("vm"), fs = require("fs"), path = require("path");
const D = require("../decode.js");
const ROOT = path.join(__dirname, "..");
const wait = ms => new Promise(r => setTimeout(r, ms));

// Minimal page: every element accepts writes; click(id) runs the element's click handler, fire(type) a document event.
// scale speeds up the app's own timers (scale 20: Tessie's 10 s poll runs every 0.5 s).
// storage may be a plain object or the Map from an earlier boot (a reload).
function boot({ storage = {}, serial = null, fetch = null, scale = 1, wakeLock = null, idb = null } = {}) {
  const els = {}, timers = [], docOn = {}, files = [];
  let reloads = 0;
  const el = () => ({ dataset: {}, style: { setProperty() {} }, classList: { toggle() {} }, children: [{ style: {} }, { style: {} }],
    textContent: "", innerHTML: "", hidden: false, value: "", checked: false, open: false, clientWidth: 0, clientHeight: 0, on: {},
    addEventListener(t, f) { this.on[t] = f; }, showModal() { this.open = true; }, close() { this.open = false; }, setAttribute() {}, focus() {}, scrollIntoView() {}, replaceChildren() {}, appendChild() {}, querySelectorAll: () => [], click() {}, remove() {} });
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
    location: { protocol: "http:", reload: () => reloads++ }, navigator: { ...(serial && { serial }), ...(wakeLock && { wakeLock }) },
    document, ...(idb && { indexedDB: idb.indexedDB, IDBKeyRange: idb.IDBKeyRange }),
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  };
  ctx.window = ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ["decode.js", "elm.js", "sim.js", "coach.js", "drives.js", "stops.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
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

function fakeTessie({ failFirst = false, cars = [{ vin: "VIN1" }] } = {}) {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    if (failFirst && calls.length === 1) throw new TypeError("Failed to fetch");
    const body = /vehicles/.test(url) ? { results: cars }
      : /battery/.test(url) ? { pack_voltage: 350, pack_current: 1, energy_remaining: 50, nominal_full_pack_energy: 75, battery_level: 66, battery_range: 200, timestamp: Date.now() / 1000 }
      : { state: "online", drive_state: { power: 0, speed: 0 }, vehicle_state: { odometer: 10000 }, charge_state: {} };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
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
    const app = boot({ storage: { "de.tessie.v1": "secret-token", "de.drives.v1": [drive], "de.trip.v1": carTrip } });
    app.click("exportBtn"); await wait(50);
    const text = await app.files[0].text(), out = JSON.parse(text);
    assert.ok(!text.includes("secret-token"), "token exported");
    assert.strictEqual(out.drives.length, 1); assert.strictEqual(out.trip.drive, 3.1);

    const evil = { app: "drive-energy", drives: [{ ...drive, habit: { tone: "good", text: "<img src=x onerror=alert(1)>" } }, { t0: "x" }],
      speed: { "55|60-79": { kwh: 2, mi: 8 }, "<b>|x": { kwh: 1, mi: 1 }, "60|x": { kwh: "1", mi: 1 } }, trip: { ...carTrip, drive: "3" } };
    app.el("importFile").on.change({ target: { files: [{ text: async () => JSON.stringify(evil) }], value: "" } }); await wait(50);
    const drives = JSON.parse(app.store.get("de.drives.v1")), speed = JSON.parse(app.store.get("de.speed.v1"));
    assert.strictEqual(drives.length, 1); assert.ok(!/</.test(drives[0].habit.text));
    assert.deepStrictEqual(Object.keys(speed), ["55|60-79"]);
    assert.strictEqual(app.store.get("de.trip.v1"), "null", "malformed trip dropped");
    assert.strictEqual(app.store.get("de.tessie.v1"), "secret-token", "token untouched");
    assert.strictEqual(app.reloads(), 1);
    app.el("importFile").on.change({ target: { files: [{ text: async () => "not json" }], value: "" } }); await wait(50);
    assert.strictEqual(app.reloads(), 1); assert.strictEqual(app.el("notice").dataset.tone, "bad");
    app.stop();
  });

  await test("tabs: the last one is remembered, Drive view shows the cockpit, Tessie without a token opens Setup", async () => {
    const app = boot({ storage: { "de.cfg.v1": { tab: "battery" } } });
    const shown = () => ["cockpit", "trip", "battery", "setup"].filter(n => !app.el(`view-${n}`).hidden);
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

  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ""}`);
  process.exit(fail ? 1 : 0);                             // exit explicitly: the fake adapters' streams are still ticking
})().catch(e => { console.error(e); process.exit(1); });
