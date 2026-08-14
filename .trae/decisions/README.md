---
alwaysApply: false
description: Memora 关键决策年轮
---

# ADR 索引 · Memora 关键决策年轮

> **创建日期**：2026-06-02 **播种批次**：模式 A v1 **总决策数**：36（内核 23 + 精灵 12 + 插件 1）

---

## 索引

| ID                                          | 标题                                                      | 状态      | 类别   |
| ------------------------------------------- | --------------------------------------------------------- | --------- | ------ |
| [ADR-001](./ADR-001-runtime-stack.md)       | 选用 Node.js 22 LTS + TypeScript 5 + ESM 作为运行时栈     | ✅ 已接受 | 运行时 |
| [ADR-002](./ADR-002-storage-layer.md)       | 存储层抽象：IMemoryStorage 接口 + 可插拔实现 | ✅ 已接受 | 数据层 |
| [ADR-003](./ADR-003-llm-adapter.md)         | LLM 适配层使用 OpenAI Chat Completions 兼容协议           | ✅ 已接受 | 集成层 |
| [ADR-004](./ADR-004-memory-unification.md)  | 记忆统一为"source 开放字符串"基元驱动模型                  | ✅ 已接受 | 架构   |
| ADR-005                                      | （序号保留，未使用）                                      | —        | —      |
| [ADR-006](./ADR-006-security-model.md)      | 安全采用两级权限 + 工具白名单 + 路径白名单                | ✅ 已接受 | 安全   |
| [ADR-007](./ADR-007-testing-strategy.md)    | 测试使用 Vitest + MSW（Mock LLM）                         | ✅ 已接受 | 质量   |
| [ADR-008](./ADR-008-directory-structure.md) | 目录结构按"职责分层"而非"按类型分层"                      | ✅ 已接受 | 工程   |
| [ADR-009](./ADR-009-focus-mode.md)          | 专注模式与记忆衰减                                        | ✅ 已接受 | 架构   |
| [ADR-010](./ADR-010-agent-facade.md)        | Agent 门面类（宿主项目接入入口）                          | ✅ 已接受 | 架构   |
| [ADR-011](./ADR-011-multi-project.md)       | 多项目并发（ProjectManager + 锁文件）                     | ✅ 已接受 | 架构   |
| [ADR-012](./ADR-012-domain-switch.md)       | 领域切换（已废弃，由角色自动匹配替代）                    | ❌ 已废弃 | 架构   |
| [ADR-013](./ADR-013-archive-pipeline.md)    | 记忆归档管道（v2.0：单步 LLM 提取 + Jaccard 去重）        | ✅ 已接受 | 架构   |
| [ADR-014](./ADR-014-memory-relation.md)     | 记忆关系图谱（侧车模型，开放字符串关系类型）              | ❌ 已废弃（2026-08-14） | 架构   |
| [ADR-015](./ADR-015-archive-mode.md)        | Agent 归档模式三态控制（full / insights-only / manual，GAP-2 已落地 2026-07-03）   | ✅ 已接受 | 架构   |
| [ADR-016](./ADR-016-vector-store-interface.md) | 向量存储接口化（IVectorStore + JsonVectorStore）       | ✅ 已接受 | 数据层 |
| [ADR-017](./ADR-017-natural-growth-redefinition.md) | 自然生长原则重新定义：分层适用（架构先行 + 枝叶 2 次提取） | ✅ 已接受 | 工程 |
| [ADR-017-web-search](./ADR-017-web-search-module.md) | Web 搜索模块（IWebSearchProvider 接口 + FetchWebSearchProvider，条件暴露给 LLM） | ✅ 已接受 | 集成层 |
| [ADR-018](./ADR-018-css-scoping-convention.md) | CSS 作用域规范：面板前缀 + BEM + 单一真理源（消除 BARE 类跨面板污染） | ✅ 已接受 | 前端 |
| [ADR-019](./ADR-019-css-functional-grouping.md) | CSS-R6 功能域分组重构：8 子目录 + 浮窗统一迁入 windows/ + 聚合器相对路径 | ✅ 已接受 | 前端 |
| [ADR-020](./ADR-020-error-handling-strategy.md) | 错误处理策略统一：按层 + 按边界分类（内核降级 / IPC 契约 / 主进程 throw / 渲染进程 reportError） | ✅ 已接受 | 工程 |
| [ADR-021](./ADR-021-memory-conflict-supersede-write-path.md) | 记忆冲突消解（写路径取代检测）与闭环透明契约 | ✅ 已接受 | 架构 |
| [ADR-022](./ADR-022-context-trust-boundary-and-agent-evals.md) | 上下文信任边界与 Agent 行为评估视角 | ✅ 已接受 | 架构 |
| [ADR-023](./ADR-023-context-cost-injection-defense-loop-convergence.md) | 上下文成本重构、即时注入防御与最小闭环收敛 | ✅ 已接受 | 架构 |

### 精灵宿主（SP 系列）

| ID                                                  | 标题                                              | 状态      | 类别   |
| --------------------------------------------------- | ------------------------------------------------- | --------- | ------ |
| [ADR-SP-001](./ADR-SP-001-runtime.md)              | 运行时栈：Node.js 24 LTS + TS5 + ESM              | ✅ 已接受 | 运行时 |
| [ADR-SP-002](./ADR-SP-002-storage.md)              | 存储层：better-sqlite3 + 同库会话                  | ✅ 已接受 | 数据层 |
| [ADR-SP-003](./ADR-SP-003-desktop-shell.md)        | 桌面壳：阶段一 CLI → 阶段二 Electron              | ✅ 已接受 | 形态   |
| [ADR-SP-004](./ADR-SP-004-perception.md)           | 感知原则：上下文感知而非内容感知                   | ✅ 已接受 | 安全   |
| [ADR-SP-005](./ADR-SP-005-package-management.md)   | 包管理：npm + file: 协议                           | ✅ 已接受 | 工程   |
| [ADR-SP-006](./ADR-SP-006-testing.md)              | 测试：Vitest + InMemoryStorage + 临时 SQLite       | ✅ 已接受 | 质量   |
| [ADR-SP-007](./ADR-SP-007-directory-structure.md)  | 目录结构：hosts/memora-sprite/ 按职责分层          | ✅ 已接受 | 工程   |
| [ADR-SP-008](./ADR-SP-008-v8-ui-refactor.md)       | v8 UI 重构：双主题 CSS 变量 + 悬浮核心窗口         | ✅ 已接受 | 前端   |
| [ADR-SP-015](./ADR-SP-015-panel-manager-composition.md) | PanelManager 组合模式约定（阶段 C 架构演进沉淀） | ✅ 已接受 | 架构   |
| [ADR-SP-016](./ADR-SP-016-ui-mixin-pattern.md) | UIManager Mixin 拆分模式（applyMixins + uiDelegations/ 委托群） | ✅ 已接受 | 架构 |
| [ADR-SP-017](./ADR-SP-017-quick-input-architecture.md) | 快速输入浮窗架构：窗口管理器内联 IPC + Controller/Completion 双类解耦 + LLM 回调注入 | ✅ 已接受 | 架构 |
| [ADR-SP-018](./ADR-SP-018-cross-process-encoding.md) | 跨进程非 ASCII 数据传递：文件 I/O + 原始数据提取（绕过 nut-js 编码 bug + stdout 管道污染 + 竞态条件） | ✅ 已接受 | 工程 |

### 插件宿主（VC 系列）

| ID                                                  | 标题                                              | 状态      | 类别   |
| --------------------------------------------------- | ------------------------------------------------- | --------- | ------ |
| [ADR-VC-001](./ADR-VC-001-vscode-plugin-host.md)   | VS Code 插件作为 memora 内核宿主（第二宿主，比 sprite 更薄） | ✅ 已接受 | 形态   |

> **跳号说明**：ADR-005（内核）和 ADR-SP-009~014（精灵）序号保留未使用——内核 005 跳号因初始设计被 ADR-004 合并；精灵 SP-009~014 跳号因精灵 ADR 编号策略与内核 SP 序号对齐，预留 SP-009~014 给未来与内核 SP 序号对齐的扩展。当前精灵 ADR 直接从 SP-008 跳到 SP-015。ADR-017-web-search 为 ADR-017 的同号子模块决策（Web 搜索能力，2026-07-30 回溯补录）；ADR-VC 系列为插件宿主（VS Code）专用前缀，与内核 / 精灵序号互不占用。

---

## 类别分布

| 类别   | 数量 | ADR 列表             |
| ------ | ---- | -------------------- |
| 运行时 | 2    | ADR-001, ADR-SP-001  |
| 数据层 | 3    | ADR-002, ADR-016, ADR-SP-002 |
| 集成层 | 2    | ADR-003, ADR-017-web-search |
| 架构   | 14   | ADR-004, ADR-009~015, ADR-021~023, ADR-SP-015, ADR-SP-016, ADR-SP-017 |
| 安全   | 2    | ADR-006, ADR-SP-004 |
| 质量   | 2    | ADR-007, ADR-SP-006 |
| 工程   | 6    | ADR-008, ADR-017, ADR-020, ADR-SP-005, ADR-SP-007, ADR-SP-018 |
| 前端   | 3    | ADR-018, ADR-019, ADR-SP-008 |
| 形态   | 2    | ADR-SP-003, ADR-VC-001 |

---

## ADR 模板

```markdown
# ADR-{NNN} · {标题}

> **状态**：✅ 已接受 / 🚧 草案 / ❌ 已废弃 / 🔄 替代 {被替代的 ADR}
> **日期**：YYYY-MM-DD **播种批次**：{批次名} **来源**：{项目决策表 §X
> / 设计文档 §X}

## 背景

{问题描述}

## 决策

{选择内容}

## 理由

{为什么这么选}

## 替代方案

| 方案    | 放弃原因 |
| ------- | -------- |
| {方案1} | {原因1}  |
| {方案2} | {原因2}  |

## 影响

{对项目其他部分的影响}

## 何时回顾

{什么情况下需要重新评估}
```

---

## 追溯链

```
(历史设计文档已归档：创意设计单页纸.md → 核心矛盾 + 主要任务)
  ↓
(历史设计文档已归档：土壤分析报告.md → 环境 + 约束)
  ↓
(历史设计文档已归档：项目决策表.md → 具体技术选型)
  ↓
.trae/decisions/          →  关键决策的不可逆约束（ADR）
  ↓
.trae/rules/              →  编码规范与架构约束
  ↓
src/                      →  代码实现
```

**任何代码改动违反 ADR 时，必须先更新 ADR 状态（改为 🚧 草案 → 重新评估）**。
