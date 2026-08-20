// Lazy DuckDB-WASM singleton. GitHub Pages cannot set COOP/COEP headers, so
// only the single-threaded async bundles (mvp/eh) are usable; selectBundle
// picks eh where the browser supports exception handling.
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdbMvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdbMvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdbEhWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import duckdbEhWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { dataUrl } from './data';

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdbMvpWasm, mainWorker: duckdbMvpWorker },
  eh: { mainModule: duckdbEhWasm, mainWorker: duckdbEhWorker },
};

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) {
    const attempt = (async () => {
      const bundle = await duckdb.selectBundle(BUNDLES);
      const worker = new Worker(bundle.mainWorker!);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      const conn = await db.connect();
      // Global view over the cross-experiment runs table; every data-predicate
      // search is a query against this one parquet file.
      await conn.query(`CREATE OR REPLACE VIEW runs AS
        SELECT * FROM read_parquet('${dataUrl('index/runs.parquet')}')`);
      await conn.close();
      return db;
    })();
    // A failed init (offline, blocked WASM) must not be cached forever;
    // clearing the promise lets the next query retry from scratch.
    dbPromise = attempt.catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

function fromArrow(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return `<binary ${value.length}B>`;
  return value;
}

export async function query(sql: string): Promise<QueryResult> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const table = await conn.query(sql);
    const columns = table.schema.fields.map((f) => f.name);
    const rows = table.toArray().map((r) => {
      const obj = r.toJSON() as Record<string, unknown>;
      for (const k of Object.keys(obj)) obj[k] = fromArrow(obj[k]);
      return obj;
    });
    return { columns, rows };
  } finally {
    await conn.close();
  }
}

/** Runs of one experiment, straight from its bundle parquet. */
export function experimentRuns(id: string): Promise<QueryResult> {
  return query(
    `SELECT * FROM read_parquet('${dataUrl(`experiments/${id}/runs.parquet`)}')
     ORDER BY tool_name, setting`,
  );
}
