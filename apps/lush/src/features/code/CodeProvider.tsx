import type {
  CodeSession,
  CodeSessionDraft,
  EventPage,
  CodeSessionSummary,
  CodeSidecarConnection,
  CodeReview,
  HarnessInstallation,
  RepositoryInspection
} from "@lush/code";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  applyCodeSessionEventPage,
  createCodeSessionPoll
} from "../../lib/code-session-poll";

type CodeAvailability = "loading" | "ready" | "unavailable" | "error";

type CodeContextValue = {
  availability: CodeAvailability;
  error: string;
  harnesses: HarnessInstallation[];
  sessions: CodeSessionSummary[];
  activeSession?: CodeSession;
  inspectRepository(path: string): Promise<RepositoryInspection>;
  chooseRepository(): Promise<string | undefined>;
  startSession(draft: CodeSessionDraft, input: string): Promise<CodeSession>;
  selectSession(id?: string): Promise<void>;
  sendInput(input: string): Promise<void>;
  interrupt(): Promise<void>;
  archiveSession(id: string): Promise<void>;
  openWorkspace(target: "finder" | "terminal" | "editor"): Promise<void>;
  fetchReview(revision?: string, comparisonRef?: string): Promise<CodeReview>;
  refresh(): Promise<void>;
};

const CodeContext = createContext<CodeContextValue | undefined>(undefined);

export function CodeProvider({ children }: { children: ReactNode }) {
  const [availability, setAvailability] = useState<CodeAvailability>("loading");
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<CodeSidecarConnection>();
  const [harnesses, setHarnesses] = useState<HarnessInstallation[]>([]);
  const [sessions, setSessions] = useState<CodeSessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<CodeSession>();
  const activeSessionIdRef = useRef<string | undefined>(undefined);

  const request = useCallback(async <Result,>(path: string, init?: RequestInit) => {
    if (!connection) throw new Error("The local Code sidecar is unavailable");
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
        ...init?.headers
      }
    });
    const payload = await response.json() as Result | { error?: string };
    if (!response.ok) {
      const errorMessage = payload !== null && typeof payload === "object" && "error" in payload
        ? payload.error
        : undefined;
      throw new Error(typeof errorMessage === "string" ? errorMessage : `Code sidecar returned ${response.status}`);
    }
    return payload as Result;
  }, [connection]);

  const refresh = useCallback(async () => {
    if (!connection) return;
    const [nextHarnesses, nextSessions] = await Promise.all([
      request<HarnessInstallation[]>("/v1/harnesses"),
      request<CodeSessionSummary[]>("/v1/sessions")
    ]);
    setHarnesses(nextHarnesses);
    setSessions(nextSessions);
  }, [connection, request]);

  const selectSession = useCallback(async (id?: string) => {
    activeSessionIdRef.current = id;
    if (!id) {
      setActiveSession(undefined);
      return;
    }
    const session = await request<CodeSession>(`/v1/sessions/${id}`);
    if (activeSessionIdRef.current === id) setActiveSession(session);
  }, [request]);

  useEffect(() => {
    if (!isTauri()) {
      setAvailability("unavailable");
      setError("Local Code sessions are available in the Lush desktop app.");
      return;
    }
    void invoke<CodeSidecarConnection>("code_sidecar_connection")
      .then((nextConnection) => {
        setConnection(nextConnection);
        setAvailability("ready");
      })
      .catch((reason) => {
        setAvailability("error");
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    if (!connection) return;
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [connection, refresh]);

  useEffect(() => {
    if (!connection || !activeSession?.id || activeSession.status !== "running") return;
    const id = activeSession.id;
    const poll = createCodeSessionPoll({
      initialCursor: activeSession.events.at(-1)?.sequence ?? 0,
      request: (cursor) => request<EventPage>(`/v1/sessions/${id}/events?after=${cursor}`),
      update: (page) => {
        setActiveSession((current) => applyCodeSessionEventPage(current, id, page));
        if (page.status !== "running") void refresh();
      },
      onError: (reason) => setError(reason instanceof Error ? reason.message : String(reason))
    });
    const timer = window.setInterval(() => { void poll.tick(); }, 500);
    return () => {
      poll.stop();
      window.clearInterval(timer);
    };
  }, [activeSession?.id, activeSession?.status, connection, refresh, request]);

  const value = useMemo<CodeContextValue>(() => ({
    availability,
    error,
    harnesses,
    sessions,
    activeSession,
    inspectRepository: (path) => request<RepositoryInspection>("/v1/repositories/inspect", {
      method: "POST",
      body: JSON.stringify({ path })
    }),
    async chooseRepository() {
      if (!isTauri()) return undefined;
      const selected = await open({ directory: true, multiple: false, title: "Choose a Git repository" });
      return typeof selected === "string" ? selected : undefined;
    },
    async startSession(draft, input) {
      const session = await request<CodeSession>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ draft, input })
      });
      activeSessionIdRef.current = session.id;
      setActiveSession(session);
      await refresh();
      return session;
    },
    selectSession,
    async sendInput(input) {
      if (!activeSessionIdRef.current) throw new Error("No Code session is selected");
      const session = await request<CodeSession>(`/v1/sessions/${activeSessionIdRef.current}/messages`, {
        method: "POST",
        body: JSON.stringify({ input })
      });
      setActiveSession(session);
    },
    async interrupt() {
      if (!activeSessionIdRef.current) return;
      await request<unknown>(`/v1/sessions/${activeSessionIdRef.current}/interrupt`, { method: "POST", body: "{}" });
    },
    async archiveSession(id) {
      await request<unknown>(`/v1/sessions/${id}/archive`, { method: "POST", body: "{}" });
      if (activeSessionIdRef.current === id) {
        activeSessionIdRef.current = undefined;
        setActiveSession(undefined);
      }
      await refresh();
    },
    async openWorkspace(target) {
      if (!activeSessionIdRef.current) throw new Error("No Code session is selected");
      await request<unknown>(`/v1/sessions/${activeSessionIdRef.current}/open`, {
        method: "POST",
        body: JSON.stringify({ target })
      });
    },
    async fetchReview(revision = "net", comparisonRef) {
      if (!activeSessionIdRef.current) throw new Error("No Code session is selected");
      const search = new URLSearchParams({ revision });
      if (comparisonRef) search.set("comparisonRef", comparisonRef);
      return request<CodeReview>(
        `/v1/sessions/${activeSessionIdRef.current}/review?${search}`
      );
    },
    refresh
  }), [activeSession, availability, error, harnesses, refresh, request, selectSession, sessions]);

  return <CodeContext.Provider value={value}>{children}</CodeContext.Provider>;
}

export function useCode() {
  const context = useContext(CodeContext);
  if (!context) throw new Error("useCode must be used within CodeProvider");
  return context;
}
