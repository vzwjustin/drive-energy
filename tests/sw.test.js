// Run: node tests/sw.test.js — the service worker caches the app and its fonts, never Tessie API replies.
const assert = require("assert"), vm = require("vm"), fs = require("fs"), path = require("path");
const on = {}, cached = [];
const ctx = {
  URL, setTimeout,
  self: { location: { origin: "https://me.github.io" }, addEventListener: (t, f) => (on[t] = f) },
  caches: { open: async () => ({ put: async req => cached.push(req.url) }), match: async () => undefined },
  fetch: async () => ({ ok: true, clone() { return this; } }),
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../sw.js"), "utf8"), ctx);

// Returns whether the worker answered the request itself.
async function get(url) {
  let res = null;
  on.fetch({ request: { url, method: "GET", mode: "cors" }, respondWith: p => (res = p), waitUntil() {} });
  if (res) await res;
  await new Promise(r => setTimeout(r, 10));
  return res != null;
}

(async () => {
  assert.ok(await get("https://me.github.io/drive-energy/app.js?v=24"));
  assert.ok(cached.includes("https://me.github.io/drive-energy/app.js?v=24"));
  console.log("ok - app files are cached for offline use");

  assert.ok(await get("https://fonts.gstatic.com/s/barlow/v12/font.woff2"));
  console.log("ok - fonts are still cached");

  assert.strictEqual(await get("https://api.tessie.com/VIN1/state?use_cache=true"), false, "Tessie request handled by the worker");
  assert.ok(!cached.some(u => u.includes("api.tessie.com")), "Tessie reply was cached");
  console.log("ok - Tessie API replies are never cached or replayed");

  // One bar of signal: the request hangs, so the saved copy is served after 3 s instead of waiting it out.
  ctx.fetch = () => new Promise(() => {}); ctx.caches.match = async () => "saved copy";
  let res = null; const t0 = Date.now();
  on.fetch({ request: { url: "https://me.github.io/drive-energy/", method: "GET", mode: "navigate" }, respondWith: p => (res = p), waitUntil() {} });
  assert.strictEqual(await res, "saved copy"); assert.ok(Date.now() - t0 < 4000, "took " + (Date.now() - t0) + " ms");
  console.log("ok - a hanging network falls back to the saved copy after 3 s");
  process.exit(0);                                         // the hanging request would keep Node waiting
})().catch(e => { console.error(e); process.exit(1); });
