<div align="center">

# dsh-track

**What compaction washes away, a cairn remembers for you.**

**English** · [中文](README.md)

[![platform-desktop](https://img.shields.io/badge/platform-desktop%20%2B%20web-blue)](#install)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-0.2.x-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![npm downloads](https://img.shields.io/npm/dt/dsh-track.svg?label=downloads)](https://www.npmjs.com/package/dsh-track)

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
(which is common), it only records the checkpoint and says so plainly instead of pretending.

---

## When to write a checkpoint: the plugin prompts you

**This is not a "wait for the model to remember" plugin.** Beyond stating the rule
in the prompt, it actively intervenes at **four moments**:

### 1. Usage-crossing notices (injected automatically — the most direct one)

The plugin measures real usage every step and, when you cross a tier, **injects a
notice into the session** (once per tier, so it never nags):

| Tier | Threshold | Injected notice |
|---|---|---|
| `warm` | usage ≥ **50%** of the window | "Past halfway. **First** call `checkpoint_write`, then `context_compact`" |
| `near` | usage ≥ **80%** | "Approaching the limit. **Update the checkpoint now**" |
| `over` | usage ≥ **90%** | "Past the safe line. **Update it immediately**" |

The notice is **pushed to the model by the plugin** — the model does not have to
remember to write.

### 2. A standing prompt section (present in every turn)

As soon as the session has a checkpoint, a rule section stays in the system prompt:

> - This section is the authoritative copy **for this session**; when it conflicts
>   with the project's docs, this section wins — but the repo always wins over both.
> - Order: when context is tight, call `checkpoint_write` **first**, then `context_compact`.

The model does not need to "remember" the convention — it reads it every turn.

### 3. A bundled skill (declarative triggers)

The package ships a `context-checkpoint` skill that names four trigger classes:

| Trigger | Meaning |
|---|---|
| **Explicit pressure signal** | The system or user says context is nearly gone (**highest confidence**) |
| **Milestone** | Root cause found / plan settled / module finished / tests pass / user confirms a decision |
| **Post-compaction reconciliation** | A new `<compacted-summary>` is observed for the first time |
| **Emergency recovery** | An overflow-style error has already surfaced |

### 4. A wake-up message after compaction

Once compaction finishes, the plugin injects a follow-up telling the model
"the checkpoint is on disk, history was compacted — **carry on from where you were,
do not restate finished work**", so it does not start over from scratch.

> **What still needs a human touch**: if a task is purely incremental and never
> reaches 50% nor compacts, none of these notices fire. For those, add a
> **milestone rule** to `AGENTS.md` (e.g. "call `checkpoint_write` after each
> module") so it becomes a fixed habit.

---

## Install

```bash
dsh plugin --profile desktop add dsh-track
```

Restart DSH afterwards.

> Requires DSH `0.2.x`. The plugin **does not** edit your `cordis.patch.yml` or
> `settings.yaml`, and leaves nothing behind when uninstalled.

---

## Where the data lives

**Entirely inside the plugin's own folder. Not one file lands in your workspace.**

```
<DSH_HOME>/plugins/dsh-track/data/
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

- **It does not summarise your conversation.** The plugin picks the moment and
  stores what it is given; *what* to write is the model's judgement. To make it a
  fixed habit at project milestones, add a line to `AGENTS.md` such as
  "call `checkpoint_write` at milestones".
- **Cross-session relevance is keyword-level**, not semantic embedding. Errors are
  biased conservatively: a one-line pointer (you go read it) rather than full text
  (tokens spent for nothing).
- **Proactive compaction may be unavailable.** Depending on your composition the
  plugin may not see a compaction service; it then only stores and re-injects
  (the core capability is unaffected), and DSH's own auto-compaction still runs.
- **One instance per data folder.** The plugin arbitrates with a lock file under
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
