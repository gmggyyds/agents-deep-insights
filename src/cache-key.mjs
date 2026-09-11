/**
 * 打标缓存的键。抽成独立模块有两个原因：
 *   1) cli.mjs 有顶层副作用，测试没法 import 它来验证键的行为；
 *   2) 键里的「契约版本」必须自动派生，不能靠人记得改。
 *
 * 派生源必须覆盖**所有会改变打标结果的东西**，不只是 schema 形状：
 *   facetSchema()  字段增删、枚举变化
 *   TASK           打标规则本身（把多标签改成单标签会直接改变全部计数）
 *   ALIASES        归一化映射（normalize 在写缓存之前跑，旧缓存里已是旧映射的结果）
 *
 * 历史：这里原本是手写常量 `v5|`，靠人记得在改 schema 时 bump。2026-09-10 加
 * collaboration_mode_counts 时漏了，6 个会话全部命中旧缓存、新字段静默为空、
 * 报告整段消失，而单元测试全绿。第一次修只 hash 了 facetSchema()——审查指出
 * 那样改 TASK/ALIASES 仍然不会失效，同一个 bug 换个入口原样复发。
 */
import { createHash } from 'node:crypto';
import { facetSchema, ALIASES } from './schema/facet.mjs';
import { TASK } from './pipeline/label.mjs';

export const SCHEMA_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify(facetSchema()))
  .update(TASK)
  .update(JSON.stringify(ALIASES))
  .digest('hex').slice(0, 8);

/**
 * 会话打标结果的缓存键。
 * 指纹必须包含转录内容本身：此前只用长度，内容变了但长度不变会命中旧缓存
 * （外部测试发现："Need AAA" -> "Need BBB" 指纹不变）。
 */
export function cacheKey(m, compactTranscript) {
  return createHash('sha256')
    .update(`${SCHEMA_FINGERPRINT}|${m.provider}|${m.id}|${m.userMessages}|${m.toolCalls}|`)
    .update(compactTranscript(m.transcript || []))
    .digest('hex').slice(0, 16);
}
