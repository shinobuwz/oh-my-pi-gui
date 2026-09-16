/**
 * Test fixture: an SDK-shaped module used by the host tests.
 *
 * `test/helpers/fake-sdk.js` builds a recording fake; this module exposes one instance
 * through the module-level `state` object so tests can import it with the same URL the
 * host loader uses (`PI_GUI_SDK_PATH` → absolute path → dynamic import) and still read
 * back what the host called. It intentionally mimics only the public surface the host
 * uses: `createAgentSession` and `SessionManager.create`.
 */

import { createFakeSdk } from "../helpers/fake-sdk.js";

const fake = createFakeSdk();

export const state = fake;
export const createAgentSession = fake.sdk.createAgentSession;
export const SessionManager = fake.sdk.SessionManager;
