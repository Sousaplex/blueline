// Bridge discovery: a tiny, side-effect-free record of where the running engine
// bridge is listening. The bridge writes it on startup; the standalone MCP
// process (which knows nothing about BLUELINE_HOME or the chosen port) reads it
// so external agents always reach the app even when the port auto-fell-back off
// the default. Well-known, mode-independent location = ~/.blueline/bridge.json.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeInfo {
  port: number;
  pid: number;
  startedAt: string;
}

function dir(): string {
  return join(homedir(), ".blueline");
}

export function bridgeInfoPath(): string {
  return join(dir(), "bridge.json");
}

/** Record the port the bridge actually bound. Best-effort — never throws. */
export function writeBridgeInfo(port: number): void {
  try {
    if (!existsSync(dir())) mkdirSync(dir(), { recursive: true });
    const info: BridgeInfo = { port, pid: process.pid, startedAt: new Date().toISOString() };
    writeFileSync(bridgeInfoPath(), JSON.stringify(info, null, 2) + "\n");
  } catch {
    // discovery is a convenience, not a requirement — a failure here must not break startup
  }
}

/** Read the last-recorded bridge location, or null if none/unreadable. */
export function readBridgeInfo(): BridgeInfo | null {
  try {
    const raw = JSON.parse(readFileSync(bridgeInfoPath(), "utf8"));
    if (raw && typeof raw.port === "number" && raw.port > 0) return raw as BridgeInfo;
  } catch {
    // no bridge has run yet, or the file is being rewritten — caller falls back
  }
  return null;
}

/** Remove the record on clean shutdown so stale ports don't linger. */
export function clearBridgeInfo(): void {
  try {
    rmSync(bridgeInfoPath(), { force: true });
  } catch {
    // ignore — a leftover file is harmless; readers verify liveness anyway
  }
}
