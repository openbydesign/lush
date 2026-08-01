import type { OrganizationSummary } from "@lush/api-client";
import { accountRoutes, getInitials } from "../../lib/app-data";
import { Link } from "react-router-dom";
import { Dropdown } from "../../ui/Dropdown";

export function UserMenu(props: {
  open: boolean;
  displayName: string;
  organizationName: string;
  activeOrganizationId?: string | null;
  organizations: OrganizationSummary[];
  onOpenChange: (open: boolean) => void;
  onSignOut: () => void;
  onOrganizationSwitch: (organizationId: string) => void;
}) {
  return (
    <div className="pb-6 pt-6">
      <Dropdown
        open={props.open}
        onOpenChange={props.onOpenChange}
        className="relative min-w-0"
        contentClass="absolute bottom-[calc(100%+0.5rem)] left-0 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-1 text-[13px] shadow-2xl shadow-[var(--shadow-menu)]"
        trigger={(dropdown) => (
          <button
            type="button"
            aria-expanded={dropdown.isOpen()}
            onClick={dropdown.toggle}
            className="flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-2.5 text-left transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)]"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand)] text-[13px] font-semibold text-white">
              {getInitials(props.displayName)}
            </span>
            <span className="min-w-0 flex-1 overflow-hidden">
              <span className="block truncate text-[15px] font-medium text-[var(--color-text)]">
                {props.displayName}
              </span>
              <span className="block truncate text-[13px] text-[var(--color-muted)]">
                {props.organizationName}
              </span>
            </span>
          </button>
        )}
      >
        <div className="border-b border-[var(--color-border)] pb-1">
          {props.organizations.map((organization) => (
              <button
                key={organization.id}
                type="button"
                onClick={() => props.onOrganizationSwitch(organization.id)}
                disabled={organization.id === props.activeOrganizationId}
                className={`block w-full rounded-md px-3 py-1.5 text-left text-[13px] font-medium transition ${
                  organization.id === props.activeOrganizationId
                    ? "bg-[var(--color-panel-hover)] text-[var(--color-text)]"
                    : "text-[var(--color-subtle)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                }`}
              >
                <span className="block truncate">{organization.name}</span>
                <span className="block text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
                  {organization.role}
                </span>
              </button>
          ))}
          <Link
            to="/organizations/new"
            onClick={() => props.onOpenChange(false)}
            className="block w-full rounded-md px-3 py-1.5 text-left text-[13px] font-medium text-[var(--color-subtle)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          >
            New organization
          </Link>
        </div>

        {accountRoutes.map((route) =>
          route.href === "/sign-out" ? (
            <button
              key={route.href}
              type="button"
              onClick={props.onSignOut}
              className="block w-full rounded-md px-3 py-1.5 text-left text-[13px] font-medium text-[var(--color-subtle)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            >
              {route.label}
            </button>
          ) : (
            <Link
              key={route.href}
              to={route.href}
              onClick={() => props.onOpenChange(false)}
              className="block w-full rounded-md px-3 py-1.5 text-left text-[13px] font-medium text-[var(--color-subtle)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            >
              {route.label}
            </Link>
          )
        )}
      </Dropdown>
    </div>
  );
}
