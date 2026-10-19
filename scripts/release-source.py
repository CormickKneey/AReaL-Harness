#!/usr/bin/env python3
"""正式导出前校验固定来源属于已获取的 main；不执行网络操作。"""

import argparse
import json
import re
import subprocess
from pathlib import Path


def verify_source(root, revision, merged_ref="refs/remotes/origin/main"):
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=root, text=True).strip()

    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("release source must be a full commit SHA")
    if git("rev-parse", "HEAD") != revision or git("status", "--porcelain"):
        raise ValueError("release source must match a clean checkout HEAD")
    tip = git("rev-parse", "--verify", merged_ref + "^{commit}")
    if (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", revision, tip], cwd=root, check=False
        ).returncode
        != 0
    ):
        raise ValueError("release source is not merged into fetched main")
    return {"sourceRevision": revision, "mergedMainRevision": tip}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    print(json.dumps(verify_source(args.root, args.revision)))


if __name__ == "__main__":
    main()
