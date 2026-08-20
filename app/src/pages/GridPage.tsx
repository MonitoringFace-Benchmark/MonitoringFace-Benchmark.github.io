import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import MiniSearch from 'minisearch';
import { loadIndex } from '../lib/data';
import type { ExperimentCard } from '../lib/types';
import DataSearch from '../components/DataSearch';

export default function GridPage() {
  const [cards, setCards] = useState<ExperimentCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  // null = no data predicate active; otherwise the matching experiment ids
  const [dataMatch, setDataMatch] = useState<Set<string> | null>(null);

  useEffect(() => {
    loadIndex()
      .then((idx) => setCards(idx.experiments))
      .catch((e) => setError(String(e)));
  }, []);

  const mini = useMemo(() => {
    if (!cards) return null;
    const ms = new MiniSearch<{ id: string; name: string; description: string; tools: string }>({
      fields: ['name', 'description', 'tools'],
      storeFields: ['id'],
      searchOptions: { prefix: true, fuzzy: 0.2, boost: { name: 2 } },
    });
    ms.addAll(
      cards.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        tools: c.tools.join(' '),
      })),
    );
    return ms;
  }, [cards]);

  const visible = useMemo(() => {
    if (!cards) return [];
    let out = cards;
    if (text.trim() && mini) {
      const hits = new Set(mini.search(text).map((h) => h.id as string));
      out = out.filter((c) => hits.has(c.id));
    }
    if (dataMatch) out = out.filter((c) => dataMatch.has(c.id));
    return out;
  }, [cards, text, mini, dataMatch]);

  if (error) return <div className="error-box">Failed to load index: {error}</div>;
  if (!cards) return <p className="muted">Loading experiments…</p>;

  const allTools = [...new Set(cards.flatMap((c) => c.tools))].sort();

  return (
    <>
      <h1>Experiments</h1>
      <p className="muted">
        {cards.length} experiments · search by name, or query the actual run data below.
      </p>
      <div className="searchbar">
        <input
          type="text"
          placeholder="Search experiments by name, description, tool…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <DataSearch tools={allTools} onMatch={setDataMatch} />
      {dataMatch && (
        <div className="notice">
          Data query matches {visible.length} of {cards.length} experiments.{' '}
          <button className="btn" onClick={() => setDataMatch(null)}>clear</button>
        </div>
      )}
      <div className="card-grid">
        {visible.map((c) => (
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
              {c.fastest_tool && <span className="chip fastest">fastest: {c.fastest_tool}</span>}
              {c.has_provenance && (
                <span className="chip OK" title="exact final tool inputs stored with conversion manifests">
                  provenance
                </span>
              )}
              <span className="chip tool">{c.tools.length} tools</span>
              <span className="chip tool">{c.n_runs} runs</span>
              {c.run_timestamp && (
                <span className="muted small">{c.run_timestamp.slice(0, 10)}</span>
              )}
            </div>
          </Link>
        ))}
      </div>
      {visible.length === 0 && <p className="muted">No experiments match.</p>}
    </>
  );
}

function firstLine(md: string): string {
  return md
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter(Boolean)[0] ?? '';
}
