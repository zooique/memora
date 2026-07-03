---
alwaysApply: false
description: 记忆关系图谱——独立侧车模型，开放字符串关系类型，IMemoryRelationStore 接口注入
---

# ADR-014 · 记忆关系图谱（侧车模型）

> **状态**：✅ 已接受
> **日期**：2026-06-25
> **来源**：阶段二 Phase 1.1 排雷优化方案（原迭代规划文档已废弃，规划内容现以本 ADR 为准）

## 背景

当前记忆模型是扁平的——每条 Memory 独立存在，彼此无关系。这导致两个问题：

1. **矛盾无法自动发现**——用户今天说"我喜欢咖啡"，下周说"我不喝咖啡了"，系统无法感知两条记忆的语义对立，会同时召回导致 LLM 上下文自相矛盾。
2. **记忆无因果结构**——大厂的 Memory 是扁平向量存储，召回靠相似度。我们的差异化价值应是"记忆有因果结构"，但当前实现与大厂同质化。

直觉方案是在 Memory 类型中新增 `relations` 字段，定义 `contradicts`/`supports`/`follows`/`refines` 四种关系类型。但排雷发现两个致命问题：

| # | 雷区 | 严重度 | 依据 |
|---|------|--------|------|
| R1 | `relations` 字段侵入 Memory 7 字段模型 | 致命 | [ADR-004](./ADR-004-memory-unification.md) 明确 Memory 是 7 字段基元，不可扩展 |
| R2 | 四种关系类型是封闭枚举 | 致命 | ADR-004 核心决策是"source 开放字符串替代封闭枚举"，关系类型同理 |

## 决策

采用**独立侧车（sidecar）模型**：MemoryRelation 是与 Memory 平行的独立数据结构，互不侵入。

### 1. 类型定义（memora 内核 `src/memory/types.ts`）

```typescript
// 关系类型是开放字符串，不是枚举
// 预设建议值：'contradicts' | 'supports' | 'follows' | 'refines' | 'caused' | 'related'
// 宿主可自由扩展，如 'derived-from'、'supersedes'
export interface MemoryRelation {
  sourceId: string;       // 关系起点（Memory.id）
  targetId: string;       // 关系终点（Memory.id）
  type: string;           // 开放字符串，非枚举
  weight: number;          // 关系强度 0-1
  createdAt: string;      // ISO 8601
}
```

### 2. 存储接口（memora 内核 `src/memory/relationStore.ts`，新建）

```typescript
// 独立于 IMemoryStorage 的侧车接口
// 宿主项目注入实现（如 SqliteStorage 扩展 memory_relations 表）
export interface IMemoryRelationStore {
  /** 添加关系（sourceId+targetId+type 唯一约束，重复添加幂等） */
  addRelation(relation: MemoryRelation): void;
  /** 查询某记忆的关系，direction 控制方向过滤（默认 'both'） */
  getRelations(memoryId: string, direction?: 'outgoing' | 'incoming' | 'both'): MemoryRelation[];
  /** 按关系类型查询（用于冲突检测：getRelationsByType('contradicts')） */
  getRelationsByType(type: string): MemoryRelation[];
  /** 获取全部关系（用于拓扑可视化构建节点+边图谱） */
  getAllRelations(): MemoryRelation[];
  /** 删除指定关系（sourceId+targetId+type 唯一定位） */
  removeRelation(sourceId: string, targetId: string, type: string): void;
}
```

### 3. 方向性设计

关系存储是有向的（sourceId → targetId），但不同关系类型的语义对称性不同：

| 关系类型 | 方向性 | 示例 |
|---------|--------|------|
| `contradicts` | 双向对称 | "喜欢咖啡" vs "不喝咖啡了" |
| `supports` | 有向 | "用 Vue" 支持 "前端工程师" |
| `follows` | 有向 | "今天下雨" follows "昨天阴天" |
| `refines` | 有向 | "Vue3 不错" refines "Vue 也不错" |

**查询策略**：`getRelations(memoryId, direction)` 参数控制：
- `'outgoing'`（默认冲突检测用）：只查 sourceId = memoryId 的关系
- `'incoming'`：只查 targetId = memoryId 的关系
- `'both'`（默认，可视化/召回增强用）：合并两个方向并去重

存储仍是有向的，查询时按方向过滤，不增加存储复杂度。

### 4. weight 的来源

weight 表示关系强度（0-1），采用 **LLM 四档离散值 + 代码默认 0.5 兜底**：

| 值 | 语义 | LLM 判断场景 |
|----|------|--------------|
| 0.0 | 几乎无关 | LLM 明确判断无关系 |
| 0.3 | 弱相关 | 关系存在但强度低 |
| 0.7 | 强相关 | 关系明确且强度高 |
| 1.0 | 确定关系 | 矛盾/等价等强关系 |
| 0.5 | 未判断（代码默认） | LLM 失败或未输出时兜底 |

**设计理由**：
- 离散值比连续浮点稳定，LLM 输出可预测
- 0.5 兜底避免 LLM 失败时关系数据缺失
- 用户不可直接编辑 weight，保持 UI 简洁

### 5. 构建时机（Sprite 层，不进内核）

```
InsightExtractor.extract() 完成后（fire-and-forget）
  → 代码层：对新提取的 insight，召回 top-5 相关记忆
  → LLM 层：判断新 insight 与每条相关记忆的关系类型
  → 代码层：写入 IMemoryRelationStore
```

遵循降级优先（[ADR-006](./ADR-006-security-model.md)）：关系构建失败不阻塞对话，仅记录日志。

### 6. 冲突检测嵌入现有流程（不增加 LLM 调用次数）

冲突检测嵌入 InsightExtractor 现有 extract() 流程，**不新建独立管线，不增加 LLM 调用次数**：

```
InsightExtractor.extract() 现有流程：
  1. LLM 提取 insight（是否值得记忆 + 摘要）
  → 新增步骤 2：代码层召回相关记忆（top-5，关键词匹配）
  → 新增步骤 3：同一次 LLM 调用中，追加判断"是否与已有记忆矛盾"
     （利用 LLM 的上下文窗口，不额外调用）
  → 步骤 4：若矛盾，调用 IMemoryRelationStore.addRelation(type='contradicts')
  → 步骤 5：旧记忆 score 降低 0.1（复用现有 decay 机制，不引入新机制）
```

## 理由

1. **侧车不侵入**——MemoryRelation 与 Memory 平行存在，保护 ADR-004 的 7 字段基元驱动模型（B1/B2 边界）
2. **开放字符串**——关系类型是字符串非枚举，宿主可自由扩展，遵循 ADR-004 核心决策（B3 边界）
3. **零 native 依赖**——IMemoryRelationStore 是接口，InMemoryRelationStore 是测试用实现，宿主注入 SqliteRelationStore（B4 边界）
4. **机制与策略分离**——内核提供 IMemoryRelationStore 接口（机制），关系构建逻辑在 Sprite 层（策略）（B5 边界）
5. **不增加 LLM 成本**——冲突检测复用现有 extract() 的 LLM 调用，将相关记忆作为上下文注入，一次调用完成提取+冲突判断（B8 边界）

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 在 Memory 类型新增 `relations` 字段 | 违反 ADR-004 的 7 字段基元约束（B1 致命） |
| 定义 `RelationType` 枚举（contradicts/supports/...） | 违反 ADR-004 的开放字符串原则（B3 致命） |
| 新建独立冲突检测管线 | 每轮从 1 次 LLM 调用变 2 次，成本翻倍 |
| 关系数据存入 Memory 的 content JSON | 查询需解析 JSON，无法用 SQL 索引 |
| 内核内置 SqliteRelationStore | 违反零 native 依赖原则（B4） |

## 影响

### 内核（memora）

| 模块 | 变更 |
|------|------|
| `src/memory/types.ts` | 新增 `MemoryRelation` 类型导出 |
| `src/memory/relationStore.ts`（新建） | 新增 `IMemoryRelationStore` 接口 |
| `src/memory/inMemoryRelationStore.ts`（新建） | 测试用实现 |
| `src/index.ts` | 导出 `MemoryRelation` 类型 + `IMemoryRelationStore` 接口 + `InMemoryRelationStore` |
| `src/agent/managers/insightExtractor.ts` | 扩展 extract() 流程，注入可选的 IMemoryRelationStore |

### 宿主（memora-sprite）

| 模块 | 变更 |
|------|------|
| `hosts/memora-sprite/src/storage/sqliteRelationStore.ts`（新建） | SQLite 实现，`memory_relations` 表 |
| `hosts/memora-sprite/src/sprite/controllers/memoryController.ts` | 新增 `getRelationGraph()` 方法 |
| `hosts/memora-sprite/src/electron/renderer/panels/memoryPanelManager.ts` | 关系图谱视图（Canvas 2D 手绘，不引 D3） |

### 规则

| 文件 | 变更 |
|------|------|
| `project-rules.md` | 技术栈清单加 MemoryRelation 行；目录结构加 `src/memory/relationStore.ts`；阶段一交付物追加关系图谱项 |
| `backend_layers_rules.md` | 新增 relationStore 模块职责边界（侧车，不侵入 IMemoryStorage） |

## 何时回顾

- 当关系数据量级超过 10000 条时，评估是否需要图数据库（如 Neo4j 嵌入式）
- 当 source 开放字符串增长到 20+ 种时，考虑引入 source 分类层级（与 ADR-004 回顾条件对齐）
- 当冲突检测准确率低于 70% 时，重新评估 LLM prompt 设计
- 当宿主项目需要批量关系导入/导出时，扩展 IMemoryRelationStore 接口
