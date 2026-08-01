import { useState } from "react";
import { ArchiveIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

export type WorkspaceSessionNavItem = {
  id: string;
  title: string;
  href: string;
  metadata?: string;
  archiveDisabled?: boolean;
};

export function WorkspaceSessionNav(props: {
  newSessionLabel: string;
  sectionLabel: string;
  activeSessionId?: string;
  items: WorkspaceSessionNavItem[];
  onNewSession: () => void;
  onArchive: (sessionId: string) => Promise<unknown> | unknown;
}) {
  const [pendingArchive, setPendingArchive] = useState<WorkspaceSessionNavItem>();
  const [isArchiving, setIsArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState("");

  const confirmArchive = async () => {
    if (!pendingArchive) return;
    setIsArchiving(true);
    setArchiveError("");
    try {
      await props.onArchive(pendingArchive.id);
      setPendingArchive(undefined);
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "Unable to archive session");
    } finally {
      setIsArchiving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        data-navigation-action
        onClick={props.onNewSession}
        className="mb-3 block w-full rounded-md border border-[var(--color-brand)] bg-[var(--color-brand)] px-3 py-1 text-left text-[10px] font-medium text-white transition hover:border-[var(--color-brand-strong)] hover:bg-[var(--color-brand-strong)]"
      >
        {props.newSessionLabel}
      </button>

      <div className="mb-2 px-3 text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--color-muted)]">
        {props.sectionLabel}
      </div>

      {props.items.map((item) => (
        <WorkspaceSessionRow
          key={item.id}
          item={item}
          active={props.activeSessionId === item.id}
          onArchive={() => {
            setArchiveError("");
            setPendingArchive(item);
          }}
        />
      ))}

      <ConfirmDialog
        open={Boolean(pendingArchive)}
        title="Archive session?"
        body="Archived sessions follow your organization's retention policy."
        confirmLabel="Archive session"
        pendingConfirmLabel="Archiving..."
        pending={isArchiving}
        error={archiveError}
        onCancel={() => {
          setArchiveError("");
          setPendingArchive(undefined);
        }}
        onConfirm={() => void confirmArchive()}
      />
    </>
  );
}

function WorkspaceSessionRow(props: {
  item: WorkspaceSessionNavItem;
  active: boolean;
  onArchive: () => void;
}) {
  const { item } = props;
  const longTitle = item.title.length > 28;

  return (
    <div
      className={`group relative w-full min-w-0 max-w-full overflow-hidden rounded-md transition ${
        props.active ? "bg-[var(--color-panel-hover)]" : "hover:bg-[var(--color-panel-hover)]"
      }`}
    >
      <Link
        to={item.href}
        title={item.title}
        className={`session-title-button block w-full min-w-0 max-w-full overflow-hidden px-3 py-0.5 pr-9 text-left text-[7px] font-medium transition ${
          props.active
            ? "text-[var(--color-text)]"
            : "text-[var(--color-subtle)] hover:text-[var(--color-text)]"
        } ${longTitle ? "session-title-button--long" : ""}`}
      >
        <span className="session-title-viewport">
          <span className="session-title-track">
            <span className="session-title-text">{item.title}</span>
            <span aria-hidden="true" className="session-title-text session-title-duplicate">
              {item.title}
            </span>
          </span>
        </span>
        {item.metadata ? (
          <span className="block truncate text-[7px] font-normal text-[var(--color-muted)]">
            {item.metadata}
          </span>
        ) : null}
      </Link>

      <button
        type="button"
        aria-label={`Archive ${item.title}`}
        title={item.archiveDisabled ? "Stop the session before archiving" : "Archive session"}
        disabled={item.archiveDisabled}
        onClick={props.onArchive}
        className="pointer-events-none absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md bg-[var(--color-panel-hover)] text-[var(--color-muted)] opacity-0 shadow-[-8px_0_8px_var(--color-panel-hover)] transition hover:text-[var(--color-text)] focus:pointer-events-auto focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <ArchiveIcon className="size-3.5" />
      </button>
    </div>
  );
}
