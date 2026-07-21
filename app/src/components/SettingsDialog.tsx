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
      })
      .catch((e) => setError(String(e)));
    setGeminiKey("");
    setMoonshotKey("");
    void client.getSetup().then(setSetup).catch(() => setSetup(null));
  }, [open, client]);

  const providerModels = settings?.registry.find((p) => p.id === provider)?.models ?? [];
  const modelOptions = providerModels.includes(model) || !model ? providerModels : [model, ...providerModels];

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
                      {[...new Set([reviewerModel, ...settings.suggestions.reviewer])].map((m) => (
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
                      {[...new Set([imagesModel, ...settings.suggestions.images])].map((m) => (
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
