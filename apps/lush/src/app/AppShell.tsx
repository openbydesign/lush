import { Suspense, useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon
} from "lucide-react";
import { useApp } from "../App";
import { RouteLoadingSkeleton } from "../components/LoadingSkeletons";
import logoUrl from "../assets/lush-logo.svg?url";
import {
  Dialog,
  DialogContent,
  DialogTitle
} from "../components/ui/dialog";
import { WorkspaceNav } from "../components/navigation/WorkspaceNav";
import { SettingsNav } from "../components/navigation/SettingsNav";
import { UserMenu } from "../components/navigation/UserMenu";
import {
  matchWorkspaceSessionPath,
  routes
} from "../lib/app-data";
import {
  readSidebarCollapsed,
  writeSidebarCollapsed
} from "../lib/sidebar-preference";
import { ScrollFade } from "../ui/ScrollFade";

export function AppShell() {
  const app = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname;
  const [lastAppPath, setLastAppPath] = useState("/sessions");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    readSidebarCollapsed
  );
  const [desktopUserMenuOpen, setDesktopUserMenuOpen] = useState(false);
  const [mobileUserMenuOpen, setMobileUserMenuOpen] = useState(false);
  const sessionMatch = matchWorkspaceSessionPath(path);
  const activeWorkspaceRoute =
    sessionMatch?.route ?? routes.find((route) => route.href === path);
  const activeWorkspaceLabel = activeWorkspaceRoute?.label ??
    (path.startsWith("/projects") ? "Projects" : undefined);
  const isSettingsRoute = path.startsWith("/settings/");

  useEffect(() => {
    if (
      path !== "/" &&
      !isSettingsRoute &&
      path !== "/organizations/new" &&
      path !== "/sign-out"
    ) {
      setLastAppPath(path);
    }
  }, [isSettingsRoute, path]);

  useEffect(() => {
    setMobileNavigationOpen(false);
    setMobileUserMenuOpen(false);
  }, [path]);

  const switchOrganization = async (organizationId: string) => {
    await app.switchActiveOrganization(organizationId);
    setDesktopUserMenuOpen(false);
    setMobileUserMenuOpen(false);
    setMobileNavigationOpen(false);
    navigate("/sessions", { replace: true });
  };

  const updateMobileNavigationOpen = (open: boolean) => {
    setMobileNavigationOpen(open);
    if (!open) {
      setMobileUserMenuOpen(false);
    }
  };

  const updateSidebarCollapsed = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    writeSidebarCollapsed(collapsed);
  };

  const workspaceNavigation = () =>
    isSettingsRoute ? (
      <SettingsNav backHref={lastAppPath} />
    ) : (
      <WorkspaceNav />
    );

  const accountMenu = (
    open: boolean,
    onOpenChange: (open: boolean) => void
  ) => (
    <UserMenu
      open={open}
      displayName={app.resolvedDisplayName}
      organizationName={app.resolvedOrganizationName}
      activeOrganizationId={app.activeOrganizationId}
      organizations={app.organizations}
      onOpenChange={onOpenChange}
      onSignOut={() => void app.signOut()}
      onOrganizationSwitch={(organizationId) => {
        void switchOrganization(organizationId).catch(() => undefined);
      }}
    />
  );

  const brandLink = () => (
    <Link
      to="/sessions"
      className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-xs font-semibold text-[var(--color-text)]"
    >
      <img src={logoUrl} alt="Lush" className="size-8 shrink-0" />
      <span>Lush</span>
      {activeWorkspaceLabel ? (
        <>
          <span className="h-4 w-px shrink-0 bg-[var(--color-border-strong)]" />
          <span className="truncate rounded-md bg-[var(--color-panel)] px-2 py-1 text-[0.625rem] font-medium text-[var(--color-subtle)]">
            {activeWorkspaceLabel}
          </span>
        </>
      ) : null}
    </Link>
  );

  return (
    <section className="flex h-screen min-h-0 w-full flex-col px-4 sm:px-6">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] lg:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => updateMobileNavigationOpen(true)}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-[var(--color-subtle)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          >
            <MenuIcon className="size-5" />
          </button>
          {brandLink()}
        </div>
      </header>

      <div
        className={`relative grid min-h-0 flex-1 transition-[grid-template-columns,gap] duration-200 ease-out ${
          sidebarCollapsed
            ? "lg:grid-cols-[0_minmax(0,1fr)] lg:gap-0"
            : "lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-6"
        }`}
      >
        <aside
          aria-hidden={sidebarCollapsed}
          inert={sidebarCollapsed}
          className={`hidden min-h-0 min-w-0 max-w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden border-r border-[var(--color-border)] pr-6 transition-[opacity,transform] duration-150 lg:grid ${
            sidebarCollapsed
              ? "pointer-events-none -translate-x-2 opacity-0"
              : "translate-x-0 opacity-100"
          }`}
        >
          <div className="flex h-14 min-w-0 items-center gap-2 border-b border-[var(--color-border)]">
            {brandLink()}
            <button
              type="button"
              aria-label="Hide sidebar"
              title="Hide sidebar"
              onClick={() => updateSidebarCollapsed(true)}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--color-muted)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
            >
              <PanelLeftCloseIcon className="size-4" />
            </button>
          </div>
          <nav className="min-h-0 min-w-0 max-w-full overflow-hidden pt-4">
            <ScrollFade
              className="h-full w-full min-w-0 max-w-full overflow-hidden"
              viewportClass="h-full w-full min-w-0 max-w-full overflow-x-hidden overflow-y-auto"
              contentClass="w-full min-w-0 max-w-full overflow-hidden space-y-1"
              top={false}
              bottom={false}
            >
              {workspaceNavigation()}
            </ScrollFade>
          </nav>

          {accountMenu(desktopUserMenuOpen, setDesktopUserMenuOpen)}
        </aside>

        <section className="relative min-h-0 min-w-0 overflow-y-auto py-3 sm:py-4 lg:pr-2">
          {sidebarCollapsed ? (
            <button
              type="button"
              aria-label="Show sidebar"
              title="Show sidebar"
              onClick={() => updateSidebarCollapsed(false)}
              className="absolute left-0 top-3 z-40 hidden size-8 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-muted)] shadow-sm backdrop-blur transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] lg:flex"
            >
              <PanelLeftOpenIcon className="size-4" />
            </button>
          ) : null}
          <Suspense fallback={<RouteLoadingSkeleton path={path} />}>
            <div className="content-enter h-full">
              <Outlet />
            </div>
          </Suspense>
        </section>
      </div>

      <Dialog open={mobileNavigationOpen} onOpenChange={updateMobileNavigationOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="top-0 left-0 grid h-dvh w-[min(20rem,calc(100vw-2rem))] max-w-none -translate-x-0 -translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 rounded-none border-y-0 border-l-0 p-4 sm:max-w-xs lg:hidden"
        >
          <DialogTitle className="mb-5 flex items-center gap-2 pr-10 text-xs">
            <img src={logoUrl} alt="" className="size-8" />
            {activeWorkspaceLabel ?? "Lush"}
          </DialogTitle>
          <nav
            className="min-h-0 overflow-y-auto"
            onClickCapture={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest("a") || target.closest("[data-navigation-action]")) {
                updateMobileNavigationOpen(false);
              }
            }}
          >
            {workspaceNavigation()}
          </nav>
          {accountMenu(mobileUserMenuOpen, setMobileUserMenuOpen)}
        </DialogContent>
      </Dialog>
    </section>
  );
}
