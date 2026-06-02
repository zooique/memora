---
alwaysApply: false
description: 后端分层规范（src/ 各模块的职责边界）
version: v0.1
date: 2026-06-02
---

# 后端分层规范

> 详见
> [ADR-008 · 目录结构按"职责分层"](./decisions/ADR-008-directory-structure.md)

## 分层职责

| 层          | 职责                              | 不该做什么      |
| ----------- | --------------------------------- | --------------- |
| `cli/`      | 解析命令、REPL 循环、用户交互     | 直接调数据库    |
| `agent/`    | Agent Loop、消息历史、工具执行    | 直接调 LLM HTTP |
| `memory/`   | 记忆存储、索引、召回、组装        | 调 LLM          |
| `llm/`      | LLM 适配、协议解析、流式处理      | 读写文件        |
| `security/` | 权限、路径白名单、Prompt 注入防御 | 业务逻辑        |
| `config/`   | 配置加载、环境变量展开            | 业务逻辑        |
| `logging/`  | 日志输出                          | 业务逻辑        |

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
