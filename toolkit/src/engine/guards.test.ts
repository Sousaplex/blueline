// Guard tests: web_fetch safety + review round cap. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
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

const { safeRelPath, pageDims } = await import("./project.ts");
const { setElementStyle, getElementStyle } = await import("./page-edit.ts");
const { snapshotPage, undoPage, redoPage, historyDepth } = await import("./undo.ts");

test("pageDims resolves named sizes, slide presets, orientation and custom", () => {
  const base = { pages: 1, widthMm: null, heightMm: null };
  assert.deepEqual(pageDims({ ...base, pageSize: "A4", orientation: "portrait" }), { w: 210, h: 297 });
  assert.deepEqual(pageDims({ ...base, pageSize: "A4", orientation: "landscape" }), { w: 297, h: 210 });
  // slide presets are landscape-first — landscape orientation keeps them wide
  assert.deepEqual(pageDims({ ...base, pageSize: "Slide 16:9", orientation: "landscape" }), { w: 338.7, h: 190.5 });
  // custom dims are literal, orientation is baked in
  assert.deepEqual(pageDims({ ...base, pageSize: "Custom", orientation: "portrait", widthMm: 300, heightMm: 100 }), { w: 300, h: 100 });
  // unknown size falls back to A4
  assert.deepEqual(pageDims({ ...base, pageSize: "Nonsense", orientation: "portrait" }), { w: 210, h: 297 });
});

test("custom dimensions clamp through meta()", () => {
  const p = tempProject();
  p.updateMeta({ settings: { pageSize: "Custom", widthMm: 9999, heightMm: 3 } as any });
  const s = p.meta().settings;
  assert.equal(s.widthMm, 2000);
  assert.equal(s.heightMm, 50);
});

test("undo/redo restores page.html snapshots; a fresh edit clears redo", () => {
  const p = tempProject();
  writeFileSync(p.pageHtml, "<html><body>v1</body></html>");
  snapshotPage(p);
  writeFileSync(p.pageHtml, "<html><body>v2</body></html>");
  snapshotPage(p);
  writeFileSync(p.pageHtml, "<html><body>v3</body></html>");
  assert.deepEqual(historyDepth(p), { undo: 2, redo: 0 });

  undoPage(p);
  assert.ok(readFileSync(p.pageHtml, "utf8").includes("v2"));
  undoPage(p);
  assert.ok(readFileSync(p.pageHtml, "utf8").includes("v1"));
  assert.deepEqual(historyDepth(p), { undo: 0, redo: 2 });
  assert.throws(() => undoPage(p), /Nothing to undo/);

  redoPage(p);
  assert.ok(readFileSync(p.pageHtml, "utf8").includes("v2"));

  // a new edit after undo invalidates the redo branch
  snapshotPage(p);
  writeFileSync(p.pageHtml, "<html><body>v2b</body></html>");
  assert.deepEqual(historyDepth(p), { undo: 2, redo: 0 });
  assert.throws(() => redoPage(p), /Nothing to redo/);
});

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
  assert.deepEqual(meta.settings, { pageSize: "A4", orientation: "portrait", pages: 1, widthMm: null, heightMm: null });
  p.updateMeta({ displayName: "Nice Name", series: "s", settings: { pages: 999 } as any });
  const updated = p.meta();
  assert.equal(updated.displayName, "Nice Name");
  assert.equal(updated.settings.pages, 24); // clamped
  assert.equal(updated.settings.pageSize, "A4"); // merge kept defaults
});

const { updateCopy } = await import("./page-edit.ts");

test("updateCopy refuses to flatten structural containers", () => {
  const p = tempProject();
  writeFileSync(
    p.pageHtml,
    `<html><body><div data-pc-id="page"><h1 data-pc-id="headline">Hi</h1><p data-pc-id="sub">There</p></div></body></html>`,
  );
  // Leaf edits work…
  updateCopy(p, "headline", "New headline");
  // …but a container edit must throw instead of destroying its children.
  assert.throws(() => updateCopy(p, "page", "flattened text"), /layout container/);
  const html = readFileSync(p.pageHtml, "utf8");
  assert.ok(html.includes("New headline") && html.includes('data-pc-id="sub"'));
});

test("updateCopy treats any non-inline child as structure (the h3+p card case)", () => {
  const p = tempProject();
  writeFileSync(
    p.pageHtml,
    `<html><body>
      <div data-pc-id="card"><h3>Title</h3><p>Body copy.</p></div>
      <h1 data-pc-id="hero">Big <span class="accent">bold</span> claim</h1>
    </body></html>`,
  );
  // A card whose children are h3+p (no divs!) must still be protected…
  assert.throws(() => updateCopy(p, "card", "flat"), /layout container/);
  // …while inline formatting (span) does not block editing a real text element.
  updateCopy(p, "hero", "Bigger claim");
  const html = readFileSync(p.pageHtml, "utf8");
  assert.ok(html.includes("<h3>Title</h3>") && html.includes("Bigger claim"));
});

const { deleteElement, moveElement, moveElementBefore, pageSource, writePageSource, tagElement } = await import("./page-edit.ts");

test("tagElement tags via strict child-index paths only", () => {
  const p = tempProject();
  writeFileSync(
    p.pageHtml,
    `<html><body><div data-pc-id="wrap"><div class="metric"><span>75%</span><span>caption</span></div></div></body></html>`,
  );
  // body > wrap > .metric > second span
  tagElement(p, "body > *:nth-child(1) > *:nth-child(1) > *:nth-child(2)", "metric-caption");
  const html = readFileSync(p.pageHtml, "utf8");
  assert.ok(/<span data-pc-id="metric-caption">caption<\/span>/.test(html));
  assert.throws(() => tagElement(p, "body > *:nth-child(1)", "wrap2"), /already tagged/);
  assert.throws(() => tagElement(p, "div.metric", "x"), /Invalid element path/); // free CSS rejected
  assert.throws(() => tagElement(p, "body > *:nth-child(1) > *:nth-child(1) > *:nth-child(1)", "metric-caption"), /already in use/);
  assert.throws(() => tagElement(p, "body > *:nth-child(9)", "nope"), /No element/);
});

test("element delete/move/source operations", () => {
  const p = tempProject();
  writeFileSync(
    p.pageHtml,
    `<html><head><style>b{}</style></head><body><div data-pc-id="wrap"><p data-pc-id="a">A</p><p data-pc-id="b">B</p><p data-pc-id="c">C</p></div></body></html>`,
  );
  const order = () => {
    const html = readFileSync(p.pageHtml, "utf8");
    return ["a", "b", "c"].filter((id) => html.includes(`data-pc-id="${id}"`)).sort(
      (x, y) => html.indexOf(`data-pc-id="${x}"`) - html.indexOf(`data-pc-id="${y}"`),
    ).join("");
  };
  moveElement(p, "c", "up");
  assert.equal(order(), "acb");
  moveElementBefore(p, "b", "a");
  assert.equal(order(), "bac");
  moveElement(p, "b", "up"); // already first — no-op
  assert.equal(order(), "bac");
  deleteElement(p, "a");
  assert.equal(order(), "bc");
  assert.throws(() => moveElementBefore(p, "wrap", "b"), /into itself/);
  assert.throws(() => deleteElement(p, "nope"), /No element/);
  assert.throws(() => writePageSource(p, "<div>hi</div>"), /complete HTML/);
  const src = pageSource(p);
  writePageSource(p, src); // round-trip of a valid document is accepted
  assert.equal(pageSource(p), src);
});

const { Workspace } = await import("./workspace.ts");
const { saveTemplate, listTemplates, instantiateTemplate, templateBrief, deleteTemplate } = await import("./templates.ts");
const { buildSystemPrompt } = await import("./prompt.ts");

test("templates: save from project, list, instantiate into a new project", () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "pc-ws-"))).ensure();
  const { dir } = ws.createProject("invoice-master", "# Brief: monthly invoice");
  const base = new Project(dir, ws);
  writeFileSync(base.pageHtml, `<html><body><table data-pc-id="line-items"><tr><td>item</td></tr></table></body></html>`);
  base.updateMeta({ settings: { pageSize: "Letter", orientation: "portrait", pages: 2 } });

  const info = saveTemplate(base, "Invoice", "Standard client invoice");
  assert.equal(info.slug, "invoice");
  assert.equal(info.settings.pageSize, "Letter");
  assert.throws(() => saveTemplate(base, "Invoice"), /already exists/);
  assert.equal(listTemplates(ws).length, 1);
  assert.equal(templateBrief(ws, "invoice"), "# Brief: monthly invoice\n");

  const { dir: dir2 } = ws.createProject("acme-march", "# Brief: March invoice for Acme");
  const inst = instantiateTemplate(ws, "invoice", dir2);
  assert.equal(inst.slug, "invoice");
  const p2 = new Project(dir2, ws);
  assert.ok(readFileSync(p2.pageHtml, "utf8").includes('data-pc-id="line-items"'));
  p2.updateMeta({ template: inst.slug, settings: inst.settings });
  assert.equal(p2.meta().template, "invoice");
  assert.equal(p2.meta().settings.pages, 2);

  // The system prompt flips into strict fill-in-the-data mode for templated projects.
  const prompt = buildSystemPrompt(p2, config);
  assert.ok(prompt.includes("Template contract") && prompt.includes('"invoice" template'));
  assert.ok(!buildSystemPrompt(base, config).includes("Template contract"));

  deleteTemplate(ws, "invoice");
  assert.equal(listTemplates(ws).length, 0);
  assert.throws(() => instantiateTemplate(ws, "invoice", dir2), /No such template/);
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
