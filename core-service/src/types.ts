/**
 * Generic bot channel types — shared across Slack, HTTP, and future adapters.
 */

import type { Attachment } from "./store.js";

// ============================================================================
// Channel / User info
// ============================================================================

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

// ============================================================================
// Bot event (adapter-agnostic incoming message)
// ============================================================================

export interface BotEvent {
	type: string; // "mention" | "dm" | "event" | adapter-specific
	channel: string;
	ts: string;
	user: string;
	text: string;
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
}

// ============================================================================
// Streaming step / pipeline events (claude.ai-style live activity)
// ============================================================================

export type StepKind = "oauth" | "history" | "fetch_dia" | "tool" | "iter";

export interface StepStartEvent {
	id: string;
	kind: StepKind;
	label: string;
	parentId?: string;
	args?: unknown;
}

export interface StepEndEvent {
	id: string;
	status: "ok" | "error";
	durationMs: number;
	summary?: string;
	output?: unknown;
}

export interface DiaPipelineSubStep {
	name: string;
	nodeType: string;
	executionTimeMs: number;
	friendlyLabel: string;
}

export interface DiaPipelineEvent {
	parentStepId: string;
	subSteps: DiaPipelineSubStep[];
}

export interface RagSource {
	title: string;
	similarityScore: number;
	sourceUrl: string;
	snippet: string;
}

export interface RagSourcesEvent {
	parentStepId: string;
	sources: RagSource[];
}

export interface LlmMetaEvent {
	parentStepId: string;
	model: string;
	temperature?: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

// ============================================================================
// Bot context (what the agent runner uses to respond)
// ============================================================================

export interface BotContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
	/** Granular activity-timeline emit (start of a sub-step). Optional: only HTTP adapter wires it. */
	emitStepStart?: (event: StepStartEvent) => void;
	emitStepEnd?: (event: StepEndEvent) => void;
	/** Post-hoc DIA pipeline breakdown after the blocking DIA call returns. */
	emitDiaPipeline?: (event: DiaPipelineEvent) => void;
	/** Top-K RAG embeddings extracted from the DIA debug payload. */
	emitRagSources?: (event: RagSourcesEvent) => void;
	/** LLM model + token usage extracted from the DIA debug payload. */
	emitLlmMeta?: (event: LlmMetaEvent) => void;
	/** Raw text chunk for synthetic typewriter effect (drives `delta` SSE event). */
	emitDelta?: (text: string) => void;
}

// ============================================================================
// Bot handler (channel-agnostic run coordinator in main.ts)
// ============================================================================

export interface BotHandler {
	isRunning(channelId: string): boolean;

	/**
	 * Run the agent for an incoming message.
	 * The ctx is pre-built by the adapter (Slack, HTTP, etc.).
	 */
	handleEvent(channelId: string, ctx: BotContext, isEvent?: boolean): Promise<void>;

	/**
	 * Abort the current run for a channel.
	 * @param onStopping — called immediately to notify the user (e.g. post "Stopping…")
	 * @param onStopped  — called once the run actually finishes (e.g. update to "Stopped")
	 */
	handleStop(
		channelId: string,
		onStopping: () => Promise<void>,
		onStopped: () => Promise<void>,
	): Promise<void>;
}

// ============================================================================
// Event router (minimal interface for EventsWatcher)
// ============================================================================

export interface EventRouter {
	/** Queue a synthetic event for processing. Returns false if the queue is full. */
	enqueueEvent(event: BotEvent): boolean;
}

// ============================================================================
// Skill catalog — DIA Brain skill endpoints
// ============================================================================

/**
 * Phase 1 ships only the `assistant` skill. Other skill names are reserved for
 * future phases — DIA SKILL.md persona files will be added without code changes.
 */
export type SkillName = "assistant" | "analysis" | "refactor" | "review" | "fix";

export const ENABLED_SKILLS: readonly SkillName[] = ["assistant"] as const;

// ============================================================================
// Canonical field catalog — pi-boi auto-dispatcher contract for DIA JSON output
// ============================================================================

/**
 * Canonical fields DIA may return. Pi-boi dispatcher scans these by name and
 * runs the corresponding action. Unknown fields are logged + ignored (forward
 * compat). DIA is workspace-blind: `file_name` is a basename only — pi-boi
 * resolves it against the session scratch directory via pathResolver.
 *
 * Phase 1 enables: display, file_name+file_content, html_artifact+file_name?,
 *                  error, next_hint
 * Phase 2/3 deferred: edit, bash_cmd, attach_path
 */
export interface DiaCanonicalResponse {
	/** Markdown text streamed to UI via typewriter. */
	display?: string;
	/** Simple basename (no path); pi-boi resolves to scratch/<channelId>/. */
	file_name?: string;
	/** Full file contents to write at resolved path. Requires file_name. */
	file_content?: string;
	/** Full HTML body for canvas artifact. Pi-boi writes to artifacts/<channelId>/. */
	html_artifact?: string;
	/** Error message to surface to user; stops further field dispatch. */
	error?: string;
	/** Informational hint for nano (read in tool result, not auto-executed). */
	next_hint?: string;
	/** Allow forward-compat unknown fields; dispatcher logs warning. */
	[key: string]: unknown;
}

export type CanonicalActionKind =
	| "display"
	| "write_file"
	| "write_artifact"
	| "error"
	| "next_hint";

export interface CanonicalActionResult {
	kind: CanonicalActionKind;
	ok: boolean;
	/** Resolved absolute path for write_file / write_artifact actions. */
	path?: string;
	error?: string;
	summary?: string;
}

export interface CanonicalDispatchResult {
	actions: CanonicalActionResult[];
	/** True if any action failed (file write rejected, sanitize failed, etc.). */
	hadError: boolean;
	/** Mirror of DIA's display so callers can persist / re-stream on refresh. */
	display?: string;
	/** Mirror of next_hint surfaced back to nano. */
	nextHint?: string;
	/** Files written and auto-attached, for chat chip rendering. */
	attachedFiles: Array<{ path: string; title?: string }>;
	/** Field names DIA returned that the dispatcher did not recognise. */
	unknownFields: string[];
}

// ============================================================================
// MCP scaffold (Phase 3 — interface only, no concrete server wired)
// ============================================================================

/**
 * Minimal MCP server descriptor for future integration. Phase 1 leaves the
 * registry empty; later phases will wire concrete MCP transports + tool
 * adapters into the agent loop alongside pi-boi raw tools.
 */
export interface MCPServer {
	name: string;
	transport: "stdio" | "sse" | "http";
	command?: string;
	args?: string[];
	url?: string;
	enabled: boolean;
}

export interface MCPRegistry {
	servers: MCPServer[];
	/** Phase 3: list discovered tools across enabled servers. */
	listTools?: () => Promise<Array<{ serverName: string; name: string; description: string }>>;
}
