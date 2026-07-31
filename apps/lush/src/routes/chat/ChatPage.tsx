import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ApiError,
  cancelAgentRun,
  type InferenceProviderStatus,
  type Session,
  type UserRole,
} from "@lush/api-client";
import { EmptyChatState } from "../../components/chat/EmptyChatState";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments
} from "../../components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments
} from "../../components/ai-elements/prompt-input";
import { Settings2Icon, XIcon } from "lucide-react";
import {
  createId,
  getFirstName,
  readComposerFocusRequest,
  readProjectChatState
} from "../../lib/app-data";
import {
  appendAgentStreamEvent,
  agentChatMessage,
  chatMessageFromSession,
  chatMessageMetadata,
  chatMessageRequestText,
  chatMessageText,
  promptAttachments,
  readAgentRunEventStream
} from "../../lib/agent-message";
import {
  agentResponseErrorMessage,
  getModelLabel,
  postAgentRun,
  reconnectAgentRun,
  titleFromContent
} from "../../lib/chat-stream";
import type {
  ChatAttachmentPart,
  ChatMessage,
  ChatMessagePart
} from "../../lib/types";
import { Message } from "../../ui/Message";
import { MessageScroller, MessageScrollerItem } from "../../ui/MessageScroller";
import {
  chatModelSelectionFromSession,
  modelSelectionName,
  resolveChatModelSelection
} from "../../lib/chat-model-selection";

function getGreeting(date: Date) {
  const hour = date.getHours();

  if (hour < 12) {
    return "Good morning";
  }

  if (hour < 17) {
    return "Good afternoon";
  }

  return "Good evening";
}

export function ChatPage(props: {
  displayName: string;
  apiBaseUrl: string;
  defaultModelSelection: string;
  providers: InferenceProviderStatus[];
  currentRole?: UserRole;
  session?: Session;
  sessionKey: number;
  ensureSession: (force?: boolean) => Promise<string | undefined>;
  onCreateSession: (request: {
    title: string;
    projectId?: string | null;
  }) => Promise<string>;
  onTruncateSession: (
    sessionId: string,
    afterMessageId: string | null
  ) => Promise<Session>;
  onMessageFeedback: (
    sessionId: string,
    messageId: string,
    sentiment: "up" | "down"
  ) => Promise<void>;
  onModelSelectionChange: (
    sessionId: string,
    modelSelection: string
  ) => Promise<void>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const stopRequestedRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerContainerRef = useRef<HTMLDivElement>(null);
  const syncedSessionKeyRef = useRef<number | undefined>(undefined);
  const modelSelectionSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const modelSelectionRevisionRef = useRef(0);
  const projectPromptHandledRef = useRef<string | undefined>(undefined);

  const [now, setNow] = useState(new Date());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [error, setError] = useState("");
  const initialSessionModelSelection = chatModelSelectionFromSession(
    props.session
  );
  const [selectedModelSelection, setSelectedModelSelection] = useState(
    initialSessionModelSelection ?? props.defaultModelSelection
  );
  const [hasThreadModelSelection, setHasThreadModelSelection] = useState(
    Boolean(initialSessionModelSelection)
  );
  const [modelSelectionSaveError, setModelSelectionSaveError] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [composerHeight, setComposerHeight] = useState(0);
  const [scrollerResetKey, setScrollerResetKey] = useState(
    props.session?.id ?? "new"
  );
  const [pendingEdit, setPendingEdit] = useState<{
    sessionId: string;
    afterMessageId: string | null;
    attachments: ChatAttachmentPart[];
  }>();
  const greeting = `${getGreeting(now)}, ${getFirstName(props.displayName)}`;
  const composerFocusRequest = readComposerFocusRequest(location.state);
  const projectChatState = readProjectChatState(location.state);
  const hasMessages = messages.length > 0;
  const enabledModelSelections =
    props.providers.flatMap((provider) =>
      provider.models.map((model) => `${provider.id}:${model.id}`)
    );
  const modelSelectionResolution = resolveChatModelSelection({
    requestedModelSelection: selectedModelSelection,
    defaultModelSelection: props.defaultModelSelection,
    enabledModelSelections
  });
  const activeModelSelection = modelSelectionResolution.modelSelection;
  const activeModelLabel =
    getModelLabel(props.providers, activeModelSelection) ||
    modelSelectionName(activeModelSelection);
  const unavailableThreadModelSelection = hasThreadModelSelection
    ? modelSelectionResolution.unavailableModelSelection
    : undefined;
  const unavailableModelNotice = unavailableThreadModelSelection
    ? activeModelSelection
      ? `Saved model “${modelSelectionName(unavailableThreadModelSelection)}” is unavailable. Using “${activeModelLabel}”.`
      : `Saved model “${modelSelectionName(unavailableThreadModelSelection)}” is unavailable. Configure an enabled model to continue.`
    : "";

  useEffect(() => {
    if (!hasThreadModelSelection) {
      setSelectedModelSelection(props.defaultModelSelection);
    }
  }, [hasThreadModelSelection, props.defaultModelSelection]);

  useEffect(() => {
    const session = props.session;
    const sessionKey = props.sessionKey;
    if (isStreaming || sessionKey === syncedSessionKeyRef.current) {
      return;
    }

    syncedSessionKeyRef.current = sessionKey;
    // Writes from this chat update the persisted session while the local
    // transcript already contains the same turn. Replacing it would change
    // every optimistic message ID and make the scroller treat the turn as new.
    if (session?.id && session.id === activeSessionId) {
      return;
    }

    setActiveSessionId(session?.id);
    setScrollerResetKey(session?.id ?? `new:${sessionKey}`);
    setMessages(sessionChatMessages(session));
    const restoredModelSelection = chatModelSelectionFromSession(session);
    setSelectedModelSelection(
      restoredModelSelection ?? props.defaultModelSelection
    );
    setHasThreadModelSelection(Boolean(restoredModelSelection));
    modelSelectionRevisionRef.current += 1;
    setModelSelectionSaveError("");
    setPendingEdit(undefined);
    setError("");
  }, [props.session, props.sessionKey, isStreaming, activeSessionId]);

  useEffect(() => {
    const clockInterval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => {
      window.clearInterval(clockInterval);
    };
  }, []);

  useEffect(() => {
    if (!composerFocusRequest) return;
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [composerFocusRequest]);

  useEffect(() => {
    const composer = composerContainerRef.current;
    if (!composer) return;

    const updateComposerHeight = () => {
      setComposerHeight(Math.ceil(composer.getBoundingClientRect().height));
    };
    updateComposerHeight();
    const observer = new ResizeObserver(updateComposerHeight);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  const updateAssistantMessage = (
    id: string,
    updater: (message: ChatMessage) => ChatMessage
  ) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? updater(message) : message))
    );

  };

  const persistModelSelection = (
    sessionId: string,
    modelSelection: string
  ) => {
    const save = modelSelectionSaveQueueRef.current
      .catch(() => undefined)
      .then(() => props.onModelSelectionChange(sessionId, modelSelection));
    modelSelectionSaveQueueRef.current = save;
    return save;
  };

  const reportModelSelectionSaveError = (
    caught: unknown,
    revision: number
  ) => {
    if (revision !== modelSelectionRevisionRef.current) return;
    const message =
      caught instanceof Error
        ? caught.message
        : "Unable to save model selection";
    setModelSelectionSaveError(`Model selection was not saved. ${message}`);
  };

  const selectModel = (modelSelection: string) => {
    if (!modelSelection) return;
    const revision = ++modelSelectionRevisionRef.current;
    setSelectedModelSelection(modelSelection);
    setHasThreadModelSelection(true);
    setModelSelectionSaveError("");
    if (!activeSessionId) return;

    void persistModelSelection(activeSessionId, modelSelection).catch((caught) =>
      reportModelSelectionSaveError(caught, revision)
    );
  };

  const sendTurn = async (
    parts: ChatMessagePart[],
    options: {
      sessionId?: string;
      retainedUser?: ChatMessage;
      baseMessages?: ChatMessage[];
    } = {}
  ) => {
    const content = chatMessageText({ parts }).trim();
    const attachments = parts.filter(
      (part): part is Extract<ChatMessagePart, { type: "attachment" }> =>
        part.type === "attachment"
    );
    if ((!content && attachments.length === 0) || isStreaming) return;

    const createdAt = new Date().toISOString();
    const modelSelection = activeModelSelection;
    const userMessage: ChatMessage = options.retainedUser ?? {
      id: createId(),
      createdAt,
      animateEntrance: true,
      role: "user",
      parts,
      status: "complete"
    };
    const assistantMessage: ChatMessage = {
      id: createId(),
      createdAt,
      role: "assistant",
      parts: [],
      status: "streaming"
    };
    const idempotencyKey = `chat-turn:${createId()}`;
    setError("");
    if (!options.retainedUser) setInput("");
    setIsStreaming(true);
    setMessages((current) => [
      ...(options.baseMessages ?? current),
      ...(options.retainedUser ? [] : [userMessage]),
      assistantMessage
    ]);

    abortControllerRef.current = new AbortController();
    stopRequestedRef.current = false;
    let sessionId = options.sessionId ?? activeSessionId;
    let assistantParts: ChatMessagePart[] = [];

    try {
      if (!sessionId) {
        sessionId = await props.onCreateSession({
          title: titleFromContent(content || attachments[0]?.filename || ""),
          projectId: projectChatState?.projectId
        });
        setActiveSessionId(sessionId);
        setHasThreadModelSelection(true);
        const revision = ++modelSelectionRevisionRef.current;
        await persistModelSelection(sessionId, modelSelection).catch((caught) =>
          reportModelSelectionSaveError(caught, revision)
        );
      }

      let token = await props.ensureSession();
      const runRequest = {
        idempotencyKey,
        ...(options.retainedUser?.serverId
          ? { originMessageId: options.retainedUser.serverId }
          : {}),
        message: agentChatMessage(userMessage),
        metadata: chatMessageMetadata(userMessage.parts)
      };
      let response: Response;
      while (true) {
        try {
          response = await postAgentRun(
            props.apiBaseUrl,
            token,
            modelSelection,
            sessionId,
            runRequest,
            abortControllerRef.current.signal
          );
          if (response.status === 401) {
            token = await props.ensureSession(true);
            continue;
          }
          break;
        } catch (caught) {
          if (abortControllerRef.current.signal.aborted) throw caught;
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
      }

      if (!response.ok) {
        throw new Error(await agentResponseErrorMessage(response));
      }

      const runId = response.headers.get("x-lush-run");
      if (!runId) throw new Error("The agent did not return a run identifier.");
      activeRunIdRef.current = runId;
      if (stopRequestedRef.current) {
        try {
          await cancelAgentRun(props.apiBaseUrl, runId, token, {});
        } catch (caught) {
          if (!(caught instanceof ApiError) || caught.status !== 401) throw caught;
          token = await props.ensureSession(true);
          await cancelAgentRun(props.apiBaseUrl, runId, token, {});
        }
      }
      let lastSequence = 0;
      let runError: Error | undefined;
      let assistantServerId: string | undefined;
      const consume = async (stream: Response) => {
        await readAgentRunEventStream(stream, (event) => {
          if (event.sequence <= lastSequence) return;
          lastSequence = event.sequence;
          const payload = event.payload && typeof event.payload === "object"
            ? event.payload as Record<string, unknown>
            : {};
          if (event.type === "run-start" && typeof payload.originMessageId === "string") {
            setMessages((current) => current.map((message) =>
              message.id === userMessage.id
                ? { ...message, serverId: payload.originMessageId as string }
                : message
            ));
          }
          if (event.type === "response-error") {
            runError = new Error(
              typeof payload.message === "string" ? payload.message : "Agent run failed"
            );
            return;
          }
          if (event.type === "response-reset") {
            assistantParts = [];
            updateAssistantMessage(assistantMessage.id, (message) => ({
              ...message,
              parts: []
            }));
            return;
          }
          if (
            event.type === "response-complete" &&
            typeof payload.assistantMessageId === "string"
          ) {
            assistantServerId = payload.assistantMessageId;
          }
          if (event.type !== "text-delta" || typeof payload.delta !== "string") return;
          assistantParts = appendAgentStreamEvent(assistantParts, {
            type: "text-delta",
            delta: payload.delta
          });
          updateAssistantMessage(assistantMessage.id, (message) => ({
            ...message,
            parts: assistantParts
          }));
        });
      };

      while (true) {
        try {
          await consume(response);
          if (runError) throw runError;
          break;
        } catch (caught) {
          if (runError) throw runError;
          if (abortControllerRef.current.signal.aborted) throw caught;
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          response = await reconnectAgentRun(
            props.apiBaseUrl,
            token,
            runId,
            lastSequence,
            abortControllerRef.current.signal
          );
          if (response.status === 401) {
            token = await props.ensureSession(true);
            response = await reconnectAgentRun(
              props.apiBaseUrl,
              token,
              runId,
              lastSequence,
              abortControllerRef.current.signal
            );
          }
          if (!response.ok) {
            throw new Error(await agentResponseErrorMessage(response));
          }
        }
      }
      updateAssistantMessage(assistantMessage.id, (message) => ({
        ...message,
        serverId: assistantServerId,
        status: "complete"
      }));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        updateAssistantMessage(assistantMessage.id, (current) => ({
          ...current,
          parts: assistantParts,
          status: "complete"
        }));
      } else {
        const message =
          caught instanceof Error ? caught.message : "Unable to reach agent";
        updateAssistantMessage(assistantMessage.id, (current) => ({
          ...current,
          status: "error",
          parts: chatMessageText(current)
            ? current.parts
            : [{ type: "text", text: message }]
        }));
      }
    } finally {
      setIsStreaming(false);
      activeRunIdRef.current = undefined;
      stopRequestedRef.current = false;
      abortControllerRef.current = undefined;
    }
  };

  useEffect(() => {
    if (
      !projectChatState ||
      projectPromptHandledRef.current === projectChatState.requestId ||
      activeSessionId ||
      messages.length > 0 ||
      isStreaming
    ) {
      return;
    }

    projectPromptHandledRef.current = projectChatState.requestId;
    void sendTurn([{ type: "text", text: projectChatState.prompt }]);
  }, [
    activeSessionId,
    isStreaming,
    messages.length,
    projectChatState?.projectId,
    projectChatState?.prompt,
    projectChatState?.requestId
  ]);

  const submit = async (prompt: PromptInputMessage) => {
    const content = prompt.text.trim();
    if ((!content && prompt.files.length === 0) || isStreaming || isRewriting) return;

    const attachments = await promptAttachments(prompt.files);
    const parts: ChatMessagePart[] = [
      ...(content ? [{ type: "text" as const, text: content }] : []),
      ...(pendingEdit?.attachments ?? []),
      ...attachments
    ];

    if (!pendingEdit) {
      await sendTurn(parts);
      return;
    }

    setIsRewriting(true);
    setError("");
    try {
      const truncated = await props.onTruncateSession(
        pendingEdit.sessionId,
        pendingEdit.afterMessageId
      );
      setScrollerResetKey(
        `${pendingEdit.sessionId}:edit:${createId()}`
      );
      const edit = pendingEdit;
      setPendingEdit(undefined);
      await sendTurn(parts, {
        sessionId: edit.sessionId,
        baseMessages: sessionChatMessages(truncated)
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to edit message"
      );
    } finally {
      setIsRewriting(false);
    }
  };

  const editMessage = (message: ChatMessage) => {
    if (!activeSessionId || !message.serverId || isStreaming || isRewriting) {
      return;
    }
    const content = chatMessageText(message);
    if (!content) return;
    const messageIndex = messages.findIndex((item) => item.id === message.id);
    if (messageIndex < 0) return;
    const precedingMessages = messages.slice(0, messageIndex);
    const afterMessageId = [...precedingMessages]
      .reverse()
      .find((item) => item.serverId)?.serverId ?? null;
    setPendingEdit({
      sessionId: activeSessionId,
      afterMessageId,
      attachments: message.parts.filter(
        (part): part is ChatAttachmentPart => part.type === "attachment"
      )
    });
    setInput(content);
    window.requestAnimationFrame(() => {
      const composer = composerRef.current;
      composer?.focus();
      composer?.setSelectionRange(content.length, content.length);
    });
  };

  const retryMessage = async (message: ChatMessage) => {
    if (!activeSessionId || !message.serverId || isStreaming || isRewriting) {
      return;
    }
    const messageIndex = messages.findIndex((item) => item.id === message.id);
    if (messageIndex < 0) return;

    setIsRewriting(true);
    setPendingEdit(undefined);
    setInput("");
    setError("");
    try {
      const truncated = await props.onTruncateSession(
        activeSessionId,
        message.serverId
      );
      const retainedMessages = sessionChatMessages(truncated);
      const retainedUser = retainedMessages.find(
        (item) => item.serverId === message.serverId
      );
      if (!retainedUser || retainedUser.role !== "user") {
        throw new Error("Unable to locate the retried message");
      }
      setScrollerResetKey(`${activeSessionId}:retry:${createId()}`);
      await sendTurn(retainedUser.parts, {
        sessionId: activeSessionId,
        retainedUser,
        baseMessages: retainedMessages
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to retry message"
      );
    } finally {
      setIsRewriting(false);
    }
  };

  const stop = () => {
    const runId = activeRunIdRef.current;
    if (!runId) {
      stopRequestedRef.current = true;
      return;
    }
    stopRequestedRef.current = true;
    void (async () => {
      try {
        let token = await props.ensureSession();
        try {
          await cancelAgentRun(props.apiBaseUrl, runId, token, {});
        } catch (caught) {
          if (!(caught instanceof ApiError) || caught.status !== 401) throw caught;
          token = await props.ensureSession(true);
          await cancelAgentRun(props.apiBaseUrl, runId, token, {});
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Unable to cancel run");
      }
    })();
  };

  const cancelEdit = () => {
    setPendingEdit(undefined);
    setInput("");
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const useSuggestion = (prompt: string) => {
    setInput(prompt);
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <MessageScroller
        resetKey={scrollerResetKey}
        busy={isStreaming}
        bottomInset={composerHeight}
      >
        {hasMessages ? (
          messages.map((message) => (
            <MessageScrollerItem
              key={message.id}
              messageId={message.id}
              scrollAnchor={message.role === "user"}
              animateEntrance={message.animateEntrance}
            >
              <Message
                message={message}
                initialFeedback={feedbackForMessage(
                  props.session,
                  message.serverId ?? message.id
                )}
                onFeedback={
                  activeSessionId && message.serverId
                    ? (messageId, sentiment) =>
                        props.onMessageFeedback(
                          activeSessionId,
                          messageId,
                          sentiment
                        )
                    : undefined
                }
                onRetry={
                  message.role === "user" && activeSessionId && message.serverId
                    ? () => retryMessage(message)
                    : undefined
                }
                onEdit={
                  message.role === "user" &&
                  activeSessionId &&
                  message.serverId &&
                  chatMessageText(message)
                    ? () => editMessage(message)
                    : undefined
                }
                actionsDisabled={isStreaming || isRewriting}
              />
            </MessageScrollerItem>
          ))
        ) : (
          <EmptyChatState
            greeting={greeting}
            onUseSuggestion={useSuggestion}
          />
        )}
      </MessageScroller>

      <div ref={composerContainerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-[var(--color-bg)] from-70% to-transparent px-1 pt-6">
        <div className="pointer-events-auto mx-auto w-full max-w-3xl">
          <PromptInput
            onSubmit={submit}
            accept="text/*,application/json,application/xml,application/yaml,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.yaml,.yml,.toml,.sql"
            multiple
            maxFiles={4}
            maxFileSize={32 * 1024}
            onError={(promptError) => setError(promptError.message)}
            className="w-full"
          >
            {pendingEdit ? (
              <PromptInputHeader className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Editing message</span>
                {pendingEdit.attachments.length > 0 ? (
                  <span className="min-w-0 truncate">
                    · retaining {pendingEdit.attachments.map((part) => part.filename).join(", ")}
                  </span>
                ) : null}
                <PromptInputButton
                  tooltip="Cancel edit"
                  className="ml-auto"
                  onClick={cancelEdit}
                >
                  <XIcon />
                </PromptInputButton>
              </PromptInputHeader>
            ) : null}
            <PendingAttachments />
            <PromptInputBody>
              <PromptInputTextarea
                ref={composerRef}
                value={input}
                onChange={(event) => {
                  setInput(event.currentTarget.value);
                  if (error) setError("");
                }}
                placeholder={
                  hasMessages ? "Write a message..." : "How can I help you today?"
                }
                className="min-h-9 px-4 py-1.5 text-base md:text-base"
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools className="w-full">
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger tooltip="Add context" />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments label="Add text files" />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>

                <div className="ml-auto min-w-0">
                  {props.providers.length > 0 ? (
                    <PromptInputSelect
                      value={activeModelSelection}
                      onValueChange={(value) => selectModel(value ?? "")}
                      disabled={isStreaming}
                    >
                      <PromptInputSelectTrigger className="max-w-52">
                        <PromptInputSelectValue placeholder="Select model">
                          {activeModelLabel}
                        </PromptInputSelectValue>
                      </PromptInputSelectTrigger>
                      <PromptInputSelectContent>
                        {props.providers.flatMap((provider) =>
                          provider.models.map((model) => {
                            const selection = `${provider.id}:${model.id}`;
                            return (
                              <PromptInputSelectItem
                                key={selection}
                                value={selection}
                              >
                                {provider.label} / {model.label}
                              </PromptInputSelectItem>
                            );
                          })
                        )}
                      </PromptInputSelectContent>
                    </PromptInputSelect>
                  ) : props.currentRole === "admin" ? (
                    <PromptInputButton
                      tooltip="Configure inference"
                      onClick={() => navigate("/settings/inference")}
                    >
                      <Settings2Icon />
                      Configure model
                    </PromptInputButton>
                  ) : null}
                </div>
              </PromptInputTools>
              <ChatSubmit
                input={input}
                error={error}
                isStreaming={isStreaming}
                disabled={isRewriting}
                modelSelection={activeModelSelection}
                onStop={stop}
              />
            </PromptInputFooter>
          </PromptInput>
          {error ? (
            <p className="mt-2 px-1 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {unavailableModelNotice || modelSelectionSaveError ? (
            <p
              className="mt-2 px-1 text-xs text-amber-700 dark:text-amber-400"
              role={modelSelectionSaveError ? "alert" : "status"}
            >
              {modelSelectionSaveError || unavailableModelNotice}
            </p>
          ) : null}
          <p className="mt-2 text-center text-[0.6875rem] text-[var(--color-muted)]">
            Lush can make mistakes. Verify important information.
          </p>
        </div>
      </div>
    </div>
  );
}

function feedbackForMessage(
  session: Session | undefined,
  messageId: string
): "up" | "down" | undefined {
  for (const snapshot of [...(session?.stateSnapshots ?? [])].reverse()) {
    if (snapshot.kind !== "message_feedback" || !snapshot.state || typeof snapshot.state !== "object") {
      continue;
    }
    const state = snapshot.state as { messageId?: unknown; sentiment?: unknown };
    if (
      state.messageId === messageId &&
      (state.sentiment === "up" || state.sentiment === "down")
    ) {
      return state.sentiment;
    }
  }
  return undefined;
}

function sessionChatMessages(session: Session | undefined) {
  return (session?.messages ?? [])
    .map(chatMessageFromSession)
    .filter((message): message is ChatMessage => Boolean(message));
}

function PendingAttachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;

  return (
    <PromptInputHeader>
      <Attachments variant="inline">
        {attachments.files.map((file) => (
          <Attachment
            key={file.id}
            data={file}
            onRemove={() => attachments.remove(file.id)}
          >
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

function ChatSubmit(props: {
  input: string;
  error: string;
  isStreaming: boolean;
  disabled: boolean;
  modelSelection: string;
  onStop: () => void;
}) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputSubmit
      status={props.isStreaming ? "streaming" : props.error ? "error" : "ready"}
      onStop={props.onStop}
      disabled={
        props.disabled ||
        !props.isStreaming &&
        (!props.modelSelection ||
          (!props.input.trim() && attachments.files.length === 0))
      }
    />
  );
}
