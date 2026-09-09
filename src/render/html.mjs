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
};
const L = (k) => LABEL[k] || k;

export function renderHtml({ metaAgg, facetAgg, meta }) {
  const total = Object.values(facetAgg.attribution).reduce((a, b) => a + b, 0) || 1;
  const pct = (n) => Math.round((n / total) * 100);
  const bar = (list, max) => list.map((f) => `
      <div class="row"><div class="k">${esc(L(f.key))}</div>
      <div class="t"><i style="width:${Math.max(3, (f.count / max) * 100)}%"></i></div>
      <div class="v">${f.count}<small> · ${f.sessions} 个会话</small></div></div>`).join('');
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
.attr{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
.attr div{border-radius:12px;padding:16px;text-align:center;border:2px solid}
.a0{background:#fbeee9;border-color:#b4553f}.a1{background:#eef1f7;border-color:#7a8db5}.a2{background:#eeebe6;border-color:#a89f92}
.attr b{display:block;font-size:26px}.attr span{font-size:12.5px}
.note{background:#fff;border:1.5px solid #ddd8d0;border-radius:12px;padding:18px 20px;margin:16px 0;font-size:14px}
.warn{background:#fbeee9;border-color:#b4553f}
ul{padding-left:20px;font-size:14px}code{background:#efebe5;padding:1px 6px;border-radius:4px;font-size:13px}
footer{margin-top:56px;padding-top:18px;border-top:2px solid #e2ded7;color:#8a8a8a;font-size:12.5px}
</style></head><body><div class="w">
<h1>你的 AI 编码摩擦报告</h1>
<p class="sub">哪些问题在重复发生，以及其中哪些是你自己能改的。</p>
<p class="meta">${esc(meta.generatedAt)} · 数据源 ${esc(meta.providers.join(' + '))} · 近 ${meta.windowDays} 天 ·
分析了 ${facetAgg.n} 个实质会话（覆盖 ${esc(meta.spanDays)} 天）· 全程本地运行，数据未离开你的机器</p>

<div class="cards">
<div class="card"><b>${metaAgg.sessions}</b><span>总会话</span></div>
<div class="card"><b>${facetAgg.n}</b><span>深度分析</span></div>
<div class="card"><b>${(metaAgg.failureRate * 100).toFixed(1)}%</b><span>工具失败率</span></div>
<div class="card"><b>${metaAgg.gitCommits}</b><span>提交次数</span></div>
</div>

<h2>这些摩擦里，多少是你能改的</h2>
<div class="attr">
<div class="a0"><b>${pct(facetAgg.attribution.user_actionable)}%</b><span>${esc(L('user_actionable'))}</span></div>
<div class="a1"><b>${pct(facetAgg.attribution.agent_capability)}%</b><span>${esc(L('agent_capability'))}</span></div>
<div class="a2"><b>${pct(facetAgg.attribution.environmental)}%</b><span>${esc(L('environmental'))}</span></div>
</div>
<div class="note">只有第一格是你下次能直接改进的。后两格换个提问方式也不会消失——
把注意力放在第一格上，投入产出比最高。</div>

<h2>重复出现的摩擦</h2>
${facetAgg.friction.length ? bar(facetAgg.friction, fmax)
  : '<div class="note">没有任何摩擦重复出现 2 次以上。样本可能偏少。</div>'}

<h2>值得固化成规则的（重复 ≥ 3 个会话）</h2>
${facetAgg.ruleCandidates.length ? `<ul>${facetAgg.ruleCandidates.map((f) =>
  `<li><b>${esc(L(f.key))}</b> — 在 ${f.sessions} 个会话里出现，共 ${f.count} 次。
   建议在 <code>AGENTS.md</code> / <code>CLAUDE.md</code> 里写一条针对它的约束。</li>`).join('')}</ul>`
  : '<div class="note">还没有摩擦重复到 3 个会话以上。门槛设在 3 是为了避免把偶发问题写成规则。</div>'}
${facetAgg.repeatedInstructions.length ? `
<h2>你反复说过的话</h2>
<div class="note">说过两次以上的指令，本身就是最好的规则候选——写进配置文件就不用再说第三次。</div>
<ul>${facetAgg.repeatedInstructions.slice(0, 8).map((i) =>
  `<li>${esc(i.text)} <small>（${i.n} 次）</small></li>`).join('')}</ul>` : ''}

<h2>你主要在做什么</h2>
${facetAgg.goals.length ? bar(facetAgg.goals, gmax) : '<div class="note">样本不足。</div>'}

<div class="note warn"><b>关于这些数字的可信度</b><br>
计数由确定性代码统计，不经过模型。但单会话的打标由 LLM 完成，实测存在 ±1 的边界判断噪声，
因此<b>单条数字不必细究，趋势和排序才是可用的</b>。分类判断（结果、会话类型）在实测中稳定复现。
${meta.repairsCount ? `<br>本次归一化修复了 ${meta.repairsCount} 处模型输出偏差。` : ''}</div>

<footer>agents-deep-insights v${esc(meta.version)} · 本地生成 ·
<a href="https://github.com/gmggyyds/agents-deep-insights">github.com/gmggyyds/agents-deep-insights</a></footer>
</div></body></html>`;
}
