import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import {
  ConfigError,
  envSchema,
  envValue,
  readEnvSchema,
  requiredEnvValue
} from "@lush/config/env";
import { getDb } from "@lush/db/client";
import type {
  ApiTokenScope,
  ApiTokensTable,
  AuthActionTokenPurpose,
  Database,
  UserRole
} from "@lush/db/schema";
import { createLogger } from "@lush/logging/logger";
import type { EmailDelivery } from "@lush/notifications/email";
import {
  canonicalApiTokenActionScopes,
  canonicalApiTokenScopes
} from "./api-token-scopes";
import {
  createRefreshToken,
  refreshTokenFamilySecret,
  rotateRefreshToken
} from "./refresh-token";
import { normalizeAuthEmail } from "./email";
import {
  dummyPasswordHash,
  hashPassword,
  passwordHashNeedsUpgrade,
  passwordMaxLength,
  verifyPassword
} from "./password";
import {
  retainedSessionIp
} from "./session-ip";
import {
  JwtKeyConfigError,
  JwtKeyStore,
  JwtTokenError,
  jwtKeyIdForPublicKey,
  parseJwtPublicKeys
} from "./jwt-keys";

export type Principal = {
  userId: string;
  organizationId: string | null;
  membershipId: string | null;
  role: UserRole | null;
  sessionId: string;
  tokenId?: string;
};

export const apiTokenScopes =
  canonicalApiTokenScopes satisfies readonly ApiTokenScope[];

export type ApiTokenPrincipal = Principal & {
  tokenId: string;
  organizationId: string;
  membershipId: string;
  role: "admin";
  scopes: ApiTokenScope[];
};

export type ApiToken = {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  createdByUserId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type ApiTokenRuntimeOptions = {
  db?: Kysely<Database>;
  now?: Date;
};

export type RequestMeta = {
  userAgent?: string | null;
  ipAddress?: string | null;
};

export type AuthAssertion = {
  providerId: string | null;
  kind: "password" | "oidc" | "oauth" | "saml";
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  avatarUrl?: string;
  groups?: string[];
  claims: Record<string, unknown>;
};

export type EmailVerificationRequired = {
  emailVerificationRequired: true;
  email: string;
};

export type AuthProviderConfig = {
  id: string;
  kind: AuthAssertion["kind"];
  label: string;
  organizationId?: string | null;
  config: Record<string, unknown>;
};

export type AuthProviderAdapter = {
  kind: AuthAssertion["kind"];
  beginLogin(request: Request, provider: AuthProviderConfig): Promise<Response>;
  completeLogin(
    request: Request,
    provider: AuthProviderConfig
  ): Promise<AuthAssertion>;
};

export type RegisterAccountRequest = {
  email: string;
  password: string;
  displayName?: string;
  organizationName?: string;
};

type NormalizedRegisterAccountRequest = {
  email: string;
  password: string;
  displayName: string;
  organizationName: string;
};

export type LoginRequest = {
  email: string;
  password: string;
  organizationId?: string;
};

export type VerifyEmailRequest = {
  token: string;
};

export type RequestPasswordResetRequest = {
  email: string;
};

export type ResetPasswordRequest = {
  token: string;
  password: string;
};

export type AuthEmailOptions = {
  emailDelivery?: EmailDelivery;
  appBaseUrl?: string;
  db?: Kysely<Database>;
  now?: Date;
  publicSignup?: boolean;
};

export type OrganizationSummary = {
  id: string;
  name: string;
  role: UserRole;
};

export type CreateOrganizationRequest = {
  name: string;
};

export type SwitchOrganizationRequest = {
  organizationId: string;
};

export type UpdateCurrentUserRequest = {
  displayName: string;
};

export type UpdateCurrentOrganizationRequest = {
  name: string;
};

export type DeleteCurrentOrganizationResponse =
  | {
      requiresOrganization: false;
      nextSession: AccessSession;
      refreshToken: string;
    }
  | {
      requiresOrganization: true;
      nextSession: AccessSession;
      refreshToken: string;
    };

export type UpdateOrganizationMemberRoleRequest = {
  membershipId: string;
  role: UserRole;
};

export type RemoveOrganizationMemberRequest = {
  membershipId: string;
};

export type CreateOrganizationInviteRequest = {
  email: string;
  role: UserRole;
  expiresInDays?: number;
};

export type RespondToOrganizationInviteRequest = {
  token: string;
  response: "accepted" | "declined";
};

const authzConfig = readEnvSchema({
  LUSH_SESSION_TTL_MS: envSchema.number(30 * 24 * 60 * 60 * 1000),
  LUSH_ACCESS_TOKEN_TTL_MS: envSchema.number(5 * 60 * 1000),
  LUSH_REFRESH_TOKEN_GRACE_MS: envSchema.number(60 * 1000),
  LUSH_AUTH_JWT_ISSUER: envSchema.optionalString("lush-authz"),
  LUSH_AUTH_JWT_AUDIENCE: envSchema.optionalString("lush-api"),
  LUSH_AUTH_PASSWORD_ENABLED: envSchema.boolean(true),
  LUSH_AUTH_SIGNUP_ENABLED: envSchema.boolean(true),
  LUSH_AUTH_PUBLIC_SIGNUP: envSchema.boolean(true),
  LUSH_EMAIL_VERIFICATION_TTL_MS: envSchema.number(24 * 60 * 60 * 1000),
  LUSH_PASSWORD_RESET_TTL_MS: envSchema.number(60 * 60 * 1000)
});
const sessionTtlMs = authzConfig.LUSH_SESSION_TTL_MS;
const accessTokenTtlMs = authzConfig.LUSH_ACCESS_TOKEN_TTL_MS;
const refreshTokenGraceMs = authzConfig.LUSH_REFRESH_TOKEN_GRACE_MS;
const jwtIssuer = authzConfig.LUSH_AUTH_JWT_ISSUER;
const jwtAudience = authzConfig.LUSH_AUTH_JWT_AUDIENCE;
const passwordAuthEnabled = authzConfig.LUSH_AUTH_PASSWORD_ENABLED;
const signupEnabled = authzConfig.LUSH_AUTH_SIGNUP_ENABLED;
const publicSignup = authzConfig.LUSH_AUTH_PUBLIC_SIGNUP;
const emailVerificationTtlMs = authzConfig.LUSH_EMAIL_VERIFICATION_TTL_MS;
const passwordResetTtlMs = authzConfig.LUSH_PASSWORD_RESET_TTL_MS;
const logger = createLogger("@lush/authz");

export type CurrentSession = {
  sessionId: string;
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    displayName: string;
  };
  organization: {
    id: string;
    name: string;
  } | null;
  membership: {
    id: string;
    role: UserRole;
  } | null;
  createdAt: string;
  expiresAt: string;
};

type RefreshSession = {
  refreshToken: string;
  session: CurrentSession;
};

export type AccessSession = {
  accessToken: string;
  accessTokenExpiresAt: string;
  session: CurrentSession;
};

export type AccessTokenClaims = {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  org: string | null;
  mid: string | null;
  role: UserRole | null;
  email: string;
  email_verified: boolean;
  name: string;
  org_name: string;
  session_created_at: string;
  session_expires_at: string;
  iat: number;
  exp: number;
  jti: string;
};

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export const authzActions = [
  "logout",
  "logoutAllSessions",
  "fetchSession",
  "openClientEvents",
  "listOrganizations",
  "switchOrganization",
  "createOrganization",
  "updateCurrentUser",
  "updateCurrentOrganization",
  "deleteCurrentOrganization",
  "listOrganizationMembers",
  "updateOrganizationMemberRole",
  "removeOrganizationMember",
  "createOrganizationInvite",
  "listOrganizationInvites",
  "respondToOrganizationInvite",
  "listApiTokens",
  "createApiToken",
  "revokeApiToken",
  "fetchInferenceConfig",
  "createInferenceProvider",
  "updateInferenceProvider",
  "refreshInferenceProviderModels",
  "updateInferenceModel",
  "deleteInferenceProvider",
  "updateInferenceModelDefault",
  "listOpenAICompatibleModels",
  "retrieveOpenAICompatibleModel",
  "createOpenAICompatibleChatCompletion",
  "createOpenAICompatibleResponse",
  "createOpenAICompatibleEmbedding",
  "streamAgentChat",
  "streamAgentPrompt",
  "createAgentRun",
  "fetchAgentRun",
  "streamAgentRunEvents",
  "cancelAgentRun",
  "listProjects",
  "createProject",
  "fetchProjectById",
  "updateProject",
  "deleteProject",
  "addProjectContext",
  "deleteProjectContext",
  "listSessions",
  "createSession",
  "fetchSessionById",
  "updateSession",
  "appendSessionMessage",
  "appendSessionState",
  "truncateSession",
  "archiveSession",
  "fetchSessionSettings",
  "updateSessionSettings",
  "getToolGatewaySettings",
  "updateToolGatewaySettings",
  "listToolConnections",
  "createToolConnection",
  "updateToolConnection",
  "deleteToolConnection",
  "listToolDefinitions",
  "updateToolDefinition",
  "discoverToolCatalog",
  "acknowledgeToolCatalog",
  "invokeTool",
  "decideToolApproval"
] as const;

export type AuthzAction = (typeof authzActions)[number];

export const apiTokenActionScopes =
  canonicalApiTokenActionScopes satisfies Partial<
    Record<AuthzAction, ApiTokenScope>
  >;

const authenticatedActions = new Set<AuthzAction>([
  "logout",
  "logoutAllSessions",
  "fetchSession",
  "openClientEvents",
  "listOrganizations",
  "switchOrganization",
  "createOrganization",
  "updateCurrentUser",
  "respondToOrganizationInvite"
]);

export const roleActionBindings: Record<UserRole, readonly AuthzAction[]> = {
  admin: [
    "fetchInferenceConfig",
    "streamAgentChat",
    "streamAgentPrompt",
    "createAgentRun",
    "fetchAgentRun",
    "streamAgentRunEvents",
    "cancelAgentRun",
    "listProjects",
    "createProject",
    "fetchProjectById",
    "updateProject",
    "deleteProject",
    "addProjectContext",
    "deleteProjectContext",
    "listSessions",
    "createSession",
    "fetchSessionById",
    "updateSession",
    "appendSessionMessage",
    "appendSessionState",
    "truncateSession",
    "archiveSession",
    "fetchSessionSettings",
    "updateSessionSettings",
    "listOrganizationMembers",
    "updateCurrentOrganization",
    "deleteCurrentOrganization",
    "updateOrganizationMemberRole",
    "removeOrganizationMember",
    "createOrganizationInvite",
    "listOrganizationInvites",
    "listApiTokens",
    "createApiToken",
    "revokeApiToken",
    "createInferenceProvider",
    "updateInferenceProvider",
    "refreshInferenceProviderModels",
    "updateInferenceModel",
    "deleteInferenceProvider",
    "updateInferenceModelDefault",
    "listOpenAICompatibleModels",
    "retrieveOpenAICompatibleModel",
    "createOpenAICompatibleChatCompletion",
    "createOpenAICompatibleResponse",
    "createOpenAICompatibleEmbedding",
    "getToolGatewaySettings",
    "updateToolGatewaySettings",
    "listToolConnections",
    "createToolConnection",
    "updateToolConnection",
    "deleteToolConnection",
    "listToolDefinitions",
    "updateToolDefinition",
    "discoverToolCatalog",
    "acknowledgeToolCatalog",
    "invokeTool",
    "decideToolApproval"
  ],
  user: [
    "fetchInferenceConfig",
    "listOpenAICompatibleModels",
    "retrieveOpenAICompatibleModel",
    "createOpenAICompatibleChatCompletion",
    "createOpenAICompatibleResponse",
    "createOpenAICompatibleEmbedding",
    "streamAgentChat",
    "streamAgentPrompt",
    "createAgentRun",
    "fetchAgentRun",
    "streamAgentRunEvents",
    "cancelAgentRun",
    "listProjects",
    "createProject",
    "fetchProjectById",
    "updateProject",
    "deleteProject",
    "addProjectContext",
    "deleteProjectContext",
    "listSessions",
    "createSession",
    "fetchSessionById",
    "updateSession",
    "appendSessionMessage",
    "appendSessionState",
    "truncateSession",
    "archiveSession",
    "fetchSessionSettings",
    "listOrganizationMembers",
    "getToolGatewaySettings",
    "listToolConnections",
    "createToolConnection",
    "updateToolConnection",
    "deleteToolConnection",
    "listToolDefinitions",
    "updateToolDefinition",
    "discoverToolCatalog",
    "acknowledgeToolCatalog",
    "invokeTool",
    "decideToolApproval"
  ]
};

const roleActionSets: Record<UserRole, ReadonlySet<AuthzAction>> = {
  admin: new Set(roleActionBindings.admin),
  user: new Set(roleActionBindings.user)
};

export function authorizePrincipal(principal: Principal, action: AuthzAction) {
  if (authenticatedActions.has(action)) {
    return {
      allowed: true as const,
      action,
      role: principal.role
    };
  }

  if (!principal.organizationId || !principal.membershipId || !principal.role) {
    throw new AuthError(
      "organization_required",
      "An active organization is required",
      403
    );
  }

  if (roleActionSets[principal.role].has(action)) {
    return {
      allowed: true as const,
      action,
      role: principal.role,
      organizationId: principal.organizationId
    };
  }

  throw new AuthError(
    "permission_denied",
    "You do not have permission to perform this action",
    403
  );
}

export function authorizeApiToken(
  principal: ApiTokenPrincipal,
  action: AuthzAction
) {
  const requiredScope = apiTokenActionScopes[action as keyof typeof apiTokenActionScopes];
  if (!requiredScope) {
    throw new AuthError(
      "api_token_not_allowed",
      "API tokens cannot access this route",
      403
    );
  }
  if (!principal.scopes.includes(requiredScope)) {
    throw new AuthError(
      "insufficient_scope",
      `API token requires the '${requiredScope}' scope`,
      403
    );
  }

  return {
    allowed: true as const,
    action,
    scope: requiredScope,
    organizationId: principal.organizationId
  };
}

export async function listApiTokens(
  principal: Principal,
  options: ApiTokenRuntimeOptions = {}
) {
  assertCanManageOrganization(principal);
  const organizationId = requireOrganizationId(principal);
  const tokens = await (options.db ?? getDb())
    .selectFrom("apiTokens")
    .selectAll()
    .where("organizationId", "=", organizationId)
    .where("revokedAt", "is", null)
    .orderBy("createdAt", "desc")
    .execute();

  return { tokens: tokens.map(toApiToken) };
}

export async function createApiToken(
  principal: Principal,
  request: unknown,
  options: ApiTokenRuntimeOptions = {}
) {
  assertCanManageOrganization(principal);
  const organizationId = requireOrganizationId(principal);
  const body = normalizeCreateApiTokenRequest(request);
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const expiresAt = body.expiresInDays
    ? new Date(now.getTime() + body.expiresInDays * 24 * 60 * 60 * 1000)
    : null;
  const publicId = randomHex(8);
  const secret = `sk_${publicId}_${randomHex(32)}`;
  const prefix = `sk_${publicId}`;

  const token = await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("apiTokens")
      .values({
        organizationId,
        name: body.name,
        tokenPrefix: prefix,
        tokenHash: await hashSecret(secret),
        scopes: body.scopes,
        createdByUserId: principal.userId,
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditEvent(trx, {
      organizationId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      action: "auth.api_token_created",
      targetType: "api_token",
      targetId: row.id,
      metadata: {
        name: row.name,
        prefix: row.tokenPrefix,
        scopes: row.scopes,
        expiresAt: row.expiresAt?.toISOString() ?? null
      }
    });

    return row;
  });

  return { token: toApiToken(token), secret };
}

export async function revokeApiToken(
  principal: Principal,
  tokenId: string,
  options: ApiTokenRuntimeOptions = {}
) {
  assertCanManageOrganization(principal);
  const organizationId = requireOrganizationId(principal);
  if (!tokenId) {
    throw new AuthError("invalid_api_token", "API token id is required");
  }

  const db = options.db ?? getDb();
  const token = await db.transaction().execute(async (trx) => {
    const now = options.now ?? new Date();
    const row = await trx
      .updateTable("apiTokens")
      .set({ revokedAt: now })
      .where("id", "=", tokenId)
      .where("organizationId", "=", organizationId)
      .where("revokedAt", "is", null)
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      throw new AuthError(
        "api_token_not_found",
        "API token was not found or is already revoked",
        404
      );
    }

    await recordAuditEvent(trx, {
      organizationId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      action: "auth.api_token_revoked",
      targetType: "api_token",
      targetId: row.id,
      metadata: { name: row.name, prefix: row.tokenPrefix, scopes: row.scopes }
    });
    return row;
  });

  return { token: toApiToken(token) };
}

export async function resolveApiToken(
  token: string,
  options: ApiTokenRuntimeOptions = {}
): Promise<ApiTokenPrincipal | undefined> {
  if (!/^sk_[0-9a-f]{16}_[0-9a-f]{64}$/.test(token)) {
    return undefined;
  }

  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const row = await db
    .selectFrom("apiTokens")
    .innerJoin("organizationMemberships", (join) =>
      join
        .onRef("organizationMemberships.userId", "=", "apiTokens.createdByUserId")
        .onRef("organizationMemberships.organizationId", "=", "apiTokens.organizationId")
    )
    .select([
      "apiTokens.id as tokenId",
      "apiTokens.organizationId",
      "apiTokens.createdByUserId as userId",
      "apiTokens.scopes",
      "apiTokens.lastUsedAt",
      "organizationMemberships.id as membershipId"
    ])
    .where("tokenHash", "=", await hashSecret(token))
    .where("revokedAt", "is", null)
    .where((eb) =>
      eb.or([eb("expiresAt", "is", null), eb("expiresAt", ">", now)])
    )
    .executeTakeFirst();
  if (!row?.userId) return undefined;

  if (!row.lastUsedAt || row.lastUsedAt < new Date(now.getTime() - 5 * 60_000)) {
    await db
      .updateTable("apiTokens")
      .set({ lastUsedAt: now })
      .where("id", "=", row.tokenId)
      .where("revokedAt", "is", null)
      .execute();
  }

  return {
    tokenId: row.tokenId,
    userId: row.userId,
    organizationId: row.organizationId,
    membershipId: row.membershipId,
    role: "admin",
    sessionId: row.tokenId,
    scopes: row.scopes
  };
}

export function apiTokenHasScope(
  principal: ApiTokenPrincipal,
  scope: ApiTokenScope
) {
  return principal.scopes.includes(scope);
}

export async function registerAccount(
  request: unknown,
  meta: RequestMeta = {},
  options: AuthEmailOptions = {}
) {
  ensurePasswordAuthEnabled();
  ensureSignupEnabled();
  const body = normalizeRegisterRequest(request);
  const db = options.db ?? getDb();
  const delivery = requireEmailDelivery(options.emailDelivery);
  const appBaseUrl = requireAppBaseUrl(options.appBaseUrl);
  const protectAccountEnumeration = options.publicSignup ?? publicSignup;

  const pending = await db.transaction().execute(async (trx) => {
    const existingUser = await trx
      .selectFrom("users")
      .leftJoin(
        "passwordCredentials",
        "passwordCredentials.userId",
        "users.id"
      )
      .select([
        "users.id",
        "users.email",
        "users.emailVerified",
        "passwordCredentials.userId as credentialUserId"
      ])
      .where("users.email", "=", body.email)
      .executeTakeFirst();

    const registeredAccount =
      existingUser &&
      (existingUser.emailVerified || !existingUser.credentialUserId);
    if (registeredAccount && !protectAccountEnumeration) {
      throw new AuthError("email_in_use", "An account already exists for this email");
    }

    const now = options.now ?? new Date();
    const passwordHash = await hashPassword(body.password);
    if (registeredAccount) {
      return { kind: "existing_account" as const, email: existingUser.email };
    }

    if (existingUser) {
      await trx
        .updateTable("users")
        .set({ displayName: body.displayName, updatedAt: now })
        .where("id", "=", existingUser.id)
        .execute();
      await trx
        .updateTable("passwordCredentials")
        .set({ passwordHash, updatedAt: now })
        .where("userId", "=", existingUser.id)
        .execute();
      await trx
        .updateTable("sessions")
        .set({ revokedAt: now })
        .where("userId", "=", existingUser.id)
        .where("revokedAt", "is", null)
        .execute();

      const token = await issueAuthActionToken(
        trx,
        existingUser.id,
        "verify_email",
        now,
        emailVerificationTtlMs
      );
      await recordAuditEvent(trx, {
        organizationId: null,
        userId: existingUser.id,
        action: "auth.local_registration_superseded",
        targetType: "user",
        targetId: existingUser.id,
        metadata: requestAuditMetadata(meta)
      });

      return { kind: "verify_email" as const, user: existingUser, token };
    }

    const user = await trx
      .insertInto("users")
      .values({
        email: body.email,
        emailVerified: false,
        displayName: body.displayName,
        avatarUrl: null,
        createdAt: now,
        updatedAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto("passwordCredentials")
      .values({
        userId: user.id,
        passwordHash,
        createdAt: now,
        updatedAt: now
      })
      .execute();

    await trx
      .insertInto("authIdentities")
      .values({
        userId: user.id,
        providerId: null,
        providerKind: "password",
        subject: user.email,
        email: user.email,
        claims: {},
        createdAt: now,
        updatedAt: now
      })
      .execute();

    const organization = await trx
      .insertInto("organizations")
      .values({
        name: body.organizationName,
        slug: await nextOrganizationSlug(trx, body.organizationName),
        createdAt: now,
        updatedAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const membership = await trx
      .insertInto("organizationMemberships")
      .values({
        organizationId: organization.id,
        userId: user.id,
        role: "admin",
        createdAt: now,
        updatedAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditEvent(trx, {
      organizationId: organization.id,
      userId: user.id,
      action: "auth.local_registered",
      targetType: "user",
      targetId: user.id,
      metadata: requestAuditMetadata(meta)
    });

    const token = await issueAuthActionToken(
      trx,
      user.id,
      "verify_email",
      now,
      emailVerificationTtlMs
    );
    return { kind: "verify_email" as const, user, token };
  });

  if (pending.kind === "existing_account") {
    await deliverAuthEmail(
      delivery,
      {
        to: pending.email,
        subject: "A Lush account already exists for this email",
        text: `Someone tried to register a Lush account with this email address, but an account already exists. Sign in instead: ${authLink(appBaseUrl, "/sign-in")}`
      },
      "existing_account"
    );

    return {
      emailVerificationRequired: true,
      email: pending.email
    } satisfies EmailVerificationRequired;
  }

  await deliverAuthEmail(
    delivery,
    {
      to: pending.user.email,
      subject: "Verify your Lush email",
      text: `Verify your email address: ${authLink(appBaseUrl, "/verify-email", pending.token)}`
    },
    "verify_email"
  );

  return {
    emailVerificationRequired: true,
    email: pending.user.email
  } satisfies EmailVerificationRequired;
}

export async function login(
  request: unknown,
  meta: RequestMeta = {},
  options: Pick<AuthEmailOptions, "db"> = {}
) {
  ensurePasswordAuthEnabled();
  const body = normalizeLoginRequest(request);
  const db = options.db ?? getDb();

  const user = await db
    .selectFrom("users")
    .innerJoin("passwordCredentials", "passwordCredentials.userId", "users.id")
    .select([
      "users.id",
      "users.email",
      "users.emailVerified",
      "passwordCredentials.passwordHash"
    ])
    .where("users.email", "=", body.email)
    .executeTakeFirst();

  const passwordMatches = await verifyPassword(
    body.password,
    user?.passwordHash ?? dummyPasswordHash
  );
  if (!user || !passwordMatches || !user.emailVerified) {
    throw new AuthError(
      "invalid_credentials",
      "Invalid email or password. If you recently signed up, check your inbox for a verification link or register again to resend it.",
      401
    );
  }

  const membershipQuery = db
    .selectFrom("organizationMemberships")
    .innerJoin(
      "organizations",
      "organizations.id",
      "organizationMemberships.organizationId"
    )
    .select([
      "organizationMemberships.id",
      "organizationMemberships.organizationId",
      "organizationMemberships.role"
    ])
    .where("organizationMemberships.userId", "=", user.id)
    .orderBy("organizationMemberships.createdAt", "asc");

  const membership = body.organizationId
    ? await membershipQuery
        .where("organizationMemberships.organizationId", "=", body.organizationId)
        .executeTakeFirst()
    : await membershipQuery.executeTakeFirst();

  if (!membership && body.organizationId) {
    throw new AuthError("membership_not_found", "No organization membership was found", 403);
  }

  if (passwordHashNeedsUpgrade(user.passwordHash)) {
    const passwordHash = await hashPassword(body.password);
    await db
      .updateTable("passwordCredentials")
      .set({ passwordHash, updatedAt: new Date() })
      .where("userId", "=", user.id)
      .where("passwordHash", "=", user.passwordHash)
      .execute();
  }

  await recordAuditEvent(db, {
    organizationId: membership?.organizationId ?? null,
    userId: user.id,
    action: "auth.local_login",
    targetType: "user",
    targetId: user.id,
    metadata: {}
  });

  const refreshSession = await createSession(db, {
    userId: user.id,
    organizationId: membership?.organizationId ?? null,
    membershipId: membership?.id ?? null,
    meta
  });

  return {
    ...(await issueAccessSession(refreshSession)),
    refreshToken: refreshSession.refreshToken
  };
}

export async function refreshAccessSession(
  refreshToken: string,
  meta: RequestMeta = {}
) {
  const rotated = await rotateRefreshSession(refreshToken, meta);
  if (!rotated) {
    throw new AuthError("invalid_session", "Session is no longer valid", 401);
  }

  return {
    ...(await issueAccessSession(rotated)),
    refreshToken: rotated.refreshToken
  };
}

export async function rotateRefreshSession(
  refreshToken: string,
  meta: RequestMeta = {},
  options: {
    db?: Kysely<Database>;
    graceMs?: number;
    signingSecret?: string;
  } = {}
) {
  const db = options.db ?? getDb();
  const graceMs = options.graceMs ?? refreshTokenGraceMs;
  const signingSecret =
    options.signingSecret ?? requiredEnvValue("LUSH_SECRET_KEY");
  const now = new Date();
  const tokenHash = await hashSecret(refreshToken);
  const familySecret = refreshTokenFamilySecret(refreshToken);
  const familyHash = await hashSecret(familySecret);
  const retainedIp = await retainedSessionIp(meta.ipAddress, {
    hmacKey: signingSecret
  });

  const result = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("sessions")
      .innerJoin("users", "users.id", "sessions.userId")
      .leftJoin("organizations", "organizations.id", "sessions.organizationId")
      .leftJoin(
        "organizationMemberships",
        "organizationMemberships.id",
        "sessions.membershipId"
      )
      .select([
        "sessions.id as sessionId",
        "sessions.userId",
        "sessions.organizationId",
        "sessions.membershipId",
        "sessions.tokenHash",
        "sessions.refreshFamilyHash",
        "sessions.previousTokenHash",
        "sessions.rotatedAt",
        "sessions.userAgent",
        "sessions.lastSeenUserAgent",
        "sessions.createdAt",
        "sessions.expiresAt",
        "sessions.revokedAt",
        "organizationMemberships.role",
        "organizationMemberships.userId as membershipUserId",
        "organizationMemberships.organizationId as membershipOrganizationId",
        "users.email",
        "users.emailVerified",
        "users.displayName",
        "organizations.name as organizationName"
      ])
      .where((eb) =>
        eb.or([
          eb("sessions.tokenHash", "=", tokenHash),
          eb("sessions.refreshFamilyHash", "=", familyHash)
        ])
      )
      .forUpdate("sessions")
      .executeTakeFirst();

    if (!row || row.revokedAt) {
      return { status: "invalid" as const };
    }

    if (row.expiresAt <= now || !sessionRowIsUsable(row)) {
      await revokeSessionId(trx, row.sessionId);
      return { status: "invalid" as const };
    }

    const previousTokenIsInGrace =
      row.previousTokenHash === tokenHash &&
      row.rotatedAt !== null &&
      now.getTime() - row.rotatedAt.getTime() <= graceMs;
    if (previousTokenIsInGrace) {
      const currentRefreshToken = await rotateRefreshToken(
        refreshToken,
        signingSecret
      );
      if (await hashSecret(currentRefreshToken) === row.tokenHash) {
        await trx
          .updateTable("sessions")
          .set({
            lastUsedAt: now,
            lastSeenUserAgent: meta.userAgent ?? null,
            lastSeenIpValue: retainedIp.value,
            lastSeenIpMode: retainedIp.mode
          })
          .where("id", "=", row.sessionId)
          .execute();
        return {
          status: "rotated" as const,
          refreshToken: currentRefreshToken,
          session: toSessionResponse(row)
        };
      }

      return { status: "invalid" as const };
    }

    if (row.tokenHash !== tokenHash) {
      await trx
        .updateTable("sessions")
        .set({ revokedAt: now })
        .where("id", "=", row.sessionId)
        .where("revokedAt", "is", null)
        .execute();
      await recordAuditEvent(trx, {
        organizationId: row.organizationId,
        userId: row.userId,
        sessionId: row.sessionId,
        action: "auth.refresh_token_reused",
        targetType: "session",
        targetId: row.sessionId,
        metadata: {
          ipValue: retainedIp.value,
          ipMode: retainedIp.mode,
          userAgent: meta.userAgent ?? null
        }
      });
      return { status: "reused" as const };
    }

    const nextRefreshToken = await rotateRefreshToken(
      refreshToken,
      signingSecret
    );
    await trx
      .updateTable("sessions")
      .set({
        tokenHash: await hashSecret(nextRefreshToken),
        refreshFamilyHash: familyHash,
        previousTokenHash: tokenHash,
        rotatedAt: now,
        lastUsedAt: now,
        lastSeenUserAgent: meta.userAgent ?? null,
        lastSeenIpValue: retainedIp.value,
        lastSeenIpMode: retainedIp.mode
      })
      .where("id", "=", row.sessionId)
      .execute();

    return {
      status: "rotated" as const,
      refreshToken: nextRefreshToken,
      session: toSessionResponse(row)
    };
  });

  return result.status === "rotated"
    ? {
        refreshToken: result.refreshToken,
        session: result.session
      }
    : undefined;
}

export async function resolveAccessPrincipal(accessToken: string) {
  try {
    const claims = await verifyAccessToken(accessToken);
    const session = await loadActiveSessionResponse(getDb(), claims.sid);
    if (!session || !accessClaimsMatchSession(claims, session)) {
      return undefined;
    }

    return {
      principal: {
        userId: session.user.id,
        organizationId: session.organization?.id ?? null,
        membershipId: session.membership?.id ?? null,
        role: session.membership?.role ?? null,
        sessionId: session.sessionId,
        tokenId: claims.jti
      },
      session
    };
  } catch {
    return undefined;
  }
}

export function accessClaimsMatchSession(
  claims: AccessTokenClaims,
  session: CurrentSession
) {
  return (
    claims.sub === session.user.id &&
    claims.sid === session.sessionId &&
    claims.org === (session.organization?.id ?? null) &&
    claims.mid === (session.membership?.id ?? null) &&
    claims.role === (session.membership?.role ?? null) &&
    claims.email === session.user.email &&
    claims.email_verified === session.user.emailVerified &&
    claims.name === session.user.displayName &&
    claims.org_name === (session.organization?.name ?? "") &&
    claims.session_created_at === session.createdAt &&
    claims.session_expires_at === session.expiresAt
  );
}

export async function resolveRefreshSession(
  refreshToken: string,
  meta: RequestMeta = {}
) {
  const db = getDb();
  const tokenHash = await hashSecret(refreshToken);
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.userId")
    .leftJoin("organizations", "organizations.id", "sessions.organizationId")
    .leftJoin(
      "organizationMemberships",
      "organizationMemberships.id",
      "sessions.membershipId"
    )
    .select([
      "sessions.id as sessionId",
      "sessions.userId",
      "sessions.organizationId",
      "sessions.membershipId",
      "sessions.createdAt",
      "sessions.expiresAt",
      "organizationMemberships.role",
      "organizationMemberships.userId as membershipUserId",
      "organizationMemberships.organizationId as membershipOrganizationId",
      "users.email",
      "users.emailVerified",
      "users.displayName",
      "organizations.name as organizationName"
    ])
    .where("sessions.tokenHash", "=", tokenHash)
    .where("sessions.revokedAt", "is", null)
    .where("sessions.expiresAt", ">", new Date())
    .executeTakeFirst();

  if (!row) {
    return undefined;
  }

  if (!sessionRowIsUsable(row)) {
    await revokeSessionId(db, row.sessionId);
    return undefined;
  }

  const retainedIp = await retainedSessionIp(meta.ipAddress);
  await db
    .updateTable("sessions")
    .set({
      lastUsedAt: new Date(),
      lastSeenUserAgent: meta.userAgent ?? null,
      lastSeenIpValue: retainedIp.value,
      lastSeenIpMode: retainedIp.mode
    })
    .where("id", "=", row.sessionId)
    .execute();

  return {
    principal: {
      userId: row.userId,
      organizationId: row.organizationId,
      membershipId: row.membershipId,
      role: row.role,
      sessionId: row.sessionId
    },
    session: toSessionResponse(row)
  };
}

export async function resolvePrincipal(
  sessionToken: string,
  meta: RequestMeta = {}
) {
  return resolveRefreshSession(sessionToken, meta);
}

export async function revokeSession(principal: Principal) {
  await revokeSessionId(getDb(), principal.sessionId);

  return { ok: true as const };
}

export async function revokeUserSessions(principal: Principal) {
  await getDb()
    .updateTable("sessions")
    .set({ revokedAt: new Date() })
    .where("userId", "=", principal.userId)
    .where("revokedAt", "is", null)
    .execute();

  return { ok: true as const };
}

async function revokeSessionId(
  db: Kysely<Database> | Transaction<Database>,
  sessionId: string
) {
  await db
    .updateTable("sessions")
    .set({ revokedAt: new Date() })
    .where("id", "=", sessionId)
    .execute();
}

async function revokeMembershipSessions(
  db: Kysely<Database> | Transaction<Database>,
  membershipId: string
) {
  await db
    .updateTable("sessions")
    .set({ revokedAt: new Date() })
    .where("membershipId", "=", membershipId)
    .where("revokedAt", "is", null)
    .execute();
}

export async function listOrganizations(principal: Principal) {
  return {
    activeOrganizationId: principal.organizationId,
    organizations: await loadUserOrganizations(getDb(), principal.userId)
  };
}

export async function switchOrganization(
  principal: Principal,
  request: unknown,
  meta: RequestMeta = {},
  options: { db?: Kysely<Database> } = {}
) {
  const body = normalizeSwitchOrganizationRequest(request);
  const db = options.db ?? getDb();

  return db.transaction().execute(async (trx) => {
    const membership = await trx
      .selectFrom("organizationMemberships")
      .select(["id", "organizationId"])
      .where("userId", "=", principal.userId)
      .where("organizationId", "=", body.organizationId)
      .executeTakeFirst();

    if (!membership) {
      throw new AuthError(
        "membership_not_found",
        "No membership was found for this organization",
        403
      );
    }

    await revokeSessionId(trx, principal.sessionId);
    const refreshSession = await createSession(trx, {
      userId: principal.userId,
      organizationId: membership.organizationId,
      membershipId: membership.id,
      meta
    });

    return {
      ...(await issueAccessSession(refreshSession)),
      refreshToken: refreshSession.refreshToken
    };
  });
}

export async function createOrganization(
  principal: Principal,
  request: unknown,
  meta: RequestMeta = {}
) {
  const body = normalizeCreateOrganizationRequest(request);
  const db = getDb();

  return db.transaction().execute(async (trx) => {
    const now = new Date();
    const organization = await trx
      .insertInto("organizations")
      .values({
        name: body.name,
        slug: await nextOrganizationSlug(trx, body.name),
        createdAt: now,
        updatedAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const membership = await trx
      .insertInto("organizationMemberships")
      .values({
        organizationId: organization.id,
        userId: principal.userId,
        role: "admin",
        createdAt: now,
        updatedAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditEvent(trx, {
      organizationId: organization.id,
      userId: principal.userId,
      action: "auth.organization_created",
      targetType: "organization",
      targetId: organization.id,
      metadata: {
        name: organization.name
      }
    });

    await revokeSessionId(trx, principal.sessionId);
    const refreshSession = await createSession(trx, {
      userId: principal.userId,
      organizationId: organization.id,
      membershipId: membership.id,
      meta
    });

    return {
      ...(await issueAccessSession(refreshSession)),
      refreshToken: refreshSession.refreshToken
    };
  });
}

export async function updateCurrentUser(
  principal: Principal,
  request: unknown
) {
  const body = normalizeUpdateCurrentUserRequest(request);
  const db = getDb();
  const now = new Date();

  await db
    .updateTable("users")
    .set({
      displayName: body.displayName,
      updatedAt: now
    })
    .where("id", "=", principal.userId)
    .execute();

  await recordAuditEvent(db, {
    organizationId: principal.organizationId,
    userId: principal.userId,
    action: "auth.user_updated",
    targetType: "user",
    targetId: principal.userId,
    metadata: {
      fields: ["displayName"]
    }
  });

  return loadSessionResponse(db, principal.sessionId);
}

export async function updateCurrentOrganization(
  principal: Principal,
  request: unknown
) {
  assertCanManageOrganization(principal);
  const organizationId = requireOrganizationId(principal);
  const body = normalizeUpdateCurrentOrganizationRequest(request);
  const db = getDb();
  const now = new Date();

  await db
    .updateTable("organizations")
    .set({
      name: body.name,
      updatedAt: now
    })
    .where("id", "=", organizationId)
    .execute();

  await recordAuditEvent(db, {
    organizationId,
    userId: principal.userId,
    action: "auth.organization_updated",
    targetType: "organization",
    targetId: organizationId,
    metadata: {
      fields: ["name"]
    }
  });

  return loadSessionResponse(db, principal.sessionId);
}

export async function deleteCurrentOrganization(
  principal: Principal,
  meta: RequestMeta = {}
): Promise<DeleteCurrentOrganizationResponse> {
  assertCanManageOrganization(principal);
  const organizationId = requireOrganizationId(principal);
  const db = getDb();

  return db.transaction().execute(async (trx) => {
    const organization = await trx
      .selectFrom("organizations")
      .select(["id", "name"])
      .where("id", "=", organizationId)
      .executeTakeFirstOrThrow();
    const nextMembership = await trx
      .selectFrom("organizationMemberships")
      .select(["id", "organizationId"])
      .where("userId", "=", principal.userId)
      .where("organizationId", "!=", organizationId)
      .orderBy("createdAt", "asc")
      .executeTakeFirst();

    await trx
      .updateTable("sessions")
      .set({ revokedAt: new Date() })
      .where("id", "=", principal.sessionId)
      .execute();

    const nextSession = await createSession(trx, {
      userId: principal.userId,
      organizationId: nextMembership?.organizationId ?? null,
      membershipId: nextMembership?.id ?? null,
      meta
    });

    await trx
      .deleteFrom("organizations")
      .where("id", "=", organizationId)
      .execute();

    await recordAuditEvent(trx, {
      organizationId: nextMembership?.organizationId ?? null,
      userId: principal.userId,
      action: "auth.organization_deleted",
      targetType: "organization",
      targetId: organization.id,
      metadata: {
        organizationId: organization.id,
        name: organization.name
      }
    });

    return {
      requiresOrganization: !nextMembership,
      nextSession: await issueAccessSession(nextSession),
      refreshToken: nextSession.refreshToken
    };
  });
}

export async function listOrganizationMembers(principal: Principal) {
  return loadOrganizationMembers(getDb(), requireOrganizationId(principal));
}

export async function updateOrganizationMemberRole(
  principal: Principal,
  request: unknown
) {
  assertCanManageOrganization(principal);
  const organizationId = requireOrganizationId(principal);
  const body = normalizeUpdateOrganizationMemberRoleRequest(request);
  const db = getDb();

  return db.transaction().execute(async (trx) => {
    await lockOrganizationMemberships(trx, organizationId);
    const targetMembership = await loadOrganizationMembership(
      trx,
      organizationId,
      body.membershipId
    );

    if (!targetMembership) {
      throw new AuthError(
        "membership_not_found",
        "No membership was found for this organization",
        404
      );
    }

    if (targetMembership.role === "admin" && body.role !== "admin") {
      await assertOrganizationKeepsAdmin(trx, organizationId);
    }

    await trx
      .updateTable("organizationMemberships")
      .set({
        role: body.role,
        updatedAt: new Date()
      })
      .where("id", "=", body.membershipId)
      .where("organizationId", "=", organizationId)
      .execute();

    await recordAuditEvent(trx, {
      organizationId,
      userId: principal.userId,
      action: "auth.organization_member_role_updated",
      targetType: "organization_membership",
      targetId: body.membershipId,
      metadata: {
        role: body.role,
        ...(principal.tokenId ? { apiTokenId: principal.tokenId } : {})
      }
    });

    return loadOrganizationMembers(trx, organizationId);
  });
}

export async function removeOrganizationMember(
  principal: Principal,
  request: unknown
) {
  assertCanManageOrganization(principal);
  const organizationId = requireOrganizationId(principal);
  const body = normalizeRemoveOrganizationMemberRequest(request);
  const db = getDb();

  return db.transaction().execute(async (trx) => {
    await lockOrganizationMemberships(trx, organizationId);
    const targetMembership = await loadOrganizationMembership(
      trx,
      organizationId,
      body.membershipId
    );

    if (!targetMembership) {
      throw new AuthError(
        "membership_not_found",
        "No membership was found for this organization",
        404
      );
    }

    if (targetMembership.role === "admin") {
      await assertOrganizationKeepsAdmin(trx, organizationId);
    }

    await revokeMembershipSessions(trx, body.membershipId);

    await trx
      .deleteFrom("organizationMemberships")
      .where("id", "=", body.membershipId)
      .where("organizationId", "=", organizationId)
      .execute();

    await recordAuditEvent(trx, {
      organizationId,
      userId: principal.userId,
      action: "auth.organization_member_removed",
      targetType: "organization_membership",
      targetId: body.membershipId,
      metadata: principal.tokenId ? { apiTokenId: principal.tokenId } : {}
    });

    return loadOrganizationMembers(trx, organizationId);
  });
}

export async function createOrganizationInvite(
  principal: Principal,
  request: unknown,
  options: Pick<
    AuthEmailOptions,
    "appBaseUrl" | "db" | "emailDelivery" | "now"
  > = {}
) {
  assertCanManageOrganization(principal);
  const organizationId = requireOrganizationId(principal);
  const body = normalizeCreateOrganizationInviteRequest(request);
  const db = options.db ?? getDb();
  const delivery = requireEmailDelivery(options.emailDelivery);
  const appBaseUrl = requireAppBaseUrl(options.appBaseUrl);
  const now = options.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + body.expiresInDays * 24 * 60 * 60 * 1000
  );
  const token = randomActionToken();
  const tokenHash = await hashSecret(token);

  const result = await db.transaction().execute(async (trx) => {
    const organization = await trx
      .selectFrom("organizations")
      .select("name")
      .where("id", "=", organizationId)
      .executeTakeFirstOrThrow();
    const pendingInvite = await trx
      .selectFrom("organizationInvites")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where("email", "=", body.email)
      .where("status", "=", "pending")
      .forUpdate()
      .executeTakeFirst();
    const invite = pendingInvite
      ? await trx
          .updateTable("organizationInvites")
          .set({
            role: body.role,
            tokenHash,
            invitedByUserId: principal.userId,
            updatedAt: now,
            expiresAt
          })
          .where("id", "=", pendingInvite.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto("organizationInvites")
          .values({
            organizationId,
            email: body.email,
            role: body.role,
            status: "pending",
            tokenHash,
            invitedByUserId: principal.userId,
            createdAt: now,
            updatedAt: now,
            expiresAt,
            respondedAt: null
          })
          .returningAll()
          .executeTakeFirstOrThrow();

    await recordAuditEvent(trx, {
      organizationId,
      userId: principal.userId,
      sessionId: principal.tokenId ? null : principal.sessionId,
      action: "auth.organization_invite_created",
      targetType: "organization_invite",
      targetId: invite.id,
      metadata: {
        inviteId: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        reissued: Boolean(pendingInvite),
        ...(principal.tokenId ? { apiTokenId: principal.tokenId } : {})
      }
    });

    return { invite, organizationName: organization.name };
  });

  await deliverAuthEmail(
    delivery,
    {
      to: result.invite.email,
      subject: `You're invited to ${result.organizationName} on Lush`,
      text: `Sign in, or create an account with this email address, then open this link again: ${authLink(appBaseUrl, "/organization-invites/respond", token)}`
    },
    "organization_invite"
  );

  return {
    invite: toInviteResponse(result.invite)
  };
}

export async function listOrganizationInvites(principal: Principal) {
  assertCanManageOrganization(principal);
  const organizationId = requireOrganizationId(principal);
  const invites = await getDb()
    .selectFrom("organizationInvites")
    .selectAll()
    .where("organizationId", "=", organizationId)
    .orderBy("createdAt", "desc")
    .execute();

  return {
    invites: invites.map(toInviteResponse)
  };
}

export async function respondToOrganizationInvite(
  principal: Principal,
  request: unknown,
  options: Pick<AuthEmailOptions, "db" | "now"> = {}
) {
  const body = normalizeRespondToOrganizationInviteRequest(request);
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const tokenHash = await hashSecret(body.token);

  return db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom("users")
      .select("email")
      .where("id", "=", principal.userId)
      .executeTakeFirstOrThrow();
    const invite = await trx
      .selectFrom("organizationInvites")
      .innerJoin(
        "organizations",
        "organizations.id",
        "organizationInvites.organizationId"
      )
      .select([
        "organizationInvites.id",
        "organizationInvites.organizationId",
        "organizationInvites.email",
        "organizationInvites.role",
        "organizationInvites.status",
        "organizationInvites.invitedByUserId",
        "organizationInvites.createdAt",
        "organizationInvites.updatedAt",
        "organizationInvites.expiresAt",
        "organizationInvites.respondedAt",
        "organizations.name as organizationName"
      ])
      .where("organizationInvites.tokenHash", "=", tokenHash)
      .forUpdate("organizationInvites")
      .executeTakeFirst();

    assertUsableOrganizationInvite(invite, now);
    if (normalizeAuthEmail(user.email) !== invite.email) {
      throw new AuthError(
        "invite_email_mismatch",
        "This invitation belongs to a different email address",
        403
      );
    }

    if (body.response === "accepted") {
      await trx
        .insertInto("organizationMemberships")
        .values({
          organizationId: invite.organizationId,
          userId: principal.userId,
          role: invite.role,
          createdAt: now,
          updatedAt: now
        })
        .onConflict((conflict) =>
          conflict.columns(["organizationId", "userId"]).doNothing()
        )
        .execute();
    }

    const respondedInvite = await trx
      .updateTable("organizationInvites")
      .set({
        status: body.response,
        respondedAt: now,
        updatedAt: now
      })
      .where("id", "=", invite.id)
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditEvent(trx, {
      organizationId: invite.organizationId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      action: `auth.organization_invite_${body.response}`,
      targetType: "organization_invite",
      targetId: invite.id,
      metadata: {
        inviteId: invite.id,
        email: invite.email,
        role: invite.role
      }
    });

    return {
      invite: toInviteResponse(respondedInvite),
      organization: {
        id: invite.organizationId,
        name: invite.organizationName
      }
    };
  });
}

export async function verifyEmailAddress(
  request: unknown,
  options: Pick<AuthEmailOptions, "db" | "now"> = {}
) {
  const token = normalizeActionToken(objectRequest(request).token);
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const tokenHash = await hashSecret(token);

  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("authActionTokens")
      .innerJoin("users", "users.id", "authActionTokens.userId")
      .select([
        "authActionTokens.userId",
        "authActionTokens.expiresAt",
        "authActionTokens.usedAt"
      ])
      .where("authActionTokens.tokenHash", "=", tokenHash)
      .where("authActionTokens.purpose", "=", "verify_email")
      .forUpdate("authActionTokens")
      .executeTakeFirst();

    assertUsableAuthActionToken(row, now);
    await trx
      .updateTable("authActionTokens")
      .set({ usedAt: now })
      .where("userId", "=", row.userId)
      .where("purpose", "=", "verify_email")
      .where("usedAt", "is", null)
      .execute();
    await trx
      .updateTable("users")
      .set({ emailVerified: true, updatedAt: now })
      .where("id", "=", row.userId)
      .execute();
    await recordAuditEvent(trx, {
      organizationId: null,
      userId: row.userId,
      action: "auth.email_verified",
      targetType: "user",
      targetId: row.userId,
      metadata: { method: "email_token" }
    });

    return { ok: true as const };
  });
}

export async function requestPasswordReset(
  request: unknown,
  meta: RequestMeta = {},
  options: AuthEmailOptions = {}
) {
  ensurePasswordAuthEnabled();
  const email = normalizeAuthEmail(objectRequest(request).email);
  if (!email) {
    throw new AuthError("invalid_email", "A valid email is required");
  }

  const delivery = requireEmailDelivery(options.emailDelivery);
  const appBaseUrl = requireAppBaseUrl(options.appBaseUrl);
  const db = options.db ?? getDb();
  const user = await db
    .selectFrom("users")
    .innerJoin("passwordCredentials", "passwordCredentials.userId", "users.id")
    .select(["users.id", "users.email", "users.emailVerified"])
    .where("users.email", "=", email)
    .executeTakeFirst();

  // Keep the response indistinguishable for unknown and unverified accounts.
  if (!user?.emailVerified) {
    return { ok: true as const };
  }

  const now = options.now ?? new Date();
  const token = await db.transaction().execute(async (trx) => {
    const issued = await issueAuthActionToken(
      trx,
      user.id,
      "reset_password",
      now,
      passwordResetTtlMs
    );
    await recordAuditEvent(trx, {
      organizationId: null,
      userId: user.id,
      action: "auth.password_reset_requested",
      targetType: "user",
      targetId: user.id,
      metadata: requestAuditMetadata(meta)
    });
    return issued;
  });

  deliverAuthEmailInBackground(
    delivery,
    {
      to: user.email,
      subject: "Reset your Lush password",
      text: `Reset your password: ${authLink(appBaseUrl, "/reset-password", token)}`
    },
    "reset_password"
  );
  return { ok: true as const };
}

export async function resetPassword(
  request: unknown,
  options: Pick<AuthEmailOptions, "db" | "now"> = {}
) {
  ensurePasswordAuthEnabled();
  const body = objectRequest(request);
  const token = normalizeActionToken(body.token);
  const password = normalizePassword(body.password);
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const tokenHash = await hashSecret(token);
  const candidate = await db
    .selectFrom("authActionTokens")
    .select(["userId", "expiresAt", "usedAt"])
    .where("tokenHash", "=", tokenHash)
    .where("purpose", "=", "reset_password")
    .executeTakeFirst();
  assertUsableAuthActionToken(candidate, now);
  const passwordHash = await hashPassword(password);

  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("authActionTokens")
      .select(["id", "userId", "expiresAt", "usedAt"])
      .where("tokenHash", "=", tokenHash)
      .where("purpose", "=", "reset_password")
      .forUpdate()
      .executeTakeFirst();

    assertUsableAuthActionToken(row, now);
    await trx
      .updateTable("authActionTokens")
      .set({ usedAt: now })
      .where("userId", "=", row.userId)
      .where("purpose", "=", "reset_password")
      .where("usedAt", "is", null)
      .execute();
    await trx
      .updateTable("passwordCredentials")
      .set({ passwordHash, updatedAt: now })
      .where("userId", "=", row.userId)
      .execute();
    await trx
      .updateTable("sessions")
      .set({ revokedAt: now })
      .where("userId", "=", row.userId)
      .where("revokedAt", "is", null)
      .execute();
    await recordAuditEvent(trx, {
      organizationId: null,
      userId: row.userId,
      action: "auth.password_reset_completed",
      targetType: "user",
      targetId: row.userId,
      metadata: { sessionsRevoked: true }
    });

    return { ok: true as const };
  });
}

export async function verifyEmailAddressByOperator(email: string) {
  const normalizedEmail = normalizeAuthEmail(email);
  if (!normalizedEmail) {
    throw new AuthError("invalid_email", "A valid email is required");
  }

  const db = getDb();
  return db.transaction().execute(async (trx) => {
    const now = new Date();
    const user = await trx
      .updateTable("users")
      .set({ emailVerified: true, updatedAt: now })
      .where("email", "=", normalizedEmail)
      .returning(["id", "email", "emailVerified"])
      .executeTakeFirst();

    if (!user) {
      throw new AuthError("user_not_found", "No user exists for this email", 404);
    }

    await trx
      .updateTable("authActionTokens")
      .set({ usedAt: now })
      .where("userId", "=", user.id)
      .where("purpose", "=", "verify_email")
      .where("usedAt", "is", null)
      .execute();
    await recordAuditEvent(trx, {
      organizationId: null,
      userId: user.id,
      action: "auth.email_verified",
      targetType: "user",
      targetId: user.id,
      metadata: {
        email: user.email,
        method: "operator_override"
      }
    });

    return {
      email: user.email,
      emailVerified: user.emailVerified
    };
  });
}

export function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function ensurePasswordAuthEnabled() {
  if (!passwordAuthEnabled) {
    throw new AuthError(
      "password_auth_disabled",
      "Email/password auth is disabled",
      403
    );
  }
}

function ensureSignupEnabled() {
  if (!signupEnabled) {
    throw new AuthError("signup_disabled", "Account registration is disabled", 403);
  }
}

function requireEmailDelivery(delivery: EmailDelivery | undefined) {
  if (!delivery) {
    throw new AuthError(
      "email_delivery_unavailable",
      "Email delivery is not configured",
      503
    );
  }
  return delivery;
}

function requireAppBaseUrl(value: string | undefined) {
  const normalized = value?.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new AuthError(
      "email_delivery_unavailable",
      "The public application URL is not configured",
      503
    );
  }
  return normalized;
}

function authLink(appBaseUrl: string, path: string, token?: string) {
  const url = new URL(path, `${appBaseUrl}/`);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

async function deliverAuthEmail(
  delivery: EmailDelivery,
  message: Parameters<EmailDelivery["send"]>[0],
  purpose: AuthActionTokenPurpose | "existing_account" | "organization_invite"
) {
  try {
    await delivery.send(message);
  } catch (error) {
    logEmailDeliveryFailure(error, purpose);
    throw new AuthError(
      "email_delivery_failed",
      "Unable to deliver the authentication email",
      503
    );
  }
}

function deliverAuthEmailInBackground(
  delivery: EmailDelivery,
  message: Parameters<EmailDelivery["send"]>[0],
  purpose: AuthActionTokenPurpose
) {
  void Promise.resolve()
    .then(() => delivery.send(message))
    .catch((error) => logEmailDeliveryFailure(error, purpose));
}

function logEmailDeliveryFailure(
  error: unknown,
  purpose: AuthActionTokenPurpose | "existing_account" | "organization_invite"
) {
  logger.error({ err: error, purpose }, "authentication email delivery failed");
}

async function issueAuthActionToken(
  db: Kysely<Database> | Transaction<Database>,
  userId: string,
  purpose: AuthActionTokenPurpose,
  now: Date,
  ttlMs: number
) {
  await db
    .updateTable("authActionTokens")
    .set({ usedAt: now })
    .where("userId", "=", userId)
    .where("purpose", "=", purpose)
    .where("usedAt", "is", null)
    .execute();

  const token = randomActionToken();
  await db
    .insertInto("authActionTokens")
    .values({
      userId,
      purpose,
      tokenHash: await hashSecret(token),
      expiresAt: new Date(now.getTime() + ttlMs),
      usedAt: null,
      createdAt: now
    })
    .execute();
  return token;
}

function randomActionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function assertUsableAuthActionToken(
  row:
    | { userId: string; expiresAt: Date; usedAt: Date | null }
    | undefined,
  now: Date
): asserts row is { userId: string; expiresAt: Date; usedAt: Date | null } {
  if (!row || row.usedAt || row.expiresAt <= now) {
    throw new AuthError(
      "invalid_or_expired_token",
      "This authentication link is invalid or has expired",
      400
    );
  }
}

function assertUsableOrganizationInvite(
  invite:
    | {
        status: "pending" | "accepted" | "declined";
        expiresAt: Date;
      }
    | undefined,
  now: Date
): asserts invite is NonNullable<typeof invite> {
  if (!invite || invite.status !== "pending" || invite.expiresAt <= now) {
    throw new AuthError(
      "invalid_or_expired_invite",
      "This organization invitation is invalid or has expired",
      400
    );
  }
}

function normalizeActionToken(value: unknown) {
  const token = typeof value === "string" ? value.trim() : "";
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new AuthError(
      "invalid_or_expired_token",
      "This authentication link is invalid or has expired",
      400
    );
  }
  return token;
}

function normalizePassword(value: unknown) {
  const password = typeof value === "string" ? value : "";
  if (password.length < 8) {
    throw new AuthError(
      "invalid_password",
      "Password must be at least 8 characters"
    );
  }
  if (password.length > passwordMaxLength) {
    throw new AuthError(
      "invalid_password",
      `Password must be at most ${passwordMaxLength} characters`
    );
  }
  return password;
}

function requestAuditMetadata(meta: RequestMeta) {
  return {
    userAgent: meta.userAgent ?? null,
    hasIpAddress: Boolean(meta.ipAddress)
  };
}

function assertEmailVerifiedForAccess(emailVerified: boolean) {
  if (!emailVerified) {
    throw new AuthError(
      "email_not_verified",
      "Verify your email before signing in",
      403
    );
  }
}

function assertCanManageOrganization(principal: Principal) {
  if (principal.role !== "admin") {
    throw new AuthError(
      "insufficient_role",
      "Only organization admins can manage organization settings",
      403
    );
  }
}

function requireOrganizationId(principal: Principal) {
  if (!principal.organizationId) {
    throw new AuthError(
      "organization_required",
      "An active organization is required",
      403
    );
  }

  return principal.organizationId;
}

export function authAssertionEmailVerified(assertion: AuthAssertion) {
  if (assertion.emailVerified) {
    return true;
  }

  const issuer = typeof assertion.claims.iss === "string" ? assertion.claims.iss : "";
  return (
    (assertion.kind === "oauth" || assertion.kind === "oidc") &&
    Boolean(assertion.email) &&
    (issuer === "https://accounts.google.com" ||
      issuer === "accounts.google.com")
  );
}

function normalizeRegisterRequest(request: unknown): NormalizedRegisterAccountRequest {
  const candidate = objectRequest(request);
  const email = normalizeAuthEmail(candidate.email);
  const password = normalizePassword(candidate.password);
  const displayName =
    typeof candidate.displayName === "string" && candidate.displayName.trim()
      ? candidate.displayName.trim()
      : email.split("@")[0];
  const organizationName =
    typeof candidate.organizationName === "string" && candidate.organizationName.trim()
      ? candidate.organizationName.trim()
      : `${displayName}'s organization`;

  if (!email) {
    throw new AuthError("invalid_email", "A valid email is required");
  }

  return {
    email,
    password,
    displayName,
    organizationName
  };
}

function normalizeUpdateCurrentUserRequest(
  request: unknown
): UpdateCurrentUserRequest {
  const candidate = objectRequest(request);
  const displayName =
    typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";

  if (!displayName) {
    throw new AuthError("invalid_display_name", "Display name is required");
  }

  if (displayName.length > 120) {
    throw new AuthError(
      "invalid_display_name",
      "Display name must be 120 characters or fewer"
    );
  }

  return {
    displayName
  };
}

function normalizeCreateOrganizationRequest(
  request: unknown
): CreateOrganizationRequest {
  const candidate = objectRequest(request);
  const name = normalizeOrganizationName(candidate.name);

  return {
    name
  };
}

function normalizeSwitchOrganizationRequest(
  request: unknown
): SwitchOrganizationRequest {
  const candidate = objectRequest(request);
  const organizationId =
    typeof candidate.organizationId === "string"
      ? candidate.organizationId.trim()
      : "";

  if (!organizationId) {
    throw new AuthError("invalid_organization", "Organization is required");
  }

  return {
    organizationId
  };
}

function normalizeUpdateCurrentOrganizationRequest(
  request: unknown
): UpdateCurrentOrganizationRequest {
  const candidate = objectRequest(request);
  const name = normalizeOrganizationName(candidate.name);

  return {
    name
  };
}

function normalizeUpdateOrganizationMemberRoleRequest(
  request: unknown
): UpdateOrganizationMemberRoleRequest {
  const candidate = objectRequest(request);
  const membershipId =
    typeof candidate.membershipId === "string" ? candidate.membershipId.trim() : "";
  const role = normalizeUserRole(candidate.role);

  if (!membershipId) {
    throw new AuthError("invalid_membership", "Membership is required");
  }

  return {
    membershipId,
    role
  };
}

function normalizeRemoveOrganizationMemberRequest(
  request: unknown
): RemoveOrganizationMemberRequest {
  const candidate = objectRequest(request);
  const membershipId =
    typeof candidate.membershipId === "string" ? candidate.membershipId.trim() : "";

  if (!membershipId) {
    throw new AuthError("invalid_membership", "Membership is required");
  }

  return {
    membershipId
  };
}

function normalizeCreateOrganizationInviteRequest(
  request: unknown
): Required<CreateOrganizationInviteRequest> {
  const candidate = objectRequest(request);
  const email = normalizeAuthEmail(candidate.email);
  const role = normalizeUserRole(candidate.role);
  const expiresInDays =
    typeof candidate.expiresInDays === "number" &&
    Number.isFinite(candidate.expiresInDays)
      ? Math.max(1, Math.min(Math.floor(candidate.expiresInDays), 30))
      : 14;

  if (!email) {
    throw new AuthError("invalid_email", "A valid email is required");
  }

  return {
    email,
    role,
    expiresInDays
  };
}

function normalizeRespondToOrganizationInviteRequest(
  request: unknown
): RespondToOrganizationInviteRequest {
  const candidate = objectRequest(request);
  const token = normalizeActionToken(candidate.token);
  if (candidate.response !== "accepted" && candidate.response !== "declined") {
    throw new AuthError(
      "invalid_invite_response",
      "Invitation response must be accepted or declined"
    );
  }

  return {
    token,
    response: candidate.response
  };
}

function normalizeOrganizationName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";

  if (!name) {
    throw new AuthError("invalid_organization_name", "Organization name is required");
  }

  if (name.length > 160) {
    throw new AuthError(
      "invalid_organization_name",
      "Organization name must be 160 characters or fewer"
    );
  }

  return name;
}

function normalizeUserRole(value: unknown): UserRole {
  if (value === "admin" || value === "user") {
    return value;
  }

  throw new AuthError("invalid_role", "Role must be admin or user");
}

function normalizeLoginRequest(request: unknown): LoginRequest {
  const candidate = objectRequest(request);
  const email = normalizeAuthEmail(candidate.email);
  const password = typeof candidate.password === "string" ? candidate.password : "";
  const organizationId =
    typeof candidate.organizationId === "string" && candidate.organizationId
      ? candidate.organizationId
      : undefined;

  if (!email || !password) {
    throw new AuthError("invalid_login", "Email and password are required");
  }

  return {
    email,
    password,
    organizationId
  };
}

function objectRequest(request: unknown) {
  if (!request || typeof request !== "object") {
    throw new AuthError("invalid_request", "Invalid auth request");
  }

  return request as Record<string, unknown>;
}

async function nextOrganizationSlug(
  db: Kysely<Database> | Transaction<Database>,
  organizationName: string
) {
  const base = slugify(organizationName) || "organization";

  for (let index = 0; index < 100; index += 1) {
    const slug = index === 0 ? base : `${base}-${index + 1}`;
    const existing = await db
      .selectFrom("organizations")
      .select("id")
      .where("slug", "=", slug)
      .executeTakeFirst();

    if (!existing) {
      return slug;
    }
  }

  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

async function loadUserOrganizations(
  db: Kysely<Database> | Transaction<Database>,
  userId: string
) {
  const rows = await db
    .selectFrom("organizationMemberships")
    .innerJoin(
      "organizations",
      "organizations.id",
      "organizationMemberships.organizationId"
    )
    .select([
      "organizations.id",
      "organizations.name",
      "organizationMemberships.role"
    ])
    .where("organizationMemberships.userId", "=", userId)
    .orderBy("organizationMemberships.createdAt", "asc")
    .execute();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role
  })) satisfies OrganizationSummary[];
}

async function loadOrganizationMembers(
  db: Kysely<Database> | Transaction<Database>,
  organizationId: string
) {
  const members = await db
    .selectFrom("organizationMemberships")
    .innerJoin("users", "users.id", "organizationMemberships.userId")
    .select([
      "organizationMemberships.id as membershipId",
      "organizationMemberships.userId",
      "organizationMemberships.role",
      "users.email",
      "users.displayName"
    ])
    .where("organizationMemberships.organizationId", "=", organizationId)
    .orderBy("organizationMemberships.createdAt", "asc")
    .execute();

  return {
    members
  };
}

async function lockOrganizationMemberships(
  db: Transaction<Database>,
  organizationId: string
) {
  await sql`
    select id
    from organization_memberships
    where organization_id = ${organizationId}
    for update
  `.execute(db);
}

async function loadOrganizationMembership(
  db: Transaction<Database>,
  organizationId: string,
  membershipId: string
) {
  return db
    .selectFrom("organizationMemberships")
    .select(["id", "role"])
    .where("id", "=", membershipId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();
}

async function assertOrganizationKeepsAdmin(
  db: Transaction<Database>,
  organizationId: string
) {
  const adminCount = await countOrganizationAdmins(db, organizationId);
  if (adminCount <= 1) {
    throw new AuthError(
      "cannot_remove_last_admin",
      "Every organization must have at least one admin",
      400
    );
  }
}

async function countOrganizationAdmins(
  db: Transaction<Database>,
  organizationId: string
) {
  const result = await sql<{ admin_count: number }>`
    select count(*)::int as admin_count
    from organization_memberships
    where organization_id = ${organizationId}
      and role = 'admin'
  `.execute(db);

  return result.rows[0]?.admin_count ?? 0;
}

function toInviteResponse(invite: {
  id: string;
  email: string;
  role: UserRole;
  status: "pending" | "accepted" | "declined";
  invitedByUserId: string | null;
  createdAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
}) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    invitedByUserId: invite.invitedByUserId,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
    respondedAt: invite.respondedAt?.toISOString() ?? null
  };
}

async function createSession(
  db: Kysely<Database> | Transaction<Database>,
  options: {
    userId: string;
    organizationId: string | null;
    membershipId: string | null;
    meta: RequestMeta;
  }
) {
  const user = await db
    .selectFrom("users")
    .select(["emailVerified"])
    .where("id", "=", options.userId)
    .executeTakeFirstOrThrow();
  assertEmailVerifiedForAccess(user.emailVerified);

  const refreshToken = await createRefreshToken(
    requiredEnvValue("LUSH_SECRET_KEY")
  );
  const familySecret = refreshTokenFamilySecret(refreshToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionTtlMs);
  const tokenHash = await hashSecret(refreshToken);
  const retainedIp = await retainedSessionIp(options.meta.ipAddress);

  const row = await db
    .insertInto("sessions")
    .values({
      userId: options.userId,
      organizationId: options.organizationId,
      membershipId: options.membershipId,
      tokenHash,
      refreshFamilyHash: await hashSecret(familySecret),
      previousTokenHash: null,
      rotatedAt: null,
      userAgent: options.meta.userAgent ?? null,
      ipValue: retainedIp.value,
      ipMode: retainedIp.mode,
      lastSeenUserAgent: options.meta.userAgent ?? null,
      lastSeenIpValue: retainedIp.value,
      lastSeenIpMode: retainedIp.mode,
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
      revokedAt: null
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const session = await loadSessionResponse(db, row.id);
  return {
    refreshToken,
    session
  } satisfies RefreshSession;
}

async function loadSessionResponse(
  db: Kysely<Database> | Transaction<Database>,
  sessionId: string
) {
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.userId")
    .leftJoin("organizations", "organizations.id", "sessions.organizationId")
    .leftJoin(
      "organizationMemberships",
      "organizationMemberships.id",
      "sessions.membershipId"
    )
    .select([
      "sessions.id as sessionId",
      "sessions.userId",
      "sessions.organizationId",
      "sessions.membershipId",
      "sessions.createdAt",
      "sessions.expiresAt",
      "organizationMemberships.role",
      "users.email",
      "users.emailVerified",
      "users.displayName",
      "organizations.name as organizationName"
    ])
    .where("sessions.id", "=", sessionId)
    .executeTakeFirstOrThrow();

  return toSessionResponse(row);
}

async function loadActiveSessionResponse(
  db: Kysely<Database> | Transaction<Database>,
  sessionId: string
) {
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.userId")
    .leftJoin("organizations", "organizations.id", "sessions.organizationId")
    .leftJoin(
      "organizationMemberships",
      "organizationMemberships.id",
      "sessions.membershipId"
    )
    .select([
      "sessions.id as sessionId",
      "sessions.userId",
      "sessions.organizationId",
      "sessions.membershipId",
      "sessions.createdAt",
      "sessions.expiresAt",
      "organizationMemberships.role",
      "organizationMemberships.userId as membershipUserId",
      "organizationMemberships.organizationId as membershipOrganizationId",
      "users.email",
      "users.emailVerified",
      "users.displayName",
      "organizations.name as organizationName"
    ])
    .where("sessions.id", "=", sessionId)
    .where("sessions.revokedAt", "is", null)
    .where("sessions.expiresAt", ">", new Date())
    .executeTakeFirst();

  if (!row || !sessionRowIsUsable(row)) {
    return undefined;
  }

  return toSessionResponse(row);
}

function sessionRowIsUsable(row: {
  userId: string;
  emailVerified: boolean;
  organizationId: string | null;
  organizationName: string | null;
  membershipId: string | null;
  membershipUserId?: string | null;
  membershipOrganizationId?: string | null;
  role: UserRole | null;
}) {
  if (!row.emailVerified) {
    return false;
  }

  if (!row.organizationId) {
    return !row.organizationName && !row.membershipId && !row.role;
  }

  return (
    Boolean(row.organizationName) &&
    Boolean(row.membershipId) &&
    row.membershipUserId === row.userId &&
    row.membershipOrganizationId === row.organizationId &&
    Boolean(row.role)
  );
}

function toSessionResponse(row: {
  sessionId: string;
  userId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  organizationId: string | null;
  organizationName: string | null;
  membershipId: string | null;
  role: UserRole | null;
  createdAt: Date;
  expiresAt: Date;
}) {
  return {
    sessionId: row.sessionId,
    user: {
      id: row.userId,
      email: row.email,
      emailVerified: row.emailVerified,
      displayName: row.displayName
    },
    organization:
      row.organizationId && row.organizationName
        ? {
            id: row.organizationId,
            name: row.organizationName
          }
        : null,
    membership:
      row.membershipId && row.role
        ? {
            id: row.membershipId,
            role: row.role
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString()
  };
}

async function issueAccessSession(refreshSession: RefreshSession): Promise<AccessSession> {
  const now = new Date();
  const accessTokenExpiresAt = new Date(now.getTime() + accessTokenTtlMs);
  const accessToken = await signAccessToken({
    iss: jwtIssuer,
    aud: jwtAudience,
    sub: refreshSession.session.user.id,
    sid: sessionIdFromRefreshSession(refreshSession.session),
    org: refreshSession.session.organization?.id ?? null,
    mid: refreshSession.session.membership?.id ?? null,
    role: refreshSession.session.membership?.role ?? null,
    email: refreshSession.session.user.email,
    email_verified: refreshSession.session.user.emailVerified,
    name: refreshSession.session.user.displayName,
    org_name: refreshSession.session.organization?.name ?? "",
    session_created_at: refreshSession.session.createdAt,
    session_expires_at: refreshSession.session.expiresAt,
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(accessTokenExpiresAt.getTime() / 1000),
    jti: crypto.randomUUID()
  });

  return {
    accessToken,
    accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
    session: refreshSession.session
  };
}

function sessionIdFromRefreshSession(session: CurrentSession) {
  return session.sessionId;
}

async function signAccessToken(claims: AccessTokenClaims) {
  try {
    return await (await jwtKeyStore()).sign(claims);
  } catch (error) {
    if (error instanceof JwtKeyConfigError) {
      throw new AuthError("auth_key_invalid", error.message, 500);
    }
    throw error;
  }
}

async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  let payload: Record<string, unknown>;
  try {
    payload = await (await jwtKeyStore()).verify(token);
  } catch (error) {
    if (error instanceof JwtTokenError) {
      throw new AuthError("invalid_access_token", "Invalid access token", 401);
    }
    if (error instanceof JwtKeyConfigError) {
      throw new AuthError("auth_key_invalid", error.message, 500);
    }
    throw error;
  }

  const claims = parseAccessClaims(payload);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== jwtIssuer || claims.aud !== jwtAudience || claims.exp <= now) {
    throw new AuthError("invalid_access_token", "Invalid access token", 401);
  }

  return claims;
}

let cachedJwtKeyStore: Promise<JwtKeyStore> | undefined;

export async function initializeJwtKeyStore() {
  await jwtKeyStore();
}

function jwtKeyStore() {
  cachedJwtKeyStore ??= loadJwtKeyStore();
  return cachedJwtKeyStore;
}

async function loadJwtKeyStore() {
  try {
    const privateKey = requiredEnvValue("LUSH_AUTH_JWT_PRIVATE_KEY");
    const publicKeySet = envValue("LUSH_AUTH_JWT_PUBLIC_KEYS");
    if (publicKeySet) {
      return initializeAndLogJwtKeyStore(new JwtKeyStore(
        requiredEnvValue("LUSH_AUTH_JWT_KEY_ID"),
        privateKey,
        parseJwtPublicKeys(publicKeySet),
        true
      ));
    }

    const legacyPublicKey = requiredEnvValue("LUSH_AUTH_JWT_PUBLIC_KEY");
    const keyId = await jwtKeyIdForPublicKey(legacyPublicKey);
    return initializeAndLogJwtKeyStore(new JwtKeyStore(
      keyId,
      privateKey,
      { [keyId]: legacyPublicKey },
      true
    ));
  } catch (error) {
    if (error instanceof ConfigError || error instanceof JwtKeyConfigError) {
      throw new AuthError(
        "auth_key_invalid",
        error.message,
        500
      );
    }

    throw error;
  }
}

async function initializeAndLogJwtKeyStore(keyStore: JwtKeyStore) {
  await keyStore.initialize();
  logger.info(
    {
      signingKid: keyStore.signingKeyId,
      acceptedKids: [...keyStore.publicKeys.keys()].sort(),
      acceptsMissingKid: true
    },
    "JWT key store loaded"
  );
  return keyStore;
}

function parseAccessClaims(value: Record<string, unknown>): AccessTokenClaims {
  if (
    typeof value.iss !== "string" ||
    typeof value.aud !== "string" ||
    typeof value.sub !== "string" ||
    typeof value.sid !== "string" ||
    (typeof value.org !== "string" && value.org !== null) ||
    (typeof value.mid !== "string" && value.mid !== null) ||
    (!isUserRole(value.role) && value.role !== null) ||
    typeof value.email !== "string" ||
    typeof value.email_verified !== "boolean" ||
    typeof value.name !== "string" ||
    typeof value.org_name !== "string" ||
    typeof value.session_created_at !== "string" ||
    typeof value.session_expires_at !== "string" ||
    typeof value.iat !== "number" ||
    typeof value.exp !== "number" ||
    typeof value.jti !== "string"
  ) {
    throw new AuthError("invalid_access_token", "Invalid access token", 401);
  }

  return value as AccessTokenClaims;
}

function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "user";
}

function normalizeCreateApiTokenRequest(request: unknown) {
  if (!request || typeof request !== "object") {
    throw new AuthError("invalid_api_token", "Invalid API token request");
  }
  const candidate = request as {
    name?: unknown;
    scopes?: unknown;
    expiresInDays?: unknown;
  };
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name || name.length > 100) {
    throw new AuthError(
      "invalid_api_token_name",
      "API token name must contain 1-100 characters"
    );
  }
  if (!Array.isArray(candidate.scopes) || candidate.scopes.length === 0) {
    throw new AuthError(
      "invalid_api_token_scopes",
      "At least one API token scope is required"
    );
  }
  const allowedScopes = new Set<string>(apiTokenScopes);
  const scopes = [...new Set(candidate.scopes)];
  if (
    scopes.some(
      (scope): boolean => typeof scope !== "string" || !allowedScopes.has(scope)
    )
  ) {
    throw new AuthError(
      "invalid_api_token_scopes",
      "API token scopes contain an unsupported value"
    );
  }
  if (
    candidate.expiresInDays !== undefined &&
    (!Number.isInteger(candidate.expiresInDays) ||
      (candidate.expiresInDays as number) < 1 ||
      (candidate.expiresInDays as number) > 365)
  ) {
    throw new AuthError(
      "invalid_api_token_expiry",
      "API token expiry must be between 1 and 365 days"
    );
  }

  return {
    name,
    scopes: scopes as ApiTokenScope[],
    expiresInDays: candidate.expiresInDays as number | undefined
  };
}

function toApiToken(row: Selectable<ApiTokensTable>): ApiToken {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    prefix: row.tokenPrefix,
    scopes: row.scopes,
    createdByUserId: row.createdByUserId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

function randomHex(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}


async function recordAuditEvent(
  db: Kysely<Database> | Transaction<Database>,
  event: {
    organizationId: string | null;
    userId: string | null;
    sessionId?: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
  }
) {
  await db
    .insertInto("auditEvents")
    .values({
      organizationId: event.organizationId,
      userId: event.userId,
      sessionId: event.sessionId ?? null,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      metadata: event.metadata,
      createdAt: new Date()
    })
    .execute();
}

async function hashSecret(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
