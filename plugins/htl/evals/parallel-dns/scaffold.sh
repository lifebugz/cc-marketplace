#!/bin/bash
set -euo pipefail

mkdir -p public test
cat > package.json <<'EOF'
{ "name": "launch-site", "version": "0.1.0", "scripts": { "test": "node test/smoke.test.js" } }
EOF
echo '<!doctype html><title>Launch</title><h1>Hello</h1>' > public/index.html
cat > test/smoke.test.js <<'EOF'
const fs = require('fs')
if (!fs.readFileSync('public/index.html', 'utf8').includes('<h1>')) throw new Error('no heading')
console.log('ok')
EOF
