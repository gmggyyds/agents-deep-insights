import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFacets, crossCollabOutcome } from '../src/pipeline/aggregate.mjs';
import { facetSchema, COLLAB_MODE, COUNT_KEYS_OF } from '../src/schema/facet.mjs';
import { normalizeFacet } from '../src/schema/normalize.mjs';
import { SCHEMA_FINGERPRINT, cacheKey } from '../src/cache-key.mjs';
import { TASK } from '../src/pipeline/label.mjs';
import { ALIASES } from '../src/schema/facet.mjs';
import { createHash } from 'node:crypto';

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

test('🔴 没打标的会话必须被排除——且要走真实管线（normalizeFacet 会 dense-fill）', () => {
  // 直接 delete 字段测不到真实情况：管线里每个 facet 都是 normalizeFacet 的产物，
  // 而它对 COUNT_KEYS_OF 无条件 dense-fill，缺字段会变成全 0 而不是 undefined。
  const raw = F(); delete raw.collaboration_mode_counts;
  const normalized = normalizeFacet(raw).facet;
  assert.deepEqual(normalized.collaboration_mode_counts, { delegate: 0, deliberate: 0, steer: 0 },
    'normalize 确实会把缺失字段填成全 0——所以判「有没有打标」不能看字段存不存在');

  const cross = crossCollabOutcome([...Array(12)].map(() => ({ ...normalized })));
  assert.equal(cross.labeledSessions, 0, '全 0 = 没打上标，不能算进 labeled');
  assert.ok(cross.insufficient);
});

test('🔴 真打标的会话与未打标的混在一起时，未打标的不得进入对照组', () => {
  const real = [...Array(10)].map(() => F({
    outcome: 'fully_achieved',
    collaboration_mode_counts: { delegate: 3, deliberate: 2, steer: 1 },
  }));
  const rawMissing = F({ outcome: 'not_achieved' });
  delete rawMissing.collaboration_mode_counts;
  const missing = [...Array(10)].map(() => ({ ...normalizeFacet(rawMissing).facet, outcome: 'not_achieved' }));
  const cross = crossCollabOutcome([...real, ...missing]);
  assert.equal(cross.labeledSessions, 10, '20 条里只有 10 条真打过标');
});

test('🔴 分组后任一侧样本不足 MIN_GROUP 时不给结论', () => {
  const many = [...Array(20)].map(() => F({ collaboration_mode_counts: { delegate: 1, deliberate: 1, steer: 0 } }));
  const few = [...Array(2)].map(() => F({ collaboration_mode_counts: { delegate: 9, deliberate: 1, steer: 0 } }));
  const cross = crossCollabOutcome([...many, ...few]);
  assert.ok(cross.byMode.deliberate.insufficient, '一侧只有 2 个会话时必须拒绝下结论');
  assert.ok(cross.byMode.deliberate.reason, '要说明为什么切不开');
});

test('🔴 主导模式也必须能出结论——不能因为「人人都有」就永远样本不足', () => {
  // delegate 在每个会话里都 >0（真实数据就是这样），旧的「有/无」分组会让对照组恒空
  const facets = [
    ...[...Array(8)].map(() => F({ collaboration_mode_counts: { delegate: 9, deliberate: 1, steer: 0 } })),
    ...[...Array(8)].map(() => F({ collaboration_mode_counts: { delegate: 2, deliberate: 5, steer: 3 } })),
  ];
  const d = crossCollabOutcome(facets).byMode.delegate;
  assert.ok(!d.insufficient, 'delegate 处处非零，但按占比中位数仍应切得开');
  assert.equal(d.high.n, 8);
  assert.equal(d.low.n, 8);
});

test('🔴 successRate 分母只用可判定集，unclear 不塞进任何一边', () => {
  const withD = [
    ...[...Array(3)].map(() => F({ outcome: 'fully_achieved', collaboration_mode_counts: { delegate: 1, deliberate: 1, steer: 0 } })),
    ...[...Array(3)].map(() => F({ outcome: 'unclear_from_transcript', collaboration_mode_counts: { delegate: 1, deliberate: 1, steer: 0 } })),
  ];
  const without = [...Array(6)].map(() => F({ outcome: 'not_achieved', collaboration_mode_counts: { delegate: 1, deliberate: 0, steer: 0 } }));
  const cross = crossCollabOutcome([...withD, ...without]);
  const d = cross.byMode.deliberate;
  assert.equal(d.high.successRate, 1, '3 好 0 坏 3 说不清 → 成功率按可判定集算应为 1.0');
  assert.equal(d.high.decidable, 3);
  assert.equal(d.high.unclear, 3);
  assert.equal(d.low.successRate, 0);
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
  assert.equal(d.successRateDelta, 1, 'deliberate 占比高的全成功、低的全失败 → delta = +1');
  assert.equal(d.frictionDelta, -2, '1/会话 vs 3/会话 → -2');
  assert.equal(d.high.userActionableShare, 1);
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



test('🔴 计数是字符串时不能走字符串拼接（crossCollabOutcome 是 export 的公共函数）', () => {
  const mk = (mode, fr) => F({
    outcome: 'fully_achieved', collaboration_mode_counts: mode,
    friction_counts: { buggy_code: fr }, friction_attribution: { buggy_code: 'user_actionable' },
  });
  const facets = [
    ...[...Array(6)].map(() => mk({ delegate: 1, deliberate: 5, steer: 0 }, '3')),
    ...[...Array(6)].map(() => mk({ delegate: 5, deliberate: 1, steer: 0 }, '3')),
  ];
  const d = crossCollabOutcome(facets).byMode.deliberate;
  assert.equal(d.high.frictionPerSession, 3, '字符串 "3" 必须当数字 3，不能拼成 333333');
});

test('低频模式不能被噪声门槛抹掉（三值稠密分类不适用 friction 的门槛）', () => {
  const facets = [
    ...[...Array(10)].map(() => F({ collaboration_mode_counts: { delegate: 9, deliberate: 4, steer: 0 } })),
    F({ collaboration_mode_counts: { delegate: 1, deliberate: 0, steer: 1 } }),
  ];
  const a = aggregateFacets(facets, {});   // 默认 noiseFloor=2
  const keys = a.collaborationModes.map((m) => m.key);
  assert.ok(keys.includes('steer'), 'steer 只出现 1 次，但它是真实存在的一类，不能消失');
  assert.equal(a.collaborationModes.length, 3);
});

// ── 缓存键：把「靠人记得 bump」换成派生，并锁住派生源的集合

test('🔴 契约指纹必须同时由 schema + TASK + ALIASES 派生', () => {
  // 只 hash schema 是不够的：决定计数结果的打标规则(TASK)和归一映射(ALIASES)都不在 schema 里。
  // 把它们任何一个从派生里去掉，这条断言就会红——这正是它存在的意义。
  const expected = createHash('sha256')
    .update(JSON.stringify(facetSchema()))
    .update(TASK)
    .update(JSON.stringify(ALIASES))
    .digest('hex').slice(0, 8);
  assert.equal(SCHEMA_FINGERPRINT, expected);
});

test('🔴 缓存键必须真的把契约指纹算进去，且对 transcript 变化敏感', () => {
  const compact = (t) => t.join('\n');
  const meta = { provider: 'codex', id: 'S1', userMessages: 3, toolCalls: 9, transcript: ['[user] AAA'] };
  const k1 = cacheKey(meta, compact);
  assert.ok(k1.startsWith(SCHEMA_FINGERPRINT) === false, '键是 hash，不该是指纹的明文前缀');

  // 内容变了但长度不变 —— 外部测试发现过这个洞
  const k2 = cacheKey({ ...meta, transcript: ['[user] BBB'] }, compact);
  assert.notEqual(k1, k2, 'transcript 内容变化必须改变缓存键');

  // 同输入必须稳定，否则每次运行都白烧一次额度
  assert.equal(cacheKey(meta, compact), k1);
});

// ── 渲染层：此前零覆盖，删掉整段或把占比放大 10 倍都不会有测试变红

import { renderHtml } from '../src/render/html.mjs';

const META = {
  sessions: 20, userMessages: 200, toolCalls: 500, failureRate: 0.1, gitCommits: 3,
  failureRateCoverage: 1, subagentSessions: 0, approvalPolicies: {}, sandboxPolicies: {},
  originators: {}, planSessions: 0,
};
const renderWith = (facets) => renderHtml({
  metaAgg: META, facetAgg: aggregateFacets(facets, { noiseFloor: 1 }),
  meta: { generatedAt: '2026-09-10 00:00 UTC', providers: ['codex'], windowDays: 30, spanDays: 30 },
  narrative: null,
});

test('渲染：协作模式章节出现，且占比数值正确', () => {
  const facets = [
    ...[...Array(8)].map(() => F({ collaboration_mode_counts: { delegate: 6, deliberate: 3, steer: 1 } })),
    ...[...Array(8)].map(() => F({ collaboration_mode_counts: { delegate: 2, deliberate: 6, steer: 2 } })),
  ];
  const html = renderWith(facets);
  assert.ok(html.includes('你在要求 AI 做什么'), '章节必须出现');
  // delegate 8*6+8*2=64, deliberate 8*3+8*6=72, steer 8*1+8*2=24, 合计 160
  assert.ok(html.includes('45.0%'), 'deliberate 72/160 = 45.0%');
  assert.ok(html.includes('40.0%'), 'delegate 64/160 = 40.0%');
  assert.ok(html.includes('15.0%'), 'steer 24/160 = 15.0%');
  assert.ok(html.includes('出现在 16/16 个会话'), '要同时给出会话覆盖数');
});

test('渲染：没有协作模式数据时整段消失，不产出畸形 HTML', () => {
  const bare = F(); delete bare.collaboration_mode_counts;
  const html = renderWith([...Array(6)].map(() => ({ ...normalizeFacet(bare).facet })));
  assert.ok(!html.includes('你在要求 AI 做什么'));
  assert.ok(!html.includes('<table class="cross">'), '不能留下空表头');
});

test('🔴 渲染：交叉项字段残缺时不抛错（聚合契约被破坏也不能崩掉整份报告）', () => {
  const facets = [...Array(12)].map(() => F({ collaboration_mode_counts: { delegate: 3, deliberate: 1, steer: 1 } }));
  const agg = aggregateFacets(facets, { noiseFloor: 1 });
  agg.collaborationCross = { byMode: { delegate: { high: {}, low: {} } } };   // 缺 successRate / frictionPerSession
  const html = renderHtml({
    metaAgg: META, facetAgg: agg,
    meta: { generatedAt: 'x', providers: ['codex'], windowDays: 30, spanDays: 30 }, narrative: null,
  });
  assert.ok(html.includes('你在要求 AI 做什么'));
  assert.ok(html.includes('—'), '缺失值应渲染成占位符而不是抛 TypeError');
});
