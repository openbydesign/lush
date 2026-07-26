import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCodeSidecar } from "../services/agent/src/code/server";

const sidecarEntry = path.join(import.meta.dir, "../services/agent/src/code/sidecar.ts");

/**
 * Launch the sidecar entrypoint the way the desktop shell does, and either wait
 * for its ready line or for it to give up.
 */
async function launchSidecar(options: { argv: string[]; stdin: string; stateDirectory: string }) {
  // Back stdin with a real file rather than a pipe: the entrypoint opens
  // /dev/stdin by name, and reopening an anonymous pipe whose writer has
  // already closed fails with ENXIO.
  const stdinFile = path.join(options.stateDirectory, "stdin");
  await writeFile(stdinFile, options.stdin);
  const stdin = openSync(stdinFile, "r");

  const child = spawn(process.execPath, ["run", sidecarEntry, `--state-dir=${options.stateDirectory}`, "--port=0", ...options.argv], {
    cwd: path.join(import.meta.dir, ".."),
    stdio: [stdin, "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

  return new Promise<{ started: boolean; stdout: string; stderr: string }>((resolve, reject) => {
    let settled = false;
    const finish = (started: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.kill("SIGKILL");
      // Node closes a descriptor handed to stdio once the child is spawned.
      try { closeSync(stdin); } catch {}
      resolve({ started, stdout, stderr });
    };
    // A successful launch prints one ready line and then stays up for signals.
    const poll = setInterval(() => { if (stdout.includes("\n")) finish(true); }, 25);
    const timer = setTimeout(() => finish(stdout.includes("\n")), 15_000);
    child.once("error", (error) => { if (!settled) { settled = true; clearInterval(poll); clearTimeout(timer); reject(error); } });
    child.once("exit", () => finish(stdout.includes("\n")));
  });
}

test("local Code sidecar requires its per-launch capability token", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "lush-code-state-"));
  const token = "a".repeat(64);
  const server = startCodeSidecar({ token, stateDirectory });
  const baseUrl = `http://${server.hostname}:${server.port}`;

  try {
    const unauthorized = await fetch(`${baseUrl}/v1/sessions`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual([]);
  } finally {
    server.stop(true);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("local Code sidecar takes its capability token from stdin", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "lush-code-state-"));
  try {
    const launch = await launchSidecar({ argv: [], stdin: "b".repeat(64), stateDirectory });
    expect(launch.started).toBe(true);
    expect(JSON.parse(launch.stdout.split("\n")[0]!)).toMatchObject({ type: "ready" });
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

test("local Code sidecar refuses a capability token passed on argv", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "lush-code-state-"));
  try {
    // argv is world-readable through the process table, so a token supplied
    // that way must not launch a server even though it is otherwise valid.
    const launch = await launchSidecar({ argv: [`--token=${"c".repeat(64)}`], stdin: "", stateDirectory });
    expect(launch.started).toBe(false);
    expect(launch.stdout).not.toContain("ready");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);
