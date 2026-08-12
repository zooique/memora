# Memora 架构设计审查报告（2026-08-11）

> 使用 16 维架构审查框架进行全面评估。
> 审查范围：内核 `src/`（172 个 .ts 文件，54,064 行）+ 宿主 `hosts/memora-sprite/`
> 审查基准：2026-08-11 代码库状态

---

## 审查概要

**整体评分：4.0 / 5.0 — 良好**

Memora 是一个架构纪律性强、工程品味高的项目。分层清晰、接口抽象合理、注释详尽、ADR 体系完整。核心问题集中在"局部过度设计 + 前沿特性缺失"的剪刀差上。

| 维度 | 评分 | 关键发现 |
|------|------|---------|
| 1. 模块化与分层 | 4/5 | 分层清晰，但 18 个 manager 导致 agent/ 模块过重 |
| 2. 架构腐化度 | 4/5 | 架构与代码基本一致，ADR 体系完整，偶有注释漂移 |
| 3. 可扩展性 | 4/5 | 接口抽象好，但 MCP 协议缺失、工具注册不够灵活 |
| 4. 依赖管理 | 5/5 | 零第三方运行时依赖，依赖方向单向清晰 |
| 5. 过度设计 | 3/5 | 工具补偿管线、边车字段维护成本偏高 |
| 6. 设计深度 | 4/5 | 核心路径深入，但多模型路由、高级 RAG 缺失 |
| 7. 技术债务密度 | 5/5 | 零 TODO/FIXME/HACK，注释质量高 |
| 8. 可测试性 | 4/5 | 81 个测试文件，核心模块 1807 行测试覆盖好 |
| 9. 向后兼容性 | 4/5 | schemaVersion 迁移机制好，但缺少正式 deprecation 策略 |
| 10. 可维护性 | 4/5 | 注释详尽，但 sessionManager.ts 1807 行偏大 |
| 11. 治理与流程 | 4/5 | 16 条规则、32 个 ADR、CI 完备 |
| 12. 构建与交付 | 4/5 | 构建脚本完整，但无自动化发布流程 |
| 13. 性能与资源 | 4/5 | 设计上有考虑，但缺少正式的性能基准测试 |
| 14. 安全与韧性 | 5/5 | 路径白名单 + 两级权限 + 审计日志，设计扎实 |
| 15. 错误处理 | 5/5 | 5 类错误 + retryable 标记 + 中文友好信息 |
| 16. 可观测性 | 3/5 | ITracer 接口好，但缺少 trace tree、token 追踪 |

---

## 一、结构维度

### 1. 模块化与分层 — 4/5

**优点：**
- 11 个顶层模块职责清晰（agent/memory/llm/persona/skill/config/logging/security/eval/utils/web-search）
- 依赖方向单向：`agent → memory → utils`，`agent → llm`，`agent → security`（[index.ts](../src/index.ts) 类型依赖图注释明确标注）
- 严格遵循"内核不反向依赖宿主"原则，所有宿主交互通过接口注入（`IMemoryStorage`、`ILogger`、`ITracer`）

**问题：**
- `src/agent/managers/` 目录下 18 个 manager 类，职责颗粒度偏细。如 `MemoryGovernance`、`MemoryAdvisor`、`MemoryInspector`、`MemoryDecayScheduler` 四个 manager 都与记忆相关，边界模糊
- `src/agent/` 模块占内核总代码量的 60%+，是事实上的"上帝模块"

### 2. 架构腐化度 — 4/5

**优点：**
- 32 个 ADR 完整记录了主要架构决策，代码与设计基本一致
- 规则文件（16 个）与 ADR 之间建立了交叉引用规范（[cross-document-reference.md](../.trae/rules/cross-document-reference.md)）
- 此前发现的 7 项腐化问题（FIFO 谓词恒真、restoreHistory 空转等）已在 2026-08-11 修复闭环

**问题：**
- 个别注释使用行号引用（如 `loop.ts:544-549`），行号漂移后产生假契约（已修复，改为符号引用）
- agent 模块中的 `_pendingPauseReason` 等四方冗余虽已收口到状态机，但历史遗留的注释引用仍在

### 3. 可扩展性 — 4/5

**优点：**
- 核心接口抽象良好：`IMemoryStorage`、`ILogger`、`ITracer`、`IVectorStore`、`IMemoryRelationStore` 均为宿主可注入接口
- 新增内置工具只需在 `builtinTools.ts` 添加定义 + `toolExecutor.ts` 添加实现

**缺口：**
- 缺少 MCP（Model Context Protocol）支持，工具系统是内置静态的，无法动态接入社区工具生态
- 新增一个 manager 需要对 `assembler.ts` 做修改，没有自动发现机制
- 工具注册是硬编码的 `switch` 分支，而非插件式注册表

### 4. 依赖管理 — 5/5

**优点：**
- `dependencies` 字段为空，零第三方运行时依赖（仅 pino 作为可选的 peerDependency）
- 依赖方向单向清晰，无循环依赖
- 文件层两段式契约（ConfigManager 写 API 只同步 SQLite，不操作文件）防止了依赖混乱

---

## 二、质量维度

### 5. 过度设计 — 3/5

**问题：**
- **工具补偿机制**（P3.4）：三态幂等性（idempotent/idempotent-key/non-idempotent）+ outbox 模式 + sideEffect 追踪 + FIFO 驱逐 + 补偿通知。完整管线涉及 9 个文件，但补偿逻辑在实践中几乎不会被触发（LLM 调用失败时用户更倾向于重试整个回合）。保留 outbox 模式即可，补偿管线可降级为日志
- **SessionCheckpoint 边车字段**：5 个可选字段（`completedToolCalls`、`roundLog`、`pauseMeta`、`pausedAt`、`schemaVersion`）各自有独立维护逻辑，使 `SessionManager` 膨胀到 1807 行。状态机本身（~100 行）是轻量的，边车字段的维护成本才是问题
- **18 个 manager**：职责颗粒度偏细，`MemoryGovernance`、`MemoryAdvisor`、`MemoryInspector` 等边界有重叠

**非过度设计：** `Composer` 四级补全链（~340 行）设计合理，各层级职责清晰；`SessionStateMachine` 三态状态机（~100 行）轻量且必要

### 6. 设计深度 — 4/5

**深入处：**
- 错误处理体系完整：5 类错误（Config/Network/Llm/Tool/Security）+ retryable 标记 + 中文友好信息 + 下一步建议
- 路径安全检查：4 类允许根 + 28 类禁止规则 + 符号链接逃逸防护 + 写入二次确认
- 记忆召回：双通道（语义 + 关键词）+ 混合排序（0.6/0.4 权重）+ 排除已注入记忆

**浅尝处：**
- **多模型路由**：仅支持单一 Provider 配置，无基于任务类型的动态模型选择（[factory.ts](../src/llm/factory.ts)）
- **RAG 管线**：有基础双通道召回，但缺少 rerank、context compression、multi-hop reasoning、查询重写
- **可观测性**：`ITracer` 接口设计合理，但缺少 trace tree（父子 span 关联）、token 消耗追踪、性能分析

### 7. 技术债务密度 — 5/5

**极低债务：**
- 内核 src/ 中零 TODO/FIXME/HACK/WORKAROUND
- 宿主 src/ 中零 TODO/FIXME/HACK/WORKAROUND
- 注释质量高，函数级注释标准化，文件级注释包含设计上下文
- 无死代码（未被引用的导出或废弃模块）

**说明：** 此前存在的 TODO（`archiveButtonManager.test.ts`）和假契约注释（`loop.ts:544-549` 行号引用）已在 2026-08-11 修复闭环

### 8. 可测试性 — 4/5

**数据：**
- 81 个测试文件，覆盖所有模块
- 使用 `InMemoryStorage` 实现零依赖测试，`MSW Mock LLM` 模拟 LLM 调用
- 核心模块（`sessionManager.ts` 1807 行）有专门的测试文件（`sessionManager.test.ts` + `sessionCheckpointLifecycle.test.ts`）

**缺口：**
- `sessionManager.ts` 因体积过大，部分方法（如 `compensateTool`）的测试依赖集成测试（`uninterruptedWorkflow.test.ts`）而非单元测试
- 集成测试（`llmIntegration.test.ts`）需要 API key 时可跳过，但缺少跳过标记的标准化

---

## 三、生命周期维度

### 9. 向后兼容性 — 4/5

**优点：**
- `SessionCheckpoint.schemaVersion` + `checkpointMigrations` 静态分发表 = 检查点版本迁移机制
- `normalizeCheckpoint` 在加载时自动应用迁移，高于当前版本时尽力恢复并 warn、不阻断
- 语义化版本（当前 2.1.0），`publishConfig` 正确设置

**缺口：**
- 缺少正式的 deprecation 策略文档（何时标记 `@deprecated`、保留几个版本、移除流程）
- 公共 API 导出（`src/index.ts`）没有版本变更日志

### 10. 可维护性 — 4/5

**数据：**
- 内核 54,064 行 / 172 个文件，平均 314 行/文件
- `sessionManager.ts` 1807 行是最大的文件，超过 1000 行阈值
- 32 个 ADR 记录完整，注释质量高

**问题：**
- `sessionManager.ts` 1807 行，单一文件承担了会话切换、分叉、恢复、检查点、补偿、暂停、归档等 10+ 项职责
- 知识分布集中：`agent/` 模块占 60%+ 代码量，新开发者上手成本高

### 11. 治理与流程 — 4/5

**数据：**
- 16 个规则文件（`.trae/rules/`），覆盖架构哲学、编码规范、安全、渐进式重构等
- 32 个 ADR（内核 20 + 精灵 12），记录完整
- CI 配置（`.github/workflows/build.yml`）含构建、测试、打包
- `ci-check.ps1` 本地模拟脚本
- 新增模块标准流程（`new-module-guide.md`）

**缺口：**
- 缺少代码审查 checklist 的标准化文件（虽然 `code-review-checklist` skill 存在）
- 模块所有权没有显式声明

### 12. 构建与交付 — 4/5

**优点：**
- 构建脚本完整：`build`、`test`、`lint`、`typecheck`、`prepublishOnly`
- `files` 字段精确控制 npm 包内容，包含文档
- `exports` 字段正确配置 ESM + types + default fallback

**缺口：**
- 无自动化发布流程（需手动 `npm publish`）
- 无 `pre-publish` 的自动化完整性校验（如检查 CHANGELOG 是否更新）

---

## 四、横向维度

### 13. 性能与资源 — 4/5

**优点：**
- 冷热分离设计（文件承载本体，数据库承载索引）
- 热记忆 FIFO 截断防膨胀
- `NoopTracer` 单例零开销

**缺口：**
- 缺少正式的性能基准测试（benchmark）
- 未评估 `completedToolCalls` FIFO 驱逐在大规模场景下的性能影响

### 14. 安全与韧性 — 5/5

**优点：**
- 路径白名单：4 类允许根 + 28 类禁止规则（[pathGuard.ts](../src/security/pathGuard.ts)）
- 符号链接逃逸防护（P0 漏洞防护）
- 写入二次确认 + 审计日志，fail-closed 拒绝写入
- 两级权限（read/write）分离
- 安全搜索（safeSearch）降级策略

### 15. 错误处理 — 5/5

**优点：**
- 5 类错误清晰分类：ConfigError / NetworkError / LlmError / ToolError / SecurityError
- `ToolErrorCode` 含 retryable 标记，支持 AgentLoop 反思自修正
- 错误展示三要素：标题（中文）+ 详情（原文）+ 建议（下一步）
- `toError` 工具函数零日志依赖，浏览器友好

### 16. 可观测性 — 3/5

**优点：**
- `ITracer`/`ISpan` 接口设计合理，支持宿主注入 OpenTelemetry 实现
- `NoopTracer` + `NoopSpan` 单例零开销
- `TRACE_SPANS` 预定义 6 个关键节点 span 名称

**缺口：**
- 缺少父子 span 关联（trace tree），无法追踪跨模块调用链
- 缺少 token 消耗追踪
- 缺少各阶段耗时统计（性能分析）
- 除 `metrics.test.ts` 外，无完整的指标采集接口

---

## 优先修复清单

### P0（立即行动）
- 无。当前架构没有致命缺陷。

### P1（短期，1-3 个月）
- [ ] **工具补偿管线降级**：保留 outbox 模式（跳过已执行幂等工具），将 `compensateTool`/`compensateAllNonIdempotent` 降级为日志级别。预期减少 `sessionManager.ts` 约 80 行
- [ ] **多模型路由基础**：在 `factory.ts` 中支持基于任务类型（简单/推理/代码）的模型选择

### P2（中期，3-6 个月）
- [ ] **MCP 协议接入**：支持动态工具注册/发现，接入社区 MCP 工具生态
- [ ] **IPC 通道治理**：当前约 122 个通道，接近 150 阈值，启动合并评估
- [ ] **CSS 架构精简**：43 个源文件，合并 memory/ 目录下的 13 个文件

### P3（长期，6-12 个月）
- [ ] **高级 RAG 管线**：rerank 阶段、context compression、查询重写
- [ ] **可观测性深化**：trace tree（父子 span）、token 消耗追踪、性能分析
- [ ] **多模态支持**：扩展消息类型支持图像理解
- [ ] **SessionManager 拆分**：将 1807 行的检查点/补偿/暂停职责提取为独立模块
- [ ] **自动化发布流程**：GitHub Actions 自动发布 npm 包

---

## 各维度评分一览

```
  结构维度                   质量维度                  生命周期维度                 横向维度
  ┌─────┐                   ┌─────┐                   ┌─────┐                   ┌─────┐
  │ 4/5 │ 模块化与分层        │ 3/5 │ 过度设计            │ 4/5 │ 向后兼容性         │ 4/5 │ 性能与资源
  │ 4/5 │ 架构腐化度          │ 4/5 │ 设计深度            │ 4/5 │ 可维护性           │ 5/5 │ 安全与韧性
  │ 4/5 │ 可扩展性            │ 5/5 │ 技术债务密度        │ 4/5 │ 治理与流程         │ 5/5 │ 错误处理
  │ 5/5 │ 依赖管理            │ 4/5 │ 可测试性            │ 4/5 │ 构建与交付         │ 3/5 │ 可观测性
  └─────┘                   └─────┘                   └─────┘                   └─────┘
```

## 总体评价

Memora 是一个**架构纪律性强、工程品味好的项目**。其核心优势在于：

1. **零依赖内核**：`dependencies` 为空，严格遵循"纯逻辑库"定位
2. **接口抽象成熟**：`IMemoryStorage`、`ILogger`、`ITracer` 等宿主注入接口设计合理
3. **架构治理扎实**：32 个 ADR、16 个规则文件、CI 流水线完整
4. **代码质量高**：零 TODO/FIXME，注释详尽，错误处理体系完整
5. **安全设计深入**：路径白名单、符号链接防护、fail-closed 策略

主要改进方向：

- **收一收**：工具补偿管线、边车字段维护成本、18 个 manager 的颗粒度
- **补一补**：MCP 协议、多模型路由、高级 RAG、可观测性深度
- **理一理**：IPC 通道数、CSS 文件数、SessionManager 1807 行

**一句话总结**：一个在"工程纪律"上得分很高、在"前沿 Agent 特性"上还有追赶空间的项目。核心设计决策（万物皆记忆、零依赖、接口注入）经得起时间检验，局部过重的问题可以通过渐进式重构解决。