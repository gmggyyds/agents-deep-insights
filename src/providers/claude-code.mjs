/**
 * Claude Code provider。
 *
 * 关键决策：**统计不自己算**。官方 /insights 已经在本机生成了
 * ~/.claude/usage-data/session-meta/*.json（纯代码提取、26 字段、随官方维护），
 * 直接复用。依据是内部教训：自建 jsonl 解析器曾漏算 cache token 达 500 倍。
 *
 * 但官方**不提供 transcript**，而深度分析没有正文就做不了——此前 claude-code
 * 的会话一律进不了 L3，本机可用样本只剩 6 个 Codex 会话。
 * 所以 v0.6 起补一条窄通道：会话清单与统计仍以 session-meta 为准，
 * 只从 ~/.claude/projects 的 jsonl 里取**正文**（见 cc-transcript.mjs）。
 * 分工，不是推翻——不重算官方已有的数，只补它没有的那一样。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { redact } from '../redact.mjs';
import { readTranscript } from './cc-transcript.mjs';

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
    // 正文从 jsonl 补；补不到才退回官方的首条 prompt（此时 L3 会据此降级）
    ...(() => {
      const tr = readTranscript(d.session_id);
      if (tr && tr.transcript.length > 1) {
        return {
          transcript: tr.transcript,
          transcriptComplete: true,
          // 工具成败改用 jsonl 里的 is_error（权威信号）；官方 tool_errors 只有总数，
          // 拿不到「判不出来」那一档，会把未知静默算进成功。
          toolFailures: tr.stats.toolFailures,
          toolOutcomesKnown: tr.stats.toolOutcomesKnown,
          toolOutcomeUnknown: tr.stats.toolOutcomeUnknown,
          sidechainLines: tr.stats.sidechainLines,
        };
      }
      return {
        transcript: d.first_prompt ? [`[user] ${redact(d.first_prompt).slice(0, 1200)}`] : [],
        transcriptComplete: false,
      };
    })(),
  };
}
