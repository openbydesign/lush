import { useEffect, useState } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PencilIcon,
  RotateCwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  WrenchIcon
} from "lucide-react";
import {
  Message as ShadcnMessage,
  MessageContent as ShadcnMessageContent,
  MessageFooter
} from "../components/ui/message";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle
} from "../components/ui/attachment";
import { Spinner } from "../components/ui/spinner";
import { Button } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "../components/ui/collapsible";
import {
  MessageAction,
  MessageActions,
  MessageResponse
} from "../components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger
} from "../components/ai-elements/reasoning";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger
} from "../components/ai-elements/sources";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput
} from "../components/ai-elements/tool";
import {
  Artifact,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle
} from "../components/ai-elements/artifact";
import { chatMessageText } from "../lib/agent-message";
import type { ChatMessage, ChatMessagePart } from "../lib/types";

export function Message({
  message,
  initialFeedback,
  onFeedback,
  onRetry,
  onEdit,
  onToolApproval,
  actionsDisabled = false
}: {
  message: ChatMessage;
  initialFeedback?: "up" | "down";
  onFeedback?: (messageId: string, sentiment: "up" | "down") => Promise<void>;
  onRetry?: () => void | Promise<void>;
  onEdit?: () => void;
  onToolApproval?: (approvalId: string, approve: boolean) => Promise<unknown>;
  actionsDisabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | undefined>(
    initialFeedback
  );
  const sources = message.parts.filter(
    (part): part is Extract<ChatMessagePart, { type: "source" }> =>
      part.type === "source"
  );
  const attachments = message.parts.filter(
    (part): part is Extract<ChatMessagePart, { type: "attachment" }> =>
      part.type === "attachment"
  );
  const tools = message.parts.filter(
    (part): part is Extract<ChatMessagePart, { type: "tool" }> =>
      part.type === "tool"
  );
  const firstToolIndex = message.parts.findIndex((part) => part.type === "tool");

  const copy = async () => {
    await navigator.clipboard.writeText(chatMessageText(message));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  useEffect(() => setFeedback(initialFeedback), [initialFeedback]);

  const submitFeedback = async (sentiment: "up" | "down") => {
    const previousFeedback = feedback;
    setFeedback(sentiment);
    try {
      await onFeedback?.(message.serverId ?? message.id, sentiment);
    } catch {
      setFeedback(previousFeedback);
    }
  };

  return (
    <article
      data-message-id={message.id}
      className="group/chat-message scroll-mt-8"
    >
      <ShadcnMessage align={message.role === "user" ? "end" : "start"}>
        <ShadcnMessageContent>
          <Bubble
            align={message.role === "user" ? "end" : "start"}
            variant={message.role === "user" ? "muted" : "ghost"}
            className={
              message.role === "assistant" ? "max-w-full" : "max-w-[76%]"
            }
          >
            <BubbleContent
              className={
                message.role === "user"
                  ? "rounded-xl px-4 py-3 text-[0.9375rem] leading-6"
                  : "text-[0.975rem] leading-7"
              }
            >
              {sources.length > 0 ? (
                <Sources>
                  <SourcesTrigger count={sources.length} />
                  <SourcesContent>
                    {sources.map((source) => (
                      <Source
                        key={source.sourceId}
                        href={source.url}
                        title={source.title}
                      />
                    ))}
                  </SourcesContent>
                </Sources>
              ) : null}

              {attachments.length > 0 ? (
                <AttachmentGroup className="mb-3">
                  {attachments.map((attachment) => (
                    <Attachment key={attachment.id} size="sm">
                      <AttachmentMedia>
                        <FileTextIcon />
                      </AttachmentMedia>
                      <AttachmentContent>
                        <AttachmentTitle>{attachment.filename}</AttachmentTitle>
                        <AttachmentDescription>
                          {attachment.mediaType} · {formatBytes(attachment.size)}
                        </AttachmentDescription>
                      </AttachmentContent>
                    </Attachment>
                  ))}
                </AttachmentGroup>
              ) : null}

              {message.parts.map((part, index) => (
                part.type === "tool" ? (
                  index === firstToolIndex ? (
                    <ToolActivity
                      key="tool-activity"
                      tools={tools}
                      onApproval={onToolApproval}
                    />
                  ) : null
                ) : (
                  <MessagePart
                    key={partKey(part, index)}
                    part={part}
                    role={message.role}
                    streaming={message.status === "streaming"}
                    onToolApproval={onToolApproval}
                  />
                )
              ))}

              {message.status === "streaming" && message.parts.length === 0 ? (
                <ToolActivityPlaceholder />
              ) : null}
            </BubbleContent>
          </Bubble>

          {message.status !== "streaming" ? (
            <MessageFooter
              className={
                message.role === "user"
                  ? "opacity-0 transition-opacity group-focus-within/chat-message:opacity-100 group-hover/chat-message:opacity-100"
                  : undefined
              }
            >
              <MessageActions className="gap-0.5">
                {message.role === "user" && message.createdAt ? (
                  <time
                    dateTime={message.createdAt}
                    title={formatMessageDate(message.createdAt)}
                    className="mr-1 tabular-nums text-muted-foreground"
                  >
                    {formatMessageTime(message.createdAt)}
                  </time>
                ) : null}
                {message.role === "user" && onRetry ? (
                  <MessageAction
                    tooltip="Retry"
                    disabled={actionsDisabled}
                    onClick={() => void onRetry()}
                  >
                    <RotateCwIcon />
                  </MessageAction>
                ) : null}
                {message.role === "user" && onEdit ? (
                  <MessageAction
                    tooltip="Edit"
                    disabled={actionsDisabled}
                    onClick={onEdit}
                  >
                    <PencilIcon />
                  </MessageAction>
                ) : null}
                <MessageAction
                  tooltip={message.role === "user" ? "Copy message" : "Copy response"}
                  onClick={() => void copy()}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </MessageAction>
                {message.role === "assistant" && onFeedback ? (
                  <>
                    <MessageAction
                      tooltip="Helpful"
                      aria-pressed={feedback === "up"}
                      className={feedback === "up" ? "bg-muted text-foreground" : undefined}
                      onClick={() => void submitFeedback("up")}
                    >
                      <ThumbsUpIcon />
                    </MessageAction>
                    <MessageAction
                      tooltip="Not helpful"
                      aria-pressed={feedback === "down"}
                      className={feedback === "down" ? "bg-muted text-foreground" : undefined}
                      onClick={() => void submitFeedback("down")}
                    >
                      <ThumbsDownIcon />
                    </MessageAction>
                  </>
                ) : null}
              </MessageActions>
            </MessageFooter>
          ) : null}
        </ShadcnMessageContent>
      </ShadcnMessage>
    </article>
  );
}

function ToolActivityPlaceholder() {
  return (
    <div
      role="status"
      className="not-prose my-2.5 flex min-h-8 max-w-full items-center gap-2 rounded-lg px-1.5 py-1 text-xs text-muted-foreground"
    >
      <Spinner className="size-3.5" />
      <span>Working</span>
    </div>
  );
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatMessageDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function MessagePart(props: {
  part: ChatMessagePart;
  role: ChatMessage["role"];
  streaming: boolean;
  onToolApproval?: (approvalId: string, approve: boolean) => Promise<unknown>;
}) {
  const { part } = props;
  switch (part.type) {
    case "text":
      return props.role === "assistant" ? (
        <MessageResponse
          className="font-serif text-base leading-[25px] [&_code]:font-mono [&_pre]:font-mono"
          isAnimating={props.streaming}
        >
          {part.text}
        </MessageResponse>
      ) : (
        <p className="whitespace-pre-wrap text-[0.9375rem] leading-6">
          {part.text}
        </p>
      );
    case "reasoning":
      return (
        <Reasoning isStreaming={props.streaming} duration={part.durationMs ? part.durationMs / 1_000 : undefined}>
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    case "tool":
      return <ToolMessagePart part={part} />;
    case "artifact":
      return (
        <Artifact>
          <ArtifactHeader>
            <div>
              <ArtifactTitle>{part.title}</ArtifactTitle>
              {part.description ? (
                <ArtifactDescription>{part.description}</ArtifactDescription>
              ) : null}
            </div>
          </ArtifactHeader>
          {part.content ? (
            <ArtifactContent>
              <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{part.content}</pre>
            </ArtifactContent>
          ) : null}
        </Artifact>
      );
    case "attachment":
    case "source":
      return null;
  }
}

function ToolMessagePart({
  part
}: {
  part: Extract<ChatMessagePart, { type: "tool" }>;
}) {
  return (
    <Tool
      defaultOpen={part.state === "approval-requested"}
      className="mb-2 last:mb-0"
    >
      <ToolHeader
        type="dynamic-tool"
        toolName={part.toolName}
        title={part.toolTitle ?? readableToolName(part.toolName)}
        state={part.state}
      />
      <ToolContent>
        {part.input !== undefined ? <ToolInput input={part.input} /> : null}
        <ToolOutput output={part.output} errorText={part.errorText} />
      </ToolContent>
    </Tool>
  );
}

function ToolActivity({
  tools,
  onApproval
}: {
  tools: Array<Extract<ChatMessagePart, { type: "tool" }>>;
  onApproval?: (approvalId: string, approve: boolean) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const pending = tools.filter((tool) => tool.state === "approval-requested");
  const active = tools.filter(
    (tool) => tool.state === "input-available" || tool.state === "input-streaming"
  );
  const failed = tools.filter(
    (tool) => tool.state === "output-error" || tool.state === "output-denied"
  );
  const labels = [...new Set(tools.map(
    (tool) => tool.toolTitle ?? readableToolName(tool.toolName)
  ))];
  const connections = uniqueToolConnections(tools);
  const summary = pending.length > 0
    ? `${pending.length} tool ${pending.length === 1 ? "needs" : "need"} approval`
    : active.length > 0
      ? `Consulting ${compactToolList(labels)}`
      : `Consulted ${compactToolList(labels)}`;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="not-prose my-2.5 w-full"
    >
      <CollapsibleTrigger
        className="group/tool-activity flex min-h-8 max-w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        aria-label="Inspect tool calls"
      >
        <span className="flex shrink-0 -space-x-1" aria-hidden="true">
          {connections.slice(0, 3).map((tool) => (
            <ToolConnectionIcon key={tool.key} tool={tool} />
          ))}
        </span>
        <span className="min-w-0 truncate">{summary}</span>
        {pending.length > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-amber-700 dark:text-amber-400">
            <AlertTriangleIcon className="size-3" />
            Review
          </span>
        ) : active.length > 0 ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
        ) : failed.length > 0 ? (
          <span className="shrink-0 text-destructive">
            {failed.length} failed
          </span>
        ) : null}
        <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/tool-activity:rotate-180" />
      </CollapsibleTrigger>
      {pending.map((tool) => (
        <ToolApprovalPrompt
          key={`approval-${tool.toolCallId}`}
          tool={tool}
          onApproval={onApproval}
        />
      ))}
      <CollapsibleContent className="mt-2 border-l border-border/70 pl-3">
        {tools.map((tool) => (
          <ToolMessagePart
            key={tool.toolCallId}
            part={tool}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolApprovalPrompt({
  tool,
  onApproval
}: {
  tool: Extract<ChatMessagePart, { type: "tool" }>;
  onApproval?: (approvalId: string, approve: boolean) => Promise<unknown>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [decision, setDecision] = useState<"approved" | "denied">();
  const [error, setError] = useState("");
  const respond = async (approve: boolean) => {
    if (!tool.approvalId || !onApproval || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onApproval(tool.approvalId, approve);
      setDecision(approve ? "approved" : "denied");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to record approval");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ml-1.5 mt-1.5 flex max-w-xl flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs">
      <span className="mr-auto min-w-0 truncate font-medium">
        {tool.toolTitle ?? readableToolName(tool.toolName)}
      </span>
      {decision ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          {decision === "approved" ? <CheckIcon className="size-3" /> : null}
          {decision === "approved" ? "Approved" : "Denied"}
        </span>
      ) : (
        <>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={submitting || !onApproval}
            onClick={() => void respond(false)}
          >
            Deny
          </Button>
          <Button
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={submitting || !onApproval}
            onClick={() => void respond(true)}
          >
            {submitting ? "Saving…" : "Allow once"}
          </Button>
        </>
      )}
      {error ? (
        <p className="w-full text-xs text-destructive" role="alert">{error}</p>
      ) : null}
    </div>
  );
}

function ToolConnectionIcon({
  tool
}: {
  tool: Extract<ChatMessagePart, { type: "tool" }> & { key: string };
}) {
  const [iconAttempt, setIconAttempt] = useState(0);
  const label = tool.connectionLabel ?? tool.toolTitle ?? readableToolName(tool.toolName);
  const iconUrls = faviconCandidates(tool.connectionIconUrl);
  const iconUrl = iconUrls[iconAttempt];
  return (
    <span className="flex size-5 items-center justify-center overflow-hidden rounded-md border border-background bg-muted text-[10px] font-medium text-muted-foreground shadow-sm">
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setIconAttempt((attempt) => attempt + 1)}
        />
      ) : tool.connectionSource === "mcp" ? (
        <McpMark />
      ) : label ? (
        label.slice(0, 1).toUpperCase()
      ) : (
        <WrenchIcon className="size-3" />
      )}
    </span>
  );
}

function McpMark() {
  return (
    <svg
      viewBox="0 0 180 180"
      aria-label="MCP"
      className="size-3.5 text-foreground"
      fill="none"
    >
      <path
        d="M18 84.853 85.882 16.971c9.373-9.373 24.569-9.373 33.941 0 9.373 9.372 9.373 24.568 0 33.941L68.558 102.177"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <path
        d="m69.265 101.47 50.558-50.558c9.373-9.373 24.569-9.373 33.942 0l.353.353c9.373 9.373 9.373 24.569 0 33.941L92.725 146.6a8 8 0 0 0 0 11.313l12.606 12.607"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <path
        d="M102.853 33.941 52.648 84.146c-9.372 9.372-9.372 24.568 0 33.941 9.373 9.372 24.569 9.372 33.941 0l50.205-50.205"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
      />
    </svg>
  );
}

function faviconCandidates(value?: string) {
  if (!value) return [];
  try {
    const direct = new URL(value);
    const labels = direct.hostname.split(".");
    if (
      labels.length <= 2 ||
      direct.hostname === "localhost" ||
      direct.hostname.includes(":") ||
      labels.every((label) => /^\d+$/.test(label))
    ) {
      return [direct.toString()];
    }
    const parent = new URL(direct.toString());
    parent.hostname = labels.slice(1).join(".");
    return [direct.toString(), parent.toString()];
  } catch {
    return [];
  }
}

function uniqueToolConnections(
  tools: Array<Extract<ChatMessagePart, { type: "tool" }>>
) {
  const seen = new Set<string>();
  return tools.flatMap((tool) => {
    const key = tool.connectionLabel ?? tool.connectionIconUrl ?? tool.toolName;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...tool, key }];
  });
}

function compactToolList(labels: string[]) {
  if (labels.length === 0) return "tools";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return labels.join(" and ");
  return `${labels.length} tools`;
}

function readableToolName(value: string) {
  const name = value.includes("__") ? value.split("__").at(-1)! : value;
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function partKey(part: ChatMessagePart, index: number) {
  if (part.type === "tool") return `tool-${part.toolCallId}`;
  if (part.type === "source") return `source-${part.sourceId}`;
  if (part.type === "artifact") return `artifact-${part.artifactId}`;
  if (part.type === "attachment") return `attachment-${part.id}`;
  return `${part.type}-${index}`;
}

function formatBytes(size?: number) {
  if (!size) return "text context";
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
}
