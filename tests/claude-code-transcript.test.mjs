import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscript, transcriptIndex, parse, _resetIndex, metaDir } from '../src/providers/claude-code.mjs';

/**
 * 造一个假的 ~/.claude/projects 树。
 * 传入 t 时用 t.after 注册清理——裸写在测试体末尾的 rmSync 在断言抛出时不会执行，
 * 实测在系统 tmpdir 里留下过真实的 adi-cc-* 遗留目录。
 */
function fixture(lines, { nested = false, t = null, name = 'sess-1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adi-cc-'));
  const dir = nested ? join(root, 'proj', 'deep', 'deeper') : join(root, 'proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), lines.map((o) => JSON.stringify(o)).join('\n'));
  if (t) t.after(() => rmSync(root, { recursive: true, force: true }));
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

// ── 以下是 review 指出的覆盖缺口：截断策略、去重取大、parse() 集成、tool 合并、sidechain 口径

test('🔴 行数超限时保首尾，不能只取前 N 行（结尾是验收边界）', (t) => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(U(`第 ${i} 条`));
  lines.push(U('最后这句是验收：这样就可以了'));
  const root = fixture(lines, { t });
  const r = readTranscript('sess-1', { root, maxLines: 20 });
  assert.equal(r.transcript.length, 20);
  assert.ok(r.truncatedLines > 0, '应报告略去了多少行');
  assert.ok(r.transcript[0].includes('第 0 条'), '开头要在');
  assert.ok(r.transcript[r.transcript.length - 1].includes('这样就可以了'), '🔴 结尾必须在');
  assert.ok(r.transcript.some((l) => l.startsWith('[… 略去中段')), '中段要有省略标记');
});

test('未超限时不截断，truncatedLines 为 0', (t) => {
  const root = fixture([U('一'), U('二')], { t });
  const r = readTranscript('sess-1', { root, maxLines: 20 });
  assert.equal(r.truncatedLines, 0);
  assert.equal(r.transcript.length, 2);
});

test('同一条 assistant 消息里的多个 tool_use 合并成一行（省出行预算给对话）', (t) => {
  const root = fixture([
    U('干活'),
    A([{ type: 'tool_use', name: 'Bash' }, { type: 'tool_use', name: 'Read' },
       { type: 'text', text: '看完了' }, { type: 'tool_use', name: 'Edit' }]),
  ], { t });
  const { transcript } = readTranscript('sess-1', { root });
  assert.deepEqual(transcript, [
    '[user] 干活', '[tool] Bash, Read', '[assistant] 看完了', '[tool] Edit',
  ]);
});

test('🔴 sidechain 数的是子代理的用户消息，不是 jsonl 行', (t) => {
  const root = fixture([
    U('人说的话'),
    { type: 'user', isSidechain: true, message: { content: '控制器写的任务书' } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '子代理回话' }] } },
    { type: 'summary', isSidechain: true, summary: 'x' },
  ], { t });
  const r = readTranscript('sess-1', { root });
  assert.equal(r.sidechainMessages, 1, '3 行带标记，但只有 1 行是子代理的用户消息');
  assert.equal(r.transcript.length, 1);
});

test('🔴 同名会话取体积最大的那份', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'adi-cc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [dir, n] of [['a', 2], ['z', 40]]) {
    mkdirSync(join(root, dir), { recursive: true });
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(JSON.stringify(U(`内容 ${i}`)));
    writeFileSync(join(root, dir, 'dup.jsonl'), rows.join('\n'));
  }
  const got = readTranscript('dup', { root });
  assert.equal(got.transcript.length, 40, '两个同名文件应取行数多（体积大）的那份');
});

test('🔴 parse() 集成：接上正文、如实标记 complete、读不到时退回 first_prompt', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'adi-cc-home-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
    _resetIndex();
  });
  mkdirSync(join(home, 'projects', 'p'), { recursive: true });
  writeFileSync(join(home, 'projects', 'p', 'S1.jsonl'),
    [U('真实诉求在这里'), A([{ type: 'text', text: '好的' }])].map((o) => JSON.stringify(o)).join('\n'));
  mkdirSync(join(home, 'usage-data', 'session-meta'), { recursive: true });
  const meta = (id) => {
    const f = join(home, 'usage-data', 'session-meta', `${id}.json`);
    writeFileSync(f, JSON.stringify({
      session_id: id, start_time: new Date().toISOString(), user_message_count: 9,
      tool_counts: { Bash: 3 }, tool_errors: 1, first_prompt: '官方只给这一条',
    }));
    return f;
  };
  process.env.CLAUDE_CONFIG_DIR = home;
  _resetIndex();

  const hit = parse(meta('S1'));
  assert.ok(hit.transcript.some((l) => l.includes('真实诉求在这里')), '应接上 jsonl 正文');
  assert.equal(hit.transcriptComplete, true);
  assert.equal(hit.userMessages, 9, '🔴 计数必须来自官方 meta，不能由 jsonl 重算');

  const missShaped = parse(meta('S-none'));
  assert.equal(missShaped.transcriptComplete, false);
  assert.ok(missShaped.transcript[0].includes('官方只给这一条'), '读不到正文时退回 first_prompt');
});
