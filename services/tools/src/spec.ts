export const toolsTypes = `
export type ToolSource = "mcp" | "openapi" | "native";
export type ToolConnectionScope = "organization" | "user";
export type ToolCredentialMode = "none" | "organization" | "user_delegated";

export type ToolConnection = {
  id: string;
  organizationId: string;
  scope: ToolConnectionScope;
  ownerUserId: string | null;
  source: ToolSource;
  label: string;
  endpoint: string | null;
  credentialMode: ToolCredentialMode;
  enabled: boolean;
  hasCredential: boolean;
  catalogVersion: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ListToolConnectionsResponse = {
  connections: ToolConnection[];
};

export type ToolAnnotations = {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};

export type ToolDefinition = {
  id: string;
  connectionId: string;
  externalName: string;
  qualifiedName: string;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown | null;
  annotations: unknown;
  definitionDigest: string;
  enabled: boolean;
};

export type ListToolDefinitionsResponse = {
  definitions: ToolDefinition[];
};

export type CreateToolConnectionRequest = {
  scope: ToolConnectionScope;
  source: ToolSource;
  label: string;
  endpoint?: { url?: string; headers?: Record<string, string> };
  credentialMode?: ToolCredentialMode;
  secret?: string;
};

export type UpdateToolConnectionRequest = {
  connectionId: string;
  label?: string;
  enabled?: boolean;
  secret?: string | null;
};

export type DeleteToolConnectionRequest = {
  connectionId: string;
};

export type DeletedToolConnection = {
  id: string;
};

export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "json"; data: unknown }
  | { type: "resource"; uri: string; mimeType?: string; text?: string }
  | { type: "binary"; mimeType: string; base64: string };

export type ToolResult = {
  isError: boolean;
  content: ToolResultContent[];
  structured?: unknown;
};

export type ToolApprovalDescriptor = {
  approvalId: string;
  scope: string;
  definitionDigest: string;
  inputDigest: string;
  expiresAt: string;
};

export type InvokeToolRequest = {
  toolName: string;
  input?: unknown;
  expectedDefinitionDigest: string;
  idempotencyKey?: string;
  runId?: string;
};

export type InvokeToolResponse =
  | { status: "succeeded" | "failed"; toolCallId: string; result: ToolResult }
  | { status: "denied"; toolCallId: string | null; reason: string }
  | { status: "approval_required"; toolCallId: string; approval: ToolApprovalDescriptor };

export type DecideToolApprovalRequest = {
  approve: boolean;
};

export type DecideToolApprovalResponse = {
  approvalId: string;
  status: "approved" | "denied";
};
`;

export const toolsRoutes = [
  {
    id: "listToolConnections",
    method: "GET",
    path: "/tools/connections",
    responseType: "ListToolConnectionsResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "createToolConnection",
    method: "POST",
    path: "/tools/connections",
    requestType: "CreateToolConnectionRequest",
    responseType: "ToolConnection",
    auth: true,
    kind: "json"
  },
  {
    id: "updateToolConnection",
    method: "POST",
    path: "/tools/connections/update",
    requestType: "UpdateToolConnectionRequest",
    responseType: "ToolConnection",
    auth: true,
    kind: "json"
  },
  {
    id: "deleteToolConnection",
    method: "POST",
    path: "/tools/connections/delete",
    requestType: "DeleteToolConnectionRequest",
    responseType: "DeletedToolConnection",
    auth: true,
    kind: "json"
  },
  {
    id: "listToolDefinitions",
    method: "GET",
    path: "/tools/connections/:connectionId/definitions",
    responseType: "ListToolDefinitionsResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "discoverToolCatalog",
    method: "POST",
    path: "/tools/connections/:connectionId/discover",
    responseType: "ListToolDefinitionsResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "invokeTool",
    method: "POST",
    path: "/tools/connections/:connectionId/invoke",
    requestType: "InvokeToolRequest",
    responseType: "InvokeToolResponse",
    auth: true,
    kind: "json"
  },
  {
    id: "decideToolApproval",
    method: "POST",
    path: "/tools/approvals/:approvalId",
    requestType: "DecideToolApprovalRequest",
    responseType: "DecideToolApprovalResponse",
    auth: true,
    kind: "json"
  }
] as const;

export type ToolsRoute = (typeof toolsRoutes)[number];
