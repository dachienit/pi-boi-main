/**
 * callDIABrain — single-shot DIA Brain skill endpoint with canonical field
 * dispatcher.
 *
 * Architecture (Phase 1, assistant-only):
 *
 *   nano (LLM Farm)  →  callDIABrain({skill, prompt, label})
 *                    →  loadSkillPersona(skill)         (read SKILL.md)
 *                    →  chatWithDIA(prompt, persona, mode:'rag')
 *                    →  parse JSON per nano-supplied schema
 *                    →  canonicalFieldDispatcher(json)
 *                          ├─ display      → typewriter to UI
 *                          ├─ file_name+file_content → resolve path + write + attach
 *                          ├─ html_artifact → resolve path + write + attach
 *                          ├─ error        → surface + stop dispatch
 *                          └─ next_hint    → bubble up to nano in result text
 *                    →  return aggregated summary to nano
 *
 * Key invariants:
 * - DIA Brain is workspace-blind: receives only the persona text + nano's
 *   prompt. Never sees paths, channelId, tool catalog.
 * - nano is the orchestrator: it composes the prompt + JSON schema. We never
 *   compose ABAP / class names / file names on nano's behalf.
 * - All filesystem resolution happens via pathResolver (sanitized basenames
 *   only — DIA cannot path-traverse).
 * - DIA's own chat history (chatHistoryId) survives across calls per channel,
 *   so nano can send short follow-up prompts ("now refactor it") without
 *   re-sending context.
 */

import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { chatWithDIA, loadSkillPersona, type DiaPhaseEvent } from "../dia/diaClient.js";
import {
	resolveCanonicalArtifactName,
	resolveCanonicalFileName,
} from "../dia/pathResolver.js";
import { extractLlmMeta, extractRagSources, mapPipelineSubSteps } from "../dia/debugSteps.js";
import { typewriteText } from "../streaming/typewriter.js";
import type {
	CanonicalActionResult,
	CanonicalDispatchResult,
	DiaCanonicalResponse,
	DiaPipelineEvent,
	DiaPipelineSubStep,
	LlmMetaEvent,
	RagSource,
	RagSourcesEvent,
	SkillName,
	StepEndEvent,
	StepStartEvent,
} from "../types.js";
import { ENABLED_SKILLS } from "../types.js";

// ============================================================================
// Tool schema — exposed to nano via the LLM Farm tool catalog
// ============================================================================

const callDIABrainSchema = Type.Object({
	label: Type.String({
		description:
			"Short user-visible action label (under 60 chars). MUST follow the format " +
			"'Ask DIA: <verb phrase>' (e.g. 'Ask DIA: write hello program', " +
			"'Ask DIA: refactor SELECT', 'Ask DIA: explain CDS').",
	}),
	skill: Type.String({
		description:
			"DIA skill endpoint to invoke. Phase 1 supports: 'assistant'. " +
			"(Future phases will add 'analysis', 'refactor', 'review', 'fix'.)",
	}),
	prompt: Type.String({
		description:
			"YOUR composed instruction to DIA. Include (1) the user's intent in 1-2 short " +
			"sentences and (2) the JSON schema you want DIA to return. DIA has its OWN " +
			"per-session chat history and remembers prior turns — DO NOT re-paste old " +
			"context. DO NOT mention paths, channel ids, scratch directories, or the " +
			"word 'pi-boi'. For file outputs, ask DIA to return a simple basename only " +
			"(no path) — pi-boi will resolve it. " +
			"Example schemas you may request:\n" +
			"  - {\"display\":\"<markdown>\"}\n" +
			"  - {\"display\":\"<markdown>\",\"file_name\":\"<basename>\",\"file_content\":\"<text>\"}\n" +
			"  - {\"display\":\"<markdown>\",\"html_artifact\":\"<html>\",\"file_name\":\"<basename.html>\"}\n" +
			"  - {\"error\":\"<reason>\"}",
	}),
});

type CallDIABrainArgs = {
	label: string;
	skill: string;
	prompt: string;
};

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

export interface PersistedAction {
	kind: CanonicalActionResult["kind"];
	label: string;
	status: "ok" | "error";
	path?: string;
	summary?: string;
}

export type PersistedLlmMeta = Omit<LlmMetaEvent, "type" | "parentStepId">;

export interface PersistedDiaCall {
	skill: SkillName;
	label: string;
	durationMs: number;
	status: "ok" | "error";
	summary?: string;
	phases: PersistedPhase[];
	pipeline?: DiaPipelineSubStep[];
	ragSources?: RagSource[];
	llmMeta?: PersistedLlmMeta;
	actions: PersistedAction[];
	displayText?: string;
	unknownFields?: string[];
}

interface CallDIABrainDetails {
	skill: SkillName;
	chatHistoryId?: string;
	display?: string;
	nextHint?: string;
	actions: PersistedAction[];
	attachedFiles: Array<{ path: string; title?: string }>;
	streamedInline: boolean;
	timeline: PersistedDiaCall[];
}

// ============================================================================
// Module-level emitter wiring (set per-run by agent.ts)
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
let activeUploadFn: ((filePath: string, title?: string) => Promise<void>) | null = null;

export function setDiaEmitters(emitters: DiaStreamEmitters): void {
	activeEmitters = emitters ?? {};
}

export function clearDiaEmitters(): void {
	activeEmitters = {};
}

/**
 * Wire the file-attach upload callback used by the canonical dispatcher's
 * write_file / write_artifact actions. Mirrors `setUploadFunction` from
 * `tools/attach.ts` but keeps the dia dispatcher self-contained (no peer-tool
 * round trip needed).
 */
export function setDiaUploadFunction(
	fn: ((filePath: string, title?: string) => Promise<void>) | null,
): void {
	activeUploadFn = fn;
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

function tryParseDiaJson(rawText: string): DiaCanonicalResponse | null {
	const cleaned = stripJsonFences(rawText);
	try {
		const parsed = JSON.parse(cleaned);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as DiaCanonicalResponse;
		}
	} catch {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				const parsed = JSON.parse(cleaned.slice(start, end + 1));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					return parsed as DiaCanonicalResponse;
				}
			} catch {
				/* fall through */
			}
		}
	}
	return null;
}

function truncateForLog(text: string, max = 80): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}

function isValidSkill(value: string): value is SkillName {
	return (ENABLED_SKILLS as readonly string[]).includes(value);
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
// Canonical field dispatcher
// ============================================================================

/**
 * Phase 1 canonical fields. Order matters because the dispatcher executes
 * them in this order: error short-circuits, display streams first so the
 * user sees the answer while files are being written, then files, then
 * next_hint is just bubbled up.
 */
const CANONICAL_FIELDS = new Set([
	"display",
	"file_name",
	"file_content",
	"html_artifact",
	"error",
	"next_hint",
]);

interface DispatcherContext {
	channelId: string;
	workspaceDir: string;
	parentStepId: string;
	signal?: AbortSignal;
}

async function canonicalFieldDispatcher(
	json: DiaCanonicalResponse,
	ctx: DispatcherContext,
): Promise<CanonicalDispatchResult> {
	const actions: CanonicalActionResult[] = [];
	const attachedFiles: Array<{ path: string; title?: string }> = [];
	const unknownFields: string[] = [];
	let display: string | undefined;
	let nextHint: string | undefined;
	let hadError = false;

	for (const key of Object.keys(json)) {
		if (!CANONICAL_FIELDS.has(key)) {
			unknownFields.push(key);
		}
	}

	// 1. error — short-circuit everything else.
	if (typeof json.error === "string" && json.error.trim()) {
		const errMsg = json.error.trim();
		actions.push({ kind: "error", ok: false, error: errMsg });
		return {
			actions,
			hadError: true,
			display: undefined,
			nextHint: undefined,
			attachedFiles,
			unknownFields,
		};
	}

	// 2. display — typewrite to UI now so the user sees the answer immediately,
	//    BEFORE any file write delay.
	if (typeof json.display === "string" && json.display.trim()) {
		display = json.display;
		const dispStepId = nextStepId("dispatch-display");
		const t0 = Date.now();
		activeEmitters.emitStepStart?.({
			id: dispStepId,
			kind: "tool",
			label: "stream display",
			parentId: ctx.parentStepId,
		});
		try {
			if (activeEmitters.emitDelta) {
				await typewriteText(display, activeEmitters.emitDelta, ctx.signal);
			}
			activeEmitters.emitStepEnd?.({
				id: dispStepId,
				status: "ok",
				durationMs: Date.now() - t0,
				summary: `${display.length} chars`,
			});
			actions.push({
				kind: "display",
				ok: true,
				summary: `${display.length} chars streamed`,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			activeEmitters.emitStepEnd?.({
				id: dispStepId,
				status: "error",
				durationMs: Date.now() - t0,
				summary: msg,
			});
			actions.push({ kind: "display", ok: false, error: msg });
			hadError = true;
		}
	}

	// 3. file_name + file_content → write to scratch + attach.
	const hasFileName = typeof json.file_name === "string" && json.file_name.trim().length > 0;
	const hasFileContent = typeof json.file_content === "string";
	const hasHtmlArtifact =
		typeof json.html_artifact === "string" && json.html_artifact.trim().length > 0;

	if (hasFileName && hasFileContent && !hasHtmlArtifact) {
		const stepId = nextStepId("dispatch-write");
		const t0 = Date.now();
		activeEmitters.emitStepStart?.({
			id: stepId,
			kind: "tool",
			label: `write ${json.file_name}`,
			parentId: ctx.parentStepId,
		});
		try {
			const absPath = resolveCanonicalFileName(
				json.file_name,
				ctx.channelId,
				ctx.workspaceDir,
			);
			await mkdir(dirname(absPath), { recursive: true });
			await writeFile(absPath, json.file_content as string, "utf-8");
			const sizeBytes = (json.file_content as string).length;
			activeEmitters.emitStepEnd?.({
				id: stepId,
				status: "ok",
				durationMs: Date.now() - t0,
				summary: `${sizeBytes} bytes`,
			});
			actions.push({
				kind: "write_file",
				ok: true,
				path: absPath,
				summary: `wrote ${sizeBytes} bytes to ${json.file_name}`,
			});

			// Auto-attach so the file chip appears in chat.
			if (activeUploadFn) {
				const attStepId = nextStepId("dispatch-attach");
				const tAtt = Date.now();
				activeEmitters.emitStepStart?.({
					id: attStepId,
					kind: "tool",
					label: `attach ${json.file_name}`,
					parentId: ctx.parentStepId,
				});
				try {
					await activeUploadFn(absPath, json.file_name as string);
					attachedFiles.push({ path: absPath, title: json.file_name as string });
					activeEmitters.emitStepEnd?.({
						id: attStepId,
						status: "ok",
						durationMs: Date.now() - tAtt,
						summary: "attached",
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					activeEmitters.emitStepEnd?.({
						id: attStepId,
						status: "error",
						durationMs: Date.now() - tAtt,
						summary: msg,
					});
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			activeEmitters.emitStepEnd?.({
				id: stepId,
				status: "error",
				durationMs: Date.now() - t0,
				summary: msg,
			});
			actions.push({ kind: "write_file", ok: false, error: msg });
			hadError = true;
		}
	} else if (hasFileName !== hasFileContent && !hasHtmlArtifact) {
		// Asymmetric file_name / file_content — DIA broke the schema.
		const missing = hasFileName ? "file_content" : "file_name";
		actions.push({
			kind: "write_file",
			ok: false,
			error: `DIA schema violation: ${missing} missing (the other was provided)`,
		});
		hadError = true;
	}

	// 4. html_artifact → write under artifacts/<channelId>/ + attach.
	if (hasHtmlArtifact) {
		const stepId = nextStepId("dispatch-artifact");
		const t0 = Date.now();
		const labelName = hasFileName ? (json.file_name as string) : "artifact.html";
		activeEmitters.emitStepStart?.({
			id: stepId,
			kind: "tool",
			label: `html_artifact ${labelName}`,
			parentId: ctx.parentStepId,
		});
		try {
			const absPath = resolveCanonicalArtifactName(
				hasFileName ? json.file_name : undefined,
				ctx.channelId,
				ctx.workspaceDir,
			);
			await mkdir(dirname(absPath), { recursive: true });
			await writeFile(absPath, json.html_artifact as string, "utf-8");
			const sizeBytes = (json.html_artifact as string).length;
			activeEmitters.emitStepEnd?.({
				id: stepId,
				status: "ok",
				durationMs: Date.now() - t0,
				summary: `${sizeBytes} bytes`,
			});
			actions.push({
				kind: "write_artifact",
				ok: true,
				path: absPath,
				summary: `wrote artifact ${sizeBytes} bytes`,
			});

			if (activeUploadFn) {
				const attStepId = nextStepId("dispatch-attach");
				const tAtt = Date.now();
				activeEmitters.emitStepStart?.({
					id: attStepId,
					kind: "tool",
					label: `attach ${labelName}`,
					parentId: ctx.parentStepId,
				});
				try {
					await activeUploadFn(absPath, labelName);
					attachedFiles.push({ path: absPath, title: labelName });
					activeEmitters.emitStepEnd?.({
						id: attStepId,
						status: "ok",
						durationMs: Date.now() - tAtt,
						summary: "attached",
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					activeEmitters.emitStepEnd?.({
						id: attStepId,
						status: "error",
						durationMs: Date.now() - tAtt,
						summary: msg,
					});
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			activeEmitters.emitStepEnd?.({
				id: stepId,
				status: "error",
				durationMs: Date.now() - t0,
				summary: msg,
			});
			actions.push({ kind: "write_artifact", ok: false, error: msg });
			hadError = true;
		}
	}

	// 5. next_hint — informational only; bubble up so nano can read it.
	if (typeof json.next_hint === "string" && json.next_hint.trim()) {
		nextHint = json.next_hint.trim();
		actions.push({ kind: "next_hint", ok: true, summary: truncateForLog(nextHint, 120) });
	}

	return {
		actions,
		hadError,
		display,
		nextHint,
		attachedFiles,
		unknownFields,
	};
}

// ============================================================================
// Tool factory
// ============================================================================

export function createCallDIABrainTool(
	channelId: string,
	_peerTools: AgentTool<any>[], // kept for signature parity; no longer used
	workingDir: string,
	hostWorkspacePath: string,
): AgentTool<typeof callDIABrainSchema> {
	return {
		name: "callDIABrain",
		label: "callDIABrain",
		description:
			"Invoke a DIA Brain skill endpoint (Claude + Bosch internal SAP RAG). " +
			"DIA is workspace-blind and returns ONLY a JSON object matching the schema YOU embed in `prompt`. " +
			"Pi-boi auto-dispatches the JSON: `display` streams to UI; `file_name`+`file_content` writes to session " +
			"scratch and attaches; `html_artifact` writes a canvas artifact; `error` surfaces an error. " +
			"DIA preserves its own per-session chat history — for follow-up turns, send a SHORT instruction " +
			"like 'now refactor it'; do NOT re-paste prior context.",
		parameters: callDIABrainSchema,
		execute: async (
			toolCallId: string,
			args: CallDIABrainArgs,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<CallDIABrainDetails>,
		) => {
			const { skill: skillRaw, prompt, label } = args;

			// --- Validate skill name ---
			if (!isValidSkill(skillRaw)) {
				const allowed = ENABLED_SKILLS.join(", ");
				const errMsg = `Unknown skill '${skillRaw}'. Allowed: ${allowed}`;
				return {
					content: [{ type: "text" as const, text: errMsg }],
					details: {
						skill: "assistant" as SkillName,
						actions: [],
						attachedFiles: [],
						streamedInline: false,
						timeline: [],
					},
				};
			}
			const skill: SkillName = skillRaw;

			// --- Open the parent timeline card for this DIA call ---
			const callStepId = nextStepId(`dia-${skill}`);
			const tCall = Date.now();
			activeEmitters.emitStepStart?.({
				id: callStepId,
				kind: "iter",
				label: label || `Ask DIA (${skill})`,
			});

			const persistedCall: PersistedDiaCall = {
				skill,
				label: label || `Ask DIA (${skill})`,
				durationMs: 0,
				status: "ok",
				phases: [],
				actions: [],
			};

			const progressLog: string[] = [`→ DIA[${skill}] thinking…`];
			let chatHistoryId: string | undefined;
			let dispatchResult: CanonicalDispatchResult | undefined;
			let displayText: string | undefined;

			const emitProgress = (extras?: Partial<CallDIABrainDetails>) => {
				onUpdate?.({
					content: [{ type: "text", text: progressLog.join("\n") }],
					details: {
						skill,
						chatHistoryId,
						display: displayText,
						nextHint: dispatchResult?.nextHint,
						actions: dispatchResult?.actions
							? toPersistedActions(dispatchResult.actions)
							: [],
						attachedFiles: dispatchResult?.attachedFiles ?? [],
						streamedInline: Boolean(displayText),
						timeline: [persistedCall],
						...extras,
					},
				});
			};

			emitProgress();

			// --- Step 1: load skill persona (workspace-blind context) ---
			const loadStepId = nextStepId("load-skill");
			const tLoad = Date.now();
			activeEmitters.emitStepStart?.({
				id: loadStepId,
				kind: "tool",
				label: `load skill ${skill}`,
				parentId: callStepId,
			});
			let persona: string;
			try {
				persona = loadSkillPersona(hostWorkspacePath, skill);
				activeEmitters.emitStepEnd?.({
					id: loadStepId,
					status: "ok",
					durationMs: Date.now() - tLoad,
					summary: `${persona.length} chars`,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				activeEmitters.emitStepEnd?.({
					id: loadStepId,
					status: "error",
					durationMs: Date.now() - tLoad,
					summary: msg,
				});
				const tCallDur = Date.now() - tCall;
				activeEmitters.emitStepEnd?.({
					id: callStepId,
					status: "error",
					durationMs: tCallDur,
					summary: `load skill failed`,
				});
				persistedCall.status = "error";
				persistedCall.summary = `load skill failed: ${msg}`;
				persistedCall.durationMs = tCallDur;
				return {
					content: [{ type: "text" as const, text: `Failed to load skill '${skill}': ${msg}` }],
					details: {
						skill,
						actions: [],
						attachedFiles: [],
						streamedInline: false,
						timeline: [persistedCall],
					},
				};
			}

			// --- Step 2: call DIA Brain (RAG mode) ---
			let diaText: string;
			try {
				const diaResp = await chatWithDIA({
					prompt,
					customMessageBehaviour: persona,
					channelId,
					mode: "rag",
					signal,
					onPhase: bridgePhaseToStep(callStepId, persistedCall.phases),
				});
				diaText = diaResp.result;
				chatHistoryId = diaResp.chatHistoryId;

				if (diaResp.debugSteps && diaResp.debugSteps.length > 0) {
					const subSteps = mapPipelineSubSteps(diaResp.debugSteps);
					if (subSteps.length > 0) {
						activeEmitters.emitDiaPipeline?.({ parentStepId: callStepId, subSteps });
						persistedCall.pipeline = subSteps;
					}
					const sources = extractRagSources(diaResp.debugSteps);
					if (sources.length > 0) {
						activeEmitters.emitRagSources?.({ parentStepId: callStepId, sources });
						persistedCall.ragSources = sources;
					}
					const llmMeta = extractLlmMeta(diaResp.debugSteps);
					if (llmMeta) {
						activeEmitters.emitLlmMeta?.({ parentStepId: callStepId, ...llmMeta });
						persistedCall.llmMeta = llmMeta;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const tCallDur = Date.now() - tCall;
				activeEmitters.emitStepEnd?.({
					id: callStepId,
					status: "error",
					durationMs: tCallDur,
					summary: msg,
				});
				persistedCall.status = "error";
				persistedCall.summary = `DIA fetch failed: ${msg}`;
				persistedCall.durationMs = tCallDur;
				return {
					content: [{ type: "text" as const, text: `DIA Brain call failed: ${msg}` }],
					details: {
						skill,
						chatHistoryId,
						actions: [],
						attachedFiles: [],
						streamedInline: false,
						timeline: [persistedCall],
					},
				};
			}

			// --- Step 3: parse JSON ---
			const parseStepId = nextStepId("parse-response");
			const tParse = Date.now();
			activeEmitters.emitStepStart?.({
				id: parseStepId,
				kind: "tool",
				label: "parse DIA JSON",
				parentId: callStepId,
			});
			const parsed = tryParseDiaJson(diaText);
			if (!parsed) {
				activeEmitters.emitStepEnd?.({
					id: parseStepId,
					status: "error",
					durationMs: Date.now() - tParse,
					summary: "non-JSON response",
				});
				// Stream raw text inline as a fallback so the user still sees something.
				if (activeEmitters.emitDelta) {
					await typewriteText(diaText, activeEmitters.emitDelta, signal);
				}
				const tCallDur = Date.now() - tCall;
				activeEmitters.emitStepEnd?.({
					id: callStepId,
					status: "ok",
					durationMs: tCallDur,
					summary: "non-JSON response",
				});
				persistedCall.status = "ok";
				persistedCall.summary = "non-JSON response — surfaced raw text";
				persistedCall.durationMs = tCallDur;
				persistedCall.displayText = diaText;
				return {
					content: [{ type: "text" as const, text: diaText }],
					details: {
						skill,
						chatHistoryId,
						display: diaText,
						actions: [],
						attachedFiles: [],
						streamedInline: true,
						timeline: [persistedCall],
					},
				};
			}
			activeEmitters.emitStepEnd?.({
				id: parseStepId,
				status: "ok",
				durationMs: Date.now() - tParse,
				summary: `${Object.keys(parsed).length} field(s)`,
			});

			// --- Step 4: dispatch canonical fields ---
			dispatchResult = await canonicalFieldDispatcher(parsed, {
				channelId,
				workspaceDir: workingDir,
				parentStepId: callStepId,
				signal,
			});
			displayText = dispatchResult.display;

			persistedCall.actions = toPersistedActions(dispatchResult.actions);
			persistedCall.displayText = displayText;
			if (dispatchResult.unknownFields.length > 0) {
				persistedCall.unknownFields = dispatchResult.unknownFields;
				progressLog.push(
					`⚠ unknown fields ignored: ${dispatchResult.unknownFields.join(", ")}`,
				);
			}

			// --- Close parent timeline card ---
			const tCallDur = Date.now() - tCall;
			const overallStatus: "ok" | "error" = dispatchResult.hadError ? "error" : "ok";
			const summaryParts: string[] = [];
			if (displayText) summaryParts.push("display");
			for (const a of dispatchResult.actions) {
				if (a.kind === "write_file" || a.kind === "write_artifact") {
					summaryParts.push(`${a.kind}${a.ok ? "" : "✗"}`);
				}
			}
			const overallSummary = summaryParts.length > 0 ? summaryParts.join(", ") : "no actions";
			activeEmitters.emitStepEnd?.({
				id: callStepId,
				status: overallStatus,
				durationMs: tCallDur,
				summary: overallSummary,
			});
			persistedCall.status = overallStatus;
			persistedCall.summary = overallSummary;
			persistedCall.durationMs = tCallDur;

			// --- Build the result text returned to nano ---
			// nano needs a SHORT structured summary so it can decide stop vs.
			// follow-up tool. We do NOT re-include `display` here — that has
			// already been streamed inline to the UI. We DO include next_hint
			// because nano cannot read the typewriter stream.
			const resultLines: string[] = [`DIA[${skill}] complete (${overallStatus}).`];
			if (dispatchResult.actions.length > 0) {
				resultLines.push(
					`Actions: ${dispatchResult.actions
						.map((a) => `${a.kind}${a.ok ? "" : "✗"}`)
						.join(", ")}`,
				);
			}
			if (dispatchResult.attachedFiles.length > 0) {
				resultLines.push(
					`Attached: ${dispatchResult.attachedFiles
						.map((f) => f.title ?? f.path.split(/[\\/]/).pop() ?? "")
						.join(", ")}`,
				);
			}
			if (dispatchResult.nextHint) {
				resultLines.push(`Next hint: ${dispatchResult.nextHint}`);
			}
			if (dispatchResult.unknownFields.length > 0) {
				resultLines.push(`Unknown fields ignored: ${dispatchResult.unknownFields.join(", ")}`);
			}

			const resultText = resultLines.join("\n");

			return {
				content: [{ type: "text" as const, text: resultText }],
				details: {
					skill,
					chatHistoryId,
					display: displayText,
					nextHint: dispatchResult.nextHint,
					actions: persistedCall.actions,
					attachedFiles: dispatchResult.attachedFiles,
					streamedInline: Boolean(displayText),
					timeline: [persistedCall],
				},
			};
		},
	};
}

function toPersistedActions(actions: CanonicalActionResult[]): PersistedAction[] {
	return actions.map((a) => ({
		kind: a.kind,
		label: actionLabel(a),
		status: a.ok ? "ok" : "error",
		path: a.path,
		summary: a.summary ?? a.error,
	}));
}

function actionLabel(a: CanonicalActionResult): string {
	switch (a.kind) {
		case "display":
			return "stream display";
		case "write_file":
			return a.path ? `write ${a.path.split(/[\\/]/).pop()}` : "write file";
		case "write_artifact":
			return a.path ? `artifact ${a.path.split(/[\\/]/).pop()}` : "html artifact";
		case "error":
			return "error";
		case "next_hint":
			return "next hint";
	}
}
