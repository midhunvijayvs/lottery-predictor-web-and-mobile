# Lottery Analyzer (Web / Mobile)

Web and installable mobile (PWA) version of the **Lottery-Predictor** Tkinter app.
It uses the same core logic, ported line-for-line from `FunctionsModule.py` to `js/core.js`:

1. Get the Kerala lottery result PDFs (draw serials `start … start+N-1`)
2. Extract all text, keep whole-number words, then keep the **4-digit** ones
3. Count how often each digit 0–9 appears in each position (D3 thousands … D0 units)
4. Show the frequency table, the **most** and **second-most** repeated digit per position,
   the 16 **positional combinations**, and four bar charts
5. Save the last result so **Show Last Result!** works later

Python, a venv and a server aren't needed. Everything runs in the browser. PDF text is read with
[pdf.js](https://mozilla.github.io/pdf.js/), which is bundled in `vendor/pdfjs` so the app also works offline.

Verified: on the same 7 PDFs, the web version gives exactly the same result as the Python app
(4,248 numbers, identical digit counts in `last_analysis_report.txt`).

## Getting the PDFs

* **Update PDF files with latest n Results** (n = No. of Files) finds the newest published draw by itself,
  then selects the latest n draws. The app estimates today's serial from the date (one draw per day),
  then checks the site to find the newest serial that actually has a result, because some days have no draw.
* **Update PDF Files** selects n draws starting from the Start Serial No., the same as the Python app.

Every PDF is downloaded **once** and saved in a permanent archive in the browser (IndexedDB), organised by
draw serial. Both buttons only download the draws that aren't saved yet. "Stored PDF files" shows which
draws are selected for Analyze. The numbers read from each PDF are also saved, so they're parsed only once.
Settings (gear icon) shows the archive size and can delete it.

Downloads go through the Cloudflare Worker in `proxy/cloudflare-worker.js`, because the result site blocks
direct downloads from other websites. The built-in proxy URL is in `js/core.js` (`DEFAULT_PROXY`).

## Backtest

The Backtest walks forward through history. It predicts each of the last N draws (default 300) using the
`window` draws before it (default: No. of Files) with exactly the same algorithm. For each draw it counts
how many of the 16 combinations appear among that draw's 4-digit numbers, and compares the total with
what 16 random picks would score. The z value measures how far the result is from random, in "luck units".
Between -2 and +2 is normal luck. "Compare windows" runs windows 3, 7, 15 and 30 side by side. The first run
downloads about 330 draws (about 45 MB); after that it runs from the archive in a few seconds.

## Host on GitHub Pages

```bash
cd "D:\soulcast projects\lottery-predictor-web-and-mobile"
git add .
git commit -m "Describe your change"
git push
```

Then on GitHub, go to **Settings → Pages → Source: Deploy from a branch → RemoteMain / (root) → Save**.
After about a minute, the app is live at `https://midhunvijayvs.github.io/lottery-predictor-web-and-mobile/`.

Pages on a free account needs a **public** repo. If you want it private, use GitHub Pro, or
Netlify / Cloudflare Pages (both free and they work with private repos).

## Install on your phone

Open the link in **Chrome** on Android, then use the **⋮ menu → Install app** (or "Add to Home screen").
The in-app **Install app** button also appears when Chrome allows it.

## Run locally on a PC

Service workers and modules need `http://`, not `file://`. From this folder:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## Updating the app

After you change any file, bump `VERSION` in `sw.js` (for example `lottery-analyzer-v2`) and push.
Installed phones pick up the new version the next time they open the app.

## Files

| File | Purpose |
|---|---|
| `index.html` | UI layout (replaces the Tkinter window) |
| `css/styles.css` | Styling (same dark theme and pink buttons) |
| `js/core.js` | Core analysis logic (port of `FunctionsModule.py`) |
| `js/app.js` | UI actions: download, add, analyze, show result, charts, settings |
| `sw.js`, `manifest.webmanifest`, `icons/` | Make it an installable, offline-capable app |
| `vendor/pdfjs/` | PDF text extraction library (Apache-2.0) |
| `proxy/cloudflare-worker.js` | Optional download proxy |
