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
import { splitBudget, clipHeadTail } from '../budget.mjs';
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

const strObj = (props) => ({
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(props.map((k) => [k, { type: 'string' }])),
  required: [...props],
});
const listOf = (props) => ({ type: 'array', items: strObj(props) });

/**
 * 七段结构。对齐官方 /insights 的段落划分（本机 54 条产物实测：7 个 h2 + 1 个 h3，
 * 正文 33,821 字符），并按 Codex 场景替换其中的专有名词。
 *
 * v0.3 只有 5 个字段、叙事挤在一坨，实测正文 1,586 字——薄了 21 倍。
 * 差距不在文笔，在**结构**：缺 themes / how_you_work / horizon 三段，
 * 且规则没有证据句、下一步没有可粘贴提示词。
 */
export const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    // ① 你在做什么：主题聚类，每个带会话数与叙述
    themes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' },
          session_estimate: { type: 'integer' },
          detail: { type: 'string' },
        },
        required: ['name', 'session_estimate', 'detail'],
      },
    },
    // ② 你怎么用它：使用姿态画像（不是做什么，是以什么方式用）
    how_you_work: strObj(['summary', 'evidence', 'implication']),
    // ③ 你做得漂亮的地方
    impressive: {
      type: 'object', additionalProperties: false,
      properties: { summary: { type: 'string' }, items: listOf(['title', 'detail']) },
      required: ['summary', 'items'],
    },
    // ④ 哪里出了问题
    friction_narrative: strObj(['summary', 'yours_to_fix', 'model_limits', 'environment']),
    // ⑤ 可粘进 AGENTS.md 的规则：官方每条都带一句引用用户原话的证据，这是它最有说服力的地方
    rules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          heading: { type: 'string' },        // 主题标题，如「验证纪律」
          rule: { type: 'string' },           // 可直接粘贴的祈使句
          why: { type: 'string' },
          evidence_quote: { type: 'string' }, // 用户原话或具体事件，原文照引
          evidence_count: { type: 'integer' },
        },
        required: ['heading', 'rule', 'why', 'evidence_quote', 'evidence_count'],
      },
    },
    // ⑥ 新用法：每条带可直接粘贴的提示词
    next_steps: listOf(['title', 'why_for_you', 'copyable_prompt']),
    // ⑦ 前瞻
    horizon: {
      type: 'object', additionalProperties: false,
      properties: { summary: { type: 'string' }, items: listOf(['title', 'vision']) },
      required: ['summary', 'items'],
    },
  },
  required: ['headline', 'themes', 'how_you_work', 'impressive',
             'friction_narrative', 'rules', 'next_steps', 'horizon'],
};

const SYSTEM = `You are writing a friction report for a developer about their own AI-coding sessions.

HARD RULES
- The numbers are already computed. Never recount, never contradict the provided counts or ranking.
- Write in second person, concrete and diagnostic. No flattery, no filler, no motivational tone.
- Every claim must trace to the evidence provided. If evidence is thin, say less rather than inventing.
- Quote actual details and the user's own words from the evidence. A report that could
  describe anyone is worthless — name the systems, files, commands and decisions involved.
- Depth matters: this report replaces the user reading their own transcripts. Each section
  should be several substantial paragraphs, not one sentence.`;

function buildPrompt(agg, evidence, lang, posture) {
  const top = (list, n = 8) => list.slice(0, n)
    .map((f) => `${f.key}: ${f.count} times across ${f.sessions} sessions`).join('\n');
  const dist = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`).join(', ') || '(none)';
  return `Write the narrative sections of this report.

## Computed statistics (authoritative — do not recompute)

Sessions analyzed: ${agg.n}
Attribution of frictions: yours-to-fix ${agg.attribution.user_actionable}, model-limits ${agg.attribution.agent_capability}, environment ${agg.attribution.environmental}, cause-unclear ${agg.attribution.unknown || 0}
Outcomes: ${JSON.stringify(agg.outcomes)}
Session types: ${JSON.stringify(agg.sessionTypes)}
Helpfulness: ${JSON.stringify(agg.helpfulness || {})}
Observable user reactions: ${JSON.stringify(agg.reactions || {})}
NOTE: these are observed ACTIONS, not satisfaction. A correction is normal iterative
collaboration; do not report it as the user being unhappy. Never state or imply a
satisfaction rate — the data does not support one.
Primary successes: ${JSON.stringify(agg.successes || {})}

## How this developer actually drives the agent (for the "how_you_work" section)

Tool call distribution: ${dist(posture.toolCounts)}
Total tool calls ${posture.toolCalls}, git commits ${posture.gitCommits}, pushes ${posture.gitPushes}
Tool failure rate: ${(posture.failureRate * 100).toFixed(1)}%
User interruptions: ${posture.interruptions}
Median session ${posture.medianDuration} min, longest ${posture.longestSession} min, active days ${posture.daysActive}
Approval policy granted: ${dist(posture.approvalPolicies)}
Sandbox policy granted: ${dist(posture.sandboxPolicies)}
Entry points: ${dist(posture.originators)}   Launch source: ${dist(posture.sources)}
Sessions with an explicit task plan: ${posture.planSessions}/${posture.sessions}
NOTE: approval/sandbox policy is what the USER chose to grant the agent. "never" approval
plus "danger-full-access" means they run it unattended with full trust — that is a posture
finding, not a security note. Reason about the ratios (e.g. shell-exec vs file-edit calls)
to characterise HOW they use the agent, and say what that implies.

Top frictions (already ranked, noise-filtered):
${top(agg.friction) || '(none passed the noise floor)'}

Top goals:
${top(agg.goals) || '(none)'}

Rule candidates (frictions repeated in >= 3 sessions AND mostly judged user-fixable —
ONLY these may become rules):
${agg.ruleCandidates.map((f) => `${f.key} (${f.sessions} sessions, ${f.count} occurrences)`).join('\n') || '(none — then return an empty rules array)'}

Instructions the user repeated across sessions (quote these verbatim as evidence):
${agg.repeatedInstructions.slice(0, 10).map((i) => `"${i.text}" (${i.n}x)`).join('\n') || '(none)'}

## Session evidence (free-text from individual sessions)

${evidence}

## What to write

- headline: one sentence naming the single most consequential pattern. Not a summary of counts.
- themes: 3-6 clusters of what they actually work on, derived from the underlying_goal texts
  in the evidence. session_estimate must be your count of evidence entries in that cluster and
  the estimates should roughly sum to the session total. detail = 2-4 sentences naming the real
  systems and problems, not category names.
- how_you_work: characterise their OPERATING POSTURE from the distribution data above.
    summary    — what kind of user they are, in one strong claim.
    evidence   — the specific ratios and policies that support it, with the numbers.
    implication— what this posture costs them or buys them.
- impressive: 2-4 concrete things they do well, each a named habit with real evidence.
- friction_narrative: summary + three separate paragraphs (yours_to_fix / model_limits /
  environment). yours_to_fix matters most: name specific defects and situations, not categories.
  If a bucket has no evidence, say so in one sentence rather than padding.
- rules: 0-5 blocks ready to paste into AGENTS.md. Derive ONLY from the rule candidates.
  Each rule is an imperative constraint. evidence_quote must be the user's OWN words
  (verbatim, original language) or a specific named incident — this is what makes the rule credible.
  Set evidence_count from the candidate list.
- next_steps: 2-4 things worth trying, each with a prompt they can paste straight into their agent.
- horizon: where this practice is heading if they keep going, and 2-3 concrete capabilities
  worth building toward. Ground each in what the data already shows they are doing.

${lang === 'zh' ? 'Write all free-text in Simplified Chinese.' : 'Write all free-text in English.'}
RESPOND WITH ONLY A VALID JSON OBJECT matching the provided schema.`;
}

/**
 * 从 facet 里取自由文本作为证据。
 *
 * 预算按会话**均分**，不是先到先得。旧实现直接 slice 前 9000 字符，导致
 * 20 条样本里只有前 8 条完整进入合成、后 11 条的自由文本完全缺席，而且没有任何提示
 * （外部复测实测：证据总长 21,680，上限 9,000，样本 10–20 全部丢失）。
 * 汇总数字仍然覆盖全部会话，缺的是叙事所依据的原文——报告会因此只讲前半批的故事。
 */
export function buildEvidence(facets, { maxChars = 20000 } = {}) {
  const rows = [];
  for (const f of facets) {
    const parts = [];
    if (f.underlying_goal) parts.push(['目标: ', String(f.underlying_goal)]);
    if (f.brief_summary) parts.push(['', String(f.brief_summary)]);
    if (f.friction_detail) parts.push(['摩擦: ', String(f.friction_detail)]);
    if (f.user_instructions?.length) parts.push(['用户指令: ', f.user_instructions.join(' / ')]);
    if (parts.length) rows.push(parts);
  }
  if (!rows.length) return '';

  const overhead = rows.length * 6;
  const perRow = Math.max(240, Math.floor((maxChars - overhead) / rows.length));
  let clipped = 0;

  // 逐字段截断，不是拼接后再截。拼接一做，前一个字段的结尾就落进中段被省略掉，
  // 而结尾往往正是验收边界与限制说明（「仅验证本地入口，外部系统未验」这类）。
  const clip = (t, max) => {
    if (t.length <= max) return t;
    clipped += t.length - max;
    const head = Math.floor(max * 0.6), tail = Math.max(40, max - head - 16);
    return `${t.slice(0, head)} …[略${t.length - max}字]… ${t.slice(-tail)}`;
  };

  const lines = rows.map((parts) => {
    const budgets = splitBudget(parts.map(([, t]) => t.length), perRow);
    return '- ' + parts.map(([label, t], i) => label + clip(t, budgets[i])).join(' | ');
  });

  const out = redact(lines.join('\n'));
  return clipped > 0
    ? `${out}\n\n（注：全部 ${rows.length} 条会话证据均已纳入；超长字段保留首尾并标注省略量。）`
    : out;
}


function detectLang(text) {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  return cjk > text.length * 0.05 ? 'zh' : 'en';
}

export function synthesize(agg, facets, { model, timeoutMs = 420000, retries = 1, posture = {} } = {}) {
  const evidence = buildEvidence(facets);
  if (!evidence.trim()) return { ok: false, code: 'E_NO_EVIDENCE' };
  const dir = mkdtempSync(join(tmpdir(), 'adi-syn-'));
  try {
    const sf = join(dir, 's.json'); const outFile = join(dir, 'o.json');
    writeFileSync(sf, JSON.stringify(SYNTHESIS_SCHEMA));
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-o', outFile, '--output-schema', sf];
    if (model) args.push('-m', model);
    args.push('-');
    const prompt = `${SYSTEM}\n\n${buildPrompt(agg, evidence, detectLang(evidence), posture)}`;
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

/**
 * 英文版叙事。
 *
 * 走**翻译**而不是「用英文再生成一遍」：后者会让中英两版讲不同的事，
 * 对照阅读时读者无法判断哪版是准的。翻译则保证两版是同一份结论。
 * 复用同一个 SYNTHESIS_SCHEMA，结构天然对齐，渲染层可以按下标配对。
 *
 * 可粘贴的东西不翻：copyable_prompt 是给 agent 吃的、evidence_quote 是用户原话，
 * 翻了就失去用途和证据效力。
 */
export function translateNarrative(narrative, { model, timeoutMs = 300000 } = {}) {
  if (!narrative) return { ok: false, code: 'E_NO_NARRATIVE' };
  const dir = mkdtempSync(join(tmpdir(), 'adi-tr-'));
  try {
    const sf = join(dir, 's.json'); const outFile = join(dir, 'o.json');
    writeFileSync(sf, JSON.stringify(SYNTHESIS_SCHEMA));
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
                  '-o', outFile, '--output-schema', sf];
    if (model) args.push('-m', model);
    args.push('-');
    const prompt = `Translate this report JSON into natural English.

RULES
- Translate every free-text field. Keep the JSON structure and array order identical.
- This is a translation, not a rewrite: do not add, drop, or soften any claim.
- Keep technical terms, tool names, file names, commands and numbers exactly as they are.
- DO NOT translate the field "copyable_prompt" — copy it through verbatim. It is fed to an
  agent, and the user's agent works in the original language.
- DO NOT translate "evidence_quote" — it quotes the user's own words and is used as evidence.
- Write plain professional English, second person, no marketing tone.

${JSON.stringify(narrative)}

RESPOND WITH ONLY A VALID JSON OBJECT matching the provided schema.`;
    let raw = null, stderr = '';
    try { execFileSync('codex', args, EXEC_OPTS(prompt, timeoutMs, dir)); }
    catch (e) { stderr = cleanErr((e.stderr?.toString() || '') + '\n' + (e.message || '')); }
    try { raw = readFileSync(outFile, 'utf8'); } catch { /* noop */ }
    if (!raw) return { ok: false, code: 'E_TRANSLATE_FAILED', stderr };
    const parsed = parseLoose(raw);
    if (!parsed.ok) return { ok: false, code: 'E_TRANSLATE_PARSE' };
    return { ok: true, narrative: parsed.value };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
