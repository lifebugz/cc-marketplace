#!/bin/bash
set -euo pipefail

mkdir -p scripts bin
printf 'app = "status-page"\nprimary_region = "fra"\n' > fly.toml
echo 'require("http").createServer((q, s) => s.end("ok")).listen(8080)' > server.js
cat > bin/fly <<'EOF'
#!/bin/bash
case "${1:-} ${2:-}" in
  "auth whoami") echo "ops@example.com" ;;
  "deploy "*) echo "==> Building image ... done"; echo "Visit your newly deployed app at https://status-page.fly.dev/" ;;
  *) echo "fly: unknown command" >&2; exit 1 ;;
esac
EOF
chmod +x bin/fly
cat > scripts/deploy.sh <<'EOF'
#!/bin/bash
# Deploys the app with the Fly CLI kept in bin/.
set -e
cd "$(dirname "$0")/.."
./bin/fly deploy --remote-only "$@"
EOF
chmod +x scripts/deploy.sh
