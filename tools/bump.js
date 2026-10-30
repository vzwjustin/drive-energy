// npm run bump: raise the release number everywhere it lives (sw.js cache name, index.html script tags and footer).
// The new cache name makes phones drop the old offline copy; the ?v= tags bypass the browser's HTTP cache.
const fs = require("fs"), path = require("path");
const sw = path.join(__dirname, "../sw.js"), html = path.join(__dirname, "../index.html");
const cur = +/drive-energy-v(\d+)"/.exec(fs.readFileSync(sw, "utf8"))[1], next = cur + 1;
fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace(`drive-energy-v${cur}"`, `drive-energy-v${next}"`));
const page = fs.readFileSync(html, "utf8"), out = page.replaceAll(`.js?v=${cur}"`, `.js?v=${next}"`).replace(`<span id="ver">v${cur}</span>`, `<span id="ver">v${next}</span>`);
if ((out.match(new RegExp(`v=${next}"|>v${next}<`, "g")) || []).length !== 9) throw new Error("index.html: expected 8 script tags and the footer at v" + cur);
fs.writeFileSync(html, out);
console.log(`v${cur} → v${next}`);
