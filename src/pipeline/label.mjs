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
import { facetSchema, OUTCOME, SESSION_TYPE, GOAL_CATEGORIES, FRICTION, ATTRIBUTION } from '../schema/facet.mjs';
import { parseLoose, normalizeFacet } from '../schema/normalize.mjs';
import { redact } from '../redact.mjs';

const TASK = `Analyze this AI coding-session transcript and extract structured facets.

Rules:
- Count only what the USER explicitly asked for. Do not infer goals from tool activity alone.
- Be conservative when evidence is weak; prefer unclear_from_transcript over guessing.
- friction_attribution splits the frictions you counted into who can act on them:
    user_actionable  = the user could have avoided it (vague request, missing context, late constraint)
    agent_capability = the assistant's own mistake or limitation
    environmental    = tooling, network, permissions, external services
  The three numbers should roughly sum to the total frictions counted.
- user_instructions: verbatim short instructions the user repeated or emphasized.`;

function buildPrompt(transcript, meta, { withEnums }) {
  const stats = JSON.stringify({
    userMessages: meta.userMessages, assistantMessages: meta.assistantMessages,
    toolCalls: meta.toolCalls, toolFailures: meta.toolFailures,
    userInterruptions: meta.userInterruptions, durationMinutes: meta.durationMinutes,
    topTools: Object.entries(meta.toolCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 8),
  });
  let p = `${TASK}\n\nTranscript:\n${transcript}\n\nSession stats:\n${stats}\n`;
  if (withEnums) {
    p += `\nAllowed values:
- outcome: ${OUTCOME.join(' | ')}
- session_type: ${SESSION_TYPE.join(' | ')}
- goal_categories keys: ${GOAL_CATEGORIES.join(', ')}
- friction_counts keys: ${FRICTION.join(', ')}
- friction_attribution keys: ${ATTRIBUTION.join(', ')}

Return an object with keys: outcome, session_type, goal_categories, friction_counts,
friction_attribution, friction_detail (string), user_instructions (array of strings), brief_summary (string).
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
  const text = redact(out.join('\n'));
  if (text.length <= maxChars) return text;
  // 保留头尾：会话结尾往往是最终状态、验收与用户确认，只留开头会让模型
  // 从前半段推断整个会话的结局。外部测试发现 19/20 条样本都撞到了旧上限。
  const head = Math.floor(maxChars * 0.6), tail = maxChars - head - 80;
  return text.slice(0, head)
    + `\n\n…（中间省略约 ${text.length - maxChars} 字符）…\n\n`
    + text.slice(-tail);
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
