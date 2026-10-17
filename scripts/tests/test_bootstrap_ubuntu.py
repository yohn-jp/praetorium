"""Preflight regressions only; these do not certify an Ubuntu host bootstrap."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "bootstrap_ubuntu", Path(__file__).parents[1] / "bootstrap-ubuntu.py")
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class PreflightTests(unittest.TestCase):
    def test_supported_ubuntu_lts_releases_are_accepted(self):
        for version in ("24.04", "26.04"):
            with self.subTest(version=version), patch.object(
                    bootstrap.Path, "read_text", return_value=
                    'ID=ubuntu\nVERSION_ID="' + version + '"\n'):
                bootstrap.verify_ubuntu_release()

    def test_other_releases_and_distributions_are_rejected(self):
        for data in ('ID=ubuntu\nVERSION_ID="25.10"\n',
                     'ID=debian\nVERSION_ID="26.04"\n', 'ID=ubuntu\n'):
            with self.subTest(data=data), patch.object(
                    bootstrap.Path, "read_text", return_value=data):
                with self.assertRaisesRegex(ValueError, "24.04 or 26.04"):
                    bootstrap.verify_ubuntu_release()

    def test_missing_oci_runtime_is_rejected(self):
        with patch.object(bootstrap.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "missing preinstalled OCI runtime"):
                bootstrap.oci_runtime()

    def test_either_supported_runtime_is_resolved(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ("runc", "buildkit-runc"):
                runtime = Path(directory) / name
                runtime.write_text("#!/bin/sh\nexit 0\n")
                runtime.chmod(0o755)
                with patch.dict("os.environ", {"PATH": directory}):
                    self.assertEqual(bootstrap.oci_runtime(), str(runtime))
                runtime.unlink()

    def test_openssl_30_zero_exit_mismatch_is_rejected(self):
        # output() returns normally for OpenSSL 3.0's zero-exit mismatch.
        with patch.object(bootstrap, "output", return_value=
                          "IP 10.42.0.2 does NOT match certificate"):
            with self.assertRaisesRegex(ValueError, "does not match bindAddress"):
                bootstrap.verify_certificate_ip("unused.pem", "10.42.0.2")

    def test_unexpected_openssl_output_is_rejected(self):
        with patch.object(bootstrap, "output", return_value=""):
            with self.assertRaises(ValueError):
                bootstrap.verify_certificate_ip("unused.pem", "10.42.0.1")

    @unittest.skipUnless(shutil.which("openssl"), "openssl is required for real certificate checks")
    def test_real_certificate_accepts_matching_ip_and_rejects_another(self):
        with tempfile.TemporaryDirectory() as directory:
            cert = str(Path(directory) / "cert.pem")
            key = str(Path(directory) / "key.pem")
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", key, "-out", cert, "-days", "1",
                "-subj", "/CN=bootstrap-preflight-test",
                "-addext", "subjectAltName=IP:10.42.0.1",
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            bootstrap.verify_certificate_ip(cert, "10.42.0.1")
            with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                bootstrap.verify_certificate_ip(cert, "10.42.0.2")


if __name__ == "__main__":
    unittest.main()
