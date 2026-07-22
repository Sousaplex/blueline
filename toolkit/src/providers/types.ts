// Provider contracts. New APIs (Flux, DALL·E, Claude-as-reviewer, ...) implement
// one of these and register in index.ts — nothing else in the toolkit changes.

export interface ImagePromptSpec {
  id: string;
  prompt: string;
  aspect: string; // "16:9", "1:1", "3:4"...
  variants: number;
}

export interface ImageProvider {
  name: string;
  generate(spec: ImagePromptSpec, styleNotes: string): Promise<Buffer[]>;
}

export interface ReviewIssue {
  page: number;
  region: string; // "header", "bottom-left", "figure 2"...
  problem: string;
  fix: string;
}

export interface ReviewResult {
  verdict: "pass" | "revise";
  issues: ReviewIssue[];
  notes?: string;
}

export interface ReviewProvider {
  name: string;
  review(input: {
    pagePngs: Buffer[];
    brief: string;
    brandGuide: string;
    priorRounds: ReviewResult[];
  }): Promise<ReviewResult>;
}
