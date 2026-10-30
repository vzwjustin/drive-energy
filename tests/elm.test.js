// Run: node tests/elm.test.js — drives ElmLink against simulated STN and ELM327 (vLinker-style) adapters.
const assert = require("assert");
const { ElmLink } = require("../elm.js");

function fakePort({ stn, craOk = true, csmOk = true }) {
  const sent = [];
  let push, monitoring = false, filter = null, timer = null;
  const enc = new TextEncoder();
  const say = s => push && push(enc.encode(s));
  const frames = ["1180000000050000000", "132A08CF2FF5FC6A20000", "2573C0A08000000000", "35200002B9C1C20000", "3D2A0DB8A0018B7600", "4010C00AC0E810E810E8"]
    .map(f => f.slice(0, 3) + f.slice(3).slice(0, 16));
  const passes = id => {
    if (!filter) return true;
    if (filter.type === "cra") return id.startsWith(filter.pat.slice(0, 2));
    return (parseInt(id, 16) & filter.cm) === (filter.cf & filter.cm);
  };
  function startStream() {
    monitoring = true;
    timer = setInterval(() => { for (const f of frames) if (passes(f.slice(0, 3))) say(f + "\r"); }, 20);
  }
  function stopStream() { monitoring = false; clearInterval(timer); say("STOPPED\r\r>"); }
  function handle(cmd) {
    sent.push(cmd);
    const c = cmd.replace(/\s+/g, " ").trim().toUpperCase();
    if (monitoring) return stopStream();
    if (c === "") return say(">");
    if (c === "ATZ") return say("\r\rELM327 v1.5\r\r>");
    if (c === "STI") return say(stn ? "STN2255 v5.10.3\r\r>" : "?\r\r>");
    if (c === "ATI") return say("ELM327 v2.3\r\r>");
    if (c === "ATCSM1") return say(csmOk ? "OK\r\r>" : "?\r\r>");
    if (c.startsWith("ATCRA")) { if (!craOk) return say("?\r\r>"); filter = { type: "cra", pat: c.split(" ")[1] }; return say("OK\r\r>"); }
    if (c.startsWith("ATCF")) { filter = { type: "mask", cf: parseInt(c.split(" ")[1], 16), cm: filter && filter.cm || 0x7FF }; return say("OK\r\r>"); }
    if (c.startsWith("ATCM")) { filter = { ...(filter || { cf: 0 }), type: "mask", cm: parseInt(c.split(" ")[1], 16) }; return say("OK\r\r>"); }
    if (c === "ATMA" || c === "STM") return startStream();
    return say("OK\r\r>");
  }
  let buf = "";
  return {
    sent,
    async open() {},
    async close() { clearInterval(timer); },
    readable: new ReadableStream({ start(ctrl) { push = b => ctrl.enqueue(b); } }),
    writable: new WritableStream({ write(chunk) {
      buf += new TextDecoder().decode(chunk);
      let i; while ((i = buf.indexOf("\r")) >= 0) { const cmd = buf.slice(0, i); buf = buf.slice(i + 1); setTimeout(() => handle(cmd), 5); }
    } }),
  };
}

const IDS = [0x118, 0x132, 0x257, 0x352, 0x3D2, 0x401];
async function run(name, opts, check) {
  const port = fakePort(opts), seen = new Set(), statuses = [];
  const link = new ElmLink({ onLine: l => { const m = /^([0-9A-F]{3})/.exec(l); if (m && l.length > 5) seen.add(m[1]); }, onStatus: s => statuses.push(s) });
  let err = null;
  try {
    await link.open(port); await link.init(IDS); await link.startMonitor();
    await new Promise(r => setTimeout(r, 4500));
    await link.stopMonitor();
  } catch (e) { err = e; }
  await link.close();
  check({ link, port, seen, err, statuses });
  console.log("ok -", name);
}

(async () => {
  await run("STN adapter: pass filters + STM", { stn: true }, ({ link, port, seen, err }) => {
    assert.ifError(err);
    assert.strictEqual(link.mode, "stn");
    assert.ok(port.sent.includes("STFAP 132,7FF") && port.sent.includes("STM"));
    assert.ok(["118", "132", "257"].every(id => seen.has(id)));
  });
  await run("vLinker-style ELM: round-robin ATCRA groups, all IDs reached", { stn: false }, ({ link, port, seen, err }) => {
    assert.ifError(err);
    assert.strictEqual(link.mode, "elm"); assert.strictEqual(link.useCra, true);
    assert.ok(port.sent.includes("ATCRA 13X") && port.sent.includes("ATMA"));
    assert.ok(!port.sent.some(c => c.startsWith("STFAP") || c === "STM"), "no STN commands on an ELM");
    for (const id of ["118", "132", "257", "352", "3D2", "401"]) assert.ok(seen.has(id), "saw " + id);
  });
  await run("old ELM firmware without wildcard ATCRA falls back to ATCF/ATCM", { stn: false, craOk: false }, ({ link, port, seen, err }) => {
    assert.ifError(err);
    assert.strictEqual(link.useCra, false);
    assert.ok(port.sent.includes("ATCF 130") && port.sent.includes("ATCM 7F0"));
    assert.ok(seen.has("132") && seen.has("118"));
  });
  await run("refuses to listen if silent monitoring isn't confirmed", { stn: false, csmOk: false }, ({ err, port }) => {
    assert.ok(err && /ATCSM1/.test(err.message));
    assert.ok(!port.sent.includes("ATMA"));
  });
  {
    // The app gives up on a Bluetooth open after 10 s and closes the link; an open that lands later must not keep the port.
    let isOpen = false;
    const port = { open: () => new Promise(r => setTimeout(() => { isOpen = true; r(); }, 100)), async close() { isOpen = false; },
      readable: new ReadableStream(), writable: new WritableStream() };
    const link = new ElmLink({});
    const opening = link.open(port).then(() => null, e => e);
    await link.close();
    assert.ok(await opening, "a late open is refused");
    assert.strictEqual(isOpen, false, "port closed again");
    console.log("ok - a Bluetooth open that finishes after close() releases the port");
  }
  console.log("\nall elm tests passed");
})();
