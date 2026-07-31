import { lazy, Suspense, useEffect, useRef } from "react";
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
  useNavigate,
  useParams,
  useRouteError
} from "react-router-dom";
import { AppProvider, useApp } from "../App";
import { TooltipProvider } from "../components/ui/tooltip";
import { CodeProvider } from "../features/code/CodeProvider";
import { routes } from "../lib/app-data";
import { AppShell } from "./AppShell";
import { AuthPage } from "../routes/AuthPage";
import { AccountRecoveryPage } from "../routes/AccountRecoveryPage";
import { CreateOrganizationPage } from "../routes/CreateOrganizationPage";
import { NotFoundPage } from "../routes/NotFoundPage";
import { OrganizationInvitePage } from "../routes/OrganizationInvitePage";
import { RoutePlaceholderPage } from "../routes/RoutePlaceholderPage";
import { ConceptDetailPage } from "../routes/concepts/ConceptDetailPage";
import { ConceptsPage } from "../routes/concepts/ConceptsPage";
import { SessionsPage } from "../routes/SessionsPage";
import { ProjectsPage } from "../routes/projects/ProjectsPage";
import { ProjectPage } from "../routes/projects/ProjectPage";
import { PersonalSettingsPage } from "../routes/settings/PersonalSettingsPage";

const ChatPage = lazy(() =>
  import("../routes/chat/ChatPage").then((module) => ({ default: module.ChatPage }))
);
const CodePage = lazy(() =>
  import("../routes/code/CodePage").then((module) => ({ default: module.CodePage }))
);
const InferenceSettingsPage = lazy(() =>
  import("../routes/settings/InferenceSettingsPage").then((module) => ({
    default: module.InferenceSettingsPage
  }))
);
const OrganizationSettingsPage = lazy(() =>
  import("../routes/settings/OrganizationSettingsPage").then((module) => ({
    default: module.OrganizationSettingsPage
  }))
);
const ToolsSettingsPage = lazy(() =>
  import("../routes/settings/ToolsSettingsPage").then((module) => ({
    default: module.ToolsSettingsPage
  }))
);

const router = createBrowserRouter([
  {
    errorElement: <RouteErrorPage />,
    element: (
      <AppProvider>
        <CodeProvider>
          <TooltipProvider>
            <AppRoot />
          </TooltipProvider>
        </CodeProvider>
      </AppProvider>
    ),
    children: [
      { index: true, element: <IndexRoute /> },
      { path: "verify-email", element: <AccountRecoveryPage mode="verify" /> },
      { path: "forgot-password", element: <AccountRecoveryPage mode="forgot" /> },
      { path: "reset-password", element: <AccountRecoveryPage mode="reset" /> },
      {
        element: <PublicOnlyRoute />,
        children: [
          { path: "sign-in", element: <AuthPage mode="login" /> },
          { path: "register", element: <AuthPage mode="register" /> }
        ]
      },
      {
        element: <AuthenticatedRoute />,
        children: [
          {
            path: "organization-invites/respond",
            element: <OrganizationInvitePage />
          },
          {
            element: <AppShell />,
            children: [
              {
                path: "organizations/new",
                element: <CreateOrganizationRoute />
              },
              { path: "sign-out", element: <SignOutRoute /> },
              {
                element: <OrganizationRoute />,
                children: [
                  { path: "concepts", element: <ConceptsRoute /> },
                  { path: "concepts/:slug", element: <ConceptDetailRoute /> },
                  { path: "sessions", element: <SessionsPage /> },
                  { path: "projects", element: <ProjectsPage /> },
                  { path: "projects/:projectId", element: <ProjectRoute /> },
                  { path: "settings/personal", element: <Navigate to="/settings/profile" replace /> },
                  { path: "settings/profile", element: <PersonalSettingsRoute pane="profile" /> },
                  { path: "settings/appearance", element: <PersonalSettingsRoute pane="appearance" /> },
                  { path: "settings/my-tools", element: <ToolsSettingsRoute mode="personal" /> },
                  { path: "settings/organization", element: <OrganizationSettingsRoute /> },
                  { path: "settings/inference", element: <InferenceSettingsRoute /> },
                  { path: "settings/tool-gateway", element: <ToolsSettingsRoute mode="organization" /> },
                  { path: "settings/tools", element: <Navigate to="/settings/tool-gateway" replace /> },
                  ...routes.flatMap((route) => {
                    const element = route.href === "/chat"
                      ? <ChatRoute />
                      : route.href === "/code"
                        ? <CodePage />
                        : <RoutePlaceholderPage route={route} />;
                    const baseRoute = {
                      path: route.href.slice(1),
                      element
                    };

                    return route.sessionAgentId
                      ? [
                          baseRoute,
                          {
                            path: `${route.href.slice(1)}/sessions/:sessionId`,
                            element
                          }
                        ]
                      : [baseRoute];
                  }),
                  { path: "*", element: <NotFoundRoute /> }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}

function AppRoot() {
  return (
    <main className="h-screen overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </main>
  );
}

function IndexRoute() {
  const app = useApp();
  if (app.sessionStatus === "loading") return null;
  if (!app.isAuthenticated) return <Navigate to="/sign-in" replace />;
  return <Navigate to={app.hasActiveOrganization ? "/sessions" : "/organizations/new"} replace />;
}

function PublicOnlyRoute() {
  const app = useApp();
  if (app.sessionStatus === "loading") return null;
  if (app.isAuthenticated) {
    return <Navigate to={app.hasActiveOrganization ? "/sessions" : "/organizations/new"} replace />;
  }
  return <Outlet />;
}

function AuthenticatedRoute() {
  const app = useApp();
  const location = useLocation();
  if (app.sessionStatus === "loading") return null;
  if (!app.isAuthenticated) {
    return (
      <Navigate
        to="/sign-in"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }
  return <Outlet />;
}

function OrganizationRoute() {
  const app = useApp();
  return app.hasActiveOrganization ? <Outlet /> : <Navigate to="/organizations/new" replace />;
}

function ConceptsRoute() {
  return <ConceptsPage />;
}

function ConceptDetailRoute() {
  const { slug } = useParams();
  return <ConceptDetailPage slug={slug ?? ""} />;
}

function ProjectRoute() {
  const { projectId } = useParams();
  return <ProjectPage projectId={projectId ?? ""} />;
}

function CreateOrganizationRoute() {
  const app = useApp();
  return (
    <CreateOrganizationPage
      error={app.organizationError}
      onCreate={app.createNewOrganization}
    />
  );
}

function PersonalSettingsRoute({ pane }: { pane: "profile" | "appearance" }) {
  const app = useApp();
  return (
    <PersonalSettingsPage
      pane={pane}
      email={app.sessionClaims?.email ?? ""}
      displayName={app.displayName}
      appearance={app.appearance}
      onDisplayNameChange={app.setDisplayName}
      onAppearanceChange={app.setAppearance}
    />
  );
}

function OrganizationSettingsRoute() {
  const app = useApp();
  const navigate = useNavigate();

  const deleteOrganization = async () => {
    const result = await app.deleteActiveOrganization();
    navigate(result.requiresOrganization ? "/organizations/new" : "/sessions", {
      replace: true
    });
  };

  return (
    <OrganizationSettingsPage
      organizationName={app.organizationName}
      currentRole={app.membershipRole}
      organizationError={app.organizationError}
      members={app.organizationMembers}
      invites={app.organizationInvites}
      onOrganizationNameChange={app.setOrganizationName}
      onDeleteOrganization={deleteOrganization}
      onInviteCreate={app.inviteOrganizationMember}
      onMemberRoleChange={app.setOrganizationMemberRole}
      onMemberRemove={app.removeMemberFromOrganization}
    />
  );
}

function InferenceSettingsRoute() {
  const app = useApp();
  return (
    <InferenceSettingsPage
      currentRole={app.membershipRole}
      inferenceConfig={app.inferenceConfig}
      modelDefaults={app.modelDefaults}
      inferenceProviderError={app.inferenceProviderError}
      isAddingInferenceProvider={app.isAddingInferenceProvider}
      refreshingInferenceProviderId={app.refreshingInferenceProviderId}
      onAddInferenceProvider={app.addInferenceProvider}
      onProviderEnabledChange={app.setInferenceProviderEnabled}
      onProviderModelsRefresh={app.refreshProviderModels}
      onProviderDelete={app.removeInferenceProvider}
      onModelEnabledChange={app.setInferenceModelEnabled}
      onModelDefaultChange={app.setModelDefault}
    />
  );
}

function ToolsSettingsRoute({ mode }: { mode: "organization" | "personal" }) {
  const app = useApp();
  return (
    <ToolsSettingsPage
      apiBaseUrl={app.apiBaseUrl}
      currentRole={app.membershipRole}
      runApiRequest={app.runApiRequest}
      mode={mode}
    />
  );
}

function ChatRoute() {
  const app = useApp();
  return (
    <ChatPage
      displayName={app.resolvedDisplayName}
      apiBaseUrl={app.apiBaseUrl}
      defaultModelSelection={app.modelDefaults.chat}
      providers={app.enabledInferenceProviders}
      currentRole={app.membershipRole}
      session={app.activeChatSession}
      sessionKey={app.chatSessionKey}
      ensureSession={app.ensureSession}
      onCreateSession={app.createChatSession}
      onTruncateSession={app.truncateChatSession}
      onMessageFeedback={app.recordChatMessageFeedback}
      onModelSelectionChange={app.recordChatModelSelection}
    />
  );
}

function SignOutRoute() {
  const app = useApp();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void app.signOut();
  }, [app]);
  return null;
}

function NotFoundRoute() {
  return <NotFoundPage />;
}

function RouteErrorPage() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Unexpected client error";

  return (
    <main className="flex h-screen items-center justify-center bg-[var(--color-bg)] px-6 text-[var(--color-text)]">
      <section className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-5">
        <h1 className="text-base font-semibold">Lush could not open this page</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{message}</p>
        <a
          href="/"
          className="mt-4 inline-block text-sm font-medium text-[var(--color-brand-soft)] hover:text-[var(--color-text)]"
        >
          Return to Lush
        </a>
      </section>
    </main>
  );
}
