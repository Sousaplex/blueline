import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createEditToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { loadConfig, type BluelineConfig } from "./config.ts";
import { Project } from "./project.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { PlaywrightBackend, type RenderBackend } from "./render.ts";
import { buildPresscheckTools } from "./tools.ts";

/** Built-in Pi tools the designer may use. Deliberately no bash. write/edit are enabled but
 *  OVERRIDDEN below with project-confined versions (Pi resolves custom tools over builtins by
 *  name), so a prompt-injected "write ~/Library/LaunchAgents/x" can't escape the project. */
const BUILTIN_TOOLS = ["read", "write", "edit", "grep", "find", "ls"];

/**
 * Reject any path that resolves outside `root`. Lexical (no realpath): the agent has no bash
 * and can't create symlinks, and lexical matching avoids the macOS /tmp→/private/tmp mismatch
 * that a realpath'd root would cause against Pi's cwd-relative (non-realpath'd) resolution.
 */
export function confineToRoot(root: string, p: string): string {
  const rootAbs = resolve(root);
  const abs = resolve(p);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error(`Refused: the agent may only write inside its project directory, not ${p}`);
  }
  return abs;
}

/** Project-confined fs operations for Pi's write/edit tools. Returned loosely-typed to unify
 *  with the custom-tool array (the definition generics differ only in render-arg variance). */
function confinedWriteEditTools(projectDir: string): any[] {
  const g = (p: string) => confineToRoot(projectDir, p);
  const write = createWriteToolDefinition(projectDir, {
    operations: {
      writeFile: (p, content) => writeFile(g(p), content),
      mkdir: async (dir) => {
        await mkdir(g(dir), { recursive: true });
      },
    },
  });
  const edit = createEditToolDefinition(projectDir, {
    operations: {
      readFile: (p) => readFile(g(p)),
      writeFile: (p, content) => writeFile(g(p), content),
      access: (p) => access(g(p)),
    },
  });
  return [write, edit];
}
const CUSTOM_TOOL_NAMES = [
  "render",
  "review",
  "gen_images",
  "use_image",
  "gen_qr",
  "web_fetch",
  "fetch_image",
  "web_search",
  "set_format",
  "write_source",
  "write_brand",
  "organize_sources",
];

export interface BluelineSession {
  session: AgentSession;
  project: Project;
  config: BluelineConfig;
  backend: RenderBackend;
  dispose(): Promise<void>;
}

export interface CreateSessionOptions {
  /** Either a ready Project (workspace-aware) or a path for the default workspace. */
  project?: Project;
  projectDir?: string;
  /** override config/providers.json designer block, e.g. "anthropic/claude-sonnet-4-5" */
  modelOverride?: string;
  backend?: RenderBackend;
}

export async function createBluelineSession(opts: CreateSessionOptions): Promise<BluelineSession> {
  const config = loadConfig();
  const project = opts.project ?? new Project(opts.projectDir ?? "projects/demo");
  const ownsBackend = !opts.backend;
  const backend = opts.backend ?? new PlaywrightBackend();

  const [providerId, modelId] = opts.modelOverride
    ? (opts.modelOverride.split("/") as [string, string])
    : [config.designer.provider, config.designer.model];

  const modelRuntime = await ModelRuntime.create();
  // Prefer an explicit env key from config; otherwise Pi's own auth (auth.json/env) applies.
  if (config.designer.apiKeyEnv && process.env[config.designer.apiKeyEnv]) {
    await modelRuntime.setRuntimeApiKey(providerId, process.env[config.designer.apiKeyEnv]!);
  }

  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) {
    const available = modelRuntime
      .getModels(providerId)
      .map((m) => m.id)
      .slice(0, 40);
    throw new Error(
      `Model "${modelId}" not found on provider "${providerId}".\n` +
        (available.length
          ? `Available on ${providerId}: ${available.join(", ")}`
          : `Provider "${providerId}" unknown. Providers: ${modelRuntime.getProviders().map((p) => p.id).join(", ")}`),
    );
  }

  const settingsManager = SettingsManager.create(project.dir, getAgentDir());
  const resourceLoader = new DefaultResourceLoader({
    cwd: project.dir,
    agentDir: getAgentDir(),
    settingsManager,
    systemPrompt: buildSystemPrompt(project, config),
    // Deterministic product surface: no ambient extensions/skills/context files from
    // the user's ~/.pi or the project directory.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: project.dir,
    model,
    modelRuntime,
    thinkingLevel: config.designer.thinkingLevel ?? "medium",
    tools: [...BUILTIN_TOOLS, ...CUSTOM_TOOL_NAMES],
    // The confined write/edit come LAST so they override Pi's unconfined builtins by name.
    customTools: [...buildPresscheckTools(project, backend, config), ...confinedWriteEditTools(project.dir)],
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.create(project.dir),
  });

  return {
    session,
    project,
    config,
    backend,
    async dispose() {
      session.dispose();
      if (ownsBackend) await backend.close(); // shared backends are owned by the caller
    },
  };
}
