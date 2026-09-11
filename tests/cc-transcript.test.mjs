import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscript, transcriptIndex } from '../src/providers/cc-transcript.mjs';

/** 造一个假的 ~/.claude/projects 树；用 t.after 清理，断言抛出时也不会留垃圾。 */
function fixture(rows, t, { name = 'sess-1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adi-cct-'));
  const dir = join(root, 'p');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), rows.map((o) => JSON.stringify(o)).join('\n'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const U = (content, extra = {}) => ({
  type: 'user', message: { role: 'user', content }, ...extra,
});
const A = (blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const read = (root, opts = {}) => readTranscript('sess-1', { root, ...opts });

test('🔴 isMeta / isCompactSummary 必须挡住——只靠文本正则会把注入当成用户诉求', (t) => {
  const root = fixture([
    U('这是人打的字，要保留'),
    U([{ type: 'text', text: '[Image: original 2480x1760, displayed at …]' }], { isMeta: true }),
    U([{ type: 'text', text: '# Some Skill\n\n文档全文……' }], { isMeta: true }),
    U('(Re-invocation of /some-skill — instructions previously loaded)', { isMeta: true }),
    U('This session is being continued from a previous conversation…', { isCompactSummary: true }),
  ], t);
  const r = read(root);
  const users = r.transcript.filter((l) => l.startsWith('[user]'));
  assert.equal(users.length, 1, '五条里只有一条是人说的话');
  assert.ok(users[0].includes('这是人打的字'));
  assert.equal(r.stats.injectedRows, 4);
  assert.equal(r.stats.userMessages, 1, '计数也不能把注入算进去');
});

test('🔴 子代理的行不计入协作，但要如实记数', (t) => {
  const root = fixture([
    U('人说的话'),
    { type: 'user', isSidechain: true, message: { role: 'user', content: '控制器写的任务书' } },
  ], t);
  const r = read(root);
  assert.equal(r.transcript.filter((l) => l.startsWith('[user]')).length, 1);
  assert.equal(r.stats.sidechainLines, 1);
});

test('🔴 行数超限时保首尾，不能只取前 N 行（结尾是验收边界）', (t) => {
  const rows = [];
  for (let i = 0; i < 80; i++) rows.push(U(`第 ${i} 条`));
  rows.push(U('最后这句是验收：这样就可以了'));
  const root = fixture(rows, t);
  const r = read(root, { maxLines: 20 });
  assert.equal(r.transcript.length, 20);
  assert.ok(r.stats.truncatedLines > 0);
  assert.ok(r.transcript[0].includes('第 0 条'), '开头要在');
  assert.ok(r.transcript.at(-1).includes('这样就可以了'), '🔴 结尾必须在');
  assert.ok(r.transcript.some((l) => l.startsWith('[… 略去中段')));
});

test('未超限时不截断', (t) => {
  const root = fixture([U('一'), U('二')], t);
  const r = read(root, { maxLines: 20 });
  assert.equal(r.stats.truncatedLines, 0);
});

test('相邻工具调用并成一行，省出预算给对话', (t) => {
  const root = fixture([
    U('干活'),
    A([{ type: 'tool_use', name: 'Bash' }, { type: 'tool_use', name: 'Read' }]),
    A([{ type: 'tool_use', name: 'Edit' }, { type: 'text', text: '改完了' }]),
  ], t);
  const { transcript } = read(root);
  assert.deepEqual(transcript, ['[user] 干活', '[tool] Bash, Read, Edit', '[assistant] 改完了']);
});

test('单字回应必须保留——中文里「好」「对」「停」就是完整回应', (t) => {
  const root = fixture([U('好'), U('对'), U('停')], t);
  assert.equal(read(root).transcript.filter((l) => l.startsWith('[user]')).length, 3);
});

test('索引只扫一层：同名会话取体积最大的那份', (t) => {
  // 不递归是刻意的（深层是子代理记录），见 external-findings 里的同名测试。
  // 这里只验一层内的同名去重。
  const root = mkdtempSync(join(tmpdir(), 'adi-cct-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [dir, n] of [['a', 2], ['z', 40]]) {
    mkdirSync(join(root, dir), { recursive: true });
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(JSON.stringify(U(`内容 ${i}`)));
    writeFileSync(join(root, dir, 'dup.jsonl'), rows.join('\n'));
  }
  assert.equal(readTranscript('dup', { root }).transcript.length, 40, '应取行数多的那份');
});

test('会话不存在时返回 null，不抛错', (t) => {
  const root = fixture([U('x')], t);
  assert.equal(readTranscript('no-such', { root }), null);
});
