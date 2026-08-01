import { settingsRoutes } from "../../lib/app-data";
import { Link, NavLink } from "react-router-dom";

const personalSettings = settingsRoutes.filter(
  (route) => route.eyebrow === "Settings"
);
const organizationSettings = settingsRoutes.filter(
  (route) => route.eyebrow === "Organization settings"
);

export function SettingsNav(props: {
  backHref: string;
}) {
  return (
    <div className="space-y-6">
      <Link
        to={props.backHref}
        className="block px-3 py-1.5 text-[0.625rem] font-medium text-[var(--color-subtle)] transition hover:text-[var(--color-text)]"
      >
        ← Back to app
      </Link>

      <SettingsSection
        title="Personal settings"
        routes={personalSettings}
      />

      <SettingsSection
        title="Organization settings"
        routes={organizationSettings}
      />
    </div>
  );
}

function SettingsSection(props: {
  title: string;
  routes: typeof settingsRoutes;
}) {
  return (
    <div>
      <div className="mb-2 px-3 text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--color-muted)]">
        {props.title}
      </div>
      <div className="space-y-1">
        {props.routes.map((route) => (
            <NavLink
              key={route.href}
              to={route.href}
              className={({ isActive }) => `block rounded-md px-3 py-1.5 text-[0.625rem] font-medium transition ${
                isActive
                  ? "bg-[var(--color-brand-strong)] text-white"
                  : "text-[var(--color-subtle)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
              }`}
            >
              {route.label}
            </NavLink>
        ))}
      </div>
    </div>
  );
}
