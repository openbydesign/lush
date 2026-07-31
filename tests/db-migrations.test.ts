import { expect, test } from "bun:test";
import { migrations } from "../packages/db/src/migrations";

test("database migrations are registered in id order with unique ids", () => {
  const ids = migrations.map((migration) => migration.id);
  const sortedIds = [...ids].sort();

  expect(ids).toEqual(sortedIds);
  expect(new Set(ids).size).toBe(ids.length);
});

test("database migration ids match their ordinal prefix", () => {
  expect(migrations.map((migration) => migration.id)).toEqual([
    "001_auth_and_inference_state",
    "002_session_state",
    "003_session_agent_id",
    "004_projects",
    "005_refresh_token_rotation",
    "006_refresh_token_grace",
    "007_auth_action_tokens",
    "008_session_ip_retention",
    "009_session_ip_columns",
    "010_organization_invite_tokens",
    "011_inference_model_capabilities",
    "012_tool_gateway"
  ]);
});

test("model capabilities are added append-only as structured JSON", async () => {
  const migration = await Bun.file(
    "packages/db/src/migrations/011_inference_model_capabilities.ts"
  ).text();

  expect(migration).toContain("add column if not exists capabilities jsonb");
  expect(migration).toContain("not null default '{}'::jsonb");
});

test("organization invite tokens are hashed, required, and unique", async () => {
  const migration = await Bun.file(
    "packages/db/src/migrations/010_organization_invite_tokens.ts"
  ).text();

  expect(migration).toContain("add column if not exists token_hash text");
  expect(migration).toContain("alter column token_hash set not null");
  expect(migration).toContain("organization_invites_token_hash_idx");
  expect(migration).toContain(
    "md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)"
  );
});

test("auth action tokens are hashed, expiring, and single-use", async () => {
  const migration = await Bun.file(
    "packages/db/src/migrations/007_auth_action_tokens.ts"
  ).text();

  expect(migration).toContain("token_hash text not null unique");
  expect(migration).toContain("expires_at timestamptz not null");
  expect(migration).toContain("used_at timestamptz");
  expect(migration).toContain("'verify_email', 'reset_password'");
});

test("refresh-token rotation migration adds a unique token-family lookup", async () => {
  const migration = await Bun.file(
    "packages/db/src/migrations/005_refresh_token_rotation.ts"
  ).text();

  expect(migration).toContain("add column if not exists refresh_family_hash text");
  expect(migration).toContain("sessions_refresh_family_hash_idx");
  expect(migration).toContain("where refresh_family_hash is not null");
});

test("refresh-token grace migration is append-only from deployed rotation schema", async () => {
  const migration = await Bun.file(
    "packages/db/src/migrations/006_refresh_token_grace.ts"
  ).text();

  expect(migration).toContain("add column if not exists previous_token_hash text");
  expect(migration).toContain("add column if not exists rotated_at timestamptz");
  expect(migration).toContain("add column if not exists last_seen_user_agent text");
  expect(migration).toContain("add column if not exists last_seen_ip_hash text");
  expect(migration).toContain("last_seen_user_agent = user_agent");
  expect(migration).toContain("last_seen_ip_hash = ip_hash");
});

test("session IP retention migration removes enumerable legacy digests", async () => {
  const migration = await Bun.file(
    "packages/db/src/migrations/008_session_ip_retention.ts"
  ).text();

  expect(migration).toContain("ip_hash = null");
  expect(migration).toContain("last_seen_ip_hash = null");
  expect(migration).toContain("metadata - 'ipHash'");
  expect(migration).not.toContain("rename column");
});

test("session IP columns are appended after the retention migration", async () => {
  const migration = await Bun.file(
    "packages/db/src/migrations/009_session_ip_columns.ts"
  ).text();

  expect(migration).toContain("rename column ip_hash to ip_value");
  expect(migration).toContain(
    "rename column last_seen_ip_hash to last_seen_ip_value"
  );
  expect(migration).toContain("add column if not exists ip_mode text");
  expect(migration).toContain(
    "add column if not exists last_seen_ip_mode text"
  );
});
