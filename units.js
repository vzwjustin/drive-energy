/* Units: everything inside the app stays in miles, mph, Wh/mi and °C (what the car sends and the saved data use).
   These turn values into the units picked in Setup for the screen, and typed distances back into miles. */
(function (root) {
  "use strict";
  const KM = 1.609344;
  let metric = false;
  const num = f => v => (v == null || !isFinite(v) ? v : f(v));
  const dist = num(mi => (metric ? mi * KM : mi));
  // Speed bands are learned in 5-mph steps; in km/h each band is shown by its converted edges (60–64 mph = 97–104 km/h).
  const bandTop = m => (metric ? Math.round((m + 5) * KM) - 1 : m + 4);
  const BAND_C = { "<40": "below 4", "40-59": "4–15", "60-79": "16–26", "80+": "27+" };   // the speed table's °F bands
  const api = {
    KM,
    set(u) { metric = u === "km"; },
    get metric() { return metric; },
    dist, speed: dist,                                     // miles → shown distance, mph → shown speed
    toMi: num(d => (metric ? d / KM : d)),                 // a typed distance → miles
    wh: num(w => (metric ? w / KM : w)),                   // Wh/mi → Wh/km
    temp: num(c => (metric ? c : (c * 9) / 5 + 32)),       // °C → shown temperature
    bandTop,
    band: m => `${metric ? Math.round(m * KM) : m}–${bandTop(m)} ${metric ? "km/h" : "mph"}`,
    tempBand: b => (metric ? `${BAND_C[b] ?? b} °C` : `${b} °F`),
  };
  const WORDS = { d: ["mi", "km"], s: ["mph", "km/h"], e: ["Wh/mi", "Wh/km"], t: ["°F", "°C"], unit: ["mile", "km"], Unit: ["Mile", "Km"], units: ["miles", "kilometers"], Units: ["Miles", "Kilometers"] };
  for (const k in WORDS) Object.defineProperty(api, k, { get: () => WORDS[k][+metric], enumerable: true });

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Units = api;
})(typeof self !== "undefined" ? self : this);
