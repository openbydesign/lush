import { useEffect, useState, type FormEvent } from "react";
import {
  acknowledgeToolCatalog,
  createToolConnection,
  decideToolApproval,
  deleteToolConnection,
  discoverToolCatalog,
  getToolGatewaySettings,
  invokeTool,
  listToolConnections,
  listToolDefinitions,
  updateToolConnection,
  updateToolGatewaySettings,
  type InvokeToolResponse,
  type ToolConnection,
  type ToolConnectionScope,
  type ToolDefinition,
  type ToolGatewaySettings,
  type ToolSource,
  type UserRole
} from "@lush/api-client";

type PendingApproval = {
  connectionId: string;
  definition: ToolDefinition;
  input: unknown;
  idempotencyKey: string;
  outcome: Extract<InvokeToolResponse, { status: "approval_required" }>;
};

export function ToolsSettingsPage(props: {
  apiBaseUrl: string;
  currentRole?: UserRole;
  runApiRequest: <T>(operation: (sessionToken: string) => Promise<T>) => Promise<T>;
}) {
  const [settings, setSettings] = useState<ToolGatewaySettings>();
  const [connections, setConnections] = useState<ToolConnection[]>([]);
  const [definitions, setDefinitions] = useState<Record<string, ToolDefinition[]>>({});
  const [expanded, setExpanded] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [scope, setScope] = useState<ToolConnectionScope>("user");
  const [source, setSource] = useState<ToolSource>("mcp");
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [testInputs, setTestInputs] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [approval, setApproval] = useState<PendingApproval>();

  const request = props.runApiRequest;
  const loadConnections = async () => {
    const response = await request((token) =>
      listToolConnections(props.apiBaseUrl, token)
    );
    setConnections(response.connections);
  };

  useEffect(() => {
    let active = true;
    void request((token) => getToolGatewaySettings(props.apiBaseUrl, token))
      .then(async (next) => {
        if (!active) return;
        setSettings(next);
        if (next.enabled) await loadConnections();
      })
      .catch((cause) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [props.apiBaseUrl]);

  const run = async (key: string, operation: () => Promise<void>) => {
    setPending(key);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending("");
    }
  };

  const toggleGateway = () => run("gateway", async () => {
    const next = await request((token) =>
      updateToolGatewaySettings(props.apiBaseUrl, token, {
        enabled: !settings?.enabled
      })
    );
    setSettings(next);
    if (next.enabled) await loadConnections();
    else setConnections([]);
  });

  const submitConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run("create", async () => {
      await request((token) =>
        createToolConnection(props.apiBaseUrl, token, {
          scope,
          source,
          label,
          ...(source === "native" ? {} : { endpoint: { url: endpoint } }),
          credentialMode: secret
            ? scope === "user" ? "user_delegated" : "organization"
            : "none",
          ...(secret ? { secret } : {})
        })
      );
      setLabel("");
      setEndpoint("");
      setSecret("");
      setFormOpen(false);
      await loadConnections();
    });
  };

  const refreshCatalog = (connection: ToolConnection) => run(`discover:${connection.id}`, async () => {
    const response = await request((token) =>
      discoverToolCatalog(props.apiBaseUrl, connection.id, token, undefined)
    );
    setDefinitions((current) => ({ ...current, [connection.id]: response.definitions }));
    setExpanded(connection.id);
    await loadConnections();
  });

  const acknowledgeCatalog = (connection: ToolConnection) => run(`acknowledge:${connection.id}`, async () => {
    await request((token) =>
      acknowledgeToolCatalog(props.apiBaseUrl, connection.id, token, {})
    );
    await loadConnections();
  });

  const toggleExpanded = (connection: ToolConnection) => run(`list:${connection.id}`, async () => {
    if (expanded === connection.id) {
      setExpanded("");
      return;
    }
    const response = await request((token) =>
      listToolDefinitions(props.apiBaseUrl, connection.id, token)
    );
    setDefinitions((current) => ({ ...current, [connection.id]: response.definitions }));
    setExpanded(connection.id);
  });

  const removeConnection = (connection: ToolConnection) => run(`delete:${connection.id}`, async () => {
    if (!window.confirm(`Delete ${connection.label}? Stored credentials and definitions will be removed.`)) return;
    await request((token) =>
      deleteToolConnection(props.apiBaseUrl, token, { connectionId: connection.id })
    );
    await loadConnections();
  });

  const toggleConnection = (connection: ToolConnection) => run(`toggle:${connection.id}`, async () => {
    await request((token) =>
      updateToolConnection(props.apiBaseUrl, token, {
        connectionId: connection.id,
        enabled: !connection.enabled
      })
    );
    await loadConnections();
  });

  const testDefinition = (
    connection: ToolConnection,
    definition: ToolDefinition
  ) => run(`test:${definition.id}`, async () => {
    const input = JSON.parse(testInputs[definition.id] || "{}");
    const idempotencyKey = crypto.randomUUID();
    const outcome = await request((token) =>
      invokeTool(props.apiBaseUrl, connection.id, token, {
        toolName: definition.externalName,
        input,
        expectedDefinitionDigest: definition.definitionDigest,
        idempotencyKey
      })
    );
    if (outcome.status === "approval_required") {
      setApproval({ connectionId: connection.id, definition, input, idempotencyKey, outcome });
      return;
    }
    setTestResults((current) => ({
      ...current,
      [definition.id]: JSON.stringify(outcome, null, 2)
    }));
  });

  const decideApproval = (approve: boolean) => {
    const current = approval;
    if (!current) return;
    void run(`approval:${current.outcome.approval.approvalId}`, async () => {
      await request((token) =>
        decideToolApproval(
          props.apiBaseUrl,
          current.outcome.approval.approvalId,
          token,
          { approve }
        )
      );
      if (!approve) {
        setTestResults((results) => ({
          ...results,
          [current.definition.id]: "Approval denied. The tool was not invoked."
        }));
        setApproval(undefined);
        return;
      }
      const outcome = await request((token) =>
        invokeTool(props.apiBaseUrl, current.connectionId, token, {
          toolName: current.definition.externalName,
          input: current.input,
          expectedDefinitionDigest: current.definition.definitionDigest,
          idempotencyKey: current.idempotencyKey
        })
      );
      setTestResults((results) => ({
        ...results,
        [current.definition.id]: JSON.stringify(outcome, null, 2)
      }));
      setApproval(undefined);
    });
  };

  const isAdmin = props.currentRole === "admin";
  return (
    <div className="grid max-w-4xl gap-4">
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-[var(--color-text)]">Tool gateway</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Manage personal and organization connections. Test calls use the production gateway, policy, and audit path.
            </p>
          </div>
          <button
            type="button"
            disabled={!isAdmin || pending === "gateway" || !settings}
            onClick={() => void toggleGateway()}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-50"
          >
            {settings?.enabled ? "Disable" : "Enable"}
          </button>
        </div>
        {!isAdmin ? (
          <p className="mt-3 text-xs text-[var(--color-muted)]">Only an organization administrator can change the rollout state.</p>
        ) : null}
      </section>

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>
      ) : null}

      {settings?.enabled ? (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium">Connections</h2>
              <p className="mt-1 text-sm text-[var(--color-muted)]">Credentials are write-only and encrypted server-side.</p>
            </div>
            <button type="button" onClick={() => setFormOpen((value) => !value)} className="rounded-md bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white">
              Add connection
            </button>
          </div>

          {formOpen ? (
            <form onSubmit={submitConnection} className="mt-4 grid gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-3 sm:grid-cols-2">
              <Field label="Name"><input required value={label} onInput={(event) => setLabel(event.currentTarget.value)} className={inputClass} /></Field>
              <Field label="Scope"><select value={scope} onChange={(event) => setScope(event.currentTarget.value as ToolConnectionScope)} className={inputClass}><option value="user">Personal</option>{isAdmin ? <option value="organization">Organization</option> : null}</select></Field>
              <Field label="Source"><select value={source} onChange={(event) => setSource(event.currentTarget.value as ToolSource)} className={inputClass}><option value="mcp">MCP Streamable HTTP</option><option value="openapi">OpenAPI 3 JSON</option><option value="native">Native</option></select></Field>
              {source !== "native" ? <Field label={source === "openapi" ? "OpenAPI document URL" : "MCP endpoint URL"}><input required type="url" value={endpoint} onInput={(event) => setEndpoint(event.currentTarget.value)} className={inputClass} /></Field> : <div />}
              {source !== "native" ? <Field label="Credential (optional)"><input type="password" value={secret} onInput={(event) => setSecret(event.currentTarget.value)} className={inputClass} autoComplete="off" /></Field> : null}
              <div className="flex items-end"><button disabled={pending === "create"} className="rounded-md bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Create</button></div>
            </form>
          ) : null}

          <div className="mt-4 grid gap-3">
            {connections.length === 0 ? <p className="text-sm text-[var(--color-muted)]">No tool connections configured.</p> : null}
            {connections.map((connection) => {
              const manageable = connection.scope === "user" || isAdmin;
              return (
                <article key={connection.id} className="rounded-md border border-[var(--color-border)] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2"><h3 className="text-sm font-medium">{connection.label}</h3><Status connection={connection} /></div>
                      <p className="mt-1 text-xs text-[var(--color-muted)]">{connection.scope === "user" ? "Personal" : "Organization"} · {connection.source.toUpperCase()}{connection.endpoint ? ` · ${connection.endpoint}` : ""}</p>
                      {connection.catalogChanged ? <p className="mt-1 text-xs text-amber-300">Catalog changed. Review definition digests, then acknowledge this version.</p> : null}
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => void toggleExpanded(connection)} className={buttonClass}>{expanded === connection.id ? "Hide" : "Definitions"}</button>
                      {manageable ? <button type="button" onClick={() => void refreshCatalog(connection)} className={buttonClass}>Discover</button> : null}
                      {manageable && connection.catalogChanged ? <button type="button" onClick={() => void acknowledgeCatalog(connection)} className={buttonClass}>Acknowledge</button> : null}
                      {manageable ? <button type="button" onClick={() => void toggleConnection(connection)} className={buttonClass}>{connection.enabled ? "Disable" : "Enable"}</button> : null}
                      {manageable ? <button type="button" onClick={() => void removeConnection(connection)} className={buttonClass}>Delete</button> : null}
                    </div>
                  </div>
                  {expanded === connection.id ? (
                    <div className="mt-3 grid gap-3 border-t border-[var(--color-border)] pt-3">
                      {(definitions[connection.id] ?? []).map((definition) => (
                        <div key={definition.id} className="rounded-md bg-[var(--color-panel)] p-3">
                          <div className="flex justify-between gap-3"><div><h4 className="text-sm font-medium">{definition.title || definition.externalName}</h4><p className="mt-1 text-xs text-[var(--color-muted)]">{definition.externalName} · {definition.policy.decision}: {definition.policy.reasons.join(", ")}</p></div><code className="text-[0.625rem] text-[var(--color-muted)]">{definition.definitionDigest.slice(0, 12)}</code></div>
                          <textarea value={testInputs[definition.id] ?? "{}"} onInput={(event) => setTestInputs((current) => ({ ...current, [definition.id]: event.currentTarget.value }))} className={`${inputClass} mt-3 min-h-20 font-mono`} aria-label={`JSON input for ${definition.externalName}`} />
                          <button type="button" onClick={() => void testDefinition(connection, definition)} className={`${buttonClass} mt-2`}>Test through gateway</button>
                          {testResults[definition.id] ? <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-xs">{testResults[definition.id]}</pre> : null}
                        </div>
                      ))}
                      {(definitions[connection.id] ?? []).length === 0 ? <p className="text-sm text-[var(--color-muted)]">No definitions. Run discovery first.</p> : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {approval ? (
        <section className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
          <h2 className="text-sm font-medium">Approval required</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">{approval.definition.externalName} is classified as {approval.definition.policy.reasons.join(", ")}.</p>
          <div className="mt-3 flex gap-2"><button type="button" onClick={() => decideApproval(true)} className="rounded-md bg-[var(--color-brand)] px-3 py-2 text-sm text-white">Approve and run</button><button type="button" onClick={() => decideApproval(false)} className={buttonClass}>Deny</button></div>
        </section>
      ) : null}
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">{props.label}</span>{props.children}</label>;
}

function Status({ connection }: { connection: ToolConnection }) {
  const color = connection.health.status === "healthy" ? "text-emerald-400" : connection.health.status === "unhealthy" ? "text-red-400" : "text-[var(--color-muted)]";
  return <span className={`text-xs ${color}`}>{connection.health.status}{connection.health.errorCode ? ` (${connection.health.errorCode})` : ""}</span>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Tool operation failed";
}

const inputClass = "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand)]";
const buttonClass = "rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--color-panel-hover)] disabled:opacity-50";
