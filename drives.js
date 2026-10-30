/* Drive segmentation + end-of-drive summary + history.
   A drive starts when the car moves (>2 mph) and ends after 20 s parked in P (or 3 min stopped in D),
   or when the driver taps End drive. Pure logic: the app feeds it cumulative counters each tick. */
(function (root) {
  "use strict";

  // Same formula as the live score: 70% consumption vs rated (100 at ≤85%, 0 at ≥150%), 30% pedal in range.
  function score(wh, rated, pedalPct) {
    if (!(wh > 0) || !(rated > 0)) return null;
    const s1 = Math.max(0, Math.min(1, (1.5 - wh / rated) / 0.65)) * 100;
    return Math.round(0.7 * s1 + 0.3 * (pedalPct ?? s1));
  }

  // The single most useful habit to work on next, from what this drive actually measured.
  function habit(d) {
    if (d.friction >= 3) return { tone: "warn", text: `Lift off earlier: ${d.friction} slowdowns used the brake with little regen. Coasting into stops keeps that energy.` };
    const used = (d.accelKWh || 0) + (d.cruiseKWh || 0);
    if (used > 0.2 && d.accelKWh / used > 0.3) return { tone: "warn", text: `Speeding up took ${Math.round((d.accelKWh / used) * 100)}% of the driving energy. Build speed gradually and lift early so you don't brake away what you spent.` };
    if (d.pedalPct != null && d.pedalPct < 60 && d.heavy >= 3) return { tone: "warn", text: `Ease take-offs: ${d.heavy} heavy-pedal moments. Up to 40% pedal gets most of the speed for far less energy.` };
    if (d.cruiseBand != null && d.sweetBand != null && d.cruiseBand >= d.sweetBand + 10)
      return { tone: "warn", text: `Most of this drive was at ${d.cruiseBand}–${d.cruiseBand + 4} mph. Your data says ${d.sweetBand}–${d.sweetBand + 4} mph is your most efficient band.` };
    if (d.climateKWh != null && d.kwh > 0 && d.climateKWh / d.kwh > 0.25)
      return { tone: "warn", text: `Climate used ${Math.round((d.climateKWh / d.kwh) * 100)}% of this drive's energy. Precondition while plugged in and lean on seat heat.` };
    if (d.pedalPct != null && d.pedalPct < 60) return { tone: "warn", text: `Pedal was in the 15–40% range ${d.pedalPct}% of the time. Aim for 70%+: smooth, moderate inputs.` };
    if (d.vsRatedPct != null && d.vsRatedPct <= 0) return { tone: "good", text: "Beat the car's rated consumption. Keep doing exactly this." };
    return { tone: "good", text: "Smooth drive. Small gains left: look further ahead and coast earlier." };
  }

  function createDrives({ load, save } = {}) {
    const s = { cur: null, stoppedFor: 0, history: (load && load()) || [], persist: true };

    function snap(x) { return { odo: x.odo, drive: x.drive, park: x.park, regen: x.regen, climate: x.climateKWh, accel: x.accelKWh ?? 0, cruise: x.cruiseKWh ?? 0, heavy: x.heavy, friction: x.friction, pressed: x.pressedSec, right: x.rightSec }; }

    function finish(x, now) {
      const c = s.cur, a = c.start, b = snap(x); s.cur = null; s.stoppedFor = 0;
      const mi = b.odo - a.odo; if (!(mi >= 0.3)) return null;
      const kwh = b.drive - a.drive, wh = (kwh * 1000) / mi, rated = x.rated || null;
      const pressed = b.pressed - a.pressed, pedalPct = pressed > 10 ? Math.round(((b.right - a.right) / pressed) * 100) : null;
      let cruiseBand = null, best = 0;
      for (const k in c.bands) if (c.bands[k] > best) { best = c.bands[k]; cruiseBand = +k; }
      const d = {
        id: `${c.t0}`, t0: c.t0, t1: now, mi, kwh, wh, rated,
        vsRatedPct: rated ? Math.round((wh / rated - 1) * 100) : null,
        rangeDeltaMi: rated ? mi - (kwh * 1000) / rated : null,           // + = range saved vs driving at rated
        pedalPct, heavy: b.heavy - a.heavy, friction: b.friction - a.friction,
        regenKWh: b.regen - a.regen, parkKWh: b.park - a.park,
        climateKWh: a.climate != null && b.climate != null ? b.climate - a.climate : null,
        accelKWh: b.accel - a.accel, cruiseKWh: b.cruise - a.cruise,
        avgMph: c.movingSec > 0 ? (mi / c.movingSec) * 3600 : null, maxMph: c.maxMph,
        cruiseBand: best > 60 ? cruiseBand : null, sweetBand: x.sweetBand ?? null, outsideC: x.outsideC ?? null, demo: !!x.demo,
      };
      d.score = score(wh, rated, pedalPct);
      d.habit = habit(d);
      if (!d.demo) { s.history.unshift(d); if (s.history.length > 60) s.history.length = 60; if (save) save(s.history); }
      return d;
    }

    // x: { odo, mph, gear, drive, park, regen, climateKWh, heavy, friction, pressedSec, rightSec, rated, sweetBand, outsideC, demo }
    function update(x, dt, now) {
      if (x.odo == null || x.drive == null) return null;
      const moving = (x.mph ?? 0) > 2;
      if (!s.cur) {
        if (moving) s.cur = { t0: now, start: snap(x), movingSec: 0, maxMph: 0, bands: {} };
        return null;
      }
      if (moving) {
        s.stoppedFor = 0; s.cur.movingSec += dt; s.cur.maxMph = Math.max(s.cur.maxMph, x.mph);
        if (x.mph >= 20) { const k = Math.floor(x.mph / 5) * 5; s.cur.bands[k] = (s.cur.bands[k] || 0) + dt; }
        return null;
      }
      s.stoppedFor += dt;
      return s.stoppedFor >= (x.gear === "P" ? 20 : 180) ? finish(x, now) : null;
    }

    return {
      update, finish: (x, now) => (s.cur ? finish(x, now) : null),
      cancel() { s.cur = null; s.stoppedFor = 0; },
      get active() { return !!s.cur; }, get history() { return s.history; },
      remove(id) { s.history = s.history.filter(d => d.id !== id); if (save) save(s.history); },
    };
  }

  const api = { createDrives, score, habit };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Drives = api;
})(typeof self !== "undefined" ? self : this);
