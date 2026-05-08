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
