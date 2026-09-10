/**
 * L2 分层采样。纯代码，零 LLM。
 *
 * 为什么不是「取最近 N 个」：官方 /insights 就是那么做的，结果在重度用户身上
 * 时间窗塌缩——本机实测 394 个会话里只覆盖到最近 17 天，而非宣称的 30 天。
 * 越是高频使用者，报告越只反映最近几天，早期反复出现的摩擦永远采不到。
 */

/** substantive 门槛：滤掉单轮噪声会话。实测 394 个里 334 个是 umsg=1 的噪声。 */
/**
 * 子代理派生的会话：控制器把任务书发给它，人全程没参与。
 *
 * 实测本机 34 条里 17 条（50%）是这种，它们贡献了 42% 的工具调用，
 * 而它们的「用户消息」其实是控制器写的任务书（"你是 Amazon 政策研究 agent。任务：…"）。
 * 全部混进「你与 agent 的协作」统计，会把总会话数、用户消息数、工具调用数一起抬高。
 *
 * 外部使用者跑 v0.4.0 时被迫自己做输入过滤（「不含自动唤醒和系统注入」），
 * 就是因为这一层没做。默认排除，但**单列报出**——静默丢弃比混进去更糟。
 */
export function isSubagent(m) {
  return !!m && m.source === 'subagent';
}

export function isSubstantive(m, { includeSubagents = false } = {}) {
  if (!m) return false;
  if (!includeSubagents && isSubagent(m)) return false;
  return m.userMessages >= 2 && (m.durationMinutes ?? 0) >= 1;
}

function isoWeek(ts) {
  const d = new Date(ts);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 864e5 + 1) / 7)).padStart(2, '0')}`;
}

/**
 * 按 ISO 周分桶，桶内按 userMessages 降序取名额；
 * 不足名额的桶把余额按候选数比例还给其他桶，保证取满 quota。
 */
export function stratifiedSample(metas, quota = 50) {
  const pool = metas.filter(isSubstantive);
  if (pool.length <= quota) return { picked: pool, buckets: bucketStats(pool), truncated: false };

  const buckets = new Map();
  for (const m of pool) {
    const k = m.startedAt ? isoWeek(m.startedAt) : 'unknown';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(m);
  }
  for (const arr of buckets.values()) arr.sort((a, b) => b.userMessages - a.userMessages);

  const keys = [...buckets.keys()].sort();
  const alloc = new Map(keys.map((k) => [k, 0]));
  let remaining = quota;
  // 多轮分配：每轮把剩余名额均分给还有候选的桶，直到分完
  while (remaining > 0) {
    const open = keys.filter((k) => alloc.get(k) < buckets.get(k).length);
    if (!open.length) break;
    const per = Math.max(1, Math.floor(remaining / open.length));
    let progressed = false;
    for (const k of open) {
      if (remaining <= 0) break;
      const room = buckets.get(k).length - alloc.get(k);
      const take = Math.min(per, room, remaining);
      if (take > 0) { alloc.set(k, alloc.get(k) + take); remaining -= take; progressed = true; }
    }
    if (!progressed) break;
  }
  const picked = keys.flatMap((k) => buckets.get(k).slice(0, alloc.get(k)));
  return { picked, buckets: bucketStats(picked), truncated: true };
}

function bucketStats(list) {
  const b = {};
  for (const m of list) {
    const k = m.startedAt ? isoWeek(m.startedAt) : 'unknown';
    b[k] = (b[k] || 0) + 1;
  }
  return b;
}
