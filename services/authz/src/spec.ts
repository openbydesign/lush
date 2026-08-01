export const authzTypes = `
export type UserRole = "admin" | "user";
export type OrganizationInviteStatus = "pending" | "accepted" | "declined";

export type RegisterAccountRequest = {
  email: string;
  password: string;
  displayName?: string;
  organizationName?: string;
};

export type EmailVerificationRequired = {
  emailVerificationRequired: true;
  email: string;
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

export type AuthActionResponse = { ok: true };

export type LogoutRequest = Record<string, never>;
export type RefreshSessionRequest = Record<string, never>;
export type LogoutAllSessionsRequest = Record<string, never>;
export type AuthRefreshReason =
  | "claims_changed"
  | "membership_changed"
  | "organization_changed"
  | "session_revoked";

export type ClientEvent = {
  type: "auth.refresh_required";
  reason: AuthRefreshReason;
};

export type UpdateCurrentUserRequest = {
  displayName: string;
};

export type UpdateCurrentOrganizationRequest = {
  name: string;
};

export type OrganizationSummary = {
  id: string;
  name: string;
  role: UserRole;
};

export type ListOrganizationsResponse = {
  activeOrganizationId: string | null;
  organizations: OrganizationSummary[];
};

export type SwitchOrganizationRequest = {
  organizationId: string;
};

export type CreateOrganizationRequest = {
  name: string;
};

export type DeleteCurrentOrganizationRequest = Record<string, never>;

export type DeleteCurrentOrganizationResponse =
  | {
      requiresOrganization: false;
      nextSession: AccessSession;
    }
  | {
      requiresOrganization: true;
      nextSession: AccessSession;
    };

export type OrganizationMember = {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  role: UserRole;
};

export type ListOrganizationMembersResponse = {
  members: OrganizationMember[];
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

export type OrganizationInvite = {
  id: string;
  email: string;
  role: UserRole;
  status: OrganizationInviteStatus;
  invitedByUserId: string | null;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
};

export type CreateOrganizationInviteResponse = {
  invite: OrganizationInvite;
};

export type ListOrganizationInvitesResponse = {
  invites: OrganizationInvite[];
};

export type RespondToOrganizationInviteRequest = {
  token: string;
  response: "accepted" | "declined";
};

export type RespondToOrganizationInviteResponse = {
  invite: OrganizationInvite;
  organization: {
    id: string;
    name: string;
  };
};

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

export type AccessSession = {
  accessToken: string;
  accessTokenExpiresAt: string;
  session: CurrentSession;
};

export type ApiTokenScope =
  | "organization:read"
  | "organization:write"
  | "inference:read"
  | "inference:write"
  | "inference:invoke"
  | "agents:read"
  | "agents:write"
  | "sessions:read"
  | "sessions:write"
  | "tools:read"
  | "tools:write";

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

export type ListApiTokensResponse = { tokens: ApiToken[] };

export type CreateApiTokenRequest = {
  name: string;
  scopes: ApiTokenScope[];
  expiresInDays?: number;
};

export type CreateApiTokenResponse = {
  token: ApiToken;
  secret: string;
};

export type RevokeApiTokenResponse = { token: ApiToken };

export type RegisterAccountResponse = EmailVerificationRequired;
`;

export const authzRoutes = [
  {
    id: "registerAccount",
    method: "POST",
    path: "/auth/register",
    requestType: "RegisterAccountRequest",
    responseType: "RegisterAccountResponse",
    auth: false,
    kind: "json"
  },
  {
    id: "login",
    method: "POST",
    path: "/auth/login",
    requestType: "LoginRequest",
    responseType: "AccessSession",
    auth: false,
    kind: "json"
  },
  {
    id: "verifyEmail",
    method: "POST",
    path: "/auth/verify-email",
    requestType: "VerifyEmailRequest",
    responseType: "AuthActionResponse",
    auth: false,
    kind: "json"
  },
  {
    id: "requestPasswordReset",
    method: "POST",
    path: "/auth/password-reset/request",
    requestType: "RequestPasswordResetRequest",
    responseType: "AuthActionResponse",
    auth: false,
    kind: "json"
  },
  {
    id: "resetPassword",
    method: "POST",
    path: "/auth/password-reset",
    requestType: "ResetPasswordRequest",
    responseType: "AuthActionResponse",
    auth: false,
    kind: "json"
  },
  {
    id: "refreshSession",
    method: "POST",
    path: "/auth/refresh",
    requestType: "RefreshSessionRequest",
    responseType: "AccessSession",
    auth: false,
    kind: "json"
  },
  {
    id: "logout",
    method: "POST",
    path: "/auth/logout",
    requestType: "LogoutRequest",
    responseType: "{ ok: true }",
    auth: true,
    kind: "json"
  },
  {
    id: "logoutAllSessions",
    method: "POST",
    path: "/auth/logout-all",
    requestType: "LogoutAllSessionsRequest",
    responseType: "{ ok: true }",
    auth: true,
    kind: "json"
  },
  {
    id: "fetchSession",
    method: "GET",
    path: "/session",
    responseType: "CurrentSession",
    auth: true,
    kind: "json"
  },
  {
    id: "openClientEvents",
    method: "GET",
    path: "/auth/events",
    responseType: "ClientEvent",
    auth: true,
    kind: "event-stream"
  },
  {
    id: "listOrganizations",
    method: "GET",
    path: "/organizations",
    responseType: "ListOrganizationsResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "switchOrganization",
    method: "POST",
    path: "/organizations/switch",
    requestType: "SwitchOrganizationRequest",
    responseType: "AccessSession",
    auth: true,
    kind: "json"
  },
  {
    id: "createOrganization",
    method: "POST",
    path: "/organizations",
    requestType: "CreateOrganizationRequest",
    responseType: "AccessSession",
    auth: true,
    kind: "json"
  },
  {
    id: "updateCurrentUser",
    method: "POST",
    path: "/session/user",
    requestType: "UpdateCurrentUserRequest",
    responseType: "CurrentSession",
    auth: true,
    kind: "json"
  },
  {
    id: "updateCurrentOrganization",
    method: "POST",
    path: "/session/organization",
    requestType: "UpdateCurrentOrganizationRequest",
    responseType: "CurrentSession",
    auth: true,
    kind: "json"
  },
  {
    id: "deleteCurrentOrganization",
    method: "POST",
    path: "/session/organization/delete",
    requestType: "DeleteCurrentOrganizationRequest",
    responseType: "DeleteCurrentOrganizationResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "listOrganizationMembers",
    method: "GET",
    path: "/session/organization/members",
    responseType: "ListOrganizationMembersResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "updateOrganizationMemberRole",
    method: "POST",
    path: "/session/organization/members/role",
    requestType: "UpdateOrganizationMemberRoleRequest",
    responseType: "ListOrganizationMembersResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "removeOrganizationMember",
    method: "POST",
    path: "/session/organization/members/remove",
    requestType: "RemoveOrganizationMemberRequest",
    responseType: "ListOrganizationMembersResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "createOrganizationInvite",
    method: "POST",
    path: "/session/organization/invites",
    requestType: "CreateOrganizationInviteRequest",
    responseType: "CreateOrganizationInviteResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "listOrganizationInvites",
    method: "GET",
    path: "/session/organization/invites",
    responseType: "ListOrganizationInvitesResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "respondToOrganizationInvite",
    method: "POST",
    path: "/session/organization/invites/respond",
    requestType: "RespondToOrganizationInviteRequest",
    responseType: "RespondToOrganizationInviteResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "listApiTokens",
    method: "GET",
    path: "/tokens",
    responseType: "ListApiTokensResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "createApiToken",
    method: "POST",
    path: "/tokens",
    requestType: "CreateApiTokenRequest",
    responseType: "CreateApiTokenResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "revokeApiToken",
    method: "POST",
    path: "/tokens/:tokenId/revoke",
    requestType: "Record<string, never>",
    responseType: "RevokeApiTokenResponse",
    auth: true,
    kind: "json"
  }
] as const;

export type AuthzRoute = (typeof authzRoutes)[number];
