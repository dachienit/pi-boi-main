import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, isAbsolute, join, normalize } from "path";
import express from "express";
import * as log from "./log.js";
import type { BotContext, BotHandler } from "./types.js";

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
 *   { type: "status",  status: "thinking"|"working"|"idle"|"stopped" }
 *   { type: "delta",   text: string }
 *   { type: "replace", text: string }
 *   { type: "thread",  text: string }
 *   { type: "file",    path: string, title?: string }
 *   { type: "delete" }
 *   { type: "done",    stopReason: string }
 *   { type: "error",   message: string }
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
		let url = `http://localhost:${this.port}/artifacts/${relativePath}`;

		const tunnelUrlFile = "/tmp/artifacts-url.txt";
		if (existsSync(tunnelUrlFile)) {
			try {
				const tunnelUrl = readFileSync(tunnelUrlFile, "utf-8").trim();
				if (tunnelUrl && !tunnelUrl.includes("localhost") && !tunnelUrl.includes("127.0.0.1")) {
					url = `${tunnelUrl}/artifacts/${relativePath}`;
				}
			} catch { /* use local fallback */ }
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
		type ChatMessage = { role: "user" | "assistant"; text: string; attachments?: string[]; thread?: string; files?: Array<{ path: string; title?: string }> };

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
				type ToolResult = { toolCallId: string; toolName: string; text: string; isError: boolean };
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
						turn.toolResults.push({ toolCallId: msg.toolCallId, toolName: msg.toolName, text, isError: msg.isError });
					}
				}

				for (const turn of turns) {
					messages.push({ role: "user", text: turn.userText, attachments: turn.attachments.length > 0 ? turn.attachments : undefined });

					const mainText = turn.assistantTexts[turn.assistantTexts.length - 1] ?? "";
					const threadParts: string[] = [];
					const files: Array<{ path: string; title?: string }> = [];

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
					}

					const thread = threadParts.length > 0 ? threadParts.join("\n\n") : undefined;
					if (mainText || thread) {
						messages.push({ role: "assistant", text: mainText, thread, files: files.length > 0 ? files : undefined });
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
