import { sql } from "kysely";
import type { Migration } from "./types";

export const inferenceModelCapabilities: Migration = {
  id: "011_inference_model_capabilities",
  async up(db) {
    await sql`
      alter table inference_provider_models
      add column if not exists capabilities jsonb not null default '{}'::jsonb
    `.execute(db);
  }
};
