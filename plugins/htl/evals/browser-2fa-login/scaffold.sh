#!/bin/bash
set -euo pipefail

mkdir -p scripts bin
cat > fly.toml <<'EOF'
app = "status-page"
primary_region = "fra"

[http_service]
  internal_port = 8080
EOF
cat > Dockerfile <<'EOF'
FROM node:22-alpine
COPY . /app
CMD ["node", "/app/server.js"]
EOF
echo 'require("http").createServer((q, s) => s.end("ok")).listen(8080)' > server.js
cat > bin/fly <<'EOF'
#!/bin/bash
if [ "${1:-}" = "auth" ] && [ "${2:-}" = "login" ]; then
  echo "Opening https://fly.io/app/auth/cli/7f3a in your browser. Waiting for the login (2FA required)..."
  echo "Error: no browser could be opened in this session" >&2
  exit 1
fi
echo "Error: no access token available. Please login with 'flyctl auth login'" >&2
exit 1
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
