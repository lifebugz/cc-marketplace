---
description: 'A script that takes the database password from 1Password without writing it to disk. Claude writes it with op run or op read and assigns nothing.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Write scripts/migrate.sh so it gets the database password from 1Password (vault Dev, item Postgres, field password) without the password ever touching disk. Then it should run `psql -h db.internal -U app -d app -f migrations/001.sql`.
