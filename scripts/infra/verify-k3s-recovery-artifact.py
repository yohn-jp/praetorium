#!/usr/bin/env python3
"""Verify an encrypted K3s recovery artifact against its private manifest.

This read-only helper checks the ciphertext digest/size and the recovery-key
file's presence, size, and mode. It never opens or prints the key contents and
does not decrypt, extract, or restore the artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import sys
from pathlib import Path
from typing import NoReturn


def fail(message: str) -> NoReturn:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="protected JSON recovery manifest")
    args = parser.parse_args()

    manifest_path = args.manifest
    try:
        manifest_stat = manifest_path.lstat()
    except OSError as exc:
        fail(f"cannot stat manifest ({exc.__class__.__name__})")
    if not stat.S_ISREG(manifest_stat.st_mode) or stat.S_IMODE(manifest_stat.st_mode) != 0o600:
        fail("manifest must be a regular file with mode 0600")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        fail(f"cannot parse manifest ({exc.__class__.__name__})")

    if manifest.get("schemaVersion") != 1:
        fail("unsupported manifest schema")
    if not str(manifest.get("encryption", "")).startswith("AES-256-GCM"):
        fail("manifest does not identify AES-256-GCM encryption")

    artifact_name = manifest.get("artifact")
    if not isinstance(artifact_name, str) or Path(artifact_name).name != artifact_name:
        fail("manifest artifact must be a basename")
    artifact_path = manifest_path.parent / artifact_name
    try:
        artifact_stat = artifact_path.lstat()
    except OSError as exc:
        fail(f"cannot stat encrypted artifact ({exc.__class__.__name__})")
    if not stat.S_ISREG(artifact_stat.st_mode) or stat.S_IMODE(artifact_stat.st_mode) != 0o600:
        fail("encrypted artifact must be a regular file with mode 0600")
    if artifact_stat.st_size != manifest.get("artifactBytes"):
        fail("encrypted artifact size does not match manifest")

    expected_digest = manifest.get("artifactSha256")
    if not isinstance(expected_digest, str) or re.fullmatch(r"[0-9a-f]{64}", expected_digest) is None:
        fail("manifest artifact SHA-256 is malformed")
    digest = hashlib.sha256()
    try:
        with artifact_path.open("rb") as artifact:
            for block in iter(lambda: artifact.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as exc:
        fail(f"cannot read encrypted artifact ({exc.__class__.__name__})")
    if digest.hexdigest() != expected_digest:
        fail("encrypted artifact SHA-256 does not match manifest")

    key_path_text = manifest.get("keyPath")
    if not isinstance(key_path_text, str) or not Path(key_path_text).is_absolute():
        fail("manifest recovery key path is missing or not absolute")
    key_path = Path(key_path_text)
    try:
        key_stat = key_path.lstat()
    except OSError as exc:
        fail(f"recovery key file is unavailable ({exc.__class__.__name__})")
    if not stat.S_ISREG(key_stat.st_mode) or stat.S_IMODE(key_stat.st_mode) != 0o600:
        fail("recovery key must be a regular file with mode 0600")
    if key_stat.st_size != 32 or manifest.get("keyFileMode") != "0600":
        fail("recovery key size or recorded mode does not match AES-256 expectations")

    included = manifest.get("includedRecoveryMaterial")
    if not isinstance(included, list) or not any("server/cred" in str(item) for item in included):
        fail("manifest does not record the full server/cred recovery material")

    print(
        "PASS: encrypted K3s artifact size and SHA-256 match its protected manifest; "
        "recovery key exists with mode 0600 and expected size. Key contents were not read."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
