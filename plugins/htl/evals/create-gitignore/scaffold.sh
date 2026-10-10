#!/bin/bash
set -euo pipefail

mkdir -p src/report
cat > pyproject.toml <<'EOF'
[project]
name = "report"
version = "0.1.0"
requires-python = ">=3.12"
EOF
echo 'print("report")' > src/report/__init__.py
