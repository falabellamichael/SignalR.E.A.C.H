#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
: "${RESULT_DIR:?Hyperloom must supply RESULT_DIR}"
mkdir -p "$RESULT_DIR"
python3 "$script_dir/hyperloom_probe.py" \
  --base "${REACH_BENCH_BASE:-http://127.0.0.1:8001}" \
  --concurrency "${REACH_BENCH_CONCURRENCY:-2}" \
  --lines "${REACH_BENCH_LINES:-0}" \
  --output "$RESULT_DIR/${RESULT_FILENAME:-inferencex_result}.json"
