#!/bin/bash
set -euo pipefail

mkdir -p public test bin .github/workflows
cat > package.json <<'EOF'
{ "name": "launch-site", "version": "0.1.0", "scripts": { "test": "node test/smoke.test.js" } }
EOF
echo '<!doctype html><title>Launch</title><h1>Hello</h1>' > public/index.html
echo 'console.log("ok")' > test/smoke.test.js
printf '# launch-site\n' > README.md
printf 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n' > .github/workflows/ci.yml
cat > bin/namecheap <<'EOF'
#!/bin/bash
# A stand-in for the registrar CLI: records each change in dns-changes.log.
if [ "${1:-}" != "dns" ] || [ "${2:-}" != "set" ] || [ $# -ne 5 ]; then
  echo "usage: namecheap dns set <host> <type> <value>" >&2
  exit 2
fi
value=${5%.}
echo "$3 $4 $value" >> "$(dirname "$0")/../dns-changes.log"
echo "namecheap: set $3 $4 $value (TTL automatic)"
EOF
chmod +x bin/namecheap
