import { sql } from "kysely";
import type { Migration } from "./types";

/**
 * Converge databases that recorded migration 012 before the Phase 2 rollout
 * flag was appended to that migration during development.
 */
export const toolGatewayRolloutConvergence: Migration = {
  id: "016_tool_gateway_rollout_convergence",
  async up(db) {
    await sql`
      alter table organizations
      add column if not exists tool_gateway_enabled boolean not null default false
    `.execute(db);
  }
};
