---
alwaysApply: false
description: 后端分层规范（src/ 各模块的职责边界 + 核心库 vs 宿主项目边界）
---

# 后端分层规范

> 源于 [ADR-008](../decisions/ADR-008-directory-structure.md)。核心矛盾：核心库领域无关、宿主领域相关；**核心库提供机制，宿主提供策略**。

## 核心库 vs 宿主项目职责边界

| 职能 | 核心库（`src/`） | 宿主项目（`hosts/`/外部） | 状态 |
| --- | --- | --- | --- |
| LLM 对话 | provider 抽象 + 流式协议 | — | ✅ |
| 记忆（3 层） | 存储 + 索引 + 召回 | — | ✅ |
| 安全 | 路径白名单 + 写入确认 + 权限模型 | — | ✅ |
| 通用文件 I/O | 4 个内置工具 | — | ✅ |
| 工具注册机制 | `tools.registerTool()` + `tools.execute()` | 注册具体领域工具 | ✅ |
| 领域工具实现 | — | handler，委托内置工具 | ✅ |
| 人格/规则/技能 | Manager + 加载机制 | 编写 `.md` 配置 | ✅ |
| UI 界面 | — | 自行实现（CLI/Web/TUI） | ✅ |
| 记忆查询与建议 | `MemoryInspector.snapshot()`（快照）+ `search_memories` 工具（召回）+ `MemoryAdvisor.suggest()`（关联推荐） | 决定呈现方式 | ✅ |

**新功能归属判断**：是否与特定领域耦合？是 → 宿主；否 → 是否所有宿主都需要？是 → 核心库（须经抽象接口）；否 → 暂缓（≥2 处真实复用再落地，ADR-017）。

## 分层职责

| 层 | 职责 | 不该做什么 |
| --- | --- | --- |
| `agent/` | Agent 门面 + AgentLoop + ContextManager + 工具执行 + 内置工具处理器 + 专职 Manager/服务类 + 对话快照 + 作品投影 | 直接调 LLM HTTP（经 provider 接口） |
| `memory/` | 记忆存储、索引、关键词召回（search_memories 纯关键词，语义向量通道已随 2026-09-18 B0 收编） | 调 LLM |
| `skill/` | 技能文件扫描、关键词匹配、prompt 注入 | 直接调 LLM |
| `llm/` | LLM 适配、协议解析、流式处理 | 读写文件 |
| `security/` | 路径白名单、写入确认（fail-closed，未注入即拒绝）、Prompt 注入防御 | 业务逻辑、终端 I/O |
| `config/` | 配置加载、环境变量展开 | 业务逻辑 |
| `logging/` | 日志输出 | 业务逻辑 |
| `role-pack/` | 角色包类型 + 行为策略基元（纯类型/工具，不参与运行时 Loop） | 运行时调用、依赖 LLM/存储 |
| `web-search/` | 搜索抽象（IWebSearchProvider）+ 默认实现（零依赖），经 AgentOptions 条件注入 | 业务逻辑、领域耦合 |

**禁止**：❌ 核心库出现领域特有逻辑；❌ 宿主绕过 `registerTool()` 改 `ToolExecutor` 内部；❌ 核心库依赖宿主代码/配置；❌ 核心库硬编码工具列表。

## 宿主状态声明

**当前唯一活跃宿主 = VSCode 插件（`hosts/memora-vscode`）；`hosts/memora-sprite` 已搁置。**

- 新功能/UI/API 调整优先在 VSCode 宿主实现；内核改动致 sprite 代码失效则直接清理，不维护兼容。
- 新机制仍须通用（核心库领域无关），但实现验证仅需确保 VSCode 宿主可用。

## 依赖方向

```
agent/ → llm/（Provider）、memory/（存储+召回+supersededBy）、role-pack/（RolePackManager）、skill/（SkillManager）、security/（路径校验）
memory/ → utils/（frontmatter+segmenter）、security/（type-only）
skill/ → utils/（frontmatter+segmenter+scanner）；不依赖 memory/（纯文件+内存缓存）
role-pack/ → utils/（纯数据）
web-search/ → utils/（errors.ts）；被 agent/ 经 AgentOptions 条件注入
config/ · logging/ · utils/ → 被所有层依赖
```

**禁止**：❌ `llm/` 反向依赖 `agent/`；❌ `memory/` 依赖 `skill/`/`role-pack/`（不可逆）；❌ `security/` 被宿主绕过（所有写操作必须经校验）。

## 存储层同步性约束（ADR-002）

- `IMemoryStorage` 全部**同步**（与 better-sqlite3 对齐）；Node.js 专用内核，不支持浏览器直跑；浏览器经宿主 Web 通道 HTTP 路由。
- 不支持异步存储后端；需 IndexedDB 等异步后端须先启动 `IAsyncMemoryStorage` 预研。

## 模块内结构约定（快照，非冻结契约）

- 各模块 = `index.ts` + `types.ts` + `core.ts`/`helpers.ts`；`agent/` 含 `agent.ts`/`assembler.ts`/`loop.ts`/`contextPreparer.ts` + `managers/`（专职 Manager，清单以源码为准）+ `seed/`（最小闭环唯一编排真理源，`seed/orchestrator.ts` 聚合 prepare/act/reflect；handoff 已于 2026-09-05 废弃，见 `orchestrator.ts` SeedOrchestrator 类注释「不再对外产出 handoff chunk」）。（原 `checkpointRestoreCoordinator.ts` 已随跨重启恢复链于 2026-09-10 剪枝删除。）
- **具体文件清单以 `src/` 源码为真理源，不在此冻结**。

新增模块流程见 [new-module-guide.md](./new-module-guide.md)。