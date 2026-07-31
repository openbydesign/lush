import { expect, test } from "bun:test";
import {
  accountRoutes,
  createComposerFocusState,
  createProjectChatState,
  matchWorkspaceSessionPath,
  readComposerFocusRequest,
  readProjectChatState,
  resolveRuntimeApiBaseUrl,
  routes,
  settingsRoutes,
  sessionRouteHref
} from "../apps/lush/src/lib/app-data";

test("help replaces concepts in the account navigation before sign out", () => {
  expect(accountRoutes.slice(-2).map((route) => [route.label, route.href])).toEqual([
    ["Help", "/concepts"],
    ["Sign out", "/sign-out"]
  ]);
});

test("tool settings separate personal access from organization governance", () => {
  expect(
    settingsRoutes
      .filter((route) => route.label.toLowerCase().includes("tool"))
      .map((route) => [route.label, route.href])
  ).toEqual([
    ["My tools", "/settings/my-tools"],
    ["Tool gateway", "/settings/tool-gateway"]
  ]);
});

test("project chat navigation carries its project and initial prompt", () => {
  const state = createProjectChatState("project-1", "  Draft a launch plan  ");

  expect(readProjectChatState(state)).toEqual({
    projectId: "project-1",
    prompt: "Draft a launch plan",
    requestId: state.projectPromptRequest
  });
  expect(readProjectChatState({ projectId: "project-1" })).toBeUndefined();
});

test("artifacts follows Agents and is not a session workspace", () => {
  expect(routes.slice(-2).map((route) => route.label)).toEqual([
    "Agents",
    "Artifacts"
  ]);
  expect(routes.at(-1)?.sessionAgentId).toBeUndefined();
});

test("workspace session routes include the session id", () => {
  const chatRoute = routes.find((route) => route.href === "/chat");

  expect(chatRoute).toBeDefined();
  expect(sessionRouteHref(chatRoute!, "session-123")).toBe(
    "/chat/sessions/session-123"
  );
  expect(
    sessionRouteHref(chatRoute!, "session with spaces")
  ).toBe("/chat/sessions/session%20with%20spaces");
});

test("workspace session route matching resolves route metadata and id", () => {
  const match = matchWorkspaceSessionPath("/chat/sessions/session-123");

  expect(match?.route.href).toBe("/chat");
  expect(match?.sessionId).toBe("session-123");
  expect(matchWorkspaceSessionPath("/chat/sessions")).toBeUndefined();
  expect(matchWorkspaceSessionPath("/chat/sessions/one/two")).toBeUndefined();
  expect(matchWorkspaceSessionPath("/settings/profile")).toBeUndefined();
});

test("new session navigation carries a unique composer focus request", () => {
  const first = createComposerFocusState();
  const second = createComposerFocusState();

  expect(readComposerFocusRequest(first)).toBe(first.focusComposerRequest);
  expect(readComposerFocusRequest(second)).toBe(second.focusComposerRequest);
  expect(first.focusComposerRequest).not.toBe(second.focusComposerRequest);
  expect(readComposerFocusRequest({ focusComposerRequest: 42 })).toBeUndefined();
  expect(readComposerFocusRequest(undefined)).toBeUndefined();
});

test("the browser app defaults to a same-origin API", () => {
  expect(
    resolveRuntimeApiBaseUrl({
      browserOrigin: "https://lush.example.com/",
      tauriRuntime: false
    })
  ).toBe("https://lush.example.com");
});

test("runtime API configuration overrides build-time configuration", () => {
  expect(
    resolveRuntimeApiBaseUrl({
      runtimeApiBaseUrl: "https://api.runtime.example.com/",
      configuredApiBaseUrl: "https://api.build.example.com",
      browserOrigin: "https://app.example.com",
      tauriRuntime: false
    })
  ).toBe("https://api.runtime.example.com");
});

test("Tauri requires an explicit API and normalizes localhost", () => {
  expect(() =>
    resolveRuntimeApiBaseUrl({
      browserOrigin: "tauri://localhost",
      tauriRuntime: true
    })
  ).toThrow("VITE_LUSH_API_BASE_URL is required in Tauri.");

  expect(
    resolveRuntimeApiBaseUrl({
      configuredApiBaseUrl: "http://localhost:7330/",
      browserOrigin: "tauri://localhost",
      tauriRuntime: true
    })
  ).toBe("http://127.0.0.1:7330");
});
