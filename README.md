<div align="center">

<img src="build/icon.png" width="96" alt="">

# Claude Memory Sync

Back up, move and two-way sync Claude Code memories, VS Code workspaces and Claude settings between macOS and Windows.

![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-1f2328?logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-5FA04E?logo=nodedotjs&logoColor=white)

[Features](#features) · [Screenshots](#screenshots) · [Install](#install) · [Usage](#usage) · [How it works](#how-it-works) · [Command line](#command-line) · [Development](#development)

</div>

<br>

![Overview screen](docs/screenshots/overview.png)

## Why

Claude Code keeps what it learns about a project as memory files under `~/.claude/projects/<project>/memory` on the
machine it runs on. The folder name is derived from the project's absolute path, so copying it to a machine where the
project lives elsewhere does not work. Claude Memory Sync matches memories to projects on each device, shows every
change before writing it, and backs up the device before every write.

## Features

- **Everything on the device in one place.** Every Claude project, memory file and workspace, where each one comes
  from, and whether it is in the last bundle.
- **One-file transfer.** Selected items are packed into a `.memsync` bundle. Double-clicking it on the other device
  opens the import.
- **Automatic project matching.** By git remote first, then by the path relative to the home folder. Uncertain matches
  are offered but not preselected.
- **Two-way, versioned sync.** New, updated, deleted and conflicting files are listed separately. A conflict is resolved
  per file: keep this device's version, take the incoming one, or keep both. `MEMORY.md` is merged line by line.
- **Workspace-aware.** Workspace files can be picked one by one for a bundle. Each incoming workspace is checked
  against the repositories it opens; a workspace whose repositories are not on the device is not preselected.
- **Claude Code chats,** optionally, with everything that belongs to them: sub-agent conversations, large tool outputs,
  file history, added files, typed prompts and the desktop app's record. No chat on the receiving device is deleted or
  shortened; a chat continued on both devices arrives as a separate copy.
- **Backup before every write,** even when a recent backup exists. Any import can be undone in one click.
- **Daily backups** from the menu bar (macOS) or the system tray (Windows).
- **Full backup before a reset.** Memories plus the app's own settings, version history, activity log and every
  earlier backup in one file; restoring it brings everything back where it was.
- **Command line** built on the same core as the app.
- **English, Turkish, German, Spanish and French,** light and dark. The app follows the system language and appearance;
  both can be changed in Settings.

## Screenshots

### Memories

Every Claude project on the device with its project folder, memory folder, git remote and files. Projects are included
in or excluded from bundles here.

![Memories](docs/screenshots/memories.png)

### Workspaces

`.code-workspace` files in the scanned folders and the folders they open. Paths that will not open on another device
(absolute paths, backslashes) are flagged and can be fixed in one click.

![Workspaces](docs/screenshots/workspaces.png)

### Import

An incoming bundle is imported in five steps: bundle, matching, changes, confirmation, result.

**Matching** shows where each part of the bundle goes on this device. A project that is not on the device shows the
`git clone` command to run.

![Import: matching](docs/screenshots/import-matching.png)

**Changes** lists only the files that differ, grouped by kind. Each file can be diffed or left out; a change that is left
out is offered again in the next import.

![Import: changes and a conflict decision](docs/screenshots/import-changes.png)

The **Workspaces** tab lists each workspace with the repositories it opens. Workspaces whose repositories are all on
the device are preselected.

![Import: workspaces](docs/screenshots/import-workspaces.png)

### Backups and history

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/backups.png" alt="Backups"></td>
    <td width="50%"><img src="docs/screenshots/history.png" alt="History"></td>
  </tr>
  <tr>
    <td>Daily, pre-operation and manual backups, and bundles from other devices. Any of them can be inspected or restored.</td>
    <td>Every operation. Undoing an import restores only the files it changed, from the backup taken right before it.</td>
  </tr>
</table>

## Install

Download the installer for your system from the [latest release](https://github.com/omersahin00/claude-memory-sync/releases/latest):

| System | Installer |
|---|---|
| **macOS** · Apple Silicon (M1 or later) | `Claude-Memory-Sync-macOS-Apple-Silicon-<version>.dmg` |
| **macOS** · Intel | `Claude-Memory-Sync-macOS-Intel-<version>.dmg` |
| **Windows** · 64-bit | `Claude-Memory-Sync-Windows-Setup-<version>.exe` |

Not sure which Mac you have? In the Apple menu, choose About This Mac: "Chip: Apple M…" is Apple Silicon,
"Processor: Intel" is Intel.

On macOS, open the dmg and drag the app to Applications. On Windows, run the installer.

The installers are not code-signed. On macOS, the first launch has to be allowed in System Settings → Privacy &
Security → Open Anyway. On Windows, choose More info → Run anyway in the SmartScreen dialog.

### Build from source

The only requirement is [Node.js](https://nodejs.org) 22.12 or later; build tools are installed into the project
folder, not system-wide. Clone the repository and double-click the build script for your system, `build-mac.command`
or `build-win.cmd`. It pulls the latest code, builds the installers into `release/` and opens that folder.

```
git clone https://github.com/omersahin00/claude-memory-sync.git
```

## Usage

**Move to a new device.** On the old device, choose **Transfer → Create bundle**. Copy the bundle, saved to the Desktop
by default, to the new device and double-click it. Projects are found by git remote or path. If a project folder exists
but Claude Code has never opened it, its memory folder is created.

**Sync again.** After working on both devices, open a new bundle. Only the changes are shown, and conflicts require a
decision.

**Take chats along.** In **Create bundle**, open a project under **Chats** and tick the chats to send; the project's
memory is ticked with them. On the other device they are listed in the **Chats** tab of the import. Bundles with chats
need version 2.4 or later on both devices.

**Reset or reinstall.** In **Backups**, choose **Full backup** and keep the file off the computer. After the reset,
install the app and double-click the file: memories, workspace files and Claude settings go back where they were, the
app's settings, version history, matches, activity log and earlier backups come back, and the app continues where it
left off. A full backup restores on the same operating system; to move to another one, use a bundle.

**Undo.** **History** lists every import with an **Undo** button.

## How it works

### What is included

| Category | Source |
|---|---|
| Project memories | `~/.claude/projects/<project>/memory/**` |
| Workspace files | `*.code-workspace` under the scanned folders, up to 3 levels deep, not inside git repositories |
| Claude settings | `~/.claude/CLAUDE.md`, `agents/`, `commands/`, `skills/` (except `skills/synced`), `output-styles/` |
| Chats (when selected) | `~/.claude/projects/<project>/<id>.jsonl` and `<id>/`, `~/.claude/file-history/<id>/`, `~/.claude/uploads/<id>/`, the chat's lines in `~/.claude/history.jsonl`, the desktop app's `claude-code-sessions` record |

Backups contain every memory, workspace file and Claude setting, and full backups every chat as well; bundles contain
what you select. Sessions of the Claude desktop app that have no project
folder (`scratch-workspaces`) are backed up but left out of bundles by default. `CLAUDE_CONFIG_DIR` is respected.

### Matching

Claude Code names a project's folder after the project's absolute path, so the same project has a different folder name
on each device. An incoming project is matched in this order: a match confirmed earlier, the same git remote, the same
path relative to the home folder (`Documents/GitHub/x`), an existing folder that Claude Code has not opened yet. A
project that matches only by name is suggested but not preselected. The workspace folder is the one that holds the
repositories the incoming workspaces open. Confirmed matches are remembered.

### Versioning

Each device records the hash of every version it has seen of every file and includes these hashes in bundles. This is
how a file deleted on the other device is told apart from a file added on this one.

| Situation | Group | Default |
|---|---|---|
| Added on the other device | New | Take |
| Added on the other device; a workspace whose repositories are not here | New | Skip, offered again next time |
| Changed on the other device only | Updated | Take |
| Deleted on the other device, unchanged here | Deleted | Delete |
| Changed on both devices | Conflict | Decision required |
| Changed here and deleted there, or the reverse | Conflict | Decision required |
| Added, changed or deleted only here | Kept | Untouched |
| A workspace file the other device left out of the bundle | (not listed) | Untouched, also in a restore |
| `MEMORY.md` | Merge | Merged line by line; a line that differs is asked |

### Chats

A chat goes to its project's Claude folder on the receiving device; its prompt history and the desktop app's record are
pointed at the project folder there. The desktop app's record is written only when the app on that device uses the same
account.

| Situation | Result |
|---|---|
| Not on this device | Added |
| Continued on the other device (this device has its beginning), or some of its files are missing here | Brought up to date |
| The same on both devices | Untouched |
| Further along on this device | Untouched |
| Continued on both devices | Added next to this device's chat under a new id; its title names the other device |

Chats are not part of daily and pre-operation backups, since an import never overwrites a chat with something shorter,
and undoing an import does not remove the chats it brought in.

### Safety

- Before every import, restore, undo and workspace fix, a full backup of the device is written and verified by reading
  it back, even if a backup was just taken.
- If a file changes after the plan was made (for example, Claude wrote to it meanwhile), nothing is written and the plan
  is rebuilt.
- Each file is written to a temporary file and moved into place. If a write fails, everything written so far is rolled
  back.
- Every written file is read back and checked. Version history is updated only after that.
- Bundle contents are verified against their hashes; a damaged bundle is rejected.
- Line ending (CRLF/LF) and BOM differences do not count as changes.
- A memory folder that suddenly looks empty is left out of bundles, so it cannot turn into a mass delete on the other
  device.
- Invalid Windows file names and names that differ only by case are rejected before anything is written.
- The window can call only an allow-listed set of core functions. The app makes no network requests.

### Files

| What | Where |
|---|---|
| Settings, version history, activity log | `~/.claude-memory-sync/` (`config.json`, `history.json`, `state.json`, `activity.jsonl`) |
| Backups | `~/.claude-memory-sync/backups/{daily,before,manual}` (configurable) |
| Bundles | Desktop by default: `claude-memory-<device>-<date>.memsync` |

A `.memsync` file is gzipped JSON and is opened with the app. A bundle with chats stores each file as a separately
compressed part with the index at the end, so chats of any size are read only while they are written; every part is
checked against its hash.

## Command line

```
node cli.js status              # what is on this device (read-only)
node cli.js backup [-o folder]  # create a bundle for another device
node cli.js sync <bundle>       # two-way merge with a bundle
node cli.js restore <bundle>    # make this device match a bundle
node cli.js config              # device name and workspace folders
```

## Development

```
npm install
npm run dev          # development mode (Vite + Electron)
npm test             # tests
npm run dist:mac     # macOS installers into release/
npm run dist:win     # Windows installer into release/
```

`release/` holds only installers; intermediate build output stays in `dist/electron`. The screenshots on this page are
rendered from two sample devices, without real data; the last argument is the interface language:

```
CMS_SCALE=2 node scripts/screenshots.mjs <folder> dark en
```

| Path | Contents |
|---|---|
| `lib/` | Core. `engine.js` is the single entry point for both the app and the command line |
| `app/` | Electron main process, preload script and the React interface (`app/renderer`) |
| `app/locales/` | Interface texts, one JSON file per language |
| `cli.js`, `lib/commands/` | Command line |
| `scripts/` | Development, packaging and screenshot helpers |
| `test/` | Tests (`node:test`) |
| `docs/` | [Design notes](docs/TASARIM.md) (in Turkish) and screenshots |

### Translations

To add a language, copy `app/locales/en.json` to a file named after the language code (`it.json`, `pt.json` …) and
translate the texts, keeping every `{placeholder}`. Texts with `one` and `other` forms follow the plural rules of the
language. The new language appears in Settings; `npm test` reports missing texts and placeholders.

### Releasing

Set the new version in `package.json`, commit, and push a matching tag:

```
git tag v2.0.1
git push origin v2.0.1
```

The [release workflow](.github/workflows/release.yml) builds the macOS and Windows installers on GitHub and publishes
them on the Releases page.

## Migrating from 1.x

On first launch the 1.x `config.json` (`reposRoot`, `prefix`) is converted, and the old files are kept as
`config.v1.json` and `history.v1.json`. Bundles from 1.x can be imported, but 1.x cannot read new bundles, so update
both devices. The 1.x prefix filter is gone: every project is listed, and you choose what goes into a bundle.
