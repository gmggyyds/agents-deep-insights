# Changelog

本项目的所有重要变更都记录在这里。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中
- `adi run` 支持 Claude Code 会话（需自行解析 transcript，官方 session-meta 不含对话内容）
- 聚合层稳定性验证：同一批数据多次运行，看 ±1 噪声在 N 个会话聚合后是否被平均
- 跨工具同尺对比（同一类摩擦在 Codex 与 Claude Code 上是否都排前列）
- 周度清单出口：未完成 / 半成品 / 已出 bug / 可合并

## [0.2.0] - 2026-09-09

### 新增
- **L5 叙事合成层**——这是 v0.1 缺失的半层，也是它只能产出统计报表的原因。
  报告现在包含：一句话结论、你做得好的地方、摩擦按归因分三段叙述、
  可直接粘贴进 AGENTS.md 的规则、下一步可试（带可粘贴提示词）。
  叙事字符数从 49（免责声明）提升到 1,563（3 个会话样本）。
- 报告改为叙事在前、原始统计折叠在后。数字仍由确定性代码计算，模型不参与计数。
- `--no-narrative` 跳过合成，只出统计（省一次调用）。

### 修复
- **`codex exec` 在项目目录里会进入「干活模式」**：加载项目 `AGENTS.md` 与全局 skill 后，
  把「读输入出 JSON」当成要执行的任务，去读 skill 文档、扫 home 目录，
  输出几百 KB 撑爆 Node 默认 1MB 缓冲，报 `ENOBUFS` 且看不出真因。
  修法：`cwd` 用临时目录 + `--ignore-user-config` + `maxBuffer` 提到 64MB。
  效果：从「靠重试侥幸成功」变成一次成功，单次调用 79s → 32s。
- 合成失败时不再吞掉错误详情（此前只打印错误码，违反本项目自己的可诊断性原则）。
- 剥离 codex 那条把整个模型列表塞进一行的 ERROR 日志，它会淹没真正的报错。

## [0.1.2] - 2026-09-09

### 变更
- README 中英双语：`README.md`（中文）+ `README.en.md`（英文），顶部纯文本切换。
  分文件而非单文件并排——调研 14 个高星项目，0 个用单文件并排。
- 首屏加终端输出截图（`docs/media/stats.svg`，矢量、暗色友好）。
  调研显示中文项目 10 个样本里 7 个首屏没有产品截图，而这对 CLI 工具是信息密度最高的一格。
- badge 收敛到 3 个（node / dependencies:0 / license）。
  对标 uv、ripgrep、bat 各 3 个；把 license 之外的一格给「零依赖」，比堆 badge 有信息量。
- emoji 用法按调研的实测惯例：中文版每个二级标题一个、正文零个（FastGPT 7/7、Folo 6/6 的模式）；
  英文版零个（bat / ripgrep / uv / cli 四个国际项目装饰性 emoji 合计为 0）。
- About 区重做：description 收到 79 字符（此前 137），加 5 个 topics。
- 联系方式：GitHub Issues + 邮件 + 公众号。不建微信群——与 SUPPORT.md 的支持边界保持一致。

## [0.1.1] - 2026-09-09

### 修复
- CI 在 Node 18 / 20 上全部失败：`node --test "<glob>"` 的 glob 支持是 Node 22+ 才有的，
  而 `engines` 声明的是 `>=18`。改为显式列出测试文件。
  由跨平台 CI 矩阵（3 OS × 3 Node 版本）发现——作者本机只有 Node 25，测不出这一类问题。

## [0.1.0] - 2026-09-09

首个公开版本。early preview，facet schema 尚可能变动。

### 新增
- `adi stats` —— 零 LLM、零网络、零额度的本地统计。默认命令。
- `adi doctor` —— 环境自检；`--issue` 输出可直接贴 GitHub 的诊断 markdown，且不含会话内容。
- `adi run` —— 完整分析，输出 HTML 报告。支持 Codex 会话。
- Codex provider：读 `~/.codex/sessions/**/rollout-*.jsonl`，纯代码提取会话元数据。
- Claude Code provider：复用官方 `/insights` 生成的 `session-meta`，不自建解析器。
- **schema 级闭合枚举**：枚举写进 JSON Schema 的 `enum` 与 `additionalProperties:false`，
  经 Codex `--output-schema` 由解码层强制。
- **归一化层**：同时管 key 与 type。同义词合并、类型强转、表外 key 记录不吞。
- **分层采样**：按 ISO 周分桶，修复「取最近 N 个」在重度用户身上的时间窗塌缩。
- **attribution 三分**：`user_actionable` / `agent_capability` / `environmental`。
- **默认脱敏**：JWT、API key、URL token、邮箱、私钥块、超长串。
- 按内容指纹的 facet 缓存，重跑不重复消耗额度。

### 实测依据
- strict schema 与 prompt-only 的对照（同一段会话各 3 次）：
  strict **0/3** 违规，prompt-only **2/3** 违规，ChatGPT 网页版 **2/3** 违规。
- 观测到的违规形态全部是**类型漂移**而非造新词：
  `goal_categories` 整体变 boolean、`friction_detail` 变 array / dict。
  这三种形态已固化为回归用例。
- 分层采样 vs 取最近 N（同一台机器 394 份真实数据、同为 50 个样本）：
  时间跨度 **32 天 vs 14 天**。

### 已知问题
- 计数字段存在 ±1 边界噪声（12 类中约 4 类，同一会话跑 3 次）。
- `adi run` 暂不支持 Claude Code 会话。
- 仅在 macOS + codex-cli 0.131.0 + gpt-5.5 上实测。
- codex-cli 0.131.0 无法使用账号默认模型（需 `--model gpt-5.5` 或升级 Codex）。

[Unreleased]: https://github.com/gmggyyds/agents-deep-insights/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/gmggyyds/agents-deep-insights/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/gmggyyds/agents-deep-insights/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/gmggyyds/agents-deep-insights/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/gmggyyds/agents-deep-insights/releases/tag/v0.1.0
