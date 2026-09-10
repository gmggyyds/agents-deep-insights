/**
 * Claude Code provider。
 *
 * 关键决策：**计数一律用官方的，正文才自己读。**
 *
 * 官方 /insights 在本机生成 ~/.claude/usage-data/session-meta/*.json
 * （纯代码提取、26 字段、免费、随官方维护），元数据全部取自它——
 * 这条来自内部教训：自建 jsonl 解析器曾漏算 cache token 达 500 倍。
 *
 * 但官方 session-meta **只有元数据，没有对话正文**（只给 first_prompt 一条），
 * 而 L3 打标要的正是正文。所以对话正文从 ~/.claude/projects 的 jsonl 补，
 * 两边按 session_id 关联。实测本机 394 个 session-meta：索引命中 394/394，
 * 其中 393 个有非空正文（缺的那个是 /login 会话，全篇没有人说过话，空结果是对的）。
 *
 * 🔴 这里划一条硬线：**jsonl 只用来取文本，绝不用来算任何数字**。
 * token、工具调用次数、失败数、提交数一律沿用官方字段。
 * 500 倍那次事故的根因是自建计数，不是自建读取——两件事不能混为一谈，
 * 也不能因为噎住就不吃饭：没有正文，Claude Code 侧的深度分析就是零。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { redact } from '../redact.mjs';
import { clipHeadTail } from '../budget.mjs';

export const name = 'claude-code';

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}
export function metaDir() { return join(claudeHome(), 'usage-data', 'session-meta'); }
/** 对话正文所在目录（深度分析的第二个数据源，doctor 要能自检到它）。 */
export function transcriptsDir() { return join(claudeHome(), 'projects'); }

export function discover({ days = 30 } = {}) {
  const dir = metaDir();
  if (!existsSync(dir)) return [];
  const cutoff = days > 0 ? Date.now() - days * 864e5 : 0;
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(dir, f);
    try {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      const ts = d.start_time ? Date.parse(d.start_time) : 0;
      if (ts >= cutoff) out.push({ path: p, mtime: ts });
    } catch { /* 坏文件跳过，doctor 会报计数差 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 官方 session-meta 字段 → 统一形状。注意：官方不提供 transcript，只有元数据。 */
export function parse(file) {
  let d; try { d = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  return {
    provider: 'claude-code', id: d.session_id, path: file,
    cwd: d.project_path || null, model: null,
    startedAt: d.start_time ? Date.parse(d.start_time) : null,
    endedAt: null,
    durationMinutes: d.duration_minutes || 0,
    userMessages: d.user_message_count || 0,
    assistantMessages: d.assistant_message_count || 0,
    toolCalls: Object.values(d.tool_counts || {}).reduce((a, b) => a + b, 0),
    toolCounts: d.tool_counts || {},
    toolFailures: d.tool_errors || 0,
    // 官方 session-meta 的 tool_errors 是对**全部**调用算的，所以可判定集就是全部调用。
    // 不补这一行，失败率的分子有、分母没有 —— 实测直接报出 163% 这种数。
    toolOutcomesKnown: Object.values(d.tool_counts || {}).reduce((a, b) => a + b, 0),
    toolStillRunning: 0, toolOutcomeUnknown: 0,
    userInterruptions: d.user_interruptions || 0,
    gitCommits: d.git_commits || 0,
    gitPushes: d.git_pushes || 0,
    responseGaps: d.user_response_times || [],
    languages: d.languages || {},
    linesAdded: d.lines_added || 0,
    linesRemoved: d.lines_removed || 0,
    filesModified: d.files_modified || 0,
    // 元数据到此为止全部来自官方 session-meta。以下只补对话正文：
    // 官方不提供 transcript，而 L3 打标离了正文什么也做不了。
    ...(() => {
      const r = readTranscript(d.session_id);
      if (r.transcript.length) {
        return {
          transcript: r.transcript,
          // 🔴 如实：截断过就不是 complete。此前只要读到一行就报 true，
          // 而默认采样下 63% 的会话是被截断的——那是个会骗人的字段。
          transcriptComplete: r.truncatedLines === 0,
          truncatedLines: r.truncatedLines,
          sidechainMessages: r.sidechainMessages,
          injectedMessages: r.injectedMessages,
        };
      }
      // 读不到就退回官方那一条 first_prompt，行为与之前一致
      return {
        transcript: d.first_prompt ? [`[user] ${redact(d.first_prompt).slice(0, 1200)}`] : [],
        transcriptComplete: false, truncatedLines: 0,
        sidechainMessages: r.sidechainMessages, injectedMessages: r.injectedMessages,
      };
    })(),
  };
}

/** 会话 id -> jsonl 路径。懒建一次，缓存在模块级；只 readdir 不读内容，3 万文件也快。 */
let _index = null;
export function transcriptIndex(rootOverride) {
  if (_index && !rootOverride) return _index;
  const idx = new Map();
  const root = rootOverride || transcriptsDir();
  if (!existsSync(root)) return rootOverride ? idx : (_index = idx);
  // 必须递归：实测 30,307 个 jsonl 里有 15,123 个在更深层目录（最深 7 层）
  // （子代理、workflow 运行各自建目录）。只扫两层会漏掉一半。
  const sizes = new Map();
  const sizeOf = (f) => { try { return statSync(f).size; } catch { return -1; } };
  const walk = (dir, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      const id = e.name.slice(0, -6);
      // 同一 session 可能在多处留档，取体积最大的那份（内容最全）
      const size = sizeOf(p);
      if (size < 0) continue;                       // 新候选读不了，保留已有的
      // 只比缓存下来的尺寸，不重复 stat 旧文件：原先一个 catch 同时兜住两次 statSync，
      // 旧文件被删或成了断链时会把坏条目留下、把好的新文件扔掉。
      if (idx.has(id) && size <= (sizes.get(id) ?? -1)) continue;
      idx.set(id, p); sizes.set(id, size);
    }
  };
  walk(root);
  if (!rootOverride) _index = idx;
  return idx;
}

/** 测试用：重置索引缓存。 */
export function _resetIndex() { _index = null; }

/**
 * 判「这条 user 消息是不是人打的字」优先用结构化标记，文本前缀只做兜底。
 *
 * jsonl 的 user 行自带三个布尔字段，比猜文本可靠得多（实测同一会话里
 * 图片占位符、slash-command 展开的 skill 全文、`(Re-invocation of …)` 三类
 * 全部带 isMeta:true，而真人那条没有）：
 *   isSidechain      子代理消息，其「用户消息」是控制器写的任务书
 *   isMeta           系统注入（图片占位、skill 文档、命令展开）
 *   isCompactSummary 上下文压缩摘要——助手写的、体量巨大、含历史 prompt 原文，
 *                    不滤掉会让同一批内容在多个会话里重复计入
 *
 * 文本前缀表保留，因为旧版本 jsonl 未必写这些字段；两道闸都过才算人说的话。
 */
const INJECTED = [
  '<system-reminder', '<command-name', '<command-message', '<local-command',
  '<user-prompt-submit-hook', '<task-notification', '<attachment', '<bash-',
  '<post-tool', '<hook', 'Caveat:', '[Request interrupted',
  'This session is being continued from a previous conversation',
  'Please continue the conversation from where we left',
  'Your task is to create a detailed summary of the conversation',
  'Base directory for this skill:',
];
const isInjected = (t) => INJECTED.some((k) => t.startsWith(k));

/**
 * 从一条 user 消息取出人打的文本。
 * content 实测有三种形态，只认 string 会漏掉贴图提问那一类——
 * 而那一类恰恰信息量最高（「这里是不是很奇怪？还有哪些我没想到的」）。
 */
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const types = new Set(content.map((b) => b && b.type));
  if (types.has('tool_result')) return null;          // 工具回执，不是人说的话
  const parts = content.filter((b) => b && b.type === 'text').map((b) => b.text || '');
  return parts.length ? parts.join('\n') : null;
}

/**
 * 读取一个会话的对话正文。返回 codex provider 同形状的 transcript 行数组。
 * 拿不到就返回空数组——调用方据此降级，不抛错。
 */
export function readTranscript(sessionId, { maxLines = 400, root = null } = {}) {
  const file = transcriptIndex(root).get(sessionId);
  if (!file) return { transcript: [], sidechainMessages: 0, injectedMessages: 0, truncatedLines: 0 };
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch { return { transcript: [], sidechainMessages: 0, injectedMessages: 0, truncatedLines: 0 }; }
  const out = [];
  let sidechain = 0, injected = 0;
  for (const line of lines) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    // 子代理消息的「用户消息」是控制器写的任务书，不是人说的话。
    // 官方 session-meta 也不含它们，混进来两边就对不上了。
    const msg = d.message;
    // sidechain 数的是子代理的**用户消息**（控制器写的任务书），不是 jsonl 行数：
    // summary 行、tool_result 回执都带这个标记，按行计会把这个数字撑大好几倍。
    if (d.isSidechain) { if (msg && d.type === 'user') sidechain++; continue; }
    if (!msg) continue;
    if (d.type === 'user') {
      if (d.isMeta === true || d.isCompactSummary === true) { injected++; continue; }
      const t = userText(msg.content);
      if (!t) continue;
      const clean = redact(t.trim());
      // 只挡空白，不设长度下限。中文里 1 个字就可以是完整回应（「好」「对」「停」），
      // 3 个字就是完整指令（「干这个」「改一下」）。按英文习惯写 <4 会整批丢掉它们，
      // 改成 <2 仍然吃掉全部单字回应——两次都是在测试里当场撞到的。
      if (!clean || isInjected(clean)) continue;
      out.push(`[user] ${clipHeadTail(clean, 1200)}`);
    } else if (d.type === 'assistant') {
      const c = msg.content;
      if (!Array.isArray(c)) continue;
      // 同一条 assistant 消息里的多个 tool_use 合并成一行。
      // 实测一个 2977 行的会话里 [tool] 占 358 行（89.5%），把行预算吃光——
      // 最后只有 8 条用户消息进模型。工具名本身信息量低，合并不丢信息但省出大量额度。
      const tools = [];
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text && b.text.trim()) {
          if (tools.length) { out.push(`[tool] ${tools.splice(0).join(', ')}`); }
          out.push(`[assistant] ${clipHeadTail(redact(b.text.trim()), 1200)}`);
        } else if (b.type === 'tool_use') {
          tools.push(b.name || 'unknown');
        }
      }
      if (tools.length) out.push(`[tool] ${tools.join(', ')}`);
    }
  }
  // 相邻的 [tool] 行再折一层：连着几条 assistant 消息只调工具、不说话时，
  // 上面的「同消息内合并」折不到它们。工具名序列本身保留，信息不丢，行数大降。
  // 实测最长的几个会话里 [tool] 占 67.5%（原始 89.5%），折完给对话腾出成倍的预算。
  const folded = [];
  for (const line of out) {
    if (line.startsWith('[tool] ') && folded.length && folded[folded.length - 1].startsWith('[tool] ')) {
      const merged = `${folded[folded.length - 1]}, ${line.slice(7)}`;
      folded[folded.length - 1] = clipHeadTail(merged, 600);
    } else folded.push(line);
  }
  out.length = 0; out.push(...folded);
  // 🔴 行数超限时保首尾，绝不能只取前 N 行。
  // budget.mjs 开篇那条教训（同一类「结尾被切掉」被外部测试连着抓到两轮）在行维度同样成立：
  // 会话结尾是验收边界——「这样就行了」「还是不对，再改」都在最后几行，砍掉尾巴等于砍掉结论。
  // 放大效应比看上去严重：全量 393 个会话只有 6.1% 撞上限，但采样器按 userMessages 降序挑，
  // 默认 --limit 30 时被送进模型的样本有 63% 撞上限、丢掉一半用户消息，且丢的全是尾部。
  if (out.length > maxLines) {
    const head = Math.floor(maxLines * 0.4);
    const tail = maxLines - head - 1;
    const omitted = out.length - head - tail;
    return {
      transcript: [...out.slice(0, head), `[… 略去中段 ${omitted} 行 …]`, ...out.slice(-tail)],
      sidechainMessages: sidechain, injectedMessages: injected, truncatedLines: omitted,
    };
  }
  return { transcript: out, sidechainMessages: sidechain, injectedMessages: injected, truncatedLines: 0 };
}

