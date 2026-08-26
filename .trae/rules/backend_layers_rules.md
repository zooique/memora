---
alwaysApply: false
description: 后端分层规范（src/ 各模块的职责边界 + 核心库 vs 宿主项目边界）
---

# 后端分层规范

> 详见
> [ADR-008 · 目录结构按"职责分层"](../decisions/ADR-008-directory-structure.md)

## 核心库 vs 宿主项目职责边界

> **核心矛盾**：核心库必须领域无关，宿主项目必须领域相关。
> **边界原则**：核心库提供"机制"，宿主项目提供"策略"。

| 职能           | 核心库（`src/`）                                                        | 宿主项目（`hosts/` / 外部）           | 当前状态      |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------- | ------------- |
| LLM 对话       | ✅ 提供 provider 抽象 + 流式协议                                        | —                                     | ✅ 已有       |
| 记忆（3 层）   | ✅ 提供存储 + 索引 + 召回（用户画像已收敛为 round-summary 的 type=preference 召回，见 [memory-as-summary.md](../../docs/architecture/memory-as-summary.md)） | —                                     | ✅ 已有       |
| 安全           | ✅ 提供路径白名单 + 写入确认 + 权限模型                                 | —                                     | ✅ 已有       |
| 通用文件 I/O   | ✅ 提供 4 个内置工具                                                    | —                                     | ✅ 已有       |
| 工具注册机制   | ✅ 提供 `tools.registerTool()` + `tools.execute()`                       | ✅ 注册具体领域工具                   | ✅ 已有       |
| 领域工具实现   | —                                                                       | ✅ 实现 handler，委托内置工具         | ✅ 已有       |
| 人格/规则/技能 | ✅ 提供 Manager + 加载机制                                              | ✅ 编写 `.md` 配置文件                | ✅ 已有       |
| UI 界面        | —                                                                       | ✅ 自行实现（CLI / Web / TUI）        | ✅ 已有       |
| Diff 确认写入  | ✅ 提供 Differ + DiffRenderer                                           | ✅ 决定何时展示 diff                  | ✅ 已有       |
| Markdown 渲染  | ✅ 提供 MarkdownRenderer                                                | ✅ 决定是否启用                       | ✅ 已有       |
| 自我进化机制   | ✅ 提供 `config.onSuggestion()` + `config.confirm()` + `memory.snapshot()` / `memory.search()` / `memory.suggest()` | ✅ 决定进化呈现方式（桌宠/徽章/面板） | ✅ 已有       |

**判断标准**：新功能应该放在哪里？

```
该功能是否与特定领域（小说/编程/日程...）耦合？
  ├─ 是 → 宿主项目（hosts/ 或外部项目）
  │       例：create_chapter、update_character、代码 diff 展示
  └─ 否 → 该功能是否所有宿主项目都需要？
         ├─ 是 → 核心库（src/），但必须通过抽象接口提供
         │       例：registerTool()、write_file、search_memories
         └─ 否 → 无明确消费者时暂缓；等 ≥2 处真实复用再落地（[ADR-017](../decisions/ADR-017-natural-growth-redefinition.md) Scenario B 回溯提取；上帝对象拆分可取 ≥3 处调用，见 progressive-refactor-rules.md §5.2）
                 例：WebUI 框架、特定 LLM 厂商优化
```

## 分层职责

| 层          | 职责                                               | 不该做什么                                      |
| ----------- | -------------------------------------------------- | ----------------------------------------------- |
| `cli/`（已移出内核，宿主项目自行实现） | 历史参考：解析命令、REPL 循环、用户交互 | 直接调数据库（应通过 memory/ 层）             |
| `agent/`    | Agent 门面 + AgentLoop + 上下文窗口管理（ContextManager）+ 工具执行 + 内置工具处理器（BuiltinToolHandlers）+ 专职 Manager/服务类（`managers/` 下 16 个：ArchiveCoordinator/ChatLockManager/DedupManager/GoalConsistencyChecker/LlmJudgeHelper/MemoryAdvisor/MemoryDecayScheduler/MemoryGovernance/MemoryInspector/RoundSummaryGenerator/SessionArchiver/SessionManager/SessionNamer/StreamAccumulator/TextPolishManager/WorkProjection）+ 聚合门面（memoryGovernance，聚合 L0-L3 治理委托）+ 对话快照 + 作品投影 | 直接调 LLM HTTP（通过 provider 接口）           |
| `memory/`   | 记忆存储、索引、召回（语义 + 关键词双通道，向量搜索可选） | 调 LLM（通过 EmbeddingService 接口注入除外）    |
| `skill/`    | 技能文件扫描、关键词匹配、prompt 注入 | 直接调 LLM                                      |
| `llm/`      | LLM 适配、协议解析、流式处理                       | 读写文件                                        |
| `security/` | 路径白名单、写入确认（fail-closed，未注入 handler 时拒绝，HC-03）、Prompt 注入防御 | 业务逻辑、交互式终端 I/O（readline 由宿主注入） |
| `config/`   | 配置加载、环境变量展开                             | 业务逻辑                                        |
| `logging/`  | 日志输出                                           | 业务逻辑                                        |
| `role-pack/` | 角色包类型定义与行为策略基元（三层结构：L1 内容 + L2 策略 + L3 代码预留；纯类型与工具函数，不参与运行时 Agent Loop） | 运行时调用、依赖 LLM 或存储                     |
| `web-search/` | 网络搜索抽象接口（IWebSearchProvider）与默认实现（FetchWebSearchProvider，零依赖）；通过 AgentOptions 条件注入，不参与强制内置 | 业务逻辑、领域耦合                              |

**禁止**：

- ❌ 核心库 `src/` 中出现领域特有逻辑（如"章节"、"角色"、"代码审查"）
- ❌ 宿主项目绕过 `registerTool()` 直接修改 `ToolExecutor` 内部
- ❌ 核心库依赖宿主项目的任何代码或配置
- ❌ 在核心库中硬编码工具列表（工具定义由 `BUILTIN_TOOLS` + `registerTool()` 动态组合）


## 宿主状态声明（2026-08-26 定案）

> **一句话**：**当前唯一活跃宿主为 VSCode 插件（hosts/memora-vscode），Sprite 桌面宿主（hosts/memora-sprite）已搁置。**

### 宿主清单与状态

| 宿主 | 路径 | 状态 | 说明 |
|------|------|------|------|
| **VSCode 插件** | hosts/memora-vscode | 🟢 **活跃开发中** | 核心目标宿主，所有新功能优先在此实现和验证 |
| Sprite 桌面宿主 | hosts/memora-sprite | 🔴 **已搁置** | 不再进行功能迭代，仅保留基础框架，待未来有明确需求时重启 |

### 开发约束

1.  **功能实现优先级**：所有新功能、UI 变更、插件 API 调整，**优先在 hosts/memora-vscode 中实现**。
2.  **Sprite 宿主清理**：若内核功能调整导致 Sprite 宿主代码失效（如移除了其专属的复杂逻辑），**直接清理废弃代码**，无需为其维护兼容性。
3.  **跨宿主设计**：当设计新机制时，仍需考虑通用性（因为核心库必须领域无关），但**实现和验证只需确保 VSCode 宿主可用**。

---

## 依赖方向

```
agent/      →  llm/         （对话调用 Provider）
            →  memory/      （记忆存储 + 召回 + 冲突消解 supersededBy）
            →  role-pack/   （角色包匹配与策略，通过 RolePackManager）
            →  skill/       （技能管理，通过 SkillManager）
            →  security/    （路径校验，跨切）
memory/     →  utils/       （frontmatter 解析 + segmenter 分词）
            →  security/    （type-only：ProjectManager.init() 需 SecurityGuard 创建项目路径守卫）
            →  （依赖倒置例外：vectorStore.ts 通过 import type 引入 llm/embedding.js 的 EmbeddingOptions——类型定义在实现方 llm/，消费者 memory/ 以 type-only 引用。EmbeddingService 方向相反，见 llm/ 行）
skill/      →  utils/       （frontmatter 解析 + segmenter 分词 + scanner 扫描）
            →  （不依赖 memory/：SkillManager 已从 SQLite 索引解耦，纯文件+内存缓存）
llm/        →  memory/      （type-only：EmbeddingService 接口定义在 memory/、llm/ provider 实现。属依赖倒置：消费者 memory/ 定义接口契约，实现方 llm/ 遵守。EmbeddingOptions 方向相反，见 memory/ 例外行）
role-pack/  →  utils/       （类型工具函数，纯数据层，无其他依赖）
web-search/ →  utils/       （errors.ts 使用 MemoraError，零网络依赖）
            →  （被 agent/ 通过 AgentOptions 条件注入，不强制内置）
config/     →  （被所有层调）
logging/    →  （被所有层调）
utils/      →  logging/（errors.ts 使用 logger）, 无其他外部依赖
```

## 存储层同步性约束（ADR-002 补充）

> **来源**：详见 [ADR-002 §同步优先决策](../decisions/ADR-002-storage-layer.md)

| 项 | 约束 |
|----|------|
| IMemoryStorage 接口 | 所有方法同步（与 better-sqlite3 API 对齐） |
| 适用环境 | Node.js 专用内核，不支持浏览器直接运行 |
| 浏览器访问方案 | 通过宿主层 Web 通道，HTTP 路由消费 HostContext |
| 异步存储后端 | 不支持。未来如需 IndexedDB 等异步后端，需先启动 IAsyncMemoryStorage 预研（触发条件见 ADR-002） |
| VectorStore 例外 | 语义搜索 `search()` 返回 `Promise<Memory[]>`（网络调用必须异步），与 IMemoryStorage 同步接口并行无冲突 |

**记忆关系侧车已移除**（ADR-014 已于 2026-08-14 判定为过度设计并废弃）：内核不再提供 `IMemoryRelationStore`/`InMemoryRelationStore`/`RelationBuilder`，冲突检测改用 `supersededBy` 布尔标记（[ADR-021](../decisions/ADR-021-memory-conflict-supersede-write-path.md) 写路径取代检测）。详见 [ADR-014](../decisions/ADR-014-memory-relation.md) 废弃说明。

**禁止**：

- ❌ `llm/` 反向依赖 `agent/`
- ❌ `memory/` 反向依赖宿主 `cli/`
- ❌ `security/` 被宿主 `cli/` 绕过（所有写操作必须经 security 校验）
- ❌ `memory/` 依赖 `skill/` 或 `role-pack/`（依赖方向不可逆）

## 模块内文件命名（约定快照）

> 顶层目录结构以 [project-rules.md §3](./project-rules.md) 为唯一冻结契约；下方为**快照性质**的内部约定，随重构漂移、**不构成冻结契约**。

**模块内部通用结构**：每个模块 = `index.ts`（公共 API）+ `types.ts`（类型）+ `core.ts`/`helpers.ts`（实现）。`agent/` 含标准文件 `agent.ts`/`assembler.ts`/`loop.ts`/`contextPreparer.ts`/`checkpointRestoreCoordinator.ts` + `managers/`（专职 Manager/服务类，当前 17 个，清单以源码为准）+ `seed/`（种子聚合目录：最小执行闭环的唯一编排真理源，`seed/orchestrator.ts` 聚合 prepare/act/reflect/handoff 四阶段，供 `agent.ts` 门面委托；`agent/seed/* → agent/loop` 消费引擎，`agent.ts → agent/seed` 委托，不新建顶层模块）；`utils/` 集中存放跨层共享纯函数（errors/array/objects/path/time/segmenter 等）。

> **具体文件清单以 `src/` 实际代码为真理源**，不在本文冻结——避免随重构腐化的冗余快照。

## 新增模块流程

> 详见 [new-module-guide.md](./new-module-guide.md)

