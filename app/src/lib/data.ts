import type { ExperimentsIndex, Manifest, FileNode, ProvenanceManifest } from './types';

/** Absolute URL for a path under site-data/, valid in dev and on Pages. */
export function dataUrl(rel: string): string {
  const base = new URL(import.meta.env.BASE_URL, window.location.href);
  return new URL(`site-data/${rel}`, base).toString();
}

async function fetchJson<T>(rel: string): Promise<T> {
  const res = await fetch(dataUrl(rel));
  if (!res.ok) throw new Error(`fetch ${rel}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const loadIndex = () => fetchJson<ExperimentsIndex>('index/experiments.json');

export const loadManifest = (id: string) =>
  fetchJson<Manifest>(`experiments/${id}/manifest.json`);

export const loadFileTree = (id: string) =>
  fetchJson<FileNode>(`experiments/${id}/filetree.json`);

/** Full provenance manifest of one (setting, tool); dir comes from the
 * bundle manifest's provenance index. */
export const loadProvenance = (id: string, dir: string) =>
  fetchJson<ProvenanceManifest>(`experiments/${id}/files/${dir}/provenance.json`);

export async function loadDescription(id: string): Promise<string> {
  const res = await fetch(dataUrl(`experiments/${id}/description.md`));
  return res.ok ? res.text() : '';
}

export function fmtBytes(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtNum(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    if (Math.abs(v) < 0.001) return v.toExponential(2);
    return v.toFixed(3);
  }
  return String(v);
}
