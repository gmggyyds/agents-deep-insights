import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFacets, crossCollabOutcome } from '../src/pipeline/aggregate.mjs';
import { facetSchema, COLLAB_MODE, COUNT_KEYS_OF } from '../src/schema/facet.mjs';
import { normalizeFacet } from '../src/schema/normalize.mjs';
import { readFile } from 'node:fs/promises';

const F = (over = {}) => ({
  outcome: 'fully_achieved', session_type: 'single_task',
  goal_categories: {}, friction_counts: {}, friction_attribution: {},
  friction_detail: '', user_instructions: [], brief_summary: '',
  underlying_goal: '', primary_success: 'none', claude_helpfulness: 'very_helpful',
  user_reaction_counts: {},
  collaboration_mode_counts: { delegate: 1, deliberate: 0, steer: 0 },
  ...over,
});

test('schema: 新字段进了 properties / required，且 strict 要求每层 required 列全', () => {
  const s = facetSchema();
  assert.ok('collaboration_mode_counts' in s.properties);
  assert.ok(s.required.includes('collaboration_mode_counts'));
  assert.deepEqual(
    [...s.required].sort(), Object.keys(s.properties).sort(),
    'OpenAI strict mode 要求 required 列全该层每个 property',
  );
  const sub = s.properties.collaboration_mode_counts;
  assert.deepEqual([...sub.required].sort(), [...COLLAB_MODE].sort());
});

test('多标签：一条消息计入多类时，三类各自独立累加（不是分摊）', () => {
  const facets = [
    F({ collaboration_mode_counts: { delegate: 1, deliberate: 1, steer: 1 } }),
    F({ collaboration_mode_counts: { delegate: 2, deliberate: 0, steer: 1 } }),
  ];
  const a = aggregateFacets(facets, { noiseFloor: 1 });
  const got = Object.fromEntries(a.collaborationModes.map((r) => [r.key, r.count]));
  assert.equal(got.delegate, 3);
  assert.equal(got.deliberate, 1);
  assert.equal(got.steer, 2);
});

test('🔴 旧 facet（没有该字段）必须被排除，不能当成 deliberate=0 混进对照组', () => {
  const legacy = F(); delete legacy.collaboration_mode_counts;
  const cross = crossCollabOutcome([...Array(12)].map(() => legacy));
  assert.equal(cross.labeledSessions, 0);
  assert.ok(cross.insufficient, '全是旧 facet 时必须判定样本不足，而不是给出 0% 的假结论');
});

test('🔴 任一组样本不足 MIN_GROUP 时不给结论', () => {
  const many = [...Array(20)].map(() => F({ collaboration_mode_counts: { delegate: 1, deliberate: 1, steer: 0 } }));
  const few = [...Array(2)].map(() => F({ collaboration_mode_counts: { delegate: 1, deliberate: 0, steer: 0 } }));
  const cross = crossCollabOutcome([...many, ...few]);
  assert.ok(cross.byMode.deliberate.insufficient, '对照组只有 2 个会话时必须拒绝下结论');
  assert.equal(cross.byMode.deliberate.without, 2);
});

test('🔴 successRate 分母只用可判定集，unclear 不塞进任何一边', () => {
  const withD = [
    ...[...Array(3)].map(() => F({ outcome: 'fully_achieved', collaboration_mode_counts: { delegate: 1, deliberate: 1, steer: 0 } })),
    ...[...Array(3)].map(() => F({ outcome: 'unclear_from_transcript', collaboration_mode_counts: { delegate: 1, deliberate: 1, steer: 0 } })),
  ];
  const without = [...Array(6)].map(() => F({ outcome: 'not_achieved', collaboration_mode_counts: { delegate: 1, deliberate: 0, steer: 0 } }));
  const cross = crossCollabOutcome([...withD, ...without]);
  const d = cross.byMode.deliberate;
  assert.equal(d.with.successRate, 1, '3 好 0 坏 3 说不清 → 成功率按可判定集算应为 1.0');
  assert.equal(d.with.decidable, 3);
  assert.equal(d.with.unclear, 3);
  assert.equal(d.without.successRate, 0);
});

test('交叉：能算出摩擦差与成功率差，且方向正确', () => {
  const withD = [...Array(6)].map(() => F({
    outcome: 'fully_achieved',
    collaboration_mode_counts: { delegate: 1, deliberate: 1, steer: 0 },
    friction_counts: { buggy_code: 1 }, friction_attribution: { buggy_code: 'user_actionable' },
  }));
  const without = [...Array(6)].map(() => F({
    outcome: 'not_achieved',
    collaboration_mode_counts: { delegate: 1, deliberate: 0, steer: 0 },
    friction_counts: { buggy_code: 3 }, friction_attribution: { buggy_code: 'user_actionable' },
  }));
  const d = crossCollabOutcome([...withD, ...without]).byMode.deliberate;
  assert.equal(d.successRateDelta, 1, '有 deliberate 全成功、无的全失败 → delta = +1');
  assert.equal(d.frictionDelta, -2, '1/会话 vs 3/会话 → -2');
  assert.equal(d.with.userActionableShare, 1);
});

test('归一化：LLM 产出的近义词能映射回三类', () => {
  const raw = {
    ...F(),
    collaboration_mode_counts: { execution: 2, exploration: 1, oversight: 3 },
  };
  const c = normalizeFacet(raw).facet.collaboration_mode_counts;
  assert.equal(c.delegate, 2, 'execution → delegate');
  assert.equal(c.deliberate, 1, 'exploration → deliberate');
  assert.equal(c.steer, 3, 'oversight → steer');
});

test('归一化：类型漂移（布尔值）不能被当成计数', () => {
  const raw = { ...F(), collaboration_mode_counts: { delegate: true, deliberate: 'yes', steer: 2 } };
  const c = normalizeFacet(raw).facet.collaboration_mode_counts;
  assert.equal(typeof c.delegate, 'number');
  assert.equal(typeof c.deliberate, 'number');
  assert.equal(c.steer, 2);
});

test('COUNT_KEYS_OF 已登记，归一化才会处理该字段', () => {
  assert.ok('collaboration_mode_counts' in COUNT_KEYS_OF);
});

test('🔴 缓存指纹必须从 facet 契约自动派生，不能手写版本号常量', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(src, /SCHEMA_FINGERPRINT[\s\S]*facetSchema\(\)/,
    '指纹必须由 facetSchema() 派生');
  const fpBlock = src.slice(src.indexOf('const fingerprint'), src.indexOf('const argv'));
  assert.doesNotMatch(fpBlock, /`v\d+\|/,
    '指纹里不允许再出现手写的 v<N>| 常量——那要靠人记得 bump，2026-09-10 已经漏过一次');
});

test('🔴 契约任何改动都必须改变指纹（否则旧缓存会被复用）', async () => {
  const { createHash } = await import('node:crypto');
  const fp = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 8);
  const base = facetSchema();
  const mutated = JSON.parse(JSON.stringify(base));
  delete mutated.properties.collaboration_mode_counts;
  mutated.required = mutated.required.filter((k) => k !== 'collaboration_mode_counts');
  assert.notEqual(fp(base), fp(mutated), '加/删字段必须让指纹变化');
});

// —— 防回归：bi() 的参数会走 esc()，塞 HTML 标签会被转义成字面文字印在报告上 ——
// 2026-09-10：补协作模式概念说明时踩过，三处 <b> 会原样显示给用户。
test('bi() 调用的文案参数里不得出现 HTML 标签', async () => {
  const src = await readFile(new URL('../src/render/html.mjs', import.meta.url), 'utf8');
  // 匹配 bi('...' 或 biH('...' 的第一个字符串参数里带尖括号标签的情况
  const offenders = [...src.matchAll(/\bbiH?\(\s*'((?:[^'\\]|\\.)*)'/g)]
    .map((m) => m[1])
    .filter((s) => /<\/?[a-zA-Z][^>]*>/.test(s));
  assert.deepEqual(offenders, [], `bi() 文案里带 HTML 标签会被 esc() 转义成字面文字：${offenders.join(' | ')}`);
});
