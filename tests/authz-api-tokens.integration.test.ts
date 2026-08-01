import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createIsolatedTestDatabase } from "../packages/db/src/test";
import {
  apiTokenHasScope,
  authorizeApiToken,
  createApiToken,
  listApiTokens,
  resolveApiToken,
  revokeApiToken,
  updateOrganizationMemberRole,
  type Principal
} from "../services/authz/src/runtime";
import { integrationDatabaseUrl } from "./integration-database";

const databaseUrl = integrationDatabaseUrl();

if (!databaseUrl) {
  test.skip("API tokens require a test database URL", () => {});
} else {
  describe("scoped organization API tokens", () => {
    let harness: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    let db: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["db"];
    let admin: Principal;
    let user: Principal;

    beforeAll(async () => {
      harness = await createIsolatedTestDatabase(databaseUrl);
      db = harness.db;
      const organization = await db
        .insertInto("organizations")
        .values({
          name: "Token test",
          slug: `token-test-${crypto.randomUUID()}`,
          createdAt: new Date(),
          updatedAt: new Date()
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      admin = await insertPrincipal(db, organization.id, "admin");
      user = await insertPrincipal(db, organization.id, "user");
    });

    afterAll(async () => {
      await harness?.destroy();
    });

    test("creates a one-time secret and resolves only its stored scopes", async () => {
      const now = new Date("2026-07-31T12:00:00.000Z");
      const created = await createApiToken(
        admin,
        {
          name: "Production router",
          scopes: ["inference:read", "inference:invoke"],
          expiresInDays: 30
        },
        { db, now }
      );

      expect(created.secret).toMatch(/^sk_[0-9a-f]{16}_[0-9a-f]{64}$/);
      expect(created.token).toMatchObject({
        name: "Production router",
        prefix: created.secret.slice(0, "sk_".length + 16),
        scopes: ["inference:read", "inference:invoke"],
        expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
        revokedAt: null
      });

      const stored = await db
        .selectFrom("apiTokens")
        .select(["tokenHash", "tokenPrefix"])
        .where("id", "=", created.token.id)
        .executeTakeFirstOrThrow();
      expect(stored.tokenHash).toBe(await hashSecret(created.secret));
      expect(stored.tokenHash).not.toBe(created.secret);
      expect(stored.tokenPrefix).toBe(created.token.prefix);

      const resolved = await resolveApiToken(created.secret, {
        db,
        now: new Date(now.getTime() + 1)
      });
      expect(resolved).toEqual({
        tokenId: created.token.id,
        userId: admin.userId,
        organizationId: created.token.organizationId,
        membershipId: admin.membershipId,
        role: "admin",
        sessionId: null,
        scopes: ["inference:read", "inference:invoke"]
      });
      expect(apiTokenHasScope(resolved!, "inference:invoke")).toBe(true);

      const listed = await listApiTokens(admin, { db });
      expect(listed.tokens[0]).toMatchObject({ id: created.token.id });
      expect(listed).not.toHaveProperty("secret");
    });

    test("rejects unsupported scopes and non-admin management", async () => {
      await expect(
        createApiToken(admin, { name: "No access", scopes: [] }, { db })
      ).rejects.toMatchObject({ code: "invalid_api_token_scopes" });
      await expect(
        createApiToken(
          admin,
          { name: "Over-scoped", scopes: ["admin:all"] },
          { db }
        )
      ).rejects.toMatchObject({ code: "invalid_api_token_scopes" });
      await expect(
        createApiToken(
          user,
          { name: "User token", scopes: ["inference:invoke"] },
          { db }
        )
      ).rejects.toMatchObject({ code: "insufficient_role" });
    });

    test("invalidates tokens when their creating user leaves the organization", async () => {
      const actor = await insertPrincipal(db, admin.organizationId!, "admin");
      const created = await createApiToken(
        actor,
        { name: "Departing owner", scopes: ["sessions:read"] },
        { db }
      );

      await db
        .deleteFrom("organizationMemberships")
        .where("id", "=", actor.membershipId!)
        .execute();

      expect(await resolveApiToken(created.secret, { db })).toBeUndefined();
    });

    test("uses the creator's live role when authorizing a token", async () => {
      const actor = await insertPrincipal(db, admin.organizationId!, "admin");
      const created = await createApiToken(
        actor,
        { name: "Demoted owner", scopes: ["organization:write"] },
        { db }
      );

      await db
        .updateTable("organizationMemberships")
        .set({ role: "user", updatedAt: new Date() })
        .where("id", "=", actor.membershipId!)
        .execute();

      const resolved = await resolveApiToken(created.secret, { db });
      expect(resolved).toMatchObject({ role: "user", sessionId: null });
      expect(() =>
        authorizeApiToken(resolved!, "updateOrganizationMemberRole")
      ).toThrow("You do not have permission to perform this action");
      await expect(
        updateOrganizationMemberRole(
          resolved!,
          { membershipId: user.membershipId, role: "admin" },
          { db }
        )
      ).rejects.toMatchObject({ code: "insufficient_role" });
    });

    test("records token-authenticated organization mutations without a session", async () => {
      const actor = await insertPrincipal(db, admin.organizationId!, "admin");
      const target = await insertPrincipal(db, admin.organizationId!, "user");
      const created = await createApiToken(
        actor,
        { name: "Organization manager", scopes: ["organization:write"] },
        { db }
      );
      const resolved = await resolveApiToken(created.secret, { db });

      expect(
        authorizeApiToken(resolved!, "updateOrganizationMemberRole").allowed
      ).toBe(true);
      await updateOrganizationMemberRole(
        resolved!,
        { membershipId: target.membershipId, role: "admin" },
        { db }
      );

      const membership = await db
        .selectFrom("organizationMemberships")
        .select("role")
        .where("id", "=", target.membershipId!)
        .executeTakeFirstOrThrow();
      expect(membership.role).toBe("admin");

      const audit = await db
        .selectFrom("auditEvents")
        .select(["sessionId", "metadata"])
        .where("action", "=", "auth.organization_member_role_updated")
        .where("targetId", "=", target.membershipId!)
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({
        sessionId: null,
        metadata: { apiTokenId: created.token.id, role: "admin" }
      });
    });

    test("revocation and expiration fail closed", async () => {
      const now = new Date("2026-07-31T13:00:00.000Z");
      const created = await createApiToken(
        admin,
        {
          name: "Temporary",
          scopes: ["inference:read"],
          expiresInDays: 1
        },
        { db, now }
      );

      expect(
        await resolveApiToken(created.secret, {
          db,
          now: new Date(now.getTime() + 86_400_001)
        })
      ).toBeUndefined();
      await revokeApiToken(admin, created.token.id, {
        db,
        now: new Date(now.getTime() + 1)
      });
      expect(
        await resolveApiToken(created.secret, {
          db,
          now: new Date(now.getTime() + 2)
        })
      ).toBeUndefined();
      const listed = await listApiTokens(admin, { db });
      expect(listed.tokens.some((token) => token.id === created.token.id)).toBe(false);

      const actions = await db
        .selectFrom("auditEvents")
        .select("action")
        .where("targetId", "=", created.token.id)
        .orderBy("createdAt", "asc")
        .execute();
      expect(actions.map((event) => event.action)).toEqual([
        "auth.api_token_created",
        "auth.api_token_revoked"
      ]);
    });
  });
}

async function insertPrincipal(
  db: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["db"],
  organizationId: string,
  role: "admin" | "user"
): Promise<Principal> {
  const now = new Date();
  const user = await db
    .insertInto("users")
    .values({
      email: `${crypto.randomUUID()}@example.com`,
      emailVerified: true,
      displayName: role,
      createdAt: now,
      updatedAt: now
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const membership = await db
    .insertInto("organizationMemberships")
    .values({ organizationId, userId: user.id, role, createdAt: now, updatedAt: now })
    .returning("id")
    .executeTakeFirstOrThrow();
  const session = await db
    .insertInto("sessions")
    .values({
      userId: user.id,
      organizationId,
      membershipId: membership.id,
      tokenHash: crypto.randomUUID(),
      refreshFamilyHash: null,
      previousTokenHash: null,
      rotatedAt: null,
      userAgent: null,
      ipValue: null,
      ipMode: "off",
      lastSeenUserAgent: null,
      lastSeenIpValue: null,
      lastSeenIpMode: "off",
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
      revokedAt: null
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return {
    userId: user.id,
    organizationId,
    membershipId: membership.id,
    role,
    sessionId: session.id
  };
}

async function hashSecret(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
