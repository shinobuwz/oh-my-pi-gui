/**
 * Test fixture: an SDK namespace without the `SessionManager` export, used to prove the
 * host fails closed when the installed host shape changes.
 */

export function createAgentSession() {
	return Promise.resolve({ session: null });
}
