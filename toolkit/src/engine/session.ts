import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { loadConfig, type PresscheckConfig } from "./config.ts";
import { Project } from "./project.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { PlaywrightBackend, type RenderBackend } from "./render.ts";
import { buildPresscheckTools } from "./tools.ts";

/** Built-in Pi tools the designer may use. Deliberately no bash. */
const BUILTIN_TOOLS = ["read", "write", "edit", "grep", "find", "ls"];
const CUSTOM_TOOL_NAMES = ["render", "review", "gen_images", "web_fetch"];

export interface PresscheckSession {
  session: AgentSession;
  project: Project;
  config: PresscheckConfig;
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

export async function createPresscheckSession(opts: CreateSessionOptions): Promise<PresscheckSession> {
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
    customTools: buildPresscheckTools(project, backend, config),
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
