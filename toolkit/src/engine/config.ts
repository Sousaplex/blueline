import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface DesignerConfig {
  provider: string;        // Pi provider id, e.g. "moonshotai", "anthropic"
  model: string;           // model id within that provider
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  apiKeyEnv?: string;      // env var holding the API key for the provider
}

export interface PresscheckConfig {
  designer: DesignerConfig;
  images: { provider: string; model: string; variantsPerPrompt: number; apiKeyEnv?: string };
  reviewer: { provider: string; model: string; maxRounds: number; apiKeyEnv?: string };
  render: { format: string; printBackground: boolean; preferCSSPageSize: boolean };
  webFetch: { maxFetchesPerRun: number; maxContentChars: number };
}

const DEFAULTS: Pick<PresscheckConfig, "webFetch"> = {
  webFetch: { maxFetchesPerRun: 10, maxContentChars: 20_000 },
};

// repo root = ../../.. from this file (toolkit/src/engine/config.ts)
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Load REPO_ROOT/.env into process.env (existing env wins). Keeps API keys working
// in contexts without a shell environment (Electron app, launchd, etc).
const envPath = resolve(REPO_ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "");
    process.env[m[1]] ??= value;
  }
}

export function loadConfig(): PresscheckConfig {
  const configPath = resolve(REPO_ROOT, "config", "providers.json");
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

export function requireApiKey(envVar: string | undefined, what: string): string | undefined {
  if (!envVar) return undefined;
  const key = process.env[envVar];
  if (!key) throw new Error(`${what}: environment variable ${envVar} is not set`);
  return key;
}
