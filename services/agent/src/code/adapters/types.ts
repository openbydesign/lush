import type {
  AutonomyMode,
  HarnessEventInput,
  HarnessId,
  HarnessInstallation,
  HarnessSessionBinding
} from "@lush/code";
import type { RunningProcess } from "../process";

export type AdapterRunOptions = {
  cwd: string;
  prompt: string;
  model?: string;
  autonomy: AutonomyMode;
  binding?: HarnessSessionBinding;
  /**
   * A qualification result the caller has already obtained from `probe()`.
   * When present the adapter reuses it instead of probing again, which is what
   * keeps session startup to one probe rather than two.
   */
  installation?: HarnessInstallation;
  emit(event: HarnessEventInput): void;
};

export type AdapterRun = {
  binding: Promise<HarnessSessionBinding>;
  completed: Promise<void>;
  interrupt(): void;
};

export interface CodingHarnessAdapter {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly effectiveAutonomy: (requested: AutonomyMode) => AutonomyMode;
  probe(): Promise<HarnessInstallation>;
  run(options: AdapterRunOptions): AdapterRun;
}

export type ParsedLine = {
  externalSessionId?: string;
  events: HarnessEventInput[];
};

export interface HarnessLineParser {
  parse(line: string): ParsedLine;
}

export type StructuredRun = {
  process: RunningProcess;
  binding: Promise<HarnessSessionBinding>;
  completed: Promise<void>;
};
