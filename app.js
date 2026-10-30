/* Drive Energy — screen logic. Data path: OBDLink MX+ → Web Serial (Bluetooth) → STN monitor lines
   → CanDecode → trip math → screen. Demo mode feeds the same path from CanSim. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const D = window.CanDecode;
  const LISTEN = Object.values(D.IDS);
  const KEY = { speed: "de.speed.v1", trip: "de.trip.v1", tripT: "de.trip.tessie.v1", cfg: "de.cfg.v1", tok: "de.tessie.v1" };
  const DEMO_SPEED = 8;
  const tripKey = src => (src === "tessie" ? KEY.tripT : KEY.trip);
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  const cfg = Object.assign({ win: 15, brick: 38, oneBased: true, keepAwake: true }, load(KEY.cfg, {}));
  let dec = D.createDecoder(), L = dec.state;
  const app = {
    source: null, link: null, port: null, sim: null, simTimer: null,
    frames: 0, fps: 0, lastFrameAt: 0, pEma: null, synthNet: 0, synthOdo: 0, lastTick: performance.now(),
    restartAt: 0, trip: load(KEY.trip, null), rec: null, wake: null, lastSave: 0,
    tessieTimer: null, vin: null, tessieBusy: false,
  };
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
    if (f) { dec.decode(f.id, f.bytes); app.frames++; app.lastFrameAt = performance.now(); return; }
    if (/BUFFER FULL|DATA ERROR|CAN ERROR|<RX ERROR/i.test(line) && app.link && performance.now() - app.restartAt > 2000) {
      app.restartAt = performance.now();
      app.link.restartMonitor().catch(() => {});
    }
  }

  /* ---------------- car connection ---------------- */
  async function connectCar() {
    if (!window.ElmLink || !ElmLink.supported()) {
      notice("This browser can't open Bluetooth serial ports. Use Chrome 138 or newer on Android, opened from an https:// address.", "bad");
      return;
    }
    stopDemo(); stopTessie();
    const link = new ElmLink({ onLine, onStatus: onLinkStatus });
    try {
      let port = app.port;
      if (!port) {
        const known = await navigator.serial.getPorts();
        port = known.length === 1 ? known[0] : await link.pick();
      }
      app.port = port; app.link = link; app.source = "car";
      status("connecting", "Connecting");
      notice(null);
      await link.open(port);
      await link.init(LISTEN);
      resetDecoder();
      await link.startMonitor();
      status("live", "Live");
      $("adapter").textContent = link.chip.replace(/\s+/g, " ");
      keepAwake();
    } catch (e) {
      const msg = e && e.name === "NotFoundError" ? "No adapter picked. Pair the OBDLink MX+ in Android Bluetooth settings first, then tap Connect car." : (e.message || String(e));
      notice(msg, "bad");
      await link.close().catch(() => {});
      app.link = null; app.source = null;
      if (e && e.name !== "NotFoundError") app.port = null;
      status("off", "Not connected");
    }
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
  function resetDecoder() { dec = D.createDecoder(); L = dec.state; app.pEma = null; app.synthNet = 0; app.synthOdo = 0; }

  /* ---------------- trip + consumption math ----------------
     Energy: lifetime counters on 0x3D2 (kWh out minus kWh in) — exact to 1 Wh, regen included.
     Distance: odometer on 0x3B6. Falls back to integrating power and speed if either is missing. */
  function tick() {
    const now = performance.now(), dt = Math.min(1, (now - app.lastTick) / 1000); app.lastTick = now;
    if (L.powerKW != null) app.pEma = app.pEma == null ? L.powerKW : app.pEma + (L.powerKW - app.pEma) * Math.min(1, dt / 0.6);
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
    if (live && (app.source === "car" || app.source === "demo")) app.coach.update(L, app.pEma, app.source === "demo" ? dt * DEMO_SPEED : dt, now);
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
    const maxR = L.maxRegenKW > 5 ? L.maxRegenKW : 60, maxD = L.maxDischargeKW > 20 ? L.maxDischargeKW : 200;
    const frac = p == null ? 0 : p >= 0 ? Math.min(1, p / maxD) : Math.max(-1, p / maxR);
    const bar = $("pbar");
    bar.style.left = frac >= 0 ? "50%" : `${50 + frac * 50}%`; bar.style.width = `${Math.abs(frac) * 50}%`;
    bar.dataset.dir = frac < 0 ? "regen" : "use";
    $("pmin").textContent = `−${Math.round(maxR)}`; $("pmax").textContent = `${Math.round(maxD)}`;
    // consumption
    const inst = p != null && mph > 3 ? (p * 1000) / mph : null;
    set("inst", fx(inst), "Wh/mi");
    $("instSub").textContent = mph != null ? `${fx(mph)} mph` : "—";
    const tripMi = t ? t.lastOdo - t.odo0 : 0, tripAvg = t && tripMi > 0.3 ? (t.drive * 1000) / tripMi : null;
    const wAvg = windowAvg(t, cfg.win);
    set("avg", fx(wAvg), "Wh/mi"); $("avgLabel").textContent = `Avg · last ${cfg.win} mi`;
    const rated = L.ratedWhPerMi > 100 ? L.ratedWhPerMi : null;
    $("avgSub").textContent = wAvg && rated ? `${Math.round((rated / wAvg) * 100)}% of rated (${rated} Wh/mi)` : rated ? `rated ${rated} Wh/mi` : "builds as you drive";
    const usable = L.energyRemainingKWh != null ? Math.max(0, L.energyRemainingKWh - (L.bufferKWh ?? 0)) : null;
    const basis = wAvg ?? tripAvg;
    set("proj", usable != null && basis > 50 ? fx((usable * 1000) / basis) : fx(L.ratedRangeMi), "mi");
    $("projSub").textContent = usable != null && basis > 50 ? `at ${Math.round(basis)} Wh/mi · rated ${fx(L.ratedRangeMi)} mi` : "rated range";
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
    // bricks
    renderBricks();
    renderCoach(live);
    // footer
    $("fps").textContent = app.source ? `${app.fps} frames/s` : "";
    $("recBtn").textContent = app.rec ? `Stop recording (${app.rec.rows.length - 1} rows)` : "Record CSV";
    $("dlBtn").hidden = !(app.rec && app.rec.rows.length > 1) && !app.lastCsv;
    if (performance.now() - lastChart > 900) { lastChart = performance.now(); drawChart(t); }
  }

  function renderCoach(live) {
    const C = app.coach, st = C.state, mph = L.speedMph ?? 0, pedal = L.pedalPct;
    const gm = C.greenMax(mph);
    $("pedalGreen").style.width = `${gm}%`;
    $("pedalFill").style.width = `${pedal ?? 0}%`;
    $("pedalFill").dataset.tone = pedal == null ? "" : pedal > gm ? "over" : "ok";
    $("pedalPct").textContent = pedal == null ? "—" : `${Math.round(pedal)}%`;
    $("brakePill").dataset.on = String(L.brakeOn === true);
    const tip = $("tip");
    if (app.source === "tessie") { tip.textContent = "Pedal coaching needs the adapter. Tessie doesn't send pedal or brake data."; tip.dataset.tone = "idle"; }
    else if (!app.source || !live) { tip.textContent = app.source ? "Waiting for the car…" : "Connect the car to start coaching."; tip.dataset.tone = "idle"; }
    else if (st.tip) { tip.textContent = st.tip.text; tip.dataset.tone = st.tip.tone; }
    const sc = C.score();
    set("cScore", sc == null ? "—" : String(sc), sc == null ? "" : "%");
    $("cScore").dataset.tone = sc == null ? "" : sc >= 75 ? "good" : sc >= 50 ? "warn" : "bad";
    $("cHard").textContent = String(st.hardLaunches); $("cBrake").textContent = String(st.brakeStops);
    $("cSmooth").textContent = st.driveSec < 5 ? "—" : st.jerk < 10 ? "Smooth" : st.jerk < 22 ? "OK" : "Choppy";
    const { rows, sweet } = C.table(), box = $("speedTable");
    if (!rows.length) { box.innerHTML = `<p class="note">Fills in as you cruise steadily above 20 mph. Each 5-mph band needs about half a mile.</p>`; return; }
    const max = Math.max(...rows.map(r => r.wh)), cur = Math.floor(mph / 5) * 5;
    box.innerHTML = rows.map(r => `<div class="srow${sweet && r.mph === sweet.mph ? " sweet" : ""}${mph > 2 && r.mph === cur ? " cur" : ""}">
      <span class="num">${r.mph}–${r.mph + 4}</span><span class="sbar"><i style="width:${(r.wh / max) * 100}%"></i></span><span class="num">${Math.round(r.wh)}</span></div>`).join("");
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
    const iw = W - Lp - R, ih = H - T - B, ys = pts.map(p => p.y), rated = L.ratedWhPerMi > 100 ? L.ratedWhPerMi : null;
    const top = Math.max(400, Math.ceil(Math.max(...ys, rated || 0) / 100) * 100), bot = Math.min(0, Math.floor(Math.min(...ys) / 100) * 100);
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
      if (!L.ratedWhPerMi && bat.nominal_full_pack_energy && cs.battery_range && cs.battery_level) {
        L.ratedWhPerMi = Math.round((bat.energy_remaining * 1000) / cs.battery_range);
      }
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
  $("resetTrip").addEventListener("click", () => { app.trip = null; app.coach.resetTrip(); if (app.source !== "demo") store(tripKey(app.source === "tessie" ? "tessie" : "car"), null); render(false); });
  $("tessieBtn").addEventListener("click", () => (app.source === "tessie" ? disconnect() : startTessie()));
  $("cfgTok").value = tessieToken() ? "••••••••" : "";
  $("cfgTok").addEventListener("change", e => { const v = e.target.value.trim(); if (!v || /^•+$/.test(v)) return; try { localStorage.setItem(KEY.tok, v); } catch (err) {} e.target.value = "••••••••"; notice("Tessie token saved on this device only.", "info"); });
  $("cfgTokClear").addEventListener("click", () => { try { localStorage.removeItem(KEY.tok); } catch (e) {} $("cfgTok").value = ""; if (app.source === "tessie") disconnect(); });
  $("recBtn").addEventListener("click", toggleRec);
  $("resetSpeed").addEventListener("click", () => { app.coach.resetBuckets(); render(false); });
  $("dlBtn").addEventListener("click", download);
  document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => { cfg.win = +b.dataset.w; store(KEY.cfg, cfg); syncSeg(); lastChart = 0; }));
  function syncSeg() { document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.w === cfg.win))); }
  $("cfgBrick").value = cfg.brick; $("cfgBase").value = cfg.oneBased ? "1" : "0"; $("cfgAwake").checked = cfg.keepAwake;
  $("cfgBrick").addEventListener("change", e => { const n = Math.round(+e.target.value); const lo = cfg.oneBased ? 1 : 0; if (n >= lo && n <= lo + 107) { cfg.brick = n; store(KEY.cfg, cfg); } });
  $("cfgBase").addEventListener("change", e => { cfg.oneBased = e.target.value === "1"; store(KEY.cfg, cfg); });
  $("cfgAwake").addEventListener("change", e => { cfg.keepAwake = e.target.checked; store(KEY.cfg, cfg); if (cfg.keepAwake && app.source) keepAwake(); else releaseAwake(); });
  window.addEventListener("resize", () => { lastChart = 0; });

  // frame rate counter + main loop
  let lastFrames = 0;
  setInterval(() => { app.fps = app.frames - lastFrames; lastFrames = app.frames; }, 1000);
  setInterval(tick, 250);
  syncSeg();
  status("off", "Not connected");
  if (!window.ElmLink || !ElmLink.supported()) notice("Live car data needs Chrome 138+ on Android (or desktop Chrome) over https://. Demo works anywhere.", "info");
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  render(false);
})();
