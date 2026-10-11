#!/bin/bash
set -euo pipefail

cat > app.py <<'EOF'
import os

from flask import Flask

app = Flask(__name__)
app.secret_key = os.environ["SESSION_SECRET"]
EOF
printf '.env\n' > .gitignore
