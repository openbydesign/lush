import {
  type AccessSession,
  type AddInferenceProviderRequest,
  appendSessionMessage,
  appendSessionState,
  addProjectContext,
  archiveSession,
  createProject,
  createSession,
  createOrganization,
  createOrganizationInvite,
  createInferenceProvider,
  deleteCurrentOrganization,
  deleteInferenceProvider,
  deleteProject,
  deleteProjectContext,
  fetchInferenceConfig,
  fetchProjectById,
  fetchSessionById,
  listOrganizationInvites,
  listOrganizationMembers,
  listOrganizations,
  listProjects,
  login,
  logout,
  type OrganizationInvite,
  type OrganizationMember,
  type OrganizationSummary,
  type Project,
  type ProjectSummary,
  openClientEvents,
  refreshInferenceProviderModels,
  registerAccount,
  removeOrganizationMember,
  respondToOrganizationInvite,
  switchOrganization,
  truncateSession,
  updateCurrentOrganization,
  updateInferenceModelDefault,
  type InferenceConfig,
  listSessions,
  updateInferenceModel,
  updateInferenceProvider,
  updateOrganizationMemberRole,
  updateCurrentUser,
  updateProject,
  updateSession,
  type Session,
  type SessionSummary,
  type UserRole,
  type WorkspaceMode
} from "@lush/api-client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";
import {
  builtInAgentIds,
  defaultModelDefaults,
  getInitialDisplayName,
  getInitialOrganizationName,
  getInitialAppearance,
  getSystemTheme,
  normalizedPath,
  resolveApiBaseUrl,
  resolveDisplayName,
  resolveOrganizationName,
  routes,
  sessionRouteHref,
} from "./lib/app-data";
import {
  type AccessTokenClaims,
  accessTokenExpiresSoon,
  clearCachedAccessSession,
  normalizeAccessSession,
  parseAccessTokenClaims,
  readCachedAccessSession,
  refreshAccessSession,
  withTokenRefresh,
  writeCachedAccessSession
} from "./lib/api-session";
import {
  appendSessionMessageSnapshot,
  appendSessionStateSnapshot,
  preferNewestSessionSnapshot
} from "./lib/chat-session-state";
import { chatModelSelectionState } from "./lib/chat-model-selection";
import { inferenceProviderErrorMessage } from "./lib/inference-provider-error";
import { abortableDelay, readClientEventStream } from "./lib/client-event-stream";
import type { Appearance, SessionStatus } from "./lib/types";

function useAppController() {
  const sessionRequestIdRef = useRef(0);
  const clientEventRefreshRef = useRef<Promise<void> | undefined>(undefined);
  const chatSessionLoadRequestIdRef = useRef(0);
  const restoreStartedRef = useRef(false);
  const location = useLocation();
  const routerNavigate = useNavigate();
  const path = normalizedPath(location.pathname);
  const chatSessionMatch = useMatch("/chat/sessions/:sessionId");
  const [appearance, setAppearanceSignal] =
    useState<Appearance>(getInitialAppearance());
  const [systemTheme, setSystemTheme] = useState(getSystemTheme());
  const [displayName, setDisplayNameSignal] =
    useState(getInitialDisplayName());
  const [sessionToken, setSessionToken] = useState("");
  const [sessionTokenExpiresAt, setSessionTokenExpiresAt] = useState("");
  const [sessionClaims, setSessionClaims] = useState<AccessTokenClaims>();
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("loading");
  const [inferenceConfig, setInferenceConfig] =
    useState<InferenceConfig>();
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [organizationMembers, setOrganizationMembers] =
    useState<OrganizationMember[]>([]);
  const [organizationInvites, setOrganizationInvites] =
    useState<OrganizationInvite[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeChatSession, setActiveChatSession] = useState<Session>();
  const [activeChatSessionId, setActiveChatSessionId] = useState<string>();
  const [chatSessionKey, setChatSessionKey] = useState(0);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const [membershipRole, setMembershipRole] = useState<UserRole>();
  const [organizationError, setOrganizationError] = useState("");
  const [inferenceProviderError, setInferenceProviderError] = useState("");
  const [isAddingInferenceProvider, setIsAddingInferenceProvider] =
    useState(false);
  const [refreshingInferenceProviderId, setRefreshingInferenceProviderId] =
    useState("");
  const [organizationName, setOrganizationNameSignal] =
    useState(getInitialOrganizationName());
  const sessionTokenRef = useRef("");
  const sessionTokenExpiresAtRef = useRef("");
  const sessionClaimsRef = useRef<AccessTokenClaims | undefined>(undefined);
  const sessionStatusRef = useRef<SessionStatus>("loading");
  const activeChatSessionIdRef = useRef<string | undefined>(undefined);
  const loadingChatSessionIdRef = useRef<string | undefined>(undefined);
  const hasActiveOrganization = Boolean(sessionClaims?.org);
  const resolvedTheme = appearance === "system" ? systemTheme : appearance;
  const resolvedDisplayName = resolveDisplayName(displayName);
  const apiBaseUrl = resolveApiBaseUrl();
  const resolvedOrganizationName = organizationName.trim()
    ? resolveOrganizationName(organizationName)
    : "No organization";
  const isAuthenticated = sessionStatus === "ready";

  const setAppearance = (nextAppearance: Appearance) => {
    setAppearanceSignal(nextAppearance);
    window.localStorage.setItem("lush:appearance", nextAppearance);
  };

  const setDisplayName = async (nextDisplayName: string) => {
    const previousDisplayName = displayName;
    const normalizedDisplayName = nextDisplayName.trim();

    if (!normalizedDisplayName) {
      setDisplayNameSignal(previousDisplayName);
      throw new Error("Display name is required");
    }

    if (normalizedDisplayName === previousDisplayName) {
      setDisplayNameSignal(normalizedDisplayName);
      return;
    }

    setDisplayNameSignal(normalizedDisplayName);

    try {
      await runAuthenticated((session) =>
        updateCurrentUser(apiBaseUrl, session.accessToken, {
          displayName: normalizedDisplayName
        })
      );
      const refreshed = await refreshAppliedSession();
      await refreshOrganizationState(refreshed);
    } catch (error) {
      setDisplayNameSignal(previousDisplayName);
      throw error;
    }
  };

  const setOrganizationName = async (nextOrganizationName: string) => {
    const previousOrganizationName = organizationName;
    const normalizedOrganizationName = nextOrganizationName.trim();

    if (!normalizedOrganizationName) {
      setOrganizationNameSignal(previousOrganizationName);
      throw new Error("Organization name is required");
    }

    if (normalizedOrganizationName === previousOrganizationName) {
      setOrganizationNameSignal(normalizedOrganizationName);
      return;
    }

    setOrganizationNameSignal(normalizedOrganizationName);

    try {
      await runAuthenticated((session) =>
        updateCurrentOrganization(apiBaseUrl, session.accessToken, {
          name: normalizedOrganizationName
        })
      );
      const refreshed = await refreshAppliedSession();
      await refreshOrganizationState(refreshed);
    } catch (error) {
      setOrganizationNameSignal(previousOrganizationName);
      throw error;
    }
  };

  const modelDefaults = inferenceConfig?.modelDefaults ?? defaultModelDefaults;
  const enabledInferenceProviders =
    (inferenceConfig?.providers ?? [])
      .filter((provider) => provider.enabled)
      .map((provider) => ({
        ...provider,
        models: provider.models.filter((model) => model.enabled)
      }))
      .filter((provider) => provider.models.length > 0);
  const setModelDefault = async (
    mode: WorkspaceMode,
    modelSelection: string
  ) => {
    setInferenceProviderError("");

    try {
      const config = await runAuthenticated((session) =>
        updateInferenceModelDefault(apiBaseUrl, session.accessToken, {
          mode,
          modelSelection
        })
      );
      applyInferenceConfig(config);
    } catch (error) {
      setInferenceProviderError(
        inferenceProviderErrorMessage(error, "Unable to update model default.")
      );
    }
  };

  const applyInferenceConfig = (
    config: InferenceConfig
  ) => {
    setInferenceConfig(config);
  };

  const applySession = (accessSession: AccessSession) => {
    const normalized = normalizeAccessSession(accessSession);
    const claims = normalized.claims;
    setSessionToken(normalized.accessSession.accessToken);
    setSessionTokenExpiresAt(normalized.accessSession.accessTokenExpiresAt);
    setSessionClaims(claims);
    sessionTokenRef.current = normalized.accessSession.accessToken;
    sessionTokenExpiresAtRef.current = normalized.accessSession.accessTokenExpiresAt;
    sessionClaimsRef.current = claims;
    sessionStatusRef.current = "ready";
    setDisplayNameSignal(claims.name);
    setOrganizationNameSignal(claims.org ? claims.org_name : "");
    setActiveOrganizationId(claims.org);
    setMembershipRole(claims.role ?? undefined);
    setSessionStatus("ready");
    writeCachedAccessSession(normalized.accessSession);
  };

  const refreshAppliedSession = async () => {
    return refreshAccessSession(apiBaseUrl, applySession);
  };

  const runWithTokenRefresh = async <T,>(
    accessSession: AccessSession,
    operation: (session: AccessSession) => Promise<T>
  ) => {
    return withTokenRefresh(
      {
        apiBaseUrl: apiBaseUrl,
        accessSession,
        applySession
      },
      operation
    );
  };

  const refreshOrganizationState = async (
    accessSession: AccessSession = currentAccessSession()
  ) => {
    const claims = parseAccessTokenClaims(accessSession.accessToken);
    if (!claims) {
      throw new Error("Invalid access token");
    }

    const organizationState = await runWithTokenRefresh(
      accessSession,
      (session) => listOrganizations(apiBaseUrl, session.accessToken)
    );
    setOrganizations(organizationState.organizations);

    const activeClaims = sessionClaimsRef.current ?? claims;
    if (!activeClaims.org) {
      setOrganizationMembers([]);
      setOrganizationInvites([]);
      return;
    }

    const members = await runWithTokenRefresh(
      accessSession,
      (session) => listOrganizationMembers(apiBaseUrl, session.accessToken)
    );
    setOrganizationMembers(members.members);

    if (activeClaims.role !== "admin") {
      setOrganizationInvites([]);
      return;
    }

    const invites = await runWithTokenRefresh(
      accessSession,
      (session) => listOrganizationInvites(apiBaseUrl, session.accessToken)
    );
    setOrganizationInvites(invites.invites);
  };

  const refreshSessions = async (
    accessSession: AccessSession = currentAccessSession()
  ) => {
    const claims = parseAccessTokenClaims(accessSession.accessToken);
    if (!claims?.org) {
      chatSessionLoadRequestIdRef.current += 1;
      setSessions([]);
      setProjects([]);
      setActiveChatSession(undefined);
      setActiveChatSessionId(undefined);
      activeChatSessionIdRef.current = undefined;
      loadingChatSessionIdRef.current = undefined;
      setChatSessionKey((current) => current + 1);
      return;
    }

    const [response, projectResponse] = await Promise.all([
      runWithTokenRefresh(accessSession, (session) =>
        listSessions(apiBaseUrl, session.accessToken)
      ),
      runWithTokenRefresh(accessSession, (session) =>
        listProjects(apiBaseUrl, session.accessToken)
      )
    ]);
    setSessions(response.sessions);
    setProjects(projectResponse.projects);
    const activeId = activeChatSessionIdRef.current;
    if (activeId && !response.sessions.some((session) => session.id === activeId)) {
      chatSessionLoadRequestIdRef.current += 1;
      setActiveChatSession(undefined);
      setActiveChatSessionId(undefined);
      activeChatSessionIdRef.current = undefined;
      loadingChatSessionIdRef.current = undefined;
      setChatSessionKey((current) => current + 1);
    }
  };

  const fetchSessionInferenceConfig = async (
    accessSession: AccessSession
  ) => {
    const claims = parseAccessTokenClaims(accessSession.accessToken);
    if (!claims) {
      throw new Error("Invalid access token");
    }

    if (!claims.org || !claims.role) {
      setInferenceProviderError("");
      return undefined;
    }

    try {
      const config = await runWithTokenRefresh(accessSession, (session) =>
        fetchInferenceConfig(apiBaseUrl, session.accessToken)
      );
      setInferenceProviderError("");
      return config;
    } catch (error) {
      setInferenceProviderError(
        error instanceof Error
          ? error.message
          : "Unable to load inference configuration"
      );
      return undefined;
    }
  };

  const currentAccessSession = (): AccessSession => {
    const claims = sessionClaimsRef.current;
    const token = sessionCredential();
    const expiresAt = sessionTokenExpiresAtRef.current;
    if (!claims || !token || !expiresAt) {
      throw new Error("Sign in required");
    }

    return {
      accessToken: token,
      accessTokenExpiresAt: expiresAt,
      session: {
        sessionId: claims.sid,
        user: {
          id: claims.sub,
          email: claims.email,
          emailVerified: true,
          displayName: claims.name
        },
        organization: claims.org
          ? {
              id: claims.org,
              name: claims.org_name
            }
          : null,
        membership: claims.mid && claims.role
          ? {
              id: claims.mid,
              role: claims.role
            }
          : null,
        createdAt: "",
        expiresAt
      }
    };
  };

  const sessionCredential = () => sessionTokenRef.current || undefined;
  const sessionTokenExpiresSoon = () =>
    accessTokenExpiresSoon(sessionTokenExpiresAtRef.current);

  const replaceRoute = (href: string) => {
    const nextPath = normalizedPath(href);
    if (nextPath !== path) {
      routerNavigate(nextPath, { replace: true });
    }
  };

  const clearSessionState = () => {
    chatSessionLoadRequestIdRef.current += 1;
    clearCachedAccessSession();
    setSessionToken("");
    setSessionTokenExpiresAt("");
    setSessionClaims(undefined);
    setSessionStatus("signed-out");
    sessionTokenRef.current = "";
    sessionTokenExpiresAtRef.current = "";
    sessionClaimsRef.current = undefined;
    sessionStatusRef.current = "signed-out";
    setInferenceConfig(undefined);
    setOrganizations([]);
    setOrganizationMembers([]);
    setOrganizationInvites([]);
    setSessions([]);
    setProjects([]);
    setActiveChatSession(undefined);
    setActiveChatSessionId(undefined);
    activeChatSessionIdRef.current = undefined;
    loadingChatSessionIdRef.current = undefined;
    setChatSessionKey((current) => current + 1);
    setActiveOrganizationId(null);
    setMembershipRole(undefined);
  };

  const restoreSession = async () => {
    const requestId = ++sessionRequestIdRef.current;
    setSessionStatus("loading");
    sessionStatusRef.current = "loading";

    try {
      const cachedSession = readCachedAccessSession();
      if (cachedSession) {
        applySession(cachedSession);
        await refreshOrganizationState(cachedSession);
        await refreshSessions(cachedSession);
        const config = await fetchSessionInferenceConfig(cachedSession);
        if (requestId !== sessionRequestIdRef.current) {
          return;
        }

        setInferenceConfig(config);
        return;
      }
    } catch {
      clearCachedAccessSession();
    }

    try {
      const session = await refreshAccessSession(apiBaseUrl, (accessSession) => {
        if (requestId === sessionRequestIdRef.current) {
          applySession(accessSession);
        }
      });
      if (requestId !== sessionRequestIdRef.current) {
        return;
      }

      applySession(session);
      await refreshOrganizationState(session);
      await refreshSessions(session);
      const config = await fetchSessionInferenceConfig(session);
      if (requestId === sessionRequestIdRef.current) {
        setInferenceConfig(config);
      }
    } catch (error) {
      if (requestId === sessionRequestIdRef.current) {
        clearSessionState();
      }
    }
  };

  const ensureSession = async (force = false) => {
    if (sessionStatusRef.current !== "ready" || force || sessionTokenExpiresSoon()) {
      try {
        await refreshAppliedSession();
      } catch (error) {
        clearSessionState();
        throw error;
      }
    }

    if (sessionStatusRef.current !== "ready") {
      throw new Error("Sign in required");
    }

    return sessionCredential();
  };

  const runAuthenticated = async <T,>(
    operation: (session: AccessSession) => Promise<T>
  ) => {
    await ensureSession();
    return runWithTokenRefresh(currentAccessSession(), operation);
  };

  const runApiRequest = async <T,>(
    operation: (sessionToken: string) => Promise<T>
  ) => runAuthenticated((session) => operation(session.accessToken));

  useEffect(() => {
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    void restoreSession();
  }, []);

  const authenticate = async (
    mode: "login" | "register",
    email: string,
    password: string
  ) => {
    const requestId = ++sessionRequestIdRef.current;

    try {
      if (mode === "register") {
        const pendingVerification = await registerAccount(apiBaseUrl, {
          email,
          password
        });
        clearSessionState();
        return { verificationEmail: pendingVerification.email };
      }

      const session = await login(apiBaseUrl, {
        email,
        password
      });
      if (requestId !== sessionRequestIdRef.current) {
        throw new Error("Authentication request was superseded");
      }

      applySession(session);
      await refreshOrganizationState(session);
      await refreshSessions(session);
      const config = await fetchSessionInferenceConfig(session);
      if (requestId === sessionRequestIdRef.current) {
        setInferenceConfig(config);
      }
      return {};
    } catch (error) {
      if (requestId === sessionRequestIdRef.current) {
        clearSessionState();
      }
      throw error instanceof Error
        ? error
        : new Error(mode === "register" ? "Unable to register" : "Unable to sign in");
    }
  };

  const signOut = async () => {
    sessionRequestIdRef.current += 1;
    const token = sessionCredential();
    clearSessionState();
    replaceRoute("/sign-in");

    await logout(apiBaseUrl, token, {}).catch(() => undefined);
  };

  const loadSessionData = async (accessSession: AccessSession) => {
    applySession(accessSession);
    await refreshOrganizationState(accessSession);
    await refreshSessions(accessSession);
    const config = await fetchSessionInferenceConfig(accessSession);
    setInferenceConfig(config);
  };

  const refreshFromClientEvent = () => {
    clientEventRefreshRef.current ??= (async () => {
      try {
        const session = await refreshAppliedSession();
        await loadSessionData(session);
      } catch {
        clearSessionState();
      } finally {
        clientEventRefreshRef.current = undefined;
      }
    })();

    return clientEventRefreshRef.current;
  };

  const connectClientEventStream = async (
    accessSession: AccessSession,
    signal: AbortSignal
  ) => {
    while (!signal.aborted) {
      try {
        const response = await openClientEvents(
          apiBaseUrl,
          accessSession.accessToken,
          signal
        );

        if (response.status === 401) {
          await refreshFromClientEvent();
          return;
        }

        if (!response.ok || !response.body) {
          throw new Error(`Client events failed with ${response.status}`);
        }

        await readClientEventStream(response, signal, async (event) => {
          if (event.type === "auth.refresh_required") {
            await refreshFromClientEvent();
          }
        });
      } catch (error) {
        if (signal.aborted) {
          return;
        }
      }

      await abortableDelay(1000, signal);
    }
  };

  const switchActiveOrganization = async (organizationId: string) => {
    setOrganizationError("");

    try {
      const session = await runAuthenticated((current) =>
        switchOrganization(apiBaseUrl, current.accessToken, {
          organizationId
        })
      );
      await loadSessionData(session);
      return session;
    } catch (error) {
      setOrganizationError(
        error instanceof Error ? error.message : "Unable to switch organization"
      );
      throw error;
    }
  };

  const createNewOrganization = async (name: string) => {
    setOrganizationError("");

    try {
      const session = await runAuthenticated((current) =>
        createOrganization(apiBaseUrl, current.accessToken, { name })
      );
      await loadSessionData(session);
      return session;
    } catch (error) {
      setOrganizationError(
        error instanceof Error ? error.message : "Unable to create organization"
      );
      throw error;
    }
  };

  const deleteActiveOrganization = async () => {
    setOrganizationError("");

    try {
      const result = await runAuthenticated((current) =>
        deleteCurrentOrganization(apiBaseUrl, current.accessToken, {})
      );
      await loadSessionData(result.nextSession);
      return result;
    } catch (error) {
      setOrganizationError(
        error instanceof Error ? error.message : "Unable to delete organization"
      );
      throw error;
    }
  };

  const inviteOrganizationMember = async (
    email: string,
    role: UserRole,
    expiresInDays?: number
  ) => {
    setOrganizationError("");

    try {
      await runAuthenticated((session) =>
        createOrganizationInvite(apiBaseUrl, session.accessToken, {
          email,
          role,
          expiresInDays
        })
      );
      const invites = await runAuthenticated((session) =>
        listOrganizationInvites(apiBaseUrl, session.accessToken)
      );
      setOrganizationInvites(invites.invites);
    } catch (error) {
      setOrganizationError(
        error instanceof Error ? error.message : "Unable to create invite"
      );
      throw error;
    }
  };

  const respondToInvite = async (
    token: string,
    response: "accepted" | "declined"
  ) => {
    const result = await runAuthenticated((session) =>
      respondToOrganizationInvite(apiBaseUrl, session.accessToken, {
        token,
        response
      })
    );

    if (response === "accepted") {
      await switchActiveOrganization(result.organization.id);
    }

    return result;
  };

  const setOrganizationMemberRole = async (
    membershipId: string,
    role: UserRole
  ) => {
    setOrganizationError("");

    try {
      const members = await runAuthenticated((session) =>
        updateOrganizationMemberRole(apiBaseUrl, session.accessToken, {
          membershipId,
          role
        })
      );
      setOrganizationMembers(members.members);
    } catch (error) {
      setOrganizationError(
        error instanceof Error ? error.message : "Unable to update member role"
      );
    }
  };

  const removeMemberFromOrganization = async (membershipId: string) => {
    setOrganizationError("");

    try {
      const members = await runAuthenticated((session) =>
        removeOrganizationMember(apiBaseUrl, session.accessToken, {
          membershipId
        })
      );
      setOrganizationMembers(members.members);
    } catch (error) {
      setOrganizationError(
        error instanceof Error ? error.message : "Unable to remove member"
      );
    }
  };

  const addInferenceProvider = async (request: AddInferenceProviderRequest) => {
    setInferenceProviderError("");
    setIsAddingInferenceProvider(true);

    try {
      await runAuthenticated((session) =>
        createInferenceProvider(apiBaseUrl, session.accessToken, request)
      );
      const config = await runAuthenticated((session) =>
        fetchInferenceConfig(apiBaseUrl, session.accessToken)
      );
      applyInferenceConfig(config);
    } catch (error) {
      setInferenceProviderError(
        inferenceProviderErrorMessage(error, "Unable to add provider. Try again.")
      );
      throw error;
    } finally {
      setIsAddingInferenceProvider(false);
    }
  };

  const refreshProviderModels = async (providerId: string) => {
    setInferenceProviderError("");
    setRefreshingInferenceProviderId(providerId);

    try {
      const config = await runAuthenticated((session) =>
        refreshInferenceProviderModels(apiBaseUrl, session.accessToken, {
          providerId
        })
      );
      applyInferenceConfig(config);
    } catch (error) {
      setInferenceProviderError(
        inferenceProviderErrorMessage(
          error,
          "Unable to refresh provider models. Try again."
        )
      );
    } finally {
      setRefreshingInferenceProviderId("");
    }
  };

  const setInferenceProviderEnabled = async (
    providerId: string,
    enabled: boolean
  ) => {
    setInferenceProviderError("");

    try {
      const config = await runAuthenticated((session) =>
        updateInferenceProvider(apiBaseUrl, session.accessToken, {
          providerId,
          enabled
        })
      );
      applyInferenceConfig(config);
    } catch (error) {
      setInferenceProviderError(
        inferenceProviderErrorMessage(error, "Unable to update provider.")
      );
    }
  };

  const setInferenceModelEnabled = async (
    providerId: string,
    modelId: string,
    enabled: boolean
  ) => {
    setInferenceProviderError("");

    try {
      const config = await runAuthenticated((session) =>
        updateInferenceModel(apiBaseUrl, session.accessToken, {
          providerId,
          modelId,
          enabled
        })
      );
      applyInferenceConfig(config);
    } catch (error) {
      setInferenceProviderError(
        inferenceProviderErrorMessage(error, "Unable to update model.")
      );
    }
  };

  const removeInferenceProvider = async (providerId: string) => {
    setInferenceProviderError("");

    try {
      const config = await runAuthenticated((session) =>
        deleteInferenceProvider(apiBaseUrl, session.accessToken, {
          providerId
        })
      );
      applyInferenceConfig(config);
    } catch (error) {
      setInferenceProviderError(
        inferenceProviderErrorMessage(error, "Unable to delete provider.")
      );
    }
  };

  const loadProject = (projectId: string) =>
    runAuthenticated((session) =>
      fetchProjectById(apiBaseUrl, projectId, session.accessToken)
    );

  const createUserProject = async (name: string) => {
    const project = await runAuthenticated((session) =>
      createProject(apiBaseUrl, session.accessToken, { name })
    );
    setProjects((current) => [project, ...current]);
    return project;
  };

  const updateUserProject = async (
    projectId: string,
    update: {
      name?: string;
      instructions?: string;
      memory?: string;
      pinned?: boolean;
    }
  ) => {
    const project = await runAuthenticated((session) =>
      updateProject(apiBaseUrl, projectId, session.accessToken, update)
    );
    setProjects((current) =>
      current.map((item) => (item.id === project.id ? project : item))
    );
    return project;
  };

  const deleteUserProject = async (projectId: string) => {
    await runAuthenticated((session) =>
      deleteProject(apiBaseUrl, projectId, session.accessToken, {})
    );
    setProjects((current) => current.filter((item) => item.id !== projectId));
    setSessions((current) =>
      current.map((item) =>
        item.projectId === projectId ? { ...item, projectId: null } : item
      )
    );
  };

  const addUserProjectContext = async (
    projectId: string,
    context: { filename: string; mediaType: string; content: string }
  ) => {
    await runAuthenticated((session) =>
      addProjectContext(
        apiBaseUrl,
        projectId,
        session.accessToken,
        context
      )
    );
    return loadProject(projectId);
  };

  const deleteUserProjectContext = async (
    projectId: string,
    contextId: string
  ) => {
    const project = await runAuthenticated((session) =>
      deleteProjectContext(
        apiBaseUrl,
        projectId,
        contextId,
        session.accessToken,
        {}
      )
    );
    setProjects((current) =>
      current.map((item) => (item.id === project.id ? project : item))
    );
    return project;
  };

  const resetChatSession = () => {
    chatSessionLoadRequestIdRef.current += 1;
    setActiveChatSession(undefined);
    setActiveChatSessionId(undefined);
    activeChatSessionIdRef.current = undefined;
    loadingChatSessionIdRef.current = undefined;
    setChatSessionKey((current) => current + 1);
  };

  const selectChatSession = async (sessionId: string) => {
    const requestId = ++chatSessionLoadRequestIdRef.current;
    setActiveChatSessionId(sessionId);
    activeChatSessionIdRef.current = sessionId;

    try {
      const session = await runAuthenticated((session) =>
        fetchSessionById(apiBaseUrl, sessionId, session.accessToken)
      );

      if (requestId !== chatSessionLoadRequestIdRef.current) {
        return;
      }

      setActiveChatSession((current) =>
        preferNewestSessionSnapshot(current, session)
      );
      setChatSessionKey((current) => current + 1);
    } catch (error) {
      if (requestId !== chatSessionLoadRequestIdRef.current) {
        return;
      }

      setActiveChatSession(undefined);
      setActiveChatSessionId(undefined);
      activeChatSessionIdRef.current = undefined;
      await refreshSessions().catch(() => undefined);
      throw error;
    }
  };

  const createChatSession = async (request: {
    title: string;
    projectId?: string | null;
  }) => {
    const summary = await runAuthenticated((session) =>
      createSession(apiBaseUrl, session.accessToken, {
        title: request.title,
        agentId: builtInAgentIds.chat,
        projectId: request.projectId
      })
    );

    setActiveChatSessionId(summary.id);
    activeChatSessionIdRef.current = summary.id;
    setActiveChatSession({
      ...summary,
      messages: [],
      stateSnapshots: []
    });
    setSessions((current) => [
      summary,
      ...current.filter((session) => session.id !== summary.id)
    ]);
    const chatRoute = routes.find((route) => route.href === "/chat");
    if (chatRoute) {
      replaceRoute(sessionRouteHref(chatRoute, summary.id));
    }
    return summary.id;
  };

  const appendChatSessionMessage = async (
    sessionId: string,
    message: {
      role: "user" | "assistant";
      content: string;
      metadata?: unknown;
    }
  ) => {
    const appendedMessage = await runAuthenticated((session) =>
      appendSessionMessage(apiBaseUrl, sessionId, session.accessToken, message)
    );
    setActiveChatSession((current) =>
      appendSessionMessageSnapshot(current, sessionId, appendedMessage)
    );
    setChatSessionKey((current) => current + 1);
    await refreshSessions().catch(() => undefined);
    return appendedMessage.id;
  };

  const updateChatSession = async (
    sessionId: string,
    update: { title?: string; projectId?: string | null; pinned?: boolean }
  ) => {
    const summary = await runAuthenticated((session) =>
      updateSession(apiBaseUrl, sessionId, session.accessToken, update)
    );

    setSessions((current) =>
      current.map((session) => (session.id === summary.id ? summary : session))
    );
    setActiveChatSession((current) =>
      current && current.id === summary.id ? { ...current, ...summary } : current
    );
    return summary;
  };

  const updateChatSessionTitle = async (sessionId: string, title: string) => {
    await updateChatSession(sessionId, { title });
  };

  const truncateChatSession = async (
    sessionId: string,
    afterMessageId: string | null
  ) => {
    const truncated = await runAuthenticated((session) =>
      truncateSession(apiBaseUrl, sessionId, session.accessToken, {
        afterMessageId
      })
    );
    setActiveChatSession(truncated);
    setSessions((current) => {
      const summary: SessionSummary = {
        id: truncated.id,
        organizationId: truncated.organizationId,
        ownerUserId: truncated.ownerUserId,
        title: truncated.title,
        agentId: truncated.agentId,
        projectId: truncated.projectId,
        pinnedAt: truncated.pinnedAt,
        stateBytes: truncated.stateBytes,
        version: truncated.version,
        createdAt: truncated.createdAt,
        updatedAt: truncated.updatedAt,
        archivedAt: truncated.archivedAt
      };
      return [summary, ...current.filter((item) => item.id !== sessionId)];
    });
    setChatSessionKey((current) => current + 1);
    return truncated;
  };

  const appendChatSessionState = async (
    sessionId: string,
    request: { kind: string; state: unknown }
  ) => {
    const snapshot = await runAuthenticated((session) =>
      appendSessionState(apiBaseUrl, sessionId, session.accessToken, request)
    );
    setActiveChatSession((current) =>
      appendSessionStateSnapshot(current, sessionId, snapshot)
    );
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              stateBytes: session.stateBytes + snapshot.byteSize,
              version: session.version + 1,
              updatedAt: snapshot.createdAt
            }
          : session
      )
    );
    return snapshot;
  };

  const recordChatMessageFeedback = async (
    sessionId: string,
    messageId: string,
    sentiment: "up" | "down"
  ) => {
    await appendChatSessionState(sessionId, {
      kind: "message_feedback",
      state: {
        messageId,
        sentiment,
        recordedAt: new Date().toISOString()
      }
    });
  };

  const recordChatModelSelection = async (
    sessionId: string,
    modelSelection: string
  ) => {
    await appendChatSessionState(
      sessionId,
      chatModelSelectionState(modelSelection)
    );
  };

  const archiveChatSession = async (sessionId: string) => {
    await runAuthenticated((session) =>
      archiveSession(apiBaseUrl, sessionId, session.accessToken, {})
    );
    setSessions((current) =>
      current.filter((session) => session.id !== sessionId)
    );

    if (activeChatSessionId === sessionId) {
      resetChatSession();
    }
    if (chatSessionMatch?.params.sessionId === sessionId) {
      replaceRoute("/chat");
    }
  };

  const syncChatSessionRoute = async (sessionId: string) => {
    if (loadingChatSessionIdRef.current === sessionId) {
      return;
    }

    loadingChatSessionIdRef.current = sessionId;

    try {
      await selectChatSession(sessionId);
    } catch {
      resetChatSession();
      replaceRoute("/chat");
    } finally {
      if (loadingChatSessionIdRef.current === sessionId) {
        loadingChatSessionIdRef.current = undefined;
      }
    }
  };

  useEffect(() => {
    if (sessionStatus !== "ready") {
      return;
    }

    const sessionId = chatSessionMatch?.params.sessionId;
    if (!sessionId) {
      if (path === "/chat" && activeChatSessionId) {
        resetChatSession();
      }
      return;
    }

    // A newly-created session is selected optimistically before its first turn is
    // fully persisted. Fetching it here can replace the in-flight transcript
    // with a stale server copy when the stream completes.
    if (activeChatSessionId === sessionId) {
      return;
    }

    void syncChatSessionRoute(sessionId);
  }, [sessionStatus, chatSessionMatch?.params.sessionId, activeChatSessionId, path]);

  useEffect(() => {
    if (
      sessionStatus !== "ready" ||
      !sessionClaims ||
      !sessionToken ||
      !sessionTokenExpiresAt
    ) {
      return;
    }

    const controller = new AbortController();
    void connectClientEventStream(currentAccessSession(), controller.signal);
    return () => controller.abort();
  }, [sessionStatus, sessionToken, sessionTokenExpiresAt]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleSystemThemeChange = () => setSystemTheme(getSystemTheme());
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  return {
    apiBaseUrl,
    sessionStatus,
    isAuthenticated,
    hasActiveOrganization,
    sessionClaims,
    displayName,
    resolvedDisplayName,
    organizationName,
    resolvedOrganizationName,
    appearance,
    resolvedTheme,
    modelDefaults,
    enabledInferenceProviders,
    organizations,
    organizationMembers,
    organizationInvites,
    sessions,
    projects,
    activeChatSession,
    activeChatSessionId,
    chatSessionKey,
    activeOrganizationId,
    membershipRole,
    organizationError,
    inferenceConfig,
    inferenceProviderError,
    isAddingInferenceProvider,
    refreshingInferenceProviderId,
    runApiRequest,
    authenticate,
    signOut,
    ensureSession,
    setAppearance,
    setDisplayName,
    setOrganizationName,
    switchActiveOrganization,
    createNewOrganization,
    deleteActiveOrganization,
    inviteOrganizationMember,
    respondToInvite,
    setOrganizationMemberRole,
    removeMemberFromOrganization,
    addInferenceProvider,
    setInferenceProviderEnabled,
    refreshProviderModels,
    setInferenceModelEnabled,
    removeInferenceProvider,
    setModelDefault,
    loadProject,
    createUserProject,
    updateUserProject,
    deleteUserProject,
    addUserProjectContext,
    deleteUserProjectContext,
    resetChatSession,
    createChatSession,
    appendChatSessionMessage,
    truncateChatSession,
    updateChatSession,
    updateChatSessionTitle,
    recordChatMessageFeedback,
    recordChatModelSelection,
    archiveChatSession
  };
}

export type AppContextValue = ReturnType<typeof useAppController>;

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const value = useAppController();
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within AppProvider");
  }
  return context;
}
