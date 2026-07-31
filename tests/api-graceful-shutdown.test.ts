import { describe, expect, test } from "bun:test";
import {
  registerGracefulShutdown,
  stopServerWithDeadline
} from "../services/api/src/graceful-shutdown";

const logger = {
  info() {},
  error() {}
};

describe("api graceful shutdown", () => {
  test("allows in-flight requests to finish before the deadline", async () => {
    const calls: boolean[] = [];
    const forced = await stopServerWithDeadline({
      async stop(closeActiveConnections = false) {
        calls.push(closeActiveConnections);
      }
    }, 20);

    await Bun.sleep(25);
    expect(forced).toBe(false);
    expect(calls).toEqual([false]);
  });

  test("force-closes long-lived streams at the deadline", async () => {
    const calls: boolean[] = [];
    const forced = await stopServerWithDeadline({
      stop(closeActiveConnections = false) {
        calls.push(closeActiveConnections);
        return closeActiveConnections ? Promise.resolve() : new Promise(() => {});
      }
    }, 5);

    expect(forced).toBe(true);
    expect(calls).toEqual([false, true]);
  });

  test("rejects invalid deadlines", async () => {
    await expect(stopServerWithDeadline({
      async stop() {}
    }, Number.NaN)).rejects.toThrow("shutdown grace");
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`force-stops on a repeated ${signal}`, async () => {
      const calls: boolean[] = [];
      const exits: number[] = [];
      let finishGracefulStop: (() => void) | undefined;
      const unregister = registerGracefulShutdown({
        stop(closeActiveConnections = false) {
          calls.push(closeActiveConnections);
          if (closeActiveConnections) {
            finishGracefulStop?.();
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            finishGracefulStop = resolve;
          });
        }
      }, logger, {
        graceMs: 1_000,
        exit(code) {
          exits.push(code);
        }
      });

      try {
        process.emit(signal);
        await Promise.resolve();
        expect(calls).toEqual([false]);

        process.emit(signal);
        await Bun.sleep(0);
        expect(calls).toEqual([false, true]);
        expect(exits).toEqual([0]);
      } finally {
        unregister();
      }
    });
  }
});
