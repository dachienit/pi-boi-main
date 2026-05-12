import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { MomSettingsManager, syncLogToSessionManager } from "./context.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { BotContext, ChannelInfo, UserInfo } from "./types.js";
import { ENABLED_SKILLS } from "./types.js";
import type { ChannelStore } from "./store.js";
import { createMomTools, setUploadFunction, setDiaUploadFunction } from "./tools/index.js";
import { clearDiaEmitters, setDiaEmitters } from "./tools/dia.js";

// Model configuration via environment variables:
//   LLM_PROVIDER  — provider name (default: "openai")
//   LLM_MODEL     — model id     (default: "gpt-4o-mini")
//   LLM_BASE_URL  — custom API base URL (e.g. http://localhost:11434/v1 for Ollama)
//   LLM_API_KEY   — API key (alternative to ~/.pi/mom/auth.json)
//   LLM_AUTH_HEADER — custom auth header name (e.g. "genaiplatform-farm-subscription-key" for Bosch)
//   LLM_BASE_MODEL — base model to clone settings from (for custom endpoints, default: "llama3-70b-8192")
const llmProvider = process.env.LLM_PROVIDER || "openai";
const llmModelId = process.env.LLM_MODEL || "gpt-4o-mini";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let model: ReturnType<typeof getModel>;

// If custom endpoint is configured, use a base model template and override
if (process.env.LLM_BASE_URL && process.env.LLM_AUTH_HEADER) {
	// Use groq's llama3-70b-8192 as template (uses openai-completions API)
	const baseModelId = process.env.LLM_BASE_MODEL || "llama3-70b-8192";
	model = (getModel as (p: string, m: string) => ReturnType<typeof getModel>)("groq", baseModelId);

	// Override with custom endpoint settings
	model.id = llmModelId;
	model.baseUrl = process.env.LLM_BASE_URL;
	(model as any).provider = llmProvider;
	(model as any).headers = {
		...(model as any).headers,
		[process.env.LLM_AUTH_HEADER]: process.env.LLM_API_KEY,
	};

	console.log(`✓ LLM: ${llmModelId} @ ${process.env.LLM_BASE_URL}`);
	console.log(`✓ LLM custom header: ${process.env.LLM_AUTH_HEADER}`);
} else {
	// Standard provider/model lookup
	model = (getModel as (p: string, m: string) => ReturnType<typeof getModel>)(llmProvider, llmModelId);

	if (process.env.LLM_BASE_URL) {
		model.baseUrl = process.env.LLM_BASE_URL;
	}
}

if (process.env.LLM_API_TYPE) {
	(model as any).api = process.env.LLM_API_TYPE;
}

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: BotContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
}

async function getLlmApiKey(authStorage: AuthStorage): Promise<string> {
	if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
	const key = await authStorage.getApiKey(llmProvider);
	if (!key) {
		throw new Error(
			`No API key found for provider "${llmProvider}".\n\n` +
				`Set LLM_API_KEY env var, or store the key in ` +
				join(homedir(), ".pi", "mom", "auth.json") +
				` as { "${llmProvider}": "your-key" }`,
		);
	}
	return key;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function getMemory(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	// channelDir is workspace/sessions/{channelId} — workspace is two levels up
	const workspaceMemoryPath = join(channelDir, "..", "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function loadMomSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	// channelDir is workspace/sessions/{channelId} — workspace is two levels up
	const hostWorkspacePath = join(channelDir, "..", "..");

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		// Translate paths to container paths for system prompt
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	_channels: ChannelInfo[],
	_users: UserInfo[],
	skills: Skill[],
): string {
	const workspacePathFwd = workspacePath.replace(/\\/g, "/");
	const channelPath = `${workspacePathFwd}/sessions/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";

	const envDescription = isDocker
		? `Running inside Docker (Alpine).
- bash cwd: / (use cd or absolute paths).
- Install tools with: apk add <package>.`
		: `Running on the host machine.
- bash cwd: ${process.cwd()}.`;

	const enabledSkillsList = ENABLED_SKILLS.join(", ");

	return `You are OctoAgent's ORCHESTRATOR for an ABAP IDE web tool (SAP S/4HANA + ABAP Cloud).

# Role (locked — read every turn)

You ARE NOT a writer. You are a router.

- You NEVER produce free text for the user. Every assistant turn MUST be a \`toolCall\` or a \`stop\`. Never both. Never plain text.
- All user-facing content (explanations, ABAP code, summaries, file content) comes from DIA Brain via \`callDIABrain\` OR from a tool result chip. Pi-boi auto-streams DIA's \`display\` field to the UI as a typewriter — you do not need to repeat it, paraphrase it, or comment on it.
- If you emit free text, OctoAgent will silently DROP it (never shown to the user) and count a violation. Repeated violations downgrade the run.
- After a \`callDIABrain\` result returns, you have ONE job: decide whether more tools are needed. If not, emit \`stop\`. Do not summarise, do not say "done", do not greet, do not apologise.

# Available skills (DIA Brain endpoints)

Phase 1 enabled: ${enabledSkillsList}.

- **assistant** — generate / explain / quick-refactor ABAP, CDS, RAP, S/4HANA, ABAP Cloud, OData, BAdI, AMDP, BAPI, BDC, IDoc, HANA, BTP. Default for any SAP/ABAP request.

DIA Brain is workspace-blind. It does NOT know about pi-boi, file paths, channel ids, scratch directories, or any tool. It only sees: (a) the skill persona text (loaded by pi-boi), and (b) the \`prompt\` you send, plus its own per-session chat history.

# How to compose \`prompt\` for callDIABrain

Format:
\`\`\`
<1-2 sentence intent in the user's language>

Return ONLY this JSON:
{ "<field>": "<type>", ... }
\`\`\`

Rules:
1. **Never re-paste prior context.** DIA already has its per-session chat history. Follow-up turns: just send the new instruction (e.g. "now refactor the class you just produced and save to file"). DIA will remember the previous turn.
2. **Never mention paths, scratch, channel ids, pi-boi, tools, or file system structure.** DIA is workspace-blind.
3. **Never invent technical details** the user did not provide (no fake table names, no class names like ZCL_*, no REPORT headers, no field lists). Relay the user's intent verbatim or in 1-2 short sentences.
4. **Always embed the JSON schema** you want DIA to return. Pick the smallest schema that captures the deliverable.
5. **For file outputs**, ask DIA for a simple \`file_name\` basename only (e.g. \`zcl_po_reader.clas.abap\`), NOT a path. Pi-boi resolves it to the session scratch directory.

# Canonical field catalog (what DIA returns → what pi-boi does)

DIA returns a single JSON object. Pi-boi auto-dispatches each known field. You do not need to issue \`write\` / \`attach\` after a DIA call — pi-boi does that for you when the right fields are present.

| Field | When to ask DIA for it | Pi-boi action |
|-------|------------------------|---------------|
| \`display\` | Any user-facing answer (explanation, summary, narrative). Use markdown. | Typewriter-stream to chat UI. |
| \`file_name\` + \`file_content\` | User asked to save / write / store / generate a file (ABAP source, CDS source, .md, .txt). | Resolve basename to \`${channelPath}/scratch/<basename>\`, write file, auto-attach as chat chip. |
| \`html_artifact\` (+ optional \`file_name\`) | User asked for an HTML / SVG / diagram artifact (visualization). | Resolve to \`${workspacePathFwd}/artifacts/${channelId}/<basename>\`, write, auto-attach as canvas. |
| \`error\` | DIA cannot fulfil the request and wants to surface a clear error. | Surface error in UI; skip other fields. |
| \`next_hint\` | DIA wants to suggest the next user action (informational only). | Bubble back to you in the tool result so you can plan a follow-up call (rarely needed). |

Other fields (e.g. \`edit\`, \`bash_cmd\`, \`attach_path\`) are RESERVED for later phases and currently ignored.

## Schema templates (copy and adapt)

- Plain explanation / answer:
  \`{ "display": "<markdown text>" }\`
- Generate ABAP and save to file:
  \`{ "display": "<short summary>", "file_name": "<basename>.abap", "file_content": "<full ABAP source>" }\`
- Visualization artifact:
  \`{ "display": "<short summary>", "html_artifact": "<full HTML>", "file_name": "<basename>.html" }\`
- Cannot fulfil:
  \`{ "error": "<reason>" }\`

## Right vs wrong examples

User: \`hello\`
- RIGHT: \`callDIABrain({skill:"assistant", label:"Ask DIA: greet", prompt:"hello\\n\\nReturn ONLY: {\\"display\\":\\"<markdown text>\\"}"})\`
- WRONG: emit text \`Hi! How can I help?\` ← banned (free text).

User: \`viết 1 abap class select PO data và lưu vào file\`
- RIGHT: \`callDIABrain({skill:"assistant", label:"Ask DIA: write PO reader class", prompt:"Generate an ABAP class that selects PO data and save it to a file (mirror the user's language: Vietnamese).\\n\\nReturn ONLY: {\\"display\\":\\"<short Vietnamese summary>\\",\\"file_name\\":\\"<basename>.clas.abap\\",\\"file_content\\":\\"<full ABAP source>\\"}"})\`
- WRONG: \`callDIABrain({skill:"assistant", prompt:"Write an ABAP class ZCL_PO_READER selecting from EKKO..."})\` ← fabricated class/table names. Bug.
- WRONG: emit text containing the ABAP source ← banned (free text + duplicates DIA's job).

User: \`now refactor it\` (after the previous turn produced an ABAP class)
- RIGHT: \`callDIABrain({skill:"assistant", label:"Ask DIA: refactor", prompt:"Refactor the class from the previous turn and save the new version to a file.\\n\\nReturn ONLY: {\\"display\\":\\"<short summary of changes>\\",\\"file_name\\":\\"<basename>.clas.abap\\",\\"file_content\\":\\"<full refactored ABAP source>\\"}"})\`
- WRONG: re-pasting the previous ABAP code into \`prompt\` ← DIA already has it in history.

# Local pi-boi tools (NON-SAP only — rare)

Use these only when the user explicitly works with non-SAP files already on disk. SAP/ABAP work always goes through DIA.

- \`read({path,offset?,limit?,label})\` — read a file the user just attached (e.g. to feed it into the next \`callDIABrain.prompt\`). Common case: user attached a file and wants ABAP analysis → \`read\` first, then \`callDIABrain({prompt:"analyse this:\\n<content>", ...})\`.
- \`write({path,content,label})\` — write a non-SAP file (e.g. \`.md\` notes).
- \`edit({path,oldText,newText,label})\` — surgical replace on an existing non-SAP file.
- \`attach({path,title?,label})\` — surface a file as a chat chip (only needed for non-SAP files; DIA outputs are auto-attached).
- \`bash({command,label})\` — multi-file search / list (rare).

Every tool call needs a \`label\` (\`Ask DIA: ...\` for callDIABrain; brief verb phrase for the rest).

# Termination

After every \`callDIABrain\` result:
- If the result indicates DIA already produced \`display\` and any requested files were written, AND the user's intent is satisfied → emit \`stop\`. Do not add text.
- If you genuinely need more (e.g. user asked "read foo.txt and refactor", and you only have the file content but not the refactor yet) → call the next tool.

# Environment
${envDescription}

# Workspace layout (for your routing decisions only — never mention to DIA)
${workspacePathFwd}/
├── MEMORY.md                    # Global memory
├── skills/                      # SKILL.md persona files for DIA endpoints
├── artifacts/${channelId}/      # HTML / SVG / diagrams (canvas)
└── sessions/${channelId}/
    ├── MEMORY.md                # Session memory
    ├── log.jsonl                # Message history
    ├── attachments/             # User-shared files
    └── scratch/                 # Generated SAP / non-SAP files

## Memory (use only to route — never re-send to DIA)
${memory}

## Skill snippets (for your awareness)
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no snippets yet)"}
`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function formatToolArgsForSlack(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a channel.
 * Runners are cached - one per channel, persistent across messages.
 */
export function getOrCreateRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, channelId, channelDir);
	channelRunners.set(channelId, runner);
	return runner;
}

/**
 * Create a new AgentRunner for a channel.
 * Sets up the session and subscribes to events once.
 */
function createRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const executor = createExecutor(sandboxConfig);
	// channelDir is workspace/sessions/{channelId} — workspace is two levels up
	// hostWorkingDir: actual path on host filesystem (for Node.js fs operations)
	// workspacePath: path as seen by executor (Docker: /workspace, Host: same as hostWorkingDir)
	const hostWorkingDir = dirname(dirname(channelDir));
	const workspacePath = executor.getWorkspacePath(hostWorkingDir);

	// Create tools with host working directory for fs operations.
	// hostWorkingDir IS the workspace root (workspacerks/), so it doubles as hostWorkspacePath
	// for skills/* lookup inside callDIABrain.
	const tools = createMomTools(executor, hostWorkingDir, channelId, hostWorkingDir);

	// Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
	const memory = getMemory(channelDir);
	const skills = loadMomSkills(channelDir, workspacePath);
	const systemPrompt = buildSystemPrompt(workspacePath, channelId, memory, sandboxConfig, [], [], skills);

	// Create session manager and settings manager
	// Use a fixed context.jsonl file per channel (not timestamped like coding-agent)
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = new MomSettingsManager(join(channelDir, ".."));

	// Create AuthStorage and ModelRegistry
	// Auth stored outside workspace so agent can't access it
	const authStorage = new AuthStorage(join(homedir(), ".pi", "mom", "auth.json"));
	// Inject LLM_API_KEY so AgentSession's internal key lookup also finds it
	if (process.env.LLM_API_KEY) {
		authStorage.setRuntimeApiKey(llmProvider, process.env.LLM_API_KEY);
	}
	const modelRegistry = new ModelRegistry(authStorage);

	// Create agent. NOTE: no `streamFn` override — pi-agent-core's default
	// `streamSimple` is used so each agent-loop turn fires a real LLM Farm
	// (gpt-5-nano via LLM_BASE_URL) request. Nano is the orchestrator at every
	// nhịp; the text-content guardrail in our subscriber ensures it never
	// surfaces free text to the user.
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async () => getLlmApiKey(authStorage),
	});

	// Load existing messages
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.replaceMessages(loadedSession.messages);
		log.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession wrapper
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: settingsManager as any,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Mutable per-run state - event handler references this
	const runState = {
		ctx: null as BotContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
		// Guardrail: count nano turns that emitted free text instead of a toolCall.
		// Each violation drops the text from the UI silently — pi-boi NEVER lets
		// nano's text reach the user. We only count for diagnostics.
		nanoTextViolations: 0,
		// True after at least one DIA call has been made in this run. Used by the
		// post-run fallback: if nano never called DIA AND emitted text, we
		// synthetically dispatch one callDIABrain on the user's behalf.
		diaCallsMade: 0,
		// True when DIA already typewrote its display field inline. Suppresses
		// the trailing replaceMessage so we don't push a duplicate text block
		// after the tool chips in the activity flow.
		diaStreamedInline: false,
		// Cached most-recent DIA display so the post-run path can replaceMessage
		// when the inline typewriter did NOT run (e.g. SSE adapter without
		// emitDelta wired).
		lastDiaDisplay: undefined as string | undefined,
		// Stash of the user's text for this run, used by the synthetic fallback.
		userText: "",
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		// Skip if no active run
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			if (agentEvent.toolName === "callDIABrain") {
				runState.diaCallsMade += 1;
			}

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			// Post args + result to thread
			const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
			const argsFormatted = pending
				? formatToolArgsForSlack(agentEvent.toolName, pending.args as Record<string, unknown>)
				: "(args not found)";
			const duration = (durationMs / 1000).toFixed(1);
			let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
			if (label) threadMessage += `: ${label}`;
			threadMessage += ` (${duration}s)\n`;
			if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
			threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

			queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}

			// Cache the most-recent DIA display so the post-run path can replace
			// the main message bubble for adapters that lack inline streaming.
			if (
				agentEvent.toolName === "callDIABrain" &&
				!agentEvent.isError &&
				typeof agentEvent.result === "object" &&
				agentEvent.result !== null &&
				"details" in agentEvent.result
			) {
				const details = (
					agentEvent.result as {
						details?: { display?: string; streamedInline?: boolean };
					}
				).details;
				if (details?.display) {
					runState.lastDiaDisplay = details.display;
					if (details.streamedInline) runState.diaStreamedInline = true;
					log.logResponse(logCtx, details.display);
				}
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				let hasToolCall = false;
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					} else if (part.type === "toolCall") {
						hasToolCall = true;
					}
				}

				const text = textParts.join("\n").trim();

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					queue.enqueueMessage(`_${thinking}_`, "main", "thinking main");
					queue.enqueueMessage(`_${thinking}_`, "thread", "thinking thread", false);
				}

				// === GUARDRAIL: drop nano free text ===
				// Nano is a pure orchestrator. Every assistant turn must be a
				// toolCall or a stop. If text leaks through (with or without a
				// toolCall), we DROP it from the UI and increment the violation
				// counter for diagnostics. The thread still gets the text so we
				// can audit the violation post-hoc.
				if (text) {
					if (hasToolCall) {
						// Hybrid: text + toolCall. Drop the text only.
						runState.nanoTextViolations += 1;
						log.logWarning(
							"nano guardrail",
							`dropped text alongside toolCall (violation #${runState.nanoTextViolations}): ${truncate(text, 120)}`,
						);
						queue.enqueueMessage(
							`_(dropped nano text — violation #${runState.nanoTextViolations})_\n${text}`,
							"thread",
							"dropped nano text audit",
							false,
						);
					} else {
						// Text-only turn. Drop from UI; let stop fire naturally.
						runState.nanoTextViolations += 1;
						log.logWarning(
							"nano guardrail",
							`dropped text-only turn (violation #${runState.nanoTextViolations}): ${truncate(text, 120)}`,
						);
						queue.enqueueMessage(
							`_(dropped nano text — violation #${runState.nanoTextViolations})_\n${text}`,
							"thread",
							"dropped nano text audit",
							false,
						);
					}
				}
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	});

	// Slack message limit
	const SLACK_MAX_LENGTH = 40000;
	const splitForSlack = (text: string): string[] => {
		if (text.length <= SLACK_MAX_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
			remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	return {
		async run(
			ctx: BotContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });

			// Sync messages from log.jsonl that arrived while we were offline or busy
			// Exclude the current message (it will be added via prompt())
			const syncedCount = syncLogToSessionManager(sessionManager, channelDir, ctx.message.ts);
			if (syncedCount > 0) {
				log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages from context.jsonl
			// This picks up any messages synced above
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.replaceMessages(reloadedSession.messages);
				log.logInfo(`[${channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
			}

			// Update system prompt with fresh memory, channel/user info, and skills
			const memory = getMemory(channelDir);
			const skills = loadMomSkills(channelDir, workspacePath);
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
			);
			session.agent.setSystemPrompt(systemPrompt);

			// Set up file upload function (used by the legacy `attach` tool).
			const uploadFn = async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId);
				await ctx.uploadFile(hostPath, title);
			};
			setUploadFunction(uploadFn);
			// Same upload pipeline reused by the canonical dispatcher inside
			// callDIABrain (write_file / write_artifact actions).
			setDiaUploadFunction(uploadFn);

			// Wire DIA streaming emitters → SSE (per-run, cleared in finally below).
			// Adapter (HTTP) provides emit* methods; Slack adapter omits them so DIA
			// just falls back to its existing onUpdate progress log.
			setDiaEmitters({
				emitStepStart: ctx.emitStepStart,
				emitStepEnd: ctx.emitStepEnd,
				emitDiaPipeline: ctx.emitDiaPipeline,
				emitRagSources: ctx.emitRagSources,
				emitLlmMeta: ctx.emitLlmMeta,
				emitDelta: ctx.emitDelta,
			});

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;
			runState.nanoTextViolations = 0;
			runState.diaCallsMade = 0;
			runState.diaStreamedInline = false;
			runState.lastDiaDisplay = undefined;
			runState.userText = ctx.message.text;

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`Slack API error (${errorContext})`, errMsg);
							try {
								await ctx.respondInThread(`_Error: ${errMsg}_`);
							} catch {
								// Ignore
							}
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitForSlack(text);
					for (const part of parts) {
						this.enqueue(
							() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
							errorContext,
						);
					}
				},
			};

			// Log context info
			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			// Build user message with timestamp and username prefix
			// Format: "[YYYY-MM-DD HH:MM:SS+HH:MM] [username]: message" so LLM knows when and who
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImagePaths: string[] = [];

			for (const a of ctx.message.attachments || []) {
				const fullPath = `${workspacePath}/${a.local}`;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(fullPath)) {
					try {
						imageAttachments.push({
							type: "image",
							mimeType,
							data: readFileSync(fullPath).toString("base64"),
						});
					} catch {
						nonImagePaths.push(fullPath);
					}
				} else {
					nonImagePaths.push(fullPath);
				}
			}

			if (nonImagePaths.length > 0) {
				userMessage += `\n\n<attachments>\n${nonImagePaths.join("\n")}\n</attachments>`;
			}

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt,
				messages: session.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(channelDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			await session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

			// Wait for queued messages
			await queueChain;

			// === GUARDRAIL FALLBACK ===
			// If nano emitted free text but never invoked any DIA call, dispatch
			// one synthetic callDIABrain on the user's behalf so they don't end
			// up with a blank UI. (Run AFTER session.prompt() returns so we don't
			// re-enter the agent loop while it's still active.)
			if (
				runState.nanoTextViolations > 0 &&
				runState.diaCallsMade === 0 &&
				runState.userText.trim() &&
				runState.stopReason !== "error"
			) {
				log.logWarning(
					"nano guardrail",
					`fallback: nano emitted ${runState.nanoTextViolations} text turn(s) without a DIA call — dispatching synthetic callDIABrain`,
				);
				const fallbackPrompt =
					`${runState.userText.trim()}\n\nReturn ONLY: {"display":"<markdown text>"}`;
				const fallbackTool = tools.find((t) => t.name === "callDIABrain");
				if (fallbackTool) {
					try {
						await fallbackTool.execute(
							`fallback_${Date.now()}`,
							{
								skill: "assistant",
								label: "Ask DIA: fallback",
								prompt: fallbackPrompt,
							} as never,
							undefined,
						);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("synthetic callDIABrain fallback failed", errMsg);
					}
				}
			}

			// Handle error case - update main message and post error to thread.
			if (runState.stopReason === "error" && runState.errorMessage) {
				try {
					await ctx.replaceMessage("_Sorry, something went wrong_");
					await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else if (runState.diaCallsMade > 0 && runState.lastDiaDisplay) {
				// DIA wrote display via the typewriter (when emitDelta wired). No
				// extra replaceMessage in that case — the inline-streamed text is
				// canonical. Otherwise (Slack adapter or no streaming) push the
				// cached display to the main bubble.
				if (runState.diaStreamedInline) {
					log.logInfo("DIA: display already streamed inline; skipping replaceMessage");
				} else {
					const finalText: string = runState.lastDiaDisplay;
					try {
						const mainText =
							finalText.length > SLACK_MAX_LENGTH
								? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
								: finalText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with DIA display", errMsg);
					}
				}
			} else {
				// No DIA call (and no error) — usually means nano correctly emitted
				// a stop on a non-actionable turn. Surface only the [SILENT] marker
				// from the most recent assistant text (if any) — all real text was
				// already dropped by the guardrail.
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalText.trim() && runState.nanoTextViolations === 0) {
					// Defensive: surface text only if it was NOT dropped by the
					// guardrail (i.e. nanoTextViolations counter unchanged).
					try {
						const mainText =
							finalText.length > SLACK_MAX_LENGTH
								? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
								: finalText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}
			}

			// Log usage summary with context info
			if (runState.totalUsage.cost.total > 0) {
				// Get last non-aborted assistant message for context calculation
				const messages = session.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = model.contextWindow || 200000;

				const summary = log.logUsageSummary(runState.logCtx!, runState.totalUsage, contextTokens, contextWindow);
				runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
				await queueChain;
			}

			// Clear run state
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;
			clearDiaEmitters();
			setDiaUploadFunction(null);

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},
	};
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
