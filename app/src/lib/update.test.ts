import { describe, expect, it } from "vitest";
import { describeProgress, formatBytes, formatEta, formatSpeed, isUnpacking, progressTitle } from "./update";

const MB = 1024 * 1024;

describe("formatBytes", () => {
  it("scales through KB / MB / GB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4 * 1024)).toBe("4 KB");
    expect(formatBytes(47 * MB)).toBe("47 MB");
    expect(formatBytes(1.5 * 1024 * MB)).toBe("1.5 GB");
  });
  it("does not invent numbers for junk input", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("formatSpeed", () => {
  it("uses MB/s above a megabyte and KB/s below", () => {
    expect(formatSpeed(2.1 * MB)).toBe("2.1 MB/s");
    expect(formatSpeed(300 * 1024)).toBe("300 KB/s");
  });
  it("returns a dash rather than Infinity when the rate is zero", () => {
    expect(formatSpeed(0)).toBe("—");
  });
});

describe("formatEta", () => {
  it("stays deliberately coarse", () => {
    expect(formatEta(3)).toBe("a few seconds left");
    expect(formatEta(42)).toBe("about 40s left");
    expect(formatEta(84)).toBe("about 1 min left"); // reads better than "about 85s"
    expect(formatEta(100)).toBe("about 2 min left");
    expect(formatEta(60 * 45)).toBe("about 45 min left");
    expect(formatEta(3600 * 1.2)).toBe("about 1 hour left");
  });
});

describe("isUnpacking", () => {
  it("is true once every byte has landed", () => {
    expect(isUnpacking({ percent: 100, transferred: 223 * MB, total: 223 * MB })).toBe(true);
    expect(isUnpacking({ percent: 99, transferred: 220 * MB, total: 223 * MB })).toBe(false);
  });
  it("falls back to percent when byte counts are absent", () => {
    expect(isUnpacking({ percent: 100 })).toBe(true);
    expect(isUnpacking({ percent: 50 })).toBe(false);
  });
});

describe("describeProgress", () => {
  it("gives bytes, speed and ETA when electron-updater provides them", () => {
    expect(
      describeProgress({ percent: 21, transferred: 47 * MB, total: 223 * MB, bytesPerSecond: 2.1 * MB }),
    ).toBe("47 MB of 223 MB · 2.1 MB/s · about 1 min left");
  });
  it("degrades to a bare percentage without byte counts", () => {
    expect(describeProgress({ percent: 37 })).toBe("37%");
  });
  it("omits the ETA when the rate is unknown", () => {
    expect(describeProgress({ percent: 21, transferred: 47 * MB, total: 223 * MB })).toBe("47 MB of 223 MB");
  });
  it("omits the ETA at completion rather than printing 0s", () => {
    expect(
      describeProgress({ percent: 100, transferred: 223 * MB, total: 223 * MB, bytesPerSecond: 2.1 * MB }),
    ).toBe("223 MB of 223 MB · 2.1 MB/s");
  });
  it("clamps a percentage that overshoots", () => {
    expect(progressTitle({ percent: 103 })).toBe("Downloading update… 100%");
  });
});
