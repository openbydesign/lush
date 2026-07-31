import {
  streamInferenceChat,
  streamInferenceTurn,
  type InferenceChatMessage,
  type InferenceTool,
  type InferenceTurnMessage
} from "@lush/inference/runtime";
import { lushAgent } from "./agents/lush";

export type AgentChatAttachment = {
  filename: string;
  mediaType: string;
  content: string;
};

export type AgentChatMessage = InferenceChatMessage & {
  attachments?: AgentChatAttachment[];
};

export type ProjectAgentContext = {
  id?: string;
  name: string;
  instructions: string;
  memory: string;
  contextItems: AgentChatAttachment[];
};

export type StreamLushAgentChatOptions = {
  organizationId: string;
  instructions?: string;
  modelSelection?: string;
  messages: AgentChatMessage[];
  project?: ProjectAgentContext;
  signal: AbortSignal;
};

export function getLushAgentMetadata() {
  return {
    id: lushAgent.id,
    name: lushAgent.name,
    sessionAgentId: lushAgent.sessionAgentId
  };
}

export async function* streamLushAgentChat({
  organizationId,
  instructions,
  modelSelection,
  messages,
  project,
  signal
}: StreamLushAgentChatOptions) {
  yield* streamInferenceChat({
    organizationId,
    modelSelection,
    systemPrompt: projectSystemPrompt(instructions ?? lushAgent.systemPrompt, project),
    messages: messages.map(toInferenceMessage),
    signal
  });
}

export async function* streamLushAgentTurn(options: {
  organizationId: string;
  instructions?: string;
  modelSelection?: string;
  messages: Array<AgentChatMessage | Exclude<InferenceTurnMessage, {
    role: "system";
  }>>;
  tools: InferenceTool[];
  project?: ProjectAgentContext;
  signal: AbortSignal;
}) {
  if (options.tools.length === 0) {
    yield* textEvents(streamLushAgentChat({
      organizationId: options.organizationId,
      instructions: options.instructions,
      modelSelection: options.modelSelection,
      messages: options.messages.filter(
        (message): message is AgentChatMessage =>
          "content" in message &&
          (message.role === "user" || message.role === "assistant")
      ),
      project: options.project,
      signal: options.signal
    }));
    return;
  }
  yield* streamInferenceTurn({
    organizationId: options.organizationId,
    modelSelection: options.modelSelection,
    systemPrompt: projectSystemPrompt(
      options.instructions ?? lushAgent.systemPrompt,
      options.project
    ),
    messages: options.messages.map((message) =>
      "content" in message && (message.role === "user" || message.role === "assistant")
        ? toInferenceMessage(message as AgentChatMessage)
        : message as Exclude<InferenceTurnMessage, { role: "system" }>
    ),
    tools: options.tools,
    signal: options.signal
  });
}

async function* textEvents(chunks: AsyncGenerator<string>) {
  for await (const delta of chunks) yield { type: "text_delta" as const, delta };
}

export function projectSystemPrompt(
  basePrompt: string,
  project: StreamLushAgentChatOptions["project"]
) {
  if (!project) return basePrompt;

  const sections = [basePrompt, `<project name=${JSON.stringify(project.name)}>`];
  if (project.instructions) {
    sections.push(`<instructions>\n${project.instructions}\n</instructions>`);
  }
  if (project.memory) {
    sections.push(`<memory>\n${project.memory}\n</memory>`);
  }
  if (project.contextItems.length > 0) {
    const context = project.contextItems
      .map(
        (item) =>
          `<file name=${JSON.stringify(item.filename)} media-type=${JSON.stringify(item.mediaType)}>\n${item.content}\n</file>`
      )
      .join("\n\n");
    sections.push(`<context>\n${context}\n</context>`);
  }
  sections.push("</project>");
  return sections.join("\n\n");
}

function toInferenceMessage(message: AgentChatMessage): InferenceChatMessage {
  if (!message.attachments?.length) return message;

  const attachmentContext = message.attachments
    .map(
      (attachment) =>
        `<file name=${JSON.stringify(attachment.filename)} media-type=${JSON.stringify(attachment.mediaType)}>\n${attachment.content}\n</file>`
    )
    .join("\n\n");

  return {
    role: message.role,
    content: `${message.content}\n\n<attachments>\n${attachmentContext}\n</attachments>`
  };
}
