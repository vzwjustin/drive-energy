// Offline shell: the screen keeps working in the car with no signal once it has loaded once.
// Network first, bypassing the browser's HTTP cache, so a new page never runs with an old script.
const CACHE = "drive-energy-v22";
const SHELL = ["./", "index.html", "app.js", "decode.js", "elm.js", "sim.js", "coach.js", "drives.js", "stops.js", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  const net = sameOrigin && req.mode !== "navigate" ? fetch(req.url, { cache: "no-cache" }) : fetch(req, sameOrigin ? { cache: "no-cache" } : undefined);
  e.respondWith(net.then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })
    .catch(() => caches.match(req, { ignoreSearch: true })));
});
