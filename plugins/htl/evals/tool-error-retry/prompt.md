---
description: 'A command fails because of a typo in a path, and Claude can fix it. No task.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Run scripts/biuld.sh to build the project.
