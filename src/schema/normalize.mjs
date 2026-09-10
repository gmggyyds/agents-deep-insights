/**
 * L4 归一化：把 LLM 的实际输出压回契约。
 *
 * 为什么需要它：strict schema 只在支持 structured output 的路径上生效。
 * 降级路径（prompt-only）实测 3 次里 2 次违规，且违规形态是**类型漂移**而非造新词：
 *   - goal_categories 的值给成 true/false（应为 integer）
 *   - friction_detail 给成 [...] 或 {...}（应为 string）
 * 类型漂移比 key 漂移更危险：key 全对，浅校验放行，然后在聚合层静默算错。
 * 所以本模块必须同时管 key 和 type。
 */

import { ENUM_OF, COUNT_KEYS_OF, ALIASES, FRICTION, ATTRIBUTION_OR_NONE } from './facet.mjs';

/** 最小 JSON 修复：剥 markdown 围栏、截首个对象、去尾逗号。不引第三方依赖。 */
export function parseLoose(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'not_a_string' };
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = s.indexOf('{');
  if (start === -1) return { ok: false, error: 'no_object_found' };
  // 找配对的收尾大括号（跳过字符串内的括号）
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  let body = end === -1 ? s.slice(start) : s.slice(start, end + 1);
  if (end === -1) body += '}'.repeat(Math.max(depth, 1)); // 截断补全
  body = body.replace(/,(\s*[}\]])/g, '$1'); // 尾逗号
  try { return { ok: true, value: JSON.parse(body) }; }
  catch (e) { return { ok: false, error: String(e.message).slice(0, 120) }; }
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 表外 key → 表内 key。精确 → 别名 → 编辑距离(<=2 且长度差<=3)。都不中返回 null。 */
export function mapKey(key, allowed) {
  const k = String(key).toLowerCase().trim().replace(/[-\s]+/g, '_').replace(/s$/, '');
  const norm = (x) => x.toLowerCase().replace(/s$/, '');
  const exact = allowed.find((a) => norm(a) === k);
  if (exact) return exact;
  const raw = String(key).toLowerCase().trim().replace(/[-\s]+/g, '_');
  if (ALIASES[raw] && allowed.includes(ALIASES[raw])) return ALIASES[raw];
  let best = null, bestD = 3;
  for (const a of allowed) {
    const d = lev(k, norm(a));
    if (d < bestD) { bestD = d; best = a; }
  }
  return bestD <= 2 ? best : null;
}

/** 值 → 非负整数。boolean 是实测最常见的漂移形态。 */
export function coerceCount(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;      // 实测：goal_categories 整体变 boolean
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  if (typeof v === 'string') {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return Math.max(0, Math.round(n));
    return null;
  }
  if (Array.isArray(v)) return v.length;             // 给了证据列表，取条数
  return null;
}

/** 值 → 字符串。实测 friction_detail 会漂成 list 和 dict。 */
export function coerceText(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => coerceText(x)).filter(Boolean).join('; ');
  if (typeof v === 'object') return Object.values(v).map((x) => coerceText(x)).filter(Boolean).join('; ');
  return String(v);
}

/**
 * 归一化一个 facet。返回 { facet, repairs }。
 * repairs 是审计轨迹——表外 key 的分布本身是 prompt 质量的信号，不静默吞掉。
 */
export function normalizeFacet(input) {
  const repairs = { unmapped_keys: [], coerced_types: [], dropped: [] };
  const out = {};

  for (const [field, allowed] of Object.entries(ENUM_OF)) {
    const raw = input?.[field];
    const v = typeof raw === 'string' ? raw.toLowerCase().trim().replace(/[-\s]+/g, '_') : raw;
    if (allowed.includes(v)) out[field] = v;
    else {
      const mapped = typeof v === 'string' ? mapKey(v, allowed) : null;
      if (mapped) { out[field] = mapped; repairs.coerced_types.push(`${field}: ${raw} -> ${mapped}`); }
      else { out[field] = null; if (raw != null) repairs.dropped.push(`${field}=${JSON.stringify(raw).slice(0, 40)}`); }
    }
  }

  for (const [field, keys] of Object.entries(COUNT_KEYS_OF)) {
    if (field === 'friction_attribution') continue;   // 已改为字符串枚举，不走计数路径
    const src = input?.[field];
    const acc = Object.fromEntries(keys.map((k) => [k, 0]));
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const [k, v] of Object.entries(src)) {
        const target = mapKey(k, keys);
        const n = coerceCount(v);
        if (target == null) { repairs.unmapped_keys.push(`${field}.${k}`); continue; }
        if (n == null) { repairs.dropped.push(`${field}.${k}=${JSON.stringify(v).slice(0, 30)}`); continue; }
        if (typeof v !== 'number' || Number.isInteger(v) === false) {
          repairs.coerced_types.push(`${field}.${k}: ${typeof v} -> int`);
        }
        acc[target] += n;   // 同义词合并靠 += ，这是修「工具类被低估 32%」的地方
      }
    }
    out[field] = acc;
  }

  // friction_attribution：新格式按类别，旧缓存是会话级三个数字。
  // 旧格式无法把责任绑到类别，一律降级为 unknown——宁可说「不知道」，
  // 也不能把旧的会话级总数当成类别级证据用。
  {
    const src = input?.friction_attribution;
    const acc = Object.fromEntries(FRICTION.map((k) => [k, 'none']));
    let legacy = false;
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const [k, v] of Object.entries(src)) {
        if (typeof v === 'number') { legacy = true; continue; }
        const target = mapKey(k, FRICTION);
        const val = typeof v === 'string' ? v.toLowerCase().trim().replace(/[-\s]+/g, '_') : null;
        if (!target) { repairs.unmapped_keys.push(`friction_attribution.${k}`); continue; }
        acc[target] = ATTRIBUTION_OR_NONE.includes(val) ? val : 'unknown';
        if (!ATTRIBUTION_OR_NONE.includes(val)) repairs.coerced_types.push(`friction_attribution.${k}: ${v} -> unknown`);
      }
    }
    if (legacy) {
      for (const k of FRICTION) if ((out.friction_counts?.[k] || 0) > 0) acc[k] = 'unknown';
      repairs.coerced_types.push('friction_attribution: 旧的会话级格式 -> 逐类别 unknown');
    }
    out.friction_attribution = acc;
  }

  const detailRaw = input?.friction_detail;
  out.friction_detail = coerceText(detailRaw);
  if (detailRaw != null && typeof detailRaw !== 'string') {
    repairs.coerced_types.push(`friction_detail: ${Array.isArray(detailRaw) ? 'array' : typeof detailRaw} -> string`);
  }
  out.brief_summary = coerceText(input?.brief_summary);
  // underlying_goal 与 brief_summary 同样会漂成 list/dict，走同一条兜底
  out.underlying_goal = coerceText(input?.underlying_goal);

  const ui = input?.user_instructions;
  out.user_instructions = Array.isArray(ui) ? ui.map(coerceText).filter(Boolean)
    : (ui ? [coerceText(ui)] : []);

  return { facet: out, repairs };
}
