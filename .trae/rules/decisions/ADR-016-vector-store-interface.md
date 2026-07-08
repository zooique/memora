---
alwaysApply: false
description: 向量存储接口化——IVectorStore 接口 + JsonVectorStore 内置实现，解除内核对 node:fs 的硬编码依赖
---

# ADR-016 · 向量存储接口化（IVectorStore + JsonVectorStore）

> **状态**：✅ 已接受 **日期**：2026-07-08（1.0 接口稳定化）
> **来源**：1.0 审查报告 P0-2 + 迭代文档 Phase 0.2

## 背景

v0.3 版本的 `VectorStore` 是一个**具体类**，直接 `import { readFileSync, writeFileSync } from 'node:fs'` 硬编码文件系统操作。这导致两个问题：

1. **违反零依赖内核原则**——内核不应依赖特定环境（如浏览器环境无 `node:fs`）
2. **无法注入自定义向量库**——宿主项目（如使用 LanceDB / Qdrant / Pinecone 的场景）必须 fork 内核才能替换实现

审查报告（P0-2）指出：VectorStore 应抽接口，与 IMemoryStorage / IMemoryRelationStore / ISessionStore 保持一致的接口注入模式。

## 决策

采用**接口与实现分离**模式，与 ADR-002（IMemoryStorage）+ ADR-014（IMemoryRelationStore）保持一致的架构风格：

### 1. 接口定义（memora 内核 `src/memory/vectorStore.ts`）

```typescript
/**
 * 向量存储接口——宿主项目可实现此接口注入自定义向量库
 * （如 SqliteVectorStore / LanceDBVectorStore / QdrantVectorStore）
 */
export interface IVectorStore {
  /** 添加向量（id 与 Memory.id 对应） */
  addVector(id: string, vector: number[], metadata?: Record<string, unknown>): void;
  /** 批量添加向量 */
  addVectors(vectors: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>): void;
  /** 按向量相似度搜索（返回 top-K 结果，含 id + score） */
  search(query: number[], limit: number): Array<{ id: string; score: number }>;
  /** 按 id 删除向量 */
  removeVector(id: string): void;
  /** 获取已索引的向量数量 */
  size(): number;
  /** 持久化（实现可选，如 JsonVectorStore 写入 JSON 文件） */
  flush?(): void;
  /** 关闭连接（实现可选） */
  close?(): void;
}
```

### 2. 内置实现：JsonVectorStore（原 VectorStore 改名）

```typescript
/**
 * JSON 文件持久化的向量存储——内置实现，满足 IVectorStore 接口
 * 适用于中小规模记忆库（< 10000 条向量），无需额外数据库依赖
 */
export class JsonVectorStore implements IVectorStore {
  // 原 VectorStore 的全部实现，类名改为 JsonVectorStore
  // node:fs 操作封装在此类内部，不暴露给接口
}
```

### 3. 注入方式

```typescript
// AgentOptions 新增 vectorStore?: IVectorStore（类型从具体类改为接口）
interface AgentOptions {
  // ...
  vectorStore?: IVectorStore;  // 原 VectorStore → IVectorStore
  embeddingService?: EmbeddingService;
}
```

### 4. 公共 API 导出

```typescript
// src/index.ts
export { JsonVectorStore } from '@/memory/vectorStore.js';  // 值导出（类）
export type { IVectorStore, EmbeddingService } from '@/memory/vectorStore.js';  // 类型导出（接口）
```

## 理由

1. **与现有架构一致**——IMemoryStorage / IMemoryRelationStore / ISessionStore 均为接口注入，IVectorStore 保持同构（B1 边界）
2. **内核零环境依赖**——`node:fs` 操作封装在 JsonVectorStore 内部，接口无环境依赖，浏览器端可实现 MemoryVectorStore（B2 边界）
3. **宿主可扩展**——宿主可实现 IVectorStore 接入 LanceDB / Qdrant / Pinecone 等专业向量数据库，无需 fork 内核（B3 边界）
4. **测试零 IO**——测试可注入 MockVectorStore（内存实现），不依赖文件系统（B4 边界）
5. **向后兼容**——JsonVectorStore 保留全部原 VectorStore 功能，宿主代码只需将类型从 `VectorStore` 改为 `IVectorStore`（或继续用 `JsonVectorStore` 值导入）

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 保留 VectorStore 具体类（不抽接口） | 违反零依赖内核原则；宿主无法注入自定义向量库 |
| 抽接口但移除 JsonVectorStore 内置实现 | 降低开箱即用体验；宿主必须自行实现基础向量存储 |
| 在 IMemoryStorage 接口中增加向量方法 | 违反接口职责单一原则；SQL 存储与向量存储的关注点不同 |
| 使用抽象类（abstract class）替代接口 | TypeScript 接口更轻量，无运行时开销；与 IMemoryStorage 等保持一致 |

## 影响

### 内核（memora）

| 模块 | 变更 |
|------|------|
| `src/memory/vectorStore.ts` | `VectorStore` 类改名 `JsonVectorStore`；新增 `IVectorStore` 接口；新增 `EmbeddingService` 接口 |
| `src/agent/agent.ts` | `AgentOptions.vectorStore` 类型从 `VectorStore` 改为 `IVectorStore` |
| `src/index.ts` | 导出 `JsonVectorStore`（值）+ `IVectorStore`/`EmbeddingService`（类型）；移除 `VectorStore` 导出 |

### 宿主（memora-sprite）

| 模块 | 变更 |
|------|------|
| `hosts/memora-sprite/src/index.ts` | `VectorStore` → `JsonVectorStore`（值）+ `IVectorStore`（类型） |
| `hosts/memora-sprite/src/sprite/sprite.ts` | `SpriteOptions.vectorStore` 类型从 `VectorStore` 改为 `IVectorStore` |

### 规则

| 文件 | 变更 |
|------|------|
| `project-rules.md` | 技术栈清单"数据层"行更新：IMemoryStorage + IMemoryRelationStore + IVectorStore + ISessionStore 接口注入 |

## 何时回顾

- 当向量数据量级超过 10000 条时，评估是否需要内置 ANN 索引（如 HNSW）实现
- 当宿主项目需要分布式向量搜索时，扩展 IVectorStore 接口支持异步操作
- 当 Web 标准化 Vector Storage API 稳定时，评估是否提供内置浏览器实现
- 当 EmbeddingService 接口需要支持批量嵌入 + AbortSignal 时（见 P1-8 embedding 韧性）

## 相关 ADR

- [ADR-002](./ADR-002-storage-layer.md) · 存储层抽象（IMemoryStorage）—— IVectorStore 与之同构
- [ADR-014](./ADR-014-memory-relation.md) · 记忆关系侧车（IMemoryRelationStore）—— IVectorStore 与之同构
