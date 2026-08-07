import { describe, expect, it } from "vitest";
import { shouldAutoOpenChat } from "./chatAutoOpen";

describe("shouldAutoOpenChat", () => {
  it("opens when a run starts — the whole point", () => {
    expect(shouldAutoOpenChat("idle", "running")).toBe(true);
  });

  it("opens for a queued run too, so waiting behind another run still explains itself", () => {
    expect(shouldAutoOpenChat("idle", "queued")).toBe(true);
  });

  it("does not re-open while a run stays active (user may have closed it deliberately)", () => {
    expect(shouldAutoOpenChat("running", "running")).toBe(false);
    expect(shouldAutoOpenChat("queued", "running")).toBe(false);
  });

  it("does not open when a run finishes", () => {
    expect(shouldAutoOpenChat("running", "idle")).toBe(false);
  });

  it("stays shut when nothing is happening", () => {
    expect(shouldAutoOpenChat("idle", "idle")).toBe(false);
  });
});
