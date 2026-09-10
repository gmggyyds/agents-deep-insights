#!/usr/bin/env node
/** agents-deep-insights CLI —— 命令分层见 docs/DESIGN.md §9.3 */
import * as fs from 'node:fs';
globalThis.__adi_fs = fs;
import { version } from './version.mjs';
import * as codex from './providers/codex.mjs';
import * as cc from './providers/claude-code.mjs';
import { aggregateMetas } from './pipeline/aggregate.mjs';
import { renderStats } from './render/stats.mjs';
import { collect, probeSchema, renderIssue } from './doctor.mjs';
import { stratifiedSample } from './pipeline/sample.mjs';
import { aggregateFacets } from './pipeline/aggregate.mjs';
import { labelWithCodex, compactTranscript } from './pipeline/label.mjs';
import { renderHtml } from './render/html.mjs';
import { synthesize, translateNarrative } from './pipeline/synthesize.mjs';
import { createHash } from 'node:crypto';
import { facetSchema } from './schema/facet.mjs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const CACHE = join(process.env.ADI_CACHE || join(homedir(), '.agents-deep-insights'), 'facets');
// 指纹必须包含转录内容本身。此前只用长度，内容变了但长度不变会命中旧缓存、
// 复用过时结果（外部测试发现："Need AAA" -> "Need BBB" 指纹不变）。
//
// 契约版本从 facetSchema() 自身派生，不再手写 `v5|` 这类常量。
// 手写版本号是「靠人记得改」的机制：2026-09-10 给 facet 加 collaboration_mode_counts
// 时就漏了 bump——6 个会话全部命中旧缓存，新字段静默为空，报告里整段消失，
// 而单元测试全绿（测的是聚合逻辑，喂的是手写 facet，碰不到缓存这条路）。
// 现在改任何一处 facet 契约，指纹自动变化，旧缓存自动失效。
export const SCHEMA_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify(facetSchema())).digest('hex').slice(0, 8);
const fingerprint = (m) => createHash('sha256')
  .update(`${SCHEMA_FINGERPRINT}|${m.provider}|${m.id}|${m.userMessages}|${m.toolCalls}|`)
  .update(compactTranscript(m.transcript || []))
  .digest('hex').slice(0, 16);

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) || 'stats';
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? true); };
const has = (n) => argv.includes(`--${n}`);

const PROVIDERS = { codex, 'claude-code': cc };

function loadMetas(days, only) {
  const used = [], warnings = [];
  let metas = [];
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (only && only !== name) continue;
    const found = p.discover({ days });
    if (!found.length) continue;
    used.push(name);
    const parsed = found.map((f) => p.parse(f.path)).filter(Boolean);
    if (parsed.length < found.length) warnings.push(`${name}: ${found.length - parsed.length} 个文件解析失败已跳过`);
    metas = metas.concat(parsed);
  }
  return { metas, used, warnings };
}

function help() {
  console.log(`
  agents-deep-insights (adi) v${version()}
  把本地 AI 编码会话变成可行动的摩擦报告。
  stats / doctor 完全本地不联网；run 会把脱敏后的会话片段发给你自己配置的模型。

  adi stats            纯统计，零 LLM、零网络、零额度（默认）
  adi doctor           环境自检；--issue 输出可直接贴 GitHub 的 markdown
  adi run              完整分析（调用 LLM，消耗你自己的订阅额度）
                       --limit <n>   分析多少个会话，默认 30
                       --model <m>   指定模型（Codex 版本旧时用 gpt-5.5）
                       --out <path>  报告输出路径
                       --no-schema   降级到 prompt-only（不推荐）
                       --no-open     不自动打开浏览器
                       --no-narrative 跳过叙事合成，只出统计（省一次调用）
                       --no-english   不生成英文版（省一次调用）

  --days <n>           时间窗，默认 30；0 表示全部
  --provider <name>    只用某个数据源：codex | claude-code
  --json               机器可读输出
`);
}

async function main() {
  if (has('help') || cmd === 'help') return help();
  const days = Number(flag('days', 30));
  const only = flag('provider');

  if (cmd === 'doctor') {
    const d = collect();
    if (has('probe')) d.schemaProbe = probeSchema();
    if (has('issue')) return console.log(renderIssue(d, d.schemaProbe));
    if (has('json')) return console.log(JSON.stringify(d, null, 2));
    console.log('\n  adi doctor\n  ' + '─'.repeat(52));
    console.log(`  OS        ${d.env.os}   Node ${d.env.node}`);
    console.log(`  Codex     ${d.codex.installed ? d.codex.version : '未安装'}`);
    console.log(`  Claude    ${d.claudeCode.installed ? d.claudeCode.version : '未安装'}`);
    console.log(`  sqlite3   ${d.sqlite3 ? '可用' : '缺失（降级扫目录）'}`);
    console.log(`  会话数    codex ${d.counts.codexSessions30d}/${d.counts.codexSessionsAll}（30天/全部）`);
    console.log(`            claude-code ${d.counts.claudeMeta30d}/${d.counts.claudeMetaAll}`);
    if (d.problems.length) { console.log('\n  问题:'); for (const p of d.problems) console.log(`    ${p.code}  ${p.hint}`); }
    else console.log('\n  未发现问题。');
    console.log('\n  提 issue 时请附上：adi doctor --issue\n');
    return;
  }

  if (cmd === 'stats') {
    const { metas, used, warnings } = loadMetas(days, only);
    if (!metas.length) {
      // 区分「完全没有数据」和「这个时间窗内没有数据」——后者提示查数据源是误导
      const anywhere = days > 0 ? loadMetas(0, only).metas.length : 0;
      if (anywhere > 0) {
        console.error(`\n  近 ${days} 天内没有会话，但更早的时间里有 ${anywhere} 个。`);
        console.error(`  放宽时间窗试试：\`adi stats --days 30\`，或 \`--days 0\` 看全部。\n`);
      } else {
        console.error('\n  没找到任何会话记录。跑 `adi doctor` 看看数据源在不在。\n');
      }
      process.exitCode = 1; return;
    }
    const a = aggregateMetas(metas);
    if (has('json')) return console.log(JSON.stringify({ window: days, providers: used, ...a }, null, 2));
    console.log(renderStats(a, { providers: used, windowDays: days, warnings }));
    return;
  }

  if (cmd === 'run') {
    const { metas, used, warnings } = loadMetas(days, only);
    const withText = metas.filter((m) => (m.transcript || []).length > 1);
    if (!withText.length) {
      if (!metas.length) {
        console.error(`\n  近 ${days} 天内没找到任何会话记录。`);
        console.error('  试试放宽时间窗：`adi run --days 0`，或跑 `adi doctor` 查看数据源。\n');
      } else {
        console.error(`\n  找到 ${metas.length} 个会话，但没有一个带可读的对话内容。`);
        console.error('  Claude Code 的官方 session-meta 只含元数据、不含对话，深度分析目前只支持 Codex 会话。');
        console.error('  如果你有 Codex 会话，试试 `adi run --provider codex --days 0`。\n');
      }
      process.exitCode = 1; return;
    }
    const quota = Number(flag('limit', 30));
    const { picked } = stratifiedSample(withText, quota);
    const model = flag('model');
    const strict = !has('no-schema');
    fs.mkdirSync(CACHE, { recursive: true });

    console.log(`\n  分析 ${picked.length} 个会话（从 ${withText.length} 个候选中分层采样）`);
    console.log(`  provider: codex${model ? ' · model ' + model : ''}${strict ? ' · strict schema' : ' · prompt-only（降级）'}`);
    console.log('  会调用 LLM 并消耗你自己的订阅额度。Ctrl-C 可随时中断，已完成的会缓存。\n');

    const facets = []; let repairsCount = 0, fresh = 0, cached = 0, failed = 0; let firstErr = null;
    for (let i = 0; i < picked.length; i++) {
      const m = picked[i];
      const cf = join(CACHE, `${fingerprint(m)}.json`);
      let r = null;
      if (fs.existsSync(cf)) { try { r = JSON.parse(fs.readFileSync(cf, 'utf8')); cached++; } catch {} }
      if (!r) {
        process.stdout.write(`  [${i + 1}/${picked.length}] 打标中…\r`);
        const out = labelWithCodex(m, { model, strict });
        if (!out.ok) {
          failed++; firstErr ||= out;
          if (failed === 1 && out.code === 'E_CODEX_TOO_OLD') {
            console.error(`\n  ${out.code}: Codex 版本过旧，跑不了账号默认模型。`);
            console.error('  解决：升级 `codex update`，或指定旧模型 `adi run --model gpt-5.5`\n');
            process.exitCode = 1; return;
          }
          continue;
        }
        r = { facet: { ...out.facet, session_id: m.id }, repairs: out.repairs };
        try { fs.writeFileSync(cf, JSON.stringify(r)); } catch {}
        fresh++;
      }
      facets.push({ ...r.facet, session_id: r.facet.session_id || m.id });
      repairsCount += (r.repairs?.unmapped_keys?.length || 0) + (r.repairs?.coerced_types?.length || 0);
      process.stdout.write(`  [${i + 1}/${picked.length}] 已完成（新 ${fresh} · 缓存 ${cached} · 失败 ${failed}）      \r`);
    }
    console.log('\n');
    if (!facets.length) {
      console.error(`  全部打标失败。${firstErr ? firstErr.code + ': ' + (firstErr.detail || '').slice(0, 160) : ''}`);
      console.error('  请跑 `adi doctor --issue` 并提 issue。\n');
      process.exitCode = 1; return;
    }
    const metaAgg = aggregateMetas(metas);
    const facetAgg = aggregateFacets(facets, { metas: picked });

    // L5 叙事合成：数字已算好，这一层只把它们写成人话 + 引用具体证据。
    // 缺了它，产出就只是一张统计报表。
    let narrative = null;
    if (!has('no-narrative')) {
      process.stdout.write('  正在合成叙事…\r');
      const syn = synthesize(facetAgg, facets, { model, posture: metaAgg });
      if (syn.ok) { narrative = syn.narrative; console.log('  叙事已合成                    '); }
      else {
        console.log(`  叙事合成失败（${syn.code}），退回纯统计报告`);
        if (syn.detail) console.log(`    ${syn.detail.split('\n')[0].slice(0, 160)}`);
        console.log('    可用 --no-narrative 跳过这一步，或跑 `adi doctor --issue` 提 issue');
      }
    }
    // 英文版：翻译而非重新生成，保证中英两版讲同一件事。
    // 默认开；--no-english 关掉（省一次模型调用）。
    let narrativeEn = null;
    if (narrative && !has('no-english')) {
      process.stdout.write('  正在生成英文版…\r');
      const tr = translateNarrative(narrative, { model });
      if (tr.ok) { narrativeEn = tr.narrative; console.log('  英文版已生成                  '); }
      else console.log(`  英文版生成失败（${tr.code}），只输出中文`);
    }
    const days_ = picked.map((m) => m.startedAt).filter(Boolean);
    const spanDays = days_.length ? Math.round((Math.max(...days_) - Math.min(...days_)) / 864e5) : 0;
    const html = renderHtml({ metaAgg, facetAgg, narrative, narrativeEn, meta: {
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',  // 标时区，否则本地时间会被误读
      providers: used, windowDays: days, spanDays, version: version(), repairsCount } });
    const out = String(flag('out', join(process.cwd(), 'adi-report.html')));
    fs.writeFileSync(out, html);
    console.log(`  报告已生成: ${out}`);
    if (failed) console.log(`  ${failed} 个会话打标失败（已跳过）。细节见 \`adi doctor\``);
    if (repairsCount) console.log(`  归一化修复了 ${repairsCount} 处模型输出偏差`);
    if (!has('no-open')) { try { execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [out], { stdio: 'ignore' }); } catch {} }
    console.log('');
    return;
  }
  help(); process.exitCode = 1;
}
main().catch((e) => { console.error('\n  内部错误:', e.message, '\n  请跑 `adi doctor --issue` 并提 issue。\n'); process.exitCode = 1; });
