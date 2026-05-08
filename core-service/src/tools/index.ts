import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { createAttachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createCallDIABrainTool } from "./dia.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";

/**
 * Create OctoAgent tools with working directory context.
 * @param executor - Executor for running shell commands
 * @param workingDir - Absolute path to the working directory (for resolving relative paths)
 * @param channelId - Session/channel id used to scope DIA chat history
 * @param hostWorkspacePath - Absolute host path to the workspace root (for reading skills/*)
 */
export function createMomTools(
	executor: Executor,
	workingDir: string,
	channelId: string,
	hostWorkspacePath: string,
): AgentTool<any>[] {
	const baseTools: AgentTool<any>[] = [
		createReadTool(executor, workingDir),
		createBashTool(executor),
		createEditTool(executor, workingDir),
		createWriteTool(executor, workingDir),
		createAttachTool(workingDir),
	];
	const diaTool = createCallDIABrainTool(channelId, baseTools, workingDir, hostWorkspacePath);
	return [...baseTools, diaTool];
}
