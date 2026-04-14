import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { CoreServiceChatPanel, CoreServiceClient, translations, type SessionInfo } from "@mariozechner/pi-web-ui";
import { setTranslations } from "@mariozechner/mini-lit";
import { html, render } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { ChevronLeft, ChevronRight, MessageSquare, Plus, Settings } from "lucide";
import "./app.css";

// Register translations in the local mini-lit instance
setTranslations(translations);

// Read config from URL params
const urlParams = new URLSearchParams(window.location.search);
const baseUrl = urlParams.get("baseUrl") || "";
const userName = urlParams.get("userName") || "user";

// Stable channel ID per browser session
let channelId = sessionStorage.getItem("channelId");
if (!channelId) {
	channelId = crypto.randomUUID();
	sessionStorage.setItem("channelId", channelId);
}

// App state
let sidebarOpen = true;
let sessions: SessionInfo[] = [];
const client = new CoreServiceClient(baseUrl);

const chatPanel = new CoreServiceChatPanel();
chatPanel.baseUrl = baseUrl;
chatPanel.channelId = channelId;
chatPanel.userName = userName;

const app = document.getElementById("app");
if (!app) throw new Error("App container not found");

async function loadSessions() {
	sessions = await client.getSessions();
	renderApp();
}

function switchSession(id: string) {
	channelId = id;
	sessionStorage.setItem("channelId", id);
	chatPanel.channelId = id;
	renderApp();
}

function newSession() {
	sessionStorage.removeItem("channelId");
	window.location.reload();
}

function toggleSidebar() {
	sidebarOpen = !sidebarOpen;
	renderApp();
}

function formatTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

function renderApp() {
	render(
		html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<!-- Header -->
				<div class="flex items-center justify-between border-b border-border shrink-0 px-4 py-1">
					<div class="flex items-center gap-2">
						${Button({
							variant: "ghost",
							size: "icon",
							children: sidebarOpen ? icon(ChevronLeft, "sm") : icon(ChevronRight, "sm"),
							onClick: toggleSidebar,
							title: sidebarOpen ? "Collapse sessions" : "Expand sessions",
						})}
						<span class="text-base font-semibold text-foreground">Bot Chat</span>
					</div>
					<div class="flex items-center gap-1">
						<theme-toggle></theme-toggle>
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(Settings, "sm"),
							onClick: () => {
								const newUrl = prompt("Core service URL:", baseUrl);
								if (newUrl && newUrl !== baseUrl) {
									const url = new URL(window.location.href);
									url.searchParams.set("baseUrl", newUrl);
									window.location.href = url.toString();
								}
							},
							title: "Settings",
						})}
					</div>
				</div>

				<!-- Body -->
				<div class="flex flex-1 overflow-hidden">
					<!-- Sidebar -->
					${sidebarOpen
						? html`
							<div class="w-60 shrink-0 border-r border-border flex flex-col overflow-hidden bg-background">
								<div class="p-2 shrink-0">
									${Button({
										variant: "outline",
										size: "sm",
										className: "w-full justify-start gap-2",
										children: html`${icon(Plus, "sm")}<span>New session</span>`,
										onClick: newSession,
									})}
								</div>
								<div class="flex-1 overflow-y-auto">
									${sessions.length === 0
										? html`<div class="px-3 py-4 text-xs text-muted-foreground italic">No sessions yet</div>`
										: sessions.map(
											(s) => html`
												<button
													class="w-full text-left px-3 py-2 hover:bg-accent transition-colors flex flex-col gap-0.5 ${s.channelId === channelId ? "bg-accent" : ""}"
													@click=${() => switchSession(s.channelId)}
												>
													<div class="flex items-center gap-1.5 min-w-0">
														${icon(MessageSquare, "xs")}
														<span class="text-xs font-medium truncate flex-1">${s.preview || "Empty session"}</span>
													</div>
													<div class="text-xs text-muted-foreground flex gap-2 pl-4">
														<span>${s.messageCount} msg${s.messageCount !== 1 ? "s" : ""}</span>
														<span>${formatTime(s.lastModified)}</span>
													</div>
												</button>
											`,
										)}
								</div>
							</div>
						`
						: ""}

					<!-- Chat Panel -->
					<div class="flex-1 min-w-0 overflow-hidden flex flex-col">${chatPanel}</div>
				</div>
			</div>
		`,
		app,
	);
}

// Initial render then load sessions
renderApp();
loadSessions();
