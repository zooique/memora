# run_team_meeting — 探索方案（角色包小组会议简化）

> 状态：**已落地（2026-09-16 路线拍板 · 方案 A 已实现）**——`run_team_meeting` 已作为内置工具实现在 `src/agent/builtinTools.ts` / `builtinToolHandlers.ts`（handler 内拼接多角色 persona 后直接调 provider.chat()）。探索期可逆决策已验证被真实消费，本文保留作方案记录（不占 ADR 编号，见 `.trae/rules/exploration-decision-sedimentation-rules.md` S1）。
> 定位：方案 A —— 用一个独立内置工具 run_team_meeting 取代「小组会议」在 task_table + 装配视角切换（T1）之上的三层叠加实现，实现**真实注入多角色 persona 设计文本、以各角色视角评估同一问题**，且收敛为单次 LLM 调用。
> 路线（用户拍板 2026-09-16）：**工具内调 LLM 实现**——run_team_meeting 在 handler 内拼接多角色 persona 后直接调 provider.chat()。

---

## 1. 现状问题与判定

### 1.1 现状：小组会议是「三个机制叠加」
实证盘点（`src/role-pack/rolePackManager.ts` + `src/agent/agent.ts` + `assembler.ts`）：
```
关键词"小组会议"命中
   → tryBuildMeetingPlan 预置骨架任务表（组长开场→组员各发言→汇总）       rolePackManager.ts:533-551
       → 依赖 task_table 架构（写入/更新/每步 done-blocked/step_boundary）
           → 依赖装配视角切换 T1 链路（getTaskTable → applyActiveStepAssembly → applyActiveStepAssemblyIfChanged）
               → 支撑 RolePackTeam 结构 + validateTeams 5条校验 + MAX_TEAM_MEMBERS 截断
               → 支撑 activeTeamMembers 消费入口 + resolveRoundAssemblyRole 视角切换
               → 支撑 buildTeamContextBlock 文案（指挥 LLM 声明 rolePack）
                   → 镜像：宿主 settingsPanel 一套重复校验 + 持久化 key + 热更新
```

**定性**：不是"会议功能复杂"，而是**任务表闭环 × 视角切换 × 小组名单 三层机制为了一次"开会"全部拉入**。按 single-truth-source 自问三题：去掉"小组会议"这个特化场景，task_table 主链路仍完整 → 会议是 task_table 之上的**特化客串**，不是最小单元（turn）的自然生长物。

### 1.2 现状的一个关键真相（也是方案 A 的可行性基础）
现有视角切换**已经是"真注入 persona 全文"**，不是标签切换：
- `refreshRolePackPrefixForRound` → `rolePackManager.buildSystemPrompt(assemblyName)` → 用该角色包的 **persona/rules/skills 全文**重建 system 前缀 → `buildSystemPromptPrefix` 拼进 LLM 调用（assembler.ts:99 `rolePackPrompt`）。

代价 = 复杂度来源：**靠 task_table 每步 done/blocked 推进 + step 携带 rolePack 触发多次切换、多次 LLM 调用**。每切一次视角 = 一次新 LLM 调用。

---

## 2. 目标形态（方案 A · 工具内调 LLM）

### 2.1 run_team_meeting 语义
```
run_team_meeting(group, topic)
   → 读取组内 组长+组员 共 N 个 RolePack，各取其 persona 全文（buildSystemPrompt(name)）
   → 拼成一个 system prompt：
     【任务】请以以下 N 个角色视角，分别评估议题「topic」：
     ─ 角色1（组长·架构师）：<persona 全文>
     ─ 角色2（组员·测试）：<persona 全文>
     ─ 角色3（组员·产品）：<persona 全文>
     请分别给出每个角色的观点（用该角色的设定、专业视角、立场），最后以组长视角汇总。
   → 一次 provider.chat() 完成，返回多角色评估结果文本。
```

### 2.2 与现状的关键差异
| 维度 | 现状（task_table + T1） | 方案 A（run_team_meeting） |
|---|---|---|
| LLM 调用次数 | 每视角一次，靠任务表驱动步进 | 一次调用含 N 视角 |
| 角色注入 | 每次只换一个（system 前缀整体替换） | 一次注入全部 N 个 persona 全文 |
| 编排依赖 | task_table / step_boundary / 装配切换 / validateTeams / MAX 截断 | 无（纯工具内串联） |
| 组名单 | 内核+宿主两套校验 | 工具参数直接传组名，复用 rolePack 读取 |

---

## 3. 可行性评估（基于现有原语）

**可行性：高。** 方案 A 只是**串联现有原语**，非新造：

| 需要的能力 | 现有落点 | 复用 |
|---|---|---|
| 读取单个角色包 persona 全文 | `rolePackManager.buildSystemPrompt(name)`（agent.ts:1365 现用） | ✅ 直接调 |
| 解析组名 → 成员角色包名 | `RolePackManager.rolePackTeams` + `activeTeamMembers` getter | ✅ 复用名单结构 |
| 多段 persona 拼装 | `buildSystemPromptPrefix` 已示范多段拼接（assembler.ts:93-120） | ✅ 参考拼接模式 |
| 单次流式调用 | `provider.chat()` | ✅ 现成 |

**改动面（按坐标）**：

| 改动 | 位置 | 规模 |
|---|---|---|
| 新建内置工具 `run_team_meeting` | `src/agent/builtinTools.ts` 注册 toolDef + `src/agent/builtinToolHandlers.ts` 实现 | 中 |
| handler 内读 N 角色 persona + 拼 prompt + 调 provider | `builtinToolHandlers.ts` 新方法 | 中 |
| `run_team_meeting` 参数校验 + security guard | handler 内 | 小 |
| 其余（会议骨架/视角切换） | **第一步不动**，并行走新通道 | 无（渐进） |

---

## 4. 需要诚实指出的边界（不迎合）

1. **工具内嵌 LLM 调用是新架构形态**。现有内置工具都是"纯函数（参数 in → 文本 out）"，run_team_meeting 首次在 handler 内调 provider.chat()。这触及"工具=纯执行"边界——这是本次改动最大的架构震动点，需在验证中重点观察是否破坏 loop 的调用模型（工具结果回喂、拒绝消息、token 计量）。
2. **拆除旧机制是大动作，不在第一步做**。先加并行走新通道，真机验证 run_team_meeting 产出质量达标后，再评估是否淘汰 task_table 会议骨架（那是独立的渐进重构）。
3. **多角色 persona 同放一个 system prompt 的 token 成本**：N 个角色全文 + 议题，预算需核（超过 SINGLE_TOOL_RESULT_MAX_TOKENS 之前题是否完整传递）。

---

## 5. 验证计划（探索期）

### 5.1 计划
1. **真机闭环**：真实 LLM 调 run_team_meeting(组, "议题")，验证：
   - 是否真实注入了 ≥2 个角色的 persona 语义（输出的各角色观点能体现各角色设定差异）；
   - 单次调用完成（工具失败数 = 0）；
   - 返回是否含组长汇总。
2. **回归**：全量 vitest 绿灯 + tsc 0 错。
3. **并行共存**：确认新通道与旧会议骨架互不干扰（旧机制仍工作）。

### 5.2 真机实证结论（2026-09-16 已跑通 ✅）
用真实角色包（白话方案设计师 / 共鸣小说家 / memora 助手）+ 真实 LLM（mimo-v2.5）探针验证：

| 验证项 | 结果 |
|---|---|
| 多角色 persona 全文注入 | ✅ `RolePackManager.buildSystemPrompt(name)` 取出三角色真实 persona，拼入单次 system prompt |
| 单次调用出各视角 | ✅ 一次 `provider.chat()`，约 30s / 1373 字，含三视角 + 组长汇总 |
| 各视角体现角色设定差异 | ✅ 三视角方法论/结构/措辞各自鲜明：小说家用"人物/内核/风格记忆、设定圣经式分卷"；助手讲"跨会话连续性/偏好学习/隐私噪音成本"；设计师真用"种子最小单元/白话总览/可开发性结论"结构 |
| 真实 LLM 闭环 | ✅ mimo 原生调用，工具失败 0 |

**验证结论：方案 A「工具内调 LLM 注入多角色 persona → 各视角评估」技术可行性已实证成立。** 关键原语全部现成（buildSystemPrompt / rolePackTeams / 多段拼装 / provider.chat），方案 A 只是串联，无需新造。

### 5.3 实证暴露的两个边界（需落入正式实现）
1. **输出姿态 = 结构化长文，非多人对话**：单次调用让模型自组织分节。→ run_team_meeting 适用**评估/评审型会议**（各视角独立给观点 + 组长汇总），**不覆盖你来我往的讨论型会议**（需交互则保留旧骨架或另设计）。
2. **persona 全文 token 成本高**：三角色单次调约 30s，大组（≥4 角色）需设角色数上限 / persona 截断，避免超 SINGLE_TOOL_RESULT_MAX_TOKENS。

---

## 6. 后续演进（固化为 ADR 的前置条件）

- 被真实场景复现消费（用户实际用 run_team_meeting 开会）且稳定；
- 新通道验证"真实注入各角色文本 + 各视角评估"效果达标；
- **会议双形态分流定案（2026-09-16，用户拍板·分流/降权）**：run_team_meeting 吃**评审型**默认路径（LLM 自主判断该评审时调它）；旧 task_table 会议骨架**不淘汰**，降级为「可打断/可续会/可中途挂工具/过程可见」的**显式可交互会议**通道（宿主「小组会议」UI 入口保留）。
  - **不带伤判据（stack/实证）**：可交互形态是仍在用的真实能力（宿主有专属 UI 入口）；ME-8 已证违约的只是「多角色轮流发言」的**软指令可靠度**（常退化为一次性多视角，恰为 run_team_meeting 形态），**不否定** task_table 的**确定性结构能力**（可打断/续会/挂工具/过程可见）。故不能一刀删。
  - **可淘汰层收窄为会议专用层**：`tryBuildMeetingPlan` / `buildTeamContextBlock`（指挥建表部分）/ T1 会议视角切换。`task_table` 主干与 `rolePackTeams` 数据源（run_team_meeting 与宿主 UI 继续消费）须保留。
  - **去留由实证定**：保留期采集双通道真实使用频次，触发 = 真实会议长时间（约一个发布周期）无可交互/续会消费 → 届时评估整体移除会议专用层。

> 关联：`.trae/rules/exploration-decision-sedimentation-rules.md`（S1 探索期落地）、`single-truth-source-mindset.md`（最小单元）、`progressive-refactor-rules.md`（渐进，先并行走证再拆）、`legacy-contract-audit-rules.md`（不带伤：不砍还在用的能力）。