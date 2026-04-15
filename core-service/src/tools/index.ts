import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";

/**
 * Create mom tools with working directory context.
 * @param executor - Executor for running shell commands
 * @param workingDir - Absolute path to the working directory (for resolving relative paths)
 */
export function createMomTools(executor: Executor, workingDir: string): AgentTool<any>[] {
	return [
		createReadTool(executor, workingDir),
		createBashTool(executor),
		createEditTool(executor, workingDir),
		createWriteTool(executor, workingDir),
		attachTool,
	];
}
