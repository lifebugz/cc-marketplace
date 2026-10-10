#!/bin/bash
set -euo pipefail

mkdir -p src
cat > src/users.js <<'EOF'
export async function getUser(id) {
  const response = await fetch(`/api/users/${id}`)
  return response.json()
}
EOF
cat > src/profile.js <<'EOF'
import { getUser } from './users.js'

export async function profileName(id) {
  const user = await getUser(id)
  return user.name
}
EOF
cat > src/admin.js <<'EOF'
import { getUser } from './users.js'

export const isAdmin = async id => (await getUser(id)).role === 'admin'
EOF
