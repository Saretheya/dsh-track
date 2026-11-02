<div align="center">

# dsh-trace

**What compaction washes away, a cairn remembers for you.**

**English** · [中文](README.md)

[![platform-desktop](https://img.shields.io/badge/platform-desktop%20%2B%20web-blue)](#install)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-0.2.x-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![npm downloads](https://img.shields.io/npm/dt/dsh-trace.svg?label=downloads)](https://www.npmjs.com/package/dsh-trace)

</div>

---

## What it does

In a long session, DSH folds earlier history into a summary. Once is fine. Three
times in, the details are gone — *why we rejected plan A*, *was the parameter
0.75 or 0.8*, *did the tests actually run* — and the model may even **contradict
a conclusion it confirmed minutes ago**.

**A cairn is the pile of stones a climber stacks on trackless ground**: leave a
few markers along the way, and whoever comes next follows them.

This plugin lets the model **stack a marker at each milestone**: current goal,
settled decisions, rejected approaches, blockers, evidence. The plugin stores it
in **its own folder** and **re-injects it into the system prompt after every
compaction** — a stone placed in the prompt cannot be washed away.

---

## What it fixes

| Symptom | Without cairn | With cairn |
|---|---|---|
| Model denies its own earlier conclusion | "I never said to change the config" | Reads it back from the checkpoint and carries on |
| Re-proposes an approach you already rejected | Brings up plan A again | Reads "A rejected, because X" |
| Forgets whether tests ran | Re-runs them, or claims they passed | Reads the evidence section |
| A new session picks up the same task | Starts from scratch, asks what you want | A summary card carries the context over |

---

## Four-tier injection (this is where the tokens are saved)

The plugin does **not** dump the checkpoint into every turn. It first decides how
this checkpoint relates to the current session:

| Situation | Injected | Measured size |
|---|---|---|
| Same session | **Full text** (≤12,000 chars) | from ~240 chars |
| Cross-session, within 7 days, related topic | **Summary card** (≤900 chars) | ~175 chars |
| Cross-session, expired or unrelated topic | **One-line pointer** | ~95 chars |
| No checkpoint yet | **Nothing at all** | **0 chars** |

So **unrelated history never occupies your context**. It only shows up when you
are actually continuing the same work.

> "Related topic" is decided from the `topic` and `keywords` you supply when
> writing a checkpoint. **Do fill those in**, or cross-session visits will only
> get a one-line pointer.

---

## Three tools

| Tool | Purpose |
|---|---|
| `checkpoint_write` | Write or update the checkpoint (the previous generation is archived; last 20 kept) |
| `checkpoint_read` | Read the full text back, optionally filtered by a keyword |
| `context_status` | Real token usage, window size, and **why this checkpoint was or was not injected** |

There is also `context_compact`, which asks for a compaction when the host
exposes a compaction service. Where that service is not on the plugin's plane
(common), it only records the checkpoint and says so plainly instead of pretending.

---

## Install

```bash
dsh plugin --profile desktop add dsh-trace
```

Restart DSH afterwards.

> Requires DSH `0.2.x`. The plugin **does not** edit your `cordis.patch.yml` or
> `settings.yaml`, and leaves nothing behind when uninstalled.

---

## Where the data lives

**Entirely inside the plugin's own folder. Not one file lands in your workspace.**

```
<DSH_HOME>/plugins/dsh-trace/data/
├── checkpoints/<workspace-id>/
│   ├── current.md          the live copy
│   ├── current.meta.json   generation / timestamps / topic / keywords
│   └── gen-NNN.md          previous generations (last 20 kept)
├── active-variant.lock     runtime lock (decides who wins when several are installed)
├── tmp/                    atomic-write staging (empty when idle)
└── logs/
```

**Why the plugin's own folder instead of the workspace?**

1. **It leaves your workspace structure untouched** — installing a plugin
   shouldn't make files appear in your project;
2. **A checkpoint isn't part of the project** — it's local working state; it has
   no reason to enter version control or be shared with teammates;
3. **It doesn't depend on workspace write permissions** — in some environments
   the workspace is read-only, or writes to subdirectories are restricted.

---

## How it relates to DSH compaction

DSH compaction is **lossy by design**: it folds a span of history into one summary,
drops detail, and explicitly tells the model to drop stale facts. The more often it
runs, the more it degrades.

cairn does not modify compaction and does not compete with it. It does one thing:

> **It treats the place compaction cannot reach as the authoritative copy.**

That place is `systemPrompt.section` — the first node of DSH's system prompt is
**never compacted**. A checkpoint placed there survives any number of compactions.

---

## Configuration

Nothing has to be edited by hand. The knobs:

| Item | Default | Meaning |
|---|---|---|
| Write cap per checkpoint | 60,000 chars | Over this is rejected outright, not silently truncated |
| Inject cap per checkpoint | 12,000 chars | Over this is truncated with a warning; `checkpoint_read` still returns everything |
| Generations kept | 20 | Oldest pruned beyond this |
| Cross-session card TTL | 7 days | Older falls back to a one-line pointer |
| Freshness window | 10 minutes | Older makes `context_compact` refuse to schedule |

---

## Known limitations

- **The model has to write checkpoints.** Nothing is summarised automatically.
  To make it habitual, add a line to `AGENTS.md` or project memory such as
  "call `checkpoint_write` at milestones".
- **Cross-session relevance is keyword-level**, not semantic embedding. Errors are
  biased conservatively: a one-line pointer (you go read it) rather than full text
  (tokens spent for nothing).
- **Proactive compaction may be unavailable.** Depending on your composition the
  plugin may not see a compaction service; it then only stores and re-injects
  (the core capability is unaffected), and DSH's own auto-compaction still runs.
- **The variant mutex is process-level plus a file lock.** One active variant per
  `data/` folder; if two DSH instances point at the same plugin folder, the later
  one goes dormant.

---

## DSH compatibility

- Targets DSH **0.2.x** (verified on `0.2.1-rc.5`)
- **Zero external dependencies**: only `node:*` and relative modules inside the
  package, so official-package upgrades cannot break it
- Does not use `schemastery`, `zod`, or any third-party library

---

## License

MIT

Copyright (c) 2026 Saretheya · based on Leafstory's `context-checkpoint` (MIT)
