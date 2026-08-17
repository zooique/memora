# 记忆系统 × 角色包 边界收敛设计

> **一句话**：设定记忆（persona / rules / skills）收进角色包内容层；记忆系统只剩摘要记忆（round-summary，按 summaryType 分类）。两者一刀切，各管各的。

## 一、问题

memora 当前存在**双轨并存**：设定记忆既走 `agent-config` 目录 → 记忆库（source: persona/rule/skill），又可由角色包承载（personaContent/rules/skills）。两套装载路径并存导致：

| 症状 | 证据 |
|------|------|
| 设定记忆仍写入记忆库 | `configManager.ts:352/413/488` upsert rule/skill；`loader.ts:21-23` 启动扫描 PERSONA/RULE/SKILL/GUARDRAIL 进索引 |
| 记忆库不「纯」 | 存储含 persona/rule/skill/work-projection/guardrail/content 等 8 类 source，非摘要单轨 |
| 角色包未完全接管 | `assembler.ts:234` `[rolePackPrompt \|\| personaPrompt]`——角色包优先、persona 兜底，两套并行 |
| 文档叙事分叉 | `memory-as-summary.md` 的「单轨」只对洞察/画像层成立；设定记忆层从未收敛 |

根因：**「设定记忆归角色包」是已设计未落地的目标态**（`rolePackManager.ts:19` 注释「M3 远期可替代」）。本设计将其正式定案。

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

- **记忆库**：只有 `round-summary`（+ `content` 会话归档，粒度不同，非冗余，见 [memory-as-summary.md §7](memory-as-summary.md)）+ 存量兼容数据（profile / work-projection）。guardrail 空转链已摘除（2026-08-17，零规则无消费者，见 §4.4）。
- **角色包**：`<configDir>/role-packs/<名>/`，`manifest.json` 唯一权威 + `persona.md` / `rules.md` / `skills/*` 内容文件（见 [role-pack-spec.md §2.2](role-pack-spec.md)）。
- **召回**：只对 round-summary 生效（按 type 差异化召回 + 会话窗口/时间排序，见 [memory-as-summary.md §4](memory-as-summary.md)）。设定记忆不再进召回面。

## 三、现状差距（核查实证）

| 路径 | 现状 | 目标 | 证据 |
|------|------|------|------|
| 启动扫描 | loader 曾扫 PERSONA/RULE/SKILL/GUARDRAIL 进索引 | 不扫设定记忆（已停扫，2026-08-17） | `loader.ts` `STARTUP_SCAN_SOURCES` 已清空 |
| 运行时写入 | configManager CRUD 三层写入（文件→索引→rule 即时注入） | 只写角色包文件，停写索引 | `configManager.ts:293-294/333/385/496-498` |
| 系统提示装配 | 角色包优先、persona 兜底 | 角色包唯一 | `assembler.ts:234` |
| 读取消费者 | loader/projectManager/configManager/memoryInspector 从索引读 rule/skill | 从角色包读（或不再读） | `loader.ts:134-136` 等 |
| 展示 | memoryInspector snapshot/stats 展示设定记忆 | 展示摘要为主 | `memoryInspector.ts:254-257` |

## 四、搬迁路径（分档渐进）

### 档 0：设计定案（本文档）

- 目标态、分界线、搬迁路径、决策点写死为单一真理源。
- 更新 [role-pack-spec.md §9.2](role-pack-spec.md)（内容层归属声明）与 [memory-as-summary.md §7](memory-as-summary.md)（计划移除补设定记忆迁出）。

### 档 1：停止写入（低风险，向后兼容）

1. `loader.ts` `STARTUP_SCAN_SOURCES` 移除 PERSONA/RULE/SKILL——索引不再新增设定记忆；存量行保留（软删兼容）。**【已完成 2026-08-17】**——`STARTUP_SCAN_SOURCES` 已清空。
2. `configManager.ts` 写索引调用降级为「仅写角色包文件」（rule 即时注入改从角色包取）。
3. 存量设定记忆数据由宿主提供一次性迁移脚本（文件已在角色包/agent-config 中，SQLite 索引行清空或标记兼容）。

**验收**：新会话不再新增 source=rule/skill/persona 记忆；旧会话不受影响。

### 档 2：读取切换（中等风险）

1. `assembler.ts` 移除 persona 兜底，`systemPrefixParts = [rolePackPrompt]` 唯一。
2. `projectManager.ts` bootstrap / `evictOrphanRules` 对账基准从「loader 扫描产物」切到「角色包文件集」。
3. `memoryInspector.ts` snapshot/stats 改读角色包或移除设定记忆段。

### 档 3：语义对齐（高风险，需先行决策）

- **rule 语义对齐**：角色包 `parseRules` 目前只认 `- `/`* ` 无序列表行（`rolePackManager.ts:226`），记忆库 rule 是任意 markdown（含元数据/可软删）。迁移需转换器：把现有规则文件转为角色包 rules.md 可解析格式，否则搬迁丢内容。
- **guardrail 已摘除**（2026-08-17）：guardrail 是「零规则、无扫描映射、无消费者」的空转链（`loop.ts` 输入/输出检查 + `assembler.ts` 索引读取），与目标态冲突，已随档 1 一并移除。原 D1「guardrail 归宿」决策作废。

## 五、决策点（待老板拍板）

| # | 决策 | 选项 | 影响 |
|---|------|------|------|
| D1 | ~~guardrail 归宿~~ | **已作废（2026-08-17）**——guardrail 空转链已摘除，无此物无需归宿 | 无 |
| D2 | 存量设定记忆数据 | A. 索引清空 / B. 标记兼容保留 | 决定宿主 SQLite 迁移脚本范围 |
| D3 | skills 正文展示 | A. 渐进披露（readSkillContent 按需读） / B. 记忆库镜像保留 | 决定宿主 UI 是否改读角色包 |
| D4 | content 会话归档 | 保留（粒度不同，非冗余） | 已定案，无需重议 |
| D5 | **默认角色包归属**（2026-08-17 定案） | **宿主职责**。内核不内置默认卡；零激活时降级为「空角色包态」+ persona 兜底（当前已实现）；移除 persona 兜底的前提是宿主已接入角色包 | 决定档 1b 是否可移除 persona 兜底 |

### 5.1 默认角色包边界（D5 定案）

> **结论：memora 内核不设计「默认角色包」，也不内置默认卡。**「默认激活哪张卡」是宿主决策；内核只保证「零角色包激活时系统可运行」。

- **内核实测现状**：`role-pack/rolePackManager.ts:287-290` `load(activePack?)` 无 activePack 且 `items.length > 0` 才自动激活第一个，零角色包时 `activePackName = null`（不强制必有卡）；`buildSystemPrompt()` 无激活时返回 `''`（空串降级已存在）；`assembler.ts:234` `[rolePackPrompt \|\| personaPrompt]` 双保险兜底。
- **宿主职责**：默认卡 = 领域决策（通用助手宿主放通用卡、文档宿主放文档卡），经 `<configDir>/role-packs/` 注入（role-pack-spec §9.1 多实例模式）。
- **对齐哲学**：memora 是纯逻辑库（ADR-002）+ 领域无关（哲学§5），内置默认卡 = 内核耦合领域偏见。
- **对档位的影响**：档 1b 移除 persona 兜底的前提 = 宿主已接入角色包（接入要求，非内核改动）。

## 六、隐式依赖（搬迁时易漏）

1. **宿主 SQLite schema 不可见**：`storageInterface.ts:6-14` 注释说明实现侧在宿主；宿主持有 `WHERE source='rule'` 等查询会静默失效，需宿主配合核对。
2. **`evictOrphanRules` 对账**（`projectManager.ts:299-332`）：基准变化后，删规则要改以角色包文件集为基准，否则规则删除后重启「复活」。
3. **`closeProject` 跨项目隔离**（`projectManager.ts:398-410`）：项目级记忆撤销语义改为角色包激活/失活。
4. **`reloadConfig('persona'/'skill')`**（`agent.ts:2535`）：目录迁走后热重载「假成功」，宿主 UI 需适配。
5. **LLM 工具链提示**：`loop.ts:1438-1441` 引导 LLM 用宿主的 `create_persona/create_rule` 工具，本体在宿主，需同步改造写入目标。
6. **测试基线**：大量测试直接构造 `source:'rule'` 记忆（`inMemoryStorage.test.ts` 等），搬迁后需同步迁移。

## 七、与其他文档的关系

| 文档 | 关系 |
|------|------|
| [role-pack-spec.md](role-pack-spec.md) | 角色包标准本体；§9.2 补内容层归属声明（本设计落点） |
| [memory-as-summary.md](memory-as-summary.md) | 记忆即摘要架构；§7 补「设定记忆迁出」待办 |
| [architecture_philosophy_rules.md §11](../.trae/rules/architecture_philosophy_rules.md) | 插卡机模型哲学——角色包承载设定的哲学依据 |
| [ADR-025-memory-role-pack-boundary](../decisions/ADR-025-memory-role-pack-boundary.md) | 本设计的 ADR 背书 |
| [memory-role-pack-boundary-rules](../.trae/rules/memory-role-pack-boundary-rules.md) | 纪律沉淀（防止再次分叉） |

## 八、一句话总判

**最终形态 = 角色包管「角色设定」，记忆系统只管「对话摘要」，一刀切干净；记忆库只有一种记忆，靠打标签分类。** 现状是「双轨中间态」，按档 0→1→2→3 渐进收敛，先定案后动刀。
