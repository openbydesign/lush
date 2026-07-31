import { sql } from "kysely";
import type { Migration } from "./types";

/** Keep catalog drift visible until a connection manager reviews it. */
export const toolCatalogAcknowledgment: Migration = {
  id: "015_tool_catalog_acknowledgment",
  async up(db) {
    await sql`
      alter table tool_connections
      add column if not exists catalog_acknowledged_version text
    `.execute(db);
  }
};
