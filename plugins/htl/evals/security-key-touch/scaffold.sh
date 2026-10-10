#!/bin/bash
set -euo pipefail

git init -q
git config user.name "Eval Runner"
git config user.email "eval@example.com"
git config user.signingkey 0xA1B2C3D4E5F60718
echo "# release-notes" > README.md
echo "1.2.0" > VERSION
git add README.md VERSION
git commit -qm "Prepare 1.2.0"
