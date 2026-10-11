#!/bin/bash
set -euo pipefail

mkdir -p src
cat > src/cli.py <<'EOF'
import json
from pathlib import Path

CACHE = Path.home() / ".weather-cache.json"


def cached(city: str) -> dict | None:
    if CACHE.exists():
        return json.loads(CACHE.read_text()).get(city)
    return None
EOF
