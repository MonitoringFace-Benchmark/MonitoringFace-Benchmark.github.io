import { useEffect, useMemo, useRef, useState } from 'react';
import { Tree, type NodeApi } from 'react-arborist';
import { downloadZip } from 'client-zip';
import { dataUrl, fmtBytes, loadFileTree, loadProvenance } from '../lib/data';
import type { FileNode, Manifest, ProvenanceManifest } from '../lib/types';
import type { QueryResult } from '../lib/duckdb';

// Files at or below this size are loaded completely into the viewer;
// larger ones show only the first PREVIEW_BYTES.
const FULL_LOAD_LIMIT = 256 * 1024;
const PREVIEW_BYTES = 64 * 1024;
const MAX_TABS = 10;

interface TreeDatum {
  id: string;
  name: string;
  file: FileNode;
  children?: TreeDatum[];
}

interface ViewerTab {
  file: FileNode;
  content: string;
  truncated: boolean;
  binary: boolean;
}

function toTree(node: FileNode): TreeDatum {
  return {
    id: node.path || node.name,
    name: node.name,
    file: node,
    children: node.kind === 'dir' ? (node.children ?? []).map(toTree) : undefined,
  };
}

function collectFiles(node: FileNode, out: FileNode[] = []): FileNode[] {
  if (node.kind === 'file') out.push(node);
  node.children?.forEach((c) => collectFiles(c, out));
  return out;
}

/** Tab label: last two path segments, so two policy.policy files from
 * different settings stay distinguishable. */
function tabLabel(path: string): string {
  const parts = path.split('/');
  return parts.slice(-2).join('/');
}

interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
}

/** Line-level diff (LCS with common prefix/suffix trimming). Returns null
 * when the middle sections are too large to diff comfortably in-browser. */
function diffLines(oldText: string, newText: string): DiffLine[] | null {
  const al = oldText.split('\n');
  const bl = newText.split('\n');
  let start = 0;
  while (start < al.length && start < bl.length && al[start] === bl[start]) start++;
  let endA = al.length;
  let endB = bl.length;
  while (endA > start && endB > start && al[endA - 1] === bl[endB - 1]) {
    endA--;
    endB--;
  }
  const ca = al.slice(start, endA);
  const cb = bl.slice(start, endB);
  const m = ca.length;
  const n = cb.length;
  if (m * n > 4_000_000) return null;
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * w + j] =
        ca[i] === cb[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = al.slice(0, start).map((t) => ({ kind: 'ctx', text: t }));
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (ca[i] === cb[j]) {
      out.push({ kind: 'ctx', text: ca[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ kind: 'del', text: ca[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: cb[j] });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', text: ca[i++] });
  while (j < n) out.push({ kind: 'add', text: cb[j++] });
  out.push(...al.slice(endA).map((t) => ({ kind: 'ctx' as const, text: t })));
  return out;
}

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Resolve the manifest's dir_template against one run's sweep factors. */
function runPrefix(template: string, run: Record<string, unknown>): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = run[key];
    if (v === null || v === undefined) {
      missing = true;
      return '';
    }
    return String(v);
  });
  return missing ? null : out;
}

/** Fetch at most `limit` bytes of `url`. Sends a Range header, but also caps
 * via a streaming reader so servers that ignore Range never flood memory. */
async function fetchPrefix(url: string, limit: number): Promise<string> {
  const init = Number.isFinite(limit)
    ? { headers: { Range: `bytes=0-${limit - 1}` } }
    : undefined;
  const res = await fetch(url, init);
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  if (!Number.isFinite(limit) || !res.body) {
    const text = await res.text();
    return Number.isFinite(limit) ? text.slice(0, limit) : text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
  }
  await reader.cancel().catch(() => {});
  const buf = new Uint8Array(Math.min(received, limit));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, buf.length - off);
    buf.set(c.subarray(0, take), off);
    off += take;
    if (off >= buf.length) break;
  }
  // ignore a possibly split multi-byte char at the cut point
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

export default function FileBrowser({
  manifest,
  runs,
}: {
  manifest: Manifest;
  runs: QueryResult | null;
}) {
  const [tree, setTree] = useState<FileNode | null>(null);
  const [selectedRun, setSelectedRun] = useState<string>('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<ViewerTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [comparePath, setComparePath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState(false);
  const [viewerLoading, setViewerLoading] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [prov, setProv] = useState<ProvenanceManifest | null>(null);
  const [provLoading, setProvLoading] = useState(false);
  const [provError, setProvError] = useState<string | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setTabs([]);
    setActivePath(null);
    setComparePath(null);
    setDiffMode(false);
    setViewerError(null);
    setViewerLoading(null);
    if (manifest.has_filetree) {
      loadFileTree(manifest.id).then(setTree).catch((e) => setError(String(e)));
    }
  }, [manifest]);

  const treeData = useMemo(() => (tree ? [toTree(tree)] : []), [tree]);

  const runOptions = useMemo(() => {
    if (!runs) return [];
    return runs.rows
      .map((r) => ({
        key: `${r.tool_name}|${r.setting}`,
        label: `${r.tool_name} · ${r.setting} · ${r.status}`,
        run: r,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [runs]);

  // The subtree prefix holding exactly the data of the selected run.
  const highlightPrefix = useMemo(() => {
    if (!selectedRun || !manifest.setting_schema.dir_template) return null;
    const opt = runOptions.find((o) => o.key === selectedRun);
    if (!opt) return null;
    return runPrefix(manifest.setting_schema.dir_template, opt.run);
  }, [selectedRun, runOptions, manifest]);

  const selectedRunRow = runOptions.find((o) => o.key === selectedRun)?.run;

  // Provenance entry of the selected run: bundle manifests published without
  // --provenance have no index, and everything below degrades to nothing.
  const provEntry = useMemo(() => {
    if (!selectedRunRow || !manifest.provenance?.length) return null;
    const setting = String(selectedRunRow.setting ?? '');
    const key = setting.includes('_') ? setting.slice(0, setting.lastIndexOf('_')) : setting;
    return (
      manifest.provenance.find(
        (p) => p.tool === selectedRunRow.tool_name && p.setting_key === key,
      ) ?? null
    );
  }, [selectedRunRow, manifest]);

  useEffect(() => {
    setProv(null);
    setProvError(null);
    if (!provEntry) return;
    let stale = false;
    setProvLoading(true);
    loadProvenance(manifest.id, provEntry.dir)
      .then((m) => { if (!stale) setProv(m); })
      .catch((e) => { if (!stale) setProvError(String(e)); })
      .finally(() => { if (!stale) setProvLoading(false); });
    return () => { stale = true; };
  }, [provEntry, manifest.id]);

  const nodeByPath = useMemo(() => {
    const map = new Map<string, FileNode>();
    if (tree) for (const f of collectFiles(tree)) map.set(f.path, f);
    return map;
  }, [tree]);

  function nodeMatchesRun(f: FileNode): boolean {
    // the grafted provenance subtree follows the run selection: only the
    // selected run's entry stays lit
    if (f.path === 'provenance' || f.path.startsWith('provenance/')) {
      if (!selectedRun) return true;
      if (!provEntry) return false;
      const d = provEntry.dir;
      return (
        f.path === 'provenance' ||
        f.path === d ||
        f.path.startsWith(d + '/') ||
        d.startsWith(f.path + '/')
      );
    }
    if (!highlightPrefix) return true;
    const inPrefix =
      f.path.startsWith(highlightPrefix + '/') || f.path === highlightPrefix;
    const prefixInside = highlightPrefix.startsWith(f.path + '/');
    if (!(inPrefix || prefixInside || f.path === '')) return false;
    // Inside the setting dir, size-suffixed artifacts only match their own run.
    if (f.kind === 'file' && inPrefix && selectedRunRow?.data_set_size != null) {
      const m = f.name.match(/^(?:data|result)_(\d+)\./);
      if (m && Number(m[1]) !== Number(selectedRunRow.data_set_size)) return false;
    }
    return true;
  }

  function toggleChecked(path: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** Bring the viewer panel into view; the tree stays where it is, so the
   * user sees where their click landed. */
  function scrollToViewer() {
    setTimeout(
      () => viewerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      60,
    );
  }

  async function viewFile(f: FileNode) {
    if (tabs.some((t) => t.file.path === f.path)) {
      setActivePath(f.path);
      scrollToViewer();
      return;
    }
    let tab: ViewerTab;
    if (f.hosting !== 'inline') {
      // not fetchable from the browser; the pane shows metadata only
      tab = { file: f, content: '', truncated: false, binary: false };
    } else {
      setViewerLoading(f.path);
      setViewerError(null);
      try {
        const url = dataUrl(`experiments/${manifest.id}/files/${f.path}`);
        const full = (f.size ?? 0) <= FULL_LOAD_LIMIT;
        const text = await fetchPrefix(url, full ? Infinity : PREVIEW_BYTES);
        const binary = text.includes('\u0000');
        tab = { file: f, content: binary ? '' : text, truncated: !full, binary };
      } catch (e) {
        setViewerError(String(e));
        setViewerLoading(null);
        return;
      }
      setViewerLoading(null);
    }
    setTabs((prev) => {
      const next = [...prev, tab];
      return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
    });
    setActivePath(f.path);
    scrollToViewer();
  }

  /** Open the canonical source and the converted final input side by side. */
  async function compareProvenance(sourcePath: string, storedPath: string) {
    const src = nodeByPath.get(sourcePath);
    const st = nodeByPath.get(storedPath);
    if (!src || !st) return;
    await viewFile(src);
    await viewFile(st);
    setComparePath(sourcePath);
    setActivePath(storedPath);
  }

  function closeTab(path: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.file.path !== path);
      if (comparePath === path) setComparePath(null);
      if (activePath === path) {
        setActivePath(next.length ? next[next.length - 1].file.path : null);
      }
      return next;
    });
  }

  async function exportZip() {
    if (!tree) return;
    setExporting(true);
    setError(null);
    try {
      const all = collectFiles(tree).filter(
        (f) => checked.has(f.path) && f.hosting === 'inline',
      );
      const skippedExternal = collectFiles(tree).filter(
        (f) => checked.has(f.path) && f.hosting === 'external',
      );
      const inputs = await Promise.all(
        all.map(async (f) => {
          const res = await fetch(dataUrl(`experiments/${manifest.id}/files/${f.path}`));
          if (!res.ok) throw new Error(`fetch ${f.path}: HTTP ${res.status}`);
          return { name: f.path, input: await res.blob() };
        }),
      );
      if (skippedExternal.length) {
        const note = skippedExternal
          .map((f) => `${f.path}\t${fmtBytes(f.size)}\tsha256=${f.sha256 ?? 'n/a'}`)
          .join('\n');
        inputs.push({
          name: 'EXTERNAL_FILES.txt',
          input: new Blob([
            `These selected files are hosted externally (too large for the site bundle).\n` +
              `Download them from the experiment's release assets:\n\n${note}\n`,
          ]),
        });
      }
      const blob = await downloadZip(inputs).blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${manifest.id}_export.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  if (!manifest.has_filetree) {
    return <div className="panel muted">No input-data tree was published for this experiment.</div>;
  }
  if (error) return <div className="error-box">{error}</div>;
  if (!tree) return <p className="muted">Loading file tree…</p>;

  const activeTab = tabs.find((t) => t.file.path === activePath) ?? null;
  const compareTab =
    comparePath && comparePath !== activePath
      ? tabs.find((t) => t.file.path === comparePath) ?? null
      : null;
  const openPaths = new Set(tabs.map((t) => t.file.path));

  // Diff is offered only for two viewable files of the same format.
  const diffEligible =
    !!activeTab &&
    !!compareTab &&
    activeTab.file.hosting === 'inline' &&
    compareTab.file.hosting === 'inline' &&
    !activeTab.binary &&
    !compareTab.binary &&
    fileExt(activeTab.file.name) === fileExt(compareTab.file.name);
  const diff =
    diffMode && diffEligible && activeTab && compareTab
      ? diffLines(compareTab.content, activeTab.content)
      : null;

  return (
    <>
      <div className="fb-layout">
        <div className="fb-tree">
          <Tree<TreeDatum>
            data={treeData}
            openByDefault={false}
            width="100%"
            height={600}
            rowHeight={26}
            indent={16}
            disableDrag
            disableDrop
          >
            {(props) => (
              <Node
                {...props}
                matches={nodeMatchesRun}
                checked={checked}
                onCheck={toggleChecked}
                onView={viewFile}
                openPaths={openPaths}
                experimentId={manifest.id}
              />
            )}
          </Tree>
        </div>
        <div className="fb-side">
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Data of a single run</h2>
            {manifest.setting_schema.dir_template ||
            (manifest.provenance?.length ?? 0) > 0 ? (
              <>
                <p className="muted small">
                  {manifest.setting_schema.dir_template
                    ? 'Pick a run to dim everything that was not part of it (its ' +
                      'setting directory, trace, policy, signature, seeds and oracle result).'
                    : 'Pick a run to inspect the exact final input its tool received; ' +
                      'per-run file dimming is only available for offline synthetic experiments.'}
                </p>
                <select
                  style={{ width: '100%' }}
                  value={selectedRun}
                  onChange={(e) => setSelectedRun(e.target.value)}
                >
                  <option value="">— all files —</option>
                  {runOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <p className="muted small">
                Per-run selection is only available for offline synthetic
                experiments; this experiment's runs are mapped by instruction
                index instead.
              </p>
            )}
          </div>
          {selectedRunRow && (manifest.provenance?.length ?? 0) > 0 && (
            <div className="panel">
              <h2 style={{ marginTop: 0 }}>Final tool input</h2>
              {!provEntry ? (
                <p className="muted small">
                  No provenance was recorded for this run (published before the
                  provenance flag, or capture failed).
                </p>
              ) : provError ? (
                <div className="error-box">{provError}</div>
              ) : provLoading || !prov ? (
                <p className="muted small">Loading provenance…</p>
              ) : (
                <>
                  <div className="chip-row" style={{ marginBottom: 8 }}>
                    {prov.input_unchanged_after_run === true && (
                      <span className="chip OK" title="inputs re-hashed after the run">
                        input unchanged ✓
                      </span>
                    )}
                    {prov.input_unchanged_after_run === false && (
                      <span className="chip TE" title="the tool modified or removed its input during the run">
                        input modified during run!
                      </span>
                    )}
                    {prov.captures > 1 && (
                      <span className="chip tool" title="repeat runs re-converted and hash-matched">
                        {prov.captures}× hash-verified
                      </span>
                    )}
                  </div>
                  {prov.entries.map((e) => {
                    const storedPath = e.stored ? `${provEntry.dir}/${e.stored.file}` : null;
                    const srcNode = nodeByPath.get(e.source.file);
                    const storedNode = storedPath ? nodeByPath.get(storedPath) : null;
                    return (
                      <div key={e.kind} className="prov-entry">
                        <div className="prov-line">
                          <span className="chip tool">{e.kind}</span>
                          {srcNode ? (
                            <span className="fb-name" onClick={() => viewFile(srcNode)}>
                              {e.source.file.split('/').pop()}
                            </span>
                          ) : (
                            <span className="mono small">{e.source.file.split('/').pop()}</span>
                          )}
                          {e.stored ? (
                            <>
                              <span className="muted">→</span>
                              {storedNode ? (
                                <span className="fb-name" onClick={() => viewFile(storedNode)}>
                                  {e.stored.file}
                                </span>
                              ) : (
                                <span className="mono small">{e.stored.file}</span>
                              )}
                            </>
                          ) : (
                            <span className="muted small">
                              {e.steps === 'custom' ? 'custom preprocessing' : 'used unmodified'}
                            </span>
                          )}
                        </div>
                        {Array.isArray(e.steps) && e.steps.length > 0 && (
                          <details className="prov-steps">
                            <summary className="muted small">
                              via {e.steps.map((s) => s.converter).join(' → ')}
                            </summary>
                            {e.steps.map((s, i) => (
                              <div key={i} className="small">
                                <span className="mono">{s.source_format} → {s.target_format}</span>
                                {s.command && (
                                  <pre className="prov-cmd">{s.command.join(' ')}</pre>
                                )}
                              </div>
                            ))}
                          </details>
                        )}
                        {e.stored && srcNode && storedNode &&
                          srcNode.hosting === 'inline' && storedNode.hosting === 'inline' && (
                          <button
                            className="btn small"
                            onClick={() => compareProvenance(e.source.file, storedPath!)}
                          >
                            compare source ↔ converted
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {prov.tool_invocation && (
                    <p className="muted small" style={{ marginBottom: 0 }}>
                      invoked: <span className="mono">{prov.tool_invocation.join(' ')}</span>
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Export</h2>
            <p className="muted small">
              {checked.size} file(s) selected. Inline files are zipped in the
              browser; externally hosted files are listed with their sha256 in
              EXTERNAL_FILES.txt.
            </p>
            <button className="btn primary" onClick={exportZip} disabled={!checked.size || exporting}>
              {exporting ? 'zipping…' : 'Export selection as .zip'}
            </button>
          </div>
        </div>
      </div>

      {(tabs.length > 0 || viewerLoading || viewerError) && (
        <div className="panel fb-viewer" ref={viewerRef}>
          <div className="fb-tabs">
            {tabs.map((t) => (
              <button
                key={t.file.path}
                className={`fb-tab ${t.file.path === activePath ? 'active' : ''}`}
                onClick={() => setActivePath(t.file.path)}
                title={t.file.path}
              >
                {tabLabel(t.file.path)}
                <span
                  className="fb-tab-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.file.path);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
            {viewerLoading && <span className="muted small">loading {viewerLoading}…</span>}
            {tabs.length > 1 && (
              <label className="fb-compare-pick muted small">
                compare side by side with
                <select
                  value={comparePath ?? ''}
                  onChange={(e) => setComparePath(e.target.value || null)}
                >
                  <option value="">— none —</option>
                  {tabs
                    .filter((t) => t.file.path !== activePath)
                    .map((t) => (
                      <option key={t.file.path} value={t.file.path}>
                        {tabLabel(t.file.path)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {compareTab && diffEligible && (
              <label className="muted small" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <input
                  type="checkbox"
                  checked={diffMode}
                  onChange={(e) => setDiffMode(e.target.checked)}
                />
                diff
              </label>
            )}
          </div>
          {viewerError && <div className="error-box">{viewerError}</div>}
          {diffMode && diffEligible && diff === null && (
            <div className="notice">
              These files are too large to diff in the browser; showing them
              side by side instead.
            </div>
          )}
          {diff && activeTab && compareTab ? (
            <div className="fb-pane">
              <div className="fb-pane-head">
                <span className="muted small">
                  diff: <span className="mono">{tabLabel(compareTab.file.path)}</span>
                  {' → '}
                  <span className="mono">{tabLabel(activeTab.file.path)}</span>
                </span>
                {(activeTab.truncated || compareTab.truncated) && (
                  <span className="chip TO">computed on the loaded portions only</span>
                )}
              </div>
              <pre className="fb-viewer-content fb-diff">
                {diff.map((l, i) => (
                  <span key={i} className={`diff-${l.kind}`}>
                    {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
                    {l.text || ' '}
                  </span>
                ))}
              </pre>
            </div>
          ) : (
            <div className={compareTab ? 'fb-compare' : ''}>
              {activeTab && (
                <ViewerPane tab={activeTab} experimentId={manifest.id} />
              )}
              {compareTab && (
                <ViewerPane tab={compareTab} experimentId={manifest.id} />
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ViewerPane({ tab, experimentId }: { tab: ViewerTab; experimentId: string }) {
  const f = tab.file;
  return (
    <div className="fb-pane">
      <div className="fb-pane-head">
        <strong className="mono small" title={f.path}>
          <bdi>{f.path}</bdi>
        </strong>
        <span className="muted small">{fmtBytes(f.size)}</span>
        {f.hosting === 'inline' && (
          <span className={`chip ${tab.truncated ? 'TO' : 'OK'}`}>
            {tab.truncated ? `preview · first ${fmtBytes(PREVIEW_BYTES)}` : 'complete file'}
          </span>
        )}
        {f.hosting === 'inline' && (
          <a
            href={dataUrl(`experiments/${experimentId}/files/${f.path}`)}
            download={f.name}
          >
            download
          </a>
        )}
      </div>
      {f.hosting !== 'inline' ? (
        <p className="muted small" style={{ marginTop: 10 }}>
          This file is hosted externally (too large for the site bundle) and
          cannot be viewed in the browser. Size {fmtBytes(f.size)}, sha256{' '}
          <span className="mono">{f.sha256 ?? 'n/a'}</span>. Download it from
          the experiment's release assets.
        </p>
      ) : tab.binary ? (
        <p className="muted small" style={{ marginTop: 10 }}>
          This file looks binary; use the download link instead.
        </p>
      ) : (
        <>
          <pre className="fb-viewer-content">{tab.content}</pre>
          {tab.truncated && (
            <p className="muted small" style={{ marginTop: 8 }}>
              Showing the first {fmtBytes(PREVIEW_BYTES)} of {fmtBytes(f.size)};
              download for the complete file.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Node({
  node,
  style,
  matches,
  checked,
  onCheck,
  onView,
  openPaths,
  experimentId,
}: {
  node: NodeApi<TreeDatum>;
  style: React.CSSProperties;
  matches: (f: FileNode) => boolean;
  checked: Set<string>;
  onCheck: (path: string) => void;
  onView: (f: FileNode) => void;
  openPaths: Set<string>;
  experimentId: string;
}) {
  const f = node.data.file;
  const dim = !matches(f);
  const isOpen = f.kind === 'file' && openPaths.has(f.path);
  return (
    <div
      style={style}
      className={`fb-node ${dim ? 'dim' : ''}`}
      onClick={() => node.isInternal && node.toggle()}
    >
      {f.kind === 'file' && (
        <input
          type="checkbox"
          checked={checked.has(f.path)}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onCheck(f.path)}
        />
      )}
      <span>{f.kind === 'dir' ? (node.isOpen ? '📂' : '📁') : '📄'}</span>
      {f.kind === 'file' ? (
        <span
          className={`fb-name ${isOpen ? 'open' : ''}`}
          title={isOpen ? 'open in the viewer below; click to jump to it' : 'view file'}
          onClick={(e) => {
            e.stopPropagation();
            onView(f);
          }}
        >
          {f.name}
        </span>
      ) : (
        <span>{f.name}</span>
      )}
      {isOpen && <span className="fb-open-badge">viewing</span>}
      {f.kind === 'file' && f.hosting === 'inline' && (
        <a
          className="fb-dl"
          href={dataUrl(`experiments/${experimentId}/files/${f.path}`)}
          download={f.name}
          title="download"
          onClick={(e) => e.stopPropagation()}
        >
          ⬇
        </a>
      )}
      {f.hosting === 'external' && (
        <span className="badge-ext" title={`sha256: ${f.sha256 ?? 'n/a'}`}>
          external
        </span>
      )}
      {f.kind === 'file' && <span className="size">{fmtBytes(f.size)}</span>}
    </div>
  );
}
