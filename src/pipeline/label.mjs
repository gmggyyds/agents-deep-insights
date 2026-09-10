/**
 * L3 单会话打标 —— 唯一消耗额度的一层。
 *
 * 首选走 provider 的 structured output（Codex 的 --output-schema 实测是服务端
 * strict 校验，见 docs/DESIGN.md §2.2：strict 0/3 违规，prompt-only 2/3 违规）。
 * 不支持 schema 时降级到 prompt-only，由 L4 归一化兜住漂移。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { facetSchema, OUTCOME, SESSION_TYPE, GOAL_CATEGORIES, FRICTION, ATTRIBUTION,
         PRIMARY_SUCCESS, HELPFULNESS, SATISFACTION } from '../schema/facet.mjs';
import { parseLoose, normalizeFacet } from '../schema/normalize.mjs';
import { splitBudget, clipHeadTail } from '../budget.mjs';
import { redact } from '../redact.mjs';

const TASK = `Analyze this AI coding-session transcript and extract structured facets.

Rules:
- Count only what the USER explicitly asked for. Do not infer goals from tool activity alone.
- Be conservative when evidence is weak; prefer unclear_from_transcript over guessing.
- friction_attribution assigns ONE responsibility to EACH friction category separately:
    user_actionable  = the user could have avoided it (vague request, missing context, late constraint)
    agent_capability = the assistant's own mistake or limitation
    environmental    = tooling, network, permissions, external services
    unknown          = the transcript does not show why it failed
    none             = this category did not occur in this session
  Judge each category on its own evidence. Do NOT let one category's responsibility
  spill onto another. If a tool failed and the transcript never says why, answer
  "unknown" — do not default to "environmental" to make the numbers look complete.
- user_instructions: verbatim short instructions the user repeated or emphasized.
  Keep the user's ORIGINAL LANGUAGE and wording. These are quoted directly in the
  report as evidence, so a paraphrase destroys their value.
- underlying_goal: 1-3 sentences on what the user was ACTUALLY trying to accomplish,
  beneath the literal request — the business or operational outcome they were after.
  Be concrete and specific to THIS session: name the systems, files, or decisions involved.
  This drives the report's theme clustering; a generic sentence makes it useless.
- primary_success: the single most valuable thing the assistant did well. "none" if nothing stood out.
- claude_helpfulness: how much the assistant actually moved the work forward.
- user_satisfaction_counts: count the user's reactions across the session. A correction or
  a "no, do X instead" is dissatisfied; explicit thanks/approval is satisfied; silent
  acceptance and moving on is likely_satisfied.
- friction_detail: name the SPECIFIC defects, not categories. "introduced a wrong upper
  bound on Net Proceeds and a cross-axis division in the ratio column" is useful;
  "had some bugs" is not. This is the raw material for the report's diagnosis section.`;

function buildPrompt(transcript, meta, { withEnums }) {
  const stats = JSON.stringify({
    userMessages: meta.userMessages, assistantMessages: meta.assistantMessages,
    toolCalls: meta.toolCalls, toolFailures: meta.toolFailures,
    userInterruptions: meta.userInterruptions, durationMinutes: meta.durationMinutes,
    topTools: Object.entries(meta.toolCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 8),
    gitCommits: meta.gitCommits, gitPushes: meta.gitPushes,
    // Codex 独有：用户显式给出的授权/风险姿态，比从工具比例反推可靠
    approvalPolicy: meta.approvalPolicy, sandboxPolicy: meta.sandboxPolicy,
    planSteps: (meta.planSteps || []).slice(0, 12),
  });
  let p = `${TASK}\n\nTranscript:\n${transcript}\n\nSession stats:\n${stats}\n`;
  if (withEnums) {
    p += `\nAllowed values:
- outcome: ${OUTCOME.join(' | ')}
- session_type: ${SESSION_TYPE.join(' | ')}
- goal_categories keys: ${GOAL_CATEGORIES.join(', ')}
- friction_counts keys: ${FRICTION.join(', ')}
- friction_attribution: one value per friction category, chosen from:
  none | user_actionable | agent_capability | environmental | unknown
- primary_success: ${PRIMARY_SUCCESS.join(' | ')}
- claude_helpfulness: ${HELPFULNESS.join(' | ')}
- user_satisfaction_counts keys: ${SATISFACTION.join(', ')}

Return an object with keys: outcome, session_type, goal_categories, friction_counts,
friction_attribution, friction_detail (string), user_instructions (array of strings),
brief_summary (string), underlying_goal (string), primary_success, claude_helpfulness,
user_satisfaction_counts.
RESPOND WITH ONLY A VALID JSON OBJECT.\n`;
  } else {
    p += '\nReturn the facets as JSON matching the provided output schema.\n';
  }
  return p;
}

/** transcript 压缩：折叠重复工具调用，截长度。内容已在 provider 层脱敏，这里再兜一次。 */
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

export function compactTranscript(lines, maxChars = 24000) {
  const out = []; let prev = null, run = 0;
  for (const l of lines) {
    if (l.startsWith('[tool]') && l === prev) { run++; continue; }
    if (run) { out.push(`  (上一工具重复 ${run} 次)`); run = 0; }
    out.push(l); prev = l;
  }
  if (run) out.push(`  (上一工具重复 ${run} 次)`);
  const msgs = out.map((l) => redact(l));
  const total = msgs.join('\n').length;
  if (total <= maxChars) return msgs.join('\n');
  // 旧实现对拼接后的整段做首尾保留，代价是**中段那些完整的消息整条消失**——
  // 一条中途的验收确认要么全在、要么全没。外部复测正是拿这个抓到样本 2 的
  // 「第一阶段完整确认」在第 38,505 字符处，两版都没进模型。
  // 改成按条均分预算、每条各自保首尾：每条消息的开头和结尾都在，丢的是各自的中段。
  const budgets = splitBudget(msgs.map((m) => m.length), maxChars - msgs.length);
  const kept = msgs.map((m, i) => clipHeadTail(m, budgets[i]));
  const dropped = total - kept.join('\n').length;
  return kept.join('\n')
    + (dropped > 0 ? `\n\n（注：全部 ${msgs.length} 条消息均已纳入；超长消息保留首尾，共省略约 ${dropped} 字符。）` : '');
}

export function labelWithCodex(meta, { model, strict = true, timeoutMs = 180000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adi-'));
  try {
    const prompt = buildPrompt(compactTranscript(meta.transcript || []), meta, { withEnums: !strict });
    const outFile = join(dir, 'o.json');
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-o', outFile];
    if (model) args.push('-m', model);
    if (strict) {
      const sf = join(dir, 's.json');
      writeFileSync(sf, JSON.stringify(facetSchema()));
      args.push('--output-schema', sf);
    }
    args.push('-');
    let stderr = '';
    try {
      execFileSync('codex', args, EXEC_OPTS(prompt, timeoutMs, dir));
    } catch (e) {
      stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
    }
    let raw = null;
    try { raw = readFileSync(outFile, 'utf8'); } catch { /* noop */ }
    if (!raw) {
      const code = /requires a newer version/i.test(stderr) ? 'E_CODEX_TOO_OLD'
        : /invalid_json_schema/i.test(stderr) ? 'E_SCHEMA_REJECTED' : 'E_LABEL_FAILED';
      return { ok: false, code, detail: stderr };
    }
    const parsed = parseLoose(raw);
    if (!parsed.ok) return { ok: false, code: 'E_BAD_JSON', detail: parsed.error };
    const { facet, repairs } = normalizeFacet(parsed.value);
    return { ok: true, facet, repairs, strict };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
