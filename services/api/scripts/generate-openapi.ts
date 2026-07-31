import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { apiSpec } from "../src/spec";

type JsonSchema = Record<string, unknown>;

type Operation = {
  summary: string;
  description?: string;
  operationId: string;
  tags: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{
    name: string;
    in: "path" | "query";
    required: boolean;
    description?: string;
    schema: JsonSchema;
  }>;
  requestBody?: {
    required: boolean;
    description?: string;
    content: {
      "application/json": {
        schema: JsonSchema;
      };
    };
  };
  responses: Record<
    string,
    {
      description: string;
      content?: {
        "application/json"?: {
          schema: JsonSchema;
        };
        "text/plain"?: {
          schema: JsonSchema;
        };
        "application/x-ndjson"?: {
          schema: JsonSchema;
        };
      };
    }
  >;
};

type OpenApiDocument = {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, Operation>>;
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http";
        scheme: "bearer";
        bearerFormat: "JWT";
      };
    };
    schemas: Record<string, JsonSchema>;
  };
};

const outputDir = resolve(import.meta.dir, "../../docs/generated/openapi");

const schemas: Record<string, JsonSchema> = {
  UserRole: describeSchema(
    enumSchema(["admin", "user"]),
    "Membership role for a user within an organization."
  ),
  OrganizationInviteStatus: describeSchema(
    enumSchema(["pending", "accepted", "declined"]),
    "Lifecycle status for an organization invite."
  ),
  AuthRefreshReason: describeSchema(
    enumSchema([
      "claims_changed",
      "membership_changed",
      "organization_changed",
      "session_revoked"
    ]),
    "Debug reason for an auth refresh invalidation event."
  ),
  ClientEvent: objectSchema({
    type: describeSchema(
      { type: "string", const: "auth.refresh_required" },
      "Event type. Clients should force-refresh auth state for this event."
    ),
    reason: describeSchema(
      ref("AuthRefreshReason"),
      "Reason supplied for logging and diagnostics; client behavior is the same for every reason."
    )
  }, ["type", "reason"], "Server-sent client event payload."),
  WorkspaceMode: describeSchema(
    enumSchema(["chat", "code", "work", "agents"]),
    "Workspace mode that owns a model default."
  ),
  SessionMessageRole: describeSchema(
    enumSchema(["user", "assistant", "system", "tool"]),
    "Role for a persisted session message."
  ),
  InferenceProviderKind: describeSchema(
    enumSchema([
      "baseten",
      "fireworks",
      "anthropic",
      "openai",
      "openai-compatible"
    ]),
    "Supported inference provider adapter kind."
  ),
  RegisterAccountRequest: objectSchema({
    email: describeSchema(
      stringSchema("email"),
      "Email address used for sign-in and verification."
    ),
    password: describeSchema(
      stringSchema(undefined, 8, 512),
      "Password for the account. Must be between 8 and 512 characters."
    ),
    displayName: describeSchema(
      stringSchema(),
      "Human-readable name shown in the app. Defaults to the email prefix."
    ),
    organizationName: describeSchema(
      stringSchema(),
      "Initial organization name. Defaults to an organization derived from the display name."
    )
  }, ["email", "password"], "Creates an email/password account and an initial organization."),
  EmailVerificationRequired: objectSchema({
    emailVerificationRequired: describeSchema(
      { type: "boolean", const: true },
      "Always true for password registration responses."
    ),
    email: describeSchema(
      stringSchema("email"),
      "Email address that must be verified before login succeeds."
    )
  }, ["emailVerificationRequired", "email"], "Registration response indicating the email verification gate."),
  LoginRequest: objectSchema({
    email: describeSchema(stringSchema("email"), "Verified account email address."),
    password: describeSchema(stringSchema(), "Account password."),
    organizationId: describeSchema(
      stringSchema("uuid"),
      "Optional organization to enter when the user belongs to more than one organization."
    )
  }, ["email", "password"], "Email/password login payload."),
  VerifyEmailRequest: objectSchema({
    token: describeSchema(stringSchema(), "Single-use email verification token.")
  }, ["token"], "Completes email verification using the token delivered to the mailbox."),
  RequestPasswordResetRequest: objectSchema({
    email: describeSchema(stringSchema("email"), "Account email address.")
  }, ["email"], "Requests a password-reset email without revealing whether the account exists."),
  ResetPasswordRequest: objectSchema({
    token: describeSchema(stringSchema(), "Single-use password-reset token."),
    password: describeSchema(
      stringSchema(undefined, 8, 512),
      "Replacement password. Must be between 8 and 512 characters."
    )
  }, ["token", "password"], "Replaces the password and revokes every active session."),
  AuthActionResponse: objectSchema({
    ok: { type: "boolean", const: true }
  }, ["ok"], "Authentication action acknowledgement."),
  LogoutRequest: emptyObjectSchema("Logout request body. Send an empty JSON object."),
  RefreshSessionRequest: emptyObjectSchema("Refresh request body. Send an empty JSON object; the refresh cookie supplies the session."),
  LogoutAllSessionsRequest: emptyObjectSchema("Logout-all request body. Send an empty JSON object."),
  UpdateCurrentUserRequest: objectSchema({
    displayName: describeSchema(
      stringSchema(),
      "Human-readable display name to store for the authenticated user."
    )
  }, ["displayName"], "Updates the authenticated user's profile."),
  UpdateCurrentOrganizationRequest: objectSchema({
    name: describeSchema(
      stringSchema(),
      "Organization display name to store for the active organization."
    )
  }, ["name"], "Updates the active organization."),
  OrganizationSummary: objectSchema({
    id: describeSchema(stringSchema("uuid"), "Organization identifier."),
    name: describeSchema(stringSchema(), "Organization display name."),
    role: describeSchema(ref("UserRole"), "Caller role in the organization.")
  }, ["id", "name", "role"], "Organization membership visible to the current user."),
  ListOrganizationsResponse: objectSchema({
    activeOrganizationId: describeSchema(
      nullableSchema(stringSchema("uuid")),
      "Active organization for the current session, or null when one must be created."
    ),
    organizations: describeSchema(
      arraySchema(ref("OrganizationSummary")),
      "Organizations the current user belongs to."
    )
  }, ["activeOrganizationId", "organizations"], "Organizations available to the current user."),
  SwitchOrganizationRequest: objectSchema({
    organizationId: describeSchema(stringSchema("uuid"), "Organization to make active for the current session.")
  }, ["organizationId"], "Switches the active organization."),
  CreateOrganizationRequest: objectSchema({
    name: describeSchema(stringSchema(), "Display name for the new organization.")
  }, ["name"], "Creates a new organization."),
  DeleteCurrentOrganizationRequest: emptyObjectSchema("Delete-organization request body. Send an empty JSON object."),
  DeleteCurrentOrganizationResponse: {
    oneOf: [
      objectSchema({
        requiresOrganization: describeSchema({ type: "boolean", const: false }, "False when another organization is active after deletion."),
        nextSession: describeSchema(ref("AccessSession"), "Rotated access session.")
      }, ["requiresOrganization", "nextSession"]),
      objectSchema({
        requiresOrganization: describeSchema({ type: "boolean", const: true }, "True when the user must create a new organization."),
        nextSession: describeSchema(ref("AccessSession"), "Rotated orgless access session.")
      }, ["requiresOrganization", "nextSession"])
    ],
    description: "Delete-organization response with the next session state."
  },
  OrganizationMember: objectSchema({
    membershipId: describeSchema(stringSchema("uuid"), "Membership identifier."),
    userId: describeSchema(stringSchema("uuid"), "User identifier."),
    email: describeSchema(stringSchema("email"), "Member email address."),
    displayName: describeSchema(stringSchema(), "Member display name."),
    role: describeSchema(ref("UserRole"), "Member role.")
  }, ["membershipId", "userId", "email", "displayName", "role"], "Organization member."),
  ListOrganizationMembersResponse: objectSchema({
    members: describeSchema(arraySchema(ref("OrganizationMember")), "Members in the active organization.")
  }, ["members"], "Active organization members."),
  UpdateOrganizationMemberRoleRequest: objectSchema({
    membershipId: describeSchema(stringSchema("uuid"), "Membership to update."),
    role: describeSchema(ref("UserRole"), "New role for the member.")
  }, ["membershipId", "role"], "Updates an organization member role."),
  RemoveOrganizationMemberRequest: objectSchema({
    membershipId: describeSchema(stringSchema("uuid"), "Membership to remove.")
  }, ["membershipId"], "Removes a member from the active organization."),
  CreateOrganizationInviteRequest: objectSchema({
    email: describeSchema(stringSchema("email"), "Email address to invite."),
    role: describeSchema(ref("UserRole"), "Role to grant when the invite is accepted."),
    expiresInDays: describeSchema(
      { type: "integer", minimum: 1, maximum: 30 },
      "Optional expiration window in days. Defaults to 14."
    )
  }, ["email", "role"], "Creates a pending organization invite."),
  OrganizationInvite: objectSchema({
    id: describeSchema(stringSchema("uuid"), "Invite identifier."),
    email: describeSchema(stringSchema("email"), "Invited email address."),
    role: describeSchema(ref("UserRole"), "Role to grant on acceptance."),
    status: describeSchema(ref("OrganizationInviteStatus"), "Invite status."),
    invitedByUserId: describeSchema(nullableSchema(stringSchema("uuid")), "User that created the invite."),
    createdAt: describeSchema(stringSchema("date-time"), "Invite creation timestamp."),
    expiresAt: describeSchema(stringSchema("date-time"), "Invite expiration timestamp."),
    respondedAt: describeSchema(nullableSchema(stringSchema("date-time")), "Accepted or declined timestamp.")
  }, ["id", "email", "role", "status", "invitedByUserId", "createdAt", "expiresAt", "respondedAt"], "Organization invite."),
  CreateOrganizationInviteResponse: objectSchema({
    invite: describeSchema(ref("OrganizationInvite"), "Created invite.")
  }, ["invite"], "Created invite response."),
  ListOrganizationInvitesResponse: objectSchema({
    invites: describeSchema(arraySchema(ref("OrganizationInvite")), "Invites for the active organization.")
  }, ["invites"], "Active organization invites."),
  RespondToOrganizationInviteRequest: objectSchema({
    token: describeSchema(stringSchema(), "Secret token from the invitation email."),
    response: describeSchema(enumSchema(["accepted", "declined"]), "Invitation response.")
  }, ["token", "response"], "Accepts or declines an organization invitation."),
  RespondToOrganizationInviteResponse: objectSchema({
    invite: describeSchema(ref("OrganizationInvite"), "Updated invitation."),
    organization: describeSchema(objectSchema({
      id: describeSchema(stringSchema("uuid"), "Organization identifier."),
      name: describeSchema(stringSchema(), "Organization name.")
    }, ["id", "name"], "Inviting organization."), "Inviting organization.")
  }, ["invite", "organization"], "Organization invitation response."),
  CurrentSession: objectSchema({
    sessionId: describeSchema(stringSchema("uuid"), "Refresh-session identifier."),
    user: describeSchema(ref("CurrentSessionUser"), "Authenticated user profile."),
    organization: describeSchema(nullableSchema(ref("CurrentSessionOrganization")), "Active organization for the session."),
    membership: describeSchema(nullableSchema(ref("CurrentSessionMembership")), "Membership connecting the user to the active organization."),
    createdAt: describeSchema(stringSchema("date-time"), "Session creation timestamp."),
    expiresAt: describeSchema(stringSchema("date-time"), "Refresh-session expiration timestamp.")
  }, ["sessionId", "user", "organization", "membership", "createdAt", "expiresAt"], "Session profile returned to authenticated clients."),
  CurrentSessionUser: objectSchema({
    id: describeSchema(stringSchema("uuid"), "User identifier."),
    email: describeSchema(stringSchema("email"), "User email address."),
    emailVerified: describeSchema({ type: "boolean" }, "Whether the email principal has been verified."),
    displayName: describeSchema(stringSchema(), "Human-readable display name.")
  }, ["id", "email", "emailVerified", "displayName"], "Authenticated user details."),
  CurrentSessionOrganization: objectSchema({
    id: describeSchema(stringSchema("uuid"), "Organization identifier."),
    name: describeSchema(stringSchema(), "Organization display name.")
  }, ["id", "name"], "Active organization details."),
  CurrentSessionMembership: objectSchema({
    id: describeSchema(stringSchema("uuid"), "Membership identifier."),
    role: describeSchema(ref("UserRole"), "Role granted to the user in the active organization.")
  }, ["id", "role"], "Active organization membership details."),
  AccessSession: objectSchema({
    accessToken: describeSchema(stringSchema(), "Short-lived bearer JWT for API and backing-service requests."),
    accessTokenExpiresAt: describeSchema(stringSchema("date-time"), "Access-token expiration timestamp."),
    session: describeSchema(ref("CurrentSession"), "Current authenticated session profile.")
  }, ["accessToken", "accessTokenExpiresAt", "session"], "Login or refresh response containing an access token and session profile."),
  RegisterAccountResponse: describeSchema(
    ref("EmailVerificationRequired"),
    "Response returned after account registration."
  ),
  ModelDefaults: {
    type: "object",
    additionalProperties: false,
    description: "Default model selection for each workspace mode.",
    required: ["chat", "code", "work", "agents"],
    properties: {
      chat: describeSchema(stringSchema(), "Default model selection for chat."),
      code: describeSchema(stringSchema(), "Default model selection for code workflows."),
      work: describeSchema(stringSchema(), "Default model selection for work workflows."),
      agents: describeSchema(stringSchema(), "Default model selection for agent workflows.")
    }
  },
  InferenceModelInterface: {
    type: "string",
    enum: ["chat-completions", "messages", "responses", "embeddings"]
  },
  InferenceModelInputModality: {
    type: "string",
    enum: ["text", "image", "audio", "video", "pdf"]
  },
  InferenceModelOutputModality: {
    type: "string",
    enum: ["text", "image", "audio", "embedding"]
  },
  InferenceModelFeature: {
    type: "string",
    enum: [
      "tools",
      "structured-output",
      "reasoning",
      "citations",
      "code-execution",
      "batch"
    ]
  },
  InferenceModelCapabilities: objectSchema({
    interfaces: describeSchema(
      arraySchema(ref("InferenceModelInterface")),
      "Provider interfaces known to accept this model."
    ),
    inputModalities: describeSchema(
      arraySchema(ref("InferenceModelInputModality")),
      "Input modalities positively identified for this model."
    ),
    outputModalities: describeSchema(
      arraySchema(ref("InferenceModelOutputModality")),
      "Output modalities positively identified for this model."
    ),
    features: describeSchema(
      arraySchema(ref("InferenceModelFeature")),
      "Optional model features positively identified by the provider."
    )
  }, [], "Partial capability facts. Omitted fields are unknown, not unsupported."),
  InferenceModelStatus: objectSchema({
    id: describeSchema(stringSchema(), "Provider-native model identifier."),
    label: describeSchema(stringSchema(), "Display label for the model."),
    capabilities: describeSchema(
      ref("InferenceModelCapabilities"),
      "Provider-reported or provider-contract model capabilities."
    ),
    enabled: describeSchema({ type: "boolean" }, "Whether users can select this model.")
  }, ["id", "label", "capabilities", "enabled"], "Model availability exposed by a configured inference provider."),
  InferenceProviderStatus: objectSchema({
    id: describeSchema(stringSchema("uuid"), "Provider configuration identifier."),
    kind: describeSchema(ref("InferenceProviderKind"), "Provider adapter kind."),
    label: describeSchema(stringSchema(), "Display label for the provider."),
    configured: describeSchema({ type: "boolean" }, "Whether the provider has a stored API key."),
    enabled: describeSchema({ type: "boolean" }, "Whether the provider can be used for inference."),
    baseUrl: describeSchema(stringSchema("uri"), "Base URL used for provider requests."),
    models: describeSchema(arraySchema(ref("InferenceModelStatus")), "Models currently known for this provider.")
  }, ["id", "kind", "label", "configured", "enabled", "baseUrl", "models"], "Organization-scoped inference provider configuration status."),
  InferenceConfig: objectSchema({
    organizationId: describeSchema(stringSchema("uuid"), "Organization that owns this inference configuration."),
    modelDefaults: describeSchema(ref("ModelDefaults"), "Mode-specific default model selections."),
    providers: describeSchema(arraySchema(ref("InferenceProviderStatus")), "Configured inference providers for the organization.")
  }, ["organizationId", "modelDefaults", "providers"], "Complete inference configuration for the active organization."),
  AddInferenceProviderRequest: objectSchema({
    kind: describeSchema(ref("InferenceProviderKind"), "Provider adapter kind."),
    label: describeSchema(stringSchema(), "Display label for the provider."),
    apiKey: describeSchema(stringSchema(), "Provider API key. Stored server-side and never returned."),
    baseUrl: describeSchema(
      stringSchema("uri"),
      "Optional OpenAI-compatible base URL override for providers that support it."
    )
  }, ["kind", "label", "apiKey"], "Adds an organization-scoped inference provider."),
  UpdateInferenceProviderRequest: objectSchema({
    providerId: describeSchema(stringSchema("uuid"), "Provider configuration identifier."),
    enabled: describeSchema({ type: "boolean" }, "Whether the provider can be used for inference.")
  }, ["providerId", "enabled"], "Updates provider availability."),
  RefreshInferenceProviderModelsRequest: objectSchema({
    providerId: describeSchema(stringSchema("uuid"), "Provider configuration identifier.")
  }, ["providerId"], "Refreshes the models available from an inference provider."),
  UpdateInferenceModelRequest: objectSchema({
    providerId: describeSchema(stringSchema("uuid"), "Provider configuration identifier."),
    modelId: describeSchema(stringSchema(), "Provider-native model identifier."),
    enabled: describeSchema({ type: "boolean" }, "Whether users can select this model.")
  }, ["providerId", "modelId", "enabled"], "Updates availability for a provider model."),
  DeleteInferenceProviderRequest: objectSchema({
    providerId: describeSchema(stringSchema("uuid"), "Provider configuration identifier.")
  }, ["providerId"], "Deletes an inference provider configuration."),
  UpdateInferenceModelDefaultRequest: objectSchema({
    mode: describeSchema(ref("WorkspaceMode"), "Workspace mode to update."),
    modelSelection: describeSchema(
      stringSchema(),
      "Model selection in provider/model form as returned by inference configuration."
    )
  }, ["mode", "modelSelection"], "Updates the default model selection for a workspace mode."),
  SessionSummary: objectSchema({
    id: describeSchema(stringSchema("uuid"), "Session identifier."),
    organizationId: describeSchema(stringSchema("uuid"), "Organization that owns the session."),
    ownerUserId: describeSchema(stringSchema("uuid"), "User that owns the session."),
    title: describeSchema(stringSchema(), "Display title for the session."),
    agentId: describeSchema(stringSchema(), "Agent identifier that owns or interprets this session."),
    stateBytes: describeSchema({ type: "integer", minimum: 0 }, "Stored session bytes counted against the session limit."),
    version: describeSchema({ type: "integer", minimum: 1 }, "Monotonic version incremented by writes."),
    createdAt: describeSchema(stringSchema("date-time"), "Session creation timestamp."),
    updatedAt: describeSchema(stringSchema("date-time"), "Last session update timestamp."),
    archivedAt: describeSchema(nullableSchema(stringSchema("date-time")), "Archive timestamp, or null when active.")
  }, ["id", "organizationId", "ownerUserId", "title", "agentId", "stateBytes", "version", "createdAt", "updatedAt", "archivedAt"], "Owned session summary."),
  SessionMessage: objectSchema({
    id: describeSchema(stringSchema("uuid"), "Message identifier."),
    sessionId: describeSchema(stringSchema("uuid"), "Session identifier."),
    role: describeSchema(ref("SessionMessageRole"), "Message role."),
    content: describeSchema(stringSchema(), "Message content."),
    metadata: describeSchema({}, "Small JSON metadata associated with the message."),
    tokenCount: describeSchema(nullableSchema({ type: "integer", minimum: 0 }), "Optional token count."),
    byteSize: describeSchema({ type: "integer", minimum: 0 }, "Bytes counted against the session limit."),
    createdAt: describeSchema(stringSchema("date-time"), "Message creation timestamp.")
  }, ["id", "sessionId", "role", "content", "metadata", "tokenCount", "byteSize", "createdAt"], "Persisted session message."),
  SessionStateSnapshot: objectSchema({
    id: describeSchema(stringSchema("uuid"), "Snapshot identifier."),
    sessionId: describeSchema(stringSchema("uuid"), "Session identifier."),
    kind: describeSchema(stringSchema(), "Application-defined snapshot kind."),
    state: describeSchema({}, "JSON state snapshot."),
    byteSize: describeSchema({ type: "integer", minimum: 0 }, "Bytes counted against the session limit."),
    createdAt: describeSchema(stringSchema("date-time"), "Snapshot creation timestamp.")
  }, ["id", "sessionId", "kind", "state", "byteSize", "createdAt"], "Versioned session state snapshot."),
  Session: {
    allOf: [
      ref("SessionSummary"),
      objectSchema({
        messages: describeSchema(arraySchema(ref("SessionMessage")), "Messages in chronological order."),
        stateSnapshots: describeSchema(arraySchema(ref("SessionStateSnapshot")), "State snapshots in chronological order.")
      }, ["messages", "stateSnapshots"])
    ],
    description: "Owned session with messages and state snapshots."
  },
  ListSessionsResponse: objectSchema({
    sessions: describeSchema(arraySchema(ref("SessionSummary")), "Active, unarchived sessions owned by the current user.")
  }, ["sessions"], "Owned session list."),
  CreateSessionRequest: objectSchema({
    title: describeSchema(stringSchema(), "Optional title. Defaults to an untitled session."),
    agentId: describeSchema(stringSchema(), "Agent identifier that owns or interprets this session.")
  }, ["agentId"], "Creates a session."),
  UpdateSessionRequest: objectSchema({
    title: describeSchema(stringSchema(), "New session title.")
  }, [], "Updates session metadata."),
  AppendSessionMessageRequest: objectSchema({
    role: describeSchema(ref("SessionMessageRole"), "Message role."),
    content: describeSchema(stringSchema(), "Message content."),
    metadata: describeSchema({}, "Optional small JSON metadata."),
    tokenCount: describeSchema(nullableSchema({ type: "integer", minimum: 0 }), "Optional token count.")
  }, ["role", "content"], "Appends a message to a session."),
  AppendSessionStateRequest: objectSchema({
    kind: describeSchema(stringSchema(), "Application-defined state kind."),
    state: describeSchema({}, "JSON state payload.")
  }, ["kind", "state"], "Appends a state snapshot to a session."),
  TruncateSessionRequest: objectSchema({
    afterMessageId: describeSchema(
      nullableSchema(stringSchema("uuid")),
      "Final message to retain, or null to remove all messages."
    )
  }, ["afterMessageId"], "Truncates a session at a message boundary."),
  ArchiveSessionRequest: emptyObjectSchema("Archive-session request body. Send an empty JSON object."),
  SessionSettings: objectSchema({
    organizationId: describeSchema(stringSchema("uuid"), "Organization that owns the settings."),
    retentionSeconds: describeSchema({ type: "integer", minimum: 0 }, "Retention window for physically purging soft-deleted sessions."),
    createdAt: describeSchema(stringSchema("date-time"), "Settings creation timestamp."),
    updatedAt: describeSchema(stringSchema("date-time"), "Settings update timestamp.")
  }, ["organizationId", "retentionSeconds", "createdAt", "updatedAt"], "Organization session-state settings."),
  UpdateSessionSettingsRequest: objectSchema({
    retentionSeconds: describeSchema({ type: "integer", minimum: 0 }, "Retention window in seconds.")
  }, ["retentionSeconds"], "Updates organization session-state settings."),
  AgentChatMessage: objectSchema({
    role: describeSchema(enumSchema(["user", "assistant"]), "Message role."),
    content: describeSchema(stringSchema(), "Message text content.")
  }, ["role", "content"], "Chat message sent to or produced by an agent."),
  AgentChatRequest: objectSchema({
    modelSelection: describeSchema(
      stringSchema(),
      "Model selection in provider/model form."
    ),
    sessionId: describeSchema(
      stringSchema("uuid"),
      "Session identifier whose persisted messages are used as agent context."
    ),
    messages: describeSchema(
      arraySchema(ref("AgentChatMessage")),
      "Client-side conversation snapshot or delta. The API reconciles this with persisted session messages before invoking the agent."
    )
  }, ["modelSelection", "sessionId", "messages"], "Streaming chat request for a session-backed chat."),
  AgentPromptRequest: objectSchema({
    modelSelection: describeSchema(
      stringSchema(),
      "Model selection in provider/model form."
    ),
    messages: describeSchema(
      arraySchema(ref("AgentChatMessage")),
      "Conversation messages to send to the agent."
    )
  }, ["modelSelection", "messages"], "Streaming prompt request for one-off agent operations."),
  AgentRunStatus: enumSchema([
    "queued", "running", "waiting_for_approval", "needs_acknowledgment",
    "completed", "failed", "cancelled"
  ]),
  CreateAgentRunRequest: objectSchema({
    idempotencyKey: describeSchema(stringSchema(), "Caller-stable key for exact start retries."),
    originMessageId: describeSchema(stringSchema("uuid"), "Existing retained user message to reuse for a retried turn."),
    modelSelection: describeSchema(stringSchema(), "Pinned provider/model selection."),
    message: ref("AgentChatMessage"),
    metadata: describeSchema({}, "Persisted message metadata.")
  }, ["idempotencyKey", "message"], "Starts a durable agent run."),
  AgentRun: objectSchema({
    id: stringSchema("uuid"),
    organizationId: stringSchema("uuid"),
    sessionId: stringSchema("uuid"),
    originMessageId: stringSchema("uuid"),
    assistantMessageId: nullableSchema(stringSchema("uuid")),
    initiatedByUserId: stringSchema("uuid"),
    agentRevisionId: stringSchema("uuid"),
    environmentId: stringSchema("uuid"),
    status: ref("AgentRunStatus"),
    purpose: enumSchema(["chat", "title"]),
    idempotencyKey: stringSchema(),
    capabilityDigest: stringSchema(),
    configurationDigest: stringSchema(),
    isolationProvider: stringSchema(),
    untrustedContentIngested: { type: "boolean" },
    modelSelection: stringSchema(),
    errorCode: nullableSchema(stringSchema()),
    errorMessage: nullableSchema(stringSchema()),
    createdAt: stringSchema("date-time"),
    updatedAt: stringSchema("date-time"),
    startedAt: nullableSchema(stringSchema("date-time")),
    completedAt: nullableSchema(stringSchema("date-time")),
    cancelledAt: nullableSchema(stringSchema("date-time"))
  }, [
    "id", "organizationId", "sessionId", "originMessageId", "assistantMessageId",
    "initiatedByUserId", "agentRevisionId", "environmentId", "status", "purpose",
    "idempotencyKey", "capabilityDigest", "configurationDigest", "isolationProvider",
    "untrustedContentIngested", "modelSelection", "errorCode", "errorMessage",
    "createdAt", "updatedAt", "startedAt", "completedAt", "cancelledAt"
  ], "Durable managed-agent run state.")
};

const operationDocs: Record<
  string,
  {
    summary: string;
    description: string;
    requestDescription?: string;
    successDescription: string;
  }
> = {
  registerAccount: {
    summary: "Register an account",
    description:
      "Creates an email/password user, an initial organization, and an admin membership. The new user must verify their email address before login succeeds.",
    requestDescription: "Account credentials and optional profile details.",
    successDescription: "Email verification requirement for the new account."
  },
  login: {
    summary: "Log in",
    description:
      "Authenticates a verified email/password account, sets the refresh-session cookie, and returns a short-lived access JWT plus the active session profile.",
    requestDescription: "Email/password credentials and optional organization selection.",
    successDescription: "Access token and current session profile."
  },
  verifyEmail: {
    summary: "Verify email",
    description:
      "Consumes a single-use, expiring email token and marks the associated account verified.",
    requestDescription: "Verification token delivered to the account email.",
    successDescription: "Email verification acknowledgement."
  },
  requestPasswordReset: {
    summary: "Request password reset",
    description:
      "Delivers a single-use, expiring reset token when a verified password account exists. The response does not disclose account existence.",
    requestDescription: "Account email address.",
    successDescription: "Password-reset request acknowledgement."
  },
  resetPassword: {
    summary: "Reset password",
    description:
      "Consumes a single-use, expiring reset token, replaces the password, and revokes all sessions for the account.",
    requestDescription: "Reset token and replacement password.",
    successDescription: "Password-reset acknowledgement."
  },
  refreshSession: {
    summary: "Refresh access",
    description:
      "Uses the refresh-session cookie to mint a new short-lived access JWT and return the current session profile.",
    requestDescription: "Empty JSON body. The refresh cookie supplies the session.",
    successDescription: "New access token and current session profile."
  },
  logout: {
    summary: "Log out",
    description:
      "Revokes the current refresh session when one is present and clears the refresh-session cookie.",
    requestDescription: "Empty JSON body.",
    successDescription: "Logout acknowledgement."
  },
  logoutAllSessions: {
    summary: "Log out all sessions",
    description:
      "Revokes every active refresh session for the authenticated user and clears the current refresh-session cookie.",
    requestDescription: "Empty JSON body.",
    successDescription: "Logout-all acknowledgement."
  },
  fetchSession: {
    summary: "Get current session",
    description:
      "Returns the user, organization, membership, and session metadata for the supplied access JWT.",
    successDescription: "Current authenticated session profile."
  },
  openClientEvents: {
    summary: "Open client event stream",
    description:
      "Opens an authenticated Server-Sent Events stream. Events are invalidation hints; clients should force-refresh auth state when `auth.refresh_required` is received.",
    successDescription: "Server-Sent Events stream of client invalidation hints."
  },
  listOrganizations: {
    summary: "List organizations",
    description:
      "Lists every organization the authenticated user belongs to and identifies the active organization for the current session.",
    successDescription: "Organizations available to the current user."
  },
  switchOrganization: {
    summary: "Switch organization",
    description:
      "Switches the active organization for the current session, rotates the refresh-session cookie, and returns a new access JWT.",
    requestDescription: "Organization to activate.",
    successDescription: "Access token and current session profile for the selected organization."
  },
  createOrganization: {
    summary: "Create organization",
    description:
      "Creates an organization, adds the current user as an admin, rotates the refresh-session cookie, and returns a new access JWT.",
    requestDescription: "Organization details.",
    successDescription: "Access token and current session profile for the new organization."
  },
  updateCurrentUser: {
    summary: "Update current user",
    description:
      "Updates the display name stored for the authenticated user and returns the refreshed session profile.",
    requestDescription: "User profile fields to update.",
    successDescription: "Updated current session profile."
  },
  updateCurrentOrganization: {
    summary: "Update current organization",
    description:
      "Updates the active organization's display name. The caller must be an organization admin.",
    requestDescription: "Organization fields to update.",
    successDescription: "Updated current session profile."
  },
  deleteCurrentOrganization: {
    summary: "Delete current organization",
    description:
      "Deletes the active organization as an admin. If another membership exists, the session switches to it; otherwise the returned session requires organization creation.",
    requestDescription: "Empty JSON body.",
    successDescription: "Rotated session state after organization deletion."
  },
  listOrganizationMembers: {
    summary: "List organization members",
    description:
      "Lists members in the active organization. The caller must be an organization admin.",
    successDescription: "Organization member list."
  },
  updateOrganizationMemberRole: {
    summary: "Update member role",
    description:
      "Updates a member role in the active organization. The caller must be an organization admin.",
    requestDescription: "Membership identifier and new role.",
    successDescription: "Updated organization member list."
  },
  removeOrganizationMember: {
    summary: "Remove member",
    description:
      "Removes a member from the active organization. The caller must be an organization admin.",
    requestDescription: "Membership identifier to remove.",
    successDescription: "Updated organization member list."
  },
  createOrganizationInvite: {
    summary: "Create organization invite",
    description:
      "Creates a pending organization invite, stores only a hash of its single-use token, sends the invitation through the configured email delivery provider, and emits an audit event.",
    requestDescription: "Invite email, role, and optional expiration window.",
    successDescription: "Created pending invite."
  },
  listOrganizationInvites: {
    summary: "List organization invites",
    description:
      "Lists invites for the active organization. The caller must be an organization admin.",
    successDescription: "Organization invite list."
  },
  respondToOrganizationInvite: {
    summary: "Respond to organization invite",
    description:
      "Accepts or declines a pending organization invite using its secret email token. The signed-in user's email must match the invitation.",
    requestDescription: "Invitation token and accepted or declined response.",
    successDescription: "Updated invitation and inviting organization."
  },
  fetchInferenceConfig: {
    summary: "Get inference configuration",
    description:
      "Returns the active organization's inference providers, model availability, and workspace model defaults.",
    successDescription: "Complete inference configuration for the active organization."
  },
  createInferenceProvider: {
    summary: "Add inference provider",
    description:
      "Stores a provider API key server-side, validates provider connectivity when possible, and returns the created provider status.",
    requestDescription: "Provider kind, label, API key, and optional base URL override.",
    successDescription: "Created provider status."
  },
  updateInferenceProvider: {
    summary: "Update inference provider",
    description:
      "Enables or disables an existing inference provider for the active organization.",
    requestDescription: "Provider identifier and enabled state.",
    successDescription: "Updated inference configuration."
  },
  refreshInferenceProviderModels: {
    summary: "Refresh inference provider models",
    description:
      "Re-discovers models from an existing inference provider, removes models no longer returned by the provider, and preserves availability settings for models that remain.",
    requestDescription: "Provider identifier.",
    successDescription: "Updated inference configuration."
  },
  updateInferenceModel: {
    summary: "Update inference model",
    description:
      "Enables or disables a provider model for selection in the active organization.",
    requestDescription: "Provider identifier, model identifier, and enabled state.",
    successDescription: "Updated inference configuration."
  },
  deleteInferenceProvider: {
    summary: "Delete inference provider",
    description:
      "Deletes a provider configuration and removes it from model selection for the active organization.",
    requestDescription: "Provider identifier.",
    successDescription: "Updated inference configuration."
  },
  updateInferenceModelDefault: {
    summary: "Update model default",
    description:
      "Sets the default provider/model selection for one workspace mode in the active organization.",
    requestDescription: "Workspace mode and model selection.",
    successDescription: "Updated inference configuration."
  },
  listProjects: {
    summary: "List projects",
    description: "Lists projects owned by the current user in the active organization.",
    successDescription: "Owned project summaries."
  },
  createProject: {
    summary: "Create project",
    description: "Creates a project for shared instructions, context, and sessions.",
    requestDescription: "Project name.",
    successDescription: "Created project."
  },
  fetchProjectById: {
    summary: "Get project",
    description: "Returns an owned project with its persisted context items.",
    successDescription: "Project details."
  },
  updateProject: {
    summary: "Update project",
    description: "Updates project identity, instructions, memory, or pin state.",
    requestDescription: "Project fields to update.",
    successDescription: "Updated project."
  },
  deleteProject: {
    summary: "Delete project",
    description: "Deletes a project and detaches its sessions.",
    requestDescription: "Empty JSON body.",
    successDescription: "Deleted project summary."
  },
  addProjectContext: {
    summary: "Add project context",
    description: "Persists a bounded text context item for a project.",
    requestDescription: "Filename, media type, and extracted text content.",
    successDescription: "Created context item."
  },
  deleteProjectContext: {
    summary: "Remove project context",
    description: "Removes a persisted context item from an owned project.",
    requestDescription: "Empty JSON body.",
    successDescription: "Updated project."
  },
  listSessions: {
    summary: "List sessions",
    description:
      "Lists active, unarchived sessions owned by the current user in the active organization.",
    successDescription: "Owned session summaries."
  },
  createSession: {
    summary: "Create session",
    description:
      "Creates an organization-scoped session owned by the current user.",
    requestDescription: "Agent identifier and optional title.",
    successDescription: "Created session summary."
  },
  fetchSessionById: {
    summary: "Get session",
    description:
      "Returns an owned session with messages and versioned state snapshots.",
    successDescription: "Session details."
  },
  updateSession: {
    summary: "Update session",
    description:
      "Updates owned session metadata such as title or model selection.",
    requestDescription: "Session metadata fields to update.",
    successDescription: "Updated session summary."
  },
  appendSessionMessage: {
    summary: "Append message",
    description:
      "Appends a message to an owned session and enforces server-side byte limits.",
    requestDescription: "Message role, content, and optional metadata.",
    successDescription: "Created session message."
  },
  appendSessionState: {
    summary: "Append state",
    description:
      "Appends a JSON state snapshot to an owned session and enforces server-side byte limits.",
    requestDescription: "Snapshot kind and JSON state payload.",
    successDescription: "Created state snapshot."
  },
  truncateSession: {
    summary: "Truncate session",
    description:
      "Atomically removes messages after a boundary and removes state snapshots that reference deleted messages.",
    requestDescription:
      "Message ID to retain as the final message, or null to remove all messages.",
    successDescription: "Truncated session details."
  },
  archiveSession: {
    summary: "Archive session",
    description:
      "Archives an owned session so it no longer appears in the active session list and becomes eligible for physical purge according to organization retention settings.",
    requestDescription: "Empty JSON body.",
    successDescription: "Archived session summary."
  },
  fetchSessionSettings: {
    summary: "Get session settings",
    description:
      "Returns organization-level session-state settings for the active organization.",
    successDescription: "Session-state settings."
  },
  updateSessionSettings: {
    summary: "Update session settings",
    description:
      "Updates organization-level session-state settings. The caller must be an organization admin.",
    requestDescription: "Session-state settings to update.",
    successDescription: "Updated session-state settings."
  },
  createAgentRun: {
    summary: "Start agent run",
    description:
      "Atomically persists the user turn and immutable run configuration, then streams replayable run events. Reusing an idempotency key with the exact request attaches to the same run.",
    requestDescription: "User turn, model selection, and caller-stable idempotency key.",
    successDescription: "Newline-delimited durable run events."
  },
  fetchAgentRun: {
    summary: "Get agent run",
    description: "Returns an owned durable run and its terminal or active state.",
    successDescription: "Agent run state."
  },
  streamAgentRunEvents: {
    summary: "Resume agent run events",
    description:
      "Streams persisted run events in sequence order. The optional `after` query parameter resumes after a previously observed sequence.",
    successDescription: "Newline-delimited durable run events."
  },
  cancelAgentRun: {
    summary: "Cancel agent run",
    description:
      "Durably cancels an owned run, revokes its inference capability, and persists any already-streamed partial answer.",
    requestDescription: "Empty JSON body.",
    successDescription: "Cancelled or already-terminal agent run."
  },
  streamAgentChat: {
    summary: "Stream agent chat",
    description:
      "Streams typed newline-delimited events from the agent identified by `agentSlug`, using persisted session messages plus a deduplicated client message snapshot as context.",
    requestDescription: "Model selection, session id, and client message snapshot.",
    successDescription: "Typed newline-delimited agent event stream."
  },
  streamAgentPrompt: {
    summary: "Stream agent prompt",
    description:
      "Streams typed newline-delimited events from the agent identified by `agentSlug` for an explicit prompt.",
    requestDescription: "Model selection and prompt messages.",
    successDescription: "Typed newline-delimited agent event stream."
  }
};

const pathParameterDescriptions: Record<string, string> = {
  agentSlug: "Unique agent slug, such as `lush` for the built-in agent.",
  sessionId: "Session identifier.",
  runId: "Agent run identifier."
};

const fullDocument = createOpenApiDocument("Lush API", apiSpec.routes);
const groupedDocuments = Object.fromEntries(
  ["auth", "inference", "sessions", "runs", "agents", "health"].map((group) => [
    group,
    createOpenApiDocument(
      `${titleCase(group)} API`,
      group === "health"
        ? []
        : apiSpec.routes.filter((route) =>
            group === "sessions"
              ? routeGroup(route.path) === "sessions" ||
                route.path.endsWith("/settings/sessions")
              : routeGroup(route.path) === group
          ),
      group
    )
  ])
);

await mkdir(outputDir, { recursive: true });
await writeJson("openapi.json", withHealthRoute(fullDocument));
for (const [group, document] of Object.entries(groupedDocuments)) {
  await writeJson(`${group}.json`, group === "health" ? withOnlyHealthRoute(document) : document);
}

console.log(`Generated OpenAPI specs in ${outputDir}`);

function createOpenApiDocument(
  title: string,
  routes: typeof apiSpec.routes,
  forcedTag?: string
): OpenApiDocument {
  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title,
      version: "0.0.0",
      description:
        "HTTP API for authentication, organization-scoped inference configuration, and agent runtime requests."
    },
    servers: [{ url: "http://localhost:7330" }],
    tags: tagsForRoutes(routes, forcedTag),
    paths: {},
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT"
        }
      },
      schemas
    }
  };

  for (const route of routes) {
    const docs = operationDocs[route.id];
    const path = openApiPath(route.path);
    document.paths[path] ??= {};
    document.paths[path][route.method.toLowerCase()] = {
      summary: docs?.summary ?? routeSummary(route.id),
      ...(docs?.description ? { description: docs.description } : {}),
      operationId: route.id,
      tags: [forcedTag ?? routeGroup(route.path)],
      ...(route.auth ? { security: [{ bearerAuth: [] }] } : {}),
      ...operationParameters(route.path, route.id),
      ...requestBody(route),
      responses: responses(route)
    };
  }

  return document;
}

function withHealthRoute(document: OpenApiDocument) {
  document.tags = tagsForRoutes(apiSpec.routes, undefined, true);
  document.paths[apiSpec.healthPath] = {
    get: healthOperation()
  };
  return document;
}

function withOnlyHealthRoute(document: OpenApiDocument) {
  document.tags = [{ name: "health", description: "Health and route discovery routes." }];
  document.paths = {
    [apiSpec.healthPath]: {
      get: healthOperation()
    }
  };
  return document;
}

function healthOperation(): Operation {
  return {
    summary: "Health check",
    operationId: "health",
    tags: ["health"],
    responses: {
      "200": {
        description: "Service health and route list.",
        content: {
          "application/json": {
            schema: objectSchema({
              ok: { type: "boolean" },
              service: stringSchema(),
              agent: stringSchema(),
              routes: arraySchema(
                objectSchema({
                  id: stringSchema(),
                  method: stringSchema(),
                  path: stringSchema()
                }, ["id", "method", "path"])
              )
            }, ["ok", "service", "agent", "routes"])
          }
        }
      }
    }
  };
}

function requestBody(route: (typeof apiSpec.routes)[number]) {
  if (!("requestType" in route)) {
    return {};
  }

  const docs = operationDocs[route.id];
  return {
    requestBody: {
      required: true,
      ...(docs?.requestDescription
        ? { description: docs.requestDescription }
        : {}),
      content: {
        "application/json": {
          schema: schemaFor(route.requestType)
        }
      }
    }
  };
}

function operationParameters(path: string, routeId: string) {
  const params = Array.from(path.matchAll(/:([A-Za-z0-9_]+)/g), (match) => match[1]);
  const parameters: NonNullable<Operation["parameters"]> = params.map((name) => ({
    name,
    in: "path" as const,
    required: true,
    description: pathParameterDescriptions[name],
    schema: stringSchema()
  }));
  if (routeId === "streamAgentRunEvents") {
    parameters.push({
      name: "after",
      in: "query",
      required: false,
      description: "Resume after this last-observed event sequence.",
      schema: { type: "integer", minimum: 0 }
    });
  }
  if (parameters.length === 0) {
    return {};
  }

  return { parameters };
}

function responses(route: (typeof apiSpec.routes)[number]): Operation["responses"] {
  const docs = operationDocs[route.id];
  if (route.kind === "stream") {
    return {
      "200": {
        description: docs?.successDescription ?? "Typed agent event stream.",
        content: {
          "application/x-ndjson": {
            schema: describeSchema(
              stringSchema(),
              route.id === "createAgentRun" || route.id === "streamAgentRunEvents"
                ? "Newline-delimited AgentRunEvent JSON objects."
                : "Newline-delimited AgentStreamEvent JSON objects."
            )
          }
        }
      },
      "401": unauthorizedResponse()
    };
  }

  if (route.kind === "event-stream") {
    return {
      "200": {
        description: docs?.successDescription ?? "Server-Sent Events stream.",
        content: {
          "text/event-stream": {
            schema: schemaFor(route.responseType)
          }
        }
      },
      "401": unauthorizedResponse()
    };
  }

  return {
    "200": {
      description: docs?.successDescription ?? "Successful response.",
      content: {
        "application/json": {
          schema: schemaFor(route.responseType)
        }
      }
    },
    ...(route.auth ? { "401": unauthorizedResponse() } : {})
  };
}

function unauthorizedResponse() {
  return {
    description: "Unauthorized.",
    content: {
      "application/json": {
        schema: objectSchema({ error: stringSchema() }, ["error"])
      }
    }
  };
}

function schemaFor(typeName: string): JsonSchema {
  if (typeName === "Response") {
    return stringSchema();
  }

  if (typeName === "{ ok: true }") {
    return objectSchema({ ok: { type: "boolean", const: true } }, ["ok"]);
  }

  return schemas[typeName] ? ref(typeName) : {};
}

function tagsForRoutes(
  routes: typeof apiSpec.routes,
  forcedTag?: string,
  includeHealth = false
) {
  const tags = new Set<string>();
  if (forcedTag) {
    tags.add(forcedTag);
  } else {
    for (const route of routes) {
      tags.add(routeGroup(route.path));
    }
  }

  if (includeHealth) {
    tags.add("health");
  }

  return [...tags].map((tag) => ({
    name: tag,
    description: tagDescription(tag)
  }));
}

function routeGroup(path: string) {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === apiSpec.apiGroup.slice(1)) {
    return segments[1] ?? "health";
  }

  return segments[0] ?? "health";
}

function routeSummary(id: string) {
  return id.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

function openApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

function enumSchema(values: string[]): JsonSchema {
  return { type: "string", enum: values };
}

function stringSchema(
  format?: string,
  minLength?: number,
  maxLength?: number
): JsonSchema {
  return {
    type: "string",
    ...(format ? { format } : {}),
    ...(minLength ? { minLength } : {}),
    ...(maxLength ? { maxLength } : {})
  };
}

function arraySchema(items: JsonSchema): JsonSchema {
  return { type: "array", items };
}

function nullableSchema(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: "null" }] };
}

function emptyObjectSchema(description?: string): JsonSchema {
  return objectSchema({}, [], description);
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[],
  description?: string
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    ...(description ? { description } : {}),
    properties,
    ...(required.length > 0 ? { required } : {})
  };
}

function describeSchema(schema: JsonSchema, description: string): JsonSchema {
  return {
    ...schema,
    description
  };
}

function titleCase(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function tagDescription(tag: string) {
  const descriptions: Record<string, string> = {
    auth: "Account registration, login, refresh, session inspection, and logout routes.",
    session: "Current-session inspection routes.",
    settings: "Organization-level settings routes.",
    sessions: "Sessions, messages, state snapshots, and session-state settings routes.",
    inference: "Organization-scoped inference provider and model-default configuration routes.",
    agents: "Agent runtime invocation routes.",
    health: "Service health and route discovery routes."
  };

  return descriptions[tag] ?? `${titleCase(tag)} routes.`;
}

async function writeJson(filename: string, value: unknown) {
  const outputPath = resolve(outputDir, filename);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}
