import { useEffect, useRef, useState } from "react";
import type { EngineClient, ProjectState } from "../engine-client";

type Mode = "proof" | "live";

interface Actions {
  updateCopy(pcId: string, text: string): Promise<void>;
  selectVariant(id: string, v: number): Promise<void>;
  render(): Promise<void>;
}

export function PreviewPane({
  project,
  client,
  cacheKey,
  actions,
}: {
  project: ProjectState;
  client: EngineClient;
  cacheKey: number;
  actions: Actions;
}) {
  const [mode, setMode] = useState<Mode>("proof");
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(0);
  const [dirty, setDirty] = useState(false); // page.html changed since last render
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!project.hasProof) return setPageCount(0);
    client.proofMeta().then(({ pages }) => {
      setPageCount(pages);
      setPage((p) => Math.min(p, Math.max(0, pages - 1)));
    });
  }, [client, cacheKey, project.hasProof]);

  // Wire inline copy editing inside the same-origin live iframe:
  // hover outline + contenteditable on click; blur persists via updateCopy.
  const armLiveEditing = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const style = doc.createElement("style");
    style.textContent = `
      [data-pc-id]:hover { outline: 2px dashed rgba(193,103,60,.8); outline-offset: 2px; cursor: text; }
      [data-pc-id]:focus { outline: 2px solid rgba(193,103,60,1); outline-offset: 2px; }
    `;
    doc.head.appendChild(style);
    doc.querySelectorAll<HTMLElement>("[data-pc-id]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        el.setAttribute("contenteditable", "plaintext-only");
        el.focus();
      });
      el.addEventListener("blur", () => {
        el.removeAttribute("contenteditable");
        const pcId = el.getAttribute("data-pc-id")!;
        void actions.updateCopy(pcId, el.textContent ?? "").then(() => setDirty(true));
      });
    });
  };

  if (!project.hasPage) {
    return (
      <main className="preview-pane empty">
        <p>No page.html yet — hit <strong>Run ▶</strong> to let the agent draft the piece.</p>
      </main>
    );
  }

  return (
    <main className="preview-pane">
      <div className="preview-toolbar">
        <div className="tabs">
          <button className={mode === "proof" ? "active" : ""} onClick={() => setMode("proof")}>
            Proof (PDF)
          </button>
          <button className={mode === "live" ? "active" : ""} onClick={() => setMode("live")}>
            Live (edit)
          </button>
        </div>
        {mode === "proof" && pageCount > 1 && (
          <div className="pager">
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>◂</button>
            <span> page {page + 1}/{pageCount} </span>
            <button disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>▸</button>
          </div>
        )}
        {dirty && (
          <button
            className="dirty-banner"
            onClick={() => void actions.render().then(() => setDirty(false))}
            title="page.html changed since the proof was rendered"
          >
            changes not in proof — Re-render ⎙
          </button>
        )}
      </div>

      <div className="preview-stage">
        {mode === "proof" ? (
          project.hasProof && pageCount > 0 ? (
            <img className="proof-page" src={client.proofPageUrl(page, cacheKey)} alt={`proof page ${page + 1}`} />
          ) : (
            <p className="dim">No proof.pdf yet — Re-render ⎙ or Run ▶.</p>
          )
        ) : (
          <iframe
            ref={iframeRef}
            className="live-frame"
            title="live preview"
            src={client.fileUrl("page.html", cacheKey)}
            onLoad={armLiveEditing}
          />
        )}
      </div>

      {project.images.length > 0 && (
        <div className="variant-bar">
          {project.images.map((slot) => (
            <div className="variant-slot" key={slot.id}>
              <span className="slot-name">{slot.id}</span>
              <button
                disabled={!slot.current || slot.current <= Math.min(...slot.variants)}
                onClick={() => void actions.selectVariant(slot.id, slot.current! - 1).then(() => setDirty(true))}
              >
                ◂
              </button>
              <span>v{slot.current ?? "?"}/{slot.variants.length}</span>
              <button
                disabled={!slot.current || slot.current >= Math.max(...slot.variants)}
                onClick={() => void actions.selectVariant(slot.id, slot.current! + 1).then(() => setDirty(true))}
              >
                ▸
              </button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
