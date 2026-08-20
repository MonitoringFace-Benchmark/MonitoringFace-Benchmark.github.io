export interface PerTool {
  tool: string;
  runs: number;
  ok: number;
  timeout: number;
  tool_error: number;
  result_error: number;
  median_runtime_s: number | null;
  fastest: boolean;
}

export interface ExperimentCard {
  id: string;
  name: string;
  description: string;
  run_timestamp: string | null;
  runtime_setting: string;
  timeout_s: number | null;
  n_runs: number;
  tools: string[];
  status_counts: Record<string, number>;
  per_tool: PerTool[];
  fastest_tool: string | null;
  has_filetree: boolean;
}

export interface ExperimentsIndex {
  schema_version: number;
  generated_at: string;
  experiments: ExperimentCard[];
}

export interface Monitor {
  name: string;
  identifier: string;
  commit: string | null;
  branch: string | null;
  params: Record<string, unknown>;
}

export interface Manifest {
  schema_version: number;
  id: string;
  name: string;
  run_timestamp: string | null;
  runtime_setting: string;
  timeout_s: number | null;
  monitors: Monitor[];
  status_files: Record<string, number>;
  n_runs: number;
  setting_schema: { kind: string; dir_template: string | null };
  fingerprint: Record<string, string>;
  has_filetree: boolean;
  seeds: Record<string, number[]>;
  data_setup: Record<string, unknown>;
  policy_setup: Record<string, unknown>;
}

export interface FileNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size?: number;
  hosting?: 'inline' | 'external';
  sha256?: string;
  children?: FileNode[];
}

/** One normalized run row as returned by DuckDB (column subset varies). */
export type RunRow = Record<string, string | number | null>;
