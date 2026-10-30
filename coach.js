/* Range coach — same rules and thresholds as EcoLab's RangeCoach (vzwjustin/eco, core/sim/RangeCoach.kt),
   ported to JS so both apps coach the same way. Listen-only: advice for the driver, nothing is sent.
   Adds Drive Energy's own speed-band learning (now split by outside temperature) and trip stats. */
(function (root) {
  "use strict";

  const ECO_LOW = 15, ECO_HIGH = 40, HYST = 1;               // pedal %, EcoLab PEDAL_ECO_LOW/HIGH, ZONE_HYSTERESIS
  const LEVEL_ORDER = { WARN: 0, GOOD: 1, TIP: 2 };          // EcoLab sort: warnings first, then good, then tips
  const MPH_PER_MS = 2.2369363;
  const U = typeof module !== "undefined" && module.exports ? require("./units.js") : root.Units;

  function rawZone(p) {
    if (p == null || !isFinite(p)) return "OFF";
    if (p < 2) return "OFF";
    if (p < ECO_LOW) return "LIGHT";
    if (p <= ECO_HIGH) return "RIGHT";
    return "TOO_MUCH";
  }
  // A heavy pedal that is only holding speed uphill counts as right (EcoLab's grade/wind exemption; no wind estimate here).
  function loadZone(p, accelMs2, grade) {
    const z = rawZone(p);
    const holding = (accelMs2 ?? 1) <= 0.3 && (grade ?? 0) > 2;
    return z === "TOO_MUCH" && holding ? "RIGHT" : z;
  }
  function pedalZone(p, accelMs2, grade, prev) {
    const z = loadZone(p, accelMs2, grade);
    if (!prev || p == null || z === prev) return z;
    const pair = [prev, z].sort().join("|");
    const edge = pair === "LIGHT|RIGHT" ? ECO_LOW : pair === "RIGHT|TOO_MUCH" ? ECO_HIGH : null;
    return edge != null && Math.abs(p - edge) < HYST ? prev : z;
  }

  const deg = c => `${Math.round(U.temp(c))} ${U.t}`;
  const tempBand = c => (c == null || !isFinite(c) ? "x" : (f => (f < 40 ? "<40" : f < 60 ? "40-59" : f < 80 ? "60-79" : "80+"))((c * 9) / 5 + 32));

  /** EcoLab RangeCoach.cues, in the units picked in Setup. Returns cues most important first; a coasting reminder is always last. */
  function cues(x) {
    const { pedal, kw, mph, brake, soc, tMin, tMax, hvacKw, regenLimitKw, accelMs2, grade, outsideC, cruiseOn } = x;
    const kmh = mph != null ? Math.abs(mph) * 1.609344 : null;
    const moving = kmh != null && kmh > 5;
    const out = [];
    const add = (level, text, kind) => out.push({ level, text, kind });

    if (tMin != null) {
      if (tMin < 10 && (kw ?? 0) > 40) add("WARN", `Pack is cold (${deg(tMin)}) and drawing ${Math.round(kw)} kW. Ease off: hard draw on a cold pack wears it and wastes range.`, "pack.coldDraw");
      else if (tMin < 10) add("TIP", `Pack is cold (${deg(tMin)}): regen is reduced until it warms, so lift off earlier.`, "pack.cold");
    }
    if (tMax != null && tMax > 45) add("WARN", `Pack is hot (${deg(tMax)}). Smooth, lower-power driving keeps it from heating further.`, "pack.hot");
    if (soc != null) {
      if (soc < 15 && (kw ?? 0) > 60) add("WARN", `Low charge (${Math.floor(soc)}%) at ${Math.round(kw)} kW. Lighter pedal protects the pack and range.`, "soc.lowDraw");
      if (soc > 95 && moving) add("TIP", `Near full (${Math.floor(soc)}%): regen is limited, so brake gently and plan stops early.`, "soc.full");
    }
    if (regenLimitKw != null && regenLimitKw < 15 && moving) add("TIP", `Regen is limited to ${Math.floor(regenLimitKw)} kW: coast early rather than braking late.`, "regen.limited");

    if (moving && brake === true && (kw ?? 0) > -5) add("TIP", "Braking without much regen: lift off sooner next time and let the car slow itself.", "brake.friction");
    if (moving && pedal != null && !cruiseOn) {
      const a = accelMs2 ?? 0, g = grade ?? 0;
      const underLoad = a <= 0.3 && g > 2;
      const regenKw = kw != null && kw < -1 ? -kw : null;
      const limit = regenLimitKw != null && regenLimitKw > 0 ? regenLimitKw : null;
      if (pedal < 2 && regenKw != null && limit != null && regenKw >= limit * 0.9)
        add("TIP", `Regen is at its limit (${Math.floor(regenKw)} kW). Lift off earlier and more gently so slowing stays on regen, not friction.`, "pedal.regenAtLimit");
      else if (pedal < 2 && regenKw != null && a < -2.5) add("TIP", "Sharp slowdown from a quick lift-off. Ease the pedal up gradually: smoother regen, fewer losses.", "pedal.sharpLift");
      else if (pedal < 2 && regenKw != null) add("GOOD", `One-pedal slowing, recovering ${Math.floor(regenKw)} kW. Keep lifting gradually to stop where you want.`, "pedal.onePedal");
      else if (pedal < 2) add("GOOD", "Coasting. Staying off the pedal is the cheapest way to travel.", "pedal.coast");
      else if (pedal <= 15 && a < -0.3) add("GOOD", "Feathering the pedal to slow down: regen is doing the work. Release a little more to slow faster.", "pedal.feather");
      else if (pedal >= ECO_LOW && pedal <= ECO_HIGH && a > 0.3) add("GOOD", `Smooth acceleration (${Math.floor(pedal)}% pedal). Ease off as you reach your speed.`, "pedal.smooth");
      else if (pedal <= 15 && a <= 0.1 && g < 1) add("TIP", "Light pedal at a steady speed. If the road ahead allows, lift off and coast.", "pedal.lightSteady");
      else if (pedal > ECO_HIGH && underLoad) add("GOOD", `Holding speed uphill takes this pedal (${Math.floor(pedal)}%). That's right: steady is cheaper than speeding up.`, "pedal.underLoad");
      else if (pedal > ECO_HIGH) add("TIP", `Pedal ${Math.floor(pedal)}%. Ease back toward ${ECO_HIGH}% or less: most of the speed for much less energy.`, "pedal.heavy");
    }
    if (grade != null && moving) {
      if (grade > 3) add("TIP", `Uphill (${Math.trunc(grade)}%): high draw is normal. Hold a steady speed and don't chase speed limits.`, "grade.up");
      if (grade < -2 && pedal != null && pedal < 2) add("GOOD", "Downhill: let regen carry you and keep off the pedal.", "grade.downOff");
      if (grade < -2 && pedal != null && pedal >= 2) add("TIP", "Downhill: lift off the pedal and let regen and gravity do the work.", "grade.downOn");
    }
    if (outsideC != null) {
      if (outsideC < 5) add("TIP", `Cold air (${deg(outsideC)}): higher ${U.e} is normal. Precondition while plugged in, and use seat heat over cabin heat.`, "air.cold");
      if (outsideC > 30 && (hvacKw ?? 0) > 2) add("TIP", `Hot day (${deg(outsideC)}): A/C is a big share of the draw. Park in shade and precondition while plugged in.`, "air.hot");
    }
    if (cruiseOn && moving) add("TIP", "Cruise is holding speed. Set it at or under the limit; on rolling hills your own light pedal can use less energy.", "cruise");
    if (hvacKw != null && hvacKw > 3) add("TIP", `Climate is using ${hvacKw.toFixed(1)} kW. Seat heat or a lower setpoint costs less range.`, "climate");
    if (kmh != null && kmh > 112) add("TIP", `Above ~${U.metric ? "110 km/h" : "70 mph"} aero drag rises sharply: a few ${U.s} less adds noticeable range.`, "aero");
    out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
    out.push({ level: "TIP", text: "For max range: look ahead, lift off the pedal early and coast to slow down instead of braking late.", kind: "coast", standing: true });
    return out;
  }

  // One line of coaching on screen. It keeps its tip at least HOLD ms (refreshing the live numbers in it) so it can be
  // read in a glance or two, then moves to the tip that has led for SETTLE ms, not one that flickered up for a moment.
  const HOLD = 8000, SETTLE = 2000;
  function show(s, top, list, now, force) {
    const kind = top ? top.kind : null;
    if (kind === (s.cur ? s.cur.kind : null)) { s.cur = top; s.next = kind; return; }   // same tip (or still none), fresh numbers
    if (kind !== s.next) { s.next = kind; s.nextAt = now; }                               // a new leader starts settling
    if (force || (now - s.nextAt >= SETTLE && (!s.cur || now - s.at >= HOLD))) { s.cur = top; s.at = now; return; }
    if (s.cur) s.cur = list.find(q => q.kind === s.cur.kind) || s.cur;                   // still held: its numbers stay current
  }

  function createCoach({ loadBuckets, saveBuckets } = {}) {
    const c = {
      zone: null, lastMph: null, accel: 0,
      driveSec: 0, pressedSec: 0, rightSec: 0, heavyEvents: 0, frictionEvents: 0, wasHeavy: false, wasFriction: false,
      headline: null, second: null, line1: { cur: null, at: 0 }, line2: { cur: null, at: 0 }, list: [], cruiseOn: false,
      buckets: migrate((loadBuckets && loadBuckets()) || {}), lastSave: 0,
    };
    function migrate(b) { const o = {}; for (const k in b) o[String(k).includes("|") ? k : `${k}|x`] = b[k]; return o; }

    function resetTrip() { Object.assign(c, { driveSec: 0, pressedSec: 0, rightSec: 0, heavyEvents: 0, frictionEvents: 0, wasHeavy: false, wasFriction: false }); }
    function resetBuckets() { c.buckets = {}; if (saveBuckets) saveBuckets(c.buckets); }

    function table(outsideC) {
      const tb = tempBand(outsideC), agg = {};
      for (const k in c.buckets) {
        const [b, t] = k.split("|");
        if (tb !== "x" && t !== tb) continue;          // known temperature: show that band only
        const a = (agg[b] ||= { kwh: 0, mi: 0 }); a.kwh += c.buckets[k].kwh; a.mi += c.buckets[k].mi;
      }
      const rows = Object.keys(agg).map(Number).sort((a, b) => a - b)
        .map(b => ({ mph: b, mi: agg[b].mi, wh: (agg[b].kwh * 1000) / agg[b].mi }))
        .filter(r => r.mi >= 0.5 && r.wh > 50 && r.wh < 800);
      const fast = rows.filter(r => r.mph >= 25);
      return { rows, sweet: fast.length ? fast.reduce((a, b) => (b.wh < a.wh ? b : a)) : null, band: tb };
    }

    // x: { pedal, kw, mph, brake, soc, tMin, tMax, hvacKw, regenLimitKw, grade, outsideC, gear }
    function update(x, dt, now) {
      const mph = x.mph ?? 0;
      const raw = c.lastMph != null && dt > 0 ? ((mph - c.lastMph) / dt) / MPH_PER_MS : 0;   // m/s²
      c.accel += (raw - c.accel) * Math.min(1, dt / 1.5); c.lastMph = mph;
      c.zone = pedalZone(x.pedal, c.accel, x.grade, c.zone);
      const moving = mph * 1.609344 > 5 && x.gear !== "P";
      const list = cues({ ...x, accelMs2: c.accel, cruiseOn: c.cruiseOn });
      c.list = list;

      if (moving) {
        c.driveSec += dt;
        if (x.pedal != null && x.pedal >= 2 && !c.cruiseOn) { c.pressedSec += dt; if (c.zone === "RIGHT") c.rightSec += dt; }
        const heavy = list.some(q => q.kind === "pedal.heavy");
        if (heavy && !c.wasHeavy) c.heavyEvents++; c.wasHeavy = heavy;
        const fr = list.some(q => q.kind === "brake.friction");
        if (fr && !c.wasFriction) c.frictionEvents++; c.wasFriction = fr;
        // Learn Wh/mi per 5-mph band and outside-temperature band from steady cruising only.
        if (x.kw != null && mph >= 20 && Math.abs(c.accel) < 0.18 && x.brake !== true) {
          const k = `${Math.floor(mph / 5) * 5}|${tempBand(x.outsideC)}`, b = (c.buckets[k] ||= { kwh: 0, mi: 0 });
          b.kwh += (x.kw * dt) / 3600; b.mi += (mph * dt) / 3600;
          if (saveBuckets && now - c.lastSave > 15000) { saveBuckets(c.buckets); c.lastSave = now; }
        }
        // Drive Energy addition: your own data says the next band down is cheaper.
        const { rows } = table(x.outsideC), band = Math.floor(mph / 5) * 5;
        const here = rows.find(r => r.mph === band), slower = rows.find(r => r.mph === band - 5);
        if (here && slower && mph >= 55 && here.wh > slower.wh * 1.06 && !list.some(q => q.level === "WARN")) {
          const at = list.findIndex(q => q.level === "TIP");     // keeps EcoLab order: warnings, good, then tips
          list.splice(at < 0 ? list.length : at, 0, { level: "TIP", kind: "speed.data",
            text: `${Math.round(U.speed(5))} ${U.s} slower saves about ${Math.round((1 - slower.wh / here.wh) * 100)}% here (${Math.round(U.wh(here.wh))} → ${Math.round(U.wh(slower.wh))} ${U.e} in your data).` });
        }
      } else { c.wasHeavy = false; c.wasFriction = false; }

      // Headline, then a second line with the next tip. A warning, or shifting into or out of P, switches at once;
      // "Stopped." waits its turn like any tip, so creeping in traffic doesn't flip it on and off.
      const parked = x.gear === "P", top = moving ? list[0]
        : parked ? { level: "TIP", kind: "parked", text: x.kw != null && x.kw < -0.3 ? "Charging." : "Parked. Coaching starts once you're rolling." }
        : { level: "TIP", kind: "stopped", text: "Stopped." };
      const h = c.line1.cur;
      show(c.line1, top, list, now, !h || (top.level === "WARN" && h.level !== "WARN") || parked !== (h.kind === "parked"));
      c.headline = c.line1.cur;
      const next = (moving && list.find(q => q.kind !== c.headline.kind && !q.standing)) || null;
      show(c.line2, next, list, now, parked || (c.line2.cur && c.line2.cur.kind === c.headline.kind));
      c.second = c.line2.cur;
    }

    return {
      update, resetTrip, resetBuckets, table,
      get state() { return c; },
      score() { return c.pressedSec > 15 ? Math.round((c.rightSec / c.pressedSec) * 100) : null; },
      setCruise(on) { c.cruiseOn = !!on; },
    };
  }

  const api = { createCoach, cues, pedalZone, rawZone, ECO_LOW, ECO_HIGH, tempBand };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Coach = api;
})(typeof self !== "undefined" ? self : this);
