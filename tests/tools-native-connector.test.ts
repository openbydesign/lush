import { describe, expect, test } from "bun:test";
import { NativeConnector } from "../services/tools/src/connectors/native";
import { defaultConnectorLimits } from "../services/tools/src/connectors/types";

const signal = () => new AbortController().signal;

describe("NativeConnector", () => {
  test("discovers the built-in read-only tool without leaking the handler", async () => {
    const tools = await new NativeConnector().discover();
    const currentTime = tools.find((tool) => tool.externalName === "current_time");
    expect(currentTime).toBeDefined();
    expect(currentTime?.annotations.readOnly).toBe(true);
    expect(currentTime?.annotations.destructive).toBe(false);
    expect((currentTime as Record<string, unknown>).handler).toBeUndefined();
  });

  test("invokes current_time and returns a normalized JSON result", async () => {
    const result = await new NativeConnector().invoke({
      externalName: "current_time",
      input: { timeZone: "UTC" },
      limits: defaultConnectorLimits,
      signal: signal()
    });
    expect(result.isError).toBe(false);
    const data = result.structured as { iso: string; epochMs: number; timeZone: string };
    expect(data.timeZone).toBe("UTC");
    expect(typeof data.epochMs).toBe("number");
    expect(() => new Date(data.iso)).not.toThrow();
  });

  test("rejects an unknown time zone", async () => {
    await expect(
      new NativeConnector().invoke({
        externalName: "current_time",
        input: { timeZone: "Mars/Olympus_Mons" },
        limits: defaultConnectorLimits,
        signal: signal()
      })
    ).rejects.toMatchObject({ code: "invalid_time_zone" });
  });

  test("rejects an unknown tool name", async () => {
    await expect(
      new NativeConnector().invoke({
        externalName: "not_a_tool",
        input: {},
        limits: defaultConnectorLimits,
        signal: signal()
      })
    ).rejects.toMatchObject({ code: "tool_not_found" });
  });
});
