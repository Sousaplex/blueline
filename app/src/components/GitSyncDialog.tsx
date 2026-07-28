// Optional workspace ↔ git sync: connect the current workspace to a repo (share
// context/styles/projects with a team, or just back it up), or clone a shared
// workspace. Uses the user's own git credentials; nothing happens unless asked.
import { Check, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DocConflict, EngineClient, GitStatus } from "../engine-client";

type Choice = "mine" | "theirs" | "fork";

export function GitSyncDialog({ client }: { client: EngineClient }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false); // revealing the "change repo" input
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [wipeHistory, setWipeHistory] = useState(false);
  const [conflicts, setConflicts] = useState<DocConflict[] | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [overwriting, setOverwriting] = useState(false);

  const refresh = () => client.gitStatus().then(setStatus).catch(() => setStatus(null));

  // Sync, but branch into conflict-resolution when the merge pauses.
  const doSync = () => {
    setBusy("sync");
    setError(null);
    setNote(null);
    void client
      .gitSync()
      .then((r) => {
        if (r.conflicts && r.conflicts.length) {
          setConflicts(r.conflicts);
          // Default every conflict to "fork" — the no-data-loss choice (keeps both versions).
          setChoices(Object.fromEntries(r.conflicts.map((c) => [c.docId, c.docId === "__shared__" ? "theirs" : "fork"])));
        } else {
          setConflicts(null);
          setNote(r.summary || "Synced.");
        }
        return refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const doOverwrite = (direction: "push" | "pull") => {
    setBusy("overwrite");
    setError(null);
    setNote(null);
    void client
      .forceOverwrite(direction)
      .then((r) => {
        setOverwriting(false);
        setConflicts(null);
        setNote(r.summary);
        return refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const doResolve = () => {
    if (!conflicts) return;
    setBusy("resolve");
    setError(null);
    setNote(null);
    void client
      .resolveConflicts(conflicts.map((c) => ({ docId: c.docId, choice: choices[c.docId] ?? "theirs" })))
      .then((r) => {
        setConflicts(null);
        const forkNote = r.forked.length ? ` Kept your version as: ${r.forked.map((f) => f.displayName).join(", ")}.` : "";
        setNote(`Resolved and pushed.${forkNote}`);
        return refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const act = (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setError(null);
    setNote(null);
    void fn()
      .then((msg) => {
        if (msg) setNote(msg);
        return refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <GitBranch data-slot="icon" /> Git
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Workspace git sync</DialogTitle>
          <DialogDescription>
            Keep this workspace in a git repo — shared source material, styles, and projects for a team,
            or just a backup. Sync pulls teammates' changes, commits yours, and pushes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {status?.isRepo && status.remote ? (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium">
                  <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
                  Connected · {status.branch ?? "main"}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{status.remote}</p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {status.dirty} local change{status.dirty === 1 ? "" : "s"}
                  {status.behind > 0 && ` · ${status.behind} behind remote`}
                  {status.ahead > 0 && ` · ${status.ahead} ahead`}
                </p>
              </div>
              <Button className="w-full" disabled={busy !== null || !!conflicts} onClick={doSync}>
                {busy === "sync" ? <Loader2 className="animate-spin" data-slot="icon" /> : <RefreshCw data-slot="icon" />}
                Sync now
              </Button>

              {conflicts && (
                <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <p className="text-sm font-medium">
                    A teammate edited the same {conflicts.length === 1 ? "document" : "documents"} — choose what to keep:
                  </p>
                  {conflicts.map((c) => (
                    <div key={c.docId} className="space-y-1">
                      <p className="truncate text-sm font-medium" title={c.files.join(", ")}>
                        {c.displayName}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          {c.files.length} file{c.files.length === 1 ? "" : "s"}
                        </span>
                      </p>
                      <div className="flex gap-1">
                        {(
                          [
                            ["fork", "Keep both"],
                            ["mine", "Keep mine"],
                            ["theirs", "Keep theirs"],
                          ] as [Choice, string][]
                        )
                          .filter(([v]) => !(v === "fork" && c.docId === "__shared__"))
                          .map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => setChoices((ch) => ({ ...ch, [c.docId]: value }))}
                              className={`flex-1 rounded border px-2 py-1 text-xs transition-colors ${
                                (choices[c.docId] ?? "theirs") === value
                                  ? "border-primary bg-primary/10 font-medium"
                                  : "text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                      </div>
                    </div>
                  ))}
                  <p className="text-[11px] text-muted-foreground">
                    <strong>Keep both</strong> saves your version as a new document (credited to you) and keeps theirs — no work lost.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" className="flex-1" disabled={busy !== null} onClick={doResolve}>
                      {busy === "resolve" ? <Loader2 className="animate-spin" data-slot="icon" /> : null} Resolve &amp; push
                    </Button>
                  </div>
                </div>
              )}

              {!changing && !confirmDisconnect && !conflicts && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1" disabled={busy !== null}
                    onClick={() => { setChanging(true); setUrl(""); setError(null); setNote(null); }}>
                    Change repo…
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1 text-destructive hover:text-destructive" disabled={busy !== null}
                    onClick={() => { setConfirmDisconnect(true); setWipeHistory(false); setError(null); setNote(null); }}>
                    Disconnect
                  </Button>
                </div>
              )}

              {changing && (
                <div className="space-y-1.5 rounded-md border p-2.5">
                  <Label htmlFor="git-newurl" className="text-xs">Repoint to a different repo (use an EMPTY repo)</Label>
                  <div className="flex gap-2">
                    <Input id="git-newurl" value={url} onChange={(e) => setUrl(e.target.value)}
                      placeholder="git@github.com:you/other.git" className="font-mono text-xs" />
                    <Button size="sm" disabled={busy !== null || !url.trim()}
                      onClick={() => act("change", async () => {
                        await client.gitConnect(url.trim());
                        setChanging(false);
                        return "Repointed. Local history is kept; the next Sync pushes to the new repo (must be empty).";
                      })}>
                      {busy === "change" ? <Loader2 className="animate-spin" data-slot="icon" /> : null} Repoint
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setChanging(false)}>Cancel</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The old repo isn't modified. Pushing into a repo that already has content is rejected — pick an empty one.
                  </p>
                </div>
              )}

              {confirmDisconnect && (
                <div className="space-y-2 rounded-md border p-2.5">
                  <p className="text-xs">
                    Disconnect from <span className="break-all font-mono">{status.remote}</span>? Local history is kept and
                    the remote repo is untouched.
                  </p>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={wipeHistory} onChange={(e) => setWipeHistory(e.target.checked)} />
                    Also erase local git history (irreversible)
                  </label>
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" disabled={busy !== null}
                      onClick={() => act("disconnect", async () => {
                        await client.gitDisconnect(wipeHistory);
                        setConfirmDisconnect(false);
                        return wipeHistory ? "Disconnected; local history erased." : "Disconnected. Local history kept.";
                      })}>
                      {busy === "disconnect" ? <Loader2 className="animate-spin" data-slot="icon" /> : null} Disconnect
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
                  </div>
                </div>
              )}

              {!changing && !confirmDisconnect && (
                overwriting ? (
                  <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
                    <p className="text-xs font-medium text-destructive">
                      Force overwrite — discards work. Use only when a sync is too tangled to merge normally.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="destructive" className="flex-1" disabled={busy !== null} onClick={() => doOverwrite("push")}>
                        {busy === "overwrite" ? <Loader2 className="animate-spin" data-slot="icon" /> : null} Push mine over remote
                      </Button>
                      <Button size="sm" variant="outline" className="flex-1" disabled={busy !== null} onClick={() => doOverwrite("pull")}>
                        Reset mine to remote
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      <strong>Push mine over remote</strong>: the repo becomes exactly your workspace — teammates' un-synced remote
                      changes are lost.
                      <br />
                      <strong>Reset mine to remote</strong>: your workspace becomes exactly the repo — your uncommitted local changes are
                      lost (brand-new files you never synced are kept).
                    </p>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setOverwriting(false)}>Cancel</Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => { setOverwriting(true); setError(null); setNote(null); }}
                  >
                    Force overwrite…
                  </button>
                )
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="git-url">Connect this workspace to a repo</Label>
              <div className="flex gap-2">
                <Input
                  id="git-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="git@github.com:you/design-workspace.git"
                  className="font-mono text-xs"
                />
                <Button
                  disabled={busy !== null || !url.trim()}
                  onClick={() =>
                    act("connect", async () => {
                      await client.gitConnect(url.trim());
                      return "Connected. Use Sync to push the workspace up.";
                    })
                  }
                >
                  {busy === "connect" ? <Loader2 className="animate-spin" data-slot="icon" /> : <GitBranch data-slot="icon" />}
                  Connect
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Create an empty repo on GitHub first (private is fine). Auth uses your existing git
                credentials. To join someone else's workspace instead, clone it from Change workspace →
                pick the cloned folder.
              </p>
            </div>
          )}

          {note && <p className="text-sm text-emerald-600 dark:text-emerald-400">{note}</p>}
          {error && <p className="break-words text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
