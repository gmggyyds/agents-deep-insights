import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stratifiedSample, isSubstantive } from '../src/pipeline/sample.mjs';

const DAY = 864e5;
function mk(daysAgo, umsg = 5) {
  return { startedAt: Date.now() - daysAgo * DAY, userMessages: umsg, durationMinutes: 10 };
}

test('substantive 门槛滤掉单轮噪声', () => {
  assert.equal(isSubstantive({ userMessages: 1, durationMinutes: 10 }), false);
  assert.equal(isSubstantive({ userMessages: 5, durationMinutes: 0 }), false);
  assert.equal(isSubstantive({ userMessages: 2, durationMinutes: 1 }), true);
});

test('核心：分层采样比「取最近 N」覆盖更宽的时间窗（样本量相同）', () => {
  // 造一个重度用户：近 7 天极密集，早 3 周稀疏 —— 正是官方塌缩的场景
  const metas = [
    ...Array.from({ length: 120 }, (_, i) => mk(i % 7)),
    ...Array.from({ length: 30 }, (_, i) => mk(8 + i)),
  ];
  const quota = 50;
  const recent = [...metas].sort((a, b) => b.startedAt - a.startedAt).slice(0, quota);
  const { picked } = stratifiedSample(metas, quota);

  assert.equal(picked.length, quota, '样本量必须打满，不能因分桶而变少');
  const spanOf = (l) => (Math.max(...l.map(m => m.startedAt)) - Math.min(...l.map(m => m.startedAt))) / DAY;
  assert.ok(spanOf(picked) > spanOf(recent) * 2,
    `分层采样跨度应显著更宽: 分层 ${spanOf(picked).toFixed(1)}d vs 最近N ${spanOf(recent).toFixed(1)}d`);
});

test('候选不足 quota 时全取，不报错', () => {
  const metas = Array.from({ length: 7 }, (_, i) => mk(i));
  const { picked, truncated } = stratifiedSample(metas, 50);
  assert.equal(picked.length, 7);
  assert.equal(truncated, false);
});

test('空输入安全', () => {
  const { picked } = stratifiedSample([], 50);
  assert.equal(picked.length, 0);
});

test('某桶候选不足时余额还给其他桶（不浪费名额）', () => {
  // 一周只有 1 个，另一周有 100 个 —— 名额必须流向有货的桶
  const metas = [mk(20), ...Array.from({ length: 100 }, () => mk(1))];
  const { picked } = stratifiedSample(metas, 30);
  assert.equal(picked.length, 30, '不能因为某桶只有 1 个就少取');
});
