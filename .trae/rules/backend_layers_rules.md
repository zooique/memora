---
alwaysApply: false
description: 后端分层规范（src/ 各模块的职责边界 + 核心库 vs 宿主项目边界）
version: v1.2
date: 2026-07-27
---

# 后端分层规范

> 详见
> [ADR-008 · 目录结构按"职责分层"](./decisions/ADR-008-directory-structure.md)
> **记忆关系侧车**：详见 [ADR-014 · 记忆关系图谱](./decisions/ADR-014-memory-relation.md)

## 核心库 vs 宿主项目职责边界

> **核心矛盾**：核心库必须领域无关，宿主项目必须领域相关。
> **边界原则**：核心库提供"机制"，宿主项目提供"策略"。

| 职能           | 核心库（`src/`）                                                        | 宿主项目（`hosts/` / 外部）           | 当前状态      |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------- | ------------- |
| LLM 对话       | ✅ 提供 provider 抽象 + 流式协议                                        | —                                     | ✅ 已有       |
| 记忆（3 层）   | ✅ 提供存储 + 索引 + 召回                                                | —                                     | ✅ 已有       |
| 记忆关系图谱   | ✅ 提供 IMemoryRelationStore 侧车接口 + InMemoryRelationStore 测试实现 + RelationBuilder 构建机制 | ✅ 实现 SqliteRelationStore + 宿主 UI 关系图谱展示 | ✅ 已有 |
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
         └─ 否 → 暂不实现，等 2 次以上重复需求再提取（枝叶层 2 次提取原则，详见 [ADR-017](./decisions/ADR-017-natural-growth-redefinition.md)）
                 例：WebUI 框架、特定 LLM 厂商优化
```

## 分层职责

| 层          | 职责                                               | 不该做什么                                      |
| ----------- | -------------------------------------------------- | ----------------------------------------------- |
| `cli/`（已移出内核，宿主项目自行实现） | 历史参考：解析命令、REPL 循环、用户交互（精灵宿主使用 Electron 主进程替代） | 直接调数据库（应通过 memory/ 层）             |
| `agent/`    | Agent 门面 + AgentLoop + 上下文窗口管理（ContextManager）+ 工具执行 + 内置工具处理器（BuiltinToolHandlers）+ 专职 Manager/服务类（14 个：ArchiveCoordinator/AutoConfigRefiner/ChatLock/Config/DedupManager/Insight/MemoryAdvisor/MemoryDecay/MemoryInspector/RelationBuilder/Session/SessionArchiver/TextPolish/WorkProjection）+ 对话快照 + 作品投影 + 用户事实提取（userFactExtractor，纯函数模块，位于 agent/ 根级）+ 记忆治理门面（memoryGovernance，聚合 L0-L3 治理委托，非新增 Manager） | 直接调 LLM HTTP（通过 provider 接口）           |
| `memory/`   | 记忆存储、索引、召回（语义 + 关键词双通道，向量搜索可选）+ 关系图谱侧车（IMemoryRelationStore 接口，独立于 IMemoryStorage） | 调 LLM（通过 EmbeddingService 接口注入除外）    |
| `persona/`  | 角色管理、关键词匹配、system prompt 组装 | 直接调 LLM                                      |
| `skill/`    | 技能文件扫描、关键词匹配、prompt 注入 | 直接调 LLM                                      |
| `llm/`      | LLM 适配、协议解析、流式处理                       | 读写文件                                        |
| `security/` | 路径白名单、写入确认（fail-closed，未注入 handler 时拒绝，HC-03）、Prompt 注入防御 | 业务逻辑、交互式终端 I/O（readline 由宿主注入） |
| `config/`   | 配置加载、环境变量展开                             | 业务逻辑                                        |
| `logging/`  | 日志输出                                           | 业务逻辑                                        |
| `eval/`     | Agent 行为评估场景定义（EvalScenario 类型 + 工具函数，仅测试用，不参与运行时） | 业务逻辑、运行时调用                             |

**禁止**：

- ❌ 核心库 `src/` 中出现领域特有逻辑（如"章节"、"角色"、"代码审查"）
- ❌ 宿主项目绕过 `registerTool()` 直接修改 `ToolExecutor` 内部
- ❌ 核心库依赖宿主项目的任何代码或配置
- ❌ 在核心库中硬编码工具列表（工具定义由 `BUILTIN_TOOLS` + `registerTool()` 动态组合）

## 依赖方向

```
agent/      →  llm/         （对话调用 Provider）
            →  memory/      （记忆存储 + 召回 + 关系图谱侧车）
            →  persona/     （角色管理，通过 PersonaManager）
            →  skill/       （技能管理，通过 SkillManager）
            →  security/    （路径校验，跨切）
memory/     →  utils/       （frontmatter 解析 + segmenter 分词）
            →  （relationStore 是侧车，独立于 IMemoryStorage，不反向依赖 agent/）
            →  （EmbeddingService 接口定义在 memory/，llm/ 通过 import type 引入 EmbeddingOptions，属依赖倒置例外）
persona/    →  utils/       （frontmatter 解析 + segmenter 分词）
            →  （不依赖 memory/：PersonaManager 已从 SQLite 索引解耦，纯文件+内存缓存）
skill/      →  utils/       （frontmatter 解析 + segmenter 分词 + scanner 扫描）
            →  （不依赖 memory/：SkillManager 已从 SQLite 索引解耦，纯文件+内存缓存）
llm/        →  memory/      （type-only：EmbeddingOptions 类型引用，依赖倒置：消费者定义接口，提供者实现接口）
config/     →  （被所有层调）
logging/    →  （被所有层调）
utils/      →  logging/（errors.ts 使用 logger）, 无其他外部依赖
```

## 存储层同步性约束（ADR-002 补充）

> **来源**：详见 [ADR-002 §同步优先决策](./decisions/ADR-002-storage-layer.md)

| 项 | 约束 |
|----|------|
| IMemoryStorage 接口 | 所有方法同步（与 better-sqlite3 API 对齐） |
| 适用环境 | Node.js 专用内核，不支持浏览器直接运行 |
| 浏览器访问方案 | 通过宿主层 Web 调试通道（`hosts/memora-sprite/src/web/`），HTTP 路由消费 HostContext |
| 异步存储后端 | 不支持。未来如需 IndexedDB 等异步后端，需先启动 IAsyncMemoryStorage 预研（触发条件见 ADR-002） |
| VectorStore 例外 | 语义搜索 `search()` 返回 `Promise<Memory[]>`（网络调用必须异步），与 IMemoryStorage 同步接口并行无冲突 |

**记忆关系侧车的依赖约束**（ADR-014）：
- `IMemoryRelationStore` 是独立接口，不依赖 `IMemoryStorage`
- `InMemoryRelationStore`（测试用）仅依赖 `MemoryRelation` 类型
- `SqliteRelationStore`（宿主实现）依赖 better-sqlite3，在宿主层
- 关系构建机制（RelationBuilder）在内核 `agent/managers/`，LLM 调用合并到 InsightExtractor 单次调用（不增加 LLM 调用次数）
- 冲突检测嵌入 InsightExtractor.extract() 现有流程，宿主仅注入存储实现

**禁止**：

- ❌ `llm/` 反向依赖 `agent/`
- ❌ `memory/` 反向依赖宿主 `cli/`
- ❌ `security/` 被宿主 `cli/` 绕过（所有写操作必须经 security 校验）
- ❌ `memory/` 依赖 `persona/` 或 `skill/`（依赖方向不可逆）

## 模块内文件命名

每个模块内部可细分为：

```
agent/
├── agent.ts              # Agent 门面类（对外入口，编排层）
├── assembler.ts          # 组件组装器（Agent init 时组装各 Manager）
├── constants.ts          # Agent/Loop 常量集合（AGENT_CONSTANTS + LOOP_CONSTANTS）
├── loop.ts               # AgentLoop 主循环
├── toolExecutor.ts       # 工具执行器（registerTool + execute + 校验分发）
├── builtinTools.ts       # 内置工具定义（BUILTIN_TOOLS 声明）
├── builtinToolHandlers.ts # 内置工具处理器（read_file/write_file/list_dir/search_memories 实现，从 ToolExecutor 提取）
├── contextManager.ts     # 上下文窗口管理器（token 估算 + 消息截断 + 关键消息提取 + 摘要生成，从 AgentLoop 提取）
├── messageHistory.ts     # 消息持久化 + 会话归档
├── tracer.ts             # 可观测性（ITracer/ISpan 接口 + NoopTracer）
├── types.ts              # Agent 类型定义
├── userFactExtractor.ts  # 用户事实提取器（正则规则，纯函数模块，从 userProfile 迁入）
├── personaMatcher.ts     # 角色语义匹配器（LLM 辅助角色匹配纯函数，从 PersonaManager.matchByLlm 迁入，遵循 persona/ 不调 LLM 约束）
├── managers/             # 专职 Manager/服务类子目录（14 个 Manager + 1 个门面 + 1 个辅助：12 个生命周期 Manager + DedupManager + 1 个无状态服务类 + memoryGovernance 门面 + llmJudgeHelper 辅助）
│   ├── archiveCoordinator.ts # 归档协调器（archiveMode 三态控制 + 归档流程编排）
│   ├── autoConfigRefiner.ts  # 智能配置提炼器（模式 3：Agent 智能总结）
│   ├── chatLockManager.ts    # 对话锁管理器（token 校验 + 超时释放 + race condition 防护）
│   ├── configManager.ts      # 配置管理器（规则/技能注入 + 配置建议）
│   ├── dedupManager.ts       # 去重管理器（L0-L1 记忆去重）
│   ├── insightExtractor.ts   # Insight 提取器（输入分类 + 记忆提取 + 关系构建）
│   ├── llmJudgeHelper.ts     # LLM 判定辅助（judgeWithLlm 高阶函数，纯函数模块，供 memoryAdvisor/relationBuilder 共享）
│   ├── memoryAdvisor.ts      # 记忆顾问（记忆质量评估 + 归档价值判断）
│   ├── memoryDecayScheduler.ts # 记忆衰减调度器（decayScores 定时执行 + 首次 init）
│   ├── memoryGovernance.ts   # 记忆治理门面（聚合 L0-L3 治理委托，非新增 Manager，详见 architecture_philosophy_rules.md）
│   ├── memoryInspector.ts    # 记忆管理器（快照 + 搜索 + 统计 + 关联推荐 + writeXxx 写操作）
│   ├── relationBuilder.ts    # 关系构建器（候选召回 + prompt 构建 + 关系写入 + 冲突检测，ADR-014）
│   ├── sessionArchiver.ts    # 会话归档器（content 类记忆归档，会话级摘要，区别于 InsightExtractor 的洞察提取）
│   ├── sessionManager.ts     # 会话管理器（fork/switch/restore）
│   ├── textPolishManager.ts  # 文本润色服务类（无状态，仅依赖 Provider，非生命周期 Manager，详见 ADR-SP-017 §3）
│   └── workProjection.ts     # 作品投影管理器
└── __tests__/            # 单元测试

utils/
├── errors.ts             # 错误类型（MemoraError + 工厂函数 + ToolErrorCode 10 种错误码 + re-export toError）
├── toError.ts            # 纯逻辑 toError（零依赖，浏览器/Node 通用）
├── eventEmitter.ts       # 轻量类型事件发射器（AgentEventMap 6 事件）
├── frontmatter.ts        # Frontmatter 解析/序列化（从 memory/ 迁入，供 memory/persona/skill 共享）
├── json.ts               # LLM JSON 安全解析（parseLlmJson：markdown 剥离 + 引号修复 + 正则回退，专用于 LLM 输出）
├── loggerHolder.ts       # Logger 持有者（utils/ 内部 getLogger，解耦 utils→logging 循环依赖）
├── math.ts               # 数学工具（cosineSimilarity + roundTo 四舍五入到指定小数位）
├── path.ts               # 路径工具（expandHome、basename）
├── safeTimer.ts          # 安全定时器（safeSetTimeout/safeSetInterval + 跟踪清理）
├── scanner.ts            # Markdown 目录扫描工具（供 persona/skill 共享）
├── segmenter.ts          # 中文分词器（Intl.Segmenter，从 memory/ 迁入，供 memory/persona/skill 共享）
├── strings.ts            # 字符串工具（slugify）
└── time.ts               # 时间工具（nowIso、todayDate）
```

## 新增模块流程

> 详见 [new-module-guide.md](./new-module-guide.md)

## 前端 CSS 三层作用域模型

> **来源**：[ADR-018 · CSS 作用域规范](./decisions/ADR-018-css-scoping-convention.md)
> **适用范围**：精灵宿主渲染进程（`hosts/memora-sprite/src/electron/renderer/styles/`）

| 层级 | 作用域 | 命名规范 | 文件归属 |
|------|--------|----------|----------|
| **L1 全局基础** | 跨面板共享的设计令牌与原子类 | `--var-xxx` 变量 / `.btn-primary` 等通用组件类 | tokens.css + base.css + layout.css 的 `#app`/`#titlebar`/`#sidebar`/`.panel`/`.nav-btn` 等 |
| **L2 面板专属** | 单个面板内的所有样式 | **面板前缀 + BEM**（如 `.perception-affect-grid`） | `<panel>.css`（如 perception.css） |
| **L3 组件局部** | 可复用的独立组件（modal/toast/dropdown） | 组件名 + BEM | modal.css / toast.css 等独立组件文件 |

**核心约束**：

- 面板专属类必须加面板前缀（`perception-` / `dashboard-` / `memory-` / `settings-`），chat 主面板例外
- L2 面板之间不得相互依赖——如需覆盖说明类名复用出错
- 单一真理源——每个面板样式集中在单一 CSS 文件，禁止跨文件重复定义
- CSS 加载顺序遵循 L1 → L3 → L2 依赖链
- 违反约束的典型表现：BARE 类（无前缀通用类）被其他面板 DOM 继承导致属性污染（如 layout.css 中曾存在的 `.affect-label` 固定宽度被感知面板继承导致文字截断）