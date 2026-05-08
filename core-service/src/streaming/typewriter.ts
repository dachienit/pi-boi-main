/**
 * Synthetic typewriter — chunk a long string into small slices and emit each
 * via `emit` with a small delay so the UI sees a flowing token-by-token stream
 * rather than a sudden block of text.
 *
 * DIA Brain does NOT support native streaming (the API blocks until the full
 * response is ready), so we replay the result through this utility to give the
 * user the same "live" feel as claude.ai or chatgpt.
 *
 * Tuning notes:
 *   - chunkSize 8 / intervalMs 14ms ≈ 570 chars/sec ≈ ~100 wpm streamed feel.
 *     A 200-char display takes ~350ms — visible "typing" but quick enough
 *     that tool execution starts soon after.
 *   - Use codepoint splitting (`Array.from`) so multi-byte characters
 *     (Vietnamese diacritics, emoji) never split mid-codepoint.
 *
 * Aborts cleanly when the agent signal is cancelled.
 */
export async function typewriteText(
	text: string,
	emit: (chunk: string) => void,
	signal?: AbortSignal,
	chunkSize = 8,
	intervalMs = 14,
): Promise<void> {
	if (!text) return;
	const codepoints = Array.from(text);
	let i = 0;
	while (i < codepoints.length) {
		if (signal?.aborted) return;
		const slice = codepoints.slice(i, i + chunkSize).join("");
		emit(slice);
		i += chunkSize;
		if (i < codepoints.length) {
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	}
}
