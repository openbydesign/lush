import type { ModelDefaults, WorkspaceMode } from "@lush/api-client";
import type {
  Appearance,
  Concept,
  Route
} from "./types";

export const defaultDisplayName = "First Last";
export const defaultOrganizationName = "Example, Inc.";
export const configuredApiBaseUrl = import.meta.env.VITE_LUSH_API_BASE_URL;
export const builtInAgentIds = {
  chat: "lush-chat",
  code: "lush-code",
  work: "lush-work",
  agents: "lush-agents"
} as const;

export const workspaceModes: Array<{
  value: WorkspaceMode;
  label: string;
}> = [
  { value: "chat", label: "Chat" },
  { value: "code", label: "Code" },
  { value: "work", label: "Work" },
  { value: "agents", label: "Agents" }
];

export const defaultModelDefaults: ModelDefaults = {
  chat: "",
  code: "",
  work: "",
  agents: ""
};

export const routes: Route[] = [
  {
    href: "/chat",
    label: "Chat",
    eyebrow: "Workspace",
    title: "Chat",
    body: "Placeholder for conversations across models, agents, tools, and team contexts.",
    sessionAgentId: builtInAgentIds.chat
  },
  {
    href: "/code",
    label: "Code",
    eyebrow: "Workspace",
    title: "Code",
    body: "Placeholder for coding sessions, repository context, code review, and agent-assisted changes.",
    sessionAgentId: builtInAgentIds.code
  },
  {
    href: "/work",
    label: "Work",
    eyebrow: "Workspace",
    title: "Work",
    body: "Placeholder for long-running work, documents, workflows, and scheduled follow-ups.",
    sessionAgentId: builtInAgentIds.work
  },
  {
    href: "/agents",
    label: "Agents",
    eyebrow: "Workspace",
    title: "Agents",
    body: "Placeholder for creating, managing, and monitoring agent runtimes and skills.",
    sessionAgentId: builtInAgentIds.agents
  },
  {
    href: "/artifacts",
    label: "Artifacts",
    eyebrow: "Workspace",
    title: "Artifacts",
    body: "Files, uploads, and generated work products from your sessions."
  }
];

export function sessionRouteHref(route: Route, sessionId: string) {
  return `${route.href}/sessions/${encodeURIComponent(sessionId)}`;
}

export function createComposerFocusState() {
  return { focusComposerRequest: crypto.randomUUID() };
}

export function readComposerFocusRequest(state: unknown) {
  if (!state || typeof state !== "object" || !("focusComposerRequest" in state)) {
    return undefined;
  }
  const request = state.focusComposerRequest;
  return typeof request === "string" ? request : undefined;
}

export function createProjectChatState(projectId: string, prompt: string) {
  return {
    ...createComposerFocusState(),
    projectId,
    projectPrompt: prompt,
    projectPromptRequest: crypto.randomUUID()
  };
}

export function readProjectChatState(state: unknown) {
  if (!state || typeof state !== "object") return undefined;
  const candidate = state as Record<string, unknown>;
  if (
    typeof candidate.projectId !== "string" ||
    typeof candidate.projectPrompt !== "string" ||
    typeof candidate.projectPromptRequest !== "string"
  ) {
    return undefined;
  }
  const prompt = candidate.projectPrompt.trim();
  return prompt
    ? {
        projectId: candidate.projectId,
        prompt,
        requestId: candidate.projectPromptRequest
      }
    : undefined;
}

export function matchWorkspaceSessionPath(pathname: string) {
  const currentPath = normalizedPath(pathname);

  for (const route of routes) {
    if (!route.sessionAgentId) {
      continue;
    }

    const prefix = `${route.href}/sessions/`;
    if (!currentPath.startsWith(prefix)) {
      continue;
    }

    const encodedSessionId = currentPath.slice(prefix.length);
    if (!encodedSessionId || encodedSessionId.includes("/")) {
      return undefined;
    }

    try {
      return {
        route,
        sessionId: decodeURIComponent(encodedSessionId)
      };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export const settingsRoutes: Route[] = [
  {
    href: "/settings/profile",
    label: "Profile",
    eyebrow: "Settings",
    title: "Profile",
    body: ""
  },
  {
    href: "/settings/appearance",
    label: "Appearance",
    eyebrow: "Settings",
    title: "Appearance",
    body: ""
  },
  {
    href: "/settings/organization",
    label: "Organization",
    eyebrow: "Organization settings",
    title: "Organization",
    body: ""
  },
  {
    href: "/settings/inference",
    label: "Inference",
    eyebrow: "Organization settings",
    title: "Inference",
    body: ""
  },
  {
    href: "/settings/tools",
    label: "Tools",
    eyebrow: "Organization settings",
    title: "Tools",
    body: ""
  }
];

function requiredRoute(routesToSearch: Route[], href: string) {
  const route = routesToSearch.find((candidate) => candidate.href === href);
  if (!route) {
    throw new Error(`Missing route metadata for ${href}`);
  }

  return route;
}

export const profileSettingsRoute = requiredRoute(
  settingsRoutes,
  "/settings/profile"
);
export const organizationSettingsRoute = requiredRoute(
  settingsRoutes,
  "/settings/organization"
);

export const accountRoutes: Route[] = [
  {
    ...profileSettingsRoute,
    label: "Personal settings",
    title: "Personal settings"
  },
  {
    ...organizationSettingsRoute,
    label: "Organization settings",
    title: "Organization settings"
  },
  {
    href: "/concepts",
    label: "Help",
    eyebrow: "Help",
    title: "Lush concepts",
    body: "A quick orientation to the main boundaries that make up Lush."
  },
  {
    href: "/sign-out",
    label: "Sign out",
    eyebrow: "Session",
    title: "Sign out",
    body: "Placeholder for ending the current session and returning to authentication."
  }
];

export const concepts: Concept[] = [
  {
    slug: "api",
    title: "API",
    summary: "Single entry point for apps and integrations.",
    body: "The API keeps the product surface simple by authenticating requests, applying cross-cutting policy, and routing work to the right backend boundary."
  },
  {
    slug: "auth",
    title: "Authentication & Authorization",
    summary: "Identity, sessions, organizations, roles, and access checks.",
    body: "Authentication verifies users and issues sessions. Authorization evaluates what an authenticated principal can do in an organization before protected actions run."
  },
  {
    slug: "sessions",
    title: "Sessions",
    summary: "Shared conversations and active work contexts.",
    body: "Sessions own messages and active work state so the same interaction can move across desktop, web, mobile, and team chat."
  },
  {
    slug: "agents",
    title: "Agents",
    summary: "Agent execution and sandbox orchestration.",
    body: "The agents boundary manages execution contexts, hosted sandboxes, and local development subprocesses behind one control-plane interface."
  },
  {
    slug: "inference",
    title: "Inference",
    summary: "Model routing across providers.",
    body: "Inference owns provider selection, model pinning, failover behavior, and request mediation across interchangeable model backends."
  },
  {
    slug: "tools",
    title: "Tools",
    summary: "Scoped access to MCP, OpenAPI, and tool systems.",
    body: "Tools mediate external capabilities so models receive narrow, governed access instead of raw URLs, credentials, or provider-specific details."
  },
  {
    slug: "skills",
    title: "Skills",
    summary: "Publish, resolve, and load agent skills.",
    body: "Skills are the runtime layer for discovering and loading agent capabilities. The shared skill catalog package keeps the reusable metadata primitives."
  },
  {
    slug: "memory",
    title: "Memory",
    summary: "Portable scoped memory across indexes.",
    body: "Memory separates observed facts from derived memories and applies scoped access controls across relational, graph, and vector-backed stores."
  },
  {
    slug: "scheduler",
    title: "Scheduler",
    summary: "Deferred actions, loops, and wakeups.",
    body: "Scheduler owns durable timing for reminders, recurring loops, retry/backoff state, and waking agents when work becomes due."
  },
  {
    slug: "artifacts",
    title: "Artifacts",
    summary: "Files, uploads, and generated work products.",
    body: "Artifacts track durable outputs such as uploaded files, generated assets, code results, storage references, and lifecycle policy."
  },
  {
    slug: "team-chat",
    title: "Team Chat",
    summary: "Slack, Teams, and Discord integration boundary.",
    body: "Team Chat exposes Lush workflows inside collaboration platforms while keeping platform-specific adapters behind one service interface."
  }
];

export const appearanceOptions: Array<{
  value: Appearance;
  label: string;
  description: string;
}> = [
  {
    value: "system",
    label: "System",
    description: "Match the current operating system appearance."
  },
  {
    value: "dark",
    label: "Dark",
    description: "Use the dark Lush interface."
  },
  {
    value: "light",
    label: "Light",
    description: "Use the light Lush interface."
  }
];

export function normalizedPath(pathname = window.location.pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

export function createId() {
  return crypto.randomUUID();
}

export function getInitialAppearance(): Appearance {
  const stored = window.localStorage.getItem("lush:appearance");

  if (stored === "dark" || stored === "light" || stored === "system") {
    return stored;
  }

  return "system";
}

export function getInitialDisplayName() {
  return defaultDisplayName;
}

export function getInitialOrganizationName() {
  return defaultOrganizationName;
}

export function resolveDisplayName(displayName: string) {
  return displayName.trim() || defaultDisplayName;
}

export function resolveOrganizationName(organizationName: string) {
  return organizationName.trim() || defaultOrganizationName;
}

export function resolveApiBaseUrl() {
  return resolveRuntimeApiBaseUrl({
    runtimeApiBaseUrl: readRuntimeApiBaseUrl(),
    configuredApiBaseUrl,
    browserOrigin: window.location.origin,
    tauriRuntime: isTauriRuntime()
  });
}

export function resolveRuntimeApiBaseUrl({
  runtimeApiBaseUrl,
  configuredApiBaseUrl,
  browserOrigin,
  tauriRuntime
}: {
  runtimeApiBaseUrl?: string;
  configuredApiBaseUrl?: string;
  browserOrigin: string;
  tauriRuntime: boolean;
}) {
  const selectedApiBaseUrl = runtimeApiBaseUrl?.trim() || configuredApiBaseUrl;
  const resolved = selectedApiBaseUrl?.trim().replace(/\/+$/, "");
  if (!resolved) {
    if (tauriRuntime) {
      throw new Error("VITE_LUSH_API_BASE_URL is required in Tauri.");
    }

    return browserOrigin.replace(/\/+$/, "");
  }

  if (!tauriRuntime) {
    return resolved;
  }

  try {
    const url = new URL(resolved);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    return resolved;
  }

  return resolved;
}

function readRuntimeApiBaseUrl() {
  if (typeof window === "undefined") {
    return undefined;
  }

  return (window as Window & {
    __LUSH_CONFIG__?: { apiBaseUrl?: string };
  }).__LUSH_CONFIG__?.apiBaseUrl;
}

function isTauriRuntime() {
  return Boolean(
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  );
}

export function getFirstName(displayName: string) {
  return resolveDisplayName(displayName).split(/\s+/)[0] ?? "First";
}

export function getInitials(displayName: string) {
  const words = resolveDisplayName(displayName).split(/\s+/).slice(0, 2);
  return words.map((word) => word[0]?.toUpperCase()).join("") || "FL";
}

export function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}
