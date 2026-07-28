type StoppableServer = {
  stop(closeActiveConnections?: boolean): Promise<void>;
};

type ShutdownLogger = {
  info(meta: Record<string, unknown>, message: string): void;
  error(meta: Record<string, unknown>, message: string): void;
};

export async function stopServerWithDeadline(
  server: StoppableServer,
  graceMs: number
) {
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error("shutdown grace must be a non-negative finite duration");
  }

  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const gracefulStop = Promise.resolve()
    .then(() => server.stop(false))
    .then(() => false);
  const forcedStop = new Promise<boolean>((resolve, reject) => {
    forceTimer = setTimeout(() => {
      server.stop(true).then(() => resolve(true), reject);
    }, graceMs);
    forceTimer.unref?.();
  });

  try {
    return await Promise.race([gracefulStop, forcedStop]);
  } finally {
    if (forceTimer) {
      clearTimeout(forceTimer);
    }
  }
}

export function registerGracefulShutdown(
  server: StoppableServer,
  logger: ShutdownLogger,
  options: {
    graceMs?: number;
    exit?: (code: number) => void;
  } = {}
) {
  const graceMs = options.graceMs ?? 25_000;
  const exit = options.exit ?? process.exit;
  let stopping = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) {
      void server.stop(true);
      return;
    }
    stopping = true;
    logger.info({ signal, graceMs }, "api shutdown started");

    void stopServerWithDeadline(server, graceMs).then(
      (forced) => {
        logger.info({ signal, forced }, "api shutdown complete");
        exit(0);
      },
      (error) => {
        logger.error({ signal, error }, "api shutdown failed");
        exit(1);
      }
    );
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
