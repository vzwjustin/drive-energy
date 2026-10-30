/* Demo source: synthesizes vehicle-bus frames as STN monitor text lines, so the whole
   pipeline (parser → decoder → screen) runs without a car. Clearly labeled as demo in the UI. */
(function (root) {
  "use strict";
  const { setBits } = root.CanDecode || require("./decode.js");
  const hex = b => b.map(x => x.toString(16).toUpperCase().padStart(2, "0")).join("");
  const line = (id, b) => id.toString(16).toUpperCase().padStart(3, "0") + hex(b);
  const frame = n => new Array(n).fill(0);

  function createSim() {
    const s = { t: 0, mph: 0, odoKm: 19000, outKWh: 9100, inKWh: 6400, full: 55.0, rem: 41.0, tick: 0, mux352: 0, mux401: 0 };
    const bricks = Array.from({ length: 108 }, () => 3.305 + (Math.random() - 0.5) * 0.004);

    function targetSpeed(t) {            // 0–40 s parked, then a loop of town + highway
      const c = t % 900;
      if (t < 40) return 0;
      if (c < 120) return 35 + 8 * Math.sin(c / 9);
      if (c < 140) return 0;              // red light
      if (c < 600) return 62 + 6 * Math.sin(c / 23);
      if (c < 840) return 40 + 10 * Math.sin(c / 11);
      return 0;
    }

    // Advance dt seconds; return the STN text lines a real bus would have produced.
    function step(dt) {
      s.t += dt; s.tick++;
      const tgt = targetSpeed(s.t), prev = s.mph;
      s.mph += Math.max(-6 * dt, Math.min(4 * dt, tgt - s.mph));
      const accel = (s.mph - prev) / dt;                                   // mph/s
      const cruise = s.mph > 1 ? 0.9 + 0.0028 * s.mph * s.mph + 0.05 * s.mph : 0.45;
      const kw = cruise + accel * s.mph * 0.21;                            // regen when slowing
      const v = 352 - kw * 0.09 + (s.rem / s.full) * 6, amps = (kw * 1000) / v;
      const kwh = (kw * dt) / 3600;
      if (kwh >= 0) s.outKWh += kwh; else s.inKWh += -kwh;
      s.rem = Math.max(0, s.rem - kwh);
      s.odoKm += (s.mph * 1.609344 * dt) / 3600;
      bricks.forEach((x, i) => { bricks[i] = x - kwh / s.full * 0.12 + (Math.random() - 0.5) * 0.0002 ; });
      const soc = (s.rem / s.full) * 100;
      const out = [];

      // Accelerator follows the power request; brake comes on for hard stops (the red light).
      const pedal = s.mph < 0.5 && tgt === 0 ? 0 : Math.max(0, Math.min(100, (kw / 205) * 100 * 1.6 + (accel > 0 ? accel * 6 : 0)));
      const brake = accel < -3.2 && s.mph > 3;
      let b = frame(8); setBits(b, 32, 8, brake ? 0 : pedal / 0.4); setBits(b, 19, 2, brake ? 1 : 0); setBits(b, 21, 3, s.t < 40 ? 1 : 4); out.push(line(0x118, b));
      b = frame(8); setBits(b, 0, 16, v / 0.01); setBits(b, 16, 16, amps / -0.1); setBits(b, 32, 16, (amps - 822) / -0.05); out.push(line(0x132, b));
      b = frame(8); setBits(b, 12, 12, (s.mph * 1.609344 + 40) / 0.08); setBits(b, 24, 9, Math.round(s.mph)); out.push(line(0x257, b));
      if (s.tick % 2 === 0) { b = frame(8); setBits(b, 0, 32, s.outKWh / 0.001); setBits(b, 32, 32, s.inKWh / 0.001); out.push(line(0x3D2, b)); }
      if (s.tick % 5 === 0) {
        b = frame(8); b[0] = s.mux352;
        if (s.mux352 === 0) { setBits(b, 16, 16, s.full / 0.02); setBits(b, 32, 16, s.rem / 0.02); setBits(b, 48, 16, s.rem * 1.03 / 0.02); }
        else if (s.mux352 === 1) { setBits(b, 16, 16, 1.7 / 0.01); setBits(b, 32, 16, (s.rem - 1.2) / 0.02); setBits(b, 48, 16, (s.full * 0.8 - s.rem) / 0.02); }
        else { b[1] = 0x26; b[2] = 0x02; b[3] = 0x20; }
        s.mux352 = (s.mux352 + 1) % 3; out.push(line(0x352, b));
        b = frame(4); setBits(b, 0, 32, s.odoKm / 0.001); out.push(line(0x3B6, b));
        b = frame(8); setBits(b, 0, 10, soc * 2.52); setBits(b, 16, 10, soc * 2.6); setBits(b, 32, 10, 221); setBits(b, 48, 7, soc); out.push(line(0x33A, b));
        b = frame(8); setBits(b, 0, 10, (soc - 0.3) * 10); setBits(b, 10, 10, soc * 10); setBits(b, 20, 10, (soc + 0.3) * 10); setBits(b, 30, 10, soc * 10); setBits(b, 40, 10, 575); out.push(line(0x292, b));
        b = frame(8); setBits(b, 44, 9, (24 + 25) / 0.25); setBits(b, 53, 9, (26.5 + 25) / 0.25); out.push(line(0x312, b));
        b = frame(8); setBits(b, 0, 16, 62 / 0.01); setBits(b, 16, 16, 205 / 0.01); out.push(line(0x252, b));
      }
      for (let k = 0; k < 2; k++) {
        b = frame(8); b[0] = s.mux401;
        for (let j = 0; j < 3; j++) setBits(b, 16 + 16 * j, 16, (bricks[s.mux401 * 3 + j] - amps * 0.0004) / 0.0001);
        s.mux401 = (s.mux401 + 1) % 36; out.push(line(0x401, b));
      }
      return out;
    }
    return { step };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createSim };
  else root.CanSim = { createSim };
})(typeof self !== "undefined" ? self : this);
