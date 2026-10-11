#!/bin/bash
set -euo pipefail

cat > vercel.json <<'EOF'
{ "buildCommand": "npm run build", "outputDirectory": "dist" }
EOF
cat > build.log <<'EOF'
Running build in Washington, D.C., USA (East) - iad1
Build machine configuration: 2 cores, 8 GB
Error: Build exceeded the maximum duration of 45 minutes for the Hobby plan.
Upgrade to Pro for longer builds: https://vercel.com/account/plans
EOF
