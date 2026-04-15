import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { mkdir, writeFile } from "fs/promises";
import { dirname, isAbsolute, resolve } from "path";
import type { Executor } from "../sandbox.js";

const writeSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're writing (shown to user)" }),
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

/**
 * Create write tool with working directory context.
 * @param _executor - Executor (unused, kept for API compatibility)
 * @param workingDir - Absolute path to the working directory (for resolving relative paths)
 */
export function createWriteTool(_executor: Executor, workingDir: string): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path: filePath, content }: { label: string; path: string; content: string },
			_signal?: AbortSignal,
		) => {
			// Use Node.js fs APIs for cross-platform compatibility (Windows + Linux)
			// Resolve relative paths against workingDir, not process.cwd()
			const resolvedPath = isAbsolute(filePath) ? filePath : resolve(workingDir, filePath);
			const dir = dirname(resolvedPath);

			try {
				await mkdir(dir, { recursive: true });
				await writeFile(resolvedPath, content, "utf-8");

				return {
					content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${filePath}` }],
					details: undefined,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to write file: ${filePath} - ${message}`);
			}
		},
	};
}
