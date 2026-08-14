/**
 * Talking to the server, and the one distinction that matters while doing it.
 *
 * **"Not signed in" is not an error.** It is the ordinary state of a browser that has just
 * been opened, and rendering it as a red box saying something failed would be both wrong and
 * alarming. Every call here returns one of three outcomes — a value, a sign-in prompt, or a
 * real failure — so a caller cannot accidentally collapse the second into the third.
 *
 * That is the same three-valued shape the engine uses everywhere else: `match`, `mismatch`
 * and `unverified` are three answers, and the whole console exists because collapsing the
 * third into either of the others produces a confident lie.
 */

/** A value, a prompt to sign in, or a genuine failure. Never two of them at once. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; signedOut: true } | { ok: false; signedOut: false; error: string };

/**
 * GET some JSON.
 *
 * `credentials: "same-origin"` is explicit rather than left to the default. The default is
 * already same-origin in every current browser, but a cookie that silently stops being sent
 * is a session that silently stops working, and this is the line that would decide it.
 */
export async function getJson<T>(path: string): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  } catch (cause) {
    // A network-level failure — the server is not running, or the page was closed mid-flight.
    // Distinct from an HTTP error, and the advice for it is different.
    return { ok: false, signedOut: false, error: `could not reach the server: ${String(cause)}` };
  }

  if (response.status === 401) return { ok: false, signedOut: true };

  if (!response.ok) {
    return { ok: false, signedOut: false, error: await reasonFrom(response) };
  }

  try {
    return { ok: true, value: (await response.json()) as T };
  } catch {
    // Reachable, and it is the failure this whole module was written after: a request that
    // was answered with a page instead of data reports 200 and then fails several frames
    // later inside `.json()`. Naming it here keeps the cause next to the symptom.
    return { ok: false, signedOut: false, error: `${path} answered with something that is not JSON` };
  }
}

/** Sign in. Returns the session, a rejection, or a transport failure. */
export async function signIn(user: string, password: string): Promise<ApiResult<{ user: string; expiresAt: number }>> {
  let response: Response;
  try {
    response = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, password }),
    });
  } catch (cause) {
    return { ok: false, signedOut: false, error: `could not reach the server: ${String(cause)}` };
  }
  if (response.ok) return { ok: true, value: (await response.json()) as { user: string; expiresAt: number } };
  // A failed sign-in is reported as a plain message, not as `signedOut` — the caller is
  // already on the sign-in screen, and bouncing it back to itself would lose the reason.
  return { ok: false, signedOut: false, error: await reasonFrom(response) };
}

/** End the session. Never fails in a way a caller must handle: signing out always succeeds. */
export async function signOut(): Promise<void> {
  try {
    await fetch("/api/session", { method: "DELETE", credentials: "same-origin" });
  } catch {
    // The cookie may or may not be cleared, but the caller is going back to the sign-in
    // screen either way, and an error box about signing out helps nobody.
  }
}

/** The server's own words where it has them, rather than a status code the reader must decode. */
async function reasonFrom(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON. Fall through to the status, which is all there is to say.
  }
  return `the server answered ${response.status}`;
}
