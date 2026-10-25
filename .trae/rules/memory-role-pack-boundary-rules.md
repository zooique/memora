---
alwaysApply: false
description: 记忆系统 × 角色包边界——设定记忆（persona/rules/skills）唯一归角色包；记忆系统单轨 = round-summary 摘要记忆；会话摘要归 SessionMeta；技能两级渐进披露；MCP server 不属角色包能力面（R10）
---
# 记忆系统 × 角色包边界纪律

> **「你是谁、怎么做事」归角色包；「聊了什么」归记忆系统。** 两刀切、不互存、不双写。
> 设计真理源：`docs/architecture/memory-role-pack-boundary.md` · ADR-025。

## 一、分界线

| 维度 | 归属 | 承载形态 |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| 你是谁 / 怎么做事（persona/rules/skills） | **角色包** | `role-packs/<名>/` 下 persona.md / rules.md / skills/*；能力声明在顶层 `capabilities` |
| 聊了什么 / 发生过什么 | **记忆系统（单轨）** | **round-summary**（每轮生成，带 summaryType/sessionName/roundId）；会话级摘要归 **SessionMeta**（summary/keyTopics），不进记忆库 |

**两个禁止**：① 记忆库禁写设定记忆（不新增 `source:'persona'/'rule'/'skill'`）；② 角色包禁写对话记忆。

## 二、可执行规则

- **R1** 新增设定一律进角色包（persona.md/rules.md/skills/*），不走记忆库。
- **R2** 新增记忆只允许摘要记忆（单轨）。判断：是「对话的沉淀」还是「思考方式的设定」？前者记忆库，后者角色包。
- **R3** 读取从角色包（`RolePackManager`/`assembleRolePack`），不从记忆库 `getBySource`。
- **R4** 迁移纪律：停写 → 切读分档执行，任一步不得跳过；存量设定记忆行保留（软删兼容）。
- **R5** **round-summary = 唯一记忆轨**（带 summaryType/sessionName/roundId 溯源）；`content` 为历史残留 source（无生产写入路径，仅治理页编辑复用）。会话级摘要归 SessionMeta，随 `deleteSession` 删除。路标检索：`list_sessions`（粗定位）→ `trace_summary`（细取证）。**禁止新增无标签、无溯源的第二轨道自动记忆源**。
- **R6** `summaryType` 纯语义标签，禁新增 type→时间窗口过滤；有效否由 superseded + 召回相关性判定。
- **R7** persona.md/rules.md 约定俗成（manifest 不声明即回退），skills/ 目录动态扫描；禁「路径写错静默丢内容」的自命名字段。
- **R8** 能力声明独立顶层 `capabilities`；禁在技能文件/skills 项塞 capability。
- **R9** 两级技能渐进披露：通用技能（全局池）+ 角色包技能（`manifest.skills`），均 L1 元数据常驻 + L2 `read_skill` 按需读。禁把通用技能复制进每个角色包。
- **R10** **MCP server 不属角色包能力面**（2026-10-25 拍板 · 真源 `docs/方案-MCP工具接入-20261023.md` §4.4）。`manifest` 与 `capabilities` 均不得出现 MCP server 引用（名字 / 路径 / 配置片段）；MCP 配置与免确认清单**恒为用户级**，宿主不读仓库内 MCP 配置文件（`.mcp.json` / `.vscode/mcp.json`）。**判据**：角色包管**内容面**（你是谁、怎么做事），MCP server = **在本机拉起的任意进程**（写一条配置 = 授权一条命令在你机器上执行 = **用户授权面**）。**结构守护已存在**（读码实证）：`capabilityMap.ts` 的 `CAPABILITY_TO_TOOLS` 是**闭表**、未知能力静默跳过，而 MCP 派生名是**运行时动态**的、静态表装不下 ⇒ 声明 MCP 能力在代码层面本就是无效的，真正的腐化入口是给该表加通配（审查点守此）。⇒ 同时关掉两种形态：「换角色包自动换 MCP 能力集」与「项目自带 MCP 能力」；重开须先改本条（二者绑死，单独放开任一侧无效）。

## 三、已知坑

- **rule 语义不对等**：角色包 `parseRules` 只认 `- ` 无序列表行；记忆库 rule 是任意 markdown，搬迁需转换器。
- **skills 正文不预装载**：正文靠 `readSkillContent` 按需读；依赖索引正文的宿主 UI 搬迁后断供。
- **宿主持久化归宿主**：内核不假设 schema（宿主注入 `IMemoryStorage`）；宿主自建 SQL 后端须自行核对 source 过滤 / 软删语义。
- **技能文件必须带 frontmatter** 才有 description 暴露（目录扫描注册，免 manifest 登记）。

## 四、审查点

- [ ] 新代码 `upsert` `source='rule'/'skill'/'persona'`？（违 R1）
- [ ] 从记忆库 `getBySource(RULE/SKILL/PERSONA)` 读设定？（违 R3）
- [ ] 角色能力绕过角色包另起通道？（违插卡机 §11）
- [ ] 新增记忆源无 `summaryType` + 结构化溯源？（违 R5）
- [ ] 出现 type→时间窗口过滤？（违 R6）
- [ ] manifest 声明非约定名内容路径？（违 R7）
- [ ] skills 项里放 capability？（违 R8）
- [ ] 通用技能复制进每个角色包？（违 R9）
- [ ] manifest.skills 逐项注册技能？（已改目录扫描）
- [ ] `manifest` / `capabilities` 出现 MCP server 引用？（违 R10）
- [ ] 宿主读仓库内 MCP 配置文件（`.mcp.json` / `.vscode/mcp.json`）？（违 R10）
- [ ] `assembler.ts` 装配仍有 persona 兜底？（应唯一走 rolePackPrompt）
