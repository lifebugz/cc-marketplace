#!/bin/bash
set -euo pipefail

cat > deploy.sh <<'EOF'
#!/bin/bash
set -euo pipefail
npm run build
aws s3 sync dist/ s3://acme-site-prod --delete
aws cloudfront create-invalidation --distribution-id E2EXAMPLE123 --paths "/*"
EOF
chmod +x deploy.sh
