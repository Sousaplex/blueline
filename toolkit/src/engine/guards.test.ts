// Guard tests: web_fetch safety + review round cap. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.GEMINI_API_KEY ??= "test-key-not-used";

const { fetchWeb, resetFetchBudget } = await import("./web-fetch.ts");
const { runReview, RoundLimitError } = await import("./review.ts");
const { Project } = await import("./project.ts");
const { loadConfig } = await import("./config.ts");

function tempProject(): InstanceType<typeof Project> {
  const dir = mkdtempSync(join(tmpdir(), "pc-test-"));
  writeFileSync(join(dir, "brief.md"), "# test brief");
  // Project resolves relative to REPO_ROOT; absolute paths pass through resolve() unchanged.
  return new Project(dir);
}

const deadBackend = {
  renderPdf: async () => assert.fail("render must not be called"),
  screenshot: async () => assert.fail("screenshot must not be called"),
  withPage: async () => assert.fail("browser must not be reached"),
  close: async () => {},
} as any;

const config = loadConfig();

test("web_fetch rejects non-http schemes", async () => {
  const p = tempProject();
  resetFetchBudget(p);
  await assert.rejects(fetchWeb(p, deadBackend, config, "file:///etc/passwd"), /Only http/);
});

test("web_fetch rejects localhost and private addresses", async () => {
  const p = tempProject();
  resetFetchBudget(p);
  await assert.rejects(fetchWeb(p, deadBackend, config, "http://localhost:8080/x"), /local/);
  await assert.rejects(fetchWeb(p, deadBackend, config, "https://127.0.0.1/x"), /private|local/i);
  await assert.rejects(fetchWeb(p, deadBackend, config, "https://192.168.1.10/x"), /private/);
  await assert.rejects(fetchWeb(p, deadBackend, config, "https://169.254.169.254/meta-data"), /private/);
});

test("web_fetch enforces per-run budget", async () => {
  const p = tempProject();
  resetFetchBudget(p);
  writeFileSync(join(p.fetchedDir, ".budget.json"), JSON.stringify({ used: config.webFetch.maxFetchesPerRun }));
  await assert.rejects(fetchWeb(p, deadBackend, config, "https://example.com/"), /budget exhausted/);
});

test("review refuses to run past the round cap", async () => {
  const p = tempProject();
  mkdirSync(p.reviewDir, { recursive: true });
  for (let i = 1; i <= config.reviewer.maxRounds; i++) {
    writeFileSync(join(p.reviewDir, `round-${i}.json`), JSON.stringify({ verdict: "revise", issues: [] }));
  }
  await assert.rejects(runReview(p, config), RoundLimitError);
});

test("review requires a rendered proof before reviewing", async () => {
  const p = tempProject();
  await assert.rejects(runReview(p, config), /render tool before/);
});
