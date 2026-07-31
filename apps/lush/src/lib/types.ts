export type Appearance = "dark" | "light" | "system";

export type Route = {
  href: string;
  label: string;
  eyebrow: string;
  title: string;
  body: string;
  sessionAgentId?: string;
};

export type Concept = {
  slug: string;
  title: string;
  summary: string;
  body: string;
};

export type ChatMessage = {
  id: string;
  serverId?: string;
  createdAt?: string;
  animateEntrance?: boolean;
  role: "user" | "assistant";
  parts: ChatMessagePart[];
  status?: "streaming" | "complete" | "error";
};

export type ChatAttachmentPart = {
  type: "attachment";
  id: string;
  filename: string;
  mediaType: string;
  size?: number;
  content: string;
};

export type ChatToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-denied"
  | "output-error";

export type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; durationMs?: number }
  | (ChatAttachmentPart)
  | {
      type: "tool";
      toolCallId: string;
      toolName: string;
      toolTitle?: string;
      connectionLabel?: string;
      connectionSource?: "mcp" | "openapi" | "native";
      connectionIconUrl?: string;
      state: ChatToolState;
      input?: unknown;
      output?: unknown;
      errorText?: string;
      approvalId?: string;
      approvalExpiresAt?: string;
      approvalDecision?: "approved" | "denied" | "expired";
    }
  | { type: "source"; sourceId: string; url: string; title: string }
  | {
      type: "artifact";
      artifactId: string;
      title: string;
      description?: string;
      mediaType: string;
      content?: string;
      url?: string;
    };

export type SessionStatus = "signed-out" | "loading" | "ready" | "error";
