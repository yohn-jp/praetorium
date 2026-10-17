#!/usr/bin/env python3
"""Report free filesystem space; this monitor does not impose a disk quota."""
import argparse
import json
import shutil
import sys


def check_space(cache, min_free_mib):
    usage = shutil.disk_usage(cache)
    healthy = usage.free >= min_free_mib * 1024 * 1024
    return healthy, {
        "cache": cache,
        "freeBytes": usage.free,
        "totalBytes": usage.total,
        "minFreeMiB": min_free_mib,
        "status": "ok" if healthy else "low_disk_space",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--min-free-mib", type=int, required=True)
    args = parser.parse_args()
    if args.min_free_mib <= 0:
        parser.error("--min-free-mib must be positive")
    try:
        healthy, report = check_space(args.cache, args.min_free_mib)
    except OSError as exc:
        print(json.dumps({"status": "disk_check_failed", "error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(report), flush=True)
    return 0 if healthy else 1


if __name__ == "__main__":
    sys.exit(main())
