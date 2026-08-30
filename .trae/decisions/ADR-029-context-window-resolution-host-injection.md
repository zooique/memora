---
alwaysApply: false
description: 上下文窗口数字的单一真理源 = 宿主构造内核 Agent 前经内核 resolveContextWindow(providerWindow, userMax) 解析后注入的 maxContextTokens；内核预算路径只消费单一数字，不认 provider/用户双层来源；角色包不声明绝对 token 配额
---

# ADR-029 · 上下文窗口解析归宿主注入（内核只消费、不解析）

> **状态**：✅ 已接受
> **日期**：2026-08-30
> **来源**：用户 SSOT 审查（上下文窗口 + 角色包职责边界，`docs/根基/` 设计日志 + 本会话对抗式复核）
> **依赖**：[ADR-010](./ADR-010-agent-facade.md)（Agent 门面 = 宿主接入入口）、[ADR-025](./ADR-025-memory-role-pack-boundary.md)（角色包只承载设定）、[role-pack-spec.md §C/§D](../../docs/architecture/role-pack-spec.md)（上下文预算装配）

## 背景

`provider.contextWindow`（`src/llm/types.ts:42` 建模、`src/config/loader.ts:308` 校验）是**声明了却没接线的死字段**：预算路径 `contextPreparer.ts:120` 实际只喂 `computeContextBudget({ windowTokens: deps.config.maxContextTokens })`，从不读 `provider.contextWindow`。而 `contextPreparer.ts:112` 旧注释写「优先 provider contextWindow，缺失降级 maxContextTokens」——**注释即谎言**（无对应代码路径支撑）。

根因是职责错位：内核契约 `{ baseUrl, model, apiKey }` 拿不到 provider 配置，窗口解析**只能归宿主**（内核/host 边界铁律，非选项）。`budget.ts` 早已把容量建模为单一入参 `windowTokens`（即内核 `AgentOptions.maxContextTokens`），设计上本就指向「宿主注入」。

此外内核 `budget.ts:32` 的 `windowTokens` 与角色包残留的 `global.tokenBudget`（绝对 token 配额）是两个平行概念，违反 SSOT。

## 决策

### 核心决策：窗口数字的唯一真理源 = 「宿主解析后注入内核的 maxContextTokens」

1. **内核只消费、不解析**：`computeContextBudget` 继续只吃单一数字 `windowTokens`（= `deps.config.maxContextTokens`），不认 provider、不硬编码窗口量级。内核零改动即可落地。
2. **解析公式收口内核**：新增 `src/agent/budget.ts` 纯函数 `resolveContextWindow(providerWindow, userMax)` 作为**唯一 min 公式**，经 `src/index.ts` 导出供宿主调用：
   - `providerWindow` 未配置（undefined/null）→ 回退 `userMax`（再回退内核 `AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS = 120_000`）；
   - `providerWindow` 已配置 → `min(providerWindow, userMax)`，绝不超过用户全局上限。
   - 宿主不在本地镜像 `min` 逻辑（避免跨宿主两份副本）。
3. **宿主在构造 Agent 前注入**：`new Agent({ maxContextTokens: resolveContextWindow(activeProvider.contextWindow, userMaxSetting) })`。
   - **vscode 宿主（本 ADR 落地范围）**：`LlmProviderConfig` 当前不含 provider 级 `contextWindow`，故 `providerWindow` 恒传 `undefined`；窗口完全由用户设置 `memora.maxContextTokens`（package.json 声明 `default 120000 / min 1000 / max 2000000`）决定。`assemble.ts` 调 `resolveContextWindow(undefined, userMax)`，`extension.ts` 从 workspace 设置读取透传。
   - **sprite 宿主（本 ADR 暂不实现，留作对称扩展点）**：读 `config.llm.providers[active].contextWindow` 作为 `providerWindow`，与 `config.memory.maxContextTokens` 取 min。
4. **角色包不再声明绝对 token 配额**：废除角色包 schema 的 `global.tokenBudget`（违反 strategyKeys 初衷且绝对量级耦合模型窗口）。内核「上下文近满则跳过召回」语义若保留须改为比例 `recallSkipAbovePercent`（默认对齐 90% 硬帽，行为不变），不暴露绝对 token。3 个内置 manifest 的 `tokenBudget:1000000` 迁回依赖 `memoryRecallPercent`（模型无关的正确抽象，已接线 `budget.ts`）。

### 配套决策（复杂度守恒，避免过度抽象）

- **不复用并行 `windowTokens` 管线**：内核已有 `maxContextTokens` 即「窗口」单一入参（budget/loop/contextManager 全用它）。宿主注入即复用，引入并行 `windowTokens` 是重复抽象。
- **动态获取是顶层非地基**：`provider.contextWindow` 配置 + 静态表已覆盖 DeepSeek/Claude 等 90% 场景；Gemini/Ollama/OpenAI 动态 API 是加分项，按顺序后做。
- **窗口量级边界不跨层引用**：内核 `AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS` 与 sprite `loader.DEFAULT_MAX_CONTEXT_TOKENS` 是**既有刻意独立声明**（见 `constants.test.ts` 护栏），本 ADR 不导出 MIN/MAX 给宿主；bounds 在配置 schema 层声明（vscode package.json `minimum/maximum`、sprite loader `MIN_CONTEXT_WINDOW/MAX_CONTEXT_WINDOW`），宿主编排不复制常量。越界手改 settings.json 时内核预算非负收敛降级，不崩溃。

## 理由

1. **SSOT 单一控制源**：窗口数字一个真相源（宿主注入的 `maxContextTokens`），解析公式收口内核单一函数；角色包零窗口责任。
2. **边界铁律**：内核契约不含 provider 配置，窗口解析天然归宿主——强行在内核解析违反 kernel/host 边界。
3. **救活死字段**：`provider.contextWindow` 经宿主解析后真正接入预算路径，不再是声明无消费的摆设。
4. **注释即契约**：旧 `:112` 谎言注释已改为准确表述（windowTokens 由宿主注入），grep 可验证。

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 内核 funnel 读 `config.llm.providers[active].contextWindow` | `AgentConfig` 无 `llm.providers`、`LlmProvider` 不暴露 `contextWindow`；内核拿不到 provider 配置，违反边界。对抗式复核已推翻「内核可解析」的隐含假设 |
| 内核另起 `windowTokens` 并行管线 | 与既有 `maxContextTokens` 重复抽象，违反复杂度守恒；`budget/loop/contextManager` 已全用 `maxContextTokens` |
| 宿主各自镜像 `min` 逻辑 | 两份副本必腐化（并列=腐化）；公式收口内核单一函数才是 SSOT |
| 角色包保留绝对 `tokenBudget` | 绝对量级耦合模型窗口，与「模型无关行为偏好」定位冲突；改比例 `recallSkipAbovePercent` 行为不变且零回归 |
| vscode 宿主侧硬编码 120K 默认 | 让宿主持有内核常量副本（违反「两处独立声明不跨层引用」护栏的初衷）；改由 `resolveContextWindow` 统一回退内核默认 |

## 影响

- **内核**：新增 `resolveContextWindow` 纯函数 + `index.ts` 导出（已落地）；`contextPreparer.ts:112` 注释改正；`computeContextBudget` 零改动。新增 `resolveContextWindow` 单测（`budget.test.ts`）。
- **vscode 宿主**：`package.json` 新增 `memora.maxContextTokens`；`AssembleOptions.maxContextTokens?: number`；`assemble.ts` 调 `resolveContextWindow(undefined, userMax)` 注入；`extension.ts` 读取透传（已落地）。sprite 不改（用户明确「只聚焦 vscode 宿主」）。
- **角色包**：`global.tokenBudget` 废除 + 3 manifest 迁移（**卫生项，本 ADR 不实现，发包前或发包后处理**）。
- **发包前必办**：内核 `npm run build` 重新产出 `dist/`，vscode 的 `file:../..` 依赖方能拿到 `resolveContextWindow` 导出；否则发布包契约与源码不一致。

## 何时回顾

- 若 vscode 后续为单 Provider 增加 per-provider `contextWindow` 配置（`LlmProviderConfig` 加字段），`assemble.ts` 将 `providerWindow` 由 `undefined` 改为读取活跃 provider 值即可，公式不变。
- 若实施角色包 `recallSkipAbovePercent` 比例化，需同步更新 role-pack-spec 与 `budget.ts`。
- 若接入 Gemini/Ollama/OpenAI 动态窗口 API，在宿主 `ModelContextResolver` 顶层扩展（非地基改动）。
