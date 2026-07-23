// Gemini API pricing (USD), used to ESTIMATE the cost of a design run. Text prices are
// per 1M tokens; image prices are per generated image. Confirm against
// https://ai.google.dev/gemini-api/docs/pricing when models or rates change — these were
// taken from that page and the UI labels the total "estimated". Callers pass already-
// resolved model ids (nicknames like "nano-banana-2" are resolved before pricing).

interface TextRate {
  inTok: number;
  outTok: number;
}
interface ImageRate {
  inTok: number;
  perImage: number;
}

export const GEMINI_PRICING: Record<string, TextRate | ImageRate> = {
  "gemini-3.6-flash": { inTok: 1.5, outTok: 7.5 },
  "gemini-3.5-flash": { inTok: 1.5, outTok: 9.0 },
  "gemini-3.1-pro": { inTok: 2.0, outTok: 12.0 },
  "gemini-2.5-flash": { inTok: 0.3, outTok: 2.5 },
  "gemini-2.5-flash-lite": { inTok: 0.1, outTok: 0.4 },
  "gemini-2.5-pro": { inTok: 1.25, outTok: 10.0 },
  "gemini-3.1-flash-image": { inTok: 0.5, perImage: 0.067 },
  "gemini-3-pro-image": { inTok: 2.0, perImage: 0.134 },
  "gemini-2.5-flash-image": { inTok: 0.3, perImage: 0.039 },
};

const DEFAULT_TEXT: TextRate = { inTok: 1.5, outTok: 9.0 };
const DEFAULT_PER_IMAGE = 0.067;

function rate(model: string): TextRate | ImageRate {
  return GEMINI_PRICING[model] ?? DEFAULT_TEXT;
}

/** Cost of a text/vision call from its token counts. */
export function textCost(model: string, inputTok: number, outputTok: number): number {
  const r = rate(model);
  const inRate = "inTok" in r ? r.inTok : DEFAULT_TEXT.inTok;
  const outRate = "outTok" in r ? (r as TextRate).outTok : DEFAULT_TEXT.outTok;
  return (inputTok / 1e6) * inRate + (outputTok / 1e6) * outRate;
}

/** Cost of N generated images from the image model. */
export function imageCost(model: string, n: number): number {
  const r = rate(model);
  const per = "perImage" in r ? r.perImage : DEFAULT_PER_IMAGE;
  return n * per;
}

export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
