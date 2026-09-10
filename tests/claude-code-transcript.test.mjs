import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscript, transcriptIndex } from '../src/providers/claude-code.mjs';

/** 造一个假的 ~/.claude/projects 树 */
function fixture(lines, { nested = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adi-cc-'));
  const dir = nested ? join(root, 'proj', 'deep', 'deeper') : join(root, 'proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sess-1.jsonl'), lines.map((o) => JSON.stringify(o)).join('\n'));
  return root;
}
const U = (content, extra = {}) => ({ type: 'user', message: { content }, ...extra });
const A = (blocks) => ({ type: 'assistant', message: { content: blocks } });

test('三种 content 形态都能取到文本（漏了 list 形态就会丢掉贴图提问）', () => {
  const root = fixture([
    U('纯文本问题，这样对吗'),
    U([{ type: 'text', text: '列表形态的问题' }]),
    U([{ type: 'image' }, { type: 'text', text: '贴图加提问，还有什么我没想到的' }]),
  ]);
  const { transcript } = readTranscript('sess-1', { root });
  assert.equal(transcript.length, 3);
  assert.ok(transcript[2].includes('还有什么我没想到的'));
  rmSync(root, { recursive: true, force: true });
});

test('🔴 isMeta / isCompactSummary / isSidechain 三个结构化标记都必须挡住', () => {
  const root = fixture([
    U('这是人打的字，要保留'),
    U([{ type: 'text', text: '[Image: original 2480x1760…]' }], { isMeta: true }),
    U([{ type: 'text', text: '# Some Skill\n\n文档全文…' }], { isMeta: true }),
    U('This session is being continued…', { isCompactSummary: true }),
    U('子代理的任务书', { isSidechain: true }),
  ]);
  const r = readTranscript('sess-1', { root });
  assert.equal(r.transcript.length, 1, '只应留下人打的那一条');
  assert.ok(r.transcript[0].includes('这是人打的字'));
  assert.equal(r.injectedMessages, 3);
  assert.equal(r.sidechainMessages, 1);
  rmSync(root, { recursive: true, force: true });
});

test('tool_result 不是人说的话', () => {
  const root = fixture([
    U([{ type: 'tool_result', tool_use_id: 'x', content: 'Exit code 0' }]),
    U('真正的问题'),
  ]);
  const { transcript } = readTranscript('sess-1', { root });
  assert.equal(transcript.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('assistant 文本与 tool_use 转成 codex 同形状的行', () => {
  const root = fixture([
    U('干这个'),
    A([{ type: 'text', text: '好的，我先看一下' }, { type: 'tool_use', name: 'Bash' }]),
  ]);
  const { transcript } = readTranscript('sess-1', { root });
  assert.deepEqual(transcript.map((l) => l.split(']')[0] + ']'), ['[user]', '[assistant]', '[tool]']);
  assert.ok(transcript[2].endsWith('Bash'));
  rmSync(root, { recursive: true, force: true });
});

test('🔴 索引必须递归到深层目录（实测一半 jsonl 在更深层，只扫两层会漏掉）', () => {
  const root = fixture([U('深层目录里的会话')], { nested: true });
  assert.equal(transcriptIndex(root).size, 1, '嵌套三层的 jsonl 也要被索引到');
  assert.equal(readTranscript('sess-1', { root }).transcript.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('文本前缀兜底：旧版本 jsonl 没有 isMeta 字段时仍要挡住注入', () => {
  const root = fixture([
    U('<system-reminder>别把我当用户输入</system-reminder>'),
    U('<command-message>insights</command-message>'),
    U('Base directory for this skill: /x/y'),
    U('这句要留下'),
  ]);
  const { transcript } = readTranscript('sess-1', { root });
  assert.equal(transcript.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('会话不存在时返回空，不抛错', () => {
  const root = fixture([U('x')]);
  const r = readTranscript('no-such-session', { root });
  assert.deepEqual(r.transcript, []);
  rmSync(root, { recursive: true, force: true });
});
