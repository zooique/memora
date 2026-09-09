# 记忆系统 × 角色包 边界收敛设计

> **一句话**：设定记忆（persona / rules / skills）收进角色包内容层；记忆系统 = 摘要记忆单轨（round-summary 轮次级，唯一自动轨，按 summaryType 语义标签分类；会话级摘要归 SessionMeta 会话记录存储）。两者一刀切，各管各的。

## 一、问题

memora 曾存在**双轨并存**：设定记忆既走 `agent-config` 目录 → 记忆库（source: persona/rule/skill），又由角色包承载（personaContent/rules/skills）。两套装载路径并存导致：

| 症状 | 危害 |
|------|------|
| 设定记忆写入记忆库 | 记忆库混入 persona/rule/skill，非摘要单轨 |
| 记忆库不「纯」 | 存储含 persona/rule/skill/work-projection/guardrail/content 等 8 类 source，非摘要单轨 |
| 角色包未完全接管 | 角色包优先、persona 兜底，两套并行，系统提示装配分叉 |
| 文档叙事分叉 | 「单轨」只对洞察/画像层成立，设定记忆层从不收敛 |

根因：**「设定记忆归角色包」与「记忆系统 = 摘要记忆」两条边界此前分开演进，未统一为同一分界。** 本文档将二分法定案。

## 二、目标态（设计真理源）

### 2.1 核心原则

> **角色包 = 一套「可插拔的设定卡」**：persona（身份）+ rules（规则）+ skills（技能），换卡即换角色，不依赖记忆系统。
>
> **记忆系统 = 只存一种记忆**：round-summary（轮次摘要），带分类标签（preference / decision / fact / intent / general）。

### 2.2 分界线（最重要）

| 维度 | 归属 | 说明 |
|------|------|------|
| 你是谁 / 你怎么做事（persona / rules / skills） | **角色包** | 设定记忆，不进记忆库 |
| 聊了什么 / 发生过什么（对话内容） | **记忆系统** | 只留摘要（round-summary） |

**设定（怎么思考）与记忆（发生过什么）彻底分开，互不干扰。**

### 2.3 目标态存储形态

- **记忆库**：只有**摘要记忆单轨**——`round-summary`（轮次级，唯一自动轨，见 [memory-as-summary.md §2.2](memory-as-summary.md)）。会话级摘要归会话记录存储 `SessionMeta`（summary/keyTopics，不写记忆库）；`content` 仅治理页手动写入轨（非自动生产，见规则 R5）。profile / work-projection 已随收敛移出记忆库（作品投影落项目级目录 `<memoraDir>/projections/`，见 [memora-api-reference.md §九](../memora-api-reference.md)）。guardrail 空转链已摘除（零规则、无扫描映射、无消费者）。
- **角色包**：`<configDir>/role-packs/<名>/`，`manifest.json` 唯一权威 + `persona.md` / `rules.md` / `skills/*` 内容文件（见 [role-pack-spec.md §2.2](role-pack-spec.md)）。
- **召回**：只对摘要记忆生效（双通道相关性召回 + 会话窗口/时间排序，见 [memory-as-summary.md §4](memory-as-summary.md)）；type 是纯语义标签，不设时效。设定记忆不再进召回面。

## 三、执行规则（收敛纪律）

### 档 1：停止写入
> 设定记忆不再写入记忆库——内核启动扫描不对 persona/rule/skill 建索引，运行时无"写索引"入口（`addRule`/`addSimpleRule`/`addSkill`/`addSimpleSkill` 死门面已移除）。存量设定记忆行保留（软删兼容），由宿主一次性迁移清理。

### 档 2：读取切换
> 设定读取从记忆库切到角色包——系统提示装配 `systemPrefixParts = [rolePackPrompt]` 唯一（取消 persona 兜底，persona 兜底随本档移除）；`getBootstrapMemories()` 不再返回设定注入，消除「角色包 rules + 索引 rule」双轨重复注入；memoryInspector snapshot 的 bootstrap 层仅作存量兼容展示（不参与装配），角色包读取是宿主 UI 职责。

### 档 3：语义对齐
> 收敛最终形态需语义对齐——**rule 语义不对等**：角色包 `parseRules` 只认 `- `/`* ` 无序列表行，记忆库 rule 是任意 markdown（含元数据/可软删）。搬迁需转换器，把现有规则文件转为角色包 rules.md 可解析格式，否则丢内容。
>- **guardrail 已摘除**：guardrail 是「零规则、无扫描映射、无消费者」的空转链，与目标态冲突，不作为独立模块保留。原「guardrail 归宿」决策作废。

**收敛顺序纪律**：先停写（档 1）后切读（档 2），再语义对齐（档 3），任何一步不得跳过。

## 四、决策定案

| # | 决策 | 定案 |
|---|------|------|
| D1 | guardrail 归宿 | **作废**——guardrail 空转链已摘除，无此物无需归宿 |
| D2 | 存量设定记忆数据 | 由宿主提供一次性迁移脚本；文件已在角色包/agent-config 中，SQLite 索引行清空或标记兼容 |
| D3 | skills 正文展示 | **渐进披露**（readSkillContent 按需读），不在记忆库镜像保留 |
| D4 | content 会话归档 | **作废（2026-09-09 剪枝）**——会话级摘要不进记忆库：SessionArchiver 只更新 `SessionMeta`（summary/keyTopics）；`content` 为历史残留 source，无生产写入路径（`memoryInspector.writeUpsert` 仅治理页编辑已有记忆复用，无新增入口），已从 `GOVERNANCE_SOURCES` 清空 |
| D5 | **默认角色包归属** | **宿主职责**。memora 内核不设计「默认角色包」，也不内置默认卡。「默认激活哪张卡」是宿主决策；内核只保证「零角色包激活时系统可运行」。零角色包时**空角色包态**运行（persona 兜底已移除，无角色设定注入） |

### 4.1 默认角色包边界（D5 定案）

> **结论：memora 内核不设计「默认角色包」，也不内置默认卡。**「默认激活哪张卡」是宿主决策；内核只保证「零角色包激活时系统可运行」。

- **内核实测现状**：`role-pack/rolePackManager.ts` `load(activePack?)` 无 activePack 且 `items.length > 0` 才自动激活第一个，零角色包时 `activePackName = null`（不强制必有卡）；`buildSystemPrompt()` 无激活时返回 `''`（空串降级）；`assembler.ts` `systemPrefixParts = [rolePackPrompt]` 唯一（persona 兜底已移除）。
- **宿主职责**：默认卡 = 领域决策（通用助手宿主放通用卡、文档宿主放文档卡），经 `<configDir>/role-packs/` 注入（role-pack-spec §9.1 多实例模式）。
- **对齐哲学**：memora 是纯逻辑库（ADR-002）+ 领域无关（哲学§5），内置默认卡 = 内核耦合领域偏见。

### 4.2 会话级摘要归属与 type 去时效（D6/D7 定案）

> **D6 · 会话级摘要归会话记录存储（重定 2026-08-31）**：`SessionArchiver` 只更新 `SessionMeta.summary/keyTopics`（见 [sessionArchiver.ts](../../src/agent/managers/sessionArchiver.ts)），不写任何记忆库 source。`content` 为历史残留 source——无生产写入路径（`memoryInspector.writeUpsert` 仅治理页编辑已有记忆复用），已从 `GOVERNANCE_SOURCES` 清空（2026-09-09 剪枝，`isTraceable` 已于 2026-08-28 删除：无行为消费者，见 ADR-025 修订与 memory-as-summary §5.2）
>
> **D7 · type 不设时效性**：记忆是否有效由**语义状态**判定（superseded 写时取代，score 无衰减），不由时间流逝判定——用户久未使用不构成记忆过期的理由。原 `intent`/`general` 7 天窗口是「用时间代理语义状态」的读时猜测，违反 ADR-021「写时定、不读时猜」纪律，已废弃（见 memory-as-summary.md §4.2）。

## 五、隐式依赖（收敛时易漏）

1. **宿主 SQLite schema 不可见**：`storageInterface.ts` 注释说明实现侧在宿主；宿主持有 `WHERE source='rule'` 等查询会静默失效，需宿主配合核对。
2. **`evictOrphanRules` 对账**（`projectManager.ts`）：基准变化后，删规则要改以角色包文件集为基准，否则规则删除后重启「复活」。
3. **`closeProject` 跨项目隔离**（`projectManager.ts`）：项目级记忆撤销语义改为角色包激活/失活。
4. **`reloadConfig('persona'/'skill')`**（`agent.ts`）：目录迁走后热重载「假成功」，宿主 UI 需适配。
5. **LLM 工具链提示**：`loop.ts` 曾引导 LLM 用 `create_persona/create_rule` 专用工具（本体在宿主）。**已解决（2026-08-28）**：create_* 工具已移除，工具选择规则节改为按实际工具动态生成，write_file 配置目录拦截亦已删除——不再存在该提示链。
6. **测试基线**：大量测试直接构造 `source:'rule'` 记忆，搬迁后需同步迁移。

## 六、与其他文档的关系

| 文档 | 关系 |
|------|------|
| [role-pack-spec.md](role-pack-spec.md) | 角色包标准本体；§9.2 补内容层归属声明（本设计落点） |
| [memory-as-summary.md](memory-as-summary.md) | 记忆即摘要架构；§7 补「设定记忆迁出」待办 |
| [architecture_philosophy_rules.md §11](../../.trae/rules/architecture_philosophy_rules.md) | 插卡机模型哲学——角色包承载设定的哲学依据 |
| [ADR-025-memory-role-pack-boundary](../../.trae/decisions/ADR-025-memory-role-pack-boundary.md) | 本设计的 ADR 背书 |
| [memory-role-pack-boundary-rules](../../.trae/rules/memory-role-pack-boundary-rules.md) | 纪律沉淀（防止再次分叉） |

## 七、一句话总判

**最终形态 = 角色包管「角色设定」，记忆系统只管「对话摘要」，一刀切干净；记忆库只有一种记忆，靠打标签分类。** 收敛按「先停写、后切读、再语义对齐」纪律渐进执行，先定案后动刀。