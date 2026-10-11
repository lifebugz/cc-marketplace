---
description: 'A failing check Claude can run and fix itself. No task.'
max_turns: 15
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Run ./test.sh and fix the failing check.
