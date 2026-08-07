// Human-readable auto-update progress. Pure functions, no React, no Electron — the
// numbers arrive verbatim from electron-updater's ProgressInfo and this module is the
// only thing standing between a 223 MB download and "is this thing frozen?".
//
// Why this matters more than it looks: the mac update payload is the WHOLE app
// (Electron + toolkit/node_modules), differential download is best-effort and usually
// falls back to a full transfer, and there is a genuinely silent phase after the bytes
// land while Squirrel.Mac unpacks the zip. A bare percentage made all three look
// identical to a hang.

export interface UpdateProgress {
  percent: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  if (n >= KB) return `${Math.round(n / KB)} KB`;
  return `${Math.round(n)} B`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  if (bytesPerSecond >= MB) return `${(bytesPerSecond / MB).toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSecond / KB)} KB/s`;
}

/** Coarse, honest ETA — deliberately vague ("about 2 min") because transfer rates wobble. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 10) return "a few seconds left";
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5}s left`;
  if (seconds < 3600) return `about ${Math.max(1, Math.round(seconds / 60))} min left`;
  const hours = seconds / 3600;
  return `about ${hours < 2 ? "1 hour" : `${Math.ceil(hours)} hours`} left`;
}

/** True once every byte has landed — from here Squirrel.Mac unpacks, and emits nothing. */
export function isUnpacking(p: UpdateProgress): boolean {
  if (typeof p.total === "number" && typeof p.transferred === "number" && p.total > 0) {
    return p.transferred >= p.total;
  }
  return p.percent >= 100;
}

/**
 * The line under the spinner. Degrades gracefully: full detail when electron-updater
 * gives us byte counts and a rate, down to a bare percentage when it doesn't.
 */
export function describeProgress(p: UpdateProgress): string {
  const percent = Math.max(0, Math.min(100, Math.round(p.percent)));
  const parts: string[] = [];

  if (typeof p.transferred === "number" && typeof p.total === "number" && p.total > 0) {
    parts.push(`${formatBytes(p.transferred)} of ${formatBytes(p.total)}`);
  } else {
    parts.push(`${percent}%`);
  }

  if (typeof p.bytesPerSecond === "number" && p.bytesPerSecond > 0) {
    parts.push(formatSpeed(p.bytesPerSecond));
    if (typeof p.transferred === "number" && typeof p.total === "number" && p.total > p.transferred) {
      parts.push(formatEta((p.total - p.transferred) / p.bytesPerSecond));
    }
  }

  return parts.join(" · ");
}

/** Headline for the progress toast — percentage stays visible even when bytes don't. */
export function progressTitle(p: UpdateProgress): string {
  return `Downloading update… ${Math.max(0, Math.min(100, Math.round(p.percent)))}%`;
}
