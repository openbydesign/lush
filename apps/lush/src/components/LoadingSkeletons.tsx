import { Skeleton } from "./ui/skeleton";

export function AppLoadingSkeleton({ path = "/sessions" }: { path?: string }) {
  return (
    <section
      className="flex h-full min-h-0 w-full flex-col px-4 sm:px-6"
      role="status"
      aria-label="Loading Lush"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border)] lg:hidden">
        <Skeleton className="size-8" />
        <Skeleton className="h-4 w-20" />
      </header>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-6">
        <aside className="hidden min-h-0 border-r border-[var(--color-border)] pr-6 lg:block">
          <div className="flex h-14 items-center gap-3 border-b border-[var(--color-border)]">
            <Skeleton className="size-8" />
            <Skeleton className="h-4 w-20" />
          </div>
          <div className="space-y-5 pt-5">
            <Skeleton className="h-3 w-16" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-4/5" />
              <Skeleton className="h-8 w-11/12" />
            </div>
            <Skeleton className="h-3 w-24" />
            <div className="space-y-2">
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-5/6" />
              <Skeleton className="h-7 w-3/4" />
            </div>
          </div>
        </aside>
        <div className="min-h-0 min-w-0 overflow-hidden py-3 sm:py-4 lg:pr-2">
          <RouteLoadingSkeleton path={path} nested />
        </div>
      </div>
    </section>
  );
}

export function AuthLoadingSkeleton() {
  return (
    <div className="flex h-full items-center justify-center px-6" role="status" aria-label="Loading account">
      <div className="w-full max-w-sm space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-6">
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="size-10 rounded-lg" />
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </div>
        <div className="space-y-4">
          <div className="space-y-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-10 w-full" /></div>
          <div className="space-y-2"><Skeleton className="h-3 w-20" /><Skeleton className="h-10 w-full" /></div>
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  );
}

export function RouteLoadingSkeleton({
  path,
  nested = false
}: {
  path: string;
  nested?: boolean;
}) {
  const content = path.startsWith("/chat")
    ? <ChatLoadingContent />
    : path.startsWith("/code")
      ? <CodeLoadingContent />
      : path.startsWith("/settings/")
        ? <SettingsLoadingContent />
        : path.startsWith("/projects/")
          ? <ProjectLoadingContent />
          : <ListLoadingContent />;

  if (nested) return content;
  return <div className="h-full" role="status" aria-label="Loading page">{content}</div>;
}

export function ProjectLoadingSkeleton() {
  return (
    <div role="status" aria-label="Loading project">
      <ProjectLoadingContent />
    </div>
  );
}

export function ToolsLoadingSkeleton() {
  return (
    <div className="grid max-w-4xl gap-4" role="status" aria-label="Loading tools">
      {[0, 1].map((item) => (
        <section key={item} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="w-full max-w-md space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
            <Skeleton className="h-9 w-24 shrink-0" />
          </div>
          {item === 1 ? (
            <div className="mt-5 space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export function DiffLoadingSkeleton() {
  return (
    <div className="space-y-4 pb-2" role="status" aria-label="Loading changes">
      {[0, 1].map((item) => (
        <article key={item} className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]">
          <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-3 py-2">
            <Skeleton className="h-3 w-3" />
            <Skeleton className="h-3 w-48 max-w-[60%]" />
            <Skeleton className="ml-auto h-3 w-16" />
          </div>
          <div className="space-y-2 p-3">
            {Array.from({ length: item === 0 ? 8 : 5 }, (_, line) => (
              <Skeleton key={line} className={`h-3 ${line % 3 === 2 ? "w-3/5" : "w-full"}`} />
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

export function ChatTranscriptLoadingSkeleton() {
  return (
    <div
      className="content-enter w-full space-y-7 px-4 pt-8"
      role="status"
      aria-label="Loading conversation"
    >
      <div className="space-y-2"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-4 w-3/5" /></div>
      <div className="ml-auto w-2/3 space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" /></div>
      <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div>
    </div>
  );
}

function ListLoadingContent() {
  return (
    <div className="mx-auto w-full max-w-5xl px-1 py-2 sm:px-4 sm:py-5">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-36" />
        <div className="flex gap-2"><Skeleton className="h-9 w-20" /><Skeleton className="h-9 w-20" /></div>
      </div>
      <Skeleton className="mt-7 h-12 w-full rounded-xl" />
      <div className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
        {Array.from({ length: 6 }, (_, item) => (
          <div key={item} className="flex min-h-16 items-center gap-3 px-2 sm:px-4">
            <Skeleton className="size-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-4 w-2/5" /><Skeleton className="h-3 w-1/4" /></div>
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsLoadingContent() {
  return (
    <div className="grid max-w-3xl gap-4">
      {[0, 1, 2].map((item) => (
        <section key={item} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="w-full max-w-sm space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-3/4" /></div>
            <div className="w-full space-y-3 sm:w-64"><Skeleton className="h-3 w-24" /><Skeleton className="h-10 w-full" />{item === 1 ? <Skeleton className="h-10 w-full" /> : null}</div>
          </div>
        </section>
      ))}
    </div>
  );
}

function ChatLoadingContent() {
  return (
    <div className="h-full min-h-[32rem] overflow-hidden">
      <div className="mx-auto max-w-3xl">
        <ChatTranscriptLoadingSkeleton />
      </div>
    </div>
  );
}

function CodeLoadingContent() {
  return (
    <div className="flex h-full min-h-[32rem] flex-col gap-4">
      <div className="flex flex-wrap gap-2"><Skeleton className="h-9 w-48" /><Skeleton className="h-9 w-32" /><Skeleton className="h-9 w-24" /></div>
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-64 w-full rounded-lg" /><Skeleton className="h-40 w-full rounded-lg" /></div>
        <Skeleton className="hidden h-full min-h-80 rounded-lg lg:block" />
      </div>
    </div>
  );
}

function ProjectLoadingContent() {
  return (
    <div className="mx-auto w-full max-w-6xl px-1 pb-12 pt-1 sm:px-4">
      <Skeleton className="mb-8 h-3 w-40" />
      <div className="flex items-center justify-between gap-4"><Skeleton className="h-9 w-56" /><div className="flex gap-2"><Skeleton className="size-8" /><Skeleton className="size-8" /></div></div>
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <main className="space-y-8"><Skeleton className="h-40 w-full rounded-2xl" /><div className="space-y-3"><Skeleton className="h-4 w-32" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div></main>
        <aside className="space-y-6"><div className="space-y-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-20 w-full" /></div><div className="space-y-3"><Skeleton className="h-4 w-20" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div></aside>
      </div>
    </div>
  );
}
