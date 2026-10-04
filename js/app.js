// UI layer — mirrors main.py (Tkinter) behaviour in the browser.
import * as core from "./core.js";
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;

const $ = (id) => document.getElementById(id);
const out = $("output");

// ---------- small storage helpers ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// IndexedDB "draws" store = permanent archive of result PDFs, keyed by draw serial.
// Each record: { serial, size, data (PDF bytes), nums (all whole-number words, filled on first parse) }
const db = (() => {
  let p;
  const open = () => p ??= new Promise((res, rej) => {
    const r = indexedDB.open("lottery-analyzer", 2);
    r.onupgradeneeded = (ev) => {
      const d = r.result, t = r.transaction;
      const draws = d.objectStoreNames.contains("draws") ? t.objectStore("draws") : d.createObjectStore("draws");
      if (ev.oldVersion >= 1 && d.objectStoreNames.contains("pdfs")) {
        // migrate files downloaded by the previous version into the archive
        const c = t.objectStore("pdfs").openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (cur) { const v = cur.value; if (v && v.serial && v.data) draws.put({ serial: v.serial, size: v.size, data: v.data }, v.serial); cur.continue(); }
          else d.deleteObjectStore("pdfs");
        };
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction("draws", mode);
      const req = fn(t.objectStore("draws"));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    put: (v) => tx("readwrite", (s) => s.put(v, v.serial)),
    get: (k) => tx("readonly", (s) => s.get(k)),
    keys: () => tx("readonly", (s) => s.getAllKeys()),
    clear: () => tx("readwrite", (s) => s.clear()),
    sizeInfo: async () => {
      const d = await open();
      return new Promise((res, rej) => {
        let n = 0, bytes = 0;
        const r = d.transaction("draws").objectStore("draws").openCursor();
        r.onsuccess = () => { const c = r.result; if (c) { n++; bytes += c.value.size || 0; c.continue(); } else res({ n, bytes }); };
        r.onerror = () => rej(r.error);
      });
    },
  };
})();
try { navigator.storage?.persist?.(); } catch {} // ask the browser not to evict the archive

// ---------- output screen (add_text_to_output_screen etc.) ----------
function log(text, color = "green", bold = false) {
  const div = document.createElement("div");
  if (color !== "green") div.classList.add(color);
  if (bold) div.classList.add("bold");
  div.textContent = typeof text === "string" ? text : JSON.stringify(text);
  out.append(div);
  out.scrollTop = out.scrollHeight;
}
function logCollapsible(title, value) {
  const d = document.createElement("details");
  const s = document.createElement("summary");
  s.textContent = title;
  const body = document.createElement("div");
  body.textContent = Array.isArray(value) ? "[" + value.join(", ") + "]" : String(value);
  d.append(s, body);
  out.append(d);
  out.scrollTop = out.scrollHeight;
}
const newline = () => log("");
function clearScreen() { out.textContent = ""; log("Screen Cleared"); }
const tick = () => new Promise((r) => setTimeout(r, 0)); // let the UI repaint

function busy(on) {
  document.querySelectorAll(".controls .btn, #settingsBtn").forEach((b) => (b.disabled = on));
}
function readInputs() {
  const count = parseInt($("fileCount").value, 10);
  const start = parseInt($("startSerial").value, 10);
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(start)) {
    log("Input Error!! Please enter valid numbers.", "red", true);
    return null;
  }
  LS.set("inputs", { count, start });
  return { count, start };
}

// ---------- file list (the draws currently selected for Analyze) ----------
const getSelection = () => LS.get("selection", []);
async function renderFiles() {
  const sel = getSelection();
  const ol = $("fileList");
  ol.innerHTML = "";
  for (const [k, serial] of sel.entries()) {
    const rec = await db.get(serial);
    const li = document.createElement("li");
    li.value = k + 1;
    li.textContent = rec ? `draw ${serial} (${Math.round(rec.size / 1024)} KB)` : `draw ${serial} — missing`;
    ol.append(li);
  }
  const { n } = await db.sizeInfo();
  $("fileSummary").textContent = (sel.length ? `${sel.length} file(s)` : "none") + ` · ${n} saved`;
}

// ---------- Update PDF Files (delete_all_pdfs + downloadPDF + verifyPDFs) ----------
function isPdf(buf) {
  const b = new Uint8Array(buf.slice(0, 5));
  return String.fromCharCode(...b) === "%PDF-";
}
async function fetchPdf(url) {
  // Proxy first (the result site blocks direct browser downloads), direct fetch as a fallback
  const proxy = (LS.get("settings", {}).proxy || "").trim() || core.DEFAULT_PROXY;
  const attempts = [() => fetch(proxy + encodeURIComponent(url)), () => fetch(url, { mode: "cors" })];
  const errs = [];
  for (const [n, go] of attempts.entries()) {
    try {
      const r = await go();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      return { buf, type: r.headers.get("Content-Type") || "" };
    } catch (e) { errs.push(`${n === 0 ? "via proxy" : "direct"}: ${e.message || e}`); }
  }
  throw new Error(errs.join(" | "));
}

// Download one draw. Returns the PDF bytes, or null when the site has no result for that serial
// (the site answers unknown/future serials with an empty file).
async function downloadSerial(serial) {
  const { buf, type } = await fetchPdf(core.RESULT_URL(serial));
  if (buf.byteLength === 0 || (!type.includes("application/pdf") && !isPdf(buf)) || !isPdf(buf)) return null;
  return buf;
}

// Make sure the given draws are in the archive; download only the missing ones (4 at a time).
// `cache` may already hold bytes fetched while searching for the latest serial.
async function ensureDraws(serials, cache = new Map(), { quiet = false } = {}) {
  const have = new Set(await db.keys());
  const need = serials.filter((s) => !have.has(s));
  log(`${serials.length - need.length} of ${serials.length} draw(s) already saved — downloading ${need.length}.`);
  let done = 0, failed = 0;
  const queue = [...need];
  const worker = async () => {
    while (queue.length) {
      const serial = queue.shift();
      try {
        const buf = cache.has(serial) ? cache.get(serial) : await downloadSerial(serial);
        if (buf) { await db.put({ serial, size: buf.byteLength, data: buf }); have.add(serial); if (!quiet) log(`Downloaded draw ${serial}`); }
        else { failed++; log(`Skipped: no result PDF for serial ${serial}.`, "yellow"); }
      } catch (e) { failed++; log(`Error downloading ${serial}: ${e.message || e}`, "red"); }
      done++;
      if (quiet && done % 10 === 0) { log(`  downloaded ${done}/${need.length}...`); }
      await tick();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, need.length) }, worker));
  if (need.length) log(`Downloads completed: ${need.length - failed} new, ${failed} not available.`);
  return serials.filter((s) => have.has(s));
}

// Shared by both update buttons: ensure the draws exist, then select them for Analyze
async function selectDraws(serials, cache) {
  log("Updating PDF files...");
  log("------------------------------------------");
  const ok = await ensureDraws(serials, cache);
  if (ok.length) {
    LS.set("selection", ok);
    log(`Selected ${ok.length} draw(s) for analysis: ${ok[0]} … ${ok[ok.length - 1]}`, "yellow", true);
  } else {
    log("No draws available — the previous selection was kept.", "yellow");
  }
  newline();
  await renderFiles();
}

// "Update PDF files" — starting-serial based (same as the Python app)
async function updatePdfFiles() {
  const inp = readInputs(); if (!inp) return;
  busy(true);
  try {
    await selectDraws(Array.from({ length: inp.count }, (_, k) => inp.start + k));
  } finally { busy(false); }
}

// ---------- Latest results ----------
// One draw a day with consecutive serials, but some days have no draw, so the date only gives
// an estimate. We then probe the site to find the newest serial that really has a result.
const ANCHOR = { serial: 74890, date: "2025-05-03" }; // KR-704, held 03/05/2025
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const todayISO = () => new Date().toLocaleDateString("en-CA"); // yyyy-mm-dd, local time

async function findLatestSerial(cache) {
  const known = LS.get("latestKnown", ANCHOR);
  const guess = known.serial + Math.max(0, dayDiff(known.date, todayISO()));
  const saved = new Set(await db.keys());
  const exists = async (s) => {
    if (saved.has(s)) return true;
    if (cache.has(s)) return !!cache.get(s);
    log(`  checking serial ${s}...`); await tick();
    const buf = await downloadSerial(s);
    cache.set(s, buf);
    return !!buf;
  };
  let lo, hi; // lo = has a result, hi = no result
  if (await exists(guess)) {
    lo = guess; let step = 1;
    while (await exists(lo + step)) { lo += step; step *= 2; if (step > 4096) throw new Error("search ran away"); }
    hi = lo + step;
  } else {
    hi = guess; let step = 1;
    while (true) {
      const s = guess - step;
      if (s <= 0 || step > 8192) throw new Error("could not find any published result");
      if (await exists(s)) { lo = s; break; }
      hi = s; step *= 2;
    }
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await exists(mid)) lo = mid; else hi = mid;
  }
  LS.set("latestKnown", { serial: lo, date: todayISO() });
  return lo;
}

async function updateLatest() {
  const n = parseInt($("fileCount").value, 10);
  if (!Number.isInteger(n) || n < 1) { log("Input Error!! Please enter valid numbers.", "red", true); return; }
  busy(true);
  try {
    log(`Finding the latest published result...`);
    const cache = new Map();
    const latest = await findLatestSerial(cache);
    const start = latest - n + 1;
    log(`Latest result serial: ${latest}. Fetching the latest ${n}: serials ${start} to ${latest}.`, "yellow", true);
    newline();
    $("startSerial").value = start;
    readInputs();
    await selectDraws(Array.from({ length: n }, (_, k) => start + k), cache);
  } catch (e) {
    log(`Could not find the latest result: ${e.message || e}`, "red", true);
  } finally { busy(false); }
}

// ---------- Analyze ----------
async function extractText(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const c = await page.getTextContent();
    text += core.textFromPdfJsItems(c.items) + "\n";
  }
  await doc.destroy();
  return text;
}

// All whole-number words of one draw (parsed once, then kept in the archive)
async function drawNumbers(serial) {
  const rec = await db.get(serial);
  if (!rec) return null;
  if (!rec.nums) {
    rec.nums = core.splitToWordsAndFilterNumbers(await extractText(rec.data));
    await db.put(rec);
  }
  return rec.nums;
}

async function analyzeAndShow() {
  const sel = getSelection();
  busy(true);
  try {
    log(" Extracting text from PDF Files...."); newline();
    const perFile = [];
    for (const [k, serial] of sel.entries()) {
      log(` extracting data from PDF file ${k + 1} (draw ${serial}).....`); await tick();
      try { const nums = await drawNumbers(serial); if (nums) perFile.push(nums); else log(`File not found: draw ${serial}`, "red"); }
      catch (e) { log(`Could not read draw ${serial}: ${e.message || e}`, "red"); }
    }
    log(" Data extraction Completed!!"); newline();
    if (!perFile.length) { log("No PDF files to analyze. Use one of the Update buttons first.", "red", true); return; }

    log(" Splitting the text data into words and filtering numbers....");
    const numbers = perFile.flat();
    const four = core.filter4DigitNumbers(numbers);
    const [D0, D1, D2, D3] = core.analyze(four);
    log(" Data Splitting and filtering completed!!");
    logCollapsible(`The result number word array (${numbers.length}) — tap to expand`, numbers);
    newline();
    log(" Collecting 4 digit numbers from the data....");
    logCollapsible(`Extracted 4 digit numbers from all the pdf files (${four.length}) — tap to expand`, four);
    newline();
    log("Total number of numbers in the above list: " + four.length);
    log(`Total number of pdf files: ${perFile.length}`);
    log(`Expected number of 4 digit results per files: ${core.EXPECTED_PER_FILE}`);
    log(`Total number of expected 4 digit results: ${perFile.length} x ${core.EXPECTED_PER_FILE} = ${perFile.length * core.EXPECTED_PER_FILE}`);
    log("------------------------------------------------------------");
    newline();
    log("  Analyzing the data.... ");

    LS.set("lastResult", { D0, D1, D2, D3, at: new Date().toISOString(), files: perFile.length, numbers: four.length });
    showResult();
  } finally { busy(false); }
}

// ---------- Backtest ----------
// Walk forward through history: predict each draw from the `w` draws before it with the
// exact same algorithm, count how many of the 16 combinations appear among that draw's
// 4-digit numbers, and compare with what random guessing would score.
function backtestWindow(draws, w, tests) {
  const first = Math.max(w, draws.length - tests);
  let hits = 0, expected = 0, variance = 0, n = 0, best = 0, drawsWithHit = 0;
  for (let i = first; i < draws.length; i++) {
    const history = draws.slice(i - w, i).flatMap((d) => d.four);
    const [D0, D1, D2, D3] = core.analyze(history);
    const { combos } = core.deriveFromResult({ D0, D1, D2, D3 });
    const winners = new Set(draws[i].four);
    const h = combos.filter((c) => winners.has(c)).length;
    const pr = winners.size / 10000;
    hits += h; expected += combos.length * pr; variance += combos.length * pr * (1 - pr);
    n++; best = Math.max(best, h); if (h) drawsWithHit++;
  }
  const z = variance ? (hits - expected) / Math.sqrt(variance) : 0;
  return { w, n, hits, expected, z, best, drawsWithHit };
}
const verdict = (z) => z >= 3 ? ["Strong", "good"] : z >= 2 ? ["Interesting", "warn"] : z <= -2 ? ["Below random", "bad"] : ["Like random", "neutral"];
const verdictText = (z) => z >= 3 ? "That is a strong signal — keep testing it on new draws before trusting it."
  : z >= 2 ? "That is better than usual luck, but not conclusive — re-test it on future draws."
  : z <= -2 ? "That is worse than random guessing."
  : "That is within normal luck — no better than picking 16 numbers at random.";

async function runBacktest() {
  const w = parseInt($("btWindow").value || $("fileCount").value, 10);
  const tests = parseInt($("btTests").value, 10);
  if (!(w >= 1 && w <= 60 && tests >= 10 && tests <= 2000)) { log("Input Error!! Window 1–60 and test draws 10–2000.", "red", true); return; }
  const windows = $("btCompare").checked ? [...new Set([3, 7, 15, 30, w])].sort((a, b) => a - b) : [w];
  const wMax = Math.max(...windows);
  busy(true);
  try {
    log("Backtest: finding the latest published result...", "yellow", true);
    const cache = new Map();
    const latest = await findLatestSerial(cache);
    const from = latest - tests - wMax + 1;
    log(`Backtest range: draws ${from} to ${latest} (${latest - from + 1} draws).`);
    const serials = Array.from({ length: latest - from + 1 }, (_, k) => from + k);
    const ok = await ensureDraws(serials, cache, { quiet: true });

    log("Reading numbers from the saved PDFs (only new ones need parsing)...");
    const draws = [];
    for (const [k, serial] of ok.entries()) {
      try { draws.push({ serial, four: core.filter4DigitNumbers(await drawNumbers(serial)) }); }
      catch (e) { log(`Could not read draw ${serial}: ${e.message || e}`, "red"); }
      if ((k + 1) % 25 === 0) { log(`  read ${k + 1}/${ok.length}`); await tick(); }
    }
    log("Running the backtest..."); await tick();
    const rows = windows.map((win) => backtestWindow(draws, win, tests));
    const result = { at: new Date().toISOString(), latest, from: draws[0]?.serial, rows, main: w };
    LS.set("lastBacktest", result);
    await renderFiles();
    showBacktest(result);
    for (const r of rows) log(`Window ${r.w}: ${r.hits} hits in ${r.n} draws, random ≈ ${r.expected.toFixed(1)}, z = ${r.z.toFixed(2)} → ${verdict(r.z)[0]}`, "yellow", true);
    newline();
  } catch (e) {
    log(`Backtest failed: ${e.message || e}`, "red", true);
  } finally { busy(false); }
}

function showBacktest(r, scroll = true) {
  if (!r) return;
  const tb = $("btTable").querySelector("tbody");
  tb.innerHTML = "";
  for (const row of r.rows) {
    const [label, cls] = verdict(row.z);
    const tr = document.createElement("tr");
    if (row.w === r.main) tr.className = "main";
    tr.innerHTML = `<td>${row.w}</td><td>${row.hits}</td><td>${row.expected.toFixed(0)}</td>` +
      `<td>${row.z >= 0 ? "+" : ""}${row.z.toFixed(1)}</td><td><span class="pill ${cls}">${label}</span></td>`;
    tb.append(tr);
  }
  const m = r.rows.find((x) => x.w === r.main) || r.rows[0];
  $("btSummary").textContent =
    `Using the previous ${m.w} draws to predict each of the last ${m.n} draws, your 16 combinations matched ${m.hits} times. ` +
    `Random guessing would match about ${m.expected.toFixed(0)} times (±${Math.sqrt(m.expected).toFixed(0)} from luck). ` +
    `At least one combination matched in ${m.drawsWithHit} of ${m.n} draws; the best single draw had ${m.best}. ${verdictText(m.z)}`;
  $("btMeta").textContent = `${m.n} test draws (${r.from}–${r.latest}) · run ${new Date(r.at).toLocaleString()}`;
  $("btBox").hidden = false;
  if (scroll) $("btBox").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Show (last) result ----------
function showResult() {
  const r = LS.get("lastResult", null);
  if (!r) { log("Error loading analysis result: no saved result yet. Run Analyze! first.", "red", true); return; }
  const { D0, D1, D2, D3 } = r;
  const { table, most, second, combos } = core.deriveFromResult(r);

  log("Raw Result" + (r.at ? `  (saved ${new Date(r.at).toLocaleString()})` : ""));
  [D0, D1, D2, D3].forEach((d) => log("[" + d.join(", ") + "]"));
  newline();
  log("Final Result: ", "yellow", true);
  log("--------------------------------------------------");
  log("Digit   D3    D2    D1    D0", "yellow", true);
  table.forEach((row) => log(row.map((v) => String(v).padEnd(6)).join(""), "yellow", true));
  log("--------------------------------------------------");
  log("Most Repeated Digits: " + JSON.stringify(most), "yellow", true);
  log("Second Most Repeated Digits: " + JSON.stringify(second), "yellow", true);
  log("--------------------------------------------------");
  log("Positional Combinations: ", "yellow", true);
  log(combos.join("  "), "yellow", true);
  newline();

  // visual result card
  const tb = $("resultTable").querySelector("tbody");
  tb.innerHTML = "";
  const cols = [D3, D2, D1, D0];
  table.forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((v, ci) => {
      const td = document.createElement("td");
      td.textContent = v;
      if (ci > 0) {
        if (most[ci - 1] === row[0]) td.className = "top";
        else if (second[ci - 1] === row[0]) td.className = "second";
      }
      tr.append(td);
    });
    tb.append(tr);
  });
  $("mostDigits").textContent = most.join("");
  $("secondDigits").textContent = second.join("");
  $("combos").innerHTML = combos.map((c) => `<span>${c}</span>`).join("");
  $("resultBox").hidden = false;
  const idx = { D3: 0, D2: 1, D1: 2, D0: 3 };
  document.querySelectorAll(".charts canvas").forEach((cv) => {
    const p = cv.dataset.pos;
    drawBars(cv, r[p], most[idx[p]], second[idx[p]]);
  });
  $("resultBox").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- bar charts (show_digit_plots) ----------
function drawBars(cv, data, topDigit, secondDigit) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const pad = { l: 36, r: 6, t: 16, b: 22 };
  const max = Math.max(...data, 1);
  const yMax = Math.ceil(max / 100) * 100;
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const y = (v) => pad.t + ph - (v / yMax) * ph;

  g.font = "11px system-ui, sans-serif";
  g.textAlign = "right"; g.textBaseline = "middle";
  for (let v = 0; v <= yMax; v += 100) {
    g.strokeStyle = "#3a3a3a"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad.l, Math.round(y(v)) + 0.5); g.lineTo(W - pad.r, Math.round(y(v)) + 0.5); g.stroke();
    g.fillStyle = "#a6a6a6"; g.fillText(v, pad.l - 4, y(v));
  }
  const slot = pw / 10, bw = Math.max(6, slot - 4);
  cv._bars = [];
  data.forEach((v, d) => {
    const x = pad.l + d * slot + (slot - bw) / 2;
    const top = y(v), h = pad.t + ph - top;
    g.fillStyle = d === topDigit ? css.getPropertyValue("--bar-top") : d === secondDigit ? css.getPropertyValue("--bar-second") : css.getPropertyValue("--bar");
    g.beginPath();
    g.roundRect ? g.roundRect(x, top, bw, h, [4, 4, 0, 0]) : g.rect(x, top, bw, h);
    g.fill();
    g.fillStyle = "#f2f2f2"; g.textAlign = "center"; g.textBaseline = "top";
    g.fillText(d, x + bw / 2, pad.t + ph + 5);
    if (d === topDigit || d === secondDigit) { g.textBaseline = "bottom"; g.fillText(v, x + bw / 2, top - 2); }
    cv._bars.push({ x: pad.l + d * slot, w: slot, d, v });
  });
  cv._data = data;
}
function setupTooltips() {
  const tip = $("tip");
  const show = (cv, ev) => {
    const rect = cv.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const b = cv._bars?.find((b) => px >= b.x && px < b.x + b.w);
    if (!b) { tip.hidden = true; return; }
    tip.textContent = `Digit ${b.d}: ${b.v}`;
    tip.style.left = ev.clientX + 12 + "px";
    tip.style.top = ev.clientY - 30 + "px";
    tip.hidden = false;
  };
  document.querySelectorAll(".charts canvas").forEach((cv) => {
    cv.addEventListener("pointermove", (e) => show(cv, e));
    cv.addEventListener("pointerdown", (e) => show(cv, e));
    cv.addEventListener("pointerleave", () => (tip.hidden = true));
  });
  window.addEventListener("scroll", () => (tip.hidden = true), { passive: true });
}

function showBacktestSaved() { const r = LS.get("lastBacktest", null); if (r) showBacktest(r, false); }

// ---------- settings ----------
function openSettings() {
  const s = LS.get("settings", { mode: "1", proxy: "" });
  document.querySelectorAll("input[name=mode]").forEach((r) => (r.checked = r.value === s.mode));
  $("proxyUrl").value = s.proxy || "";
  $("proxyUrl").placeholder = core.DEFAULT_PROXY;
  db.sizeInfo().then(({ n, bytes }) => ($("archiveInfo").textContent = `${n} draw(s) saved · ${(bytes / 1048576).toFixed(1)} MB`));
  $("clearArchive").textContent = "Delete saved draws";
  $("clearArchive").dataset.armed = "";
  $("settingsDlg").showModal();
}
$("settingsDlg").addEventListener("close", () => {
  if ($("settingsDlg").returnValue !== "save") return;
  const mode = document.querySelector("input[name=mode]:checked")?.value || "1";
  LS.set("settings", { mode, proxy: $("proxyUrl").value.trim() });
  log(`Settings saved. Analysis mode option ${mode}.`);
});

$("clearArchive").addEventListener("click", async () => {
  const b = $("clearArchive");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to delete"; return; }
  await db.clear(); LS.set("selection", []);
  b.dataset.armed = ""; b.textContent = "Deleted";
  $("archiveInfo").textContent = "0 draw(s) saved · 0.0 MB";
  log("All saved draws deleted.", "yellow");
  renderFiles();
});

// ---------- install button (PWA) ----------
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredPrompt = e; $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null; $("installBtn").hidden = true;
});
window.addEventListener("appinstalled", () => ($("installBtn").hidden = true));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ---------- wire up ----------
$("updateBtn").onclick = updatePdfFiles;
$("latestBtn").onclick = updateLatest;
const syncLatestLabel = () => {
  const n = parseInt($("fileCount").value, 10);
  $("latestBtn").textContent = `Update PDF files with latest ${Number.isInteger(n) && n > 0 ? n : "n"} Results`;
};
$("fileCount").addEventListener("input", syncLatestLabel);
$("analyzeBtn").onclick = analyzeAndShow;
$("btBtn").onclick = runBacktest;
$("fileCount").addEventListener("input", () => ($("btWindow").placeholder = $("fileCount").value));
$("lastBtn").onclick = showResult;
$("clearBtn").onclick = clearScreen;
$("settingsBtn").onclick = openSettings;
window.addEventListener("resize", () => { if (!$("resultBox").hidden) {
  const r = LS.get("lastResult", null); if (!r) return;
  const { most, second } = core.deriveFromResult(r); const idx = { D3: 0, D2: 1, D1: 2, D0: 3 };
  document.querySelectorAll(".charts canvas").forEach((cv) => drawBars(cv, r[cv.dataset.pos], most[idx[cv.dataset.pos]], second[idx[cv.dataset.pos]]));
} });

const saved = LS.get("inputs", null);
if (saved) { $("fileCount").value = saved.count; $("startSerial").value = saved.start; }
syncLatestLabel();
$("btWindow").placeholder = $("fileCount").value;
showBacktestSaved();
setupTooltips();
renderFiles();
log("Lottery Analyzer ready (web version).");
