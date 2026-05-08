import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, isAbsolute, join, normalize } from "path";
import express from "express";
import * as log from "./log.js";
import type {
	BotContext,
	BotHandler,
	DiaPipelineEvent,
	LlmMetaEvent,
	RagSourcesEvent,
	StepEndEvent,
	StepStartEvent,
} from "./types.js";

/**
 * Normalize a file path for the current OS.
 * - If path is an absolute Windows path (C:\...) on Linux, extract the relative part and resolve against workingDir
 * - If path is relative, resolve against workingDir
 * - Otherwise return normalized absolute path
 */
function normalizeFilePath(filePath: string, workingDir: string): string {
	// Check for Windows absolute path (e.g., C:\Users\... or D:\...)
	const windowsDrivePattern = /^[A-Za-z]:[\\\/]/;
	if (windowsDrivePattern.test(filePath)) {
		// On Linux, try to extract a meaningful relative path from Windows path
		// Look for known markers like "artifacts", "sessions", "workspacerks"
		const normalizedWinPath = filePath.replace(/\\/g, "/");
		const markers = ["workspacerks/", "artifacts/", "sessions/"];
		for (const marker of markers) {
			const idx = normalizedWinPath.indexOf(marker);
			if (idx !== -1) {
				const relativePart = normalizedWinPath.slice(idx);
				return join(workingDir, "..", relativePart);
			}
		}
		// Fallback: just use the filename
		return join(workingDir, basename(filePath));
	}

	// Regular path handling
	if (isAbsolute(filePath)) {
		return normalize(filePath);
	}
	return join(workingDir, filePath);
}

// ============================================================================
// HTTP context adapter
// ============================================================================

type SseEmitter = (event: object) => void;

function createHttpContext(opts: {
	channelId: string;
	userName: string;
	text: string;
	ts: string;
	send: SseEmitter;
	workingDir: string;
	attachments?: Array<{ local: string }>;
}): BotContext {
	const { channelId, userName, text, ts, send, workingDir, attachments = [] } = opts;

	const logToFile = (entry: object) => {
		const dir = join(workingDir, "sessions", channelId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	};

	return {
		message: {
			text,
			rawText: text,
			user: "web-user",
			userName,
			channel: channelId,
			ts,
			attachments,
		},
		channelName: channelId,
		channels: [{ id: channelId, name: channelId }],
		users: [{ id: "web-user", userName, displayName: userName }],

		respond: async (responseText: string, shouldLog = true) => {
			send({ type: "delta", text: responseText });
			if (shouldLog) {
				const responseTs = (Date.now() / 1000).toFixed(6);
				logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true });
			}
		},

		replaceMessage: async (responseText: string) => {
			send({ type: "replace", text: responseText });
			const responseTs = (Date.now() / 1000).toFixed(6);
			logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true, isFinal: true });
		},

		respondInThread: async (responseText: string) => {
			send({ type: "thread", text: responseText });
			const responseTs = (Date.now() / 1000).toFixed(6);
			logToFile({ date: new Date().toISOString(), ts: responseTs, user: "bot", text: responseText, attachments: [], isBot: true, isThread: true });
		},

		setTyping: async (isTyping: boolean) => {
			send({ type: "status", status: isTyping ? "thinking" : "idle" });
		},

		uploadFile: async (filePath: string, title?: string) => {
			send({ type: "file", path: filePath, title });
		},

		setWorking: async (working: boolean) => {
			send({ type: "status", status: working ? "working" : "idle" });
		},

		deleteMessage: async () => {
			send({ type: "delete" });
		},

		emitStepStart: (event: StepStartEvent) => {
			send({ type: "step_start", ...event });
		},

		emitStepEnd: (event: StepEndEvent) => {
			send({ type: "step_end", ...event });
		},

		emitDiaPipeline: (event: DiaPipelineEvent) => {
			send({ type: "dia_pipeline", ...event });
		},

		emitRagSources: (event: RagSourcesEvent) => {
			send({ type: "rag_sources", ...event });
		},

		emitLlmMeta: (event: LlmMetaEvent) => {
			send({ type: "llm_meta", ...event });
		},

		emitDelta: (chunk: string) => {
			send({ type: "delta", text: chunk });
		},
	};
}

// ============================================================================
// HTTP SSE Server
// ============================================================================

/**
 * HTTP server that exposes the bot via Server-Sent Events.
 *
 * Endpoints:
 *   POST /chat              – { channelId, text, userName? }  → SSE stream
 *   POST /stop              – { channelId }                   → { ok, message }
 *   GET  /status/:channelId                                   → { running }
 *   GET  /sessions                                            → SessionInfo[]
 *   GET  /messages/:channelId                                 → ChatMessage[]
 *   GET  /file?path=...                                       → raw file
 *   GET  /artifact-url?path=...                               → { url }
 *   GET  /artifacts/*                                         → static files from {workingDir}/artifacts/
 *
 * SSE event shapes:
 *   { type: "status",       status: "thinking"|"working"|"idle"|"stopped" }
 *   { type: "delta",        text: string }
 *   { type: "replace",      text: string }
 *   { type: "thread",       text: string }
 *   { type: "file",         path: string, title?: string }
 *   { type: "delete" }
 *   { type: "done",         stopReason: string }
 *   { type: "error",        message: string }
 *   { type: "step_start",   id, kind: "oauth"|"history"|"fetch_dia"|"tool"|"iter", label, parentId?, args? }
 *   { type: "step_end",     id, status: "ok"|"error", durationMs, summary?, output? }
 *   { type: "dia_pipeline", parentStepId, subSteps: [{ name, nodeType, executionTimeMs, friendlyLabel }] }
 *   { type: "rag_sources",  parentStepId, sources: [{ title, similarityScore, sourceUrl, snippet }] }
 *   { type: "llm_meta",     parentStepId, model, temperature?, promptTokens, completionTokens, totalTokens }
 */
export class HttpServer {
	private port: number;
	private workingDir: string;
	private handler: BotHandler;

	constructor(config: { port: number; workingDir: string; handler: BotHandler }) {
		this.port = config.port;
		this.workingDir = config.workingDir;
		this.handler = config.handler;
	}

	start(): void {
		const app = express();
		app.use(express.json({ limit: "50mb" }));

		// CORS
		app.use((_req, res, next) => {
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");
			next();
		});
		app.options("/{*path}", (_req, res) => { res.sendStatus(204); });

		// Static artifact files — serves {workingDir}/artifacts/ at /artifacts/
		const artifactsDir = join(this.workingDir, "artifacts");
		app.use("/artifacts", express.static(artifactsDir, { fallthrough: false }));

		// API routes
		app.post("/chat",           (req, res) => { void this.handleChat(req, res); });
		app.post("/stop",           (req, res) => { void this.handleStop(req, res); });
		app.get("/status/:id",      (req, res) => this.handleStatus(req.params.id, res));
		app.get("/sessions",        (_req, res) => this.handleSessions(res));
		app.get("/messages/:id",    (req, res) => this.handleMessages(decodeURIComponent(req.params.id), res));
		app.get("/file",            (req, res) => this.handleFile(String(req.query.path ?? ""), res));
		app.get("/artifact-url",    (req, res) => this.handleArtifactUrl(String(req.query.path ?? ""), res));

		app.listen(this.port, () => {
			log.logInfo(`HTTP SSE server listening on port ${this.port}`);
			log.logInfo(`Artifacts served from: ${artifactsDir}`);
		});
	}

	// ==========================================================================
	// Handlers
	// ==========================================================================

	private async handleChat(req: express.Request, res: express.Response): Promise<void> {
		type AttachmentPayload = { fileName: string; mimeType: string; content: string };
		const { channelId, text, userName = "user", attachments = [] } = req.body as {
			channelId?: string; text?: string; userName?: string; attachments?: AttachmentPayload[];
		};

		if (!channelId || !text) {
			res.status(400).json({ error: "Missing channelId or text" });
			return;
		}

		if (this.handler.isRunning(channelId)) {
			res.status(409).json({ error: "Already running. POST /stop first." });
			return;
		}

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		const send: SseEmitter = (event) => {
			if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
		};

		const ts = (Date.now() / 1000).toFixed(6);
		const channelDir = join(this.workingDir, "sessions", channelId);
		if (!existsSync(channelDir)) mkdirSync(channelDir, { recursive: true });

		const savedAttachments: Array<{ local: string }> = [];
		if (attachments.length > 0) {
			const attachDir = join(channelDir, "attachments");
			if (!existsSync(attachDir)) mkdirSync(attachDir, { recursive: true });
			for (const att of attachments) {
				const safeName = `${Date.now()}_${att.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
				const filePath = join(attachDir, safeName);
				writeFileSync(filePath, Buffer.from(att.content, "base64"));
				savedAttachments.push({ local: `sessions/${channelId}/attachments/${safeName}` });
			}
		}

		const ctx = createHttpContext({ channelId, userName, text, ts, send, workingDir: this.workingDir, attachments: savedAttachments });

		appendFileSync(
			join(channelDir, "log.jsonl"),
			`${JSON.stringify({ date: new Date().toISOString(), ts, user: "web-user", userName, text, attachments: savedAttachments, isBot: false })}\n`,
		);

		log.logInfo(`[${channelId}] HTTP: Starting run: ${text.substring(0, 50)}`);

		try {
			await this.handler.handleEvent(channelId, ctx);
			send({ type: "done" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[${channelId}] HTTP run error`, msg);
			send({ type: "error", message: msg });
		} finally {
			res.end();
		}
	}

	private async handleStop(req: express.Request, res: express.Response): Promise<void> {
		const { channelId } = req.body as { channelId?: string };
		if (!channelId) {
			res.status(400).json({ error: "Missing channelId" });
			return;
		}

		if (this.handler.isRunning(channelId)) {
			await this.handler.handleStop(channelId, async () => {}, async () => {});
			res.json({ ok: true, message: "Stopping..." });
		} else {
			res.json({ ok: false, message: "Nothing running" });
		}
	}

	private handleStatus(channelId: string, res: express.Response): void {
		res.json({ running: this.handler.isRunning(channelId) });
	}

	private handleArtifactUrl(filePath: string, res: express.Response): void {
		const artifactsDir = normalize(join(this.workingDir, "artifacts"));
		// Use normalizeFilePath to handle cross-platform paths
		const normalizedFilePath = normalizeFilePath(filePath, this.workingDir);

		if (!filePath || !normalizedFilePath.startsWith(artifactsDir)) {
			res.json({ url: null });
			return;
		}

		// Get relative path and convert to forward slashes for URL
		const relativePath = normalizedFilePath.slice(artifactsDir.length).replace(/^[/\\]/, "").replace(/\\/g, "/");
		
		// Use relative URL by default - browser/proxy will handle the correct base URL
		// This works for both localhost and SAP BAS/cloud environments
		let url = `/artifacts/${relativePath}`;

		// Override with explicit tunnel URL if configured (for special cases like ngrok)
		const tunnelUrlFile = "/tmp/artifacts-url.txt";
		if (existsSync(tunnelUrlFile)) {
			try {
				const tunnelUrl = readFileSync(tunnelUrlFile, "utf-8").trim();
				if (tunnelUrl && !tunnelUrl.includes("localhost") && !tunnelUrl.includes("127.0.0.1")) {
					url = `${tunnelUrl}/artifacts/${relativePath}`;
				}
			} catch { /* use relative URL fallback */ }
		}

		res.json({ url });
	}

	private handleFile(filePath: string, res: express.Response): void {
		if (!filePath) {
			res.status(400).json({ error: "Missing path" });
			return;
		}

		// Use normalizeFilePath for cross-platform support (handles Windows paths on Linux)
		const resolved = normalizeFilePath(filePath, this.workingDir);
		const normalizedWorkingDir = normalize(this.workingDir);

		log.logInfo(`[/file] path=${filePath}, resolved=${resolved}, workingDir=${normalizedWorkingDir}`);

		if (!resolved.startsWith(normalizedWorkingDir)) {
			log.logWarning(`[/file] Forbidden: resolved path not in workingDir`);
			res.status(403).json({ error: "Forbidden" });
			return;
		}

		if (!existsSync(resolved)) {
			log.logWarning(`[/file] Not found: ${resolved}`);
			res.status(404).json({ error: "Not found" });
			return;
		}

		res.sendFile(resolved);
	}

	private handleMessages(channelId: string, res: express.Response): void {
		type ContextEntry = { type: string; timestamp?: string; message?: Record<string, any> };
		// TimelineStep mirrors the frontend AgentActivityTimeline.TimelineStep shape.
		// Sent over the wire as JSON; the web-ui maps it directly into <agent-activity-timeline>.
		type TimelineStep = {
			id: string;
			kind: "oauth" | "history" | "fetch_dia" | "tool" | "iter";
			label: string;
			parentId?: string;
			status: "ok" | "error";
			durationMs?: number;
			summary?: string;
			subSteps?: Array<Record<string, unknown>>;
			ragSources?: Array<Record<string, unknown>>;
			llmMeta?: Record<string, unknown>;
		};
		// FlowBlock interleaves activity-card groups with assistant display text so
		// the web-ui can render claude.ai-style: card → text → card → card → text...
		type FlowBlock =
			| { type: "steps"; steps: TimelineStep[] }
			| { type: "text"; text: string };
		type ChatMessage = {
			role: "user" | "assistant";
			text: string;
			attachments?: string[];
			thread?: string;
			files?: Array<{ path: string; title?: string }>;
			flow?: FlowBlock[];
		};

		// Rebuild interleaved FlowBlock[] from the persisted details.timeline payload
		// of a callDIABrain toolResult. Stable IDs are derived from the parent
		// toolCallId + iteration / phase / tool index so re-renders don't churn.
		//
		// Per iteration:
		//   - if `displayText` is present (new sessions): emit
		//       { steps: [iter + phases] }, { text: displayText }, { steps: [tool] }*
		//     so each tool becomes its own top-level card AFTER the text.
		//   - else (legacy sessions, pre-Phase 8.5): emit one nested
		//       { steps: [iter + phases + tools-with-parentId] } block so the
		//       layout matches the old monolithic timeline card.
		//
		// When NO iteration carried `displayText` and `finalDiaDisplay` exists, it
		// is appended as a trailing { text } block so legacy sessions still show
		// the assistant's response below the activity card.
		const rebuildFlow = (
			toolCallId: string,
			persisted: any[],
			finalDiaDisplay?: string,
		): FlowBlock[] => {
			const out: FlowBlock[] = [];
			let anyDisplayText = false;

			persisted.forEach((iter, i) => {
				if (!iter || typeof iter !== "object") return;
				const iterId = `${toolCallId}-iter-${i}`;
				const iterStep: TimelineStep = {
					id: iterId,
					kind: "iter",
					label: typeof iter.label === "string" ? iter.label : `DIA iteration ${i + 1}`,
					status: iter.status === "error" ? "error" : "ok",
					durationMs: typeof iter.durationMs === "number" ? iter.durationMs : undefined,
					summary: typeof iter.summary === "string" ? iter.summary : undefined,
					subSteps: Array.isArray(iter.pipeline) ? iter.pipeline : undefined,
					ragSources: Array.isArray(iter.ragSources) ? iter.ragSources : undefined,
					llmMeta: iter.llmMeta && typeof iter.llmMeta === "object" ? iter.llmMeta : undefined,
				};

				const phaseSteps: TimelineStep[] = [];
				for (const phase of Array.isArray(iter.phases) ? iter.phases : []) {
					if (!phase || typeof phase !== "object") continue;
					const phaseKind = phase.phase as TimelineStep["kind"];
					if (phaseKind !== "oauth" && phaseKind !== "history" && phaseKind !== "fetch_dia") continue;
					phaseSteps.push({
						id: `${iterId}-phase-${phase.phase}`,
						kind: phaseKind,
						label: typeof phase.label === "string" ? phase.label : phase.phase,
						parentId: iterId,
						status: phase.status === "error" ? "error" : "ok",
						durationMs: typeof phase.durationMs === "number" ? phase.durationMs : undefined,
						summary: typeof phase.summary === "string" ? phase.summary : undefined,
					});
				}

				const toolList = Array.isArray(iter.tools) ? iter.tools : [];
				const displayText = typeof iter.displayText === "string" ? iter.displayText.trim() : "";

				if (displayText) {
					anyDisplayText = true;
					// NEW interleaved layout: iter card → display text → per-tool cards.
					out.push({ type: "steps", steps: [iterStep, ...phaseSteps] });
					out.push({ type: "text", text: displayText });
					toolList.forEach((tool: any, j: number) => {
						if (!tool || typeof tool !== "object") return;
						const toolStep: TimelineStep = {
							id: `${iterId}-tool-${j}`,
							kind: "tool",
							label:
								typeof tool.label === "string"
									? tool.label
									: typeof tool.tool === "string"
										? tool.tool
										: "tool",
							// NO parentId -- top-level card sitting AFTER the text.
							status: tool.status === "error" ? "error" : "ok",
							durationMs: typeof tool.durationMs === "number" ? tool.durationMs : undefined,
							summary: typeof tool.summary === "string" ? tool.summary : undefined,
						};
						out.push({ type: "steps", steps: [toolStep] });
					});
				} else {
					// LEGACY nested layout for sessions written before displayText capture.
					const nestedTools: TimelineStep[] = toolList
						.filter((t: any) => t && typeof t === "object")
						.map((tool: any, j: number) => ({
							id: `${iterId}-tool-${j}`,
							kind: "tool",
							label:
								typeof tool.label === "string"
									? tool.label
									: typeof tool.tool === "string"
										? tool.tool
										: "tool",
							parentId: iterId,
							status: tool.status === "error" ? "error" : "ok",
							durationMs: typeof tool.durationMs === "number" ? tool.durationMs : undefined,
							summary: typeof tool.summary === "string" ? tool.summary : undefined,
						}));
					out.push({ type: "steps", steps: [iterStep, ...phaseSteps, ...nestedTools] });
				}
			});

			// Legacy fallback: trailing text block from finalDiaDisplay when no iter
			// supplied displayText (pre-Phase 8.5 sessions or non-JSON DIA replies).
			if (!anyDisplayText && finalDiaDisplay && finalDiaDisplay.trim()) {
				out.push({ type: "text", text: finalDiaDisplay.trim() });
			}

			return out;
		};

		const formatArgs = (args: Record<string, any>): string => {
			const lines: string[] = [];
			for (const [key, value] of Object.entries(args)) {
				if (key === "label") continue;
				if (key === "path" && typeof value === "string") {
					const range = args.offset !== undefined && args.limit !== undefined
						? `:${args.offset}-${args.offset + args.limit}` : "";
					lines.push(value + range);
					continue;
				}
				if (key === "offset" || key === "limit") continue;
				const str = typeof value === "string" ? value : JSON.stringify(value);
				lines.push(str.length > 300 ? str.slice(0, 300) + "…" : str);
			}
			return lines.join("\n");
		};

		const contextFile = join(this.workingDir, "sessions", channelId, "context.jsonl");
		const messages: ChatMessage[] = [];

		if (existsSync(contextFile)) {
			try {
				const lines = readFileSync(contextFile, "utf-8").trim().split("\n").filter(Boolean);
				const entries: ContextEntry[] = [];
				for (const line of lines) {
					try { entries.push(JSON.parse(line)); } catch { /* skip */ }
				}

				type ToolCall = { id: string; name: string; label?: string; args: Record<string, any> };
				type ToolResult = {
					toolCallId: string;
					toolName: string;
					text: string;
					isError: boolean;
					details?: Record<string, any>;
				};
				type Turn = { userText: string; attachments: string[]; toolCalls: ToolCall[]; toolResults: ToolResult[]; assistantTexts: string[] };

				const stripPrefix = (text: string) =>
					text.replace(/^(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] )?\[[^\]]+\]: /, "");

				const extractAttachments = (text: string): { text: string; attachments: string[] } => {
					const match = text.match(/<attachments>\n([\s\S]*?)\n<\/attachments>/);
					if (!match) return { text, attachments: [] };
					const names = match[1].split("\n").filter(Boolean).map((p) => p.split(/[/\\]/).pop() ?? p);
					return { text: text.replace(/\n\n<attachments>[\s\S]*?<\/attachments>/, "").trim(), attachments: names };
				};

				const turns: Turn[] = [];

				for (const entry of entries) {
					if (entry.type !== "message" || !entry.message) continue;
					const msg = entry.message;

					if (msg.role === "user") {
						const textPart = (msg.content as any[])?.find((c: any) => c.type === "text");
						if (!textPart?.text) continue;
						const { text: cleanText, attachments } = extractAttachments(stripPrefix(textPart.text));
						turns.push({ userText: cleanText, attachments, toolCalls: [], toolResults: [], assistantTexts: [] });
					} else if (msg.role === "assistant") {
						if (turns.length === 0) continue;
						const turn = turns[turns.length - 1];
						for (const part of (msg.content as any[]) || []) {
							if (part.type === "toolCall") {
								turn.toolCalls.push({ id: part.id, name: part.name, label: part.arguments?.label, args: part.arguments ?? {} });
							} else if (part.type === "text" && part.text?.trim()) {
								turn.assistantTexts.push(part.text.trim());
							}
						}
					} else if (msg.role === "toolResult") {
						if (turns.length === 0) continue;
						const turn = turns[turns.length - 1];
						const text = (msg.content as any[])?.find((c: any) => c.type === "text")?.text ?? "";
						turn.toolResults.push({
							toolCallId: msg.toolCallId,
							toolName: msg.toolName,
							text,
							isError: msg.isError,
							details: msg.details as Record<string, any> | undefined,
						});
					}
				}

				for (const turn of turns) {
					messages.push({ role: "user", text: turn.userText, attachments: turn.attachments.length > 0 ? turn.attachments : undefined });

					let mainText = turn.assistantTexts[turn.assistantTexts.length - 1] ?? "";
					const threadParts: string[] = [];
					const files: Array<{ path: string; title?: string }> = [];
					const flowBlocks: FlowBlock[] = [];

					for (const tc of turn.toolCalls) {
						const result = turn.toolResults.find((r) => r.toolCallId === tc.id);
						let block = `**${result?.isError ? "✗" : "✓"} ${tc.name}**`;
						if (tc.label) block += `: ${tc.label}`;
						const argsStr = formatArgs(tc.args);
						if (argsStr) block += `\n\`\`\`\n${argsStr}\n\`\`\``;
						if (result) {
							const resultStr = result.text;
							block += `\n**Result:**\n\`\`\`\n${resultStr.slice(0, 500)}${resultStr.length > 500 ? "\n…" : ""}\n\`\`\``;
						}
						threadParts.push(block);
						if (tc.name === "attach" && tc.args.path) {
							// Normalize path to handle cross-platform session access (Windows path on Linux, etc.)
							const normalizedPath = normalizeFilePath(tc.args.path as string, this.workingDir);
							files.push({ path: normalizedPath, title: tc.args.title as string | undefined });
						}

						// callDIABrain runs `attach` nested in its sub-loop, so the file paths
						// only live in the toolResult's `details.attachedFiles`. Lift them up
						// here so chips re-appear on page refresh. Likewise, fall back to the
						// DIA `display` text when the assistant message body is empty (which
						// happens whenever short-circuit aborts nano before it emits text).
						if (tc.name === "callDIABrain" && result?.details) {
							const details = result.details;
							const nested = Array.isArray(details.attachedFiles) ? details.attachedFiles : [];
							for (const f of nested) {
								if (f && typeof f.path === "string") {
									const normalizedPath = normalizeFilePath(f.path, this.workingDir);
									files.push({ path: normalizedPath, title: typeof f.title === "string" ? f.title : undefined });
								}
							}
							if (!mainText && typeof details.finalDiaDisplay === "string" && details.finalDiaDisplay.trim()) {
								mainText = details.finalDiaDisplay.trim();
							}
							if (Array.isArray(details.timeline) && details.timeline.length > 0) {
								const finalDisplay =
									typeof details.finalDiaDisplay === "string" ? details.finalDiaDisplay : undefined;
								flowBlocks.push(...rebuildFlow(tc.id, details.timeline, finalDisplay));
							}
						}
					}

					const thread = threadParts.length > 0 ? threadParts.join("\n\n") : undefined;
					if (mainText || thread || flowBlocks.length > 0) {
						messages.push({
							role: "assistant",
							text: mainText,
							thread,
							files: files.length > 0 ? files : undefined,
							flow: flowBlocks.length > 0 ? flowBlocks : undefined,
						});
					}
				}
			} catch { /* unreadable file */ }
		}

		res.json(messages);
	}

	private handleSessions(res: express.Response): void {
		type SessionInfo = { channelId: string; preview: string; messageCount: number; lastModified: number };
		const sessions: SessionInfo[] = [];

		const sessionsDir = join(this.workingDir, "sessions");
		try {
			if (existsSync(sessionsDir)) {
				for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
					if (!entry.isDirectory()) continue;
					const logFile = join(sessionsDir, entry.name, "log.jsonl");
					if (!existsSync(logFile)) continue;

					try {
						const stat = statSync(logFile);
						const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
						let messageCount = 0;
						let preview = "";

						for (const line of lines) {
							try {
								const msg = JSON.parse(line);
								if (!msg.isBot && msg.text) {
									messageCount++;
									if (!preview) preview = msg.text;
								}
							} catch { /* skip */ }
						}

						sessions.push({
							channelId: entry.name,

							preview: preview.length > 80 ? preview.slice(0, 80) + "…" : preview,
							messageCount,
							lastModified: stat.mtimeMs,
						});
					} catch { /* skip */ }
				}
			}
		} catch { /* workingDir unreadable */ }

		sessions.sort((a, b) => b.lastModified - a.lastModified);
		res.json(sessions);
	}
}
