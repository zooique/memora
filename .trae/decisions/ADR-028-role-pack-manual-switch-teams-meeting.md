# ADR-028 · 角色包体系：手动切换 + 组（组长+组员）+ 小组会议（任务表应用）

> **状态**：✅ 已接受
> **日期**：2026-08-29 **播种批次**：— **来源**：设计文档 [role-pack-exclusivity-relocation.md](../../docs/architecture/role-pack-exclusivity-relocation.md)（v0.13 定案）· 🔄 替代 ADR-026（已删除，git 历史可溯）

## 背景

角色包体系经历了多轮收敛：互斥黑名单（`exclusiveWith`）→ 白名单组+自动流转 → 显式/隐式分水岭（砍自动流转）→ 键/表层分层（砍键切换）→ 组员仅会议（砍日常切换）。最终定案：**角色包只能手动切换（唯一日常形态）**；角色包可**建组**（组长 + 组员名单，宿主数据）；**组员唯一作用是作为小组会议的参与者**（会议内临时表层装配：persona/rules/skills 换、键恒为组长）。无自动流转、无模式开关、无组员日常切换、无叠加、无会议引擎。

关键矛盾：角色包不只是提示词，`strategy` 键（memoryRecall / toolMode / temperature / tokenBudget / summaryFocus / handoff…）是 **Agent 运行的确定性行为配置**。自动切换 = 系统在用户无感知时替换全套行为配置 = **配置抖动**（正在执行的工具调用可能失权）。

## 决策

1. **切换**：只能手动切换单一角色包（完整切换，含键）。删除 `exclusiveWith`、`autoSwitch`、`autoMatch`、`tryAutoMatchRolePack`、`matchRolePackByLlm`、`stickyLocked`/`resetSticky`、`AUTO_MATCH_THRESHOLD` 全链。
2. **角色包分层**：底层键（strategy）= 行为配置，恒来自 `activePack`；表层文本（persona/rules/skills）= 设定记忆，可临时覆盖（仅会议内）。
3. **组**：`rolePackTeams: { leader, members[] }[]`（宿主数据，用户级持久化）。组长身份唯一、组员可多组引用、名单非空。非选择对象、非独立实体。
4. **组员**：仅会议参与，不用于日常（无下拉切换、无手动指定成员机制）；非会议时段零作用。
5. **会议**：用户发起 → LLM 用 `task_table_write` 组织任务表（`PlanStep.rolePack` 声明发言角色）→ loop 既有闭环逐项执行；**内核零会议代码**（仅任务级表层覆盖能力 + 组清单注入 + 范围校验）。
6. **表层装配**：会议任务项 = persona/rules/skills 换 + skills 加载跟随装配视角；**键不换**（恒组长）、工具面恒组长、summaryFocus 恒组长（已知取舍）。
7. **兜底**：单层 `builtinFallbackRole ?? BUILTIN_FALLBACK_PACK`（内核契约包 `memora助手`）；构建期 existsSync 校验（缺失即构建失败）；运行时缺失 → 无 persona 运行 + warning（降级优先，不装配失败）。
8. **选择解析**：单链 `activeRolePack（宿主持久化）→ 兜底包`；落兜底一次性上报宿主（写回与否宿主定）；`activePack` 唯一角色状态。
9. **持久化**：组与选择均宿主持久化（用户级 globalState），不用 `.memora`（=dataDir，配置入数据目录违反 ADR 原则）。
10. **checkpoint**：`PlanStep.rolePack` 进 checkpoint，schemaVersion 升版 v2（v1→v2 迁移无操作，可选字段天然兼容）。

## 理由

- **显式 vs 隐式是分水岭**：手动换角色/会议指定角色 = 用户意图（配置切换 OK）；关键词命中自动切 = 隐式（配置抖动，砍）。
- **键不随视角切（防抖动）**：表层是轻量视角，键切换才是重操作，两者不混用。
- **改 loop = 给 turn（问答闭环）开洞**（违反「turn 是最小完整单元」）；挂 `PlanStep` = 往既有挂载点生长（任务表本就由 LLM 经 `task_table_write` 维护）。
- **组数据归宿主**：组是环境关系（谁是谁的组员取决于环境），不进 manifest（角色包零环境知识）。
- **兜底包归内核**：兜底是机制底线，随内核分发，各宿主零分叉（构建期校验前移失败尽早）。

## 替代方案

| 方案 | 放弃原因 |
| ------- | -------- |
| 互斥黑名单（exclusiveWith） | 他指（"我对邻居的态度"）与插卡独立性矛盾；作者只能写死创作时邻居名（流通即失效）；黑名单默认全量可切（新包天然成漂移源） |
| 组内自动流转（关键词命中即切） | 隐式替换全套行为配置 = 配置抖动，违反「重配置对象只被显式调用」 |
| 复用单轮闭环跑会议 | 撞 chat 独占锁（不可重入）、写历史/沉淀摘要与"只读"冲突、超过切换限流阈值 |
| 会议内键也切换 | 组员身份与行为配置错配（翻译组员用组长写作者的 temperature）；工具面失权 |
| `leader` 字段 | 与成员声明序完全重叠 = 伪真理源；锚点 = 第一有效成员，队长是 UI 视觉标签不占数据字段 |
| 自动匹配阈值参数化 | 无参数名/无值/无落点；组内候选集收敛后切频天然下降，沿用既有阈值即可（伪定案） |

## 影响

- **删除**：`exclusiveWith`（types/manager/validator/示例包 manifest）、autoSwitch 及自动匹配全链、`RolePackMeta.exclusiveWith`、示例包互斥声明、§11.2「可叠加」属性。
- **新增**：`AgentOptions.rolePackTeams` / `builtinFallbackRole`；`activeRolePack` 语义扩展为解析链第一层；`PlanStep.rolePack` + `task_table_write` 扩展；内核兜底契约包 `memora助手` + `BUILTIN_FALLBACK_PACK` 常量；组数据校验（组长唯一/名单非空/悬空 warning）；会议机制（表层装配分支 + 组清单注入 + 范围校验 + skills 跟随装配视角）。
- **宿主**：组管理 UI（建组/拉组员/成员排序）+ 组员名单展示（「小组会议用」标注）+ 选择持久化（沿用 globalState）+ 会议入口（提示 LLM 可用任务表组织会议）。门面 `switchRolePack` 与 IPC 协议不变（选择对象只有角色包）。
- **ADR-026 被替代**：autoSwitch 宿主装配级键已随 v0.13 整体移除（无自动匹配可关）。

## 收敛补记（2026-08-29）：确定性输入触发

前文决策 5 把会议触发放在「LLM 见软指令后自愿调 `task_table_write`」。实测该触发是 LLM 自由裁量，简单提示词「小组会议：讨论xxx」时灵时不灵，可靠性不达标。

收口为**确定性输入触发**（最小内核 affordance，不引入会议引擎）：

1. **触发判定（SSOT 单一入口）**：`RolePackManager.tryBuildMeetingPlan(input)` —— 输入含「小组会议」**且** `activePack` 是某组组长 → 返回预置步骤（组员各一步 `rolePack=成员` + 一步汇总 `无 rolePack=组长视角`）；否则返回 `null`。
2. **预置（复用既有泛型）**：`SeedPrepare.run` 命中即经 `SessionManager.writePlan`（既有任务表写点，与 `task_table_write` 同机）预置，不新写会议专属写路径。
3. **强制多 turn 任务编排**：`orchestrator.runChat` 读 `SeedPrepareResult.meetingPreset` → 跳过规划闭环、直调 `completeExternalTask` 跑多 turn 步序列（复用既有步闭环 + `refreshAssemblyForRolePack` 逐成员硬切换）。
4. **软指令退役**：`buildTeamContextBlock` 原「须立即用 task_table_write」软触发删除，改为描述系统编排、仅要求 LLM 用 `task_table_update` 标记完成——消除「确定性预置」与「LLM 自建表」双写竞争。

**为何不违反决策 5「内核零会议代码」**：未引入会议执行引擎（无独立循环 / 键切换 / 重入）；确定性触发仅用既有 `PlanStep.rolePack` 表层覆盖能力 + 既有步闭环执行，是决策 5 允许能力的延伸，内核零会议执行引擎底线不变。

## 收敛补记（2026-09-06）：确定性预置退役，归 LLM 通道

决策再次反转：`tryBuildMeetingPlan` 确定性任务表自动预置退役，会议建表回归 LLM 经 `task_table_write` 自主组织（回到上文决策 5 原设计，且 LLM 通道 = 任务表 SSOT 唯一写点）。

- **触发变为主动指令**：删除 `prepare.run` 的「小组会议」守卫 + `writePlan('overwrite')` 预置，及 `RolePackManager.tryBuildMeetingPlan()`；`buildTeamContextBlock` 文案改为明确指挥 LLM 用 `task_table_write` 自主建表（带 rolePack=组员示例），不再承诺「系统自动预置」。
- **删除任务表截断链**：`taskLoopLimit` 键、`resolveTaskLoopLimit()`、`MAX_TASK_LOOP_LIMIT` / `DEFAULT_TASK_LOOP_LIMIT`、`GlobalStrategy.taskLoopLimit` 全删（键已无常量消费方）。
- **保留**：任务表泛型能力（`task_table_write/update`）、`PlanStep.rolePack` + 表层装配分支 + 组清单注入 + 范围校验、会议执行骨架（技能/装配跟随角色切换）。
- **理由**：任务表本通用能力，会议只借用；确定性预置是会议场景特化的越权补丁（前次补记已证软指令时灵时不灵），本次彻底删确定性、把写点收敛到唯一 LLM 通道，符合「最小单元不自造第二引擎」。
- **已知回归（已接受）**：LLM 可能需多发一次会话来主动建表（依赖提示词可靠性回到软驱动水平）；任务表为空时会议退化为普通问答闭环。

## 收敛补记（2026-09-07）：最小受控起点（确定性骨架半反转）

2026-09-06 退役补记的「已知回归」被真实样本证实（ME-6 触发样本，2026-09-07 互动叙事平台方案项目 round-1788738948095.json）：LLM 收到 `buildTeamContextBlock` 后**未调用 `task_table_write`**，改用 `write_file` 写 `.memora/task-table.md` 伪建表（全库首个该路径出现，纯模型自由发挥）——PlanStep 全程为空 → 顶部任务板不渲染、`PlanStep.rolePack` 视角切换机制失效、四角色发言全部组长视角一次 narrate 硬演。软指令建表遵从性实锤不达标。

**半反转定案（用户拍板「骨架 + 文案强化 + 自主扩步」）**，介于 2026-09-06（全软）与 2026-08-29（全确定性）之间：

1. **恢复确定性骨架预置**（`tryBuildMeetingPlan`，骨架版）：组长开场步（无 rolePack = 组长视角）→ 组员各一步（`rolePack=成员`）→ 汇总步尾（无 rolePack）。仅占位不固化发言内容；推进交 LLM；LLM 可经 `task_table_write` 追加步骤（append 扩步，不锁死多轮交互）。
2. **恢复 prepare 守卫**：无在途计划（pending/active 均无）时的「小组会议」输入 → `writePlan('overwrite')` 预置；在途 → 跳过（续会语义，不重开不叠加）。
3. **文案强化**（`buildTeamContextBlock`）：告知骨架已预置（按骨架逐项执行）+ 扩步纪律（rolePack=对应组员）+ **显式禁止 `write_file` 创建/修改任务表**（直击本次样本的伪建表绕行）。
4. **不再有任务表截断链**：骨架 ≤ `MAX_TEAM_MEMBERS`+2 步（≤6），无需 taskLoopLimit（2026-09-06 已删，不回填）。

**与 2026-09-06 退役的差异**：退役点删除的是「完整确定性预置」（含内容/流程编排 + 截断链）；本次仅恢复「占位骨架 + 单一守卫」，内容与推进仍归 LLM 单通道（`task_table_update` 标记），`task_table_write` 仍是任务表唯一写点。

**为何不违反决策 5「内核零会议代码」**：与两次补记一致——未引入会议执行引擎（无独立循环/键切换/重入），骨架预置复用既有 `writePlan` + `PlanStep.rolePack` 表层覆盖 + 既有步闭环执行。

**遗留**：骨架只解决「建表/表可见/视角钩子」（ME-6/ME-7）；「逐步推进、一步一停换视角」的执行纪律仍靠 LLM 遵从（ME-8 观察）。真实会议跑 3-5 次后按 ME-7 探针核对建表率与勾选率，决定是否再收紧。

## 何时回顾

- 出现「需要某角色完整能力（键+工具）参与会议」的诉求时——当前方案要求手动切换该角色（完整切换），而非会议内切键；若该诉求成高频，重新评估会议内键切换的代价。
- 出现「组员需日常使用」诉求时——当前组员零日常作用；若用户场景证实需要，重新评估「组员日常切换」的分层代价。
