/** L4 聚合。纯代码，零 LLM —— 所有计数/排序/门槛判定都在这里，不交给模型。 */
import { FRICTION, GOAL_CATEGORIES, ATTRIBUTION } from '../schema/facet.mjs';
import { isSubstantive } from './sample.mjs';

export function aggregateMetas(metas) {
  const a = {
    sessions: metas.length, substantive: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0,
    toolFailures: 0, interruptions: 0, gitCommits: 0, gitPushes: 0,
    totalMinutes: 0, toolCounts: {}, projects: {}, hours: Array(24).fill(0),
    gaps: [], days: new Set(), durations: [],
  };
  for (const m of metas) {
    a.userMessages += m.userMessages || 0;
    a.assistantMessages += m.assistantMessages || 0;
    a.toolCalls += m.toolCalls || 0;
    a.toolFailures += m.toolFailures || 0;
    a.interruptions += m.userInterruptions || 0;
    a.gitCommits += m.gitCommits || 0;
    a.gitPushes += m.gitPushes || 0;
    a.totalMinutes += m.durationMinutes || 0;
    if (isSubstantive(m) && m.durationMinutes > 0) a.durations.push(m.durationMinutes);
    if (isSubstantive(m)) a.substantive++;
    for (const [k, v] of Object.entries(m.toolCounts || {})) a.toolCounts[k] = (a.toolCounts[k] || 0) + v;
    // 同时支持 POSIX 与 Windows 路径分隔符（外部 Windows 测试发现 C:\\a\\b 会整个当项目名）
    if (m.cwd) { const p = m.cwd.split(/[\\/]/).filter(Boolean).pop() || m.cwd; a.projects[p] = (a.projects[p] || 0) + 1; }
    if (m.startedAt) { a.hours[new Date(m.startedAt).getHours()]++; a.days.add(new Date(m.startedAt).toISOString().slice(0, 10)); }
    for (const g of m.responseGaps || []) if (g > 0) a.gaps.push(g);
  }
  a.daysActive = a.days.size; delete a.days;
  // 注意：totalMinutes 是「会话跨度之和」，含挂机时间且多窗口并发时会重复累加，
  // 不等于真实工时，因此不对外展示为「累计小时」。中位数才是可解释的。
  a.durations.sort((x, y) => x - y);
  a.medianDuration = a.durations.length ? a.durations[Math.floor(a.durations.length / 2)] : 0;
  a.longestSession = a.durations.length ? a.durations[a.durations.length - 1] : 0;
  delete a.durations;
  a.gaps.sort((x, y) => x - y);
  a.medianGap = a.gaps.length ? a.gaps[Math.floor(a.gaps.length / 2)] : null;
  a.failureRate = a.toolCalls ? a.toolFailures / a.toolCalls : 0;
  return a;
}

/** facet 聚合。noise floor：只出现 1 次的不展示；立规候选要求 >= 3。 */
export const RULE_THRESHOLD = 3;
export const NOISE_FLOOR = 2;

/**
 * fork 会话继承父会话的全部历史，同一句话会在父子里各出现一次。
 * 把 fork 家族并成一个集合，家族内同一句只算一次——否则「你反复说过的话」会虚高。
 * （外部测试发现：两个 fork 关系的会话把同一组指令报成了「2 次」）
 */
function forkFamilyOf(metas) {
  const parent = new Map();          // id -> forkedFrom
  for (const m of metas || []) if (m?.id) parent.set(m.id, m.forkedFrom || null);
  const rootOf = (id, seen = new Set()) => {
    let cur = id;
    while (parent.get(cur) && !seen.has(cur)) { seen.add(cur); cur = parent.get(cur); }
    return cur;
  };
  const fam = new Map();             // id -> 家族根 id
  for (const id of parent.keys()) fam.set(id, rootOf(id));
  return fam;
}

export function aggregateFacets(facets, { noiseFloor = NOISE_FLOOR, metas = null } = {}) {
  const family = metas ? forkFamilyOf(metas) : null;
  const sum = (keys, field) => {
    const acc = Object.fromEntries(keys.map((k) => [k, 0]));
    const sessions = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const f of facets) for (const [k, v] of Object.entries(f?.[field] || {})) {
      if (!(k in acc)) continue;
      acc[k] += v; if (v > 0) sessions[k]++;
    }
    return { total: acc, sessions };
  };
  const friction = sum(FRICTION, 'friction_counts');
  const goals = sum(GOAL_CATEGORIES, 'goal_categories');
  // 归因汇总由「该类别的归因 × 该类别的次数」推导，不再单独存会话级总数。
  // unknown 单列——原因不明的失败不塞进 environmental 充数。
  const attribution = { user_actionable: 0, agent_capability: 0, environmental: 0, unknown: 0 };
  const attrByCategory = {};          // key -> {归因: 会话数}
  for (const f of facets) {
    const counts = f?.friction_counts || {};
    const attrs = f?.friction_attribution || {};
    for (const k of FRICTION) {
      const n = counts[k] || 0;
      if (!n) continue;
      const a = ATTRIBUTION.includes(attrs[k]) ? attrs[k] : 'unknown';
      attribution[a] += n;
      (attrByCategory[k] ||= {})[a] = (attrByCategory[k]?.[a] || 0) + 1;
    }
  }

  const rank = (o) => Object.entries(o.total)
    .filter(([, v]) => v >= noiseFloor)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => ({ key: k, count: v, sessions: o.sessions[k] }));

  const counts = (field) => {
    const c = {};
    for (const f of facets) { const v = f?.[field]; if (v) c[v] = (c[v] || 0) + 1; }
    return c;
  };

  // 计数单位是「家族」而不是「会话」：fork 出来的子会话不重复计
  const seenBy = {};
  for (const f of facets) {
    const unit = family && f?.session_id ? (family.get(f.session_id) || f.session_id) : (f?.session_id ?? Math.random());
    for (const s of f?.user_instructions || []) {
      const k = String(s).trim().toLowerCase();
      if (k.length <= 6) continue;
      (seenBy[k] ||= new Set()).add(unit);
    }
  }
  const instructions = Object.fromEntries(Object.entries(seenBy).map(([k, set]) => [k, set.size]));

  return {
    n: facets.length,
    friction: rank(friction), goals: rank(goals),
    attribution,
    outcomes: counts('outcome'), sessionTypes: counts('session_type'),
    // 立规候选：两个条件同时满足才提
    //   ① 重复 >= 3 个会话（对齐「同坑第 N 次才升格」的做法）
    //   ② **这一类摩擦本身**在多数会话里被归为用户可改
    // 此前用的是全局开关（整体有任何 user_actionable 就放行所有类别），外部复测
    // 用「3 条纯环境 tool_failed + 1 条无关的 user_actionable」就把它打穿了。
    // 责任必须绑到类别，不能靠会话级总数。
    ruleCandidates: rank(friction).filter((f) => {
      if (f.sessions < RULE_THRESHOLD) return false;
      const by = attrByCategory[f.key] || {};
      const total = Object.values(by).reduce((a, b) => a + b, 0) || 1;
      return (by.user_actionable || 0) / total > 0.5;   // 过半会话判定为用户可改
    }).map((f) => ({ ...f, attribution: attrByCategory[f.key] || {} })),
    attributionByCategory: attrByCategory,
    repeatedInstructions: Object.entries(instructions)
      .filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1])
      .map(([text, n]) => ({ text, n })),
  };
}
