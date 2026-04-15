import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { readFile } from "fs/promises";
import { extname, isAbsolute, resolve } from "path";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

/**
 * Map of file extensions to MIME types for common image formats
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * Check if a file is an image based on its extension
 */
function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

const readSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're reading and why (shown to user)" }),
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Create read tool with working directory context.
 * @param _executor - Executor (unused, kept for API compatibility)
 * @param workingDir - Absolute path to the working directory (for resolving relative paths)
 */
export function createReadTool(_executor: Executor, workingDir: string): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path: filePath, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
			_signal?: AbortSignal,
		): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> => {
			// Use Node.js fs APIs for cross-platform compatibility (Windows + Linux)
			// Resolve relative paths against workingDir, not process.cwd()
			const resolvedPath = isAbsolute(filePath) ? filePath : resolve(workingDir, filePath);

			const mimeType = isImageFile(filePath);

			try {
				if (mimeType) {
					// Read as image (binary) - convert to base64
					const buffer = await readFile(resolvedPath);
					const base64 = buffer.toString("base64");

					return {
						content: [
							{ type: "text", text: `Read image file [${mimeType}]` },
							{ type: "image", data: base64, mimeType },
						],
						details: undefined,
					};
				}

				// Read text file
				const fileContent = await readFile(resolvedPath, "utf-8");
				const allLines = fileContent.split("\n");
				const totalFileLines = allLines.length;

				// Apply offset if specified (1-indexed)
				const startLine = offset ? Math.max(1, offset) : 1;
				const startLineDisplay = startLine;

				// Check if offset is out of bounds
				if (startLine > totalFileLines) {
					throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
				}

				// Extract lines from offset
				let selectedLines = allLines.slice(startLine - 1);
				let userLimitedLines: number | undefined;

				// Apply user limit if specified
				if (limit !== undefined) {
					const endLine = Math.min(limit, selectedLines.length);
					selectedLines = selectedLines.slice(0, endLine);
					userLimitedLines = endLine;
				}

				let selectedContent = selectedLines.join("\n");

				// Apply truncation (respects both line and byte limits)
				const truncation = truncateHead(selectedContent);

				let outputText: string;
				let details: ReadToolDetails | undefined;

				if (truncation.firstLineExceedsLimit) {
					// First line at offset exceeds 50KB - tell model to use bash or alternative
					const firstLineSize = formatSize(Buffer.byteLength(selectedContent.split("\n")[0], "utf-8"));
					outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit]`;
					details = { truncation };
				} else if (truncation.truncated) {
					// Truncation occurred - build actionable notice
					const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
					const nextOffset = endLineDisplay + 1;

					outputText = truncation.content;

					if (truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
					} else {
						outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
					}
					details = { truncation };
				} else if (userLimitedLines !== undefined) {
					// User specified limit, check if there's more content
					const linesFromStart = startLine - 1 + userLimitedLines;
					if (linesFromStart < totalFileLines) {
						const remaining = totalFileLines - linesFromStart;
						const nextOffset = startLine + userLimitedLines;

						outputText = truncation.content;
						outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
					} else {
						outputText = truncation.content;
					}
				} else {
					// No truncation, no user limit exceeded
					outputText = truncation.content;
				}

				return {
					content: [{ type: "text", text: outputText }],
					details,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to read file: ${filePath} - ${message}`);
			}
		},
	};
}
