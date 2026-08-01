import type {
  AutonomyMode,
  CodeSession,
  CodeSessionDraft,
  CodeReview,
  CodeReviewFile,
  HarnessEvent,
  HarnessId,
  RepositoryInspection
} from "@lush/code";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  Columns2Icon,
  CircleDotIcon,
  Code2Icon,
  FileDiffIcon,
  FolderOpenIcon,
  FolderGit2Icon,
  GitBranchIcon,
  LoaderCircleIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  SquareIcon,
  Rows3Icon,
  TerminalIcon,
  SquareTerminalIcon,
  FilesIcon,
  GitCompareArrowsIcon,
  WrenchIcon,
  WrapTextIcon,
  XCircleIcon
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  Message,
  MessageContent,
  MessageResponse
} from "../../components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools
} from "../../components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger
} from "../../components/ai-elements/reasoning";
import { DiffLoadingSkeleton } from "../../components/LoadingSkeletons";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from "../../components/ui/select";
import { useCode } from "../../features/code/CodeProvider";
import { useApp } from "../../App";
import { readComposerFocusRequest } from "../../lib/app-data";

const autonomyOptions: Array<{ value: AutonomyMode; label: string }> = [
  { value: "plan", label: "Plan" },
  { value: "manual", label: "Ask before changes" },
  { value: "accept-edits", label: "Accept edits" },
  { value: "auto", label: "Auto" }
];

export function CodePage() {
  const code = useCode();
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [repository, setRepository] = useState<RepositoryInspection>();
  const [baseRef, setBaseRef] = useState("");
  const [harnessId, setHarnessId] = useState<HarnessId>("codex");
  const [autonomy, setAutonomy] = useState<AutonomyMode>("accept-edits");
  const [useWorktree, setUseWorktree] = useState(true);
  const [model, setModel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const composerFocusRequest = readComposerFocusRequest(location.state);

  useEffect(() => {
    void code.selectSession(sessionId).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [sessionId]);

  useEffect(() => {
    const firstInstalled = code.harnesses.find((harness) => harness.status === "installed");
    if (firstInstalled && !code.harnesses.some((harness) => harness.id === harnessId && harness.status === "installed")) {
      setHarnessId(firstInstalled.id);
    }
  }, [code.harnesses, harnessId]);

  useEffect(() => {
    if (sessionId || !composerFocusRequest) return;
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [composerFocusRequest, sessionId]);

  const inspect = async (path: string) => {
    setError("");
    setPending(true);
    try {
      const next = await code.inspectRepository(path);
      setRepository(next);
      setRepositoryPath(next.root);
      setBaseRef(
        next.branches.find((branch) => branch.name === "main")?.name
          ?? next.currentBranch
          ?? next.branches[0]?.name
          ?? "HEAD"
      );
    } catch (reason) {
      setRepository(undefined);
      setError(reason instanceof Error ? reason.message : "Unable to inspect repository");
    } finally {
      setPending(false);
    }
  };

  if (code.availability !== "ready") {
    return <UnavailableState availability={code.availability} message={code.error} />;
  }

  if (sessionId && code.activeSession?.id === sessionId) {
    return <ActiveCodeSession session={code.activeSession} />;
  }

  const selectedHarness = code.harnesses.find((harness) => harness.id === harnessId);
  const effectiveAutonomy = selectedHarness?.capabilities.autonomyModes.includes(autonomy)
    ? autonomy
    : selectedHarness?.capabilities.autonomyModes[0] ?? autonomy;

  const start = async (input: string) => {
    if (!repository) throw new Error("Choose a Git repository first");
    setPending(true);
    setError("");
    try {
      const draft: CodeSessionDraft = {
        repositoryPath: repository.root,
        baseRef,
        harnessId,
        useWorktree,
        autonomy,
        model: model.trim() || undefined
      };
      const session = await code.startSession(draft, input);
      navigate(`/code/sessions/${session.id}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to start Code session";
      setError(message);
      throw reason;
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-2 pb-4 sm:px-6">
      <div className="flex flex-1 flex-col justify-center py-8 sm:py-12">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]">
            <Code2Icon className="size-5 text-[var(--color-brand-soft)]" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[var(--color-text)]">Start a coding session</h1>
            <p className="mt-0.5 text-sm text-[var(--color-muted)]">Run an installed harness in a dedicated local worktree.</p>
          </div>
        </div>

        <div className="grid gap-x-6 gap-y-5 border-y border-[var(--color-border)] py-6 sm:grid-cols-2">
          <Setting label="Repository" icon={<FolderGit2Icon />} className="sm:col-span-2">
            <div className="flex gap-2">
              <input
                value={repositoryPath}
                onChange={(event) => setRepositoryPath(event.target.value)}
                onBlur={() => { if (repositoryPath && repositoryPath !== repository?.root) void inspect(repositoryPath); }}
                placeholder="Choose a local Git repository"
                className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 text-sm outline-none focus:border-[var(--color-brand)]"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void code.chooseRepository().then((path) => {
                  if (path) return inspect(path);
                })}
              >
                Browse
              </Button>
            </div>
            {repository ? (
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
                <span>{repository.name}</span>
                <span>{repository.dirty ? "Source checkout has changes" : "Source checkout clean"}</span>
                <span>{repository.headCommit.slice(0, 8)}</span>
              </div>
            ) : null}
          </Setting>

          <Setting label="Base branch" icon={<GitBranchIcon />}>
            <select value={baseRef} disabled={!repository} onChange={(event) => setBaseRef(event.target.value)} className="code-select">
              {!repository ? <option>Choose a repository first</option> : null}
              {repository?.branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
            </select>
          </Setting>

          <Setting label="Harness" icon={<TerminalIcon />}>
            <select value={harnessId} onChange={(event) => setHarnessId(event.target.value as HarnessId)} className="code-select">
              {code.harnesses.map((harness) => (
                <option key={harness.id} value={harness.id} disabled={harness.status !== "installed"}>
                  {harness.displayName}{harness.version ? ` ${harness.version}` : " (not installed)"}
                </option>
              ))}
            </select>
          </Setting>

          <Setting label="Autonomy" icon={<CircleDotIcon />}>
            <select value={autonomy} onChange={(event) => setAutonomy(event.target.value as AutonomyMode)} className="code-select">
              {autonomyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {effectiveAutonomy !== autonomy ? (
              <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">Effective policy: {effectiveAutonomy}</p>
            ) : null}
          </Setting>

          <Setting label="Model override" icon={<MonitorIcon />}>
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Harness default" className="code-input" />
          </Setting>

          <label className="flex items-center justify-between gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2.5 sm:col-span-2">
            <span>
              <span className="block text-sm font-medium text-[var(--color-text)]">Create a managed worktree</span>
              <span className="block text-xs text-[var(--color-muted)]">Keeps the source checkout untouched. Created only when you send.</span>
            </span>
            <input type="checkbox" checked={useWorktree} onChange={(event) => setUseWorktree(event.target.checked)} className="size-4 accent-[var(--color-brand)]" />
          </label>
        </div>
      </div>

      <PromptInput onSubmit={({ text }) => start(text)} className="sticky bottom-0">
        <PromptInputBody>
          <PromptInputTextarea ref={composerRef} placeholder="Describe the change you want to make..." disabled={pending} />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <span className="truncate text-xs text-[var(--color-muted)]">
              {repository ? `${repository.name} · ${baseRef} · ${selectedHarness?.displayName ?? harnessId}` : "Choose a repository to continue"}
            </span>
          </PromptInputTools>
          <PromptInputSubmit disabled={!repository || pending} status={pending ? "submitted" : "ready"} />
        </PromptInputFooter>
      </PromptInput>
      {error || code.error ? <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error || code.error}</p> : null}
    </div>
  );
}

function ActiveCodeSession({ session }: { session: CodeSession }) {
  const code = useCode();
  const [view, setView] = useState<"conversation" | "changes">("conversation");
  const [diffLayout, setDiffLayout] = useState<"unified" | "split">("unified");
  const [diffWrap, setDiffWrap] = useState(true);
  const [error, setError] = useState("");
  const activity = session.events.filter((event) => event.kind.startsWith("command.") || event.kind.startsWith("tool."));
  const reasoningByTurn = useMemo(() => {
    const values = new Map<string, string>();
    for (const event of session.events) {
      if (event.kind === "reasoning.delta" && event.turnId) values.set(event.turnId, `${values.get(event.turnId) ?? ""}${event.data.delta}`);
    }
    return values;
  }, [session.events]);

  const send = async (input: string) => {
    setError("");
    try { await code.sendInput(input); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to send message"); throw reason; }
  };

  return (
    <div className="flex h-full min-h-0 flex-col font-sans">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-[var(--color-text)]">{session.title}</h1>
            <StatusBadge status={session.status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
            <span>{session.repositoryName}</span><span>·</span><span>{session.branch}</span><span>·</span><span>{session.harnessId}</span>
            {session.draft.autonomy !== session.effectiveAutonomy ? <><span>·</span><span>{session.draft.autonomy} requested, {session.effectiveAutonomy} effective</span></> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <div className="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-0.5">
            <ViewButton active={view === "conversation"} onClick={() => setView("conversation")}><TerminalIcon />Conversation</ViewButton>
            <ViewButton active={view === "changes"} onClick={() => setView("changes")}><FileDiffIcon />Changes</ViewButton>
          </div>
          {view === "changes" ? (
            <div className="flex items-center gap-0.5 border-l border-[var(--color-border)] pl-1.5">
              <Button type="button" variant={diffLayout === "unified" ? "secondary" : "ghost"} size="icon-sm" title="Inline diff" aria-label="Inline diff" onClick={() => setDiffLayout("unified")}><Rows3Icon /></Button>
              <Button type="button" variant={diffLayout === "split" ? "secondary" : "ghost"} size="icon-sm" title="Side-by-side diff" aria-label="Side-by-side diff" onClick={() => setDiffLayout("split")}><Columns2Icon /></Button>
              <Button type="button" variant={diffWrap ? "secondary" : "ghost"} size="icon-sm" title={diffWrap ? "Disable line wrapping" : "Wrap long lines"} aria-label={diffWrap ? "Disable line wrapping" : "Wrap long lines"} onClick={() => setDiffWrap((current) => !current)}><WrapTextIcon /></Button>
            </div>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Open workspace" title="Open workspace">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Open in...</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void code.openWorkspace("finder")}><FolderOpenIcon />Finder</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void code.openWorkspace("terminal")}><SquareTerminalIcon />Terminal</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void code.openWorkspace("editor")}><Code2Icon />Visual Studio Code</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {view === "conversation" ? (
        <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 space-y-7 overflow-y-auto py-7 pr-2">
            {session.messages.map((message) => (
              <div key={message.id}>
                {message.role === "assistant" && reasoningByTurn.get(message.turnId) ? (
                  <Reasoning isStreaming={session.status === "running" && message.turnId === session.messages.at(-1)?.turnId}>
                    <ReasoningTrigger />
                    <ReasoningContent>{reasoningByTurn.get(message.turnId)!}</ReasoningContent>
                  </Reasoning>
                ) : null}
                <Message from={message.role} className="max-w-full">
                  <MessageContent className="text-[0.9375rem] leading-6">
                    <MessageResponse className="font-sans" isAnimating={session.status === "running"}>{message.content}</MessageResponse>
                  </MessageContent>
                </Message>
              </div>
            ))}
            {activity.length ? <Activity events={activity} /> : null}
            {session.error ? <p className="text-sm text-red-600 dark:text-red-400">{session.error}</p> : null}
        </div>
      ) : (
        <ChangesView key={session.id} session={session} layout={diffLayout} wrap={diffWrap} />
      )}
      <div className="mx-auto mt-2 w-full max-w-3xl shrink-0">
        <PromptInput onSubmit={({ text }) => send(text)}>
          <PromptInputBody><PromptInputTextarea placeholder={view === "changes" ? "Ask for a revision to these changes..." : "Ask for a revision or the next step..."} /></PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <span className="text-xs text-[var(--color-muted)]">
                {view === "changes" ? "Reviewing workspace changes" : session.workspace.managedWorktree ? "Managed worktree" : "Source checkout"}
              </span>
            </PromptInputTools>
            <PromptInputSubmit
              status={session.status === "running" ? "streaming" : session.status === "failed" ? "error" : "ready"}
              onStop={() => void code.interrupt()}
            />
          </PromptInputFooter>
        </PromptInput>
        {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      </div>
    </div>
  );
}

function Activity({ events }: { events: HarnessEvent[] }) {
  const activities = useMemo(() => {
    const merged = new Map<string, { id: string; command?: string; name?: string; status?: string; output?: string; error?: string }>();
    for (const event of events) {
      if (event.kind !== "command.started" && event.kind !== "command.completed" && event.kind !== "tool.started" && event.kind !== "tool.completed") continue;
      const data = event.data;
      const id = "commandId" in data ? data.commandId : data.toolCallId;
      merged.set(id, { ...merged.get(id), id, ...data });
    }
    return [...merged.values()];
  }, [events]);

  return (
    <details className="border-y border-[var(--color-border)] py-3 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[var(--color-muted)]">
        <WrenchIcon className="size-4" />{activities.length} agent activities<ChevronDownIcon className="ml-auto size-4" />
      </summary>
      <div className="mt-3 space-y-2">
        {activities.map((data) => {
          return (
            <div key={data.id} className="rounded-md bg-[var(--color-panel)] px-3 py-2">
              <div className="flex items-center gap-2 font-mono text-xs"><TerminalIcon className="size-3.5" />{data.command ?? data.name ?? "Activity"}<span className="ml-auto text-[var(--color-muted)]">{data.status}</span></div>
              {data.output || data.error ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-[var(--color-muted)]">{data.output ?? data.error}</pre> : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function ChangesView({
  session,
  layout,
  wrap
}: {
  session: CodeSession;
  layout: "unified" | "split";
  wrap: boolean;
}) {
  const code = useCode();
  const app = useApp();
  const [review, setReview] = useState<CodeReview>();
  const [revision, setRevision] = useState("net");
  const [comparisonRef, setComparisonRef] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const fileCards = useRef(new Map<string, HTMLElement>());

  const loadReview = async (nextRevision = revision, quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const nextReview = await code.fetchReview(nextRevision, comparisonRef || undefined);
      setReview(nextReview);
      setComparisonRef((current) => current || nextReview.comparisonRef);
      setSelectedFile((current) =>
        nextReview.snapshot.files.some((file) => file.path === current)
          ? current
          : nextReview.snapshot.files[0]?.path ?? ""
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load workspace changes");
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    void loadReview(revision);
  }, [revision, comparisonRef, session.id]);

  useEffect(() => {
    if (session.status !== "running") return;
    const timer = window.setInterval(() => void loadReview(revision, true), 1_500);
    return () => window.clearInterval(timer);
  }, [revision, comparisonRef, session.id, session.status]);

  const parsedFiles = useMemo(() => {
    if (!review?.snapshot.patch) return [];
    try {
      return parsePatchFiles(review.snapshot.patch, `${session.id}:${review.snapshot.revision}`)
        .flatMap((patch) => patch.files);
    } catch {
      return [];
    }
  }, [review?.snapshot.patch, review?.snapshot.revision, session.id]);
  const jumpToFile = (path: string) => {
    setSelectedFile(path);
    window.requestAnimationFrame(() => {
      fileCards.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col py-4">
      <div className="mb-3 grid min-w-0 gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,24rem)] xl:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select value={revision} onValueChange={setRevision}>
            <SelectTrigger size="sm" className="max-w-full sm:max-w-[28rem]" aria-label="Review revision">
              <GitCompareArrowsIcon className="text-[var(--color-muted)]" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start" className="max-w-[min(32rem,80vw)]">
              <SelectItem value="net">Diff vs {review?.comparisonRef ?? (comparisonRef || "main")}</SelectItem>
              <SelectItem value="unstaged">Unstaged changes</SelectItem>
              <SelectItem value="staged">Staged changes</SelectItem>
              {review?.commits.length ? (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Commits not on {review.comparisonRef}</SelectLabel>
                    {review.commits.map((commit) => (
                      <SelectItem key={commit.id} value={commit.id}>{commit.shortId} {commit.subject}</SelectItem>
                    ))}
                  </SelectGroup>
                </>
              ) : null}
            </SelectContent>
          </Select>

          <Select
            value={review?.comparisonRef ?? comparisonRef}
            onValueChange={(value) => {
              setRevision("net");
              setComparisonRef(value);
            }}
            disabled={!review?.comparisonRefs.length}
          >
            <SelectTrigger size="sm" className="max-w-full sm:max-w-52" aria-label="Comparison branch">
              <GitBranchIcon className="text-[var(--color-muted)]" />
              <SelectValue placeholder="Comparison branch" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectGroup>
                <SelectLabel>Comparison branch</SelectLabel>
                {review?.comparisonRefs.map((ref) => (
                  <SelectItem key={ref} value={ref}>{ref}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          {review ? (
            <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
              <span>{review.snapshot.files.length} {review.snapshot.files.length === 1 ? "file" : "files"}</span>
              <span className="font-medium text-emerald-600 dark:text-emerald-400">+{review.snapshot.additions}</span>
              <span className="font-medium text-red-600 dark:text-red-400">-{review.snapshot.deletions}</span>
              {review.snapshot.binaryFiles ? <span>{review.snapshot.binaryFiles} binary</span> : null}
              {review.snapshot.truncated ? <Badge variant="outline">Truncated</Badge> : null}
            </div>
          ) : null}
        </div>

        <Select value={selectedFile} onValueChange={jumpToFile} disabled={!review?.snapshot.files.length}>
          <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Jump to changed file">
            <FilesIcon className="text-[var(--color-muted)]" />
            <SelectValue placeholder="Jump to file" />
          </SelectTrigger>
          <SelectContent position="popper" align="end" className="max-w-[min(32rem,80vw)]">
            <SelectGroup>
              <SelectLabel>Changed files</SelectLabel>
              {review?.snapshot.files.map((file) => (
                <SelectItem key={`${file.previousPath ?? ""}:${file.path}`} value={file.path}>{file.path}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-smooth pr-2">
        {loading && !review ? (
          <DiffLoadingSkeleton />
        ) : error ? (
          <div className="content-enter flex h-full items-center justify-center px-6 text-center text-sm text-red-600 dark:text-red-400">{error}</div>
        ) : review?.snapshot.files.length ? (
          <div className="content-enter space-y-4 pb-2">
            {review.snapshot.files.map((file) => {
              const fileDiff = findParsedFile(parsedFiles, file.path);
              return (
                <article
                  key={`${file.previousPath ?? ""}:${file.path}`}
                  ref={(node) => {
                    if (node) fileCards.current.set(file.path, node);
                    else fileCards.current.delete(file.path);
                  }}
                  className="scroll-mt-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]"
                >
                  <header className="flex min-w-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 text-xs">
                    <span className="w-3 shrink-0 font-mono font-semibold text-[var(--color-muted)]">{fileStatusLabel(file.status)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text)]" title={file.path}>
                      {file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path}
                    </span>
                    {file.additions === null || file.deletions === null ? (
                      <span className="text-[var(--color-muted)]">binary</span>
                    ) : (
                      <span className="flex shrink-0 gap-2 font-mono">
                        <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                        <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
                      </span>
                    )}
                  </header>
                  {fileDiff ? (
                    <FileDiff
                      key={`${review.snapshot.revision}:${fileDiff.name}:${layout}:${wrap}:${app.resolvedTheme}`}
                      fileDiff={fileDiff}
                      disableWorkerPool
                      options={{
                        theme: { light: "pierre-light", dark: "pierre-dark" },
                        themeType: app.resolvedTheme === "dark" ? "dark" : "light",
                        diffStyle: layout,
                        overflow: wrap ? "wrap" : "scroll",
                        diffIndicators: "bars",
                        lineDiffType: "word-alt",
                        hunkSeparators: "line-info",
                        disableFileHeader: true,
                        stickyHeader: false,
                        enableLineSelection: true
                      }}
                    />
                  ) : (
                    <div className="px-4 py-10 text-center text-sm text-[var(--color-muted)]">
                      {file.additions === null ? "Binary diff is not displayed." : "Diff unavailable in the current review payload."}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="content-enter flex h-full items-center justify-center px-6 text-center text-sm text-[var(--color-muted)]">No changes in this revision.</div>
        )}
      </div>
    </div>
  );
}

function findParsedFile(files: FileDiffMetadata[], path: string) {
  return files.find((file) => file.name === path || file.name.replace(/^b\//, "") === path);
}

function fileStatusLabel(status: CodeReviewFile["status"]) {
  return { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", "type-changed": "T", unmerged: "U" }[status];
}

function Setting({ label, icon, className = "", children }: { label: string; icon: React.ReactNode; className?: string; children: React.ReactNode }) {
  return <label className={className}><span className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--color-muted)] [&_svg]:size-3.5">{icon}{label}</span>{children}</label>;
}

function ViewButton({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition [&_svg]:size-3.5 ${active ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"}`}>{children}</button>;
}

function StatusBadge({ status }: { status: CodeSession["status"] }) {
  const config = {
    running: { icon: <LoaderCircleIcon className="animate-spin" />, label: "Running" },
    completed: { icon: <CheckCircle2Icon />, label: "Complete" },
    failed: { icon: <XCircleIcon />, label: "Failed" },
    interrupted: { icon: <SquareIcon />, label: "Stopped" },
    idle: { icon: <CircleDotIcon />, label: "Ready" }
  }[status];
  return <Badge variant="outline">{config.icon}{config.label}</Badge>;
}

function UnavailableState({ availability, message }: { availability: string; message: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6 text-center">
      <div className="max-w-md">
        {availability === "loading" ? <LoaderCircleIcon className="mx-auto size-6 animate-spin text-[var(--color-muted)]" /> : <MonitorIcon className="mx-auto size-7 text-[var(--color-muted)]" />}
        <h1 className="mt-4 text-lg font-semibold">{availability === "loading" ? "Starting local Code" : "Desktop app required"}</h1>
        {message ? <p className="mt-2 text-sm text-[var(--color-muted)]">{message}</p> : null}
      </div>
    </div>
  );
}
