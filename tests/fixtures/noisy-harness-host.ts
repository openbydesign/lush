import { writeSync } from "node:fs";

// Drain the start frame, then exceed a typical OS pipe buffer synchronously.
// If the parent leaves stderr as an unread pipe, this write deadlocks.
for await (const _chunk of process.stdin as AsyncIterable<Buffer>) {
  // Input contents are immaterial to this transport-level regression fixture.
}
writeSync(2, "x".repeat(2 * 1024 * 1024));
process.stdout.write(`${JSON.stringify({ type: "end", state: "completed" })}\n`);
