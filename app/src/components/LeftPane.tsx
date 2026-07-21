import type { ProjectState } from "../engine-client";

export function LeftPane({
  project,
  selectedRound,
  onSelectRound,
}: {
  project: ProjectState;
  selectedRound: number | null;
  onSelectRound: (round: number | null) => void;
}) {
  const shownRound = project.rounds.find((r) => r.round === selectedRound);
  return (
    <aside className="left-pane">
      <section>
        <h3>Brief</h3>
        <pre className="brief">{project.brief || "(no brief.md)"}</pre>
      </section>
      <section>
        <h3>Context</h3>
        <ul className="file-list">
          {project.contextFiles.map((f) => (
            <li key={f}>▸ {f}</li>
          ))}
          {!project.contextFiles.length && <li className="dim">(empty)</li>}
        </ul>
      </section>
      <section>
        <h3>Styles</h3>
        <ul className="file-list">
          {project.styleFiles.map((f) => (
            <li key={f}>▸ {f}</li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Rounds</h3>
        <div className="rounds">
          {project.rounds.map((r) => (
            <button
              key={r.round}
              className={`round ${r.verdict} ${selectedRound === r.round ? "selected" : ""}`}
              title={`round ${r.round}: ${r.verdict}`}
              onClick={() => onSelectRound(selectedRound === r.round ? null : r.round)}
            >
              {r.round}
            </button>
          ))}
          {!project.rounds.length && <span className="dim">no reviews yet</span>}
        </div>
        {shownRound && (
          <div className="round-detail">
            <strong>
              Round {shownRound.round}: {shownRound.verdict === "pass" ? "✅ pass" : "✏ revise"}
            </strong>
            <ul>
              {shownRound.issues.map((issue, i) => (
                <li key={i}>
                  <em>p{issue.page} · {issue.region}:</em> {issue.problem} <span className="fix">→ {issue.fix}</span>
                </li>
              ))}
              {!shownRound.issues.length && <li className="dim">no issues</li>}
            </ul>
            {shownRound.notes && <p className="notes">{shownRound.notes}</p>}
          </div>
        )}
      </section>
    </aside>
  );
}
