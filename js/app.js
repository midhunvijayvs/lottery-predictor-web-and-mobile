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

// IndexedDB = the browser version of the "pdf-downloads" folder
const db = (() => {
  let p;
  const open = () => p ??= new Promise((res, rej) => {
    const r = indexedDB.open("lottery-analyzer", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("pdfs");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction("pdfs", mode);
      const s = t.objectStore("pdfs");
      const req = fn(s);
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    put: (k, v) => tx("readwrite", (s) => s.put(v, k)),
    get: (k) => tx("readonly", (s) => s.get(k)),
    del: (k) => tx("readwrite", (s) => s.delete(k)),
    clear: () => tx("readwrite", (s) => s.clear()),
    all: async () => {
      const d = await open();
      return new Promise((res, rej) => {
        const items = [];
        const r = d.transaction("pdfs").objectStore("pdfs").openCursor();
        r.onsuccess = () => { const c = r.result; if (c) { items.push([c.key, c.value]); c.continue(); } else res(items); };
        r.onerror = () => rej(r.error);
      });
    },
  };
})();

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
  document.querySelectorAll(".controls .btn").forEach((b) => (b.disabled = on));
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

// ---------- file list ----------
async function renderFiles() {
  const items = (await db.all()).sort((a, b) => a[0] - b[0]);
  const ol = $("fileList");
  ol.innerHTML = "";
  for (const [k, v] of items) {
    const li = document.createElement("li");
    li.value = k;
    li.textContent = `${k}.pdf — ${v.name} (${Math.round(v.size / 1024)} KB)`;
    ol.append(li);
  }
  $("fileSummary").textContent = items.length ? `${items.length} file(s)` : "none";
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
  let lastErr;
  for (const go of attempts) {
    try {
      const r = await go();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      return { buf, type: r.headers.get("Content-Type") || "" };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function updatePdfFiles() {
  const inp = readInputs(); if (!inp) return;
  busy(true);
  try {
    log("Downloading PDF files...");
    log("------------------------------------------");
    const failed = [], got = [];
    for (let i = 1; i <= inp.count; i++) {
      const serial = inp.start + i - 1;
      const url = core.RESULT_URL(serial);
      log(`Downloading from: ${url}`); await tick();
      try {
        const { buf, type } = await fetchPdf(url);
        if (!type.includes("application/pdf") && !isPdf(buf)) {
          log(`Skipped ${i}: Not a PDF file.`, "yellow"); failed.push({ i, serial, url }); continue;
        }
        if (buf.byteLength === 0) { log(`Skipped ${i}: empty file.`, "yellow"); failed.push({ i, serial, url }); continue; }
        got.push([i, { name: `draw ${serial}`, serial, size: buf.byteLength, data: buf }]);
        log(`Downloaded ${i}.pdf`);
      } catch (e) {
        log(`Error downloading ${i}: ${e.message || e}`, "red");
        failed.push({ i, serial, url });
      }
    }
    log("All PDF Downloads completed!!"); newline();
    if (got.length) {
      // only now replace the old files (delete_all_pdfs) — so a blocked download never wipes them
      log("Deleting old PDF files..."); await db.clear();
      for (const [k, v] of got) await db.put(k, v);
      log(`Saved ${got.length} new PDF file(s).`); newline();
    } else {
      log("Nothing downloaded — your previously stored PDF files were kept.", "yellow"); newline();
    }
    await verifyPdfs();
    showManual(failed);
  } finally { busy(false); }
}

async function verifyPdfs() {
  log("Verifying PDF files...");
  const items = await db.all();
  const kept = [], deleted = [];
  for (const [k, v] of items) {
    if (!v.size || !isPdf(v.data)) { await db.del(k); deleted.push(`${k}.pdf`); }
    else kept.push(`${k}.pdf`);
  }
  let report = "Verification Report\n--------------------\n" +
    `>>> Total files scanned: ${items.length}\n>>> Deleted invalid files: ${deleted.length}\n>>> Valid files kept: ${kept.length}`;
  if (deleted.length) report += "\n\n>>> Deleted Files:\n" + deleted.join("\n");
  if (kept.length) report += "\n\n>>> Valid Files:\n" + kept.join("\n");
  log(report); newline();
  await renderFiles();
}

function showManual(failed) {
  const box = $("manualBox");
  if (!failed.length) { box.hidden = true; return; }
  const ol = $("manualLinks");
  ol.innerHTML = "";
  for (const f of failed) {
    const li = document.createElement("li");
    li.value = f.i;
    const a = document.createElement("a");
    a.href = f.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = `Draw serial ${f.serial}`;
    li.append(a);
    ol.append(li);
  }
  box.hidden = false;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Add PDFs manually (replaces the files with the picked ones) ----------
async function addPdfs(files) {
  if (!files.length) return;
  busy(true);
  try {
    const list = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    await db.clear();
    let i = 0;
    for (const f of list) {
      const buf = await f.arrayBuffer();
      if (!isPdf(buf)) { log(`Skipped ${f.name}: not a PDF file.`, "yellow"); continue; }
      i++;
      await db.put(i, { name: f.name, size: buf.byteLength, data: buf });
      log(`Added ${f.name} as ${i}.pdf`);
    }
    $("fileCount").value = i || $("fileCount").value;
    readInputs();
    log(`${i} PDF file(s) ready. Tap Analyze!`, "yellow", true);
    $("manualBox").hidden = true;
    await renderFiles();
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

async function analyzeAndShow() {
  const inp = readInputs(); if (!inp) return;
  busy(true);
  try {
    log(" Extracting text from PDF Files...."); newline();
    const texts = [];
    for (let i = 1; i <= inp.count; i++) {
      log(` extracting data from PDF file ${i}.pdf.....`); await tick();
      const rec = await db.get(i);
      if (!rec) { log(`File not found: ${i}.pdf`, "red"); continue; }
      try { texts.push(await extractText(rec.data)); }
      catch (e) { log(`Could not read ${i}.pdf: ${e.message || e}`, "red"); }
    }
    log(" Data extraction Completed!!"); newline();
    if (!texts.length) { log("No PDF files to analyze. Use Update PDF Files or Add PDFs first.", "red", true); return; }

    log(" Splitting the text data into words and filtering numbers....");
    const { numbers, four, result } = core.runAnalysis(texts);
    log(" Data Splitting and filtering completed!!");
    logCollapsible(`The result number word array (${numbers.length}) — tap to expand`, numbers);
    newline();
    log(" Collecting 4 digit numbers from the data....");
    logCollapsible(`Extracted 4 digit numbers from all the pdf files (${four.length}) — tap to expand`, four);
    newline();
    log("Total number of numbers in the above list: " + four.length);
    log(`Total number of pdf files: ${texts.length}`);
    log(`Expected number of 4 digit results per files: ${core.EXPECTED_PER_FILE}`);
    log(`Total number of expected 4 digit results: ${texts.length} x ${core.EXPECTED_PER_FILE} = ${texts.length * core.EXPECTED_PER_FILE}`);
    log("------------------------------------------------------------");
    newline();
    log("  Analyzing the data.... ");

    LS.set("lastResult", { ...result, at: new Date().toISOString(), files: texts.length, numbers: four.length });
    showResult();
  } finally { busy(false); }
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

// ---------- settings ----------
function openSettings() {
  const s = LS.get("settings", { mode: "1", proxy: "" });
  document.querySelectorAll("input[name=mode]").forEach((r) => (r.checked = r.value === s.mode));
  $("proxyUrl").value = s.proxy || "";
  $("proxyUrl").placeholder = core.DEFAULT_PROXY;
  $("settingsDlg").showModal();
}
$("settingsDlg").addEventListener("close", () => {
  if ($("settingsDlg").returnValue !== "save") return;
  const mode = document.querySelector("input[name=mode]:checked")?.value || "1";
  LS.set("settings", { mode, proxy: $("proxyUrl").value.trim() });
  log(`Settings saved. Analysis mode option ${mode}.`);
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
$("addBtn").onclick = () => $("filePicker").click();
$("filePicker").onchange = (e) => { addPdfs(e.target.files); e.target.value = ""; };
$("analyzeBtn").onclick = analyzeAndShow;
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
setupTooltips();
renderFiles();
log("Lottery Analyzer ready (web version).");
