import type {
  ColumnType,
  Generated,
  Insertable,
  Selectable,
  Updateable
} from "kysely";

/** Stable identities for the built-in Lush agent's first immutable revision. */
export const builtinLushAgentId = "00000000-0000-4000-8000-000000000101";
export const builtinLushRevisionId = "00000000-0000-4000-8000-000000000102";
export const builtinLushRevisionInstructions =
  "You are Lush, a concise and practical AI agent inside the Lush app.\n\n" +
  "Answer directly, ask clarifying questions when needed, and avoid claiming tool\n" +
  "access until tools are explicitly connected.\n";
export const builtinLushRevisionDigest =
  "9370875a1a258a08f7167fa64ec72e256179bbcbaea1e8431394f4ab26b4c103";

export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export type UserRole = "admin" | "user";
export type OrganizationInviteStatus = "pending" | "accepted" | "declined";
export type AuthProviderKind = "password" | "oidc" | "oauth" | "saml";
export type WorkspaceMode = "chat" | "code" | "work" | "agents";
export type SessionMessageRole = "user" | "assistant" | "system" | "tool";
export type InferenceProviderKind =
  | "baseten"
  | "fireworks"
  | "anthropic"
  | "openai"
  | "openai-compatible";

export type InferenceModelInterface =
  | "chat-completions"
  | "messages"
  | "responses"
  | "embeddings";
export type InferenceModelInputModality =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "pdf";
export type InferenceModelOutputModality =
  | "text"
  | "image"
  | "audio"
  | "embedding";
export type InferenceModelFeature =
  | "tools"
  | "structured-output"
  | "reasoning"
  | "citations"
  | "code-execution"
  | "batch";
export type InferenceModelCapabilities = {
  interfaces?: InferenceModelInterface[];
  inputModalities?: InferenceModelInputModality[];
  outputModalities?: InferenceModelOutputModality[];
  features?: InferenceModelFeature[];
};

export type UsersTable = {
  id: Generated<string>;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type OrganizationsTable = {
  id: Generated<string>;
  name: string;
  slug: string;
  toolGatewayEnabled: Generated<boolean>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type OrganizationMembershipsTable = {
  id: Generated<string>;
  organizationId: string;
  userId: string;
  role: UserRole;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type OrganizationInvitesTable = {
  id: Generated<string>;
  organizationId: string;
  email: string;
  role: UserRole;
  status: OrganizationInviteStatus;
  tokenHash: string;
  invitedByUserId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  expiresAt: Timestamp;
  respondedAt: Timestamp | null;
};

export type AuthProvidersTable = {
  id: Generated<string>;
  organizationId: string | null;
  kind: AuthProviderKind;
  label: string;
  enabled: boolean;
  config: unknown;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type AuthIdentitiesTable = {
  id: Generated<string>;
  userId: string;
  providerId: string | null;
  providerKind: AuthProviderKind;
  subject: string;
  email: string | null;
  claims: unknown;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type PasswordCredentialsTable = {
  userId: string;
  passwordHash: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type AuthActionTokenPurpose = "verify_email" | "reset_password";

export type AuthActionTokensTable = {
  id: Generated<string>;
  userId: string;
  purpose: AuthActionTokenPurpose;
  tokenHash: string;
  expiresAt: Timestamp;
  usedAt: Timestamp | null;
  createdAt: Timestamp;
};

export type SessionsTable = {
  id: Generated<string>;
  userId: string;
  organizationId: string | null;
  membershipId: string | null;
  tokenHash: string;
  refreshFamilyHash: string | null;
  previousTokenHash: string | null;
  rotatedAt: Timestamp | null;
  userAgent: string | null;
  ipValue: string | null;
  ipMode: "off" | "hmac" | "plain" | null;
  lastSeenUserAgent: string | null;
  lastSeenIpValue: string | null;
  lastSeenIpMode: "off" | "hmac" | "plain" | null;
  createdAt: Timestamp;
  lastUsedAt: Timestamp;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
};

export type AuditEventsTable = {
  id: Generated<string>;
  organizationId: string | null;
  userId: string | null;
  sessionId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  createdAt: Timestamp;
};

export type InferenceProvidersTable = {
  id: Generated<string>;
  organizationId: string;
  kind: InferenceProviderKind;
  label: string;
  baseUrl: string;
  encryptedApiKey: string;
  enabled: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type InferenceProviderModelsTable = {
  id: Generated<string>;
  providerId: string;
  modelId: string;
  label: string;
  capabilities: InferenceModelCapabilities;
  enabled: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type InferenceModelDefaultsTable = {
  organizationId: string;
  mode: WorkspaceMode;
  modelSelection: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type SessionThreadsTable = {
  id: Generated<string>;
  organizationId: string;
  ownerUserId: string;
  title: string;
  agentId: string;
  agentInstallationId: Generated<string | null>;
  agentRevisionId: Generated<string | null>;
  currentRunId: Generated<string | null>;
  projectId: string | null;
  pinnedAt: Timestamp | null;
  stateBytes: number;
  version: number;
  deleted: boolean;
  deletedAt: Timestamp | null;
  deleteAfter: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archivedAt: Timestamp | null;
};

export type ProjectsTable = {
  id: Generated<string>;
  organizationId: string;
  ownerUserId: string;
  name: string;
  instructions: string;
  memory: string;
  pinnedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ProjectContextItemsTable = {
  id: Generated<string>;
  projectId: string;
  organizationId: string;
  ownerUserId: string;
  filename: string;
  mediaType: string;
  content: string;
  byteSize: number;
  createdAt: Timestamp;
};

export type SessionMessagesTable = {
  id: Generated<string>;
  threadId: string;
  organizationId: string;
  authorUserId: string | null;
  role: SessionMessageRole;
  content: string;
  metadata: unknown;
  tokenCount: number | null;
  byteSize: number;
  createdAt: Timestamp;
  supersededAt: NullableTimestamp;
};

export type SessionStateSnapshotsTable = {
  id: Generated<string>;
  threadId: string;
  organizationId: string;
  kind: string;
  state: unknown;
  byteSize: number;
  createdAt: Timestamp;
};

export type SessionAttachmentsTable = {
  id: Generated<string>;
  threadId: string;
  organizationId: string;
  artifactId: string;
  label: string;
  mimeType: string | null;
  byteSize: number;
  createdAt: Timestamp;
};

export type OrganizationSessionSettingsTable = {
  organizationId: string;
  retentionSeconds: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ToolSource = "mcp" | "openapi" | "native";
export type ToolCredentialMode = "none" | "organization" | "user_delegated";
export type ToolCallStatus =
  | "proposed"
  | "waiting_for_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "outcome_unknown"
  | "cancelled";
export type ToolApprovalScope =
  | "once"
  | "once_per_run"
  | "once_per_resource"
  | "every_call";
export type ToolApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "needs_acknowledgment"
  | "completed"
  | "failed"
  | "cancelled";
export type AgentEnvironmentStatus =
  | "provisioning"
  | "ready"
  | "running"
  | "idle"
  | "hibernated"
  | "failed"
  | "destroyed";

export type ManagedAgentsTable = {
  id: Generated<string>;
  organizationId: string | null;
  slug: string;
  name: string;
  systemOwned: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ManagedAgentRevisionsTable = {
  id: Generated<string>;
  agentId: string;
  version: number;
  instructions: string;
  modelPolicy: unknown;
  executionProfile: "chat" | "code" | "work";
  limits: unknown;
  digest: string;
  createdAt: Timestamp;
  publishedAt: Timestamp;
};

export type AgentInstallationsTable = {
  id: Generated<string>;
  organizationId: string;
  agentId: string;
  ownerUserId: string | null;
  status: "active" | "disabled";
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type AgentInstallationRevisionsTable = {
  id: Generated<string>;
  installationId: string;
  agentRevisionId: string;
  parentInstallationRevisionId: string | null;
  additionalInstructions: string;
  capabilityPolicy: unknown;
  modelOverride: unknown | null;
  digest: string;
  createdAt: Timestamp;
};

export type AgentEnvironmentsTable = {
  id: Generated<string>;
  organizationId: string;
  ownerUserId: string;
  sessionId: string;
  profile: "chat" | "code" | "work";
  status: AgentEnvironmentStatus;
  isolationProvider: string;
  backendHandle: string | null;
  imageDigest: string;
  limits: unknown;
  leaseExpiresAt: Timestamp | null;
  retentionUntil: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  destroyedAt: Timestamp | null;
};

export type AgentRunsTable = {
  id: Generated<string>;
  organizationId: string;
  sessionId: string;
  originMessageId: string;
  assistantMessageId: string | null;
  initiatedByUserId: string;
  agentRevisionId: string;
  environmentId: string;
  status: AgentRunStatus;
  purpose: "chat" | "title";
  idempotencyKey: string;
  startDigest: string;
  capabilityDigest: string;
  configurationDigest: string;
  configuration: unknown;
  isolationProvider: string;
  untrustedContentIngested: boolean;
  limits: unknown;
  modelSelection: string;
  errorCode: string | null;
  errorMessage: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  cancelledAt: Timestamp | null;
};

export type AgentRunInstallationRevisionsTable = {
  runId: string;
  installationRevisionId: string;
  organizationId: string;
};

export type AgentRunCapabilitiesTable = {
  id: Generated<string>;
  runId: string;
  organizationId: string;
  principalUserId: string;
  snapshot: unknown;
  digest: string;
  revokedAt: Timestamp | null;
  createdAt: Timestamp;
};

export type AgentRunEventsTable = {
  id: Generated<string>;
  runId: string;
  organizationId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: Timestamp;
};

export type AgentRunArtifactsTable = {
  id: Generated<string>;
  runId: string;
  organizationId: string;
  artifactId: string;
  kind: string;
  createdAt: Timestamp;
};

export type AgentRunAcknowledgmentsTable = {
  id: Generated<string>;
  runId: string;
  organizationId: string;
  toolCallId: string;
  decidedByUserId: string;
  decision: "retry" | "abandon";
  inputDigest: string;
  toolDefinitionDigest: string;
  createdAt: Timestamp;
};

export type ToolAnnotations = {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};

export type ToolConnectionHealth = "unknown" | "healthy" | "unhealthy";

export type ToolConnectionsTable = {
  id: Generated<string>;
  organizationId: string;
  ownerUserId: string | null;
  source: ToolSource;
  /** Stable identity for code-owned catalogs; null for user-managed connections. */
  systemKey: Generated<string | null>;
  label: string;
  endpointConfig: unknown;
  credentialMode: ToolCredentialMode;
  enabled: boolean;
  policy: unknown;
  catalogVersion: string | null;
  catalogAcknowledgedVersion: string | null;
  catalogChanged: boolean;
  healthStatus: ToolConnectionHealth;
  healthCheckedAt: Timestamp | null;
  healthErrorCode: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ToolCredentialBindingsTable = {
  id: Generated<string>;
  connectionId: string;
  subjectUserId: string | null;
  encryptedSecret: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ToolDefinitionsTable = {
  id: Generated<string>;
  connectionId: string;
  externalName: string;
  qualifiedName: string;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown | null;
  annotations: ToolAnnotations;
  /** Connector-owned invocation metadata. Never exposed as policy. */
  sourceMetadata: unknown;
  definitionDigest: string;
  enabled: boolean;
  timeoutMs: Generated<number | null>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ToolCallsTable = {
  id: Generated<string>;
  organizationId: string;
  connectionId: string;
  toolDefinitionId: string | null;
  runId: string | null;
  initiatedByUserId: string;
  status: ToolCallStatus;
  input: unknown;
  inputDigest: string;
  definitionDigest: string;
  outputPreview: unknown | null;
  outputRef: string | null;
  isError: boolean;
  policyDecision: unknown | null;
  idempotencyKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Timestamp;
  completedAt: Timestamp | null;
};

export type ToolApprovalsTable = {
  id: Generated<string>;
  organizationId: string;
  toolCallId: string | null;
  connectionId: string;
  toolDefinitionId: string;
  runId: string | null;
  initiatedByUserId: string;
  inputDigest: string;
  definitionDigest: string;
  scope: ToolApprovalScope;
  status: ToolApprovalStatus;
  decidedByUserId: string | null;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  decidedAt: Timestamp | null;
};

export type LushMigrationsTable = {
  id: string;
  appliedAt: Timestamp;
};

export type Database = {
  lushMigrations: LushMigrationsTable;
  users: UsersTable;
  organizations: OrganizationsTable;
  organizationMemberships: OrganizationMembershipsTable;
  organizationInvites: OrganizationInvitesTable;
  authProviders: AuthProvidersTable;
  authIdentities: AuthIdentitiesTable;
  passwordCredentials: PasswordCredentialsTable;
  authActionTokens: AuthActionTokensTable;
  sessions: SessionsTable;
  auditEvents: AuditEventsTable;
  inferenceProviders: InferenceProvidersTable;
  inferenceProviderModels: InferenceProviderModelsTable;
  inferenceModelDefaults: InferenceModelDefaultsTable;
  sessionThreads: SessionThreadsTable;
  projects: ProjectsTable;
  projectContextItems: ProjectContextItemsTable;
  sessionMessages: SessionMessagesTable;
  sessionStateSnapshots: SessionStateSnapshotsTable;
  sessionAttachments: SessionAttachmentsTable;
  organizationSessionSettings: OrganizationSessionSettingsTable;
  toolConnections: ToolConnectionsTable;
  toolCredentialBindings: ToolCredentialBindingsTable;
  toolDefinitions: ToolDefinitionsTable;
  toolCalls: ToolCallsTable;
  toolApprovals: ToolApprovalsTable;
  managedAgents: ManagedAgentsTable;
  managedAgentRevisions: ManagedAgentRevisionsTable;
  agentInstallations: AgentInstallationsTable;
  agentInstallationRevisions: AgentInstallationRevisionsTable;
  agentEnvironments: AgentEnvironmentsTable;
  agentRuns: AgentRunsTable;
  agentRunInstallationRevisions: AgentRunInstallationRevisionsTable;
  agentRunCapabilities: AgentRunCapabilitiesTable;
  agentRunEvents: AgentRunEventsTable;
  agentRunArtifacts: AgentRunArtifactsTable;
  agentRunAcknowledgments: AgentRunAcknowledgmentsTable;
};

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type Organization = Selectable<OrganizationsTable>;
export type OrganizationMembership = Selectable<OrganizationMembershipsTable>;
export type Session = Selectable<SessionsTable>;
export type SessionThreadRow = Selectable<SessionThreadsTable>;
export type ProjectRow = Selectable<ProjectsTable>;
export type ProjectContextItemRow = Selectable<ProjectContextItemsTable>;
export type SessionMessageRow = Selectable<SessionMessagesTable>;
export type SessionStateSnapshotRow = Selectable<SessionStateSnapshotsTable>;
export type InferenceProviderRow = Selectable<InferenceProvidersTable>;
export type InferenceProviderModelRow = Selectable<InferenceProviderModelsTable>;
export type ToolConnectionRow = Selectable<ToolConnectionsTable>;
export type ToolCredentialBindingRow = Selectable<ToolCredentialBindingsTable>;
export type ToolDefinitionRow = Selectable<ToolDefinitionsTable>;
export type ToolCallRow = Selectable<ToolCallsTable>;
export type ToolApprovalRow = Selectable<ToolApprovalsTable>;
export type ManagedAgentRow = Selectable<ManagedAgentsTable>;
export type ManagedAgentRevisionRow = Selectable<ManagedAgentRevisionsTable>;
export type AgentInstallationRow = Selectable<AgentInstallationsTable>;
export type AgentEnvironmentRow = Selectable<AgentEnvironmentsTable>;
export type AgentRunRow = Selectable<AgentRunsTable>;
export type AgentRunEventRow = Selectable<AgentRunEventsTable>;
