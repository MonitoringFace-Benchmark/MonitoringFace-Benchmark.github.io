import { useState } from 'react';
import { Link } from 'react-router-dom';
import { query, type QueryResult } from '../lib/duckdb';
import { fmtNum } from '../lib/data';

interface Props {
  tools: string[];
  onMatch: (ids: Set<string> | null) => void;
}

const PREDICATES = [
  { key: 'fastest', label: 'is the fastest (median over commonly-solved settings)' },
  { key: 'TO', label: 'timed out' },
  { key: 'TE', label: 'had a tool error' },
  { key: 'RE', label: 'disagreed with the oracle' },
  { key: 'OK', label: 'has valid runs' },
] as const;

function sqlFor(tool: string, predicate: string): string {
  const t = tool.replace(/'/g, "''");
  if (predicate === 'fastest') {
    // paired comparison, same semantics as the grid chip: only tools with
    // maximal setting coverage are eligible, medians are taken over the
    // settings all eligible tools solved
    return `
      WITH ok_runs AS (
        SELECT experiment_id, tool_name, setting, runtime_s
        FROM runs WHERE status = 'OK' AND runtime_s IS NOT NULL
      ),
      cov AS (
        SELECT experiment_id, tool_name, count(DISTINCT setting) AS c
        FROM ok_runs GROUP BY 1, 2
      ),
      eligible AS (
        SELECT experiment_id, tool_name FROM cov
        WHERE c = (SELECT max(c2.c) FROM cov c2 WHERE c2.experiment_id = cov.experiment_id)
      ),
      common AS (
        SELECT o.experiment_id, o.setting
        FROM ok_runs o
        JOIN eligible e ON e.experiment_id = o.experiment_id AND e.tool_name = o.tool_name
        GROUP BY 1, 2
        HAVING count(DISTINCT o.tool_name) =
          (SELECT count(*) FROM eligible e2 WHERE e2.experiment_id = o.experiment_id)
      ),
      med AS (
        SELECT o.experiment_id, o.tool_name, median(o.runtime_s) AS m
        FROM ok_runs o
        JOIN eligible e ON e.experiment_id = o.experiment_id AND e.tool_name = o.tool_name
        JOIN common c ON c.experiment_id = o.experiment_id AND c.setting = o.setting
        GROUP BY 1, 2
      )
      SELECT experiment_id FROM (
        SELECT experiment_id, tool_name, m,
               min(m) OVER (PARTITION BY experiment_id) AS mn
        FROM med
      ) WHERE tool_name = '${t}' AND m = mn`;
  }
  // "timed out" covers the whole family: offline TO, online ATO/MTO
  const cond = predicate === 'TO' ? "status IN ('TO','ATO','MTO')" : `status = '${predicate}'`;
  return `SELECT DISTINCT experiment_id FROM runs
          WHERE tool_name = '${t}' AND ${cond}`;
}

export default function DataSearch({ tools, onMatch }: Props) {
  const [tool, setTool] = useState(tools[0] ?? '');
  const [predicate, setPredicate] = useState<string>('fastest');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [sql, setSql] = useState(
    "SELECT experiment_id, tool_name, count(*) AS timeouts\nFROM runs WHERE status IN ('TO','ATO','MTO')\nGROUP BY 1, 2 ORDER BY timeouts DESC",
  );
  const [sqlResult, setSqlResult] = useState<QueryResult | null>(null);

  async function runPredicate() {
    setBusy(true);
    setError(null);
    try {
      const res = await query(sqlFor(tool, predicate));
      onMatch(new Set(res.rows.map((r) => String(r.experiment_id))));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runSql() {
    setBusy(true);
    setError(null);
    try {
      const res = await query(sql);
      setSqlResult(res);
      if (res.columns.includes('experiment_id')) {
        onMatch(new Set(res.rows.map((r) => String(r.experiment_id))));
      }
    } catch (e) {
      setError(String(e));
      setSqlResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="data-search">
      <div className="row">
        <span className="muted">Find experiments where</span>
        <select value={tool} onChange={(e) => setTool(e.target.value)}>
          {tools.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select value={predicate} onChange={(e) => setPredicate(e.target.value)}>
          {PREDICATES.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="primary" onClick={runPredicate} disabled={busy || !tool}>
          {busy ? 'querying…' : 'Search data'}
        </button>
        <button onClick={() => setShowSql((s) => !s)}>
          {showSql ? 'hide SQL' : 'SQL mode'}
        </button>
      </div>
      {showSql && (
        <>
          <textarea
            className="sql-box"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
          />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="primary" onClick={runSql} disabled={busy}>
              Run SQL on `runs`
            </button>
            <span className="muted small">
              one row per run, every experiment; queried in-browser via DuckDB-WASM
            </span>
          </div>
          {sqlResult && (
            <div className="tbl-wrap" style={{ marginTop: 8, maxHeight: 300, overflowY: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    {sqlResult.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sqlResult.rows.slice(0, 200).map((r, i) => (
                    <tr key={i}>
                      {sqlResult.columns.map((c) => (
                        <td key={c} className={typeof r[c] === 'number' ? 'num' : ''}>
                          {c === 'experiment_id' && r[c] != null ? (
                            <Link to={`/e/${String(r[c])}`}>{String(r[c])}</Link>
                          ) : (
                            fmtNum(r[c])
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
