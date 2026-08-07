// When should clicking Run pop the agent chat open?
//
// Pure so the rule is testable without mounting App. The rule is deliberately a
// TRANSITION test, not a state test — "the run is active" would re-open the panel every
// render and fight a user who closed it mid-run.
import type { RunState } from "../engine-client";

/** A run that is doing (or about to do) visible agent work. */
function isActive(state: RunState): boolean {
  return state === "running" || state === "queued";
}

/**
 * True only on the idle -> active edge. Consequences of that choice:
 * - closing the panel mid-run keeps it closed (no state re-trigger)
 * - opening a document that was ALREADY running doesn't yank the panel open
 * - queued counts, so a run waiting behind another still explains itself
 */
export function shouldAutoOpenChat(prev: RunState, next: RunState): boolean {
  return !isActive(prev) && isActive(next);
}
