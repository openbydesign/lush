import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  FolderIcon,
  PlusIcon
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../../App";
import { SessionFilterMenu } from "../../features/sessions/SessionFilterMenu";
import { SessionGlyph } from "../../features/sessions/SessionGlyph";
import { SessionMenu } from "../../features/sessions/SessionMenu";
import { useSessions } from "../../features/sessions/useSessions";
import { createComposerFocusState } from "../../lib/app-data";
import {
  defaultSessionFiltersForPath,
  filterSessions,
  groupSessions,
  sessionFilterTypeForPath,
  type SessionFilters,
  type SessionItem
} from "../../lib/session-organization";
import { PrimaryNav } from "./PrimaryNav";

export function WorkspaceNav() {
  const app = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const sessionActions = useSessions();
  const filterScope = sessionFilterTypeForPath(location.pathname);
  const [filtersByScope, setFiltersByScope] = useState<
    Partial<Record<SessionFilters["type"], SessionFilters>>
  >({});
  const filters =
    filtersByScope[filterScope] ??
    defaultSessionFiltersForPath(location.pathname);
  const setFilters = (next: SessionFilters) => {
    setFiltersByScope((current) => ({
      ...current,
      [filterScope]: next
    }));
  };
  const [recentsOpen, setRecentsOpen] = useState(true);
  const filteredSessions = filterSessions(sessionActions.sessions, filters);
  const pinnedSessions = filteredSessions.filter((session) => session.pinnedAt);
  const recentSessions = filteredSessions
    .filter((session) => !session.pinnedAt)
    .slice(0, 14);
  const pinnedProjects = app.projects.filter((project) => project.pinnedAt);
  const groups = groupSessions(recentSessions, filters.groupBy);

  const startNewChat = () => {
    app.resetChatSession();
    navigate("/chat", { state: createComposerFocusState() });
  };

  const sessionRow = (session: SessionItem) => (
    <SidebarSessionRow
      key={session.key}
      session={session}
      active={location.pathname === session.href}
      menu={
        <SessionMenu
          session={session}
          projects={app.projects}
          triggerClassName="pointer-events-none absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md bg-[var(--color-panel-hover)] text-[var(--color-muted)] opacity-0 shadow-[-8px_0_8px_var(--color-panel-hover)] transition hover:text-[var(--color-text)] focus:pointer-events-auto focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
          onRename={(title) => sessionActions.renameSession(session, title)}
          onPinChange={(pinned) => sessionActions.setSessionPinned(session, pinned)}
          onMoveToProject={(projectId) =>
            sessionActions.moveSessionToProject(session, projectId)
          }
          onArchive={() => sessionActions.archiveSession(session)}
        />
      }
    />
  );

  return (
    <>
      <button
        type="button"
        data-navigation-action
        onClick={startNewChat}
        className="mb-1 flex w-full items-center gap-1.5 rounded-lg px-3 py-1 text-left text-[10px] font-medium text-[var(--color-subtle)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
      >
        <PlusIcon className="size-3.5" />
        New
      </button>

      <Link
        to="/projects"
        className={`mb-3 flex items-center gap-1.5 rounded-lg px-3 py-1 text-[10px] font-medium transition ${
          location.pathname.startsWith("/projects")
            ? "bg-[var(--color-panel-hover)] text-[var(--color-text)]"
            : "text-[var(--color-subtle)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
        }`}
      >
        <FolderIcon className="size-3.5" />
        Projects
      </Link>

      <PrimaryNav />

      {pinnedProjects.length > 0 || pinnedSessions.length > 0 ? (
        <section className="mt-6">
          <h2 className="mb-1 px-3 py-1 text-[0.6875rem] font-medium text-[var(--color-muted)]">
            Pinned
          </h2>
          <div className="space-y-1">
            {pinnedProjects.map((project) => (
              <Link
                key={project.id}
                to={`/projects/${encodeURIComponent(project.id)}`}
                className="flex items-center gap-1.5 rounded-md px-3 py-0.5 text-[7px] text-[var(--color-subtle)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
              >
                <FolderIcon className="size-3 shrink-0 text-[var(--color-muted)]" />
                <span className="truncate">{project.name}</span>
              </Link>
            ))}
            {pinnedSessions.map(sessionRow)}
          </div>
        </section>
      ) : null}

      <section className="mt-6">
        <div className="mb-1 flex items-center gap-1 px-2">
          <button
            type="button"
            onClick={() => setRecentsOpen((current) => !current)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-[0.6875rem] font-medium text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            Recents
            <ChevronDownIcon className={`size-3.5 transition ${recentsOpen ? "" : "-rotate-90"}`} />
          </button>
          <Link
            to="/sessions"
            aria-label="View all sessions"
            title="View all"
            className="flex size-7 items-center justify-center rounded-md text-[var(--color-muted)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          >
            <ArrowUpRightIcon className="size-4" />
          </Link>
          <SessionFilterMenu filters={filters} onChange={setFilters} trigger="icon" />
        </div>

        {recentsOpen ? (
          <div className="space-y-1">
            {recentSessions.length === 0 ? (
              <p className="px-3 py-2 text-[7px] text-[var(--color-muted)]">No matching sessions</p>
            ) : (
              groups.map((group) => (
                <div key={group.key}>
                  {group.label ? (
                    <div className="px-3 pb-1 pt-2 text-[0.5625rem] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                      {group.label}
                    </div>
                  ) : null}
                  {group.sessions.map(sessionRow)}
                </div>
              ))
            )}
          </div>
        ) : null}
      </section>
    </>
  );
}

function SidebarSessionRow(props: {
  session: SessionItem;
  active: boolean;
  menu: ReactNode;
}) {
  const longTitle = props.session.title.length > 28;
  return (
    <div
      className={`group relative min-w-0 overflow-hidden rounded-md transition ${
        props.active
          ? "bg-[var(--color-panel-hover)]"
          : "hover:bg-[var(--color-panel-hover)]"
      }`}
    >
      <Link
        to={props.session.href}
        title={props.session.title}
        className={`session-title-button flex min-w-0 items-center gap-1.5 overflow-hidden px-3 py-1 pr-9 text-[7px] leading-[1.4] text-[var(--color-subtle)] hover:text-[var(--color-text)] ${
          longTitle ? "session-title-button--long" : ""
        }`}
      >
        <SessionGlyph type={props.session.type} className="size-3 shrink-0 text-[var(--color-muted)]" />
        <span className="session-title-viewport flex-1">
          <span className="session-title-track">
            <span className="session-title-text">{props.session.title}</span>
            <span aria-hidden="true" className="session-title-text session-title-duplicate">
              {props.session.title}
            </span>
          </span>
        </span>
      </Link>
      {props.menu}
    </div>
  );
}
