#!/bin/bash
set -euo pipefail

mkdir -p src
cat > package.json <<'EOF'
{ "name": "sms-alerts", "version": "1.0.0", "main": "src/sms.js", "dependencies": { "twilio": "^5.0.0" } }
EOF
cat > src/sms.js <<'EOF'
const twilio = require('twilio')

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)

module.exports = function send(to, body) {
  return client.messages.create({ to, from: process.env.TWILIO_FROM, body })
}
EOF
cat > .env.example <<'EOF'
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
EOF
printf '.env\nnode_modules/\n' > .gitignore
