/* OBDLink MX+ (STN chip) link over Web Serial / Bluetooth RFCOMM.
   Listen-only: sets silent monitoring (ATCSM1) and only reads frames that pass the STN filters.
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
      this.chip = "";
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
          if (this.waiter) this.waiter.lines.push(line);
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
      const id = await this.cmd("STI").catch(() => ["?"]);
      this.chip = id.join(" ");
      if (!/STN/i.test(this.chip)) {
        throw new Error(`This adapter answered "${this.chip || z.join(" ")}". The screen needs an OBDLink/STN adapter for multi-ID filtering.`);
      }
      const setup = ["ATE0", "ATL0", "ATS0", "ATH1", "ATD0", "ATCAF0", "ATCSM1", "ATSP6", "STFCP", "STFCB", "STFCFC"];
      for (const c of setup) await this.cmd(c);
      for (const n of ids) await this.cmd(`STFAP ${n.toString(16).toUpperCase().padStart(3, "0")},7FF`);
      this.onStatus({ type: "ready", chip: this.chip });
    }

    async startMonitor() {
      this.monitoring = true;
      await this._write("STM\r");
      this.onStatus({ type: "monitoring" });
    }

    async stopMonitor() {
      if (!this.monitoring) return;
      this.monitoring = false;
      // Any character stops monitoring; wait for the prompt.
      await new Promise(resolve => {
        const w = { lines: [], resolve, timer: setTimeout(() => { this.waiter = null; resolve([]); }, 1500) };
        this.waiter = w;
        this._write("\r").catch(() => resolve([]));
      });
    }

    async restartMonitor() { await this.stopMonitor(); await sleep(50); await this.startMonitor(); }

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
