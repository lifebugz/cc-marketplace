---
description: 'A random secret is something Claude can generate. No task.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Put a random SESSION_SECRET in .env.
