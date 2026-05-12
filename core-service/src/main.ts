#!/usr/bin/env node

import "dotenv/config";

// Setup global proxy for LLM calls (must be before any fetch).
//
// IMPORTANT: pi-ai's `utils/http-proxy.js` runs an async `import("undici").then`
// that calls `setGlobalDispatcher(new EnvHttpProxyAgent())` AFTER our manual
// ProxyAgent install — silently overriding it with a dispatcher that reads
// `HTTPS_PROXY` / `HTTP_PROXY` env vars. To survive that override we also
// expose the proxy URL (with embedded basic auth) via the standard env vars
// before any pi-ai code runs.
import { setGlobalDispatcher, ProxyAgent } from "undici";
if (process.env.PROX) {
	// Build the proxy URL manually because `new URL(...).toString()` collapses
	// `iyh1hc:@host` (empty password) to `iyh1hc@host` (no separator), which
	// EnvHttpProxyAgent cannot parse. We always emit `user:password@host` with
	// the colon present, even when password is empty.
	const baseUrl = new URL(process.env.PROX);
	let proxyUri: string;
	if (process.env.AGENT_USER) {
		const userEnc = encodeURIComponent(process.env.AGENT_USER);
		const pwdEnc = encodeURIComponent(process.env.AGENT_PWD || "");
		proxyUri = `${baseUrl.protocol}//${userEnc}:${pwdEnc}@${baseUrl.host}`;
	} else {
		proxyUri = `${baseUrl.protocol}//${baseUrl.host}`;
	}

	// (1) Install our own ProxyAgent first — covers any sync fetch that fires
	// before pi-ai's async http-proxy.js callback resolves.
	const token = process.env.AGENT_USER
		? `Basic ${Buffer.from(`${process.env.AGENT_USER}:${process.env.AGENT_PWD || ""}`).toString("base64")}`
		: undefined;
	const dispatcher = new ProxyAgent({ uri: proxyUri, token });
	setGlobalDispatcher(dispatcher);

	// (2) Mirror to standard env vars so EnvHttpProxyAgent (pi-ai override)
	// resolves to the same proxy with embedded auth. Without this, pi-ai's
	// override silently bypasses the proxy (or worse: picks up a stale Windows
	// env var pointing at the corporate proxy WITHOUT auth, causing every LLM
	// Farm call to fail with a generic "Connection error"). We FORCE-overwrite
	// any pre-existing HTTPS_PROXY so the local authenticated forwarder wins.
	process.env.HTTPS_PROXY = proxyUri;
	process.env.HTTP_PROXY = proxyUri;
	process.env.https_proxy = proxyUri;
	process.env.http_proxy = proxyUri;

	console.log(`✓ Proxy: ${process.env.PROX} (user: ${process.env.AGENT_USER || "none"})`);
	console.log(`✓ HTTPS_PROXY = ${process.env.HTTPS_PROXY}`);
}

// Debug fetch wrapper — logs every outbound LLM Farm request to surface
// silent connection failures from the OpenAI SDK retry loop.
if (process.env.LLM_DEBUG === "true" && process.env.LLM_BASE_URL) {
	const baseLLM = process.env.LLM_BASE_URL;
	const _fetch = globalThis.fetch;
	globalThis.fetch = (async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : input?.url ?? String(input);
		const isLLM = url.startsWith(baseLLM);
		if (isLLM) {
			console.log(`[LLM_DEBUG] → ${init?.method || "GET"} ${url}`);
		}
		try {
			const res = await _fetch(input, init);
			if (isLLM) console.log(`[LLM_DEBUG] ← ${res.status} ${url}`);
			return res;
		} catch (err) {
			if (isLLM) {
				const cause = (err as any)?.cause;
				console.log(`[LLM_DEBUG] ✗ ${url} -- ${err}`);
				if (cause) console.log(`[LLM_DEBUG]   cause: ${cause}`);
			}
			throw err;
		}
	}) as typeof fetch;
}

// Add api-version query param for Azure OpenAI endpoints (required by Bosch GenAI Platform)
if (process.env.LLM_API_VERSION) {
	const originalFetch = globalThis.fetch;
	const apiVersion = process.env.LLM_API_VERSION;
	const baseUrl = process.env.LLM_BASE_URL || "";

	globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		let url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

		// Only modify requests to our configured LLM endpoint
		if (baseUrl && url.startsWith(baseUrl.split("?")[0])) {
			const urlObj = new URL(url);
			if (!urlObj.searchParams.has("api-version")) {
				urlObj.searchParams.set("api-version", apiVersion);
				url = urlObj.toString();
			}
			input = typeof input === "string" ? url : new URL(url);
		}

		return originalFetch(input, init);
	};
	console.log(`✓ LLM API version: ${apiVersion}`);
}

import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import { HttpServer } from "./http.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { createSlackContext, SlackBot as SlackBotClass } from "./slack.js";
import { ChannelStore } from "./store.js";
import type { BotContext, BotHandler } from "./types.js";

// ============================================================================
// Config
// ============================================================================

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
	httpPort?: number;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let httpPort: number | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (arg.startsWith("--http=")) {
			httpPort = parseInt(arg.slice("--http=".length), 10) || 3030;
		} else if (arg === "--http") {
			const next = args[i + 1];
			if (next && !next.startsWith("-") && /^\d+$/.test(next)) {
				httpPort = parseInt(next, 10);
				i++;
			} else {
				httpPort = 3030;
			}
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		httpPort,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>] [--http[=port]] <working-directory>");
	console.error("       mom --download <channel-id>");
	process.exit(1);
}

const { workingDir, sandbox, httpPort } = {
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
	httpPort: parsedArgs.httpPort,
};

const hasSlack = !!(MOM_SLACK_APP_TOKEN && MOM_SLACK_BOT_TOKEN);
const hasHttp = httpPort !== undefined;

if (!hasSlack && !hasHttp) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	console.error("Or start with --http[=port] to use the HTTP SSE channel instead.");
	process.exit(1);
}

await validateSandbox(sandbox);

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	/** Called once the aborted run finishes — set by handleStop, invoked by handleEvent */
	onStopComplete?: () => Promise<void>;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, "sessions", channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir),
			store: new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN || "" }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Handler
// ============================================================================

const handler: BotHandler = {
	isRunning(channelId: string): boolean {
		return channelStates.get(channelId)?.running ?? false;
	},

	async handleStop(
		channelId: string,
		onStopping: () => Promise<void>,
		onStopped: () => Promise<void>,
	): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			state.onStopComplete = onStopped;
			await onStopping();
		}
		// "Nothing running" case: the adapter already checked isRunning() before calling this
	},

	async handleEvent(channelId: string, ctx: BotContext, _isEvent?: boolean): Promise<void> {
		const state = getState(channelId);

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${channelId}] Starting run: ${ctx.message.text.substring(0, 50)}`);

		try {
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx, state.store);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.onStopComplete) {
					await state.onStopComplete();
					state.onStopComplete = undefined;
				}
			}
		} catch (err) {
			log.logWarning(`[${channelId}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// Start HTTP SSE server if requested
if (hasHttp) {
	const httpServer = new HttpServer({
		port: httpPort!,
		workingDir,
		handler,
	});
	httpServer.start();
}

// Start Slack bot if tokens are available
let eventsWatcher: ReturnType<typeof createEventsWatcher> | undefined;

if (hasSlack) {
	const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });

	const bot = new SlackBotClass(handler, {
		appToken: MOM_SLACK_APP_TOKEN,
		botToken: MOM_SLACK_BOT_TOKEN,
		workingDir,
		store: sharedStore,
	});

	eventsWatcher = createEventsWatcher(workingDir, bot);
	eventsWatcher.start();

	bot.start();
}

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher?.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher?.stop();
	process.exit(0);
});
