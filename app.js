/* Drive Energy — screen logic. Data path: OBDLink MX+ → Web Serial (Bluetooth) → STN monitor lines
   → CanDecode → trip math → screen. Demo mode feeds the same path from CanSim. */
(() => {
  "use strict";
  // Show script errors on screen instead of failing silently, so they can be reported.
  window.addEventListener("error", e => {
    const n = document.getElementById("notice"); if (!n) return;
    n.hidden = false; n.dataset.tone = "bad";
    document.getElementById("noticeText").textContent = `Something broke: ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno}). Reload; if it stays, send this to Claude.`;
  });
  const $ = id => document.getElementById(id);
  const D = window.CanDecode;
  const LISTEN = Object.values(D.IDS);
  const KEY = { drives: "de.drives.v1", speed: "de.speed.v1", trip: "de.trip.v1", tripT: "de.trip.tessie.v1", cfg: "de.cfg.v1", tok: "de.tessie.v1" };
  const DEMO_SPEED = 8;
  const tripKey = src => (src === "tessie" ? KEY.tripT : KEY.trip);
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  const cfg = Object.assign({ win: 15, brick: 38, oneBased: true, keepAwake: true, drive: false, goal: null }, load(KEY.cfg, {}));
  let dec = D.createDecoder(), L = dec.state;
  const app = {
    source: null, link: null, port: null, sim: null, simTimer: null,
    frames: 0, fps: 0, lastFrameAt: 0, pEma: null, synthNet: 0, synthOdo: 0, lastTick: performance.now(),
    restartAt: 0, trip: load(KEY.trip, null), rec: null, wake: null, lastSave: 0,
    tessieTimer: null, vin: null, tessieBusy: false,
    idStats: {}, rawLines: [], bufferFull: 0,
  };
  const drives = Drives.createDrives({ load: () => load(KEY.drives, []), save: h => store(KEY.drives, h) });
  const stops = Stops.createStops();
  const realCoach = Coach.createCoach({ loadBuckets: () => load(KEY.speed, {}), saveBuckets: b => store(KEY.speed, b) });
  app.coach = realCoach;

  /* ---------------- status ---------------- */
  function status(kind, text) {
    $("chip").dataset.s = kind; $("chipText").textContent = text;
    $("connectBtn").hidden = app.source === "car";
    $("disconnectBtn").hidden = app.source !== "car";
    $("demoBtn").textContent = app.source === "demo" ? "Stop demo" : "Demo";
    $("tessieBtn").textContent = app.source === "tessie" ? "Stop Tessie" : "Tessie";
  }
  function notice(text, tone) {
    const n = $("notice"); n.hidden = !text; n.dataset.tone = tone || "warn"; $("noticeText").textContent = text || "";
  }

  /* ---------------- frames in ---------------- */
  function onLine(line) {
    const f = D.parseLine(line);
    if (f) {
      const r = dec.decode(f.id, f.bytes); app.frames++; app.lastFrameAt = performance.now();
      const s = (app.idStats[f.id] ||= { n: 0, ok: 0, last: 0, sample: "" });
      s.n++; if (r) s.ok++; s.last = app.lastFrameAt; s.sample = line.replace(/\s+/g, "");
      return;
    }
    app.rawLines.push(`${new Date().toLocaleTimeString()}  ${line}`); if (app.rawLines.length > 30) app.rawLines.shift();
    if (/BUFFER FULL/i.test(line)) app.bufferFull++;
    if (/BUFFER FULL|DATA ERROR|CAN ERROR|<RX ERROR/i.test(line) && app.link && performance.now() - app.restartAt > 2000) {
      app.restartAt = performance.now();
      app.link.restartMonitor().catch(() => {});
    }
  }

  /* ---------------- car connection ---------------- */
  // auto = true: a background attempt with an adapter Chrome already has permission for (no chooser, quiet on failure).
  async function connectCar(auto = false) {
    if (!window.ElmLink || !ElmLink.supported()) {
      if (!auto) notice("This browser can't open Bluetooth serial ports. Use Chrome 138 or newer on Android, opened from an https:// address.", "bad");
      return;
    }
    if (app.connecting) return; app.connecting = true;
    if (!auto) app.userStopped = false;
    if (auto && app.source) { app.connecting = false; return; }
    stopDemo(); stopTessie();
    const link = new ElmLink({ onLine, onStatus: onLinkStatus });
    try {
      let port = app.port;
      if (!port) {
        const known = await navigator.serial.getPorts();
        const saved = cfg.portInfo && known.find(p => { const i = p.getInfo ? p.getInfo() : {}; return i.bluetoothServiceClassId && i.bluetoothServiceClassId === cfg.portInfo.bluetoothServiceClassId; });
        port = saved || (known.length >= 1 && auto ? known[0] : known.length === 1 ? known[0] : null);
        if (!port) { if (auto) throw Object.assign(new Error("no granted adapter"), { quiet: true }); port = await link.pick(); }
      }
      try { cfg.portInfo = port.getInfo ? port.getInfo() : null; store(KEY.cfg, cfg); } catch (e) {}
      app.port = port; app.link = link; app.source = "car";
      status("connecting", "Connecting");
      notice(null);
      await link.open(port);
      await link.init(LISTEN);
      resetDecoder();
      await link.startMonitor();
      status("live", "Live");
      $("adapter").textContent = `${link.chip.replace(/\s+/g, " ")} · ${link.mode === "stn" ? "STN filters, continuous" : "ELM round-robin, ~1 s refresh"} · listen-only`;
      keepAwake();
      if (auto) notice("Connected to the adapter automatically.", "info");
    } catch (e) {
      await link.close().catch(() => {});
      app.link = null; app.source = null;
      if (auto) {
        // Adapter not powered/in range yet (car off, phone just got in): keep the remembered port and try again soon.
        status("off", app.port || (e && !e.quiet) ? "Looking for the adapter…" : "Not connected");
      } else {
        const msg = e && e.name === "NotFoundError" ? "No adapter picked. Pair the adapter in Android Bluetooth settings first, then tap Connect car." : (e.message || String(e));
        notice(msg, "bad");
        if (e && e.name !== "NotFoundError") app.port = null;
        status("off", "Not connected");
      }
    } finally { app.connecting = false; }
  }

  /* Auto-connect: once you've picked the adapter one time, Chrome remembers the permission. While this page is open
     and nothing else is connected, try that adapter on load, whenever Chrome reports it in range, and every 15 s.
     A manual Disconnect pauses this until you tap Connect car again. */
  function autoEligible() { return cfg.autoConnect !== false && !app.source && !app.userStopped && !app.connecting && !document.hidden && window.ElmLink && ElmLink.supported(); }
  async function autoTry() {
    if (!autoEligible()) return;
    try { const known = await navigator.serial.getPorts(); if (!known.length) return; } catch (e) { return; }
    connectCar(true);
  }
  if (window.ElmLink && ElmLink.supported()) {
    navigator.serial.addEventListener("connect", e => { if (autoEligible()) { app.port = e.target || app.port; connectCar(true); } });
    navigator.serial.addEventListener("disconnect", () => { if (app.source === "car") status("connecting", "Adapter went away, waiting…"); });
    setTimeout(autoTry, 800);
    setInterval(autoTry, 15000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(autoTry, 500); });
  }
  function onLinkStatus(s) {
    if (s.type === "init") status("connecting", s.message);
    if (s.type === "lost" || s.type === "error") {
      notice(s.message || "Lost the Bluetooth link to the adapter. Reconnecting…", "warn");
      status("connecting", "Reconnecting");
      const link = app.link; app.link = null;
      setTimeout(async () => { try { await link?.close(); } catch (e) {} if (app.source === "car") connectCar(); }, 2500);
    }
  }
  async function disconnect() {
    const src = app.source;
    if (src === "car") app.userStopped = true;
    if (src === "demo") stopDemo();
    if (src === "tessie") stopTessie();
    app.source = null;
    if (app.link) { await app.link.close().catch(() => {}); app.link = null; }
    releaseAwake();
    status("off", "Not connected");
  }

  /* ---------------- demo ---------------- */
  function startDemo() {
    if (app.link) disconnect();
    resetDecoder();
    app.source = "demo"; app.sim = CanSim.createSim();
    app.savedTrip = app.trip; app.trip = null;            // demo never touches your real trip
    app.coach = Coach.createCoach({});                    // or your learned speed table
    const SPEED = DEMO_SPEED;
    app.simTimer = setInterval(() => { for (let k = 0; k < SPEED; k++) app.sim.step(0.05).forEach(onLine); }, 50);
    status("demo", "Demo · 8× speed");
    notice("Showing simulated frames, not your car. Tap Connect car to switch to live data.", "info");
  }
  function stopDemo() {
    if (app.simTimer) { clearInterval(app.simTimer); app.simTimer = null; }
    if (app.source === "demo") { app.trip = app.savedTrip ?? load(KEY.trip, null); app.source = null; notice(null); }
    app.coach = realCoach;
  }
  function resetDecoder() { drives.cancel(); stops.reset(); app.climateKWh = 0; dec = D.createDecoder(); L = dec.state; app.pEma = null; app.synthNet = 0; app.synthOdo = 0; app.idStats = {}; app.rawLines = []; app.bufferFull = 0; }

  /* ---------------- trip + consumption math ----------------
     Energy: lifetime counters on 0x3D2 (kWh out minus kWh in) — exact to 1 Wh, regen included.
     Distance: odometer on 0x3B6. Falls back to integrating power and speed if either is missing. */
  function tick() {
    const now = performance.now(), dt = Math.min(1, (now - app.lastTick) / 1000); app.lastTick = now;
    if (L.powerKW != null) app.pEma = app.pEma == null ? L.powerKW : app.pEma + (L.powerKW - app.pEma) * Math.min(1, dt / 0.3);
    if (L.powerKW != null) app.synthNet += (L.powerKW * dt) / 3600;
    if (L.speedMph != null) app.synthOdo += (L.speedMph * dt) / 3600;
    const hasTotals = L.totalOutKWh != null, net = hasTotals ? L.totalOutKWh - L.totalInKWh : app.synthNet;
    const odo = L.odoMi != null ? L.odoMi : app.synthOdo;
    const live = app.source && (now - app.lastFrameAt < (app.source === "tessie" ? 45000 : 4000));

    if (app.source && live && (L.powerKW != null || hasTotals)) {
      let t = app.trip;
      const fresh = !t || t.src !== (hasTotals ? "c" : "s") + (L.odoMi != null ? "o" : "i") || Math.abs(odo - t.lastOdo) > 50 || Math.abs(net - t.lastNet) > 30;
      if (fresh) t = app.trip = { t0: Date.now(), src: (hasTotals ? "c" : "s") + (L.odoMi != null ? "o" : "i"), odo0: odo, lastOdo: odo, lastNet: net, lastIn: L.totalInKWh ?? 0, drive: 0, park: 0, regen: 0, charged: 0, D: [0], E: [0] };
      const dNet = net - t.lastNet, dMi = odo - t.lastOdo, dIn = (L.totalInKWh ?? 0) - t.lastIn;
      const moving = (L.speedMph ?? 0) > 0.8 || dMi > 0.0005;
      if (moving) { t.drive += dNet; if (hasTotals && dIn > 0) t.regen += dIn; else if (!hasTotals && dNet < 0) t.regen -= dNet; }
      else if (dNet < -0.0005) t.charged -= dNet;
      else t.park += Math.max(0, dNet);
      t.lastNet = net; t.lastOdo = odo; t.lastIn = L.totalInKWh ?? 0;
      const dist = odo - t.odo0;
      if (dist - t.D[t.D.length - 1] >= 0.05) {
        t.D.push(dist); t.E.push(t.drive);
        if (t.D.length > 1400) { t.D.splice(0, 200); t.E.splice(0, 200); }
      }
      if ((app.source === "car" || app.source === "tessie") && now - app.lastSave > 10000) { store(tripKey(app.source), t); app.lastSave = now; }
    }
    app.tgt = app.source ? computeTargets() : null;
    if (live && (app.source === "car" || app.source === "demo")) app.coach.update({
      pedal: L.pedalPct, kw: app.pEma, mph: L.speedMph, brake: L.brakeOn, gear: L.gear, soc: L.socUI ?? L.uiSOC,
      tMin: L.packTminC, tMax: L.packTmaxC, hvacKw: L.compressorKW, regenLimitKw: L.maxRegenKW, grade: L.gradePct, outsideC: L.outsideC,
    }, app.source === "demo" ? dt * DEMO_SPEED : dt, app.source === "demo" ? (app.simNow = (app.simNow || 0) + dt * DEMO_SPEED * 1000) : now);
    const dtSim = app.source === "demo" ? dt * DEMO_SPEED : dt;
    if (live && (app.source === "car" || app.source === "demo")) {
      checkAlerts(now);
      const sd = stops.update({ mph: L.speedMph, kw: app.pEma, brake: L.brakeOn, pedal: L.pedalPct }, dtSim);
      if (sd) { app.lastStopAt = now; }
    }
    if (L.compressorKW != null) app.climateKWh = (app.climateKWh || 0) + (L.compressorKW * dtSim) / 3600;
    // Where the energy went: integrate pack power into cruising / speeding up / climate / parked, plus regen recovered.
    if (live && app.trip && app.pEma != null && app.source !== "tessie") {
      const eb = (app.trip.eb ||= { cruise: 0, accel: 0, climate: 0, parked: 0, regen: 0 }), P = app.pEma, h = dtSim / 3600;
      const moving = (L.speedMph ?? 0) > 2, clim = P > 0 ? Math.min(P, Math.max(0, L.compressorKW ?? 0)) : 0;
      if (P < 0) { if (moving) eb.regen += -P * h; }
      else {
        eb.climate += clim * h; const rest = P - clim;
        if (!moving) eb.parked += rest * h;
        else {
          const cruise = app.tgt && app.tgt.cruiseKW > 0.5 ? app.tgt.cruiseKW : rest;
          if (app.coach.state.accel > 0.3 && rest > cruise) { eb.accel += (rest - cruise) * h; eb.cruise += cruise * h; } else eb.cruise += rest * h;
        }
      }
    }
    if (live && (app.source === "car" || app.source === "demo") && app.trip) {
      const st = app.coach.state, sw = app.coach.table(L.outsideC).sweet;
      const done = drives.update({
        odo, mph: L.speedMph, gear: L.gear, drive: app.trip.drive, park: app.trip.park, regen: app.trip.regen,
        climateKWh: L.compressorKW != null ? app.climateKWh : null, heavy: st.heavyEvents, friction: st.frictionEvents,
        accelKWh: app.trip.eb ? app.trip.eb.accel : 0, cruiseKWh: app.trip.eb ? app.trip.eb.cruise : 0,
        stopKinetic: stops.state.kinetic, stopRegen: stops.state.regen, stopCount: stops.state.n,
        pressedSec: st.pressedSec, rightSec: st.rightSec, rated: ratedWh(), sweetBand: sw ? sw.mph : null, outsideC: L.outsideC, demo: app.source === "demo",
      }, dtSim, Date.now());
      if (done) { showSummary(done); renderDrives(); }
    }
    if (app.rec && app.source && now - app.rec.last >= 1000) record(now);
    if (app.source === "car") status(live ? "live" : "quiet", live ? "Live" : "No CAN traffic");
    if (app.source === "tessie" && app.tessieAt) status(live ? "tessie" : "quiet", `Tessie · ${app.carState === "asleep" ? "car asleep · " : ""}${age(Date.now() - app.tessieAt)}`);
    render(live);
  }

  function windowAvg(t, w) {
    if (!t || t.D.length < 2) return null;
    const end = t.D[t.D.length - 1], start = Math.max(0, end - w); let j = 0;
    while (j < t.D.length - 1 && t.D[j] < start) j++;
    const span = end - t.D[j]; return span > 0.3 ? ((t.E[t.E.length - 1] - t.E[j]) * 1000) / span : null;
  }

  /* ---------------- render ---------------- */
  const fx = (v, d = 0) => (v == null || !isFinite(v) ? "—" : v.toFixed(d));
  const set = (id, v, unit) => { $(id).innerHTML = v === "—" ? "—" : `${v}${unit ? `<small>${unit}</small>` : ""}`; };
  let lastChart = 0;
  function render(live) {
    const t = app.trip, p = app.pEma, mph = L.speedMph;
    // power
    set("pw", fx(p, Math.abs(p ?? 0) < 10 ? 1 : 0), "kW");
    $("pwSub").textContent = p == null ? "waiting for pack data" : p < -0.2 ? (mph > 1 ? "regenerating" : "charging") : mph > 1 ? "driving" : "parked draw";
    // consumption
    const tripMi = t ? t.lastOdo - t.odo0 : 0, tripAvg = t && tripMi > 0.3 ? (t.drive * 1000) / tripMi : null;
    const wAvg = windowAvg(t, cfg.win);
    set("avg", fx(wAvg), "Wh/mi"); $("avgLabel").textContent = `Avg · last ${cfg.win} mi`;
    const rated = ratedWh();
    const vsRated = r => (r <= 1 ? `${Math.round((1 - r) * 100)}% under rated` : `${Math.round((r - 1) * 100)}% over rated`);
    $("avgSub").textContent = wAvg && rated ? `${vsRated(wAvg / rated)} (${rated} Wh/mi)` : rated ? `rated ${rated} Wh/mi` : "builds as you drive";
    const usable = L.energyRemainingKWh != null ? Math.max(0, L.energyRemainingKWh - (L.bufferKWh ?? 0)) : null;
    const basis = wAvg ?? tripAvg;
    set("proj", usable != null && basis > 50 ? fx((usable * 1000) / basis) : fx(L.ratedRangeMi), "mi");
    $("projSub").textContent = usable != null && basis > 50 ? `at ${Math.round(basis)} Wh/mi · rated ${fx(L.ratedRangeMi)} mi` : "rated range";
    renderGuide(usable, basis);
    renderGauge(live, tripAvg);
    renderMiles(app.tgt && app.tgt.whTarget ? Math.round(app.tgt.whTarget) : ratedWh());
    renderScore(tripMi, tripAvg);
    // battery
    const soc = L.socUI ?? L.uiSOC;
    $("battFill").style.width = `${Math.max(0, Math.min(100, soc ?? 0))}%`; $("battPct").textContent = soc != null ? `${fx(soc, 1)}%` : "—";
    set("eRem", fx(L.energyRemainingKWh, 1), "kWh"); set("eFull", fx(L.fullPackKWh, 1), "kWh");
    set("eBuf", fx(L.bufferKWh, 1), "kWh"); set("pv", fx(L.packV, 1), "V"); set("pa", fx(L.packA, 1), "A");
    const tF = c => (c == null ? null : (c * 9) / 5 + 32);
    $("pt").innerHTML = L.packTminC != null ? `${fx(tF(L.packTminC))}–${fx(tF(L.packTmaxC))}<small>°F</small>` : "—";
    // trip
    set("tMi", fx(tripMi, 1), "mi"); set("tAvg", fx(tripAvg), "Wh/mi");
    const tot = t ? t.drive + t.park : 0;
    $("tDrive").textContent = t ? `${fx(t.drive, 2)} kWh` : "—";
    $("tPark").textContent = t ? `${fx(t.park, 2)} kWh` : "—";
    $("tRegen").textContent = t ? `${fx(t.regen, 2)} kWh` : "—";
    $("tChg").textContent = t && t.charged > 0.01 ? `${fx(t.charged, 2)} kWh` : "—";
    $("tSince").textContent = t ? `since ${new Date(t.t0).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
    const bars = $("split").children;
    bars[0].style.width = tot > 0 ? `${(Math.max(0, t.drive) / tot) * 100}%` : "0"; bars[1].style.width = tot > 0 ? `${(t.park / tot) * 100}%` : "0";
    // Slower-changing panels redraw once a second (or immediately on an explicit refresh) to keep the phone cool.
    const nowR = performance.now(), slow = live === true && nowR - (app.slowAt || 0) < 1000 && !app.forceSlow;
    if (!slow) { app.slowAt = nowR; app.forceSlow = false; renderBreakdown(t); renderPlan(usable); }
    // bricks
    if (!slow) renderBricks();
    renderCoach(live, slow);
    // footer
    $("fps").textContent = app.source ? `${app.fps} frames/s` : "";
    $("recBtn").textContent = app.rec ? `Stop recording (${app.rec.rows.length - 1} rows)` : "Record CSV";
    $("dlBtn").hidden = !(app.rec && app.rec.rows.length > 1) && !app.lastCsv;
    if (performance.now() - lastChart > 900) { lastChart = performance.now(); drawChart(t); }
  }

  function renderCoach(live, slow) {
    const C = app.coach, st = C.state, mph = L.speedMph ?? 0, pedal = L.pedalPct, zone = st.zone;
    $("pedalFill").style.width = `${pedal ?? 0}%`;
    $("pedalFill").dataset.zone = pedal == null ? "" : zone || "";
    $("pedalPct").textContent = pedal == null ? "—" : `${Math.round(pedal)}%`;
    $("pedalZone").textContent = pedal == null ? "" : ({ OFF: (app.pEma ?? 0) < -1 ? `regen ${Math.round(-app.pEma)} kW` : "off", LIGHT: "light", RIGHT: "in range", TOO_MUCH: "too much" })[zone] || "";
    $("brakePill").dataset.on = String(L.brakeOn === true);
    const tip = $("tip"), tip2 = $("tip2");
    tip2.textContent = "";
    if (app.source === "tessie") { tip.textContent = "Pedal coaching needs the adapter. Tessie doesn't send pedal or brake data."; tip.dataset.tone = "idle"; }
    else if (!app.source || !live) { tip.textContent = app.source ? "Waiting for the car…" : "Connect the car to start coaching."; tip.dataset.tone = "idle"; }
    else if (st.headline) {
      tip.textContent = st.headline.text;
      tip.dataset.tone = st.headline.kind === "parked" ? "idle" : ({ WARN: "bad", GOOD: "good", TIP: "warn" })[st.headline.level];
      const next = st.headline.kind !== "parked" && st.list.find(q => q.kind !== st.headline.kind && !q.standing);
      tip2.textContent = next ? next.text : "";
    }
    const sc = C.score();
    set("cScore", sc == null ? "—" : String(sc), sc == null ? "" : "%");
    $("cScore").dataset.tone = sc == null ? "" : sc >= 75 ? "good" : sc >= 50 ? "warn" : "bad";
    $("cHard").textContent = String(st.heavyEvents); $("cBrake").textContent = String(st.frictionEvents);
    set("cGrade", L.gradePct == null ? "—" : `${L.gradePct > 0 ? "+" : ""}${L.gradePct}`, L.gradePct == null ? "" : "%");
    $("cruiseBtn").setAttribute("aria-pressed", String(st.cruiseOn));
    const avgCap = stops.avg(), ls = stops.state.last;
    set("cCap", avgCap == null ? "—" : String(avgCap), avgCap == null ? "" : "%");
    $("cCap").dataset.tone = avgCap == null ? "" : Stops.grade(avgCap);
    $("cCapSub").textContent = ls ? `last: ${ls.v0}→${ls.v1} mph, ${ls.pct}%${ls.braked ? " (brake used)" : ""}` : "slowdowns from 15+ mph";
    // Right after a slowdown, show its result in the second coaching line for 8 s.
    if (ls && app.lastStopAt && performance.now() - app.lastStopAt < 8000 / (app.source === "demo" ? DEMO_SPEED : 1) && app.source)
      $("tip2").textContent = `That slowdown recovered ${ls.pct}% of your momentum${ls.pct >= 60 ? ". Excellent." : ls.pct >= 40 ? ". Lift a bit earlier for more." : ". Lift much earlier, less brake."}`;
    if (slow) return;
    const { rows, sweet, band } = C.table(L.outsideC), box = $("speedTable");
    $("tempBand").textContent = band === "x" ? "" : `at ${band} °F outside`;
    if (!rows.length) { box.innerHTML = `<p class="note">Fills in as you cruise steadily above 20 mph. Each 5-mph band needs about half a mile${band === "x" ? "" : " at this outside temperature"}.</p>`; return; }
    // Speed curve: your Wh/mi at each 5-mph band (points at band centers), sweet spot highlighted, your speed marked,
    // and what a full usable pack would reach at each band.
    const usable = L.energyRemainingKWh != null ? Math.max(0, L.energyRemainingKWh - (L.bufferKWh ?? 0)) : null;
    const W = 320, H = 150, Lp = 34, R = 10, T = 14, B = 24, xs = rows.map(r => r.mph + 2.5);
    const x0 = Math.min(20, ...xs) - 2, x1 = Math.max(80, ...xs) + 2, ys = rows.map(r => r.wh);
    const y0 = Math.floor((Math.min(...ys) - 20) / 50) * 50, y1 = Math.ceil((Math.max(...ys) + 20) / 50) * 50;
    const X = v => Lp + ((v - x0) / (x1 - x0)) * (W - Lp - R), Y = v => T + ((y1 - v) / (y1 - y0)) * (H - T - B);
    let g = "";
    for (let v = y0; v <= y1; v += 50) g += `<line x1="${Lp}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${Lp - 5}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
    for (let v = Math.ceil(x0 / 10) * 10; v <= x1; v += 10) g += `<text x="${X(v)}" y="${H - 6}" text-anchor="middle">${v}</text>`;
    const path = rows.map((r, i) => `${i ? "L" : "M"}${X(r.mph + 2.5).toFixed(1)},${Y(r.wh).toFixed(1)}`).join("");
    const curX = mph > 3 ? X(Math.max(x0, Math.min(x1, mph))) : null;
    box.innerHTML = `<svg class="scurve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Your Wh/mi by speed">${g}
      ${curX ? `<line x1="${curX}" x2="${curX}" y1="${T}" y2="${H - B}" stroke="var(--fg)" stroke-dasharray="3 3" opacity=".6"/><text x="${curX}" y="${T - 3}" text-anchor="middle" style="fill:var(--fg)">you ${Math.round(mph)}</text>` : ""}
      ${rows.length > 1 ? `<path d="${path}" fill="none" stroke="var(--rated)" stroke-width="2"/>` : ""}
      ${rows.map(r => `<circle cx="${X(r.mph + 2.5)}" cy="${Y(r.wh)}" r="${sweet && r.mph === sweet.mph ? 6 : 3.5}" fill="${sweet && r.mph === sweet.mph ? "var(--energy)" : "var(--rated)"}"/>`).join("")}
      </svg>
      <div class="stable2">${rows.map(r => `<div class="${sweet && r.mph === sweet.mph ? "sweet" : ""}${mph > 2 && r.mph === Math.floor(mph / 5) * 5 ? " cur" : ""}"><span class="num">${r.mph}–${r.mph + 4} mph</span><span class="num">${Math.round(r.wh)} Wh/mi</span><span class="num">${usable != null ? `${Math.round((usable * 1000) / r.wh)} mi` : ""}</span></div>`).join("")}</div>
      <p class="note" style="margin:6px 0 0">Last column: how far your current charge goes at that speed.</p>`;
  }

  // Rated Wh/mi isn't broadcast (0x33A's old field is an artifact), so derive it from usable energy ÷ rated range.
  let ratedEma = null;
  function ratedWh() {
    const rem = L.energyRemainingKWh, range = L.ratedRangeMi;
    if (rem == null || !(range > 20)) return ratedEma ? Math.round(ratedEma) : null;
    const v = ((rem - (L.bufferKWh ?? 0)) * 1000) / range;
    if (v > 150 && v < 400) ratedEma = ratedEma == null ? v : ratedEma + (v - ratedEma) * 0.05;
    return ratedEma ? Math.round(ratedEma) : null;
  }

  // Charge plan: energy for the miles you need at your real consumption (last 7 drives, else this trip, else rated),
  // plus the reserve you want to arrive with, as a % of the current full pack.
  cfg.plan = Object.assign({ mi: 30, res: 20 }, cfg.plan || {});
  $("planMi").value = String(cfg.plan.mi); $("planRes").value = String(cfg.plan.res);
  $("planMi").addEventListener("change", e => { const v = Math.round(parseFloat(e.target.value)); if (v >= 1 && v <= 400) { cfg.plan.mi = v; store(KEY.cfg, cfg); } else e.target.value = String(cfg.plan.mi); app.forceSlow = true; render(true); });
  $("planRes").addEventListener("change", e => { cfg.plan.res = +e.target.value; store(KEY.cfg, cfg); app.forceSlow = true; render(true); });
  function renderPlan(usable) {
    const full = L.fullPackKWh, box = $("planRows");
    const recent = drives.history.slice(0, 7).filter(d => d.wh > 0);
    const t = app.trip, tripMi = t ? t.lastOdo - t.odo0 : 0;
    const wh = recent.length >= 2 ? recent.reduce((p, d) => p + d.wh, 0) / recent.length : tripMi > 2 && t.drive > 0 ? (t.drive * 1000) / tripMi : ratedWh();
    const basis = recent.length >= 2 ? `your last ${recent.length} drives` : tripMi > 2 ? "this trip" : "rated";
    if (!full || !wh) { box.innerHTML = `<p class="note">Needs the full-pack reading from the car: connect the adapter or Tessie.</p>`; return; }
    const needKWh = (cfg.plan.mi * wh) / 1000, needPct = Math.min(100, Math.ceil((needKWh / full) * 100 + cfg.plan.res));
    const soc = L.socUI ?? L.uiSOC;
    const coverMi = usable != null ? Math.max(0, ((usable - (cfg.plan.res / 100) * full) * 1000) / wh) : null;
    box.innerHTML = `
      <div><span>Charge to at least</span><span class="planbig" data-tone="${soc != null && soc >= needPct ? "good" : ""}">${needPct}%</span></div>
      <div><span>Energy for ${cfg.plan.mi} mi</span><span>${needKWh.toFixed(1)} kWh at ${Math.round(wh)} Wh/mi</span></div>
      ${soc != null ? `<div><span>Now at ${Math.round(soc)}%</span><span>${soc >= needPct ? "enough, no charge needed" : `${needPct - Math.round(soc)}% short`}</span></div>` : ""}
      ${coverMi != null ? `<div><span>Current charge covers</span><span>~${Math.round(coverMi)} mi with ${cfg.plan.res}% left</span></div>` : ""}
      <p class="note" style="margin:6px 0 0">Based on ${basis}. Cold weather, climate use and highway speed raise Wh/mi.</p>`;
  }

  const EB = [["cruise", "Holding speed", "var(--rated)"], ["accel", "Speeding up", "var(--energy)"], ["climate", "Climate", "#6aa5e8"], ["parked", "Parked / standby", "var(--faint)"]];
  function renderBreakdown(t) {
    const eb = t && t.eb, box = $("ebRows"), bar = $("ebBar");
    const tot = eb ? EB.reduce((p, [k]) => p + Math.max(0, eb[k]), 0) : 0;
    if (!eb || tot < 0.02) { bar.innerHTML = ""; box.innerHTML = `<p class="note">${app.source === "tessie" ? "Needs the adapter: Tessie updates too slowly to split energy by use." : "Fills in as you drive."}</p>`; return; }
    bar.innerHTML = EB.map(([k, , c]) => `<i style="width:${(Math.max(0, eb[k]) / tot) * 100}%;background:${c}"></i>`).join("");
    box.innerHTML = EB.map(([k, label, c]) => `<div><span><i class="dot" style="background:${c}"></i>${label}</span><span>${eb[k].toFixed(2)} kWh · ${Math.round((Math.max(0, eb[k]) / tot) * 100)}%</span></div>`).join("")
      + `<div><span><i class="dot" style="background:var(--regen)"></i>Recovered by regen</span><span>${eb.regen.toFixed(2)} kWh${eb.accel > 0.05 ? ` · ${Math.round((eb.regen / eb.accel) * 100)}% of speed-up energy` : ""}</span></div>`;
  }

  function renderBricks() {
    const b = L.bricks, have = b.filter(v => v != null);
    const idx = cfg.oneBased ? cfg.brick - 1 : cfg.brick;
    $("bWatchLbl").textContent = `Brick ${cfg.brick}`;
    if (have.length < 20) { ["bMin", "bMax", "bSpread", "bWatch", "bGap"].forEach(id => ($(id).innerHTML = "—")); $("bCount").textContent = app.source === "tessie" ? "needs the adapter (not in Tessie)" : `${have.length}/108 reported`; drawBricks(null, idx); return; }
    const min = Math.min(...have), max = Math.max(...have);
    set("bMin", fx(min, 3), "V"); set("bMax", fx(max, 3), "V"); set("bSpread", fx((max - min) * 1000), "mV");
    const w = b[idx];
    set("bWatch", w != null ? fx(w, 3) : "—", w != null ? "V" : "");
    const others = b.filter((v, i) => v != null && i !== idx), lowOther = others.length ? Math.min(...others) : null;
    const gap = w != null && lowOther != null ? (w - lowOther) * 1000 : null;
    $("bGap").innerHTML = gap == null ? "—" : `${gap > 0 ? "+" : ""}${fx(gap)}<small>mV</small>`;
    $("bGap").dataset.tone = gap != null && gap < -20 ? "bad" : gap != null && gap < -5 ? "warn" : "";
    $("bCount").textContent = `${have.length}/108 reported · gap is vs the lowest of the others`;
    drawBricks(b, idx, min, max);
  }

  function drawBricks(b, idx, min, max) {
    const c = $("bricks"), dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d"), cs = getComputedStyle(document.documentElement);
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const bw = w / 108;
    for (let i = 0; i < 108; i++) {
      const v = b && b[i];
      let hh = 3;
      if (v != null && max > min) hh = 4 + ((v - min) / (max - min)) * (h - 6);
      else if (v != null) hh = h * 0.6;
      g.fillStyle = i === idx ? cs.getPropertyValue("--energy") : v != null ? cs.getPropertyValue("--rated") : cs.getPropertyValue("--line");
      g.fillRect(i * bw + 0.5, h - hh, Math.max(1, bw - 1), hh);
    }
  }

  function drawChart(t) {
    const box = $("chart"), w = cfg.win;
    const pts = [];
    if (t && t.D.length > 2) {
      const end = t.D[t.D.length - 1], start = Math.max(0, end - w), roll = w <= 5 ? 0.5 : 1; let j = 0;
      for (let i = 1; i < t.D.length; i++) {
        if (t.D[i] < start) continue;
        while (j < i - 1 && t.D[i] - t.D[j + 1] >= roll) j++;
        const span = t.D[i] - t.D[j]; if (span < 0.2) continue;
        pts.push({ x: t.D[i] - (end - w), y: ((t.E[i] - t.E[j]) * 1000) / span });
      }
    }
    if (pts.length < 2) {
      box.innerHTML = `<div class="empty"><div><strong>Drive to draw the line</strong>Consumption plots every 0.05 mi once the car is moving.</div></div>`;
      return;
    }
    const narrow = box.clientWidth < 520, W = narrow ? 380 : 640, H = narrow ? 220 : 260, Lp = 40, R = 10, T = 16, B = 24;
    const iw = W - Lp - R, ih = H - T - B, ys = pts.map(p => p.y), rated = ratedWh();
    const budget = cfg.goal && app.budgetWh > 50 && app.budgetWh < 900 ? app.budgetWh : null;
    const top = Math.max(400, Math.ceil(Math.max(...ys, rated || 0, budget || 0) / 100) * 100), bot = Math.min(0, Math.floor(Math.min(...ys) / 100) * 100);
    const X = x => Lp + (x / w) * iw, Y = y => T + ((top - Math.max(bot, Math.min(top, y))) / (top - bot)) * ih;
    let g = "";
    for (let v = bot; v <= top; v += 100) g += `<line x1="${Lp}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${Lp - 7}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
    const step = w <= 5 ? 1 : w <= 15 ? 5 : 10;
    for (let m = 0; m <= w; m += step) g += `<text x="${X(m)}" y="${H - 6}" text-anchor="${m === 0 ? "start" : m === w ? "end" : "middle"}">${m === w ? "now" : `−${w - m} mi`}</text>`;
    const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    const f = pts[0], l = pts[pts.length - 1], z = Y(Math.max(bot, 0));
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Consumption over the last ${w} miles">${g}
      <path d="${line}L${X(l.x).toFixed(1)},${z}L${X(f.x).toFixed(1)},${z}Z" fill="var(--energy-soft)"/>
      ${rated ? `<line x1="${Lp}" x2="${W - R}" y1="${Y(rated)}" y2="${Y(rated)}" stroke="var(--rated)" stroke-width="1.5" stroke-dasharray="5 5"/>` : ""}
      ${budget ? `<line x1="${Lp}" x2="${W - R}" y1="${Y(budget)}" y2="${Y(budget)}" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="2 4"/><text x="${W - R}" y="${Y(budget) - 5}" text-anchor="end" style="fill:var(--warn)">goal budget ${Math.round(budget)}</text>` : ""}
      <path d="${line}" fill="none" stroke="var(--energy)" stroke-width="2.25" stroke-linejoin="round"/>
      <circle cx="${X(l.x)}" cy="${Y(l.y)}" r="5" fill="var(--energy)" stroke="var(--surface)" stroke-width="2"/>
      <text x="${X(l.x) - 8}" y="${Y(l.y) - 10}" text-anchor="end" style="fill:var(--fg);font-weight:600">${Math.round(l.y)}</text></svg>`;
  }

  const age = ms => { const sec = Math.max(0, Math.round(ms / 1000)); if (sec < 90) return `${sec}s old`; const m = Math.round(sec / 60); return m < 90 ? `${m} min old` : `${Math.floor(m / 60)} h ${m % 60} min old`; };
  /* ---------------- Tessie (remote) ----------------
     Same screen, fed from api.tessie.com instead of the adapter. Your car streams Fleet Telemetry to Tessie,
     so pack volts/amps and energy update every few seconds while it's awake. The token stays in this
     phone's storage only; it's never in the page's code. use_cache=true never wakes the car. */
  const tessieToken = () => { try { return localStorage.getItem(KEY.tok) || ""; } catch (e) { return ""; } };
  async function tget(path) {
    const r = await fetch(`https://api.tessie.com/${path}`, { headers: { Authorization: `Bearer ${tessieToken()}` }, cache: "no-store" });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }
  async function startTessie() {
    if (!tessieToken()) {
      document.querySelector(".tools details").open = true; $("cfgTok").focus();
      notice("Paste your Tessie API token in Settings first. It's saved on this device only.", "warn");
      return;
    }
    if (app.source === "car" || app.source === "demo") await disconnect();
    resetDecoder();
    app.source = "tessie"; app.trip = load(KEY.tripT, null); app.tessieAt = null;
    status("connecting", "Reaching Tessie"); notice(null);
    try {
      const v = await tget("vehicles?only_active=true");
      const list = v.results || [];
      if (!list.length) throw Object.assign(new Error("No vehicles on this Tessie account."), { status: 0 });
      app.vin = list[0].vin;
      await pollTessie();
      app.tessieTimer = setInterval(() => { if (!document.hidden) pollTessie(); }, 10000);
    } catch (e) { tessieError(e); }
  }
  function stopTessie() {
    if (app.tessieTimer) { clearInterval(app.tessieTimer); app.tessieTimer = null; }
    if (app.source === "tessie") { app.trip = load(KEY.trip, null); }
  }
  async function pollTessie() {
    if (app.tessieBusy || app.source !== "tessie") return;
    app.tessieBusy = true;
    try {
      const [bat, st] = await Promise.all([tget(`${app.vin}/battery`), tget(`${app.vin}/state?use_cache=true`)]);
      if (app.source !== "tessie") return;
      const ds = st.drive_state || {}, vs = st.vehicle_state || {}, cs = st.charge_state || {};
      L.packV = bat.pack_voltage; L.packA = bat.pack_current;
      L.powerKW = typeof ds.power === "number" ? ds.power : (bat.pack_voltage * bat.pack_current) / 1000;
      L.speedMph = ds.speed || 0;
      if (typeof vs.odometer === "number") L.odoMi = vs.odometer;
      L.energyRemainingKWh = bat.energy_remaining; L.fullPackKWh = bat.nominal_full_pack_energy; L.bufferKWh = null;
      L.socUI = bat.battery_level; L.ratedRangeMi = bat.battery_range;
      L.packTminC = bat.module_temp_min; L.packTmaxC = bat.module_temp_max;
      if (cs.charge_limit_soc != null) L.chargeLimit = cs.charge_limit_soc;
      // Trip energy from the drop in energy remaining (0.01 kWh steps): out − in = 1000 − remaining.
      L.totalOutKWh = 1000 - bat.energy_remaining; L.totalInKWh = 0;

      app.carState = st.state; app.tessieAt = (bat.timestamp ? bat.timestamp * (bat.timestamp < 1e12 ? 1000 : 1) : Date.now());
      app.frames++; app.lastFrameAt = performance.now();
      if (!$("notice").hidden && $("notice").dataset.tone !== "bad") notice(null);
    } catch (e) { tessieError(e); }
    finally { app.tessieBusy = false; }
  }
  function tessieError(e) {
    const s = e && e.status;
    if (s === 401 || s === 403) { notice("Tessie rejected the token. Paste a fresh one in Settings (Tessie app → Settings → API).", "bad"); disconnect(); return; }
    if (s === 429) { notice("Tessie says too many requests. Slowing down for a minute.", "warn"); if (app.tessieTimer) { clearInterval(app.tessieTimer); app.tessieTimer = setTimeout(() => { app.tessieTimer = setInterval(() => { if (!document.hidden) pollTessie(); }, 15000); }, 60000); } return; }
    if (s === 0) { notice(e.message, "bad"); disconnect(); return; }
    notice(`Couldn't reach Tessie (${e && e.message ? e.message : "network"}). Retrying every 10 seconds.`, "warn");
  }

  /* ---------------- max-range guidance ----------------
     Targets come from this car's own steady-cruise data (coach speed table, same outside-temperature band),
     falling back to rated consumption. Efficient draw = what holding this speed costs + a gentle-acceleration
     allowance (~0.06 g). Gentle regen = up to 60% of the BMS regen limit (max 35 kW). */
  const MASS_KG = 1850;
  function computeTargets() {
    const mph = L.speedMph ?? 0, { rows, sweet } = app.coach.table(L.outsideC);
    const here = rows.find(r => r.mph === Math.floor(mph / 5) * 5), rated = ratedWh();
    const whTarget = here ? here.wh : rated;
    const cruiseKW = whTarget && mph > 3 ? (whTarget * mph) / 1000 : 1;
    const accelKW = Math.max(8, (MASS_KG * 0.6 * (mph / 2.2369363)) / 1000);
    const regenLim = L.maxRegenKW > 5 ? L.maxRegenKW : 60;
    return { mph, whTarget, cruiseKW, upKW: cruiseKW + accelKW, regenGentle: Math.min(35, 0.6 * regenLim), rows, sweet, here };
  }

  function renderGuide(usable, basis) {
    const tg = app.tgt, set2 = (id, text, tone) => { $(id + "V").textContent = text; $(id).dataset.tone = tone || ""; };
    // 1. Range vs the car's own rated estimate, at your current pace.
    if (usable != null && basis > 50 && L.ratedRangeMi > 0) {
      const d = Math.round((usable * 1000) / basis - L.ratedRangeMi);
      set2("gRange", `${d >= 0 ? "+" : "−"}${Math.abs(d)} mi`, d >= 0 ? "good" : d > -15 ? "warn" : "bad");
    } else set2("gRange", "drive to see", "");
    // 2. Best speed from your data, and what it's worth right now.
    if (tg && tg.sweet) {
      const s = tg.sweet, here = tg.here;
      if (usable != null && here && here.mph > s.mph && tg.mph > 3) {
        const gain = Math.round((usable * 1000) / s.wh - (usable * 1000) / here.wh);
        set2("gSpeed", gain >= 1 ? `${s.mph}–${s.mph + 4} mph: +${gain} mi` : `${s.mph}–${s.mph + 4} mph`, gain >= 5 ? "warn" : "good");
      } else set2("gSpeed", `${s.mph}–${s.mph + 4} mph · ${Math.round(s.wh)} Wh/mi`, here && here.mph === s.mph ? "good" : "");
    } else set2("gSpeed", "learning…", "");
    // Climate / standby cost in range terms: kW ÷ your Wh/mi = miles of range used per hour.
    {
      const pace = basis > 50 ? basis : tg && tg.whTarget ? tg.whTarget : ratedWh();
      const moving = tg && tg.mph > 3, cw = L.compressorKW, outF = L.outsideC != null ? Math.round((L.outsideC * 9) / 5 + 32) : null;
      if (!moving && app.pEma != null && app.pEma > 0.05 && app.source && pace) {
        $("gClimL").textContent = "Parked draw";
        const mph = (app.pEma * 1000) / pace;
        set2("gClim", `${app.pEma.toFixed(1)} kW · −${mph.toFixed(1)} mi/hr`, app.pEma > 1.5 ? "warn" : "");
      } else if (cw != null && pace) {
        $("gClimL").textContent = `Climate${outF != null ? ` · ${outF}°F out` : ""}`;
        const mph = (cw * 1000) / pace;
        set2("gClim", cw < 0.15 ? "off · 0 mi/hr" : `${cw.toFixed(1)} kW · −${mph.toFixed(1)} mi/hr`, cw > 3 ? "bad" : cw > 1.5 ? "warn" : "good");
      } else { $("gClimL").textContent = "Climate"; set2("gClim", app.source === "tessie" ? "needs the adapter" : "—", ""); }
    }
    // 3. Range goal: energy budget per mile to arrive with the buffer intact.
    const g = cfg.goal;
    if (!g) { $("gGoalL").textContent = "Range goal"; set2("gGoal", "Set a goal", ""); return; }
    const done = L.odoMi != null && g.odo0 != null ? Math.max(0, L.odoMi - g.odo0) : 0;
    const left = Math.max(0, g.mi - done);
    $("gGoalL").textContent = `Goal ${g.mi} mi · ${left.toFixed(1)} left`;
    if (usable == null || left < 0.1) { set2("gGoal", left < 0.1 ? "Made it" : "waiting for battery data", left < 0.1 ? "good" : ""); return; }
    const budget = (usable * 1000) / left;
    app.budgetWh = budget;
    const pace = basis > 50 ? basis : tg && tg.whTarget;
    const full = L.fullPackKWh || null;
    if (!pace) { set2("gGoal", `budget ${Math.round(budget)} Wh/mi`, ""); return; }
    const arrive = full ? Math.max(0, ((usable - (left * pace) / 1000) / full) * 100) : null;
    if (pace <= budget) set2("gGoal", `On budget${arrive != null ? ` · arrive ~${Math.round(arrive)}%` : ""}`, budget - pace > 40 ? "good" : "warn");
    else {
      const ok = tg && tg.rows.filter(r => r.wh <= budget * 0.95 && r.mph >= 25).sort((a, b) => b.mph - a.mph)[0];
      set2("gGoal", ok ? `Over by ${Math.round(pace - budget)} Wh/mi · slow to ~${ok.mph + 4} mph` : `Over by ${Math.round(pace - budget)} Wh/mi · ease off`, "bad");
    }
  }

  $("gGoal").addEventListener("click", () => {
    const f = $("goalForm"); f.hidden = !f.hidden; $("goalMsg").textContent = "";
    if (!f.hidden) { $("goalMi").value = cfg.goal ? String(cfg.goal.mi) : ""; f.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  });
  function setGoal(mi) {
    if (!(mi >= 1 && mi <= 400)) { $("goalMsg").textContent = "Enter a number of miles from 1 to 400."; return; }
    cfg.goal = { mi, odo0: L.odoMi ?? null, at: Date.now() }; store(KEY.cfg, cfg);
    $("goalForm").hidden = true; lastChart = 0; render(true);
  }
  document.querySelectorAll("#goalQuick [data-mi]").forEach(b => b.addEventListener("click", () => setGoal(+b.dataset.mi)));
  $("goalForm").addEventListener("submit", e => { e.preventDefault(); setGoal(Math.round(parseFloat(String($("goalMi").value).replace(/[^0-9.]/g, "")))); });
  $("goalClear").addEventListener("click", () => { cfg.goal = null; app.budgetWh = null; store(KEY.cfg, cfg); $("goalForm").hidden = true; lastChart = 0; render(true); });
  function setDrive(on) { cfg.drive = on; store(KEY.cfg, cfg); document.body.classList.toggle("drive", on); $("driveBtn").setAttribute("aria-pressed", String(on)); if (on) keepAwake(); }
  $("driveBtn").addEventListener("click", () => setDrive(!cfg.drive));
  setDrive(!!cfg.drive);

  /* ---------------- efficiency gauge + power flow ----------------
     Gauge: smoothed Wh/mi right now on a 240° arc. Green up to your target for this speed (your own
     steady-cruise data, else rated), amber to 1.35× target, red beyond. White tick = target, amber dot = trip avg.
     Flow bar: left of zero = regen, right = power used, animated every frame from raw pack power. */
  const G = { cx: 120, cy: 112, r: 92, start: 150, sweep: 240, max: 0, built: false };
  const polar = (deg, r = G.r) => { const a = (deg * Math.PI) / 180; return [G.cx + r * Math.cos(a), G.cy + r * Math.sin(a)]; };
  const arcPath = (d0, d1, r = G.r) => { const [x0, y0] = polar(d0, r), [x1, y1] = polar(d1, r); return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${d1 - d0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)},${y1.toFixed(1)}`; };
  const ARC_LEN = (Math.PI * G.r * G.sweep) / 180;
  function buildGauge(max, target) {
    G.max = max; G.target = target;
    const deg = v => G.start + (Math.max(0, Math.min(max, v)) / max) * G.sweep;
    const z1 = target || max * 0.45, z2 = Math.min(max, z1 * 1.35);
    let t = "";
    for (let v = 0; v <= max; v += 100) { const [x, y] = polar(deg(v), G.r - 24); t += `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${v}</text>`; }
    const [tx0, ty0] = polar(deg(z1), G.r - 13), [tx1, ty1] = polar(deg(z1), G.r + 13);
    $("effGauge").innerHTML = `
      <path class="arcbg" d="${arcPath(G.start, G.start + G.sweep)}"/>
      <path class="zone" d="${arcPath(deg(0), deg(z1), G.r + 14)}" stroke="var(--regen)"/>
      <path class="zone" d="${arcPath(deg(z1), deg(z2), G.r + 14)}" stroke="var(--warn)"/>
      <path class="zone" d="${arcPath(deg(z2), deg(max), G.r + 14)}" stroke="var(--bad)"/>
      <path class="val" id="gVal" d="${arcPath(G.start, G.start + G.sweep)}" stroke="var(--regen)" stroke-dasharray="0 ${ARC_LEN}"/>
      ${target ? `<line class="tgt" x1="${tx0.toFixed(1)}" y1="${ty0.toFixed(1)}" x2="${tx1.toFixed(1)}" y2="${ty1.toFixed(1)}"/>` : ""}
      ${t}`;
    G.built = true;
  }
  const gaugeDeg = v => G.start + (Math.max(0, Math.min(G.max, v)) / G.max) * G.sweep;

  let whSmooth = null, kwE = null, mphE = null;
  function renderGauge(live, tripAvg) {
    const tg = app.tgt, mph = L.speedMph ?? 0, target = tg && tg.whTarget ? Math.round(tg.whTarget) : null;
    const max = Math.max(500, Math.ceil(((target || 300) * 1.9) / 100) * 100);
    if (!G.built || G.max !== max || G.target !== target) buildGauge(max, target);
    const moving = live && mph > 3 && app.pEma != null;
    // Ratio of separately smoothed power and speed: avoids huge spikes at low speed (30 kW at 3 mph ≠ 10,000 Wh/mi).
    if (moving) {
      const k = 0.18; kwE = kwE == null ? app.pEma : kwE + (app.pEma - kwE) * k; mphE = mphE == null ? mph : mphE + (mph - mphE) * k;
      whSmooth = mphE > 8 ? Math.max(-999, Math.min(1500, (kwE * 1000) / mphE)) : null;
    } else { whSmooth = null; kwE = null; mphE = null; }
    const v = whSmooth, el = $("inst"), st = $("effState");
    const tone = v == null || !target ? "" : v <= target ? "good" : v <= target * 1.35 ? "warn" : "bad";
    const val = $("gVal");
    val.setAttribute("stroke-dasharray", `${v != null && v > 0 ? ((Math.min(G.max, v) / G.max) * ARC_LEN).toFixed(1) : 0} ${ARC_LEN}`);
    val.setAttribute("stroke", tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "var(--regen)");
    if (!live) { el.textContent = "—"; el.dataset.tone = ""; $("instSub").textContent = "Wh/mi now"; st.textContent = app.source ? "Waiting for the car" : "Connect the car"; st.dataset.tone = ""; }
    else if (!moving) {
      const kw = app.pEma ?? 0;
      const charging = kw < -0.3 && L.gear !== "D" && L.gear !== "R";
      el.textContent = charging ? "Charging" : L.gear === "D" || L.gear === "R" ? "Stopped" : "Parked"; el.dataset.tone = "";
      $("instSub").textContent = `${Math.abs(kw) < 10 ? Math.abs(kw).toFixed(1) : Math.round(Math.abs(kw))} kW ${kw < -0.3 ? (charging ? "in" : "regen") : "draw"}`;
      st.textContent = "Not moving"; st.dataset.tone = "";
    } else if (v < 0) { el.textContent = "Regen"; el.dataset.tone = "good"; $("instSub").textContent = `recovering ${Math.round(-app.pEma)} kW`; st.textContent = "Recovering energy"; st.dataset.tone = "good"; }
    else {
      el.textContent = String(Math.round(v)); el.dataset.tone = tone; $("instSub").textContent = `Wh/mi now · ${Math.round(mph)} mph`;
      st.textContent = tone === "good" ? "Efficient" : tone === "warn" ? "A bit heavy" : tone === "bad" ? "Wasting range" : "Measuring";
      st.dataset.tone = tone;
    }
    $("effTarget").textContent = target ? `Target ${target} Wh/mi${tg.here ? " (your best at this speed)" : " (rated)"}${tripAvg > 0 ? ` · trip ${Math.round(tripAvg)}` : ""}` : "";
  }

  // Mile by mile: Wh/mi of each of the last 10 whole miles of this trip plus the mile in progress, colored vs target.
  function cumAt(t, d) {                      // driving energy at trip distance d, interpolated
    const D = t.D, E = t.E; if (d <= 0) return 0;
    let lo = 0, hi = D.length - 1; if (d >= D[hi]) return E[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (D[m] <= d) lo = m; else hi = m; }
    const f = (d - D[lo]) / (D[hi] - D[lo] || 1); return E[lo] + f * (E[hi] - E[lo]);
  }
  function renderMiles(target) {
    const t = app.trip, box = $("mileBars");
    if (!t || t.D.length < 3 || t.D[t.D.length - 1] < 0.3) { box.innerHTML = `<span class="note">Each mile shows up here as you drive.</span>`; $("mileNow").textContent = ""; return; }
    const end = t.D[t.D.length - 1], whole = Math.floor(end), first = Math.max(0, whole - 10), miles = [];
    for (let k = first; k < whole; k++) miles.push({ k, wh: (cumAt(t, k + 1) - cumAt(t, k)) * 1000 });
    const part = end - whole; if (part >= 0.2) miles.push({ k: whole, wh: ((cumAt(t, end) - cumAt(t, whole)) * 1000) / part, partial: true });
    const max = Math.max(target ? target * 1.6 : 400, ...miles.map(m => m.wh));
    box.innerHTML = miles.map(m => {
      const tone = !target ? "" : m.wh <= target ? "good" : m.wh <= target * 1.35 ? "warn" : "bad";
      return `<span class="mb${m.partial ? " partial" : ""}" data-tone="${tone}" title="Mile ${m.k + 1}: ${Math.round(m.wh)} Wh/mi"><i style="height:${Math.max(6, (Math.max(0, m.wh) / max) * 100)}%"></i><b>${Math.round(m.wh)}</b></span>`;
    }).join("") + (target ? `<span class="mtarget" style="bottom:calc(16px + (100% - 16px) * ${(target / max).toFixed(3)})"></span>` : "");
    const last = miles.filter(m => !m.partial).slice(-1)[0];
    $("mileNow").textContent = last ? `last full mile ${Math.round(last.wh)} Wh/mi` : "";
  }

  // Efficiency score, 0–100 for this trip: 70% consumption vs rated (100 at ≤85% of rated Wh/mi, 0 at ≥150%),
  // 30% share of pedal time in the 15–40% range. Shown once the trip has half a mile.
  function renderScore(tripMi, tripAvg) {
    const rated = ratedWh(), el = $("effScore");
    if (!(tripMi > 0.5) || !(tripAvg > 0) || !rated) { el.innerHTML = "—"; el.dataset.tone = ""; $("effScoreSub").textContent = "drive half a mile to score"; return; }
    const r = tripAvg / rated, s1 = Math.max(0, Math.min(1, (1.5 - r) / 0.65)) * 100;
    const pedal = app.coach.score(), sc = Math.round(0.7 * s1 + 0.3 * (pedal ?? s1));
    el.innerHTML = `${sc}<small>/100</small>`; el.dataset.tone = sc >= 80 ? "good" : sc >= 60 ? "warn" : "bad";
    $("effScoreSub").textContent = `${r <= 1 ? Math.round((1 - r) * 100) + "% under" : Math.round((r - 1) * 100) + "% over"} rated Wh/mi${pedal != null ? ` · pedal ${pedal}% in range` : ""}`;
  }

  // Power flow bar: zero sits at 28% so the "using" side gets more room. √ scale so cruising is visible.
  const FZ = 28, flow = { v: 0, last: performance.now(), up: 0, dn: 0 };
  const fFrac = (v, up, dn) => (v >= 0 ? Math.sqrt(Math.min(1, v / up)) : Math.sqrt(Math.min(1, -v / dn)));
  const fPos = (v, up, dn) => (v >= 0 ? FZ + (100 - FZ) * fFrac(v, up, dn) : FZ - FZ * fFrac(v, up, dn));
  function flowTicks(up, dn) {
    if (flow.up === up && flow.dn === dn) return; flow.up = up; flow.dn = dn;
    $("fTicks").innerHTML = [-dn, -20, 0, 20, 50, 100, up].filter((v, i, a) => a.indexOf(v) === i && v <= up && v >= -dn)
      .map(v => `<span style="left:${fPos(v, up, dn)}%">${v < 0 ? "−" + -v : v}${v === up ? " kW" : ""}</span>`).join("");
  }
  function flowFrame(now) {
    const dt = Math.min(0.1, (now - flow.last) / 1000); flow.last = now;
    const live = app.source && performance.now() - app.lastFrameAt < (app.source === "tessie" ? 45000 : 4000);
    flow.v += ((live && L.powerKW != null ? L.powerKW : 0) - flow.v) * Math.min(1, dt / 0.12);
    const up = Math.max(150, Math.ceil((L.maxDischargeKW > 40 && L.maxDischargeKW < 400 ? L.maxDischargeKW : 200) / 50) * 50), dn = 80;
    flowTicks(up, dn);
    const v = flow.v, tg = app.tgt, moving = live && tg && tg.mph > 3;
    $("fUse").style.transform = `scaleX(${v > 0 ? fFrac(v, up, dn) : 0})`;
    $("fRegen").style.transform = `scaleX(${v < 0 ? fFrac(v, up, dn) : 0})`;
    const zu = $("fZoneU"), zr = $("fZoneR"); zu.hidden = zr.hidden = !moving;
    if (moving) {
      zu.style.left = `${FZ}%`; zu.style.width = `${fPos(tg.upKW, up, dn) - FZ}%`;
      const l = fPos(-tg.regenGentle, up, dn); zr.style.left = `${l}%`; zr.style.width = `${FZ - l}%`;
    }
    const useTone = !moving ? "" : v <= tg.upKW ? "ok" : v <= tg.upKW * 1.8 ? "" : "way", hard = moving && -v > tg.regenGentle;
    $("fUse").dataset.tone = useTone; $("fRegen").dataset.tone = hard ? "hard" : "";
    const kw = `${Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : Math.round(Math.abs(v))} kW`;
    $("flowState").textContent = !live || L.powerKW == null ? "—"
      : v < -0.5 ? (hard ? `${kw} regen · strong, lift earlier` : `${kw} regen`)
      : !moving ? `${kw} ${v > 0.3 ? "draw" : ""}`.trim()
      : useTone === "ok" ? `${kw} · efficient` : useTone === "way" ? `${kw} · hard acceleration` : `${kw} · above efficient`;
    requestAnimationFrame(flowFrame);
  }
  document.documentElement.style.setProperty("--z", `${FZ}%`);
  requestAnimationFrame(flowFrame);

  /* ---------------- eyes-free alerts ----------------
     Off by default. A short buzz and/or tone when a costly habit starts, so you don't have to look:
     one low tone = ease off the pedal; two high tones = lift earlier (brake or regen at its limit); long low = pack warning.
     Each kind fires at most once per 15 s, never while cruise/Autopilot is marked on. */
  const ALERT_KIND = { "pedal.heavy": "ease", "pedal.sharpLift": "ease", "brake.friction": "brake", "pedal.regenAtLimit": "brake", "pack.coldDraw": "warn", "soc.lowDraw": "warn", "pack.hot": "warn" };
  const PATTERN = { ease: { vib: [90], tones: [[392, 0.16]] }, brake: { vib: [60, 70, 60], tones: [[784, 0.1], [784, 0.1]] }, warn: { vib: [250], tones: [[262, 0.45]] } };
  let audioCtx = null; const lastAlert = {}; let prevKinds = new Set();
  function unlockAudio() { try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume(); } catch (e) {} }
  function fireAlert(type, force) {
    const mode = cfg.alerts || "off"; if (mode === "off" && !force) return;
    const p = PATTERN[type]; if (!p) return;
    if ((mode === "vibrate" || mode === "both" || force) && navigator.vibrate) { try { navigator.vibrate(p.vib); } catch (e) {} }
    if ((mode === "sound" || mode === "both" || force) && audioCtx) {
      let t = audioCtx.currentTime + 0.02;
      for (const [f, d] of p.tones) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + d + 0.02); t += d + 0.08;
      }
    }
  }
  function checkAlerts(now) {
    const st = app.coach.state, kinds = new Set((st.list || []).map(q => q.kind));
    if (!st.cruiseOn && (L.speedMph ?? 0) > 5) for (const k of kinds) {
      const type = ALERT_KIND[k];
      if (type && !prevKinds.has(k) && !(now - (lastAlert[k] || 0) < 15000)) { lastAlert[k] = now; fireAlert(type); }
    }
    prevKinds = kinds;
  }
  document.addEventListener("pointerdown", () => { if (cfg.alerts && cfg.alerts !== "off") unlockAudio(); }, { once: true });

  /* ---------------- drive summaries + history ---------------- */
  const fmtWhen = t => new Date(t).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const signed = (v, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
  function showSummary(d) {
    const tone = d.score == null ? "" : d.score >= 80 ? "good" : d.score >= 60 ? "warn" : "bad";
    const cell = (label, v, sub) => `<div class="scell"><div class="label">${label}</div><div class="sv">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
    $("sumBody").innerHTML = `
      <div class="shead"><div><h3>Drive summary${d.demo ? " · demo" : ""}</h3><div class="sub">${fmtWhen(d.t0)} · ${d.mi.toFixed(1)} mi${d.avgMph ? ` · avg ${Math.round(d.avgMph)} mph` : ""}</div></div>
        <div class="sscore" data-tone="${tone}"><span>${d.score ?? "—"}</span><small>score</small></div></div>
      <div class="sgrid">
        ${cell("Wh/mi", Math.round(d.wh), d.rated ? `rated ${Math.round(d.rated)}` : "")}
        ${cell("vs rated", d.vsRatedPct == null ? "—" : `${d.vsRatedPct > 0 ? "+" : ""}${d.vsRatedPct}%`, d.vsRatedPct == null ? "" : d.vsRatedPct <= 0 ? "used less" : "used more")}
        ${cell("Range vs rated", d.rangeDeltaMi == null ? "—" : `${signed(d.rangeDeltaMi)} mi`, "on this drive")}
        ${cell("Energy", `${d.kwh.toFixed(2)} kWh`, `${d.regenKWh.toFixed(2)} kWh back from regen`)}
        ${cell("Pedal in range", d.pedalPct == null ? "—" : `${d.pedalPct}%`, `${d.heavy} heavy · ${d.friction} brake-heavy stops`)}
        ${cell("Slowdown capture", d.capturePct == null ? "—" : `${d.capturePct}%`, d.stops ? `${d.stops} slowdowns · 60%+ is great` : "")}
        ${cell("Speeding up", d.accelKWh != null && d.accelKWh + d.cruiseKWh > 0 ? `${Math.round((d.accelKWh / (d.accelKWh + d.cruiseKWh)) * 100)}%` : "—", "of driving energy")}
        ${cell("Climate", d.climateKWh == null ? "—" : `${d.climateKWh.toFixed(2)} kWh`, d.climateKWh != null && d.kwh > 0 ? `${Math.round((d.climateKWh / d.kwh) * 100)}% of energy` : "")}
      </div>
      <div class="shabit" data-tone="${d.habit.tone}"><div class="label">${d.habit.tone === "good" ? "Nice" : "Work on this next"}</div><p>${d.habit.text}</p></div>
      ${compareLine(d)}`;
    $("sumDelete").hidden = d.demo || !drives.history.some(x => x.id === d.id);
    $("sumDelete").dataset.id = d.id; $("sumDelete").textContent = "Delete drive";
    $("summary").hidden = false;
  }
  // How this drive compares with your typical one (median of the other saved drives).
  function compareLine(d) {
    const others = drives.history.filter(x => x.id !== d.id && x.wh > 0);
    if (others.length < 3) return "";
    const med = others.map(x => x.wh).sort((a, b) => a - b)[Math.floor(others.length / 2)];
    const pct = Math.round((d.wh / med - 1) * 100);
    return `<p class="note" style="margin-top:10px">${pct === 0 ? "Same as" : pct < 0 ? `${-pct}% more efficient than` : `${pct}% less efficient than`} your typical drive (${Math.round(med)} Wh/mi).</p>`;
  }
  $("sumDone").addEventListener("click", () => ($("summary").hidden = true));
  $("sumDelete").addEventListener("click", e => {
    const b = e.currentTarget;
    if (b.textContent !== "Tap again to delete") { b.textContent = "Tap again to delete"; return; }
    drives.remove(b.dataset.id); $("summary").hidden = true; renderDrives();
  });
  $("summary").addEventListener("click", e => { if (e.target.id === "summary") $("summary").hidden = true; });
  function renderDrives() {
    const h = drives.history, box = $("driveList");
    $("endDrive").hidden = !drives.active;
    if (!h.length) { $("driveTrend").innerHTML = ""; box.innerHTML = `<p class="note">Each drive gets a summary and a score when you park (20 s in P). They're kept on this phone.</p>`; return; }
    renderTrend(h);
    box.innerHTML = h.slice(0, 8).map(d => `<button class="drow" type="button" data-id="${d.id}">
      <span class="dwhen">${fmtWhen(d.t0)}</span><span class="num">${d.mi.toFixed(1)} mi</span><span class="num">${Math.round(d.wh)} Wh/mi</span>
      <span class="dscore" data-tone="${d.score >= 80 ? "good" : d.score >= 60 ? "warn" : "bad"}">${d.score ?? "—"}</span></button>`).join("");
    box.querySelectorAll(".drow").forEach(b => b.addEventListener("click", () => { const d = drives.history.find(x => x.id === b.dataset.id); if (d) showSummary(d); }));
  }
  // Trend: last 12 scores as bars (oldest left), recent-vs-previous averages, best, and range saved vs rated.
  function renderTrend(h) {
    const avg = (a, f) => { const v = a.map(f).filter(x => x != null && isFinite(x)); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; };
    const recent = h.slice(0, 7), prev = h.slice(7, 14);
    const sNow = avg(recent, d => d.score), sPrev = avg(prev, d => d.score);
    const whNow = avg(recent, d => d.wh), whPrev = avg(prev, d => d.wh);
    const best = h.reduce((b, d) => (d.score != null && (!b || d.score > b.score) ? d : b), null);
    const saved = h.slice(0, 30).reduce((p, d) => p + (d.rangeDeltaMi || 0), 0);
    const bars = h.slice(0, 12).reverse();
    const W = 240, H = 46, bw = W / 12;
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="trendbars" role="img" aria-label="Scores of the last ${bars.length} drives">${bars.map((d, i) => {
      const sc = d.score ?? 0, hh = Math.max(3, (sc / 100) * (H - 4));
      const c = sc >= 80 ? "var(--regen)" : sc >= 60 ? "var(--warn)" : "var(--bad)";
      return `<rect x="${(i * bw + 2).toFixed(1)}" y="${(H - hh).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${hh.toFixed(1)}" rx="2" fill="${c}"/>`; }).join("")}</svg>`;
    const arrow = (now, before, lowerIsBetter) => { if (now == null || before == null) return ""; const better = lowerIsBetter ? now < before : now > before; const d = Math.abs(now - before);
      return d < 0.5 ? " · steady" : ` · <span data-tone="${better ? "good" : "bad"}">${better ? "▲ better" : "▼ worse"} vs prior 7</span>`; };
    $("driveTrend").innerHTML = `
      <div class="tgrid">
        <div><div class="label">Avg score, last ${recent.length}</div><div class="tv">${sNow == null ? "—" : Math.round(sNow)}</div><div class="sub">${arrow(sNow, sPrev, false).replace(/^ · /, "")}</div></div>
        <div><div class="label">Avg Wh/mi, last ${recent.length}</div><div class="tv">${whNow == null ? "—" : Math.round(whNow)}</div><div class="sub">${arrow(whNow, whPrev, true).replace(/^ · /, "")}</div></div>
        <div><div class="label">Best score</div><div class="tv">${best ? best.score : "—"}</div><div class="sub">${best ? fmtWhen(best.t0) : ""}</div></div>
        <div><div class="label">Range vs rated</div><div class="tv" data-tone="${saved >= 0 ? "good" : "bad"}">${signed(saved)} mi</div><div class="sub">last ${Math.min(30, h.length)} drives combined</div></div>
      </div>${svg}`;
  }

  $("endDrive").addEventListener("click", () => {
    if (!app.trip) return;
    const st = app.coach.state, sw = app.coach.table(L.outsideC).sweet;
    const d = drives.finish({ odo: L.odoMi ?? app.synthOdo, drive: app.trip.drive, park: app.trip.park, regen: app.trip.regen, climateKWh: L.compressorKW != null ? app.climateKWh : null,
      accelKWh: app.trip.eb ? app.trip.eb.accel : 0, cruiseKWh: app.trip.eb ? app.trip.eb.cruise : 0,
      stopKinetic: stops.state.kinetic, stopRegen: stops.state.regen, stopCount: stops.state.n,
      heavy: st.heavyEvents, friction: st.frictionEvents, pressedSec: st.pressedSec, rightSec: st.rightSec, rated: ratedWh(), sweetBand: sw ? sw.mph : null, outsideC: L.outsideC, demo: app.source === "demo" }, Date.now());
    if (d) showSummary(d); else notice("That drive was under 0.3 mi, so there's nothing to summarize.", "info");
    renderDrives();
  });
  renderDrives();
  setInterval(() => { $("endDrive").hidden = !drives.active; }, 2000);

  /* ---------------- diagnostics ---------------- */
  const ID_NAMES = { 0x118: "pedal/brake/gear", 0x132: "pack V/A → power", 0x252: "power limits", 0x257: "speed", 0x267: "road grade", 0x292: "SOC",
    0x2A8: "climate compressor", 0x312: "pack temps", 0x321: "outside temp", 0x33A: "rated range", 0x352: "energy remaining/full pack", 0x3B6: "odometer",
    0x3D2: "lifetime kWh (trip energy)", 0x401: "brick voltages" };
  function diagText() {
    const now = performance.now(), lines = [];
    lines.push(`Drive Energy diagnostics · ${new Date().toISOString()}`);
    lines.push(`Source: ${app.source || "none"} · adapter: ${app.link ? app.link.chip : "—"} · mode: ${app.link ? app.link.mode : "—"}${app.link && app.link.mode === "elm" ? ` · ATCRA wildcards: ${app.link.useCra ? "yes" : "no (ATCF/ATCM)"}` : ""}`);
    lines.push(`Frames total: ${app.frames} · now ${app.fps}/s · BUFFER FULL: ${app.bufferFull} · 0x352 format: ${dec.meta.fmt352 || "undetected"}`);
    lines.push("", "ID    frames  decoded  last seen   what");
    for (const id of LISTEN) {
      const s = app.idStats[id];
      lines.push(`${id.toString(16).toUpperCase().padStart(3, "0")}  ${String(s ? s.n : 0).padStart(7)}  ${String(s ? s.ok : 0).padStart(7)}  ${s ? ((now - s.last) / 1000).toFixed(1).padStart(7) + " s" : "  never  "}   ${ID_NAMES[id] || ""}${s ? "   last: " + s.sample : ""}`);
    }
    const other = Object.keys(app.idStats).map(Number).filter(id => !LISTEN.includes(id));
    if (other.length) lines.push(`Other IDs seen: ${other.map(i => i.toString(16).toUpperCase()).join(", ")}`);
    lines.push("", "Decoded now:", JSON.stringify({ ...L, bricks: `${L.bricks.filter(v => v != null).length}/108` }, (k, v) => (typeof v === "number" ? +v.toFixed(3) : v)));
    lines.push("", "Adapter commands:", ...((app.link && app.link.log) || ["—"]));
    lines.push("", "Other adapter output:", ...(app.rawLines.length ? app.rawLines : ["—"]));
    return lines.join("\n");
  }
  setInterval(() => { const d = $("diag"); if (d && d.open) $("diagText").textContent = diagText(); }, 1000);
  $("diag").addEventListener("toggle", () => { if ($("diag").open) $("diagText").textContent = diagText(); });
  $("diagCopy").addEventListener("click", async () => {
    const text = diagText(); $("diagText").textContent = text;
    try { await navigator.clipboard.writeText(text); $("diagCopy").textContent = "Copied"; setTimeout(() => ($("diagCopy").textContent = "Copy diagnostics"), 2000); }
    catch (e) { const r = document.createRange(); r.selectNodeContents($("diagText")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); $("diagCopy").textContent = "Selected: long-press to copy"; }
  });

  /* ---------------- CSV recording ---------------- */
  const COLS = ["time", "speed_mph", "power_kw", "pack_v", "pack_a", "odometer_mi", "total_out_kwh", "total_in_kwh", "soc_pct", "energy_remaining_kwh", "full_pack_kwh", "brick_min_v", "brick_max_v", "watched_brick", "watched_brick_v", "pack_tmin_c", "pack_tmax_c"];
  function record(now) {
    const b = L.bricks.filter(v => v != null), idx = cfg.oneBased ? cfg.brick - 1 : cfg.brick;
    const r = [new Date().toISOString(), L.speedMph, L.powerKW, L.packV, L.packA, L.odoMi, L.totalOutKWh, L.totalInKWh, L.socUI, L.energyRemainingKWh, L.fullPackKWh,
      b.length ? Math.min(...b) : null, b.length ? Math.max(...b) : null, cfg.brick, L.bricks[idx], L.packTminC, L.packTmaxC];
    app.rec.rows.push(r.map(v => (v == null ? "" : typeof v === "number" ? +v.toFixed(4) : v)).join(","));
    app.rec.last = now;
    if (app.rec.rows.length > 36001) app.rec.rows.splice(1, 1);
  }
  function toggleRec() {
    if (app.rec) { app.lastCsv = app.rec.rows.join("\n"); app.rec = null; }
    else app.rec = { rows: [COLS.join(",")], last: 0, started: new Date() };
    render(true);
  }
  function download() {
    const text = app.rec ? app.rec.rows.join("\n") : app.lastCsv; if (!text) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = `drive-energy-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}${app.source === "demo" ? "-DEMO" : ""}.csv`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------------- screen wake ---------------- */
  async function keepAwake() {
    if (!cfg.keepAwake || !("wakeLock" in navigator)) return;
    try { app.wake = await navigator.wakeLock.request("screen"); } catch (e) {}
  }
  function releaseAwake() { try { app.wake?.release(); } catch (e) {} app.wake = null; }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && app.source) keepAwake(); });

  /* ---------------- controls ---------------- */
  $("connectBtn").addEventListener("click", connectCar);
  $("demoBtn").addEventListener("click", () => (app.source === "demo" ? disconnect() : startDemo()));
  $("disconnectBtn").addEventListener("click", disconnect);
  $("resetTrip").addEventListener("click", () => { app.trip = null; drives.cancel(); stops.reset(); app.coach.resetTrip(); if (app.source !== "demo") store(tripKey(app.source === "tessie" ? "tessie" : "car"), null); render(false); });
  $("tessieBtn").addEventListener("click", () => (app.source === "tessie" ? disconnect() : startTessie()));
  $("cfgTok").value = tessieToken() ? "••••••••" : "";
  $("cfgTok").addEventListener("change", e => { const v = e.target.value.trim(); if (!v || /^•+$/.test(v)) return; try { localStorage.setItem(KEY.tok, v); } catch (err) {} e.target.value = "••••••••"; notice("Tessie token saved on this device only.", "info"); });
  $("cfgTokClear").addEventListener("click", () => { try { localStorage.removeItem(KEY.tok); } catch (e) {} $("cfgTok").value = ""; if (app.source === "tessie") disconnect(); });
  $("recBtn").addEventListener("click", toggleRec);
  $("resetSpeed").addEventListener("click", () => { app.coach.resetBuckets(); render(false); });
  $("cruiseBtn").addEventListener("click", () => { app.coach.setCruise(!app.coach.state.cruiseOn); render(true); });
  $("dlBtn").addEventListener("click", download);
  document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => { cfg.win = +b.dataset.w; store(KEY.cfg, cfg); syncSeg(); lastChart = 0; }));
  function syncSeg() { document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.w === cfg.win))); }
  $("cfgBrick").value = cfg.brick; $("cfgBase").value = cfg.oneBased ? "1" : "0"; $("cfgAwake").checked = cfg.keepAwake;
  $("cfgBrick").addEventListener("change", e => { const n = Math.round(+e.target.value); const lo = cfg.oneBased ? 1 : 0; if (n >= lo && n <= lo + 107) { cfg.brick = n; store(KEY.cfg, cfg); } });
  $("cfgBase").addEventListener("change", e => { cfg.oneBased = e.target.value === "1"; store(KEY.cfg, cfg); });
  $("cfgAuto").checked = cfg.autoConnect !== false;
  $("cfgAuto").addEventListener("change", e => { cfg.autoConnect = e.target.checked; store(KEY.cfg, cfg); if (e.target.checked) autoTry(); });
  $("cfgAlerts").value = cfg.alerts || "off";
  $("cfgAlerts").addEventListener("change", e => { cfg.alerts = e.target.value; store(KEY.cfg, cfg); unlockAudio(); });
  $("alertTest").addEventListener("click", () => { unlockAudio(); fireAlert("ease", true); setTimeout(() => fireAlert("brake", true), 900); });
  $("cfgAwake").addEventListener("change", e => { cfg.keepAwake = e.target.checked; store(KEY.cfg, cfg); if (cfg.keepAwake && app.source) keepAwake(); else releaseAwake(); });
  window.addEventListener("resize", () => { lastChart = 0; });

  // frame rate counter + main loop
  let lastFrames = 0;
  setInterval(() => { app.fps = app.frames - lastFrames; lastFrames = app.frames; }, 1000);
  setInterval(tick, 250);
  syncSeg();
  status("off", "Not connected");
  if (!window.ElmLink || !ElmLink.supported()) notice("Live car data needs Chrome 138+ on Android (or desktop Chrome) over https://. Demo works anywhere.", "info");
  // Service worker: check for a new version on every load and switch to it right away (one automatic reload).
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").then(r => r.update()).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded && !app.source) { reloaded = true; location.reload(); } });
  }
  render(false);
})();
