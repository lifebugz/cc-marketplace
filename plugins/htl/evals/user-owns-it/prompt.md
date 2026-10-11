---
description: 'The user already said they will do the login. Claude writes the script and assigns nothing.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

I'll log in to gh myself later. Meanwhile, write deploy.sh: it builds with `npm run build` and publishes dist/app.zip as a GitHub release with `gh release create`.
