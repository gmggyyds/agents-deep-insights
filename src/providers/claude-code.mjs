/**
 * Claude Code provider。
 *
 * 关键决策：**不自己解析 ~/.claude/projects 的 jsonl**。
 * 官方 /insights 已经在本机生成了 ~/.claude/usage-data/session-meta/*.json
 * （纯代码提取、26 字段、免费、随官方维护）。直接复用，一行采集代码不写。
 * 这条来自内部教训：自建 jsonl 解析器曾漏算 cache token 达 500 倍。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
    userInterruptions: d.user_interruptions || 0,
    gitCommits: d.git_commits || 0,
    gitPushes: d.git_pushes || 0,
    responseGaps: d.user_response_times || [],
    languages: d.languages || {},
    linesAdded: d.lines_added || 0,
    linesRemoved: d.lines_removed || 0,
    filesModified: d.files_modified || 0,
    // 官方只给首条 prompt，没有完整 transcript —— L3 打标时据此降级
    transcript: d.first_prompt ? [`[user] ${redact(d.first_prompt).slice(0, 400)}`] : [],
    transcriptComplete: false,
  };
}
