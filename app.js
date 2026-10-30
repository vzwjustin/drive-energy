/* Drive Energy — screen logic. Data path: OBDLink MX+ → Web Serial (Bluetooth) → STN monitor lines
   → CanDecode → trip math → screen. Demo mode feeds the same path from CanSim. */
(() => {
  "use strict";
  // Show script errors on screen instead of failing silently, so they can be reported. Background (promise) failures
  // too: every expected one is caught where it happens, so one that gets this far is a bug.
  const broke = what => {
    const n = document.getElementById("notice"); if (!n) return;
    n.hidden = false; n.dataset.tone = "bad";
    document.getElementById("noticeText").textContent = `Something broke: ${what}. Reload; if it stays, report this message with Copy diagnostics (Setup tab).`;
  };
  window.addEventListener("error", e => broke(`${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`));
  window.addEventListener("unhandledrejection", e => broke(e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  const $ = id => document.getElementById(id);
  const D = window.CanDecode;
  const LISTEN = Object.values(D.IDS);
  const KEY = { drives: "de.drives.v1", speed: "de.speed.v1", trip: "de.trip.v1", tripT: "de.trip.tessie.v1", cfg: "de.cfg.v1", tok: "de.tessie.v1", csv: "de.csv.v1" };
  const DEMO_SPEED = 8;
  const tripKey = src => (src === "tessie" ? KEY.tripT : KEY.trip);
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  const cfg = Object.assign({ win: 15, brick: 38, oneBased: true, keepAwake: true, drive: false, goal: null }, load(KEY.cfg, {}));
  const U = Units; U.set(cfg.units);                     // miles or kilometers on screen (Setup); the math stays in miles
  // The car's own touchscreen browser (its user agent carries "Tesla/<firmware>"), or ?car to try that layout elsewhere.
  // It has no Web Serial, so the adapter can't connect there: the numbers come from Tessie.
  const inCar = /\bTesla\//.test(navigator.userAgent || "") || /[?&]car\b/.test(location.search || "");
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
    const on = app.source === "car" || (inCar && app.source === "tessie");   // connected the way this screen can be
    $("connectBtn").hidden = on;
    $("chooseBtn").hidden = app.source === "car";
    document.body.classList.toggle("offline", !on);
    $("disconnectBtn").hidden = app.source !== "car" && app.source !== "tessie";
    $("demoLbl").textContent = app.source === "demo" ? "Stop demo" : "Demo";
    $("tessieLbl").textContent = app.source === "tessie" ? "Stop Tessie" : "Start Tessie";
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
      if (r === "bricks") sagSample(f.bytes[0]);
      // With another app in front Chrome may run timers once a minute; frames keep arriving, so let them drive the update.
      if (app.lastFrameAt - app.lastTick > 1100) tick();
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
  async function connectCar(auto = false, choose = false) {
    auto = auto === true;                                   // never let an Event object count as "auto"
    if (!window.ElmLink || !ElmLink.supported()) {
      if (!auto) notice("This browser can't open Bluetooth serial ports. Use Chrome 138 or newer on Android, opened from an https:// address.", "bad");
      return;
    }
    let picked = null;
    if (!auto) {
      app.userStopped = false;
      // Open the picker first, while Chrome still counts this as your tap.
      let known = [];
      try { known = await navigator.serial.getPorts(); } catch (e) {}
      if (choose || !known.length) {
        notice("Chrome will ask to connect to a \"serial port\": that's your Bluetooth OBD adapter. Pick its name (for example OBDLink MX+ or vLinker) and tap Connect.", "info");
        try { picked = await navigator.serial.requestPort(); }
        catch (e) { notice(e && e.name === "NotFoundError" ? "No adapter picked. If the list was empty: 1) pair the adapter in Android Settings → Bluetooth (PIN usually 1234), 2) allow Chrome's Nearby devices permission (Android Settings → Apps → Chrome → Permissions), 3) close Scan My Tesla or other OBD apps, then tap Choose adapter in Setup." : (e.message || String(e)), "bad"); return; }
      }
      // A background attempt may still be holding the port; wait for it (up to 12 s) instead of ignoring the tap.
      if (app.connecting) { app.abortAuto = true; status("connecting", "Finishing the last attempt…"); for (let i = 0; i < 48 && app.connecting; i++) await new Promise(r => setTimeout(r, 250)); }
      if (app.source === "car") await disconnect();
      app.userStopped = false;
      if (picked) {
        app.port = picked;
        // Web Serial can't tell two Bluetooth serial adapters apart (same service ID), so keep permission for the one
        // you picked only; auto-connect then can't open the wrong one. Choose adapter still lists them all.
        for (const p of known) if (p !== picked) p.forget?.().catch(() => {});
      }
    }
    if (app.connecting) return; app.connecting = true; app.abortAuto = false;
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
      if (!auto) notice(null);
      // Bluetooth open can hang when the adapter is off or out of range: give up after 10 s.
      await Promise.race([link.open(port), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("The adapter didn't answer. Is the car awake and the adapter plugged in?"), { quiet: auto })), 10000))]);
      if (auto && app.abortAuto) throw Object.assign(new Error("superseded"), { quiet: true });
      await link.init(LISTEN);
      resetDecoder();
      await link.startMonitor();
      status("live", "Live");
      $("adapter").textContent = `${link.chip.replace(/\s+/g, " ")} · ${link.mode === "stn" ? "STN filters, continuous" : "ELM round-robin, ~1 s refresh"} · listen-only`;
      if (auto) notice("Connected to the adapter automatically.", "info");
    } catch (e) {
      await link.close().catch(() => {});
      app.link = null; app.source = null;
      if (auto) {
        // Adapter not powered/in range yet (car off, phone just got in): keep the remembered port and try again soon.
        status("off", app.port || (e && !e.quiet) ? "Looking for the adapter…" : "Not connected");
      } else {
        const msg = e && e.name === "NotFoundError" ? "No adapter picked. Pair the adapter in Android Bluetooth settings first, then tap Connect car." : `${e.message || String(e)} If that's the wrong adapter, tap Choose adapter in Setup.`;
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
      // Reconnect through the quiet auto path: a miss keeps the remembered adapter and auto-connect retries every 15 s.
      setTimeout(async () => { try { await link?.close(); } catch (e) {} if (app.source === "car" && !app.link) { app.source = null; connectCar(true); } }, 2500);
    }
  }
  async function disconnect() {
    const src = app.source;
    if (src === "car") app.userStopped = true;
    if (src === "demo") stopDemo();
    if (src === "tessie") stopTessie();
    app.source = null;
    if (app.link) { await app.link.close().catch(() => {}); app.link = null; }
    syncAwake();
    status("off", "Not connected");
  }

  /* ---------------- demo ---------------- */
  async function startDemo() {
    // Fully stop the adapter or Tessie first, so neither overwrites the demo's status or swaps trips afterwards.
    if (app.source) { await disconnect(); if (app.source) return; }   // a second tap already started the demo
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
  function resetDecoder() { drives.cancel(); stops.reset(); app.sag = null; app.restSpread = null; app.restSec = 0; app.climateKWh = 0; app.liveAt = 0; dec = D.createDecoder(); L = dec.state; app.pEma = null; app.synthNet = 0; app.synthOdo = 0; app.idStats = {}; app.rawLines = []; app.bufferFull = 0; }

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
    // After a (re)connect, pack power arrives well before the kWh and odometer frames (ELM round-robin: 10–20 s).
    // Wait for both (or 30 s, then integrate instead) so the saved trip isn't taken for a new source and reset.
    if (live && !app.liveAt) app.liveAt = now;
    const settled = (hasTotals && L.odoMi != null) || (live && now - app.liveAt > 30000);

    if (app.source && live && settled && (L.powerKW != null || hasTotals)) {
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
      if (now - app.lastSave > 10000) { saveTrip(); app.lastSave = now; }
    }
    app.tgt = app.source ? computeTargets() : null;
    // Tessie has no pedal or brake data, so it gets the tips that don't need them (drag, pack, charge, cold air…).
    if (live && app.source) app.coach.update({
      pedal: L.pedalPct, kw: app.pEma, mph: L.speedMph, brake: L.brakeOn, gear: L.gear, soc: L.socUI ?? L.uiSOC,
      tMin: L.packTminC, tMax: L.packTmaxC, hvacKw: L.compressorKW, regenLimitKw: L.maxRegenKW, grade: L.gradePct, outsideC: L.outsideC,
      learn: app.source !== "tessie",
    }, app.source === "demo" ? dt * DEMO_SPEED : dt, now);   // real time even in Demo, so tips are held long enough to read
    const dtSim = app.source === "demo" ? dt * DEMO_SPEED : dt;
    // Health test prep pace, for its time estimates: average speed over the last few minutes, stops included.
    if (!healthOn()) app.pace = null;
    else if (live && L.speedMph != null) app.pace = app.pace == null ? (L.speedMph > 3 ? L.speedMph : null) : app.pace + (L.speedMph - app.pace) * Math.min(1, dtSim / 180);
    // Brick spread after 10 s parked with almost no current: the balance figure. Under load the bricks are read a few
    // at a time while the current changes, so the live spread mixes moments.
    app.restSec = live && L.packA != null && Math.abs(L.packA) < 5 && (L.speedMph ?? 0) < 0.5 ? (app.restSec || 0) + dtSim : 0;
    if (app.restSec > 10) { const have = L.bricks.filter(v => v != null); if (have.length >= 100) app.restSpread = (Math.max(...have) - Math.min(...have)) * 1000; }
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
    if (live && settled && app.source && app.trip) {         // Tessie too (gear from its shift state): no pedal or slowdown parts
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
    syncAwake();
    render(live);
  }

  function saveTrip() { if (app.trip && (app.source === "car" || app.source === "tessie")) store(tripKey(app.source), app.trip); }

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
    const t = app.trip, soc = L.socUI ?? L.uiSOC;
    const packT = L.packTminC != null ? `${fx(U.temp(L.packTminC))}–${fx(U.temp(L.packTmaxC))}` : null;
    // charge (power is on the flow bar below it)
    set("kSoc", fx(soc), "%"); $("kSoc").dataset.tone = soc == null ? "" : soc < 10 ? "bad" : soc < 20 ? "warn" : "";
    $("kSocSub").textContent = [L.energyRemainingKWh != null && `${fx(L.energyRemainingKWh, 1)} kWh left`, packT && `pack ${packT}${U.t}`].filter(Boolean).join(" · ") || "waiting for the car";
    // consumption
    const tripMi = t ? t.lastOdo - t.odo0 : 0, tripAvg = t && tripMi > 0.3 ? (t.drive * 1000) / tripMi : null;
    const wAvg = windowAvg(t, U.toMi(cfg.win));
    set("avg", fx(U.wh(wAvg)), U.e); $("avgLabel").textContent = `Avg · last ${cfg.win} ${U.d}`;
    const rated = ratedWh();
    const vsRated = r => (r <= 1 ? `${Math.round((1 - r) * 100)}% under rated` : `${Math.round((r - 1) * 100)}% over rated`);
    $("avgSub").textContent = wAvg && rated ? `${vsRated(wAvg / rated)} (${Math.round(U.wh(rated))} ${U.e})` : rated ? `rated ${Math.round(U.wh(rated))} ${U.e}` : "builds as you drive";
    const usable = L.energyRemainingKWh != null ? Math.max(0, L.energyRemainingKWh - (L.bufferKWh ?? 0)) : null;
    const basis = wAvg ?? tripAvg;
    set("proj", fx(U.dist(usable != null && basis > 50 ? (usable * 1000) / basis : L.ratedRangeMi)), U.d);
    $("projSub").textContent = usable != null && basis > 50 ? `at ${Math.round(U.wh(basis))} ${U.e} · rated ${fx(U.dist(L.ratedRangeMi))} ${U.d}` : "rated range";
    // Under the chart, as the car's Energy app does: the window's average and the range it projects.
    $("chartSub").textContent = usable != null && wAvg > 50 ? `Avg ${Math.round(U.wh(wAvg))} ${U.e} over the last ${cfg.win} ${U.d} · projected ${fx(U.dist((usable * 1000) / wAvg))} ${U.d}` : "Rolling average against rated";
    renderGuide(usable, basis);
    app.hs = healthNow();
    renderGauge(live, tripAvg);
    renderScore(tripMi, tripAvg);
    // battery
    $("battFill").style.width = `${Math.max(0, Math.min(100, soc ?? 0))}%`; $("battPct").textContent = soc != null ? `${fx(soc, 1)}%` : "—";
    set("eRem", fx(L.energyRemainingKWh, 1), "kWh"); set("eFull", fx(L.fullPackKWh, 1), "kWh");
    set("eBuf", fx(L.bufferKWh, 1), "kWh"); set("pv", fx(L.packV, 1), "V"); set("pa", fx(L.packA, 1), "A");
    $("pt").innerHTML = packT ? `${packT}<small>${U.t}</small>` : "—";
    set("bRegen", fx(L.maxRegenKW), "kW"); set("bRange", fx(U.dist(L.ratedRangeMi)), U.d);
    $("topSoc").textContent = soc != null ? `${fx(soc)}%` : "—";
    $("topTemp").textContent = packT ? `${packT}${U.t}` : "—";
    // trip
    set("tMi", fx(U.dist(tripMi), 1), U.d); set("tAvg", fx(U.wh(tripAvg)), U.e);
    const tot = t ? t.drive + t.park : 0;
    $("tDrive").textContent = t ? `${fx(t.drive, 2)} kWh` : "—";
    $("tPark").textContent = t ? `${fx(t.park, 2)} kWh` : "—";
    $("tRegen").textContent = t ? `${fx(t.regen, 2)} kWh` : "—";
    $("tChg").textContent = t && t.charged > 0.01 ? `${fx(t.charged, 2)} kWh` : "—";
    $("tSince").textContent = t ? `since ${new Date(t.t0).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
    const bars = $("split").children;
    bars[0].style.width = tot > 0 ? `${(Math.max(0, t.drive) / tot) * 100}%` : "0"; bars[1].style.width = tot > 0 ? `${(t.park / tot) * 100}%` : "0";
    // Slower-changing panels redraw once a second (or immediately on an explicit refresh) to keep the phone cool,
    // and only on the tab that's showing: switching tabs forces a redraw.
    const nowR = performance.now(), slow = live === true && nowR - (app.slowAt || 0) < 1000 && !app.forceSlow;
    if (!slow) {
      app.slowAt = nowR; app.forceSlow = false;
      if (cfg.tab === "trip") { renderBreakdown(t); renderPark(); }
      if (cfg.tab === "battery") { renderPlan(usable); renderBricks(); }
      if (cfg.tab === "cockpit") renderMiles(app.tgt && app.tgt.whTarget ? Math.round(app.tgt.whTarget) : ratedWh());
      if (cfg.tab === "health") renderHealth(cfg.health ? app.hs : burnPlan(null));
    }
    renderCoach(live, slow);
    // footer
    $("fps").textContent = app.source ? `${app.fps} frames/s` : "";
    $("recBtn").textContent = app.rec ? `Stop recording (${app.rec.rows.length - 1} rows)` : "Record CSV";
    $("dlBtn").hidden = !(app.rec && app.rec.rows.length > 1) && !app.lastCsv;
    if (cfg.tab === "trip" && performance.now() - lastChart > 900) { lastChart = performance.now(); drawChart(t); }
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
    if (!app.source || !live) { tip.textContent = app.source ? "Waiting for the car…" : "Connect the car to start coaching."; tip.dataset.tone = "idle"; app.saidKind = null; }
    else if (st.headline) {
      tip.textContent = st.headline.text;
      // Screen readers hear a tip once when it changes, not on every live-number refresh (4× a second).
      if (app.saidKind !== st.headline.kind) { app.saidKind = st.headline.kind; $("tipSay").textContent = st.headline.text; }
      tip.dataset.tone = st.headline.kind === "parked" || st.headline.kind === "stopped" ? "idle" : ({ WARN: "bad", GOOD: "good", TIP: "warn" })[st.headline.level];
      tip2.textContent = st.second ? st.second.text                // held like the headline (coach.js), so it doesn't flicker
        : app.source === "tessie" && !inCar && st.headline.kind !== "parked" ? "Pedal and brake coaching need the adapter." : "";
    }
    const sc = C.score();
    set("cScore", sc == null ? "—" : String(sc), sc == null ? "" : "%");
    $("cScore").dataset.tone = sc == null ? "" : sc >= 75 ? "good" : sc >= 50 ? "warn" : "bad";
    $("cHard").textContent = String(st.heavyEvents); $("cBrake").textContent = String(st.frictionEvents);
    set("cGrade", L.gradePct == null ? "—" : `${L.gradePct > 0 ? "+" : ""}${L.gradePct}`, L.gradePct == null ? "" : "%");
    $("cruiseBtn").setAttribute("aria-pressed", String(st.cruiseOn));
    $("cruiseBtn").hidden = !live || !app.source || app.source === "tessie";   // only means something with live pedal data
    const avgCap = stops.avg(), ls = stops.state.last;
    set("cCap", avgCap == null ? "—" : String(avgCap), avgCap == null ? "" : "%");
    $("cCap").dataset.tone = avgCap == null ? "" : Stops.grade(avgCap);
    $("cCapSub").textContent = ls ? `last: ${Math.round(U.speed(ls.v0))}→${Math.round(U.speed(ls.v1))} ${U.s}, ${ls.pct}%${ls.braked ? " (brake used)" : ""}` : `slowdowns from ${Math.round(U.speed(15))}+ ${U.s}`;
    // Right after a slowdown, show its result in the second coaching line for 8 s.
    if (ls && app.lastStopAt && performance.now() - app.lastStopAt < 8000 && app.source)   // 8 real seconds, Demo too
      $("tip2").textContent = `That slowdown recovered ${ls.pct}% of your momentum${ls.pct >= 60 ? ". Excellent." : ls.pct >= 40 ? ". Lift a bit earlier for more." : ". Lift much earlier, less brake."}`;
    // Health test prep takes over the banner: where to turn around, then how far is left to the target.
    if (cfg.health && app.source && live) {
      const h = cfg.health, s = app.hs, p = app.pEma;
      const text = !s ? "Health test prep: waiting for the charge level…"
        : h.phase === "done" ? `At ${h.target}%: ready for the battery health test.`
        : h.phase === "back" ? `Head home · ${fx(U.dist(s.left), 1)} ${U.d}${dot(eta(s.left))} of driving left until ${h.target}%.`
        : s.turnIn <= 0.2 ? "Turn around now and head home."
        : `${Math.round(s.raw)}% → ${h.target}% · turn around in ${fx(U.dist(s.turnIn), 1)} ${U.d}${dot(eta(s.turnIn))}.`;
      tip.textContent = text; tip.dataset.tone = h.phase === "done" ? "good" : "warn";
      tip2.textContent = s && p > 0.3 && h.phase !== "done" ? `Using ${fx(p, 1)} kW · about ${Math.round(p / s.k)}% an hour${h.burn && h.burn.did.length ? " · climate boosted" : ""}` : "";
      const kind = `health.${h.phase}.${s && s.turnIn <= 0.2 ? 1 : 0}`;
      if (app.saidKind !== kind) { app.saidKind = kind; $("tipSay").textContent = text; }
    }
    if (slow || cfg.tab !== "trip") return;                // the speed curve lives on the Trip tab
    const { rows, sweet, band } = C.table(L.outsideC), box = $("speedTable");
    $("tempBand").textContent = band === "x" ? "" : `at ${U.tempBand(band)} outside`;
    if (!rows.length) { box.innerHTML = `<p class="note">Fills in as you cruise steadily above ${Math.round(U.speed(20))} ${U.s}. Each ${Math.round(U.speed(5))}-${U.s} band needs about ${U.metric ? "0.8 km" : "half a mile"}${band === "x" ? "" : " at this outside temperature"}.</p>`; return; }
    // Speed curve: your Wh/mi at each 5-mph band (points at band centers), sweet spot highlighted, your speed marked,
    // and what a full usable pack would reach at each band. Drawn in the units picked in Setup.
    const usable = L.energyRemainingKWh != null ? Math.max(0, L.energyRemainingKWh - (L.bufferKWh ?? 0)) : null;
    const sp = U.speed, W = 320, H = 150, Lp = 34, R = 10, T = 14, B = 24, xs = rows.map(r => sp(r.mph + 2.5)), xStep = U.metric ? 20 : 10;
    const x0 = Math.min(sp(20), ...xs) - 2, x1 = Math.max(sp(80), ...xs) + 2, ys = rows.map(r => U.wh(r.wh));
    const y0 = Math.floor((Math.min(...ys) - 20) / 50) * 50, y1 = Math.ceil((Math.max(...ys) + 20) / 50) * 50;
    const X = v => Lp + ((v - x0) / (x1 - x0)) * (W - Lp - R), Y = v => T + ((y1 - v) / (y1 - y0)) * (H - T - B);
    let g = "";
    for (let v = y0; v <= y1; v += 50) g += `<line x1="${Lp}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${Lp - 5}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
    for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1; v += xStep) g += `<text x="${X(v)}" y="${H - 6}" text-anchor="middle">${v}</text>`;
    const path = rows.map((r, i) => `${i ? "L" : "M"}${X(sp(r.mph + 2.5)).toFixed(1)},${Y(U.wh(r.wh)).toFixed(1)}`).join("");
    const curX = mph > 3 ? X(Math.max(x0, Math.min(x1, sp(mph)))) : null;
    box.innerHTML = `<svg class="scurve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Your ${U.e} by speed">${g}
      ${curX ? `<line x1="${curX}" x2="${curX}" y1="${T}" y2="${H - B}" stroke="var(--fg)" stroke-dasharray="3 3" opacity=".6"/><text x="${curX}" y="${T - 3}" text-anchor="middle" style="fill:var(--fg)">you ${Math.round(sp(mph))}</text>` : ""}
      ${rows.length > 1 ? `<path d="${path}" fill="none" stroke="var(--rated)" stroke-width="2"/>` : ""}
      ${rows.map(r => `<circle cx="${X(sp(r.mph + 2.5))}" cy="${Y(U.wh(r.wh))}" r="${sweet && r.mph === sweet.mph ? 6 : 3.5}" fill="${sweet && r.mph === sweet.mph ? "var(--energy)" : "var(--rated)"}"/>`).join("")}
      </svg>
      <div class="stable2">${rows.map(r => `<div class="${sweet && r.mph === sweet.mph ? "sweet" : ""}${mph > 2 && r.mph === Math.floor(mph / 5) * 5 ? " cur" : ""}"><span class="num">${U.band(r.mph)}</span><span class="num">${Math.round(U.wh(r.wh))} ${U.e}</span><span class="num">${usable != null ? `${Math.round(U.dist((usable * 1000) / r.wh))} ${U.d}` : ""}</span></div>`).join("")}</div>
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
  $("planRes").value = String(cfg.plan.res);
  // Typed in the shown unit, kept in miles.
  $("planMi").addEventListener("change", e => { const v = Math.round(parseFloat(e.target.value)); if (v >= 1 && v <= 400) { cfg.plan.mi = U.toMi(v); store(KEY.cfg, cfg); } else e.target.value = String(Math.round(U.dist(cfg.plan.mi))); app.forceSlow = true; render(true); });
  $("planRes").addEventListener("change", e => { cfg.plan.res = +e.target.value; store(KEY.cfg, cfg); app.forceSlow = true; render(true); });
  // Wh/mi across several drives, weighted by distance: a half-mile hop doesn't count as much as a highway run.
  const whOf = list => { const mi = list.reduce((p, d) => p + d.mi, 0), kwh = list.reduce((p, d) => p + d.kwh, 0); return mi > 0 && kwh > 0 ? (kwh * 1000) / mi : null; };
  function planWh() {
    const recent = drives.history.slice(0, 7), recentWh = recent.length >= 2 ? whOf(recent) : null;
    const t = app.trip, tripMi = t ? t.lastOdo - t.odo0 : 0, tripWh = tripMi > 2 && t.drive > 0 ? (t.drive * 1000) / tripMi : null;
    return { wh: recentWh ?? tripWh ?? ratedWh(), basis: recentWh ? `your last ${recent.length} drives` : tripWh ? "this trip" : "rated" };
  }
  function renderPlan(usable) {
    const full = L.fullPackKWh, box = $("planRows"), { wh, basis } = planWh();
    if (!full || !wh) { box.innerHTML = `<p class="note">Needs the full-pack reading from the car: connect the adapter or Tessie.</p>`; return; }
    const needKWh = (cfg.plan.mi * wh) / 1000, needPct = Math.min(100, Math.ceil((needKWh / full) * 100 + cfg.plan.res));
    const soc = L.socUI ?? L.uiSOC;
    const coverMi = usable != null ? Math.max(0, ((usable - (cfg.plan.res / 100) * full) * 1000) / wh) : null;
    box.innerHTML = `
      <div><span>Charge to at least</span><span class="planbig" data-tone="${soc != null && soc >= needPct ? "good" : ""}">${needPct}%</span></div>
      <div><span>Energy for ${Math.round(U.dist(cfg.plan.mi))} ${U.d}</span><span>${needKWh.toFixed(1)} kWh at ${Math.round(U.wh(wh))} ${U.e}</span></div>
      ${soc != null ? `<div><span>Now at ${Math.round(soc)}%</span><span>${soc >= needPct ? "enough, no charge needed" : `${needPct - Math.round(soc)}% short`}</span></div>` : ""}
      ${coverMi != null ? `<div><span>Current charge covers</span><span>~${Math.round(U.dist(coverMi))} ${U.d} with ${cfg.plan.res}% left</span></div>` : ""}
      <p class="note" style="margin:6px 0 0">Based on ${basis}. Cold weather, climate use and highway speed raise ${U.e}.</p>`;
  }

  const EB = [["cruise", "Holding speed", "var(--rated)"], ["accel", "Speeding up", "var(--energy)"], ["climate", "Climate", "#6aa5e8"], ["parked", "Parked / standby", "var(--faint)"]];
  function renderBreakdown(t) {
    const eb = t && t.eb, box = $("ebRows"), bar = $("ebBar");
    const tot = eb ? EB.reduce((p, [k]) => p + Math.max(0, eb[k]), 0) : 0;
    if (!eb || tot < 0.02) { bar.innerHTML = ""; box.innerHTML = `<p class="note">${app.source === "tessie" ? "Needs the adapter: Tessie updates too slowly to split energy by use." : "Fills in as you drive."}</p>`; return; }
    bar.innerHTML = EB.map(([k, , c]) => `<i style="width:${(Math.max(0, eb[k]) / tot) * 100}%;background:${c}"></i>`).join("");
    const r = ratedWh(), range = kwh => (r ? ` · ${fx(U.dist((Math.max(0, kwh) * 1000) / r), 1)} ${U.d}` : "");   // range impact, as the car's Energy app shows it
    box.innerHTML = EB.map(([k, label, c]) => `<div><span><i class="dot" style="background:${c}"></i>${label}</span><span>${eb[k].toFixed(2)} kWh · ${Math.round((Math.max(0, eb[k]) / tot) * 100)}%${range(eb[k])}</span></div>`).join("")
      + `<div><span><i class="dot" style="background:var(--regen)"></i>Recovered by regen</span><span>${eb.regen.toFixed(2)} kWh${range(eb.regen)}${eb.accel > 0.05 ? ` · ${Math.round((eb.regen / eb.accel) * 100)}% of speed-up energy` : ""}</span></div>`;
  }

  function renderBricks() {
    const b = L.bricks, have = b.filter(v => v != null);
    const idx = cfg.oneBased ? cfg.brick - 1 : cfg.brick;
    $("bWatchLbl").textContent = `Brick ${cfg.brick}`;
    $("bMinLbl").textContent = "Lowest"; $("bMaxLbl").textContent = "Highest";
    if (have.length < 20) { ["bMin", "bMax", "bSpread", "bWatch", "bGap", "bSag"].forEach(id => ($(id).innerHTML = "—")); $("bSpreadSub").textContent = $("bSagSub").textContent = ""; $("bCount").textContent = app.source === "tessie" ? "needs the adapter (not in Tessie)" : `${have.length}/108 reported`; drawBricks(null, idx); return; }
    const min = Math.min(...have), max = Math.max(...have), base = cfg.oneBased ? 1 : 0;
    set("bMin", fx(min, 3), "V"); set("bMax", fx(max, 3), "V"); set("bSpread", fx((max - min) * 1000), "mV");
    $("bSpreadSub").textContent = app.restSpread != null ? `parked: ${fx(app.restSpread)} mV` : "parked: not yet";
    $("bMinLbl").textContent = `Lowest · #${b.indexOf(min) + base}`; $("bMaxLbl").textContent = `Highest · #${b.indexOf(max) + base}`;
    const w = b[idx];
    set("bWatch", w != null ? fx(w, 3) : "—", w != null ? "V" : "");
    const others = b.filter((v, i) => v != null && i !== idx), lowOther = others.length ? Math.min(...others) : null;
    const gap = w != null && lowOther != null ? (w - lowOther) * 1000 : null;
    $("bGap").innerHTML = gap == null ? "—" : `${Math.round(gap) > 0 ? "+" : ""}${Math.round(gap)}<small>mV</small>`;   // never "-0"
    $("bGap").dataset.tone = gap != null && gap < -20 ? "bad" : gap != null && gap < -5 ? "warn" : "";
    $("bCount").textContent = `${have.length}/108 reported · gap is vs the lowest of the others`;
    renderSag(idx, base);
    drawBricks(b, idx);
  }

  // Watched brick under load. The two bricks reported in the same frame were read at the same moment, at the same pack
  // current, so the slope of the watched brick's difference from them against current is its extra resistance:
  // how many mV more it sags per 100 A. Measured fresh each session, from the adapter's frames.
  function sagSample(mux) {
    const idx = cfg.oneBased ? cfg.brick - 1 : cfg.brick, b = L.bricks, a = L.packA;
    if (mux !== Math.floor(idx / 3) || a == null) return;
    const mates = [0, 1, 2].map(k => mux * 3 + k).filter(i => i !== idx);
    if (b[idx] == null || mates.some(i => b[i] == null)) return;
    let s = app.sag; if (!s || s.idx !== idx) s = app.sag = { idx, mates, n: 0, x: 0, y: 0, xx: 0, xy: 0, lo: a, hi: a };
    const g = (b[idx] - (b[mates[0]] + b[mates[1]]) / 2) * 1000;
    s.n++; s.x += a; s.y += g; s.xx += a * a; s.xy += a * g; s.lo = Math.min(s.lo, a); s.hi = Math.max(s.hi, a);
  }
  function renderSag(idx, base) {
    const s = app.sag && app.sag.idx === idx ? app.sag : null, el = $("bSag");
    if (!s || s.n < 20 || s.hi - s.lo < 100) {
      el.innerHTML = "—"; el.dataset.tone = "";
      $("bSagSub").textContent = app.source === "tessie" ? "needs the adapter" : "accelerate firmly once to measure";
      return;
    }
    const sag = (-(s.n * s.xy - s.x * s.y) / (s.n * s.xx - s.x * s.x)) * 100;   // mV per 100 A, + = sags more
    el.innerHTML = `${sag >= 0 ? "+" : "−"}${fx(Math.abs(sag), 1)}<small>mV</small>`;
    el.dataset.tone = sag >= 15 ? "bad" : sag >= 5 ? "warn" : "";
    $("bSagSub").textContent = `per 100 A vs bricks ${s.mates[0] + base} & ${s.mates[1] + base}`;
  }

  // Heatmap of all 108 bricks: brighter = higher within today's spread; amber/red = 5/20 mV under the median brick.
  function drawBricks(b, idx) {
    const have = b ? b.filter(v => v != null).sort((x, y) => x - y) : [], min = have[0], max = have[have.length - 1], med = have[have.length >> 1];
    const base = cfg.oneBased ? 1 : 0;
    $("bricks").innerHTML = Array.from({ length: 108 }, (_, i) => {
      const v = b && b[i], n = i + base, w = i === idx ? " w" : "";
      if (v == null) return `<span class="bk none${w}" data-i="${i}" title="Brick ${n}: no reading">${n}</span>`;
      const under = (med - v) * 1000, a = Math.round(8 + (max > min ? (v - min) / (max - min) : 1) * 32);
      return `<span class="bk${w}" data-i="${i}" data-tone="${under > 20 ? "bad" : under > 5 ? "warn" : ""}" style="--a:${a}%" title="Brick ${n}: ${v.toFixed(3)} V">${n}</span>`;
    }).join("");
  }

  function drawChart(t) {
    const box = $("chart"), wd = cfg.win, w = U.toMi(wd);          // window as shown (mi or km), and in miles
    const pts = [];
    if (t && t.D.length > 2) {
      const end = t.D[t.D.length - 1], start = Math.max(0, end - w), roll = U.toMi(wd <= 5 ? 0.5 : 1); let j = 0;
      for (let i = 1; i < t.D.length; i++) {
        if (t.D[i] < start) continue;
        while (j < i - 1 && t.D[i] - t.D[j + 1] >= roll) j++;
        const span = t.D[i] - t.D[j]; if (span < 0.2) continue;
        pts.push({ x: t.D[i] - (end - w), y: U.wh(((t.E[i] - t.E[j]) * 1000) / span) });
      }
    }
    if (pts.length < 2) {
      box.innerHTML = `<div class="empty"><div><strong>Drive to draw the line</strong>Consumption plots every ${U.metric ? "80 m" : "0.05 mi"} once the car is moving.</div></div>`;
      return;
    }
    const narrow = box.clientWidth < 520, W = narrow ? 380 : 640, H = narrow ? 220 : 260, Lp = 40, R = 10, T = 16, B = 24;
    const iw = W - Lp - R, ih = H - T - B, ys = pts.map(p => p.y), rated = U.wh(ratedWh());
    const budget = cfg.goal && app.budgetWh > 50 && app.budgetWh < 900 ? U.wh(app.budgetWh) : null;
    const top = Math.max(U.metric ? 300 : 400, Math.ceil(Math.max(...ys, rated || 0, budget || 0) / 100) * 100), bot = Math.min(0, Math.floor(Math.min(...ys) / 100) * 100);
    const X = x => Lp + (x / w) * iw, Y = y => T + ((top - Math.max(bot, Math.min(top, y))) / (top - bot)) * ih;
    let g = "";
    for (let v = bot; v <= top; v += 100) g += `<line x1="${Lp}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${Lp - 7}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
    const step = wd <= 5 ? 1 : wd <= 15 ? 5 : 10;
    for (let m = 0; m <= wd; m += step) g += `<text x="${X(U.toMi(m))}" y="${H - 6}" text-anchor="${m === 0 ? "start" : m === wd ? "end" : "middle"}">${m === wd ? "now" : `−${wd - m} ${U.d}`}</text>`;
    const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    const f = pts[0], l = pts[pts.length - 1], z = Y(Math.max(bot, 0));
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Consumption over the last ${wd} ${U.units}">${g}
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
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer in ${ms / 1000} s`)), ms))]);
  async function tget(path) {
    const r = await fetch(`https://api.tessie.com/${path}`, { headers: { Authorization: `Bearer ${tessieToken()}` }, cache: "no-store" });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }
  async function startTessie() {
    if (!tessieToken()) {
      showTab("setup"); $("cfgTok").focus();
      notice("Paste your Tessie API token in Setup first. It's saved on this device only.", "warn");
      return;
    }
    if (app.source === "car" || app.source === "demo") await disconnect();
    resetDecoder();
    app.source = "tessie"; app.trip = load(KEY.tripT, null); app.tessieAt = null; app.vin = null;
    status("connecting", "Reaching Tessie"); notice(null);
    // Poll from the start (finding the car first) so a failed first request is retried too. While a health test prep
    // runs, keep polling with the screen off (Chrome may slow it to once a minute) so climate still switches off at the target.
    app.tessieTimer = setInterval(() => { if (!document.hidden || healthOn()) pollTessie(); }, 10000);
    await pollTessie();
  }
  function stopTessie() {
    if (app.tessieTimer) { clearInterval(app.tessieTimer); app.tessieTimer = null; }
    if (app.source === "tessie") { app.trip = load(KEY.trip, null); }
  }
  async function pollTessie() {
    if (app.tessieBusy || app.source !== "tessie") return;
    app.tessieBusy = true;
    try {
      if (!app.vin) {
        const list = (await tget("vehicles?only_active=true")).results || [];
        if (!list.length) throw Object.assign(new Error("No vehicles on this Tessie account."), { status: 0 });
        app.vin = (list.find(v => v.vin === cfg.tessieVin) || list[0]).vin;
        showCars(list);
      }
      const [bat, st] = await Promise.all([tget(`${app.vin}/battery`), tget(`${app.vin}/state?use_cache=true`)]);
      if (app.source !== "tessie") return;
      const ds = st.drive_state || {}, vs = st.vehicle_state || {}, cs = st.charge_state || {};
      L.packV = bat.pack_voltage; L.packA = bat.pack_current;
      L.powerKW = typeof ds.power === "number" ? ds.power : (bat.pack_voltage * bat.pack_current) / 1000;
      L.speedMph = ds.speed || 0;
      L.gear = ds.shift_state || (ds.speed ? null : "P");    // no shift state while it sits (or sleeps): parked
      L.outsideC = typeof (st.climate_state || {}).outside_temp === "number" ? st.climate_state.outside_temp : null;
      if (typeof vs.odometer === "number") L.odoMi = vs.odometer;
      L.energyRemainingKWh = bat.energy_remaining; L.fullPackKWh = bat.nominal_full_pack_energy; L.bufferKWh = null;
      L.socUI = bat.battery_level; L.ratedRangeMi = bat.battery_range;
      L.packTminC = bat.module_temp_min; L.packTmaxC = bat.module_temp_max;
      if (cs.charge_limit_soc != null) L.chargeLimit = cs.charge_limit_soc;
      // Trip energy from the drop in energy remaining (0.01 kWh steps): out − in = 1000 − remaining.
      L.totalOutKWh = 1000 - bat.energy_remaining; L.totalInKWh = 0;

      app.carState = st.state; app.tessieAt = (bat.timestamp ? bat.timestamp * (bat.timestamp < 1e12 ? 1000 : 1) : Date.now());
      app.frames++; app.lastFrameAt = performance.now();
      if (app.lastFrameAt - app.lastTick > 1100) tick();     // timers stalled (screen off): update now, as adapter frames do
      if (!$("notice").hidden && $("notice").dataset.tone !== "bad") notice(null);
    } catch (e) { tessieError(e); }
    finally { app.tessieBusy = false; }
  }
  // Several cars on the Tessie account: a picker in Setup (remembered). Option() sets text safely.
  function showCars(list) {
    $("cfgVinRow").hidden = list.length < 2;
    $("cfgVin").replaceChildren(...list.map(v => new Option(`${v.last_state?.display_name || "Car"} · …${String(v.vin).slice(-6)}`, v.vin)));
    $("cfgVin").value = app.vin;
  }
  // Another car or account: forget the one looked up, so climate commands and the Parked card don't go to the old car.
  const forgetCar = () => { app.vin = app.cmdVin = null; app.park = null; };
  $("cfgVin").addEventListener("change", async e => {
    cfg.tessieVin = e.target.value; store(KEY.cfg, cfg); forgetCar();
    if (app.source === "tessie") { await disconnect(); startTessie(); }
  });
  function tessieError(e) {
    const s = e && e.status;
    app.tessieErr = `${new Date().toLocaleTimeString()} ${e && e.message ? e.message : "network"}`;
    if (s === 401 || s === 403) { notice("Tessie rejected the token. Paste a fresh one in Setup (Tessie app → Settings → API).", "bad"); disconnect(); return; }
    if (s === 429) { notice("Tessie says too many requests. Slowing down for a minute.", "warn"); if (app.tessieTimer) { clearInterval(app.tessieTimer); app.tessieTimer = setTimeout(() => { app.tessieTimer = setInterval(() => { if (!document.hidden || healthOn()) pollTessie(); }, 15000); }, 60000); } return; }
    if (s === 0) { notice(e.message, "bad"); disconnect(); return; }
    notice(`Couldn't reach Tessie (${e && e.message ? e.message : "network"}). Retrying every 10 seconds.`, "warn");
  }

  /* ---------------- parked (Tessie's idle log) ----------------
     Like the Park view of the car's Energy app: what each parked stretch used. Tessie logs these whether or not this
     page was open. Read-only; fetched while the Trip tab shows, at most every 10 minutes (every minute after a failure). */
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const hm = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  async function loadPark() {
    app.parkBusy = true;
    try {
      const vin = app.vin || cfg.tessieVin || ((await tget("vehicles?only_active=true")).results || [])[0]?.vin;
      if (!vin) throw new Error("no car on this Tessie account");
      const r = await tget(`${vin}/idles?from=${Math.floor(Date.now() / 1000) - 7 * 86400}&distance_format=mi`);
      app.park = { at: Date.now(), list: (r.results || []).filter(d => d.ended_at > d.started_at).sort((a, b) => b.started_at - a.started_at) };
    } catch (e) {
      app.park = { at: Date.now(), err: e.status === 401 || e.status === 403 ? "Tessie rejected the token. Paste a fresh one in Setup." : `Couldn't reach Tessie (${e.message || "network"}). Trying again in a minute.` };
    } finally { app.parkBusy = false; }
  }
  function renderPark() {
    const tok = !!tessieToken(), p = app.park;
    if (!tok) app.park = null;
    else if (!app.parkBusy && (!p || Date.now() - p.at > (p.err ? 60000 : 600000))) loadPark();
    const key = `${tok ? (app.park ? app.park.at : "wait") : "none"}${U.d}`;   // redraw only when the data or units change
    if (app.parkKey === key) return; app.parkKey = key;
    const blank = text => { $("pkLast").innerHTML = $("pkWeek").innerHTML = "—"; $("pkLastSub").textContent = $("pkWeekSub").textContent = ""; $("pkRows").innerHTML = ""; $("pkNote").textContent = text; };
    if (!tok) return blank("Paste a Tessie token in Setup: Tessie logs every parked stretch, even with this page closed.");
    if (!app.park) return blank("Reading Tessie's log…");
    if (app.park.err) return blank(app.park.err);
    const list = app.park.list;
    if (!list.length) return blank("No parked stretches in Tessie's log for the last 7 days.");
    const kwh = d => Math.max(0, +d.energy_used || 0), hrs = d => (d.ended_at - d.started_at) / 3600;
    const tags = d => [d.sentry_fraction >= 0.05 && `Sentry ${Math.round(d.sentry_fraction * 100)}%`, d.climate_fraction >= 0.05 && `climate ${Math.round(d.climate_fraction * 100)}%`].filter(Boolean).join(" · ");
    const last = list[0];
    set("pkLast", fx(kwh(last), 2), "kWh");
    $("pkLastSub").textContent = [hm(hrs(last) * 3600000), `${fx((kwh(last) * 1000) / hrs(last))} W`, tags(last)].filter(Boolean).join(" · ");
    const sum = list.reduce((s, d) => s + kwh(d), 0), mi = list.reduce((s, d) => s + Math.max(0, +d.rated_range_used || 0), 0);
    set("pkWeek", fx(sum, 1), "kWh");
    $("pkWeekSub").textContent = `${fx(sum / 7, 1)} kWh a day · ${fx(U.dist(mi))} ${U.d} of range`;
    $("pkRows").innerHTML = list.slice(0, 6).map(d => `<div><span>${fmtWhen(d.started_at * 1000)}${d.location ? ` · ${esc(String(d.location).split(",")[0])}` : ""}${tags(d) ? `<br><small class="sub">${tags(d)}</small>` : ""}</span><span>${fx(kwh(d), 2)} kWh · ${hm(hrs(d) * 3600000)}</span></div>`).join("");
    // What Sentry costs this car: average draw over stretches with it on the whole time, against those with it off.
    const avgW = g => { const h = g.reduce((s, d) => s + hrs(d), 0); return h > 0.5 ? (g.reduce((s, d) => s + kwh(d), 0) * 1000) / h : null; };
    const on = avgW(list.filter(d => d.sentry_fraction >= 0.9)), off = avgW(list.filter(d => !(d.sentry_fraction > 0.1) && !(d.climate_fraction > 0.1)));
    $("pkNote").textContent = on != null && off != null ? `With Sentry on, the car drew about ${Math.round(on)} W parked; with Sentry and climate off, ${Math.round(off)} W.` : "Sentry and climate show the share of the time each was on, as Tessie logs it.";
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
      const d = (usable * 1000) / basis - L.ratedRangeMi;
      set2("gRange", `${d >= 0 ? "+" : "−"}${Math.abs(Math.round(U.dist(d)))} ${U.d}`, d >= 0 ? "good" : d > -15 ? "warn" : "bad");
    } else set2("gRange", "drive to see", "");
    // 2. Best speed from your data, and what it's worth right now.
    if (tg && tg.sweet) {
      const s = tg.sweet, here = tg.here;
      if (usable != null && here && here.mph > s.mph && tg.mph > 3) {
        const gain = (usable * 1000) / s.wh - (usable * 1000) / here.wh, shown = Math.round(U.dist(gain));
        set2("gSpeed", shown >= 1 ? `${U.band(s.mph)}: +${shown} ${U.d}` : U.band(s.mph), gain >= 5 ? "warn" : "good");
      } else set2("gSpeed", `${U.band(s.mph)} · ${Math.round(U.wh(s.wh))} ${U.e}`, here && here.mph === s.mph ? "good" : "");
    } else set2("gSpeed", "learning…", "");
    // Climate / standby cost in range terms: kW ÷ your Wh/mi = miles of range used per hour.
    {
      const pace = basis > 50 ? basis : tg && tg.whTarget ? tg.whTarget : ratedWh();
      const moving = tg && tg.mph > 3, cw = L.compressorKW, out = L.outsideC != null ? Math.round(U.temp(L.outsideC)) : null;
      if (!moving && app.pEma != null && app.pEma > 0.05 && app.source && pace) {
        $("gClimL").textContent = "Parked draw";
        const mph = (app.pEma * 1000) / pace;
        set2("gClim", `${app.pEma.toFixed(1)} kW · −${U.dist(mph).toFixed(1)} ${U.d}/hr`, app.pEma > 1.5 ? "warn" : "");
      } else if (cw != null && pace) {
        $("gClimL").textContent = `Climate${out != null ? ` · ${out}${U.t} out` : ""}`;
        const mph = (cw * 1000) / pace;
        set2("gClim", cw < 0.15 ? `off · 0 ${U.d}/hr` : `${cw.toFixed(1)} kW · −${U.dist(mph).toFixed(1)} ${U.d}/hr`, cw > 3 ? "bad" : cw > 1.5 ? "warn" : "good");
      } else { $("gClimL").textContent = `Climate${out != null ? ` · ${out}${U.t} out` : ""}`; set2("gClim", app.source === "tessie" && !inCar ? "needs the adapter" : "—", ""); }
    }
    // 3. Range goal: energy budget per mile to arrive with the buffer intact.
    // A goal covers one stretch of driving: it clears itself a day after it was set. Set before the car was connected,
    // it counts from the first odometer reading.
    if (cfg.goal && Date.now() - cfg.goal.at > 864e5) { cfg.goal = null; app.budgetWh = null; store(KEY.cfg, cfg); lastChart = 0; }
    const g = cfg.goal;
    if (!g) { $("gGoalL").textContent = "Range goal"; set2("gGoal", "Set a goal", ""); return; }
    if (g.odo0 == null && L.odoMi != null) { g.odo0 = L.odoMi; store(KEY.cfg, cfg); }
    const done = L.odoMi != null && g.odo0 != null ? Math.max(0, L.odoMi - g.odo0) : 0;
    const left = Math.max(0, g.mi - done);
    $("gGoalL").textContent = `Goal ${Math.round(U.dist(g.mi))} ${U.d} · ${U.dist(left).toFixed(1)} left`;
    if (usable == null || left < 0.1) { set2("gGoal", left < 0.1 ? "Made it" : "waiting for battery data", left < 0.1 ? "good" : ""); return; }
    const budget = (usable * 1000) / left;
    app.budgetWh = budget;
    const pace = basis > 50 ? basis : tg && tg.whTarget;
    const full = L.fullPackKWh || null;
    if (!pace) { set2("gGoal", `budget ${Math.round(U.wh(budget))} ${U.e}`, ""); return; }
    const arrive = full ? Math.max(0, ((usable - (left * pace) / 1000) / full) * 100) : null;
    if (pace <= budget) set2("gGoal", `On budget${arrive != null ? ` · arrive ~${Math.round(arrive)}%` : ""}`, budget - pace > 40 ? "good" : "warn");
    else {
      const ok = tg && tg.rows.filter(r => r.wh <= budget * 0.95 && r.mph >= 25).sort((a, b) => b.mph - a.mph)[0];
      const over = `Over by ${Math.round(U.wh(pace - budget))} ${U.e}`;
      set2("gGoal", ok ? `${over} · slow to ~${U.bandTop(ok.mph)} ${U.s}` : `${over} · ease off`, "bad");
    }
  }

  $("gGoal").addEventListener("click", () => {
    const f = $("goalForm"); f.hidden = !f.hidden; $("goalMsg").textContent = "";
    if (!f.hidden) { $("goalMi").value = cfg.goal ? String(Math.round(U.dist(cfg.goal.mi))) : ""; f.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  });
  function setGoal(n) {                                    // n in the shown unit; the goal is kept in miles
    if (!(n >= 1 && n <= 400)) { $("goalMsg").textContent = `Enter a number of ${U.units} from 1 to 400.`; return; }
    cfg.goal = { mi: U.toMi(n), odo0: L.odoMi ?? null, at: Date.now() }; store(KEY.cfg, cfg);
    $("goalForm").hidden = true; lastChart = 0; render(true);
  }
  document.querySelectorAll("#goalQuick [data-mi]").forEach(b => b.addEventListener("click", () => setGoal(+b.dataset.mi)));
  $("goalForm").addEventListener("submit", e => { e.preventDefault(); setGoal(Math.round(parseFloat(String($("goalMi").value).replace(/[^0-9.]/g, "")))); });
  $("goalClear").addEventListener("click", () => { cfg.goal = null; app.budgetWh = null; store(KEY.cfg, cfg); $("goalForm").hidden = true; lastChart = 0; render(true); });
  /* ---------------- battery health test prep ----------------
     Use the charge down to a target (20%) on an out-and-back drive from home before the car's battery health test.
     Turn around when what's left above the target only just covers the drive back at the Wh/mi this drive is using:
     each extra mile out costs two, there and back. Tessie can switch climate on to burn faster. Only climate
     commands are ever sent, and Turn off undoes only what the app switched on. */
  const kwhPerPct = () => (L.fullPackKWh > 10 ? (L.fullPackKWh - (L.bufferKWh ?? 0)) / 100 : null);
  const healthOn = () => !!cfg.health && cfg.health.phase !== "done";
  // Tessie reports whole percents. Between steps, follow energy remaining (0.01 kWh) so the countdown moves smoothly:
  // just after a step down the charge is at the top of the new percent, and it can't go below the bottom of it.
  function fineSoc() {
    const soc = L.socUI ?? L.uiSOC, e = L.energyRemainingKWh, k = kwhPerPct();
    if (app.source !== "tessie" || soc == null || e == null || !k) return soc;
    let a = app.socAnchor;
    if (!a || a.soc !== soc) a = app.socAnchor = { soc, e, top: a && soc < a.soc ? soc + 0.5 : soc };
    return Math.min(soc + 0.5, Math.max(soc - 0.5, a.top - (a.e - e) / k));
  }
  function burnPlan(h) {                                  // h: the running prep, or null to plan from here
    const raw = L.socUI ?? L.uiSOC, soc = fineSoc(), k = kwhPerPct(), target = h ? h.target : cfg.healthTarget || 20;
    if (soc == null || !k) return null;
    const out = h && h.odo0 != null && L.odoMi != null ? Math.max(0, L.odoMi - h.odo0) : 0;
    const used = h && h.e0 != null && L.energyRemainingKWh != null ? h.e0 - L.energyRemainingKWh : 0;
    const own = out >= 2 && used > 0, p = planWh(), wh = own ? (used * 1000) / out : p.wh;   // this drive's own Wh/mi after 2 mi
    if (!wh) return null;
    const above = Math.max(0, (soc - target) * k), left = (above * 1000) / wh;
    return { soc, raw, k, target, out, wh, basis: own ? "this drive" : p.basis, above, left, turnIn: (left - out) / 2 };
  }
  // Runs with every screen update while a prep is on: fills in the start readings, then calls the turn-around and the target.
  function healthNow() {
    const h = cfg.health; if (!h) return null;
    // One outing: clears itself after a day, and a prep tried out in Demo doesn't carry over to the car (or back).
    if (Date.now() - h.at > 864e5 || (app.source && !!h.demo !== (app.source === "demo"))) { healthStop(); return null; }
    if (h.odo0 == null && L.odoMi != null) { h.odo0 = L.odoMi; store(KEY.cfg, cfg); }
    if (h.e0 == null && L.energyRemainingKWh != null) { h.e0 = L.energyRemainingKWh; store(KEY.cfg, cfg); }
    const s = burnPlan(h); if (!s) return null;
    if (h.phase !== "done" && s.raw <= h.target) { h.phase = "done"; store(KEY.cfg, cfg); prepAlert(); burnOff(); }
    else if (h.phase === "out" && s.out > 0.5 && s.turnIn <= 0) { h.phase = "back"; store(KEY.cfg, cfg); prepAlert(); }
    return s;
  }
  // Driving time for a distance at the prep's pace, e.g. "~14 min"; nothing until the car has moved.
  function eta(mi) {
    if (!(app.pace > 5) || !(mi > 0)) return "";
    const m = Math.max(1, Math.round((mi / app.pace) * 60));
    return `~${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`}`;
  }
  const dot = s => (s ? ` · ${s}` : "");
  async function healthStop() {
    if (app.burnBusy) { burnMsg("Wait for the climate commands to finish, then tap Stop again.", "bad"); return; }
    const b = cfg.health && cfg.health.burn;
    cfg.health = null; store(KEY.cfg, cfg); app.forceSlow = true;
    await burnOff(b);
  }
  function renderHealth(s) {
    const h = cfg.health, box = $("hRows"), on = healthOn();
    $("hStart").textContent = !h ? "Start from home" : h.phase === "done" ? "Done" : "Stop";
    $("hStart").classList.toggle("primary", !h);
    ["burnFull", "burnDefrost", "burnCamp"].forEach(id => ($(id).disabled = !on || !!app.burnBusy || app.source === "demo"));   // Demo never commands the real car
    $("burnOff").disabled = !(h && h.burn && h.burn.did.length) || !!app.burnBusy;
    if (!s) { box.innerHTML = `<p class="note">${app.source ? "Waiting for the charge level and the full-pack reading…" : "Needs the charge level: connect the adapter or start Tessie."}</p>`; return; }
    const p = app.pEma, using = p > 0.3 ? `<div><span>Using now</span><span>${fx(p, 1)} kW · about ${Math.round(p / s.k)}% an hour</span></div>` : "";
    if (!h) {
      box.innerHTML = s.raw <= s.target ? `<div><span>Now at ${Math.round(s.raw)}%</span><span>already at ${s.target}% or below</span></div>` : `
        <div><span>Now at ${Math.round(s.raw)}%</span><span>${Math.round(s.raw - s.target)}% to use · ${s.above.toFixed(1)} kWh</span></div>
        <div><span>Round trip</span><span>~${Math.round(U.dist(s.left))} ${U.d} at ${Math.round(U.wh(s.wh))} ${U.e}</span></div>
        <div><span>Drive out</span><span class="planbig">~${Math.round(U.dist(s.left / 2))} ${U.d}</span></div>
        <p class="note" style="margin:6px 0 0">Then turn around and head home. Based on ${s.basis}; after ${U.metric ? "3 km" : "2 mi"} it uses this drive's own ${U.e}, so climate on full or a faster road brings the turn-around point closer.</p>`;
      return;
    }
    const head = h.phase === "done" ? `<div><span>Ready</span><span class="planbig" data-tone="good">At ${h.target}%</span></div>`
      : h.phase === "back" ? `<div><span>Heading home</span><span class="planbig">${fx(U.dist(s.left), 1)} ${U.d} to ${h.target}%</span></div>`
      : `<div><span>Turn around in</span><span class="planbig">${s.turnIn <= 0.2 ? "now" : `${fx(U.dist(s.turnIn), 1)} ${U.d}`}</span></div>`;
    const time = h.phase === "back" ? eta(s.left) : h.phase === "out" && s.turnIn > 0.2 ? eta(s.turnIn) : "";
    box.innerHTML = `${head}
      ${time ? `<div><span>Time at this pace</span><span>${time}</span></div>` : ""}
      <div><span>Now at</span><span>${fx(s.raw, 1)}% → ${h.target}% · ${s.above.toFixed(1)} kWh to use</span></div>
      <div><span>Driven since start</span><span>${fx(U.dist(s.out), 1)} ${U.d} at ${Math.round(U.wh(s.wh))} ${U.e}${s.basis === "this drive" ? "" : " (planned)"}</span></div>
      ${h.phase === "done" ? "" : using}
      ${h.phase === "done" ? `<p class="note" style="margin:6px 0 0">The charge is down to ${h.target}%: ready for the battery health test.</p>` : ""}`;
  }

  // Tessie commands. One the car refuses comes back { result: false, reason }.
  async function tessieCar() {
    if (app.vin) return app.vin;
    if (!app.cmdVin) {
      const list = (await within(tget("vehicles?only_active=true"), 45000)).results || [];
      const v = list.find(x => x.vin === cfg.tessieVin) || list[0];
      if (!v) throw new Error("no vehicles on this Tessie account");
      app.cmdVin = v.vin;
    }
    return app.cmdVin;
  }
  // Tessie waits for the car to wake before it answers; give up after 45 s rather than leave the buttons stuck.
  // The last 20 commands and replies go into Copy diagnostics.
  async function tcmd(name, q) {
    const line = `${name}${q ? `?${q}` : ""}`;
    const log = msg => { (app.cmdLog ||= []).push(`${new Date().toLocaleTimeString()}  ${line}  ${msg}`); if (app.cmdLog.length > 20) app.cmdLog.shift(); };
    try {
      const r = await within(fetch(`https://api.tessie.com/${await tessieCar()}/command/${line}`, { method: "POST", headers: { Authorization: `Bearer ${tessieToken()}` } }), 45000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.result !== true) throw new Error(j.reason || j.error || (r.ok ? "the car didn't accept it" : `HTTP ${r.status}`));
      log("ok");
    } catch (e) { log(`failed: ${e.message}`); throw e; }
  }
  const burnMsg = (text, tone) => { $("burnMsg").textContent = text; $("burnMsg").dataset.tone = tone || ""; };
  // full: climate flat out (AC at LO when it's warm out; HI plus seat and wheel heaters when it's cold).
  // defrost: heater and AC together with the fan maxed. camp: keeps climate running with the car parked.
  async function burn(kind) {
    const h = cfg.health; if (!h || app.burnBusy || app.source === "demo") return;
    if (!tessieToken()) { showTab("setup"); $("cfgTok").focus(); notice("Paste your Tessie API token in Setup so the app can switch climate on.", "warn"); return; }
    const b = (h.burn ||= { did: [] });
    let step = "Reading climate";
    const run = async (label, name, q, undo) => { step = label; burnMsg(`${label}…`); await tcmd(name, q); if (!b.did.includes(undo)) { b.did.push(undo); store(KEY.cfg, cfg); } };
    app.burnBusy = true; app.forceSlow = true;
    try {
      if (!("prevC" in b)) {                                // what to put back afterwards
        const cl = (await within(tget(`${await tessieCar()}/state?use_cache=true`), 45000)).climate_state || {};
        b.prevC = cl.driver_temp_setting ?? null; b.wasOn = !!cl.is_climate_on; b.cold = (cl.outside_temp ?? L.outsideC ?? 20) < 15;
        store(KEY.cfg, cfg);
      }
      await run("Climate on", "start_climate", "", "climate");
      if (kind === "full") {
        await run(`Cabin to ${b.cold ? "HI" : "LO"}`, "set_temperatures", `temperature=${b.cold ? 28 : 15}`, "temp");
        if (b.cold) {
          await run("Driver seat heater", "set_seat_heat", "seat=front_left&level=3", "seats");
          await run("Passenger seat heater", "set_seat_heat", "seat=front_right&level=3", "seats");
          await run("Steering wheel heater", "start_steering_wheel_heater", "", "wheel");
        }
      }
      if (kind === "defrost") await run("Max defrost", "start_max_defrost", "", "defrost");
      if (kind === "camp") await run("Camp mode", "set_climate_keeper_mode", "mode=3", "camp");
      burnMsg(kind === "camp" ? "Camp mode on: climate keeps running with the car parked. Keep this page open so it can switch everything off at the target."
        : kind === "defrost" ? "Max defrost on." : `Climate on full${b.cold ? ": HI, seat and wheel heaters" : ": AC at LO"}.`, "good");
    } catch (e) { burnMsg(`${step} didn't work: ${e.message}.`, "bad"); }
    finally { app.burnBusy = false; app.forceSlow = true; }
  }
  // Undo only what the app switched on, climate last, and put the cabin temperature back.
  async function burnOff(b = cfg.health && cfg.health.burn) {
    if (!b || !b.did.length || app.burnBusy) return;
    const UNDO = [["camp", "Camp mode off", "set_climate_keeper_mode", "mode=0"], ["defrost", "Max defrost off", "stop_max_defrost", ""],
      ["wheel", "Steering wheel heater off", "stop_steering_wheel_heater", ""], ["seats", "Driver seat heater off", "set_seat_heat", "seat=front_left&level=0"],
      ["seats", "Passenger seat heater off", "set_seat_heat", "seat=front_right&level=0"], ["temp", "Cabin temperature back", "set_temperatures", `temperature=${b.prevC}`],
      ["climate", "Climate off", "stop_climate", ""]];
    app.burnBusy = true; app.forceSlow = true; const failed = [];
    for (const [k, label, name, q] of UNDO) {
      if (!b.did.includes(k) || (k === "temp" && b.prevC == null) || (k === "climate" && b.wasOn)) continue;
      try { burnMsg(`${label}…`); await tcmd(name, q); } catch (e) { failed.push(`${label} (${e.message})`); }
    }
    if (!failed.length) b.did = [];
    store(KEY.cfg, cfg); app.burnBusy = false; app.forceSlow = true;
    burnMsg(failed.length ? `Couldn't undo: ${failed.join(", ")}. Check the car's climate screen.` : "Everything the app switched on is off again.", failed.length ? "bad" : "good");
  }
  $("hTarget").value = String(cfg.health ? cfg.health.target : cfg.healthTarget || 20);
  $("hTarget").addEventListener("change", e => {
    cfg.healthTarget = +e.target.value;
    if (cfg.health) { cfg.health.target = cfg.healthTarget; cfg.health.phase = "out"; }
    store(KEY.cfg, cfg); app.forceSlow = true; render(true);
  });
  $("hStart").addEventListener("click", () => {
    unlockAudio();                                          // a tap: the prep's alerts may make sound
    if (cfg.health) healthStop();
    else { cfg.health = { target: cfg.healthTarget || 20, at: Date.now(), odo0: L.odoMi ?? null, e0: L.energyRemainingKWh ?? null, phase: "out", demo: app.source === "demo" }; store(KEY.cfg, cfg); burnMsg(""); }
    app.forceSlow = true; render(true);
  });
  $("burnFull").addEventListener("click", () => burn("full"));
  $("burnDefrost").addEventListener("click", () => burn("defrost"));
  $("burnCamp").addEventListener("click", () => burn("camp"));
  $("burnOff").addEventListener("click", () => burnOff());
  /* ---------------- tabs ----------------
     Cockpit / Trip / Battery / Health / Setup; the last one is remembered. Drive view always shows the cockpit. */
  const TABS = ["cockpit", "trip", "battery", "health", "setup"];
  function showTab(name) {
    if (!TABS.includes(name)) name = "cockpit";
    if (cfg.tab !== name) { cfg.tab = name; store(KEY.cfg, cfg); }
    for (const n of TABS) {
      $(`view-${n}`).hidden = n !== name;
      $(`tab-${n}`).setAttribute("aria-selected", String(n === name)); $(`tab-${n}`).tabIndex = n === name ? 0 : -1;
    }
    lastChart = 0; app.forceSlow = true;                    // the chart was sized while hidden: redraw it now
  }
  TABS.forEach((n, i) => {
    $(`tab-${n}`).addEventListener("click", () => { showTab(n); window.scrollTo?.(0, 0); });
    $(`tab-${n}`).addEventListener("keydown", e => {        // arrow keys move between tabs
      const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!k) return;
      const next = TABS[(i + k + TABS.length) % TABS.length]; showTab(next); $(`tab-${next}`).focus();
    });
  });
  showTab(cfg.tab);
  function setDrive(on) { cfg.drive = on; store(KEY.cfg, cfg); document.body.classList.toggle("drive", on); $("driveBtn").setAttribute("aria-pressed", String(on)); if (on) showTab("cockpit"); syncAwake(); }
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
    const tg = app.tgt, mph = L.speedMph ?? 0, target = tg && tg.whTarget ? Math.round(U.wh(tg.whTarget)) : null;
    const max = Math.max(U.metric ? 300 : 500, Math.ceil(((target || U.wh(300)) * 1.9) / 100) * 100);
    if (!G.built || G.max !== max || G.target !== target) buildGauge(max, target);
    const moving = live && mph > 3 && app.pEma != null;
    // Ratio of separately smoothed power and speed: avoids huge spikes at low speed (30 kW at 3 mph ≠ 10,000 Wh/mi).
    if (moving) {
      const k = 0.18; kwE = kwE == null ? app.pEma : kwE + (app.pEma - kwE) * k; mphE = mphE == null ? mph : mphE + (mph - mphE) * k;
      whSmooth = mphE > 8 ? Math.max(-999, Math.min(1500, (kwE * 1000) / mphE)) : null;
    } else { whSmooth = null; kwE = null; mphE = null; }
    const v = U.wh(whSmooth), el = $("inst"), st = $("effState");
    const tone = v == null || !target ? "" : v <= target ? "good" : v <= target * 1.35 ? "warn" : "bad";
    const val = $("gVal");
    val.setAttribute("stroke-dasharray", `${v != null && v > 0 ? ((Math.min(G.max, v) / G.max) * ARC_LEN).toFixed(1) : 0} ${ARC_LEN}`);
    val.setAttribute("stroke", tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "var(--regen)");
    if (!live) { el.textContent = "—"; el.dataset.tone = ""; $("instSub").textContent = `${U.e} now`; st.textContent = app.source ? "Waiting for the car" : "Connect the car"; st.dataset.tone = ""; }
    else if (!moving) {
      const kw = app.pEma ?? 0;
      const charging = kw < -0.3 && L.gear !== "D" && L.gear !== "R";
      el.textContent = charging ? "Charging" : L.gear === "D" || L.gear === "R" ? "Stopped" : "Parked"; el.dataset.tone = "";
      $("instSub").textContent = `${Math.abs(kw) < 10 ? Math.abs(kw).toFixed(1) : Math.round(Math.abs(kw))} kW ${kw < -0.3 ? (charging ? "in" : "regen") : "draw"}`;
      st.textContent = "Not moving"; st.dataset.tone = "";
    } else if (v < 0) { el.textContent = "Regen"; el.dataset.tone = "good"; $("instSub").textContent = `recovering ${Math.round(-app.pEma)} kW`; st.textContent = "Recovering energy"; st.dataset.tone = "good"; }
    else {
      el.textContent = String(Math.round(v)); el.dataset.tone = tone; $("instSub").textContent = `${U.e} now · ${Math.round(U.speed(mph))} ${U.s}`;
      st.textContent = tone === "good" ? "Efficient" : tone === "warn" ? "A bit heavy" : tone === "bad" ? "Wasting range" : "Measuring";
      st.dataset.tone = tone;
    }
    if (healthOn() && st.dataset.tone) { st.textContent = "Health test prep"; st.dataset.tone = ""; }   // using energy is the point
    el.dataset.word = String(!/^\d+$/.test(el.textContent));          // "Regen", "Parked"… set smaller than a number
    $("effTarget").textContent = target ?`Target ${target} ${U.e}${tg.here ? " (your best at this speed)" : " (rated)"}${tripAvg > 0 ? ` · trip ${Math.round(U.wh(tripAvg))}` : ""}` : "";
  }

  // Mile by mile (or km by km): Wh/mi of each of the last 10 whole miles of this trip plus the one in progress, colored vs target.
  function cumAt(t, d) {                      // driving energy at trip distance d, interpolated
    const D = t.D, E = t.E; if (d <= 0) return 0;
    let lo = 0, hi = D.length - 1; if (d >= D[hi]) return E[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (D[m] <= d) lo = m; else hi = m; }
    const f = (d - D[lo]) / (D[hi] - D[lo] || 1); return E[lo] + f * (E[hi] - E[lo]);
  }
  function renderMiles(target) {
    const t = app.trip, box = $("mileBars"), u = U.toMi(1);   // one shown unit, in miles: bar k covers k·u to (k+1)·u
    target = U.wh(target);
    if (!t || t.D.length < 3 || t.D[t.D.length - 1] < 0.3) { box.innerHTML = `<span class="note">Each ${U.unit} shows up here as you drive.</span>`; $("mileNow").textContent = ""; return; }
    const end = U.dist(t.D[t.D.length - 1]), whole = Math.floor(end), first = Math.max(0, whole - 10), miles = [];
    for (let k = first; k < whole; k++) miles.push({ k, wh: (cumAt(t, (k + 1) * u) - cumAt(t, k * u)) * 1000 });
    const part = end - whole; if (part >= 0.2) miles.push({ k: whole, wh: ((cumAt(t, end * u) - cumAt(t, whole * u)) * 1000) / part, partial: true });
    const max = Math.max(target ? target * 1.6 : U.wh(400), ...miles.map(m => m.wh));
    box.innerHTML = miles.map(m => {
      const tone = !target ? "" : m.wh <= target ? "good" : m.wh <= target * 1.35 ? "warn" : "bad";
      return `<span class="mb${m.partial ? " partial" : ""}" data-tone="${tone}" title="${U.Unit} ${m.k + 1}: ${Math.round(m.wh)} ${U.e}"><i style="height:${Math.max(6, (Math.max(0, m.wh) / max) * 100)}%"></i><b>${Math.round(m.wh)}</b></span>`;
    }).join("") + (target ? `<span class="mtarget" style="bottom:calc(16px + (100% - 16px) * ${(target / max).toFixed(3)})"></span>` : "");
    const last = miles.filter(m => !m.partial).slice(-1)[0];
    $("mileNow").textContent = last ? `last full ${U.unit} ${Math.round(last.wh)} ${U.e}` : "";
  }

  // Efficiency score, 0–100 for this trip: 70% consumption vs rated (100 at ≤85% of rated Wh/mi, 0 at ≥150%),
  // 30% share of pedal time in the 15–40% range. Shown once the trip has half a mile.
  function renderScore(tripMi, tripAvg) {
    const rated = ratedWh(), el = $("effScore");
    if (!(tripMi > 0.5) || !(tripAvg > 0) || !rated) { el.innerHTML = "—"; el.dataset.tone = ""; $("effScoreSub").textContent = `drive ${U.metric ? "1 km" : "half a mile"} to score`; return; }
    const r = tripAvg / rated, pedal = app.coach.score(), sc = Drives.score(tripAvg, rated, pedal);   // same formula as drive summaries
    el.innerHTML = `${sc}<small>/100</small>`; el.dataset.tone = sc >= 80 ? "good" : sc >= 60 ? "warn" : "bad";
    $("effScoreSub").textContent = `${r <= 1 ? Math.round((1 - r) * 100) + "% under" : Math.round((r - 1) * 100) + "% over"} rated ${U.e}${pedal != null ? ` · pedal ${pedal}% in range` : ""}`;
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
    // Every frame only while it can move: on the Cockpit with a source (or still settling to zero); otherwise twice a second.
    if (cfg.tab === "cockpit" && (app.source || Math.abs(flow.v) > 0.01)) requestAnimationFrame(flowFrame);
    else { setTimeout(() => requestAnimationFrame(flowFrame), 500); if (cfg.tab !== "cockpit") return; }
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
    // The car's regen limit (lower when the pack is cold or nearly full), when it's inside the bar's scale.
    const lim = L.maxRegenKW > 1 && L.maxRegenKW < dn ? Math.round(L.maxRegenKW) : null, fl = $("fLimit");
    fl.hidden = lim == null; if (lim != null) fl.style.left = `${fPos(-lim, up, dn)}%`;
    const rl = lim == null ? "◀ Regen" : `◀ Regen · max ${lim} kW`; if ($("fRegenLbl").textContent !== rl) $("fRegenLbl").textContent = rl;
    const useTone = !moving ? "" : v <= tg.upKW ? "ok" : v <= tg.upKW * 1.8 ? "" : "way", hard = moving && -v > tg.regenGentle;
    $("fUse").dataset.tone = useTone; $("fRegen").dataset.tone = hard ? "hard" : "";
    const kw = `${Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : Math.round(Math.abs(v))} kW`;
    $("flowState").textContent = !live || L.powerKW == null ? "—"
      : v < -0.5 ? (hard ? `${kw} regen · strong, lift earlier` : `${kw} regen`)
      : !moving ? `${kw} ${v > 0.3 ? "draw" : ""}`.trim()
      : useTone === "ok" ? `${kw} · efficient` : useTone === "way" ? `${kw} · hard acceleration` : `${kw} · above efficient`;
  }
  document.documentElement.style.setProperty("--z", `${FZ}%`);
  requestAnimationFrame(flowFrame);

  /* ---------------- eyes-free alerts ----------------
     Off by default. A short buzz and/or tone when a costly habit starts, so you don't have to look:
     one low tone = ease off the pedal; two high tones = lift earlier (brake or regen at its limit); long low = pack warning;
     three rising = health test prep: turn around, or the target is reached.
     Each kind fires at most once per 15 s, never while cruise/Autopilot is marked on. */
  const ALERT_KIND = { "pedal.heavy": "ease", "pedal.sharpLift": "ease", "brake.friction": "brake", "pedal.regenAtLimit": "brake", "pack.coldDraw": "warn", "soc.lowDraw": "warn", "pack.hot": "warn" };
  const PATTERN = { ease: { vib: [90], tones: [[392, 0.16]] }, brake: { vib: [60, 70, 60], tones: [[784, 0.1], [784, 0.1]] }, warn: { vib: [250], tones: [[262, 0.45]] },
    turn: { vib: [150, 80, 150, 80, 300], tones: [[523, 0.14], [659, 0.14], [784, 0.3]] } };
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
      if (type && !(healthOn() && type !== "warn") && !prevKinds.has(k) && !(now - (lastAlert[k] || 0) < 15000)) { lastAlert[k] = now; fireAlert(type); }
    }
    prevKinds = kinds;
  }
  // Health test prep: turn around and target reached always alert (both ways when alerts are off), so the moment isn't missed.
  const alertsOff = () => !cfg.alerts || cfg.alerts === "off", prepAlert = () => fireAlert("turn", alertsOff());
  document.addEventListener("pointerdown", () => { if (!alertsOff() || cfg.health) unlockAudio(); }, { once: true });

  /* ---------------- drive summaries + history ---------------- */
  const fmtWhen = t => new Date(t).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const signed = (v, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
  function showSummary(d) {
    const tone = d.score == null ? "" : d.score >= 80 ? "good" : d.score >= 60 ? "warn" : "bad";
    const hb = Drives.habit(d);                           // rebuilt, not the saved text: it follows the units setting
    const cell = (label, v, sub) => `<div class="scell"><div class="label">${label}</div><div class="sv">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
    $("sumBody").innerHTML = `
      <div class="shead"><div><h3>Drive summary${d.demo ? " · demo" : ""}</h3><div class="sub">${fmtWhen(d.t0)} · ${U.dist(d.mi).toFixed(1)} ${U.d}${d.avgMph ? ` · avg ${Math.round(U.speed(d.avgMph))} ${U.s}` : ""}</div></div>
        <div class="sscore" data-tone="${tone}"><span>${d.score ?? "—"}</span><small>score</small></div></div>
      <div class="sgrid">
        ${cell(U.e, Math.round(U.wh(d.wh)), d.rated ? `rated ${Math.round(U.wh(d.rated))}` : "")}
        ${cell("vs rated", d.vsRatedPct == null ? "—" : `${d.vsRatedPct > 0 ? "+" : ""}${d.vsRatedPct}%`, d.vsRatedPct == null ? "" : d.vsRatedPct <= 0 ? "used less" : "used more")}
        ${cell("Range vs rated", d.rangeDeltaMi == null ? "—" : `${signed(U.dist(d.rangeDeltaMi))} ${U.d}`, "on this drive")}
        ${cell("Energy", `${d.kwh.toFixed(2)} kWh`, `${d.regenKWh.toFixed(2)} kWh back from regen`)}
        ${cell("Pedal in range", d.pedalPct == null ? "—" : `${d.pedalPct}%`, `${d.heavy} heavy · ${d.friction} brake-heavy stops`)}
        ${cell("Slowdown capture", d.capturePct == null ? "—" : `${d.capturePct}%`, d.stops ? `${d.stops} slowdowns · 60%+ is great` : "")}
        ${cell("Speeding up", d.accelKWh != null && d.accelKWh + d.cruiseKWh > 0 ? `${Math.round((d.accelKWh / (d.accelKWh + d.cruiseKWh)) * 100)}%` : "—", "of driving energy")}
        ${cell("Climate", d.climateKWh == null ? "—" : `${d.climateKWh.toFixed(2)} kWh`, d.climateKWh != null && d.kwh > 0 ? `${Math.round((d.climateKWh / d.kwh) * 100)}% of energy` : "")}
      </div>
      <div class="shabit" data-tone="${hb.tone}"><div class="label">${hb.tone === "good" ? "Nice" : "Work on this next"}</div><p>${hb.text}</p></div>
      ${compareLine(d)}`;
    $("sumDelete").hidden = d.demo || !drives.history.some(x => x.id === d.id);
    $("sumDelete").dataset.id = d.id; $("sumDelete").textContent = "Delete drive";
    if (!$("summary").open) $("summary").showModal();    // modal <dialog>: keeps focus inside, Esc closes, focus returns on close
    $("sumDone").focus();
  }
  function closeSummary() { if ($("summary").open) $("summary").close(); }
  // How this drive compares with your typical one (median of the other saved drives).
  function compareLine(d) {
    const others = drives.history.filter(x => x.id !== d.id && x.wh > 0);
    if (others.length < 3) return "";
    const med = others.map(x => x.wh).sort((a, b) => a - b)[Math.floor(others.length / 2)];
    const pct = Math.round((d.wh / med - 1) * 100);
    return `<p class="note" style="margin-top:10px">${pct === 0 ? "Same as" : pct < 0 ? `${-pct}% more efficient than` : `${pct}% less efficient than`} your typical drive (${Math.round(U.wh(med))} ${U.e}).</p>`;
  }
  $("sumDone").addEventListener("click", closeSummary);
  $("sumDelete").addEventListener("click", e => {
    const b = e.currentTarget;
    if (b.textContent !== "Tap again to delete") { b.textContent = "Tap again to delete"; return; }
    drives.remove(b.dataset.id); closeSummary(); renderDrives();
  });
  $("summary").addEventListener("click", e => { if (e.target.id === "summary") closeSummary(); });
  function renderDrives() {
    const h = drives.history, box = $("driveList");
    $("endDrive").hidden = !drives.active;
    if (!h.length) { $("driveTrend").innerHTML = ""; box.innerHTML = `<p class="note">Each drive gets a summary and a score when you park (20 s in P). They're kept on this phone.</p>`; return; }
    renderTrend(h);
    box.innerHTML = (app.allDrives ? h : h.slice(0, 8)).map(d => `<button class="drow" type="button" data-id="${d.id}">
      <span class="dwhen">${fmtWhen(d.t0)}</span><span class="num">${U.dist(d.mi).toFixed(1)} ${U.d}</span><span class="num">${Math.round(U.wh(d.wh))} ${U.e}</span>
      <span class="dscore" data-tone="${d.score >= 80 ? "good" : d.score >= 60 ? "warn" : "bad"}">${d.score ?? "—"}</span></button>`).join("")
      + (h.length > 8 ? `<button class="btn sm" id="driveMore" type="button">${app.allDrives ? "Show fewer" : `Show all ${h.length}`}</button>` : "");
    box.querySelectorAll(".drow").forEach(b => b.addEventListener("click", () => { const d = drives.history.find(x => x.id === b.dataset.id); if (d) showSummary(d); }));
    if (h.length > 8) $("driveMore").addEventListener("click", () => { app.allDrives = !app.allDrives; renderDrives(); });
  }
  // Trend: last 12 scores as bars (oldest left), recent-vs-previous averages, best, and range saved vs rated.
  function renderTrend(h) {
    const avg = (a, f) => { const v = a.map(f).filter(x => x != null && isFinite(x)); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; };
    const recent = h.slice(0, 7), prev = h.slice(7, 14);
    const sNow = avg(recent, d => d.score), sPrev = avg(prev, d => d.score);
    const whNow = whOf(recent), whPrev = whOf(prev);
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
        <div><div class="label">Avg ${U.e}, last ${recent.length}</div><div class="tv">${whNow == null ? "—" : Math.round(U.wh(whNow))}</div><div class="sub">${arrow(whNow, whPrev, true).replace(/^ · /, "")}</div></div>
        <div><div class="label">Best score</div><div class="tv">${best ? best.score : "—"}</div><div class="sub">${best ? fmtWhen(best.t0) : ""}</div></div>
        <div><div class="label">Range vs rated</div><div class="tv" data-tone="${saved >= 0 ? "good" : "bad"}">${signed(U.dist(saved))} ${U.d}</div><div class="sub">last ${Math.min(30, h.length)} drives combined</div></div>
      </div>${svg}`;
  }

  $("endDrive").addEventListener("click", () => {
    if (!app.trip) return;
    const st = app.coach.state, sw = app.coach.table(L.outsideC).sweet;
    const d = drives.finish({ odo: L.odoMi ?? app.synthOdo, drive: app.trip.drive, park: app.trip.park, regen: app.trip.regen, climateKWh: L.compressorKW != null ? app.climateKWh : null,
      accelKWh: app.trip.eb ? app.trip.eb.accel : 0, cruiseKWh: app.trip.eb ? app.trip.eb.cruise : 0,
      stopKinetic: stops.state.kinetic, stopRegen: stops.state.regen, stopCount: stops.state.n,
      heavy: st.heavyEvents, friction: st.frictionEvents, pressedSec: st.pressedSec, rightSec: st.rightSec, rated: ratedWh(), sweetBand: sw ? sw.mph : null, outsideC: L.outsideC, demo: app.source === "demo" }, Date.now());
    if (d) showSummary(d); else notice(`That drive was under ${U.metric ? "0.5 km" : "0.3 mi"}, so there's nothing to summarize.`, "info");
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
    if (tessieToken()) lines.push(`Tessie: car …${String(app.vin || app.cmdVin || "not looked up").slice(-6)} · ${app.carState || "state unknown"} · last reading ${app.tessieAt ? age(Date.now() - app.tessieAt) : "none"} · last error ${app.tessieErr || "none"}`);
    if (cfg.health) lines.push(`Health test prep: ${JSON.stringify(cfg.health)}`);
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
    lines.push("", "Tessie commands:", ...(app.cmdLog && app.cmdLog.length ? app.cmdLog : ["—"]));
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
    const row = r.map(v => (v == null ? "" : typeof v === "number" ? +v.toFixed(4) : v)).join(",");
    app.rec.rows.push(row); app.rec.pending.push([++app.rec.n, row]);
    app.rec.last = now;
    if (app.rec.rows.length > MAX_ROWS + 1) app.rec.rows.splice(1, 1);
    if (app.rec.pending.length >= 10) flushRec();
  }
  function toggleRec() {
    if (app.rec) { flushRec(); app.lastCsv = app.rec.rows.join("\n"); app.rec = null; store(KEY.csv, { state: "stopped" }); }
    else {
      app.rec = { rows: [COLS.join(",")], last: 0, started: new Date(), n: 0, pending: [] }; app.lastCsv = null;
      store(KEY.csv, { state: "recording" }); csvStore("readwrite", s => s.clear());
    }
    render(true);
  }
  // Rows also go to IndexedDB (10 at a time, and whenever the page is hidden), so a reload or a discarded background
  // tab doesn't lose the recording. The last one stays downloadable until the next recording starts.
  const MAX_ROWS = 36000;                                   // 10 h at one row a second
  let csvDb = null;
  function csvStore(mode, fn) {
    if (!window.indexedDB) return Promise.resolve(null);
    csvDb ||= new Promise((res, rej) => { const r = indexedDB.open("drive-energy", 1); r.onupgradeneeded = () => r.result.createObjectStore("csv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return csvDb.then(db => new Promise((res, rej) => {
      const tx = db.transaction("csv", mode), req = fn(tx.objectStore("csv"));
      tx.oncomplete = () => res(req ? req.result : null); tx.onerror = tx.onabort = () => rej(tx.error);
    })).catch(() => null);
  }
  function flushRec() {
    const r = app.rec; if (!r || !r.pending.length) return;
    const rows = r.pending; r.pending = [];
    csvStore("readwrite", s => { for (const [k, v] of rows) s.put(v, k); const old = rows[rows.length - 1][0] - MAX_ROWS; if (old > 0) s.delete(IDBKeyRange.upperBound(old)); });
  }
  // Leaving the page (app switch, tab closed, Android reclaiming it): save now, not at the next 10 s / 15 s mark.
  document.addEventListener("visibilitychange", () => { if (document.hidden) { flushRec(); saveTrip(); store(KEY.speed, realCoach.state.buckets); } });
  if (load(KEY.csv, null)) csvStore("readonly", s => s.getAll()).then(rows => {
    if (!rows || !rows.length || app.rec) return;
    app.lastCsv = [COLS.join(","), ...rows].join("\n");
    if (load(KEY.csv, {}).state === "recording") { store(KEY.csv, { state: "stopped" }); notice(`Recovered an unfinished CSV recording (${rows.length} rows). Tap Download CSV to save it.`, "info"); }
  });
  function saveFile(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function download() {
    const text = app.rec ? app.rec.rows.join("\n") : app.lastCsv; if (!text) return;
    saveFile(`drive-energy-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}${app.source === "demo" ? "-DEMO" : ""}.csv`, text, "text/csv");
  }

  /* ---------------- backup ----------------
     Drives, the speed table and trips live only in this browser's storage. Ask Chrome to keep it (otherwise it may clear
     it when space runs low), and let it be saved to a file and restored. The Tessie token is never exported. */
  navigator.storage?.persist?.().catch(() => {});
  // Settings go along too, but not per-outing state (range goal, health test prep, current tab). The file is untrusted,
  // so each setting is checked before it's used.
  const SETTINGS = {
    win: v => [5, 15, 30].includes(v), brick: v => Number.isInteger(v) && v >= 0 && v <= 108, oneBased: v => typeof v === "boolean",
    keepAwake: v => typeof v === "boolean", autoConnect: v => typeof v === "boolean", alerts: v => ["off", "vibrate", "sound", "both"].includes(v),
    healthTarget: v => [10, 15, 20, 25, 30].includes(v), units: v => ["mi", "km"].includes(v),
    plan: v => !!v && typeof v.mi === "number" && v.mi > 0.5 && v.mi <= 400 && [10, 15, 20, 30].includes(v.res),     // miles, from km too
  };
  $("exportBtn").addEventListener("click", () => {
    saveTrip();
    const data = { app: "drive-energy", version: 1, exported: new Date().toISOString(),
      drives: load(KEY.drives, []), speed: load(KEY.speed, {}), trip: load(KEY.trip, null), tessieTrip: load(KEY.tripT, null),
      settings: Object.fromEntries(Object.keys(SETTINGS).filter(k => cfg[k] != null).map(k => [k, cfg[k]])) };
    saveFile(`drive-energy-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), "application/json");
  });
  confirmTap($("importBtn"), "Tap again: replaces this phone's drives", () => $("importFile").click());
  const finite = v => typeof v === "number" && isFinite(v);
  function cleanTrip(t) {
    const NUM = ["t0", "odo0", "lastOdo", "lastNet", "lastIn", "drive", "park", "regen", "charged"], EBK = ["cruise", "accel", "climate", "parked", "regen"];
    if (!t || typeof t !== "object" || !/^[cs][oi]$/.test(t.src) || !NUM.every(k => finite(t[k]))) return null;
    if (!Array.isArray(t.D) || !Array.isArray(t.E) || !t.D.length || t.D.length !== t.E.length || !t.D.every(finite) || !t.E.every(finite)) return null;
    const out = { src: t.src, D: t.D.slice(-1400), E: t.E.slice(-1400) };
    for (const k of NUM) out[k] = t[k];
    if (t.eb && EBK.every(k => finite(t.eb[k]))) out.eb = Object.fromEntries(EBK.map(k => [k, t.eb[k]]));
    return out;
  }
  $("importFile").addEventListener("change", async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    let o = null;
    try { o = JSON.parse(await f.text()); } catch (err) {}
    if (!o || o.app !== "drive-energy") { notice("That file isn't a Drive Energy backup.", "bad"); return; }
    // The file is untrusted: keep only well-formed numbers. Drives are rebuilt, so their text is regenerated here.
    const list = Array.isArray(o.drives) ? o.drives.map(d => Drives.clean(d)).filter(Boolean).slice(0, Drives.KEEP) : [], speed = {};
    for (const [k, v] of Object.entries(o.speed && typeof o.speed === "object" ? o.speed : {}))
      if (/^\d{1,3}(\|(x|<40|40-59|60-79|80\+))?$/.test(k) && v && finite(v.kwh) && finite(v.mi) && v.mi >= 0) speed[k] = { kwh: v.kwh, mi: v.mi };
    if (app.source) await disconnect();                     // so nothing running saves over the import before the reload
    store(KEY.drives, list); store(KEY.speed, speed); store(KEY.trip, cleanTrip(o.trip)); store(KEY.tripT, cleanTrip(o.tessieTrip));
    const set = o.settings && typeof o.settings === "object" ? o.settings : {};
    for (const [k, ok] of Object.entries(SETTINGS)) if (ok(set[k])) cfg[k] = k === "plan" ? { mi: set.plan.mi, res: set.plan.res } : set[k];
    const lo = cfg.oneBased ? 1 : 0; cfg.brick = Math.min(lo + 107, Math.max(lo, cfg.brick));     // inside the numbering's range
    store(KEY.cfg, cfg);
    location.reload();
  });

  /* ---------------- screen wake ----------------
     Screen stays on while a source is running or Drive view is on (if the setting allows). Checked every tick, so it
     comes back after a tab switch; one lock at a time, so turning either off really releases it. */
  async function syncAwake() {
    const want = () => cfg.keepAwake && (!!app.source || cfg.drive);
    if (!want()) { releaseAwake(); return; }
    if (!("wakeLock" in navigator) || document.hidden || app.waking || (app.wake && !app.wake.released) || performance.now() < (app.wakeRetryAt || 0)) return;
    app.waking = true;
    try { app.wake = await navigator.wakeLock.request("screen"); if (!want()) releaseAwake(); }
    catch (e) { app.wakeRetryAt = performance.now() + 5000; }                 // e.g. battery saver: don't ask 4× a second
    finally { app.waking = false; }
  }
  function releaseAwake() { try { app.wake?.release().catch(() => {}); } catch (e) {} app.wake = null; }

  /* ---------------- controls ---------------- */
  // Wrapped: passing connectCar directly would hand it the click event as its "auto" argument (the v21 bug:
  // a tap was treated as a silent background attempt, so the adapter picker never opened).
  $("connectBtn").addEventListener("click", () => (inCar ? startTessie() : connectCar(false, false)));
  $("chooseBtn").addEventListener("click", () => connectCar(false, true));
  $("demoBtn").addEventListener("click", () => (app.source === "demo" ? disconnect() : startDemo()));
  $("disconnectBtn").addEventListener("click", disconnect);
  // Erasing links ask for a second tap within 4 s.
  function confirmTap(btn, armedText, action) {
    const label = btn.textContent; let timer = null;
    btn.addEventListener("click", () => {
      if (!timer) { btn.textContent = armedText; timer = setTimeout(() => { timer = null; btn.textContent = label; }, 4000); return; }
      clearTimeout(timer); timer = null; btn.textContent = label; action();
    });
  }
  confirmTap($("resetTrip"), "Tap again to reset the trip", () => { app.trip = null; drives.cancel(); stops.reset(); app.coach.resetTrip(); if (app.source !== "demo") store(tripKey(app.source === "tessie" ? "tessie" : "car"), null); render(false); });
  $("tessieBtn").addEventListener("click", () => (app.source === "tessie" ? disconnect() : startTessie()));
  $("cfgTok").value = tessieToken() ? "••••••••" : "";
  $("cfgTok").addEventListener("change", e => { const v = e.target.value.trim(); if (!v || /^•+$/.test(v)) return; try { localStorage.setItem(KEY.tok, v); } catch (err) {} forgetCar(); e.target.value = "••••••••"; notice("Tessie token saved on this device only.", "info"); });
  $("cfgTokClear").addEventListener("click", () => { try { localStorage.removeItem(KEY.tok); } catch (e) {} forgetCar(); $("cfgTok").value = ""; if (app.source === "tessie") disconnect(); });
  $("recBtn").addEventListener("click", toggleRec);
  confirmTap($("resetSpeed"), "Tap again to erase your speed table", () => { app.coach.resetBuckets(); app.forceSlow = true; render(false); });
  $("cruiseBtn").addEventListener("click", () => { app.coach.setCruise(!app.coach.state.cruiseOn); render(true); });
  $("dlBtn").addEventListener("click", download);
  document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => { cfg.win = +b.dataset.w; store(KEY.cfg, cfg); syncSeg(); lastChart = 0; }));
  function syncSeg() { document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.w === cfg.win))); }
  $("bricks").addEventListener("click", e => {                // tap a brick in the heatmap to watch it
    const t = e.target.closest && e.target.closest("[data-i]"); if (!t) return;
    cfg.brick = +t.dataset.i + (cfg.oneBased ? 1 : 0); store(KEY.cfg, cfg); $("cfgBrick").value = cfg.brick; app.forceSlow = true; render(!!app.source);
  });
  $("cfgBrick").value = cfg.brick; $("cfgBase").value = cfg.oneBased ? "1" : "0"; $("cfgAwake").checked = cfg.keepAwake;
  $("cfgBrick").addEventListener("change", e => { const n = Math.round(+e.target.value); const lo = cfg.oneBased ? 1 : 0; if (n >= lo && n <= lo + 107) { cfg.brick = n; store(KEY.cfg, cfg); } else e.target.value = cfg.brick; });
  // Keep the brick number inside the new numbering's range (108 isn't a brick in 0–107, 0 isn't one in 1–108).
  $("cfgBase").addEventListener("change", e => { cfg.oneBased = e.target.value === "1"; const lo = cfg.oneBased ? 1 : 0; cfg.brick = Math.min(lo + 107, Math.max(lo, cfg.brick)); $("cfgBrick").value = cfg.brick; store(KEY.cfg, cfg); });
  $("cfgAuto").checked = cfg.autoConnect !== false;
  $("cfgAuto").addEventListener("change", e => { cfg.autoConnect = e.target.checked; store(KEY.cfg, cfg); if (e.target.checked) autoTry(); });
  $("cfgAlerts").value = cfg.alerts || "off";
  $("cfgAlerts").addEventListener("change", e => { cfg.alerts = e.target.value; store(KEY.cfg, cfg); unlockAudio(); });
  $("alertTest").addEventListener("click", () => { unlockAudio(); fireAlert("ease", true); setTimeout(() => fireAlert("brake", true), 900); });
  $("cfgAwake").addEventListener("change", e => { cfg.keepAwake = e.target.checked; store(KEY.cfg, cfg); syncAwake(); });
  // Units change only what's shown (saved data stays in miles), so switching back and forth loses nothing.
  function applyUnits() {
    document.querySelectorAll("[data-u]").forEach(e => { e.textContent = U[e.dataset.u]; });
    $("planMi").value = String(Math.round(U.dist(cfg.plan.mi)));
    $("goalMi").placeholder = `${U.Units}, e.g. ${U.metric ? 70 : 45}`;
    $("legendAvg").textContent = `Rolling 1-${U.unit} average (${U.e})`;
    $("effGauge").setAttribute("aria-label", `Efficiency gauge: watt-hours per ${U.metric ? "kilometer" : "mile"} now against your target`);
  }
  $("cfgUnits").value = U.metric ? "km" : "mi";
  $("cfgUnits").addEventListener("change", e => { cfg.units = e.target.value; store(KEY.cfg, cfg); U.set(cfg.units); applyUnits(); renderDrives(); app.forceSlow = true; lastChart = 0; render(!!app.source); });
  applyUnits();
  window.addEventListener("resize", () => { lastChart = 0; });

  // frame rate counter + main loop
  let lastFrames = 0;
  setInterval(() => { app.fps = app.frames - lastFrames; lastFrames = app.frames; }, 1000);
  setInterval(tick, 250);
  syncSeg();
  status("off", "Not connected");
  // On the car's screen Connect car means Tessie, and it starts on its own (asking for the token in Setup if there's none).
  document.body.classList.toggle("car", inCar);
  if (inCar) { $("connectBtn").querySelector("use")?.setAttribute("href", "#i-cloud"); startTessie(); }
  else if (!window.ElmLink || !ElmLink.supported()) notice("Live car data needs Chrome 138+ on Android (or desktop Chrome) over https://. Demo works anywhere.", "info");
  // Service worker: check for a new version on every load and switch to it right away (one automatic reload).
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").then(r => r.update()).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded && !app.source) { reloaded = true; location.reload(); } });
  }
  render(false);
})();
