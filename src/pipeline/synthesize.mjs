/**
 * L5 叙事合成。
 *
 * 与 L3 的分工（这是本项目最容易做错的一处）：
 *   L3 打标  → 结构化枚举，喂给 L4 做确定性统计
 *   L5 合成  → 人话叙事，输入是「L4 已经算好的数字」+「L3 采集的自由文本」
 *
 * 「LLM 只打标不计数」约束的是**计数**，不约束**叙事**。
 * 没有这一层，产出就只是一张统计报表，读者拿不到可执行的东西。
 *
 * 硬约束：本层拿到的是算好的数字，不允许模型重新计数或推翻排序。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLoose } from '../schema/normalize.mjs';
import { redact } from '../redact.mjs';

/**
 * codex exec 的执行选项。三个都不是可选项：
 *   cwd            → 在临时目录跑。留在仓库里 codex 会加载项目 AGENTS.md 与全局 skill，
 *                    把「读输入出 JSON」当成「要干的活」，然后满世界跑工具。
 *   ignore-user-config → 同上，切断用户级配置。
 *   maxBuffer      → 上面那种「干活模式」输出几百 KB，Node 默认 1MB 缓冲会 ENOBUFS，
 *                    而 ENOBUFS 的报错信息里看不出真正原因，极难定位。
 */
function EXEC_OPTS(input, timeout, cwd) {
  return { input, cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout, maxBuffer: 64 * 1024 * 1024 };
}

export const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    working_well: {
      type: 'object', additionalProperties: false,
      properties: {
        summary: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: { title: { type: 'string' }, detail: { type: 'string' } },
            required: ['title', 'detail'],
          },
        },
      },
      required: ['summary', 'items'],
    },
    friction_narrative: {
      type: 'object', additionalProperties: false,
      properties: {
        yours_to_fix: { type: 'string' },
        model_limits: { type: 'string' },
        environment: { type: 'string' },
      },
      required: ['yours_to_fix', 'model_limits', 'environment'],
    },
    rules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          rule: { type: 'string' },        // 可直接粘进 AGENTS.md 的一行
          why: { type: 'string' },         // 依据哪些观察
          evidence_count: { type: 'integer' },
        },
        required: ['rule', 'why', 'evidence_count'],
      },
    },
    next_steps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          why_for_you: { type: 'string' },
          copyable_prompt: { type: 'string' },
        },
        required: ['title', 'why_for_you', 'copyable_prompt'],
      },
    },
  },
  required: ['headline', 'working_well', 'friction_narrative', 'rules', 'next_steps'],
};

const SYSTEM = `You are writing a friction report for a developer about their own AI-coding sessions.

HARD RULES
- The numbers are already computed. Never recount, never contradict the provided counts or ranking.
- Write in second person, concrete and diagnostic. No flattery, no filler, no motivational tone.
- Every claim must trace to the evidence provided. If evidence is thin, say less rather than inventing.
- Quote or paraphrase actual details from the session evidence; a report that could describe anyone is worthless.
- Write in the same language as the majority of the evidence text (Chinese evidence -> Chinese output).`;

function buildPrompt(agg, evidence, lang) {
  const top = (list, n = 6) => list.slice(0, n).map((f) => `${f.key}: ${f.count} times across ${f.sessions} sessions`).join('\n');
  return `Write the narrative sections of this report.

## Computed statistics (authoritative — do not recompute)

Sessions analyzed: ${agg.n}
Attribution of frictions: yours-to-fix ${agg.attribution.user_actionable}, model-limits ${agg.attribution.agent_capability}, environment ${agg.attribution.environmental}
Outcomes: ${JSON.stringify(agg.outcomes)}
Session types: ${JSON.stringify(agg.sessionTypes)}

Top frictions (already ranked, noise-filtered):
${top(agg.friction) || '(none passed the noise floor)'}

Top goals:
${top(agg.goals) || '(none)'}

Rule candidates (frictions repeated in >= 3 sessions — ONLY these may become rules):
${agg.ruleCandidates.map((f) => `${f.key} (${f.sessions} sessions, ${f.count} occurrences)`).join('\n') || '(none — then return an empty rules array)'}

Instructions the user repeated across sessions:
${agg.repeatedInstructions.slice(0, 8).map((i) => `"${i.text}" (${i.n}x)`).join('\n') || '(none)'}

## Session evidence (free-text from individual sessions)

${evidence}

## What to write

- headline: one sentence naming the single most consequential pattern. Not a summary of counts.
- working_well: 2-3 concrete things this developer does well, each grounded in the evidence.
- friction_narrative: three separate paragraphs.
    yours_to_fix   — what THEY could have done differently. This is the section that matters most;
                     be specific and actionable, cite concrete situations from the evidence.
    model_limits   — where the assistant itself fell short.
    environment    — tooling, network, permissions, external services.
  If a bucket has no evidence, say so in one short sentence instead of padding.
- rules: 0-5 lines ready to paste into AGENTS.md / CLAUDE.md. Derive ONLY from the rule candidates above.
  Each rule must be an imperative constraint, not a description. Set evidence_count from the candidate list.
- next_steps: 2-3 things worth trying next, each with a prompt the user can paste directly into their agent.

${lang === 'zh' ? 'Write all free-text in Simplified Chinese.' : 'Write all free-text in English.'}
RESPOND WITH ONLY A VALID JSON OBJECT matching the provided schema.`;
}

/** 从 facet 里取自由文本作为证据。这些字段此前被采集但从未使用。 */
export function buildEvidence(facets, { maxChars = 9000 } = {}) {
  const parts = [];
  for (const f of facets) {
    const bits = [];
    if (f.brief_summary) bits.push(f.brief_summary);
    if (f.friction_detail) bits.push(`摩擦: ${f.friction_detail}`);
    if (f.user_instructions?.length) bits.push(`用户指令: ${f.user_instructions.join(' / ')}`);
    if (bits.length) parts.push(`- ${bits.join(' | ')}`);
  }
  return redact(parts.join('\n')).slice(0, maxChars);
}

/** codex 会把整个 models 列表塞进一行 ERROR 日志，几十 KB，会淹没真正的报错。 */
function require$fs2() { return globalThis.__adi_fs; }

function cleanErr(s) {
  return s.split('\n').filter((l) => l.length < 400 && !/models_manager|models cache/.test(l))
          .join('\n').trim().slice(0, 400);
}

function detectLang(text) {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  return cjk > text.length * 0.05 ? 'zh' : 'en';
}

export function synthesize(agg, facets, { model, timeoutMs = 420000, retries = 1 } = {}) {
  const evidence = buildEvidence(facets);
  if (!evidence.trim()) return { ok: false, code: 'E_NO_EVIDENCE' };
  const dir = mkdtempSync(join(tmpdir(), 'adi-syn-'));
  try {
    const sf = join(dir, 's.json'); const outFile = join(dir, 'o.json');
    writeFileSync(sf, JSON.stringify(SYNTHESIS_SCHEMA));
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-o', outFile, '--output-schema', sf];
    if (model) args.push('-m', model);
    args.push('-');
    const prompt = `${SYSTEM}\n\n${buildPrompt(agg, evidence, detectLang(evidence))}`;
    let stderr = '', raw = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try { execFileSync('codex', args, EXEC_OPTS(prompt, timeoutMs, dir)); }
      catch (e) {
        const full = (e.stderr?.toString() || '') + '\n---MSG---\n' + (e.message || '');
        if (process.env.ADI_DEBUG) { try { require$fs2().writeFileSync('/tmp/adi-syn-stderr.txt', full); } catch {} }
        stderr = cleanErr(full);
      }
      try { raw = readFileSync(outFile, 'utf8'); } catch { /* noop */ }
      if (raw) break;
    }
    if (!raw) return { ok: false, code: 'E_SYNTHESIS_FAILED', detail: stderr };
    const parsed = parseLoose(raw);
    if (!parsed.ok) return { ok: false, code: 'E_BAD_JSON', detail: parsed.error };
    return { ok: true, narrative: parsed.value };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
