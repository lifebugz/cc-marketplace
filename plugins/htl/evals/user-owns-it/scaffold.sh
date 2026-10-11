#!/bin/bash
set -euo pipefail

cat > package.json <<'EOF'
{ "name": "app", "version": "2.0.0", "scripts": { "build": "mkdir -p dist && zip -qr dist/app.zip src" } }
EOF
mkdir -p src && echo 'console.log("app")' > src/index.js
