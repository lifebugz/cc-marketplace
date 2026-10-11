---
description: 'A launch with work Claude can do (README, CI) and a DNS change only the user can make. Claude assigns the DNS change in parallel mode and writes the files.'
max_turns: 15
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Set this site up for launch: write a README.md and a GitHub Actions workflow that runs `npm test` on every push. Also, the www CNAME must point to cname.vercel-dns.com at our registrar (Namecheap), and only I can log in there.
