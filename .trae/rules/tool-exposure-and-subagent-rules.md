---
alwaysApply: false
description: 工具暴露面与子会话边界纪律——三层归层、能力声明即收窄、五层诊断出口、子会话结构性只读与深度 1
---

# 工具暴露面 × 角色包 × 子会话边界纪律

> **一句话**：工具的「能不能被看见」由三层归层决定；角色包声明能力只会**收窄**，不会增加；子会话的只读与深度 1 是**结构性**保证，不是 deny 表的副产品。
> 真源入口：`src/agent/toolExecutor.ts`（`DEFAULT_EXPOSED_TOOLS` / `isToolExposed`）、`src/role-pack/capabilityMap.ts`（`CAPABILITY_TO_TOOLS` / `isRegisteredCapability`）、`src/agent/assembler.ts`（子装配）。

## §0 范围与分工

- 本文件只覆盖「工具可见性 × 角色包 × 子会话」这一个域。
- 不复述：伪成功口径见 [project-rules.md](./project-rules.md) §8.1 / §8.5；接缝端到端见 [project-rules.md](./project-rules.md) §8.3 与 [testing_rules.md](./generic/testing_rules.md) §8；可观测性边界见 [architecture_philosophy_rules.md](./architecture_philosophy_rules.md) §12。

## §1 三层归层

- **R1** 角色包能影响的工具可见性只有三层，按判定顺序：常驻集 `DEFAULT_EXPOSED_TOOLS`（在查白名单之前直接放行，`capabilities` 挡不住）→ 能力映射 `CAPABILITY_TO_TOOLS`（角色包声明后解锁）→ 其余（白名单为 `null` 时全可见；为数组时仅名单内可见）。
- **R2** 新增任何**内置**工具，必须在同一改动里决定它落哪一层。不决定则默认落第三层 = 静默关闭：只有未声明 `capabilities` 的包能用，已声明的包永远看不见。不归层属于 R13 意义上的静默缺陷，当前无运行时诊断，见 R15。
- **R3** 一项事实只允许一个真源：**角色包 manifest 可声明的能力名清单只有 `src/role-pack/capabilityMap.ts` 一处**。校验器要问「是否已登记」，只调用 `isRegisteredCapability`，不得复制第二份名单。子会话可授予能力是另一份独立窄集（`assembler.ts` 的 `SUBAGENT_GRANTABLE_CAPABILITIES`），不是重复登记。
- **R4** 可增长集合（工具清单、能力枚举、调用点）在注释与文档里只描述性质，不写死数量。
- **R5** `denyTools`、宿主自定义工具、`search_project` **不是**角色包决定源：`denyTools` 恒为第一层且必须早于 `customTools` 判定；自定义工具与 `search_project` 注入即暴露。角色包能力声明不得越权过滤这三类。

## §2 角色包声明 = 收窄

- **R6** `capabilities` 三态（真源 `rolePackManager.parseManifestCapabilities` 与 `agent.applyRolePackToolExposure`）：缺省 `undefined` → 白名单 `null`（全开）；数组 → 白名单数组（空数组 = 仅常驻集）；字段畸形（非数组）→ 按「显式空能力」处理，即最收紧。
- **R7** 声明是收窄，不是增加。写了 `capabilities`（哪怕空数组），白名单就从 `null` 变成数组，结果是「只剩常驻集 + 已登记能力映射出的工具」。文档、示例、UI 提示三处口径必须一致。
- **R8** 能力成组开放，不允许点对点开放单个工具。**角色包 manifest 产生的**白名单只能由 `CAPABILITY_TO_TOOLS` 经 `resolveCapabilityTools` 映射产出，manifest 不得直接写工具名；子会话授予走 R10 的另一条链（`resolveSubagentCapabilities` → `setToolWhitelist`）。
- **R9** 未登记但格式合法的能力名：校验器产 `UNREGISTERED_CAPABILITY` warning，未登记项不解锁任何工具；由于声明了 `capabilities`，工具面会从全开收窄为「常驻集 + 已登记能力映射」，若只声明了未登记项则只剩常驻集。禁止静默跳过。
- **R10** 子会话的能力授予只接受 `web:search` / `web:fetch`（真源 `assembler.ts` 的 `SUBAGENT_GRANTABLE_CAPABILITIES`），其余直接抛 `toolError`，不静默降级。
- **R11** 文档与示例只允许出现已登记的能力名，不得保留会触发 `UNREGISTERED_CAPABILITY` 的示例——那等于把「声明即收窄」的陷阱演示给作者。

## §3 五层诊断出口

- **R12** 五层：角色包校验（`validator.ts`）→ 装配注入（`assembler.ts`）→ 执行器（`denyTools` 与白名单，`isToolExposed`）→ loop 逐 step 裁剪（`resolveActiveTools`）→ 宿主 UI 呈现。
- **R13** 任一层出现「跳过 / 忽略 / 未知 / 未匹配」却不留可见诊断，即为缺陷；诊断级别最低 warning。
- **R14** 每一层都必须能回答「这个工具为什么没出现在清单里」，答案要指向该层真源（如 validator 的 `code`、`isToolExposed` 的层序）。
- **R15** 需要单一出口：给定角色包，输出「最终可见工具清单 + 每项放行或被挡的原因」。当前没有这个出口，属已知缺口；缺口存在期间不得把「读码推断」当成已验证结论。

## §4 子会话能力边界

- **R16** 子 loop 的 `toolReadonly` 是硬编码 `readonly`、不继承父（真源 `assembler.ts` 的 `createSubagentLoop`：`loop.setStrategy({ toolReadonly: 'readonly' })`）。
- **R17** 子执行器带 deny 集 `SUBAGENT_DENIED_TOOLS`（真源 `toolExecutor.ts`），禁写盘与执行类工具。新增工具时必须按副作用核一遍这张表，再按职责核一遍（`run_team_meeting` 是职责例外的样板）。
- **R18** 深度 1 由「子装配不注入派发端口」结构性保证，不是靠 deny 表：`delegate_task` 不在 `SUBAGENT_DENIED_TOOLS`，且声明 `readonly: true`，只读闸也放行。任何人给 `createSubagentToolExecutor` 接上派发端口，递归立刻变深度 2；改动子装配前必须先看本条。
- **R19** 在飞子会话不受额度或角色包变更影响，只约束后续派发：`createSubagentLoop` 只消费装配期快照 `SubagentRuntimeParams`，装配后不再读父级配置。
