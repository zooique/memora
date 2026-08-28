---
alwaysApply: false
description: 角色自动匹配开关 autoSwitch 收敛为宿主装配级键（角色包不再可写，默认 on + 宿主 strategyOverride 覆盖）；宿主策略覆盖通道 resolveActiveStrategy(strategy, override) 作为「宿主策略层」通用机制
---

# ADR-026 · 角色自动匹配开关归宿主装配层（autoSwitch 宿主级键 + strategyOverride 通用覆盖通道）

> **状态**：✅ 已接受
> **日期**：2026-08-28
> **来源**：用户 SSOT 审查（角色包"为什么要管自己能不能被自动切换？"——内容供给方不该管理宿主运行时行为）
> **依赖**：[ADR-025](./ADR-025-memory-role-pack-boundary.md)（角色包只承载设定，边界一刀切）、[role-pack-spec.md §六](../../docs/architecture/role-pack-spec.md)（L2 策略键集）、[memory-role-pack-boundary-rules.md](../rules/memory-role-pack-boundary-rules.md)

## 背景

角色自动匹配开关 `autoSwitch` 原为角色包策略键（`prepare.autoSwitch`，默认 `on`），角色包作者可在 manifest strategy 里声明。SSOT 审查发现**同一行为存在两个控制源且角色包侧失控**：

| 症状 | 证据 |
|------|------|
| 角色包可写 autoSwitch | `STRATEGY_KEY_RULES.prepare.autoSwitch` 开放键 + authoring-guide 指导作者填写 |
| 角色包实际无差异化 | 全部 3 个内置角色包都写 `"autoSwitch": "on"`（同值冗余——若每个包必须写同一值，说明该值不该由包决定） |
| 宿主必须覆盖而非直接控制 | VSCode 插件（产品定位：只用手动切换）被迫引入宿主级覆盖压过角色包声明 |

角色包定位 = 内容供给方（你是谁 / 你怎么做事 / 你有什么能力）。**「能否被自动切换」是宿主的运行时产品行为策略，不是角色能力**——与 ADR-025「角色包只承载设定」的边界哲学一致。

## 决策

### 核心决策：autoSwitch 收敛为宿主装配级键

1. **角色包不再可写 autoSwitch**：`STRATEGY_KEY_RULES` 移除该键 → 角色包 manifest 写它按**未知键 warning + 忽略**，不参与决策。
2. **内核默认保留** `autoSwitch: 'on'`（SSOT 基线，未覆盖即允许自动匹配）。
3. **宿主经装配级覆盖改变最终解析值**：`resolveActiveStrategy(rolePackManager, strategyOverride)` 中 override 压过角色包声明，VSCode 插件注入 `{ prepare: { autoSwitch: 'off' } }` 实现"只用手动切换"。

### 配套决策：strategyOverride = 宿主策略层通用覆盖通道

`AgentOptions.strategyOverride?: Partial<BehaviorStrategy>` 是**「宿主策略层」通用机制**（非 autoSwitch 专属开关）——任何宿主产品决策（工具审批、token 预算、自动匹配等任意策略键）都可经此表达，决议链统一为：`内核默认（on/…） → 宿主覆盖 → resolve* → 运行时生效`。

## 理由

1. **SSOT 单一控制源**：一个行为（是否自动切换）一个开关（autoSwitch），且该开关唯一归属"决策者"（宿主产品层）；角色包是"被管理对象"，不做自我管理。
2. **职责边界对齐 ADR-025**：角色包管"内容"（persona/rules/skills/capabilities/温度/提问倾向），宿主管"运行时行为策略"（切换、审批、预算）。"我能否被切换"是宿主管理行为，不是角色能力声明。
3. **消灭同值冗余**：角色包写 autoSwitch 只能写同一值（on），属于无信息量的冗余配置，删之无行为损失。
4. **宿主覆盖通道通用化**：strategyOverride 是策略层通用机制，未来宿主覆盖其他键（如统一关自审查）无需再造独立开关。

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 宿主独立布尔开关（`rolePackAutoMatch`） | 曾引入：与角色包 `autoSwitch` 并存 → 控制同一行为出现两个语义键（双源冲突），且中途未接线。SSOT 判定为反模式后删除 |
| 内核默认值改为 `'off'` 全局关闭 | 改变所有宿主默认行为，违反「核心库提供机制、宿主提供策略」边界；VSCode 需求是产品决策，不是内核建制 |
| 保留角色包可写 autoSwitch | 作者无法做有效差异化（只能写同一值 on），且切换权在宿主产品手里——允许角色包声明会造成"内容包作者决定宿主行为"的倒置 |

## 影响

- **角色包**：manifest 写 `autoSwitch` 将产生未知键 warning 并被忽略（向后兼容不阻塞加载）；作者指南/规范/schema/3 个内置 manifest 同步移除该键。
- **内核**：`BehaviorStrategy.prepare.autoSwitch` 字段保留（宿主 override 通道的数据形状），`resolveAutoSwitch` 消费点不变；新增守卫测试防误加回角色包键集。
- **宿主**：VSCode 插件装配注入 `strategyOverride: { prepare: { autoSwitch: 'off' } }`；未来可将开关开放为用户设置（从 configuration 读取透传，内核无需改动）。

## 何时回顾

无需定期回顾。若未来出现真实的"单角色包自我锁定"需求（某角色拒绝被自动切换），需重新评估是否在角色包侧开放该键——届时以真实消费场景为准，不提前设计。