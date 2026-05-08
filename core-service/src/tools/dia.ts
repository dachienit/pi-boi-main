import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { chatWithDIA } from "../dia/diaClient.js";

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

interface CallDIABrainDetails {
	iterations: number;
	chatHistoryId?: string;
	toolsRun: { tool: string; ok: boolean }[];
	finalDiaDisplay?: string;
	shortCircuit?: boolean;
}

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
		// Try to locate a JSON object inside the text
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
	return toolsRun
		.map((t) => `${t.ok ? "✓" : "✗"} ${t.tool}`)
		.join("  ");
}

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
			let lastChatHistoryId: string | undefined;
			let lastDisplay = "";

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

			for (let iter = 1; iter <= MAX_SUB_ITERATIONS; iter++) {
				if (signal?.aborted) {
					progressLog.push(`× aborted before iter ${iter}`);
					emit();
					throw new Error("callDIABrain aborted");
				}

				progressLog.push(`→ DIA thinking (iter ${iter})…`);
				emit();

				const { result, chatHistoryId } = await chatWithDIA({
					prompt,
					customMessageBehaviour,
					channelId,
					mode: "rag",
					signal,
				});
				lastChatHistoryId = chatHistoryId;

				const parsed = tryParseDiaPlan(result);

				if (!parsed) {
					progressLog.push("⚠ DIA returned non-JSON, surfacing raw text");
					emit();
					return {
						content: [
							{
								type: "text" as const,
								text: result,
							},
						],
						details: {
							iterations: iter,
							chatHistoryId,
							toolsRun,
							finalDiaDisplay: result,
							shortCircuit: false,
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
					const finalText = lastDisplay || result;
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
						},
					};
				}

				const iterResults: ToolResultRecord[] = [];
				for (let stepIdx = 0; stepIdx < planSteps.length; stepIdx++) {
					const step = planSteps[stepIdx];
					if (signal?.aborted) {
						progressLog.push("× aborted mid-plan");
						emit();
						throw new Error("callDIABrain aborted");
					}
					progressLog.push(`→ ${step.tool}…`);
					emit();
					const record = await runOnePlanStep(step, peerTools, toolCallId, stepIdx, signal);
					iterResults.push(record);
					toolsRun.push({ tool: record.tool, ok: record.ok });
					progressLog.push(
						record.ok
							? `  ✓ ${record.tool} ${truncateForLog(record.output ?? "")}`
							: `  ✗ ${record.tool}: ${record.error}`,
					);
					emit();
				}

				if (parsed.done) {
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
							},
						};
					}
					// DIA marked done but tool(s) failed -> override and feedback for recovery
					progressLog.push("⚠ done=true but tools failed, feeding back for recovery");
					emit();
				}

				prompt = JSON.stringify({ toolResults: iterResults });
			}

			progressLog.push(`⚠ hit max ${MAX_SUB_ITERATIONS} iterations, returning partial result`);
			emit();
			const cappedFinal = lastDisplay || "(no display)";
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
				},
			};
		},
	};
}

function truncateForLog(text: string, max = 80): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}
