/**
 * Minimal DOM/global environment used to exercise `src/browser/app.js` in Node.
 *
 * It is deliberately strict where it matters for security: assigning `innerHTML`
 * throws, so a regression that switches from `textContent` to HTML parsing fails the
 * page test instead of only failing in review.
 */

const realSetTimeout = setTimeout;

/** Wait for queued microtasks/promises using the real timer (tests replace setTimeout). */
export function flushTasks() {
	return new Promise((resolve) => realSetTimeout(resolve, 0));
}

class FakeClassList {
	constructor() {
		this.classes = new Set();
	}
	add(...names) {
		for (const name of names) {
			this.classes.add(name);
		}
	}
	remove(...names) {
		for (const name of names) {
			this.classes.delete(name);
		}
	}
	contains(name) {
		return this.classes.has(name);
	}
	toggle(name, force) {
		const enabled = force === undefined ? !this.classes.has(name) : Boolean(force);
		if (enabled) {
			this.classes.add(name);
		} else {
			this.classes.delete(name);
		}
		return enabled;
	}
	toString() {
		return [...this.classes].join(" ");
	}
}

function matchSimple(element, selector) {
	const checkedMatch = /:checked$/.test(selector);
	const base = selector.replace(/:checked$/, "");
	const attributeMatch = /\[([^=\]]+)(?:=([^\]]*))?\]/.exec(base);
	const tagAndClass = base.replace(/\[[^\]]*\]/, "");
	const tag = /^[a-zA-Z]+/.exec(tagAndClass)?.[0] ?? null;
	const classes = [...tagAndClass.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
	if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) {
		return false;
	}
	if (!classes.every((name) => element.classList.contains(name))) {
		return false;
	}
	if (attributeMatch) {
		const [, name, value] = attributeMatch;
		if (element[name] === undefined) {
			return false;
		}
		if (value !== undefined && String(element[name]) !== value) {
			return false;
		}
	}
	if (checkedMatch && element.checked !== true) {
		return false;
	}
	return true;
}

export class FakeElement {
	constructor(tagName = "div") {
		this.tagName = tagName.toUpperCase();
		this.children = [];
		this.parent = null;
		this.dataset = {};
		this.classList = new FakeClassList();
		this.listeners = new Map();
		this.attributes = {};
		this.value = "";
		this.checked = false;
		this.disabled = false;
		this.required = false;
		this.type = undefined;
		this.name = undefined;
		this.placeholder = undefined;
		this.maxLength = undefined;
		this._text = "";
	}

	set className(value) {
		this.attributes.class = value ?? "";
		this.classList = new FakeClassList();
		this.classList.add(...String(value ?? "").split(/\s+/).filter(Boolean));
	}

	get className() {
		return this.classList.toString();
	}

	set innerHTML(_value) {
		throw new Error("the page must render host data with textContent, not innerHTML");
	}

	set textContent(value) {
		this._text = String(value ?? "");
		this.children = [];
	}

	get textContent() {
		if (this.children.length === 0) {
			return this._text;
		}
		return this.children.map((child) => child.textContent).join("");
	}

	append(...nodes) {
		for (const node of nodes) {
			if (node.parent) {
				node.parent.children = node.parent.children.filter((child) => child !== node);
			}
			node.parent = this;
			this.children.push(node);
		}
	}

	insertBefore(node, reference) {
		if (node.parent) {
			node.parent.children = node.parent.children.filter((child) => child !== node);
		}
		node.parent = this;
		if (!reference) {
			this.children.push(node);
			return;
		}
		const index = this.children.indexOf(reference);
		if (index === -1) {
			this.children.push(node);
		} else {
			this.children.splice(index, 0, node);
		}
	}

	prepend(...nodes) {
		for (const node of [...nodes].reverse()) {
			node.parent = this;
			this.children.unshift(node);
		}
	}

	remove() {
		if (this.parent) {
			this.parent.children = this.parent.children.filter((child) => child !== this);
			this.parent = null;
		}
	}

	cloneNode() {
		const copy = new FakeElement(this.tagName);
		copy.attributes = { ...this.attributes };
		copy.classList = new FakeClassList();
		for (const name of this.classList.classes) {
			copy.classList.add(name);
		}
		copy.dataset = { ...this.dataset };
		copy.type = this.type;
		copy.name = this.name;
		copy.placeholder = this.placeholder;
		copy.maxLength = this.maxLength;
		copy.required = this.required;
		copy.value = this.value;
		copy._text = this._text;
		for (const child of this.children) {
			copy.append(child.cloneNode(true));
		}
		return copy;
	}

	querySelectorAll(selector) {
		const results = [];
		const visit = (node) => {
			for (const child of node.children) {
				if (matchSimple(child, selector)) {
					results.push(child);
				}
				visit(child);
			}
		};
		visit(this);
		return results;
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	addEventListener(type, handler) {
		const list = this.listeners.get(type) ?? [];
		list.push(handler);
		this.listeners.set(type, list);
	}

	/** Test helper: dispatch an event and return the handlers' results. */
	dispatch(type) {
		const event = { type, preventDefault() {}, stopPropagation() {} };
		return (this.listeners.get(type) ?? []).map((handler) => handler(event));
	}

	click() {
		return this.dispatch("click");
	}

	submit() {
		return this.dispatch("submit");
	}
}

/** Build the fake document from the real index.html markup (ids/classes stay in sync). */
export function createFakeEnvironment({ token = null } = {}) {
	const byId = new Map();
	const elements = [];
	const document = {
		getElementById(id) {
			if (!byId.has(id)) {
				const element = new FakeElement("div");
				element.id = id;
				byId.set(id, element);
			}
			return byId.get(id);
		},
		createElement(tagName) {
			const element = new FakeElement(tagName);
			elements.push(element);
			return element;
		},
	};
	// The page reads a <template id="card-template"> whose content is cloned per card.
	const template = document.getElementById("card-template");
	const content = new FakeElement("template-content");
	const card = new FakeElement("article");
	card.classList.add("card");
	const title = new FakeElement("h2");
	title.classList.add("card-title");
	const message = new FakeElement("p");
	message.classList.add("card-message");
	const meta = new FakeElement("p");
	meta.classList.add("card-meta");
	const form = new FakeElement("form");
	form.classList.add("card-form");
	const actions = new FakeElement("div");
	actions.classList.add("card-actions");
	const cancel = new FakeElement("button");
	cancel.classList.add("cancel");
	cancel.type = "button";
	actions.append(cancel);
	const result = new FakeElement("p");
	result.classList.add("card-result");
	card.append(title, message, meta, form, actions, result);
	content.append(card);
	template.content = content;

	const location = {
		hash: token ? `#t=${token}` : "",
		pathname: "/",
		search: "",
	};
	const storage = new Map();
	const sessionStorage = {
		getItem: (key) => storage.get(key) ?? null,
		setItem: (key, value) => storage.set(key, String(value)),
	};
	const fetchCalls = [];
	let snapshot = { revision: 0, pending: [] };
	const fetch = async (path, options = {}) => {
		fetchCalls.push({ path, options });
		return {
			ok: true,
			status: 200,
			json: async () => snapshot,
		};
	};
	const timers = [];
	const setTimeout = (handler, delay) => {
		timers.push({ handler, delay });
		return timers.length;
	};

	const window = { location };
	return {
		document,
		location,
		sessionStorage,
		fetch,
		fetchCalls,
		timers,
		window,
		history: { replaceState: () => {} },
		setSnapshot(next) {
			snapshot = next;
		},
		/** Run the next scheduled poll callback and wait for its async work. */
		async runNextTimer() {
			const timer = timers.shift();
			if (!timer) {
				throw new Error("no scheduled page timer to run");
			}
			await timer.handler();
			await flushTasks();
		},
	};
}

const PAGE_GLOBALS = ["document", "location", "sessionStorage", "fetch", "history", "window"];

/**
 * Install the fake browser globals for a test. Returns a restore function.
 * `setTimeout` is replaced by a recorder so the page's poll loop never runs on its own.
 */
export function installPageGlobals(environment) {
	const previous = new Map();
	for (const key of [...PAGE_GLOBALS, "setTimeout", "clearTimeout"]) {
		previous.set(key, globalThis[key]);
	}
	globalThis.document = environment.document;
	globalThis.location = environment.location;
	globalThis.sessionStorage = environment.sessionStorage;
	globalThis.fetch = environment.fetch;
	globalThis.history = environment.history;
	globalThis.window = environment.window;
	globalThis.setTimeout = (handler, delay) => {
		environment.timers.push({ handler, delay });
		return environment.timers.length;
	};
	globalThis.clearTimeout = () => {};
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete globalThis[key];
			} else {
				globalThis[key] = value;
			}
		}
	};
}

/** Import a fresh copy of the page module (query string busts the ESM cache). */
export async function importPage({ bust = "1" } = {}) {
	return import(`../../src/browser/app.js?fake-dom=${bust}`);
}

export { FakeElement as Element };
