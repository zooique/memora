---
alwaysApply: false
description: 向量存储接口化——IVectorStore 接口 + JsonVectorStore 内置实现，解除内核对 node:fs 的硬编码依赖
---

# ADR-016 · 向量存储接口化（IVectorStore + JsonVectorStore）

> **状态**：❌ 已废弃（2026-09-18 B0 收编） **原接受日期**：2026-07-08（1.0 接口稳定化）
> **废弃理由**：见文末「2026-09-18 收编 · 本 ADR 整体废弃」。**序号 016 不再使用，不因废弃回填**。
> **来源**：1.0 审查报告 P0-2 + 迭代文档 Phase 0.2

## 背景

v0.3 版本的 `VectorStore` 是一个**具体类**，直接 `import { readFileSync, writeFileSync } from 'node:fs'` 硬编码文件系统操作。这导致两个问题：

1. **违反零依赖内核原则**——内核不应依赖特定环境（如浏览器环境无 `node:fs`）
2. **无法注入自定义向量库**——宿主项目（如使用 LanceDB / Qdrant / Pinecone 的场景）必须 fork 内核才能替换实现

审查报告（P0-2）指出：VectorStore 应抽接口，与 IMemoryStorage / IMemoryRelationStore / ISessionStore 保持一致的接口注入模式。

## 决策

采用**接口与实现分离**模式，与 ADR-002（IMemoryStorage）+ ADR-014（IMemoryRelationStore）保持一致的架构风格。

接口三要素（详见 `src/memory/vectorStore.ts` 源码，此处不重复内嵌代码）：

1. **`IVectorStore` 接口（依赖倒置）**：`src/memory/vectorStore.ts`。内核消费者（recall.ts / memoryInspector.ts / agent.ts）只依赖此接口，不耦合具体持久化方式（JSON / SQLite / 外部向量库）。接口为**异步**设计、接收**文本字符串**而非原始向量数组（由内部 EmbeddingService 完成 text→vector 嵌入，宿主无需自建 embedding 服务）。
2. **`EmbeddingService` 接口**：`llm/embedding.ts` 的 `EmbeddingProvider` 满足之（结构子类型）。`embed`/`batchEmbed` 接受 `EmbeddingOptions`（signal + timeoutMs，P1-8 韧性补齐）。
3. **内置实现 `JsonVectorStore`（原 VectorStore 改名）**：JSON 文件持久化，适用于 <10000 条向量。加固点：load() schema 校验防损坏文件污染内存 + upsert/batchUpsert 维度一致性校验防维度错位 + save() 串行化防并发覆盖 + delete() 立即 save（FIX-P0-9 防崩溃后已删向量复活）。

**提供者注入方式**：`AgentOptions.vectorStore?: IVectorStore`（类型从具体类 `VectorStore` 改为接口 `IVectorStore`）。宿主可注入 `SqliteVectorStore` / `LanceDBVectorStore` / `QdrantVectorStore` 等实现，无需 fork 内核。

**公共 API 导出**（`src/index.ts`）：值导出 `JsonVectorStore`；类型导出 `IVectorStore` / `EmbeddingService` / `EmbeddingOptions`；移除旧 `VectorStore` 导出。

## 理由

1. **与现有架构一致**——IMemoryStorage / IMemoryRelationStore / ISessionStore 均为接口注入，IVectorStore 保持同构（B1 边界）
2. **内核零环境依赖**——`node:fs` 封装在 JsonVectorStore 内部，接口本身无环境依赖，宿主可注入自定义实现。注意：内核整体仍是 Node.js 专用（[ADR-002](./ADR-002-storage-layer.md) §定位定论 v0.9），"浏览器端实现 MemoryVectorStore"是宿主层的事
3. **宿主可扩展**——接入 LanceDB / Qdrant / Pinecone 无需 fork（B3 边界）
4. **测试零 IO**——测试注入 MockVectorStore（内存实现），不依赖文件系统（B4 边界）
5. **向后兼容**——宿主代码只需将类型 `VectorStore` → `IVectorStore`（或继续用 `JsonVectorStore` 值导入）
6. **异步 + 文本嵌入设计**——宿主无需自建 embedding 服务；异步为未来支持远程向量库（Qdrant HTTP API）预留空间

## 影响

| 范围 | 变更 |
|------|------|
| `src/memory/vectorStore.ts` | `VectorStore` 改名 `JsonVectorStore`；新增 `IVectorStore` + `EmbeddingService` 接口 |
| `src/agent/agent.ts` | `AgentOptions.vectorStore` 类型改为 `IVectorStore` |
| `src/index.ts` | 导出 `JsonVectorStore`（值）+ 类型；移除 `VectorStore` 导出 |
| `src/llm/embedding.ts` | 新增 `EmbeddingOptions`（P1-8 韧性补齐） |
| `hosts/memora-sprite/src/` | sprite 侧同步 `VectorStore` → `JsonVectorStore` / `IVectorStore` |
| `project-rules.md` | 技术栈"数据层"行更新为四接口注入清单 |

## 何时回顾

- 向量量级超 10000 条 → 评估内置 ANN 索引（HNSW）
- 宿主需分布式向量搜索 → 评估拆分 IAsyncVectorStore（网络分区/重试）
- EmbeddingService 需流式嵌入时（当前 batchEmbed 已支持 AbortSignal + timeoutMs）

## 相关 ADR

- [ADR-002](./ADR-002-storage-layer.md) · 存储层抽象（IMemoryStorage）—— IVectorStore 与之同构
- ADR-014 · 记忆关系侧车（IMemoryRelationStore）—— IVectorStore 与之同构（已废弃，git 历史可溯）

---

## 2026-09-18 收编 · 本 ADR 整体废弃

> **驱动**：B0 裁决（用户拍板，台账 `MEM-EMB-1`）。**本 ADR 描述的接口与实现已全链删除，序号 016 废弃不再复用**。
>
> **废弃因果（实锤）**：向量语义召回通道**写端从未接线**——生产代码对 `JsonVectorStore.upsert/batchUpsert` **零调用**（仅测试/验证脚本消费），`searchHybrid` 的 `size > 0` 守卫恒 false → 语义通道生产上从未生效，`search_memories` 恒走纯关键词 = **「宣称能力零消费」的僵尸声明**。本 ADR 的接口化设计本身无伤，但其所承载的能力从未被真实消费。
>
> **土壤调研（2026-09-18）**：Anthropic Memory tool / Claude Code / Librarian Pattern（挪威语生产系统：SQLite FTS5 零 embedding 胜出）均实证「LLM 消费者 + 小语料（单用户千级 round-summary）」下纯关键词足用——LLM 自主改述重试是天然词汇桥梁；Mem0 的语义增益（+26% 准确率）属大语料/文档检索场景，不适用。
>
> **收编内容**：`IVectorStore` / `JsonVectorStore` / `EmbeddingService` / `EmbeddingProvider` 全删；`AgentOptions.vectorStore`、`config.embedding` 段、宿主 `createVectorStore`、设置面板向量检索 UI（`cfg_save/clear_embedding`）同步删除；`search_memories` 纯关键词 + 工具描述补「未命中换词重试」。
>
> **重建候选（探索期，不预支）**：若真实复现「关键词换词多轮仍搜不到、语义上确实存在」→ 按 **cache 可重算形态**回补（记忆库=唯一事实源，向量库=派生缓存：装配期幂等 batchUpsert 全量重建 + 单一写总线增量同步）。**任何回补不得散点双写**（否则回到 §3 双轨镜像带伤）。
