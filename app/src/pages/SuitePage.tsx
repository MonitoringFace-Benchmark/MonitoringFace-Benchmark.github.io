import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { loadIndex } from '../lib/data';
import { experimentRuns, type QueryResult } from '../lib/duckdb';
import type { ExperimentCard, Suite } from '../lib/types';
import { ExperimentCardView } from '../components/ExperimentCard';
import ResultsTable from '../components/ResultsTable';
import AnalysisView from '../components/AnalysisView';

type Tab = 'overview' | 'results' | 'analysis';

export default function SuitePage() {
  const { id = '' } = useParams();
  const [suite, setSuite] = useState<Suite | null>(null);
  const [members, setMembers] = useState<ExperimentCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [combined, setCombined] = useState<QueryResult | null>(null);
  const [combinedError, setCombinedError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    let stale = false;
    setSuite(null);
    setMembers([]);
    setCombined(null);
    setCombinedError(null);
    setTab('overview');
    loadIndex()
      .then((idx) => {
        if (stale) return;
        const s = (idx.suites ?? []).find((x) => x.id === id) ?? null;
        if (!s) {
          setError(`Unknown suite "${id}"`);
          return;
        }
        setSuite(s);
        setMembers(idx.experiments.filter((c) => s.members.includes(c.id)));
        // combined view: all members' runs in one table, still one row per run
        Promise.all(s.members.map((m) => experimentRuns(m)))
          .then((results) => {
            if (stale) return;
            const columns = [...new Set(results.flatMap((r) => r.columns))];
            setCombined({ columns, rows: results.flatMap((r) => r.rows) });
          })
          .catch((e) => { if (!stale) setCombinedError(String(e)); });
      })
      .catch((e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [id]);

  if (error) return <div className="error-box">{error}</div>;
  if (!suite) return <p className="muted">Loading suite…</p>;

  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ['results', `Combined results (${suite.n_runs})`],
    ['analysis', 'Combined analysis'],
  ];

  return (
    <>
      <h1>
        <span className="suite-badge">suite</span> {suite.name}
      </h1>
      <div className="chip-row">
        {Object.entries(suite.status_counts).map(([s, n]) => (
          <span key={s} className={`chip ${s}`}>
            {s} {n}
          </span>
        ))}
        {suite.fastest_tool && (
          <span
            className="chip fastest"
            title={`lowest median runtime over the ${suite.fastest_common_settings} settings solved by every fully-covering tool across all members`}
          >
            fastest: {suite.fastest_tool}
          </span>
        )}
        {suite.run_timestamp && (
          <span className="muted small">run {suite.run_timestamp.replace('T', ' ')}</span>
        )}
      </div>
      <div className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          {suite.description && (
            <div className="panel" style={{ marginBottom: 14 }}>
              <ReactMarkdown>{suite.description}</ReactMarkdown>
            </div>
          )}
          <div className="card-grid">
            {members.map((c) => (
              <ExperimentCardView key={c.id} c={c} />
            ))}
          </div>
        </>
      )}
      {tab === 'results' &&
        (combined ? (
          <ResultsTable result={combined} unhide={['experiment_id']} />
        ) : combinedError ? (
          <div className="error-box">{combinedError}</div>
        ) : (
          <p className="muted">Loading combined runs…</p>
        ))}
      {tab === 'analysis' &&
        (combined ? <AnalysisView result={combined} /> : <p className="muted">Loading combined runs…</p>)}
    </>
  );
}
