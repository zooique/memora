---
alwaysApply: false
description: 上下文窗口数字的单一真理源 = 宿主构造内核 Agent 前经内核 resolveContextWindow(window?) 解析（per-LLM 窗口即唯一真理源，未配置回退内核默认 120K）后注入的 maxContextTokens；内核预算路径只消费单一数字，不认 provider/用户双层来源；角色包不声明绝对 token 配额
---

# ADR-029 · 上下文窗口解析归宿主注入（内核只消费、不解析）

> **状态**：✅ 已接受
> **坐标**：正文行号为**历史记录的时点快照**，代码演进后不再核对——定位请按符号名检索，勿依赖行号。
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
2. **解析公式收口内核**：新增 `src/agent/budget.ts` 纯函数 `resolveContextWindow(window?: number)` 作为**唯一窗口公式**（单参：传 per-LLM 窗口，未配置回退内核 `AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS = 120_000`），经 `src/index.ts` 导出供宿主调用：
   - 传 per-LLM `contextWindow` → 直接采用（唯一真理源，**无全局封顶**）；
   - 未配置（undefined）→ 回退内核 `AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS = 120_000`；
   - 宿主不在本地镜像任何 `min`/封顶逻辑（复杂度守恒，单一公式收口）。
3. **宿主在构造 Agent 前注入**：`new Agent({ maxContextTokens: resolveContextWindow(activeProvider.contextWindow) })`（单参：per-LLM 窗口即唯一真理源，未配置回退内核默认 120K）。
   - **vscode 宿主（本 ADR 落地范围）**：`LlmProviderConfig.contextWindow` 即 per-LLM 窗口真理源（详见「决策演进」）。`assemble.ts` 调 `resolveContextWindow(activeProviderCfg?.contextWindow)`，未配置回落内核默认 120K；`extension.ts` 仅做旧全局 `memora.maxContextTokens` 的一次性迁移清理。
   - **sprite 宿主（本 ADR 暂不实现，留作对称扩展点）**：读 `config.llm.providers[active].contextWindow` 直接作为 `resolveContextWindow` 的入参（无全局封顶）。
4. **角色包不再声明绝对 token 配额**：废除角色包 schema 的 `global.tokenBudget`（违反 strategyKeys 初衷且绝对量级耦合模型窗口）。内核「上下文近满则跳过召回」语义若保留须改为比例 `recallSkipAbovePercent`（默认对齐 90% 硬帽，行为不变），不暴露绝对 token。3 个内置 manifest 的 `tokenBudget:1000000` 迁回依赖 `memoryRecallPercent`（模型无关的正确抽象，已接线 `budget.ts`）。

> ⚠️ **本条后半句已失效，不执行（2026-09-12 复核）**：其论证前提是「内核上下文近满则跳过**召回**」，而召回注入已随召回策略键族于 2026-09-09 退役（`src/role-pack/strategyResolver.ts:52`）；且目标载体 `memoryRecallPercent` **本身也在该批退役**——论证前提与目标载体双双消失。故「改为 `recallSkipAbovePercent`」「迁回 `memoryRecallPercent`」两项**不再执行**（`recallSkipAbovePercent` 从未引入）。
> **前半句仍成立**：角色包不声明绝对 token 配额。2026-09-12 以「3 个内置 manifest 改 `tokenBudget: 0`（= 不设限）」兑现——**保留键、取消绝对量级**，比原议「废除键」更保守，且与「软上限须小于上下文窗口（默认 120K）才可能触发」一致（原值 `1000000` 永不触发，等价于不设限却有误导性）。

### 配套决策（复杂度守恒，避免过度抽象）

- **不复用并行 `windowTokens` 管线**：内核已有 `maxContextTokens` 即「窗口」单一入参（budget/loop/contextManager 全用它）。宿主注入即复用，引入并行 `windowTokens` 是重复抽象。
- **动态获取是顶层非地基**：`provider.contextWindow` 配置 + 静态表已覆盖 DeepSeek/Claude 等 90% 场景；Gemini/Ollama/OpenAI 动态 API 是加分项，按顺序后做。
- **窗口量级边界不跨层引用**：内核 `AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS` 与 sprite `loader.DEFAULT_MAX_CONTEXT_TOKENS` 是**既有刻意独立声明**（见 `constants.test.ts` 护栏），本 ADR 不导出 MIN/MAX 给宿主；bounds 在配置 schema 层声明（vscode package.json `minimum/maximum`、sprite loader `MIN_CONTEXT_WINDOW/MAX_CONTEXT_WINDOW`），宿主编排不复制常量。越界手改 settings.json 时内核预算非负收敛降级，不崩溃。

> **⚠️ 本条末两句已失效（2026-09-18 裁决，见「上下文窗口区间裁决 —— 2026-09-18 演进」）**：`MIN_CONTEXT_WINDOW` 已删除、`MAX_CONTEXT_WINDOW` 不再作为裁决上界（仅 `logger.warn` 观测、值仍原样生效），「越界收敛降级」行为随之撤销 —— 超模型能力由 API 报错（可见失败），不再被任何一层静默替换。

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
- **vscode 宿主（原文，已被「决策演进」取代）**：原设计 `package.json` 新增全局 `memora.maxContextTokens` + `AssembleOptions.maxContextTokens` + `assemble.ts` 调 `resolveContextWindow(undefined, userMax)`（旧两参签名，已废弃）。**已于 2026-08-30 按「决策演进」落地为 per-LLM 方案**（见下「影响（已实现）」）：全局 `memora.maxContextTokens` 废弃 + 一次性迁移；窗口真理源改为 `LlmProviderConfig.contextWindow`。sprite 不改（用户明确「只聚焦 vscode 宿主」）。
- **角色包**：`global.tokenBudget` 废除 + 3 manifest 迁移（**卫生项，本 ADR 不实现，发包前或发包后处理**）。
- **发包前必办**：内核 `npm run build` 重新产出 `dist/`，vscode 的 `file:../..` 依赖方能拿到 `resolveContextWindow` 导出；否则发布包契约与源码不一致。

## 何时回顾

- ~~若 vscode 后续为单 Provider 增加 per-provider `contextWindow` 配置（`LlmProviderConfig` 加字段），`assemble.ts` 将 `providerWindow` 由 `undefined` 改为读取活跃 provider 值即可，公式不变。~~ **✅ 已于 2026-08-30 落地**：`LlmProviderConfig` 已加 `contextWindow?: number`，`assemble.ts` 经 `providerStore.getActive()?.contextWindow` 读取并 `resolveContextWindow(…)`（单参）注入；公式收敛为单源。
- 若实施角色包 `recallSkipAbovePercent` 比例化，需同步更新 role-pack-spec 与 `budget.ts`。
- 若接入 Gemini/Ollama/OpenAI 动态窗口 API，在宿主 `ModelContextResolver` 顶层扩展（非地基改动；可选「自动探测预填」见演进第 5 点，推迟）。

---

## 决策演进（2026-08-30 续 · per-model 独立上限 + 分层动态获取）

> **驱动**：用户给定两前提——① vscode 仅用户自添个人 LLM、无内置 LLM（宿主不知用户用哪些）；② 每 LLM 须独立开放上下文上限配置。并挑战「为何需维护静态表 / 能否从 LLM API 取上限」。本节能取代原 vscode 落地节（第 31 行）的「全局单值」表述；解析公式同步收敛为单参 `resolveContextWindow(window?)`（per-LLM 即唯一真理源，无全局封顶）。

### 事实裁定（对抗式核实）

上下文上限能否运行时获取，**取决于 provider，无统一标准**：

- **能取真值**：Ollama `/api/show` 返回 `model_info.*.context_length`（hermes-agent#23949 / openclaw#73515 / vscode#302475 实测）；Gemini `Model` 资源带 `inputTokenLimit`/`outputTokenLimit`；OpenRouter `/api/v1/models` 每模型带 `context_length`。
- **不能取**：OpenAI-compatible 基线（`/v1/chat/completions`，内核核心契约 `{baseUrl, model, apiKey}`）——`/v1/models` 响应 schema 仅含 `id/owned_by/permission/...`，**无 context window 字段**；上限只写在模型卡/定价网页。故任意 `base_url`（vLLM / LM Studio / DeepSeek·通义·月之暗面 OpenAI 兼容端点）均无标准端点可查。

→ 但「静态表 / 动态 API 作校验」在**前提 1（无内置 LLM、不知用户用哪些 LLM）**下整体作废：宿主无任何宿主持有的「模型真上限」权威。→ **静态表删除**；动态获取降级为可选「自动探测」预填（非 SSOT、推迟）。唯一真理源 = 用户 per-LLM `contextWindow`。

### 演进决策

1. **窗口数字 SSOT 不变**（宿主解析后注入 `maxContextTokens`），但 vscode 由「全局单值 `memora.maxContextTokens`」演进为 **per-model `LlmProviderConfig.contextWindow`**：每个 provider 条目独立上限，切换激活 provider（模型）即切换上限。
2. **前提 1（无内置 LLM）推翻「静态表 / 动态 API 作校验」的必要性**：宿主不知道用户添加了哪些 LLM（任意 OpenAI-compatible / Ollama / Gemini / vLLM / LM Studio…），故**不存在任何宿主持有的「模型真上限」权威**——静态表覆盖不全且需维护、动态 API 对未知 endpoint 无效。→ **删除静态表；动态获取降级为可选预填（见第 5 点），不进入 SSOT**。
3. **唯一真理源 = 用户 per-LLM `contextWindow`**：每个用户添加的 LLM 配置项一个 `contextWindow` 数字即真理；宿主注入 `resolveContextWindow(llmEntry.contextWindow)`（单参：per-LLM 窗口为唯一真理源，未配置回退 120K）→ `maxContextTokens`。内核零改动。未填 → 内核默认 120K 兜底（默认非真理源）。
4. **仅有的护栏 = schema `minimum`/`maximum`**（防 0 / 防天文数字撑爆预算）：这是 sanity bound，不是模型上限，不构成第二真理源。
5. **废弃全局 `memora.maxContextTokens`**（避免双源）；存量用户设置经一次性迁移落到首个 provider 条目的 `contextWindow`。

### 理由（对齐用户铁律）

- 「一份真理源」：用户 per-LLM `contextWindow` 是唯一真相；宿主不知用户用了哪些 LLM（前提 1），无任何宿主持有的 ceiling 权威，故不引入任何第二来源（静态表 / 动态 API 均不进 SSOT）。
- 回应「能否从 API 取」：能（Ollama/Gemini/OpenRouter），但前提 1 下宿主不知用户 LLM、且未知 endpoint 无标准端点 → 动态获取仅作**可选预填**（推迟），不进真理链。
- 复杂度守恒：不新造窗口管线、不维护静态表；复用 ADR-029 既有 `resolveContextWindow(window?)` 单参插槽，内核零改动。

### 影响（已实现 · 2026-08-30）

- ✅ vscode `LlmProviderConfig` 加 `contextWindow?: number`（`protocol.ts`，SSOT 注释锁定「用户真理源」）；设置 UI 每 provider 条目可编辑（弹窗 `#f-contextwindow` + 卡片详情 ` · N ctx` 透明可见）。
- ✅ 保存校验 = 仅 sanity bound（`providerStore.save`：正整数 + 1024–10_000_000 范围），**不校验「是否超过模型真上限」**（宿主不知该上限）；非第二真理源。
- ✅ `assemble.ts`：`resolveContextWindow(activeProviderCfg?.contextWindow)`（单参：per-LLM 窗口即真理源，未配置回退 120K；`AssembleOptions.maxContextTokens` 已删除）。内核零改动。
- ✅ `memora.maxContextTokens` 废弃（`package.json` 配置段删除）+ 一次性迁移（`providerStore.migrateMaxContextTokens`：旧全局值并入首个未配 contextWindow 的 provider 并清除旧键；`extension.activate` 调用）。
- ⏸ 可选「自动探测上限」预填按钮（**非 SSOT、推迟**）：仅当用户显式选 Ollama/Gemini 类型且 `base_url` 可达时，探测结果写入用户 `contextWindow` 字段（仍由用户值作真理，不另立来源）。属 ADR-029 原规划的顶层加分项，非核心 SSOT。
- 质量门：vscode `tsc --noEmit` 0 错、`eslint --max-warnings 0` 0 警告（src）、host 全量测试 272 通过（含新增 `providerStore.test.ts` 9 + `configView.test.ts` 扩展 4）。

---

## 上下文窗口区间裁决 —— 2026-09-18 演进

> **驱动**：V1 观察项（`contextWindow` 区间双定义 + 静默回退）。内核 `src/config/loader.ts` 存 `MIN/MAX_CONTEXT_WINDOW=1000/2M`，越界**静默 `return undefined`** → 兜底 120K；而宿主 `providerStore.ts` 存 `1024/10M`，越界**弹窗拒绝**。后果：填 3M → 宿主接受（<10M）→ 内核静默丢弃 → **UI 显示 3M / 真实生效 120K，全程零提示**。
>
> **裁决**：
> 1. **内核删除上界裁决**：`validateContextWindow` 只留自身防御（非数 / 非有限 / 非正数 → `undefined`），越界仅 `logger.warn`（**观测，不改行为**）；`MIN_CONTEXT_WINDOW` 删除，`MAX_CONTEXT_WINDOW` 降级为「告警参考量级」（2M = 主流旗舰窗口量级，非裁决）。
> 2. **否决**「宿主护栏升级为权威拒绝 + 上界对齐 2M」：上界本质是对「最大模型窗口」这一**外部事实的猜测**，该事实只有 provider/API 掌握——猜宽（防呆 10M）是保守、猜准（2M）是冒险（未来 4M 模型上线即被拒）。
> 3. **值原样生效** → 超模型能力由 **API 报错**（真实层可见失败），不再被任何一层静默替换。
> 4. **退出条件（登记于台账 `V1-RULING`）**：若出现「超大 contextWindow 导致 API 4xx / 超时显著上升」→ 回滚为**显式报错**；⚠️ 硬约束：**任何回滚都不得回到静默**。
>
> **对齐本 ADR**：核心决策「窗口数字唯一真理源 = 用户 per-LLM `contextWindow`、内核只消费不解析」**不变且被强化**（删掉静默替换后「UI 显示值 = 真实生效值」更成立）。本演进只改「bounds 声明层」执行细节：bounds 的**唯一裁决方** = 宿主 `providerStore` 的 sanity bound（1024~10M，纯防呆）；内核不再持有第二份区间定义。
