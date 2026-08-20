import { lazy, Suspense, useMemo, type ComponentType } from 'react';
import type { ILocalVizAppProps } from '@kanaries/graphic-walker';
import type { QueryResult } from '../lib/duckdb';

// graphic-walker is ~MBs of JS; load it only when the Analysis tab opens.
// The cast pins the overloaded component to its local-computation signature,
// which React.lazy would otherwise collapse to the remote one.
const GraphicWalker = lazy(() =>
  import('@kanaries/graphic-walker').then((m) => ({
    default: m.GraphicWalker as unknown as ComponentType<ILocalVizAppProps>,
  })),
);
import '@kanaries/graphic-walker/dist/style.css';

const DIMENSIONS = new Set([
  'status', 'status_class', 'tool_name', 'tool_id', 'setting', 'commit',
  'branch', 'params_json', 'experiment_id', 'num_operators', 'num_fvs',
  'num_setting', 'data_set_size', 'repetition', 'instruction_index',
]);

export default function AnalysisView({ result }: { result: QueryResult }) {
  const { rows, fields } = useMemo(() => {
    // Full error texts are noise for charting and bloat the walker's rows.
    const cols = result.columns.filter((c) => c !== 'error');
    const rows = result.rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of cols) o[c] = r[c];
      return o;
    });
    const fields = cols.map((c) => {
      const sample = result.rows.find((r) => r[c] !== null && r[c] !== undefined)?.[c];
      const numeric = typeof sample === 'number' && !DIMENSIONS.has(c);
      return {
        fid: c,
        name: c,
        semanticType: numeric ? ('quantitative' as const) : ('nominal' as const),
        analyticType: numeric ? ('measure' as const) : ('dimension' as const),
      };
    });
    return { rows, fields };
  }, [result]);

  return (
    <div className="gw-wrap">
      <Suspense fallback={<p className="muted">Loading analysis workbench…</p>}>
        <GraphicWalker data={rows} fields={fields} appearance="light" />
      </Suspense>
    </div>
  );
}
