import { describe, expect, test } from "bun:test";
import {
  titleFromContent
} from "../apps/lush/src/lib/chat-stream";

describe("app chat stream helpers", () => {
  test("builds a bounded provisional title", () => {
    expect(titleFromContent("  Design   the session model ")).toBe(
      "Design the session model"
    );
    expect(titleFromContent("x".repeat(100))).toHaveLength(80);
  });
});
