// viewer: localhost editor for an approved project — inline copy editing
// (contenteditable over page.html), image-variant shuffling, export.
// TODO(next slice): small HTTP server serving page.html with an edit overlay;
// export = same render path as render.ts.
const projectDir = process.argv[2];
if (!projectDir) throw new Error("usage: npm run viewer -- projects/<slug>");
throw new Error("viewer: not implemented yet");
