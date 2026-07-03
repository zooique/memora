---
alwaysApply: false
description: 后端分层规范（src/ 各模块的职责边界 + 核心库 vs 宿主项目边界）
version: v0.8
date: 2026-07-03
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
| 记忆关系图谱   | ✅ 提供 IMemoryRelationStore 侧车接口 + InMemoryRelationStore 测试实现 | ✅ 实现 SqliteRelationStore + 关系构建逻辑 | ✅ 已有 |
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
         └─ 否 → 暂不实现，等 3 次以上重复需求再提取
                 例：WebUI 框架、特定 LLM 厂商优化
```

**禁止**：

- ❌ 核心库 `src/` 中出现领域特有逻辑（如"章节"、"角色"、"代码审查"）
- ❌ 宿主项目绕过 `registerTool()` 直接修改 `ToolExecutor` 内部
- ❌ 核心库依赖宿主项目的任何代码或配置
- ❌ 在核心库中硬编码工具列表（工具定义由 `BUILTIN_TOOLS` + `registerTool()`
  动态组合）

## 分层职责

| 层          | 职责                                               | 不该做什么                                      |
| ----------- | -------------------------------------------------- | ----------------------------------------------- |
| `cli/`（宿主） | 解析命令、REPL 循环、用户交互                      | 直接调数据库                                    |
| `agent/`    | Agent 门面 + AgentLoop + 上下文窗口管理（ContextManager）+ 工具执行 + 内置工具处理器（BuiltinToolHandlers）+ 专职 Manager（Insight/Config/MemoryInspector/AutoConfigRefiner/MemoryAdvisor/Session/SessionArchiver/WorkProjection/UserFactExtractor）+ 对话快照 + 作品投影 + 用户事实提取 | 直接调 LLM HTTP（通过 provider 接口）           |
| `memory/`   | 记忆存储、索引、召回（语义 + 关键词双通道，向量搜索可选）+ 关系图谱侧车（IMemoryRelationStore 接口，独立于 IMemoryStorage） | 调 LLM（通过 EmbeddingService 接口注入除外）    |
| `persona/`  | 角色管理、关键词匹配、system prompt 组装、写入 SQLite 索引 | 直接调 LLM                                      |
| `skill/`    | 技能文件扫描、关键词匹配、prompt 注入、写入 SQLite 索引 | 直接调 LLM、操作记忆索引                        |
| `llm/`      | LLM 适配、协议解析、流式处理                       | 读写文件                                        |
| `security/` | 路径白名单、写入确认（fail-closed，未注入 handler 时拒绝，HC-03）、Prompt 注入防御 | 业务逻辑、交互式终端 I/O（readline 由宿主注入） |
| `config/`   | 配置加载、环境变量展开                             | 业务逻辑                                        |
| `logging/`  | 日志输出                                           | 业务逻辑                                        |
| `eval/`     | Agent 行为评估场景定义（EvalScenario 类型 + 工具函数，仅测试用，不参与运行时） | 业务逻辑、运行时调用                             |

## 依赖方向

```
agent/      →  llm/         （对话调用 Provider）
            →  memory/      （记忆存储 + 召回 + 关系图谱侧车）
            →  persona/     （角色管理，通过 PersonaManager）
            →  skill/       （技能管理，通过 SkillManager）
            →  security/    （路径校验，跨切）
memory/     →  utils/       （frontmatter 解析 + segmenter 分词）
            →  （relationStore 是侧车，独立于 IMemoryStorage，不反向依赖 agent/）
persona/    →  memory/      （SQLite 写入 + 类型定义）
            →  utils/       （frontmatter 解析 + segmenter 分词）
skill/      →  memory/      （SQLite 写入 + 类型定义）
            →  utils/       （frontmatter 解析 + segmenter 分词 + scanner 扫描）
config/     →  （被所有层调）
logging/    →  （被所有层调）
utils/      →  logging/（errors.ts 使用 logger）, 无其他外部依赖
```

**记忆关系侧车的依赖约束**（ADR-014）：
- `IMemoryRelationStore` 是独立接口，不依赖 `IMemoryStorage`
- `InMemoryRelationStore`（测试用）仅依赖 `MemoryRelation` 类型
- `SqliteRelationStore`（宿主实现）依赖 better-sqlite3，在宿主层
- 关系构建逻辑（调用 LLM 判断关系类型）在宿主层，不在内核

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
├── managers/             # 专职 Manager 子目录
│   ├── configManager.ts      # 配置管理器（规则/技能注入 + 配置建议）
│   ├── autoConfigRefiner.ts  # 智能配置提炼器（模式 3：Agent 智能总结）
│   ├── insightExtractor.ts   # Insight 提取器（输入分类 + 记忆提取）
│   ├── memoryInspector.ts    # 记忆查看器（快照 + 搜索 + 统计 + 关联推荐）
│   ├── memoryAdvisor.ts      # 记忆顾问（记忆质量评估 + 归档价值判断）
│   ├── sessionManager.ts     # 会话管理器（fork/switch/restore）
│   ├── sessionArchiver.ts    # 会话归档器（content 类记忆归档，会话级摘要，区别于 InsightExtractor 的洞察提取）
│   ├── workProjection.ts     # 作品投影管理器
│   └── userFactExtractor.ts  # 用户事实提取器（正则规则，从 userProfile 迁入）
└── __tests__/            # 单元测试

utils/
├── errors.ts             # 错误类型（MemoraError + 工厂函数 + ToolErrorCode 10 种错误码 + re-export toError）
├── toError.ts            # 纯逻辑 toError（零依赖，浏览器/Node 通用）
├── eventEmitter.ts       # 轻量类型事件发射器（AgentEventMap 6 事件）
├── frontmatter.ts        # Frontmatter 解析/序列化（从 memory/ 迁入，供 memory/persona/skill 共享）
├── json.ts               # JSON 安全解析/序列化
├── loggerHolder.ts       # Logger 持有者（utils/ 内部 getLogger，解耦 utils→logging 循环依赖）
├── math.ts               # 数学工具（cosineSimilarity）
├── path.ts               # 路径工具（expandHome、basename）
├── safeTimer.ts          # 安全定时器（safeSetTimeout/safeSetInterval + 跟踪清理）
├── scanner.ts            # Markdown 目录扫描工具（供 persona/skill 共享）
├── segmenter.ts          # 中文分词器（Intl.Segmenter，从 memory/ 迁入，供 memory/persona/skill 共享）
├── strings.ts            # 字符串工具（slugify）
└── time.ts               # 时间工具（nowIso、todayDate）
```

## 新增模块流程

1. 先写需求说明（解决什么矛盾）
2. 更新本文件（在职责表中加一行）
3. 新建 `src/<module>/` 目录
4. 在 `index.ts` 中导出
5. 写单元测试（≥ 80% 覆盖率）
6. 写 ADR（如果引入新的技术决策）
