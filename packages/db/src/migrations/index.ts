import { authAndInferenceState } from "./001_auth_and_inference_state";
import { sessionState } from "./002_session_state";
import { sessionAgentId } from "./003_session_agent_id";
import { projects } from "./004_projects";
import { refreshTokenRotation } from "./005_refresh_token_rotation";
import { refreshTokenGrace } from "./006_refresh_token_grace";
import { authActionTokens } from "./007_auth_action_tokens";
import { sessionIpRetention } from "./008_session_ip_retention";
import { sessionIpColumns } from "./009_session_ip_columns";
import { organizationInviteTokens } from "./010_organization_invite_tokens";
import { inferenceModelCapabilities } from "./011_inference_model_capabilities";
import { toolGateway } from "./012_tool_gateway";
import { agentRuns } from "./013_agent_runs";
import { toolControlPlane } from "./014_tool_control_plane";
import type { Migration } from "./types";

export const migrations: Migration[] = [
  authAndInferenceState,
  sessionState,
  sessionAgentId,
  projects,
  refreshTokenRotation,
  refreshTokenGrace,
  authActionTokens,
  sessionIpRetention,
  sessionIpColumns,
  organizationInviteTokens,
  inferenceModelCapabilities,
  toolGateway,
  agentRuns,
  toolControlPlane
];
