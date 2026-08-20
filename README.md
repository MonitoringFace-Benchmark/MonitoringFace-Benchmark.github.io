# MonitoringFace results website

A fully static site that presents MonitoringFace experiment results: a
searchable grid of experiments, per-experiment result tables with provenance,
a file browser over the input data with per-run selection and zip export, and
an embedded graphic-walker workbench for self-service analysis. Search can
query the actual run data ("experiments where tool X timed out", "where tool X
is fastest") via DuckDB-WASM over a cross-experiment parquet file, so no
backend is needed; the whole site deploys to GitHub Pages.

## Layout

- `ingest/mfsite.py`  the only publish path. Packages a results directory
  (plus its experiment YAML and input tree) into a site bundle and regenerates
  the global index. Normalizes at ingest: `Status.OK` enum reprs, the
  positional `Setting` id split into sweep factors, `max_mem` KB, `cpu`
  percent strings, multi-line stack-trace CSV cells.
- `app/`  Vite + React + TypeScript SPA (hash routing, so no 404 tricks on
  Pages). `app/public/site-data/` holds the published bundles and IS
  committed: pushing to main deploys them.
- `.github/workflows/deploy.yml`  builds and deploys to GitHub Pages on every
  push to main. Enforces the no-LFS rule and the Pages size budgets first.

## Publish an experiment

```bash
cd ingest
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt   # once
./.venv/bin/python mfsite.py publish \
  --results <MonitoringFace>/Infrastructure/results/<run_dir> \
  --configs <MonitoringFace>/Archive/Experiments \
  --suite <MonitoringFace>/Archive/Experiments/benchmark_paper/eval.yaml \
  --inputs-root <MonitoringFace>/Infrastructure/experiments \
  --out ../app/public/site-data
```

Then commit the new bundle and push; CI validates and deploys it.

Suite directories (one subfolder per experiment) and single-experiment result
directories are both handled. Input files up to `--inline-limit-mb` (default
5 MB) are copied into the bundle; larger ones (the 823 MB Nokia trace, the
266 MB oracle `.res` files) are recorded in `filetree.json` with size and
sha256 as `external`, to be attached to a GitHub Release for download-only
access. Release assets are CORS-blocked for in-browser reads (verified 2026),
so the site never `fetch()`es them; they appear in the file browser as
download entries and in exports via `EXTERNAL_FILES.txt`.

## Run the site locally

```bash
cd app
bun install
bun run dev        # http://localhost:5173  (npm/pnpm work too)
```

`bun run build` produces `dist/` exactly as Pages serves it;
`bun run preview` serves that build. `bun run typecheck` runs tsc.

## Data model

- `site-data/index/experiments.json`  grid cards with precomputed aggregates
  (status counts, per-tool medians, fastest tool). MiniSearch runs over this
  for instant name/description search; no WASM on the landing path.
- `site-data/index/runs.parquet`  one denormalized row per run across all
  experiments (provenance columns joined from the YAML). Every data-predicate
  search is a single DuckDB-WASM query against this file, fetched via HTTP
  range requests. GitHub Pages serves ranges with `Access-Control-Allow-
  Origin: *`, which is what makes this work.
- `site-data/experiments/<id>/`  `manifest.json` (monitors with commit,
  branch, params; fingerprint sha256 triple; status-file inventory; setting
  schema), `runs.parquet` (full rows including error text), `description.md`,
  `filetree.json`, `files/…` (inline input data).

DuckDB-WASM uses the single-threaded async bundle: Pages cannot set
COOP/COEP headers, so the pthreads build is not an option. graphic-walker
loads lazily when the Analysis tab first opens and currently receives the
run-level rows in memory (hundreds of rows per experiment). When online
experiments with exploded per-step `output_pairs` series are added, feed it
through its `computation` prop backed by DuckDB instead, and downsample the
series at ingest; raw per-step data in browser memory is a tab-killer at
Nokia scale.

## Size budgets (GitHub Pages)

Hard limits: 100 MiB per file, 1 GB published site, 100 GB/month soft
bandwidth. The CI template fails the build at 95 MiB per file and 900 MiB
total. Never use Git LFS in the site repo: Pages serves LFS pointer files,
silently. The app itself contributes ~77 MB (both DuckDB WASM bundles; a
browser downloads only one). Overflow strategy when the corpus outgrows the
budget: move cold experiment bundles' parquet to Hugging Face datasets or
Cloudflare R2 (both serve Range + CORS) and keep only indexes and aggregates
on Pages.
