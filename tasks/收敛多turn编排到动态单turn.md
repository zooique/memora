# 收敛多 turn 编排到动态单 turn

> 创建日期：2026-09-04  
> 来源：会话讨论 + 主流产品（Trae Agent 2.0 / Trae SOLO / WorkBuddy）任务驱动方式对比  
> 状态：**探索期**——先写 docs/ 验证，不固化 ADR（符合探索期决策沉淀机制 S1）

---

## 一、收敛结论

### 当前问题

memora 的 externalTaskLoop 把复杂任务强制拆成 **规划 turn + N 个步 turn + 汇报 turn** 共多个独立 turn（每个独立 roundId + 独立 runIterationLoop 调用），存在三个结构性问题：

1. **强制前置规划 turn（注入 PLAN_ONLY_HINT）**——主流收敛方向（Trae Agent 2.0 已砍掉固定 Proposal 阶段）证明：LLM 自主规划（需要时才建任务表）比强制前置规划更灵活、更少走入死路
2. **独立 roundId 声称"隔离"但实际 messages 累积不隔离**——设计意图与实现不符，徒增复杂度
3. **摘要锚 head roundId（而非每个 turn 产摘要）**——反而说明多个 turn 在语义上是一个闭环，不需要拆分

### 收敛方向

**砍掉多 turn 编排层，让复杂任务在一个 turn 的 step 循环里动态生长**。

| 维度 | 收敛前（过度拆分） | 收敛后（主流做法） |
|---|---|---|
| 复杂度承载 | 5 个独立 turn（规划 + N 步 + 汇报） | **一个 turn 内 step 循环跑完** |
| 规划 | 强制规划 turn（PLAN_ONLY_HINT） | **LLM 自主**——需要分步时调 task_table_write，不需要直接跑工具 |
| roundId | 每个 turn 独立 + 收尾回指 | **一个 roundId 到底** |
| messages | 跨 step 累积不隔离（声称隔离但实际不隔离） | 同一数组自然累积 |
| 摘要 | 所有 turn 共享 head roundId 产一个 | 一个 turn = 一个摘要（本来就对） |
| 宿主感知 | 宿主只调一次 chat() | 宿主只调一次 chat()（**不变，SSOT 保留**） |

### 保留什么

| 保留项 | 理由 |
|---|---|
| **task_table_write / task_table_update 工具** | LLM 动态规划的载体——需要分步时自建任务表，不需要直接跳过 |
| **taskLoopLimit 上限** | 防止 LLM 建无限大的任务表（预算保护） |
| **停滞检测（STALL_THRESHOLD=3）** | LLM 连续 3 次不推进任务表 → 标记 blocked 并提示 |
| **askLimit / 软暂停 / 续跑** | step 颗粒度挂起在一个 turn 内，天然保留 |
| **会议机制（meetingPreset + team 数据）** | 独立入口——tryBuildMeetingPlan 程序化生成步骤（组员各发言 + 汇总）的能力保留；收敛到单 turn 内跑，只是不再需要多 turn 编排器 |
| **refreshAssemblyForRolePack** | 改为单 turn 内嵌角色切换钩子（从 task_table 当前 active 步骤读取 rolePack → 刷新 persona 前缀） |
| **宿主是插座** | 内核自主编排，宿主只调一次 chat()——**这个 SSOT 完全保留** |

---

## 二、排雷结论

### 生产代码影响面（10 个文件，全在 src/ 内，hosts 层零依赖 ✅）

| # | 文件 | 改动类型 | 风险 |
|---|---|---|---|
| 1 | `src/agent/seed/orchestrator.ts` | **大改**：砍 externalTaskLoop / runStepSequence / completeExternalTask / finalizeExternalTask 四个方法；runChat 简化为单 turn 直接答（不再走难度分级分支） | 中 |
| 2 | `src/agent/loop.ts` | 砍 setWithinExternalTask / isWithinExternalTask / setExternalTaskHeadRoundId / externalTaskHeadId 四个 public 方法 + 两个 private 字段 withinExternalTask / externalTaskHeadRoundId；**保留 cleanTemporarySystemMessages（通用清理，非多 turn 专用）** | 中 |
| 3 | `src/agent/seed/prepare.ts` | 砍 meetingPreset 判定 / tryBuildMeetingPlan 调用；**保留 refreshAssemblyForRolePack（改为单 turn 内嵌钩子）**；**保留 buildTeamContextBlock（会议机制需要）** | 低 |
| 4 | `src/agent/seed/types.ts` | SeedPrepareResult 砍 meetingPreset 字段 | 低 |
| 5 | `src/agent/seed/difficulty.ts` | 难度分级逻辑整个文件可砍（或降级为简单 tag） | 低 |
| 6 | `src/role-pack/rolePackManager.ts` | **不动**——team 数据结构 / buildTeamContextBlock / tryBuildMeetingPlan / resolveRoundAssemblyRole 全部保留，收敛到单 turn 后仍然需要 | 无 |
| 7 | `src/memory/roundStore.ts` | 注释更新（提到 externalTaskLoop 的地方改为"动态单 turn 内任务表驱动"） | 无 |
| 8 | `src/agent/seed/__tests__/orchestrator.test.ts` | 测试重写——砍多 turn 编排测试，会议机制测试改为单 turn 场景 | 中 |
| 9 | `src/agent/seed/__tests__/prepare.test.ts` | 砍 meetingPreset 相关测试，保留会议机制 team 上下文块测试 | 低 |
| 10 | `src/agent/seed/__tests__/harness.ts` | 砍 withinExternalTask / externalTaskHeadRoundId 相关 mock 字段 | 低 |

### 隐藏风险排查

| 风险点 | 结论 | 处理 |
|---|---|---|
| hosts 层依赖 externalTaskLoop 相关字段？ | ❌ **零依赖** | 安全收敛 |
| cleanTemporarySystemMessages 是多 turn 专用？ | ❌ 是通用方法（每轮 chat() 前清理临时 system 消息） | **保留** |
| 会议机制需要多 turn 编排器才能跑？ | ❌ tryBuildMeetingPlan 程序化生成步骤 + refreshAssemblyForRolePack 角色切换 → 可以收敛到单 turn step 循环内嵌钩子 | 需要在 step 循环内部注入"按当前 task_table active 步骤 rolePack 刷新 persona"钩子 |
| externalTaskHeadRoundId 被摘要生成器依赖？ | ❌ 是 orchestrator 收尾阶段手动回指用的，收敛后不需要 | 安全砍 |
| prepare.ts 里 resolveRoundAssemblyRole 的调用时机？ | 原来在 prepare 阶段读 task_table active 步骤的 rolePack → 收敛后改为 step 循环内部每次 LLM 调用前检查 | 位置从 prepare 移到 loop.runIterationLoop 的迭代入口 |

---

## 三、实施计划（按依赖顺序）

### P0：删多 turn 编排层（3 个核心文件）

| 步骤 | 文件 | 操作 |
|---|---|---|
| 1 | `orchestrator.ts` | 砍 externalTaskLoop / runStepSequence / completeExternalTask / finalizeExternalTask 四个方法；runChat 简化：**不管 difficulty 判定，不管 meetingPreset，一条链路走到底**（prepare → act → backgroundReflect → handoff）；PLAN_ONLY_HINT / stepPrompt 两个常量可砍 |
| 2 | `loop.ts` | 砍 setWithinExternalTask / isWithinExternalTask / setExternalTaskHeadRoundId / externalTaskHeadId 四个 public 方法 + 两个 private 字段 + withinExternalTask 相关引用（runResume 续跑入口里的 `!parts.loop.isWithinExternalTask` 检查等） |
| 3 | `types.ts` | SeedPrepareResult 砍 meetingPreset 字段 |

### P1：清理入口分流（2 个文件）

| 步骤 | 文件 | 操作 |
|---|---|---|
| 4 | `prepare.ts` | 砍 meetingPreset 判定块（`tryBuildMeetingPlan` 调用 + `meetingPreset` 返回 + sessionManager.writePlan 调用）；**保留 refreshAssemblyForRolePack / buildTeamContextBlock**（改为单 turn 内嵌钩子，从 step 循环内部调） |
| 5 | `difficulty.ts` | 难度分级逻辑整个文件可砍（或降级为简单 tag 不参与分流） |

### P2：适配会议机制到单 turn（2 个文件）

| 步骤 | 文件 | 操作 |
|---|---|---|
| 6 | `loop.ts` runIterationLoop 迭代入口 | **新增钩子**：每次 LLM 调用前，检查 task_table 有没有 active 步骤带 rolePack 声明 → 调 rolePackManager.resolveRoundAssemblyRole → setRoundAssemblyRole + 刷新 persona 前缀（refreshRolePackPrefixForRound）。**程序化**，不需要 LLM 决策 |
| 7 | `prepare.ts` | tryBuildMeetingPlan 从"prepare 阶段预置任务表 + meetingPreset 标记走多 turn"改为"prepare 阶段如果命中，直接调 sessionManager.writePlan 预置任务表（覆盖 write）"——不再标记 meetingPreset，让普通单 turn 路径正常消费任务表 |

### P3：测试更新（3 个文件）

| 步骤 | 文件 | 操作 |
|---|---|---|
| 8 | orchestrator.test.ts | 砍多 turn 编排测试（externalTaskLoop / runStepSequence / finalizeExternalTask / meetingPreset 跳过规划 turn 测试）；新增：会议机制在单 turn 内跑、LLM 自主建任务表（task_table_write）后 step 循环动态消费 |
| 9 | prepare.test.ts | 砍 meetingPreset 相关测试；保留 buildTeamContextBlock / rolePack 解析测试 |
| 10 | harness.ts | 砍 withinExternalTask / externalTaskHeadRoundId / meetingPreset / tryBuildMeetingPlan 相关 mock 字段 |

### P4：注释清理（2 个文件）

| 步骤 | 文件 | 操作 |
|---|---|---|
| 11 | roundStore.ts | 注释提到 externalTaskLoop 的地方改为"动态单 turn 内任务表驱动" |
| 12 | 全库 Grep | 扫一遍残留的 externalTaskLoop / withinExternalTask / externalTaskHeadRoundId / meetingPreset 字面量注释，更新或删除 |

---

## 四、验证清单

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npx vitest run` 全量测试全绿
- [ ] hosts 层 chatPanel.ts / chatView.ts 手动跑一次会议场景（输入"小组会议：讨论" + 配好 team）→ 单 turn 内多角色发言串行完成
- [ ] hosts 层手动跑一次复杂任务（"帮我重构这个项目"）→ LLM 动态决定是否建任务表 → step 循环跑完 → 一个 roundId → 一个摘要
- [ ] hosts 层手动跑 ask 挂起 → 用户回答 → 续跑 → 同一 turn 内
- [ ] 残留引用 Grep：`externalTaskLoop|completeExternalTask|runStepSequence|finalizeExternalTask|externalTaskHeadRoundId|withinExternalTask|meetingPreset` → src/ 生产代码零命中

---

## 五、为什么这是收敛方向而非"砍功能"

| 旧设计（多 turn 编排） | 新设计（动态单 turn） |
|---|---|
| 强制 LLM 先规划再执行 | LLM 自主——简单问题直接答，复杂问题自然建任务表 |
| 每个步 turn 独立 roundId（声称隔离但实际 messages 累积） | 一个 roundId 到底（messages 累积天然可见，LLM 看到完整历史） |
| 规划/步 turn/汇报拆分 → 摘要锚 head | 一个 turn 一个摘要（语义本来就是一个闭环） |
| 摘要恒 1:1 的实现靠"多 turn 共享 head roundId" | 摘要恒 1:1 的实现靠"一个 turn = 一个摘要" |
| 会议机制靠多 turn 编排器承载 | 会议机制靠"step 循环内嵌角色切换钩子"承载 |
| 宿主是插座（正确 SSOT） | **宿主是插座（完全保留）** |

**核心哲学不变**：turn 是最小单元、宿主是插座、LLM 自主决策。  
**变的是**：复杂任务承载方式从"强制多 turn 拆分"收敛到"动态单 turn 内 step 循环驱动"。
