import { describe, expect, test } from "bun:test";
import { stopServerWithDeadline } from "../services/api/src/graceful-shutdown";

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
});
