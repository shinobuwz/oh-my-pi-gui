/**
 * Bounded reader for the *child* session of one pi-subagents run.
 *
 * Why this exists: pi-subagents exposes two read-only views, and both are previews — the
 * inspect command sends no thinking and clips every message to 1000 chars, its transcript
 * view flattens events into text lines. The child's own Pi session file keeps the whole
 * thing (every tool call with its arguments, every result and every thinking block), so the
 * host reads that file directly instead of asking the extension for a summary of it.
 *
 * Boundaries, all of them deliberate:
 *
 * - **No path ever crosses the wire.** The browser names a run id and a child index; the
 *   path is derived here from the parent session file, and the id must be a UUID while the
 *   index must be a small non-negative integer, so no input can reach outside
 *   `<parent session dir>/<parent session id>/<runId>/run-<index>/session.jsonl` — the same
 *   root pi-subagents derives from the parent `.jsonl` file.
 * - **Bounded.** At most `maxBytes` of the file tail and `maxRecords` projected records are
 *   held, and one page is at most `maxLimit` records. A multi-megabyte child session is
 *   therefore streamed, not loaded.
 * - **Host-only projection.** Records are re-projected with the same pure helpers the chat
 *   view uses (`serializeMessage`) and never handed over raw: no session metadata, no cwd, no
 *   session file path, no `subagentRunId` (the inspector has no allowlisted id for a
 *   grandchild run, so it must not offer that affordance).
 * - **Fail closed.** A missing file, an unreadable file, a non-regular file or an unknown
 *   layout is reported as its own reason; nothing is guessed and no directory is scanned.
 */

import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";

import { CHAT_LIMITS, serializeMessage } from "./chat-messages.js";
import { isRecord, redactPathTokens, redactSecretText, redactSensitivePathFields } from "./redaction.js";

export const SUBAGENT_SESSION_LIMITS = Object.freeze({
	/** Bytes of the child session tail that may be read (and re-read) for one page. */
	maxFileBytes: 8 * 1024 * 1024,
	/** Projected records kept from that window. */
	maxRecords: 2000,
	/** Records returned by one page. */
	defaultLimit: 40,
	maxLimit: 200,
	/** Longest child index we accept (parallel/chain runs are small in practice). */
	maxChildIndex: 64,
});

/** pi-subagents names child directories after the run id, which is always a UUID. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derive the child session file of one run without ever trusting a caller-provided path.
 *
 * @param {{ parentSessionFile?: string|null, runId?: unknown, index?: unknown }} input
 * @returns {{ ok: true, path: string } | { ok: false, code: string, message: string }}
 */
export function childSessionPath({ parentSessionFile, runId, index = 0 } = {}) {
	if (typeof parentSessionFile !== "string" || parentSessionFile.length === 0) {
		return { ok: false, code: "no_session_file", message: "the host does not know the parent session file, so no child session can be derived" };
	}
	if (typeof runId !== "string" || !RUN_ID.test(runId)) {
		return { ok: false, code: "invalid_run_id", message: "a child session is only addressed by the UUID of its run" };
	}
	if (!Number.isSafeInteger(index) || index < 0 || index > SUBAGENT_SESSION_LIMITS.maxChildIndex) {
		return { ok: false, code: "invalid_index", message: `a child index must be an integer between 0 and ${SUBAGENT_SESSION_LIMITS.maxChildIndex}` };
	}
	const parentPath = resolve(parentSessionFile);
	try {
		const checked = lstatWithoutSymlinks(parentPath);
		if (!checked.ok || !checked.stats.isFile()) {
			return { ok: false, code: "no_session_file", message: "the host parent session is not a regular file, so no child session can be derived" };
		}
	} catch {
		return { ok: false, code: "no_session_file", message: "the host parent session file is unavailable, so no child session can be derived" };
	}
	const parentName = basename(parentPath);
	if (!parentName.endsWith(".jsonl") || parentName.length <= ".jsonl".length) {
		return { ok: false, code: "no_session_file", message: "the host session file does not have Pi's expected .jsonl layout, so no child session can be derived" };
	}
	// Pi's getSubagentSessionRoot() inserts the parent session basename (without .jsonl)
	// between the sessions directory and the run id. Do not collapse this level: doing so
	// would read a different file in a shared sessions directory.
	const parentSessionRoot = join(dirname(parentPath), parentName.slice(0, -".jsonl".length));
	return { ok: true, path: join(parentSessionRoot, runId, `run-${index}`, "session.jsonl") };
}

/**
 * Return the lstat result for a path only when every component is a real directory/file.
 * A valid symlink (including a symlinked run directory) is deliberately refused: otherwise
 * a writer could replace an allowlisted child path with a link to an unrelated host file.
 */
function lstatWithoutSymlinks(path) {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
	let current = root;
	for (const part of parts) {
		current = join(current, part);
		const stats = lstatSync(current);
		if (stats.isSymbolicLink()) {
			return { ok: false, code: "not_found", message: "the derived child session path contains a symbolic link" };
		}
	}
	return { ok: true, stats: lstatSync(absolute) };
}

/** Read at most `maxBytes` from the end of one regular file. */
function readTail(path, maxBytes) {
	let checked;
	try {
		checked = lstatWithoutSymlinks(path);
	} catch {
		return { ok: false, code: "not_found", message: "this run has no child session file on disk any more" };
	}
	if (!checked.ok) return checked;
	const stats = checked.stats;
	if (!stats.isFile() || stats.isSymbolicLink()) {
		return { ok: false, code: "not_found", message: "the derived child session path is not a regular file" };
	}
	const bytes = Math.min(stats.size, maxBytes);
	const start = Math.max(0, stats.size - bytes);
	let handle = null;
	try {
		handle = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(bytes);
		let read = 0;
		while (read < bytes) {
			const chunk = readSync(handle, buffer, read, bytes - read, start + read);
			if (chunk <= 0) break;
			read += chunk;
		}
		return { ok: true, text: buffer.subarray(0, read).toString("utf8"), truncatedHead: start > 0, bytes: read };
	} catch {
		return { ok: false, code: "unreadable", message: "the child session file could not be read" };
	} finally {
		if (handle !== null) {
			try { closeSync(handle); } catch { /* best effort */ }
		}
	}
}

/**
 * Project one parsed session record. Only `message` records carry conversation content, and
 * only the three chat roles are projected; everything else counts as skipped so the page can
 * say how much of the file it did not show.
 */
function projectRecord(record, index) {
	if (!isRecord(record) || record.type !== "message" || !isRecord(record.message)) {
		return null;
	}
	const projected = serializeMessage(record.message, typeof record.id === "string" ? record.id : `child-record-${index}`, null, record.timestamp);
	if (!projected) {
		return null;
	}
	const message = {
		id: projected.id,
		kind: projected.kind,
		role: projected.role,
		text: projected.text,
		blocks: Array.isArray(projected.blocks) ? projected.blocks : [],
		timestamp: projected.timestamp ?? null,
	};
	if (typeof projected.toolName === "string") message.toolName = projected.toolName;
	if (projected.isError === true) message.isError = true;
	if (typeof projected.stopReason === "string") message.stopReason = projected.stopReason;
	return message;
}

/** Credential and host-path shapes are redacted per message text/block; relative project paths stay. */
function redactMessage(message) {
	const redact = (value) => (typeof value === "string" && value.length > 0
		? redactPathTokens(redactSensitivePathFields(redactSecretText(value)))
		: value);
	const blocks = [];
	for (const block of message.blocks.slice(0, CHAT_LIMITS.maxBlocksPerMessage)) {
		if (!isRecord(block)) continue;
		const { subagentRunId: _nestedRunId, ...next } = block;
		for (const field of ["text", "content", "arguments", "error"]) {
			if (typeof next[field] === "string") next[field] = redact(next[field]);
		}
		blocks.push(next);
	}
	return { ...message, text: redact(message.text) ?? "", blocks };
}

/**
 * Read one page of a child session, newest page first.
 *
 * @param {{ path: string, before?: unknown, limit?: unknown, maxBytes?: unknown }} input
 *   `before` is the cursor a previous page returned (records newer than it were already
 *   sent), so paging walks backwards through the file without renumbering anything, and
 *   `maxBytes` may only shrink the window, never grow it.
 * @returns {{ ok: true, messages: object[], earlier: boolean, cursor: number|null, window: object } | { ok: false, code: string, message: string }}
 */
export function readChildSessionPage({ path, before = null, limit = SUBAGENT_SESSION_LIMITS.defaultLimit, maxBytes = SUBAGENT_SESSION_LIMITS.maxFileBytes } = {}) {
	const pageSize = Number.isSafeInteger(limit) && limit > 0
		? Math.min(limit, SUBAGENT_SESSION_LIMITS.maxLimit)
		: SUBAGENT_SESSION_LIMITS.defaultLimit;
	// A caller may only ever ask for a *smaller* window than the documented bound.
	const windowBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0
		? Math.min(Math.max(maxBytes, 1024), SUBAGENT_SESSION_LIMITS.maxFileBytes)
		: SUBAGENT_SESSION_LIMITS.maxFileBytes;
	const tail = readTail(path, windowBytes);
	if (!tail.ok) return tail;

	const lines = tail.text.split(/\r?\n/);
	// A slice that does not start at byte 0 starts mid-record: drop that partial line.
	if (tail.truncatedHead && lines.length > 0) lines.shift();
	const records = [];
	let skipped = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			skipped += 1;
			continue;
		}
		const message = projectRecord(parsed, records.length);
		if (message) records.push(redactMessage(message));
		else skipped += 1;
	}
	// Keep the newest `maxRecords` of the window so the cursor stays stable for a long file.
	if (records.length > SUBAGENT_SESSION_LIMITS.maxRecords) {
		skipped += records.length - SUBAGENT_SESSION_LIMITS.maxRecords;
		records.splice(0, records.length - SUBAGENT_SESSION_LIMITS.maxRecords);
	}

	const end = typeof before === "number" && Number.isSafeInteger(before) && before > 0
		? Math.min(before, records.length)
		: records.length;
	const start = Math.max(0, end - pageSize);
	return {
		ok: true,
		messages: records.slice(start, end),
		earlier: start > 0,
		cursor: start > 0 ? start : null,
		window: {
			fileBytes: tail.bytes,
			truncatedHead: tail.truncatedHead,
			records: records.length,
			skipped,
			limit: pageSize,
		},
	};
}
