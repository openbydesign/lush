import { sql } from "kysely";
import type { Migration } from "./types";

/** Organization API credentials with explicit, independently revocable scopes. */
export const apiTokens: Migration = {
  id: "022_api_tokens",
  async up(db) {
    await sql`
      create table if not exists api_tokens (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references organizations(id) on delete cascade,
        name text not null,
        token_prefix text not null,
        token_hash text not null unique,
        scopes text[] not null,
        created_by_user_id uuid references users(id) on delete set null,
        expires_at timestamptz,
        last_used_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz not null default now(),
        constraint api_tokens_name_length_check
          check (char_length(name) between 1 and 100),
        constraint api_tokens_scopes_nonempty_check
          check (cardinality(scopes) > 0),
        constraint api_tokens_scopes_supported_check
          check (scopes <@ array['inference:models:read', 'inference:invoke']::text[])
      )
    `.execute(db);

    await sql`
      create index if not exists api_tokens_organization_created_idx
      on api_tokens(organization_id, created_at desc)
    `.execute(db);
  }
};
