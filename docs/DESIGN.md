# agents-deep-insights — 设计文档

> 状态：v0.1.0 设计定稿 · 2026-09-09
> 这份文档是实现契约，不是宣传材料。改实现前先改这里。

## 1. 要解决什么

把 AI 编码 agent 的本地会话记录，变成一份**可累加、可纵向对比**的摩擦报告。

两个具体缺口：

- **Codex 没有任何内置的 insights 能力**。Claude Code 有 `/insights`，Codex 一片空白。
- **Claude Code 官方 `/insights` 有三个已实测的洞**（证据见 §2）：
  1. 枚举只写在 prompt、不进 JSON Schema，且输出侧无校验 → 类目漂移
  2. 采样取「最近约 50 个」，重度用户会时间窗塌缩（宣称 30 天，实测覆盖 17 天）
  3. 摩擦混报，不区分「用户能改的」和「模型/环境的锅」，读者无法行动

## 2. 实测证据（决定设计的三组数据）

### 2.1 枚举漂移（本机 394 份 session-meta / 54 份 facet）

| 字段 | 官方 bundle 里定义 | 实际产出 |
|---|--:|--:|
| `friction_counts` | 12 类 | **35 类** |
| `goal_categories` | 12 类 | **171 类** |
| `outcome` / `session_type` / `helpfulness` / `primary_success` | 5/5/5/7 | 4/4/4/6（未漂） |

漂移只发生在 `dict<key,int>` 字段上——因为 LLM 生成的是 key，不是从候选里选。
同义词碎片直接改排序：工具类摩擦真实 25（`tool_failure` 17 + `tool_limitation` 4 +
`tool_automation_failure` 4），报告只显示 17，**低估 32%**。而官方枚举里写的是
`tool_failed`，一次都没被用过。

### 2.2 三方对照实测（同一段会话各跑 3 次）

```
                          run0    run1    run2   违规/3
codex strict-schema          ✓       ✓       ✓   0/3
codex prompt-only            ✗       ✗       ✓   2/3
ChatGPT 网页版                ✓       ✗       ✗   2/3
```

违规形态**不是**「造新词」，而是**类型漂移**，共观测到三种：

- `goal_categories` 的值给成 `true/false`（应为 integer）→ `sum()` 把 true 当 1
- `friction_detail` 给成 `[...]`（应为 string）→ 下游 `.strip()` 崩
- `friction_detail` 给成 `{...}`（应为 string）

**类型漂移比 key 漂移更危险**：key 全对，浅校验放行，然后在聚合层静默算错。

### 2.3 strict schema 的额外收益：判断方差也降了

| | outcome 三次 | session_type 三次 |
|---|---|---|
| codex strict-schema | **全同** | **全同** |
| codex prompt-only | 2 种 | 1 种 |
| ChatGPT 网页版 | 2 种 | 2 种 |

原因：`enum` 把任务从「发明一个标签」变成「从 N 个里选一个」，选择空间收窄。
但**只稳住分类字段**；计数字段仍有 ±1 噪声（12 类中 4 类在三次间变动，幅度均为 ±1）。

## 3. 架构

```
L0 发现    provider 接口，各 agent 一个实现
L1 提取    纯代码 → session-meta（零 LLM）
L2 采样    按周分桶 + 桶内均匀抽（不是「取最近 N」）
L3 打标    strict schema 单会话 facet（唯一花额度的一层）
L4 聚合    归一化 + 纯代码累加 + 噪声门槛
L5 合成    模板化生成，LLM 只润色措辞
```

**不可动摇的分界**：L1/L2/L4 零 LLM。所有计数、排序、门槛判定由确定性代码完成。
LLM 只做 L3 的单会话打标和 L5 的措辞。这样统计数字可审计、可复现。

### L0 provider

| provider | 数据源 | v0.1.0 |
|---|---|---|
| `codex` | `~/.codex/state_*.sqlite`（取 mtime 最新）查 `threads` 表拿索引 → 按 `rollout_path` 读 `sessions/YYYY/MM/DD/rollout-*.jsonl` 逐事件解析 | ✅ 必须 |
| `claude-code` | `~/.claude/usage-data/session-meta/*.json`（官方已生成，直接读，不自己解析 jsonl） | ✅ 复用官方 L1 |

### L2 采样

- substantive 门槛：`userMessages >= 2` 且 `durationMinutes >= 1`
- 按 ISO 周分桶（窗口默认 30 天，约 4-5 桶），桶内按 `userMessages` 降序
- 配额分配：`k = floor(quota / 桶数)`；**某桶不足 k 时，剩余名额按桶内候选数比例
  重新分给其他桶**（不是丢弃），保证总是取满 quota
- 默认 `quota = 50`（与官方一致，便于对照）
- 目的：修「重度用户时间窗塌缩」

### L3 schema 契约

标量字段用 `enum`；计数字段用 `additionalProperties: false` + `properties` 列全 key。

⚠️ OpenAI strict mode 硬性要求：**每层 `required` 必须列出该层 `properties` 的每一个 key**。
所以计数字段是稠密的（未发生的类目填 0），这对聚合反而更友好。

新增字段（官方没有）：

- `attribution`: `user-actionable` | `ai-capability` | `environmental`
  ——只有 `user-actionable` 的摩擦才进规则候选
- `user_instructions: string[]` ——用户反复下达的原话，是最强的规则候选

### L4 归一化（关键：必须同时管 key 和 type）

```
1. JSON 解析失败 → jsonrepair 兜底
2. key 白名单：表外 key 归一化后（小写、去复数 s、`-`→`_`）先精确匹配；
   不中则用 Levenshtein 距离，**阈值 <= 2 且长度差 <= 3** 才映射；
   仍不中的进 `other` 桶并在报告里**单独列出原始 key**（不静默吞掉——
   表外 key 的分布本身是 prompt 质量的信号）
3. type 强制：boolean → int(0/1)；list/dict → join 成 string；非数值 → 丢弃并计入 dropped
4. 噪声门槛：出现 1 次的不展示；立规候选要求 count >= 3
```

第 3 步是 §2.2 实测逼出来的，不是防御性编程。

## 4. Provider 策略

```
首选  codex exec --output-schema <file>     strict，实测 0/3 违规
降级  无 schema 能力时 → 宽松解析 + L4 强制归一化
不支持 ChatGPT 网页版作为生产路径（够不到 text.format.schema；且贴会话进网页 = 数据外流）
```

## 5. 隐私（硬约束，不是可选项）

- **数据不出本机**。没有遥测、没有上报、没有「帮你分析一下」的云端。
- **采集层强制脱敏**，在任何内容进入 LLM 之前执行：
  JWT（`eyJ...`）· `sk-`/`ghp_`/`gho_`/`github_pat_`/`xoxb-`/`xoxp-`/`AKIA` 前缀 ·
  URL query 里的 `token`/`key`/`secret`/`password`/`signature` · 邮箱 · 40 位以上长串
- 这条不是假想：从真实会话提取 transcript 时**实际命中过一个可用的登录 JWT**。
- `doctor` 输出**只含环境与计数，绝不含会话内容**——它要被贴进 GitHub issue。

## 6. 可诊断性（决定同事/学员测试的效率）

作者只有 macOS + codex 0.131.0，**测不了**：其他 Codex 版本、Windows/Linux、
空数据首次运行、额度耗尽、网络异常。所以工具必须自证环境。

- `adi doctor` → 结构化诊断：OS / Codex 版本 / schema 能力探测 /
  各 provider 发现的会话数 / 上次运行结果 / 首个失败的错误码
- 所有失败走**结构化错误码**（`E_CODEX_TOO_OLD` / `E_NO_SESSIONS` / `E_SCHEMA_REJECTED` …），
  不是自由文本
- issue 模板**强制**贴 `doctor` 输出

已知必须处理的环境问题：**codex 0.131.0 跑不了账号默认模型**
（`gpt-5.6-sol` 报 `requires a newer version of Codex`）。必须探测并给出可执行提示，
而不是把 400 原样抛给用户。

## 7. 非目标（v0.1.0 明确不做）

- ❌ 跨工具同尺对比（等两边都有足够样本再说）
- ❌ 自动写入 `AGENTS.md` / `CLAUDE.md`（只生成候选，落盘由人决定）
- ❌ 云端 / 服务端 / 账号体系
- ❌ 周度四类清单（未完成/半成品/bug/可合并）——那是另一个消费者，v0.2 再挂

## 8. 已知限制（必须写进 README，不藏）

- 计数字段有 ±1 噪声，**单会话数字不可尽信**；聚合层是否能把噪声平均掉**尚未验证**
- L5 合成层的稳定性尚未验证
- 只在 macOS + codex 0.131.0 + gpt-5.5 上实测过

## 9. 技术决策

### 9.1 零运行时依赖（硬约束）

`package.json` 的 `dependencies` **必须保持为空**。理由不是洁癖：

- 这个工具要装在几百台陌生机器上。**任何 native 模块（如 `better-sqlite3`）编译失败
  就是当场装不上**，而编译失败在不同 OS / Node 版本 / 缺 build tools 的机器上非常常见。
- 零依赖 = `npx agents-deep-insights` 秒起，没有供应链风险，没有 `npm install` 失败面。

推论：

- 读 sqlite 走 **shell 调 `sqlite3` CLI**（macOS 自带；Linux 常见；缺失时降级到只读
  rollout jsonl 并由 `doctor` 报明）——不用 native 绑定。
- JSON 修复自己实现最小版（截断补全、去尾逗号、剥 markdown 围栏），不引 `jsonrepair`。

### 9.2 运行时选择：Node.js ≥18

Codex CLI 用户多数经 npm 安装（`npm i -g @openai/codex`），大概率已有 Node。
`npx` 提供最短的零安装路径。

### 9.3 命令分层：第一条命令必须不可能失败

| 命令 | LLM | 网络 | 额度 | 失败面 |
|---|---|---|---|---|
| `adi stats` | 无 | 无 | 无 | 只读本地文件 |
| `adi doctor` | 无 | 无 | 无 | 只探测环境 |
| `adi run` | 有 | 有 | 有 | 完整分析 |

`stats` 是默认入口与现场演示用命令。用户先看到自己的数据，再决定要不要花额度。
