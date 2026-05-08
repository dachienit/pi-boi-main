import type { DiaDebugStep } from "./diaClient.js";
import type { DiaPipelineSubStep, LlmMetaEvent, RagSource } from "../types.js";

/**
 * Map opaque DIA `NodeType` strings to short, user-friendly verbs that look
 * good in the UI timeline. Falls back to the raw `stepName` when unknown.
 */
function friendlyLabel(stepName: string, nodeType: string): string {
	const key = (nodeType || "").toLowerCase();
	if (key.includes("prompt builder")) return "Build prompt";
	if (key.includes("chat input")) return "Receive input";
	if (key.includes("vector")) return "Vector search";
	if (key.includes("full") && key.includes("text")) return "Keyword search";
	if (key.includes("rerank")) return "Rerank results";
	if (key.includes("llm")) return "LLM generation";
	if (key.includes("chat output")) return "Format response";
	return stepName || "Step";
}

export function mapPipelineSubSteps(steps: DiaDebugStep[]): DiaPipelineSubStep[] {
	return steps.map((s) => {
		const nodeType =
			(s.details && typeof s.details === "object" && (s.details as any).NodeType) || "";
		return {
			name: s.stepName,
			nodeType: String(nodeType),
			executionTimeMs: typeof s.executionTimeMs === "number" ? s.executionTimeMs : 0,
			friendlyLabel: friendlyLabel(s.stepName, String(nodeType)),
		};
	});
}

interface RawEmbedding {
	text?: string;
	similarityScore?: number;
	metadata?: {
		name?: string;
		original_source?: string;
		source?: string;
	};
}

/**
 * Extract top-K RAG sources, dedupe by `original_source` URL (or `name`) so
 * the panel does not show 5 chunks of the same document.
 */
export function extractRagSources(steps: DiaDebugStep[], topK = 5): RagSource[] {
	// Find the first step that has an `embeddings` array — usually "Vector search"
	// or "Embeddings reranking". Falls back to scanning every step.
	const flat: RawEmbedding[] = [];
	for (const step of steps) {
		const details = step.details as Record<string, unknown> | undefined;
		const embeds = details && (details.embeddings as RawEmbedding[] | undefined);
		if (Array.isArray(embeds)) flat.push(...embeds);
	}
	if (flat.length === 0) return [];

	flat.sort((a, b) => (b.similarityScore ?? 0) - (a.similarityScore ?? 0));

	const seen = new Set<string>();
	const out: RagSource[] = [];
	for (const e of flat) {
		const url = e.metadata?.original_source ?? e.metadata?.source ?? "";
		const dedupKey = url || e.metadata?.name || "";
		if (dedupKey && seen.has(dedupKey)) continue;
		if (dedupKey) seen.add(dedupKey);

		out.push({
			title: e.metadata?.name ?? "Untitled source",
			similarityScore: typeof e.similarityScore === "number" ? e.similarityScore : 0,
			sourceUrl: url,
			snippet: snippetFromText(e.text ?? ""),
		});
		if (out.length >= topK) break;
	}
	return out;
}

function snippetFromText(text: string, max = 220): string {
	// Strip the leading "Title: …\nContent: " prefix DIA Brain prepends.
	const stripped = text.replace(/^\s*Title:[^\n]*\n+Content:\s*/i, "").replace(/\s+/g, " ").trim();
	if (stripped.length <= max) return stripped;
	return `${stripped.slice(0, max - 1)}…`;
}

/**
 * Pull `model` + token usage from the first LLM step we find in the pipeline.
 * Returns `null` when DIA did not surface the metadata.
 */
export function extractLlmMeta(steps: DiaDebugStep[]): Omit<LlmMetaEvent, "parentStepId"> | null {
	for (const step of steps) {
		const details = step.details as Record<string, any> | undefined;
		if (!details) continue;
		const nodeType = String(details.NodeType ?? "").toLowerCase();
		if (!nodeType.includes("llm")) continue;

		const meta = details.response?.metadata;
		if (!meta) continue;

		const usage = meta.usage ?? {};
		const query = details.query ?? {};
		return {
			model: String(meta.model ?? "unknown"),
			temperature: typeof query.options?.temperature === "number" ? query.options.temperature : undefined,
			promptTokens: Number(usage.promptTokens ?? 0),
			completionTokens: Number(usage.completionTokens ?? 0),
			totalTokens: Number(usage.totalTokens ?? 0),
		};
	}
	return null;
}
