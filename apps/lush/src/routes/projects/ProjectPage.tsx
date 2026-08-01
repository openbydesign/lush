import type { Project } from "@lush/api-client";
import {
  FileTextIcon,
  MoreVerticalIcon,
  PaperclipIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SendIcon,
  Trash2Icon,
  XIcon
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApp } from "../../App";
import { ProjectLoadingSkeleton } from "../../components/LoadingSkeletons";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import { ProjectDialog } from "../../features/projects/ProjectDialog";
import { SessionGlyph } from "../../features/sessions/SessionGlyph";
import { SessionMenu } from "../../features/sessions/SessionMenu";
import { useSessions } from "../../features/sessions/useSessions";
import { createProjectChatState } from "../../lib/app-data";
import {
  filterSessions,
  formatSessionActivity,
  type SessionItem
} from "../../lib/session-organization";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

export function ProjectPage(props: { projectId: string }) {
  const app = useApp();
  const navigate = useNavigate();
  const sessionActions = useSessions();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [project, setProject] = useState<Project>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void app.loadProject(props.projectId)
      .then((loaded) => {
        if (!active) return;
        setProject(loaded);
        setInstructions(loaded.instructions);
      })
      .catch((caught) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Unable to load project");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.projectId]);

  if (loading) return <ProjectLoadingSkeleton />;
  if (!project) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-lg font-semibold">Project unavailable</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{error}</p>
        <Link to="/projects" className="mt-4 inline-block text-sm text-[var(--color-brand-soft)]">
          Return to projects
        </Link>
      </div>
    );
  }

  const projectSessions = filterSessions(
    sessionActions.sessions.filter((session) => session.projectId === project.id),
    { type: "all", activity: "all", groupBy: "none" }
  );
  const pinnedSessions = projectSessions.filter((session) => session.pinnedAt);
  const recentSessions = projectSessions.filter((session) => !session.pinnedAt);

  const update = async (
    fields: Parameters<typeof app.updateUserProject>[1]
  ) => {
    setPending(true);
    setError("");
    try {
      const updated = await app.updateUserProject(project.id, fields);
      setProject(updated);
      setInstructions(updated.instructions);
      return updated;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update project");
      throw caught;
    } finally {
      setPending(false);
    }
  };

  const addContextFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setPending(true);
    setError("");
    try {
      let updated = project;
      for (const file of Array.from(files)) {
        const content = await file.text();
        updated = await app.addUserProjectContext(project.id, {
          filename: file.name,
          mediaType: file.type || "text/plain",
          content
        });
      }
      setProject(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to add context");
    } finally {
      setPending(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const sessionMenu = (session: SessionItem) => (
    <SessionMenu
      session={session}
      projects={app.projects}
      triggerClassName="flex size-7 items-center justify-center rounded-md text-[var(--color-muted)] opacity-0 transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] focus:opacity-100 group-hover:opacity-100"
      onRename={(title) => sessionActions.renameSession(session, title)}
      onPinChange={(pinned) => sessionActions.setSessionPinned(session, pinned)}
      onMoveToProject={(projectId) => sessionActions.moveSessionToProject(session, projectId)}
      onArchive={() => sessionActions.archiveSession(session)}
    />
  );

  return (
    <div className="content-enter mx-auto w-full max-w-6xl px-1 pb-12 pt-1 sm:px-4">
      <div className="mb-8 flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <Link to="/projects" className="hover:text-[var(--color-text)]">Projects</Link>
        <span>/</span>
        <span className="truncate text-[var(--color-subtle)]">{project.name}</span>
      </div>

      <header className="flex items-center justify-between gap-4">
        <h1 className="truncate font-serif text-3xl font-semibold text-[var(--color-text)]">
          {project.name}
        </h1>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={project.pinnedAt ? "Unpin project" : "Pin project"}
            title={project.pinnedAt ? "Unpin project" : "Pin project"}
            disabled={pending}
            onClick={() =>
              void update({ pinned: !project.pinnedAt }).catch(() => undefined)
            }
            className="flex size-8 items-center justify-center rounded-md text-[var(--color-muted)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          >
            {project.pinnedAt ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Project actions"
                className="flex size-8 items-center justify-center rounded-md text-[var(--color-muted)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
              >
                <MoreVerticalIcon className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                <PencilIcon /> Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2Icon /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <main className="min-w-0">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const content = prompt.trim();
              if (!content) return;
              app.resetChatSession();
              navigate("/chat", { state: createProjectChatState(project.id, content) });
            }}
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-4 shadow-[var(--shadow-composer)]"
          >
            <textarea
              value={prompt}
              rows={3}
              placeholder="How can I help you today?"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              className="w-full resize-none bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-muted)]"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="rounded-md bg-[var(--color-panel-hover)] px-2 py-1 text-xs text-[var(--color-subtle)]">
                Chat
              </span>
              <Button type="submit" size="icon-sm" disabled={!prompt.trim()} aria-label="Start project chat">
                <SendIcon />
              </Button>
            </div>
          </form>

          <ProjectSessionSection
            title="Pinned"
            sessions={pinnedSessions}
            menu={sessionMenu}
          />
          <ProjectSessionSection
            title="Recents"
            sessions={recentSessions}
            menu={sessionMenu}
            empty="No sessions in this project yet."
          />
        </main>

        <aside className="h-fit overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)]">
          <section className="p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-[var(--color-subtle)]">Instructions</h2>
              <button
                type="button"
                aria-label="Edit project instructions"
                onClick={() => setEditingInstructions((current) => !current)}
                className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
              >
                <PencilIcon className="size-3.5" />
              </button>
            </div>
            {editingInstructions ? (
              <div className="mt-3">
                <textarea
                  autoFocus
                  value={instructions}
                  rows={5}
                  maxLength={16 * 1024}
                  onChange={(event) => setInstructions(event.target.value)}
                  className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs leading-5 text-[var(--color-text)] outline-none focus:border-[var(--color-border-strong)]"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setInstructions(project.instructions);
                      setEditingInstructions(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      void update({ instructions })
                        .then(() => setEditingInstructions(false))
                        .catch(() => undefined)
                    }
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs leading-5 text-[var(--color-muted)]">
                {project.instructions || "Add instructions to guide every session in this project."}
              </p>
            )}
          </section>

          <section className="border-t border-[var(--color-border)] p-5">
            <h2 className="text-sm font-medium text-[var(--color-subtle)]">Memory</h2>
            <p className="mt-2 text-xs leading-5 text-[var(--color-muted)]">
              {project.memory || "Project memory will show here after a few sessions."}
            </p>
          </section>

          <section className="border-t border-[var(--color-border)] p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-[var(--color-subtle)]">Context</h2>
              <button
                type="button"
                aria-label="Add project context"
                title="Add text context"
                disabled={pending}
                onClick={() => fileInputRef.current?.click()}
                className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
              >
                <PaperclipIcon className="size-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="text/*,.md,.json,.csv,.xml,.yaml,.yml"
                className="hidden"
                onChange={(event) => void addContextFiles(event.target.files)}
              />
            </div>
            {project.contextItems.length === 0 ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 flex w-full flex-col items-center rounded-xl bg-[var(--color-bg)] px-4 py-8 text-center"
              >
                <FileTextIcon className="size-6 text-[var(--color-muted)]" />
                <span className="mt-3 text-xs text-[var(--color-muted)]">
                  Add text files to reference in every session.
                </span>
              </button>
            ) : (
              <div className="mt-3 space-y-1">
                {project.contextItems.map((item) => (
                  <div key={item.id} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-panel-hover)]">
                    <FileTextIcon className="size-3.5 shrink-0 text-[var(--color-muted)]" />
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-subtle)]">
                      {item.filename}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${item.filename}`}
                      disabled={pending}
                      onClick={() =>
                        void app.deleteUserProjectContext(project.id, item.id)
                          .then(setProject)
                          .catch((caught) =>
                            setError(caught instanceof Error ? caught.message : "Unable to remove context")
                          )
                      }
                      className="text-[var(--color-muted)] opacity-0 hover:text-[var(--color-text)] focus:opacity-100 group-hover:opacity-100"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      <ProjectDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename project"
        description="This changes the project name everywhere it appears."
        initialName={project.name}
        submitLabel="Save"
        onSubmit={(name) => update({ name })}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete project?"
        body="Sessions will remain available, but project instructions, memory, and context will be deleted."
        confirmLabel="Delete project"
        pendingConfirmLabel="Deleting..."
        pending={pending}
        danger
        error={error}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          setPending(true);
          setError("");
          void app.deleteUserProject(project.id)
            .then(() => navigate("/projects", { replace: true }))
            .catch((caught) =>
              setError(caught instanceof Error ? caught.message : "Unable to delete project")
            )
            .finally(() => setPending(false));
        }}
      />
    </div>
  );
}

function ProjectSessionSection(props: {
  title: string;
  sessions: SessionItem[];
  menu: (session: SessionItem) => ReactNode;
  empty?: string;
}) {
  if (props.sessions.length === 0 && !props.empty) return null;

  return (
    <section className="mt-9">
      <h2 className="mb-2 text-xs font-medium text-[var(--color-muted)]">{props.title}</h2>
      {props.sessions.length === 0 ? (
        <p className="py-3 text-xs text-[var(--color-muted)]">{props.empty}</p>
      ) : (
        <div className="space-y-1">
          {props.sessions.map((session) => (
            <div key={session.key} className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition hover:bg-[var(--color-panel-hover)]">
              <SessionGlyph type={session.type} className="size-4 shrink-0 text-[var(--color-muted)]" />
              <Link to={session.href} className="min-w-0 flex-1 truncate text-sm text-[var(--color-subtle)] hover:text-[var(--color-text)]">
                {session.title}
              </Link>
              <time className="shrink-0 text-xs text-[var(--color-muted)]" dateTime={session.updatedAt}>
                {formatSessionActivity(session.updatedAt)}
              </time>
              {props.menu(session)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
