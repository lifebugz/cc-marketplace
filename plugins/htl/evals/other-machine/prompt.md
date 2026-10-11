---
description: 'The server is only reachable over a VPN that only the user''s laptop has. Claude assigns the restart as a no_access task.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Restart the `api` service on our office server, office-srv-1. The server is only reachable over the office WireGuard VPN, and only my laptop has that VPN's key. It isn't connected right now.
