// Mechanical dead-space detection: measure how empty each horizontal band of a
// rendered page is, so the reviewer judges from pixel facts — and catastrophic
// gaps hard-fail regardless of the vision model's mood.
import { PNG } from "pngjs";

export interface EmptyBand {
  fromPct: number; // 0-100, top of band
  toPct: number;
  widthPct: 100;
}

export interface PageWhitespace {
  page: number; // 1-based
  emptyPct: number; // share of all rows that are background-only
  interiorBands: EmptyBand[]; // contiguous empty bands not touching the page margins
}

const ROW_EMPTY_THRESHOLD = 0.985; // share of row pixels matching background
const CHANNEL_TOLERANCE = 10;
const MARGIN_PCT = 8; // bands living entirely inside the top/bottom margin are fine
const MIN_BAND_PCT = 10; // report bands taller than this

function isBg(data: Buffer, idx: number, bg: [number, number, number]): boolean {
  return (
    Math.abs(data[idx] - bg[0]) <= CHANNEL_TOLERANCE &&
    Math.abs(data[idx + 1] - bg[1]) <= CHANNEL_TOLERANCE &&
    Math.abs(data[idx + 2] - bg[2]) <= CHANNEL_TOLERANCE
  );
}

export function analyzePage(pngBuffer: Buffer, pageNumber: number): PageWhitespace {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;

  // Background = median of a border sample (corners + edge midpoints).
  const samples: [number, number, number][] = [];
  const points = [
    [2, 2], [width - 3, 2], [2, height - 3], [width - 3, height - 3],
    [Math.floor(width / 2), 2], [2, Math.floor(height / 2)],
  ];
  for (const [x, y] of points) {
    const i = (y * width + x) * 4;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  }
  const median = (vals: number[]) => vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  const bg: [number, number, number] = [
    median(samples.map((s) => s[0])),
    median(samples.map((s) => s[1])),
    median(samples.map((s) => s[2])),
  ];

  const rowEmpty: boolean[] = new Array(height);
  const step = 3; // sample every 3rd pixel
  for (let y = 0; y < height; y++) {
    let matches = 0;
    let total = 0;
    for (let x = 0; x < width; x += step) {
      total++;
      if (isBg(data, (y * width + x) * 4, bg)) matches++;
    }
    rowEmpty[y] = matches / total >= ROW_EMPTY_THRESHOLD;
  }

  let emptyRows = 0;
  const bands: EmptyBand[] = [];
  let bandStart: number | null = null;
  for (let y = 0; y <= height; y++) {
    const empty = y < height && rowEmpty[y];
    if (empty) {
      emptyRows++;
      bandStart ??= y;
    } else if (bandStart !== null) {
      const fromPct = (bandStart / height) * 100;
      const toPct = (y / height) * 100;
      const heightPct = toPct - fromPct;
      const isMargin = toPct <= MARGIN_PCT || fromPct >= 100 - MARGIN_PCT;
      if (heightPct >= MIN_BAND_PCT && !isMargin) {
        bands.push({ fromPct: Math.round(fromPct), toPct: Math.round(toPct), widthPct: 100 });
      }
      bandStart = null;
    }
  }

  return {
    page: pageNumber,
    emptyPct: Math.round((emptyRows / height) * 100),
    interiorBands: bands,
  };
}

export function describeWhitespace(pages: PageWhitespace[]): string {
  return pages
    .map((p) => {
      const bands = p.interiorBands.length
        ? p.interiorBands.map((b) => `full-width empty band from ${b.fromPct}% to ${b.toPct}% of page height (${b.toPct - b.fromPct}% tall)`).join("; ")
        : "no large interior empty bands";
      return `page ${p.page}: ${p.emptyPct}% of rows are background-only; ${bands}`;
    })
    .join("\n");
}

/** Bands so large they can never be a deliberate design choice in a brief-driven piece. */
export function catastrophicBands(pages: PageWhitespace[], thresholdPct = 14): { page: number; band: EmptyBand }[] {
  const hits: { page: number; band: EmptyBand }[] = [];
  for (const p of pages) {
    for (const band of p.interiorBands) {
      if (band.toPct - band.fromPct >= thresholdPct) hits.push({ page: p.page, band });
    }
  }
  return hits;
}
