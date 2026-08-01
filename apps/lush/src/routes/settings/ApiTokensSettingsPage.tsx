import { useEffect, useState, type FormEvent } from "react";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  type ApiToken,
  type ApiTokenScope,
  type UserRole
} from "@lush/api-client";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

const scopes: Array<{ value: ApiTokenScope; label: string; description: string }> = [
  {
    value: "inference:models:read",
    label: "Read inference models",
    description: "List and retrieve models available to the organization."
  },
  {
    value: "inference:invoke",
    label: "Invoke inference",
    description: "Create chat completions, responses, and embeddings."
  }
];

export function ApiTokensSettingsPage(props: {
  apiBaseUrl: string;
  currentRole?: UserRole;
  runApiRequest: <T>(operation: (sessionToken: string) => Promise<T>) => Promise<T>;
}) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<ApiTokenScope[]>(
    scopes.map((scope) => scope.value)
  );
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [createdSecret, setCreatedSecret] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<ApiToken>();
  const isAdmin = props.currentRole === "admin";

  const load = async () => {
    if (!isAdmin) return;
    const response = await props.runApiRequest((sessionToken) =>
      listApiTokens(props.apiBaseUrl, sessionToken)
    );
    setTokens(response.tokens);
  };

  useEffect(() => {
    let active = true;
    if (!isAdmin) return () => { active = false; };
    void props.runApiRequest((sessionToken) =>
      listApiTokens(props.apiBaseUrl, sessionToken)
    ).then((response) => {
      if (active) setTokens(response.tokens);
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [isAdmin, props.apiBaseUrl]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending("create");
    setError("");
    setCreatedSecret("");
    try {
      const response = await props.runApiRequest((sessionToken) =>
        createApiToken(props.apiBaseUrl, sessionToken, {
          name: name.trim(),
          scopes: selectedScopes,
          ...(expiresInDays ? { expiresInDays } : {})
        })
      );
      setCreatedSecret(response.secret);
      setName("");
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending("");
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setPending(revokeTarget.id);
    setError("");
    try {
      await props.runApiRequest((sessionToken) =>
        revokeApiToken(props.apiBaseUrl, revokeTarget.id, sessionToken, {})
      );
      setRevokeTarget(undefined);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending("");
    }
  };

  if (!isAdmin) {
    return (
      <div className="max-w-3xl rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 text-sm text-[var(--color-muted)]">
        Organization admins manage API tokens.
      </div>
    );
  }

  return (
    <div className="grid max-w-3xl gap-4">
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <h2 className="text-sm font-medium text-[var(--color-text)]">Create API token</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Tokens are organization credentials. Grant only the scopes the client needs.
        </p>
        <form onSubmit={submit} className="mt-4 grid gap-4">
          <label className="grid gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">Name</span>
            <input
              value={name}
              onInput={(event) => setName(event.currentTarget.value)}
              required
              maxLength={100}
              placeholder="Production model router"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-brand)]"
            />
          </label>
          <fieldset className="grid gap-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">Scopes</legend>
            {scopes.map((scope) => (
              <label key={scope.value} className="flex gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-3">
                <input
                  type="checkbox"
                  checked={selectedScopes.includes(scope.value)}
                  onChange={(event) => setSelectedScopes((current) =>
                    event.currentTarget.checked
                      ? [...new Set([...current, scope.value])]
                      : current.filter((value) => value !== scope.value)
                  )}
                />
                <span>
                  <span className="block text-sm text-[var(--color-text)]">{scope.label}</span>
                  <span className="block text-xs text-[var(--color-muted)]">{scope.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="grid gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">Expiration</span>
            <select
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.currentTarget.value))}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-text)]"
            >
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
              <option value={0}>No expiration</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={pending === "create" || !name.trim() || selectedScopes.length === 0}
            className="w-fit rounded-md bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending === "create" ? "Creating..." : "Create token"}
          </button>
        </form>
      </section>

      {createdSecret ? (
        <section className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
          <h2 className="text-sm font-medium text-[var(--color-text)]">Copy this token now</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">It will not be shown again.</p>
          <div className="mt-3 flex gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-[var(--color-panel)] p-3 text-xs text-[var(--color-text)]">{createdSecret}</code>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(createdSecret)}
              className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm text-[var(--color-text)]"
            >
              Copy
            </button>
          </div>
        </section>
      ) : null}

      {error ? <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</p> : null}

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <h2 className="text-sm font-medium text-[var(--color-text)]">API tokens</h2>
        <div className="mt-3 grid gap-2">
          {tokens.length === 0 ? <p className="text-sm text-[var(--color-muted)]">No API tokens.</p> : null}
          {tokens.map((token) => {
            const inactive = Boolean(token.revokedAt) || Boolean(token.expiresAt && new Date(token.expiresAt) <= new Date());
            return (
              <div key={token.id} className="flex flex-col gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text)]">{token.name}</p>
                  <p className="mt-1 font-mono text-xs text-[var(--color-muted)]">{token.prefix}...</p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">{token.scopes.join(", ")}</p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {token.revokedAt ? "Revoked" : inactive ? "Expired" : token.expiresAt ? `Expires ${new Date(token.expiresAt).toLocaleDateString()}` : "No expiration"}
                    {token.lastUsedAt ? ` · Last used ${new Date(token.lastUsedAt).toLocaleString()}` : " · Never used"}
                  </p>
                </div>
                {!inactive ? (
                  <button
                    type="button"
                    onClick={() => setRevokeTarget(token)}
                    disabled={pending === token.id}
                    className="rounded-md border border-red-500/50 px-3 py-2 text-sm text-red-300 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title="Revoke API token?"
        body="Clients using this token will immediately lose access."
        confirmLabel="Revoke token"
        pendingConfirmLabel="Revoking..."
        pending={Boolean(revokeTarget && pending === revokeTarget.id)}
        danger
        onCancel={() => setRevokeTarget(undefined)}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "API token request failed";
}
