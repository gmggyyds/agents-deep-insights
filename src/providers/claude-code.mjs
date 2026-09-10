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
 * 两边按 session_id 关联（实测 394/394 命中，见 tests/claude-code-transcript.test.mjs）。
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

export const name = 'claude-code';

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}
export function metaDir() { return join(claudeHome(), 'usage-data', 'session-meta'); }

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
      const { transcript, sidechainMessages } = readTranscript(d.session_id);
      if (transcript.length) return { transcript, transcriptComplete: true, sidechainMessages };
      // 读不到就退回官方那一条 first_prompt，行为与之前一致
      return {
        transcript: d.first_prompt ? [`[user] ${redact(d.first_prompt).slice(0, 1200)}`] : [],
        transcriptComplete: false, sidechainMessages: 0,
      };
    })(),
  };
}

/** 会话 id -> jsonl 路径。懒建一次，缓存在模块级；只 readdir 不读内容，3 万文件也快。 */
let _index = null;
export function transcriptIndex(rootOverride) {
  if (_index && !rootOverride) return _index;
  const idx = new Map();
  const root = rootOverride || join(claudeHome(), 'projects');
  if (!existsSync(root)) return rootOverride ? idx : (_index = idx);
  // 必须递归：实测 30,307 个 jsonl 里有 15,123 个在更深层目录（最深 7 层）
  // （子代理、workflow 运行各自建目录）。只扫两层会漏掉一半。
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
      const prev = idx.get(id);
      if (prev) {
        try { if (statSync(p).size <= statSync(prev).size) continue; } catch { continue; }
      }
      idx.set(id, p);
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
  if (!file) return { transcript: [], sidechainMessages: 0, injectedMessages: 0 };
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch { return { transcript: [], sidechainMessages: 0, injectedMessages: 0 }; }
  const out = [];
  let sidechain = 0, injected = 0;
  for (const line of lines) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    // 子代理消息的「用户消息」是控制器写的任务书，不是人说的话。
    // 官方 session-meta 也不含它们，混进来两边就对不上了。
    if (d.isSidechain) { sidechain++; continue; }
    const msg = d.message;
    if (!msg) continue;
    if (d.type === 'user') {
      if (d.isMeta === true || d.isCompactSummary === true) { injected++; continue; }
      const t = userText(msg.content);
      if (!t) continue;
      const clean = redact(t.trim());
      // 长度下限只挡空白，不挡短指令：中文 3 个字就是完整指令（「干这个」「改一下」
      // 「继续跑」），按英文习惯写 <4 会把它们整批丢掉——实测在测试里当场撞到。
      if (!clean || clean.length < 2 || isInjected(clean)) continue;
      out.push(`[user] ${clip(clean)}`);
    } else if (d.type === 'assistant') {
      const c = msg.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text && b.text.trim()) {
          out.push(`[assistant] ${clip(redact(b.text.trim()))}`);
        } else if (b.type === 'tool_use') {
          out.push(`[tool] ${b.name || 'unknown'}`);
        }
      }
    }
    if (out.length >= maxLines) break;
  }
  return { transcript: out, sidechainMessages: sidechain, injectedMessages: injected };
}

/** 与 codex provider 同口径的单条裁剪：保首尾，中段省略。 */
function clip(t, max = 1200) {
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.62), tail = max - head - 16;
  return `${t.slice(0, head)} …[略${t.length - max}字]… ${t.slice(-tail)}`;
}
