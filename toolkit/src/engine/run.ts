// CLI entry: npm run agent -- projects/<slug> [--model provider/model] [--prompt "..."]
import { markRunStart } from "./review.ts";
import { resetSearchBudget } from "./search.ts";
import { resetFetchBudget } from "./web-fetch.ts";
import { createBluelineSession } from "./session.ts";

function parseArgs(argv: string[]) {
  const args = { projectDir: "", modelOverride: undefined as string | undefined, prompt: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.modelOverride = argv[++i];
    else if (argv[i] === "--prompt") args.prompt = argv[++i];
    else if (!argv[i].startsWith("--")) args.projectDir = argv[i];
  }
  if (!args.projectDir) {
    console.error('usage: npm run agent -- projects/<slug> [--model provider/model] [--prompt "..."]');
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { session, project, config, dispose } = await createBluelineSession({
  projectDir: args.projectDir,
  modelOverride: args.modelOverride,
});

resetFetchBudget(project);
resetSearchBudget(project);
markRunStart(project);
console.log(`Blueline engine — project=${project.slug} model=${session.model?.id} reviewer=${config.reviewer.model}`);

let currentTool: string | undefined;
session.subscribe((event) => {
  switch (event.type) {
    case "message_update": {
      const e = (event as any).assistantMessageEvent;
      if (e?.type === "text_delta") process.stdout.write(e.delta);
      break;
    }
    case "message_end":
      process.stdout.write("\n");
      break;
    case "tool_execution_start": {
      const ev = event as any;
      currentTool = ev.toolName ?? ev.name;
      console.log(`\n⚙ ${currentTool} ${summarizeArgs(ev.args)}`);
      break;
    }
    case "tool_execution_end": {
      const ev = event as any;
      const out = ev.result?.content?.find((c: any) => c.type === "text")?.text ?? "";
      console.log(`  ↳ ${firstLines(out, currentTool === "review" ? 30 : 3)}`);
      break;
    }
  }
});

function summarizeArgs(argsObj: unknown): string {
  if (!argsObj || typeof argsObj !== "object") return "";
  const s = JSON.stringify(argsObj);
  return s === "{}" ? "" : s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

function firstLines(s: string, n: number): string {
  const lines = s.split("\n");
  return lines.slice(0, n).join("\n  ") + (lines.length > n ? `\n  … (+${lines.length - n} lines)` : "");
}

const kickoff =
  args.prompt ??
  `Produce the deliverable for this project. Start by reading brief.md, then follow your loop until the reviewer passes the piece or the round limit is hit.`;

const startedAt = Date.now();
try {
  await session.prompt(kickoff);
} finally {
  const latest = project.latestReview();
  const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(`\n${"─".repeat(60)}`);
  if (latest) {
    const verdict = (latest.result as any)?.verdict;
    console.log(`Result: ${verdict === "pass" ? "✅ PASS" : `⚠️ ${verdict}`} after ${latest.round} round(s), ${mins} min`);
    console.log(`Proof:  ${project.proofPdf}`);
    console.log(`Rounds: ${project.reviewDir}/round-*.json`);
    process.exitCode = verdict === "pass" ? 0 : 2;
  } else {
    console.log(`Result: ❌ no review round completed (${mins} min) — check output above`);
    process.exitCode = 1;
  }
  await dispose();
}
