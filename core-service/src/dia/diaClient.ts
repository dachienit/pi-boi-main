import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Agent, fetch } from "undici";
import type { SkillName } from "../types.js";

export type DiaPhase = "oauth" | "history" | "fetch";

const SKILL_FILENAME = "SKILL.md";

/**
 * Load a skill's SKILL.md persona text from `<workspaceDir>/skills/<skill>/SKILL.md`.
 *
 * The persona is sent to DIA Brain as `customMessageBehaviour`. It contains
 * scope, style, and output rules — but NOT pi-boi internals (paths, tools,
 * channel ids). DIA stays workspace-blind by design; pi-boi handles all
 * filesystem resolution after DIA returns.
 */
export function loadSkillPersona(workspaceDir: string, skill: SkillName): string {
	const skillPath = join(workspaceDir, "skills", skill, SKILL_FILENAME);
	if (!existsSync(skillPath)) {
		throw new Error(
			`Skill '${skill}' not found at ${skillPath}. ` +
				`Create the file or run the OctoAgent setup that seeds workspace skills.`,
		);
	}
	return readFileSync(skillPath, "utf-8");
}

export interface DiaPhaseEvent {
	phase: DiaPhase;
	stage: "start" | "end";
	durationMs?: number;
	cached?: boolean;
	error?: string;
}

export interface ChatWithDIAArgs {
	prompt: string;
	customMessageBehaviour: string;
	channelId: string;
	mode?: "rag" | "pure";
	signal?: AbortSignal;
	/** Optional callback fired around each network phase (oauth, history, fetch). */
	onPhase?: (event: DiaPhaseEvent) => void;
}

/**
 * Raw debug step shape returned by DIA Brain when `debugStepDetailsEnabled: true`.
 * We keep it loose because the inner `details` payload varies per node type.
 */
export interface DiaDebugStep {
	stepId: string;
	stepName: string;
	executionTimeMs: number;
	details?: Record<string, unknown>;
}

export interface ChatWithDIAResponse {
	result: string;
	chatHistoryId: string;
	debugSteps?: DiaDebugStep[];
}

interface TokenCache {
	accessToken: string | null;
	expiresAt: number;
}

let tokenCache: TokenCache = { accessToken: null, expiresAt: 0 };

const historyMap = new Map<string, string>();

// Direct (non-proxy) dispatcher used to bypass the global proxy that main.ts
// installs via `setGlobalDispatcher(ProxyAgent)`. Required for the Microsoft
// public OAuth endpoint (login.microsoftonline.com) which the Bosch corporate
// proxy is not authorised to relay. DIA Brain endpoints continue to use the
// global proxy (no dispatcher override).
let directAgent: Agent | null = null;
function getDirectAgent(): Agent {
	if (!directAgent) directAgent = new Agent();
	return directAgent;
}

async function fetchOAuth2Token(): Promise<{ accessToken: string; expiresIn: number }> {
	const tokenUrl = process.env.URL_TOKEN?.replace(/"/g, "").trim();
	if (!tokenUrl) throw new Error("URL_TOKEN is not configured in .env");

	const params = new URLSearchParams();
	params.append("client_id", process.env.CLIENT_ID?.replace(/"/g, "").trim() ?? "");
	params.append("scope", process.env.SCOPE?.replace(/"/g, "").trim() ?? "");
	params.append("client_secret", process.env.CLIENT_SECRET?.replace(/"/g, "").trim() ?? "");
	params.append("grant_type", process.env.GRANT_TYPE?.replace(/"/g, "").trim() ?? "client_credentials");

	console.log(`[DIA] OAuth -> ${tokenUrl} (no proxy)`);
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
		dispatcher: getDirectAgent(),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`DIA OAuth token request failed: ${response.status} - ${errorText}`);
	}

	const tokenData = (await response.json()) as { access_token?: string; expires_in?: number };
	if (!tokenData.access_token) {
		throw new Error("DIA OAuth response missing access_token");
	}

	return {
		accessToken: tokenData.access_token,
		expiresIn: tokenData.expires_in ?? 3600,
	};
}

async function getTokenCached(onPhase?: ChatWithDIAArgs["onPhase"]): Promise<string> {
	const now = Date.now();
	if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
		// Cache hit — emit a synthetic 0ms event so the UI still shows the step.
		onPhase?.({ phase: "oauth", stage: "start", cached: true });
		onPhase?.({ phase: "oauth", stage: "end", durationMs: 0, cached: true });
		return tokenCache.accessToken;
	}

	onPhase?.({ phase: "oauth", stage: "start", cached: false });
	const t0 = Date.now();
	try {
		const token = await fetchOAuth2Token();
		tokenCache = {
			accessToken: token.accessToken,
			expiresAt: now + token.expiresIn * 1000,
		};
		onPhase?.({ phase: "oauth", stage: "end", durationMs: Date.now() - t0, cached: false });
		return token.accessToken;
	} catch (err) {
		onPhase?.({
			phase: "oauth",
			stage: "end",
			durationMs: Date.now() - t0,
			cached: false,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

async function createHistoryRemote(brainId: string, token: string): Promise<string> {
	const baseUrl = process.env.DIA_HISTORY?.replace(/"/g, "").trim();
	if (!baseUrl) throw new Error("DIA_HISTORY is not configured in .env");
	const url = `${baseUrl}/${brainId}`;

	const response = await fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	});

	if (response.status !== 200) {
		const errorText = await response.text();
		throw new Error(`DIA createHistory failed: ${response.status} - ${errorText}`);
	}

	const historyId = (await response.text()).trim();
	if (!historyId) throw new Error("DIA createHistory returned empty body");
	return historyId.replace(/^"|"$/g, "");
}

async function getOrCreateHistory(
	channelId: string,
	brainId: string,
	token: string,
	onPhase?: ChatWithDIAArgs["onPhase"],
): Promise<string> {
	const cached = historyMap.get(channelId);
	if (cached) {
		onPhase?.({ phase: "history", stage: "start", cached: true });
		onPhase?.({ phase: "history", stage: "end", durationMs: 0, cached: true });
		return cached;
	}

	onPhase?.({ phase: "history", stage: "start", cached: false });
	const t0 = Date.now();
	try {
		const historyId = await createHistoryRemote(brainId, token);
		historyMap.set(channelId, historyId);
		console.log(`[DIA] New history ${historyId} for channel ${channelId}`);
		onPhase?.({ phase: "history", stage: "end", durationMs: Date.now() - t0, cached: false });
		return historyId;
	} catch (err) {
		onPhase?.({
			phase: "history",
			stage: "end",
			durationMs: Date.now() - t0,
			cached: false,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

export function resetHistory(channelId: string): void {
	historyMap.delete(channelId);
}

export async function chatWithDIA(args: ChatWithDIAArgs): Promise<ChatWithDIAResponse> {
	const { prompt, customMessageBehaviour, channelId, mode = "rag", signal, onPhase } = args;

	const brainId = process.env.BRAIN_ID?.replace(/"/g, "").trim();
	if (!brainId) throw new Error("BRAIN_ID is not configured in .env");

	const endpoint = (mode === "pure" ? process.env.DIA_CHAT_PURE : process.env.DIA_CHAT_RAG)
		?.replace(/"/g, "")
		.trim();
	if (!endpoint) {
		throw new Error(`DIA endpoint for mode '${mode}' is not configured in .env`);
	}

	const token = await getTokenCached(onPhase);
	const chatHistoryId = await getOrCreateHistory(channelId, brainId, token, onPhase);

	// Body schema differs between the two DIA workflows:
	//   RAG  -> Claude + Bosch SAP RAG (uses `useGptKnowledge` toggle)
	//   PURE -> gpt-5-nano (no RAG, accepts `attachmentIds` for per-call uploads)
	// Sending an unknown field to either workflow can trigger backend rejection,
	// so build the body strictly per the documented schema for the active mode.
	const baseBody = {
		prompt,
		customMessageBehaviour,
		knowledgeBaseId: brainId,
		chatHistoryId,
		debugStepDetailsEnabled: true,
	};
	const body =
		mode === "rag"
			? { ...baseBody, useGptKnowledge: true }
			: { ...baseBody, attachmentIds: [] as string[] };

	onPhase?.({ phase: "fetch", stage: "start" });
	const t0 = Date.now();
	let response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		onPhase?.({
			phase: "fetch",
			stage: "end",
			durationMs: Date.now() - t0,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}

	if (response.status !== 200) {
		const errorText = await response.text();
		onPhase?.({
			phase: "fetch",
			stage: "end",
			durationMs: Date.now() - t0,
			error: `HTTP ${response.status}: ${errorText.slice(0, 200)}`,
		});
		throw new Error(`DIA chat (${mode}) failed: ${response.status} - ${errorText}`);
	}

	const data = (await response.json()) as {
		result?: string;
		debugReportDTO?: { debugSteps?: DiaDebugStep[] };
	};
	if (!data.result) {
		onPhase?.({
			phase: "fetch",
			stage: "end",
			durationMs: Date.now() - t0,
			error: "missing 'result' field",
		});
		throw new Error("DIA chat response missing 'result' field");
	}

	const elapsed = Date.now() - t0;
	console.log(`[DIA] ${mode.toUpperCase()} ok ${elapsed}ms (history=${chatHistoryId.slice(0, 8)}…)`);
	onPhase?.({ phase: "fetch", stage: "end", durationMs: elapsed });

	return {
		result: data.result,
		chatHistoryId,
		debugSteps: data.debugReportDTO?.debugSteps,
	};
}
