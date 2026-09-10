# agents-deep-insights

[简体中文](README.md) | English

Turn your local AI coding-agent sessions into an actionable report: which problems keep recurring, and **which of them are yours to fix**.

![node](https://img.shields.io/badge/node-%3E%3D18-5FA04E) ![dependencies](https://img.shields.io/badge/dependencies-0-2f7a63) ![license](https://img.shields.io/badge/license-MIT-blue)

<img src="docs/media/stats.svg" alt="adi stats output" width="560">

```bash
npx github:gmggyyds/agents-deep-insights          # the screenshot above, 2 seconds, no tokens spent
```

Works with **Codex CLI** and **Claude Code**. Collection and statistics run entirely on your machine — no
telemetry, no account, no third-party server. For deep analysis, `run` sends **redacted excerpts** to
**the model you have already configured** (`codex exec`).

> Prefer a short command? `npm i -g github:gmggyyds/agents-deep-insights`, then just type `adi`.
> Not published to the npm registry yet.

---

## Privacy first

- **Which steps go online, stated plainly**:
  `stats` and `doctor` are **fully local** — no network, no model calls.
  `run` sends redacted session excerpts to the model you configured (`codex exec`); that step
  necessarily goes online, but through your own credentials and quota — this tool has no server of its own.
  Fetching the source via `npx` also uses the network.
- The collector **redacts by default**: JWTs, `sk-` / `ghp_` / `xoxb-` / `AKIA` style keys, tokens in URLs,
  emails, private-key blocks and long opaque strings are replaced *before* anything reaches a model.
  > Not a hypothetical. While extracting a real session during development, it contained a live login token.
- `adi doctor` prints **environment and counts only, never session content** — it is designed to be pasted
  into a public issue.

## Why not just use the built-in one

Claude Code ships `/insights`. **Codex ships nothing.** And the built-in version has three reproducible problems.

**1. Categories drift, so the statistics are wrong.** The official implementation defines 12 friction
categories in its binary, but only states them in the prompt and never validates the output.
On one real machine it produced **35** friction categories and **171** goal categories. Synonym
fragmentation silently changes the ranking:

```
tool_failure 17 + tool_limitation 4 + tool_automation_failure 4 = 25 in reality
the report shows 17 — a 32% undercount
```

This tool puts the enums into the JSON Schema, enforced at **decode time**, then normalizes synonyms back
together. Three runs over the same session:

| Approach | Invalid output |
|---|---|
| **Enum in schema (this tool)** | **0 / 3** |
| Enum in prompt only (official approach) | 2 / 3 |
| ChatGPT web UI | 2 / 3 |

The failures were not invented category names — they were **type drift**: count fields coming back as
`true`/`false`, text fields coming back as arrays or objects. That is the more dangerous kind: every field
name is correct, shallow validation lets it through, and the aggregation layer then miscounts silently.

**2. Sampling collapses, worst for heavy users.** The official version takes "the most recent ~50 sessions".
Same machine, same real data, same sample size:

| Selection | Time span | Distinct days | Sample size |
|---|---|---|---|
| Most recent 50 (official approach) | 14 days | 11 | 50 |
| **Weekly stratified sampling (this tool)** | **32 days** | **18** | 50 |

Identical sample size, more than double the coverage. The more you use the tool, the narrower the official
report's window becomes.

**3. Frictions are reported as one pile, so you cannot act on them.** Twelve categories mixed together
tell you nothing about what *you* could have done differently. This tool adds an attribution dimension —
**yours to fix / model limitation / environment** — and only the first bucket feeds the
"worth writing into AGENTS.md" candidates.

## Three commands

| Command | LLM | Network | Tokens | Notes |
|---|---|---|---|---|
| `adi stats` | no | no | no | Plain statistics. Default command, **cannot fail** |
| `adi doctor` | no | no | no | Environment check. `--issue` emits paste-ready markdown |
| `adi run` | yes | yes | yes | Full analysis, produces an HTML report |

Below, `adi` stands for the command; without a global install, replace it with
`npx github:gmggyyds/agents-deep-insights`.

```bash
adi stats --days 7                 # time window (default 30, 0 = everything)
adi run --limit 30                 # how many sessions to analyze
adi run --model gpt-5.5            # pin a model when your Codex CLI is older
adi run --out ~/report.html        # where to write the report
adi doctor --issue                 # diagnostics ready to paste into an issue
```

Analyzed sessions are cached by content fingerprint, so re-running does not spend tokens twice.

## What's in the report

`adi run` produces something you can act on, not a statistics dashboard:

<img src="docs/media/report.png" alt="report produced by adi run" width="620">

*Real output, generated from synthetic sessions. Note that each item under "what's working" quotes the actual session — a report that cites nothing is worthless. (Report text follows the language of your sessions.)*


| Section | Content |
|---|---|
| Headline | The single most consequential pattern — not a summary of counts |
| What's working | 2-3 items, each grounded in a concrete situation from your sessions |
| **Friction, split three ways** | **Yours to fix** / model limitations / environment |
| Paste-ready rules | Derived only from "yours to fix" frictions repeating across 3+ sessions |
| What to try next | Each with a prompt you can paste straight into your agent |
| **What you're asking the AI to do** | Every message counted by what it asks for (delegate / deliberate / steer), cross-tabbed against outcomes and friction |
| Raw statistics | Collapsed at the bottom, so you can check the claims above |

**The three-way split is the point.** The official `/insights` reports all 12 friction categories
as one pile, leaving you unable to tell which ones were yours. Split apart, the report can say
"here is what you could do differently, concretely" — the other two buckets will not disappear by
asking better questions, so the first one is where the leverage is.

**The collaboration-mode section is a description, not a score.** It counts what your messages ask
for — you already know what you want and are handing off work (delegate), you have not settled the
judgement yet and are working it out together (deliberate), or you are reviewing output and setting
rules (steer). The three add up to more than 100% because a single message often asks for several
things at once, so **multi-label counting is mandatory**: measured on real data, forcing a single
dominant label understates "deliberate" by 2.5× (8.2% vs 20.5%).

**If you first heard these three words in a talk or course**, they are the same thing as "AI Thinking /
AI Working / Oversight" — the report just uses plainer words:

| In the report | In the talk | Test |
|---|---|---|
| delegate | **Working** | You already know what you want; you are having it produced or executed |
| deliberate | **Thinking** | You have not settled it yet; you are converging on a judgement together |
| steer | **Oversight** | Reviewing output or future behaviour, setting rules, recording why something was rejected |

**The easiest thing to misread: this percentage counts messages, not the time or thought behind them.**
"Help me work out whether this model is worth doing" may have cost you half an hour; "continue" costs
one second — both count as exactly one message here. So **a message-count share structurally understates
how much deliberation actually went in**: seeing "deliberate 7%" does not mean only 7% of your thinking
went into thinking.

If you have heard someone say "I now spend ninety percent of my time thinking", that describes **where
their effort sits**, which is a different measure from **share of messages**. **The two numbers are not
comparable.** To see whether you have actually changed, compare the same person, same measure, at two
points in time — not your message share against someone else's description of their effort.

Equally important is what it **cannot** do: a higher or lower share does not mean better or worse.
Measured on the same person three months apart, the three shares moved from 6.3/75.8/17.9 to
7.2/78.6/14.2, driven mainly by what kind of work that period happened to contain. The cross-tab
against outcomes is **correlation, not causation** (easy tasks both need less deliberation and succeed
more readily — that alone can invert the relationship), and any group with fewer than 5 sessions is
reported as "insufficient sample" with no percentage.

All numbers are computed by deterministic code. The model only turns them into prose and cites
evidence; it never counts.

## Design principle

**The model labels; the code counts.**

Per-session friction counts and attribution are **judged by the model**. Aggregation, ranking and threshold
decisions across sessions are computed by deterministic code, which never revises the model's judgement.
So a "count" in the report is a sum of model outputs, not an independent measurement — the report says so too. That is what makes the numbers auditable and reproducible — otherwise
a claim like "this problem occurred 62 times" cannot be used to justify a rule.

Full design and measurements: [docs/DESIGN.md](docs/DESIGN.md) (written in Chinese).

## Known limitations

Stated up front rather than buried:

- **Count fields carry ±1 boundary noise.** Across three runs of the same session, about 4 of 12 friction
  categories shift by one. **Do not read individual numbers too closely; trends and ranking are what hold.**
  Classification fields (outcome, session type) reproduced identically in testing.
- Whether aggregation averages that noise out across many sessions is **not yet properly verified**.
- On the Claude Code side this tool currently reads only the official `session-meta` (metadata, no
  conversation content), so **deep analysis supports Codex sessions only**. `stats` supports both.
- The "what you're asking the AI to do" section depends on conversation content, so it **also only
  works for Codex sessions**; there is no transcript on the Claude Code side and the section is omitted.
- Only tested on macOS + Node 25 + codex-cli 0.131.0 + gpt-5.5. On any other setup, please run
  `adi doctor` and paste the output into an issue — that is exactly the feedback this project needs most.

## Requirements

- Node.js ≥ 18 (**zero runtime dependencies**, nothing installed from npm)
- `adi run` requires Codex CLI, signed in

## Feedback

- **Bugs and usage questions**: open an [issue](https://github.com/gmggyyds/agents-deep-insights/issues).
  Please run `adi doctor --issue` first and paste the output — it contains only environment and counts,
  so it is safe to post publicly. Scope of support: [SUPPORT.md](SUPPORT.md).
- **Email**: gmggyyds@gmail.com

## Credits

The design stands on prior work, although the code was written independently:

- Claude Code's built-in `/insights` — the layered pipeline and per-session labeling approach come from
  observing how it behaves
- [cosformula/codex-session-insights](https://github.com/cosformula/codex-session-insights) — how to read
  Codex sessions, and the `--ephemeral` cold-start cost model
- [melagiri/code-insights](https://github.com/melagiri/code-insights) — the attribution dimension, the
  explicit "LLMs synthesize, they don't count" rule, and noise thresholds
- [atani/codex-insights](https://github.com/atani/codex-insights) — splitting suggestions into persistent
  rules vs. one-off prompts

## License

MIT
