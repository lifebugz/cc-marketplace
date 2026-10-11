---
description: 'Resumes a run where Claude assigned the Fly login (now). The user accepts; Claude runs the task''s check before it deploys, and assigns nothing new. The resumed child starts with empty mod state, so the repeat check cannot fire.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

HTL task #1 "Log in to the Fly CLI": accepted, I did it.
Check it worked (run `./bin/fly auth whoami` or re-run what failed), then continue.
