/* Efficiency coach: reads accelerator pedal, brake and speed (0x118, 0x257) plus pack power (0x132)
   and turns them into one short, glanceable tip, a trip score, and a speed-vs-consumption table
   learned from this car's own steady cruising. */
(function (root) {
  "use strict";

  // Pedal "green zone": how far down the pedal can go and still be an efficient request.
  // Take-offs need less than people think; highway cruise needs more just to hold speed.
  const greenMax = mph => (mph < 25 ? 30 : mph < 50 ? 40 : 50);
  const HARD_PEDAL = 60, BRAKE_SPEED = 8, JERKY = 22;

  function createCoach({ loadBuckets, saveBuckets }) {
    const c = {
      lastPedal: null, lastMph: null, jerk: 0,
      driveSec: 0, greenSec: 0, hardLaunches: 0, brakeStops: 0,
      wasHard: false, wasBrake: false,
      tip: null, tipAt: 0,
      buckets: (loadBuckets && loadBuckets()) || {}, lastSave: 0, persist: true,
    };

    function resetTrip() {
      Object.assign(c, { driveSec: 0, greenSec: 0, hardLaunches: 0, brakeStops: 0, jerk: 0, wasHard: false, wasBrake: false });
    }
    function resetBuckets() { c.buckets = {}; if (saveBuckets) saveBuckets(c.buckets); }

    function table() {
      const rows = Object.keys(c.buckets).map(Number).sort((a, b) => a - b)
        .map(b => ({ mph: b, mi: c.buckets[b].mi, wh: (c.buckets[b].kwh * 1000) / c.buckets[b].mi }))
        .filter(r => r.mi >= 0.5 && r.wh > 50 && r.wh < 800);
      const fast = rows.filter(r => r.mph >= 25);
      const sweet = fast.length ? fast.reduce((a, b) => (b.wh < a.wh ? b : a)) : null;
      return { rows, sweet };
    }

    function pick(tip, now) {
      // Hold a tip at least 3 s so the line doesn't flicker; a higher-priority tip can cut in.
      if (!c.tip || now - c.tipAt > 3000 || tip.prio > c.tip.prio || tip.key === c.tip.key) {
        if (!c.tip || tip.key !== c.tip.key) c.tipAt = now;
        c.tip = tip;
      }
    }

    // Call ~4×/s. kw = smoothed pack power (+ = using), dt in seconds.
    function update(L, kw, dt, now) {
      const mph = L.speedMph ?? 0, pedal = L.pedalPct, brake = L.brakeOn === true;
      const moving = mph > 2 && L.gear !== "P";
      if (pedal != null && c.lastPedal != null && dt > 0) {
        const rate = Math.abs(pedal - c.lastPedal) / dt;                  // %/s
        c.jerk += (rate - c.jerk) * Math.min(1, dt / 3);                  // ~3 s average
      }
      const rawAccel = c.lastMph != null && dt > 0 ? (mph - c.lastMph) / dt : 0;
      c.accel = (c.accel ?? 0) + (rawAccel - (c.accel ?? 0)) * Math.min(1, dt / 1.5);   // ~1.5 s average
      const accel = c.accel;
      c.lastPedal = pedal; c.lastMph = mph;

      if (!moving) {
        c.wasHard = false; c.wasBrake = false;
        pick({ key: "parked", prio: 0, tone: "idle", text: kw != null && kw < -0.3 ? "Charging" : "Parked. Tips show up once you're rolling." }, now);
        return;
      }
      c.driveSec += dt;

      const brakeAtSpeed = brake && mph > BRAKE_SPEED;
      if (brakeAtSpeed && !c.wasBrake) c.brakeStops++;
      c.wasBrake = brakeAtSpeed;

      const hard = pedal != null && pedal >= HARD_PEDAL && mph < 50;
      if (hard && !c.wasHard) c.hardLaunches++;
      c.wasHard = hard;

      const inGreen = pedal != null && pedal <= greenMax(mph) && c.jerk < JERKY && !brakeAtSpeed;
      if (inGreen) c.greenSec += dt;

      // Learn Wh/mi per 5-mph band from steady cruising only (no big speed changes).
      if (kw != null && mph >= 20 && Math.abs(accel) < 0.4 && !brake) {
        const b = Math.floor(mph / 5) * 5, k = (c.buckets[b] ||= { kwh: 0, mi: 0 });
        k.kwh += (kw * dt) / 3600; k.mi += (mph * dt) / 3600;
        if (c.persist && saveBuckets && now - c.lastSave > 15000) { saveBuckets(c.buckets); c.lastSave = now; }
      }

      // Tip, highest priority first.
      if (pedal == null) { pick({ key: "nopedal", prio: 1, tone: "idle", text: "Pedal data isn't on this connection." }, now); return; }
      if (brakeAtSpeed) return pick({ key: "brake", prio: 6, tone: "bad", text: "Brake pedal at speed: lift off earlier and let regen slow you." }, now);
      if (hard) return pick({ key: "hard", prio: 5, tone: "warn", text: `Ease in: keep take-offs under ${greenMax(mph)}% pedal.` }, now);
      if (c.jerk > JERKY) return pick({ key: "jerky", prio: 4, tone: "warn", text: "Smooth it out. A steady foot beats pumping the pedal." }, now);
      const { rows, sweet } = table();
      const here = rows.find(r => r.mph === Math.floor(mph / 5) * 5), slower = rows.find(r => r.mph === Math.floor(mph / 5) * 5 - 5);
      if (here && slower && mph >= 55 && here.wh > slower.wh * 1.06) {
        const save = Math.round((1 - slower.wh / here.wh) * 100);
        return pick({ key: "speed", prio: 3, tone: "warn", text: `5 mph slower saves about ${save}% here (${Math.round(here.wh)} → ${Math.round(slower.wh)} Wh/mi in your data).` }, now);
      }
      if (pedal === 0 && kw != null && kw < -2) return pick({ key: "regen", prio: 2, tone: "good", text: `Regen on: recovering ${Math.abs(kw).toFixed(0)} kW.` }, now);
      if (inGreen) return pick({ key: "green", prio: 1, tone: "good", text: sweet ? `Efficient. Your sweet spot is ${sweet.mph}–${sweet.mph + 4} mph at ${Math.round(sweet.wh)} Wh/mi.` : "Efficient. Keep it right here." }, now);
      return pick({ key: "over", prio: 2, tone: "warn", text: `Pedal past the green zone (${greenMax(mph)}% at this speed).` }, now);
    }

    return {
      update, resetTrip, resetBuckets, table, greenMax,
      get state() { return c; },
      score() { return c.driveSec > 20 ? Math.round((c.greenSec / c.driveSec) * 100) : null; },
      setPersist(on) { c.persist = on; },
    };
  }

  const api = { createCoach, greenMax };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Coach = api;
})(typeof self !== "undefined" ? self : this);
