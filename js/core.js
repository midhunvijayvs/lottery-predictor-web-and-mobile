// Core logic ported 1:1 from FunctionsModule.py (Lottery-Predictor).
// Pure functions only — no UI, no network — so it can be tested in Node too.

export const RESULT_URL = (serial) =>
  `https://result.keralalotteries.com/viewlotisresult.php?drawserial=${serial}`;

// Cloudflare Worker that downloads the result PDFs for the browser (see proxy/cloudflare-worker.js)
export const DEFAULT_PROXY = "https://lottery-proxy.midhunvijayvs.workers.dev/?url=";

export const EXPECTED_PER_FILE = 606;

// split_to_words_and_filter_numbers: split on whitespace, keep pure-digit words
export function splitToWordsAndFilterNumbers(s) {
  return s.split(/\s+/).filter((w) => w.length > 0 && /^[0-9]+$/.test(w));
}

// filter_4_digit_numbers
export function filter4DigitNumbers(list) {
  return list.filter((w) => w.length === 4);
}

// unpack: split each number into units/tens/hundreds/thousands digits
export function unpack(a) {
  const dig0 = [], dig1 = [], dig2 = [], dig3 = [];
  for (const v of a) {
    let t = parseInt(v, 10);
    dig0.push(t % 10); t = Math.trunc(t / 10);
    dig1.push(t % 10); t = Math.trunc(t / 10);
    dig2.push(t % 10); t = Math.trunc(t / 10);
    dig3.push(t % 10);
  }
  return [dig0, dig1, dig2, dig3];
}

// count: frequency of each digit 0-9
export function count(digitArray) {
  const r = new Array(10).fill(0);
  for (const d of digitArray) if (d >= 0 && d <= 9) r[d] += 1;
  return r;
}

// analyze -> [D0Result, D1Result, D2Result, D3Result]
export function analyze(array) {
  const [d0, d1, d2, d3] = unpack(array);
  return [count(d0), count(d1), count(d2), count(d3)];
}

// format_result_for_display: rows [digit, D3, D2, D1, D0]
export function formatResultForDisplay(D3, D2, D1, D0) {
  const out = [];
  for (let i = 0; i < 10; i++) out.push([i, D3[i], D2[i], D1[i], D0[i]]);
  return out;
}

// find_most_frequent_digits: first index of max (same as Python list.index(max()))
export function findMostFrequentDigits(D3, D2, D1, D0) {
  return [D3, D2, D1, D0].map((r) => r.indexOf(Math.max(...r)));
}

// find_second_most_frequent_digits: stable sort by count desc, take 2nd
// (Python's sorted() is stable, JS Array.prototype.sort is stable too)
export function findSecondMostFrequentDigits(D3, D2, D1, D0) {
  return [D3, D2, D1, D0].map((r) => {
    const sorted = r.map((c, d) => [d, c]).sort((a, b) => b[1] - a[1]);
    return sorted.length > 1 ? sorted[1][0] : -1;
  });
}

// generate_positional_combinations: Cartesian product of the two choices per position
export function generatePositionalCombinations(list1, list2) {
  if (list1.length !== 4 || list2.length !== 4)
    throw new Error("Both lists must contain exactly 4 digits.");
  const choices = list1.map((d, i) => [String(d), String(list2[i])]);
  let combos = [""];
  for (const opts of choices) {
    const next = [];
    for (const c of combos) for (const o of opts) next.push(c + o);
    combos = next;
  }
  return combos;
}

// Turn pdf.js text content of a page into text similar to PyMuPDF's page.get_text()
export function textFromPdfJsItems(items) {
  let s = "";
  for (const it of items) {
    s += it.str;
    s += it.hasEOL ? "\n" : " ";
  }
  return s;
}

// Full pipeline from a list of extracted text blobs -> everything the UI shows
export function runAnalysis(texts) {
  const all = texts.join("\n");
  const numbers = splitToWordsAndFilterNumbers(all);
  const four = filter4DigitNumbers(numbers);
  const [D0, D1, D2, D3] = analyze(four);
  return { numbers, four, result: { D0, D1, D2, D3 } };
}

export function deriveFromResult({ D0, D1, D2, D3 }) {
  const table = formatResultForDisplay(D3, D2, D1, D0);
  const most = findMostFrequentDigits(D3, D2, D1, D0);
  const second = findSecondMostFrequentDigits(D3, D2, D1, D0);
  const combos = generatePositionalCombinations(most, second);
  return { table, most, second, combos };
}
