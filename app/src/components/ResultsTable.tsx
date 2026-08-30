import { useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import type { QueryResult } from '../lib/duckdb';
import { fmtNum } from '../lib/data';

const PREFERRED_ORDER = [
  'status', 'tool_name', 'setting', 'runtime_s', 'wall_time_s', 'pre_s',
  'compilation_s', 'post_s', 'mem_mb', 'cpu_pct', 'timeout_s',
];
const HIDDEN = new Set(['experiment_id', 'status_class', 'params_json', 'error',
  'max_mem_kb', 'num_operators', 'num_fvs', 'num_setting', 'data_set_size',
  'repetition', 'tool_id', 'commit', 'branch', 'has_provenance']);

type Row = Record<string, unknown>;

export default function ResultsTable({
  result,
  unhide = [],
}: {
  result: QueryResult;
  unhide?: string[];
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  // keyed by TanStack row id, which is stable under sorting and filtering
  const [expanded, setExpanded] = useState<string | null>(null);

  const statuses = useMemo(
    () => [...new Set(result.rows.map((r) => String(r.status)))].sort(),
    [result],
  );

  const rows = useMemo(
    () =>
      statusFilter === 'all'
        ? result.rows
        : result.rows.filter((r) => r.status === statusFilter),
    [result, statusFilter],
  );

  const columns = useMemo(() => {
    const helper = createColumnHelper<Row>();
    // drop columns that are entirely empty for this experiment (e.g.
    // input_unchanged on bundles published without provenance)
    const hasValue = (c: string) =>
      result.rows.some((r) => r[c] !== null && r[c] !== undefined);
    const hidden = (c: string) => HIDDEN.has(c) && !unhide.includes(c);
    const visible = [
      ...unhide.filter((c) => result.columns.includes(c) && hasValue(c)),
      ...PREFERRED_ORDER.filter((c) => result.columns.includes(c) && hasValue(c)),
      ...result.columns.filter(
        (c) => !PREFERRED_ORDER.includes(c) && !hidden(c) && !unhide.includes(c) && hasValue(c),
      ),
    ];
    return visible.map((c) =>
      // null -> undefined + sortUndefined so timed-out/errored runs with no
      // runtime never rank as "fastest" when sorting ascending
      helper.accessor((row) => row[c] ?? undefined, {
        id: c,
        header: c,
        sortUndefined: 'last',
        cell: (info) =>
          c === 'status' ? (
            <span className={`chip ${String(info.getValue())}`}>{String(info.getValue())}</span>
          ) : (
            fmtNum(info.getValue())
          ),
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, unhide.join(',')]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <div className="chip-row" style={{ marginBottom: 10 }}>
        <button
          className={`btn ${statusFilter === 'all' ? 'primary' : ''}`}
          onClick={() => setStatusFilter('all')}
        >
          all ({result.rows.length})
        </button>
        {statuses.map((s) => (
          <button
            key={s}
            className={`btn ${statusFilter === s ? 'primary' : ''}`}
            onClick={() => setStatusFilter(s)}
          >
            {s} ({result.rows.filter((r) => r.status === s).length})
          </button>
        ))}
        <span className="muted small">click a row with an error to expand the stack trace</span>
      </div>
      <div className="tbl-wrap" style={{ maxHeight: 620, overflowY: 'auto' }}>
        <table className="tbl">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} onClick={h.column.getToggleSortingHandler()}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((r) => {
              const err = r.original.error as string | undefined;
              return (
                <FragmentRow
                  key={r.id}
                  colCount={columns.length}
                  err={err}
                  expanded={expanded === r.id}
                  onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                >
                  {r.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={typeof cell.getValue() === 'number' ? 'num' : ''}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </FragmentRow>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FragmentRow({
  children,
  colCount,
  err,
  expanded,
  onToggle,
}: {
  children: React.ReactNode;
  colCount: number;
  err?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr onClick={err ? onToggle : undefined} style={err ? { cursor: 'pointer' } : undefined}>
        {children}
      </tr>
      {expanded && err && (
        <tr>
          <td colSpan={colCount}>
            <div className="error-full">{err}</div>
          </td>
        </tr>
      )}
    </>
  );
}
