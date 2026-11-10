#!/usr/bin/env python3
"""Online, independently consistent SQLite snapshots plus live application files.

Never starts/stops containers or writes application data. Only this tool's own
completed backup sets in the selected pool are eligible for retention cleanup.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

FORMAT = "shuyo-online-backup-v1"
SET_PATTERN = re.compile(r"shuyo-\d{8}T\d{12}Z-[0-9a-f]{8}\Z")
DATABASES = ("accounts.sqlite", "admins.sqlite", "engagement.sqlite", "reviews.sqlite", "shares.sqlite")
REQUIRED_FILES = (".env", "data/db.json", "docker-compose.yml", "deploy/Caddyfile")
RESERVE_BYTES = 2 * 1024 ** 3


class BackupError(Exception):
    pass


class BackupBusy(BackupError):
    pass


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds")


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_private(path, content):
    with Path(path).open("xb") as stream:
        os.chmod(path, 0o600)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def fsync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def checked_directory(path):
    path = Path(path).absolute()
    for component in (path, *path.parents):
        if component.is_symlink():
            raise BackupError("备份路径不得包含符号链接")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_dir():
        raise BackupError("备份路径不是目录")
    os.chmod(path, 0o700)
    return path.resolve()


@contextlib.contextmanager
def backup_lock(repo):
    root = checked_directory(repo / "backups")
    lock_path = root / ".online-backup.lock"
    descriptor = os.open(str(lock_path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise BackupBusy("已有备份任务运行；本次不执行、不轮换") from error
        yield
    finally:
        os.close(descriptor)


def command(args, repo):
    result = subprocess.run(args, cwd=repo, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=20, check=True, text=True)
    return result.stdout.strip()


def version_metadata(repo, require_running):
    result = {"git_commit": None, "git_branch": None, "git_dirty": None, "api": None}
    try:
        result["git_commit"] = command(["git", "rev-parse", "HEAD"], repo)
        result["git_branch"] = command(["git", "branch", "--show-current"], repo)
        result["git_dirty"] = bool(command(["git", "--no-optional-locks", "status", "--porcelain"], repo))
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        ids = command(["docker", "compose", "ps", "--all", "--quiet", "api"], repo).splitlines()
        if len(ids) != 1:
            raise BackupError("未找到唯一 API 容器")
        template = ('{"container_id":"{{.Id}}","image_id":"{{.Image}}",'
                    '"status":"{{.State.Status}}","started_at":"{{.State.StartedAt}}",'
                    '"health":"{{if .State.Health}}{{.State.Health.Status}}{{end}}",'
                    '"restart_count":{{.RestartCount}}}')
        result["api"] = json.loads(command(["docker", "inspect", "--format", template, ids[0]], repo))
    except (OSError, subprocess.SubprocessError, ValueError, BackupError):
        if require_running:
            raise BackupError("无法核对生产 API 状态；不执行定时备份")
    if require_running and (not result["api"] or result["api"]["status"] != "running"
                            or result["api"]["health"] != "healthy"):
        raise BackupError("生产 API 未健康运行；跳过备份，不启动任何服务")
    return result


def source_entries(repo):
    for name in REQUIRED_FILES + tuple("data/" + name for name in DATABASES):
        path = repo / name
        if path.is_symlink() or not path.is_file():
            raise BackupError("缺少必需的普通文件：" + name)
    for name in ("data", "runtime"):
        if (repo / name).is_symlink() or not (repo / name).is_dir():
            raise BackupError("缺少必需的普通目录：" + name)
    paths = [repo / ".env", repo / "docker-compose.yml", repo / "deploy", repo / "deploy/Caddyfile"]
    for name in ("data", "runtime"):
        root = repo / name
        paths.append(root)
        for directory, directories, files in os.walk(root, followlinks=False):
            for child in sorted(directories + files):
                paths.append(Path(directory) / child)
    entries = []
    for path in sorted(set(paths), key=lambda item: item.relative_to(repo).as_posix()):
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue  # A live cache/upload may disappear; required files checked again later.
        relative = path.relative_to(repo).as_posix()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise BackupError("源目录含符号链接或特殊文件；需人工核对：" + relative)
        # SQLite journals are deliberately replaced by standalone online snapshots.
        if path.name.endswith(("-wal", "-shm", "-journal")):
            continue
        if path.name.endswith(".tmp") or ".tmp-" in path.name:
            continue
        entries.append((path, relative, info))
    return entries


def check_disk_space(pool, entries):
    usage = shutil.disk_usage(pool)
    source_bytes = sum(info.st_size for _, _, info in entries if stat.S_ISREG(info.st_mode))
    for source, _, _ in entries:
        if source.suffix.lower() in (".sqlite", ".sqlite3", ".db"):
            with contextlib.suppress(FileNotFoundError):
                source_bytes += Path(str(source) + "-wal").stat().st_size
    # Staging, archive and a verification copy, conservatively without compression.
    required = max(RESERVE_BYTES, int(usage.total * 0.10)) + source_bytes * 3
    if usage.free < required:
        raise BackupError("磁盘余量不足；保留原备份，不删除旧档腾空间")


def readonly_database(path, immutable=False):
    uri = Path(path).resolve().as_uri() + "?mode=ro" + ("&immutable=1" if immutable else "")
    connection = sqlite3.connect(uri, uri=True, timeout=1)
    connection.execute("PRAGMA query_only = ON")
    return connection


def check_database(path):
    with contextlib.closing(readonly_database(path, immutable=True)) as connection:
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise BackupError("SQLite 完整性检查未通过")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise BackupError("SQLite 外键检查未通过")


def snapshot_database(source, destination, timeout=60):
    started_at = utc_now()
    deadline = time.monotonic() + timeout

    def progress(status, remaining, total):
        if time.monotonic() > deadline:
            raise BackupError("SQLite 在线备份超时；不轮换旧备份")

    with contextlib.closing(readonly_database(source)) as source_db:
        with contextlib.closing(sqlite3.connect(str(destination))) as target_db:
            source_db.backup(target_db, pages=128, progress=progress, sleep=0.05)
            # Operates on the backup ONLY, making it a standalone file without WAL.
            target_db.execute("PRAGMA journal_mode = DELETE")
    os.chmod(destination, 0o600)
    check_database(destination)
    return {"started_at": started_at, "finished_at": utc_now(), "integrity_check": "ok",
            "foreign_key_check": "ok"}


def copy_live_file(source, destination):
    for attempt in range(3):
        try:
            descriptor = os.open(str(source), os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, "rb") as reader:
                before = os.fstat(reader.fileno())
                with destination.open("wb") as writer:
                    shutil.copyfileobj(reader, writer, length=1024 * 1024)
                after = os.fstat(reader.fileno())
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise BackupError("文件在复制过程中变化")
            if source.suffix.lower() == ".json":
                with destination.open("r", encoding="utf-8") as stream:
                    json.load(stream)
            os.chmod(destination, 0o600)
            return before
        except (BackupError, json.JSONDecodeError):
            if attempt == 2:
                raise BackupError("活动文件连续三次无法生成完整副本")
            time.sleep(0.1)
    raise AssertionError("unreachable")


def stage_files(repo, staging, entries):
    inventory, databases, skipped = [], {}, []
    for source, relative, info in entries:
        target = staging / relative
        kind = "directory" if stat.S_ISDIR(info.st_mode) else "file"
        if kind == "directory":
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
        else:
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            try:
                if source.suffix.lower() in (".sqlite", ".sqlite3", ".db"):
                    databases[relative] = snapshot_database(source, target)
                else:
                    info = copy_live_file(source, target)
            except FileNotFoundError:
                if relative in REQUIRED_FILES or relative in {"data/" + name for name in DATABASES}:
                    raise BackupError("备份时必需文件消失：" + relative)
                target.unlink(missing_ok=True)
                skipped.append(relative)
                continue
        item = {"path": relative, "kind": kind, "mode": stat.S_IMODE(info.st_mode),
                "uid": info.st_uid, "gid": info.st_gid, "mtime_ns": info.st_mtime_ns}
        if kind == "file":
            item.update(size=target.stat().st_size, sha256=digest_file(target))
        inventory.append(item)
    actual = {item["path"] for item in inventory}
    if not set(REQUIRED_FILES).issubset(actual) or not {"data/" + name for name in DATABASES}.issubset(databases):
        raise BackupError("备份缺少必需文件或数据库")
    return inventory, databases, skipped


def create_archive(staging, archive_path, inventory, manifest_content):
    with tarfile.open(archive_path, "x:gz", compresslevel=3, format=tarfile.PAX_FORMAT) as archive:
        for item in inventory:
            info = archive.gettarinfo(str(staging / item["path"]), arcname=item["path"])
            info.uid, info.gid = item["uid"], item["gid"]
            info.uname = info.gname = ""  # Restore by numeric IDs, not host-specific names.
            info.mode = item["mode"]
            info.mtime = item["mtime_ns"] / 1_000_000_000
            if info.isfile():
                with (staging / item["path"]).open("rb") as stream:
                    archive.addfile(info, stream)
            else:
                archive.addfile(info)
        import io
        info = tarfile.TarInfo("backup-manifest.json")
        info.size, info.mode = len(manifest_content), 0o600
        archive.addfile(info, io.BytesIO(manifest_content))
    os.chmod(archive_path, 0o600)
    with archive_path.open("rb") as stream:
        os.fsync(stream.fileno())


def validate_relative(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts or "\\" in name:
        raise BackupError("归档包含不安全路径")
    return path


def verify_set(directory):
    directory = Path(directory)
    if directory.is_symlink():
        raise BackupError("备份集不能是符号链接")
    for name in ("backup.tar.gz", "manifest.json", "SHA256SUMS"):
        if (directory / name).is_symlink() or not (directory / name).is_file():
            raise BackupError("备份集缺少必需文件")
    manifest_content = (directory / "manifest.json").read_bytes()
    manifest = json.loads(manifest_content)
    if manifest.get("format") != FORMAT:
        raise BackupError("不支持的备份格式")
    expected_sums = {}
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        checksum, name = line.split("  ", 1)
        if name not in ("backup.tar.gz", "manifest.json") or name in expected_sums:
            raise BackupError("校验文件格式无效")
        expected_sums[name] = checksum
    if set(expected_sums) != {"backup.tar.gz", "manifest.json"}:
        raise BackupError("校验文件不完整")
    for name, checksum in expected_sums.items():
        if digest_file(directory / name) != checksum:
            raise BackupError("归档或元信息 SHA-256 不匹配")
    items = {item["path"]: item for item in manifest["files"]}
    if len(items) != len(manifest["files"]):
        raise BackupError("备份清单路径重复")
    required = set(REQUIRED_FILES) | {"data/" + name for name in DATABASES}
    if not required.issubset(items) or not {"data/" + name for name in DATABASES}.issubset(manifest["databases"]):
        raise BackupError("备份清单缺少必需数据")
    seen = set()
    with tempfile.TemporaryDirectory(prefix=".verify-shuyo-", dir=directory.parent) as temporary:
        write_private(Path(temporary) / ".work-owner.json", json_bytes({"format": FORMAT, "source_repo": manifest.get("source_repo")}))
        with tarfile.open(directory / "backup.tar.gz", "r:gz") as archive:
            for member in archive:
                validate_relative(member.name)
                if member.name in seen:
                    raise BackupError("归档路径重复")
                seen.add(member.name)
                if member.name == "backup-manifest.json":
                    if not member.isfile() or member.size != len(manifest_content):
                        raise BackupError("归档元信息无效")
                    with archive.extractfile(member) as stream:
                        if stream.read() != manifest_content:
                            raise BackupError("归档内外元信息不一致")
                    continue
                item = items.get(member.name)
                if item is None or member.issym() or member.islnk():
                    raise BackupError("归档包含清单外文件或链接")
                if (member.uid, member.gid, member.mode) != (item["uid"], item["gid"], item["mode"]):
                    raise BackupError("归档文件权限元信息不一致")
                if item["kind"] == "directory":
                    if not member.isdir():
                        raise BackupError("归档目录类型不一致")
                    continue
                if not member.isfile() or member.size != item["size"]:
                    raise BackupError("归档文件类型或大小不一致")
                digest = hashlib.sha256()
                needs_copy = member.name in manifest["databases"] or member.name.endswith(".json")
                # Never extract archive paths. Copies use fresh flat temporary names.
                copied = Path(temporary) / uuid.uuid4().hex if needs_copy else None
                with contextlib.ExitStack() as stack:
                    stream = stack.enter_context(archive.extractfile(member))
                    target = stack.enter_context(copied.open("xb")) if copied else None
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(block)
                        if target:
                            target.write(block)
                if digest.hexdigest() != item["sha256"]:
                    raise BackupError("归档文件内容校验失败")
                if copied:
                    os.chmod(copied, 0o600)
                    if member.name in manifest["databases"]:
                        check_database(copied)
                    else:
                        with copied.open("r", encoding="utf-8") as stream:
                            json.load(stream)
                    copied.unlink()
    if seen != set(items) | {"backup-manifest.json"}:
        raise BackupError("归档缺少清单文件")
    return manifest


def managed_sets(pool, repo):
    sets = []
    for child in pool.iterdir():
        if not SET_PATTERN.fullmatch(child.name) or child.is_symlink() or not child.is_dir():
            continue
        manifest_path = child / "manifest.json"
        if manifest_path.is_symlink():
            continue
        try:
            manifest = json.loads(manifest_path.read_text())
            if (manifest.get("format") == FORMAT and manifest.get("source_repo") == str(repo)
                    and manifest.get("backup_id") == child.name):
                sets.append(child)
        except (OSError, ValueError):
            continue
    return sorted(sets, key=lambda item: item.name, reverse=True)


def rotate(pool, repo, keep):
    removed = []
    candidates = managed_sets(pool, repo)
    # A corrupt newer set must never evict an older known-good recovery point.
    for child in candidates:
        verify_set(child)
    for child in candidates[keep:]:
        shutil.rmtree(child)
        removed.append(child.name)
    fsync_directory(pool)
    return removed


def write_summary(pool, result):
    history_path = pool / "history.json"
    if history_path.is_symlink():
        raise BackupError("执行摘要不得是符号链接")
    try:
        history = json.loads(history_path.read_text()) if history_path.exists() else []
        if not isinstance(history, list):
            history = []
    except ValueError:
        history = []
    temporary = pool / (".summary-" + uuid.uuid4().hex)
    write_private(temporary, json_bytes(([result] + history)[:7]))
    os.replace(temporary, history_path)
    fsync_directory(pool)


def cleanup_stale_workdirs(pool, repo):
    for child in pool.iterdir():
        if not child.name.startswith((".partial-shuyo-", ".verify-shuyo-")) or child.is_symlink() or not child.is_dir():
            continue
        marker = child / ".work-owner.json"
        try:
            if marker.is_symlink():
                continue
            owner = json.loads(marker.read_text())
            if (owner.get("format") == FORMAT and owner.get("source_repo") == str(repo)
                    and time.time() - child.stat().st_mtime > 86400):
                shutil.rmtree(child)
        except (OSError, ValueError):
            continue


def run_backup(repo, pool, reason="manual", keep=2, require_running=False):
    repo = Path(repo).resolve()
    pool_input = Path(os.path.abspath(pool))
    if (pool_input == repo or pool_input in repo.parents or pool_input.is_relative_to(repo / "data")
            or pool_input.is_relative_to(repo / "runtime")):
        raise BackupError("备份目录不得覆盖仓库、生产 data 或 runtime")
    if not (repo / ".env").is_file():
        raise BackupError("未找到生产 .env；不创建数据目录或启动服务")
    with backup_lock(repo):
        pool = checked_directory(pool_input)
        pending = None
        started = utc_now()
        try:
            cleanup_stale_workdirs(pool, repo)
            entries = source_entries(repo)
            check_disk_space(pool, entries)
            versions = version_metadata(repo, require_running)
            backup_id = "shuyo-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid.uuid4().hex[:8]
            pending = Path(tempfile.mkdtemp(prefix=".partial-shuyo-", dir=pool))
            os.chmod(pending, 0o700)
            write_private(pending / ".work-owner.json", json_bytes({"format": FORMAT, "source_repo": str(repo)}))
            staging = pending / "staging"
            staging.mkdir(mode=0o700)
            files, databases, skipped = stage_files(repo, staging, entries)
            manifest = {"format": FORMAT, "backup_id": backup_id, "source_repo": str(repo),
                        "started_at": started, "snapshot_finished_at": utc_now(), "reason": reason,
                        "consistency": "per-database-online; cross-database/files best-effort",
                        "python_version": sys.version.split()[0], "sqlite_version": sqlite3.sqlite_version,
                        "versions": versions, "databases": databases, "files": files,
                        "skipped_volatile_files": skipped}
            content = json_bytes(manifest)
            write_private(pending / "manifest.json", content)
            create_archive(staging, pending / "backup.tar.gz", files, content)
            shutil.rmtree(staging)
            write_private(pending / "SHA256SUMS", (
                digest_file(pending / "backup.tar.gz") + "  backup.tar.gz\n" +
                digest_file(pending / "manifest.json") + "  manifest.json\n").encode())
            verify_set(pending)
            (pending / ".work-owner.json").unlink()
            fsync_directory(pending)
            final = pool / backup_id
            os.rename(pending, final)
            pending = None
            fsync_directory(pool)
            removed = rotate(pool, repo, keep)
            result = {"status": "success", "finished_at": utc_now(), "backup_id": backup_id,
                      "archive_bytes": (final / "backup.tar.gz").stat().st_size,
                      "databases": len(databases), "skipped_volatile_files": len(skipped),
                      "retained": len(managed_sets(pool, repo)), "removed": removed, "reason": reason}
            write_summary(pool, result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
            return final
        except BaseException as error:
            if pending is not None:
                shutil.rmtree(pending)
            with contextlib.suppress(Exception):
                write_summary(pool, {"status": "failed", "finished_at": utc_now(), "reason": reason,
                                     "error_type": type(error).__name__})
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--reason", choices=("manual", "scheduled", "pre-deploy", "verification"), default="manual")
    parser.add_argument("--keep", type=int, default=2)
    parser.add_argument("--require-running", action="store_true", help="fail without starting anything if API is not healthy")
    parser.add_argument("--verify", type=Path, help="verify a backup set in isolation; never restore production")
    args = parser.parse_args()
    if not 1 <= args.keep <= 50:
        parser.error("--keep must be between 1 and 50")
    os.umask(0o077)

    def interrupted(signum, frame):
        raise BackupError("备份任务被中断")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        if args.verify:
            manifest = verify_set(args.verify)
            print(json.dumps({"status": "verified", "backup_id": manifest["backup_id"],
                              "databases": len(manifest["databases"])}, ensure_ascii=False))
        else:
            run_backup(args.repo_dir, args.backup_dir or args.repo_dir / "backups/rolling",
                       args.reason, args.keep, args.require_running)
        return 0
    except BackupBusy as error:
        print(str(error), file=sys.stderr)
        return 75
    except (BackupError, OSError, ValueError, sqlite3.Error) as error:
        # Errors name files/types, never print source JSON/SQL rows or environment values.
        print("备份失败：" + type(error).__name__ + ": " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
