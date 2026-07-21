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

const { safeRelPath } = await import("./project.ts");
const { setElementStyle, getElementStyle } = await import("./page-edit.ts");

test("safeRelPath blocks traversal and absolute paths, allows subfolders", () => {
  assert.equal(safeRelPath("photos/team.jpg"), "photos/team.jpg");
  assert.equal(safeRelPath("/leading/slash.md"), "leading/slash.md");
  assert.equal(safeRelPath("win\\style\\path.png"), "win/style/path.png");
  assert.throws(() => safeRelPath("../../etc/passwd"));
  assert.throws(() => safeRelPath("a/../b.md"));
  assert.throws(() => safeRelPath("a/./b.md"));
  assert.throws(() => safeRelPath(""));
});

test("project meta defaults are safe on legacy projects and clamp settings", () => {
  const p = tempProject();
  const meta = p.meta();
  assert.equal(meta.displayName, p.slug);
  assert.deepEqual(meta.settings, { pageSize: "A4", orientation: "portrait", pages: 1 });
  p.updateMeta({ displayName: "Nice Name", series: "s", settings: { pages: 999 } as any });
  const updated = p.meta();
  assert.equal(updated.displayName, "Nice Name");
  assert.equal(updated.settings.pages, 24); // clamped
  assert.equal(updated.settings.pageSize, "A4"); // merge kept defaults
});

test("element nudge clamps offsets and round-trips through page.html", () => {
  const p = tempProject();
  writeFileSync(p.pageHtml, `<html><body><section data-pc-id="stats" style="color: red">x</section></body></html>`);
  setElementStyle(p, "stats", { translateX: 3, translateY: -2 });
  assert.deepEqual(getElementStyle(p, "stats"), { translateX: 3, translateY: -2, marginTop: null });
  setElementStyle(p, "stats", { translateX: 9999, translateY: 0, marginTop: 12 });
  const s = getElementStyle(p, "stats");
  assert.equal(s.translateX, 150); // clamped to NUDGE_LIMIT
  assert.equal(s.marginTop, 12);
  setElementStyle(p, "stats", { translateX: 0, translateY: 0, marginTop: null });
  assert.deepEqual(getElementStyle(p, "stats"), { translateX: 0, translateY: 0, marginTop: null });
  assert.throws(() => setElementStyle(p, "nope", { translateX: 1 }), /No element/);
});
