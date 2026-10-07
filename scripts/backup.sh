#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_dir="${1:-$repo_dir/backups}"

if [[ ! -f "$repo_dir/.env" ]]; then
  echo "未找到 $repo_dir/.env" >&2
  exit 1
fi

mkdir -p "$backup_dir" "$repo_dir/data" "$repo_dir/runtime/caddy-data" "$repo_dir/runtime/caddy-config"
backup_dir="$(cd "$backup_dir" && pwd)"
chmod 700 "$backup_dir"
umask 077

revision="$(git -C "$repo_dir" rev-parse --short HEAD 2>/dev/null || printf 'unversioned')"
archive="$backup_dir/shuyo-$(date -u +%Y%m%dT%H%M%SZ)-$revision.tar.gz"
if [[ -e "$archive" ]]; then
  echo "备份文件已存在：$archive" >&2
  exit 1
fi

cd "$repo_dir"
trap 'docker compose start >/dev/null || true' EXIT
docker compose stop
tar -czf "$archive" .env data runtime
tar -tzf "$archive" >/dev/null
docker compose start
trap - EXIT

chmod 600 "$archive"
echo "备份完成：$archive"
sha256sum "$archive"
