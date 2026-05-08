import { Agent, fetch } from "undici";

export interface ChatWithDIAArgs {
	prompt: string;
	customMessageBehaviour: string;
	channelId: string;
	mode?: "rag" | "pure";
	signal?: AbortSignal;
}

export interface ChatWithDIAResponse {
	result: string;
	chatHistoryId: string;
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

async function getTokenCached(): Promise<string> {
	const now = Date.now();
	if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
		return tokenCache.accessToken;
	}

	const token = await fetchOAuth2Token();
	tokenCache = {
		accessToken: token.accessToken,
		expiresAt: now + token.expiresIn * 1000,
	};
	return token.accessToken;
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

async function getOrCreateHistory(channelId: string, brainId: string, token: string): Promise<string> {
	const cached = historyMap.get(channelId);
	if (cached) return cached;
	const historyId = await createHistoryRemote(brainId, token);
	historyMap.set(channelId, historyId);
	console.log(`[DIA] New history ${historyId} for channel ${channelId}`);
	return historyId;
}

export function resetHistory(channelId: string): void {
	historyMap.delete(channelId);
}

export async function chatWithDIA(args: ChatWithDIAArgs): Promise<ChatWithDIAResponse> {
	const { prompt, customMessageBehaviour, channelId, mode = "rag", signal } = args;

	const brainId = process.env.BRAIN_ID?.replace(/"/g, "").trim();
	if (!brainId) throw new Error("BRAIN_ID is not configured in .env");

	const endpoint = (mode === "pure" ? process.env.DIA_CHAT_PURE : process.env.DIA_CHAT_RAG)
		?.replace(/"/g, "")
		.trim();
	if (!endpoint) {
		throw new Error(`DIA endpoint for mode '${mode}' is not configured in .env`);
	}

	const token = await getTokenCached();
	const chatHistoryId = await getOrCreateHistory(channelId, brainId, token);

	const body = {
		prompt,
		customMessageBehaviour,
		knowledgeBaseId: brainId,
		chatHistoryId,
		useGptKnowledge: true,
	};

	const t0 = Date.now();
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});

	if (response.status !== 200) {
		const errorText = await response.text();
		throw new Error(`DIA chat (${mode}) failed: ${response.status} - ${errorText}`);
	}

	const data = (await response.json()) as { result?: string };
	if (!data.result) {
		throw new Error("DIA chat response missing 'result' field");
	}

	const elapsed = Date.now() - t0;
	console.log(`[DIA] ${mode.toUpperCase()} ok ${elapsed}ms (history=${chatHistoryId.slice(0, 8)}…)`);

	return { result: data.result, chatHistoryId };
}
