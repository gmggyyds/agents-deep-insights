/** L4 聚合。纯代码，零 LLM —— 所有计数/排序/门槛判定都在这里，不交给模型。 */
import { FRICTION, GOAL_CATEGORIES, ATTRIBUTION , COLLAB_MODE } from '../schema/facet.mjs';
import { isSubstantive, isSubagent } from './sample.mjs';

export function aggregateMetas(metas) {
  const a = {
    sessions: 0,   // 真人参与的会话数，循环里累加；子代理不计
    allSessions: metas.length, substantive: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0,
    toolFailures: 0, interruptions: 0, gitCommits: 0, gitPushes: 0,
    toolOutcomesKnown: 0, toolStillRunning: 0, toolOutcomeUnknown: 0,
    totalMinutes: 0, toolCounts: {}, projects: {}, hours: Array(24).fill(0),
    gaps: [], days: new Set(), durations: [],
    subagentSessions: 0, subagentToolCalls: 0, subagentUserMessages: 0,
    // 姿态信号（授权策略/沙箱/任务分解）目前只有 Codex 会话带。用全部会话当分母
    // 会把比例稀释：实测「8/411 个会话有任务分解」，真实分母是 17 个 Codex 会话，
    // 差 24 倍。凡是只有部分数据源具备的信号，必须自带自己的分母。
    postureSessions: 0,
    // 姿态分布（Codex 独有，官方 /insights 无等价信号）：
    // 用户显式给出的授权与沙箱策略，是「你把它当自主执行器还是结对编程」最硬的证据。
    approvalPolicies: {}, sandboxPolicies: {}, originators: {}, sources: {}, models: {},
    planSessions: 0,
  };
  for (const m of metas) {
    // 子代理会话单独记账，不并入「你和 agent 的协作」口径
    if (isSubagent(m)) {
      a.subagentSessions++;
      a.subagentToolCalls += m.toolCalls || 0;
      a.subagentUserMessages += m.userMessages || 0;
      continue;
    }
    a.userMessages += m.userMessages || 0;
    a.assistantMessages += m.assistantMessages || 0;
    a.toolCalls += m.toolCalls || 0;
    a.toolFailures += m.toolFailures || 0;
    a.toolOutcomesKnown += m.toolOutcomesKnown || 0;
    a.toolStillRunning += m.toolStillRunning || 0;
    a.toolOutcomeUnknown += m.toolOutcomeUnknown || 0;
    a.interruptions += m.userInterruptions || 0;
    a.gitCommits += m.gitCommits || 0;
    a.gitPushes += m.gitPushes || 0;
    a.totalMinutes += m.durationMinutes || 0;
    a.sessions++;
    if (isSubstantive(m) && m.durationMinutes > 0) a.durations.push(m.durationMinutes);
    if (isSubstantive(m)) a.substantive++;
    for (const [k, v] of Object.entries(m.toolCounts || {})) a.toolCounts[k] = (a.toolCounts[k] || 0) + v;
    // 同时支持 POSIX 与 Windows 路径分隔符（外部 Windows 测试发现 C:\\a\\b 会整个当项目名）
    if (m.cwd) { const p = m.cwd.split(/[\\/]/).filter(Boolean).pop() || m.cwd; a.projects[p] = (a.projects[p] || 0) + 1; }
    if (m.startedAt) { a.hours[new Date(m.startedAt).getHours()]++; a.days.add(new Date(m.startedAt).toISOString().slice(0, 10)); }
    for (const g of m.responseGaps || []) if (g > 0) a.gaps.push(g);
    const bump = (o, v) => { if (v) o[v] = (o[v] || 0) + 1; };
    bump(a.approvalPolicies, m.approvalPolicy); bump(a.sandboxPolicies, m.sandboxPolicy);
    bump(a.originators, m.originator); bump(a.sources, m.source); bump(a.models, m.model);
    if ((m.planSteps || []).length) a.planSessions++;
    if (m.approvalPolicy || m.sandboxPolicy || (m.planSteps || []).length) a.postureSessions++;
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
  // 分母只用「能判定结果的调用」。把判不出来的混进分母等于系统性稀释失败率——
  // 本机实测 1,224 次调用里有 280 次拿不到退出码、119 次仍在运行，
  // 按总调用算失败率会低估三分之一。
  a.failureRate = a.toolOutcomesKnown ? a.toolFailures / a.toolOutcomesKnown : 0;
  a.failureRateCoverage = a.toolCalls ? a.toolOutcomesKnown / a.toolCalls : 0;
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


/** outcome 三分：达成 / 未达成 / 说不清。说不清单列，不算成功也不算失败。 */
const GOOD_OUTCOMES = new Set(['fully_achieved', 'mostly_achieved']);
const BAD_OUTCOMES = new Set(['not_achieved', 'partially_achieved']);

/** 一个会话有没有被打过协作模式的标（旧缓存 facet 没有这个字段，必须排除而不是当成 0）。 */
function hasModeLabel(f) {
  const c = f?.collaboration_mode_counts;
  return !!c && COLLAB_MODE.some((k) => typeof c[k] === 'number');
}

function groupProfile(list) {
  let good = 0, bad = 0, unclear = 0, friction = 0, userActionable = 0, frictionTotal = 0;
  for (const f of list) {
    if (GOOD_OUTCOMES.has(f?.outcome)) good++;
    else if (BAD_OUTCOMES.has(f?.outcome)) bad++;
    else unclear++;
    const counts = f?.friction_counts || {};
    const attrs = f?.friction_attribution || {};
    for (const k of FRICTION) {
      const n = counts[k] || 0;
      if (!n) continue;
      friction += n; frictionTotal += n;
      if (attrs[k] === 'user_actionable') userActionable += n;
    }
  }
  const decidable = good + bad;
  return {
    n: list.length,
    good, bad, unclear,
    // 分母只用可判定集——判不出来的不塞进任何一边充数（同工具失败率的口径）
    successRate: decidable ? good / decidable : null,
    decidable,
    frictionPerSession: list.length ? friction / list.length : 0,
    userActionableShare: frictionTotal ? userActionable / frictionTotal : null,
  };
}

/**
 * 协作模式 × 结果 的交叉。
 *
 * 回答的问题：**一个会话里出现过某种协作模式，跟这个会话的结果有没有关系？**
 * 例如「没有任何 deliberate（想清楚）就直接派活的会话，是不是更容易出问题？」
 *
 * 🔴 这是**相关性，不是因果**。渲染层必须照此措辞。混杂因素是真实存在的：
 * 简单任务天然不需要 deliberate 且天然容易成功，会把关系拉成反向。
 * 🔴 任一组样本不足 MIN_GROUP 就返回 insufficient——小样本的百分比差异毫无意义。
 */
const MIN_GROUP = 5;

export function crossCollabOutcome(facets) {
  const labeled = facets.filter(hasModeLabel);
  const out = { labeledSessions: labeled.length, byMode: {} };
  if (labeled.length < MIN_GROUP * 2) { out.insufficient = true; return out; }
  for (const mode of COLLAB_MODE) {
    const withMode = labeled.filter((f) => (f.collaboration_mode_counts?.[mode] || 0) > 0);
    const without = labeled.filter((f) => !(f.collaboration_mode_counts?.[mode] > 0));
    if (withMode.length < MIN_GROUP || without.length < MIN_GROUP) {
      out.byMode[mode] = { insufficient: true, with: withMode.length, without: without.length };
      continue;
    }
    const a = groupProfile(withMode), b = groupProfile(without);
    out.byMode[mode] = {
      with: a, without: b,
      successRateDelta: (a.successRate != null && b.successRate != null)
        ? a.successRate - b.successRate : null,
      frictionDelta: a.frictionPerSession - b.frictionPerSession,
    };
  }
  return out;
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
  const collab = sum(COLLAB_MODE, 'collaboration_mode_counts');
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
    helpfulness: counts('claude_helpfulness'), successes: counts('primary_success'),
    reactions: facets.reduce((acc, f) => {
      for (const [k, v] of Object.entries(f?.user_reaction_counts || {})) {
        if (typeof v === 'number' && v > 0) acc[k] = (acc[k] || 0) + v;
      }
      return acc;
    }, {}),
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
    collaborationModes: rank(collab),
    collaborationCross: crossCollabOutcome(facets),
    repeatedInstructions: Object.entries(instructions)
      .filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1])
      .map(([text, n]) => ({ text, n })),
  };
}
