---
alwaysApply: false
description: 对抗性审查架构决策收敛——核心：设定记忆（persona/rules/skills）唯一归角色包内容层，记忆系统只剩摘要（round-summary 按 summaryType 分类），记忆库停止写入设定记忆
---

# ADR-025 · 记忆系统 × 角色包边界收敛（设定记忆归角色包，记忆库只剩摘要）

> **状态**：✅ 已接受
> **日期**：2026-08-17
> **来源**：用户设计意图核对（第一性原理：设定记忆与对话记忆是两种东西，不互存不双写）；对抗式核查（grep 实证现有双轨并存）
> **依赖**：[ADR-004](./ADR-004-memory-unification.md)（记忆 source 基元模型）、[memory-role-pack-boundary.md](../architecture/memory-role-pack-boundary.md)（设计真理源）、[role-pack-spec.md §9.2](../architecture/role-pack-spec.md)（角色包标准内容层归属）、[memory-as-summary.md](../architecture/memory-as-summary.md)（摘要即记忆）

## 背景

用户设计意图核对发现**双轨并存**：

| 症状 | 证据 |
|------|------|
| 设定记忆仍写入记忆库 | `configManager.ts:352/413/488` upsert rule/skill；`loader.ts:21-23` 启动扫描 PERSONA/RULE/SKILL/GUARDRAIL 进索引 |
| 角色包未完全接管 | `assembler.ts:234` `[rolePackPrompt \|\| personaPrompt]`——角色包优先、persona 兜底 |
| 记忆库不纯 | 存储含 persona/rule/skill/work-projection/guardrail/content 8 类 source，非摘要单轨 |

角色包标准早已设计承载 persona/rules/skills（`rolePackManager.ts:466-506` 装载 persona.md/rules.md），但运行时仍与 PersonaManager/SkillManager 并存（`rolePackManager.ts:17-19`「M3 远期可替代」）。**设计目标态已存在，运行时未落地。**

## 决策

### 核心决策：设定记忆归角色包，记忆库只剩摘要

1. **分界线**：「你是谁 / 你怎么做事」（persona/rules/skills）→ 角色包内容层 L1；「聊了什么 / 发生过什么」→ 记忆系统（round-summary，按 summaryType 分类）。
2. **记忆库不写入设定记忆**：`persona` / `rule` / `skill` 不再作为记忆库 source 写入（loader 停扫 + configManager 停写索引）。
3. **角色包不写对话记忆**：角色包只承载设定，不承载轮次摘要。
4. **存量兼容**：已写入记忆库的存量设定记忆行保留（软删兼容），不再新写入；宿主提供一次性迁移即可清理。
5. **guardrail 空转链已摘除**（2026-08-17，档 1 一并落地）：guardrail 为「零规则、无扫描映射、无消费者」的空转机制（输入/输出检查 + 索引读取），与目标态冲突，已移除。原「guardrail 归宿待定」决策作废。

### 配套决策 D5：默认角色包 = 宿主职责（2026-08-17 定案）

> memora 内核**不设计「默认角色包」、不内置默认卡**。「默认激活哪张卡」是宿主决策（领域决策）；内核只保证「零角色包激活时系统可运行」。

- 内核实测：`rolePackManager.ts:287-290` 零角色包时 `activePackName = null`（不强制必有卡）；`buildSystemPrompt()` 无激活返回 `''`；`assembler.ts:234` persona 兜底。
- 宿主：默认卡经 `<configDir>/role-packs/` 注入（role-pack-spec §9.1 多实例模式）。
- 对齐：纯逻辑库（ADR-002）+ 领域无关（哲学§5）。
- 档位影响：档 1b 移除 persona 兜底的前提 = 宿主已接入角色包（接入要求，非内核改动）。

### 收敛路径（分档渐进）

| 档 | 内容 | 风险 |
|----|------|------|
| 0 | 设计定案（本 ADR + 设计文档） | 零 |
| 1 | loader 停扫三类 + configManager 停写索引（存量行保留） | 低 |
| 2 | assembler 移除 persona 兜底 + projectManager/memoryInspector 改读角色包 | 中 |
| 3 | rule 语义对齐（parseRules 扩展 markdown 解析） | 高 |

**SSOT 自检（决策成立的前提）**：
- ✅ 不新增存储层——复用角色包内容文件 + round-summary；
- ✅ 不新增后台系统——收敛既有双轨，非新增；
- ✅ 与 ADR-004 兼容——persona/rule/skill 作为 source 标签仍保留（存量兼容），只是停止新写入；
- ✅ 与 role-pack-spec §9.2 一致——设定记忆唯一归角色包，双方不双写。

## 影响

- **内核**：loader.ts / configManager.ts / assembler.ts / projectManager.ts / memoryInspector.ts 的设定记忆读写路径收敛。
- **宿主**：SQLite schema（不可见，需宿主核对 `WHERE source='rule'` 等查询）、create_persona/create_rule 工具、热重载 UI、测试基线。
- **文档**：memory-as-summary.md §7 计划移除表已补「设定记忆迁出」；role-pack-spec.md §9.2 已补内容层归属声明。

## 被否决的选项

| 选项 | 否决理由 |
|------|----------|
| 维持双轨（角色包 + 记忆库并行） | 违反单一真理源；同一设定两处承载必然腐化 |
| 设定记忆完全移除（不迁入角色包） | 丢失既有能力（角色/规则/技能是 memora 核心资产） |
