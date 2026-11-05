# dsh-plugin-hop · Cross-machine Relay

<img src="icon.svg" width="84" height="84" alt="Cross-machine Relay icon">

English | [中文](README.md)

One private repository holds every project. `/hop push` on the work machine, one click on **Download** at home — sessions, todos, attachments and code travel together, and the conversation continues without re-briefing the model.

## What it solves

A DSH session is an **event log**: every turn, tool call, todo list (`todo_write`), goal and compaction summary lives in it. Move that log to another machine and re-attach it to the same project, and the model's context is complete — not a summary, the real thing.

| Content | Channel | Notes |
|---|---|---|
| Sessions, todos, goals, attachments | A private relay repository | Exported and imported by the plugin |
| Project code | The project's own git | Snapshot commit on `hop/<device>` |

## Install

1. Clone this repository anywhere.
2. Install it in DSH: `plugin_manager` → `install_bundle` → that directory.
3. Reload the page (⌘R) and the **Relay** icon appears in the sidebar.

## Configure (once per machine)

Open the panel's **Set repository** control, or run:

```
/hop setup git@github.com:you/dsh-hop-myrepo.git
```

Every project on this machine then shares that relay — no per-project setup.

You need a **private** repository (GitHub or Gitee) for relay state only, not project code; both machines can `git clone` it without prompting (SSH key or credential helper); and both run the same DSH version.

> Never paste a token into chat: hand it to `git credential` / the keychain. The plugin stores only the repository URL.

## Usage

**Panel**: sidebar → **Relay** → the project list (green dot = present here, grey dot = not downloaded) → **Download**. Pulls run in the background; the panel polls progress and refreshes when done.

**Commands**:

```
/hop              list projects in the relay
/hop push [note]  hand the current project off
/hop pull name    download it on this machine
/hop status       show this machine's settings
```

With a single project in the relay, `/hop pull` needs no argument. The default destination is `~/dsh-projects/<name>`.

**Tools**: `hop_setup`, `hop_push`, `hop_pull`, `hop_list`, `hop_status` — or just say "hand this project off to my machine at home".

**Sub-sessions**: push includes every subagent session spawned from the current one; pull rebuilds them parent-first.

**Closed sessions**: pass `session` to the tool, e.g. `hop_push({"session":"session-cca62e...","project":"biao-live-v3"})`.

## What is synced

```
relay repo
├── relay.json                         # project index: name, time, session count, source path
└── projects/<project-name>/
    ├── manifest.json                  # device, time, base commit, session/attachment list
    ├── sessions/<id>.json.zst         # session log (header + events, compressed JSONL)
    └── attachments/<sha256>.bin       # images/files referenced by events, content-addressed
```

Session bundles are compressed text (about 6MB for 157 turns); attachments are copied on demand; old absolute paths are rewritten to the new root on import.

## FAQ

**Code did not come along?** The project is not a git repository or has no `origin`; the plugin skips code sync and says so.

**Paths differ?** Pass a destination to pull, or use the default `~/dsh-projects/<name>`; old paths in the log are rewritten.

**Project root vs. session working directory?** `--project` only affects code sync — session paths follow the **session's working directory**. Make the working directory the project directory for perfectly aligned paths.

**Model keys / plugins / skills missing?** They are **not synced**, and should not be. Configure each machine once; that is the only unavoidable setup step.

**Both machines edited the same session?** Relay means *handoff*, not real-time collaboration. A session still running locally is imported as a copy; divergent history creates a new session. Nothing is merged silently.

**Repository too large?** Long sessions with many screenshots reach hundreds of MB. Start fresh sessions periodically, or prune old projects.

**push fails with an auth error?** Every git command runs with `GIT_TERMINAL_PROMPT=0`, so it fails fast. Clone the relay manually once to confirm the credentials work.

## Security

- Session logs can contain secrets you pasted. The relay repository **must stay private**.
- Do not put tokens in URLs; use a credential helper. A token pasted into chat is part of the session log — rotate it after use.
- Anyone you give relay access to can read all of your conversations.

## Development

```
dsh-hop/
├── index.js          Host: commands, tools, JSON routes, git/session transfer
├── client.js         Panel: sidebar.panellist + main
├── cordis.patch.yml  plugin row
└── locale/           display names and descriptions
```

After changing host code, remove and reinstall the bundle so the new JavaScript loads; `client.js` changes only need a page reload.
