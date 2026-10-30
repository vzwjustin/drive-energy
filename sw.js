// Offline shell: the screen keeps working in the car with no signal once it has loaded once.
// Network first (up to 3 s), bypassing the browser's HTTP cache, so a new page never runs with an old script.
const CACHE = "drive-energy-v29";
const SHELL = ["./", "index.html", "app.js", "decode.js", "elm.js", "sim.js", "coach.js", "drives.js", "stops.js", "manifest.webmanifest", "icon.svg", "icon-maskable.svg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  // Tessie replies carry the car's data (VIN, location): never store them or replay stale ones offline.
  if (req.method !== "GET" || url.hostname === "api.tessie.com") return;
  const sameOrigin = url.origin === self.location.origin;
  const net = sameOrigin && req.mode !== "navigate" ? fetch(req.url, { cache: "no-cache" }) : fetch(req, sameOrigin ? { cache: "no-cache" } : undefined);
  const fresh = net.then(r => { if (!r.ok) return r; const copy = r.clone(); return caches.open(CACHE).then(c => c.put(req, copy)).then(() => r, () => r); });
  const saved = () => caches.match(req, { ignoreSearch: true });
  // A weak signal (a garage, one bar) mustn't stall the page: after 3 s serve the saved copy, and let the download
  // finish in the background so the next load gets it.
  e.waitUntil(fresh.catch(() => {}));
  e.respondWith(Promise.race([fresh, new Promise(res => setTimeout(res, 3000))])
    .then(r => r || saved().then(c => c || fresh))
    .catch(saved));
});
