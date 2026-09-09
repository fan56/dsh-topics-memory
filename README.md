# dsh-topics-memory

English | [中文](README.zh.md)

A dsh plugin: maintains "working topic memory" as an [OKF (Open Knowledge Format v0.2)](https://github.com/GoogleCloudPlatform/open-knowledge-format) knowledge bundle, persisted in a local git repository (optionally synced to a private GitHub repo), with conclusions traceable through git history, sessions automatically observed and distilled into knowledge, and relevant topics injected to the model before every turn.

> **Requires dsh >= 0.1.2-rc.1** — this plugin targets the dsh RC/stable line only (CI and releases resolve the newest of the `latest`/`next` dist-tags at runtime). **The alpha line is no longer supported.**

## Demo

The full flow in about four minutes: topics captured, distilled, and injected in a real session.

https://github.com/user-attachments/assets/8c06cc98-b1ed-402b-9110-4f9a93eb15bc

## The problem it solves

Long sessions forget. Cross-session, even more so. This plugin maintains **structured topic memory**: each Topic records a matter's **name, dependencies, open questions, current conclusion, impact, and recommendations**. When a conclusion changes, edit the file and commit — `git log` directly answers "when, by whom, and why did this conclusion change".

## Why this plugin exists: memory is edited, not accumulated

The short version: **more memory is not better memory.**

Most memory tools assume accumulation — record everything, retrieve broadly. That may work for humans; for LLMs it backfires twice over. Model attention is a finite resource, so a giant memory bank means every turn is spent digging for signal in noise. Worse, process memories hoard intermediate judgments that were right once and wrong later — and they will confidently steer the model into bad decisions.

So this plugin takes a hard editorial line on what deserves to be remembered: **a topic records exactly four things — the question that started it, the conclusion it reached, what it impacts, and what it depends on. Everything in between — the discussion, the dead ends, the wrong turns — is deliberately not memory.** Process belongs to the session; when the session ends, it goes. Only conclusions that survive distillation make it into the bundle.

Short-term memory is the session's own job — the conversation context already is one, and a plugin that feeds it back is noise. Long-term memory belongs to topics: small, structured, git-traceable, injected in budgeted slices with zero hits meaning zero injection. Every turn hands the model the **minimum high-value context**, not the biggest warehouse.

This plugin is not trying to be the model's notebook. It is trying to be the model's editor: deciding what is worth keeping — and, more importantly, what should be forgotten.

## Core features

- **Strict OKF v0.2 compliance**: each Topic is a `markdown + YAML frontmatter` concept document (`type: Topic`) that the whole OKF ecosystem (Obsidian, OKF validators) can consume directly; ships with the provenance (`sources`), trust (`generated`/`verified`), and lifecycle (`status`/`stale_after`) field families.
- **Git-traceable**: one conclusion change = one commit (write-through); the `topic_history` tool and `/topics history` make change history first-class.
- **Local-first**: local-only mode by default (`~/.dsh/topics/`), zero config, zero credentials; setting `repo` enables GitHub sync (single repo, single bundle, single `main`, write-through + debounced push; rebase conflicts are demoted and flagged for a human — no automatic smart-merge).
- **LLM-free hot-path injection**: per-turn lexical matching (CJK bigrams + words + weighted tags + `depends` graph walk), millisecond-scale; zero matches = zero injection; per-topic digest ≤300 tokens, top-K ≤4, total budget ≤1.5k tokens — all configurable.
- **Observable, tunable injection**: every turn writes an Injection Log (hits, scores, near-misses, budget usage); `/topics stats` reports hit rate, top-N, near-miss distribution, and tuning suggestions — tune from evidence, not vibes.
- **Knowledge as a graph**: `depends` (machine-readable directed edges) plus body `[[wikilinks]]` and markdown links (human-written edges) form one graph; retrieval walks it in both directions (per-level decay, configurable depth) so a single hit pulls in a knowledge subgraph; every write rebuilds the `meta/backlinks.json` reverse index, and `/topics show` lists "who references me, and how" — check the blast radius before changing a conclusion.
- **Two-stage observer (M2)**: the main model jots atomic observations with `topic_observe`; a background distill lane (session end + every N turns, model configurable) distills them into formal Topics in batches; when the model itself deems something worth keeping, it `topic_save`s directly.

## Quick start

1. Install (command below), restart dsh;
2. Run `/topics onboard` — native dsh ask-user panels walk you through the five decisions: mode / repo / distill model / injection tier / auto-observe — nothing is written until the final confirm;
3. Work as usual: relevant conclusions are injected every turn; say "remember…" to have the model `topic_save`; `/topics status` for health, `/topics stats` for injection stats.

## Tools & commands

| Model tools | Purpose |
|---|---|
| `topic_save` | Save/revise a Topic (name / dependencies / open questions / conclusion / impact / recommendations) |
| `topic_observe` | Jot an atomic observation (decision/finding/constraint/question), pending distill |
| `topic_search` | LLM-free keyword search over memory |
| `topic_history` | A topic's conclusion change history (git log as a tool) |

| Command | Purpose |
|---|---|
| `/topics onboard` | Interactive setup wizard on dsh-native ask-user panels (mode / repo / distill model / injection tier / auto-observe); typed fallback where no ask-user UI exists |
| `/topics status` | Bundle health: topic count, observation backlog, conflicts, last distill outcome, sync status |
| `/topics distill` | Manually trigger one distill run over the current observation pool (same lane, same in-flight guard; summary mirrors the distill-state fields) |
| `/topics consolidate` | Manually trigger one consolidation run: the LLM gardener merges duplicates, promotes settled drafts, deprecates superseded entries, refreshes metadata — every change is its own git commit, revert to roll back |
| `/topics stats` | Injection stats: hit rate, top-N, near-miss distribution, tuning advice |
| `/topics list` / `show` / `history` | Browse topics, backlinks, and change history |
| `/topics graph` | Generate a relationship-graph web page (force-directed, draggable/zoomable, hover for conclusions) and open it in the browser |
| `/topics sync [pull\|push]` | GitHub mode: manual pull/push (automatic by default) |
| `/topics config` / `set <key> <value>` | View and edit config (thresholds, budgets, distill model, …) |

## Install

```bash
dsh plugin --profile <your profile> add @aiwayds/dsh-topics-memory
```

First thing after installing: run `/topics onboard`. The bundle lives at `~/.dsh/topics/` by default (`$DSH_TOPICS_HOME` overrides). GitHub sync: `/topics set repo <owner/name>` (suggested repo name `dsh-topics-data`, to keep it distinct from the plugin's own source repo); credentials come from `$GITHUB_TOKEN` or a logged-in gh CLI (login is not this plugin's job).

### Upgrading from 0.5.x (rename)

0.6.0 renames the plugin: `@aiwayds/dsh-llmwiki-memory` → `@aiwayds/dsh-topics-memory`, the `/wiki` command family → `/topics`, and the settings namespace `llmwiki` → `topics`. Install the new package (and remove the old one from your profile) — on first start the plugin migrates everything automatically: the data directory `~/.dsh/llmwiki` is renamed to `~/.dsh/topics`, and user-tuned values in the old `llmwiki` settings namespace are copied into `topics`. No manual steps; if a migration step fails the plugin falls back to the old locations and keeps working.

## Uninstall

Remove the plugin from a profile:

```sh
dsh plugin --profile <name> remove @aiwayds/dsh-topics-memory
```

The host reconciles the profile automatically: the `dsh.profile.bundles` entry is spliced and the patch layer is dropped.

What stays on disk (kept on purpose — this is your memory):

- `~/.dsh/topics/` — the whole topic bundle: topic markdown, `meta/`, and the embedded `.git` repo (the full history; it may carry an `origin` remote — GitHub sync stops with the plugin). To archive the bundle elsewhere, copy or clone this directory as-is.
- `~/.dsh/settings.yaml` `topics:` section — user overrides. Reinstalling silently reactivates sync including any configured `repo`; delete the section first if you want a clean start.
- The legacy `llmwiki:` settings section left by the 0.5.x → 0.6.x migration is never auto-deleted; remove it by hand once nothing needs it.

Purge everything: back up `~/.dsh/topics` first, then `rm -rf ~/.dsh/topics`.

## Configuration

First-time setup belongs to `/topics onboard`; day-to-day tuning is `/topics set <key> <value>` (writes the `topics` namespace in `settings.yaml`, effective from the next session). All keys and defaults:

| Key | Default | Meaning |
|---|---|---|
| `repo` | empty (local-only) | GitHub sync repo `owner/name`; suggested `dsh-topics-data`; empty = back to local-only |
| `autoInject` | `true` | Per-turn injection master switch |
| `injectDedup` | `true` | Session-level injection dedup: topics already injected in this session are not re-injected (registry cleared at session end; budget-dropped topics stay injectable; deduped topK slots are NOT backfilled) — ADR 0012 |
| `suppressEcho` | `true` | Distill-echo suppression: topics distilled from the CURRENT session's own turns are not injected back into it (provenance rides the observations log `sessionId → distilledInto`) |
| `topK` | `4` | Max topics injected per turn |
| `perTopicBudget` | `300` | Per-topic digest token budget |
| `totalBudget` | `1500` | Total injection budget per turn |
| `matchThreshold` | `0.3` | Hit threshold; tune from `/topics stats` near-miss evidence |
| `tagBoost` | `0.15` | Additive boost per tag hit (total cap across hits equals this value) |
| `injectMode` | `pointer` | Injection shape: pointer (light pointers, ≤80 tok each, `topic_open` pulls the full text; total budget capped at 600) / digest (full digest rendering, per-topic 300 / total 1500) |
| `qualityLane` | `sampled` | Slow quality lane: `off` / `sampled` (1/3 of turns) / `always`; produced at `turn/end`, consumed by the next injection (consume-once), never for subagent sessions |
| `graphDepth` | `2` | `depends` graph walk depth (0 disables) |
| `recencyWindowDays` | `7` | Recency bonus window (+0.2) |
| `autoObserve` | `true` | Capture atomic observations every turn |
| `includeSubagents` | `false` | Whether injection and observation also engage subagent sessions (ADR 0011; off by default since 0.7.0); `off` skips them entirely |
| `observationMaxChars` | `2000` | Per-side per-turn observation truncation |
| `distillProvider` / `distillModel` | empty (distill off) | Distill lane model route; both must be set to enable. With a UI, `/topics set distill-provider` / `distill-model` without a value opens a picker panel (provider list → that provider's model catalog); a mixed `provider model` / `provider/model` value for `distill-model` splits into both keys |
| `distillEveryTurns` | `5` | Distill every N turns of a long session |
| `distillOnSessionEnd` | `true` | Distill once when a session ends |
| `distillBatchSize` | `40` | Observations per distill model call. On an output-limit (`max-tokens`) failure the batch halves automatically (floor 5) and retries — a failing batch can no longer livelock the backlog; the shrink persists until reload or a config change. Note: `/topics set distillBatchSize` back to the same value does not reset the shrink — set a different value or reload the plugin |
| `distillMaxModelCalls` | `8` | Max model calls per distill run, including the one corrective retry for ops echoing no valid `observed_ids` (the run stalls when the budget can't fit it). Batches already distilled keep their marks when the budget stops the run (partial progress), recorded as `partial: …` in the distill state |
| `consolidateCadence` | `daily` | Consolidation-lane cadence: `daily`/`3d`/`7d`/`off`. At session start the plugin checks the last consolidation time (`meta/consolidate-state.json`) and, when due, runs the LLM gardener in the background (reusing the distill model route): local lexical clustering only feeds near-look-alike candidate clusters; four op kinds merge/promote/deprecate/refresh, out-of-scope ops are dropped; a failed call never advances the stamp, so the next start retries |
| `deprecatedTtlDays` | `15` | Deprecated topics older than N days are dropped at session start (local rule, no model; each drop is its own git commit — history stays recoverable); `0` disables the sweep |
| `pushDebounceSeconds` | `45` | GitHub-mode debounced push interval |

## Acknowledgements

This project's shape is directly inspired and supported by:

- **[zosmaai/pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki)** — a native OKF v0.2 knowledge extension for pi and this project's direct inspiration; its two-stage observation (cheap atomic observations + background distill), cache-safe injection (volatile content never enters the system prompt), and layered vault & ownership model are all absorbed here.
- **[GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format)** — the Open Knowledge Format (OKF) v0.2 spec this bundle format strictly follows.
- **[Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a5bf55591489e981c11519de94f)** — the starting point of the whole "an LLM maintains a personal knowledge base" methodology.
- **[fan56/pi-topic-memory](https://github.com/fan56/pi-topic-memory)** — the same author's predecessor: a working topic ledger with silent injection for pi; its LLM-free hot-path matching and injection-timing experience is this project's direct technical ancestor.
- **[chancelu/dsh-llmwiki](https://github.com/chancelu/dsh-llmwiki)** — a fellow dsh-ecosystem precedent; this project's same-turn injection seam (`agent/inbox/spliced` + `systemPrompt.context()`) follows the mechanism it validated on real dsh.

## Known boundaries

- **Subagents are out of memory by default — one switch to opt in**: by default (`include-subagents` off since 0.7.0) delegated sessions are skipped entirely — no injection, no observation, no distill triggers; `/topics set include-subagents on` applies injection and observation to them too. The topic tools stay on the global layer, so an explicit `topic_save` from a child still lands. Out-of-process subagents (claude-code/codex providers) never load this plugin anyway.
- **Exit is local-only (0.10.0)**: the plugin's disposer makes one local git commit of the meta sidecars (observations / injections / distill state) and never waits on the network — no pull, no push, no model call, so host exit no longer pays a git round-trip or a bounded distill wait (the old 90s cap is gone; only a 10s guard against a pathological git stall remains). The exit distill trigger is fired fire-and-forget and is skipped entirely while a session-end run is still in flight (the same pool head would otherwise be fed to the model twice). Nothing is lost by skipping: observations are write-through on disk, the deferred push is replayed by the next boot's pull, and the skipped distill is replayed there too (boot-replay). `meta/distill-state.json` records each lane's outcome, checkable via `/topics status`.
- **Observation GC (three strikes)**: an observation the model actually evaluated (parseable answer, however useless) but no op consumed accrues one failed attempt; the third failed attempt physically deletes it — explicitly authorized cleanup of raw data the lane demonstrably cannot process. Runs that never evaluated the batch never count: infrastructure failures (network errors, unconfigured distill route → readable `no-model` short-circuit) and unparseable output (`invalid-output`) are exempt, and a batch still mid-shrink on output-limit retries is only counted once a verdict is reached (success, floor stop, stall, or an explicit skip). Deletions are committed immediately (data destruction stays git-traceable); pure attempt counters follow the usual flush cadence.
- **Config read timing**: `/topics set` and `settings.yaml` edits take effect most reliably from the next session start.
- **Picking a distill model**: `/topics onboard` splits the distill decision into two dependent questions (provider first, then that provider's model catalog), pre-validated with `resolveModelInfo` — a provider with no live route blocks and re-asks, an off-catalog model (a non-NO_ADAPTER failure: outside the advisory catalog, possibly still usable) warns but is allowed; hosts without an ask UI or a usable model route fall back to typed input. The same validation backs the `/topics set` picker panels.

## Design docs

- [CONTEXT.md](CONTEXT.md) — domain glossary
- [docs/adr/](docs/adr/) — 0001–0013: OKF compliance, remote shape, sync strategy, two-stage observer, bundle layout, injection defaults, observability & tunables, dual-mode persistence, onboarding wizard, subagent isolation, the include-subagents switch, injection dedup default-on, the rename & migration

## License

MIT
