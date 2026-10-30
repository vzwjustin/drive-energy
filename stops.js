/* Slowdown capture: for each slowdown (from ≥15 mph, losing ≥10 mph), how much of the car's kinetic energy
   came back through regen. Capture = regen kWh ÷ kinetic energy lost (½·m·(v0²−v1²)). Drag and rolling losses
   during the slowdown mean ~60–75% is excellent; braking late on the friction brakes pulls it down. */
(function (root) {
  "use strict";
  const MASS = 1850, MS = 0.44704;
  const kineticKWh = (mph0, mph1) => (0.5 * MASS * ((mph0 * MS) ** 2 - (mph1 * MS) ** 2)) / 3.6e6;
  const grade = pct => (pct >= 60 ? "good" : pct >= 40 ? "warn" : "bad");

  function createStops() {
    const s = { ev: null, accel: 0, lastMph: null, last: null, n: 0, sumPct: 0, kinetic: 0, regen: 0, history: [] };
    function close(mph1) {
      const e = s.ev; s.ev = null;
      if (!(e.v0 - mph1 >= 10)) return null;
      if (e.liftSec + e.brakeSec < 0.5 * e.dur) return null;   // mostly feathering the pedal: not a regen opportunity
      const k = kineticKWh(e.v0, mph1); if (!(k > 0.005)) return null;
      const pct = Math.max(0, Math.min(100, Math.round((e.regen / k) * 100)));
      const out = { v0: Math.round(e.v0), v1: Math.round(mph1), pct, braked: e.brakeSec > 1, regenKWh: e.regen, kineticKWh: k, tone: grade(pct), stop: mph1 < 3 };
      s.last = out; s.n++; s.sumPct += pct; s.kinetic += k; s.regen += e.regen; s.history.push(pct); if (s.history.length > 50) s.history.shift();
      return out;
    }
    // x: { mph, kw, brake, pedal }, dt seconds. Returns a finished slowdown when one ends.
    function update(x, dt) {
      const mph = x.mph ?? 0;
      if (s.lastMph != null && dt > 0) s.accel += (((mph - s.lastMph) / dt) * MS - s.accel) * Math.min(1, dt / 1);
      s.lastMph = mph;
      if (!s.ev) {
        if (mph >= 15 && s.accel < -0.3) s.ev = { v0: mph, regen: 0, brakeSec: 0, liftSec: 0, dur: 0, upSec: 0, minMph: mph };
        return null;
      }
      const e = s.ev;
      if (x.kw != null && x.kw < 0) e.regen += (-x.kw * dt) / 3600;
      if (x.brake === true) e.brakeSec += dt;
      else if (x.pedal == null || x.pedal < 2) e.liftSec += dt;
      e.dur += dt;
      e.minMph = Math.min(e.minMph, mph);
      if (mph < 3) return close(mph);
      if (s.accel > 0.2) { e.upSec += dt; if (e.upSec > 2) return close(e.minMph); } else e.upSec = 0;
      return null;
    }
    return {
      update, reset() { Object.assign(s, { ev: null, last: null, n: 0, sumPct: 0, kinetic: 0, regen: 0, history: [] }); },
      get state() { return s; },
      avg() { return s.kinetic > 0.01 ? Math.round((s.regen / s.kinetic) * 100) : null; },
    };
  }
  const api = { createStops, kineticKWh, grade };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Stops = api;
})(typeof self !== "undefined" ? self : this);
