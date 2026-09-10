/**
 * Claude Code 的对话正文提取。
 *
 * 分工，不是推翻既有决策：**统计仍然用官方 `session-meta`**（它已经算好、随官方维护，
 * 自建统计曾漏算 cache token 达 500 倍——那条教训针对的是「重算官方已有的数」）。
 * 这里只补官方**没有提供**的那一样东西：transcript。
 *
 * 没有它的代价是实测出来的：深度分析此前只能用 Codex 会话，本机可用样本 6 个，
 * 而 `~/.claude/projects` 里躺着 29,869 个带完整对话的 jsonl。
 * 报告因此长期在「样本量不足以支持模式类结论」的状态下运行。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../redact.mjs';
import { claudeHome } from './claude-code.mjs';

/**
 * sessionId → jsonl 路径。只按文件名建索引，不读内容（实测 42ms）。
 *
 * 🔴 **只扫一层，不要改成递归**。实测 29,869 个 jsonl 的层级分布是
 * `{1: 15196, 3: 4113, 5: 11010}`——深层的全都是
 * `<session>/subagents/agent-*.jsonl`，也就是子代理（含子代理的子代理）的记录。
 * 一层 readdir 恰好只取到真实用户会话；改成递归会把 14,673 条子代理记录
 * 混进「你与 agent 的协作」，重演 Codex 侧那个「子代理占一半」的坑。
 */
let INDEX = null;
export function transcriptIndex({ rebuild = false } = {}) {
  if (INDEX && !rebuild) return INDEX;
  INDEX = new Map();
  const root = join(claudeHome(), 'projects');
  if (!existsSync(root)) return INDEX;
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return INDEX; }
  for (const d of dirs) {
    const dir = join(root, d.name);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) INDEX.set(f.slice(0, -6), join(dir, f));
    }
  }
  return INDEX;
}

/** 工具结果的成败判定。权威信号是 `is_error`；缺这个字段就是判不出来，不猜。 */
export function classifyToolResult(block, acc) {
  const e = block?.is_error;
  if (e === true) { acc.toolFailures++; acc.toolOutcomesKnown++; return; }
  if (e === false) { acc.toolOutcomesKnown++; return; }
  acc.toolOutcomeUnknown++;   // 判不出来 ≠ 成功
}

const clip = (t, max = 1200) => {
  const s = String(t);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.62), tail = max - head - 16;
  return `${s.slice(0, head)} …[略${s.length - max}字]… ${s.slice(-tail)}`;
};

/** 不是人打的字：命令输出回灌、系统提醒、粘贴附件。计入 transcript 会污染「用户说了什么」。 */
const LOW_SIGNAL = /^(<command-name>|<local-command|<system-reminder>|Caveat: The messages below|<user-memory|\[Request interrupted)/;

/**
 * 读一个会话的 transcript。
 * @returns {{transcript:string[], stats:object}|null}
 */
export function readTranscript(sessionId, { maxLines = 4000 } = {}) {
  const p = transcriptIndex().get(sessionId);
  if (!p) return null;
  let lines;
  try { lines = readFileSync(p, 'utf8').split('\n'); } catch { return null; }
  const transcript = [];
  const acc = {
    userMessages: 0, assistantMessages: 0, toolCalls: 0, toolCounts: {},
    toolFailures: 0, toolOutcomesKnown: 0, toolOutcomeUnknown: 0, toolStillRunning: 0,
    userInterruptions: 0, models: {}, sidechainLines: 0,
  };
  for (const line of lines.slice(0, maxLines)) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    // 子代理产生的行不算「你和 agent 的协作」，但要记数以便如实报出
    if (d.isSidechain === true) { acc.sidechainLines++; continue; }
    const msg = d.message;
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    if (msg.model) acc.models[msg.model] = (acc.models[msg.model] || 0) + 1;
    const content = msg.content;
    const blocks = Array.isArray(content) ? content
      : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        const txt = String(b.text || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        if (role === 'user') {
          if (/\[Request interrupted/.test(txt)) acc.userInterruptions++;
          if (LOW_SIGNAL.test(txt)) continue;
          acc.userMessages++;
        } else if (role === 'assistant') acc.assistantMessages++;
        transcript.push(`[${role}] ${clip(redact(txt))}`);
      } else if (b.type === 'tool_use') {
        acc.toolCalls++;
        const n = b.name || 'unknown';
        acc.toolCounts[n] = (acc.toolCounts[n] || 0) + 1;
        transcript.push(`[tool] ${n}`);
      } else if (b.type === 'tool_result') {
        classifyToolResult(b, acc);
      }
      // thinking 块刻意不进 transcript：它是模型的内部推理，不是协作记录，
      // 且体量极大（实测占内容块 28%），会把真正的对话挤出预算。
    }
  }
  return { transcript, stats: acc };
}
