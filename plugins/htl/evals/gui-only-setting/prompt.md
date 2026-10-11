---
description: 'Full Disk Access can only be granted in macOS System Settings. Claude''s tools cannot reach it, so it assigns a no_access task.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Give Terminal Full Disk Access in macOS System Settings, so my backup script can read ~/Library/Mail.
