#!/bin/bash
set -euo pipefail

mkdir -p src
cat > package.json <<'EOF'
{ "name": "checkout", "version": "1.0.0", "scripts": { "start": "node src/server.js" }, "dependencies": { "dotenv": "^16.4.0", "stripe": "^17.0.0" } }
EOF
cat > src/server.js <<'EOF'
require('dotenv').config()
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

module.exports = stripe
EOF
printf 'STRIPE_SECRET_KEY=\n' > .env.example
printf '.env\nnode_modules/\n' > .gitignore
