"""Disk pressure reporting without filling the OS filesystem."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "check_build_disk", Path(__file__).parents[1] / "check-build-disk.py")
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class DiskMonitorTests(unittest.TestCase):
    def test_free_space_threshold_and_report(self):
        for free, expected in ((2048 * 1024**2, True), (2048 * 1024**2 - 1, False)):
            with self.subTest(free=free), patch.object(
                    monitor.shutil, "disk_usage", return_value=
                    SimpleNamespace(free=free, total=32 * 1024**3)):
                healthy, report = monitor.check_space("/var/lib/praetorium-buildkit", 2048)
                self.assertEqual(healthy, expected)
                self.assertEqual(report["freeBytes"], free)
                self.assertEqual(report["status"], "ok" if expected else "low_disk_space")


if __name__ == "__main__":
    unittest.main()
