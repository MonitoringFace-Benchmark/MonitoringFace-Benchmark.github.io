import { Link } from 'react-router-dom';
import type { ExperimentCard as Card, Suite } from '../lib/types';

export function firstLine(md: string): string {
  return md
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter(Boolean)[0] ?? '';
}

export function ExperimentCardView({ c }: { c: Card }) {
  return (
    <Link key={c.id} to={`/e/${c.id}`} className="card">
      <div className="card-title">{c.name}</div>
      <div className="card-desc">{firstLine(c.description) || 'No description.'}</div>
      <div className="chip-row">
        {Object.entries(c.status_counts).map(([s, n]) => (
          <span key={s} className={`chip ${s}`}>
            {s} {n}
          </span>
        ))}
      </div>
      <div className="chip-row">
        {c.has_provenance && (
          <span className="chip OK" title="exact final tool inputs stored with conversion manifests">
            provenance
          </span>
        )}
        <span className="chip tool">{c.tools.length} tools</span>
        <span className="chip tool">{c.n_runs} runs</span>
        {c.run_timestamp && <span className="muted small">{c.run_timestamp.slice(0, 10)}</span>}
      </div>
    </Link>
  );
}

export function SuiteCardView({ s }: { s: Suite }) {
  return (
    <Link key={s.id} to={`/s/${s.id}`} className="card suite-card">
      <div className="card-title">
        <span className="suite-badge">suite</span> {s.name}
      </div>
      <div className="card-desc">
        {firstLine(s.description) || `${s.members.length} experiments published together.`}
      </div>
      <div className="chip-row">
        {Object.entries(s.status_counts).map(([st, n]) => (
          <span key={st} className={`chip ${st}`}>
            {st} {n}
          </span>
        ))}
      </div>
      <div className="chip-row">
        <span className="chip tool">{s.members.length} members</span>
        <span className="chip tool">{s.n_runs} runs</span>
        {s.run_timestamp && <span className="muted small">{s.run_timestamp.slice(0, 10)}</span>}
      </div>
    </Link>
  );
}
