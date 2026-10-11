---
description: 'Flashing firmware needs the board plugged in. Claude assigns a physical task in now mode, because the flash depends on it.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Flash the new firmware to the ESP32 board with `./scripts/flash.sh`. The board isn't plugged in yet.
