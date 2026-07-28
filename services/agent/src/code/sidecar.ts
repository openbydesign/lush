import { homedir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { startCodeSidecar } from "./server";

const argumentsMap = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    return separator < 0 ? [argument, ""] : [argument.slice(0, separator), argument.slice(separator + 1)];
  })
);
const token = (await readFile("/dev/stdin", "utf8")).trim();
if (!token) throw new Error("A capability token is required on stdin");
const stateDirectory = argumentsMap.get("--state-dir") || path.join(homedir(), ".lush", "code", "sessions");
const port = Number(argumentsMap.get("--port") || 0);
const server = startCodeSidecar({ token, stateDirectory, port });

console.log(JSON.stringify({ type: "ready", baseUrl: `http://${server.hostname}:${server.port}` }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.shutdown().finally(() => {
      server.stop(true);
      process.exit(0);
    });
  });
}
