import { sql } from "kysely";
import type { Migration } from "./types";

/** Expands organization API tokens from inference-only to canonical API scopes. */
export const apiTokenCanonicalScopes: Migration = {
  id: "023_api_token_canonical_scopes",
  async up(db) {
    await sql`
      alter table api_tokens
      drop constraint api_tokens_scopes_supported_check
    `.execute(db);

    await sql`
      update api_tokens
      set scopes = array_replace(scopes, 'inference:models:read', 'inference:read')
      where scopes @> array['inference:models:read']::text[]
    `.execute(db);

    await sql`
      alter table api_tokens
      add constraint api_tokens_scopes_supported_check check (
        scopes <@ array[
          'organization:read',
          'organization:write',
          'inference:read',
          'inference:write',
          'inference:invoke',
          'agents:read',
          'agents:write',
          'sessions:read',
          'sessions:write',
          'tools:read',
          'tools:write'
        ]::text[]
      )
    `.execute(db);
  }
};
