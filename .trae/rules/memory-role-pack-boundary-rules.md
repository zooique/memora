---
alwaysApply: true
description: 记忆系统 × 角色包边界纪律——设定记忆（persona/rules/skills）唯一归角色包内容层，记忆库只剩摘要（round-summary 按 summaryType 分类）；新增设定记忆一律进角色包，记忆库禁止再写设定记忆
---

# 记忆系统 × 角色包边界纪律

> **一句话**：**"你是谁、你怎么做事"归角色包（设定记忆）；"聊了什么、发生过什么"归记忆系统（摘要记忆）。** 两者一刀切，各管各的，不互存、不双写。
>
> 设计真理源：[memory-role-pack-boundary.md](../docs/architecture/memory-role-pack-boundary.md) · ADR：[ADR-025](../decisions/ADR-025-memory-role-pack-boundary.md)

---

## 一、分界线（不可逾越）

| 维度 | 归属 | 承载形态 |
|------|------|----------|
| 你是谁 / 你怎么做事（persona / rules / skills） | **角色包** | `<configDir>/role-packs/<名>/` 下 `persona.md` / `rules.md` / `skills/*`（manifest.json 注册） |
| 聊了什么 / 发生过什么 | **记忆系统** | round-summary，带 `summaryType` 分类标签（preference/decision/fact/intent/general） |

**两个"禁止"**：
1. **记忆库禁止写入设定记忆**——`source: 'persona'/'rule'/'skill'` 不再新增；
2. **角色包禁止写入对话记忆**——角色包只承载设定，不承载轮次摘要。

## 二、可执行规则

### 新增设定（R1）
> 新增角色、规则、技能时，**一律写入角色包**（persona.md / rules.md / skills/*），不走 `agent-config/personas|rules|skills` 目录进记忆库。

### 新增记忆（R2）
> 对话记忆只允许 round-summary（+ content 会话归档）。判断标准：**它是"对话的沉淀"还是"思考方式的设定"**？前者进记忆库，后者进角色包。

### 读取路径（R3）
> 读取 persona/rules/skills 从**角色包**读（`RolePackManager` / `assembleRolePack`），不从记忆库 `getBySource` 读。

### 迁移纪律（R4）
> 收敛分档执行（档 0 定案 → 档 1 停写 → 档 2 切读 → 档 3 语义对齐），**先停写后切读**，任何一步不得跳过；存量设定记忆行保留（软删兼容），宿主一次性迁移清理。

## 三、已知坑（对抗式核查实证）

1. **rule 语义不对等**：角色包 `parseRules` 只认 `- `/`* ` 无序列表行（`role-pack/rolePackManager.ts`）；记忆库 rule 是任意 markdown。搬迁需转换器，否则丢内容。
2. **skills 正文不预装载**：角色包 skill 是"生态指针"，正文靠 `readSkillContent` 按需读；依赖索引正文的宿主 UI 搬迁后会断供。
3. **guardrail 已摘除（2026-08-17）**：guardrail 空转链（零规则/无扫描映射/无消费者）已随档 1 移除，不再新增 guardrail 相关代码。
4. **宿主 SQLite schema 不可见**：宿主持有 `WHERE source='rule'` 等查询会静默失效，需宿主核对配合。

## 四、审查点（代码评审时检查）

- [ ] 是否有新代码 `upsert` `source='rule'/'skill'/'persona'` 记忆？（违反 R1）
- [ ] 是否有人从记忆库 `getBySource(RULE/SKILL/PERSONA)` 读设定？（违反 R3）
- [ ] 新增的"角色相关能力"是否绕开角色包另起通道？（违反插卡机模型 §11）
- [ ] `assembler.ts` systemPrompt 装配是否仍存在 persona 兜底？（收敛完成后应唯一走 rolePackPrompt）
