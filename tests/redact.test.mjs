import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, auditRedaction } from '../src/redact.mjs';

test('脱敏：真实命中过的形态', () => {
  const jwt = 'eyJ1c2VyX2lkIjoiNzI1OTU3OTI5NjMzMzc5MTIzNCIsImRldmljZQ.eyJhbGciOiJIUzI1NiJ9.abc123';
  const cases = [
    `https://example.com/wiki/A?disposable_login_token=${jwt}&from=search`,
    'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
    'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'contact bob.smith@example.com for access',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
  ];
  for (const c of cases) {
    const out = redact(c);
    assert.equal(auditRedaction(out).length, 0, `未脱净: ${c.slice(0, 45)} -> ${out.slice(0, 70)}`);
  }
});

test('脱敏不误伤正常内容', () => {
  const normal = '把 lx_orders 的 purchase_date 按 PT 时区聚合，然后跑 npm test';
  assert.equal(redact(normal), normal, '普通中英文技术描述不应被改动');
  assert.equal(redact('会话数 394，facet 54 份'), '会话数 394，facet 54 份');
});

test('脱敏幂等：跑两遍结果一致', () => {
  const s = 'key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456 and me@example.com';
  const once = redact(s);
  assert.equal(redact(once), once, '二次脱敏不应再改动（占位符不能被兜底规则再吃一次）');
});

test('脱敏对空值安全', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
  assert.equal(redact(''), '');
});
