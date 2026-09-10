/** L5 报告：模板化生成。数字全部来自 L4 的确定性聚合，LLM 不参与计数。 */
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
.en{color:#4a4a4a}p.en{font-size:14px;font-style:normal;border-left:2px solid #e2ded7;padding-left:12px;margin-top:-4px}
.en-inline{font-weight:400;color:#8a8a8a;font-size:.9em}
.langbar{display:flex;gap:6px;align-items:center;margin:0 0 18px}
.langbar button{border:1.5px solid #ddd8d0;background:#fff;color:#4a4a4a;border-radius:20px;
padding:5px 14px;font-size:12.5px;cursor:pointer;font-family:inherit}
.langbar button.on{background:#b4553f;border-color:#b4553f;color:#fff}
.sub-h{font-size:17px;margin:30px 0 10px;color:#3d3d3d}
.blk h4 .n{float:right;font-size:12px;color:#8a8a8a;background:#f4f1ec;padding:2px 9px;border-radius:20px;font-weight:400}
.blk.good{border-left:5px solid #5d8a66}.blk.theme{border-left:5px solid #7a8db5}.blk.far{border-left:5px solid #a1789b}
.note.posture{background:#f4f1ec;font-size:13px}
.rulebar{display:flex;gap:10px;align-items:center;margin:14px 0}
.copyall{background:#b4553f;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13.5px;cursor:pointer;font-family:inherit}
.copy1{background:#f4f1ec;color:#4a4a4a;border:1.5px solid #ddd8d0;border-radius:7px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit}
.rule .rh{display:block;font-size:15px;margin:0 0 10px;cursor:pointer}
.rule .rh input{margin-right:8px}
.quote{font-size:13px;color:#6a6a6a;border-left:3px solid #ddd8d0;padding:6px 12px;margin:10px 0;background:#faf8f5}
#copystat{font-size:12.5px;color:#5d8a66}
</style></head><body class="lang-both"><div class="w">
<h1>你的 AI 编码摩擦报告</h1>
<p class="sub zh">哪些问题在重复发生，以及其中哪些是你自己能改的。</p>
${BI ? '<p class="sub en">Which problems keep recurring, and which of them are yours to fix.</p>' : ''}
${BI ? `<div class="langbar"><span style="font-size:12.5px;color:#8a8a8a">语言</span>
<button onclick="setLang('both',this)" class="on">双语对照</button>
<button onclick="setLang('zh',this)">中文</button>
<button onclick="setLang('en',this)">English</button></div>` : ''}
<p class="meta zh">${esc(meta.generatedAt)} · 数据源 ${esc(meta.providers.join(' + '))} · ${meta.windowDays > 0 ? `近 ${meta.windowDays} 天` : '全部时间'} ·
深度分析 ${facetAgg.n} 个会话（覆盖 ${esc(meta.spanDays)} 天）· 采集与统计在本地完成，
仅脱敏后的会话片段发送给你自己配置的模型</p>
${BI ? `<p class="meta en">${esc(meta.generatedAt)} · sources ${esc(meta.providers.join(' + '))} · ${meta.windowDays > 0 ? `last ${meta.windowDays} days` : 'all time'} ·
${facetAgg.n} sessions deeply analyzed (spanning ${esc(meta.spanDays)} days) · collection and statistics run locally;
only redacted session excerpts are sent to the model you configured yourself</p>` : ''}

<div class="cards">
${[[metaAgg.sessions, '总会话', 'Sessions'],
   [facetAgg.n, '深度分析', 'Deeply analyzed'],
   [`${(metaAgg.failureRate * 100).toFixed(1)}%`, '工具失败率', 'Tool failure rate'],
   [metaAgg.gitCommits, '提交次数', 'Commits']].map(([v, zh, en]) =>
`<div class="card"><b>${v}</b><span class="zh">${zh}</span>${BI ? `<span class="en">${en}</span>` : ''}</div>`).join('')}
</div>

${N ? bi(N.headline, E && E.headline, 'div', 'lead') : ''}

${N && N.themes && N.themes.length ? `
${biH('你主要在做什么', 'What You Work On')}
${N.themes.map((t, i) => { const e = (pick('themes') || [])[i]; return `
<div class="blk theme"><h4>${esc(t.name)}${e && BI ? `${BI ? '<span class="en-inline en"> / ${esc(e.name)}</span>' : ''}` : ''}
<span class="n"><span class="zh">${t.session_estimate} 个会话</span>${BI ? `<span class="en">${t.session_estimate} sessions</span>` : ''}</span></h4>
${bi(t.detail, e && e.detail)}</div>`; }).join('')}` : ''}

${N && N.how_you_work ? `
${biH('你是怎么用它的', 'How You Use Codex')}
${bi(N.how_you_work.summary, pick('how_you_work.summary'), 'div', 'lead')}
<div class="blk"><h4>支撑证据 ${BI ? '<span class="en-inline en">/ Evidence</span>' : ''}</h4>
${bi(N.how_you_work.evidence, pick('how_you_work.evidence'))}</div>
<div class="blk"><h4>这意味着什么 ${BI ? '<span class="en-inline en">/ What it implies</span>' : ''}</h4>
${bi(N.how_you_work.implication, pick('how_you_work.implication'))}</div>
<div class="note posture"><b>姿态数据</b>（Codex 独有，Claude Code 的 /insights 没有这些信号）<br>
授权策略 ${Object.entries(metaAgg.approvalPolicies || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || '未记录'} ·
沙箱 ${Object.entries(metaAgg.sandboxPolicies || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || '未记录'} ·
入口 ${Object.entries(metaAgg.originators || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || '未记录'} ·
${metaAgg.planSessions || 0}/${metaAgg.sessions} 个会话有显式任务分解</div>` : ''}

${N && N.impressive ? `
${biH('你做得漂亮的地方', 'Impressive Things You Did')}
${bi(N.impressive.summary, pick('impressive.summary'), 'p', 'nar')}
${(N.impressive.items || []).map((i, ix) => { const e = (pick('impressive.items') || [])[ix]; return `
<div class="blk good"><h4>${esc(i.title)}${e && BI ? `${BI ? '<span class="en-inline en"> / ${esc(e.title)}</span>' : ''}` : ''}</h4>
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
<div class="blk mine"><h4>你自己能改的 ${BI ? '<span class="en-inline en">/ Yours to fix</span>' : ''}</h4>
${bi(N.friction_narrative.yours_to_fix, pick('friction_narrative.yours_to_fix'))}</div>
<div class="blk mdl"><h4>助手能力所限 ${BI ? '<span class="en-inline en">/ Model limits</span>' : ''}</h4>
${bi(N.friction_narrative.model_limits, pick('friction_narrative.model_limits'))}</div>
<div class="blk env"><h4>环境或工具问题 ${BI ? '<span class="en-inline en">/ Environment</span>' : ''}</h4>
${bi(N.friction_narrative.environment, pick('friction_narrative.environment'))}</div>` : ''}

<h3 class="sub-h">重复出现的摩擦</h3>
${facetAgg.friction.length ? bar(facetAgg.friction, fmax)
  : '<div class="note">没有任何摩擦重复出现 2 次以上。样本可能偏少。</div>'}

${biH('可以直接粘进 AGENTS.md 的规则', 'Suggested AGENTS.md Additions')}
${N && N.rules && N.rules.length ? `
<div class="note zh">勾选你要的，点「复制勾选项」，直接粘进项目根目录的 <code>AGENTS.md</code>。</div>
${BI ? '<div class="note en">Check the ones you want, hit "复制勾选项", and paste them straight into <code>AGENTS.md</code> at your project root.</div>' : ''}
<div class="rulebar"><button class="copyall" onclick="copyChecked()">复制勾选项</button>
<span id="copystat"></span></div>
${N.rules.map((r, i) => { const e = (pick('rules') || [])[i]; return `
<div class="rule"><span class="n"><span class="zh">${r.evidence_count} 个会话</span>${BI ? `<span class="en">${r.evidence_count} sessions</span>` : ''}</span>
<label class="rh"><input type="checkbox" class="rk" checked data-rule="${esc('## ' + r.heading + '\n- ' + r.rule)}">
<b>${esc(r.heading)}</b>${e && BI ? `${BI ? '<span class="en-inline en"> / ${esc(e.heading)}</span>' : ''}` : ''}</label>
<code class="zh">${esc(r.rule)}</code>${e && BI ? `<code class="en">${esc(e.rule)}</code>` : ''}
${bi(r.why, e && e.why, 'div', 'why')}
${r.evidence_quote ? `<div class="quote">证据：${esc(r.evidence_quote)}</div>` : ''}
<button class="copy1" onclick="copyOne(this)">复制这条</button></div>`; }).join('')}`
  : (facetAgg.ruleCandidates.length ? `<ul>${facetAgg.ruleCandidates.map((f) =>
      `<li><b>${esc(L(f.key))}</b> — 在 ${f.sessions} 个会话里出现，共 ${f.count} 次</li>`).join('')}</ul>`
    : '<div class="note">还没有摩擦重复到 3 个会话以上。门槛设在 3，是为了避免把偶发问题写成规则。</div>')}
${facetAgg.repeatedInstructions.length ? `
<h3 class="sub-h">你反复说过的话</h3>
<div class="note zh">说过两次以上的指令，本身就是最好的规则候选——写进配置文件就不用再说第三次。</div>
${BI ? '<div class="note en">An instruction you have given more than twice is already the best rule candidate — put it in the config file and you never have to say it a third time.</div>' : ''}
<ul>${facetAgg.repeatedInstructions.slice(0, 8).map((i) =>
  `<li>${esc(i.text)} <small>（${i.n} 次）</small></li>`).join('')}</ul>` : ''}

${N && N.next_steps && N.next_steps.length ? `
${biH('下一步可以试试', 'New Ways to Use Codex')}
<div class="note zh">每条下面的提示词可以直接整段粘进 Codex。</div>
${BI ? '<div class="note en">Each prompt below can be pasted into Codex as-is.</div>' : ''}
${N.next_steps.map((s2, i) => { const e = (pick('next_steps') || [])[i]; return `
<div class="step"><h4>${esc(s2.title)}${e && BI ? `${BI ? '<span class="en-inline en"> / ${esc(e.title)}</span>' : ''}` : ''}</h4>
${bi(s2.why_for_you, e && e.why_for_you)}
<pre>${esc(s2.copyable_prompt)}</pre>
<button class="copy1" onclick="copyPre(this)">复制提示词</button></div>`; }).join('')}` : ''}

${N && N.horizon ? `
${biH('再往前一步', 'On the Horizon')}
${bi(N.horizon.summary, pick('horizon.summary'), 'div', 'lead')}
${(N.horizon.items || []).map((i, ix) => { const e = (pick('horizon.items') || [])[ix]; return `
<div class="blk far"><h4>${esc(i.title)}${e && BI ? `${BI ? '<span class="en-inline en"> / ${esc(e.title)}</span>' : ''}` : ''}</h4>
${bi(i.vision, e && e.vision)}</div>`; }).join('')}` : ''}

<details><summary>展开：支撑这些结论的原始统计</summary>
<h3 style="font-size:17px;margin:18px 0 10px">你主要在做什么</h3>
${facetAgg.goals.length ? bar(facetAgg.goals, gmax) : '<div class="note">样本不足。</div>'}
<h3 style="font-size:17px;margin:22px 0 10px">会话结果分布</h3>
<div class="note">${Object.entries(facetAgg.outcomes).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') || '无'}</div>
</details>

<div class="note warn"><b>关于这些数字的可信度</b><br>
顶部四个数字取自全部会话；摩擦与归因取自深度分析的那部分样本，两者范围不同。
每个会话的摩擦次数与归因**由模型判定**；跨会话的汇总、排序、门槛判定由确定性代码完成，
代码不对模型的判断做二次修改。所以「次数」是模型输出的加总，不是独立测量值。
原因未确定的摩擦单独计入「原因未确定」，不并入环境类。
超长会话在送入模型前会保留首尾、省略中段，因此极长会话的中间过程可能未被覆盖。
实测单会话打标存在 ±1 的边界判断噪声，
因此<b>单条数字不必细究，趋势和排序才是可用的</b>。分类判断（结果、会话类型）在实测中稳定复现。
${meta.repairsCount ? `<br>本次归一化修复了 ${meta.repairsCount} 处模型输出偏差。` : ''}</div>

<footer>agents-deep-insights v${esc(meta.version)} · 本地生成 ·
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
