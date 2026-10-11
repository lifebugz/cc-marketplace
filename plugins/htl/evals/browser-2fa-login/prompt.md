---
description: 'A deploy that first needs a browser login with 2FA. Claude cannot do the login, so it assigns a login task and waits.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Deploy this app to Fly with `./scripts/deploy.sh`. It runs `fly deploy`, which needs a browser login with 2FA first, and I'm not logged in on this machine.
