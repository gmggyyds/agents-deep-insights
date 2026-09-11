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
export function transcriptIndex({ rebuild = false, root: rootOverride = null } = {}) {
  if (INDEX && !rebuild && !rootOverride) return INDEX;
  const idx = new Map();
  const sizes = new Map();
  const root = rootOverride || join(claudeHome(), 'projects');
  if (!existsSync(root)) return rootOverride ? idx : (INDEX = idx);
  const sizeOf = (f) => { try { return statSync(f).size; } catch { return -1; } };
  // 🔴 刻意只扫一层，不递归。深层目录（`<proj>/<id>/subagents/*.jsonl`）放的是
  // 子代理记录，递归会把它们当成会话索引进来——而子代理的「用户消息」是控制器
  // 写的任务书，混进「你和 agent 的协作」会全面抬高数字。
  // 递归也不会提高覆盖率：实测递归前后对 394 个 session-meta 的命中都是 393/394，
  // 需要的那些 id 全在第一层。见 tests/external-findings.test.mjs 的同名测试。
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return rootOverride ? idx : (INDEX = idx); }
  for (const d of dirs) {
    const dir = join(root, d.name);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      const p = join(dir, f);
      // 同名时取体积最大的那份（内容最全）。只 stat 新候选、比缓存下来的尺寸：
      // 一个 catch 同时兜住两次 stat 时，旧文件被删或成断链会把坏条目留下、把好的扔掉。
      const size = sizeOf(p);
      if (size < 0) continue;
      if (idx.has(id) && size <= (sizes.get(id) ?? -1)) continue;
      idx.set(id, p); sizes.set(id, size);
    }
  }
  if (!rootOverride) INDEX = idx;
  return idx;
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
const LOW_SIGNAL = /^(<command-name>|<local-command|<system-reminder>|Caveat: The messages below|<user-memory|\[Request interrupted|\[Image: original|Base directory for this skill:|\(Re-invocation of)/;

/**
 * 🔴 判「是不是人打的字」优先用结构化标记，文本正则只做兜底。
 *
 * jsonl 的 user 行自带这两个布尔字段，比猜文本可靠得多。实测同一个会话里
 * 图片占位符、slash-command 展开的 skill 全文、`(Re-invocation of …)` 三类
 * 全部带 isMeta:true，而真人那条没有——只靠正则会把 19 条里的 9 条噪声
 * 当成用户诉求喂给打标模型。
 *   isMeta           系统注入（图片占位、skill 文档、命令展开）
 *   isCompactSummary 上下文压缩摘要：助手写的、体量巨大、含历史 prompt 原文，
 *                    不滤会让同一批内容在多个会话里重复计入
 */
const isInjectedRow = (d) => d.isMeta === true || d.isCompactSummary === true;

/**
 * 读一个会话的 transcript。
 * @returns {{transcript:string[], stats:object}|null}
 */
export function readTranscript(sessionId, { maxLines = 400, root = null } = {}) {
  const p = transcriptIndex(root ? { root } : undefined).get(sessionId);
  if (!p) return null;
  let lines;
  try { lines = readFileSync(p, 'utf8').split('\n'); } catch { return null; }
  const transcript = [];
  const acc = {
    userMessages: 0, assistantMessages: 0, toolCalls: 0, toolCounts: {},
    toolFailures: 0, toolOutcomesKnown: 0, toolOutcomeUnknown: 0, toolStillRunning: 0,
    userInterruptions: 0, models: {}, sidechainLines: 0, injectedRows: 0, truncatedLines: 0,
  };
  for (const line of lines) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    // 子代理产生的行不算「你和 agent 的协作」，但要记数以便如实报出
    if (d.isSidechain === true) { acc.sidechainLines++; continue; }
    // 系统注入的行不是人说的话（见 isInjectedRow 的说明）
    if (isInjectedRow(d)) { acc.injectedRows++; continue; }
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
        // 相邻的工具调用并到同一行：工具名信息量低，一条条占行会把对话挤出预算。
        // 实测一个 2977 行的会话里 [tool] 独占 89.5%，最后只有 8 条用户消息进模型。
        const last = transcript[transcript.length - 1];
        if (last && last.startsWith('[tool] ') && last.length < 600) {
          transcript[transcript.length - 1] = `${last}, ${n}`;
        } else transcript.push(`[tool] ${n}`);
      } else if (b.type === 'tool_result') {
        classifyToolResult(b, acc);
      }
      // thinking 块刻意不进 transcript：它是模型的内部推理，不是协作记录，
      // 且体量极大（实测占内容块 28%），会把真正的对话挤出预算。
    }
  }
  // 🔴 行数超限时保首尾，不能只取前 N 行。
  // budget.mjs 开篇那条教训（同一类「结尾被切掉」被外部测试连着抓到两轮）在行维度同样成立：
  // 会话结尾是验收边界——「这样就行了」「还是不对，再改」都在最后几行。
  // 原实现 lines.slice(0, maxLines) 还是按 jsonl 行切的，长会话会整段丢掉尾巴。
  if (transcript.length > maxLines) {
    const head = Math.floor(maxLines * 0.4);
    const tail = maxLines - head - 1;
    acc.truncatedLines = transcript.length - head - tail;
    const kept = [...transcript.slice(0, head), `[… 略去中段 ${acc.truncatedLines} 行 …]`, ...transcript.slice(-tail)];
    return { transcript: kept, stats: acc };
  }
  return { transcript, stats: acc };
}
