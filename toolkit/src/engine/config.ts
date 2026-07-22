import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DesignerConfig {
  provider: string;        // Pi provider id, e.g. "moonshotai", "anthropic"
  model: string;           // model id within that provider
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  apiKeyEnv?: string;      // env var holding the API key for the provider
}

export interface BluelineConfig {
  designer: DesignerConfig;
  images: { provider: string; model: string; variantsPerPrompt: number; apiKeyEnv?: string };
  reviewer: { provider: string; model: string; maxRounds: number; apiKeyEnv?: string };
  render: { format: string; printBackground: boolean; preferCSSPageSize: boolean };
  webFetch: { maxFetchesPerRun: number; maxContentChars: number };
  webSearch: { model: string; maxSearchesPerRun: number; apiKeyEnv?: string };
}

const DEFAULTS: Pick<BluelineConfig, "webFetch" | "webSearch"> = {
  webFetch: { maxFetchesPerRun: 10, maxContentChars: 20_000 },
  webSearch: { model: "gemini-3.5-flash", maxSearchesPerRun: 5, apiKeyEnv: "GEMINI_API_KEY" },
};

// Code root = ../../.. from this file (toolkit/src/engine/config.ts). In the
// packaged app this is <app>/Contents/Resources — read-only, code + defaults.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Data root = where mutable state lives: providers.json, workspace.json, .env,
// and the default workspace. The packaged app sets BLUELINE_HOME to the OS
// app-data dir; in dev it equals REPO_ROOT so nothing changes.
export const DATA_ROOT = process.env.BLUELINE_HOME ? resolve(process.env.BLUELINE_HOME) : REPO_ROOT;
if (DATA_ROOT !== REPO_ROOT) mkdirSync(DATA_ROOT, { recursive: true });

// Load .env from the data root (and, in dev, the repo) — existing env wins.
for (const root of new Set([DATA_ROOT, REPO_ROOT])) {
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "");
    process.env[m[1]] ??= value;
  }
}

export function loadConfig(): BluelineConfig {
  const configPath = resolve(DATA_ROOT, "config", "providers.json");
  const examplePath = resolve(REPO_ROOT, "config", "providers.example.json");
  const path = existsSync(configPath) ? configPath : examplePath;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw.designer) {
    throw new Error(
      `Missing "designer" block in ${path}. Add e.g. {"designer": {"provider": "moonshotai", "model": "<id>", "apiKeyEnv": "MOONSHOT_API_KEY"}}`,
    );
  }
  return { ...DEFAULTS, ...raw };
}

/** Persist API keys to DATA_ROOT/.env AND inject into the running process —
 *  onboarding-set keys work immediately, no relaunch. Values are never logged. */
export function saveApiKeys(keys: Record<string, string>): string[] {
  const envPath = resolve(DATA_ROOT, ".env");
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  const saved: string[] = [];
  for (const [name, value] of Object.entries(keys)) {
    if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(name)) throw new Error(`Refusing to store non-API-key variable: ${name}`);
    const v = value.trim();
    if (!v || /\s/.test(v)) throw new Error(`${name}: value looks malformed`);
    const line = `${name}=${v}`;
    const idx = lines.findIndex((l) => l.trim().startsWith(`${name}=`));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
    process.env[name] = v; // live effect for all sessions created from now on
    saved.push(name);
  }
  writeFileSync(envPath, lines.filter((l, i) => l.trim() || i < lines.length - 1).join("\n").trimEnd() + "\n", { mode: 0o600 });
  return saved;
}

/** Apply API keys to the running process in memory ONLY — no .env written. Used
 *  by the packaged app, where the Electron main process owns encrypted-at-rest
 *  custody (OS keychain) and pushes keys into the bridge live. */
export function applyApiKeys(keys: Record<string, string>): string[] {
  const applied: string[] = [];
  for (const [name, value] of Object.entries(keys)) {
    if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(name)) throw new Error(`Refusing to apply non-API-key variable: ${name}`);
    const v = value.trim();
    if (!v || /\s/.test(v)) throw new Error(`${name}: value looks malformed`);
    process.env[name] = v;
    applied.push(name);
  }
  return applied;
}

export function requireApiKey(envVar: string | undefined, what: string): string | undefined {
  if (!envVar) return undefined;
  const key = process.env[envVar];
  if (!key) throw new Error(`${what}: environment variable ${envVar} is not set`);
  return key;
}
