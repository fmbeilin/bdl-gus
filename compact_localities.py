#!/usr/bin/env python3
"""Merge the extractor's many small locality parts into a few large ones.

fetch_localities.py writes a new part every few variables (~1 MB each, a few hundred
a day), which makes anything that scans lake_v2/facts_localities slow. This merges
them into part-NNN.parquet files of about --target-mb each and writes manifest.json
(file -> variable range and row count) beside them.

Safe to run while the extractor is running:
  * only parts older than --min-age minutes are read, so a part being written is skipped;
  * merged output is written under a temporary name and renamed into place only after
    its row count and variable set match the inputs;
  * inputs are moved out only after that, so a crash leaves duplicates, never a gap;
  * merged files never reuse a number, and only one merge runs at a time.
Inputs are moved, not deleted, to --moved-to (default ~/bdl-localities-merged-inputs/<date>).

  python3 compact_localities.py               # one pass
  python3 compact_localities.py --loop 86400  # one pass a day, forever
"""
import argparse, datetime, fcntl, json, os, re, shutil, sys, tempfile, time
import pyarrow as pa, pyarrow.compute as pc, pyarrow.parquet as pq

SCHEMA = pa.schema([("variable_id", pa.int32()), ("unitId", pa.string()),
                    ("unitName", pa.string()), ("parent_gmina", pa.string()),
                    ("year", pa.int16()), ("value", pa.float64()),
                    ("attr_id", pa.int8())])
MERGED = re.compile(r"^part-(\d{3})\.parquet$")
ROWS_PER_GROUP = 2_000_000


def log(msg):
    print(f"[{datetime.datetime.now():%F %T}] {msg}", flush=True)


def is_local(path):
    """False for a Dropbox online-only placeholder, which cannot be read without a download."""
    st = os.stat(path)
    return st.st_blocks * 512 >= st.st_size * 0.5


def variables_of(path):
    pf = pq.ParquetFile(path)
    out = set()
    for i in range(pf.num_row_groups):
        out.update(pc.unique(pf.read_row_group(i, columns=["variable_id"])["variable_id"]).to_pylist())
    return out, pf.metadata.num_rows


def write_manifest(d):
    entries = []
    for f in sorted(os.listdir(d)):
        if not (f.startswith("part-") and f.endswith(".parquet")):
            continue
        md = pq.ParquetFile(os.path.join(d, f)).metadata
        col = md.schema.to_arrow_schema().get_field_index("variable_id")
        lo = min(md.row_group(i).column(col).statistics.min for i in range(md.num_row_groups))
        hi = max(md.row_group(i).column(col).statistics.max for i in range(md.num_row_groups))
        entries.append({"file": f"facts_localities/{f}", "var_min": lo, "var_max": hi,
                        "rows": md.num_rows, "merged": bool(MERGED.match(f))})
    tmp = os.path.join(d, ".manifest.json.tmp")
    with open(tmp, "w") as fh:
        json.dump({"facts_localities": entries}, fh, indent=1)
    os.replace(tmp, os.path.join(d, "manifest.json"))


def one_pass(root, target_mb, min_age, moved_to, dry_run):
    d = os.path.join(root, "lake_v2", "facts_localities")
    now = time.time()
    names = [f for f in os.listdir(d) if f.startswith("part-") and f.endswith(".parquet")]
    merged = sorted((int(MERGED.match(f).group(1)), f) for f in names if MERGED.match(f))
    small, skipped = [], []
    for f in names:
        if MERGED.match(f):
            continue
        p = os.path.join(d, f)
        if now - os.path.getmtime(p) < min_age * 60:
            continue
        (small if is_local(p) else skipped).append(f)
    if skipped:
        log(f"skipping {len(skipped)} online-only placeholder(s): {skipped[:3]}")
    if len(small) < 2:
        log(f"nothing to merge ({len(small)} small part(s), {len(merged)} merged)")
        write_manifest(d)
        return

    # Fill the last merged file up to the target before starting a new one.
    inputs = []
    if merged and os.path.getsize(os.path.join(d, merged[-1][1])) < target_mb * 1e6 * 0.9:
        inputs.append(merged[-1][1])

    # Order small parts by their lowest variable id, so each merged file covers a tight range.
    def low(f):
        md = pq.ParquetFile(os.path.join(d, f)).metadata
        c = md.schema.to_arrow_schema().get_field_index("variable_id")
        return min(md.row_group(i).column(c).statistics.min for i in range(md.num_row_groups))
    inputs += sorted(small, key=low)

    seen, rows_in, dup = {}, 0, {}
    for f in inputs:
        vs, n = variables_of(os.path.join(d, f))
        rows_in += n
        for v in vs:
            if v in seen:
                dup.setdefault(v, [seen[v]]).append(f)
            seen[v] = f
    if dup:
        log(f"REFUSING: {len(dup)} variable(s) appear in more than one input, e.g. "
            f"{list(dup.items())[:3]}. Resolve these before merging.")
        return
    total_mb = sum(os.path.getsize(os.path.join(d, f)) for f in inputs) / 1e6
    log(f"merging {len(inputs)} files ({total_mb:,.0f} MB, {rows_in:,} rows, {len(seen)} variables)")
    if dry_run:
        return

    next_n = (merged[-1][0] + 1) if merged else 0
    outs, writer, buf, buf_rows = [], None, [], 0

    def new_writer():
        tmp = os.path.join(d, f".merge-{os.getpid()}-{len(outs):03d}.parquet.tmp")
        outs.append(tmp)
        return pq.ParquetWriter(tmp, SCHEMA, compression="zstd", write_statistics=True)

    def flush_buf():
        nonlocal writer, buf, buf_rows
        if not buf_rows:
            return
        if writer is None:
            writer = new_writer()
        writer.write_table(pa.concat_tables(buf), row_group_size=ROWS_PER_GROUP)
        buf, buf_rows = [], 0
        if os.path.getsize(outs[-1]) >= target_mb * 1e6:
            writer.close()
            writer = None

    for f in inputs:
        pf = pq.ParquetFile(os.path.join(d, f))
        for i in range(pf.num_row_groups):
            t = pf.read_row_group(i).select(SCHEMA.names).cast(SCHEMA)
            buf.append(t)
            buf_rows += t.num_rows
            if buf_rows >= ROWS_PER_GROUP:
                flush_buf()
    flush_buf()
    if writer is not None:
        writer.close()

    seen_out, rows_out = set(), 0
    for p in outs:
        vs, n = variables_of(p)
        seen_out |= vs
        rows_out += n
    if rows_out != rows_in or seen_out != set(seen):
        log(f"VERIFY FAILED: rows {rows_in:,} in vs {rows_out:,} out; variables "
            f"{len(seen)} in vs {len(seen_out)} out. Inputs left in place; temp files kept: {outs}")
        return

    final = []
    for i, p in enumerate(outs):
        name = f"part-{next_n + i:03d}.parquet"
        os.replace(p, os.path.join(d, name))
        final.append(name)
    os.makedirs(moved_to, exist_ok=True)
    for f in inputs:
        shutil.move(os.path.join(d, f), os.path.join(moved_to, f))
    write_manifest(d)
    log(f"merged into {final} ({sum(os.path.getsize(os.path.join(d, f)) for f in final) / 1e6:,.0f} MB); "
        f"{len(inputs)} inputs moved to {moved_to}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.environ.get("BDL_ROOT") or os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--target-mb", type=float, default=256)
    ap.add_argument("--min-age", type=float, default=15, help="minutes; younger parts are left alone")
    ap.add_argument("--moved-to", default=None)
    ap.add_argument("--loop", type=float, default=0, help="seconds between passes; 0 = one pass")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    lock = open(os.path.join(tempfile.gettempdir(), "bdl_compact_localities.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("another merge is already running")

    while True:
        moved_to = a.moved_to or os.path.expanduser(
            f"~/bdl-localities-merged-inputs/{datetime.date.today():%Y-%m-%d}")
        try:
            one_pass(a.root, a.target_mb, a.min_age, moved_to, a.dry_run)
        except Exception as e:
            log(f"merge pass failed: {type(e).__name__}: {e}")
        if not a.loop:
            break
        time.sleep(a.loop)


if __name__ == "__main__":
    main()
