/**
 * L5 报告：模板化生成。
 * 跨会话的汇总、排序与门槛判定由确定性代码完成；单会话的次数与归因是模型判定的。
 * （早期注释写「LLM 不参与计数」，不准确——外部复测指出后已改。）
 */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABEL = {
  misunderstood_request: '误解了你的要求', wrong_approach: '方向走错', buggy_code: '给出的代码有 bug',
  user_rejected_action: '你否决了它的操作', agent_got_blocked: '助手被卡住', user_stopped_early: '你中途叫停',
  wrong_file_or_location: '改错文件或位置', excessive_changes: '改动超出范围', slow_or_verbose: '啰嗦或缓慢',
  tool_failed: '工具执行失败', user_unclear: '你的指令不够清楚', external_issue: '环境或外部服务问题',
  debug_investigate: '排查问题', implement_feature: '实现功能', fix_bug: '修 bug', write_script_tool: '写脚本工具',
  refactor_code: '重构', configure_system: '配置系统', create_pr_commit: '提交与 PR', analyze_data: '数据分析',
  understand_codebase: '理解代码库', write_tests: '写测试', write_docs: '写文档', deploy_infra: '部署运维',
  warmup_minimal: '缓存预热',
  user_actionable: '你自己能改的', agent_capability: '助手能力所限', environmental: '环境或工具问题',
  unknown: '原因未确定',
  delegate: '派活（已知要什么）', deliberate: '想清楚（还没定）', steer: '把关与定规则',
};
const L = (k) => LABEL[k] || k;

/** 英文标签。纯英文模式下图表轴标签不该还是中文——那等于英文版少了一半内容。 */
const LABEL_EN = {
  misunderstood_request: 'Misunderstood the request', wrong_approach: 'Wrong approach',
  buggy_code: 'Buggy code', user_rejected_action: 'You rejected the action',
  agent_got_blocked: 'Agent got blocked', user_stopped_early: 'You stopped it early',
  wrong_file_or_location: 'Wrong file or location', excessive_changes: 'Changes beyond scope',
  slow_or_verbose: 'Slow or verbose', tool_failed: 'Tool execution failed',
  user_unclear: 'Your instruction was unclear', external_issue: 'Environment or external service',
  debug_investigate: 'Debugging', implement_feature: 'Implementing features', fix_bug: 'Fixing bugs',
  write_script_tool: 'Writing scripts/tools', refactor_code: 'Refactoring',
  configure_system: 'System configuration', create_pr_commit: 'Commits and PRs',
  analyze_data: 'Data analysis', understand_codebase: 'Understanding the codebase',
  write_tests: 'Writing tests', write_docs: 'Writing docs', deploy_infra: 'Deploy and ops',
  warmup_minimal: 'Cache warmup',
  user_actionable: 'Yours to fix', agent_capability: 'Model limits',
  environmental: 'Environment or tooling', unknown: 'Cause undetermined',
};
LABEL_EN.delegate = 'Delegate (you knew what you wanted)';
LABEL_EN.deliberate = 'Deliberate (still working it out)';
LABEL_EN.steer = 'Steer (gate and set rules)';
const LE = (k) => LABEL_EN[k] || k;

export function renderHtml({ metaAgg, facetAgg, meta, narrative, narrativeEn }) {
  const N = narrative || null;
  const E = narrativeEn || null;   // 英文叙事；缺省时只出中文，语言开关自动隐藏
  const BI = !!E;
  /**
   * 双语节点：中英各出一份兄弟元素，用 body 上的 class 控制显隐。
   * 不做 JS 文本替换——那样「双语对照」这一态就实现不了，而对照恰恰是最常用的一态。
   */
  const bi = (zh, en, tag = 'p', cls = '') => {
    const z = `<${tag} class="${cls} zh">${esc(zh)}</${tag}>`;
    return BI && en ? z + `<${tag} class="${cls} en">${esc(en)}</${tag}>` : z;
  };
  const biH = (zh, en, tag = 'h2') => bi(zh, en, tag, '');
  const pick = (path, i) => {   // 取英文叙事里对应下标的项，缺了就返回 undefined
    try { return path.split('.').reduce((o, k) => o?.[k], E); } catch { return undefined; }
  };
  const para = (t) => t ? `<p class="nar">${esc(t).replace(/\n/g, '<br>')}</p>` : '';
  const total = Object.values(facetAgg.attribution).reduce((a, b) => a + b, 0) || 1;
  const pct = (n) => Math.round((n / total) * 100);
  const bar = (list, max) => list.map((f) => `
      <div class="row"><div class="k"><span class="zh">${esc(L(f.key))}</span>${BI ? `<span class="en">${esc(LE(f.key))}</span>` : ''}</div>
      <div class="t"><i style="width:${Math.max(3, (f.count / max) * 100)}%"></i></div>
      <div class="v">${f.count}<small><span class="zh"> · ${f.sessions} 个会话</span>${BI ? `<span class="en"> · ${f.sessions} sessions</span>` : ''}</small></div></div>`).join('');
  const fmax = facetAgg.friction[0]?.count || 1;
  const gmax = facetAgg.goals[0]?.count || 1;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>你的 AI 编码摩擦报告</title><style>
*{box-sizing:border-box}body{margin:0;background:#f8f6f3;color:#1a1a1a;line-height:1.7;
font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei',-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif}
.w{max-width:900px;margin:0 auto;padding:44px 24px 72px}
h1{font-size:32px;margin:0 0 8px}h2{font-size:21px;margin:44px 0 14px;padding-left:12px;border-left:4px solid #b4553f}
.sub{color:#6a6a6a;font-size:14px;margin:0 0 6px}.meta{color:#8a8a8a;font-size:12.5px;border-bottom:2px solid #e2ded7;padding-bottom:18px;margin-bottom:8px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.card{background:#fff;border:1.5px solid #ddd8d0;border-radius:12px;padding:16px;text-align:center}
.card b{display:block;font-size:26px;line-height:1.25}.card span{font-size:12.5px;color:#6a6a6a}
.row{display:grid;grid-template-columns:150px 1fr 110px;gap:10px;align-items:center;margin:7px 0;font-size:14px}
.t{background:#eeebe6;border-radius:5px;height:17px;overflow:hidden}.t i{display:block;height:100%;background:#b4553f;border-radius:5px}
.row .v{font-size:13px;color:#4a4a4a}.row small{color:#9a9a9a}
.attr{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.attr div{border-radius:12px;padding:16px;text-align:center;border:2px solid}
.a3{background:#f4f1ec;border-color:#c9c4bc}
.a0{background:#fbeee9;border-color:#b4553f}.a1{background:#eef1f7;border-color:#7a8db5}.a2{background:#eeebe6;border-color:#a89f92}
.attr b{display:block;font-size:26px}.attr span{font-size:12.5px}
.note{background:#fff;border:1.5px solid #ddd8d0;border-radius:12px;padding:18px 20px;margin:16px 0;font-size:14px}
.lead{font-size:19px;line-height:1.6;background:#fff;border-left:5px solid #b4553f;border-radius:0 12px 12px 0;padding:20px 24px;margin:22px 0}
.nar{font-size:15px;line-height:1.85;margin:12px 0 20px}
.blk{background:#fff;border:1.5px solid #ddd8d0;border-radius:12px;padding:18px 22px;margin:14px 0}
.blk h4{margin:0 0 8px;font-size:16px}.blk p{font-size:14.5px;margin:0;color:#3d3d3d}
.blk.mine{border-left:5px solid #b4553f}.blk.mdl{border-left:5px solid #7a8db5}.blk.env{border-left:5px solid #a89f92}
.rule{background:#fff;border:1.5px solid #ddd8d0;border-radius:12px;padding:16px 20px;margin:12px 0;position:relative}
.rule code{display:block;background:#f4f1ec;padding:12px 14px;border-radius:8px;font-size:14px;line-height:1.6;white-space:pre-wrap;margin:0 0 10px}
.rule .why{font-size:13.5px;color:#6a6a6a}
.rule .n{position:absolute;top:14px;right:16px;font-size:12px;color:#8a8a8a;background:#f4f1ec;padding:2px 9px;border-radius:20px}
@media(max-width:820px){.rule .n{position:static;display:inline-block;margin-bottom:8px}.row{grid-template-columns:110px 1fr 88px;font-size:13px}.attr{grid-template-columns:1fr}}
.step{background:#fff;border:1.5px solid #ddd8d0;border-radius:12px;padding:16px 20px;margin:12px 0}
.step h4{margin:0 0 6px;font-size:15.5px}.step p{font-size:14px;color:#3d3d3d;margin:0 0 10px}
.step pre{background:#1c1b19;color:#d4d0c8;padding:12px 14px;border-radius:8px;font-size:13px;line-height:1.55;overflow-x:auto;margin:0;white-space:pre-wrap}
details{margin:18px 0}summary{cursor:pointer;font-size:15px;font-weight:700;padding:10px 0;color:#6a6a6a}
.warn{background:#fbeee9;border-color:#b4553f}
ul{padding-left:20px;font-size:14px}code{background:#efebe5;padding:1px 6px;border-radius:4px;font-size:13px}
footer{margin-top:56px;padding-top:18px;border-top:2px solid #e2ded7;color:#8a8a8a;font-size:12.5px}
/* 双语三态：中文 / 英文 / 对照。默认对照——这份报告同时要给中文使用者和开源读者看 */
body.lang-zh .en{display:none}body.lang-en .zh{display:none}
.note.en code,.rule code.en{display:inline-block}
body.lang-en h2.zh,body.lang-zh h2.en{display:none}
.en{color:#4a4a4a}
/* 双语对照下行内元素会首尾相连（实测 h1 出现「…报告Your AI Coding…」）：
   同一行里的 zh/en 强制换行显示，块级的本来就各占一行不受影响 */
body.lang-both h1 .en,body.lang-both .card .en,body.lang-both .n .en,
body.lang-both .copyall .en,body.lang-both .copy1 .en,body.lang-both .row .k .en,body.lang-both .row .v .en,
body.lang-both .attr .en{display:block}
body.lang-both .n .en,body.lang-both .row .v .en{font-size:.9em;opacity:.75}p.en{font-size:14px;font-style:normal;border-left:2px solid #e2ded7;padding-left:12px;margin-top:-4px}
.en-inline{font-weight:400;color:#8a8a8a;font-size:.9em}
.langbar{display:flex;gap:6px;align-items:center;margin:0 0 18px;flex-wrap:wrap}
/* 400px 下按钮会被挤到逐字断行（实测「中文」竖成了 中/文）：按钮内禁断行，整条允许换行 */
.langbar button,.langbar>span{white-space:nowrap}
.langbar button{border:1.5px solid #ddd8d0;background:#fff;color:#4a4a4a;border-radius:20px;
padding:5px 14px;font-size:12.5px;cursor:pointer;font-family:inherit}
.langbar button.on{background:#b4553f;border-color:#b4553f;color:#fff}
.sub-h{font-size:17px;margin:30px 0 10px;color:#3d3d3d}
.blk h4 .n{float:right;font-size:12px;color:#8a8a8a;background:#f4f1ec;padding:2px 9px;border-radius:20px;font-weight:400}
.blk.good{border-left:5px solid #5d8a66}.blk.theme{border-left:5px solid #7a8db5}.blk.far{border-left:5px solid #a1789b}
.note.posture{background:#f4f1ec;font-size:13px}
.samplewarn{border-width:2px}
.note.cross-thin{border-width:2px}
.card .sub2{display:block;font-size:11px;color:#8a8a8a;margin-top:4px}
table.cross{width:100%;border-collapse:collapse;margin:14px 0;font-size:13.5px;background:#fff;border:1.5px solid #ddd8d0;border-radius:12px;overflow:hidden}
table.cross th{text-align:left;padding:10px 12px;background:#f4f1ec;color:#6a6a6a;font-size:12.5px;font-weight:600}
table.cross td{padding:10px 12px;border-top:1px solid #eeebe6;color:#3d3d3d}
table.cross td em{font-style:normal;color:#b4553f;font-size:12.5px}
table.cross td.ins{color:#8a8a8a}
@media(max-width:820px){table.cross{display:block;overflow-x:auto}}
.rulebar{display:flex;gap:10px;align-items:center;margin:14px 0}
.copyall{background:#b4553f;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13.5px;cursor:pointer;font-family:inherit}
.copy1{background:#f4f1ec;color:#4a4a4a;border:1.5px solid #ddd8d0;border-radius:7px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
.rule .rh{display:block;font-size:15px;margin:0 0 10px;cursor:pointer}
.rule .rh input{margin-right:8px}
.quote{font-size:13px;color:#6a6a6a;border-left:3px solid #ddd8d0;padding:6px 12px;margin:10px 0;background:#faf8f5}
#copystat{font-size:12.5px;color:#5d8a66}
</style></head><body class="lang-both"><div class="w">
<h1><span class="zh">你的 AI 编码摩擦报告</span>${BI ? '<span class="en">Your AI Coding Friction Report</span>' : ''}</h1>
<p class="sub zh">哪些问题在重复发生，以及其中哪些是你自己能改的。</p>
${BI ? '<p class="sub en">Which problems keep recurring, and which of them are yours to fix.</p>' : ''}
${BI ? `<div class="langbar"><span class="quote" style="font-size:12.5px;color:#8a8a8a">语言 / Language</span>
<button onclick="setLang('both',this)" class="on quote">双语对照 / Both</button>
<button onclick="setLang('zh',this)" class="quote">中文</button>
<button onclick="setLang('en',this)" class="quote">English</button></div>` : ''}
<p class="meta zh">${esc(meta.generatedAt)} · 数据源 ${esc(meta.providers.join(' + '))} · ${meta.windowDays > 0 ? `近 ${meta.windowDays} 天` : '全部时间'} ·
深度分析 ${facetAgg.n} 个会话（覆盖 ${esc(meta.spanDays)} 天）· 采集与统计在本地完成，
仅脱敏后的会话片段发送给你自己配置的模型</p>
${BI ? `<p class="meta en">${esc(meta.generatedAt)} · sources ${esc(meta.providers.join(' + '))} · ${meta.windowDays > 0 ? `last ${meta.windowDays} days` : 'all time'} ·
${facetAgg.n} sessions deeply analyzed (spanning ${esc(meta.spanDays)} days) · collection and statistics run locally;
only redacted session excerpts are sent to the model you configured yourself</p>` : ''}

<div class="cards">
${[[metaAgg.sessions, '你参与的会话', 'Your sessions'],
   [facetAgg.n, '深度分析', 'Deeply analyzed'],
   [`${(metaAgg.failureRate * 100).toFixed(1)}%`, '工具失败率', 'Tool failure rate'],
   [metaAgg.gitCommits, '提交次数', 'Commits']].map(([v, zh, en]) =>
`<div class="card"><b>${v}</b><span class="zh">${zh}</span>${BI ? `<span class="en">${en}</span>` : ''}</div>`).join('')}
</div>

${facetAgg.n < 5 ? `
<div class="note warn samplewarn"><b><span class="zh">⚠️ 样本量不足以支持「模式」类结论</span>${BI ? '<span class="en">⚠️ Sample too small to support pattern-level claims</span>' : ''}</b><br>
<span class="zh">这份报告的叙事只基于 <b>${facetAgg.n} 个</b>深度分析会话。
主题聚类、使用姿态、前瞻这几段需要跨会话的重复才成立，${facetAgg.n} 个会话给不出重复。
请把下面的叙事当作<b>对这 ${facetAgg.n} 次会话的描述</b>，不是对你工作方式的判断。<br>
深度分析目前只支持 Codex 会话（Claude Code 的官方记录只有元数据、没有对话正文）。
想扩大样本：<code>adi run --days 0</code> 放宽到全部时间。</span>
${BI ? `<span class="en">The narrative below rests on only <b>${facetAgg.n}</b> deeply analyzed session(s).
Theme clustering, working posture and the horizon section all require repetition across sessions,
which ${facetAgg.n} session(s) cannot provide. Read the narrative as a <b>description of those
${facetAgg.n} session(s)</b>, not as a judgement about how you work.<br>
Deep analysis currently supports Codex sessions only (Claude Code's official records carry
metadata without transcript text). To widen the sample: <code>adi run --days 0</code>.</span>` : ''}</div>` : ''}
${N ? bi(N.headline, E && E.headline, 'div', 'lead') : ''}
${(metaAgg.subagentSessions || metaAgg.failureRateCoverage < 0.95) ? `
<div class="note posture"><b><span class="zh">口径说明</span>${BI ? '<span class="en">How these numbers are counted</span>' : ''}</b><br>
<span class="zh">${metaAgg.subagentSessions ? `另有 ${metaAgg.subagentSessions} 个会话由子代理派生（人未参与），
它们的 ${metaAgg.subagentToolCalls} 次工具调用与 ${metaAgg.subagentUserMessages} 条任务书<b>未计入</b>上面的数字。` : ''}
${metaAgg.failureRateCoverage < 0.95 ? `工具失败率的分母只用能拿到退出码的调用，
覆盖 ${Math.round(metaAgg.failureRateCoverage * 100)}% 的调用；其余拿不到结果，未计入分母也未算作成功。` : ''}</span>
${BI ? `<span class="en">${metaAgg.subagentSessions ? `A further ${metaAgg.subagentSessions} sessions were spawned by
sub-agents with no human in the loop; their ${metaAgg.subagentToolCalls} tool calls and
${metaAgg.subagentUserMessages} task briefs are <b>excluded</b> from the numbers above.` : ''}
${metaAgg.failureRateCoverage < 0.95 ? `The tool failure rate counts only calls that reported an exit code,
covering ${Math.round(metaAgg.failureRateCoverage * 100)}% of calls; the rest are neither counted as failures nor as successes.` : ''}</span>` : ''}</div>` : ''}


${N && N.themes && N.themes.length ? `
${biH('你主要在做什么', 'What You Work On')}
${N.themes.map((t, i) => { const e = (pick('themes') || [])[i]; return `
<div class="blk theme"><h4><span class="zh">${esc(t.name)}</span>${e && BI ? `<span class="en-inline en"> / ${esc(e.name)}</span>` : ''}
<span class="n"><span class="zh">${t.session_estimate} 个会话</span>${BI ? `<span class="en">${t.session_estimate} sessions</span>` : ''}</span></h4>
${bi(t.detail, e && e.detail)}</div>`; }).join('')}` : ''}

${N && N.how_you_work ? `
${biH('你是怎么用它的', 'How You Use Codex')}
${bi(N.how_you_work.summary, pick('how_you_work.summary'), 'div', 'lead')}
<div class="blk"><h4><span class="zh">支撑证据</span> ${BI ? '<span class="en-inline en">/ Evidence</span>' : ''}</h4>
${bi(N.how_you_work.evidence, pick('how_you_work.evidence'))}</div>
<div class="blk"><h4><span class="zh">这意味着什么</span> ${BI ? '<span class="en-inline en">/ What it implies</span>' : ''}</h4>
${bi(N.how_you_work.implication, pick('how_you_work.implication'))}</div>
<div class="note posture"><b><span class="zh">姿态数据</span>${BI ? '<span class="en">Operating posture</span>' : ''}</b><span class="zh">（Codex 独有，Claude Code 的 /insights 没有这些信号）</span>${BI ? '<span class="en"> (Codex-only; Claude Code /insights has no equivalent signal)</span>' : ''}<br>
${(() => { const d = (o) => Object.entries(o || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
  const ap = d(metaAgg.approvalPolicies), sb = d(metaAgg.sandboxPolicies), og = d(metaAgg.originators);
  const zh = `授权策略 ${ap || '未记录'} · 沙箱 ${sb || '未记录'} · 入口 ${og || '未记录'} · ${metaAgg.planSessions || 0}/${metaAgg.postureSessions || 0} 个会话有显式任务分解（分母=带姿态信号的会话）`;
  const en = `approval ${ap || 'not recorded'} · sandbox ${sb || 'not recorded'} · entry ${og || 'not recorded'} · ${metaAgg.planSessions || 0}/${metaAgg.postureSessions || 0} sessions with an explicit task plan`;
  return `<span class="zh">${zh}</span>` + (BI ? `<span class="en">${en}</span>` : ''); })()}</div>` : ''}

${N && N.impressive ? `
${biH('你做得漂亮的地方', 'Impressive Things You Did')}
${bi(N.impressive.summary, pick('impressive.summary'), 'p', 'nar')}
${(N.impressive.items || []).map((i, ix) => { const e = (pick('impressive.items') || [])[ix]; return `
<div class="blk good"><h4><span class="zh">${esc(i.title)}</span>${e && BI ? `<span class="en-inline en"> / ${esc(e.title)}</span>` : ''}</h4>
${bi(i.detail, e && e.detail)}</div>`; }).join('')}` : ''}

${biH('哪里出了问题', 'Where Things Go Wrong')}
${N && N.friction_narrative && N.friction_narrative.summary
  ? bi(N.friction_narrative.summary, pick('friction_narrative.summary'), 'p', 'nar') : ''}
<div class="attr">
${['user_actionable', 'agent_capability', 'environmental', 'unknown'].map((k, i) =>
  (k === 'unknown' && !facetAgg.attribution.unknown) ? '' : `
<div class="a${i}"><b>${pct(facetAgg.attribution[k])}%</b><span class="zh">${esc(L(k))}</span>${BI ? `<span class="en">${esc(LE(k))}</span>` : ''}</div>`).join('')}
</div>
<div class="note zh">只有第一格是你下次能直接改进的。后两格换个提问方式也不会消失——
把注意力放在第一格上，投入产出比最高。</div>
${BI ? `<div class="note en">Only the first bucket is something you can act on next time. The other two
do not disappear by rephrasing your prompts — putting your attention on the first one
has the highest return.</div>` : ''}

${N && N.friction_narrative ? `
<div class="blk mine"><h4><span class="zh">你自己能改的</span> ${BI ? '<span class="en-inline en">/ Yours to fix</span>' : ''}</h4>
${bi(N.friction_narrative.yours_to_fix, pick('friction_narrative.yours_to_fix'))}</div>
<div class="blk mdl"><h4><span class="zh">助手能力所限</span> ${BI ? '<span class="en-inline en">/ Model limits</span>' : ''}</h4>
${bi(N.friction_narrative.model_limits, pick('friction_narrative.model_limits'))}</div>
<div class="blk env"><h4><span class="zh">环境或工具问题</span> ${BI ? '<span class="en-inline en">/ Environment</span>' : ''}</h4>
${bi(N.friction_narrative.environment, pick('friction_narrative.environment'))}</div>` : ''}

<h3 class="sub-h zh">重复出现的摩擦</h3>${BI ? '<h3 class="sub-h en">Recurring friction</h3>' : ''}
${facetAgg.friction.length ? bar(facetAgg.friction, fmax)
  : '<div class="note">没有任何摩擦重复出现 2 次以上。样本可能偏少。</div>'}

${biH('可以直接粘进 AGENTS.md 的规则', 'Suggested AGENTS.md Additions')}
${N && N.rules && N.rules.length ? `
<div class="note zh">勾选你要的，点「复制勾选项」，直接粘进项目根目录的 <code>AGENTS.md</code>。</div>
${BI ? '<div class="note en">Check the ones you want, hit "复制勾选项", and paste them straight into <code>AGENTS.md</code> at your project root.</div>' : ''}
<div class="rulebar"><button class="copyall" onclick="copyChecked()"><span class="zh">复制勾选项</span>${BI ? '<span class="en">Copy checked</span>' : ''}</button>
<span id="copystat"></span></div>
${N.rules.map((r, i) => { const e = (pick('rules') || [])[i]; return `
<div class="rule">${(() => { const c = (facetAgg.ruleCandidates || []).find((x) => x.key === r.friction_key); return c ? `<span class="n"><span class="zh">${c.sessions} 个会话 · ${c.count} 次</span>${BI ? `<span class="en">${c.sessions} sessions · ${c.count}×</span>` : ''}</span>` : ''; })()}
<label class="rh"><input type="checkbox" class="rk" checked data-rule="${esc('## ' + r.heading + '\n- ' + r.rule)}">
<b><span class="zh">${esc(r.heading)}</span></b>${e && BI ? `<span class="en-inline en"> / ${esc(e.heading)}</span>` : ''}</label>
<code class="zh">${esc(r.rule)}</code>${e && BI ? `<code class="en">${esc(e.rule)}</code>` : ''}
${bi(r.why, e && e.why, 'div', 'why')}
${r.evidence_quote ? `<div class="quote">证据：${esc(r.evidence_quote)}</div>` : ''}
<button class="copy1" onclick="copyOne(this)"><span class="zh">复制这条</span>${BI ? '<span class="en">Copy</span>' : ''}</button></div>`; }).join('')}`
  : (facetAgg.ruleCandidates.length ? `<ul>${facetAgg.ruleCandidates.map((f) =>
      `<li><b>${esc(L(f.key))}</b> — 在 ${f.sessions} 个会话里出现，共 ${f.count} 次</li>`).join('')}</ul>`
    : '<div class="note">还没有摩擦重复到 3 个会话以上。门槛设在 3，是为了避免把偶发问题写成规则。</div>')}
${facetAgg.repeatedInstructions.length ? `
<h3 class="sub-h zh">你反复说过的话</h3>${BI ? '<h3 class="sub-h en">What you keep repeating</h3>' : ''}
<div class="note zh">说过两次以上的指令，本身就是最好的规则候选——写进配置文件就不用再说第三次。</div>
${BI ? '<div class="note en">An instruction you have given more than twice is already the best rule candidate — put it in the config file and you never have to say it a third time.</div>' : ''}
<ul>${facetAgg.repeatedInstructions.slice(0, 8).map((i) =>
  `<li class="quote">${esc(i.text)} <small>×${i.n}</small></li>`).join('')}</ul>` : ''}

${N && N.next_steps && N.next_steps.length ? `
${biH('下一步可以试试', 'New Ways to Use Codex')}
<div class="note zh">每条下面的提示词可以直接整段粘进 Codex。</div>
${BI ? '<div class="note en">Each prompt below can be pasted into Codex as-is.</div>' : ''}
${N.next_steps.map((s2, i) => { const e = (pick('next_steps') || [])[i]; return `
<div class="step"><h4><span class="zh">${esc(s2.title)}</span>${e && BI ? `<span class="en-inline en"> / ${esc(e.title)}</span>` : ''}</h4>
${bi(s2.why_for_you, e && e.why_for_you)}
<pre>${esc(s2.copyable_prompt)}</pre>
<button class="copy1" onclick="copyPre(this)"><span class="zh">复制提示词</span>${BI ? '<span class="en">Copy prompt</span>' : ''}</button></div>`; }).join('')}` : ''}

${N && N.horizon ? `
${biH('再往前一步', 'On the Horizon')}
${bi(N.horizon.summary, pick('horizon.summary'), 'div', 'lead')}
${(N.horizon.items || []).map((i, ix) => { const e = (pick('horizon.items') || [])[ix]; return `
<div class="blk far"><h4><span class="zh">${esc(i.title)}</span>${e && BI ? `<span class="en-inline en"> / ${esc(e.title)}</span>` : ''}</h4>
${bi(i.vision, e && e.vision)}</div>`; }).join('')}` : ''}

${(() => {
  const cm = facetAgg.collaborationModes || [];
  // 三类即使全 0 也会各占一行（那是「没打上标」，不是「都是 0」），此时整段不渲染
  if (!cm.length || !cm.some((m) => m.count > 0)) return '';
  const cmax = cm[0]?.count || 1;
  const tot = cm.reduce((a, b) => a + b.count, 0) || 1;
  const X = facetAgg.collaborationCross || {};
  const pctOf = (n) => (n / tot * 100).toFixed(1);
  const share = cm.map((m) => `<div class="card"><b>${pctOf(m.count)}%</b><span class="zh">${esc(L(m.key))}</span>${BI ? `<span class="en">${esc(LE(m.key))}</span>` : ''}<span class="sub2">${m.sessions}/${facetAgg.n} 个会话出现过</span></div>`).join('');
  const num1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—');
  const pct0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');
  const sgn = (v, digits, suffix) => (typeof v === 'number' && Number.isFinite(v)
    ? `${v > 0 ? '+' : ''}${v.toFixed(digits)}${suffix}` : '');
  const rows = Object.entries(X.byMode || {}).map(([mode, d]) => {
    if (!d || d.insufficient) {
      const why = d?.reason === 'no_variation'
        ? '各会话占比几乎一样，切不出可比的两组'
        : `分组后一侧样本不足（${d?.high ?? 0} / ${d?.low ?? 0}）`;
      return `<tr><td>${esc(L(mode))}</td><td colspan="3" class="ins">${why}，不下结论</td></tr>`;
    }
    const hi = d.high || {}, lo = d.low || {};
    const sd = sgn((d.successRateDelta ?? NaN) * 100, 0, 'pp');
    return `<tr><td>${esc(L(mode))}</td>
      <td>${hi.n ?? 0} / ${lo.n ?? 0}</td>
      <td>${pct0(hi.successRate)} vs ${pct0(lo.successRate)}${sd ? ` <em>${sd}</em>` : ''}</td>
      <td>${num1(hi.frictionPerSession)} vs ${num1(lo.frictionPerSession)} <em>${sgn(d.frictionDelta, 1, '')}</em></td></tr>`;
  }).join('');
  return `
${biH('你在要求 AI 做什么', 'What You Are Asking For')}
${bi('把你发出的每一条消息按「在要求什么」分三类：派活＝Working、想清楚＝Thinking、把关＝Oversight，就是课上讲的那三个词。一条消息常常同时要求好几件事——「你先去找，给我参考，我再纠正你」三类都算，会同时计入三类。下面的百分比是三类标签各占多少（合计 100%），卡片下方另给出每类在多少个会话里出现过。这里量的是注意力分布，不是水平高低。',
     'Every message you sent, classified by what it asks for: delegate = Working, deliberate = Thinking, steer = Oversight — the same three words used in the talk. One message often asks for several things at once and is counted under each. The percentages are the share of each label among all labels (they sum to 100%); under each card is how many sessions that mode appeared in. This describes where your attention went, not how good you are.')}
<div class="note posture">${bi('这个百分比按「消息条数」算，不按时间或心力算。一条「帮我想清楚这事该不该做」你可能想了半小时，一条「继续」只要一秒，在这里都算 1 条——所以条数占比天然低估「想清楚」。看到「想清楚 7%」不等于「我只有 7% 的精力在思考」。如果你听过「我九成时间在想」这类说法，那描述的是心力重心，和条数占比不是同一个口径，两个数不能直接比大小。',
     'This percentage counts messages, not the time or thought behind them. "Help me work out whether this is worth doing" may have cost you half an hour; "continue" costs a second — both count as one message here, so a message-count share structurally understates deliberation. Seeing "deliberate 7%" does not mean only 7% of your thinking went into thinking. If you have heard someone say "I spend ninety percent of my time thinking", that describes where their effort sits — a different measure, not comparable to this one.')}
<br>${bi('这几个占比不是分数。同一个人在不同月份差别很大：实测同一使用者相隔三个月的三类占比从 6.3/75.8/17.9 变成 7.2/78.6/14.2，主要由那段时间在干什么类型的活决定，不是能力变化。要比就比同一个人、同一个口径、不同时间的两次统计。',
     'These shares are not a score. The same person can differ a lot month to month: measured three months apart, the three shares moved from 6.3/75.8/17.9 to 7.2/78.6/14.2, driven mainly by what kind of work that period contained. Compare the same person, same measure, at two points in time.')}</div>
<div class="cards">${share}</div>
${X.insufficient ? '<div class="note cross-thin">已打标会话不足，无法做交叉分析。</div>' : `
${bi('这三类跟结果有没有关系', 'Does any of this relate to how sessions turn out')}
${bi('按每个会话里该模式所占的比例，把会话切成「占比高的一半」和「占比低的一半」再比。不用「有没有」分组——多标签下派活几乎每个会话都有，那样分对照组恒空，那一行就永远出不了结论。',
     'Sessions are split by how large a share that mode takes within each session: the higher-share half versus the lower-share half. Not "has it / does not" — under multi-label counting the dominant mode appears in almost every session, which would leave the control group empty and that row permanently inconclusive.')}
<table class="cross"><thead><tr><th>模式</th><th>占比高 / 低（会话数）</th><th>成功率（高 vs 低）</th><th>每会话摩擦数</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="note posture"><b>怎么读这张表：</b>它是<b>相关性，不是因果</b>。简单任务天然既不需要「想清楚」又天然容易成功，这一条就足以把关系拉成反向。
成功率的分母只用能判定的会话（结果说不清的单列，不塞进任何一边）。
任一组少于 5 个会话时直接标「样本不足」，不给百分比——小样本的差异没有意义。
</div>`}
`;
})()}

<details><summary><span class="zh">展开：支撑这些结论的原始统计</span>${BI ? '<span class="en">Expand: the raw statistics behind these conclusions</span>' : ''}</summary>
<h3 class="zh" style="font-size:17px;margin:18px 0 10px">你主要在做什么</h3>${BI ? '<h3 class="en" style="font-size:17px;margin:18px 0 10px">What you work on</h3>' : ''}
${facetAgg.goals.length ? bar(facetAgg.goals, gmax) : '<div class="note">样本不足。</div>'}
<h3 class="zh" style="font-size:17px;margin:22px 0 10px">会话结果分布</h3>${BI ? '<h3 class="en" style="font-size:17px;margin:22px 0 10px">Outcome distribution</h3>' : ''}
<div class="note">${Object.entries(facetAgg.outcomes).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') || '无'}</div>
</details>

<div class="note warn"><b><span class="zh">关于这些数字的可信度</span>${BI ? '<span class="en">How much to trust these numbers</span>' : ''}</b><br>
<span class="zh">顶部四个数字取自全部会话；摩擦与归因取自深度分析的那部分样本，两者范围不同。
每个会话的摩擦次数与归因<b>由模型判定</b>；跨会话的汇总、排序、门槛判定由确定性代码完成，
代码不对模型的判断做二次修改。所以「次数」是模型输出的加总，不是独立测量值。
原因未确定的摩擦单独计入「原因未确定」，不并入环境类。
工具失败按 shell 退出码判定，不按输出里是否出现 error 字样——后者会把搜索命中的源代码算成失败。
报告只记录可观察到的用户反应（纠正、改向、明确认可等），<b>不推断满意度</b>：
纠正是正常的迭代协作，不等于不满；沉默可能是认可，也可能是放弃。
一次外层工具调用不等于一次实际操作（一个逻辑动作可能拆成多次调用）。
超长会话在送入模型前每条消息保留首尾、省略中段，因此极长消息的中间内容可能未被覆盖。
实测单会话打标存在 ±1 的边界判断噪声，因此<b>单条数字不必细究，趋势和排序才是可用的</b>。
${meta.repairsCount ? `本次归一化修复了 ${meta.repairsCount} 处模型输出偏差。` : ''}</span>
${BI ? `<span class="en">The four numbers at the top cover all sessions; friction and attribution come only
from the deeply analyzed subset — different scopes. Per-session friction counts and attribution are
<b>judged by the model</b>; the cross-session aggregation, ranking and thresholds are computed by
deterministic code that never revises the model's judgement. So a "count" is a sum of model outputs,
not an independent measurement.
Friction with no stated cause is listed separately as "cause undetermined" and is never folded into
the environment bucket.
Tool failures are determined by shell exit code, not by whether the word "error" appears in the output —
the latter counts source code found by a search as a failure.
The report records only observable user actions (corrections, redirections, explicit approval);
it does <b>not infer satisfaction</b>: a correction is normal iterative collaboration, not displeasure,
and silence may mean approval or may mean giving up.
One outer tool call is not one real operation — a single logical action may be split across several calls.
In long sessions each message keeps its head and tail with the middle elided, so the middle of very long
messages may not be covered.
Measured labelling noise is about ±1 per session, so <b>individual numbers are not worth scrutinising;
the trend and the ranking are</b>.
${meta.repairsCount ? `Normalisation repaired ${meta.repairsCount} model output deviations in this run.` : ''}</span>` : ''}</div>

${meta.artifactsDir ? `
<h2 class=" zh">如何核对这份结论</h2>${BI ? '<h2 class=" en">How to verify these conclusions</h2>' : ''}
<div class="note"><span class="zh">这份报告的每个数字都能自己复核。中间产物落在报告同级目录
<code>${esc(meta.artifactsDir)}/</code>：<br>
· <code>aggregate.json</code> — 全部聚合数字（顶部卡片、柱状图、归因比例的来源）<br>
· <code>facets.json</code> — 逐会话的模型打标原始输出，没有二次加工<br>
· <code>sample-index.json</code> — 进入深度分析的是哪些会话，各自的消息数与工具成败<br>
· <code>narrative.json</code> — 中英叙事的原始 JSON<br>
· <code>run.json</code> — 时间窗、候选数、采样额度、立规门槛、归一化修复数<br>
判据不一致时以 <code>aggregate.json</code> 为准——报告里的数字都由它渲染，
叙事部分则可能带模型的解释成分。</span>
${BI ? `<span class="en">Every number here can be checked. The intermediate artifacts are written next to
this report in <code>${esc(meta.artifactsDir)}/</code>:<br>
· <code>aggregate.json</code> — all aggregated figures (the source of the cards, bars and attribution split)<br>
· <code>facets.json</code> — the raw per-session model labels, unprocessed<br>
· <code>sample-index.json</code> — which sessions entered deep analysis, with their message and tool-outcome counts<br>
· <code>narrative.json</code> — the raw narrative JSON, both languages<br>
· <code>run.json</code> — time window, candidate pool, sampling quota, rule threshold, normalisation repairs<br>
Where they disagree, <code>aggregate.json</code> wins — the report's numbers are rendered from it,
whereas the narrative may carry the model's interpretation.</span>` : ''}</div>` : ''}

<footer>agents-deep-insights v${esc(meta.version)} · <span class="zh">本地生成</span>${BI ? '<span class="en">generated locally</span>' : ''} ·
<a href="https://github.com/gmggyyds/agents-deep-insights">github.com/gmggyyds/agents-deep-insights</a></footer>
</div>
<script>
function setLang(l, btn){
  document.body.className = 'lang-' + l;
  document.querySelectorAll('.langbar button').forEach(function(b){ b.classList.remove('on'); });
  btn.classList.add('on');
}
function flash(el, msg){ var t = el.textContent; el.textContent = msg;
  setTimeout(function(){ el.textContent = t; }, 1400); }
function write(text, el, msg){
  // navigator.clipboard 在 file:// 下部分浏览器不可用，回退到 textarea + execCommand
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(function(){ flash(el, msg); },
      function(){ fallback(text, el, msg); });
  } else { fallback(text, el, msg); }
}
function fallback(text, el, msg){
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); flash(el, msg); }
  catch (e) { flash(el, '复制失败，请手动选取'); }
  document.body.removeChild(ta);
}
function copyOne(btn){ write(btn.closest('.rule').querySelector('.rk').dataset.rule, btn, '已复制'); }
function copyPre(btn){ write(btn.closest('.step').querySelector('pre').textContent, btn, '已复制'); }
function copyChecked(){
  var picked = [].slice.call(document.querySelectorAll('.rk:checked'))
    .map(function(c){ return c.dataset.rule; });
  var stat = document.getElementById('copystat');
  if (!picked.length) { stat.textContent = '一条都没勾'; setTimeout(function(){ stat.textContent=''; }, 1400); return; }
  write(picked.join('\n\n'), stat, '已复制 ' + picked.length + ' 条');
}
</script>
</body></html>`;
}
