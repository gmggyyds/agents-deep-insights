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

const LOW_SIGNAL = /^(<turn_aborted>|<environment_context>|# AGENTS\.md|<permissions instructions>)/;

/** L1：纯代码提取 session-meta。零 LLM。 */
export function parse(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const meta = {
    provider: 'codex', id: null, path: file, cwd: null, model: null,
    startedAt: null, endedAt: null,
    userMessages: 0, assistantMessages: 0, toolCalls: 0,
    toolCounts: {}, toolFailures: 0, userInterruptions: 0,
    gitCommits: 0, gitPushes: 0, responseGaps: [], transcript: [],
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
      if (clean) meta.transcript.push(`[${pl.role}] ${redact(clean).slice(0, 400)}`);
    } else if (pl.type === 'function_call' || pl.type === 'custom_tool_call') {
      meta.toolCalls++;
      const n = pl.name || 'unknown';
      meta.toolCounts[n] = (meta.toolCounts[n] || 0) + 1;
      const args = typeof pl.arguments === 'string' ? pl.arguments : JSON.stringify(pl.arguments || '');
      if (/\bgit\s+commit\b/.test(args)) meta.gitCommits++;
      if (/\bgit\s+push\b/.test(args)) meta.gitPushes++;
      meta.transcript.push(`[tool] ${n}`);
    } else if (pl.type === 'function_call_output' || pl.type === 'custom_tool_call_output') {
      const o = typeof pl.output === 'string' ? pl.output : JSON.stringify(pl.output || '');
      if (/"exit_code"\s*:\s*[1-9]|command failed|error:/i.test(o)) meta.toolFailures++;
    }
  }
  meta.id ||= file.split('/').pop().replace(/^rollout-|\.jsonl$/g, '');
  meta.durationMinutes = meta.startedAt && meta.endedAt
    ? Math.round((meta.endedAt - meta.startedAt) / 60000) : 0;
  return meta;
}
