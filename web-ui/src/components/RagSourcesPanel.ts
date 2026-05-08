import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { RagSource } from "../adapters/core-service.js";

/**
 * Perplexity-style horizontal grid of RAG source cards. Each card shows the
 * document name, similarity score, a short snippet, and links to the original
 * SharePoint URL when available.
 */
@customElement("rag-sources-panel")
export class RagSourcesPanel extends LitElement {
	@property({ type: Array }) declare sources: RagSource[];

	constructor() {
		super();
		this.sources = [];
	}

	protected override createRenderRoot() {
		return this;
	}

	private formatScore(score: number): string {
		return `${(score * 100).toFixed(0)}%`;
	}

	private renderCard(s: RagSource) {
		const inner = html`
			<div class="flex items-center justify-between gap-2 mb-1">
				<span class="text-xs font-medium text-foreground truncate">${s.title}</span>
				<span class="text-[10px] text-emerald-500 font-mono shrink-0"
					>${this.formatScore(s.similarityScore)}</span
				>
			</div>
			<div class="text-[11px] text-muted-foreground line-clamp-3 leading-snug">${s.snippet}</div>
		`;

		if (s.sourceUrl) {
			return html`
				<a
					href=${s.sourceUrl}
					target="_blank"
					rel="noopener"
					class="block w-56 shrink-0 p-2 rounded-md border border-border/60 bg-muted/30 hover:bg-muted/60 hover:border-border transition-colors"
				>
					${inner}
				</a>
			`;
		}
		return html`
			<div class="block w-56 shrink-0 p-2 rounded-md border border-border/60 bg-muted/30">
				${inner}
			</div>
		`;
	}

	override render() {
		if (!this.sources || this.sources.length === 0) return html``;
		return html`
			<div class="flex flex-col gap-1">
				<div class="text-[11px] font-medium text-muted-foreground">RAG sources</div>
				<div class="flex gap-2 overflow-x-auto pb-1">
					${this.sources.map((s) => this.renderCard(s))}
				</div>
			</div>
		`;
	}
}
