// Run: node tests/app.test.js — boots the real app.js on a stub page against a fake adapter and a fake Tessie.
const assert = require("assert"), vm = require("vm"), fs = require("fs"), path = require("path");
const D = require("../decode.js");
const ROOT = path.join(__dirname, "..");
const wait = ms => new Promise(r => setTimeout(r, ms));

// Minimal page: every element accepts writes; click(id) runs the element's click handler.
// scale speeds up the app's own timers (scale 20: Tessie's 10 s poll runs every 0.5 s).
function boot({ storage = {}, serial = null, fetch = null, scale = 1 } = {}) {
  const els = {}, timers = [];
  const el = () => ({ dataset: {}, style: { setProperty() {} }, classList: { toggle() {} }, children: [{ style: {} }, { style: {} }],
    textContent: "", innerHTML: "", hidden: false, value: "", checked: false, open: false, clientWidth: 0, clientHeight: 0, on: {},
    addEventListener(t, f) { this.on[t] = f; }, setAttribute() {}, focus() {}, scrollIntoView() {} });
  const store = new Map(Object.entries(storage).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const later = fn => (f, ms, ...a) => { const id = fn(f, (ms || 0) / scale, ...a); timers.push(id); return id; };
  const ctx = {
    console, performance, TextEncoder, TextDecoder, URL, Blob, fetch,
    setTimeout: later(setTimeout), setInterval: later(setInterval), clearTimeout, clearInterval,
    requestAnimationFrame: () => 0, getComputedStyle: () => ({ getPropertyValue: () => "" }), addEventListener() {},
    location: { protocol: "http:" }, navigator: serial ? { serial } : {},
    document: { getElementById: id => (els[id] ||= el()), querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, documentElement: el(), body: el(), hidden: false },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  };
  ctx.window = ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ["decode.js", "elm.js", "sim.js", "coach.js", "drives.js", "stops.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  return { text: id => els[id].textContent, html: id => els[id].innerHTML, click: id => els[id].on.click(), stop: () => timers.forEach(clearTimeout) };
}

// STN adapter on a parked car: pack power and speed every 10 ms, lifetime kWh and odometer only every 500 ms.
const OUT = 9100, IN = 6400, ODO_KM = 30000, ODO_MI = ODO_KM / 1.609344;
const hexFrame = (id, fill) => { const b = new Array(8).fill(0); fill(b); return id.toString(16).toUpperCase() + b.map(x => x.toString(16).toUpperCase().padStart(2, "0")).join(""); };
const FAST = [hexFrame(0x132, b => { D.setBits(b, 0, 16, 350 / 0.01); D.setBits(b, 16, 16, 2 / -0.1); }), hexFrame(0x257, b => D.setBits(b, 12, 12, 40 / 0.08))];
const SLOW = [hexFrame(0x3D2, b => { D.setBits(b, 0, 32, OUT / 0.001); D.setBits(b, 32, 32, IN / 0.001); }), hexFrame(0x3B6, b => D.setBits(b, 0, 32, ODO_KM / 0.001))];
function fakeSerial() {
  let push, buf = "", streams = [];
  const say = s => push(new TextEncoder().encode(s));
  function handle(c) {
    if (streams.length) { streams.forEach(clearInterval); streams = []; return say("STOPPED\r\r>"); }
    if (c === "STI") return say("STN2255 v5.10.3\r\r>");
    if (c === "STM") { streams = [setInterval(() => FAST.forEach(f => say(f + "\r")), 10), setInterval(() => SLOW.forEach(f => say(f + "\r")), 500)]; return; }
    say(c ? "OK\r\r>" : ">");
  }
  const port = {
    getInfo: () => ({}), async open() {}, async close() { streams.forEach(clearInterval); streams = []; },
    readable: new ReadableStream({ start(ctrl) { push = b => ctrl.enqueue(b); } }),
    writable: new WritableStream({ write(chunk) {
      buf += new TextDecoder().decode(chunk);
      let i; while ((i = buf.indexOf("\r")) >= 0) { const c = buf.slice(0, i).trim(); buf = buf.slice(i + 1); setTimeout(() => handle(c), 2); }
    } }),
  };
  return { getPorts: async () => [port], requestPort: async () => port, addEventListener() {} };
}

function fakeTessie({ failFirst = false } = {}) {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    if (failFirst && calls.length === 1) throw new TypeError("Failed to fetch");
    const body = /vehicles/.test(url) ? { results: [{ vin: "VIN1" }] }
      : /battery/.test(url) ? { pack_voltage: 350, pack_current: 1, energy_remaining: 50, nominal_full_pack_energy: 75, battery_level: 66, battery_range: 200, timestamp: Date.now() / 1000 }
      : { state: "online", drive_state: { power: 0, speed: 0 }, vehicle_state: { odometer: 10000 }, charge_state: {} };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
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

  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ""}`);
  process.exit(fail ? 1 : 0);                             // exit explicitly: the fake adapters' streams are still ticking
})().catch(e => { console.error(e); process.exit(1); });
