// API-key custody for the packaged app. Keys are encrypted at rest with the OS
// keychain via Electron's safeStorage and kept in the app-data dir (NOT the
// workspace — so they can never be swept into a git sync). The main process
// decrypts them only into the bridge child's env at spawn; nothing readable
// touches disk. Dev/browser builds have no safeStorage and keep using .env.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

const KEY_NAME = /^[A-Z][A-Z0-9_]*_API_KEY$/;

function storePath(): string {
  return join(app.getPath("userData"), "credentials.json");
}

/** True when the OS keychain is usable (always on macOS in a normal session). */
export function keychainAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** All stored keys, decrypted. {} if none or the keychain is unavailable. */
export function loadCredentials(): Record<string, string> {
  if (!keychainAvailable() || !existsSync(storePath())) return {};
  const out: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Record<string, string>;
    for (const [name, b64] of Object.entries(raw)) {
      if (!KEY_NAME.test(name)) continue;
      try {
        out[name] = safeStorage.decryptString(Buffer.from(b64, "base64"));
      } catch {
        // a value we can't decrypt (e.g. different machine) is skipped, not fatal
      }
    }
  } catch {
    // corrupt store degrades to "no keys" rather than blocking startup
  }
  return out;
}

/** Encrypt and merge `keys` into the store. Returns the names actually saved. */
export function saveCredentials(keys: Record<string, string>): string[] {
  if (!keychainAvailable()) throw new Error("OS keychain is unavailable — cannot store credentials securely");
  const existing: Record<string, string> = existsSync(storePath())
    ? (JSON.parse(readFileSync(storePath(), "utf8")) as Record<string, string>)
    : {};
  const saved: string[] = [];
  for (const [name, value] of Object.entries(keys)) {
    const v = value.trim();
    if (!KEY_NAME.test(name)) throw new Error(`Refusing to store non-API-key variable: ${name}`);
    if (!v || /\s/.test(v)) throw new Error(`${name}: value looks malformed`);
    existing[name] = safeStorage.encryptString(v).toString("base64");
    saved.push(name);
  }
  writeFileSync(storePath(), JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
  return saved;
}

/** One-time: pull any *_API_KEY out of a legacy plaintext .env into the keychain,
 *  then strip those lines (deleting the file if nothing else remains). Idempotent. */
export function migrateEnvFile(bluelineHome: string): void {
  if (!keychainAvailable()) return;
  const envPath = join(bluelineHome, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  const found: Record<string, string> = {};
  const kept: string[] = [];
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && KEY_NAME.test(m[1]) && !line.trim().startsWith("#")) {
      found[m[1]] = m[2].replace(/^["']|["']$/g, "");
    } else {
      kept.push(line);
    }
  }
  if (!Object.keys(found).length) return;
  saveCredentials(found);
  const remainder = kept.join("\n").trim();
  if (remainder) writeFileSync(envPath, remainder + "\n", { mode: 0o600 });
  else unlinkSync(envPath);
  console.log(`[credentials] migrated ${Object.keys(found).length} key(s) from .env into the OS keychain`);
}
