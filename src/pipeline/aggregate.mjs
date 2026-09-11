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

/**
 * 一个会话有没有被真正打过协作模式的标。
 *
 * 🔴 不能用「字段存在 / 是数字」判断：`normalizeFacet` 对 COUNT_KEYS_OF 里的字段
 * 无条件 dense-fill，源里根本没有这个字段时也会产出 {delegate:0,deliberate:0,steer:0}，
 * 于是「没打标」被判成「已打标」，对照组被未打标会话填满，直接造出
 * 「有 deliberate 成功率 0% vs 无 100%」这种假结论。
 * 而这条路径是可达的：该字段是 required 列表最后一个 key，模型输出截断时第一个丢，
 * 而 parseLoose 专门做截断补全，补完就是一份"看起来完整"的全 0 facet。
 *
 * 改用「三类之和 > 0」：采样进来的会话都有 >=2 条用户消息，三类全 0 在语义上
 * 不可能是真实标注结果，只可能是没打上。
 */
function hasModeLabel(f) {
  const c = f?.collaboration_mode_counts;
  if (!c) return false;
  return COLLAB_MODE.reduce((sum, k) => sum + (Number(c[k]) || 0), 0) > 0;
}

function groupProfile(list) {
  let good = 0, bad = 0, unclear = 0, friction = 0, userActionable = 0;
  for (const f of list) {
    if (GOOD_OUTCOMES.has(f?.outcome)) good++;
    else if (BAD_OUTCOMES.has(f?.outcome)) bad++;
    else unclear++;
    const counts = f?.friction_counts || {};
    const attrs = f?.friction_attribution || {};
    for (const k of FRICTION) {
      // Number() 不能省：这是 export 出去的公共函数，喂进字符串 "3" 时
      // `friction += n` 会走字符串拼接，算出天文数字而不报错。
      const n = Number(counts[k]) || 0;
      if (!n) continue;
      friction += n;
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
    userActionableShare: friction ? userActionable / friction : null,
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
  // 🔴 分组不能用「有 / 无」。多标签稠密计数下，主导模式几乎每个会话都 >=1，
  // 对照组恒空——delegate 那一行会永远停在「样本不足（有 N / 无 0）」，三行表里
  // 只有一行能出数。改为按**该模式在会话内的占比**取中位数分割：占比高的一半
  // vs 低的一半，每个模式都能分出两组，比较的也从「有没有」变成「多还是少」。
  for (const mode of COLLAB_MODE) {
    const withShare = labeled.map((f) => {
      const c = f.collaboration_mode_counts || {};
      const tot = COLLAB_MODE.reduce((s, k) => s + (Number(c[k]) || 0), 0);
      return { f, share: tot ? (Number(c[mode]) || 0) / tot : 0 };
    }).sort((x, y) => x.share - y.share);
    // 不能直接用「> 中位数」切：真实数据里占比高度重复，中位数两侧常有一侧为空。
    // 改为找一个**两侧都够 MIN_GROUP、且分割点两边取值确实不同**的切点；
    // 找不到就说明这个模式在所有会话里占比几乎一样，本来就没有可比的两组。
    let cut = -1;
    for (let i = MIN_GROUP; i <= withShare.length - MIN_GROUP; i++) {
      if (withShare[i].share > withShare[i - 1].share) { cut = i; break; }
    }
    if (cut < 0) {
      out.byMode[mode] = { insufficient: true, reason: 'no_variation', n: withShare.length };
      continue;
    }
    const low = withShare.slice(0, cut).map((x) => x.f);
    const high = withShare.slice(cut).map((x) => x.f);
    const median = withShare[cut].share;
    const a = groupProfile(high), b = groupProfile(low);
    out.byMode[mode] = {
      median,
      high: a, low: b,
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
    // 稠密三值分类不能套 friction/goal 那套噪声门槛（默认 2）：
    // 一个真实出现过 1 次的模式会被整个抹掉，同时把分母也改了。
    collaborationModes: Object.entries(collab.total)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => ({ key: k, count: v, sessions: collab.sessions[k] })),
    collaborationCross: crossCollabOutcome(facets),
    repeatedInstructions: Object.entries(instructions)
      .filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1])
      .map(([text, n]) => ({ text, n })),
  };
}
