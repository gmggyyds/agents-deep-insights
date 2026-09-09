/**
 * 回归用例全部来自真实观测，不是编的：
 *   drift-*.json  = 2026-09-09 三方对照实测中 LLM 的实际违规产出
 *   clean-strict  = strict schema 路径的合规产出（不能被归一化改坏）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFacet, parseLoose, coerceCount, coerceText, mapKey } from '../src/schema/normalize.mjs';
import { FRICTION, GOAL_CATEGORIES, OUTCOME, SESSION_TYPE } from '../src/schema/facet.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const raw = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('契约：归一化后 key 集合永远闭合', () => {
  for (const f of ['clean-strict.json', 'drift-boolean.json', 'drift-boolean-and-list.json',
                   'drift-dict-detail.json', 'drift-list-detail.json', 'drift-synonym-fragments.json']) {
    const { facet } = normalizeFacet(fx(f));
    assert.deepEqual(Object.keys(facet.friction_counts).sort(), [...FRICTION].sort(), `${f}: friction keys`);
    assert.deepEqual(Object.keys(facet.goal_categories).sort(), [...GOAL_CATEGORIES].sort(), `${f}: goal keys`);
  }
});

test('契约：所有计数值都是非负整数', () => {
  for (const f of ['drift-boolean.json', 'drift-boolean-and-list.json', 'drift-synonym-fragments.json']) {
    const { facet } = normalizeFacet(fx(f));
    for (const field of ['friction_counts', 'goal_categories']) {
      for (const [k, v] of Object.entries(facet[field])) {
        assert.ok(Number.isInteger(v) && v >= 0, `${f}: ${field}.${k} = ${JSON.stringify(v)}`);
      }
    }
  }
});

test('实测形态①：goal_categories 整体漂成 boolean → 强制为 0/1', () => {
  const { facet, repairs } = normalizeFacet(fx('drift-boolean.json'));
  assert.ok(Object.values(facet.goal_categories).every(Number.isInteger));
  assert.ok(repairs.coerced_types.some((r) => r.includes('-> int')), '应记录类型强转');
});

test('实测形态②：friction_detail 漂成 array → 拼成 string', () => {
  const { facet, repairs } = normalizeFacet(fx('drift-list-detail.json'));
  assert.equal(typeof facet.friction_detail, 'string');
  assert.ok(facet.friction_detail.length > 0, '不能把内容丢掉');
  assert.ok(repairs.coerced_types.some((r) => r.startsWith('friction_detail')));
});

test('实测形态③：friction_detail 漂成 dict → 拼成 string', () => {
  const { facet } = normalizeFacet(fx('drift-dict-detail.json'));
  assert.equal(typeof facet.friction_detail, 'string');
  assert.ok(facet.friction_detail.length > 0);
});

test('核心价值：同义词碎片合并，修「工具类被低估 32%」', () => {
  const { facet } = normalizeFacet(fx('drift-synonym-fragments.json'));
  // tool_failure 17 + tool_limitation 4 + tool_automation_failure 4 = 25
  assert.equal(facet.friction_counts.tool_failed, 25, '工具类必须合并成 25，不是 17');
  // environment_issues 6 + environment_issue 6 + environment_setup 3
  //   + tooling_environment_issues 3 + tool_environment_issues 2 = 20
  assert.equal(facet.friction_counts.external_issue, 20, '环境类 5 个碎片必须合并成 20');
  assert.equal(facet.friction_counts.buggy_code, 62, '已在表内的不能被改动');
});

test('表外 key 不静默吞掉，进 repairs 供审计', () => {
  const { repairs } = normalizeFacet(fx('drift-synonym-fragments.json'));
  assert.ok(repairs.unmapped_keys.some((k) => k.includes('完全没见过的类')),
    '映射不上的 key 必须被记录');
});

test('枚举大小写/连字符变体能归位', () => {
  const { facet } = normalizeFacet(fx('drift-synonym-fragments.json'));
  assert.equal(facet.outcome, 'mostly_achieved', '"MOSTLY ACHIEVED" 应归位');
  assert.equal(facet.session_type, 'multi_task', '"multi-task" 应归位');
});

test('clean 输入不被归一化改坏（幂等）', () => {
  const src = fx('clean-strict.json');
  const { facet, repairs } = normalizeFacet(src);
  assert.equal(facet.outcome, src.outcome);
  assert.equal(facet.session_type, src.session_type);
  assert.equal(repairs.unmapped_keys.length, 0, 'clean 输入不该有未映射 key');
  const again = normalizeFacet(facet).facet;
  assert.deepEqual(again.friction_counts, facet.friction_counts, '归一化必须幂等');
});

test('parseLoose：剥 markdown 围栏 + 截断补全', () => {
  const r = parseLoose(raw('drift-truncated.txt'));
  assert.ok(r.ok, `截断 JSON 应能修复: ${r.error || ''}`);
  assert.equal(r.value.outcome, 'mostly_achieved');
  assert.equal(r.value.friction_counts.buggy_code, 3);
});

test('parseLoose：尾逗号 / 前后噪声文本', () => {
  assert.ok(parseLoose('Here you go:\n{"a":1,}\nHope this helps').ok);
  assert.equal(parseLoose('no json here').ok, false);
});

test('coerce 边界', () => {
  assert.equal(coerceCount(true), 1);
  assert.equal(coerceCount(false), 0);
  assert.equal(coerceCount('3'), 3);
  assert.equal(coerceCount(-5), 0, '负数钳到 0');
  assert.equal(coerceCount(2.6), 3);
  assert.equal(coerceCount(['a', 'b']), 2, '证据数组取条数');
  assert.equal(coerceCount({}), null, '无法转换应返回 null 而非猜');
  assert.equal(coerceText(['a', 'b']), 'a; b');
  assert.equal(coerceText(null), '');
});

test('mapKey 不做过度匹配（防误合并）', () => {
  assert.equal(mapKey('buggy_code', FRICTION), 'buggy_code');
  assert.equal(mapKey('tool_failure', FRICTION), 'tool_failed');
  assert.equal(mapKey('completely_unrelated_thing', FRICTION), null,
    '差太远的必须返回 null，不能硬凑');
});
