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
    if (m.cwd) { const p = m.cwd.split('/').filter(Boolean).pop() || m.cwd; a.projects[p] = (a.projects[p] || 0) + 1; }
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

export function aggregateFacets(facets, { noiseFloor = NOISE_FLOOR } = {}) {
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
  const attribution = sum(ATTRIBUTION, 'friction_attribution');

  const rank = (o) => Object.entries(o.total)
    .filter(([, v]) => v >= noiseFloor)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => ({ key: k, count: v, sessions: o.sessions[k] }));

  const counts = (field) => {
    const c = {};
    for (const f of facets) { const v = f?.[field]; if (v) c[v] = (c[v] || 0) + 1; }
    return c;
  };

  const instructions = {};
  for (const f of facets) for (const s of f?.user_instructions || []) {
    const k = String(s).trim().toLowerCase();
    if (k.length > 6) instructions[k] = (instructions[k] || 0) + 1;
  }

  return {
    n: facets.length,
    friction: rank(friction), goals: rank(goals),
    attribution: attribution.total,
    outcomes: counts('outcome'), sessionTypes: counts('session_type'),
    // 立规候选：重复 >= 3 次才提，对齐「同坑第 N 次才升格」的做法
    ruleCandidates: rank(friction).filter((f) => f.sessions >= RULE_THRESHOLD),
    repeatedInstructions: Object.entries(instructions)
      .filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1])
      .map(([text, n]) => ({ text, n })),
  };
}
