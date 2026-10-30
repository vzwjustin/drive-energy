/* Model 3 / Y vehicle-bus decoders for the energy screen.
   Bit layouts follow the community DBC (github.com/joshwardell/model3dbc, MIT) plus the
   2021+ multiplexed 0x352 layout. All signals are Intel (little-endian) byte order.
   Works in the browser (window.CanDecode) and in Node (module.exports) for tests. */
(function (root) {
  "use strict";

  // Read `len` bits starting at Intel bit `start` (bit 0 = LSB of byte 0).
  function bits(b, start, len, signed) {
    let v = 0;
    for (let i = 0; i < len; i++) {
      const bit = start + i, byte = bit >> 3;
      if (byte >= b.length) return null;
      if ((b[byte] >> (bit & 7)) & 1) v += 2 ** i;
    }
    if (signed && v >= 2 ** (len - 1)) v -= 2 ** len;
    return v;
  }
  // Inverse, used by the simulator and tests.
  function setBits(b, start, len, value) {
    let v = Math.round(value);
    if (v < 0) v += 2 ** len;
    for (let i = 0; i < len; i++) {
      const bit = start + i, byte = bit >> 3, mask = 1 << (bit & 7);
      if (Math.floor(v / 2 ** i) % 2) b[byte] |= mask; else b[byte] &= ~mask;
    }
    return b;
  }

  // CAN IDs the screen listens to (hex strings for STN pass filters).
  const IDS = {
    HV: 0x132,        // pack voltage + current
    POWER_AVAIL: 0x252,
    SOC: 0x292,
    THERMAL: 0x312,
    UI_RANGE: 0x33A,
    ENERGY: 0x352,
    ODO: 0x3B6,
    TOTALS: 0x3D2,    // lifetime kWh out / in
    SPEED: 0x257,
    BRICKS: 0x401,
  };

  // One "ID + data" line from an STN/ELM monitor with ATH1 ATS0 ATD0 ATCAF0.
  // e.g. "132A08CF2FF5FC6A20000" -> {id:0x132, bytes:[...]}
  function parseLine(line) {
    const s = String(line).replace(/\s+/g, "").toUpperCase();
    const m = /^([0-9A-F]{3})((?:[0-9A-F]{2}){1,8})$/.exec(s);
    if (!m) return null;
    const bytes = [];
    for (let i = 0; i < m[2].length; i += 2) bytes.push(parseInt(m[2].substr(i, 2), 16));
    return { id: parseInt(m[1], 16), bytes };
  }

  function createDecoder() {
    const st = { fmt352: null }; // "old" (pre-2021, 0.1 kWh) or "new" (muxed, 0.02 kWh)
    const out = { bricks: new Array(108).fill(null) };

    function decode(id, b) {
      switch (id) {
        case IDS.HV: {
          const v = bits(b, 0, 16) * 0.01;
          const i = bits(b, 16, 16, true) * -0.1;          // + = discharging
          if (v > 100 && v < 600) { out.packV = v; out.packA = i; out.powerKW = (v * i) / 1000; return "hv"; }
          return null;
        }
        case IDS.POWER_AVAIL:
          out.maxRegenKW = bits(b, 0, 16) * 0.01;
          out.maxDischargeKW = bits(b, 16, 16) * 0.01;
          return "limits";
        case IDS.SOC:
          out.socMin = bits(b, 0, 10) * 0.1;
          out.socUI = bits(b, 10, 10) * 0.1;
          out.socMax = bits(b, 20, 10) * 0.1;
          out.socAvg = bits(b, 30, 10) * 0.1;
          return "soc";
        case IDS.THERMAL:
          out.packTminC = bits(b, 44, 9) * 0.25 - 25;
          out.packTmaxC = bits(b, 53, 9) * 0.25 - 25;
          return "thermal";
        case IDS.UI_RANGE:
          out.ratedRangeMi = bits(b, 0, 10);
          out.idealRangeMi = bits(b, 16, 10);
          out.ratedWhPerMi = bits(b, 32, 10);
          out.uiSOC = bits(b, 48, 7);
          return "range";
        case IDS.ENERGY: return decode352(b);
        case IDS.ODO: {
          const km = bits(b, 0, 32);
          if (km == null) return null;
          out.odoMi = (km * 0.001) / 1.609344;
          return "odo";
        }
        case IDS.TOTALS: {
          const dis = bits(b, 0, 32), chg = bits(b, 32, 32);
          if (dis == null || chg == null) return null;
          out.totalOutKWh = dis * 0.001; out.totalInKWh = chg * 0.001;
          return "totals";
        }
        case IDS.SPEED: {
          const kph = bits(b, 12, 12) * 0.08 - 40;
          out.speedMph = Math.max(0, kph / 1.609344);
          return "speed";
        }
        case IDS.BRICKS: {
          const mux = b[0];
          if (mux > 35 || b.length < 8) return null;
          for (let k = 0; k < 3; k++) {
            const v = bits(b, 16 + 16 * k, 16) * 0.0001;
            out.bricks[mux * 3 + k] = v > 1.5 && v < 4.5 ? v : null;
          }
          return "bricks";
        }
      }
      return null;
    }

    // Format detection: the 2021+ frame cycles its first byte through 0,1,2 (mux index);
    // the old frame's first byte is the low byte of full-pack energy, so it is constant and usually > 3.
    st.seen = new Set(); st.count = 0;
    function decode352(b) {
      if (!st.fmt352) {
        if (b[0] > 3) st.fmt352 = "old";
        else { st.seen.add(b[0]); st.count++;
          if (st.seen.size >= 2) st.fmt352 = "new";
          else if (st.count >= 8) st.fmt352 = "old";
          else return null; }
      }
      if (st.fmt352 === "new") {
        const mux = b[0] & 3;
        if (mux === 0) {
          const full = bits(b, 16, 16) * 0.02, rem = bits(b, 32, 16) * 0.02;
          if (full < 30 || full > 150) return null;
          out.fullPackKWh = full; out.energyRemainingKWh = rem; out.idealRemainingKWh = bits(b, 48, 16) * 0.02;
          return "energy";
        }
        if (mux === 1) {
          out.fullChargeComplete = !!bits(b, 15, 1);
          out.bufferKWh = bits(b, 16, 16) * 0.01;
          out.expectedRemainingKWh = bits(b, 32, 16) * 0.02;
          out.toChargeCompleteKWh = bits(b, 48, 16) * 0.02;
          return "energy";
        }
        return null;
      }
      // Pre-2021 unmuxed layout, 0.1 kWh steps.
      const full = bits(b, 0, 11) * 0.1;
      if (full < 30 || full > 150) return null;
      st.fmt352 = "old";
      out.fullPackKWh = full;
      out.energyRemainingKWh = bits(b, 11, 11) * 0.1;
      out.expectedRemainingKWh = bits(b, 22, 11) * 0.1;
      out.idealRemainingKWh = bits(b, 33, 11) * 0.1;
      out.toChargeCompleteKWh = bits(b, 44, 11) * 0.1;
      out.bufferKWh = bits(b, 55, 8) * 0.1;
      out.fullChargeComplete = !!bits(b, 63, 1);
      return "energy";
    }

    return { decode, state: out, meta: st };
  }

  const api = { bits, setBits, parseLine, createDecoder, IDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CanDecode = api;
})(typeof self !== "undefined" ? self : this);
