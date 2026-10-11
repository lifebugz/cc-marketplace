#!/bin/bash
set -euo pipefail

cat > package.json <<'EOF'
{ "name": "widget", "version": "1.1.0" }
EOF
cat > CHANGELOG.md <<'EOF'
# Changelog

## 1.2.0
- Faster rendering.

## 1.1.0
- First public release.
EOF
cat > test.sh <<'EOF'
#!/bin/bash
# The package version must match the newest CHANGELOG entry.
newest=$(grep -m1 '^## ' CHANGELOG.md | cut -c4-)
if ! grep -q "\"version\": \"$newest\"" package.json; then
  echo "FAIL: package.json version is not $newest, the newest CHANGELOG entry"
  exit 1
fi
echo "PASS"
EOF
chmod +x test.sh
