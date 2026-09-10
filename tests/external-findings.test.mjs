/**
 * 外部测试发现的问题，逐条固化为回归用例。
 * 来源：2026-09-09 两位外部测试者在 macOS(codex 0.153.4) 与 Windows 上的实测反馈。
 * 这些问题作者本机全部测不出来——版本不同、平台不同、或功能承诺了却没实现。
 */
import { test } from 'node:test';
import { compactTranscript } from '../src/pipeline/label.mjs';
import { readFileSync as _rf, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseClaudeCode } from '../src/providers/claude-code.mjs';
import { classifyOutcome } from '../src/providers/codex.mjs';
const FACET_SRC = _rf(new URL('../src/schema/facet.mjs', import.meta.url), 'utf8');
const LABEL_SRC = _rf(new URL('../src/pipeline/label.mjs', import.meta.url), 'utf8');
const mkMeta = () => ({ toolFailures: 0, toolOutcomesKnown: 0, toolStillRunning: 0, toolOutcomeUnknown: 0 });
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
  rules: [{ heading: '规则主题', rule: '中文祈使规则', why: '依据中文', evidence_quote: '你有测试吗', evidence_count: 4 }],
  next_steps: [{ title: '下一步中文', why_for_you: '原因中文', copyable_prompt: 'Paste me' }],
  horizon: { summary: '前瞻中文', items: [{ title: '前瞻标题', vision: '愿景中文' }] },
};
const FAKE_EN = {
  headline: 'English headline',
  themes: [{ name: 'Theme one', session_estimate: 3, detail: 'Theme detail' }],
  how_you_work: { summary: 'Posture', evidence: 'Evidence', implication: 'Implication' },
  impressive: { summary: 'Summary', items: [{ title: 'Title', detail: 'Detail' }] },
  friction_narrative: { summary: 'Summary', yours_to_fix: 'Yours', model_limits: 'Limits', environment: 'Env' },
  rules: [{ heading: 'Rule heading', rule: 'English imperative rule', why: 'Why', evidence_quote: '你有测试吗', evidence_count: 4 }],
  next_steps: [{ title: 'Next', why_for_you: 'Why', copyable_prompt: 'Paste me' }],
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
  // 逐个块级元素检查：含中文却没有 zh 标记的，在 lang-en 下会和英文同时显示
  const leaks = [];
  for (const m of h.matchAll(/<(code|p|div|li|h4|h2|span)([^>]*)>([^<]{4,})<\/\1>/g)) {
    const [, tag, attrs, txt] = m;
    if (!/[一-鿿]/.test(txt)) continue;
    const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/);
    if (cls.includes('zh')) continue;
    if (cls.includes('quote')) continue;              // 证据句刻意保留原话
    if (cls.includes('en')) continue;                 // 英文块里引用的原话，同上
    leaks.push(`<${tag} class="${cls.join(' ')}">${txt.trim().slice(0, 40)}`);
  }
  assert.deepEqual(leaks, [], `英文模式下会残留 ${leaks.length} 处中文:\n` + leaks.join('\n'));
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
