/** 终端 stats：零 LLM、零网络、零额度。第一入口，必须不可能失败。 */
const BAR = '█';
const pad = (s, n) => String(s).padEnd(n);
const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function bars(entries, width = 26, top = 8) {
  const list = entries.slice(0, top);
  if (!list.length) return ['  (无数据)'];
  const max = Math.max(...list.map(([, v]) => v)) || 1;
  const w = Math.max(...list.map(([k]) => String(k).length));
  return list.map(([k, v]) =>
    `  ${pad(k, w)}  ${BAR.repeat(Math.max(1, Math.round((v / max) * width)))} ${num(v)}`);
}

export function renderStats(a, { providers, windowDays, warnings = [] }) {
  const L = [];
  L.push('');
  L.push('  agents-deep-insights · stats');
  L.push(`  近 ${windowDays} 天 · 数据源 ${providers.join(' + ')} · 全部本地计算，未联网`);
  L.push('  ' + '─'.repeat(58));
  L.push('');
  const noise = a.sessions - a.substantive;
  L.push(`  会话 ${num(a.sessions)}（其中 ${num(a.substantive)} 个实质会话）    你的消息 ${num(a.userMessages)}    工具调用 ${num(a.toolCalls)}`);
  const md = a.medianDuration >= 60 ? (a.medianDuration / 60).toFixed(1) + ' 小时' : a.medianDuration + ' 分钟';
  L.push(`  活跃 ${a.daysActive} 天    实质会话时长中位数 ${md}    提交 ${num(a.gitCommits)} 次`);
  if (noise > a.sessions * 0.3) {
    L.push(`  ${num(noise)} 个单轮会话（${(noise / a.sessions * 100).toFixed(0)}%）——多为误开或缓存预热，分析时会被排除`);
  }
  L.push('');
  if (a.toolCalls) {
    const pct = (a.failureRate * 100).toFixed(1);
    const flag = a.failureRate > 0.15 ? '  ← 偏高' : '';
    L.push(`  工具失败率 ${pct}%（${num(a.toolFailures)}/${num(a.toolCalls)}）${flag}`);
  }
  if (a.interruptions) L.push(`  你打断了 ${num(a.interruptions)} 次`);
  if (a.medianGap != null) {
    const g = a.medianGap;
    L.push(`  你的响应中位时长 ${g < 60 ? g.toFixed(0) + ' 秒' : (g / 60).toFixed(1) + ' 分钟'}`);
  }
  L.push('');
  L.push('  最常用的工具');
  L.push(...bars(Object.entries(a.toolCounts).sort((x, y) => y[1] - x[1])));
  const projs = Object.entries(a.projects).sort((x, y) => y[1] - x[1]);
  if (projs.length) { L.push(''); L.push('  最常工作的项目'); L.push(...bars(projs, 26, 6)); }
  const peak = a.hours.indexOf(Math.max(...a.hours));
  if (Math.max(...a.hours) > 0) {
    L.push(''); L.push(`  活跃时段高峰 ${String(peak).padStart(2, '0')}:00`);
    const mx = Math.max(...a.hours);
    L.push('  ' + a.hours.map((h) => ' ▁▂▃▄▅▆▇█'[Math.round((h / mx) * 8)]).join(''));
    L.push('  0' + ' '.repeat(10) + '6' + ' '.repeat(10) + '12' + ' '.repeat(9) + '18' + ' '.repeat(8) + '23');
  }
  if (warnings.length) { L.push(''); for (const w of warnings) L.push(`  ! ${w}`); }
  L.push('');
  L.push('  ' + '─'.repeat(58));
  L.push('  这些是纯统计。要看「哪些摩擦在重复、哪些是你自己能改的」：');
  L.push('    adi run        完整分析（会调用 LLM，消耗你自己的额度）');
  L.push('    adi doctor     环境自检（提 issue 时请附上它的输出）');
  L.push('');
  return L.join('\n');
}
