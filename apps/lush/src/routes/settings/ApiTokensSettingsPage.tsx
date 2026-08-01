import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  type ApiToken,
  type ApiTokenScope,
  type UserRole
} from "@lush/api-client";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../../components/ui/dialog";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

type ScopeOption = {
  value: ApiTokenScope;
  label: string;
  description: string;
};

const scopeGroups: Array<{ label: string; scopes: ScopeOption[] }> = [
  {
    label: "Organization",
    scopes: [
      {
        value: "organization:read",
        label: "Read organization",
        description: "View organization members and invitations."
      },
      {
        value: "organization:write",
        label: "Manage organization",
        description: "Manage organization members and invitations."
      }
    ]
  },
  {
    label: "Inference",
    scopes: [
      {
        value: "inference:read",
        label: "Read inference",
        description: "View inference configuration and available models."
      },
      {
        value: "inference:write",
        label: "Manage inference",
        description: "Manage inference providers, models, and defaults."
      },
      {
        value: "inference:invoke",
        label: "Invoke inference",
        description: "Create chat completions, responses, and embeddings."
      }
    ]
  },
  {
    label: "Agents",
    scopes: [
      {
        value: "agents:read",
        label: "Read agent runs",
        description: "View agent runs and stream their events."
      },
      {
        value: "agents:write",
        label: "Invoke agents",
        description: "Start and cancel runs or invoke agents directly."
      }
    ]
  },
  {
    label: "Sessions",
    scopes: [
      {
        value: "sessions:read",
        label: "Read sessions",
        description: "View projects, sessions, messages, and settings."
      },
      {
        value: "sessions:write",
        label: "Manage sessions",
        description: "Create and modify projects, sessions, messages, and state."
      }
    ]
  },
  {
    label: "Tools",
    scopes: [
      {
        value: "tools:read",
        label: "Read tools",
        description: "View gateway settings, connections, and saved tool catalogs."
      },
      {
        value: "tools:write",
        label: "Manage and invoke tools",
        description: "Manage or discover connections and invoke or approve tool calls."
      }
    ]
  }
];

export function ApiTokensSettingsPage(props: {
  apiBaseUrl: string;
  currentRole?: UserRole;
  runApiRequest: <T>(operation: (sessionToken: string) => Promise<T>) => Promise<T>;
}) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<ApiTokenScope[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdSecret, setCreatedSecret] = useState("");
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | "">("");
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

  useEffect(() => {
    if (!copyStatus) return;
    const timeout = window.setTimeout(() => setCopyStatus(""), 2_500);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending("create");
    setCreateError("");
    setCreatedSecret("");
    setCopyStatus("");
    try {
      const response = await props.runApiRequest((sessionToken) =>
        createApiToken(props.apiBaseUrl, sessionToken, {
          name: name.trim(),
          scopes: selectedScopes,
          ...(expiresInDays ? { expiresInDays } : {})
        })
      );
      setCreateOpen(false);
      setCreatedSecret(response.secret);
      setName("");
      await load();
    } catch (cause) {
      setCreateError(errorMessage(cause));
    } finally {
      setPending("");
    }
  };

  const copyToken = async () => {
    try {
      await writeClipboardText(createdSecret);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  const closeCreatedToken = () => {
    setCreatedSecret("");
    setCopyStatus("");
  };

  const openCreateToken = () => {
    setName("");
    setSelectedScopes([]);
    setExpiresInDays(90);
    setCreateError("");
    setCreateOpen(true);
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
      {error ? <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</p> : null}

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-[var(--color-text)]">API tokens</h2>
          <Button type="button" onClick={openCreateToken}>Create token</Button>
        </div>
        <div className="mt-3 grid gap-2">
          {tokens.length === 0 ? (
            <div className="grid justify-items-start gap-3 rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-panel)] p-5">
              <div>
                <p className="text-sm font-medium text-[var(--color-text)]">Connect a service to Lush</p>
                <p className="mt-1 max-w-xl text-sm text-[var(--color-muted)]">
                  API tokens let applications access Lush APIs for this organization. Each token starts with no access and can be scoped and revoked independently.
                </p>
              </div>
              <Button type="button" variant="outline" onClick={openCreateToken}>
                Create your first token
              </Button>
            </div>
          ) : null}
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

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (pending === "create") return;
          setCreateOpen(open);
          if (!open) setCreateError("");
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create API token</DialogTitle>
            <DialogDescription>
              Create an organization credential and grant only the scopes its client needs.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} autoComplete="off" className="grid gap-4">
            <label className="grid gap-2">
              <span className="pb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">Token label</span>
              <input
                autoFocus
                autoComplete="new-password"
                name="credential-description"
                value={name}
                onInput={(event) => setName(event.currentTarget.value)}
                required
                maxLength={100}
                placeholder="Token name"
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-brand)]"
              />
            </label>
            <label className="grid gap-2">
              <span className="pb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">Expiration</span>
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
            <fieldset className="grid gap-4">
              <legend className="pb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">Scopes</legend>
              {scopeGroups.map((group) => (
                <div key={group.label} className="grid gap-2 sm:grid-cols-2">
                  <h3 className="pb-2 text-xs font-medium text-[var(--color-muted)] sm:col-span-2">{group.label}</h3>
                  {group.scopes.map((scope) => (
                    <label key={scope.value} className="flex gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-3">
                      <input
                        type="checkbox"
                        checked={selectedScopes.includes(scope.value)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setSelectedScopes((current) =>
                            checked
                              ? [...new Set([...current, scope.value])]
                              : current.filter((value) => value !== scope.value)
                          );
                        }}
                      />
                      <span>
                        <span className="block text-sm text-[var(--color-text)]">{scope.label}</span>
                        <span className="block text-xs text-[var(--color-muted)]">{scope.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              ))}
            </fieldset>
            {createError ? <p className="text-sm text-red-400">{createError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending === "create"} onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending === "create" || !name.trim() || selectedScopes.length === 0}>
                {pending === "create" ? "Creating..." : "Create token"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(createdSecret)}
        onOpenChange={(open) => {
          if (!open) closeCreatedToken();
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Copy your API token</DialogTitle>
            <DialogDescription>
              This token will not be shown again. Store it securely before closing this dialog.
            </DialogDescription>
          </DialogHeader>
          <button
            type="button"
            aria-label="Copy API token"
            title="Copy API token"
            onClick={() => void copyToken()}
            className="max-h-32 cursor-copy overflow-auto break-all rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-3 text-left font-mono text-xs text-[var(--color-text)] select-all hover:border-[var(--color-border-strong)]"
          >
            {createdSecret}
          </button>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => void copyToken()}>
              {copyStatus === "copied" ? "Copied" : "Copy token"}
            </Button>
            <Button type="button" onClick={closeCreatedToken}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <CopyToast status={copyStatus} />
    </div>
  );
}

async function writeClipboardText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through for browsers or webviews that deny the Clipboard API.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy failed");
}

function CopyToast(props: { status: "copied" | "failed" | "" }) {
  if (!props.status) return null;

  const failed = props.status === "failed";
  return createPortal(
    <div
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      className={`fixed right-4 top-4 z-[100] rounded-md border px-4 py-3 text-sm shadow-lg ${
        failed
          ? "border-red-500/50 bg-red-950 text-red-100"
          : "border-emerald-500/50 bg-emerald-950 text-emerald-100"
      }`}
    >
      {failed ? "Could not copy token. Select and copy it manually." : "API token copied."}
    </div>,
    document.body
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "API token request failed";
}
