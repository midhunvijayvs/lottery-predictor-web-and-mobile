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

* **Update PDF Files** first tries to download directly. The result site usually blocks this from
  other websites (CORS). When it does, the app lists a link for each draw.
* **Add PDFs from phone**: open those links, save the PDFs, then pick them all here. They're
  numbered 1.pdf, 2.pdf … in name order.
* Optional: deploy `proxy/cloudflare-worker.js` (free Cloudflare Worker) and paste its URL in
  **Settings → Download proxy**. **Update PDF Files** then downloads automatically.

Downloaded and added PDFs are stored in the browser (IndexedDB), like the old `pdf-downloads` folder.

## Host on GitHub Pages

```bash
cd "D:\soulcast projects\Lottery-Predictor-Web"
git init
git add .
git commit -m "Lottery Analyzer web app"
git branch -M main
git remote add origin https://github.com/<your-user>/lottery-analyzer-web.git
git push -u origin main
```

Then on GitHub, go to **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**.
After about a minute, the app is live at `https://<your-user>.github.io/lottery-analyzer-web/`.

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
