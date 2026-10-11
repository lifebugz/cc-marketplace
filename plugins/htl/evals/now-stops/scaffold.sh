#!/bin/bash
set -euo pipefail

mkdir -p migrations
echo 'ALTER TABLE orders ADD COLUMN shipped_at timestamptz;' > migrations/042_shipped_at.sql
cat > migrate.sh <<'EOF'
#!/bin/bash
# Applies migrations/ to the production database at db.internal.
echo "migrate: connecting to db.internal:5432 ..."
echo "migrate: error: could not connect to db.internal:5432: no route to host (are you on the office VPN?)" >&2
exit 1
EOF
chmod +x migrate.sh
