---
alwaysApply: false
description: 记忆系统 × 角色包边界——设定记忆（persona/rules/skills）唯一归角色包；记忆系统单轨 = round-summary 摘要记忆；会话摘要归 SessionMeta；技能两级渐进披露
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
- [ ] `assembler.ts` 装配仍有 persona 兜底？（应唯一走 rolePackPrompt）
