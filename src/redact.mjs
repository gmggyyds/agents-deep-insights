/**
 * 脱敏：在任何内容离开本进程（进入 LLM）之前执行。
 *
 * 这不是假想需求。2026-09-09 从真实 Codex 会话提取 transcript 做实验时，
 * 里面直接带着一个可用的一次性登录 token（JWT）。
 * 使用者的会话里会有 API key、供应商报价、利润数据——采集层必须默认脱敏。
 */

const RULES = [
  [/\beyJ[A-Za-z0-9_\-]{15,}\.[A-Za-z0-9_\-]{10,}(?:\.[A-Za-z0-9_\-]+)?/g, '<JWT_REDACTED>'],
  [/\b(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xoxb-|xoxp-|xoxa-|AKIA|ASIA|glpat-|AIza)[A-Za-z0-9_\-]{12,}/g, '<KEY_REDACTED>'],
  [/([?&](?:token|access_token|refresh_token|disposable_login_token|api_key|apikey|key|secret|password|passwd|pwd|sig|signature|auth)=)[^&\s"']+/gi, '$1<REDACTED>'],
  [/\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["']?([^\s"',;]{8,})["']?/gi, (m) => m.replace(/([:=]\s*["']?)[^\s"',;]{8,}/, '$1<REDACTED>')],
  [/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '<EMAIL_REDACTED>'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<PRIVATE_KEY_REDACTED>'],
  // 兜底：40+ 位无空格长串（多数是 token/hash）。放最后，避免抢在具名规则前面。
  [/\b(?![A-Za-z0-9_\-]*REDACTED)[A-Za-z0-9_\-]{40,}\b/g, '<LONGTOKEN_REDACTED>'],
];

export function redact(text) {
  if (typeof text !== 'string' || !text) return text ?? '';
  let s = text;
  for (const [rx, rep] of RULES) s = s.replace(rx, rep);
  return s;
}

/** 自检：返回仍可能是凭证的残留片段。用于测试和 doctor。 */
export function auditRedaction(text) {
  const probes = [
    ['jwt', /\beyJ[A-Za-z0-9_\-]{15,}\.[A-Za-z0-9_\-]{10,}/g],
    ['api_key', /\b(?:sk-ant-|sk-|ghp_|github_pat_|xoxb-|AKIA|glpat-|AIza)[A-Za-z0-9_\-]{12,}/g],
    ['email', /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g],
    ['long_token', /\b[A-Za-z0-9_\-]{40,}\b/g],
  ];
  const leaks = [];
  for (const [name, rx] of probes) {
    for (const m of String(text).match(rx) || []) {
      if (!m.includes('REDACTED')) leaks.push({ kind: name, sample: m.slice(0, 24) + '…' });
    }
  }
  return leaks;
}
