# chrome-profile: know which Chrome profile is which

When Claude in Chrome is connected in more than one Chrome profile, Claude Code
calls the browsers "Browser 1", "Browser 2", and so on. You cannot tell which
profile or Google account each one is, and the numbers change from one session
to the next.

This mod tells Claude, and you, which profile, Google account and computer
each browser is. Claude then picks the right profile for each task by itself,
and can use two or more profiles in one session. The mod never asks you which
profile to use, and it never blocks a browser call.

Tested with Claude Code 2.1.325 in the terminal, the VS Code extension and the
Desktop app, with Claude in Chrome 1.0.107 and Google Chrome on macOS.

## Install

```
/plugin install chrome-profile --marketplace lifebugz/cc-marketplace
```

Confirm that Claude Code may add the marketplace, then pick a scope. There is
nothing to set up: the mod has no settings.

## What Claude sees

Each browser gets a label: the profile, then the computer it runs on.

```
Work (some.one@example.com) · Office Mac
```

| The browser's profile                                          | Its label                                                |
| :------------------------------------------------------------- | :------------------------------------------------------- |
| Has a Google account                                           | `Work (some.one@example.com) · Office Mac`               |
| Is named after its account                                     | `some.one@example.com · Office Mac`                      |
| Has an account signed in on the web only                       | `Scratch (web: some.one@example.com) · …`                |
| Has no Google account                                          | `Scratch (no account) · Office Mac`                      |
| Is unknown, but you named it                                   | `Work (named by you) · Office Mac`                       |
| Is unknown                                                     | `Browser 2 (profile unknown) · another macOS computer`   |
| Is unknown, and this computer's Chrome files could not be read | `Browser 2 (profile unknown) · a macOS computer`         |
| Is unknown, in Desktop (it says the browser runs here)         | `Browser 2 (profile unknown) · Office Mac`               |
| Runs on another computer, and you named it                     | `Browser 2 (profile unknown) · Home PC`                  |
| Runs on another computer you have not named                    | `Browser 2 (profile unknown) · another Windows computer` |

The labels show up in four places:

1. **The browser list.** When Claude calls `list_connected_browsers`, each
   browser's `name` is its label. New fields add the rest: `bridgeName` (the
   original name), `profile` (the profile's name, its email, and every Google
   account signed in to it), `machine` (the computer's name and whether it is
   this one) and `extensionVersion`. The `deviceId` stays as it was, so Claude
   still switches with it.
2. **Each switch.** `select_browser` answers
   `Selected browser "Work (some.one@example.com) · Office Mac".`
3. **The session's first browser call.** Its result comes with a note that
   lists every connected profile.
4. **Every prompt after that**, when two or more browsers are connected, one
   line goes to Claude:

   ```
   Connected Chrome profiles: Work (some.one@example.com) · Office Mac
   (also: web.one@example.com) [in use], Personal (other.one@example.com) ·
   Office Mac. Switch with select_browser.
   ```

   `(also: …)` names the profile's other Google accounts, the ones its label
   does not show.

   Before the session's first browser call, the mod adds nothing and never
   connects to the browser, so a session that does not use the browser costs
   nothing.

A subagent (a helper Claude starts for part of a task) sees the same labels
as Claude.

## Name a browser the mod cannot identify

The mod finds each browser's profile in this computer's Chrome files. For a
browser it cannot find, give it a name:

- `/chrome-profile name Work`: names the profile of a browser whose profile is
  unknown. Once the mod can read the browser's real profile, the real name
  and email replace yours.
- `/chrome-profile machine Home PC`: names the computer of a browser that runs
  on another computer.

With one such browser, the command names it at once. With several, it asks
which one.

## What the mod reads and keeps

It opens these files read-only, in Chrome's folder
(`~/Library/Application Support/Google/Chrome`):

- `Local State`: each profile's name, email and Google account details.
- Each profile's `Preferences`: only `account_info`, the Google accounts
  signed in to that profile. The file also holds password data, which the mod
  never reads.
- Claude in Chrome's own storage in each profile, to find which profile each
  browser is.
- The extension's folder name, for its version.

It also runs `scutil --get ComputerName` for this computer's name.

It keeps, on this computer only, what it learned about each browser, the
names you gave, and this computer's name. That lets an app that cannot read
Chrome's files (see below) still show the labels.

The labels, and with them your profile names, emails and computer names, go
into what Claude reads. That is the point of the mod. Nothing else leaves
your computer.

## Claude Desktop on macOS

In the Desktop app, macOS does not let Claude Code read Chrome's files, and it
shows no prompt. The mod then uses what a terminal or VS Code session of the
same install learned. So run one browser task in the terminal or in VS Code
first. A browser the mod has never seen shows as
`Browser 3 (profile unknown)` until you name it with `/chrome-profile name`.

In auto mode, Desktop also refuses the mod's own call to list the browsers.
The mod then uses the last list Claude itself got in that session. Until
Claude has listed the browsers, a switch shows the old name, no profile line
is added, and `/chrome-profile name` answers "No browsers are connected." Ask
Claude to list the browsers first.

### Let Desktop read Chrome's files (untested)

These steps were **not tested**. macOS privacy settings are yours to change.

Desktop runs Claude Code as its own app, so macOS asks whether that app,
not Desktop, may read the files:

```
~/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app
```

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Click **+**, press **Cmd+Shift+G**, and paste the folder above with the
   version in it (look in `~/Library/Application Support/Claude/claude-code/`).
3. Pick `claude.app`, turn it on, and start a new Desktop session.

The folder changes with every Claude Code version, so the setting may stop
working after an update.

## Limits

- Google Chrome on macOS only, for now. Other Chromium browsers and Linux and
  Windows come later.
- The mod reads only this computer's files. A browser on another computer
  shows its computer, but not its profile, until you name it.
- Claude Code's own `/chrome` → **Select browser…** list still shows
  "Browser 1".
- Every `select_browser` also becomes the app's default pick. Sessions of the
  same app that have not picked a browser yet follow it. That is Claude Code's
  behavior, and the mod cannot change it.
- After you resume a session, the profile line starts again at that session's
  next browser call.
