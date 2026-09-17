/**
 * Page behaviour tests: the served `app.js` is executed against a strict fake DOM so
 * card construction, explicit submissions and the "host text is text" guarantee are
 * covered without a real browser. `innerHTML` throws in the fake DOM, so a regression
 * to HTML parsing fails here as well as in the static guard.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createFakeEnvironment, flushTasks, importPage, installPageGlobals } from "./helpers/fake-dom.js";

const indexHtml = readFileSync(fileURLToPath(new URL("../src/browser/index.html", import.meta.url)), "utf8");

let restoreGlobals = null;
let bust = 0;

afterEach(() => {
	restoreGlobals?.();
	restoreGlobals = null;
});

async function boot({ token = "a".repeat(64), pending = [], revision = 1, generation = 1, reloading = false } = {}) {
	bust += 1;
	const environment = createFakeEnvironment({ token });
	environment.setSnapshot({ revision, pending, generation, reloading });
	restoreGlobals = installPageGlobals(environment);
	const page = await importPage({ bust: `boot-${bust}` });
	// The module schedules its first poll; run it so the snapshot is rendered.
	await environment.runNextTimer();
	return { environment, page };
}

const samples = {
	confirm: { id: "id-confirm", kind: "confirm", title: "Probe confirm", message: "Confirm <script>alert(1)</script>?", options: null, unsupported: false },
	select: { id: "id-select", kind: "select", title: "Probe select", message: "", options: ["Red", "Blue"], unsupported: false },
	input: { id: "id-input", kind: "input", title: "Probe input", message: "", placeholder: "type here", unsupported: false },
	editor: { id: "id-editor", kind: "editor", title: "Probe editor", message: "", prefill: "prefilled line", unsupported: false },
	custom: { id: "id-custom", kind: "custom", title: "custom", message: "", unsupported: true, unsupportedReason: "terminated without approval" },
};

function postCalls(environment) {
	return environment.fetchCalls.filter((call) => call.path === "/api/answer");
}

describe("browser page markup contract", () => {
	it("still contains the elements and classes the page module depends on", () => {
		for (const token of [
			'id="card-template"',
			'class="card"',
			'class="card-title"',
			'class="card-message"',
			'class="card-meta"',
			'class="card-form"',
			'class="card-actions"',
			'class="cancel"',
			'class="card-result"',
			'id="connection"',
			'id="status-heading"',
			'id="status-state"',
			'id="status-cwd"',
			'id="status-branch"',
			'id="status-tokens"',
			'id="status-context"',
			'id="page-tab-chat"',
			'id="page-tab-subagents"',
			'id="chat-page"',
			'id="subagents-page"',
			'id="subagents-heading"',
			'id="subagents-tag"',
			'id="subagents-state"',
			'id="subagents-refresh"',
			'id="subagents-status"',
			'id="subagents-fleet"',
			'id="subagents-async"',
			'id="requests"',
			'id="empty"',
			'id="auth"',
			'id="auth-form"',
			'id="auth-token"',
			'id="auth-message"',
			'name="token"',
			'id="reload-form"',
			'id="reload-button"',
			'id="reload-state"',
			'id="chat-history"',
			'id="chat-form"',
			'id="chat-input"',
			'id="chat-delivery"',
			'value="steer"',
			'id="chat-send"',
			'id="chat-stop"',
			'id="chat-status"',
			'id="controls-heading"',
			'id="controls-state"',
			'id="model-current"',
			'id="model-form"',
			'id="model-select"',
			'id="model-status"',
			'id="thinking-form"',
			'id="thinking-select"',
			'id="thinking-status"',
		]) {
			assert.equal(indexHtml.includes(token), true, `index.html must keep ${token}`);
		}

		// Picking a value in either select applies it; the old second-confirmation
		// buttons must not come back behind a live select.
		for (const gone of ['id="model-apply"', 'id="thinking-apply"', ">Use model<", ">Use thinking level<"]) {
			assert.equal(indexHtml.includes(gone), false, `index.html must not keep ${gone}`);
		}

		// Chat and Subagents are two pages of one shell: the tab row in the top bar switches
		// them, and the subagents area may no longer occupy the chat rail at all.
		assert.equal(indexHtml.includes('id="subagents-card"'), false, "the subagents rail card is gone");
		const railBlock = indexHtml.slice(
			indexHtml.indexOf('<aside class="rail"'),
			indexHtml.indexOf("</aside>", indexHtml.indexOf('<aside class="rail"')),
		);
		assert.notEqual(railBlock.length, 0, "index.html must keep the session rail");
		for (const token of [
			'id="subagents-heading"',
			'id="subagents-tag"',
			'id="subagents-state"',
			'id="subagents-refresh"',
			'id="subagents-status"',
			'id="subagents-fleet"',
			'id="subagents-async"',
		]) {
			assert.equal(railBlock.includes(token), false, `the chat rail must not render ${token}`);
		}

		// The tab row is the only way in and out, so its contract is explicit: tablist + tabs
		// with aria-selected and aria-controls, panels with role=tabpanel and a label.
		assert.match(indexHtml, /<div class="page-tabs" role="tablist" aria-label="Pages">/);
		const chatTab = /<button id="page-tab-chat"[^>]*>/.exec(indexHtml)?.[0] ?? "";
		assert.match(chatTab, /role="tab"/);
		assert.match(chatTab, /aria-selected="true"/, "Chat is the default page");
		assert.match(chatTab, /aria-controls="chat-page"/);
		const subagentsTab = /<button id="page-tab-subagents"[^>]*>/.exec(indexHtml)?.[0] ?? "";
		assert.match(subagentsTab, /role="tab"/);
		assert.match(subagentsTab, /aria-selected="false"/);
		assert.match(subagentsTab, /aria-controls="subagents-page"/);
		assert.match(subagentsTab, /tabindex="-1"/, "only the selected tab stays in the tab order");

		const chatPanel = /<div id="chat-page"[^>]*>/.exec(indexHtml)?.[0] ?? "";
		assert.match(chatPanel, /role="tabpanel"/);
		assert.match(chatPanel, /aria-labelledby="page-tab-chat"/);
		const subagentsPanel = /<section id="subagents-page"[^>]*>/.exec(indexHtml)?.[0] ?? "";
		assert.match(subagentsPanel, /role="tabpanel"/);
		assert.match(subagentsPanel, /aria-labelledby="page-tab-subagents"/);
		assert.match(subagentsPanel, /class="[^"]*hidden/, "the subagents page starts hidden: Chat is the default");
		assert.equal(/hidden/.test(chatPanel), false, "the chat page must not start hidden");

		// The page owns the whole subagents area: heading, counts, state, refresh, status and
		// both sections; and one bounded scroll body wraps the long content.
		const pageBlock = indexHtml.slice(indexHtml.indexOf('id="subagents-page"'), indexHtml.indexOf("</main>", indexHtml.indexOf('id="subagents-page"')));
		for (const token of [
			'id="subagents-heading"',
			'id="subagents-tag"',
			'id="subagents-state"',
			'id="subagents-refresh"',
			'id="subagents-status"',
			'id="subagents-fleet"',
			'id="subagents-async"',
			"class=\"column-title\">Fleet<",
			"class=\"column-title\">Async runs<",
		]) {
			assert.equal(pageBlock.includes(token), true, `the subagents page must own ${token}`);
		}
		const bodyIndex = pageBlock.indexOf('class="subagents-page-body"');
		assert.notEqual(bodyIndex, -1, "the page content needs one bounded scroll body");
		for (const token of ['id="subagents-fleet"', 'id="subagents-async"']) {
			assert.equal(pageBlock.indexOf(token) > bodyIndex, true, `${token} must sit inside the page body`);
		}
	});
});

describe("browser page behaviour", () => {
	it("shows one page at a time and keeps the reader's page across every poll", async () => {
		const { environment, page } = await boot();
		const chatTab = environment.document.getElementById("page-tab-chat");
		const subagentsTab = environment.document.getElementById("page-tab-subagents");
		const chatPage = environment.document.getElementById("chat-page");
		const subagentsPage = environment.document.getElementById("subagents-page");

		// Chat is the default: the subagents area must not compete with the transcript.
		assert.equal(page.state.page, "chat");
		assert.equal(chatPage.classList.contains("hidden"), false);
		assert.equal(subagentsPage.classList.contains("hidden"), true);
		assert.equal(chatTab.getAttribute("aria-selected"), "true");
		assert.equal(subagentsTab.getAttribute("aria-selected"), "false");
		assert.equal(chatTab.tabIndex, 0);
		assert.equal(subagentsTab.tabIndex, -1);

		const callsBefore = environment.fetchCalls.length;
		subagentsTab.click();
		assert.equal(page.state.page, "subagents");
		assert.equal(subagentsPage.classList.contains("hidden"), false, "the subagents page takes the workspace");
		assert.equal(chatPage.classList.contains("hidden"), true, "the chat and its rail leave the workspace");
		assert.equal(subagentsTab.getAttribute("aria-selected"), "true");
		assert.equal(chatTab.getAttribute("aria-selected"), "false");
		assert.equal(chatTab.tabIndex, -1);
		assert.equal(subagentsTab.tabIndex, 0);
		assert.equal(
			environment.fetchCalls.length,
			callsBefore,
			"switching pages must not request anything: the page only shows what the poll delivered",
		);

		// A poll, a refresh, or a reload's new generation all update data in place: none of
		// them may yank the reader back to Chat.
		environment.setSnapshot({ revision: 2, pending: [], generation: 1, reloading: false });
		await environment.runNextTimer();
		assert.equal(subagentsPage.classList.contains("hidden"), false, "a poll must not change the page");
		environment.setSnapshot({ revision: 3, pending: [], generation: 2, reloading: false });
		await environment.runNextTimer();
		assert.equal(subagentsPage.classList.contains("hidden"), false, "a new generation must not change the page");
		assert.equal(environment.document.getElementById("page-tab-subagents").getAttribute("aria-selected"), "true");

		chatTab.click();
		assert.equal(page.state.page, "chat");
		assert.equal(chatPage.classList.contains("hidden"), false);
		assert.equal(subagentsPage.classList.contains("hidden"), true);
		assert.equal(chatTab.getAttribute("aria-selected"), "true");
	});

	it("switches pages from the keyboard with the tab row's roving focus", async () => {
		const { environment } = await boot();
		const chatTab = environment.document.getElementById("page-tab-chat");
		const subagentsTab = environment.document.getElementById("page-tab-subagents");
		const chatPage = environment.document.getElementById("chat-page");
		const subagentsPage = environment.document.getElementById("subagents-page");

		chatTab.dispatch("keydown", { key: "Tab" });
		assert.equal(chatPage.classList.contains("hidden"), false, "an unrelated key must not switch pages");
		assert.equal(subagentsTab.getAttribute("aria-selected"), "false");

		chatTab.dispatch("keydown", { key: "ArrowRight" });
		assert.equal(subagentsPage.classList.contains("hidden"), false);
		assert.equal(subagentsTab.getAttribute("aria-selected"), "true");
		assert.equal(subagentsTab.tabIndex, 0, "the selected tab is the one Tab reaches");
		assert.equal(chatTab.tabIndex, -1);

		subagentsTab.dispatch("keydown", { key: "ArrowLeft" });
		assert.equal(chatPage.classList.contains("hidden"), false);
		assert.equal(chatTab.getAttribute("aria-selected"), "true");

		// Two tabs, one row: the edges wrap, and Home/End pick an end directly.
		chatTab.dispatch("keydown", { key: "ArrowLeft" });
		assert.equal(subagentsPage.classList.contains("hidden"), false, "ArrowLeft on the first tab wraps to the last");
		subagentsTab.dispatch("keydown", { key: "Home" });
		assert.equal(chatPage.classList.contains("hidden"), false);
		chatTab.dispatch("keydown", { key: "End" });
		assert.equal(subagentsPage.classList.contains("hidden"), false);
		assert.equal(environment.document.getElementById("page-tab-subagents").tabIndex, 0);
	});

	it("renders compact status values safely and keeps missing values explicitly unknown", async () => {
		const { environment } = await boot();
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 1,
			reloading: false,
			status: {
				available: true,
				cwd: "E:/workspace/<safe>",
				git: { branch: "feature/demo", reason: null },
				tokens: { input: 1200, output: null, cacheRead: 3, cacheWrite: null, total: null },
				contextUsage: { tokens: null, contextWindow: 128000, percent: null },
			},
		});
		await environment.runNextTimer();
		assert.equal(environment.document.getElementById("status-cwd").textContent, "E:/workspace/<safe>");
		assert.equal(environment.document.getElementById("status-branch").textContent, "feature/demo");
		assert.match(environment.document.getElementById("status-tokens").textContent, /in 1\.2k/);
		assert.match(environment.document.getElementById("status-tokens").textContent, /out Unknown/);
		assert.match(environment.document.getElementById("status-tokens").textContent, /total Unknown/);
		assert.match(environment.document.getElementById("status-context").textContent, /tokens Unknown/);
		assert.match(environment.document.getElementById("status-context").textContent, /window 128k/);
		assert.match(environment.document.getElementById("status-context").textContent, /usage Unknown/);

		environment.setSnapshot({ revision: 3, pending: [], generation: 1, reloading: false, status: null });
		await environment.runNextTimer();
		assert.equal(environment.document.getElementById("status-cwd").textContent, "Unknown");
		assert.equal(environment.document.getElementById("status-branch").textContent, "Unknown");
		assert.equal(environment.document.getElementById("status-tokens").textContent, "Unknown");
		assert.match(environment.document.getElementById("status-context").textContent, /tokens Unknown/);
	});

	it("renders incremental chat messages without replacing the existing rows", async () => {
		const chat = {
			available: true,
			phase: "streaming",
			revision: 1,
			messages: [
				{ id: "entry-user", role: "user", text: "hello\nthere" },
				{ id: "live-assistant", role: "assistant", text: "partial" },
			],
		};
		const { environment } = await boot({ session: undefined });
		environment.setSnapshot({ revision: 2, pending: [], generation: 1, reloading: false, chat });
		await environment.runNextTimer();
		const history = environment.document.getElementById("chat-history");
		assert.equal(history.children.length, 2);
		assert.equal(history.children[1].querySelector(".chat-text").textContent, "partial");
		history.scrollTop = 17;

		environment.setSnapshot({
			revision: 3,
			pending: [],
			generation: 1,
			reloading: false,
			chat: { ...chat, revision: 2, phase: "idle", messages: [
				{ id: "entry-user", role: "user", text: "hello\nthere" },
				{ id: "entry-assistant", role: "assistant", text: "complete" },
			] },
		});
		await environment.runNextTimer();
		assert.equal(history.children.length, 2, "finalized stream reconciliation must not duplicate chat rows");
		assert.equal(history.children[1].querySelector(".chat-text").textContent, "complete");
		assert.equal(history.scrollTop, 17, "stream updates must not force-scroll a reader reviewing earlier history");
	});

	it("finalizes markdown streaming when the turn goes idle without a new message revision", async () => {
		const assistant = { id: "live-assistant", role: "assistant", revision: 7, text: "$E = mc^2$" };
		const { environment } = await boot({ session: undefined });
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 1,
			reloading: false,
			chat: { available: true, phase: "streaming", revision: 7, messages: [assistant] },
		});
		await environment.runNextTimer();
		const history = environment.document.getElementById("chat-history");
		assert.equal(history.children[0].dataset.markdownStreaming, "1");

		environment.setSnapshot({
			revision: 3,
			pending: [],
			generation: 1,
			reloading: false,
			chat: { available: true, phase: "idle", revision: 8, messages: [assistant] },
		});
		await environment.runNextTimer();
		assert.equal(history.children[0].dataset.markdownStreaming, "0", "idle must settle TeX even when the row revision is unchanged");
	});

	it("requests a fresh full chat snapshot after a generation change", async () => {
		const { environment, page } = await boot();
		const oldMessage = { id: "old-message", role: "user", revision: 4, text: "old generation" };
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 1,
			reloading: false,
			chat: { available: true, phase: "idle", revision: 4, messagesFull: true, historyIds: [oldMessage.id], messages: [oldMessage] },
		});
		await environment.runNextTimer();
		assert.equal(page.state.chatRevision, 4);

		const newMessage = { id: "new-message", role: "assistant", revision: 1, text: "new generation" };
		const replacement = {
			revision: 3,
			pending: [],
			generation: 2,
			reloading: false,
			chat: { available: true, phase: "idle", revision: 1, messagesFull: true, historyIds: [newMessage.id], messages: [newMessage] },
		};
		const originalFetch = environment.fetch;
		environment.fetch = async (path, options = {}) => {
			environment.fetchCalls.push({ path, options });
			if (path === "/api/state?since=4" || path === "/api/state") {
				return { ok: true, status: 200, json: async () => replacement };
			}
			return originalFetch(path, options);
		};
		globalThis.fetch = environment.fetch;
		await environment.runNextTimer();

		const stateCalls = environment.fetchCalls.filter((call) => call.path.startsWith("/api/state"));
		assert.equal(stateCalls.at(-2).path, "/api/state?since=4", "the first poll observes the old revision while discovering the new generation");
		assert.equal(stateCalls.at(-1).path, "/api/state", "the new generation must be fetched without the old since value");
		assert.deepEqual([...page.state.chatMessages.keys()], [newMessage.id]);
		assert.equal(page.state.chatMessages.has(oldMessage.id), false);
		assert.equal(environment.document.getElementById("chat-history").children[0].dataset.id, newMessage.id);
	});

	it("merges chat deltas, preserves unchanged card identity, prunes ids, and updates streams", async () => {
		const { environment, page } = await boot();
		const firstMessage = { id: "entry-one", role: "user", revision: 1, text: "one" };
		const secondMessage = { id: "live-two", role: "assistant", revision: 1, text: "partial" };
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 1,
			reloading: false,
			chat: {
				available: true,
				phase: "streaming",
				revision: 1,
				messagesFull: true,
				historyIds: [firstMessage.id, secondMessage.id],
				messages: [firstMessage, secondMessage],
			},
		});
		await environment.runNextTimer();
		const history = environment.document.getElementById("chat-history");
		const firstCard = history.children[0];
		const firstBlock = firstCard.querySelector(".chat-blocks").children[0];
		firstCard.dataset.marker = "keep-me";

		environment.setSnapshot({
			revision: 3,
			pending: [],
			generation: 1,
			reloading: false,
			chat: {
				available: true,
				phase: "streaming",
				revision: 1,
				messagesFull: false,
				historyIds: null,
				messages: [],
			},
		});
		await environment.runNextTimer();
		assert.equal(environment.fetchCalls.at(-1).path, "/api/state?since=1", "known chat revisions use the incremental state query");
		assert.equal(history.children[0], firstCard, "unchanged revisions must keep the card node");
		assert.equal(firstCard.dataset.marker, "keep-me", "unchanged cards must not be rebuilt");
		assert.equal(firstCard.querySelector(".chat-blocks").children[0], firstBlock, "unchanged blocks must keep identity");

		const updatedSecond = { ...secondMessage, revision: 2, text: "complete" };
		environment.setSnapshot({
			revision: 4,
			pending: [],
			generation: 1,
			reloading: false,
			chat: {
				available: true,
				phase: "streaming",
				revision: 2,
				messagesFull: false,
				historyIds: [firstMessage.id, secondMessage.id],
				messages: [updatedSecond],
			},
		});
		await environment.runNextTimer();
		assert.equal(history.children[0], firstCard);
		assert.equal(history.children[1].querySelector(".chat-text").textContent, "complete");
		assert.notEqual(history.children[1].querySelector(".chat-blocks").children[0], firstBlock);

		environment.setSnapshot({
			revision: 5,
			pending: [],
			generation: 1,
			reloading: false,
			chat: {
				available: true,
				phase: "streaming",
				revision: 3,
				messagesFull: false,
				historyIds: [secondMessage.id],
				messages: [],
			},
		});
		await environment.runNextTimer();
		assert.equal(history.children.length, 1, "historyIds must prune removed ids");
		assert.equal(history.children[0].dataset.id, secondMessage.id);
		assert.equal(page.state.chatMessages.size, 1, "delta pruning must also shrink the client message cache");
		assert.deepEqual([...page.state.chatMessages.keys()], [secondMessage.id]);
		assert.equal(page.state.chatMessages.has(firstMessage.id), false);

		const replacement = { id: "entry-three", role: "assistant", revision: 4, text: "replacement" };
		environment.setSnapshot({
			revision: 6,
			pending: [],
			generation: 1,
			reloading: false,
			chat: {
				available: true,
				phase: "idle",
				revision: 4,
				messagesFull: true,
				historyIds: [replacement.id],
				messages: [replacement],
			},
		});
		await environment.runNextTimer();
		assert.equal(history.children.length, 1, "a full snapshot must rebuild the cache");
		assert.equal(history.children[0].dataset.id, replacement.id);
	});

	it("renders asynchronous chat delivery failures and clears them after recovery", async () => {
		const { environment } = await boot();
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 1,
			reloading: false,
			chat: { available: true, phase: "streaming", revision: 1, messages: [], lastError: "message delivery failed after acceptance: host rejected it" },
		});
		await environment.runNextTimer();
		const status = environment.document.getElementById("chat-status");
		assert.equal(status.textContent, "message delivery failed after acceptance: host rejected it");
		assert.equal(status.dataset.state, "error");

		environment.setSnapshot({
			revision: 3,
			pending: [],
			generation: 1,
			reloading: false,
			chat: { available: true, phase: "idle", revision: 2, messages: [], lastError: null },
		});
		await environment.runNextTimer();
		assert.equal(status.textContent, "");
		assert.equal(status.dataset.state, "");
	});

	it("keeps a fresh acceptance message when polling clears an older delivery error", async () => {
		const { environment } = await boot();
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 1,
			reloading: false,
			chat: { available: true, phase: "idle", revision: 1, messages: [], lastError: "message delivery failed after acceptance: host rejected it" },
		});
		await environment.runNextTimer();

		const originalFetch = environment.fetch;
		environment.setSnapshot({
			revision: 3,
			pending: [],
			generation: 1,
			reloading: false,
			chat: { available: true, phase: "idle", revision: 2, messages: [], lastError: null },
		});
		environment.fetch = async (path, options = {}) => {
			environment.fetchCalls.push({ path, options });
			if (path === "/api/message") {
				return {
					ok: true,
					status: 200,
					json: async () => ({ ok: true, accepted: true, queued: false, delivery: "normal", requestedDelivery: "normal", execution: "pending", phase: "starting" }),
				};
			}
			return originalFetch(path, options);
		};
		globalThis.fetch = environment.fetch;
		environment.document.getElementById("chat-input").value = "accepted after recovery";
		environment.document.getElementById("chat-form").submit();
		await flushTasks();

		const status = environment.document.getElementById("chat-status");
		assert.match(status.textContent, /message accepted/i);
		assert.match(status.textContent, /execution has not completed/i);
		assert.equal(status.dataset.state, "ok");
	});

	it("renders immediate extension command acceptance separately from queued execution", async () => {
		const { environment } = await boot();
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 11,
			reloading: false,
			chat: { available: true, phase: "streaming", revision: 1, messages: [] },
		});
		await environment.runNextTimer();
		const originalFetch = environment.fetch;
		environment.fetch = async (path, options = {}) => {
			environment.fetchCalls.push({ path, options });
			if (path === "/api/message") {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						ok: true,
						accepted: true,
						queued: false,
						delivery: "steer",
						requestedDelivery: "steer",
						execution: "immediate",
						message: "extension slash command executed immediately; it is not part of the delivery queue",
						phase: "streaming",
					}),
				};
			}
			return originalFetch(path, options);
		};
		globalThis.fetch = environment.fetch;
		environment.document.getElementById("chat-input").value = "/extension-command now";
		environment.document.getElementById("chat-delivery").value = "steer";
		environment.document.getElementById("chat-form").submit();
		await flushTasks();
		const status = environment.document.getElementById("chat-status").textContent;
		assert.match(status, /executed immediately/i);
		assert.match(status, /not part of the delivery queue/i);
		assert.equal(/accepted and queued/i.test(status), false);
	});

	it("renders thinking and tool blocks with safe native folding defaults", async () => {
		const longOutput = "tool output ".repeat(150);
		const chat = {
			available: true,
			phase: "streaming",
			revision: 1,
			messages: [{
				id: "assistant-blocks",
				role: "assistant",
				blocks: [
					{ type: "thinking", text: "private reasoning" },
					{ type: "text", text: "visible response" },
					{ type: "toolCall", name: "read", arguments: "{\"path\":\"src/index.js\"}" },
					{ type: "toolResult", name: "read", content: longOutput, isError: false },
				],
				text: "visible response",
			}],
		};
		const { environment } = await boot();
		environment.setSnapshot({ revision: 2, pending: [], generation: 1, reloading: false, chat });
		await environment.runNextTimer();
		const card = environment.document.getElementById("chat-history").children[0];
		const details = card.querySelectorAll("details");
		assert.equal(details.length, 3, "thinking, tool call and tool result each get a collapsible block");
		assert.equal(details[0].open, false, "thinking is collapsed by default");
		assert.equal(details[1].open, false, "tool arguments are collapsed by default");
		assert.equal(details[2].open, false, "long tool output is collapsed by default");
		assert.equal(card.querySelector(".chat-text").textContent, "visible response");
		assert.match(details[0].querySelector("pre").textContent, /private reasoning/);
		assert.match(details[2].querySelector("pre").textContent, /tool output/);

		// A short tool result remains readable without opening a disclosure block.
		environment.setSnapshot({
			revision: 3,
			pending: [],
			generation: 1,
			reloading: false,
			chat: { ...chat, revision: 2, messages: [{
				id: "assistant-short",
				role: "assistant",
				text: "visible response",
				blocks: [
					{ type: "text", text: "visible response" },
					{ type: "toolResult", name: "read", content: "short output", isError: false },
				],
			}] },
		});
		await environment.runNextTimer();
		const shortCard = environment.document.getElementById("chat-history").children[0];
		assert.equal(shortCard.querySelectorAll("details")[0].open, true, "short tool output is readable by default");
	});

	it("maps busy steer/followUp selections and labels acceptance separately from execution", async () => {
		const { environment } = await boot();
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 6,
			reloading: false,
			chat: { available: true, phase: "streaming", revision: 1, messages: [] },
		});
		await environment.runNextTimer();
		const originalFetch = environment.fetch;
		environment.fetch = async (path, options = {}) => {
			environment.fetchCalls.push({ path, options });
			if (path === "/api/message") {
				const body = JSON.parse(options.body);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						ok: true,
						accepted: true,
						queued: true,
						delivery: body.delivery,
						requestedDelivery: body.delivery,
						execution: "pending",
						phase: "streaming",
					}),
				};
			}
			return originalFetch(path, options);
		};
		globalThis.fetch = environment.fetch;
		const input = environment.document.getElementById("chat-input");
		const delivery = environment.document.getElementById("chat-delivery");
		input.value = "steer this response";
		delivery.value = "steer";
		environment.document.getElementById("chat-form").submit();
		await flushTasks();
		input.value = "follow this response";
		delivery.value = "followUp";
		environment.document.getElementById("chat-form").submit();
		await flushTasks();
		const messageCalls = environment.fetchCalls.filter((call) => call.path === "/api/message");
		assert.deepEqual(messageCalls.map((call) => JSON.parse(call.options.body)), [
			{ generation: 6, text: "steer this response", delivery: "steer" },
			{ generation: 6, text: "follow this response", delivery: "followUp" },
		]);
		assert.match(environment.document.getElementById("chat-status").textContent, /accepted and queued/i);
		assert.match(environment.document.getElementById("chat-status").textContent, /not executed/i);
	});

	it("reports idle delivery normalization without claiming steer execution", async () => {
		const { environment } = await boot();
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 7,
			reloading: false,
			chat: { available: true, phase: "idle", revision: 1, messages: [] },
		});
		await environment.runNextTimer();
		const originalFetch = environment.fetch;
		environment.fetch = async (path, options = {}) => {
			environment.fetchCalls.push({ path, options });
			if (path === "/api/message") {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						ok: true,
						accepted: true,
						queued: false,
						delivery: "normal",
						requestedDelivery: "steer",
						normalized: true,
						execution: "pending",
						phase: "starting",
					}),
				};
			}
			return originalFetch(path, options);
		};
		globalThis.fetch = environment.fetch;
		environment.document.getElementById("chat-input").value = "idle steer";
		environment.document.getElementById("chat-delivery").value = "steer";
		environment.document.getElementById("chat-form").submit();
		await flushTasks();
		assert.match(environment.document.getElementById("chat-status").textContent, /immediate normal/i);
		assert.match(environment.document.getElementById("chat-status").textContent, /execution has not completed/i);
	});

	it("submits a multiline message only from the browser form and delegates stop", async () => {
		const { environment } = await boot();
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 5,
			reloading: false,
			chat: { available: true, phase: "idle", revision: 1, messages: [] },
		});
		await environment.runNextTimer();
		const input = environment.document.getElementById("chat-input");
		input.value = "first line\nsecond line";
		environment.document.getElementById("chat-form").submit();
		await flushTasks();
		const messageCall = environment.fetchCalls.find((call) => call.path === "/api/message");
		assert.ok(messageCall);
		assert.deepEqual(JSON.parse(messageCall.options.body), { generation: 5, text: "first line\nsecond line" });
		assert.equal(input.value, "", "accepted messages clear the composer");

		environment.setSnapshot({
			revision: 3,
			pending: [],
			generation: 5,
			reloading: false,
			chat: { available: true, phase: "streaming", revision: 2, messages: [] },
		});
		await environment.runNextTimer();
		environment.document.getElementById("chat-stop").click();
		await flushTasks();
		const stopCall = environment.fetchCalls.find((call) => call.path === "/api/stop");
		assert.ok(stopCall);
		assert.deepEqual(JSON.parse(stopCall.options.body), { generation: 5 });
	});

	it("does not submit while the current chat state reports a busy agent", async () => {
		const { environment } = await boot();
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 2,
			reloading: false,
			chat: { available: true, phase: "streaming", revision: 1, messages: [] },
		});
		await environment.runNextTimer();
		environment.document.getElementById("chat-input").value = "must not queue";
		environment.document.getElementById("chat-form").submit();
		await flushTasks();
		assert.equal(environment.fetchCalls.some((call) => call.path === "/api/message"), false);
		assert.match(environment.document.getElementById("chat-status").textContent, /busy|queued delivery/i);
	});

	it("shows a message rejection code and message without claiming acceptance", async () => {
		const { environment } = await boot();
		environment.setSnapshot({
			revision: 2,
			pending: [],
			generation: 8,
			reloading: false,
			chat: { available: true, phase: "idle", revision: 1, messages: [] },
		});
		await environment.runNextTimer();
		const originalFetch = environment.fetch;
		environment.fetch = async (path, options = {}) => {
			environment.fetchCalls.push({ path, options });
			if (path === "/api/message") {
				return {
					ok: false,
					status: 409,
					json: async () => ({ ok: false, error: { code: "unsupported_command", message: "not supported" } }),
				};
			}
			return originalFetch(path, options);
		};
		globalThis.fetch = environment.fetch;
		environment.document.getElementById("chat-input").value = "/model";
		environment.document.getElementById("chat-form").submit();
		await flushTasks();
		const status = environment.document.getElementById("chat-status").textContent;
		assert.match(status, /Message rejected \(unsupported_command\): not supported/);
		assert.equal(/accepted/i.test(status), false, "a rejected message must not be reported as accepted");
	});

	it("authenticates with the fragment token and renders every pending kind", async () => {
		const { environment } = await boot({ pending: Object.values(samples) });
		const stateCall = environment.fetchCalls.find((call) => call.path === "/api/state");
		assert.equal(stateCall.options.headers.Authorization, `Bearer ${"a".repeat(64)}`);
		assert.equal(environment.sessionStorage.getItem("pi-browser-ui-token"), "a".repeat(64));

		const cards = environment.document.getElementById("requests").children;
		assert.equal(cards.length, 5);
		const titles = cards.map((card) => card.querySelector(".card-title").textContent);
		assert.deepEqual(titles, ["Probe confirm", "Probe select", "Probe input", "Probe editor", "custom"]);
		// Host text with markup stays text and is never parsed as HTML.
		assert.equal(cards[0].querySelector(".card-message").textContent, "Confirm <script>alert(1)</script>?");
	});

	it("answers confirm explicitly (Yes / No / Cancel)", async () => {
		const { environment } = await boot({ pending: [samples.confirm] });
		const card = environment.document.getElementById("requests").children[0];
		const [yes, no] = card.querySelector(".card-form").children;
		assert.equal(yes.textContent, "Yes");
		assert.equal(no.textContent, "No");

		card.querySelector(".card-form").submit();
		await flushTasks();
		assert.deepEqual(JSON.parse(postCalls(environment)[0].options.body), { id: "id-confirm", action: "answer", value: true });
	});

	it("sends false only when the browser user presses No", async () => {
		const { environment } = await boot({ pending: [samples.confirm] });
		const card = environment.document.getElementById("requests").children[0];
		card.querySelector(".card-form").children[1].click();
		await flushTasks();
		assert.deepEqual(JSON.parse(postCalls(environment)[0].options.body), { id: "id-confirm", action: "answer", value: false });
	});

	it("requires an explicit selection before answering a select prompt", async () => {
		const { environment } = await boot({ pending: [samples.select] });
		const card = environment.document.getElementById("requests").children[0];
		const radios = card.querySelectorAll("input[type=radio]");
		assert.deepEqual(
			radios.map((radio) => radio.value),
			["Red", "Blue"],
		);
		card.querySelector(".card-form").submit();
		await flushTasks();
		assert.equal(postCalls(environment).length, 0, "an empty selection must not be submitted");
		assert.match(card.querySelector(".card-result").textContent, /Choose a value first/);

		radios[1].checked = true;
		card.querySelector(".card-form").submit();
		await flushTasks();
		assert.deepEqual(JSON.parse(postCalls(environment)[0].options.body), { id: "id-select", action: "answer", value: "Blue" });
	});

	it("answers input and editor prompts with the typed text", async () => {
		const { environment } = await boot({ pending: [samples.input, samples.editor] });
		const [inputCard, editorCard] = environment.document.getElementById("requests").children;
		const text = inputCard.querySelector("input[type=text]");
		assert.equal(text.placeholder, "type here");
		text.value = "typed from the browser";
		inputCard.querySelector(".card-form").submit();
		await flushTasks();

		const textarea = editorCard.querySelector("textarea");
		assert.equal(textarea.value, "prefilled line");
		textarea.value = "edited\nin the browser";
		editorCard.querySelector(".card-form").submit();
		await flushTasks();

		assert.deepEqual(
			postCalls(environment).map((call) => JSON.parse(call.options.body)),
			[
				{ id: "id-input", action: "answer", value: "typed from the browser" },
				{ id: "id-editor", action: "answer", value: "edited\nin the browser" },
			],
		);
	});

	it("cancels without approval and dismisses unsupported notices", async () => {
		const { environment } = await boot({ pending: [samples.select, samples.custom] });
		const [selectCard, customCard] = environment.document.getElementById("requests").children;
		selectCard.querySelector(".cancel").click();
		await flushTasks();
		assert.deepEqual(JSON.parse(postCalls(environment)[0].options.body), { id: "id-select", action: "cancel" });

		assert.equal(customCard.querySelector(".card-form"), null, "unsupported notices must have no answer controls");
		const dismiss = customCard.querySelector(".cancel");
		assert.equal(dismiss.textContent, "Dismiss notice");
		assert.match(customCard.querySelector(".card-message").textContent, /terminated without approval/);
		dismiss.click();
		await flushTasks();
		assert.deepEqual(JSON.parse(postCalls(environment)[1].options.body), { id: "id-custom", action: "dismiss" });
	});

	it("keeps a card and reports the error when the host rejects a reply", async () => {
		const { environment } = await boot({ pending: [samples.confirm] });
		const card = environment.document.getElementById("requests").children[0];
		environment.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: "already_resolved", message: "already resolved" } }) });
		globalThis.fetch = environment.fetch;
		card.querySelector(".card-form").submit();
		await flushTasks();
		assert.match(card.querySelector(".card-result").textContent, /already_resolved/);
		assert.equal(card.querySelector(".card-form").children[0].disabled, false, "controls must be re-enabled after a rejection");
	});

	it("requests a host reload without taking a new URL or token", async () => {
		const { environment } = await boot({ pending: [samples.confirm] });
		environment.setSnapshot({ revision: 2, pending: [], generation: 1, reloading: true });
		environment.document.getElementById("reload-form").submit();
		await flushTasks();

		const reloadCall = environment.fetchCalls.find((call) => call.path === "/api/reload");
		assert.ok(reloadCall, "the reload control must post to /api/reload");
		assert.equal(reloadCall.options.method, "POST");
		assert.equal(reloadCall.options.headers.Authorization, `Bearer ${"a".repeat(64)}`);
		assert.equal(environment.sessionStorage.getItem("pi-browser-ui-token"), "a".repeat(64), "the token must be kept for the same process");

		// The next poll observes the new generation and clears cards from the old one.
		await environment.runNextTimer();
		assert.equal(environment.document.getElementById("requests").children.length, 0, "stale cards must be dropped after reload");
		assert.match(environment.document.getElementById("connection").textContent, /reloading/i);
		assert.match(environment.document.getElementById("reload-state").textContent, /Reload accepted/);

		environment.setSnapshot({ revision: 3, pending: [], generation: 2, reloading: false });
		await environment.runNextTimer();
		assert.match(environment.document.getElementById("connection").textContent, /Reconnected after reload/);
		assert.match(environment.document.getElementById("reload-state").textContent, /Reloaded · browser generation 2/);
	});

	it("reports a refused reload without dropping the session", async () => {
		const { environment } = await boot({ pending: [samples.confirm] });
		globalThis.fetch = async (path, options) => {
			environment.fetchCalls.push({ path, options });
			return { ok: false, status: 409, json: async () => ({ ok: false, error: { code: "busy", message: "the session did not become idle" } }) };
		};
		environment.document.getElementById("reload-form").submit();
		await flushTasks();
		assert.match(environment.document.getElementById("reload-state").textContent, /Reload refused \(busy\)/);
		assert.equal(environment.document.getElementById("reload-button").disabled, false, "the control must be usable again");
	});

	it("shows attach_failed reloads as failures with the replacement binding reason", async () => {
		const { environment } = await boot({ pending: [samples.confirm] });
		globalThis.fetch = async (path, options) => {
			environment.fetchCalls.push({ path, options });
			return {
				ok: false,
				status: 503,
				json: async () => ({
					ok: false,
					error: { code: "attach_failed", message: "old binding detached; new instance rejected the host UI seam" },
				}),
			};
		};
		environment.document.getElementById("reload-form").submit();
		await flushTasks();
		const reloadState = environment.document.getElementById("reload-state");
		assert.match(reloadState.textContent, /Reload refused \(attach_failed\)/);
		assert.match(reloadState.textContent, /new instance rejected the host UI seam/);
		assert.equal(reloadState.dataset.state, "error");
		assert.equal(/nothing was changed/i.test(reloadState.textContent), false);
		assert.equal(environment.document.getElementById("reload-button").disabled, false, "the control must be usable again");
	});

	it("stops polling and asks for a new token after a 401", async () => {
		bust += 1;
		const environment = createFakeEnvironment({ token: "b".repeat(64) });
		environment.fetch = async (path, options) => {
			environment.fetchCalls.push({ path, options });
			return { ok: false, status: 401, json: async () => ({ ok: false, error: { code: "unauthorized", message: "invalid bearer token" } }) };
		};
		restoreGlobals = installPageGlobals(environment);
		await importPage({ bust: `unauthorized-${bust}` });
		await environment.runNextTimer();
		assert.match(environment.document.getElementById("connection").textContent, /Not authorized/);
		assert.equal(environment.document.getElementById("auth").classList.contains("hidden"), false);
		assert.match(environment.document.getElementById("auth-message").textContent, /Open the browser URL of the running Pi session/);
	});
});
