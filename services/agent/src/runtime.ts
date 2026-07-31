import {
  streamInferenceChat,
  type InferenceChatMessage
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
