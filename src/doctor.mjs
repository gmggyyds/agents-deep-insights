/**
 * 环境自检。
 *
 * 存在理由：作者只有 macOS + 一个 Codex 版本，测不了别人的 OS / 版本 / 空数据 /
 * 额度耗尽。与其让使用者描述「跑不起来」，不如让工具自证环境。
 *
 * 硬约束：输出只含环境与计数，绝不含任何会话内容 —— 它要被贴进公开 issue。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform, release, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as codex from './providers/codex.mjs';
import * as cc from './providers/claude-code.mjs';

export const ERRORS = {
  E_NO_SESSIONS: '未找到任何会话记录',
  E_CODEX_TOO_OLD: 'Codex CLI 版本过旧，跑不了账号的默认模型',
  E_CODEX_MISSING: '未安装 Codex CLI',
  E_SCHEMA_REJECTED: '模型拒绝了 output schema',
  E_NO_PROVIDER: '没有可用的数据源',
};

function tryExec(cmd, args) {
  try { return { ok: true, out: execFileSync(cmd, args, { stdio: 'pipe', timeout: 15000 }).toString().trim() }; }
  catch (e) { return { ok: false, out: (e.stderr?.toString() || e.message || '').slice(0, 200) }; }
}

export function collect() {
  const d = { tool: 'agents-deep-insights', version: '0.5.0', ts: new Date().toISOString() };
  d.env = { os: `${platform()} ${release()}`, node: process.version, arch: process.arch };

  const cv = tryExec('codex', ['--version']);
  d.codex = { installed: cv.ok, version: cv.ok ? cv.out : null };
  d.sqlite3 = tryExec('sqlite3', ['--version']).ok;
  const clv = tryExec('claude', ['--version']);
  d.claudeCode = { installed: clv.ok, version: clv.ok ? clv.out.split('\n')[0] : null };

  // doctor 输出要贴进公开 issue，绝不能带本机用户名
  const tilde = (p) => String(p).replace(homedir(), '~');
  d.sources = {
    codexHome: { path: tilde(codex.codexHome()), exists: existsSync(codex.codexHome()) },
    claudeMeta: { path: tilde(cc.metaDir()), exists: existsSync(cc.metaDir()) },
  };
  d.counts = {
    codexSessions30d: codex.discover({ days: 30 }).length,
    codexSessionsAll: codex.discover({ days: 0 }).length,
    claudeMeta30d: cc.discover({ days: 30 }).length,
    claudeMetaAll: cc.discover({ days: 0 }).length,
  };

  d.problems = [];
  if (!d.codex.installed && !d.claudeCode.installed) d.problems.push({ code: 'E_NO_PROVIDER', hint: '安装 Codex CLI 或 Claude Code 后再试' });
  if (d.counts.codexSessionsAll === 0 && d.counts.claudeMetaAll === 0) {
    d.problems.push({ code: 'E_NO_SESSIONS', hint: '先正常使用 Codex 或 Claude Code 产生一些会话' });
  }
  if (d.counts.claudeMetaAll === 0 && d.claudeCode.installed) {
    d.problems.push({ code: 'E_NO_SESSIONS', scope: 'claude-code', hint: '在 Claude Code 里先跑一次 /insights 生成 session-meta' });
  }
  if (!d.sqlite3) d.problems.push({ code: 'W_NO_SQLITE', hint: 'sqlite3 缺失，Codex 索引降级为直接扫目录（功能不减）' });
  return d;
}

/** 探测 output schema 是否真被强制。会发起一次极小的真实调用。 */
export function probeSchema() {
  if (!tryExec('codex', ['--version']).ok) return { supported: false, code: 'E_CODEX_MISSING' };
  const { mkdtempSync, writeFileSync, rmSync } = require$fs();
  const dir = mkdtempSync(join(tmpdir(), 'adi-probe-'));  // 不能写死 /tmp，Windows 上 ENOENT
  const sf = `${dir}/s.json`;
  writeFileSync(sf, JSON.stringify({
    type: 'object', additionalProperties: false,
    properties: { ok: { type: 'string', enum: ['yes', 'no'] } }, required: ['ok'],
  }));
  const r = tryExec('codex', ['exec', '--skip-git-repo-check', '--ephemeral', '--output-schema', sf, '-o', `${dir}/o.json`, 'Reply with ok=yes']);
  let out = null;
  try { out = JSON.parse(require$fs().readFileSync(`${dir}/o.json`, 'utf8')); } catch { /* noop */ }
  rmSync(dir, { recursive: true, force: true });
  if (out && (out.ok === 'yes' || out.ok === 'no')) return { supported: true };
  if (/requires a newer version/i.test(r.out)) return { supported: false, code: 'E_CODEX_TOO_OLD', detail: r.out.slice(0, 160) };
  if (/invalid_json_schema/i.test(r.out)) return { supported: false, code: 'E_SCHEMA_REJECTED', detail: r.out.slice(0, 160) };
  return { supported: false, code: 'E_SCHEMA_REJECTED', detail: r.out.slice(0, 160) };
}
function require$fs() { return globalThis.__adi_fs; }

export function renderIssue(d, schema) {
  return [
    '<!-- 由 `adi doctor --issue` 生成。只含环境与计数，不含任何会话内容。 -->',
    '### 环境', '```json', JSON.stringify({ ...d, schemaProbe: schema }, null, 2), '```',
    '', '### 我做了什么', '（贴上你运行的命令）', '', '### 期望 / 实际', '（期望看到…，实际看到…）',
  ].join('\n');
}
