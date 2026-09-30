---
alwaysApply: false
description: 输出上限裁决收口定案——maxTokens 生效值 = min(per-LLM 配置, 角色包 outputLimit) 单点裁决，取证面记生效值不记配置快照，0-哨兵装配层过滤
---

# ADR-035 · 输出上限裁决收口（maxTokens 取交集）

> **状态**：✅ 已接受
> **日期**：2026-09-29 落地 · 2026-09-30 真机复核定案并补录（S2 固化：src 生产引用 1 处）
> **过程稿**：`tasks/审查-空响应根因排雷与优化方案-20260929.md`（T1 落地 + §七复核，「怎么变过来的」归该稿）
> **背景**：EMPTY-RESP-1 空响应根因的根治面——per-LLM 输出预算字段（T1）落地后，真机复核发现「配置端到端生效」是伪证

## 决策

1. **最终生效值 = 取交集**：`maxTokens = min(per-LLM 配置 defaultMaxTokens, 角色包 act.outputLimit)`，单点裁决收敛在 `loop.buildChatOptions`；任一侧声明「不能超过 X」都必须被满足。
2. **0-哨兵在装配层过滤**：角色包 `outputLimit = 0`（不干预哨兵）不进裁决——装配层仅接受 `∈ [1, MAX_OUTPUT_LIMIT]`，越界忽略（0 / 负数 / 超上限均不干预）。
3. **取证面记生效值，不记配置快照**：`Agent.getEffectiveMaxTokens()` 复用 `buildChatOptions` 单点裁决输出，宿主 `buildRoundMeta` 以它为首选、配置面仅作回落——meta 事件里的 maxTokens 必须是**真实请求值**。
4. **内核不设上限裁决**：内核对 maxTokens 只做形态防御（NaN / 负数 / 0 不发出），不做 1–65536 之类的上限校验（宿主面板 sanity 检查是宿主独立行为，非跨包契约）。

## 理由

- 两侧（per-LLM 配置 / 角色包策略）都是「上限」性质；**直接覆盖**（`Object.assign` 压过）与上限语义相反——它让角色包把用户配的小值顶大（包 4096 顶掉面板 64K），用户无从得知谁赢了。
- 真机复核实证：「配置 64K 端到端生效」是伪证——meta 记的是配置快照而非请求真值，真实链路被角色包 `outputLimit` 压过；取证面记配置值导致误判，必须记生效值。
- 「显式接管」不成立：用户显式配置会被角色包策略合法压过（交集语义下只会更小），故盲区消除的唯一手段是**取证面直读生效值**。

## 引用方

- `loop.ts` `buildChatOptions`（单点裁决）/ `getEffectiveMaxTokens`（取证出口）
- `agent.ts`（装配层 0-哨兵过滤 + 薄委托）
- 宿主 `buildRoundMeta`（meta 事件生效值首选源）
- `roundStore.ts`（落盘 meta 语义：「与角色包取更小值」措辞）
