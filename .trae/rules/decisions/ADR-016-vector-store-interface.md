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

采用**接口与实现分离**模式，与 ADR-002（IMemoryStorage）+ ADR-014（IMemoryRelationStore）保持一致的架构风格。

### 1. 接口定义（memora 内核 `src/memory/vectorStore.ts`）

> **重要**：接口为**异步**设计（load/save/upsert/search 均返回 Promise），
> 且接收**文本字符串**而非原始向量数组——由 EmbeddingService 在接口内部完成文本→向量的嵌入。
> 这让宿主无需自建 embedding 服务，只需注入 EmbeddingProvider 即可获得语义搜索能力。

```typescript
/**
 * 嵌入服务接口（依赖倒置，与 llm/ 层解耦）
 *
 * EmbeddingProvider（llm/embedding.ts）满足此接口（结构子类型）。
 * P1-8 韧性补齐：embed/batchEmbed 接受 EmbeddingOptions（signal + timeoutMs）。
 */
export interface EmbeddingService {
  embed(text: string, options?: EmbeddingOptions): Promise<number[]>;
  batchEmbed(texts: string[], options?: EmbeddingOptions): Promise<Array<{ text: string; vector: number[] }>>;
}

/**
 * 向量存储接口（依赖倒置）
 *
 * 内核消费者（recall.ts / memoryInspector.ts / agent.ts）只依赖此接口，
 * 不耦合具体持久化方式（JSON / SQLite / 外部向量库）。
 *
 * 内核内置实现：JsonVectorStore（JSON 文件持久化，单用户本地场景）。
 * 宿主可替换为 SqliteVectorStore / LanceDBVectorStore / QdrantVectorStore 等实现。
 */
export interface IVectorStore {
  /** 从持久化介质加载向量索引（冷启动） */
  load(): Promise<void>;
  /** 持久化向量索引到介质 */
  save(): Promise<void>;
  /**
   * 为文本生成向量并存储
   * @param id 记忆 ID（与 Memory.id 对应）
   * @param text 待嵌入的文本
   * @param options embedding 调用选项（signal 外部取消 + timeoutMs 超时）
   */
  upsert(id: string, text: string, options?: EmbeddingOptions): Promise<void>;
  /**
   * 批量嵌入并存储
   * @param items ID + 文本对
   * @param options embedding 调用选项（signal 外部取消 + timeoutMs 超时）
   */
  batchUpsert(items: Array<{ id: string; text: string }>, options?: EmbeddingOptions): Promise<void>;
  /**
   * 删除向量（实现决定是否立即持久化）
   * @param id 待删除的记忆 ID
   */
  delete(id: string): void;
  /**
   * 语义搜索：基于查询文本的向量，返回 topK 最相似的 ID
   * @param query 查询文本（内部嵌入为向量后搜索）
   * @param topK 返回数量上限（默认 5）
   * @param minSimilarity 最低相似度阈值（0~1，默认 0.3）
   * @param options embedding 调用选项（signal 外部取消 + timeoutMs 超时）
   * @returns ID + 相似度 对的数组，按相似度降序排列
   */
  search(
    query: string,
    topK?: number,
    minSimilarity?: number,
    options?: EmbeddingOptions,
  ): Promise<Array<{ id: string; similarity: number }>>;
  /** 获取存储的向量数量 */
  readonly size: number;
}
```

### 2. 内置实现：JsonVectorStore（原 VectorStore 改名）

```typescript
/**
 * JSON 文件持久化的向量存储——内置实现，满足 IVectorStore 接口
 * 适用于中小规模记忆库（< 10000 条向量），无需额外数据库依赖
 *
 * 加固点：
 * - load() 增加 schema 校验（防止损坏文件污染内存索引）
 * - upsert/batchUpsert 增加维度一致性校验（防止维度错位导致相似度计算崩溃）
 * - save() 串行化（防止并发 save 互相覆盖丢失数据）
 */
export class JsonVectorStore implements IVectorStore {
  constructor(
    private readonly storePath: string,        // JSON 文件路径
    private readonly embeddingProvider: EmbeddingService,  // 嵌入服务注入
  ) {}
  // ... 全部方法实现 IVectorStore 接口 ...
}
```

### 3. 注入方式

```typescript
// AgentOptions 新增 vectorStore?: IVectorStore（类型从具体类改为接口）
interface AgentOptions {
  // ...
  vectorStore?: IVectorStore;  // 原 VectorStore → IVectorStore
  // embeddingProvider 通过 vectorStore 内部持有，无需单独注入
}
```

### 4. 公共 API 导出

```typescript
// src/index.ts
export { JsonVectorStore } from '@/memory/vectorStore.js';  // 值导出（类）
export type { IVectorStore, EmbeddingService } from '@/memory/vectorStore.js';  // 类型导出（接口）
export type { EmbeddingOptions } from '@/llm/embedding.js';  // 韧性选项类型
```

## 理由

1. **与现有架构一致**——IMemoryStorage / IMemoryRelationStore / ISessionStore 均为接口注入，IVectorStore 保持同构（B1 边界）
2. **内核零环境依赖**——`node:fs` 操作封装在 JsonVectorStore 内部，接口本身无环境依赖，宿主可注入自定义实现（如 LanceDB / Qdrant / Pinecone）。注意：内核整体仍是 Node.js 专用（详见 [ADR-002](./ADR-002-storage-layer.md) §"关于内核浏览器可 import"的定位澄清），"浏览器端可实现 MemoryVectorStore" 是宿主层的事，不是内核目标
3. **宿主可扩展**——宿主可实现 IVectorStore 接入 LanceDB / Qdrant / Pinecone 等专业向量数据库，无需 fork 内核（B3 边界）
4. **测试零 IO**——测试可注入 MockVectorStore（内存实现），不依赖文件系统（B4 边界）
5. **向后兼容**——JsonVectorStore 保留全部原 VectorStore 功能，宿主代码只需将类型从 `VectorStore` 改为 `IVectorStore`（或继续用 `JsonVectorStore` 值导入）
6. **异步 + 文本嵌入设计**——接口接收文本而非原始向量，让宿主无需自建 embedding 服务；异步设计为未来支持远程向量库（如 Qdrant HTTP API）预留空间

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 保留 VectorStore 具体类（不抽接口） | 违反零依赖内核原则；宿主无法注入自定义向量库 |
| 抽接口但移除 JsonVectorStore 内置实现 | 降低开箱即用体验；宿主必须自行实现基础向量存储 |
| 在 IMemoryStorage 接口中增加向量方法 | 违反接口职责单一原则；SQL 存储与向量存储的关注点不同 |
| 使用抽象类（abstract class）替代接口 | TypeScript 接口更轻量，无运行时开销；与 IMemoryStorage 等保持一致 |
| 同步接口 + 原始向量数组（接收 number[]） | 宿主需自建 embedding 服务；无法支持远程向量库的异步 API |

## 影响

### 内核（memora）

| 模块 | 变更 |
|------|------|
| `src/memory/vectorStore.ts` | `VectorStore` 类改名 `JsonVectorStore`；新增 `IVectorStore` 接口；新增 `EmbeddingService` 接口 |
| `src/agent/agent.ts` | `AgentOptions.vectorStore` 类型从 `VectorStore` 改为 `IVectorStore` |
| `src/index.ts` | 导出 `JsonVectorStore`（值）+ `IVectorStore`/`EmbeddingService`（类型）；移除 `VectorStore` 导出 |
| `src/llm/embedding.ts` | 新增 `EmbeddingOptions` 接口（P1-8 韧性补齐） |

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
- 当宿主项目需要分布式向量搜索时，评估是否需要拆分 IAsyncVectorStore 接口（当前已是异步，但未考虑网络分区/重试）
- 当宿主层 Web 调试通道需要浏览器侧直接调用 IVectorStore 时，由宿主通过 IPC 委托 Node.js 主进程（内核不计划提供浏览器内置实现）
- 当 EmbeddingService 接口需要支持流式嵌入时（当前 batchEmbed 已支持 AbortSignal + timeoutMs）

## 相关 ADR

- [ADR-002](./ADR-002-storage-layer.md) · 存储层抽象（IMemoryStorage）—— IVectorStore 与之同构
- [ADR-014](./ADR-014-memory-relation.md) · 记忆关系侧车（IMemoryRelationStore）—— IVectorStore 与之同构
