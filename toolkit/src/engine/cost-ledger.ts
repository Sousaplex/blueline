// Per-run cost accumulator. The image / review / search engine calls record their Gemini
// usage here, keyed by project dir; the bridge resets it when a run starts and reads it
// when the run ends (designer-LLM cost is added separately from Pi's token stats). This
// sidesteps threading a cost callback through Pi's tool construction.
import { imageCost, textCost } from "./pricing.ts";

export interface RunLedger {
  images: number;
  imageUsd: number;
  reviewUsd: number;
  searchUsd: number;
}

const ledgers = new Map<string, RunLedger>();

function get(dir: string): RunLedger {
  let l = ledgers.get(dir);
  if (!l) {
    l = { images: 0, imageUsd: 0, reviewUsd: 0, searchUsd: 0 };
    ledgers.set(dir, l);
  }
  return l;
}

export function recordImages(dir: string, model: string, n: number): void {
  const l = get(dir);
  l.images += n;
  l.imageUsd += imageCost(model, n);
}
export function recordReview(dir: string, model: string, inputTok: number, outputTok: number): void {
  get(dir).reviewUsd += textCost(model, inputTok, outputTok);
}
export function recordSearch(dir: string, model: string, inputTok: number, outputTok: number): void {
  get(dir).searchUsd += textCost(model, inputTok, outputTok);
}
export function resetLedger(dir: string): void {
  ledgers.delete(dir);
}
export function takeLedger(dir: string): RunLedger {
  const l = get(dir);
  ledgers.delete(dir);
  return l;
}
