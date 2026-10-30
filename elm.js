/* OBD adapter link over Web Serial / Bluetooth RFCOMM.
   - STN chips (OBDLink MX+): many pass filters + continuous STM monitor.
   - ELM327-class chips (vLinker FS, MC+, etc.): round-robin through small receive-address groups
     (ATCRA 13X …) with ATMA, the same approach EcoLab uses, because plain ATMA overflows on a Model 3 bus.
   Listen-only: silent monitoring (ATCSM1) must be confirmed or the link refuses to listen.
   Nothing is ever transmitted onto the car's CAN bus. */
(function (root) {
  "use strict";
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  class ElmLink {
    constructor({ onLine, onStatus }) {
      this.onLine = onLine || (() => {});
      this.onStatus = onStatus || (() => {});
      this.port = null; this.writer = null; this.reader = null;
      this.buf = ""; this.waiter = null; this.monitoring = false; this.closed = false;
      this.chip = ""; this.mode = null; this.groups = []; this.useCra = true; this._rr = null;
    }

    static supported() { return typeof navigator !== "undefined" && "serial" in navigator; }

    async pick() {
      // No filter: Chrome lists paired Bluetooth Serial Port Profile devices (and USB serial on desktop).
      this.port = await navigator.serial.requestPort();
      return this.port;
    }

    async open(port) {
      this.port = port || this.port;
      await this.port.open({ baudRate: 115200, bufferSize: 65536 });
      this.closed = false;
      this.writer = this.port.writable.getWriter();
      this._readLoop();
    }

    async _readLoop() {
      const dec = new TextDecoder();
      while (!this.closed && this.port && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            this._ingest(dec.decode(value, { stream: true }));
          }
        } catch (e) {
          if (!this.closed) this.onStatus({ type: "error", message: "Bluetooth link dropped: " + (e.message || e) });
        } finally {
          try { this.reader.releaseLock(); } catch (e) {}
        }
        if (!this.closed) { this.onStatus({ type: "lost" }); break; }
      }
    }

    _ingest(text) {
      this.buf += text;
      let idx;
      while ((idx = this.buf.search(/[\r\n>]/)) >= 0) {
        const ch = this.buf[idx];
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (line) {
          // CAN frames always go to the decoder, even when they arrive while a command reply is pending.
          if (this.waiter && !/^[0-9A-F]{3}(?:[0-9A-F]{2}){1,8}$/i.test(line.replace(/\s+/g, ""))) this.waiter.lines.push(line);
          else this.onLine(line);
        }
        if (ch === ">" && this.waiter) { const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.resolve(w.lines); }
      }
      if (this.buf.length > 4096) this.buf = this.buf.slice(-512);
    }

    async _write(s) { await this.writer.write(new TextEncoder().encode(s)); }

    // Send an AT/ST command and wait for the ">" prompt.
    cmd(s, timeout = 2500) {
      return new Promise(async (resolve, reject) => {
        if (this.waiter) { reject(new Error("busy")); return; }
        const w = { lines: [], resolve, timer: null };
        w.timer = setTimeout(() => { if (this.waiter === w) this.waiter = null; reject(new Error(`No reply to ${s}`)); }, timeout);
        this.waiter = w;
        try { await this._write(s + "\r"); } catch (e) { clearTimeout(w.timer); this.waiter = null; reject(e); }
      });
    }

    async init(ids) {
      this.onStatus({ type: "init", message: "Resetting adapter" });
      try { await this._write("\r"); await sleep(300); } catch (e) {}
      this.buf = "";
      const z = await this.cmd("ATZ", 4000);
      await sleep(600);                                   // some ELM clones keep rebooting after the prompt
      const sti = (await this.cmd("STI").catch(() => ["?"])).join(" ");
      const isStn = /STN/i.test(sti);
      const ati = isStn ? "" : (await this.cmd("ATI").catch(() => [""])).join(" ");
      this.chip = isStn ? sti : (ati || z.join(" ") || "ELM327");
      const ok = r => r.some(l => /^OK$/i.test(l.trim()));
      for (const c of ["ATE0", "ATL0", "ATS0", "ATH1", "ATD0", "ATCAF0", "ATSP6"]) await this.cmd(c);
      const csm = await this.cmd("ATCSM1").catch(() => []);
      if (!ok(csm)) throw new Error(`The adapter (${this.chip}) didn't confirm silent monitoring (ATCSM1), so Drive Energy won't listen. It never risks acknowledging frames on the car's bus.`);
      if (isStn) {
        this.mode = "stn";
        for (const c of ["STFCP", "STFCB", "STFCFC"]) await this.cmd(c);
        for (const n of ids) await this.cmd(`STFAP ${n.toString(16).toUpperCase().padStart(3, "0")},7FF`);
      } else {
        this.mode = "elm";
        this.groups = ElmLink.groupsFor(ids);
        const probe = await this.cmd(`ATCRA ${this.groups[0].pat}`).catch(() => ["?"]);
        this.useCra = ok(probe);                          // older firmware: fall back to ATCF/ATCM masks
        if (!this.useCra) await this.cmd("ATAR").catch(() => {});
      }
      this.onStatus({ type: "ready", chip: this.chip, mode: this.mode });
    }

    // Group IDs by their first two hex digits: "13X" = 0x130–0x13F. Fast-changing ones get visited every cycle.
    static groupsFor(ids) {
      const FAST = new Set([0x118, 0x132, 0x257]);
      const map = new Map();
      for (const id of ids) {
        const pre = id.toString(16).toUpperCase().padStart(3, "0").slice(0, 2);
        const g = map.get(pre) || { pat: pre + "X", cf: pre + "0", cm: "7F0", fast: false, dwell: 300 };
        if (FAST.has(id)) { g.fast = true; g.dwell = 250; }
        if (id === 0x401) g.dwell = 1500;                 // 36 brick pages need a longer look
        map.set(pre, g);
      }
      return [...map.values()];
    }

    async _select(g) {
      if (this.useCra) await this.cmd(`ATCRA ${g.pat}`);
      else { await this.cmd(`ATCF ${g.cf}`); await this.cmd(`ATCM ${g.cm}`); }
    }

    async _interrupt() {
      await new Promise(resolve => {
        const w = { lines: [], resolve, timer: setTimeout(() => { if (this.waiter === w) this.waiter = null; resolve([]); }, 1500) };
        this.waiter = w;
        this._write("\r").catch(() => resolve([]));
      });
    }

    async _roundRobin() {
      const fast = this.groups.filter(g => g.fast), slow = this.groups.filter(g => !g.fast);
      let si = 0;
      while (this.monitoring && !this.closed) {
        const seq = slow.length ? [...fast, slow[si++ % slow.length]] : fast;
        for (const g of seq) {
          if (!this.monitoring || this.closed) break;
          try {
            await this._select(g);
            await this._write("ATMA\r");
            await sleep(g.dwell);
            await this._interrupt();
          } catch (e) {
            if (!this.monitoring || this.closed) break;
            this.onStatus({ type: "warn", message: "Adapter missed a step; continuing." });
            await this._interrupt().catch(() => {});
            await sleep(200);
          }
        }
      }
    }

    async startMonitor() {
      this.monitoring = true;
      if (this.mode === "elm") { this._rr = this._roundRobin(); this.onStatus({ type: "monitoring" }); return; }
      await this._write("STM\r");
      this.onStatus({ type: "monitoring" });
    }

    async stopMonitor() {
      if (!this.monitoring) return;
      this.monitoring = false;
      if (this.mode === "elm") { try { await this._rr; } catch (e) {} this._rr = null; return; }
      // Any character stops monitoring; wait for the prompt.
      await new Promise(resolve => {
        const w = { lines: [], resolve, timer: setTimeout(() => { this.waiter = null; resolve([]); }, 1500) };
        this.waiter = w;
        this._write("\r").catch(() => resolve([]));
      });
    }

    async restartMonitor() {
      if (this.mode === "elm") return;                    // round-robin already restarts every step
      await this.stopMonitor(); await sleep(50); await this.startMonitor();
    }

    async close() {
      try { await this.stopMonitor(); } catch (e) {}
      this.closed = true;
      try { await this.reader?.cancel(); } catch (e) {}
      try { this.writer?.releaseLock(); } catch (e) {}
      try { await this.port?.close(); } catch (e) {}
      this.onStatus({ type: "closed" });
    }
  }

  root.ElmLink = ElmLink;
})(typeof self !== "undefined" ? self : this);
