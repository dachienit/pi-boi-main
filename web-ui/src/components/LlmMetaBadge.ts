import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { LlmMetaEvent } from "../adapters/core-service.js";

type LlmMeta = Omit<LlmMetaEvent, "type" | "parentStepId">;

/**
 * Compact LLM metadata badge: model · tokens (in / out) · temperature.
 * Rendered inline under the parent step in the timeline.
 */
@customElement("llm-meta-badge")
export class LlmMetaBadge extends LitElement {
	@property({ type: Object }) declare meta: LlmMeta | null;

	constructor() {
		super();
		this.meta = null;
	}

	protected override createRenderRoot() {
		return this;
	}

	override render() {
		if (!this.meta) return html``;
		const m = this.meta;
		return html`
			<div
				class="inline-flex items-center gap-2 text-[11px] text-muted-foreground bg-muted/40 border border-border/60 rounded px-2 py-0.5 w-fit font-mono"
			>
				<span class="text-foreground">${m.model}</span>
				<span>·</span>
				<span>${m.totalTokens.toLocaleString()} tok</span>
				<span class="opacity-70">(${m.promptTokens} in / ${m.completionTokens} out)</span>
				${m.temperature !== undefined
					? html`<span>·</span>
							<span>T=${m.temperature}</span>`
					: ""}
			</div>
		`;
	}
}
