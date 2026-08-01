import { ApiError } from "@lush/api-client";
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../App";
import logoUrl from "../assets/lush-logo.svg?url";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const app = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showVerificationRecovery, setShowVerificationRecovery] =
    useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setShowVerificationRecovery(false);
    setSubmitting(true);

    try {
      const result = await app.authenticate(mode, email, password);
      setPassword("");

      if (result.verificationEmail) {
        navigate("/sign-in", {
          replace: true,
          state: { notice: `Check ${result.verificationEmail} for next steps before signing in.` }
        });
        return;
      }

      const requestedPath = (location.state as { from?: unknown } | null)?.from;
      navigate(
        typeof requestedPath === "string" && requestedPath.startsWith("/")
          ? requestedPath
          : "/concepts",
        { replace: true }
      );
    } catch (caught) {
      const invalidCredentials =
        mode === "login" && caught instanceof ApiError && caught.status === 401;
      setShowVerificationRecovery(invalidCredentials);
      setError(
        invalidCredentials
          ? "Invalid email or password."
          : caught instanceof Error
            ? caught.message
            : mode === "register"
              ? "Unable to register"
              : "Unable to sign in"
      );
    } finally {
      setSubmitting(false);
    }
  };

  const notice = (location.state as { notice?: unknown } | null)?.notice;

  return (
    <section className="content-enter flex h-screen items-center justify-center px-6">
      <form
        onSubmit={submit}
        className="grid w-full max-w-sm gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-5"
      >
        <div className="flex items-center gap-3">
          <img src={logoUrl} alt="Lush" className="h-9 w-9" />
          <div>
            <h1 className="text-base font-semibold text-[var(--color-text)]">Lush</h1>
            <p className="text-sm text-[var(--color-muted)]">
              {mode === "register" ? "Create account" : "Sign in"}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-md bg-[var(--color-panel)] p-1">
          <AuthModeButton active={mode === "login"} onClick={() => navigate("/sign-in")}>
            Sign in
          </AuthModeButton>
          <AuthModeButton active={mode === "register"} onClick={() => navigate("/register")}>
            Register
          </AuthModeButton>
        </div>

        <label className="grid gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand)]"
            required
          />
        </label>

        <label className="grid gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition hover:border-[var(--color-border-strong)] focus:border-[var(--color-brand)]"
            minLength={8}
            maxLength={mode === "register" ? 512 : undefined}
            required
          />
        </label>

        {mode === "login" ? (
          <Link
            to="/forgot-password"
            className="text-right text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            Forgot password?
          </Link>
        ) : null}

        {typeof notice === "string" ? (
          <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-muted)]">
            {notice}
          </p>
        ) : null}
        {error ? (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <p>{error}</p>
            {showVerificationRecovery ? (
              <p className="mt-2">
                If you recently signed up, check your inbox for a verification
                link, or{" "}
                <Link to="/register" className="underline hover:text-red-200">
                  register again
                </Link>{" "}
                to resend it.
              </p>
            ) : null}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md border border-[var(--color-brand)] bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white transition hover:border-[var(--color-brand-strong)] hover:bg-[var(--color-brand-strong)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Connecting..." : mode === "register" ? "Create account" : "Sign in"}
        </button>
      </form>
    </section>
  );
}

function AuthModeButton(props: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`rounded px-3 py-2 text-sm font-medium transition ${
        props.active
          ? "bg-[var(--color-card)] text-[var(--color-text)]"
          : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {props.children}
    </button>
  );
}
