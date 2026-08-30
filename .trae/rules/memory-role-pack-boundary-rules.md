***

alwaysApply: true
description: 记忆系统 × 角色包边界纪律——设定记忆（persona/rules/skills）唯一归角色包内容层；记忆系统 = 摘要记忆（round-summary 轮次级 + content 会话级，summaryType 语义标签分类，type 不设时效）；角色包内容文件约定名（persona.md/rules.md）；能力声明独立顶层 capabilities（C2）；两级技能渐进披露（通用全局 + 角色包绑定）；新增设定记忆一律进角色包，记忆库禁止再写设定记忆
----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

# 记忆系统 × 角色包边界纪律

> **一句话**：**"你是谁、你怎么做事"归角色包（设定记忆）；"聊了什么、发生过什么"归记忆系统（摘要记忆）。** 两者一刀切，各管各的，不互存、不双写。
>
> 设计真理源：[memory-role-pack-boundary.md](../../docs/architecture/memory-role-pack-boundary.md) · ADR：[ADR-025](../decisions/ADR-025-memory-role-pack-boundary.md)

***

## 一、分界线（不可逾越）

| 维度                                    | 归属       | 承载形态                                                                                                                        |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| 你是谁 / 你怎么做事（persona / rules / skills） | **角色包**  | `<configDir>/role-packs/<名>/` 下 `persona.md` / `rules.md` / `skills/*`（manifest.json 注册）；**能力声明在顶层** **`capabilities`**（C2） |
| 聊了什么 / 发生过什么                          | **记忆系统** | 摘要记忆：round-summary（轮次级，sessionName+roundId 双溯源）+ content（会话级，sessionName 溯源），带 `summaryType` 语义标签                           |

**两个"禁止"**：

1. **记忆库禁止写入设定记忆**——`source: 'persona'/'rule'/'skill'` 不再新增；
2. **角色包禁止写入对话记忆**——角色包只承载设定，不承载轮次摘要。

## 二、可执行规则

### 新增设定（R1）

> 新增角色、规则、技能时，**一律写入角色包**（persona.md / rules.md / skills/\*），不走 `agent-config/personas|rules|skills` 目录进记忆库。

### 新增记忆（R2）

> 对话记忆只允许摘要记忆——round-summary（轮次级）与 content（会话级）。判断标准：**它是"对话的沉淀"还是"思考方式的设定"**？前者进记忆库，后者进角色包。

### 读取路径（R3）

> 读取 persona/rules/skills 从**角色包**读（`RolePackManager` / `assembleRolePack`），不从记忆库 `getBySource` 读。

### 迁移纪律（R4）

> 收敛分档执行（档 0 定案 → 档 1 停写 → 档 2 切读 → 档 3 语义对齐），**先停写后切读**，任何一步不得跳过；存量设定记忆行保留（软删兼容），宿主一次性迁移清理。

### content 融入纪律（R5）

> **记忆库双轨**（2026-08-30 更正，勿再按旧描述实现）：
> - `round-summary` — **自动轨**。每轮对话生成，带 `summaryType` / `sessionName` / `roundId` 溯源。
> - `content` — **用户手动轨**。仅由治理页经 `writeUpsert` 写入，**不由内核自动生成**。
>   注：`content` 不在 `SOURCE_LABELS` 内（属 `GOVERNANCE_SOURCES`），勿误当作「会话级摘要记忆」。
>
> **会话级摘要不进记忆库**：它是**路标**而非记忆——存于 `SessionMeta`（`summary` / `keyTopics`，
> 与双层命名 `autoName`/`displayName` 并存），随 `deleteSession` 一并删除。
> 历史沿革：`SessionArchiver` 曾将其写入 `content` 记忆，R3 排雷后改为只更新 SessionMeta；
> 旧版 R5 仍按改动前描述，导致 ⑥ 误实现 `softDeleteSessionContents`（无生产者，恒空转，已删）。
>
> **禁止新增无标签、无溯源的第二轨道自动记忆源**。（`isTraceable` 已移除（2026-08-28）：无行为消费者，溯源降级改按读时查找结果渲染，见 memory-as-summary §5.2）
>
> **例外（⑥ 治理操作，2026-08-29）**：随会话/问答闭环删除而软删的轮次摘要（`softDeleteRoundSummaries`），其溯源字段（`sessionName`/`roundId`）在删除时即清空——原会话/轮已物理回收，溯源悬空无意义；回收站恢复后即为**无溯源的独立记忆**。这是治理操作的脱钩行为，非新增无溯源记忆源（治理页单条软删 `writeDelete` 仍保留溯源，误删恢复保留关联）。

### type 不设时效（R6）

> `summaryType` 是**纯语义标签**，不携带时效性。禁止新增 type→时间窗口的过滤逻辑；记忆是否有效由 superseded（写时取代）+ score 衰减（自然沉底）判定，不由时间流逝判定。

### 内容文件零声明（R7）

> 角色包内容文件**全部约定俗成**：`persona.md`（身份）、`rules.md`（规则）——manifest **不声明**即回退约定名；`skills/` 目录动态扫描（C3）。manifest 不承载任何内容路径注册。禁止新增「路径写错静默丢内容」的自由命名字段。

### 能力声明独立（R8）

> 角色能力声明**只放 manifest 顶层** **`capabilities`**（`{ capability: '域:动作', description? }`）。禁止在技能文件或 skills 项里塞 capability（C2）。

### 两级技能渐进披露（R9）

> 技能体系两级同构：**通用技能（全局池** **`configDir/skills/`，全局激活）+ 角色包技能（`manifest.skills`，角色激活才激活）**，统一渐进披露（L1 元数据清单常驻 + L2 `read_skill` 按需读正文）。禁止把通用技能复制进每个角色包（R1 的边界）。

## 三、已知坑（对抗式核查实证）

1. **rule 语义不对等**：角色包 `parseRules` 只认 `- ` /`* `  无序列表行（`role-pack/rolePackManager.ts`）；记忆库 rule 是任意 markdown。搬迁需转换器，否则丢内容。
2. **skills 正文不预装载**：角色包 skill 是"生态指针"，正文靠 `readSkillContent` 按需读；依赖索引正文的宿主 UI 搬迁后会断供。
3. **guardrail 已摘除（2026-08-17）**：guardrail 空转链（零规则/无扫描映射/无消费者）已随档 1 移除，不再新增 guardrail 相关代码。
4. **宿主 SQLite schema 不可见**：宿主持有 `WHERE source='rule'` 等查询会静默失效，需宿主核对配合。
5. **skills 目录扫描（C3，2026-08-18）**：角色包 `skills/` 目录**动态扫描**注册（frontmatter 声明 name/description），新增技能只写文件免 manifest 注册——与全局技能池同构。manifest.skills 仅可选白名单过滤。注意：技能文件必须带 frontmatter 才有 description 暴露（渐进披露 L1）。

## 四、审查点（代码评审时检查）

* [ ] 是否有新代码 `upsert` `source='rule'/'skill'/'persona'` 记忆？（违反 R1）

* [ ] 是否有人从记忆库 `getBySource(RULE/SKILL/PERSONA)` 读设定？（违反 R3）

* [ ] 新增的"角色相关能力"是否绕开角色包另起通道？（违反插卡机模型 §11）

* [ ] 新增记忆源是否带 `summaryType` + 结构化溯源？（违反 R5）

* [ ] 是否出现 type→时间窗口的过滤逻辑？（违反 R6）

* [ ] 是否在 manifest 声明非约定名内容文件路径？（违反 R7）

* [ ] 是否在 skills 项里放 capability？（违反 R8）

* [ ] 是否把通用技能复制进每个角色包？（违反 R9）

* [ ] 是否在 manifest.skills 里逐项注册技能？（C3 已改目录扫描——新增技能只写文件，无需注册）

* [ ] `assembler.ts` systemPrompt 装配是否仍存在 persona 兜底？（收敛完成后应唯一走 rolePackPrompt）

