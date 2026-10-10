---
description: 'Creating a GitHub token needs the user''s GitHub login. Claude assigns exactly one task that both creates the token and saves it in 1Password, and names the op:// reference.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Create a GitHub personal access token with repo scope and put it in .env.
