import { useEffect, useMemo, useState } from 'react';
import { Tree, type NodeApi } from 'react-arborist';
import { downloadZip } from 'client-zip';
import { dataUrl, fmtBytes, loadFileTree } from '../lib/data';
import type { FileNode, Manifest } from '../lib/types';
import type { QueryResult } from '../lib/duckdb';

// Files at or below this size are loaded completely into the viewer;
// larger ones show only the first PREVIEW_BYTES.
const FULL_LOAD_LIMIT = 256 * 1024;
const PREVIEW_BYTES = 64 * 1024;

interface TreeDatum {
  id: string;
  name: string;
  file: FileNode;
  children?: TreeDatum[];
}

interface ViewerState {
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
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [viewerLoading, setViewerLoading] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);

  useEffect(() => {
    setViewer(null);
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

  function nodeMatchesRun(f: FileNode): boolean {
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

  async function viewFile(f: FileNode) {
    if (f.hosting !== 'inline') {
      // not fetchable from the browser; show metadata only
      setViewer({ file: f, content: '', truncated: false, binary: false });
      setViewerError(null);
      return;
    }
    setViewerLoading(f.path);
    setViewerError(null);
    try {
      const url = dataUrl(`experiments/${manifest.id}/files/${f.path}`);
      const full = (f.size ?? 0) <= FULL_LOAD_LIMIT;
      const text = await fetchPrefix(url, full ? Infinity : PREVIEW_BYTES);
      const binary = text.includes('\u0000');
      setViewer({ file: f, content: binary ? '' : text, truncated: !full, binary });
    } catch (e) {
      setViewer(null);
      setViewerError(String(e));
    } finally {
      setViewerLoading(null);
    }
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
                experimentId={manifest.id}
              />
            )}
          </Tree>
        </div>
        <div className="fb-side">
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Data of a single run</h2>
            {manifest.setting_schema.dir_template ? (
              <>
                <p className="muted small">
                  Pick a run to dim everything that was not part of it (its setting
                  directory, trace, policy, signature, seeds and oracle result).
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

      {(viewer || viewerLoading || viewerError) && (
        <div className="panel fb-viewer">
          <div className="fb-viewer-head">
            <span>📄</span>
            <strong className="mono">{viewerLoading ?? viewer?.file.path}</strong>
            {viewer && <span className="muted small">{fmtBytes(viewer.file.size)}</span>}
            {viewer && viewer.file.hosting === 'inline' && (
              <span className={`chip ${viewer.truncated ? 'TO' : 'OK'}`}>
                {viewer.truncated
                  ? `preview · first ${fmtBytes(PREVIEW_BYTES)}`
                  : 'complete file'}
              </span>
            )}
            {viewer && viewer.file.hosting === 'inline' && (
              <a
                href={dataUrl(`experiments/${manifest.id}/files/${viewer.file.path}`)}
                download={viewer.file.name}
              >
                download
              </a>
            )}
            <button
              className="btn"
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                setViewer(null);
                setViewerError(null);
              }}
            >
              close
            </button>
          </div>
          {viewerError && <div className="error-box">{viewerError}</div>}
          {viewerLoading && <p className="muted">Loading…</p>}
          {viewer && viewer.file.hosting !== 'inline' && (
            <p className="muted small" style={{ marginTop: 10 }}>
              This file is hosted externally (too large for the site bundle) and
              cannot be viewed in the browser. Size {fmtBytes(viewer.file.size)},
              sha256 <span className="mono">{viewer.file.sha256 ?? 'n/a'}</span>.
              Download it from the experiment's release assets.
            </p>
          )}
          {viewer && viewer.binary && (
            <p className="muted small" style={{ marginTop: 10 }}>
              This file looks binary; use the download link instead.
            </p>
          )}
          {viewer && viewer.file.hosting === 'inline' && !viewer.binary && (
            <>
              <pre className="fb-viewer-content">{viewer.content}</pre>
              {viewer.truncated && (
                <p className="muted small" style={{ marginTop: 8 }}>
                  Showing the first {fmtBytes(PREVIEW_BYTES)} of{' '}
                  {fmtBytes(viewer.file.size)}; download for the complete file.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

function Node({
  node,
  style,
  matches,
  checked,
  onCheck,
  onView,
  experimentId,
}: {
  node: NodeApi<TreeDatum>;
  style: React.CSSProperties;
  matches: (f: FileNode) => boolean;
  checked: Set<string>;
  onCheck: (path: string) => void;
  onView: (f: FileNode) => void;
  experimentId: string;
}) {
  const f = node.data.file;
  const dim = !matches(f);
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
          className="fb-name"
          title="view file"
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
