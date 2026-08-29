---
alwaysApply: false
description: Memora 关键决策年轮
---

# ADR 索引 · Memora 关键决策年轮

> **创建日期**：2026-06-02 **播种批次**：模式 A v1 **范围**：内核 + 插件宿主（memora-vscode）

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
| [ADR-010](./ADR-010-agent-facade.md)        | Agent 门面类（宿主项目接入入口）                          | ✅ 已接受 | 架构   |
| [ADR-011](./ADR-011-multi-project.md)       | 多项目并发（ProjectManager + 锁文件）                     | ✅ 已接受 | 架构   |
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
| [ADR-024](./ADR-024-session-title-layer.md) | 会话标题层：身份与展示标题解耦，首轮闭环自动命名 + 手动改名透传 | ✅ 已接受 | 架构 |
| [ADR-025](./ADR-025-memory-role-pack-boundary.md) | 记忆系统 × 角色包边界收敛：设定记忆归角色包，记忆库 = 摘要记忆本体 | ✅ 已接受 | 架构 |
| [ADR-026](./ADR-026-auto-switch-host-assembly.md) | 角色自动匹配开关归宿主装配层（autoSwitch 宿主级键 + strategyOverride 通用覆盖通道） | 🔄 替代（2026-08-29） | 架构 |
| [ADR-027](./ADR-027-process-event-log.md) | 过程事件日志 + 重放重建（Round.processEvents 单文件内聚 + 展示层 process_event 单形态 + currentRoundMeta 身份单源） | ✅ 已接受 | 架构 |
| [ADR-028](./ADR-028-role-pack-manual-switch-teams-meeting.md) | 角色包体系：手动切换 + 组（组长+组员）+ 小组会议（任务表应用，内核零会议代码） | ✅ 已接受 | 架构 |

### 插件宿主（VC 系列）

| ID                                                  | 标题                                              | 状态      | 类别   |
| --------------------------------------------------- | ------------------------------------------------- | --------- | ------ |
| [ADR-VC-001](./ADR-VC-001-vscode-plugin-host.md)   | VS Code 插件作为 memora 内核宿主 | ✅ 已接受 | 形态   |

> **跳号说明**：ADR-005（内核）序号保留未使用（初始设计被 ADR-004 合并）；ADR-017-web-search 为 ADR-017 的同号子模块决策（Web 搜索能力，2026-07-30 回溯补录）；ADR-VC 系列为插件宿主（VS Code）专用前缀，与内核序号互不占用。
>
> **深度剪枝（2026-08-19）**：删除 ADR-009（专注模式，零消费）与 ADR-012（领域切换，已废弃）。序号保持空缺不重用——编号是历史的稳定标识，废弃即让位，避免序号错乱。
>
> **精灵宿主独立（2026-08-21）**：ADR-SP 系列（精灵宿主决策，SP-001~008/015~018）随精灵独立仓库开发，已从本仓库 decisions 移除并归档至精灵仓库。本仓库决策年轮仅保留内核 + 插件宿主（memora-vscode，第一宿主）。

---

## 类别分布

| 类别   | 数量 | ADR 列表             |
| ------ | ---- | -------------------- |
| 运行时 | 1    | ADR-001 |
| 数据层 | 2    | ADR-002, ADR-016 |
| 集成层 | 2    | ADR-003, ADR-017-web-search |
| 架构   | 14   | ADR-004, ADR-010~015, ADR-021~028 |
| 安全   | 1    | ADR-006 |
| 质量   | 1    | ADR-007 |
| 工程   | 3    | ADR-008, ADR-017, ADR-020 |
| 前端   | 2    | ADR-018, ADR-019 |
| 形态   | 1    | ADR-VC-001 |

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
