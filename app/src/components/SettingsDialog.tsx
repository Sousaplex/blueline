import { Check, KeyRound, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { EngineClient, EngineSettings, SetupState } from "../engine-client";

export function SettingsDialog({ client }: { client: EngineClient }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // draft state
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("medium");
  const [reviewerModel, setReviewerModel] = useState("");
  const [maxRounds, setMaxRounds] = useState(6);
  const [imagesModel, setImagesModel] = useState("");
  const [variantsPerPrompt, setVariantsPerPrompt] = useState(2);
  const [briefModel, setBriefModel] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpPort, setMcpPort] = useState(7717);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [geminiKey, setGeminiKey] = useState("");
  const [moonshotKey, setMoonshotKey] = useState("");

  useEffect(() => {
    if (!open) return;
    setError(null);
    client
      .getSettings()
      .then((s) => {
        setSettings(s);
        setProvider(s.config.designer.provider);
        setModel(s.config.designer.model);
        setThinking(s.config.designer.thinkingLevel ?? "medium");
        setReviewerModel(s.config.reviewer.model);
        setMaxRounds(s.config.reviewer.maxRounds);
        setImagesModel(s.config.images.model);
        setVariantsPerPrompt(s.config.images.variantsPerPrompt);
        setBriefModel(s.config.brief?.model ?? s.config.reviewer.model);
        setMaxConcurrent(s.config.runs?.maxConcurrent ?? 3);
        setMcpEnabled(s.config.mcp?.enabled ?? true);
        setMcpPort(s.config.mcp?.port ?? 7717);
      })
      .catch((e) => setError(String(e)));
    setGeminiKey("");
    setMoonshotKey("");
    setAvail(null);
    void client.getSetup().then(setSetup).catch(() => setSetup(null));
    // Fetch the live model list in the background — the dialog is usable before this resolves.
    void client.listModels().then(setAvail).catch(() => setAvail({ generate: [], image: [], error: "Couldn't reach the model list." }));
  }, [open, client]);

  const [copied, setCopied] = useState(false);
  // Live Google model list — fetched SEPARATELY so it never blocks the dialog opening.
  const [avail, setAvail] = useState<{ generate: string[]; image: string[]; error?: string } | null>(null);
  const providerModels = settings?.registry.find((p) => p.id === provider)?.models ?? [];
  const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter(Boolean) as string[])];
  // Prefer the LIVE list of models the key can actually use; fall back to registry/suggestions.
  const modelOptions =
    provider === "google" && avail?.generate.length
      ? uniq([model, ...avail.generate])
      : providerModels.includes(model) || !model
        ? providerModels
        : [model, ...providerModels];
  const reviewerOptions = uniq([reviewerModel, ...(avail?.generate.length ? avail.generate : settings?.suggestions.reviewer ?? [])]);
  const imageOptions = uniq([imagesModel, ...(avail?.image.length ? avail.image : settings?.suggestions.images ?? [])]);
  const briefOptions = uniq([briefModel, ...(avail?.generate.length ? avail.generate : settings?.suggestions.reviewer ?? [])]);

  const copyDiagnostics = async () => {
    setError(null);
    try {
      const d = await client.diagnostics();
      await navigator.clipboard.writeText("```json\n" + JSON.stringify(d, null, 2) + "\n```");
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const keys: { GEMINI_API_KEY?: string; MOONSHOT_API_KEY?: string } = {};
      if (geminiKey.trim()) keys.GEMINI_API_KEY = geminiKey.trim();
      if (moonshotKey.trim()) keys.MOONSHOT_API_KEY = moonshotKey.trim();
      if (Object.keys(keys).length) await client.saveKeys(keys);
      await client.updateSettings({
        designer: { provider, model, thinkingLevel: thinking }, // apiKeyEnv is derived from the provider engine-side
        reviewer: { model: reviewerModel, maxRounds },
        images: { model: imagesModel, variantsPerPrompt },
        brief: { model: briefModel },
        runs: { maxConcurrent: Math.max(1, Math.min(10, Math.round(maxConcurrent) || 3)) },
        mcp: { enabled: mcpEnabled, port: Math.max(1024, Math.min(65535, Math.round(mcpPort) || 7717)) },
      });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Settings">
          <Settings />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Model configuration — saved to config/providers.json.</DialogDescription>
        </DialogHeader>

        {!settings && !error && <p className="text-sm text-muted-foreground">loading…</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {avail?.error && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            Couldn't reach the Google model list: {avail.error} — usually a missing or invalid API key. Add your key below, then reopen Settings.
          </p>
        )}
        {avail && !avail.error && avail.generate.length > 0 && provider === "google" && model && !avail.generate.includes(model) && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            Your designer model <span className="font-mono">{model}</span> isn't in the list Google serves for this key — that stalls generation. Pick an available model below.
          </p>
        )}

        {settings && (
          <div className="space-y-5">
            <section className="space-y-3">
              <h4 className="text-sm font-medium">Designer (layout agent)</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Provider</Label>
                  <Select
                    value={provider}
                    onValueChange={(v) => {
                      setProvider(v);
                      const models = settings.registry.find((p) => p.id === v)?.models ?? [];
                      if (!models.includes(model)) setModel(models[0] ?? "");
                    }}
                  >
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {settings.registry.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.id}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Model</Label>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {modelOptions.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Thinking</Label>
                  <Select value={thinking} onValueChange={setThinking}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["off", "minimal", "low", "medium", "high"].map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <h4 className="flex items-center gap-1.5 text-sm font-medium">
                <KeyRound className="size-3.5" /> API keys
              </h4>
              <p className="text-xs text-muted-foreground">
                Stored locally in the app's .env and applied immediately — no relaunch. Leave blank to keep the
                existing key.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1">
                    Google Gemini
                    {setup?.keys.GEMINI_API_KEY && <Check className="size-3 text-emerald-600 dark:text-emerald-400" />}
                  </Label>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={geminiKey}
                    onChange={(e) => setGeminiKey(e.target.value)}
                    placeholder={setup?.keys.GEMINI_API_KEY ? "configured" : "AIza…"}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1">
                    Moonshot (Kimi)
                    {setup?.keys.MOONSHOT_API_KEY && <Check className="size-3 text-emerald-600 dark:text-emerald-400" />}
                  </Label>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={moonshotKey}
                    onChange={(e) => setMoonshotKey(e.target.value)}
                    placeholder={setup?.keys.MOONSHOT_API_KEY ? "configured" : "sk-…"}
                  />
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <h4 className="text-sm font-medium">Reviewer (vision QA)</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Model</Label>
                  <Select value={reviewerModel} onValueChange={setReviewerModel}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {reviewerOptions.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Max rounds</Label>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    value={maxRounds}
                    onChange={(e) => setMaxRounds(Number(e.target.value))}
                  />
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <h4 className="text-sm font-medium">Images</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Model</Label>
                  <Select value={imagesModel} onValueChange={setImagesModel}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {imageOptions.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Variants per prompt</Label>
                  <Input
                    type="number"
                    min={1}
                    max={6}
                    value={variantsPerPrompt}
                    onChange={(e) => setVariantsPerPrompt(Number(e.target.value))}
                  />
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <h4 className="text-sm font-medium">Brief drafting</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Model</Label>
                  <Select value={briefModel} onValueChange={setBriefModel}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {briefOptions.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="self-center text-xs text-muted-foreground">
                  The Gemini model that expands a one-line idea into a structured brief (New project → Draft).
                </p>
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <h4 className="text-sm font-medium">Runs</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Concurrent generations</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={maxConcurrent}
                    onChange={(e) => setMaxConcurrent(Number(e.target.value))}
                  />
                </div>
                <p className="self-center text-xs text-muted-foreground">
                  How many projects generate at once (1–10). The rest queue. Higher uses more API
                  quota in parallel — 3 is a good default.
                </p>
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <h4 className="text-sm font-medium">External access (MCP)</h4>
              <p className="text-xs text-muted-foreground">
                Lets external AI agents (Claude Code, Kimi CLI…) drive Blueline through its MCP server —
                create projects, run designs, read reviews. The app itself keeps working either way.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Agent access</Label>
                  <button
                    type="button"
                    onClick={() => setMcpEnabled((v) => !v)}
                    className={`h-9 w-full rounded-md border px-3 text-sm font-medium transition-colors ${
                      mcpEnabled
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {mcpEnabled ? "On — agents allowed" : "Off — agents blocked"}
                  </button>
                </div>
                <div className="space-y-1.5">
                  <Label>Preferred port</Label>
                  <Input
                    type="number"
                    min={1024}
                    max={65535}
                    value={mcpPort}
                    onChange={(e) => setMcpPort(Number(e.target.value))}
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                If this port is busy Blueline picks a free one automatically. Turning access on/off applies
                immediately; a port change takes effect next time you launch the app.
              </p>
            </section>

            <Separator />

            <section className="space-y-2">
              <h4 className="text-sm font-medium">Debug</h4>
              <p className="text-xs text-muted-foreground">
                Something not working? Copy a diagnostics report (app version, configured models, which models your key can
                actually use, and recent errors — no secrets) and paste it when asking for help.
              </p>
              <Button variant="outline" size="sm" onClick={() => void copyDiagnostics()}>
                {copied ? <Check data-slot="icon" /> : null}
                {copied ? "Copied to clipboard" : "Copy diagnostics"}
              </Button>
            </section>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !settings}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
