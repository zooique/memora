---
alwaysApply: false
description: Agent 归档模式（full / insights-only / manual）三态控制
---

# ADR-015 · Agent 归档模式三态控制

> **状态**：✅ 已采纳
> **日期**：2026-07-02（新枝破土·GAP-1 收敛）
> **来源**：新枝破土循环——扫描发现 archiveMode 硬约束在 user_profile.md / project_memory.md 中明确记载，但源代码中完全未实现

## 背景

user_profile.md 与 project_memory.md 均明确记载硬约束：

> "Agent must support three archive modes: 'full' (default, all content auto-archive), 'insights-only' (only user insights auto-archive, content requires manual archive), 'manual' (no auto-archive)"

但 `grep -r "archiveMode" src/` 与 `grep -r "archiveMode" .trae/rules/` 均 0 匹配——约束先于实现，代码层完全缺失该机制。

### 现状归档流程（`Agent.postProcess`）

每轮对话后无差别执行：
1. **profile facts 归档**（`UserProfile.archiveFacts`）—— 从用户输入提取画像事实
2. **角色自动匹配**（`PersonaManager.autoMatch`）—— 不涉及归档
3. **技能关键词匹配**（`SkillManager.match`）—— 不涉及归档
4. **Insight 提取**（`InsightExtractor.extract`）—— LLM 提取洞察

无任何模式开关，所有用户都被强制全量自动归档。

### 约束文本歧义

约束写"only user insights auto-archive, content requires manual archive"，其中"content"语义模糊。经新枝破土方案设计阶段决策（2026-07-02）澄清：

- **采纳解读A**：content = 对话原始内容（GAP-2 会话归档未实现）。profile facts 与 insight 同属"提炼类记忆"（非原始对话），在 `insights-only` 模式下都自动归档。
- **否决解读B**：严格按字面"only insights" → 只 insight 自动，profile 需手动。否决理由：会导致用户每说一句话都需手动确认画像更新，体验割裂，违反"主动可见"原则。

## 决策

### 1. 三种模式语义

| Mode | profile facts | insight | 对话原始内容（GAP-2 预留） |
|------|--------------|---------|---------------------------|
| `full`（默认） | 自动 | 自动 | 自动（GAP-2 实现后） |
| `insights-only` | 自动 | 自动 | 手动 |
| `manual` | 手动 | 手动 | 手动 |

**设计原则**：profile facts 与 insight 同属"提炼类记忆"（从输入中加工得到，非原始对话），归档行为应保持一致。`insights-only` 模式下两者都自动；`manual` 模式下两者都需手动触发。

### 2. 配置位置

- **构造参数**：`AgentOptions.archiveMode?: ArchiveMode`（默认 `'full'`）
- **运行时切换**：`Agent.setArchiveMode(mode: ArchiveMode): void`
- **归属层**：内核层（src/agent/），不耦合宿主 sprite.json，符合 ADR-010 门面模式 + 零依赖内核原则

### 3. 手动触发 API

为 `manual` 模式提供手动归档入口（`insights-only` 模式下 profile/insight 已自动，仅需手动触发对话原始内容归档，待 GAP-2 实现）：

```typescript
// 手动触发 profile facts 归档（manual 模式下使用）
async archiveProfileFacts(input: string): Promise<UserProfileEntry[]>

// 手动触发 insight 提取（manual 模式下使用）
async archiveInsight(input: string, assistantContent: string): Promise<Memory[]>
```

### 4. postProcess 改造

```typescript
private async postProcess(input: string, assistantContent: string): Promise<void> {
  // 角色匹配 + 技能匹配不受 archiveMode 影响（每轮都执行）
  this.runPersonaMatch(input);
  this.runSkillMatch(input);

  // 归档行为受 archiveMode 控制
  if (this.#archiveMode === 'manual') return; // 全手动，跳过所有自动归档

  // archiveMode === 'full' | 'insights-only'：profile + insight 都自动
  this.archiveProfileFactsAuto(input);
  this.archiveInsightAuto(input, assistantContent);
}
```

## 关键实现

| 组件 | 文件 | 变更 |
|------|------|------|
| 类型 | `src/agent/types.ts` | 新增 `ArchiveMode` 类型 |
| 门面 | `src/agent/agent.ts` | AgentOptions 新增字段 + `#archiveMode` + `setArchiveMode` + 手动 API + postProcess 改造 |
| 测试 | `src/agent/__tests__/agent.test.ts` | 3 种模式 × 归档行为 用例 |

## 后果

**正面**：
- 满足硬约束，补齐 P0 功能设计缺口
- 用户可控制归档粒度（如敏感场景用 manual，日常用 full）
- 为 GAP-2 会话归档预留 `content` 类扩展点
- 手动 API 为宿主提供"主动可见"的归档入口

**负面**：
- 三种模式增加测试矩阵复杂度（3 模式 × 2 类归档 = 6 用例）
- `manual` 模式下用户忘记手动归档会导致记忆丢失（需宿主 UI 提供明显入口）

## 关联

- 衍生约束更新：`project_memory.md` 已记载的硬约束本 ADR 落地后从"未实现约束"转为"已实现约束"
- 关联缺口：GAP-2 会话归档功能（P1）实现后需扩展 `content` 类归档的模式控制
