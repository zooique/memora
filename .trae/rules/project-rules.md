---
alwaysApply: true
description: Memora 项目总则、技术栈清单、目录结构
version: v0.1
date: 2026-06-02
---

# Memora · 项目总则

> **设计哲学**：万物皆是记忆 **核心矛盾**：无状态推理 ←→ 连续演化任务
> **基调**：专注模式（应无所住，而生其心）——支持切换，默认专注详见
> [architecture_philosophy_rules.md §9](./architecture_philosophy_rules.md)
> **决策追溯**：`.trae/rules/decisions/` 下 8 个 ADR

## 1. 不可违反的硬约束

1. **设计文档优先**：所有架构决策必须与
   [01-主架构-v4.0.md](../../docs/基础设计文档/01-主架构-v4.0.md) /
   [02-上下文组装-v4.0.md](../../docs/基础设计文档/02-上下文组装-v4.0.md) /
   [03-安全权限-v0.2.md](../../docs/基础设计文档/安全权限设计%20v0.2.md) /
   [04-测试策略-v0.2.md](../../docs/基础设计文档/04-测试策略-v0.2.md) /
   [00-记忆归档原则-v1.0.md](../../docs/基础设计文档/00-记忆归档原则-v1.0.md)
   一致
2. **ADR 优先于个人偏好**：技术栈变更必须先更新 ADR（`.trae/rules/decisions/`）
3. **跨文档引用规范**：详见
   [cross-document-reference.md](./cross-document-reference.md)——使用"文档.§章节号"格式
4. **记忆统一模型**：不引入"规则/技能/历史"等独立子系统；统一用
   `memory_type + permanence` 区分

## 2. 技术栈清单

| 类别   | 选型                                         | 决策                                                  |
| ------ | -------------------------------------------- | ----------------------------------------------------- |
| 运行时 | Node.js ≥ 20 LTS + TypeScript 5 strict + ESM | [ADR-001](./decisions/ADR-001-runtime-stack.md)       |
| 数据层 | better-sqlite3 + sqlite-vec                  | [ADR-002](./decisions/ADR-002-storage-layer.md)       |
| LLM    | OpenAI Chat Completions 兼容协议             | [ADR-003](./decisions/ADR-003-llm-adapter.md)         |
| 形态   | CLI 优先（阶段一）                           | [ADR-005](./decisions/ADR-005-cli-first.md)           |
| 安全   | 两级权限 + 路径白名单                        | [ADR-006](./decisions/ADR-006-security-model.md)      |
| 测试   | Vitest + MSW Mock LLM                        | [ADR-007](./decisions/ADR-007-testing-strategy.md)    |
| 目录   | 按职责分层                                   | [ADR-008](./decisions/ADR-008-directory-structure.md) |

## 3. 目录结构（不允许修改）

```
src/
├── index.ts        # CLI 入口（不改）
├── cli/            # CLI 解析与交互
├── agent/          # Agent Loop + 工具执行 + 对话快照 + 作品投影
├── memory/         # 记忆引擎（5 类统一）
├── persona/        # 人格管理（角色配置，记忆管道最高优先级）
├── skill/          # 技能管理（两层目录，记忆管道最高优先级）
├── llm/            # LLM 适配层
├── security/       # 安全策略
├── config/         # 配置加载
├── logging/        # 日志
└── utils/          # 工具函数
```

## 4. 命名规范（与 .trae/rules/ 一致）

| 类型      | 规则                                 |
| --------- | ------------------------------------ |
| 文件夹    | 连字符（`cli-commands/`）            |
| TS 文件   | 小驼峰（`openai-compatible.ts`）     |
| 类        | 大驼峰（`OpenAICompatibleProvider`） |
| 变量/函数 | 小驼峰（`loadConfig`）               |
| 常量      | 全大写下划线（`BLOCKED_PATTERNS`）   |
| 类型/接口 | 大驼峰（`Memory`、`ChatOptions`）    |

## 5. Git 提交规范

```
feat: 新增记忆召回管线
fix: 修复路径白名单越界
docs: 更新 01-主架构-v4.0.md v3.6
test: 补充 Agent Loop E2E
refactor: 重构 LLM Provider 抽象
chore: 升级 dependencies
```

格式：`<type>(<scope>): <subject>`

## 6. 阶段一交付物

- ✅ 项目骨架可编译、可运行
- ✅ 5 种记忆类型 schema 校验通过
- ✅ SQLite 索引 CRUD 单元测试通过
- ✅ 路径白名单 6 个测试用例通过
- ✅ LLM Provider Mock 集成测试通过
- ⏳ CLI 启动后能对话（需真实 LLM API Key）
