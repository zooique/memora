---
alwaysApply: false
description: 后端分层规范（src/ 各模块的职责边界 + 核心库 vs 宿主项目边界）
version: v0.2
date: 2026-06-04
---

# 后端分层规范

> 详见
> [ADR-008 · 目录结构按"职责分层"](./decisions/ADR-008-directory-structure.md)

## 核心库 vs 宿主项目职责边界

> **核心矛盾**：核心库必须领域无关，宿主项目必须领域相关。
> **边界原则**：核心库提供"机制"，宿主项目提供"策略"。

| 职能           | 核心库（`src/`）                                                        | 宿主项目（`examples/` / 外部）        | 当前状态      |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------- | ------------- |
| LLM 对话       | ✅ 提供 provider 抽象 + 流式协议                                        | —                                     | ✅ 已有       |
| 记忆（4 层）   | ✅ 提供存储 + 索引 + 归档 + 召回                                        | —                                     | ✅ 已有       |
| 安全           | ✅ 提供路径白名单 + 写入确认 + 权限模型                                 | —                                     | ✅ 已有       |
| 通用文件 I/O   | ✅ 提供 4 个内置工具                                                    | —                                     | ✅ 已有       |
| 工具注册机制   | ✅ 提供 `registerTool()` + `executeTool()`                              | ✅ 注册具体领域工具                   | ✅ 已有       |
| 领域工具实现   | —                                                                       | ✅ 实现 handler，委托内置工具         | ✅ 已有       |
| 人格/规则/技能 | ✅ 提供 Manager + 加载机制                                              | ✅ 编写 `.md` 配置文件                | ✅ 已有       |
| UI 界面        | —                                                                       | ✅ 自行实现（CLI / Web / TUI）        | ✅ 已有       |
| Diff 确认写入  | ✅ 提供 Differ + DiffRenderer                                           | ✅ 决定何时展示 diff                  | ✅ 已有       |
| Markdown 渲染  | ✅ 提供 MarkdownRenderer                                                | ✅ 决定是否启用                       | ✅ 已有       |
| 自我进化机制   | ✅ 提供 onConfigSuggestion + confirmConfigSuggestion + inspect() 读端口 | ✅ 决定进化呈现方式（桌宠/徽章/面板） | 🔧 接口已实现 |

**判断标准**：新功能应该放在哪里？

```
该功能是否与特定领域（小说/编程/日程...）耦合？
  ├─ 是 → 宿主项目（examples/ 或外部项目）
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
| `cli/`      | 解析命令、REPL 循环、用户交互                      | 直接调数据库                                    |
| `agent/`    | Agent Loop、消息历史、工具执行、对话快照、作品投影 | 直接调 LLM HTTP（通过 provider 接口）           |
| `memory/`   | 记忆存储、索引、召回、组装                         | 调 LLM（通过 EmbeddingService 接口注入除外）    |
| `persona/`  | 角色管理、关键词匹配、system prompt 组装           | 操作记忆索引（通过 PersonaManager 写入 SQLite） |
| `skill/`    | 技能文件扫描、关键词匹配、prompt 注入              | 操作记忆索引                                    |
| `llm/`      | LLM 适配、协议解析、流式处理                       | 读写文件                                        |
| `security/` | 权限、路径白名单、Prompt 注入防御                  | 业务逻辑                                        |
| `config/`   | 配置加载、环境变量展开                             | 业务逻辑                                        |
| `logging/`  | 日志输出                                           | 业务逻辑                                        |

## 依赖方向

```
cli/        →  agent/  →  llm/         （用户输入路径）
            →  memory/  →  （agent/ 调 memory）
            →  security/                （跨切）
config/     →  （被所有层调）
logging/    →  （被所有层调）
```

**禁止**：

- ❌ `llm/` 反向依赖 `agent/`
- ❌ `memory/` 反向依赖 `cli/`
- ❌ `security/` 被 `cli/` 绕过（所有写操作必须经 security 校验）

## 模块内文件命名

每个模块内部可细分为：

```
agent/
├── loop.ts             # 主循环
├── tool-executor.ts    # 工具执行
├── message-history.ts  # 消息持久化（阶段二）
└── __tests__/          # 单元测试（与 src/ 平级时放 tests/）
```

## 新增模块流程

1. 先写需求说明（解决什么矛盾）
2. 更新本文件（在职责表中加一行）
3. 新建 `src/<module>/` 目录
4. 在 `index.ts` 中导出
5. 写单元测试（≥ 80% 覆盖率）
6. 写 ADR（如果引入新的技术决策）
