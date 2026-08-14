/**
 * The sign-in screen.
 *
 * **This form is the reason the bundle is served without a session.** It lives inside the
 * bundle, so a router that put the bundle behind the session made signing in impossible —
 * the console was a blank white page through `geoqa server` until that was fixed.
 *
 * Deliberately plain. There is one account, configured by whoever runs the server, and there
 * is no registration, no password reset and no "remember me" — each of those is a credential
 * path, and a credential path nobody asked for is attack surface nobody is watching. What is
 * here instead is an honest error line: the server refuses to say whether the user or the
 * password was wrong (that distinction is a user-enumeration oracle), so this does not
 * pretend to know either.
 */
import { useState, type FormEvent, type JSX } from "react";
import { signIn } from "./api.ts";

export function Login({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [user, setUser] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void signIn(user, password).then((result) => {
      setBusy(false);
      if (result.ok) {
        // The password is dropped from state the moment it is no longer needed. It buys
        // little on its own — but a value that outlives its use is a value that ends up in a
        // stack frame, a devtools snapshot or an error report.
        setPassword("");
        onSignedIn();
        return;
      }
      setError(result.signedOut ? "sign-in failed" : result.error);
    });
  };

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <div className="signin-brand">
          geo<b>qa</b>
        </div>
        <p className="signin-lede">
          Geographic QA console. Every reading behind this screen was taken from inside the market it claims.
        </p>

        <label className="field">
          <span className="field-label">User</span>
          <input className="input" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" spellCheck={false} />
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </label>

        {/* `role="alert"` so the reason is announced rather than only drawn — a sign-in error
            a screen reader does not reach is a dead end with no way out. */}
        {error !== null && (
          <p className="signin-error" role="alert">
            {error}
          </p>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy || password === ""}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="signin-hint">
          No password set? Run <code>geoqa server hash &lt;password&gt;</code> and export what it prints. There is no default
          account on purpose.
        </p>
      </form>
    </div>
  );
}
