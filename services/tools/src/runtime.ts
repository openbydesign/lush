/**
 * Tool gateway control plane.
 *
 * CRUD for organization- and user-scoped tool connections, encrypted credential
 * storage, and catalog discovery/normalization. Every read is scoped so a user
 * can never see another user's private connection, and an organization
 * administrator gets governance metadata but not the ability to invoke as, or
 * read the secret of, a user-private connection.
 */

import { getDb } from "@lush/db/client";
import type {
  ToolConnectionRow,
  ToolConnectionHealth,
  ToolCredentialMode,
  ToolDefinitionRow,
  ToolSource,
  UserRole
} from "@lush/db/schema";
import type { Transaction } from "kysely";
import type { Database } from "@lush/db/schema";
import {
  buildConnector,
  parseMcpConfig,
  parseOpenApiConfig
} from "./connector-factory";
import {
  ConnectorError,
  restrictiveAnnotations,
  type NormalizedToolDefinition
} from "./connectors/types";
import { builtinNativeTools } from "./connectors/native";
import { digestValue } from "./digest";
import {
  decryptSecret,
  encryptSecret,
  secretEnvelopeNeedsRotation,
  SecretError
} from "./secrets";
import {
  explainToolPolicy,
  normalizeConnectionPolicy,
  type ToolPolicyExplanation
} from "./policy";

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export type ToolsPrincipal = {
  userId: string;
  organizationId: string;
  role: UserRole;
};

export type ToolConnectionScope = "organization" | "user";

/** Public, secret-free view of a connection. */
export type ToolConnectionSummary = {
  id: string;
  organizationId: string;
  scope: ToolConnectionScope;
  ownerUserId: string | null;
  source: ToolSource;
  systemManaged: boolean;
  label: string;
  endpoint: string | null;
  credentialMode: ToolCredentialMode;
  enabled: boolean;
  hasCredential: boolean;
  catalogVersion: string | null;
  catalogChanged: boolean;
  health: {
    status: ToolConnectionHealth;
    checkedAt: string | null;
    errorCode: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type ToolDefinitionSummary = {
  id: string;
  connectionId: string;
  externalName: string;
  qualifiedName: string;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown | null;
  annotations: unknown;
  /** Stable digest a caller can pin and pass back as expectedDefinitionDigest. */
  definitionDigest: string;
  enabled: boolean;
  policy: ToolPolicyExplanation;
};

export type CreateToolConnectionRequest = {
  scope: ToolConnectionScope;
  source: ToolSource;
  label: string;
  endpoint?: { url?: string; headers?: Record<string, string> };
  credentialMode?: ToolCredentialMode;
  /** Plaintext secret for organization service credentials. */
  secret?: string;
};

export type UpdateToolConnectionRequest = {
  connectionId: string;
  label?: string;
  enabled?: boolean;
  secret?: string | null;
  policy?: {
    deny?: boolean;
    approval?: "default" | "never" | "every_call";
  };
};

export type ToolGatewaySettings = {
  enabled: boolean;
  canManageOrganization: boolean;
};

const BUILTIN_CONNECTION_KEY = "lush_builtin";

/** Phase-2 rollout gate. Absence/default false keeps every HTTP route dark. */
export async function isToolGatewayEnabled(organizationId: string): Promise<boolean> {
  const organization = await getDb()
    .selectFrom("organizations")
    .select("toolGatewayEnabled")
    .where("id", "=", organizationId)
    .executeTakeFirst();
  return organization?.toolGatewayEnabled === true;
}

export async function getToolGatewaySettings(
  principal: ToolsPrincipal
): Promise<ToolGatewaySettings> {
  return {
    enabled: await isToolGatewayEnabled(principal.organizationId),
    canManageOrganization: principal.role === "admin"
  };
}

export async function updateToolGatewaySettings(
  principal: ToolsPrincipal,
  enabled: unknown
): Promise<ToolGatewaySettings> {
  if (principal.role !== "admin") {
    throw new ToolError(
      "forbidden",
      "Only organization administrators can change tool gateway settings",
      403
    );
  }
  if (typeof enabled !== "boolean") {
    throw new ToolError("invalid_settings", "Tool gateway enabled must be a boolean");
  }
  await getDb()
    .updateTable("organizations")
    .set({ toolGatewayEnabled: enabled, updatedAt: new Date() })
    .where("id", "=", principal.organizationId)
    .execute();
  return { enabled, canManageOrganization: true };
}

async function ensureBuiltinToolConnection(organizationId: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insertInto("toolConnections")
    .values({
      organizationId,
      ownerUserId: null,
      source: "native",
      systemKey: BUILTIN_CONNECTION_KEY,
      label: "Built-in tools",
      endpointConfig: {},
      credentialMode: "none",
      enabled: false,
      policy: {},
      catalogVersion: null,
      catalogAcknowledgedVersion: null,
      catalogChanged: false,
      healthStatus: "unknown",
      healthCheckedAt: null,
      healthErrorCode: null,
      createdAt: now,
      updatedAt: now
    })
    .onConflict((oc) =>
      oc.columns(["organizationId", "systemKey"]).doNothing()
    )
    .execute();

  const connection = await db
    .selectFrom("toolConnections")
    .selectAll()
    .where("organizationId", "=", organizationId)
    .where("systemKey", "=", BUILTIN_CONNECTION_KEY)
    .executeTakeFirstOrThrow();
  const definitions: NormalizedToolDefinition[] = builtinNativeTools.map(
    ({ handler: _handler, ...definition }) => definition
  );
  const catalogVersion = await digestValue(
    [...definitions].sort((a, b) => a.externalName.localeCompare(b.externalName))
  );
  if (connection.catalogVersion !== catalogVersion) {
    await persistConnectionCatalog(connection, definitions, true);
  }
}

export async function listToolConnections(
  principal: ToolsPrincipal
): Promise<ToolConnectionSummary[]> {
  await ensureBuiltinToolConnection(principal.organizationId);
  const rows = await getDb()
    .selectFrom("toolConnections")
    .selectAll()
    .where("organizationId", "=", principal.organizationId)
    .where((eb) =>
      // Org-scoped connections plus the caller's own user-scoped connections.
      eb.or([
        eb("ownerUserId", "is", null),
        eb("ownerUserId", "=", principal.userId)
      ])
    )
    .orderBy("createdAt", "asc")
    .execute();

  const credentialFlags = await credentialPresence(rows.map((row) => row.id));
  return rows.map((row) => summarizeConnection(row, credentialFlags));
}

export async function createToolConnection(
  principal: ToolsPrincipal,
  request: CreateToolConnectionRequest
): Promise<ToolConnectionSummary> {
  if (request.scope !== "organization" && request.scope !== "user") {
    throw new ToolError("invalid_connection", "Connection scope must be organization or user");
  }
  if (request.source !== "mcp" && request.source !== "openapi") {
    throw new ToolError(
      "invalid_connection",
      "Native tools are system-managed and cannot be added as connections"
    );
  }
  const label = typeof request.label === "string" ? request.label.trim() : "";
  if (!label) {
    throw new ToolError("invalid_connection", "A connection label is required");
  }
  if (request.scope === "organization" && principal.role !== "admin") {
    throw new ToolError(
      "forbidden",
      "Only organization administrators can create organization connections",
      403
    );
  }

  const credentialMode = request.credentialMode ?? "none";
  if (
    credentialMode !== "none" &&
    credentialMode !== "organization" &&
    credentialMode !== "user_delegated"
  ) {
    throw new ToolError("invalid_connection", "Credential mode is invalid");
  }
  if (request.secret !== undefined && typeof request.secret !== "string") {
    throw new ToolError("invalid_connection", "Connection secret must be a string");
  }
  if (request.secret?.trim() && credentialMode === "none") {
    throw new ToolError(
      "invalid_connection",
      "A secret requires an explicit credential mode"
    );
  }

  const source = request.source;
  const endpointConfig = normalizeEndpoint(source, request.endpoint);
  const ownerUserId = request.scope === "user" ? principal.userId : null;

  if (credentialMode === "user_delegated" && request.scope !== "user") {
    throw new ToolError(
      "invalid_connection",
      "User-delegated credentials require a user-scoped connection"
    );
  }

  const db = getDb();
  const now = new Date();
  const connection = await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("toolConnections")
      .values({
        organizationId: principal.organizationId,
        ownerUserId,
        source,
        label,
        endpointConfig,
        credentialMode,
        enabled: true,
        policy: {},
        catalogVersion: null,
        catalogAcknowledgedVersion: null,
        catalogChanged: false,
        healthStatus: "unknown",
        healthCheckedAt: null,
        healthErrorCode: null,
        createdAt: now,
        updatedAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (request.secret?.trim()) {
      await storeCredential(trx, {
        connectionId: row.id,
        // Organization service credentials have no subject; user-delegated bind
        // to the owning user.
        subjectUserId: credentialMode === "user_delegated" ? principal.userId : null,
        secret: request.secret.trim(),
        now
      });
    }

    return row;
  });

  const flags = await credentialPresence([connection.id]);
  return summarizeConnection(connection, flags);
}

export async function updateToolConnection(
  principal: ToolsPrincipal,
  request: UpdateToolConnectionRequest
): Promise<ToolConnectionSummary> {
  if (
    request.secret !== undefined &&
    request.secret !== null &&
    typeof request.secret !== "string"
  ) {
    throw new ToolError("invalid_connection", "Connection secret must be a string");
  }
  const connection = await requireConnectionForManagement(principal, request.connectionId);
  if (
    connection.systemKey !== null &&
    (request.label !== undefined || request.secret !== undefined)
  ) {
    throw new ToolError(
      "system_connection_managed",
      "Built-in connection identity and credentials are managed by Lush",
      409
    );
  }
  const db = getDb();
  const now = new Date();

  await db.transaction().execute(async (trx) => {
    const changes: Record<string, unknown> = { updatedAt: now };
    if (typeof request.label === "string" && request.label.trim()) {
      changes.label = request.label.trim();
    }
    if (typeof request.enabled === "boolean") {
      changes.enabled = request.enabled;
    }
    if (request.policy !== undefined) {
      if (!request.policy || typeof request.policy !== "object") {
        throw new ToolError("invalid_policy", "Connection policy must be an object");
      }
      const rawPolicy = request.policy as Record<string, unknown>;
      if (
        Object.keys(rawPolicy).some((key) => key !== "deny" && key !== "approval") ||
        (rawPolicy.deny !== undefined && typeof rawPolicy.deny !== "boolean") ||
        (rawPolicy.approval !== undefined &&
          rawPolicy.approval !== "default" &&
          rawPolicy.approval !== "never" &&
          rawPolicy.approval !== "every_call")
      ) {
        throw new ToolError("invalid_policy", "Connection policy is invalid");
      }
      changes.policy = normalizeConnectionPolicy(request.policy);
    }
    await trx
      .updateTable("toolConnections")
      .set(changes)
      .where("id", "=", connection.id)
      .execute();

    if (request.secret === null) {
      await trx
        .deleteFrom("toolCredentialBindings")
        .where("connectionId", "=", connection.id)
        .execute();
    } else if (typeof request.secret === "string" && request.secret.trim()) {
      if (connection.credentialMode === "none") {
        throw new ToolError(
          "invalid_connection",
          "A secret cannot be stored for a connection with credential mode none"
        );
      }
      await storeCredential(trx, {
        connectionId: connection.id,
        subjectUserId:
          connection.credentialMode === "user_delegated" ? principal.userId : null,
        secret: request.secret.trim(),
        now
      });
    }
  });

  const updated = await getConnectionRow(connection.id);
  const flags = await credentialPresence([connection.id]);
  return summarizeConnection(updated, flags);
}

export async function deleteToolConnection(
  principal: ToolsPrincipal,
  connectionId: string
): Promise<{ id: string }> {
  const connection = await requireConnectionForManagement(principal, connectionId);
  if (connection.systemKey !== null) {
    throw new ToolError(
      "system_connection_managed",
      "Built-in tool connections cannot be deleted",
      409
    );
  }
  await getDb()
    .deleteFrom("toolConnections")
    .where("id", "=", connection.id)
    .execute();
  return { id: connection.id };
}

export async function listToolDefinitions(
  principal: ToolsPrincipal,
  connectionId: string
): Promise<ToolDefinitionSummary[]> {
  const connection = await requireVisibleConnection(principal, connectionId);
  const rows = await getDb()
    .selectFrom("toolDefinitions")
    .selectAll()
    .where("connectionId", "=", connectionId)
    .orderBy("externalName", "asc")
    .execute();
  return rows.map((row) => summarizeDefinition(row, connection.policy));
}

/**
 * Discover the tools exposed by a connection and upsert them as definitions.
 * This uses the same authorization and connector path as runtime invocation, so
 * a successful discovery also validates connectivity and credentials.
 */
export async function discoverConnectionCatalog(
  principal: ToolsPrincipal,
  connectionId: string,
  signal: AbortSignal
): Promise<ToolDefinitionSummary[]> {
  const connection = await requireConnectionForManagement(principal, connectionId);
  if (connection.systemKey !== null) {
    throw new ToolError(
      "system_connection_managed",
      "Built-in tool definitions are synchronized automatically",
      409
    );
  }
  const credential = await resolveCredential(connection, principal.userId);
  const connector = buildConnector({ connection, credential });

  let discovered: NormalizedToolDefinition[];
  try {
    discovered = await connector.discover(signal);
  } catch (error) {
    const failure =
      error instanceof ConnectorError
        ? error
        : new ConnectorError("discovery_failed", "Tool discovery failed", 502, error);
    await updateConnectionHealth(connection.id, "unhealthy", failure.code);
    if (error instanceof ConnectorError) {
      throw new ToolError(error.code, error.message, error.status, error);
    }
    throw new ToolError("discovery_failed", "Tool discovery failed", 502, error);
  } finally {
    await connector.close?.();
  }

  await persistConnectionCatalog(connection, discovered, false);

  return listToolDefinitions(principal, connection.id);
}

async function persistConnectionCatalog(
  connection: ToolConnectionRow,
  discovered: NormalizedToolDefinition[],
  autoAcknowledge: boolean
): Promise<void> {
  const now = new Date();
  const orderedDiscovered = [...discovered].sort((a, b) =>
    a.externalName.localeCompare(b.externalName)
  );
  const catalogVersion = await digestValue(orderedDiscovered);

  await getDb().transaction().execute(async (trx) => {
    const externalNames = discovered.map((tool) => tool.externalName);
    // Remove definitions that no longer exist on the source.
    let deleteStale = trx
      .deleteFrom("toolDefinitions")
      .where("connectionId", "=", connection.id);
    if (externalNames.length > 0) {
      deleteStale = deleteStale.where("externalName", "not in", externalNames);
    }
    await deleteStale.execute();

    for (const tool of discovered) {
      // Native annotations are Lush-owned code. Remote annotations are
      // untrusted source hints, so the effective persisted policy remains
      // restrictive until a future explicit review surface assigns it.
      const annotations =
        connection.source === "native" ? tool.annotations : restrictiveAnnotations;
      const effectiveDefinition = { ...tool, annotations };
      const definitionDigest = await digestValue(effectiveDefinition);
      await trx
        .insertInto("toolDefinitions")
        .values({
          connectionId: connection.id,
          externalName: tool.externalName,
          qualifiedName: qualifiedName(connection, tool.externalName),
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? null,
          annotations,
          sourceMetadata: tool.sourceMetadata ?? {},
          definitionDigest,
          enabled: true,
          createdAt: now,
          updatedAt: now
        })
        .onConflict((oc) =>
          oc.columns(["connectionId", "externalName"]).doUpdateSet((eb) => ({
            qualifiedName: eb.ref("excluded.qualifiedName"),
            title: eb.ref("excluded.title"),
            description: eb.ref("excluded.description"),
            inputSchema: eb.ref("excluded.inputSchema"),
            outputSchema: eb.ref("excluded.outputSchema"),
            annotations: eb.ref("excluded.annotations"),
            sourceMetadata: eb.ref("excluded.sourceMetadata"),
            definitionDigest: eb.ref("excluded.definitionDigest"),
            updatedAt: now
          }))
        )
        .execute();
    }

    const current = await trx
      .selectFrom("toolConnections")
      .select(["catalogVersion", "catalogAcknowledgedVersion"])
      .where("id", "=", connection.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    // The first catalog is trusted as the connection's baseline. Later drift
    // remains visible across refreshes until a manager explicitly acknowledges
    // the exact observed version.
    const acknowledgedVersion = autoAcknowledge
      ? catalogVersion
      : current.catalogAcknowledgedVersion ?? current.catalogVersion ?? catalogVersion;

    await trx
      .updateTable("toolConnections")
      .set({
        catalogVersion,
        catalogAcknowledgedVersion: acknowledgedVersion,
        catalogChanged: acknowledgedVersion !== catalogVersion,
        healthStatus: "healthy",
        healthCheckedAt: now,
        healthErrorCode: null,
        updatedAt: now
      })
      .where("id", "=", connection.id)
      .execute();
  });
}

export async function acknowledgeConnectionCatalog(
  principal: ToolsPrincipal,
  connectionId: string
): Promise<{ connectionId: string; catalogVersion: string }> {
  const connection = await requireConnectionForManagement(principal, connectionId);
  if (!connection.catalogVersion) {
    throw new ToolError(
      "catalog_unavailable",
      "Discover the connection catalog before acknowledging it",
      409
    );
  }

  const result = await getDb()
    .updateTable("toolConnections")
    .set({
      catalogAcknowledgedVersion: connection.catalogVersion,
      catalogChanged: false,
      updatedAt: new Date()
    })
    .where("id", "=", connection.id)
    .where("catalogVersion", "=", connection.catalogVersion)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) {
    throw new ToolError(
      "catalog_changed",
      "The catalog changed while it was being acknowledged; review the latest definitions",
      409
    );
  }
  return { connectionId: connection.id, catalogVersion: connection.catalogVersion };
}

// ---------------------------------------------------------------------------
// Internal helpers (also used by the invocation gateway).
// ---------------------------------------------------------------------------

export async function getConnectionRow(connectionId: string): Promise<ToolConnectionRow> {
  if (!isUuid(connectionId)) {
    throw new ToolError("connection_not_found", "Tool connection was not found", 404);
  }
  const row = await getDb()
    .selectFrom("toolConnections")
    .selectAll()
    .where("id", "=", connectionId)
    .executeTakeFirst();
  if (!row) {
    throw new ToolError("connection_not_found", "Tool connection was not found", 404);
  }
  return row;
}

/** A connection the principal is allowed to see and use (read/invoke). */
export async function requireVisibleConnection(
  principal: ToolsPrincipal,
  connectionId: string
): Promise<ToolConnectionRow> {
  const row = await getConnectionRow(connectionId);
  const visible =
    row.organizationId === principal.organizationId &&
    (row.ownerUserId === null || row.ownerUserId === principal.userId);
  if (!visible) {
    // Do not distinguish "not found" from "not yours": never confirm the
    // existence of another user's private connection.
    throw new ToolError("connection_not_found", "Tool connection was not found", 404);
  }
  return row;
}

/** A connection the principal may manage (edit/delete). */
async function requireConnectionForManagement(
  principal: ToolsPrincipal,
  connectionId: string
): Promise<ToolConnectionRow> {
  const row = await requireVisibleConnection(principal, connectionId);
  if (row.ownerUserId === null && principal.role !== "admin") {
    throw new ToolError(
      "forbidden",
      "Only organization administrators can manage organization connections",
      403
    );
  }
  return row;
}

/**
 * Resolve the plaintext credential for a call as the given subject. Returns null
 * when the connection uses no credential. An organization service credential
 * (subjectUserId null) is used for organization-scoped connections; a
 * user-delegated credential is bound to the invoking user.
 */
export async function resolveCredential(
  connection: ToolConnectionRow,
  subjectUserId: string
): Promise<string | null> {
  if (connection.credentialMode === "none") {
    return null;
  }

  const wantSubject =
    connection.credentialMode === "user_delegated" ? subjectUserId : null;

  // Branch the query so the null-subject (organization service credential) case
  // uses `is null` and the user-delegated case uses `=`, without a type cast.
  const baseQuery = getDb()
    .selectFrom("toolCredentialBindings")
    .selectAll()
    .where("connectionId", "=", connection.id);
  const binding = await (wantSubject === null
    ? baseQuery.where("subjectUserId", "is", null)
    : baseQuery.where("subjectUserId", "=", wantSubject)
  ).executeTakeFirst();

  if (!binding) {
    throw new ToolError(
      "credential_missing",
      "No credential is configured for this connection",
      409
    );
  }

  const context = {
    connectionId: connection.id,
    subjectUserId: binding.subjectUserId ?? "organization"
  };
  try {
    const plaintext = await decryptSecret(binding.encryptedSecret, context);
    if (await secretEnvelopeNeedsRotation(binding.encryptedSecret)) {
      await getDb()
        .updateTable("toolCredentialBindings")
        .set({
          encryptedSecret: await encryptSecret(plaintext, context),
          updatedAt: new Date()
        })
        .where("id", "=", binding.id)
        .execute();
    }
    return plaintext;
  } catch (error) {
    if (error instanceof SecretError) {
      throw new ToolError(error.code, error.message, error.status, error);
    }
    throw error;
  }
}

async function storeCredential(
  trx: Transaction<Database>,
  params: {
    connectionId: string;
    subjectUserId: string | null;
    secret: string;
    now: Date;
  }
): Promise<void> {
  let encryptedSecret: string;
  try {
    encryptedSecret = await encryptSecret(params.secret, {
      connectionId: params.connectionId,
      subjectUserId: params.subjectUserId ?? "organization"
    });
  } catch (error) {
    if (error instanceof SecretError) {
      throw new ToolError(error.code, error.message, error.status, error);
    }
    throw error;
  }

  // Replace any existing binding for this (connection, subject). ON CONFLICT is
  // avoided because the uniqueness is enforced by two partial indexes (one for
  // the null-subject service credential, one per user), which column inference
  // cannot target.
  const deleteExisting = trx
    .deleteFrom("toolCredentialBindings")
    .where("connectionId", "=", params.connectionId);
  await (params.subjectUserId === null
    ? deleteExisting.where("subjectUserId", "is", null)
    : deleteExisting.where("subjectUserId", "=", params.subjectUserId)
  ).execute();

  await trx
    .insertInto("toolCredentialBindings")
    .values({
      connectionId: params.connectionId,
      subjectUserId: params.subjectUserId,
      encryptedSecret,
      createdAt: params.now,
      updatedAt: params.now
    })
    .execute();
}

async function credentialPresence(
  connectionIds: string[]
): Promise<Set<string>> {
  if (connectionIds.length === 0) {
    return new Set();
  }
  const rows = await getDb()
    .selectFrom("toolCredentialBindings")
    .select("connectionId")
    .where("connectionId", "in", connectionIds)
    .execute();
  return new Set(rows.map((row) => row.connectionId));
}

function normalizeEndpoint(
  source: ToolSource,
  endpoint: CreateToolConnectionRequest["endpoint"]
): unknown {
  if (source === "native") {
    return {};
  }
  if (source === "mcp") {
    if (endpoint?.headers && Object.keys(endpoint.headers).length > 0) {
      throw new ToolError(
        "invalid_endpoint",
        "Static endpoint headers are not supported; use an encrypted credential binding"
      );
    }
    // Validate structure now so an invalid URL fails at create time. Surface the
    // connector's error as a structured ToolError so the API reports a specific
    // code instead of a generic gateway failure.
    try {
      return parseMcpConfig({
        url: endpoint?.url
      });
    } catch (error) {
      if (error instanceof ConnectorError) {
        throw new ToolError(error.code, error.message, error.status, error);
      }
      throw error;
    }
  }
  if (source === "openapi") {
    if (endpoint?.headers && Object.keys(endpoint.headers).length > 0) {
      throw new ToolError(
        "invalid_endpoint",
        "Static endpoint headers are not supported; use an encrypted credential binding"
      );
    }
    try {
      return parseOpenApiConfig({ url: endpoint?.url });
    } catch (error) {
      if (error instanceof ConnectorError) {
        throw new ToolError(error.code, error.message, error.status, error);
      }
      throw error;
    }
  }
  return {};
}

function qualifiedName(connection: ToolConnectionRow, externalName: string): string {
  const prefix = connection.source === "native" ? "native" : connection.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${prefix || connection.source}__${externalName}`;
}

function summarizeConnection(
  row: ToolConnectionRow,
  credentialFlags: Set<string>
): ToolConnectionSummary {
  const endpoint =
    (row.source === "mcp" || row.source === "openapi") &&
    row.endpointConfig && typeof row.endpointConfig === "object"
      ? ((row.endpointConfig as { url?: string }).url ?? null)
      : null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    scope: row.ownerUserId ? "user" : "organization",
    ownerUserId: row.ownerUserId,
    source: row.source,
    systemManaged: row.systemKey !== null,
    label: row.label,
    endpoint,
    credentialMode: row.credentialMode,
    enabled: row.enabled,
    hasCredential: credentialFlags.has(row.id),
    catalogVersion: row.catalogVersion,
    catalogChanged: row.catalogChanged,
    health: {
      status: row.healthStatus,
      checkedAt: row.healthCheckedAt ? toIso(row.healthCheckedAt) : null,
      errorCode: row.healthErrorCode
    },
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function summarizeDefinition(
  row: ToolDefinitionRow,
  connectionPolicy: unknown
): ToolDefinitionSummary {
  return {
    id: row.id,
    connectionId: row.connectionId,
    externalName: row.externalName,
    qualifiedName: row.qualifiedName,
    title: row.title,
    description: row.description,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    annotations: row.annotations,
    definitionDigest: row.definitionDigest,
    enabled: row.enabled,
    policy: explainToolPolicy(row.annotations, connectionPolicy)
  };
}

async function updateConnectionHealth(
  connectionId: string,
  status: ToolConnectionHealth,
  errorCode: string | null
): Promise<void> {
  await getDb()
    .updateTable("toolConnections")
    .set({
      healthStatus: status,
      healthCheckedAt: new Date(),
      healthErrorCode: errorCode,
      updatedAt: new Date()
    })
    .where("id", "=", connectionId)
    .execute();
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}
