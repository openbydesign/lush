import { describe, expect, test } from "bun:test";
import {
  NativeConnector,
  jsonResult,
  type NativeTool
} from "../services/tools/src/connectors/native";
import { defaultConnectorLimits } from "../services/tools/src/connectors/types";

const signal = () => new AbortController().signal;
const fixtureTool: NativeTool = {
  externalName: "fixture_echo",
  title: "Fixture echo",
  description: "Test-only native tool",
  inputSchema: { type: "object" },
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false
  },
  async handler(input) {
    return jsonResult(input);
  }
};

describe("NativeConnector", () => {
  test("ships no placeholder built-ins", async () => {
    expect(await new NativeConnector().discover(signal())).toEqual([]);
  });

  test("discovers registered tools without leaking handlers", async () => {
    const [tool] = await new NativeConnector([fixtureTool]).discover(signal());
    expect(tool?.externalName).toBe("fixture_echo");
    expect(tool?.annotations.readOnly).toBe(true);
    expect((tool as Record<string, unknown>).handler).toBeUndefined();
  });

  test("rejects discovery when it is already canceled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new NativeConnector([fixtureTool]).discover(controller.signal)).rejects.toMatchObject({
      name: "AbortError"
    });
  });

  test("invokes a registered native tool", async () => {
    const result = await new NativeConnector([fixtureTool]).invoke({
      externalName: "fixture_echo",
      input: { value: "hello" },
      limits: defaultConnectorLimits,
      signal: signal()
    });
    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({ value: "hello" });
  });

  test("rejects an unknown tool name", async () => {
    await expect(
      new NativeConnector([fixtureTool]).invoke({
        externalName: "not_a_tool",
        input: {},
        limits: defaultConnectorLimits,
        signal: signal()
      })
    ).rejects.toMatchObject({ code: "tool_not_found" });
  });
});
