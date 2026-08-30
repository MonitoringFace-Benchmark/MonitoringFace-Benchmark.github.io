export interface PerTool {
  tool: string;
  runs: number;
  ok: number;
  timeout: number;
  tool_error: number;
  result_error: number;
  median_runtime_s: number | null;
  fastest: boolean;
  eligible?: boolean;
  common_median_runtime_s?: number | null;
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
  fastest_common_settings?: number;
  has_filetree: boolean;
  has_provenance?: boolean;
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

/** One (setting, tool) provenance entry as indexed in the bundle manifest.
 * Optional end to end: bundles published without --provenance carry none. */
export interface ProvenanceIndexEntry {
  setting_key: string;
  tool: string;
  dir: string; // relative to files/, e.g. "provenance/5_2_0_50/WhyMon"
  input_unchanged_after_run: boolean | null;
  captures: number | null;
  kinds: string[];
  stored_kinds: string[];
}

export interface ProvenanceStep {
  converter: string;
  source_format: string;
  target_format: string;
  command: string[] | null;
  cmd_params: string[] | null;
}

export interface ProvenanceEntry {
  kind: string;
  source: { file: string; format: string; sha256: string | null };
  steps: ProvenanceStep[] | 'custom';
  stored: { file: string; sha256: string } | null;
  as_seen_by_tool: string;
}

export interface ProvenanceManifest {
  schema_version: number;
  experiment_fingerprint: Record<string, string>;
  framework_commit: string | null;
  tool: { name: string; identifier: string; params: Record<string, unknown> };
  setting_key: string;
  captures: number;
  tool_invocation: string[] | null;
  input_unchanged_after_run: boolean | null;
  entries: ProvenanceEntry[];
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
  provenance?: ProvenanceIndexEntry[];
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
