import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { chatWithDIA, type DiaPhaseEvent } from "../dia/diaClient.js";
import { extractLlmMeta, extractRagSources, mapPipelineSubSteps } from "../dia/debugSteps.js";
import { typewriteText } from "../streaming/typewriter.js";
import type {
	DiaPipelineEvent,
	DiaPipelineSubStep,
	LlmMetaEvent,
	RagSource,
	RagSourcesEvent,
	StepEndEvent,
	StepStartEvent,
} from "../types.js";

const callDIABrainSchema = Type.Object({
	label: Type.String({
		description:
			"Short user-visible action label. MUST follow the format 'Ask DIA: <verb phrase>' " +
			"(e.g. 'Ask DIA: generate ZCL_PO_READER', 'Ask DIA: refactor legacy SELECT', 'Ask DIA: review CDS view'). " +
			"Keep it under 60 characters. Do NOT prefix with 'DIABrain:' or any other variant.",
	}),
	query: Type.String({
		description:
			"VERBATIM RELAY of the user's most recent message. Copy byte-for-byte: " +
			"do NOT translate, paraphrase, expand, polish, capitalize, or add anything. " +
			"FORBIDDEN: file names, class names, table names, field names, ABAP code, REPORT/CLASS/INTERFACE headers, " +
			"scratch paths, package names, transport requests, or any technical detail the user did not literally type. " +
			"DIA Brain has RAG + chat history and decides ALL technical details. Your only job is to relay raw text. " +
			"If the user typed 'write a simple program', then query MUST be exactly 'write a simple program' -- nothing more.",
	}),
	terminal: Type.Optional(
		Type.Boolean({
			description:
				"Default true. When true, OctoAgent surfaces DIA's final `display` text directly to the UI " +
				"and short-circuits the agent loop — DIA's response IS the answer and you (the router) MUST NOT " +
				"emit any follow-up text. Set false ONLY if you genuinely need to call additional tools " +
				"(read/edit/bash/write) AFTER DIA finishes. This is rare.",
		}),
	),
});

const MAX_SUB_ITERATIONS = 10;
const SKILL_FILENAME = "SKILL.md";
const SKILL_DIR = "assistant";

interface DiaPlanStep {
	tool: string;
	args: Record<string, unknown>;
}

interface DiaPlan {
	display?: string;
	plan?: DiaPlanStep[];
	done?: boolean;
}

interface ToolResultRecord {
	tool: string;
	ok: boolean;
	output?: string;
	error?: string;
}

interface AttachedFileRef {
	path: string;
	title?: string;
}

// ============================================================================
// Persisted timeline shapes — written into context.jsonl via toolResult.details
// so /messages can rebuild the live activity timeline on page refresh.
// ============================================================================

export interface PersistedPhase {
	phase: "oauth" | "history" | "fetch_dia";
	label: string;
	durationMs: number;
	status: "ok" | "error";
	cached?: boolean;
	summary?: string;
}

export interface PersistedTool {
	tool: string;
	label: string;
	durationMs: number;
	status: "ok" | "error";
	summary?: string;
}

export type PersistedLlmMeta = Omit<LlmMetaEvent, "type" | "parentStepId">;

export interface PersistedIteration {
	label: string;
	durationMs: number;
	status: "ok" | "error";
	summary?: string;
	phases: PersistedPhase[];
	pipeline?: DiaPipelineSubStep[];
	ragSources?: RagSource[];
	llmMeta?: PersistedLlmMeta;
	tools: PersistedTool[];
	/**
	 * The DIA `display` text streamed inline AFTER this iteration's card is
	 * finalised but BEFORE its tool plan executes. Persisted so /messages can
	 * re-interleave the text between activity cards on refresh.
	 */
	displayText?: string;
}

interface CallDIABrainDetails {
	iterations: number;
	chatHistoryId?: string;
	toolsRun: { tool: string; ok: boolean }[];
	finalDiaDisplay?: string;
	shortCircuit?: boolean;
	/**
	 * Set when the DIA `display` text was already streamed inline via emitDelta.
	 * The agent.ts subscriber uses this to skip a duplicate enqueueMessage call.
	 */
	streamedInline?: boolean;
	/**
	 * Files attached by DIA during this sub-loop (via the nested `attach` tool).
	 * Persisted to context.jsonl so /messages can rebuild file chips on page refresh.
	 */
	attachedFiles?: AttachedFileRef[];
	/**
	 * Full activity timeline (per-iteration: phases, pipeline, RAG, LLM meta, tools).
	 * Persisted to context.jsonl so /messages can rebuild the timeline UI on refresh.
	 */
	timeline?: PersistedIteration[];
}

// ============================================================================
// Module-level emitter wiring (set per-run by agent.ts, similar to setUploadFunction)
// ============================================================================

export interface DiaStreamEmitters {
	emitStepStart?: (event: StepStartEvent) => void;
	emitStepEnd?: (event: StepEndEvent) => void;
	emitDiaPipeline?: (event: DiaPipelineEvent) => void;
	emitRagSources?: (event: RagSourcesEvent) => void;
	emitLlmMeta?: (event: LlmMetaEvent) => void;
	emitDelta?: (chunk: string) => void;
}

let activeEmitters: DiaStreamEmitters = {};

export function setDiaEmitters(emitters: DiaStreamEmitters): void {
	activeEmitters = emitters ?? {};
}

export function clearDiaEmitters(): void {
	activeEmitters = {};
}

let stepCounter = 0;
function nextStepId(prefix: string): string {
	stepCounter += 1;
	return `${prefix}-${Date.now().toString(36)}-${stepCounter}`;
}

// ============================================================================
// Helpers
// ============================================================================

function stripJsonFences(text: string): string {
	const trimmed = text.trim();
	const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fenceMatch) return fenceMatch[1].trim();
	return trimmed;
}

function tryParseDiaPlan(rawText: string): DiaPlan | null {
	const cleaned = stripJsonFences(rawText);
	try {
		const parsed = JSON.parse(cleaned);
		if (parsed && typeof parsed === "object") return parsed as DiaPlan;
	} catch {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				const parsed = JSON.parse(cleaned.slice(start, end + 1));
				if (parsed && typeof parsed === "object") return parsed as DiaPlan;
			} catch {
				/* fall through */
			}
		}
	}
	return null;
}

function renderToolsCatalog(peerTools: AgentTool<any>[]): string {
	const summaryLines = peerTools.map((tool) => `- **${tool.name}** — ${tool.description}`);
	const schema = peerTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	return [
		"### Tool summary",
		summaryLines.join("\n"),
		"",
		"### Tool JSON schemas (source of truth for `args`)",
		"```json",
		JSON.stringify(schema, null, 2),
		"```",
	].join("\n");
}

function loadSkill(hostWorkspacePath: string): string {
	const skillPath = join(hostWorkspacePath, "skills", SKILL_DIR, SKILL_FILENAME);
	if (!existsSync(skillPath)) {
		throw new Error(
			`Skill 'assistant' not found at ${skillPath}. ` +
				`Create the file or run the OctoAgent setup that seeds workspace skills.`,
		);
	}
	return readFileSync(skillPath, "utf-8");
}

async function runOnePlanStep(
	step: DiaPlanStep,
	peerTools: AgentTool<any>[],
	toolCallId: string,
	stepIndex: number,
	signal: AbortSignal | undefined,
): Promise<ToolResultRecord> {
	const tool = peerTools.find((t) => t.name === step.tool);
	if (!tool) {
		return { tool: step.tool, ok: false, error: `unknown tool '${step.tool}'` };
	}
	if (!step.args || typeof step.args !== "object") {
		return { tool: step.tool, ok: false, error: "missing args object" };
	}

	try {
		const result = await tool.execute(`${toolCallId}:${stepIndex}`, step.args as never, signal);
		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return { tool: step.tool, ok: true, output: text || "(ok)" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { tool: step.tool, ok: false, error: message };
	}
}

function summariseExecution(toolsRun: { tool: string; ok: boolean }[]): string {
	if (toolsRun.length === 0) return "(no tools executed)";
	return toolsRun.map((t) => `${t.ok ? "✓" : "✗"} ${t.tool}`).join("  ");
}

function truncateForLog(text: string, max = 80): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Map a DIA `onPhase` event to a UI step (oauth / history / fetch_dia) AND
 * append a persistable record to `phaseSink` so the timeline survives refresh.
 */
function bridgePhaseToStep(
	parentId: string,
	phaseSink: PersistedPhase[],
): (event: DiaPhaseEvent) => void {
	const open = new Map<string, { id: string; t0: number; label: string; cached?: boolean }>();
	const kindMap: Record<DiaPhaseEvent["phase"], "oauth" | "history" | "fetch_dia"> = {
		oauth: "oauth",
		history: "history",
		fetch: "fetch_dia",
	};
	const labelMap: Record<DiaPhaseEvent["phase"], string> = {
		oauth: "Get DIA token",
		history: "Open chat history",
		fetch: "Ask DIA Brain",
	};

	return (e) => {
		const kind = kindMap[e.phase];
		const baseLabel = labelMap[e.phase];
		const fullLabel = e.cached ? `${baseLabel} (cached)` : baseLabel;

		if (e.stage === "start") {
			const id = nextStepId(`phase-${e.phase}`);
			open.set(e.phase, { id, t0: Date.now(), label: fullLabel, cached: e.cached });
			activeEmitters.emitStepStart?.({ id, kind, label: fullLabel, parentId });
		} else {
			const opened = open.get(e.phase);
			const id = opened?.id ?? nextStepId(`phase-${e.phase}`);
			const durationMs = e.durationMs ?? (opened ? Date.now() - opened.t0 : 0);
			const summary = e.error ? e.error : e.cached ? "cached" : `${durationMs}ms`;
			open.delete(e.phase);
			activeEmitters.emitStepEnd?.({
				id,
				status: e.error ? "error" : "ok",
				durationMs,
				summary,
			});
			phaseSink.push({
				phase: kind,
				label: opened?.label ?? fullLabel,
				durationMs,
				status: e.error ? "error" : "ok",
				cached: opened?.cached ?? e.cached,
				summary,
			});
		}
	};
}

// ============================================================================
// Tool factory
// ============================================================================

export function createCallDIABrainTool(
	channelId: string,
	peerTools: AgentTool<any>[],
	_workingDir: string,
	hostWorkspacePath: string,
): AgentTool<typeof callDIABrainSchema> {
	return {
		name: "callDIABrain",
		label: "callDIABrain",
		description:
			"Call DIA Brain (Claude + RAG over Bosch internal SAP knowledge base). Use this for ANY SAP / ABAP / CDS / RAP / S/4HANA / ABAP Cloud / OData / BAdI / AMDP question. " +
			"DIA plans the next concrete step (write file, edit file, attach, etc.) and OctoAgent executes the plan on its behalf. " +
			"Pass the user's full natural-language request as `query`. Do NOT pre-translate or pre-format.",
		parameters: callDIABrainSchema,
		execute: async (
			toolCallId: string,
			{ query, terminal }: { label: string; query: string; terminal?: boolean },
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<CallDIABrainDetails>,
		) => {
			const isTerminal = terminal !== false; // default true
			const skillTemplate = loadSkill(hostWorkspacePath);
			const toolsCatalog = renderToolsCatalog(peerTools);
			const withTools = skillTemplate.includes("{{TOOLS}}")
				? skillTemplate.replace(/\{\{TOOLS\}\}/g, toolsCatalog)
				: `${skillTemplate}\n\n## Available tools\n\n${toolsCatalog}`;
			const customMessageBehaviour = withTools.replace(/\{\{CHANNEL_ID\}\}/g, channelId);

			const progressLog: string[] = [];
			const toolsRun: { tool: string; ok: boolean }[] = [];
			const attachedFiles: AttachedFileRef[] = [];
			const persistedIterations: PersistedIteration[] = [];
			let lastChatHistoryId: string | undefined;
			let lastDisplay = "";
			let didStreamInline = false;

			const emit = () => {
				onUpdate?.({
					content: [{ type: "text", text: progressLog.join("\n") }],
					details: {
						iterations: progressLog.filter((l) => l.startsWith("→ DIA")).length,
						chatHistoryId: lastChatHistoryId,
						toolsRun: [...toolsRun],
					},
				});
			};

			let prompt = query;

			/**
			 * Run a DIA-supplied tool plan, emitting per-tool step events.
			 *
			 * - When `parentId` is set (multi-iter, not-done case), tools render as
			 *   children of the iter card.
			 * - When `parentId` is undefined (single-pass done case), tools render
			 *   as TOP-LEVEL cards interleaved with the typewritten display text.
			 */
			const runPlanTools = async (
				planSteps: DiaPlanStep[],
				parentId: string | undefined,
				currentIter: PersistedIteration,
				onAbort?: () => void,
			): Promise<ToolResultRecord[]> => {
				const iterResults: ToolResultRecord[] = [];
				for (let stepIdx = 0; stepIdx < planSteps.length; stepIdx++) {
					const step = planSteps[stepIdx];
					if (signal?.aborted) {
						progressLog.push("× aborted mid-plan");
						emit();
						onAbort?.();
						throw new Error("callDIABrain aborted");
					}

					const toolStepId = nextStepId(`tool-${step.tool}`);
					const toolT0 = Date.now();
					activeEmitters.emitStepStart?.({
						id: toolStepId,
						kind: "tool",
						label: step.tool,
						...(parentId ? { parentId } : {}),
						args: step.args,
					});

					progressLog.push(`→ ${step.tool}…`);
					emit();
					const record = await runOnePlanStep(step, peerTools, toolCallId, stepIdx, signal);
					iterResults.push(record);
					toolsRun.push({ tool: record.tool, ok: record.ok });

					// Capture attached files so /messages can rebuild file chips on refresh.
					if (record.ok && step.tool === "attach" && typeof step.args.path === "string") {
						attachedFiles.push({
							path: step.args.path,
							title: typeof step.args.title === "string" ? step.args.title : undefined,
						});
					}

					const toolDur = Date.now() - toolT0;
					const toolSummary = record.ok ? truncateForLog(record.output ?? "") : record.error;
					activeEmitters.emitStepEnd?.({
						id: toolStepId,
						status: record.ok ? "ok" : "error",
						durationMs: toolDur,
						summary: toolSummary,
					});
					currentIter.tools.push({
						tool: record.tool,
						label: step.tool,
						durationMs: toolDur,
						status: record.ok ? "ok" : "error",
						summary: toolSummary,
					});

					progressLog.push(
						record.ok
							? `  ✓ ${record.tool} ${truncateForLog(record.output ?? "")}`
							: `  ✗ ${record.tool}: ${record.error}`,
					);
					emit();
				}
				return iterResults;
			};

			for (let iter = 1; iter <= MAX_SUB_ITERATIONS; iter++) {
				if (signal?.aborted) {
					progressLog.push(`× aborted before iter ${iter}`);
					emit();
					throw new Error("callDIABrain aborted");
				}

				// === Iteration step (parent for all sub-steps in this round) ===
				const iterStepId = nextStepId("iter");
				const iterT0 = Date.now();
				const iterLabel = `DIA iteration ${iter}`;
				activeEmitters.emitStepStart?.({
					id: iterStepId,
					kind: "iter",
					label: iterLabel,
				});
				progressLog.push(`→ DIA thinking (iter ${iter})…`);
				emit();

				// Persistable skeleton for this iteration — finalised at end of loop.
				const currentIter: PersistedIteration = {
					label: iterLabel,
					durationMs: 0,
					status: "ok",
					phases: [],
					tools: [],
				};

				const { result, chatHistoryId, debugSteps } = await chatWithDIA({
					prompt,
					customMessageBehaviour,
					channelId,
					mode: "rag",
					signal,
					onPhase: bridgePhaseToStep(iterStepId, currentIter.phases),
				});
				lastChatHistoryId = chatHistoryId;

				// === Replay DIA pipeline / RAG / LLM meta from debug payload ===
				if (debugSteps && debugSteps.length > 0) {
					const subSteps = mapPipelineSubSteps(debugSteps);
					if (subSteps.length > 0) {
						activeEmitters.emitDiaPipeline?.({ parentStepId: iterStepId, subSteps });
						currentIter.pipeline = subSteps;
					}
					const sources = extractRagSources(debugSteps);
					if (sources.length > 0) {
						activeEmitters.emitRagSources?.({ parentStepId: iterStepId, sources });
						currentIter.ragSources = sources;
					}
					const llmMeta = extractLlmMeta(debugSteps);
					if (llmMeta) {
						activeEmitters.emitLlmMeta?.({ parentStepId: iterStepId, ...llmMeta });
						currentIter.llmMeta = llmMeta;
					}
				}

				const parsed = tryParseDiaPlan(result);

				if (!parsed) {
					progressLog.push("⚠ DIA returned non-JSON, surfacing raw text");
					emit();
					const iterDur = Date.now() - iterT0;
					activeEmitters.emitStepEnd?.({
						id: iterStepId,
						status: "ok",
						durationMs: iterDur,
						summary: "non-JSON response",
					});
					currentIter.durationMs = iterDur;
					currentIter.status = "ok";
					currentIter.summary = "non-JSON response";
					currentIter.displayText = result;
					persistedIterations.push(currentIter);
					// Stream raw text inline so the user sees it growing token-by-token.
					if (activeEmitters.emitDelta) {
						await typewriteText(result, activeEmitters.emitDelta, signal);
						didStreamInline = true;
					}
					return {
						content: [{ type: "text" as const, text: result }],
						details: {
							iterations: iter,
							chatHistoryId,
							toolsRun,
							finalDiaDisplay: result,
							shortCircuit: false,
							streamedInline: didStreamInline,
							attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
							timeline: persistedIterations,
						},
					};
				}

				if (parsed.display) lastDisplay = parsed.display;
				if (parsed.display) {
					progressLog.push(`💬 ${parsed.display}`);
					emit();
				}

				const planSteps = Array.isArray(parsed.plan) ? parsed.plan : [];

				if (planSteps.length === 0) {
					progressLog.push(parsed.done ? "✓ done" : "⚠ empty plan, exiting");
					emit();
					const iterDur = Date.now() - iterT0;
					const summary = parsed.done ? "done" : "empty plan";
					activeEmitters.emitStepEnd?.({
						id: iterStepId,
						status: "ok",
						durationMs: iterDur,
						summary,
					});
					currentIter.durationMs = iterDur;
					currentIter.status = "ok";
					currentIter.summary = summary;
					const finalText = lastDisplay || result;
					currentIter.displayText = finalText;
					persistedIterations.push(currentIter);
					if (activeEmitters.emitDelta && finalText) {
						await typewriteText(finalText, activeEmitters.emitDelta, signal);
						didStreamInline = true;
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `${finalText}\n\n[DIA tools: ${summariseExecution(toolsRun)}]`,
							},
						],
						details: {
							iterations: iter,
							chatHistoryId,
							toolsRun,
							finalDiaDisplay: finalText,
							shortCircuit: isTerminal && Boolean(finalText),
							streamedInline: didStreamInline,
							attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
							timeline: persistedIterations,
						},
					};
				}

				// === SINGLE-PASS HOT PATH (interleaved) ===
				// DIA marked done -> close iter card NOW, typewrite display NOW,
				// THEN run tools as TOP-LEVEL cards (claude.ai-style flow).
				if (parsed.done) {
					// Pre-validate plan args. DIA occasionally emits a malformed plan
					// (e.g. `[{"tool":"write"}, {"tool":"attach"}]` with no `args`)
					// while still writing a confident display ("Saved to ..."). Without
					// this check we'd typewrite the optimistic display, then surface
					// spurious "missing args object" tool-fail cards, then recover via
					// iter 2 which produces a duplicate display — confusing UX.
					//
					// Treat malformed plans as a recovery cycle: skip the optimistic
					// typewrite, mark the iter card as error, and feed the validation
					// failures back to DIA so iter 2 produces a clean (single) display.
					const malformed = planSteps.filter(
						(s) => !s.args || typeof s.args !== "object",
					);
					if (malformed.length > 0) {
						const iterDur = Date.now() - iterT0;
						const summary = `malformed plan: ${malformed.length} step(s) missing args`;
						activeEmitters.emitStepEnd?.({
							id: iterStepId,
							status: "error",
							durationMs: iterDur,
							summary,
						});
						currentIter.durationMs = iterDur;
						currentIter.status = "error";
						currentIter.summary = summary;
						persistedIterations.push(currentIter);
						progressLog.push(`⚠ ${summary}, feeding back for recovery`);
						emit();
						const recoveryFeedback = malformed.map((s) => ({
							tool: s.tool,
							ok: false,
							error: "missing args object — re-emit the plan with the required `args` field for every step",
						}));
						prompt = JSON.stringify({ toolResults: recoveryFeedback });
						continue;
					}

					const iterDur = Date.now() - iterT0;
					activeEmitters.emitStepEnd?.({
						id: iterStepId,
						status: "ok",
						durationMs: iterDur,
						summary: "single-pass done",
					});
					currentIter.durationMs = iterDur;
					currentIter.status = "ok";
					currentIter.summary = "single-pass done";
					currentIter.displayText = lastDisplay;
					persistedIterations.push(currentIter);

					if (activeEmitters.emitDelta && lastDisplay) {
						await typewriteText(lastDisplay, activeEmitters.emitDelta, signal);
						didStreamInline = true;
					}

					// Tools render as TOP-LEVEL cards (no parentId) so they sit
					// AFTER the typewritten display text in the activity flow.
					const iterResults = await runPlanTools(planSteps, undefined, currentIter);
					const hasFailure = iterResults.some((r) => !r.ok);

					if (!hasFailure) {
						progressLog.push("✓ done (single-pass)");
						emit();
						return {
							content: [
								{
									type: "text" as const,
									text: `${lastDisplay}\n\n[DIA tools: ${summariseExecution(toolsRun)}]`,
								},
							],
							details: {
								iterations: iter,
								chatHistoryId,
								toolsRun,
								finalDiaDisplay: lastDisplay,
								shortCircuit: isTerminal && Boolean(lastDisplay),
								streamedInline: didStreamInline,
								attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
								timeline: persistedIterations,
							},
						};
					}

					// DIA marked done but tool(s) failed -> feed back to next iter
					// for recovery. Iter card already closed; tool cards already
					// rendered as top-level. The next iter will open a NEW iter card.
					progressLog.push("⚠ done=true but tools failed, feeding back for recovery");
					emit();
					prompt = JSON.stringify({ toolResults: iterResults });
					continue;
				}

				// === MULTI-ITER CASE ===
				// DIA wants another round after these tools. Tools render NESTED
				// under the iter card (parentId: iterStepId). The iter card is
				// closed AFTER the tool loop; next iter opens a new card below.
				const iterResults = await runPlanTools(planSteps, iterStepId, currentIter, () => {
					const iterDur = Date.now() - iterT0;
					activeEmitters.emitStepEnd?.({
						id: iterStepId,
						status: "error",
						durationMs: iterDur,
						summary: "aborted",
					});
					currentIter.durationMs = iterDur;
					currentIter.status = "error";
					currentIter.summary = "aborted";
					persistedIterations.push(currentIter);
				});

				const iterDur = Date.now() - iterT0;
				const iterSummary = `${iterResults.length} tool(s) executed`;
				activeEmitters.emitStepEnd?.({
					id: iterStepId,
					status: "ok",
					durationMs: iterDur,
					summary: iterSummary,
				});
				currentIter.durationMs = iterDur;
				currentIter.status = "ok";
				currentIter.summary = iterSummary;
				persistedIterations.push(currentIter);

				prompt = JSON.stringify({ toolResults: iterResults });
			}

			progressLog.push(`⚠ hit max ${MAX_SUB_ITERATIONS} iterations, returning partial result`);
			emit();
			const cappedFinal = lastDisplay || "(no display)";
			// Pin the cap-branch text onto the LAST persisted iteration so /messages
			// can re-interleave it as the trailing text block on refresh.
			if (cappedFinal && persistedIterations.length > 0) {
				const lastIter = persistedIterations[persistedIterations.length - 1];
				if (!lastIter.displayText) lastIter.displayText = cappedFinal;
			}
			if (activeEmitters.emitDelta && cappedFinal) {
				await typewriteText(cappedFinal, activeEmitters.emitDelta, signal);
				didStreamInline = true;
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `${cappedFinal}\n\n[DIA reached ${MAX_SUB_ITERATIONS}-iteration cap. Tools: ${summariseExecution(toolsRun)}]`,
					},
				],
				details: {
					iterations: MAX_SUB_ITERATIONS,
					chatHistoryId: lastChatHistoryId,
					toolsRun,
					finalDiaDisplay: cappedFinal,
					shortCircuit: isTerminal && Boolean(lastDisplay),
					streamedInline: didStreamInline,
					attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
					timeline: persistedIterations,
				},
			};
		},
	};
}
