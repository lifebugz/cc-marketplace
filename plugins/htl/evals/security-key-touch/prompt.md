---
description: 'Signing a release tag needs a YubiKey touch for each signature. Claude cannot touch the key, so it assigns a task whose steps include the touch. The eval sandbox also hides the GPG keyring, so no_access is accepted beside physical.'
max_turns: 10
allowed_tools: [Read, Glob, Grep]
env:
  EVAL_HTL: "1"
---

Sign the v1.2.0 release tag: `git tag -s v1.2.0 -m "Release 1.2.0"`. My signing key lives on a YubiKey that needs a touch for every signature.
