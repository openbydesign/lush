import type { Kysely, Transaction } from "kysely";
import { getDb } from "@lush/db/client";
import type {
  Database,
  ProjectContextItemRow,
  ProjectRow,
  SessionMessageRole,
  SessionMessageRow,
  SessionStateSnapshotRow,
  SessionThreadRow
} from "@lush/db/schema";

export type SessionPrincipal = {
  userId: string;
  organizationId: string;
};

export type SessionSummary = {
  id: string;
  organizationId: string;
  ownerUserId: string;
  title: string;
  agentId: string;
  projectId: string | null;
  pinnedAt: string | null;
  stateBytes: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type SessionMessage = {
  id: string;
  sessionId: string;
  role: SessionMessageRole;
  content: string;
  metadata: unknown;
  tokenCount: number | null;
  byteSize: number;
  createdAt: string;
};

export type SessionStateSnapshot = {
  id: string;
  sessionId: string;
  kind: string;
  state: unknown;
  byteSize: number;
  createdAt: string;
};

export type Session = SessionSummary & {
  messages: SessionMessage[];
  stateSnapshots: SessionStateSnapshot[];
};

export type CreateSessionRequest = {
  title?: string;
  agentId: string;
  projectId?: string | null;
};

export type UpdateSessionRequest = {
  title?: string;
  projectId?: string | null;
  pinned?: boolean;
};

export type ProjectSummary = {
  id: string;
  organizationId: string;
  ownerUserId: string;
  name: string;
  instructions: string;
  memory: string;
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectContextItem = {
  id: string;
  projectId: string;
  filename: string;
  mediaType: string;
  content: string;
  byteSize: number;
  createdAt: string;
};

export type Project = ProjectSummary & {
  contextItems: ProjectContextItem[];
};

export type CreateProjectRequest = {
  name: string;
};

export type UpdateProjectRequest = {
  name?: string;
  instructions?: string;
  memory?: string;
  pinned?: boolean;
};

export type AddProjectContextRequest = {
  filename: string;
  mediaType: string;
  content: string;
};

export type AppendSessionMessageRequest = {
  role: SessionMessageRole;
  content: string;
  metadata?: unknown;
  tokenCount?: number | null;
};

export type AppendSessionStateRequest = {
  kind: string;
  state: unknown;
};

export type TruncateSessionRequest = {
  afterMessageId: string | null;
};

export type SessionSettings = {
  organizationId: string;
  retentionSeconds: number;
  createdAt: string;
  updatedAt: string;
};

export type UpdateSessionSettingsRequest = {
  retentionSeconds: number;
};

export const sessionSizeLimits = {
  maxThreadBytes: 10 * 1024 * 1024,
  maxMessageContentBytes: 256 * 1024,
  maxStateSnapshotBytes: 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxProjectContextItemBytes: 256 * 1024,
  maxProjectContextBytes: 1024 * 1024
} as const;

const messageRoles: SessionMessageRole[] = [
  "user",
  "assistant",
  "system",
  "tool"
];
const messageRoleSet = new Set<string>(messageRoles);
const textEncoder = new TextEncoder();

export class SessionStateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export async function listProjects(principal: SessionPrincipal) {
  const rows = await getDb()
    .selectFrom("projects")
    .selectAll()
    .where("organizationId", "=", principal.organizationId)
    .where("ownerUserId", "=", principal.userId)
    .orderBy("updatedAt", "desc")
    .execute();

  return { projects: rows.map(toProjectSummary) };
}

export async function createProject(
  principal: SessionPrincipal,
  request: unknown
) {
  const body = normalizeCreateProjectRequest(request);
  const db = getDb();
  const now = new Date();
  const project = await db
    .insertInto("projects")
    .values({
      organizationId: principal.organizationId,
      ownerUserId: principal.userId,
      name: body.name,
      instructions: "",
      memory: "",
      pinnedAt: null,
      createdAt: now,
      updatedAt: now
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordSessionEvent(db, principal, {
    action: "project.created",
    targetId: project.id,
    targetType: "project",
    metadata: {}
  });

  return { ...toProjectSummary(project), contextItems: [] } satisfies Project;
}

export async function fetchProject(
  principal: SessionPrincipal,
  projectId: string
) {
  const db = getDb();
  const project = await loadOwnedProject(db, principal, projectId);
  if (!project) {
    throw new SessionStateError("project_not_found", "Project was not found", 404);
  }

  const contextItems = await db
    .selectFrom("projectContextItems")
    .selectAll()
    .where("projectId", "=", project.id)
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .execute();

  return {
    ...toProjectSummary(project),
    contextItems: contextItems.map(toProjectContextItem)
  } satisfies Project;
}

export async function updateProject(
  principal: SessionPrincipal,
  projectId: string,
  request: unknown
) {
  const body = normalizeUpdateProjectRequest(request);
  const db = getDb();
  const current = await loadOwnedProject(db, principal, projectId);
  if (!current) {
    throw new SessionStateError("project_not_found", "Project was not found", 404);
  }

  const now = new Date();
  const project = await db
    .updateTable("projects")
    .set({
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.instructions === undefined
        ? {}
        : { instructions: body.instructions }),
      ...(body.memory === undefined ? {} : { memory: body.memory }),
      ...(body.pinned === undefined
        ? {}
        : { pinnedAt: body.pinned ? current.pinnedAt ?? now : null }),
      updatedAt: now
    })
    .where("id", "=", current.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordSessionEvent(db, principal, {
    action: "project.updated",
    targetId: project.id,
    targetType: "project",
    metadata: { fields: Object.keys(body) }
  });

  return fetchProject(principal, project.id);
}

export async function deleteProject(
  principal: SessionPrincipal,
  projectId: string
) {
  const db = getDb();
  const project = await loadOwnedProject(db, principal, projectId);
  if (!project) {
    throw new SessionStateError("project_not_found", "Project was not found", 404);
  }

  await db.deleteFrom("projects").where("id", "=", project.id).execute();
  await recordSessionEvent(db, principal, {
    action: "project.deleted",
    targetId: project.id,
    targetType: "project",
    metadata: {}
  });
  return toProjectSummary(project);
}

export async function addProjectContext(
  principal: SessionPrincipal,
  projectId: string,
  request: unknown
) {
  const body = normalizeProjectContextRequest(request);
  const db = getDb();
  const project = await loadOwnedProject(db, principal, projectId);
  if (!project) {
    throw new SessionStateError("project_not_found", "Project was not found", 404);
  }

  const total = await db
    .selectFrom("projectContextItems")
    .select(({ fn }) => fn.sum<number>("byteSize").as("bytes"))
    .where("projectId", "=", project.id)
    .executeTakeFirst();
  if (Number(total?.bytes ?? 0) + body.byteSize > sessionSizeLimits.maxProjectContextBytes) {
    throw new SessionStateError(
      "project_context_too_large",
      "Project context exceeds the maximum total size"
    );
  }

  const item = await db
    .insertInto("projectContextItems")
    .values({
      projectId: project.id,
      organizationId: principal.organizationId,
      ownerUserId: principal.userId,
      filename: body.filename,
      mediaType: body.mediaType,
      content: body.content,
      byteSize: body.byteSize,
      createdAt: new Date()
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .updateTable("projects")
    .set({ updatedAt: new Date() })
    .where("id", "=", project.id)
    .execute();

  return toProjectContextItem(item);
}

export async function deleteProjectContext(
  principal: SessionPrincipal,
  projectId: string,
  contextId: string
) {
  const db = getDb();
  const project = await loadOwnedProject(db, principal, projectId);
  if (!project) {
    throw new SessionStateError("project_not_found", "Project was not found", 404);
  }

  const result = await db
    .deleteFrom("projectContextItems")
    .where("id", "=", contextId)
    .where("projectId", "=", project.id)
    .executeTakeFirst();
  if (Number(result.numDeletedRows) === 0) {
    throw new SessionStateError(
      "project_context_not_found",
      "Project context item was not found",
      404
    );
  }

  await db
    .updateTable("projects")
    .set({ updatedAt: new Date() })
    .where("id", "=", project.id)
    .execute();
  return fetchProject(principal, project.id);
}

export async function listSessions(principal: SessionPrincipal) {
  const db = getDb();
  const rows = await db
    .selectFrom("sessionThreads")
    .selectAll()
    .where("organizationId", "=", principal.organizationId)
    .where("ownerUserId", "=", principal.userId)
    .where("deleted", "=", false)
    .where("archivedAt", "is", null)
    .orderBy("updatedAt", "desc")
    .execute();

  return {
    sessions: rows.map(toThreadSummary)
  };
}

export async function createSession(
  principal: SessionPrincipal,
  request: unknown
) {
  const body = normalizeCreateThreadRequest(request);
  const db = getDb();
  if (body.projectId) {
    const project = await loadOwnedProject(db, principal, body.projectId);
    if (!project) {
      throw new SessionStateError("project_not_found", "Project was not found", 404);
    }
  }
  const now = new Date();
  const thread = await db
    .insertInto("sessionThreads")
    .values({
      organizationId: principal.organizationId,
      ownerUserId: principal.userId,
      title: body.title,
      agentId: body.agentId,
      projectId: body.projectId,
      pinnedAt: null,
      stateBytes: 0,
      version: 1,
      deleted: false,
      deletedAt: null,
      deleteAfter: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordSessionEvent(db, principal, {
    action: "session.thread_created",
    targetId: thread.id,
    metadata: {
      agentId: thread.agentId
    }
  });

  return toThreadSummary(thread);
}

export async function fetchSession(
  principal: SessionPrincipal,
  sessionId: string
) {
  const db = getDb();
  const thread = await loadOwnedThread(db, principal, sessionId);
  if (!thread) {
    throw new SessionStateError(
      "session_not_found",
      "Session was not found",
      404
    );
  }

  const [messages, snapshots] = await Promise.all([
    db
      .selectFrom("sessionMessages")
      .selectAll()
      .where("threadId", "=", thread.id)
      .where("supersededAt", "is", null)
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .execute(),
    db
      .selectFrom("sessionStateSnapshots")
      .selectAll()
      .where("threadId", "=", thread.id)
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .execute()
  ]);

  return {
    ...toThreadSummary(thread),
    messages: messages.map(toMessage),
    stateSnapshots: snapshots.map(toStateSnapshot)
  } satisfies Session;
}

export async function updateSession(
  principal: SessionPrincipal,
  sessionId: string,
  request: unknown
) {
  const body = normalizeUpdateThreadRequest(request);
  const db = getDb();
  const now = new Date();
  const thread = await db.transaction().execute(async (trx) => {
    const current = await loadOwnedThreadForUpdate(trx, principal, sessionId);
    if (!current) {
      throw new SessionStateError(
        "session_not_found",
        "Session was not found",
        404
      );
    }
    assertThreadCanAcceptWrite(current);

    if (body.projectId) {
      const project = await loadOwnedProject(trx, principal, body.projectId);
      if (!project) {
        throw new SessionStateError("project_not_found", "Project was not found", 404);
      }
    }

    const updates = {
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
      ...(body.pinned === undefined
        ? {}
        : { pinnedAt: body.pinned ? current.pinnedAt ?? now : null })
    };

    const updated = await trx
      .updateTable("sessionThreads")
      .set({
        ...updates,
        version: current.version + 1
      })
      .where("id", "=", current.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordSessionEvent(trx, principal, {
      action: "session.thread_updated",
      targetId: current.id,
      metadata: {
        fields: Object.keys(body)
      }
    });

    return updated;
  });

  return toThreadSummary(thread);
}

export async function appendSessionMessage(
  principal: SessionPrincipal,
  sessionId: string,
  request: unknown
) {
  const body = normalizeAppendMessageRequest(request);
  const db = getDb();

  return db.transaction().execute(async (trx) => {
    const thread = await loadOwnedThreadForUpdate(trx, principal, sessionId);
    if (!thread) {
      throw new SessionStateError(
        "session_not_found",
        "Session was not found",
        404
      );
    }

    assertThreadCanAcceptWrite(thread);
    assertThreadLimit(thread.stateBytes, body.byteSize);
    const now = new Date();
    const message = await trx
      .insertInto("sessionMessages")
      .values({
        threadId: thread.id,
        organizationId: principal.organizationId,
        authorUserId: body.role === "user" ? principal.userId : null,
        role: body.role,
        content: body.content,
        metadata: body.metadata,
        tokenCount: body.tokenCount,
        byteSize: body.byteSize,
        createdAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("sessionThreads")
      .set({
        stateBytes: thread.stateBytes + body.byteSize,
        updatedAt: now,
        version: thread.version + 1
      })
      .where("id", "=", thread.id)
      .execute();

    await recordSessionEvent(trx, principal, {
      action: "session.message_created",
      targetId: thread.id,
      metadata: {
        messageId: message.id,
        role: message.role,
        byteSize: message.byteSize
      }
    });

    return toMessage(message);
  });
}

export async function appendSessionState(
  principal: SessionPrincipal,
  sessionId: string,
  request: unknown
) {
  const body = normalizeAppendStateRequest(request);
  const db = getDb();

  return db.transaction().execute(async (trx) => {
    const thread = await loadOwnedThreadForUpdate(trx, principal, sessionId);
    if (!thread) {
      throw new SessionStateError(
        "session_not_found",
        "Session was not found",
        404
      );
    }

    assertThreadCanAcceptWrite(thread);
    assertThreadLimit(thread.stateBytes, body.byteSize);
    const now = new Date();
    const snapshot = await trx
      .insertInto("sessionStateSnapshots")
      .values({
        threadId: thread.id,
        organizationId: principal.organizationId,
        kind: body.kind,
        state: body.state,
        byteSize: body.byteSize,
        createdAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("sessionThreads")
      .set({
        stateBytes: thread.stateBytes + body.byteSize,
        updatedAt: now,
        version: thread.version + 1
      })
      .where("id", "=", thread.id)
      .execute();

    await recordSessionEvent(trx, principal, {
      action: "session.state_snapshot_created",
      targetId: thread.id,
      metadata: {
        snapshotId: snapshot.id,
        kind: snapshot.kind,
        byteSize: snapshot.byteSize
      }
    });

    return toStateSnapshot(snapshot);
  });
}

export async function truncateSession(
  principal: SessionPrincipal,
  sessionId: string,
  request: unknown
) {
  const body = normalizeTruncateSessionRequest(request);
  const db = getDb();

  return db.transaction().execute(async (trx) => {
    const thread = await loadOwnedThreadForUpdate(trx, principal, sessionId);
    if (!thread) {
      throw new SessionStateError(
        "session_not_found",
        "Session was not found",
        404
      );
    }
    assertThreadCanAcceptWrite(thread);

    const [messages, snapshots] = await Promise.all([
      trx
        .selectFrom("sessionMessages")
        .selectAll()
        .where("threadId", "=", thread.id)
        .where("supersededAt", "is", null)
        .orderBy("createdAt", "asc")
        .orderBy("id", "asc")
        .execute(),
      trx
        .selectFrom("sessionStateSnapshots")
        .selectAll()
        .where("threadId", "=", thread.id)
        .orderBy("createdAt", "asc")
        .orderBy("id", "asc")
        .execute()
    ]);

    const {
      retainedMessages,
      removedMessages,
      retainedSnapshots,
      removedSnapshots,
      removedBytes
    } = planSessionTruncation(messages, snapshots, body.afterMessageId);

    if (removedMessages.length > 0) {
      await trx
        .updateTable("sessionMessages")
        .set({ supersededAt: new Date() })
        .where("id", "in", removedMessages.map((message) => message.id))
        .execute();
    }
    if (removedSnapshots.length > 0) {
      await trx
        .deleteFrom("sessionStateSnapshots")
        .where("id", "in", removedSnapshots.map((snapshot) => snapshot.id))
        .execute();
    }

    const now = new Date();
    const updated = await trx
      .updateTable("sessionThreads")
      .set({
        stateBytes: Math.max(0, thread.stateBytes - removedBytes),
        updatedAt: now,
        version: thread.version + 1
      })
      .where("id", "=", thread.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordSessionEvent(trx, principal, {
      action: "session.thread_truncated",
      targetId: thread.id,
      metadata: {
        afterMessageId: body.afterMessageId,
        removedMessageCount: removedMessages.length,
        removedStateSnapshotCount: removedSnapshots.length,
        removedBytes
      }
    });

    return {
      ...toThreadSummary(updated),
      messages: retainedMessages.map(toMessage),
      stateSnapshots: retainedSnapshots.map(toStateSnapshot)
    } satisfies Session;
  });
}

export async function archiveSession(
  principal: SessionPrincipal,
  sessionId: string
) {
  const db = getDb();
  const now = new Date();
  const thread = await db.transaction().execute(async (trx) => {
    const current = await loadOwnedThreadForUpdate(trx, principal, sessionId);
    if (!current) {
      throw new SessionStateError(
        "session_not_found",
        "Session was not found",
        404
      );
    }

    const settings = await getSessionSettingsForOrganization(
      trx,
      principal.organizationId
    );
    const deleteAfter = new Date(
      now.getTime() + settings.retentionSeconds * 1000
    );
    const updated = await trx
      .updateTable("sessionThreads")
      .set({
        archivedAt: current.archivedAt ?? now,
        deleted: true,
        deletedAt: current.deletedAt ?? now,
        deleteAfter,
        updatedAt: now,
        version: current.version + 1
      })
      .where("id", "=", current.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordSessionEvent(trx, principal, {
      action: "session.thread_archived",
      targetId: current.id,
      metadata: {
        deleteAfter: deleteAfter.toISOString(),
        retentionSeconds: settings.retentionSeconds
      }
    });

    return updated;
  });

  await purgeDeletedSessions();
  return toThreadSummary(thread);
}

export async function fetchSessionSettings(principal: SessionPrincipal) {
  return getSessionSettingsForOrganization(getDb(), principal.organizationId);
}

export async function updateSessionSettings(
  principal: SessionPrincipal,
  request: unknown
) {
  const body = normalizeUpdateSettingsRequest(request);
  const db = getDb();
  const now = new Date();
  const settings = await db
    .insertInto("organizationSessionSettings")
    .values({
      organizationId: principal.organizationId,
      retentionSeconds: body.retentionSeconds,
      createdAt: now,
      updatedAt: now
    })
    .onConflict((oc) =>
      oc.column("organizationId").doUpdateSet({
        retentionSeconds: body.retentionSeconds,
        updatedAt: now
      })
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordSessionEvent(db, principal, {
    action: "session.settings_updated",
    targetId: principal.organizationId,
    targetType: "organization",
    metadata: {
      retentionSeconds: settings.retentionSeconds
    }
  });

  return toSessionSettings(settings);
}

export async function purgeDeletedSessions(now = new Date()) {
  const db = getDb();
  const rows = await db
    .selectFrom("sessionThreads")
    .select(["id", "organizationId", "ownerUserId"])
    .where("deleted", "=", true)
    .where("deleteAfter", "<=", now)
    .execute();

  if (rows.length === 0) {
    return { purged: 0 };
  }

  await db
    .deleteFrom("sessionThreads")
    .where(
      "id",
      "in",
      rows.map((row) => row.id)
    )
    .execute();

  for (const row of rows) {
    await recordSessionEvent(db, {
      organizationId: row.organizationId,
      userId: row.ownerUserId
    }, {
      action: "session.thread_purged",
      targetId: row.id,
      metadata: {}
    });
  }

  return { purged: rows.length };
}

export function messageByteSize(content: string, metadata: unknown = {}) {
  return byteLength(content) + jsonByteLength(metadata);
}

export function stateSnapshotByteSize(state: unknown) {
  return jsonByteLength(state);
}

export function jsonByteLength(value: unknown) {
  const serialized = JSON.stringify(value);
  return byteLength(serialized ?? "");
}

export function byteLength(value: string) {
  return textEncoder.encode(value).byteLength;
}

export function titleFromContent(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Untitled session";
  }

  return normalized.length > 80
    ? `${normalized.slice(0, 77).trimEnd()}...`
    : normalized;
}

export function planSessionTruncation<
  Message extends { id: string; byteSize: number },
  Snapshot extends { id: string; byteSize: number; state: unknown }
>(
  messages: Message[],
  snapshots: Snapshot[],
  afterMessageId: string | null
) {
  const boundaryIndex = afterMessageId === null
    ? -1
    : messages.findIndex((message) => message.id === afterMessageId);
  if (afterMessageId !== null && boundaryIndex < 0) {
    throw new SessionStateError(
      "session_message_not_found",
      "Session message was not found",
      404
    );
  }

  const retainedMessages = messages.slice(0, boundaryIndex + 1);
  const removedMessages = messages.slice(boundaryIndex + 1);
  const removedMessageIds = new Set(removedMessages.map((message) => message.id));
  const removedSnapshots = snapshots.filter((snapshot) =>
    snapshotReferencesMessage(snapshot, removedMessageIds)
  );
  const removedSnapshotIds = new Set(removedSnapshots.map((snapshot) => snapshot.id));
  const retainedSnapshots = snapshots.filter(
    (snapshot) => !removedSnapshotIds.has(snapshot.id)
  );
  const removedBytes = [...removedMessages, ...removedSnapshots].reduce(
    (total, entry) => total + entry.byteSize,
    0
  );

  return {
    retainedMessages,
    removedMessages,
    retainedSnapshots,
    removedSnapshots,
    removedBytes
  };
}

function normalizeCreateThreadRequest(
  request: unknown
): {
  title: string;
  agentId: string;
  projectId: string | null;
} {
  const candidate = objectRequest(request);
  const agentId = normalizeShortText(candidate.agentId, "agent_id", 160);
  const title =
    typeof candidate.title === "string" && candidate.title.trim()
      ? normalizeTitle(candidate.title)
      : "Untitled session";

  return {
    title,
    agentId,
    projectId:
      candidate.projectId === null || candidate.projectId === undefined
        ? null
        : normalizeShortText(candidate.projectId, "project_id", 160)
  };
}

function normalizeUpdateThreadRequest(
  request: unknown
): UpdateSessionRequest {
  const candidate = objectRequest(request);
  const update: UpdateSessionRequest = {};

  if ("title" in candidate) {
    update.title = normalizeTitle(candidate.title);
  }
  if ("projectId" in candidate) {
    update.projectId = candidate.projectId === null
      ? null
      : normalizeShortText(candidate.projectId, "project_id", 160);
  }
  if ("pinned" in candidate) {
    if (typeof candidate.pinned !== "boolean") {
      throw new SessionStateError(
        "invalid_session_pinned",
        "Pinned must be a boolean"
      );
    }
    update.pinned = candidate.pinned;
  }

  if (Object.keys(update).length === 0) {
    throw new SessionStateError(
      "invalid_session_update",
      "At least one session field is required"
    );
  }

  return update;
}

function normalizeCreateProjectRequest(request: unknown): CreateProjectRequest {
  const candidate = objectRequest(request);
  return { name: normalizeShortText(candidate.name, "project_name", 120) };
}

function normalizeUpdateProjectRequest(request: unknown): UpdateProjectRequest {
  const candidate = objectRequest(request);
  const update: UpdateProjectRequest = {};

  if ("name" in candidate) {
    update.name = normalizeShortText(candidate.name, "project_name", 120);
  }
  if ("instructions" in candidate) {
    update.instructions = normalizeLongText(
      candidate.instructions,
      "project_instructions",
      16 * 1024
    );
  }
  if ("memory" in candidate) {
    update.memory = normalizeLongText(
      candidate.memory,
      "project_memory",
      32 * 1024
    );
  }
  if ("pinned" in candidate) {
    if (typeof candidate.pinned !== "boolean") {
      throw new SessionStateError(
        "invalid_project_pinned",
        "Pinned must be a boolean"
      );
    }
    update.pinned = candidate.pinned;
  }

  if (Object.keys(update).length === 0) {
    throw new SessionStateError(
      "invalid_project_update",
      "At least one project field is required"
    );
  }
  return update;
}

function normalizeProjectContextRequest(
  request: unknown
): AddProjectContextRequest & { byteSize: number } {
  const candidate = objectRequest(request);
  const filename = normalizeShortText(
    candidate.filename,
    "project_context_filename",
    255
  );
  const mediaType = normalizeShortText(
    candidate.mediaType,
    "project_context_media_type",
    127
  );
  const content = normalizeLongText(
    candidate.content,
    "project_context_content",
    sessionSizeLimits.maxProjectContextItemBytes
  );
  if (!content) {
    throw new SessionStateError(
      "invalid_project_context_content",
      "Project context content is required"
    );
  }
  const byteSize = byteLength(content);

  if (byteSize > sessionSizeLimits.maxProjectContextItemBytes) {
    throw new SessionStateError(
      "project_context_item_too_large",
      "Project context item exceeds the maximum size"
    );
  }
  return { filename, mediaType, content, byteSize };
}

function normalizeAppendMessageRequest(
  request: unknown
): AppendSessionMessageRequest & { byteSize: number; metadata: unknown } {
  const candidate = objectRequest(request);
  const role = normalizeMessageRole(candidate.role);
  const content = typeof candidate.content === "string" ? candidate.content : "";
  const metadata =
    "metadata" in candidate && candidate.metadata !== undefined
      ? candidate.metadata
      : {};
  const metadataBytes = jsonByteLength(metadata);
  const contentBytes = byteLength(content);
  const tokenCount =
    typeof candidate.tokenCount === "number" && Number.isFinite(candidate.tokenCount)
      ? Math.max(0, Math.floor(candidate.tokenCount))
      : null;

  if (!content.trim()) {
    throw new SessionStateError(
      "invalid_session_message",
      "Message content is required"
    );
  }

  if (contentBytes > sessionSizeLimits.maxMessageContentBytes) {
    throw new SessionStateError(
      "session_message_too_large",
      "Session message exceeds the maximum message size"
    );
  }

  if (metadataBytes > sessionSizeLimits.maxMetadataBytes) {
    throw new SessionStateError(
      "session_metadata_too_large",
      "Session metadata exceeds the maximum metadata size"
    );
  }

  return {
    role,
    content,
    metadata,
    tokenCount,
    byteSize: contentBytes + metadataBytes
  };
}

function normalizeAppendStateRequest(
  request: unknown
): AppendSessionStateRequest & { byteSize: number } {
  const candidate = objectRequest(request);
  const kind = normalizeShortText(candidate.kind, "state_kind", 120);
  const state = candidate.state;
  if (state === undefined) {
    throw new SessionStateError(
      "invalid_session_state",
      "Session state is required"
    );
  }
  const byteSize = stateSnapshotByteSize(state);

  if (byteSize > sessionSizeLimits.maxStateSnapshotBytes) {
    throw new SessionStateError(
      "session_state_too_large",
      "Session state exceeds the maximum state snapshot size"
    );
  }

  return {
    kind,
    state,
    byteSize
  };
}

function normalizeTruncateSessionRequest(
  request: unknown
): TruncateSessionRequest {
  const candidate = objectRequest(request);
  if (!("afterMessageId" in candidate)) {
    throw new SessionStateError(
      "invalid_truncate_boundary",
      "A session message boundary is required"
    );
  }

  return {
    afterMessageId: candidate.afterMessageId === null
      ? null
      : normalizeShortText(candidate.afterMessageId, "message_id", 160)
  };
}

function normalizeUpdateSettingsRequest(
  request: unknown
): UpdateSessionSettingsRequest {
  const candidate = objectRequest(request);
  const retentionSeconds = candidate.retentionSeconds;

  if (
    typeof retentionSeconds !== "number" ||
    !Number.isFinite(retentionSeconds) ||
    retentionSeconds < 0
  ) {
    throw new SessionStateError(
      "invalid_retention_seconds",
      "Retention seconds must be zero or greater"
    );
  }

  return {
    retentionSeconds: Math.floor(retentionSeconds)
  };
}

function normalizeMessageRole(value: unknown): SessionMessageRole {
  if (isSessionMessageRole(value)) {
    return value;
  }

  throw new SessionStateError(
    "invalid_session_message_role",
    "Session message role is invalid"
  );
}

function isSessionMessageRole(value: unknown): value is SessionMessageRole {
  return typeof value === "string" && messageRoleSet.has(value);
}

function normalizeTitle(value: unknown) {
  return normalizeShortText(value, "session_title", 160);
}

function normalizeShortText(value: unknown, code: string, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new SessionStateError(`invalid_${code}`, "A non-empty value is required");
  }

  if (text.length > maxLength) {
    throw new SessionStateError(
      `invalid_${code}`,
      `Value must be ${maxLength} characters or fewer`
    );
  }

  return text;
}

function normalizeLongText(value: unknown, code: string, maxBytes: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (byteLength(text) > maxBytes) {
    throw new SessionStateError(
      `invalid_${code}`,
      `Value must be ${maxBytes} bytes or fewer`
    );
  }
  return text;
}

function objectRequest(request: unknown) {
  if (!request || typeof request !== "object") {
    throw new SessionStateError("invalid_request", "Invalid session request");
  }

  return request as Record<string, unknown>;
}

function assertThreadLimit(currentBytes: number, addedBytes: number) {
  if (currentBytes + addedBytes > sessionSizeLimits.maxThreadBytes) {
    throw new SessionStateError(
      "session_thread_limit_exceeded",
      "Session thread exceeds the maximum stored state size"
    );
  }
}

function assertThreadCanAcceptWrite(thread: SessionThreadRow) {
  if (thread.deleted) {
    throw new SessionStateError(
      "session_thread_deleted",
      "Session thread has been deleted",
      409
    );
  }

  if (thread.archivedAt) {
    throw new SessionStateError(
      "session_thread_archived",
      "Session thread has been archived",
      409
    );
  }
}

function snapshotReferencesMessage(
  snapshot: { state: unknown },
  messageIds: ReadonlySet<string>
) {
  if (!snapshot.state || typeof snapshot.state !== "object") return false;
  const messageId = (snapshot.state as { messageId?: unknown }).messageId;
  return typeof messageId === "string" && messageIds.has(messageId);
}

async function loadOwnedThread(
  db: Kysely<Database> | Transaction<Database>,
  principal: SessionPrincipal,
  threadId: string
) {
  return db
    .selectFrom("sessionThreads")
    .selectAll()
    .where("id", "=", threadId)
    .where("organizationId", "=", principal.organizationId)
    .where("ownerUserId", "=", principal.userId)
    .where("deleted", "=", false)
    .where("archivedAt", "is", null)
    .executeTakeFirst();
}

async function loadOwnedProject(
  db: Kysely<Database> | Transaction<Database>,
  principal: SessionPrincipal,
  projectId: string
) {
  return db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .where("organizationId", "=", principal.organizationId)
    .where("ownerUserId", "=", principal.userId)
    .executeTakeFirst();
}

async function loadOwnedThreadForUpdate(
  db: Transaction<Database>,
  principal: SessionPrincipal,
  threadId: string
) {
  return db
    .selectFrom("sessionThreads")
    .selectAll()
    .where("id", "=", threadId)
    .where("organizationId", "=", principal.organizationId)
    .where("ownerUserId", "=", principal.userId)
    .where("deleted", "=", false)
    .forUpdate()
    .executeTakeFirst();
}

async function getSessionSettingsForOrganization(
  db: Kysely<Database> | Transaction<Database>,
  organizationId: string
) {
  const existing = await db
    .selectFrom("organizationSessionSettings")
    .selectAll()
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();

  if (existing) {
    return toSessionSettings(existing);
  }

  const now = new Date();
  const created = await db
    .insertInto("organizationSessionSettings")
    .values({
      organizationId,
      retentionSeconds: 0,
      createdAt: now,
      updatedAt: now
    })
    .onConflict((oc) => oc.column("organizationId").doNothing())
    .returningAll()
    .executeTakeFirst();

  if (created) {
    return toSessionSettings(created);
  }

  const raced = await db
    .selectFrom("organizationSessionSettings")
    .selectAll()
    .where("organizationId", "=", organizationId)
    .executeTakeFirstOrThrow();
  return toSessionSettings(raced);
}

async function recordSessionEvent(
  db: Kysely<Database> | Transaction<Database>,
  principal: SessionPrincipal,
  event: {
    action: string;
    targetId: string;
    targetType?: string;
    metadata: Record<string, unknown>;
  }
) {
  await db
    .insertInto("auditEvents")
    .values({
      organizationId: principal.organizationId,
      userId: principal.userId,
      sessionId: null,
      action: event.action,
      targetType: event.targetType ?? "session_thread",
      targetId: event.targetId,
      metadata: event.metadata,
      createdAt: new Date()
    })
    .execute();
}

function toThreadSummary(thread: SessionThreadRow): SessionSummary {
  return {
    id: thread.id,
    organizationId: thread.organizationId,
    ownerUserId: thread.ownerUserId,
    title: thread.title,
    agentId: thread.agentId,
    projectId: thread.projectId,
    pinnedAt: thread.pinnedAt?.toISOString() ?? null,
    stateBytes: thread.stateBytes,
    version: thread.version,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    archivedAt: thread.archivedAt?.toISOString() ?? null
  };
}

function toProjectSummary(project: ProjectRow): ProjectSummary {
  return {
    id: project.id,
    organizationId: project.organizationId,
    ownerUserId: project.ownerUserId,
    name: project.name,
    instructions: project.instructions,
    memory: project.memory,
    pinnedAt: project.pinnedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
  };
}

function toProjectContextItem(item: ProjectContextItemRow): ProjectContextItem {
  return {
    id: item.id,
    projectId: item.projectId,
    filename: item.filename,
    mediaType: item.mediaType,
    content: item.content,
    byteSize: item.byteSize,
    createdAt: item.createdAt.toISOString()
  };
}

function toMessage(message: SessionMessageRow): SessionMessage {
  return {
    id: message.id,
    sessionId: message.threadId,
    role: message.role,
    content: message.content,
    metadata: message.metadata,
    tokenCount: message.tokenCount,
    byteSize: message.byteSize,
    createdAt: message.createdAt.toISOString()
  };
}

function toStateSnapshot(snapshot: SessionStateSnapshotRow): SessionStateSnapshot {
  return {
    id: snapshot.id,
    sessionId: snapshot.threadId,
    kind: snapshot.kind,
    state: snapshot.state,
    byteSize: snapshot.byteSize,
    createdAt: snapshot.createdAt.toISOString()
  };
}

function toSessionSettings(settings: {
  organizationId: string;
  retentionSeconds: number;
  createdAt: Date;
  updatedAt: Date;
}): SessionSettings {
  return {
    organizationId: settings.organizationId,
    retentionSeconds: settings.retentionSeconds,
    createdAt: settings.createdAt.toISOString(),
    updatedAt: settings.updatedAt.toISOString()
  };
}
