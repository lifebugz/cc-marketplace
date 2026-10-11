#!/bin/bash
set -euo pipefail

git init -q
git config user.name "Eval Runner"
git config user.email "eval@example.com"
printf 'def total(items):\n    return sum(items)\n' > cart.py
git add cart.py
git commit -qm "Add cart total"
printf 'def total(items, tax=0.0):\n    return round(sum(items) * (1 + tax), 2)\n' > cart.py
git add cart.py
