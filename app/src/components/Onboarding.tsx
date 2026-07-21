// First-run experience: welcome → choose where work lives → connect API keys.
// Keys are applied to the running engine immediately (no relaunch), and
// finishing persists the workspace so onboarding never shows again.
import { ArrowRight, Check, FolderOpen, HardDrive, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import logo from "../assets/logo.png";
import type { EngineClient, SetupState } from "../engine-client";

type Step = "welcome" | "workspace" | "keys";

export function Onboarding({
  client,
  setup,
  onDone,
}: {
  client: EngineClient;
  setup: SetupState;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>("welcome");
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [geminiKey, setGeminiKey] = useState("");
  const [hasGemini, setHasGemini] = useState(setup.keys.GEMINI_API_KEY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickFolder = () =>
    act(async () => {
      const ok = await client.chooseWorkspace();
      if (!ok) return;
      const state = await client.getSetup();
      setWorkspaceRoot(state.workspaceRoot);
      setStep("keys");
    });

  const useDefault = () =>
    act(async () => {
      await client.useDefaultWorkspace();
      setWorkspaceRoot(setup.defaultWorkspaceRoot);
      setStep("keys");
    });

  const saveKeyAndFinish = () =>
    act(async () => {
      if (geminiKey.trim()) {
        await client.saveKeys({ GEMINI_API_KEY: geminiKey.trim() });
        setHasGemini(true);
        setGeminiKey("");
      }
      await client.completeSetup();
      onDone();
    });

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-background p-8 text-foreground">
      <div className="w-full max-w-lg space-y-8">
        <div className="space-y-1 text-center">
          <img src={logo} alt="" className="mx-auto mb-4 size-16 rounded-2xl shadow-lg" />
          <h1 className="text-2xl font-semibold tracking-tight">blueline</h1>
          <p className="text-sm text-muted-foreground">Print-ready marketing collateral, designed and press-checked by an agent.</p>
        </div>

        {step === "welcome" && (
          <div className="space-y-6">
            <ol className="mx-auto max-w-sm space-y-3 text-sm text-muted-foreground">
              <li className="flex gap-3"><span className="font-medium text-foreground">1.</span> Brief it — audience, message, format.</li>
              <li className="flex gap-3"><span className="font-medium text-foreground">2.</span> The agent designs, renders a proof, and a vision reviewer press-checks it until it passes.</li>
              <li className="flex gap-3"><span className="font-medium text-foreground">3.</span> You polish copy, photos and spacing live, then export a print-ready PDF.</li>
            </ol>
            <div className="flex justify-center">
              <Button onClick={() => setStep("workspace")}>
                Get started <ArrowRight data-slot="icon" />
              </Button>
            </div>
          </div>
        )}

        {step === "workspace" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-medium">Where should your design work live?</h2>
              <p className="text-xs text-muted-foreground">
                The workspace folder holds every project, plus shared source material and brand styles.
              </p>
            </div>
            <button
              className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 disabled:opacity-50"
              disabled={busy}
              onClick={() => void pickFolder()}
            >
              <FolderOpen className="size-5 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">Choose a folder…</span>
                <span className="block text-xs text-muted-foreground">Pick any folder — e.g. in Documents or a synced drive.</span>
              </span>
            </button>
            <button
              className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 disabled:opacity-50"
              disabled={busy}
              onClick={() => void useDefault()}
            >
              <HardDrive className="size-5 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">Use the default location</span>
                <span className="block break-all text-xs text-muted-foreground">{setup.defaultWorkspaceRoot}</span>
              </span>
            </button>
          </div>
        )}

        {step === "keys" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-medium">Connect a model</h2>
              <p className="text-xs text-muted-foreground">
                One Google Gemini key powers design, image generation, review and research. Stored locally in the
                app's own .env — it never leaves this machine.
              </p>
            </div>
            {workspaceRoot && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" /> Workspace: <span className="break-all font-mono">{workspaceRoot}</span>
              </p>
            )}
            {hasGemini ? (
              <p className="flex items-center gap-1.5 rounded-md border bg-muted/40 p-3 text-sm">
                <Check className="size-4 text-emerald-600 dark:text-emerald-400" /> Gemini key already configured.
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="onboarding-gemini" className="flex items-center gap-1.5">
                  <KeyRound className="size-3.5" /> GEMINI_API_KEY
                </Label>
                <Input
                  id="onboarding-gemini"
                  type="password"
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                  placeholder="AIza…"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Get one free at aistudio.google.com. Other providers (e.g. Kimi K3 as the designer) can be added later in Settings.
                </p>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(async () => { await client.completeSetup(); onDone(); })}>
                Skip for now
              </Button>
              <Button disabled={busy || (!hasGemini && !geminiKey.trim())} onClick={() => void saveKeyAndFinish()}>
                {busy ? <Loader2 className="animate-spin" data-slot="icon" /> : <Check data-slot="icon" />} Finish
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
