// Blueline Import — rebuilds a Blueline document as real, editable Figma layers.
//
// Input is scene.json from Blueline's Export → Figma scene. The Plugin API is the only
// sanctioned way to create Figma nodes (the REST API is read-only, and .fig is an
// undocumented binary format), so this runs in Figma rather than writing a file.
//
// Plain JS on purpose: no build step, no node_modules. Clone the repo, point Figma at
// this folder's manifest.json, done.

const FIGMA_WEIGHT_NAMES = {
  100: ["Thin", "Hairline"],
  200: ["Extra Light", "ExtraLight", "Ultra Light"],
  300: ["Light"],
  400: ["Regular", "Book", "Normal"],
  500: ["Medium"],
  600: ["Semi Bold", "SemiBold", "Demi Bold"],
  700: ["Bold"],
  800: ["Extra Bold", "ExtraBold", "Ultra Bold"],
  900: ["Black", "Heavy"],
};

const FALLBACK_FAMILY = "Inter";

/** family|weight|italic -> the FontName Figma actually accepted. Filled during preload. */
const resolvedFonts = new Map();
const fontKey = (family, weight, italic) => family + "|" + weight + "|" + italic;

/**
 * Find a loadable FontName for a (family, weight, italic) triple.
 * Tries the real family across its plausible style names, then Inter, then Inter Regular —
 * so a webfont Figma has never heard of degrades instead of throwing.
 */
async function resolveFont(family, weight, italic) {
  const names = FIGMA_WEIGHT_NAMES[weight] || FIGMA_WEIGHT_NAMES[400];
  const candidates = [];
  for (const fam of [family, FALLBACK_FAMILY]) {
    for (const base of names) {
      candidates.push({ family: fam, style: italic ? base + " Italic" : base });
    }
    // An italic run in a family that has no italic cut still deserves the right weight.
    if (italic) for (const base of names) candidates.push({ family: fam, style: base });
  }
  candidates.push({ family: FALLBACK_FAMILY, style: "Regular" });

  for (const candidate of candidates) {
    try {
      await figma.loadFontAsync(candidate);
      return candidate;
    } catch (e) {
      /* not available in this file — try the next */
    }
  }
  return null;
}

async function preloadFonts(fonts, report) {
  const missing = new Set();
  for (const font of fonts) {
    const resolved = await resolveFont(font.family, font.weight, font.italic);
    if (!resolved) continue;
    resolvedFonts.set(fontKey(font.family, font.weight, font.italic), resolved);
    if (resolved.family !== font.family) missing.add(font.family);
  }
  if (missing.size) {
    report("Substituted " + FALLBACK_FAMILY + " for missing font(s): " + [...missing].join(", "));
  }
}

/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" -> { color: {r,g,b}, opacity }. */
function parseColor(css) {
  if (!css) return null;
  const m = /rgba?\(([^)]+)\)/.exec(css);
  if (!m) return null;
  const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return {
    color: { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255 },
    opacity: parts.length > 3 ? parts[3] : 1,
  };
}

function solidPaint(css) {
  const parsed = parseColor(css);
  if (!parsed || parsed.opacity === 0) return null;
  return [{ type: "SOLID", color: parsed.color, opacity: parsed.opacity }];
}

function applyCorners(node, radii) {
  if (!radii) return;
  const [tl, tr, br, bl] = radii;
  if (!tl && !tr && !br && !bl) return;
  node.topLeftRadius = tl;
  node.topRightRadius = tr;
  node.bottomRightRadius = br;
  node.bottomLeftRadius = bl;
}

/** Figma's base64Decode isn't in every API version — keep a decoder for the older ones. */
function base64ToBytes(b64) {
  if (typeof figma.base64Decode === "function") return figma.base64Decode(b64);
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array((clean.length * 3) >> 2);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (CHARS.indexOf(clean[i]) << 18) |
      (CHARS.indexOf(clean[i + 1]) << 12) |
      ((clean[i + 2] ? CHARS.indexOf(clean[i + 2]) : 0) << 6) |
      (clean[i + 3] ? CHARS.indexOf(clean[i + 3]) : 0);
    bytes[p++] = (n >> 16) & 255;
    if (clean[i + 2]) bytes[p++] = (n >> 8) & 255;
    if (clean[i + 3]) bytes[p++] = n & 255;
  }
  return bytes.subarray(0, p);
}

const TEXT_CASE = { uppercase: "UPPER", lowercase: "LOWER", capitalize: "TITLE" };
const TEXT_ALIGN = { left: "LEFT", center: "CENTER", right: "RIGHT", justified: "JUSTIFIED" };

function createRect(node) {
  const rect = figma.createRectangle();
  rect.name = "Rect";
  rect.x = node.x;
  rect.y = node.y;
  rect.resize(Math.max(0.01, node.width), Math.max(0.01, node.height));
  rect.fills = solidPaint(node.fill) || [];
  applyCorners(rect, node.cornerRadii);
  if (node.stroke) {
    const strokePaint = solidPaint(node.stroke.color);
    if (strokePaint) {
      rect.strokes = strokePaint;
      rect.strokeWeight = node.stroke.weight;
      rect.strokeAlign = "INSIDE"; // matches the CSS border box
    }
  }
  if (node.opacity < 1) rect.opacity = node.opacity;
  return rect;
}

function createText(node) {
  const font = resolvedFonts.get(fontKey(node.fontFamily, node.fontWeight, node.italic));
  if (!font) return null; // no loadable face — skip rather than throw mid-import
  const text = figma.createText();
  text.fontName = font;
  text.characters = node.characters;
  text.fontSize = Math.max(1, node.fontSize);
  text.x = node.x;
  text.y = node.y;
  // Fixed box matching the measured layout, so reflow can't shuffle the composition.
  text.textAutoResize = "NONE";
  text.resize(Math.max(1, node.width), Math.max(1, node.height));
  text.fills = solidPaint(node.color) || [];
  text.textAlignHorizontal = TEXT_ALIGN[node.textAlign] || "LEFT";
  text.textAlignVertical = "TOP";
  text.lineHeight = node.lineHeightPx ? { value: node.lineHeightPx, unit: "PIXELS" } : { unit: "AUTO" };
  text.letterSpacing = { value: node.letterSpacingPx || 0, unit: "PIXELS" };
  if (TEXT_CASE[node.textTransform]) text.textCase = TEXT_CASE[node.textTransform];
  text.name = node.characters.slice(0, 40) || "Text";
  if (node.opacity < 1) text.opacity = node.opacity;
  return text;
}

function createImage(node) {
  // A clipping frame + an inner rectangle reproduces Blueline's crop model exactly:
  // the frame is the crop window, the rectangle is the photo's own box inside it.
  const frame = figma.createFrame();
  frame.name = "Image";
  frame.x = node.x;
  frame.y = node.y;
  frame.resize(Math.max(0.01, node.width), Math.max(0.01, node.height));
  frame.clipsContent = true;
  frame.fills = [];
  applyCorners(frame, node.cornerRadii);

  const image = figma.createImage(base64ToBytes(node.dataBase64));
  const photo = figma.createRectangle();
  photo.name = "Photo";
  photo.x = node.inner.x;
  photo.y = node.inner.y;
  photo.resize(Math.max(0.01, node.inner.width), Math.max(0.01, node.inner.height));
  photo.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
  frame.appendChild(photo);
  if (node.opacity < 1) frame.opacity = node.opacity;
  return frame;
}

async function build(scene, report) {
  await preloadFonts(scene.fonts || [], report);

  const container = figma.createFrame();
  container.name = scene.name || "Blueline import";
  container.fills = [];
  container.clipsContent = false;
  container.layoutMode = "HORIZONTAL";
  container.itemSpacing = 80;
  container.counterAxisSizingMode = "AUTO";
  container.primaryAxisSizingMode = "AUTO";

  let skipped = 0;
  for (const page of scene.pages) {
    const frame = figma.createFrame();
    frame.name = scene.pages.length > 1 ? "Page " + (page.index + 1) : scene.name || "Page";
    frame.resize(page.width, page.height);
    frame.clipsContent = true;
    frame.fills = solidPaint(page.background) || [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];

    for (const node of page.nodes) {
      let created = null;
      try {
        if (node.kind === "rect") created = createRect(node);
        else if (node.kind === "text") created = createText(node);
        else if (node.kind === "image") created = createImage(node);
      } catch (e) {
        created = null;
      }
      // Appending in scene order preserves paint order: later nodes land on top.
      if (created) frame.appendChild(created);
      else skipped++;
    }
    container.appendChild(frame);
  }

  figma.currentPage.appendChild(container);
  figma.viewport.scrollAndZoomIntoView([container]);
  figma.currentPage.selection = [container];
  return { pages: scene.pages.length, skipped };
}

figma.showUI(__html__, { width: 380, height: 300 });

figma.ui.onmessage = async (msg) => {
  if (msg.type !== "import") return;
  const notes = [];
  const report = (m) => notes.push(m);
  try {
    const scene = JSON.parse(msg.json);
    if (!scene || scene.version !== 1 || !Array.isArray(scene.pages)) {
      throw new Error("Not a Blueline scene file (expected version 1).");
    }
    for (const w of scene.warnings || []) notes.push(w);
    const result = await build(scene, report);
    if (result.skipped) notes.push(result.skipped + " element(s) could not be created and were skipped.");
    figma.ui.postMessage({
      type: "done",
      message: "Imported " + result.pages + " page(s).",
      notes: notes,
    });
    figma.notify("Blueline: imported " + result.pages + " page(s)");
  } catch (err) {
    figma.ui.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
