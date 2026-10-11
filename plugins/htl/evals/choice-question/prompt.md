---
description: 'A design choice is a question for AskUserQuestion or plain text, never a task.'
max_turns: 10
allowed_tools: [Read, Glob, Grep, AskUserQuestion]
env:
  EVAL_HTL: "1"
---

Should this CLI use SQLite or Postgres for its local cache?
