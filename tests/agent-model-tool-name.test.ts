import { describe, expect, test } from "bun:test";
import {
  allocateModelToolName,
  modelToolName,
  modelToolNameMaxLength
} from "../services/agent/src/model-tool-name";

describe("agent model tool names", () => {
  test("sanitizes connector names to the provider-portable contract", () => {
    expect(modelToolName("pets.api__pets.get/v2")).toBe("pets_api__pets_get_v2");
    expect(modelToolName("🔎")).toBe("tool");
    expect(modelToolName("x".repeat(100))).toHaveLength(modelToolNameMaxLength);
    expect(modelToolName("pets.get")).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  test("resolves post-sanitization collisions within the length bound", () => {
    const used = new Set<string>();
    const first = allocateModelToolName("pets.get", used);
    const second = allocateModelToolName("pets/get", used);
    const third = allocateModelToolName("pets get", used);

    expect([first, second, third]).toEqual(["pets_get", "pets_get_2", "pets_get_3"]);
    expect(new Set([first, second, third]).size).toBe(3);
    expect([first, second, third].every((name) => name.length <= 64)).toBe(true);
  });
});
