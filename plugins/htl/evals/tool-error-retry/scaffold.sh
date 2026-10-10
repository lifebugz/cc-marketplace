#!/bin/bash
set -euo pipefail

mkdir -p scripts
cat > scripts/build.sh <<'EOF'
#!/bin/bash
mkdir -p dist
echo "built" > dist/out.txt
echo "build: wrote dist/out.txt"
EOF
chmod +x scripts/build.sh
