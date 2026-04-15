import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";
import { readFile, writeFile } from "fs/promises";
import { isAbsolute, resolve } from "path";
import type { Executor } from "../sandbox.js";

/**
 * Generate a unified diff string with line numbers and context
 */
function generateDiffString(oldContent: string, newContent: string, contextLines = 4): string {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				oldLineNum += skipStart + skipEnd;
				newLineNum += skipStart + skipEnd;
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}

const editSchema = Type.Object({
	label: Type.String({ description: "Brief description of the edit you're making (shown to user)" }),
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

/**
 * Create edit tool with working directory context.
 * @param _executor - Executor (unused, kept for API compatibility)
 * @param workingDir - Absolute path to the working directory (for resolving relative paths)
 */
export function createEditTool(_executor: Executor, workingDir: string): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		parameters: editSchema,
		execute: async (
			_toolCallId: string,
			{ path: filePath, oldText, newText }: { label: string; path: string; oldText: string; newText: string },
			_signal?: AbortSignal,
		) => {
			// Use Node.js fs APIs for cross-platform compatibility (Windows + Linux)
			// Resolve relative paths against workingDir, not process.cwd()
			const resolvedPath = isAbsolute(filePath) ? filePath : resolve(workingDir, filePath);

			try {
				// Read the file
				const content = await readFile(resolvedPath, "utf-8");

				// Check if old text exists
				if (!content.includes(oldText)) {
					throw new Error(
						`Could not find the exact text in ${filePath}. The old text must match exactly including all whitespace and newlines.`,
					);
				}

				// Count occurrences
				const occurrences = content.split(oldText).length - 1;

				if (occurrences > 1) {
					throw new Error(
						`Found ${occurrences} occurrences of the text in ${filePath}. The text must be unique. Please provide more context to make it unique.`,
					);
				}

				// Perform replacement
				const index = content.indexOf(oldText);
				const newContent = content.substring(0, index) + newText + content.substring(index + oldText.length);

				if (content === newContent) {
					throw new Error(
						`No changes made to ${filePath}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
					);
				}

				// Write the file back
				await writeFile(resolvedPath, newContent, "utf-8");

				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced text in ${filePath}. Changed ${oldText.length} characters to ${newText.length} characters.`,
						},
					],
					details: { diff: generateDiffString(content, newContent) },
				};
			} catch (err) {
				if (err instanceof Error && err.message.includes("Could not find")) {
					throw err;
				}
				if (err instanceof Error && err.message.includes("occurrences")) {
					throw err;
				}
				if (err instanceof Error && err.message.includes("No changes made")) {
					throw err;
				}
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to edit file: ${filePath} - ${message}`);
			}
		},
	};
}
