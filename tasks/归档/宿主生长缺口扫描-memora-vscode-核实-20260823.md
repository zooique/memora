# memora-vscode 宿主生长缺口扫描（聚焦版）

> 只审查 `hosts/memora-vscode`，不计入 sprite。
> 方法：以内核 19 模块为种子，逐个 grep 实测核对 vscode 宿主源码（非凭 alignment 文档记忆）。
> 关键纠偏：上一份 `GROWTH_GAP_SCAN.md` 沿用了 `host-alignment-v2.md` 的旧 ❌ 标项，本报告实测推翻其中多项——**vscode 对齐度被低估了**。
>
> 三态：
> - ✅ 已对齐（接线 + 暴露均完成）
> - 🟡 内核运行/提供但宿主未消费（隐性缺口）
> - ❌ 未对齐

---

## 一、模块对齐矩阵（实测）

| # | 内核模块 | 状态 | 证据 |
|---|---------|------|------|
| 1 | 单一问答闭环 | ✅ | `chatPanel.ts` 消费 `agent.chat()` 流式 chunk |
| 2 | 记忆·摘要·召回链 | ✅ | `workspaceStorage.ts` 实现 `IMemoryStorage` + `searchHybrid`；`settingsPanel` 接 `MemoryInspector` |
| 3 | 上下文装配·截断·补全 | 🟡 | `compaction` 内核运行（`assemble.ts` 注 G5 后台去重）；但**无用户可见的"上下文已压缩"提示**；`contextTruncated` 中文化已注入 |
| 4 | 工具执行与安全 | ✅ | `codeExecutionProvider` + `permission:'owner'` + `allowedPaths` + `confirmWrites` + `preExecutionCheck` |
| 5 | 角色包装配与策略 | ✅ | `rolePackSwitched` 事件绑定 (`chatPanel:609`) + `activeRolePack` 持久化 + capabilities/toolMode 读取 |
| 6 | 会话状态机·检查点 | ✅ | `sessionStore.ts:219-229` 完整 `saveCheckpoint/loadCheckpoint/deleteCheckpoint`；`protocol.ts` 定义 `checkpoint_restore/available`；`chatPanel:1116` 调 `agent.restoreFromCheckpoint()` |
| 7 | LLM 适配与路由 | ✅ | `providerStore.ts` + `createProvider` + `providerRouter` 钩子（单 Provider 直返，预留路由） |
| 8 | Skills 系统主干 | ✅ | `agent.skills.loadExtraDir(userSkillsDir)` + 全局/角色包两级 + skillMatched 提示 (`chatPanel` 指示器) |
| 9 | 安全与路径守卫 | ✅ | `pathGuard` 内核 + `allowedPaths` 注入 |
| 10 | 核心工具层 (configRM/scanner/segmenter) | ✅ | `workspaceStorage.ts:15` 引 `segmentLower/validateSource/applyDecayToMemory`；经 `agent.tools` 间接消费 |
| 11 | 会话存储与历史 | ✅ | `WorkspaceSessionStore` 实现 `ISessionStore` 全量方法 + `deleteSession/truncateFrom` 扩展 |
| 12 | 宿主要装层 assembler | ✅ | `assemble.ts` 薄壳，注入全量依赖（唯一装配真理源，优于 sprite） |
| 13 | 外部 Provider 边界 | ✅ | `FetchWebSearchProvider`/`FetchWebFetchProvider` + `createLocalCodeExecutor` |
| 14 | loop 模块专项 | ✅ | `dedupCompleted` 提示 (`chatPanel:542-555` "已自动优化 N 次重复工具调用")；handoff 续跑限 3 轮；pause/resume |
| 15 | Agent 门面 agent.ts | ✅ | `new Agent()` 注入全量 options |
| 16 | 5 个支持 Manager | 🟡 | `memoryAdvisor.suggest()` **仅注释提及未消费** (`chatPanel:1765`)；`memoryGovernance`/`memoryDecayScheduler` 内核自动跑；`goalConsistencyChecker` 内核内部 |
| 17 | config/loader.ts | ✅ | `loadConfig` 经 `createProviderFromConfig` 间接 |
| 18 | 记忆存储实现 memory/ | ❌→🟡 | **无 SQLite**（JSON 文件存储）；向量索引**已对齐**（`JsonVectorStore` 注入）。StoragePathResolver 未用（直接拼路径） |
| 19 | logging/eventEmitter/utils | ✅ | `tracer.ts` 实现 `ITracer` + `atomicWriteFileSync` |

---

## 二、真实生长缺口（聚焦后）

### 🟡 缺口 1：memoryAdvisor 建议未消费（模块 16）
- **现状**：`assemble.ts` 经内核 assembler 强制创建 `MemoryAdvisor`（被动被 recall 调用）。`chatPanel.ts:1765` 注释提到"见 memoryAdvisor.suggest"，但**代码未真正调用 `agent.memoryAdvisor?.suggest()` 并推送给 UI**。
- **生长点**：在召回完成后调用 `suggest()`，将"与你关注相关但未直接搜到的记忆"作为建议卡片推入对话面板（复用现有 suggestion 卡片机制）。内核 API 已现成。

### 🟡 缺口 2：compaction 上下文压缩无用户可感知提示（模块 3）
- **现状**：内核 `loop.ts:231` 默认 `ResultReplacementStrategy` 在跑，tracer 有"压缩摘要" span (`tracer.ts:119`)，但**用户看不到"上下文已压缩/已截断"的提示**。
- **生长点**：监听 compaction 相关事件/AgentChunk，在对话面板提示"为保持专注，已压缩早期上下文"。与现有 `contextTruncated` 中文化文案同构。

### 🟡 缺口 3：StoragePathResolver 未用（模块 18）
- **现状**：宿主直接 `join(projectPath, '.memora')` 拼路径（`assemble.ts:139/160`），未按内核 `StoragePathResolver` 解析。当前无害，但若内核路径约定演进，宿主会漂。
- **生长点**：低优先，仅当内核 `StoragePathResolver` 稳定且有宿主收益时接入。

### ❌→🟡 缺口 4：SQLite 生产级存储（模块 18，设计选择）
- **现状**：`WorkspaceStorage` 为单文件 JSON 数组（`workspaceStorage.ts`），无 SQLite。对齐文档标 ❌，但 sprite 已用 SQLite——**两宿主不对称**。
- **性质**：非硬性缺口，是"规模阈值"问题（记忆量 > 500KB 才触发）。当前 vscode 定位为工作区级轻量宿主，JSON 可接受。
- **生长点**：仅当实测记忆量增长触发性能拐点时升级 `SqliteMemoryStorage`。不建议现在做。

---

## 三、对抗式审查结论

1. **推翻上份报告的误判**：`host-alignment-v2.md` 标 ❌ 的 `IVectorStore`/`atomicWrite`/`checkpoint` 三项，实测 vscode **已对齐**——文档是 2026-08-18 的旧快照，宿主已生长超越文档。
2. **vscode 对齐度整体高于 sprite**：assembler 薄壳、checkpoint 完整接线、角色包切换事件、duplicate 提示——这些 sprite 缺的，vscode 都有。
3. **剩余缺口集中在"被动能力未消费"**：memoryAdvisor、compaction 提示——内核在跑，宿主没把价值呈现给用户。这是**低工作量、高感知**的生长点。
4. **SQLite 不是真缺口**：是规模阈值决策，不应列为优先生长项。

---

## 四、建议生长顺序（vscode 专属）

| 优先级 | 缺口 | 工作量 | 性质 |
|-------|------|-------|------|
| P1 | memoryAdvisor 建议推 UI | 小 | 内核 API 现成 |
| P1 | compaction 压缩提示 | 小 | 复用中文化文案 |
| P3 | StoragePathResolver 接入 | 极小 | 防路径漂移 |
| 暂缓 | SQLite 升级 | 中 | 非必要，等规模拐点 |
