"""Synthetic fixtures only: no production files, network, Docker or service changes."""
import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/backup-online.py"
spec = importlib.util.spec_from_file_location("backup_online", SCRIPT)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class OnlineBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="shuyo-backup-test-")
        self.repo = (Path(self.temporary.name) / "repo").resolve()
        self.pool = self.repo / "backups/rolling"
        for name in ("data/tip-images", "runtime/caddy-data", "runtime/caddy-config", "deploy"):
            (self.repo / name).mkdir(parents=True, exist_ok=True)
        self.connections = []
        for name in backup.DATABASES:
            connection = sqlite3.connect(self.repo / "data" / name, check_same_thread=False)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            connection.execute("INSERT INTO records(value) VALUES ('committed-in-live-wal')")
            connection.commit()
            self.connections.append(connection)
        (self.repo / ".env").write_text("COOKIE_SECRET=synthetic-test-secret\n")
        (self.repo / ".env").chmod(0o600)
        (self.repo / "data/db.json").write_text('{"feedback":[],"presence":{}}')
        (self.repo / "data/webvpn-status.json").write_text('{"status":"available"}')
        (self.repo / "data/tip-images/example.png").write_bytes(b"synthetic-image")
        (self.repo / "runtime/caddy-data/certificate").write_bytes(b"synthetic-certificate")
        (self.repo / "docker-compose.yml").write_text("name: shuyo\n")
        (self.repo / "deploy/Caddyfile").write_text("localhost { respond ok }\n")
        (self.repo / "data/unfinished.json.tmp").write_text('{"unfinished":')
        self.versions = patch.object(backup, "version_metadata", return_value={"git_commit": "test", "api": None})
        self.versions.start()

    def tearDown(self):
        self.versions.stop()
        for connection in self.connections:
            connection.close()
        self.temporary.cleanup()

    def run_backup(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return backup.run_backup(self.repo, self.pool)

    def test_live_wal_is_snapshotted_and_archive_can_be_restored_in_isolation(self):
        source_before = (self.repo / "data/db.json").read_bytes()
        directory = self.run_backup()
        manifest = backup.verify_set(directory)
        self.assertEqual(len(manifest["databases"]), 5)
        self.assertEqual(len(backup.managed_sets(self.pool, self.repo)), 1)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        for name in ("backup.tar.gz", "manifest.json", "SHA256SUMS"):
            self.assertEqual((directory / name).stat().st_mode & 0o777, 0o600)
        with tarfile.open(directory / "backup.tar.gz") as archive:
            names = archive.getnames()
            self.assertFalse(any(name.endswith(("-wal", "-shm", "-journal", ".tmp")) for name in names))
            self.assertIn(".env", names)
            self.assertIn("runtime/caddy-data/certificate", names)
            self.assertEqual(archive.getmember(".env").mode, 0o600)
            self.assertEqual(archive.getmember(".env").uid, (self.repo / ".env").stat().st_uid)
            extracted = Path(self.temporary.name) / "restored.sqlite"
            with archive.extractfile("data/reviews.sqlite") as reader, extracted.open("wb") as writer:
                shutil.copyfileobj(reader, writer)
        with contextlib.closing(sqlite3.connect(extracted)) as connection:
            self.assertEqual(connection.execute("SELECT value FROM records").fetchall(), [("committed-in-live-wal",)])
        self.assertEqual((self.repo / "data/db.json").read_bytes(), source_before)
        self.assertEqual(self.connections[3].execute("PRAGMA journal_mode").fetchone()[0], "wal")
        self.connections[3].execute("INSERT INTO records(value) VALUES ('still-writable')")
        self.connections[3].commit()

    def test_only_latest_two_owned_sets_are_removed(self):
        self.pool.mkdir(parents=True)
        legacy = self.pool / "legacy.tar.gz"
        legacy.write_bytes(b"historical")
        unknown = self.pool / "shuyo-20000101T000000000000Z-1234abcd"
        unknown.mkdir()
        (unknown / "manifest.json").write_text('{"format":"not-ours"}')
        historical = self.repo / "backups/service-resume-20261109"
        historical.mkdir()
        (historical / "keep.tar.gz").write_bytes(b"historical")
        created = [self.run_backup() for _ in range(4)]
        self.assertEqual(backup.managed_sets(self.pool, self.repo), list(reversed(created[-2:])))
        self.assertFalse(created[0].exists())
        self.assertTrue(legacy.exists())
        self.assertTrue(unknown.exists())
        self.assertTrue((historical / "keep.tar.gz").exists())
        history = json.loads((self.pool / "history.json").read_text())
        self.assertEqual(len(history), 4)
        for directory in created[-2:]:
            backup.verify_set(directory)

    def test_corrupt_source_preserves_both_old_sets_and_cleans_partial(self):
        previous = [self.run_backup(), self.run_backup()]
        self.connections[4].close()
        self.connections.pop()
        for suffix in ("", "-wal", "-shm"):
            (self.repo / ("data/shares.sqlite" + suffix)).unlink(missing_ok=True)
        (self.repo / "data/shares.sqlite").write_bytes(b"not a database")
        with self.assertRaises(sqlite3.DatabaseError):
            self.run_backup()
        self.assertTrue(all(path.exists() for path in previous))
        self.assertFalse(list(self.pool.glob(".partial-*")))
        self.assertEqual(json.loads((self.pool / "history.json").read_text())[0]["status"], "failed")

    def test_low_disk_never_removes_old_backups(self):
        previous = [self.run_backup(), self.run_backup()]
        usage = shutil._ntuple_diskusage(40 * 1024 ** 3, 39 * 1024 ** 3, 1024 ** 3)
        with patch.object(backup.shutil, "disk_usage", return_value=usage):
            with self.assertRaisesRegex(backup.BackupError, "磁盘"):
                self.run_backup()
        self.assertTrue(all(path.exists() for path in previous))

    def test_corrupt_archive_is_rejected(self):
        directory = self.run_backup()
        with (directory / "backup.tar.gz").open("ab") as stream:
            stream.write(b"tampered")
        with self.assertRaisesRegex(backup.BackupError, "SHA-256"):
            backup.verify_set(directory)

    def test_damaged_existing_set_cannot_evict_a_good_older_backup(self):
        first, second = self.run_backup(), self.run_backup()
        with (second / "backup.tar.gz").open("ab") as stream:
            stream.write(b"damaged-existing-backup")
        with self.assertRaisesRegex(backup.BackupError, "SHA-256"):
            self.run_backup()
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())
        self.assertEqual(len(backup.managed_sets(self.pool, self.repo)), 3)
        backup.verify_set(first)

    def test_lock_prevents_concurrent_backup_without_rotation(self):
        self.run_backup()
        with (self.repo / "backups/.online-backup.lock").open("r+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(backup.BackupBusy):
                self.run_backup()
        self.assertEqual(len(backup.managed_sets(self.pool, self.repo)), 1)

    def test_production_and_symlink_output_paths_are_rejected(self):
        for pool in (self.repo, self.repo / "data/nested", self.repo / "backups/../data/nested"):
            with self.assertRaises(backup.BackupError):
                backup.run_backup(self.repo, pool)
        (self.repo / "backups").mkdir(exist_ok=True)
        (self.repo / "backups/alias").symlink_to(self.repo / "data", target_is_directory=True)
        with self.assertRaises(backup.BackupError):
            backup.run_backup(self.repo, self.repo / "backups/alias/nested")
        self.assertFalse((self.repo / "data/nested").exists())

    def test_source_symlink_cannot_include_external_files(self):
        (self.repo / "data/escaped").symlink_to(self.repo / ".env")
        with self.assertRaisesRegex(backup.BackupError, "符号链接"):
            self.run_backup()

    def test_history_is_bounded_and_stale_owned_work_is_cleaned(self):
        self.run_backup()
        for number in range(10):
            backup.write_summary(self.pool, {"status": "example", "number": number})
        self.assertEqual(len(json.loads((self.pool / "history.json").read_text())), 7)
        stale = self.pool / ".partial-shuyo-abandoned"
        stale.mkdir()
        (stale / ".work-owner.json").write_text(json.dumps({"format": backup.FORMAT, "source_repo": str(self.repo)}))
        ancient = time.time() - 90000
        os.utime(stale, (ancient, ancient))
        unowned = self.pool / ".partial-shuyo-unowned"
        unowned.mkdir()
        os.utime(unowned, (ancient, ancient))
        self.run_backup()
        self.assertFalse(stale.exists())
        self.assertTrue(unowned.exists())

    def test_backup_stays_consistent_while_other_connection_writes(self):
        source = self.repo / "data/reviews.sqlite"
        self.connections[3].execute("CREATE TABLE counter(n INTEGER NOT NULL)")
        self.connections[3].execute("INSERT INTO counter VALUES (1)")
        self.connections[3].commit()
        stop = threading.Event()
        writes = []

        def writer():
            connection = sqlite3.connect(source)
            try:
                while not stop.is_set():
                    connection.execute("BEGIN")
                    connection.execute("INSERT INTO records(value) VALUES ('concurrent')")
                    connection.execute("UPDATE counter SET n=n+1")
                    connection.commit()
                    writes.append(1)
                    time.sleep(0.001)
            finally:
                connection.close()

        thread = threading.Thread(target=writer)
        thread.start()
        try:
            while not writes:
                time.sleep(0.001)
            destination = Path(self.temporary.name) / "online.sqlite"
            backup.snapshot_database(source, destination)
            with contextlib.closing(sqlite3.connect(destination)) as connection:
                count = connection.execute("SELECT COUNT(*) FROM records").fetchone()[0]
                counter = connection.execute("SELECT n FROM counter").fetchone()[0]
                self.assertEqual(count, counter)
            self.assertTrue(writes)
        finally:
            stop.set()
            thread.join(timeout=10)

    def test_timer_and_wrapper_never_stop_or_start_containers(self):
        root = SCRIPT.parents[1]
        wrapper = (root / "scripts/backup.sh").read_text()
        service = (root / "deploy/shuyo-backup.service").read_text()
        timer = (root / "deploy/shuyo-backup.timer").read_text()
        self.assertNotIn("docker compose stop", wrapper)
        self.assertNotIn("docker compose start", wrapper)
        self.assertIn("--require-running", service)
        self.assertIn("ProtectSystem=strict", service)
        self.assertIn("04:00:00 Asia/Shanghai", timer)
        self.assertIn("Persistent=false", timer)
        for arguments in (("--help",), ("/unused legacy path", "--help")):
            result = subprocess.run(["bash", str(root / "scripts/backup.sh"), *arguments],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("--require-running", result.stdout)


if __name__ == "__main__":
    unittest.main()
