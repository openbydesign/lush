import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessCapabilities, HarnessEventInput, HarnessId, HarnessInstallation } from "@lush/code";
import { runCommand, spawnJsonLineProcess } from "../process";
import type { AdapterRun, AdapterRunOptions, HarnessLineParser } from "./types";

const knownLocations: Record<HarnessId, string[]> = {
  codex: [".local/bin/codex", ".bun/bin/codex"],
  "claude-code": [".local/bin/claude"],
  opencode: [".opencode/bin/opencode", ".local/bin/opencode"]
};

export async function probeHarness(options: {
  id: HarnessId;
  displayName: string;
  command: string;
  capabilities: HarnessCapabilities;
  probeArguments: string[];
  requiredHelpTokens: string[];
}): Promise<HarnessInstallation> {
  const executable = await discoverExecutable(options.id, options.command);
  if (!executable) {
    return {
      id: options.id,
      displayName: options.displayName,
      transport: "structured-cli",
      status: "missing",
      detail: `${options.command} was not found`,
      capabilities: options.capabilities
    };
  }

  try {
    const [versionOutput, helpOutput] = await Promise.all([
      runCommand([executable, "--version"], homedir()),
      runCommand([executable, ...options.probeArguments], homedir())
    ]);
    const missingTokens = validateHelpSurface(helpOutput, options.requiredHelpTokens);
    if (missingTokens.length > 0) {
      return {
        id: options.id,
        displayName: options.displayName,
        transport: "structured-cli",
        executable,
        version: parseVersion(versionOutput),
        status: "incompatible",
        detail: `Required structured CLI options are missing: ${missingTokens.join(", ")}`,
        capabilities: options.capabilities
      };
    }
    return {
      id: options.id,
      displayName: options.displayName,
      transport: "structured-cli",
      executable,
      version: parseVersion(versionOutput),
      status: "installed",
      capabilities: options.capabilities
    };
  } catch (error) {
    return {
      id: options.id,
      displayName: options.displayName,
      transport: "structured-cli",
      executable,
      status: "incompatible",
      detail: error instanceof Error ? error.message : "Version probe failed",
      capabilities: options.capabilities
    };
  }
}

export function validateHelpSurface(helpOutput: string, requiredTokens: string[]) {
  return requiredTokens.filter((token) => !helpOutput.includes(token));
}

/**
 * Reuse the caller's qualification result when it supplied one, otherwise
 * probe. `startSession` already probes before it creates the session, so
 * passing that result through leaves one probe per session start instead of
 * two.
 */
export function resolveInstallation(
  options: AdapterRunOptions,
  probe: () => Promise<HarnessInstallation>
): Promise<HarnessInstallation> {
  return options.installation ? Promise.resolve(options.installation) : probe();
}

export function runStructuredAdapter(options: {
  adapterId: HarnessId;
  executable: string;
  version: string;
  command: string[];
  run: AdapterRunOptions;
  parser: HarnessLineParser;
}): AdapterRun {
  let externalSessionId = options.run.binding?.externalSessionId;
  let resolveBinding!: (binding: NonNullable<AdapterRunOptions["binding"]>) => void;
  let rejectBinding!: (error: Error) => void;
  let bindingSettled = false;
  const binding = new Promise<NonNullable<AdapterRunOptions["binding"]>>((resolve, reject) => {
    resolveBinding = resolve;
    rejectBinding = reject;
  });

  const settleBinding = (sessionId: string) => {
    if (bindingSettled) return;
    bindingSettled = true;
    externalSessionId = sessionId;
    resolveBinding({
      harnessId: options.adapterId,
      harnessVersion: options.version,
      adapterVersion: "0.1.0",
      transport: "structured-cli",
      externalSessionId: sessionId
    });
  };

  if (externalSessionId) settleBinding(externalSessionId);

  const process = spawnJsonLineProcess({
    command: options.command,
    cwd: options.run.cwd,
    handlers: {
      stdout(line) {
        try {
          const parsed = options.parser.parse(line);
          if (parsed.externalSessionId) settleBinding(parsed.externalSessionId);
          for (const event of parsed.events) options.run.emit(event);
        } catch (error) {
          options.run.emit({
            kind: "diagnostic",
            data: { level: "warning", message: `Ignored malformed ${options.adapterId} event: ${error instanceof Error ? error.message : "unknown error"}` }
          });
        }
      },
      stderr(line) {
        options.run.emit({ kind: "diagnostic", data: { level: "info", message: redactDiagnostic(line) } });
      }
    }
  });

  const completed = process.exited.then((exitCode) => {
    if (!bindingSettled) {
      const error = new Error(`${options.adapterId} did not report a session id`);
      rejectBinding(error);
      if (exitCode === 0) throw error;
    }
    if (exitCode !== 0) throw new Error(`${options.adapterId} exited with status ${exitCode}`);
  });

  return { binding, completed, interrupt: process.interrupt };
}

async function discoverExecutable(id: HarnessId, command: string) {
  const candidates = [
    ...knownLocations[id].map((candidate) => path.join(homedir(), candidate)),
    path.join("/opt/homebrew/bin", command),
    path.join("/usr/local/bin", command),
    path.join("/usr/bin", command)
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }

  const direct = await findWith(["/usr/bin/which", command]);
  if (direct) return direct;
  return findWith(["/bin/zsh", "-lic", `command -v ${command}`]);
}

async function findWith(command: string[]) {
  try {
    const output = await runCommand(command, homedir());
    const candidate = output.split("\n").at(-1)?.trim();
    if (!candidate || !path.isAbsolute(candidate)) return undefined;
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

function parseVersion(output: string) {
  return output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/)?.[0] ?? output.trim().slice(0, 80);
}

function redactDiagnostic(value: string) {
  return value
    .replace(/(authorization|api[-_ ]?key|token|secret|password)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .slice(0, 8 * 1024);
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function text(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function number(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

export function parseJsonLine(line: string) {
  return record(JSON.parse(line));
}
