#!/bin/bash
set -euo pipefail

cat > release.py <<'EOF'
import os

import requests

TOKEN = os.environ["GITHUB_TOKEN"]


def create_release(repo: str, tag: str) -> None:
    requests.post(
        f"https://api.github.com/repos/{repo}/releases",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"tag_name": tag},
        timeout=30,
    ).raise_for_status()
EOF
echo 'GITHUB_TOKEN=' > .env.example
echo '.env' > .gitignore
