// review: rasterizes out/proof.pdf to PNGs, sends them + brief + style guide to
// the vision reviewer, writes review/round-<N>.json (ReviewResult).
// TODO(next slice): pdf->png via Playwright page screenshots or pdftoppm, then
// GeminiReviewProvider with a structured-output schema matching ReviewResult.
const projectDir = process.argv[2];
if (!projectDir) throw new Error("usage: npm run review -- projects/<slug>");
throw new Error("review: reviewer not implemented yet — see providers/types.ts");
