/**
 * Static security guards for the local browser page.
 *
 * These are contract checks, not prose checks: they protect the "no dynamic HTML,
 * no external resources, explicit submissions only" behaviour that the HTTP tests
 * cannot observe without a real browser.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const browserDir = fileURLToPath(new URL("../src/browser/", import.meta.url));
const appJs = readFileSync(`${browserDir}app.js`, "utf8");
const indexHtml = readFileSync(`${browserDir}index.html`, "utf8");
const appCss = readFileSync(`${browserDir}app.css`, "utf8");

describe("browser page security guards", () => {
	it("never assigns host-provided data as HTML", () => {
		const forbiddenSinks = [
			/\.innerHTML\b/,
			/\binnerHTML\s*=/,
			/\.outerHTML\b/,
			/insertAdjacentHTML\s*\(/,
			/document\.write\s*\(/,
			/(?:^|[^\w.])eval\s*\(/m,
			/new\s+Function\s*\(/,
		];
		for (const pattern of forbiddenSinks) {
			assert.equal(pattern.test(appJs), false, `app.js must not use ${pattern}`);
		}
		assert.equal(appJs.includes("textContent"), true, "app.js must render values with textContent");
		assert.equal(indexHtml.includes("template"), true, "index.html must render cards from a static template");
		assert.equal(indexHtml.includes("<pre>"), false);
	});

	it("loads only same-origin local resources", () => {
		const combined = `${appJs}\n${indexHtml}\n${appCss}`;
		assert.equal(/https?:\/\/(?!127\.0\.0\.1)/.test(combined), false, "no external origins may be referenced");
		assert.equal(combined.includes("cdn"), false);
		assert.equal(indexHtml.includes('<script src="/app.js"'), true);
		assert.equal(indexHtml.includes('<link rel="stylesheet" href="/app.css"'), true);
	});

	it("uses the URL fragment token and an Authorization header", () => {
		assert.match(appJs, /location\.hash/);
		assert.match(appJs, /sessionStorage\.setItem/);
		assert.match(appJs, /Authorization = `Bearer \$\{state\.token\}`/);
		assert.equal(appJs.includes("replaceState"), true, "the token must be stripped from the visible URL");
	});

	it("posts only to the loopback API paths and only on explicit user action", () => {
		assert.match(appJs, /fetch\(path, /);
		assert.match(appJs, /"\/api\/state"/);
		assert.match(appJs, /"\/api\/answer"/);
		assert.match(appJs, /"\/api\/reload"/);
		assert.match(appJs, /"\/api\/message"/);
		assert.match(appJs, /"\/api\/stop"/);
		assert.match(appJs, /"\/api\/model"/);
		assert.match(appJs, /"\/api\/thinking"/);
		assert.match(appJs, /sendUserMessage|chatSending/);
		assert.match(appJs, /addEventListener\("submit"/);
		assert.match(appJs, /"cancel"\)/);
		assert.equal(/\.then\(\(\) => submit\(/.test(appJs), false, "answers must never be submitted implicitly");
		assert.equal(/location\.reload\(/.test(appJs), false, "a session reload must go through the host API, not a page reload");
		assert.equal(/window\.prompt\(|new URL\(/.test(appJs), false, "the page must never ask the user for a new session URL");
	});
});
