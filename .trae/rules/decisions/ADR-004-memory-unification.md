---
alwaysApply: false
description: 记忆统一为"source 开放字符串"基元驱动模型
---

# ADR-004 · 记忆统一为"source 开放字符串"基元驱动模型

> **状态**：✅ 已接受 **日期**：2026-06-11（v2.0 重构）/ 2026-07-03（GAP-6 软删除扩展）
> **前身**：v1.0 "类型 + 永久性标记"模型（2026-06-02）
> **来源**：(历史设计文档已归档：记忆系统重构方案_排雷炼化版.md)

## 背景

v1.0 模型使用 `memory_type`（6 种枚举）× `permanence`（4 级枚举）区分记忆。
实践发现：

1. **封闭枚举扩展性差**——新增来源需改代码
2. **permanence 是查询时策略，不是记忆固有属性**——同一条记忆在不同场景下召回策略不同
3. **管理器过多**——TopicMount（话题漂移检测）、ArchiveManager（封存重试队列）、TopicStore（话题文件）各 200+ 行，维护成本高
4. **概念驱动 vs 基元驱动**——概念驱动导致每个概念都有独立的管理器/枚举/类型

## 决策

从"概念驱动"重构为"基元驱动"：

| v1.0（旧） | v2.0（新） | 变化 |
|------------|-----------|------|
| `memory_type` 枚举（6 种） | `source` 开放字符串 | 封闭 → 开放 |
| `permanence` 枚举（4 级） | 移除 | 召回策略由查询时决定 |
| `tags` JSON 数组 | 移除 | source 标签足够 |
| `weight` 0-1 | `score` 0-1 | 改名 |
| `updatedAt` ISO 8601 | `accessedAt` ISO 8601 | 语义更精确 |
| `filePath` 文件路径 | 移除 | id 中已包含来源 |
| Memory 接口 9 字段 | Memory 接口 7 字段 | 精简（v2.0）/ 8 字段（v2.1 GAP-6 软删除） |

**新 Memory 接口（v2.1，GAP-6 软删除扩展）：**

```typescript
interface Memory {
  id: string;           // source:name（如 'rule:core'、'insight:1718083200000'）
  content: string;      // 记忆内容（Markdown）
  source: string;       // 来源标签（开放字符串，非枚举）
  name: string;         // 可读名称
  createdAt: string;   // 创建时间（ISO 8601）
  accessedAt: string;  // 最后访问时间（每次召回时刷新）
  score: number;        // 权重（0-1，召回时用于排序）
  deletedAt?: string;  // 软删除时间（ISO 8601，可选；非 undefined 表示已软删除，回收站保留 30 天）
}
```

> **GAP-6 软删除扩展（2026-07-03）**：新增可选字段 `deletedAt`，实现"删除即软删除"语义。
> - `deletedAt` 为 `undefined` 表示活跃记忆（默认）
> - `deletedAt` 为 ISO 8601 时间戳表示已软删除，回收站可恢复
> - 召回/搜索/列表/统计自动过滤 `deletedAt != undefined` 的记忆
> - `delete(id)` 语义改为软删除（写入 deletedAt），新增 `purge(id)` 物理删除
> - 软删除不删除向量索引（restore 时无需重新嵌入）
> - 回收站保留 30 天（`sprite.json` 的 `recycleBinRetentionDays` 可配，设为 0 禁用自动清理），超期由宿主 Sprite 启动的 6 小时定时器自动物理清理（`purgeExpired(before: Date)`，启动时立即执行一次，`unref()` 不阻止进程退出）

**source 标签约定（开放，非枚举）：**

| source | 含义 | 来源 |
|--------|------|------|
| `persona` | 角色人格 | agent-config/personas/*.md |
| `rule` | 创作规则 | agent-config/rules/*.md + .memora/rules/*.md |
| `skill` | 技能定义 | agent-config/skills/*.md |
| `insight` | 对话洞察 | 每轮问答结束后 LLM 提取 |
| `profile` | 用户画像 | 每轮问答中 LLM 实时提取 |
| `work-projection` | 作品投影 | Agent 读取用户作品时生成的概要 |
| `guardrail` | 内容护栏 | configDir/rules/guardrails/ 下的规则文件 |

**新增来源无需改代码**——只需在存储时指定 source 字符串即可。

## 理由

1. **开放 > 封闭**——source 是字符串，新增来源无需改代码
2. **基元 > 概念**——7 字段 Memory + search() 函数，无需管理器
3. **简单 > 复杂**——TopicMount 200+ 行 → recall() 10 行
4. **查询时策略 > 固化属性**——permanence 不是记忆的固有属性

## 删除的模块

| 模块 | 删除理由 |
|------|---------|
| MemoryType 枚举 | 被 source 字符串替代 |
| Permanence 系统 | 召回策略由查询时决定 |
| TopicMount | 被简单关键词搜索替代 |
| ArchiveManager | 归档改为同步执行 |
| TopicStore | 改为会话文件（sessions/*.md，仅 UI 回溯） |
| RecallPipeline | 被 recall() 函数替代 |

## 保留的模块

| 模块 | 保留理由 |
|------|---------|
| AgentLoop | LLM 交互核心，与记忆系统无关 |
| PersonaManager | 角色切换逻辑合理，source='persona' 即可 |
| FileStore | 配置文件 I/O，作为"源"保留 |
| registerTool() | 工具注册 API，与记忆系统无关 |
| UserProfile | 用户画像提取逻辑合理，source='profile' 即可 |
| WorkProjection | 文件投影逻辑合理，source='work-projection' 即可 |

## System Prompt 构建（6 层）

```
Layer 1: 角色人格（persona）    — 每次注入，不可省略
Layer 2: 创作规则（rule）       — 每次注入，不可省略
Layer 3: 用户画像（profile）    — 每次注入，不可省略
Layer 4: 相关记忆（recall）     — 按相关性注入，可省略
Layer 5: 最近对话（recent）     — AgentLoop 最近 3 轮，固定注入
Layer 6: 工具描述（tools）      — 每次注入（如果有工具）
```

**Layer 5 最近对话注入**（新增）：
- AgentLoop 维护最近 3 轮 user + assistant 消息
- 每次构建 system prompt 时固定注入
- 不依赖话题检测，不依赖关键词匹配
- 当用户输入无信息量（如"你好"）时，LLM 仍能看到最近对话上下文

## 召回逻辑

```
用户发消息 → 提取关键词（Intl.Segmenter + 停用词过滤）
  → 搜索 SQLite（LIKE 关键词匹配，排除 persona/rule）
  → 按 score 降序，取 top N
  → 注入 system prompt
```

## 归档逻辑

每轮问答结束后异步提取 insight，一轮一提，原子级粒度。

## 影响

- SQLite schema 简化：`type` → `source`，移除 `permanence`/`tags`/`updated_at`/`file_path`
- IMemoryStorage 接口简化：移除 `getByPermanence()`/`getByType()`/`applyDecay()`/`touch()`
- 新增 `getBySource(source)` 方法
- 宿主项目（泊文）IPC 接口需适配新 Memory 接口

## 何时回顾

- 当 source 标签增长到 20+ 种时，考虑引入 source 分类层级
- 当 LIKE 查询性能不足时，引入 FTS5 全文索引
- 当需要跨会话记忆持久化时，实现 sessions/*.md 写入逻辑
- 当回收站数据量显著影响存储性能时，考虑分表存储软删除记忆
