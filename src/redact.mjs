/**
 * 脱敏：在任何内容离开本进程（进入 LLM）之前执行。
 *
 * 这不是假想需求。开发过程中从真实会话提取内容时，里面直接带着一个可用的登录 token。
 *
 * 覆盖形态（v0.2.1 由外部测试补齐 JSON 字段与 Authorization 头两类）：
 * 私钥块 / JWT / 常见 key 前缀 / Authorization 头 / JSON-YAML-TOML 凭证字段 /
 * URL query 凭证参数 / 邮箱 / 40 位以上长串。
 * auditRedaction 的探针必须与 RULES 一一对应——探针漏掉的形态，自检会假绿。
 * 使用者的会话里会有 API key、供应商报价、利润数据——采集层必须默认脱敏。
 */

const RULES = [
  // 私钥块要最先处理，否则内部内容会被其他规则打碎
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<PRIVATE_KEY_REDACTED>'],
  [/\beyJ[A-Za-z0-9_\-]{15,}\.[A-Za-z0-9_\-]{10,}(?:\.[A-Za-z0-9_\-]+)?/g, '<JWT_REDACTED>'],
  [/\b(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xoxb-|xoxp-|xoxa-|AKIA|ASIA|glpat-|AIza)[A-Za-z0-9_\-]{12,}/g, '<KEY_REDACTED>'],
  // Authorization / Proxy-Authorization 头（Bearer / Basic / token）
  [/\b(Authorization|Proxy-Authorization)\s*:\s*(Bearer|Basic|Token|token)\s+\S+/gi, '$1: $2 <REDACTED>'],
  // JSON / YAML / TOML 里的凭证字段："access_token": "xxx" / app_secret = 'xxx' / password: xxx
  [/(["']?\b(?:app_?secret|client_?secret|access_?token|refresh_?token|id_?token|api_?key|apikey|secret_?key|private_?key|password|passwd|pwd|auth_?token|session_?token|bearer|credentials?|token|secret)\b["']?\s*[:=]\s*)(["']?)([^\s"',;}\]]{6,})\2/gi,
   (_m, k, q) => `${k}${q}<REDACTED>${q}`],
  // URL query 里的凭证参数
  [/([?&](?:token|access_token|refresh_token|disposable_login_token|api_key|apikey|key|secret|password|passwd|pwd|sig|signature|auth)=)[^&\s"']+/gi, '$1<REDACTED>'],
  [/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '<EMAIL_REDACTED>'],
  // 兜底：40+ 位无空格长串。放最后，避免抢在具名规则前面。
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
    ['auth_header', /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|Token|token)\s+\S+/gi],
    ['credential_field', /["']?\b(?:app_?secret|client_?secret|access_?token|refresh_?token|api_?key|apikey|secret_?key|password|passwd|auth_?token|session_?token|credentials?|token|secret)\b["']?\s*[:=]\s*["']?[^\s"',;}\]]{6,}/gi],
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
