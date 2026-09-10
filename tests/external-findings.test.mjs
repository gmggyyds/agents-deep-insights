/**
 * 外部测试发现的问题，逐条固化为回归用例。
 * 来源：2026-09-09 两位外部测试者在 macOS(codex 0.153.4) 与 Windows 上的实测反馈。
 * 这些问题作者本机全部测不出来——版本不同、平台不同、或功能承诺了却没实现。
 */
import { test } from 'node:test';
import { compactTranscript } from '../src/pipeline/label.mjs';
import { readFileSync as _rf, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseClaudeCode } from '../src/providers/claude-code.mjs';
import { classifyOutcome } from '../src/providers/codex.mjs';
const FACET_SRC = _rf(new URL('../src/schema/facet.mjs', import.meta.url), 'utf8');
const LABEL_SRC = _rf(new URL('../src/pipeline/label.mjs', import.meta.url), 'utf8');
const mkMeta = () => ({ toolFailures: 0, toolOutcomesKnown: 0, toolStillRunning: 0, toolOutcomeUnknown: 0 });
import { version } from '../src/version.mjs';
import { readTranscript, transcriptIndex, classifyToolResult } from '../src/providers/cc-transcript.mjs';
import { renderHtml } from '../src/render/html.mjs';
import { SYNTHESIS_SCHEMA } from '../src/pipeline/synthesize.mjs';
import { splitBudget } from '../src/budget.mjs';
import assert from 'node:assert/strict';
import { redact, auditRedaction } from '../src/redact.mjs';
import { aggregateFacets, aggregateMetas } from '../src/pipeline/aggregate.mjs';

test('脱敏：JSON/YAML 凭证字段（此前完全漏掉，audit 也假绿）', () => {
  const cases = [
    '{"app_secret": "DemoOnlyFakeSecret1234567890"}',
    '{"access_token":"DemoOnlyFakeToken0987654321"}',
    '{"password": "DemoOnlyPass123456"}',
    "api_key = 'DemoOnlyKeyAbcdef123456'",
    'token: DemoOnly1234567890',
    'secret=DemoOnlySecretValue123',
  ];
  for (const c of cases) {
    const out = redact(c);
    assert.notEqual(out, c, `未脱敏: ${c}`);
    assert.equal(auditRedaction(out).length, 0, `audit 仍报残留: ${out}`);
  }
});

test('脱敏：Authorization 头', () => {
  for (const c of ['Authorization: Bearer DemoOnly1234567890',
                   'Proxy-Authorization: Basic DemoOnlyBasic123456']) {
    const out = redact(c);
    assert.ok(out.includes('<REDACTED>'), `未脱敏: ${c} -> ${out}`);
    assert.equal(auditRedaction(out).length, 0);
  }
});

test('脱敏：audit 探针必须与规则一一对应（探针漏的形态会假绿）', () => {
  // 未脱敏的原文，audit 必须能报出来
  for (const c of ['{"access_token":"DemoOnlyFakeToken0987654321"}',
                   'Authorization: Bearer DemoOnly1234567890']) {
    assert.ok(auditRedaction(c).length > 0, `audit 漏检: ${c}`);
  }
});

test('脱敏不误伤正常技术文本', () => {
  for (const c of ['把 lx_orders 的 purchase_date 按 PT 时区聚合，然后跑 npm test',
                   '会话数 394，facet 54 份',
                   'the auth token is stored elsewhere']) {
    assert.equal(redact(c), c, `误伤: ${c}`);
  }
});

test('规则候选必须按摩擦类别匹配归因，不能用会话级全局开关', () => {
  const env = (n) => Array.from({ length: n }, () => ({
    friction_counts: { tool_failed: 1 },
    friction_attribution: { tool_failed: 'environmental' },
  }));

  assert.deepEqual(aggregateFacets(env(3)).ruleCandidates, [],
    '纯环境故障不该产出规则候选——写成规则也改不掉');

  // 外部复测打穿旧实现的反例：3 条纯环境 + 1 条**无关的** user_actionable。
  // 旧实现是全局开关（整体有任何 user_actionable 就放行所有类别），
  // 于是 tool_failed 又冒出来当候选。
  const mixed = [...env(3), {
    friction_counts: { user_unclear: 1 },
    friction_attribution: { user_unclear: 'user_actionable' },
  }];
  assert.deepEqual(aggregateFacets(mixed).ruleCandidates.map((r) => r.key), [],
    '别的类别是用户可改，不能让纯环境的 tool_failed 跟着进候选');

  // 真正该产出的：这一类摩擦本身在多数会话里被判为用户可改
  const real = Array.from({ length: 3 }, () => ({
    friction_counts: { excessive_changes: 1 },
    friction_attribution: { excessive_changes: 'user_actionable' },
  }));
  assert.deepEqual(aggregateFacets(real).ruleCandidates.map((r) => r.key), ['excessive_changes']);
});

test('原因不明的摩擦单列 unknown，不塞进 environmental 充数', () => {
  const a = aggregateFacets([{
    friction_counts: { buggy_code: 2, tool_failed: 1 },
    friction_attribution: { buggy_code: 'unknown', tool_failed: 'environmental' },
  }]);
  assert.equal(a.attribution.unknown, 2, '未知原因必须单独计');
  assert.equal(a.attribution.environmental, 1, '不能把未知并进环境');
});

test('旧的会话级归因格式降级为 unknown，而不是硬套成类别归因', async () => {
  const { normalizeFacet } = await import('../src/schema/normalize.mjs');
  const { facet, repairs } = normalizeFacet({
    friction_counts: { tool_failed: 3 },
    friction_attribution: { user_actionable: 0, agent_capability: 0, environmental: 1 },  // 旧格式
  });
  assert.equal(facet.friction_attribution.tool_failed, 'unknown',
    '旧格式没有类别级证据，宁可说不知道');
  assert.ok(repairs.coerced_types.some((r) => r.includes('旧的会话级格式')));
});

test('Windows 路径不能整个当成项目名', () => {
  const a = aggregateMetas([
    { cwd: 'C:\\demo\\project-a', toolCounts: {} },
    { cwd: '/home/dev/project-b', toolCounts: {} },
  ]);
  assert.deepEqual(Object.keys(a.projects).sort(), ['project-a', 'project-b']);
});

test('fork 会话的共同历史不重复计数', () => {
  const metas = [{ id: 'parent' }, { id: 'child', forkedFrom: 'parent' }, { id: 'other' }];
  const mk = (sid) => ({ session_id: sid, user_instructions: ['always run tests after editing'],
                         friction_counts: {}, friction_attribution: {} });
  const withFork = aggregateFacets([mk('parent'), mk('child'), mk('other')], { metas });
  assert.equal(withFork.repeatedInstructions[0].n, 2,
    'parent 与 child 是同一 fork 家族，应合并为 1，加 other 共 2');
});

test('缓存指纹必须包含内容，不能只看长度', async () => {
  const { createHash } = await import('node:crypto');
  const { compactTranscript } = await import('../src/pipeline/label.mjs');
  const fp = (transcript) => createHash('sha256')
    .update('v2|codex|same-id|2|0|').update(compactTranscript(transcript)).digest('hex').slice(0, 16);
  // 等长但内容不同 —— 旧实现（只用 length）会给出相同指纹并复用过时结果
  assert.notEqual(fp(['[user] Need AAA']), fp(['[user] Need BBB']));
});

/* ── v0.3.1：第二层截断形状 ──────────────────────────────────────
 * 复测第二轮指出：样本 2 的「第一阶段完整确认」在压缩文本第 38,505 字符处，
 * 旧的「整段首尾保留」把它整条丢进省略中段。承诺改成「每条消息都留下首尾」，
 * 这里就必须有测试在承诺不成立时失败。
 */
test('第二层：超预算时每条消息的首尾都必须存活', () => {
  // 200 条消息，每条 500 字，共 10 万字，远超 24k 预算
  const msgs = Array.from({ length: 200 }, (_, i) =>
    `[assistant] 消息${i}开头${'填'.repeat(480)}消息${i}结尾`);
  const out = compactTranscript(msgs);
  const missHead = msgs.filter((_, i) => !out.includes(`消息${i}开头`)).length;
  const missTail = msgs.filter((_, i) => !out.includes(`消息${i}结尾`)).length;
  assert.equal(missHead, 0, `有 ${missHead} 条消息的开头丢失`);
  assert.equal(missTail, 0, `有 ${missTail} 条消息的结尾丢失`);
  assert.ok(out.length <= 24000 + 200, `输出 ${out.length} 超出预算`);
});

test('第二层：中段消息不得整条消失（旧实现的反例）', () => {
  // 填充必须用中文：'x'.repeat(600) 会被脱敏规则当成 40+ 字符 token 整段替换掉，
  // 底本缩到 24k 以内，截断根本不触发——这条测试第一版就是这样假绿的。
  const msgs = Array.from({ length: 100 }, (_, i) => `[assistant] ${'填'.repeat(600)}标记${i}`);
  const out = compactTranscript(msgs);
  assert.ok(msgs.join('\n').length > 24000, '夹具本身没超预算，测试无意义');
  // 正中间那条——旧的整段首尾保留必然丢掉它
  assert.ok(out.includes('标记50'), '中段消息整条消失了');
});

test('splitBudget：短条目不得占用它用不完的额度', () => {
  // 1 条超长 + 99 条很短。公平分配应把额度绝大部分给那条长的。
  const lens = [50000, ...Array(99).fill(5)];
  const b = splitBudget(lens, 10000);
  assert.equal(b[1], 5, '短条目应当全额保留，不多拿');
  assert.ok(b[0] > 9000, `长条目只拿到 ${b[0]}，额度被浪费了`);
  assert.ok(b.reduce((a, c) => a + c, 0) <= 10000, '总额超预算');
});

/* ── v0.4.0：七段结构与双语 ──────────────────────────────────────── */

const FAKE_NARR = {
  headline: '中文标题句', 
  themes: [{ name: '主题一', session_estimate: 3, detail: '主题细节中文' }],
  how_you_work: { summary: '姿态概述', evidence: '证据中文', implication: '含义中文' },
  impressive: { summary: '概述中文', items: [{ title: '标题中文', detail: '细节中文' }] },
  friction_narrative: { summary: '摘要中文', yours_to_fix: '你能改的中文', model_limits: '能力所限中文', environment: '环境中文' },
  rules: [{ heading: '规则主题', rule: '中文祈使规则', why: '依据中文', evidence_quote: '你有测试吗', friction_key: 'tool_failed' }],
  next_steps: [{ title: '下一步中文', why_for_you: '原因中文', copyable_prompt: '先不要执行，请把这个任务改写成任务契约' }],
  horizon: { summary: '前瞻中文', items: [{ title: '前瞻标题', vision: '愿景中文' }] },
};
const FAKE_EN = {
  headline: 'English headline',
  themes: [{ name: 'Theme one', session_estimate: 3, detail: 'Theme detail' }],
  how_you_work: { summary: 'Posture', evidence: 'Evidence', implication: 'Implication' },
  impressive: { summary: 'Summary', items: [{ title: 'Title', detail: 'Detail' }] },
  friction_narrative: { summary: 'Summary', yours_to_fix: 'Yours', model_limits: 'Limits', environment: 'Env' },
  rules: [{ heading: 'Rule heading', rule: 'English imperative rule', why: 'Why', evidence_quote: '你有测试吗', friction_key: 'tool_failed' }],
  next_steps: [{ title: 'Next', why_for_you: 'Why', copyable_prompt: '先不要执行，请把这个任务改写成任务契约' }],
  horizon: { summary: 'Horizon', items: [{ title: 'T', vision: 'V' }] },
};
const FAKE_AGG = {
  n: 4, friction: [{ key: 'tool_failed', count: 9, sessions: 4 }], goals: [{ key: 'fix_bug', count: 5, sessions: 3 }],
  attribution: { user_actionable: 4, agent_capability: 2, environmental: 3, unknown: 1 },
  outcomes: { mostly_achieved: 4 }, sessionTypes: { multi_task: 4 },
  ruleCandidates: [{ key: 'tool_failed', count: 9, sessions: 4 }],
  // 夹具必须让每个条件分支都渲染，否则测不到的分支就是泄漏的藏身处——
  // 「你反复说过的话」那段第一版就因为夹具是空数组而漏掉了。
  repeatedInstructions: [{ text: '先测试再说完成', n: 3 }],
};
const FAKE_META_AGG = { sessions: 4, failureRate: 0.1, gitCommits: 2, approvalPolicies: { never: 4 },
  sandboxPolicies: {}, originators: {}, planSessions: 2 };
const renderArgs = (en) => ({ metaAgg: FAKE_META_AGG, facetAgg: FAKE_AGG, narrative: FAKE_NARR,
  narrativeEn: en, meta: { generatedAt: '2026-01-01 00:00 UTC', providers: ['codex'],
  windowDays: 0, spanDays: 7, version: 'test', repairsCount: 0 } });

test('报告必须有官方那七段，缺一段就是结构性缺失', () => {
  const h = renderHtml(renderArgs(null));
  for (const sec of ['你主要在做什么', '你是怎么用它的', '你做得漂亮的地方', '哪里出了问题',
                     'AGENTS.md 的规则', '下一步可以试试', '再往前一步']) {
    assert.ok(h.includes(sec), `缺少段落: ${sec}`);
  }
});

test('双语：切到 English 时不得残留未标记的中文块', () => {
  const h = renderHtml(renderArgs(FAKE_EN));
  // 判据：把所有**已标记语言**的元素整个剥掉后，页面上还剩多少中文。
  //
  // 两版都翻过车，所以写法很讲究：
  //   v1 用 `<tag ...>([^<]{4,})</tag>`，要求文本后紧跟闭合标签 —— 看不见
  //      `<h4>中文<span class="en">…</span></h4>` 这种嵌套，实测漏掉 20 处标题。
  //   v2 放开成 `[\s\S]*?`，又因为非贪婪遇到同名嵌套（div 套 div）只匹配到
  //      第一个 </div>，把子元素的开标签留在了内容里，产生 3 处假阳性。
  // 现在从**内向外**逐层剥：每轮只删「内部不再含同名开标签」的已标记元素，
  // 反复直到不再变化。剥完剩下的中文才是真的没标记。
  // 只看 <body>：<head> 里的 <title> 是浏览器标签页文字，不是页面内容
  let body = (h.split('<body')[1] || h)
    .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    // 可粘贴载荷刻意保留原语言：<pre> 里的提示词是给 agent 吃的，
    // data-rule 是要粘进 AGENTS.md 的规则原文。翻译它们就失去用途。
    .replace(/<pre[\s\S]*?<\/pre>/g, '')
    .replace(/data-rule="[^"]*"/g, '');
  const marked = /<(\w+)[^>]*class="[^"]*\b(?:zh|en|quote)\b[^"]*"[^>]*>((?:(?!<\1[\s>])[\s\S])*?)<\/\1>/;
  let prev;
  do { prev = body; body = body.replace(marked, ''); } while (body !== prev);
  const bare = body.replace(/<[^>]+>/g, ' ');
  const leaks = (bare.match(/[一-鿿][^\s]{0,30}/g) || []).filter((x) => x.trim());
  assert.deepEqual(leaks, [], `英文模式下会残留 ${leaks.length} 处中文:\n` + leaks.slice(0, 12).join('\n'));
});

test('双语：中文规则的 code 必须带 zh 标记（否则英文模式下中英规则同时显示）', () => {
  const h = renderHtml(renderArgs(FAKE_EN));
  const codes = [...h.matchAll(/<code([^>]*)>([^<]*)<\/code>/g)]
    .filter((m) => /[一-鿿]/.test(m[2]));
  assert.ok(codes.length > 0, '夹具里应当有中文规则');
  for (const c of codes) assert.match(c[1], /\bzh\b/, `中文 code 缺 zh 标记: ${c[2].slice(0, 30)}`);
});

test('没有英文叙事时不出语言开关，也不出任何 en 节点', () => {
  const h = renderHtml(renderArgs(null));
  // 注意查的是开关元素本身，不是 'langbar' 字符串——CSS 里恒有 .langbar 规则，
  // 第一版测试就是匹配到了样式表，报了个假的失败。
  assert.ok(!/<div class="langbar"/.test(h), '单语报告不该有语言开关');
  assert.ok(!/class="[^"]*\ben\b/.test(h), '单语报告不该有 en 节点');
});

test('规则块必须带证据句与勾选框——这是规则可信的依据', () => {
  const h = renderHtml(renderArgs(null));
  assert.ok(h.includes('你有测试吗'), '规则缺少证据引用');
  assert.ok(h.includes('class="rk"'), '规则缺少勾选框');
  assert.ok(h.includes('copyChecked'), '缺少批量复制');
});

test('合成 schema 七段齐全且每层 required 列全（strict 模式硬要求）', () => {
  const need = ['headline', 'themes', 'how_you_work', 'impressive',
                'friction_narrative', 'rules', 'next_steps', 'horizon'];
  for (const k of need) assert.ok(SYNTHESIS_SCHEMA.properties[k], `schema 缺 ${k}`);
  const walk = (o, path) => {
    if (o.type === 'object' && o.properties) {
      const miss = Object.keys(o.properties).filter((k) => !(o.required || []).includes(k));
      assert.deepEqual(miss, [], `${path} 的 required 漏了 ${miss}`);
      for (const [k, v] of Object.entries(o.properties)) walk(v, `${path}.${k}`);
    }
    if (o.type === 'array' && o.items) walk(o.items, `${path}[]`);
  };
  walk(SYNTHESIS_SCHEMA, 'root');
});

/* ── v0.5.0：外部使用者用 v0.4.0 跑自己的会话后提出的三条 ────────────── */

test('工具失败判定：grep 打印出的源代码不得算作失败', () => {
  // 真实误报形态：搜索命中一行含 error: 的源码
  const greps = [
    'Chunk ID: 1a\nWall time: 0.3 seconds\nProcess exited with code 0\n'
      + 'route.ts:22:    if (!token) return { ok: false, error: "token fetch failed" };',
    'Process exited with code 0\nexcept OSError:\n    continue',
  ];
  for (const out of greps) {
    const m = mkMeta(); classifyOutcome(out, m);
    assert.equal(m.toolFailures, 0, `误报为失败: ${out.slice(0, 50)}`);
  }
});

test('工具失败判定：认退出码，不认 "exit_code" 那种从不存在的写法', () => {
  const fail = mkMeta(); classifyOutcome('Process exited with code 1\nsome output', fail);
  assert.equal(fail.toolFailures, 1, '非零退出码必须算失败');
  const ok = mkMeta(); classifyOutcome('Process exited with code 0\nfine', ok);
  assert.equal(ok.toolFailures, 0);
  // 旧实现找的是 `"exit_code": N`，这种写法在真实数据里一次都没出现过
  const legacy = mkMeta(); classifyOutcome('{"exit_code": 1}', legacy);
  assert.equal(legacy.toolOutcomeUnknown + legacy.toolFailures, 1, '至少要有明确归类');
});

test('工具失败判定：判不出来要计入 unknown，不能默认算成功', () => {
  const m = mkMeta(); classifyOutcome('some output with no exit information at all', m);
  assert.equal(m.toolOutcomeUnknown, 1, '判不出来必须单列');
  assert.equal(m.toolOutcomesKnown, 0, '判不出来不得计入可判定集（否则稀释失败率）');
  const run = mkMeta(); classifyOutcome('Process running with session abc', run);
  assert.equal(run.toolStillRunning, 1);
  assert.equal(run.toolFailures + run.toolOutcomesKnown, 0, '仍在运行既不算成功也不算失败');
});

test('子代理派生的会话不得计入「你与 agent 的协作」统计', () => {
  const human = { source: 'vscode', userMessages: 5, toolCalls: 10, durationMinutes: 5, toolCounts: {}, responseGaps: [] };
  const sub = { source: 'subagent', userMessages: 3, toolCalls: 40, durationMinutes: 9, toolCounts: {}, responseGaps: [] };
  const a = aggregateMetas([human, sub, sub]);
  assert.equal(a.sessions, 1, '真人会话应只有 1 个');
  assert.equal(a.allSessions, 3, '文件总数仍要如实报出');
  assert.equal(a.subagentSessions, 2, '子代理数量必须单列，不能静默丢弃');
  assert.equal(a.userMessages, 5, '子代理的任务书不是用户消息');
  assert.equal(a.toolCalls, 10, '子代理的工具调用不并入');
});

test('失败率分母只用可判定的调用', () => {
  const m = { source: 'vscode', userMessages: 2, toolCalls: 100, durationMinutes: 5,
    toolFailures: 15, toolOutcomesKnown: 60, toolStillRunning: 10, toolOutcomeUnknown: 30,
    toolCounts: {}, responseGaps: [] };
  const a = aggregateMetas([m]);
  assert.equal(a.failureRate.toFixed(3), (15 / 60).toFixed(3), '分母应为可判定集 60，不是总调用 100');
  assert.ok(a.failureRateCoverage < 1, '必须能报出口径覆盖率');
});

test('不得再用「满意度」口径——纠正不等于不满，沉默不等于满意', () => {
  assert.ok(!FACET_SRC.includes('user_satisfaction_counts'), 'satisfaction 字段应已移除');
  assert.ok(FACET_SRC.includes('user_reaction_counts'), '应改为可观察反应');
  assert.ok(!LABEL_SRC.includes('is dissatisfied'), '打标 prompt 不得把纠正判为不满');
});

test('失败率不得超过 100%——每个 provider 都要报可判定集', () => {
  // 必须走真实的 parse()，不能自己拼 meta 对象——第一版就是那样写的，
  // 把修复撤掉它照样绿，等于没测到 provider。
  const dir = mkdtempSync(join(tmpdir(), 'adi-t-'));
  const f = join(dir, 'session-meta.json');
  writeFileSync(f, JSON.stringify({
    session_id: 't1', project_path: '/tmp/x', start_time: new Date().toISOString(),
    duration_minutes: 5, user_message_count: 3, assistant_message_count: 4,
    tool_counts: { Bash: 20, Read: 10 }, tool_errors: 3, first_prompt: 'hi',
  }));
  try {
    const m = parseClaudeCode(f);
    assert.ok(m, 'fixture 应能解析');
    assert.equal(m.toolOutcomesKnown, 30, 'claude-code 的可判定集应等于全部调用数');
    const a = aggregateMetas([m]);
    assert.ok(a.failureRate <= 1, `失败率 ${(a.failureRate * 100).toFixed(1)}% 超过 100%`);
    assert.equal(a.failureRate.toFixed(3), (3 / 30).toFixed(3));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTML 输出里不得有字面 markdown 加粗（HTML 不渲染 **）', () => {
  const h = renderHtml(renderArgs(FAKE_EN));
  const literal = h.match(/\*\*[^*\n]{2,60}\*\*/g) || [];
  assert.deepEqual(literal, [], `报告里出现了没被渲染的 **：${literal.join(' / ')}`);
});

test('样本过少时必须显著警示，不能把 n=1 的描述当成模式', () => {
  // 查元素，不查类名字符串——CSS 里恒有 .samplewarn 规则。
  // 本轮这个坑踩了第二次（第一次是 .langbar），所以固定用 <div class="..."> 形式匹配。
  const el = /<div class="[^"]*\bsamplewarn\b/;
  const small = renderHtml({ ...renderArgs(null), facetAgg: { ...FAKE_AGG, n: 1 } });
  assert.match(small, el, 'n=1 时必须出样本量警示');
  assert.ok(/样本量不足/.test(small), '警示要说清是样本量问题');
  const big = renderHtml({ ...renderArgs(null), facetAgg: { ...FAKE_AGG, n: 20 } });
  assert.doesNotMatch(big, el, '样本充足时不该出警示');
});

test('版本号必须与 package.json 一致，且不得在代码里硬编码', () => {
  const pkg = JSON.parse(_rf(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(version(), pkg.version, 'version() 应等于 package.json');
  // --help 与报告里的版本号历史上分别停在 v0.3.1 / v0.5.1，跟真实发布版本对不上；
  // 同事按 --help 报 bug 会指向错的版本。这里禁止代码里再出现字面版本号。
  for (const f of ['cli.mjs', 'doctor.mjs']) {
    const src = _rf(new URL(`../src/${f}`, import.meta.url), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*[*/]/.test(l)).join('\n');
    const hard = code.match(/(?<![\w.])v?\d+\.\d+\.\d+(?![\w.])/g) || [];
    assert.deepEqual(hard, [], `${f} 里仍有硬编码版本号: ${hard.join(', ')}`);
  }
});

test('落了中间产物就必须在报告里指出来，否则等于没有', () => {
  const withA = renderHtml({ ...renderArgs(FAKE_EN),
    meta: { ...renderArgs(FAKE_EN).meta, artifactsDir: 'adi-report-artifacts' } });
  assert.match(withA, /如何核对这份结论/, '缺少核对入口');
  for (const f of ['aggregate.json', 'facets.json', 'sample-index.json', 'run.json']) {
    assert.ok(withA.includes(f), `没有指出 ${f}`);
  }
  assert.ok(withA.includes('adi-report-artifacts'), '没有给出目录名');
  // 没落盘时不该凭空承诺可核对
  const without = renderHtml(renderArgs(FAKE_EN));
  assert.doesNotMatch(without, /如何核对这份结论/, '没落盘却声称可核对');
});

/* ── v0.6.0：Claude Code 正文提取 ──────────────────────────────────── */

test('工具结果：is_error 是权威信号，缺这个字段算判不出来而不是成功', () => {
  const a = { toolFailures: 0, toolOutcomesKnown: 0, toolOutcomeUnknown: 0 };
  classifyToolResult({ is_error: true }, a);
  assert.equal(a.toolFailures, 1); assert.equal(a.toolOutcomesKnown, 1);
  classifyToolResult({ is_error: false }, a);
  assert.equal(a.toolFailures, 1); assert.equal(a.toolOutcomesKnown, 2);
  // 实测抽样里 is_error 缺失占多数（1334 缺 / 692 假 / 80 真），
  // 把缺失当成功会系统性压低失败率——Codex 侧已经栽过一次同型的。
  classifyToolResult({}, a);
  assert.equal(a.toolOutcomeUnknown, 1, '缺 is_error 必须计入 unknown');
  assert.equal(a.toolOutcomesKnown, 2, 'unknown 不得进可判定集');
});

test('正文提取：子代理行不计入、命令回灌不算用户消息', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adi-cc-'));
  const proj = join(dir, 'projects', '-x'); mkdirSync(proj, { recursive: true });
  const sid = 'test-session-1';
  const rows = [
    { type: 'user', isSidechain: false, message: { role: 'user', content: '真实的用户提问内容' } },
    // 子代理产生的行：Claude Code 用 isSidechain 标记
    { type: 'user', isSidechain: true, message: { role: 'user', content: '子代理的任务书不该算进来' } },
    // 命令输出回灌 / 系统提醒：不是人打的字
    { type: 'user', isSidechain: false, message: { role: 'user', content: '<system-reminder>提醒正文</system-reminder>' } },
    { type: 'user', isSidechain: false, message: { role: 'user', content: '<command-name>/foo</command-name>' } },
    { type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'thinking', thinking: '内部推理不该进 transcript' },
                { type: 'text', text: '助手的回答' },
                { type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', isSidechain: false, message: { role: 'user',
      content: [{ type: 'tool_result', is_error: true, content: 'boom' }] } },
  ];
  writeFileSync(join(proj, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n'));
  const prevHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    transcriptIndex({ rebuild: true });
    const r = readTranscript(sid);
    assert.ok(r, '应能读到 transcript');
    assert.equal(r.stats.userMessages, 1, '只有 1 条是人打的字');
    assert.equal(r.stats.sidechainLines, 1, '子代理行要如实计数而不是静默丢弃');
    assert.equal(r.stats.toolCalls, 1);
    assert.equal(r.stats.toolFailures, 1);
    const joined = r.transcript.join('\n');
    assert.ok(joined.includes('真实的用户提问内容'));
    assert.ok(!joined.includes('子代理的任务书'), '子代理内容不得进 transcript');
    assert.ok(!joined.includes('内部推理'), 'thinking 块不得进 transcript');
    assert.ok(!/提醒正文|command-name/.test(joined), '系统注入不得进 transcript');
  } finally {
    if (prevHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevHome;
    transcriptIndex({ rebuild: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('正文索引只扫一层——深层是子代理记录，递归会把它们混进来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adi-cc2-'));
  const proj = join(dir, 'projects', '-y');
  mkdirSync(join(proj, 'deadbeef', 'subagents'), { recursive: true });
  writeFileSync(join(proj, 'real-session.jsonl'), '{}');
  writeFileSync(join(proj, 'deadbeef', 'subagents', 'agent-xyz.jsonl'), '{}');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const idx = transcriptIndex({ rebuild: true });
    assert.ok(idx.has('real-session'), '一层的真实会话要进索引');
    assert.ok(!idx.has('agent-xyz'), '子代理记录不得进索引');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    transcriptIndex({ rebuild: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只有部分数据源具备的信号，必须用自己的分母', () => {
  // 姿态信号（授权/沙箱/任务分解）目前只有 Codex 会话带。
  // 用全部会话当分母会稀释比例——实测「8/411」，真实分母是 17 个 Codex 会话，差 24 倍。
  const cxWithPosture = { provider: 'codex', source: 'vscode', userMessages: 2, durationMinutes: 5,
    toolCalls: 1, toolCounts: {}, responseGaps: [], approvalPolicy: 'never',
    sandboxPolicy: 'danger-full-access', planSteps: ['a'] };
  const ccNoPosture = { provider: 'claude-code', userMessages: 2, durationMinutes: 5,
    toolCalls: 1, toolCounts: {}, responseGaps: [] };
  const a = aggregateMetas([cxWithPosture, ...Array(30).fill(ccNoPosture)]);
  assert.equal(a.sessions, 31, '总会话数照常统计');
  assert.equal(a.postureSessions, 1, '带姿态信号的只有 1 个');
  assert.equal(a.planSessions, 1);
  const h = renderHtml({ ...renderArgs(null), metaAgg: a });
  assert.ok(h.includes('1/1 个会话有显式任务分解'), `分母用错了：${(h.match(/\d+\/\d+ 个会话有显式任务分解/) || [])[0]}`);
  assert.ok(!h.includes('1/31 个会话有显式任务分解'), '不得用全部会话当分母');
});

test('渲染结果里不得出现未插值的模板字面量', () => {
  // 实测踩过：修双语泄漏时把 ${BI ? '…${esc(e.heading)}…' : ''} 写成了单引号，
  // 内层 ${} 不再插值，页面上直接印出 `先写最终物 / ${esc(e.heading)}`。
  // 泄漏测试看不见它（这串没有中文），DOM 断言也不会报——只有真看渲染结果才发现。
  for (const h of [renderHtml(renderArgs(FAKE_EN)), renderHtml(renderArgs(null))]) {
    const literals = h.match(/\$\{[^}\n]{1,60}\}/g) || [];
    assert.deepEqual(literals, [], `页面上出现了未插值的模板：${literals.slice(0, 5).join(' / ')}`);
  }
});

test('双语对照下行内元素必须分行，不能首尾相连', () => {
  // 实测踩过：h1 渲染成「你的 AI 编码摩擦报告Your AI Coding Friction Report」，
  // 数字卡片渲染成「深度分析Deeply analyzed」。块级元素各占一行没事，行内的会粘住。
  const h = renderHtml(renderArgs(FAKE_EN));
  const css = (h.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  const rule = css.match(/body\.lang-both[^{]*\{display:block\}/);
  assert.ok(rule, '缺少「行内 en 分行」的样式规则');
  for (const sel of ['h1 .en', '.card .en', '.copyall .en']) {
    assert.ok(rule[0].includes(sel), `${sel} 未包含在分行规则里`);
  }
});
