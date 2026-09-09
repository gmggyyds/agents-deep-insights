# agents-deep-insights

[简体中文](README.md) | English

Turn your local AI coding-agent sessions into an actionable report: which problems keep recurring, and **which of them are yours to fix**.

![node](https://img.shields.io/badge/node-%3E%3D18-5FA04E) ![dependencies](https://img.shields.io/badge/dependencies-0-2f7a63) ![license](https://img.shields.io/badge/license-MIT-blue)

<img src="docs/media/stats.svg" alt="adi stats output" width="560">

```bash
npx github:gmggyyds/agents-deep-insights          # the screenshot above, 2 seconds, no tokens spent
```

Works with **Codex CLI** and **Claude Code**. Everything runs on your machine — no uploads, no telemetry, no account.

> Prefer a short command? `npm i -g github:gmggyyds/agents-deep-insights`, then just type `adi`.
> Not published to the npm registry yet.

---

## Privacy first

- Session content is read **locally** and sent only to **the LLM you already configured** (`codex exec`).
  It never passes through a third-party server.
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

## Design principle

**The model labels; the code counts.**

Every count, ranking and threshold decision is computed by deterministic code. The model only produces a
structured label for a single session. That is what makes the numbers auditable and reproducible — otherwise
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
