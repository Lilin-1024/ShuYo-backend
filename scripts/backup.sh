#!/usr/bin/env bash
# Online snapshots only. This entry point never stops, starts or rebuilds services.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Keep the legacy optional first positional backup directory working.
if [[ $# -gt 0 && "$1" != -* ]]; then
  backup_dir="$1"
  shift
  set -- --backup-dir "$backup_dir" "$@"
fi
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$repo_dir/scripts/backup-online.py" "$@"
