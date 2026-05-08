import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { basename, isAbsolute, resolve as resolvePath } from "path";

// This will be set by the agent before running
let uploadFn: ((filePath: string, title?: string) => Promise<void>) | null = null;

export function setUploadFunction(fn: (filePath: string, title?: string) => Promise<void>): void {
	uploadFn = fn;
}

const attachSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're sharing (shown to user)" }),
	path: Type.String({ description: "Path to the file to attach" }),
	title: Type.Optional(Type.String({ description: "Title for the file (defaults to filename)" })),
});

/**
 * Create attach tool with working directory context.
 * Relative paths are resolved against `workingDir` (NOT process.cwd()) so
 * the absolute path matches what `write` / `edit` produce and what the
 * HTTP `/file` endpoint expects (must be inside workingDir).
 */
export function createAttachTool(workingDir: string): AgentTool<typeof attachSchema> {
	return {
		name: "attach",
		label: "attach",
		description:
			"Attach a file to your response. Use this to share files, images, or documents with the user. Only files inside the working directory can be attached.",
		parameters: attachSchema,
		execute: async (
			_toolCallId: string,
			{ path, title }: { label: string; path: string; title?: string },
			signal?: AbortSignal,
		) => {
			if (!uploadFn) {
				throw new Error("Upload function not configured");
			}

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Resolve relative paths against workingDir, not process.cwd().
			const absolutePath = isAbsolute(path) ? path : resolvePath(workingDir, path);
			const fileName = title || basename(absolutePath);

			await uploadFn(absolutePath, fileName);

			return {
				content: [{ type: "text" as const, text: `Attached file: ${fileName}` }],
				details: undefined,
			};
		},
	};
}
