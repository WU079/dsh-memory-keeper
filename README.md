# dsh-memory-keeper

> Cross-session memory for [DSH](https://github.com/deepseek-ai/deepseek-harness). Every session is exported to a
> readable Markdown transcript (dialogue only), one long-term `MEMORY.md` is kept as the main file, and a new window
> gets a compact wake-up summary instead of starting from nothing.

English | [中文](README.zh.md)

## What it is

`dsh-memory-keeper` gives an agent a memory that survives windows. It reads DSH's own session files (read-only),
turns each conversation into plain Markdown with every message tagged by provenance, keeps a long-term `MEMORY.md`
that the agent writes to, and assembles a small "wake up" digest when a fresh conversation begins.

## Why

DSH sessions are isolated. Open a new window and the previous conversation is simply gone from the agent's view —
only a compressed session file stays on disk, in a format meant for DSH itself, not for reading. Long conversations
also get compacted, and details quietly fall out of context. So an agent that was told something last week has no
reliable way to remember it today.

This plugin closes that gap:

- **Session transcripts** — every session becomes `<dataDir>/sessions/<workspace>/<date>_<id8>.md`, dialogue only
  (user / assistant text), each message carrying a `sessionId#seq` provenance marker. A table index
  (`sessions/INDEX.md`) and a machine-readable `sessions/index.json` are maintained alongside. Sub-agent sessions
  (`origin: subagent` / sessions with a `parentSession`) are worker transcripts of a parent conversation and are
  skipped, so search results stay dialogue rather than delegation plumbing.
- **One long-term main file** — `MEMORY.md`, the durable file you and the agent actually curate.
- **Wake-up digest** — `mem_wake` returns a compact summary bounded by `wakeMaxChars`.
- **Optional housekeeping** — archive stale sessions out of the way, and optionally back the data directory up to a
  git remote.

Nothing is hard-coded to a particular home directory or persona; `dataDir` is configurable.

## How it differs from DSH's built-in memory tools

DSH ships its own `memory_*` tools: small key-value notes, scoped to `project` or `user`, saved and searched by the
agent itself. Those are for facts the agent decides are worth pinning — a preference, a decision, a convention.

This plugin handles a different job:

| | built-in `memory_*` tools | `dsh-memory-keeper` |
|---|---|---|
| unit of memory | a short note in a key-value store | a whole session transcript + `MEMORY.md` |
| scope | `project` / `user` | a data directory you choose |
| what you get back | notes matching a keyword | the original dialogues, with file + line provenance |
| lifecycle | written when the agent decides | exported on a timer, archived when old |

They solve different problems and are happy to coexist — the tool names differ (`mem_*` vs `memory_*`), so installing
this plugin does not shadow or conflict with the built-in ones.

## Install

```bash
# from npm (after it is published)
dsh plugin --profile <your-profile> add dsh-memory-keeper

# from a local checkout
dsh plugin --profile <your-profile> add link:F:\path\to\dsh-memory-keeper
```

The plugin declares `dsh.bundle`, so the profile just has to list the package in `dsh.profile.bundles`. Restart the
profile afterwards (or reload it) and the `mem_*` tools appear.

Then open **Settings → Plugins → Cross-session memory** and point it at a data directory, or leave that empty and
accept the default.

## The four tools

### `mem_wake`

No arguments. Returns the "what happened while you were away" digest: data directory, last export time, read/write
mode, the first `wakeEntries` items of `MEMORY.md`, the last three days of diary titles, and the recent session
index — all capped at `wakeMaxChars` characters.

```
mem_wake
```

### `mem_search`

Searches the data directory and returns hits with file, line number and the matching text. `scope` is
`all` | `memory` | `diary` | `sessions`.

```
mem_search { "query": "语音克隆", "limit": 10, "scope": "all" }
```

### `mem_write`

Writes to the main file or to today's diary. `target` is `memory` (default) | `diary`; `mode` is `append`
(default) or `replace-section` (which requires `section`); `section` names the heading to replace. A `.bak` copy is
made before the write, and only the targeted section (or the end of the diary) is touched — never a full rewrite.
The result reports bytes and sha256 before/after so you can verify. Refused when `writable` is `false`. Optional
`note` says why you are writing (plugin log only, not stored in the main file), `withDate` controls the date suffix
on single-line entries (default `true`), and `day` picks the diary date (default today).

```
mem_write { "content": "- 2026-10-24: 插件脚手架开工", "target": "memory", "mode": "append" }
mem_write { "content": "...", "target": "memory", "mode": "replace-section", "section": "事实台" }
mem_write { "content": "Finished the settings panel today.", "target": "diary" }
```

### `mem_status`

No arguments. Returns the current state: data directory and where it came from, mode (read-only / read-write), main
file size and mtime, diary and session counts, last export / archive / backup times, and the effective config.

```
mem_status
```

## `/mem` command

| command | what it does |
|---|---|
| `/mem wake` | same digest as `mem_wake` |
| `/mem tidy` | incremental export, then archive sessions older than `keepDays` that are not the newest in their workspace (`archive` off = export only) |
| `/mem export` | export sessions right now (`--force` regenerates everything) |
| `/mem search <word>` | same search as `mem_search` |
| `/mem status` | same state as `mem_status` |

## Settings

The panel lives at **Settings → Plugins → Cross-session memory**. It reads and writes
`$DSH_HOME/memory-keeper/config.json`, the same file the `/api/memory-keeper/*` routes use.

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch for background work |
| `autoExport` | `true` | whether the timer actually runs |
| `dataDir` | `""` | data directory; empty = `$DSH_HOME/memory/<workspace name>` |
| `exportIntervalHours` | `6` | auto-export interval in hours, clamped to 1–168 |
| `archive` | `false` | move expired old sessions into `$DSH_HOME/sessions-archive` |
| `keepDays` | `14` | archive threshold in days, clamped to 1–3650 |
| `wakeMaxChars` | `2000` | cap on the `mem_wake` digest, clamped to 200–20000 |
| `wakeEntries` | `6` | how many `MEMORY.md` entries the digest shows, clamped to 1–50 |
| `writable` | `true` | allow `mem_write`; `false` = read-only mode |
| `userLabel` | `用户` | speaker label for the user in exported transcripts |
| `assistantLabel` | `助手` | speaker label for the assistant in exported transcripts |
| `githubRemote` | `""` | git remote for backup; empty = backup disabled |
| `githubPush` | `false` | push after a backup |
| `searchLimit` | `20` | default number of `mem_search` hits, clamped to 1–200 |

The `userLabel` / `assistantLabel` defaults are the Chinese labels `用户` / `助手`; change them if you prefer other
speaker names in the exported transcripts.

### HTTP routes

The panel uses these (same-origin, same local login as other DSH panels):

| method | path | purpose |
|---|---|---|
| `GET` | `/api/memory-keeper/status` | state view (what `mem_status` returns) |
| `GET` | `/api/memory-keeper/config` | current config + defaults + resolved data directory |
| `POST` | `/api/memory-keeper/config` | merge and save a config patch, returns the new config |
| `POST` | `/api/memory-keeper/export` | export now; body may carry `{ "force": true, "limit": 10 }` |
| `POST` | `/api/memory-keeper/archive` | archive; body may carry `{ "dryRun": true }` to only preview |
| `GET` | `/api/memory-keeper/search?q=word&limit=20` | same as `mem_search` |
| `GET` | `/api/memory-keeper/wake` | same as `mem_wake` |

## Data directory

`dataDir` defaults to `$DSH_HOME/memory/<workspace name>` (on a default install that is
`~/.dsh/memory/<workspace name>`). Set it explicitly if you want memory in a synced folder instead.

```
<dataDir>/
  MEMORY.md                  main file: the durable memory you curate
  diary/YYYY-MM-DD.md        one diary file per day
  sessions/INDEX.md          human-readable table index
  sessions/index.json        machine-readable index
  sessions/<wsName>/<YYYY-MM-DD>_<id8>.md
  state.json                 { lastExportAt, lastArchiveAt, lastBackupAt, lastBackupError, lastExportResult }
```

## Safety and read-only guarantees

- **DSH's sessions are read-only.** The plugin only ever reads `~/.dsh/sessions/**`. It never writes back and never
  deletes anything there.
- **Archiving is off by default and explicit.** With `archive: true`, sessions older than `keepDays` that are not
  the latest session of their workspace **and** that were already exported successfully once are moved with
  `rename` into `$DSH_HOME/sessions-archive`. Sessions that were never exported are never touched, and when
  `archive` is `false`, nothing is moved.
- **Writes to the main file are guarded.** Before touching `MEMORY.md` (or a diary file) a `.bak` copy is left next
  to it, and only the targeted section is replaced — the rest of the file is left byte-for-byte alone.
- **No network by default.** Leave `githubRemote` empty and the plugin makes no outbound connection at all. Backup
  only happens after you fill that in.

## Privacy

Session transcripts contain the full conversation content. By default everything stays on your local disk under
`dataDir`. Do not put `dataDir` inside a public repository, and if you enable the GitHub backup, remember you are
pushing your conversations to that remote — leave it empty unless you are comfortable with that.

## Requirements

| piece | what |
|---|---|
| DSH | 0.2.x, on a profile that can install plugins |
| Node.js | >= 22 |

## License

MIT — see [LICENSE](LICENSE).
