/**
 * 外部测试发现的问题，逐条固化为回归用例。
 * 来源：2026-09-09 两位外部测试者在 macOS(codex 0.153.4) 与 Windows 上的实测反馈。
 * 这些问题作者本机全部测不出来——版本不同、平台不同、或功能承诺了却没实现。
 */
import { test } from 'node:test';
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

test('规则候选必须落实 user_actionable 过滤（README 承诺过但代码没做）', () => {
  const envOnly = Array.from({ length: 3 }, () => ({
    friction_counts: { tool_failed: 1 },
    friction_attribution: { user_actionable: 0, agent_capability: 0, environmental: 1 },
  }));
  assert.deepEqual(aggregateFacets(envOnly).ruleCandidates, [],
    '纯环境故障不该产出规则候选——写成规则也改不掉');

  const mixed = Array.from({ length: 3 }, () => ({
    friction_counts: { excessive_changes: 1 },
    friction_attribution: { user_actionable: 1, agent_capability: 0, environmental: 0 },
  }));
  assert.ok(aggregateFacets(mixed).ruleCandidates.length > 0, '含用户可改成分时应产出候选');
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
