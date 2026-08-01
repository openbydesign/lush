import { expect, test } from "bun:test";
import {
  AuthError,
  apiTokenActionScopes,
  apiTokenScopes,
  authorizeApiToken,
  authzActions,
  authorizePrincipal,
  roleActionBindings,
  type ApiTokenPrincipal,
  type Principal
} from "../services/authz/src/runtime";
import { apiSpec } from "../services/api/src/spec";

const basePrincipal: Principal = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  role: "user",
  sessionId: "session-1"
};

test("role action bindings only reference known authz actions", () => {
  const knownActions = new Set<string>(authzActions);
  const boundActions = [
    ...roleActionBindings.admin,
    ...roleActionBindings.user
  ];

  expect(boundActions.every((action) => knownActions.has(action))).toBe(true);
});

test("protected api routes have matching authz actions", () => {
  const knownActions = new Set<string>(authzActions);
  const missingActions = apiSpec.routes
    .filter((route) => route.auth)
    .map((route) => route.id)
    .filter((routeId) => !knownActions.has(routeId));

  expect(missingActions).toEqual([]);
});

test("API token scopes use canonical resources and explicitly bound actions", () => {
  expect(apiTokenScopes).toEqual([
    "organization:read",
    "organization:write",
    "inference:read",
    "inference:write",
    "inference:invoke",
    "agents:read",
    "agents:write",
    "sessions:read",
    "sessions:write",
    "tools:read",
    "tools:write"
  ]);
  expect(Object.keys(apiTokenActionScopes).every((action) =>
    authzActions.includes(action as (typeof authzActions)[number])
  )).toBe(true);
  expect(new Set(Object.values(apiTokenActionScopes))).toEqual(
    new Set(apiTokenScopes)
  );
});

test("API tokens default deny routes without an explicit matching scope", () => {
  const tokenPrincipal: ApiTokenPrincipal = {
    ...basePrincipal,
    organizationId: "org-1",
    membershipId: "membership-1",
    role: "admin",
    tokenId: "token-1",
    scopes: ["sessions:read"]
  };

  expect(authorizeApiToken(tokenPrincipal, "listSessions").allowed).toBe(true);
  expect(() => authorizeApiToken(tokenPrincipal, "createSession")).toThrow(
    AuthError
  );
  expect(() => authorizeApiToken(tokenPrincipal, "createApiToken")).toThrow(
    AuthError
  );
  expect(() => authorizeApiToken(tokenPrincipal, "fetchSession")).toThrow(
    AuthError
  );
});

test("role action bindings keep users read-only for organization and inference settings", () => {
  expect(roleActionBindings.user).toContain("listOrganizationMembers");
  expect(roleActionBindings.user).toContain("fetchInferenceConfig");
  expect(roleActionBindings.user).toContain("listOpenAICompatibleModels");
  expect(roleActionBindings.user).toContain("createOpenAICompatibleResponse");
  expect(roleActionBindings.user).toContain("listSessions");
  expect(roleActionBindings.user).toContain("appendSessionMessage");
  expect(roleActionBindings.user).toContain("truncateSession");
  expect(roleActionBindings.user).not.toContain("updateCurrentOrganization");
  expect(roleActionBindings.user).not.toContain("createApiToken");
  expect(roleActionBindings.user).not.toContain("revokeApiToken");
  expect(roleActionBindings.user).not.toContain("createInferenceProvider");
  expect(roleActionBindings.user).not.toContain("refreshInferenceProviderModels");
  expect(roleActionBindings.user).not.toContain("updateInferenceModelDefault");
  expect(roleActionBindings.user).not.toContain("updateSessionSettings");
});

test("authorizePrincipal allows user read actions and rejects management actions", () => {
  expect(authorizePrincipal(basePrincipal, "fetchInferenceConfig").allowed).toBe(
    true
  );
  expect(authorizePrincipal(basePrincipal, "listOrganizationMembers").allowed).toBe(
    true
  );
  expect(authorizePrincipal(basePrincipal, "listSessions").allowed).toBe(
    true
  );

  expect(() =>
    authorizePrincipal(basePrincipal, "updateCurrentOrganization")
  ).toThrow(AuthError);
  expect(() => authorizePrincipal(basePrincipal, "createApiToken")).toThrow(
    AuthError
  );
  expect(() =>
    authorizePrincipal(basePrincipal, "createInferenceProvider")
  ).toThrow(AuthError);
  expect(() =>
    authorizePrincipal(basePrincipal, "refreshInferenceProviderModels")
  ).toThrow(AuthError);
  expect(() =>
    authorizePrincipal(basePrincipal, "updateSessionSettings")
  ).toThrow(AuthError);
});

test("authorizePrincipal allows admin organization and inference management actions", () => {
  const adminPrincipal: Principal = {
    ...basePrincipal,
    role: "admin"
  };

  expect(
    authorizePrincipal(adminPrincipal, "updateCurrentOrganization").allowed
  ).toBe(true);
  expect(authorizePrincipal(adminPrincipal, "createInferenceProvider").allowed).toBe(
    true
  );
  expect(
    authorizePrincipal(adminPrincipal, "refreshInferenceProviderModels").allowed
  ).toBe(true);
  expect(
    authorizePrincipal(adminPrincipal, "updateInferenceModelDefault").allowed
  ).toBe(true);
  expect(authorizePrincipal(adminPrincipal, "updateSessionSettings").allowed).toBe(
    true
  );
});

test("authorizePrincipal requires an active organization for role-bound actions", () => {
  const noOrganizationPrincipal: Principal = {
    ...basePrincipal,
    organizationId: null,
    membershipId: null,
    role: null
  };

  expect(
    authorizePrincipal(noOrganizationPrincipal, "updateCurrentUser").allowed
  ).toBe(true);
  expect(
    authorizePrincipal(noOrganizationPrincipal, "respondToOrganizationInvite")
      .allowed
  ).toBe(true);
  expect(() =>
    authorizePrincipal(noOrganizationPrincipal, "fetchInferenceConfig")
  ).toThrow(AuthError);
});
