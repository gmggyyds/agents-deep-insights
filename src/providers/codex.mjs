/**
 * Codex CLI provider。
 *
 * 数据源：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（逐事件）
 * 索引优先走 ~/.codex/state_*.sqlite 的 threads 表（有 archived / updated_at / cwd 等元数据），
 * 但 sqlite3 CLI 不一定存在 —— 缺失时降级为直接扫目录，功能不减，只是少了归档过滤。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { redact } from '../redact.mjs';

export const name = 'codex';

export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function hasSqlite() {
  try { execFileSync('sqlite3', ['--version'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function walkRollouts(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkRollouts(p, out);
    else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
  }
  return out;
}

export function discover({ days = 30 } = {}) {
  const root = join(codexHome(), 'sessions');
  if (!existsSync(root)) return [];
  const cutoff = days > 0 ? Date.now() - days * 864e5 : 0;
  return walkRollouts(root)
    .map((p) => { try { return { path: p, mtime: statSync(p).mtimeMs }; } catch { return null; } })
    .filter((x) => x && x.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 这些不是人打的字，不能算进 userMessages——否则会污染 substantive 判定与采样排序。
 * <codex_internal_context 是 Codex 自动续跑注入的，作者本机（0.131.0）不产生这个标记，
 * 由 0.153.4 上的外部测试发现（该版本 20 条样本里有 84 条被误计）。
 */
/**
 * 单条消息的截断。400 字太短——一条长答复的**末尾**往往是验收边界与限制说明
 * （「仅验证了本地入口，外部系统未验」这类），只留开头会把边界一起切掉，
 * 而上层的首尾保留策略无法恢复已经在这一层丢掉的内容。
 */
function clipMessage(t, max = 1200) {
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.62), tail = max - head - 16;
  return `${t.slice(0, head)} …[略${t.length - max}字]… ${t.slice(-tail)}`;
}

const LOW_SIGNAL = /^(<turn_aborted>|<environment_context>|<codex_internal_context|# AGENTS\.md|<permissions instructions>|<user_instructions>)/;

/** L1：纯代码提取 session-meta。零 LLM。 */
export function parse(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const meta = {
    provider: 'codex', id: null, path: file, cwd: null, model: null,
    startedAt: null, endedAt: null, forkedFrom: null,
    userMessages: 0, assistantMessages: 0, toolCalls: 0,
    toolCounts: {}, toolFailures: 0, userInterruptions: 0,
    gitCommits: 0, gitPushes: 0, responseGaps: [],
    originator: null, source: null, cliVersion: null,
    modelCounts: {}, approvalPolicies: {}, sandboxPolicies: {}, reasoningEfforts: {},
    planSteps: [], transcript: [],
  };
  let lastAssistantTs = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const ts = d.timestamp ? Date.parse(d.timestamp) : null;
    if (ts) { if (!meta.startedAt || ts < meta.startedAt) meta.startedAt = ts;
              if (!meta.endedAt || ts > meta.endedAt) meta.endedAt = ts; }
    if (d.type === 'session_meta') {
      const pl = d.payload || {};
      meta.id ||= pl.id || null; meta.cwd ||= pl.cwd || null;
      meta.forkedFrom ||= pl.forked_from_id || null;
      // 入口与版本。source 可能是对象（子代理派生时是 {subagent:{thread_spawn:…}}），
      // 归一成一个标签，否则下游按字符串用会拿到 "[object Object]"。
      meta.originator ||= pl.originator || null;
      meta.cliVersion ||= pl.cli_version || null;
      if (pl.source != null && !meta.source) {
        meta.source = typeof pl.source === 'string' ? pl.source
          : (pl.source.subagent ? 'subagent' : Object.keys(pl.source)[0] || 'unknown');
      }
      continue;
    }
    // turn_context 是 Codex 独有的：显式记录用户给出的授权与风险姿态
    // （approval_policy / sandbox_policy），比从工具调用比例反推姿态硬得多。
    // 官方 Claude Code /insights 没有等价信号。
    if (d.type === 'turn_context') {
      const pl = d.payload || {};
      if (pl.model) meta.modelCounts[pl.model] = (meta.modelCounts[pl.model] || 0) + 1;
      if (pl.approval_policy) meta.approvalPolicies[pl.approval_policy] = (meta.approvalPolicies[pl.approval_policy] || 0) + 1;
      const sb = pl.sandbox_policy?.type;
      if (sb) meta.sandboxPolicies[sb] = (meta.sandboxPolicies[sb] || 0) + 1;
      const eff = pl.collaboration_mode?.settings?.reasoning_effort;
      if (eff) meta.reasoningEfforts[eff] = (meta.reasoningEfforts[eff] || 0) + 1;
      continue;
    }
    if (d.type !== 'response_item') continue;
    const pl = d.payload || {};
    if (pl.type === 'message') {
      const txt = (pl.content || []).map((c) => (c && c.text) || '').join('');
      const clean = txt.replace(/\s+/g, ' ').trim();
      if (pl.role === 'user') {
        if (/<turn_aborted>/.test(txt)) meta.userInterruptions++;
        if (!LOW_SIGNAL.test(clean)) {
          meta.userMessages++;
          if (lastAssistantTs && ts) {
            const gap = (ts - lastAssistantTs) / 1000;
            if (gap > 2 && gap < 3600) meta.responseGaps.push(gap);
          }
        }
      } else if (pl.role === 'assistant') { meta.assistantMessages++; if (ts) lastAssistantTs = ts; }
      if (clean) meta.transcript.push(`[${pl.role}] ${clipMessage(redact(clean))}`);
    } else if (pl.type === 'function_call' || pl.type === 'custom_tool_call') {
      meta.toolCalls++;
      const n = pl.name || 'unknown';
      meta.toolCounts[n] = (meta.toolCounts[n] || 0) + 1;
      const args = typeof pl.arguments === 'string' ? pl.arguments : JSON.stringify(pl.arguments || '');
      if (/\bgit\s+commit\b/.test(args)) meta.gitCommits++;
      if (/\bgit\s+push\b/.test(args)) meta.gitPushes++;
      // update_plan 是用户可见的任务分解，50% 的会话有；比 transcript 更结构化地
      // 说明「这次要干几件事」。只留步骤文本，丢掉状态机噪音。
      if (n === 'update_plan') {
        try {
          const steps = (JSON.parse(args)?.plan || []).map((x) => x?.step).filter(Boolean);
          if (steps.length) meta.planSteps.push(...steps.map((t) => redact(String(t)).slice(0, 200)));
        } catch { /* 计划体是自由结构，解析不了就当没有，不影响其它信号 */ }
      }
      meta.transcript.push(`[tool] ${n}`);
    } else if (pl.type === 'function_call_output' || pl.type === 'custom_tool_call_output') {
      const o = typeof pl.output === 'string' ? pl.output : JSON.stringify(pl.output || '');
      if (/"exit_code"\s*:\s*[1-9]|command failed|error:/i.test(o)) meta.toolFailures++;
    }
  }
  meta.id ||= file.split('/').pop().replace(/^rollout-|\.jsonl$/g, '');
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  meta.model = top(meta.modelCounts) || meta.model || null;
  meta.approvalPolicy = top(meta.approvalPolicies);
  meta.sandboxPolicy = top(meta.sandboxPolicies);
  meta.reasoningEffort = top(meta.reasoningEfforts);
  meta.durationMinutes = meta.startedAt && meta.endedAt
    ? Math.round((meta.endedAt - meta.startedAt) / 60000) : 0;
  return meta;
}
