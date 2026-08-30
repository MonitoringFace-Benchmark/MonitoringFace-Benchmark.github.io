import { useEffect, useMemo, useState } from 'react';
import MiniSearch from 'minisearch';
import { loadIndex } from '../lib/data';
import type { ExperimentCard, Suite } from '../lib/types';
import DataSearch from '../components/DataSearch';
import { ExperimentCardView, SuiteCardView } from '../components/ExperimentCard';

interface SearchDoc {
  id: string; // 'e:<id>' or 's:<id>'
  name: string;
  description: string;
  tools: string;
}

export default function GridPage() {
  const [cards, setCards] = useState<ExperimentCard[] | null>(null);
  const [suites, setSuites] = useState<Suite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  // null = no data predicate active; otherwise the matching experiment ids
  const [dataMatch, setDataMatch] = useState<Set<string> | null>(null);

  useEffect(() => {
    loadIndex()
      .then((idx) => {
        setCards(idx.experiments);
        setSuites(idx.suites ?? []);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const mini = useMemo(() => {
    if (!cards) return null;
    const ms = new MiniSearch<SearchDoc>({
      fields: ['name', 'description', 'tools'],
      storeFields: ['id'],
      searchOptions: { prefix: true, fuzzy: 0.2, boost: { name: 2 } },
    });
    ms.addAll(
      cards.map((c) => ({
        id: `e:${c.id}`,
        name: c.name,
        description: c.description,
        tools: c.tools.join(' '),
      })),
    );
    ms.addAll(
      suites.map((s) => ({
        id: `s:${s.id}`,
        name: s.name,
        description: s.description,
        tools: s.members.join(' '),
      })),
    );
    return ms;
  }, [cards, suites]);

  const { visibleCards, visibleSuites, matchTotal } = useMemo(() => {
    if (!cards) return { visibleCards: [], visibleSuites: [], matchTotal: 0 };
    const membersOf = new Map(suites.map((s) => [s.id, new Set(s.members)]));
    let expHits: Set<string> | null = null;
    let suiteHits: Set<string> | null = null;
    if (text.trim() && mini) {
      expHits = new Set();
      suiteHits = new Set();
      for (const h of mini.search(text)) {
        const id = h.id as string;
        if (id.startsWith('e:')) expHits.add(id.slice(2));
        else suiteHits.add(id.slice(2));
      }
    }
    const cardVisible = (c: ExperimentCard) =>
      (!expHits || expHits.has(c.id)) && (!dataMatch || dataMatch.has(c.id));
    // a suite shows when the suite itself matches the text, or any member
    // passes the text/data filters
    const suiteVisible = (s: Suite) => {
      const members = cards.filter((c) => membersOf.get(s.id)?.has(c.id));
      const memberPasses = members.some(
        (c) => (!expHits || expHits.has(c.id)) && (!dataMatch || dataMatch.has(c.id)),
      );
      const textOk = !expHits || suiteHits?.has(s.id) || memberPasses;
      const dataOk = !dataMatch || members.some((c) => dataMatch.has(c.id));
      return textOk && dataOk;
    };
    const visibleSuites = suites.filter(suiteVisible);
    // suite members live inside their suite card, not at the top level
    const visibleCards = cards.filter((c) => !c.suite_id && cardVisible(c));
    return {
      visibleCards,
      visibleSuites,
      matchTotal: visibleCards.length + visibleSuites.length,
    };
  }, [cards, suites, text, mini, dataMatch]);

  if (error) return <div className="error-box">Failed to load index: {error}</div>;
  if (!cards) return <p className="muted">Loading experiments…</p>;

  const allTools = [...new Set(cards.flatMap((c) => c.tools))].sort();
  const totalEntries = cards.filter((c) => !c.suite_id).length + suites.length;

  return (
    <>
      <h1>Experiments</h1>
      <p className="muted">
        {cards.length} experiments{suites.length > 0 && ` in ${totalEntries} entries (${suites.length} suites)`}
        {' '}· search by name, or query the actual run data below.
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
          Data query matches {matchTotal} of {totalEntries} entries.{' '}
          <button className="btn" onClick={() => setDataMatch(null)}>clear</button>
        </div>
      )}
      <div className="card-grid">
        {visibleSuites.map((s) => (
          <SuiteCardView key={s.id} s={s} />
        ))}
        {visibleCards.map((c) => (
          <ExperimentCardView key={c.id} c={c} />
        ))}
      </div>
      {matchTotal === 0 && <p className="muted">No experiments match.</p>}
    </>
  );
}
