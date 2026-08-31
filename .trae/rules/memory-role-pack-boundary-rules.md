---
alwaysApply: true
description: 记忆系统 × 角色包边界纪律——设定记忆（persona/rules/skills）唯一归角色包内容层；记忆系统单轨 = 问答闭环摘要记忆（round-summary，带 summaryType 语义标签，type 不设时效），会话摘要归会话记录存储（SessionMeta）；content 仅治理页手动写入，非内核自动轨；角色包内容文件约定名（persona.md/rules.md）；能力声明独立顶层 capabilities（C2）；两级技能渐进披露；新增设定记忆一律进角色包，记忆库禁止再写设定记忆
---

# 记忆系统 × 角色包边界纪律

> **「你是谁、你怎么做事」归角色包（设定记忆）；「聊了什么」归记忆系统（摘要记忆）。** 两刀切、不互存、不双写。设计真理源：[memory-role-pack-boundary.md](../../docs/architecture/memory-role-pack-boundary.md) · ADR-025。
>
> 实现终点态（ADR-025 收敛）：设定记忆纯文件装载、不写 SQLite / 记忆库。

## 一、分界线

| 维度 | 归属 | 承载形态 |
| --- | --- | --- |
| 你是谁 / 怎么做事（persona/rules/skills） | **角色包** | `<configDir>/role-packs/<名>/` 下 persona.md / rules.md / skills/*；能力声明在顶层 `capabilities`（C2） |
| 聊了什么 / 发生过什么 | **记忆系统（单轨）** | **round-summary**（问答闭环摘要记忆，每轮生成，带 summaryType/sessionName/roundId）；会话级摘要归 **会话记录存储（SessionMeta.summary/keyTopics）**，不进记忆库 |

**两个禁止**：

1. 记忆库**禁止写入设定记忆**（不再新增 `source: 'persona'/'rule'/'skill'`）；
2. 角色包**禁止写入对话记忆**（只承载设定，不承载轮次摘要）。

## 二、可执行规则

- **R1 新增设定一律进角色包**（persona.md/rules.md/skills/*），不走 `agent-config/personas|rules|skills` 进记忆库。
- **R2 新增记忆只允许摘要记忆（单轨）**：round-summary（自动轨）+ content（治理页手动轨）。判断：是"对话的沉淀"还是"思考方式的设定"？前者进记忆库，后者进角色包。
- **R3 读取从角色包**（`RolePackManager`/`assembleRolePack`），不从记忆库 `getBySource` 读。
- **R4 迁移纪律**：停写→切读分档执行，任何一步不得跳过；存量设定记忆行保留（软删兼容），宿主一次性清理。
- **R5 摘要记忆单轨**：**round-summary = 唯一自动轨**（每轮问答闭环自动生成，带 summaryType/sessionName/roundId 溯源）。**content = 用户手动轨**（仅治理页经 `writeUpsert` 写入，不由内核自动生成，不在 `SOURCE_LABELS`，属 `GOVERNANCE_SOURCES`）。**会话级摘要不进记忆库**——归会话记录存储 `SessionMeta`（summary/keyTopics），随 `deleteSession` 一并删除。路标检索闭环：`list_sessions`（粗定位）→ `trace_summary`（细取证），均在 `BUILTIN_TOOLS`。禁止新增无标签、无溯源的第二轨道自动记忆源。治理操作软删 round-summary 时溯源即清空（原会话/轮已物理回收）。
- **R6 type 不设时效**：`summaryType` 纯语义标签，禁止新增 type→时间窗口过滤；有效否由 superseded + 召回相关性判定。
- **R7 内容文件零声明**：persona.md/rules.md 约定俗成（manifest 不声明即回退），skills/ 目录动态扫描；manifest 不承载内容路径注册，禁止"路径写错静默丢内容"的自命名字段。
- **R8 能力声明独立顶层** `capabilities`；禁止在技能文件/skills 项塞 capability。
- **R9 两级技能渐进披露**：通用技能（全局池 `configDir/skills/`，全局激活）+ 角色包技能（`manifest.skills`，角色激活才激活），统一渐进披露（L1 元数据常驻 + L2 read_skill 按需读）。禁止把通用技能复制进每个角色包。

## 三、已知坑（对抗式核查）

- **rule 语义不对等**：角色包 `parseRules` 只认 `- ` 无序列表行（`rolePackManager.ts`）；记忆库 rule 是任意 markdown，搬迁需转换器。
- **skills 正文不预装载**：角色包 skill 是"生态指针"，正文靠 `readSkillContent` 按需读；依赖索引正文的宿主 UI 搬迁后断供。
- **guardrail 已摘除**：无空转链，不新增 guardrail 代码。
- **宿主 SQLite schema 不可见**：宿主持有 `WHERE source='rule'` 等查询会静默失效，需宿主核对。
- **skills 目录扫描（C3）**：角色包 `skills/` 目录动态扫描注册（frontmatter 声明 name/description），新增技能只写文件免 manifest 注册；技能文件必须带 frontmatter 才有 description 暴露。

## 四、审查点

- [ ] 新代码 `upsert` `source='rule'/'skill'/'persona'`？（违 R1）
- [ ] 从记忆库 `getBySource(RULE/SKILL/PERSONA)` 读设定？（违 R3）
- [ ] 角色能力绕过角色包另起通道？（违插卡机 §11）
- [ ] 新增记忆源无 `summaryType` + 结构化溯源？（违 R5）
- [ ] 出现 type→时间窗口过滤？（违 R6）
- [ ] manifest 声明非约定名内容路径？（违 R7）
- [ ] skills 项里放 capability？（违 R8）
- [ ] 通用技能复制进每个角色包？（违 R9）
- [ ] manifest.skills 逐项注册技能？（C3 已改目录扫描）
- [ ] `assembler.ts` systemPrompt 装配仍存在 persona 兜底？（应唯一走 rolePackPrompt）