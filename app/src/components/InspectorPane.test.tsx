// Regression coverage for the contextual Inspector — the surface where two live-edit
// capabilities have silently regressed before: the multi-select alignment controls and
// the per-image variant shuttle. These assert that the right controls render for each
// selection kind, so a future refactor that drops them fails CI instead of shipping.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EngineClient, ProjectState } from "../engine-client";
import { InspectorPane } from "./InspectorPane";

// Any client method is a no-op promise — rendering never calls the network.
const client = new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as EngineClient;

function project(images: ProjectState["images"] = []): ProjectState {
  return {
    workspaceRoot: "/ws",
    slug: "demo",
    meta: null,
    artboard: { w: 210, h: 297 },
    history: { undo: 0, redo: 0 },
    brief: "",
    contextFiles: [],
    brandFiles: [],
    rounds: [],
    images,
    editable: [],
    hasPage: true,
    hasProof: false,
    running: false,
    runState: "idle",
    runStates: {},
    designerModel: "google/gemini-3.5-flash",
  };
}

const common = {
  project: project(),
  client,
  deleteRequestIds: null,
  onDeleteHandled: () => {},
  onDeselect: () => {},
  onAlign: () => {},
  applyProps: () => {},
  setPosition: () => {},
};

describe("InspectorPane", () => {
  it("renders the alignment controls for a multi-selection", () => {
    render(<InspectorPane {...common} selection={{ kind: "multi", ids: ["a", "b"] }} />);
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    // Figma-style align strip — must be present when 2+ elements are selected.
    for (const label of ["Align left", "Align right", "Align top", "Align bottom"]) {
      expect(screen.getByTitle(label)).toBeInTheDocument();
    }
  });

  it("renders align-to-page controls for a single block selection", () => {
    render(
      <InspectorPane
        {...common}
        selection={{ kind: "block", id: "headline", nudge: { x: 0, y: 0, marginTop: null } }}
      />,
    );
    expect(screen.getByTitle("Align left (of page)")).toBeInTheDocument();
    expect(screen.getByText("aligns to the page")).toBeInTheDocument();
  });

  it("renders the variant shuttle for an image selection with variants", () => {
    render(
      <InspectorPane
        {...common}
        project={project([{ id: "hero", variants: [1, 2], current: 1 }])}
        selection={{ kind: "image", id: "hero", tag: "IMG" }}
      />,
    );
    expect(screen.getByText(/v1 \/ 2/)).toBeInTheDocument(); // the shuttle counter
    expect(screen.getByText(/Generate more/)).toBeInTheDocument();
    expect(screen.getByText(/Upload/)).toBeInTheDocument();
  });
});
