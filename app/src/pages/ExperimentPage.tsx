import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { loadDescription, loadManifest } from '../lib/data';
import { experimentRuns, type QueryResult } from '../lib/duckdb';
import type { Manifest } from '../lib/types';
import ResultsTable from '../components/ResultsTable';
import AnalysisView from '../components/AnalysisView';
import FileBrowser from '../components/FileBrowser';

type Tab = 'overview' | 'results' | 'analysis' | 'files';

export default function ExperimentPage() {
  const { id = '' } = useParams();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [runs, setRuns] = useState<QueryResult | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    // Latest-wins: without the stale guard, slow responses from a previous
    // experiment would render under this one's URL.
    let stale = false;
    setManifest(null);
    setManifestError(null);
    setDescription('');
    setRuns(null);
    setRunsError(null);
    setTab('overview');
    loadManifest(id)
      .then((m) => { if (!stale) setManifest(m); })
      .catch((e) => { if (!stale) setManifestError(String(e)); });
    loadDescription(id).then((d) => { if (!stale) setDescription(d); });
    experimentRuns(id)
      .then((r) => { if (!stale) setRuns(r); })
      .catch((e) => { if (!stale) setRunsError(String(e)); });
    return () => { stale = true; };
  }, [id]);

  if (manifestError) {
    return <div className="error-box">Unknown experiment "{id}": {manifestError}</div>;
  }
  if (!manifest) return <p className="muted">Loading experiment…</p>;

  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ['results', `Results (${manifest.n_runs})`],
    ['analysis', 'Analysis'],
    ['files', 'Files'],
  ];

  return (
    <>
      <h1>{manifest.name}</h1>
      <div className="chip-row">
        {Object.entries(manifest.status_files).map(([s, n]) => (
          <span key={s} className="chip tool">
            {s}: {n}
          </span>
        ))}
        {manifest.timeout_s != null && (
          <span className="chip TO">timeout {manifest.timeout_s}s</span>
        )}
        {manifest.run_timestamp && (
          <span className="muted small">run {manifest.run_timestamp.replace('T', ' ')}</span>
        )}
      </div>
      <div className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview manifest={manifest} description={description} />}
      {tab === 'results' &&
        (runs ? (
          <ResultsTable result={runs} />
        ) : runsError ? (
          <div className="error-box">{runsError}</div>
        ) : (
          <p className="muted">Loading runs…</p>
        ))}
      {tab === 'analysis' &&
        (runs ? <AnalysisView result={runs} /> : <p className="muted">Loading runs…</p>)}
      {tab === 'files' && <FileBrowser manifest={manifest} runs={runs} />}
    </>
  );
}

function Overview({ manifest, description }: { manifest: Manifest; description: string }) {
  return (
    <div className="panel">
      <ReactMarkdown>{description || '*No description.*'}</ReactMarkdown>
      <h2>Tools under test</h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Tool</th>
              <th>Commit</th>
              <th>Branch</th>
              <th>Params</th>
            </tr>
          </thead>
          <tbody>
            {manifest.monitors.map((m) => (
              <tr key={m.name}>
                <td>{m.name}</td>
                <td>{m.identifier}</td>
                <td className="mono">{m.commit?.slice(0, 10) ?? ''}</td>
                <td>{m.branch ?? ''}</td>
                <td className="mono">
                  {Object.keys(m.params).length ? JSON.stringify(m.params) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Provenance</h2>
      <dl className="kv">
        <dt>Runtime setting</dt>
        <dd>{manifest.runtime_setting}</dd>
        <dt>Setting schema</dt>
        <dd>{manifest.setting_schema.kind}</dd>
        {Object.entries(manifest.fingerprint).map(([k, v]) => (
          <FingerprintRow key={k} k={k} v={v} />
        ))}
        <dt>Seeds</dt>
        <dd>{Object.keys(manifest.seeds).length} setting seed pairs recorded</dd>
      </dl>
    </div>
  );
}

function FingerprintRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className="mono">{v}</dd>
    </>
  );
}
