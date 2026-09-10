/**
 * 截断预算的共用实现。
 *
 * 管线里有三处要在有限字符里塞下多条内容（单条消息 / 单会话 transcript / 合成层证据）。
 * 三处曾各写各的，形状不一致，于是同一类「结尾被切掉」的问题被外部测试连着抓到两轮。
 * 现在统一成一种形状：**按条均分预算，每条各自保首尾**。
 *
 * 为什么不是对拼接后的整段做首尾保留：那样丢掉的是「中间那些完整的条目」——
 * 一条中段确认要么全在、要么全不在。按条均分则每条的开头和结尾都留得住，
 * 丢的是每条内部的中段。同样的预算，后者让每一条都留下痕迹。
 */

/**
 * 最大最小公平分配（water-filling）。
 *
 * 反复迭代：算出人均份额，凡是「需求低于人均」的条目全额满足并退出分配池，
 * 把它省下的额度摊回给剩下的条目，直到剩下的需求都高于人均——这些平分剩余。
 *
 * 为什么不是「先给保底再按比例」：保底额一旦发给用不完的短条目就收不回来。
 * 实测 561 条消息、24,000 预算时，那种做法白扔了 27% 的额度，
 * 长消息反而更早被砍到只剩几十字。
 */
export function splitBudget(lens, total) {
  const n = lens.length;
  if (!n) return [];
  const out = new Array(n).fill(0);
  const idx = lens.map((l, i) => i).sort((a, b) => lens[a] - lens[b]);
  let left = total, rest = n;
  for (const i of idx) {
    const share = Math.floor(left / rest);
    if (lens[i] <= share) { out[i] = lens[i]; left -= lens[i]; }
    else { out[i] = share; left -= share; }
    rest--;
  }
  return out;
}

/** 保首尾的截断。结尾往往是验收边界与限制说明，比中段值钱。 */
export function clipHeadTail(t, max, { headRatio = 0.62, note = (n) => ` …[略${n}字]… ` } = {}) {
  if (t.length <= max) return t;
  const marker = note(t.length - max);
  const room = max - marker.length;
  if (room <= 0) return t.slice(0, max);
  const head = Math.floor(room * headRatio);
  return t.slice(0, head) + marker + t.slice(-(room - head));
}
