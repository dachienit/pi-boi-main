import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Check, ChevronRight, Loader2, Wrench, X } from "lucide";
import type {
	DiaPipelineSubStep,
	LlmMetaEvent,
	RagSource,
	StepEndEvent,
	StepKind,
	StepStartEvent,
} from "../adapters/core-service.js";
import "./RagSourcesPanel.js";
import "./LlmMetaBadge.js";

export interface TimelineStep {
	id: string;
	kind: StepKind;
	label: string;
	parentId?: string;
	args?: unknown;
	status: "running" | "ok" | "error";
	startedAt: number;
	durationMs?: number;
	summary?: string;
	subSteps?: DiaPipelineSubStep[];
	ragSources?: RagSource[];
	llmMeta?: Omit<LlmMetaEvent, "type" | "parentStepId"> | null;
}

/**
 * Live activity timeline (claude.ai-style). Shows each backend step with a
 * spinner while running, then a check / error icon and duration when finished.
 * DIA pipeline / RAG / LLM meta render as expandable details under the parent
 * iteration row.
 */
@customElement("agent-activity-timeline")
export class AgentActivityTimeline extends LitElement {
	@property({ type: Array }) declare steps: TimelineStep[];

	constructor() {
		super();
		this.steps = [];
	}

	protected override createRenderRoot() {
		return this;
	}

	private renderStatusIcon(step: TimelineStep) {
		if (step.status === "running") {
			return html`<span class="text-muted-foreground inline-flex animate-spin"
				>${icon(Loader2, "sm")}</span
			>`;
		}
		if (step.status === "error") {
			return html`<span class="text-destructive inline-flex">${icon(X, "sm")}</span>`;
		}
		return html`<span class="text-emerald-500 inline-flex">${icon(Check, "sm")}</span>`;
	}

	private renderKindIcon(kind: StepKind) {
		const colorMap: Record<StepKind, string> = {
			oauth: "text-amber-500",
			history: "text-blue-500",
			fetch_dia: "text-purple-500",
			tool: "text-emerald-500",
			iter: "text-primary",
		};
		return html`<span class="${colorMap[kind]} inline-flex"
			>${icon(kind === "tool" ? Wrench : ChevronRight, "sm")}</span
		>`;
	}

	private formatDuration(ms?: number): string {
		if (ms === undefined) return "";
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	private renderRow(step: TimelineStep, depth: number): TemplateResult {
		const childSteps = this.steps.filter((s) => s.parentId === step.id);
		const hasExpandable = Boolean(
			(step.subSteps && step.subSteps.length > 0) ||
				(step.ragSources && step.ragSources.length > 0) ||
				step.llmMeta ||
				childSteps.length > 0,
		);

		const indent = depth * 18;
		const rowInner = html`
			${this.renderStatusIcon(step)} ${this.renderKindIcon(step.kind)}
			<span class="text-foreground truncate">${step.label}</span>
			${step.durationMs !== undefined
				? html`<span class="text-muted-foreground text-xs"
						>${this.formatDuration(step.durationMs)}</span
					>`
				: ""}
			${step.summary && step.status !== "running"
				? html`<span class="text-muted-foreground text-xs truncate">— ${step.summary}</span>`
				: ""}
		`;

		if (!hasExpandable) {
			return html`
				<div
					class="flex items-center gap-2 py-1 text-sm"
					style="padding-left:${indent + 14}px"
				>
					${rowInner}
				</div>
			`;
		}

		return html`
			<details class="group" ?open=${step.status === "running"}>
				<summary
					class="cursor-pointer list-none flex items-center gap-2 py-1 text-sm hover:bg-muted/40 rounded transition-colors [&::-webkit-details-marker]:hidden [&::marker]:hidden"
					style="padding-left:${indent}px"
				>
					<span
						class="text-muted-foreground text-[10px] inline-block transition-transform group-open:rotate-90 w-3 shrink-0"
						>▶</span
					>
					${rowInner}
				</summary>
				<div style="padding-left:${indent + 22}px" class="flex flex-col gap-1 py-1">
					${step.subSteps && step.subSteps.length > 0
						? this.renderPipelineTree(step.subSteps)
						: ""}
					${step.ragSources && step.ragSources.length > 0
						? html`<rag-sources-panel .sources=${step.ragSources}></rag-sources-panel>`
						: ""}
					${step.llmMeta
						? html`<llm-meta-badge .meta=${step.llmMeta}></llm-meta-badge>`
						: ""}
					${childSteps.map((c) => this.renderRow(c, depth + 1))}
				</div>
			</details>
		`;
	}

	private renderPipelineTree(subSteps: DiaPipelineSubStep[]) {
		return html`
			<div
				class="flex flex-col gap-0.5 border-l-2 border-purple-500/30 pl-2 text-xs text-muted-foreground"
			>
				<div class="text-[11px] font-medium text-purple-500 mb-0.5">DIA Brain pipeline</div>
				${subSteps.map(
					(s) => html`
						<div class="flex items-center gap-2">
							<span class="text-emerald-500/80 inline-flex">${icon(Check, "sm")}</span>
							<span class="text-foreground">${s.friendlyLabel}</span>
							<span class="text-[10px] text-muted-foreground/70 truncate">${s.name}</span>
							<span class="ml-auto text-muted-foreground/80"
								>${this.formatDuration(s.executionTimeMs)}</span
							>
						</div>
					`,
				)}
			</div>
		`;
	}

	override render() {
		const rootSteps = this.steps.filter((s) => !s.parentId);
		if (rootSteps.length === 0) return html``;
		return html`
			<div class="flex flex-col border border-border/60 rounded-lg p-2 bg-muted/20">
				${rootSteps.map((s) => this.renderRow(s, 0))}
			</div>
		`;
	}
}

// ============================================================================
// Helpers exported for the chat panel to maintain a TimelineStep[] from raw events
// ============================================================================

export function applyStepStart(steps: TimelineStep[], event: StepStartEvent): TimelineStep[] {
	return [
		...steps,
		{
			id: event.id,
			kind: event.kind,
			label: event.label,
			parentId: event.parentId,
			args: event.args,
			status: "running",
			startedAt: Date.now(),
		},
	];
}

export function applyStepEnd(steps: TimelineStep[], event: StepEndEvent): TimelineStep[] {
	return steps.map((s) =>
		s.id === event.id
			? {
					...s,
					status: event.status === "ok" ? "ok" : "error",
					durationMs: event.durationMs,
					summary: event.summary,
				}
			: s,
	);
}

export function applyDiaPipeline(
	steps: TimelineStep[],
	parentId: string,
	subSteps: DiaPipelineSubStep[],
): TimelineStep[] {
	return steps.map((s) => (s.id === parentId ? { ...s, subSteps } : s));
}

export function applyRagSources(
	steps: TimelineStep[],
	parentId: string,
	sources: RagSource[],
): TimelineStep[] {
	return steps.map((s) => (s.id === parentId ? { ...s, ragSources: sources } : s));
}

export function applyLlmMeta(
	steps: TimelineStep[],
	parentId: string,
	meta: Omit<LlmMetaEvent, "type" | "parentStepId">,
): TimelineStep[] {
	return steps.map((s) => (s.id === parentId ? { ...s, llmMeta: meta } : s));
}
