#!/usr/bin/env python3
"""mfsite - package MonitoringFace experiment results into static site bundles.

Usage:
  python mfsite.py publish --results <results_dir> --configs <configs_root> \
      [--suite <suite.yaml>] [--inputs-root <experiments_root>] \
      --out <site-data_dir> [--inline-limit-mb 5]

A results dir is either a single experiment (status CSVs directly inside) or a
suite run (one subdirectory per experiment). For each experiment this emits:

  out/experiments/<id>/manifest.json    provenance + file inventory
  out/experiments/<id>/runs.parquet     normalized per-run table (full error text)
  out/experiments/<id>/description.md
  out/experiments/<id>/filetree.json    input-data tree with hosting classes
  out/experiments/<id>/files/...        input files <= inline limit, mirrored

and regenerates the global index over every bundle present in out/:

  out/index/runs.parquet        one row per run across all experiments (no error text)
  out/index/experiments.json    grid cards + precomputed aggregates
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yaml

csv.field_size_limit(sys.maxsize)

SCHEMA_VERSION = 1

STATUS_SUFFIXES = {
    "valid": "valid",
    "timeout": "timeout",
    "tool_error": "tool_error",
    "result_error": "result_error",
    "missing": "missing",
    "timeout_accumulative_latency": "timeout_accumulative_latency",
    "timeout_maximum_latency": "timeout_maximum_latency",
}

# Columns whose values are float seconds in the aggregator CSVs.
SECONDS_COLS = {"pre", "compilation", "runtime", "post", "wall_time", "build",
                "total_elapsed", "timeout"}

SETTING_PARTS_OFFLINE = ["num_operators", "num_fvs", "num_setting",
                         "data_set_size", "repetition"]


def status_csvs(d: Path) -> list[Path]:
    """CSVs in d whose name matches an aggregator status suffix. Suite-vs-
    single detection must use THIS, not any *.csv: stray analysis CSVs at the
    top of a suite dir would otherwise hijack it into single-experiment mode
    and silently drop every real experiment."""
    return [f for f in d.glob("*.csv")
            if any(f.stem.endswith(f"_{s}") for s in STATUS_SUFFIXES)]


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def clean_status(raw: str) -> str:
    """'Status.OK' -> 'OK' (the CSVs store Python enum reprs)."""
    return raw.split(".", 1)[1] if raw.startswith("Status.") else raw


def parse_cpu(raw: str | None) -> float | None:
    """'384%' -> 384.0; keeps None for absent values."""
    if raw is None or raw == "":
        return None
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*%", raw)
    return float(m.group(1)) if m else None


def split_setting(setting: str) -> dict:
    """Split the positional Setting id. Five numeric parts is the offline
    synthetic schema (ops_fvs_setting_datasize_rep); two parts is the
    case-study/online schema (instruction_rep). Anything else stays raw."""
    parts = setting.split("_")
    out: dict = {}
    if len(parts) == 5 and all(p.isdigit() for p in parts):
        out.update({k: int(v) for k, v in zip(SETTING_PARTS_OFFLINE, parts)})
    elif len(parts) == 2 and all(p.isdigit() for p in parts):
        out.update({"instruction_index": int(parts[0]), "repetition": int(parts[1])})
    return out


def read_status_csv(path: Path) -> list[dict]:
    """Read one aggregator CSV with a real CSV parser (error cells contain
    multi-line quoted stack traces)."""
    with path.open(newline="", encoding="utf-8", errors="replace") as f:
        return list(csv.DictReader(f))


def load_experiment_yaml(configs_root: Path, stem: str,
                         hint: str | None = None) -> tuple[dict, Path | None]:
    """Resolve the experiment config. A suite YAML's `path` entry (hint) wins;
    otherwise fall back to searching by stem, loudly on ambiguity or absence,
    since a wrong config publishes wrong provenance."""
    if hint:
        p = configs_root / hint
        if p.is_file():
            with p.open() as f:
                return yaml.safe_load(f) or {}, p
        print(f"  WARNING: suite names config {hint} but it does not exist; "
              f"falling back to search")
    hits = sorted(configs_root.rglob(f"{stem}.yaml"))
    if not hits:
        print(f"  WARNING: no config YAML found for '{stem}'; publishing "
              f"without provenance (no monitors/commits/seeds)")
        return {}, None
    if len(hits) > 1:
        print(f"  WARNING: {len(hits)} configs match '{stem}.yaml'; using "
              f"{hits[0]} (candidates: {', '.join(str(h) for h in hits)})")
    with hits[0].open() as f:
        return yaml.safe_load(f) or {}, hits[0]


def monitor_table(config: dict) -> list[dict]:
    mons = []
    for m in config.get("monitors", []) or []:
        mons.append({
            "name": m.get("name"),
            "identifier": m.get("identifier"),
            "commit": m.get("commit"),
            "branch": m.get("branch"),
            "params": m.get("params") or {},
        })
    return mons


def build_runs_frame(exp_dir: Path, exp_id: str, monitors: list[dict],
                     status_inventory: dict) -> pd.DataFrame:
    """Normalize every status CSV of one experiment into a single frame."""
    mon_by_name = {m["name"]: m for m in monitors}
    rows: list[dict] = []
    for f in sorted(exp_dir.glob("*.csv")):
        suffix = None
        for s in STATUS_SUFFIXES:
            if f.stem.endswith(f"_{s}"):
                # longest-suffix match: timeout_accumulative_latency also ends in
                # a shorter candidate, so keep the longest hit
                if suffix is None or len(s) > len(suffix):
                    suffix = s
        if suffix is None:
            continue
        recs = read_status_csv(f)
        status_inventory[suffix] = len(recs)
        for r in recs:
            row: dict = {
                "experiment_id": exp_id,
                "status": clean_status(r.get("Status", "")),
                "status_class": suffix,
                "tool_name": r.get("Name"),
                "setting": r.get("Setting"),
            }
            row.update(split_setting(r.get("Setting", "") or ""))
            for col in ("pre", "compilation", "runtime", "post", "wall_time",
                        "build", "total_elapsed", "timeout"):
                if col in r and r[col] not in (None, ""):
                    try:
                        row[f"{col}_s"] = float(r[col])
                    except ValueError:
                        pass
            if r.get("max_mem") not in (None, ""):
                try:
                    kb = int(float(r["max_mem"]))
                    row["max_mem_kb"] = kb
                    row["mem_mb"] = round(kb / 1024.0, 2)
                except ValueError:
                    pass
            if "cpu" in r:
                row["cpu_pct"] = parse_cpu(r.get("cpu"))
            if r.get("total_count") not in (None, ""):
                try:
                    row["total_count"] = int(float(r["total_count"]))
                except ValueError:
                    pass
            # Online runs have no `runtime` stage; total_elapsed is their
            # monitoring-time analog. A canonical runtime_s in every bundle
            # keeps the "fastest tool" ranking defined for the online family.
            if "runtime_s" not in row and "total_elapsed_s" in row:
                row["runtime_s"] = row["total_elapsed_s"]
            err = r.get("error") or r.get("error_msg")
            if err:
                row["error"] = err
            mon = mon_by_name.get(row["tool_name"] or "")
            if mon:
                row["tool_id"] = mon["identifier"]
                row["commit"] = mon["commit"]
                row["branch"] = mon.get("branch")
                row["params_json"] = json.dumps(mon["params"], sort_keys=True)
            rows.append(row)
    df = pd.DataFrame(rows)
    # An experiment with zero rows must still carry the core schema: a
    # 0-column parquet would crash every later rebuild_index over this out dir.
    for c in ("experiment_id", "status", "status_class", "tool_name", "setting"):
        if c not in df.columns:
            df[c] = pd.Series(dtype="object")
    # Keep the sweep factors as nullable ints so mixed experiments still concat.
    for c in SETTING_PARTS_OFFLINE + ["instruction_index", "max_mem_kb", "total_count"]:
        if c in df.columns:
            df[c] = df[c].astype("Int64")
    return df


def ingest_file_tree(inputs_dir: Path, bundle_dir: Path,
                     inline_limit: int) -> dict:
    """Walk the experiment input tree; copy files <= inline_limit into the
    bundle, record everything (with hosting class + sha256) in a nested tree."""
    files_root = bundle_dir / "files"

    def walk(d: Path, rel: Path) -> dict:
        children = []
        for entry in sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name)):
            if entry.name == ".DS_Store" or entry.is_symlink():
                continue
            r = rel / entry.name
            if entry.is_dir():
                children.append(walk(entry, r))
            else:
                size = entry.stat().st_size
                node = {"name": entry.name, "path": str(r), "kind": "file",
                        "size": size}
                if size <= inline_limit:
                    node["hosting"] = "inline"
                    dest = files_root / r
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(entry, dest)
                else:
                    node["hosting"] = "external"
                    node["sha256"] = sha256_file(entry)
                children.append(node)
        return {"name": rel.name or inputs_dir.name, "path": str(rel),
                "kind": "dir", "children": children}

    tree = walk(inputs_dir, Path())
    tree["name"] = inputs_dir.name
    tree["path"] = ""  # str(Path()) is "."; the frontend's root sentinel is ""
    return tree


def ingest_provenance(exp_dir: Path, bundle: Path, inline_limit: int) -> tuple[list, dict | None]:
    """Ingest results/<run>/provenance/ (written by the platform's
    --provenance flag) into the bundle under files/provenance/, verifying
    every manifest pointer and hash. Returns (index entries, a filetree
    subtree node). Both are empty/None when the results dir has no
    provenance, which keeps pre-provenance bundles fully valid."""
    prov_root = exp_dir / "provenance"
    if not prov_root.is_dir():
        return [], None

    index: list = []
    setting_nodes: list = []
    # dot-dirs are tmp litter from a crashed platform capture, never data
    for sk_dir in sorted(p for p in prov_root.iterdir()
                         if p.is_dir() and not p.name.startswith(".")):
        tool_nodes: list = []
        for tool_dir in sorted(p for p in sk_dir.iterdir()
                               if p.is_dir() and not p.name.startswith(".")):
            manifest_file = tool_dir / "provenance.json"
            if not manifest_file.is_file():
                sys.exit(f"provenance dir without manifest: {tool_dir}")
            manifest = json.loads(manifest_file.read_text())

            # the never-dangles guarantee extends to the site: refuse a bundle
            # whose manifest points at a missing or hash-mismatched file
            for entry in manifest.get("entries", []):
                stored = entry.get("stored")
                if not stored:
                    continue
                f = tool_dir / stored["file"]
                if not f.is_file():
                    sys.exit(f"provenance manifest {manifest_file} points at "
                             f"missing file {stored['file']}")
                if sha256_file(f) != stored["sha256"]:
                    sys.exit(f"provenance hash mismatch for {f}: bundle refused")

            rel_dir = f"provenance/{sk_dir.name}/{tool_dir.name}"
            dest = bundle / "files" / rel_dir
            dest.mkdir(parents=True, exist_ok=True)
            file_nodes: list = []
            for f in sorted(tool_dir.iterdir()):
                if not f.is_file() or f.name == ".DS_Store":
                    continue
                size = f.stat().st_size
                node = {"name": f.name, "path": f"{rel_dir}/{f.name}",
                        "kind": "file", "size": size}
                # the manifest is the panel's data source: always ship it,
                # independent of the inline limit
                if f.name == "provenance.json" or size <= inline_limit:
                    node["hosting"] = "inline"
                    shutil.copy2(f, dest / f.name)
                else:
                    node["hosting"] = "external"
                    node["sha256"] = sha256_file(f)
                file_nodes.append(node)

            tool_nodes.append({"name": tool_dir.name, "path": rel_dir,
                               "kind": "dir", "children": file_nodes})
            index.append({
                "setting_key": manifest.get("setting_key", sk_dir.name),
                "tool": (manifest.get("tool") or {}).get("name", tool_dir.name),
                "dir": rel_dir,
                "input_unchanged_after_run": manifest.get("input_unchanged_after_run"),
                "captures": manifest.get("captures"),
                "kinds": [e.get("kind") for e in manifest.get("entries", [])],
                "stored_kinds": [e.get("kind") for e in manifest.get("entries", [])
                                 if e.get("stored")],
            })
        setting_nodes.append({"name": sk_dir.name, "path": f"provenance/{sk_dir.name}",
                              "kind": "dir", "children": tool_nodes})

    subtree = {"name": "provenance", "path": "provenance", "kind": "dir",
               "children": setting_nodes}
    return index, subtree


def read_fingerprint(inputs_dir: Path) -> dict:
    fp = inputs_dir / "fingerprint"
    out = {}
    if fp.is_file():
        for line in fp.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def publish_experiment(exp_dir: Path, exp_id: str, out: Path, configs_root: Path,
                       inputs_root: Path | None, description: str,
                       run_timestamp: str | None, inline_limit: int,
                       config_hint: str | None = None) -> None:
    final_bundle = out / "experiments" / exp_id
    old_description = None
    if final_bundle.exists():
        # A republish without --suite must not wipe a previously set description.
        desc_file = final_bundle / "description.md"
        if desc_file.is_file():
            old_description = desc_file.read_text()
    # Stage into a hidden sibling and swap only after every validation and
    # write succeeded: a refused publish (e.g. a provenance hash mismatch)
    # must never destroy the previously published bundle.
    bundle = out / "experiments" / f".tmp_{exp_id}"
    if bundle.exists():
        shutil.rmtree(bundle)
    bundle.mkdir(parents=True)

    config, config_path = load_experiment_yaml(configs_root, exp_id, config_hint)
    monitors = monitor_table(config)
    status_inventory: dict = {}
    runs = build_runs_frame(exp_dir, exp_id, monitors, status_inventory)

    filetree = None
    fingerprint = {}
    inputs_dir = (inputs_root / exp_id) if inputs_root else None
    if inputs_dir and inputs_dir.is_dir():
        filetree = ingest_file_tree(inputs_dir, bundle, inline_limit)
        fingerprint = read_fingerprint(inputs_dir)

    prov_index, prov_subtree = ingest_provenance(exp_dir, bundle, inline_limit)
    if prov_subtree is not None:
        if filetree is None:
            filetree = {"name": exp_id, "path": "", "kind": "dir", "children": []}
        if any(c.get("name") == "provenance" for c in filetree.get("children", [])):
            sys.exit(f"input tree of {exp_id} has a top-level 'provenance' "
                     f"directory, which collides with the grafted provenance "
                     f"subtree; rename it before publishing")
        filetree["children"].append(prov_subtree)
    if filetree is not None:
        (bundle / "filetree.json").write_text(json.dumps(filetree, indent=1))

    # per-run provenance flags, joined on (tool, setting minus repeat index)
    prov_by_key = {(p["tool"], p["setting_key"]): p for p in prov_index}
    if len(runs):
        def _prov_of(row):
            setting = str(row.get("setting") or "")
            key = setting.rsplit("_", 1)[0] if "_" in setting else setting
            return prov_by_key.get((row.get("tool_name"), key))
        matches = runs.apply(_prov_of, axis=1)
        runs["has_provenance"] = matches.notna()
        runs["input_unchanged"] = matches.map(
            lambda p: p.get("input_unchanged_after_run") if isinstance(p, dict) else None
        ).astype("boolean")
    else:
        runs["has_provenance"] = pd.Series(dtype="bool")
        runs["input_unchanged"] = pd.Series(dtype="boolean")
    runs.to_parquet(bundle / "runs.parquet", index=False)

    setting_kind = "offline_synthetic" if "num_operators" in runs.columns else \
        ("instruction" if "instruction_index" in runs.columns else "raw")
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "id": exp_id,
        "name": exp_id.replace("_", " "),
        "run_timestamp": run_timestamp,
        "runtime_setting": config.get("runtime_setting", "offline"),
        "timeout_s": (config.get("runtime_constraints") or {}).get("upper_bound"),
        # relative to configs_root: absolute paths would leak the local
        # machine's username into the published manifest
        "config_file": str(config_path.relative_to(configs_root))
        if config_path else None,
        "monitors": monitors,
        "oracles": config.get("oracles") or [],
        "status_files": status_inventory,
        "n_runs": int(len(runs)),
        "setting_schema": {
            "kind": setting_kind,
            "dir_template": "operators_{num_operators}/free_vars_{num_fvs}/num_{num_setting}"
            if setting_kind == "offline_synthetic" else None,
        },
        "fingerprint": fingerprint,
        "has_filetree": filetree is not None,
        "seeds": config.get("seeds") or {},
        "data_setup": config.get("data_setup") or {},
        "policy_setup": config.get("policy_setup") or {},
        "provenance": prov_index,
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest, indent=1))
    (bundle / "description.md").write_text(
        description or old_description or f"# {manifest['name']}\n")
    # everything succeeded: swap the staged bundle into place
    if final_bundle.exists():
        shutil.rmtree(final_bundle)
    bundle.rename(final_bundle)
    print(f"  bundled {exp_id}: {len(runs)} runs, "
          f"statuses {status_inventory}, filetree={'yes' if filetree else 'no'}, "
          f"provenance={len(prov_index)} entries")


def rebuild_index(out: Path) -> None:
    """Regenerate the global runs.parquet + experiments.json from every bundle
    currently present under out/experiments/."""
    exp_root = out / "experiments"
    index_dir = out / "index"
    index_dir.mkdir(parents=True, exist_ok=True)
    cards = []
    frames = []
    for bundle in sorted(p for p in exp_root.iterdir()
                         if p.is_dir() and not p.name.startswith(".")):
        if not (bundle / "manifest.json").is_file() or \
           not (bundle / "runs.parquet").is_file():
            print(f"  WARNING: skipping incomplete bundle {bundle.name} "
                  f"(interrupted publish? delete or republish it)")
            continue
        manifest = json.loads((bundle / "manifest.json").read_text())
        runs = pd.read_parquet(bundle / "runs.parquet")
        frames.append(runs.drop(columns=[c for c in ("error",) if c in runs.columns]))

        # "fastest" is a PAIRED comparison: only tools with maximal setting
        # coverage are eligible, and their medians are computed over the
        # settings they ALL solved. A tool that timed out somewhere must not
        # win by having dropped its hardest setting from its own median.
        if "runtime_s" in runs.columns:
            ok_runs = runs[(runs["status"] == "OK") & runs["runtime_s"].notna()]
        else:
            ok_runs = runs.iloc[0:0]
        coverage = {t: set(g["setting"]) for t, g in ok_runs.groupby("tool_name")}
        max_cov = max((len(s) for s in coverage.values()), default=0)
        eligible = sorted(t for t, s in coverage.items() if len(s) == max_cov) \
            if max_cov else []
        common = set.intersection(*(coverage[t] for t in eligible)) if eligible else set()
        common_med = ok_runs[
            ok_runs["tool_name"].isin(eligible) & ok_runs["setting"].isin(common)
        ].groupby("tool_name")["runtime_s"].median() if common else None
        fastest = str(common_med.idxmin()) if common_med is not None and len(common_med) else None

        per_tool = []
        for tool, grp in runs.groupby("tool_name"):
            g_ok = grp[grp["status"] == "OK"]
            per_tool.append({
                "tool": tool,
                "runs": int(len(grp)),
                "ok": int(len(g_ok)),
                # the whole timeout family: offline TO, online ATO/MTO
                "timeout": int(grp["status"].isin(("TO", "ATO", "MTO")).sum()),
                "tool_error": int((grp["status"] == "TE").sum()),
                "result_error": int((grp["status"] == "RE").sum()),
                "median_runtime_s": round(float(g_ok["runtime_s"].median()), 4)
                if "runtime_s" in g_ok.columns and len(g_ok) else None,
                "eligible": tool in eligible,
                "common_median_runtime_s": round(float(common_med[tool]), 4)
                if common_med is not None and tool in common_med.index else None,
                "fastest": tool == fastest,
            })

        desc = (bundle / "description.md").read_text().strip()
        cards.append({
            "id": manifest["id"],
            "name": manifest["name"],
            "description": desc,
            "run_timestamp": manifest.get("run_timestamp"),
            "runtime_setting": manifest.get("runtime_setting"),
            "timeout_s": manifest.get("timeout_s"),
            "n_runs": manifest.get("n_runs"),
            "tools": [m["name"] for m in manifest.get("monitors", [])],
            "status_counts": {
                s: int((runs["status"] == s).sum())
                for s in sorted(runs["status"].dropna().unique())
            },
            "per_tool": per_tool,
            "fastest_tool": fastest,
            "fastest_common_settings": len(common),
            "has_filetree": manifest.get("has_filetree", False),
            "has_provenance": bool(manifest.get("provenance")),
        })

    if frames:
        pd.concat(frames, ignore_index=True).to_parquet(
            index_dir / "runs.parquet", index=False)
    (index_dir / "experiments.json").write_text(json.dumps({
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "experiments": cards,
    }, indent=1))
    total = sum(c["n_runs"] for c in cards)
    print(f"  index: {len(cards)} experiments, {total} runs -> {index_dir}")


def parse_run_timestamp(results_dir: Path) -> str | None:
    m = re.search(r"(\d{8}_\d{6})$", results_dir.name)
    if not m:
        return None
    return datetime.strptime(m.group(1), "%Y%m%d_%H%M%S").isoformat()


def main() -> None:
    ap = argparse.ArgumentParser(prog="mfsite")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pub = sub.add_parser("publish", help="package a results dir into site bundles")
    pub.add_argument("--results", required=True, type=Path)
    pub.add_argument("--configs", required=True, type=Path,
                     help="root of the experiment YAMLs (e.g. Archive/Experiments)")
    pub.add_argument("--suite", type=Path, default=None,
                     help="suite YAML providing per-experiment descriptions")
    pub.add_argument("--inputs-root", type=Path, default=None,
                     help="root of experiment input trees (Infrastructure/experiments)")
    pub.add_argument("--out", required=True, type=Path)
    pub.add_argument("--inline-limit-mb", type=float, default=5.0)
    reidx = sub.add_parser("reindex", help="regenerate the global index over "
                           "the bundles already present in --out")
    reidx.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    if args.cmd == "reindex":
        rebuild_index(args.out)
        return

    descriptions: dict[str, str] = {}
    config_hints: dict[str, str] = {}
    if args.suite and args.suite.is_file():
        with args.suite.open() as f:
            suite = yaml.safe_load(f) or {}
        for e in suite.get("experiments", []) or []:
            stem = Path(e.get("path", "")).stem
            if stem:
                descriptions[stem] = e.get("description", "")
                config_hints[stem] = e.get("path", "")

    results: Path = args.results
    run_ts = parse_run_timestamp(results)
    if status_csvs(results):
        # single experiment: id from folder name minus timestamp
        exp_id = re.sub(r"_\d{8}_\d{6}$", "", results.name)
        targets = [(results, exp_id)]
    else:
        targets = [(d, d.name) for d in sorted(results.iterdir())
                   if d.is_dir() and status_csvs(d)]
    if not targets:
        sys.exit(f"no status CSVs found under {results}")

    inline_limit = int(args.inline_limit_mb * 1024 * 1024)
    print(f"publishing {len(targets)} experiment(s) from {results}")
    for exp_dir, exp_id in targets:
        publish_experiment(exp_dir, exp_id, args.out, args.configs,
                           args.inputs_root, descriptions.get(exp_id, ""),
                           run_ts, inline_limit,
                           config_hint=config_hints.get(exp_id))
    rebuild_index(args.out)


if __name__ == "__main__":
    main()
