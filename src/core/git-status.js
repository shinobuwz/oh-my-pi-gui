/**
 * Shared read-only session status (Git branch + usage totals) for the browser GUI.
 *
 * Moved verbatim from the removed private-seam adapter (`src/adapter/status-bridge.js`)
 * when that path was removed: `src/host/status.js` drives this implementation through a
 * read-only view over the public SDK `AgentSession`, so the Git argv/bounds, reason codes
 * and usage-aggregation semantics stay a single implementation with no second copy.
 *
 * The status implementation deliberately reads only public session data. Session usage is
 * aggregated from the active branch (with a compatibility fallback to the public all-entry
 * reader), while Git is queried asynchronously with fixed argv. No session content,
 * provider configuration, credentials, costs, or TUI footer data crosses this boundary.
 */

import { execFile as nodeExecFile } from "node:child_process";

export const STATUS_LIMITS = Object.freeze({
	maxCwdChars: 4096,
	maxBranchChars: 256,
	maxGitOutputBytes: 4096,
	gitTimeoutMs: 750,
	branchRefreshThrottleMs: 250,
});

const USAGE_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite"]);
const REFRESH_EVENTS = new Set([
	"agent_end",
	"agent_settled",
	"message_end",
	"model_select",
	"thinking_level_select",
	"session_compact",
	"session_tree",
]);

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNonNegative(value) {
	const number = finiteNumber(value);
	return number !== null && number >= 0 ? number : null;
}

function finitePositive(value) {
	const number = finiteNumber(value);
	return number !== null && number > 0 ? number : null;
}

function readProperty(value, key) {
	try {
		return value?.[key];
	} catch {
		return undefined;
	}
}

/** Bound a path or a Git label without allowing control characters into status text. */
export function boundStatusText(value, maxChars) {
	if (typeof value !== "string" || value.length === 0) {
		return null;
	}
	const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ");
	if (sanitized.length <= maxChars) {
		return sanitized;
	}
	if (maxChars <= 1) {
		return sanitized.slice(0, Math.max(0, maxChars));
	}
	return `${sanitized.slice(0, maxChars - 1)}…`;
}

function emptyTokenTotals() {
	return {
		input: null,
		output: null,
		cacheRead: null,
		cacheWrite: null,
		total: null,
	};
}

/**
 * Aggregate only documented usage-bearing session entries.
 *
 * Missing or malformed fields stay null. A real numeric zero is preserved as zero,
 * so an absent field can never be mistaken for a reported zero.
 */
export function aggregateUsageEntries(entries) {
	const totals = emptyTokenTotals();
	if (!Array.isArray(entries)) {
		return totals;
	}

	const sums = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
	const valid = Object.fromEntries(USAGE_FIELDS.map((field) => [field, false]));
	const overflowed = Object.fromEntries(USAGE_FIELDS.map((field) => [field, false]));
	let incomplete = false;
	for (const entry of entries) {
		let usage = null;
		try {
			if (entry?.type === "message") {
				const message = entry.message;
				if (message?.role === "assistant" || message?.role === "toolResult") {
					usage = message.usage;
				}
			} else if (entry?.type === "compaction" || entry?.type === "branch_summary") {
				usage = entry.usage;
			}
		} catch {
			usage = null;
		}
		if (!usage || typeof usage !== "object") {
			continue;
		}
		for (const field of USAGE_FIELDS) {
			const value = finiteNonNegative(readProperty(usage, field));
			if (value === null) {
				incomplete = true;
				continue;
			}
			if (overflowed[field]) {
				incomplete = true;
				continue;
			}
			const next = sums[field] + value;
			if (!Number.isFinite(next)) {
				// Do not emit Infinity after an overflowing sum. This field is unknown
				// rather than a fabricated or unsafe total.
				overflowed[field] = true;
				incomplete = true;
				continue;
			}
			sums[field] = next;
			valid[field] = true;
		}
	}

	let total = 0;
	let hasTotal = false;
	let totalOverflowed = false;
	for (const field of USAGE_FIELDS) {
		if (!valid[field] || overflowed[field]) {
			continue;
		}
		totals[field] = sums[field];
		const next = total + sums[field];
		if (!Number.isFinite(next)) {
			totalOverflowed = true;
			continue;
		}
		total = next;
		hasTotal = true;
	}
	const allFieldsValid = USAGE_FIELDS.every((field) => valid[field] && !overflowed[field]);
	if (hasTotal && !totalOverflowed && allFieldsValid && !incomplete) {
		totals.total = total;
	}
	return totals;
}

function readSessionEntries(sessionManager) {
	if (!sessionManager || typeof sessionManager !== "object") {
		return [];
	}

	let getBranch = null;
	try {
		getBranch = typeof sessionManager.getBranch === "function" ? sessionManager.getBranch.bind(sessionManager) : null;
	} catch {
		getBranch = null;
	}
	if (getBranch) {
		try {
			const branch = getBranch();
			if (Array.isArray(branch)) {
				return branch;
			}
		} catch {
			// A missing/broken public branch reader is the compatibility case for the
			// public all-entry reader below. No private session file access is attempted.
		}
	}

	let getEntries = null;
	try {
		getEntries = typeof sessionManager.getEntries === "function" ? sessionManager.getEntries.bind(sessionManager) : null;
	} catch {
		getEntries = null;
	}
	if (getEntries) {
		try {
			const entries = getEntries();
			if (Array.isArray(entries)) {
				return entries;
			}
		} catch {
			// Unknown usage is represented by null totals.
		}
	}
	return [];
}

function readContextUsage(ctx) {
	let reported;
	try {
		reported = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	} catch {
		reported = undefined;
	}

	const reportedObject = reported && typeof reported === "object" ? reported : null;
	const tokens = finiteNonNegative(readProperty(reportedObject, "tokens"));
	const percent = finiteNonNegative(readProperty(reportedObject, "percent"));
	const reportedWindow = finitePositive(readProperty(reportedObject, "contextWindow"));
	const model = readProperty(ctx, "model");
	const modelWindow = finitePositive(readProperty(model, "contextWindow"));
	const contextWindow = reportedWindow ?? modelWindow;

	if (!reportedObject && contextWindow === null) {
		return null;
	}
	return { tokens, contextWindow, percent };
}

function callbackResult(error, stdout) {
	return {
		error: error ?? null,
		stdout: typeof stdout === "string" || Buffer.isBuffer(stdout) ? stdout : "",
	};
}

function errorCode(error) {
	const code = error?.code;
	if (typeof code === "string" || typeof code === "number") {
		return code;
	}
	const status = error?.status;
	return typeof status === "string" || typeof status === "number" ? status : null;
}

function isExitCode(error, expected) {
	const code = errorCode(error);
	return code === expected || code === String(expected);
}

function isGitFailure(error) {
	const code = errorCode(error);
	return code === "ENOENT"
		|| code === "ETIMEDOUT"
		|| code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
		|| error?.killed === true
		|| error?.signal === "SIGTERM";
}

function failureReason(error) {
	const code = errorCode(error);
	if (code === "ENOENT") {
		return "git_unavailable";
	}
	if (code === "ETIMEDOUT" || error?.killed === true || error?.signal === "SIGTERM") {
		return "git_timeout";
	}
	if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
		return "git_output_limit";
	}
	if (isExitCode(error, 128)) {
		return "not_repo";
	}
	return "git_error";
}

function outputText(value) {
	if (typeof value === "string") {
		return value;
	}
	if (Buffer.isBuffer(value)) {
		return value.toString("utf8");
	}
	return "";
}

function parseGitLabel(value) {
	const raw = outputText(value);
	const firstLine = raw.split(/\r?\n/, 1)[0].trim();
	if (!firstLine || /[\u0000-\u001f\u007f]/.test(firstLine)) {
		return null;
	}
	return boundStatusText(firstLine, STATUS_LIMITS.maxBranchChars);
}

function sameGitState(left, right) {
	return left?.branch === right?.branch && left?.reason === right?.reason;
}

/**
 * Generation-scoped status bridge. Git refreshes are asynchronous and throttled;
 * all other values are read-only snapshots of the active source.
 */
export class StatusBridge {
	#ctx;
	#generation;
	#logger;
	#execFile;
	#active = true;
	#revision = 0;
	#git = { branch: null, reason: "refreshing" };
	#refreshTimer = null;
	#refreshInFlight = null;
	#refreshPending = false;
	#gitChild = null;
	#refreshThrottleMs;

	constructor({ ctx, generation, logger = () => {}, execFile = nodeExecFile, refreshThrottleMs = STATUS_LIMITS.branchRefreshThrottleMs }) {
		if (!ctx) {
			throw new Error("StatusBridge requires a current extension context");
		}
		if (typeof execFile !== "function") {
			throw new Error("StatusBridge requires an execFile-style Git runner");
		}
		this.#ctx = ctx;
		this.#generation = generation;
		this.#logger = logger;
		this.#execFile = execFile;
		this.#refreshThrottleMs = Number.isFinite(refreshThrottleMs) && refreshThrottleMs >= 0
			? refreshThrottleMs
			: STATUS_LIMITS.branchRefreshThrottleMs;
		// Binding starts one asynchronous Git refresh. The returned promise is kept
		// internally so an explicit refresh can join it without spawning a second call.
		void this.refresh();
	}

	get generation() {
		return this.#generation;
	}

	/** Refresh Git immediately; status values themselves remain read-only. */
	refresh() {
		if (!this.#active) {
			return Promise.resolve(this.snapshot());
		}
		if (this.#refreshInFlight) {
			return this.#refreshInFlight;
		}
		let promise;
		promise = this.#refreshGit().finally(() => {
			if (this.#refreshInFlight === promise) {
				this.#refreshInFlight = null;
			}
			if (this.#refreshPending && this.#active) {
				this.#refreshPending = false;
				this.#scheduleRefresh();
			}
		});
		this.#refreshInFlight = promise;
		return promise;
	}

	/** Alias used by internal callers that want to make the Git operation explicit. */
	refreshBranch() {
		return this.refresh();
	}

	handle(event, ctx = this.#ctx) {
		if (!this.#active || !event || typeof event.type !== "string") {
			return;
		}
		if (ctx) {
			this.#ctx = ctx;
		}
		if (!REFRESH_EVENTS.has(event.type)) {
			return;
		}
		this.#revision += 1;
		this.#scheduleRefresh();
	}

	snapshot() {
		if (!this.#active || !this.#ctx) {
			return {
				available: false,
				cwd: null,
				git: { branch: null, reason: "disposed" },
				tokens: emptyTokenTotals(),
				contextUsage: null,
				revision: this.#revision,
			};
		}

		const cwd = boundStatusText(readProperty(this.#ctx, "cwd"), STATUS_LIMITS.maxCwdChars);
		const entries = readSessionEntries(readProperty(this.#ctx, "sessionManager"));
		return {
			available: true,
			cwd,
			git: { ...this.#git },
			tokens: aggregateUsageEntries(entries),
			contextUsage: readContextUsage(this.#ctx),
			revision: this.#revision,
		};
	}

	dispose() {
		if (!this.#active) {
			return;
		}
		this.#active = false;
		if (this.#refreshTimer) {
			clearTimeout(this.#refreshTimer);
			this.#refreshTimer = null;
		}
		this.#refreshPending = false;
		try {
			this.#gitChild?.kill?.();
		} catch {
			// Best-effort cancellation; the callback is ignored after disposal.
		}
		this.#gitChild = null;
		this.#ctx = null;
		this.#execFile = null;
		this.#logger = () => {};
		this.#git = { branch: null, reason: "disposed" };
	}

	#scheduleRefresh() {
		if (!this.#active) {
			return;
		}
		if (this.#refreshInFlight) {
			this.#refreshPending = true;
			return;
		}
		if (this.#refreshTimer) {
			return;
		}
		this.#refreshTimer = setTimeout(() => {
			this.#refreshTimer = null;
			void this.refresh();
		}, this.#refreshThrottleMs);
		this.#refreshTimer?.unref?.();
	}

	async #refreshGit() {
		const rawCwd = readProperty(this.#ctx, "cwd");
		const cwd = typeof rawCwd === "string" && rawCwd.length > 0 ? rawCwd : null;
		let next;
		if (!cwd) {
			next = { branch: null, reason: "cwd_unavailable" };
		} else {
			next = await this.#resolveGit(cwd);
		}
		if (!this.#active) {
			return this.snapshot();
		}
		if (!sameGitState(this.#git, next)) {
			this.#git = next;
			this.#revision += 1;
		}
		return this.snapshot();
	}

	async #resolveGit(cwd) {
		const symbolic = await this.#runGit(cwd, ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"]);
		if (!symbolic.error) {
			const branch = parseGitLabel(symbolic.stdout);
			if (branch) {
				return { branch, reason: null };
			}
		}
		if (symbolic.error && isGitFailure(symbolic.error)) {
			return { branch: null, reason: failureReason(symbolic.error) };
		}

		// Symbolic-ref exits nonzero for detached HEAD. The fixed second command is
		// still read-only and gives a bounded label without exposing command errors.
		const detached = await this.#runGit(cwd, ["--no-optional-locks", "rev-parse", "--short", "HEAD"]);
		if (!detached.error) {
			const label = parseGitLabel(detached.stdout);
			if (label) {
				return { branch: label, reason: "detached_head" };
			}
			return { branch: null, reason: "invalid_output" };
		}
		const reason = failureReason(detached.error);
		this.#logger(`Git status unavailable (${reason})`);
		return { branch: null, reason };
	}

	#runGit(cwd, args) {
		return new Promise((resolve) => {
			let child = null;
			let settled = false;
			const finish = (error, stdout, stderr) => {
				if (settled) {
					return;
				}
				settled = true;
				if (this.#gitChild === child) {
					this.#gitChild = null;
				}
				resolve(callbackResult(error, stdout));
			};
			const options = {
				cwd,
				encoding: "utf8",
				timeout: STATUS_LIMITS.gitTimeoutMs,
				maxBuffer: STATUS_LIMITS.maxGitOutputBytes,
				windowsHide: true,
				shell: false,
			};
			try {
				const runner = this.#execFile;
				if (typeof runner !== "function") {
					finish(Object.assign(new Error("Git runner unavailable"), { code: "ENOENT" }));
					return;
				}
				child = runner("git", args, options, finish);
				if (child && typeof child.then === "function") {
					child.then(
						(result) => finish(null, result?.stdout ?? result ?? "", result?.stderr ?? ""),
						(error) => finish(error),
					);
				} else if (child && typeof child.stdout === "string" && !child.once) {
					// Promise-style test doubles sometimes return a result synchronously.
					queueMicrotask(() => finish(null, child.stdout, child.stderr));
				}
				if (!settled && child && typeof child.kill === "function") {
					this.#gitChild = child;
				}
			} catch (error) {
				finish(error);
			}
		});
	}
}

export { emptyTokenTotals, finiteNonNegative, finiteNumber, readSessionEntries, readContextUsage };
