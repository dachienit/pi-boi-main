import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type ImageContent,
	type Model,
	type ToolCall,
} from "@mariozechner/pi-ai";
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
import type { ChannelStore } from "./store.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";

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

// =============================================================================
// LLM Farm Bypass: Synthetic streamFn that always dispatches to callDIABrain.
// =============================================================================
// We replace the default `streamSimple` (which fetches LLM Farm) with a
// synthetic emitter. Pi-agent loop, sessionManager, logging, retry, abort
// all still fire normally because we return a real AssistantMessageEventStream
// emitting the standard "done" event. Zero HTTP, zero token cost on Nano.

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Matches the mom-bot prefix added in agent.ts ~line 855:
//   `[${timestamp}] [${userName}]: ${text}`
// We strip it here so DIA Brain receives the user's raw text only.
const USER_PREFIX_RE = /^\[[^\]]+\]\s*\[[^\]]+\]:\s*/;

function stripUserPrefix(text: string): string {
	return text.replace(USER_PREFIX_RE, "");
}

function extractUserText(content: unknown): string {
	let raw = "";
	if (typeof content === "string") {
		raw = content;
	} else if (Array.isArray(content)) {
		raw = content
			.filter(
				(c): c is { type: "text"; text: string } =>
					typeof c === "object" && c !== null && (c as any).type === "text",
			)
			.map((c) => c.text)
			.join("\n");
	}
	return stripUserPrefix(raw.trim()).trim();
}

function makeLabel(userText: string): string {
	const stripped = userText.replace(/\s+/g, " ").trim();
	const truncated = stripped.length > 45 ? `${stripped.slice(0, 45)}...` : stripped;
	return `Ask DIA: ${truncated}`;
}

/**
 * Synthetic streamFn that bypasses LLM Farm entirely.
 *
 * - Last message = user (with non-empty text) -> emit assistant{toolCall callDIABrain({query: verbatim, label})}
 * - Last message = toolResult OR signal aborted OR empty user -> emit assistant{text:"", stopReason:stop|aborted}
 *   so the agent loop terminates gracefully.
 *
 * After tool_execution_end fires session.abort() (existing short-circuit logic
 * for callDIABrain), the next iter lands here with aborted=true and we return stop.
 */
function synthDiaStreamFn(
	targetModel: Model<any>,
	context: Context,
	options?: { signal?: AbortSignal },
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const lastMsg = context.messages[context.messages.length - 1];
	const now = Date.now();
	const aborted = options?.signal?.aborted === true;

	const baseMessage = {
		role: "assistant" as const,
		api: targetModel.api,
		provider: (targetModel as any).provider,
		model: targetModel.id,
		usage: { ...ZERO_USAGE },
		timestamp: now,
	};

	let finalMessage: AssistantMessage;

	if (!aborted && lastMsg?.role === "user") {
		const userText = extractUserText(lastMsg.content);
		if (!userText.trim()) {
			finalMessage = {
				...baseMessage,
				content: [{ type: "text", text: "" }],
				stopReason: "stop",
			} as AssistantMessage;
		} else {
			const toolCallId = `synth_${now}_${Math.random().toString(36).slice(2, 10)}`;
			const toolCall: ToolCall = {
				type: "toolCall",
				id: toolCallId,
				name: "callDIABrain",
				arguments: { query: userText, label: makeLabel(userText) },
			};
			finalMessage = {
				...baseMessage,
				content: [toolCall],
				stopReason: "toolUse",
			} as AssistantMessage;
		}
	} else {
		finalMessage = {
			...baseMessage,
			content: [{ type: "text", text: "" }],
			stopReason: aborted ? "aborted" : "stop",
		} as AssistantMessage;
	}

	queueMicrotask(() => {
		stream.push({
			type: "done",
			reason: aborted ? "aborted" : (finalMessage.stopReason as any),
			message: finalMessage,
		} as any);
		stream.end(finalMessage);
	});

	return stream;
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
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	return `You are OctoAgent's first-turn order taker for an ABAP IDE web tool (SAP S/4HANA + ABAP Cloud). You know the menu and the kitchens; you do NOT cook ABAP. Be concise, technical, direct. No emojis. No filler. Act first, explain briefly.

Two kitchens:
- DIA Brain (Claude + Bosch SAP RAG): the only chef for SAP/ABAP/CDS/RAP/S-4HANA orders. Route via \`callDIABrain\`.
- Local file tools (\`write\`, \`edit\`, \`read\`, \`attach\`, \`bash\`): for simple non-SAP deliverables you can handle yourself.

## Action Rules (highest priority — read first, every turn)
The user request fits ONE of these patterns. Pick the matching workflow and execute the tool calls BEFORE writing any prose.

0. **SAP / ABAP routing (HIGHEST PRIORITY)** — any request involving SAP, ABAP, CDS, RAP, S/4HANA, ABAP Cloud, OData, BAdI, AMDP, BTP, ALV, BAPI, BDC, IDoc, HANA, or any Bosch internal SAP topic
   - Call \`callDIABrain\` ONCE. Do not call any other tool in this turn.
   - \`query\` MUST be the user's last message copied BYTE-FOR-BYTE. Keep the user's language as-is (do NOT translate). Keep typos. Keep lower-case lower-case. Do NOT paraphrase, polish, expand, summarize. **FORBIDDEN to add to query**: file names, class names (ZCL_*), table names (EKKO/MARA/...), field names, ABAP code, REPORT/CLASS/INTERFACE headers, package names, transport requests, scratch paths, the word "abap". DIA has RAG + chat history and decides ALL technical details itself.
   - \`label\`: format \`Ask DIA: <verb phrase>\` (e.g. "Ask DIA: write simple program", "Ask DIA: refactor legacy SELECT", "Ask DIA: review CDS view"). Under 60 chars. No "DIABrain:" prefix.
   - \`terminal\`: omit (default true). DIA's reply IS the answer; the agent loop short-circuits after the tool returns — you MUST NOT emit any follow-up text. Anything you say after \`callDIABrain\` will be discarded. Set \`terminal: false\` ONLY if you genuinely need additional tools after DIA (rare).
   - Wrong vs right (memorize). User: \`write a simple program and save to file\`
     - WRONG: \`callDIABrain({ query: "Write a simple ABAP program. Create file hello.abap containing REPORT z_hello. WRITE 'Hello'.", ... })\` ← fabricated file/REPORT/code. Bug.
     - RIGHT: \`callDIABrain({ query: "write a simple program and save to file", label: "Ask DIA: write simple program" })\` ← verbatim relay.
1. **"save / write / store / generate ... to a file"** (file is the deliverable, NON-SAP only)
   - Call \`write\` → save file to \`${channelPath}/scratch/<name>.<ext>\` (\`.md\`, \`.json\`, \`.txt\`, \`.sh\`, …).
   - Call \`attach\` with the same path so it previews in the chat.
   - Then a 2-3 line confirmation in chat. Do NOT paste the full code in chat — the file IS the code.
2. **HTML / SVG / diagram (visualization deliverable, NON-SAP only)**
   - Call \`write\` → save to \`${workspacePathFwd}/artifacts/${channelId}/<name>.html\`.
   - Call \`attach\` with that path.
3. **Paste-only (NON-SAP review / refactor / fix / explain) — no save requested**
   - Reply directly in chat with structured Markdown. No tool calls needed unless you must read another file first.
4. **Multi-file search / list / batch op (NON-SAP only)**
   - Use \`bash\` (\`grep -r\`, \`ls\`, \`find\`). Avoid \`bash\` for single-file read/write — use \`read\` / \`write\` / \`edit\`.

If the request is ambiguous and SAP-related, default to pattern 0 (callDIABrain). If non-SAP and ambiguous, default to pattern 1 (write + attach). Never respond with a long code block when the user said "save" / "write to file".

## Mission (restaurant identity)
OctoAgent: ABAP IDE for generating, refactoring, reviewing, and fixing ABAP / CDS / RAP for SAP S/4HANA and ABAP Cloud. All actual SAP/ABAP work is delegated to DIA Brain.

## Environment
${envDescription}

## Workspace Layout
${workspacePathFwd}/
├── MEMORY.md                    # Global memory (all channels)
├── SYSTEM.md                    # Project decisions log
├── skills/                      # Reusable ABAP/CDS snippets (SKILL.md + template files)
├── artifacts/${channelId}/      # HTML/SVG/diagrams rendered as interactive canvas
└── sessions/${channelId}/       # Current session
    ├── MEMORY.md                # Session-specific memory
    ├── log.jsonl                # Message history
    ├── attachments/             # User-shared files
    ├── scratch/                 # Generated ABAP/CDS files
    └── skills/                  # Session-specific snippets

## Tools (menu)
Every tool call needs a \`label\` (short user-visible action description).
- **callDIABrain**: ONLY chef for SAP/ABAP/CDS/RAP/S-4HANA orders. DIA plans + executes write/edit/attach steps internally. Args: \`query\` (relay user request VERBATIM), \`label\` (\`Ask DIA: ...\`), optional \`terminal\` (default true → DIA's reply goes straight to UI, agent loop ends; set false only if you must run more tools after).
- **read**: read a file (offset/limit for large files). NON-SAP usage.
- **write**: create / overwrite a file. Auto-creates parent dirs. NON-SAP only.
- **edit**: surgical \`oldText → newText\` replacement on an existing file (oldText must be unique). NON-SAP only.
- **attach**: render a file inline in the chat. ALWAYS pair with the write/edit that produced it.
- **bash**: shell commands for multi-file search / batch ops only. NON-SAP only.

## Memory & Decisions (order memory)
- Global \`${workspacePathFwd}/MEMORY.md\`: project conventions, namespace, target stack (S/4HANA release, ABAP Cloud yes/no), user preferences.
- Session \`${channelPath}/MEMORY.md\`: decisions for this task.
- \`${workspacePathFwd}/SYSTEM.md\`: append architectural decisions (RAP managed vs unmanaged, package layout, external dependencies).
Update when you learn a durable fact or are asked to remember.
Use this memory ONLY to route or set context. Do NOT use it to enrich \`callDIABrain.query\`.

### Current Memory
${memory}

### Available Snippets
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no snippets yet — create one when a pattern repeats)"}

## Context
- For current date/time: \`date\`.
- Older history: search \`${channelPath}/log.jsonl\`.
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

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async () => getLlmApiKey(authStorage),
		streamFn: synthDiaStreamFn,
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
		diaFinalDisplay: undefined as string | undefined,
		diaShortCircuited: false,
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

			// Short-circuit nano synthesis after callDIABrain when DIA already produced the
			// final user-facing text. Surface DIA's `display` directly to the UI and abort the
			// agent loop so nano never fires its 2nd LLM call (saves cost + latency, preserves
			// DIA's full detail verbatim).
			if (
				agentEvent.toolName === "callDIABrain" &&
				!agentEvent.isError &&
				typeof agentEvent.result === "object" &&
				agentEvent.result !== null &&
				"details" in agentEvent.result
			) {
				const details = (agentEvent.result as { details?: { shortCircuit?: boolean; finalDiaDisplay?: string } })
					.details;
				if (details?.shortCircuit && details.finalDiaDisplay) {
					const finalText = details.finalDiaDisplay;
					runState.diaFinalDisplay = finalText;
					runState.diaShortCircuited = true;
					log.logResponse(logCtx, finalText);
					queue.enqueueMessage(finalText, "main", "dia final response");
					queue.enqueueMessage(finalText, "thread", "dia final thread", false);
					session.abort();
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
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					queue.enqueueMessage(`_${thinking}_`, "main", "thinking main");
					queue.enqueueMessage(`_${thinking}_`, "thread", "thinking thread", false);
				}

				if (text.trim()) {
					log.logResponse(logCtx, text);
					queue.enqueueMessage(text, "main", "response main");
					queue.enqueueMessage(text, "thread", "response thread", false);
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

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId);
				await ctx.uploadFile(hostPath, title);
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
			runState.diaFinalDisplay = undefined;
			runState.diaShortCircuited = false;

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

			// Handle error case - update main message and post error to thread
			// Skip the error path when DIA short-circuited (the agent loop ends with stopReason
			// "aborted" by design — that is success, not failure).
			if (runState.stopReason === "error" && runState.errorMessage && !runState.diaShortCircuited) {
				try {
					await ctx.replaceMessage("_Sorry, something went wrong_");
					await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else if (runState.diaShortCircuited && runState.diaFinalDisplay) {
				// DIA short-circuit: use the cached final display, ignore lastAssistant
				// (it is empty / aborted because we cancelled nano's 2nd LLM call).
				const finalText: string = runState.diaFinalDisplay;
				try {
					const mainText =
						finalText.length > SLACK_MAX_LENGTH
							? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
							: finalText;
					await ctx.replaceMessage(mainText);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to replace message with DIA final display", errMsg);
				}
			} else {
				// Final message update
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				// Check for [SILENT] marker - delete message and thread instead of posting
				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalText.trim()) {
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
