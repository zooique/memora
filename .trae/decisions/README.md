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
| [ADR-015](./ADR-015-archive-mode.md)        | Agent 归档模式二态控制（full / manual，insights-only 已随洞察层移除收敛，GAP-2 已落地 2026-07-03）   | ✅ 已接受 | 架构   |
| [ADR-016](./ADR-016-vector-store-interface.md) | 向量存储接口化（IVectorStore + JsonVectorStore）       | ❌ 已废弃（2026-09-18 B0 收编，序号不再复用） | 数据层 |
| [ADR-017](./ADR-017-natural-growth-redefinition.md) | 自然生长原则重新定义：分层适用（架构先行 + 枝叶 2 次提取） | ✅ 已接受 | 工程 |
| [ADR-017-web-search](./ADR-017-web-search-module.md) | Web 搜索模块（IWebSearchProvider 接口 + FetchWebSearchProvider，条件暴露给 LLM） | ✅ 已接受 | 集成层 |
| [ADR-018](./ADR-018-css-scoping-convention.md) | CSS 作用域规范：面板前缀 + BEM + 单一真理源（消除 BARE 类跨面板污染） | ✅ 已接受 | 前端 |
| [ADR-021](./ADR-021-memory-conflict-supersede-write-path.md) | 记忆冲突消解（写路径取代检测）与闭环透明契约 | ✅ 已接受 | 架构 |
| [ADR-022](./ADR-022-context-trust-boundary-and-agent-evals.md) | 上下文信任边界与 Agent 行为评估视角 | ✅ 已接受 | 架构 |
| [ADR-023](./ADR-023-context-cost-injection-defense-loop-convergence.md) | 上下文成本重构、即时注入防御与最小闭环收敛 | ✅ 已接受 | 架构 |
| [ADR-024](./ADR-024-session-title-layer.md) | 会话标题层：身份与展示标题解耦，首轮闭环自动命名 + 手动改名透传 | ✅ 已接受 | 架构 |
| [ADR-025](./ADR-025-memory-role-pack-boundary.md) | 记忆系统 × 角色包边界收敛：设定记忆归角色包，记忆库 = round-summary 摘要单轨，会话级摘要归 SessionMeta | ✅ 已接受 | 架构 |
| [ADR-027](./ADR-027-process-event-log.md) | 过程事件日志 + 重放重建（Round.processEvents 单文件内聚 + 展示层 process_event 单形态 + currentRoundMeta 身份单源） | ✅ 已接受 | 架构 |
| [ADR-028](./ADR-028-role-pack-manual-switch-teams-meeting.md) | 角色包体系：手动切换 + 组（组长+组员）+ 小组会议（任务表应用，内核零会议代码） | ✅ 已接受 | 架构 |
| [ADR-029](./ADR-029-context-window-resolution-host-injection.md) | 上下文窗口解析归宿主注入（内核只消费不解析，resolveContextWindow 单一公式，角色包不声明绝对 token 配额） | ✅ 已接受 | 架构 |
| [ADR-030](./ADR-030-context-occupancy-input-indicator.md) | 输入区上下文占用指示器（内核算、宿主传、webview 渲，输入区常驻比例条 + hover 明细） | ✅ 已接受 | 架构 |
| [ADR-031](./ADR-031-tool-read-ledger-account-vs-occupancy.md) | 工具读取台账：账本与占用解耦（判据只记「发生过」，结构化台账 + 拦截三分支 + 压缩摘要替代 + 失败硬闸，CTX-1b 定案） | ✅ 已接受 | 架构 |
| [ADR-032](./ADR-032-gate-ownership-loop.md) | 门禁所有权闭环（本地钩子接管闸门：分层 fast/full + 步骤单一定义 + 收据；补 `host:build` 与 `verify:dist-contract`，**不承诺强制**） | ✅ 已接受 | 工程 |

### 插件宿主（VC 系列）

| ID                                                  | 标题                                              | 状态      | 类别   |
| --------------------------------------------------- | ------------------------------------------------- | --------- | ------ |
| [ADR-VC-001](./ADR-VC-001-vscode-plugin-host.md)   | VS Code 插件作为 memora 内核宿主 | ✅ 已接受 | 形态   |

> **跳号说明**：ADR-005（内核）序号保留未使用（初始设计被 ADR-004 合并）；ADR-009/012/013/014/019/020/026 已删除（零消费或已废弃/替代，git 历史可溯）；ADR-017-web-search 为**历史补录遗留**（2026-07-30 回溯补录时误用 017 子号命名——017 序号唯一对应 [natural-growth-redefinition](./ADR-017-natural-growth-redefinition.md)，web-search 序号保持现状不重编，序号是历史稳定标识，**不再新增子号**）；ADR-VC 系列为插件宿主（VS Code）专用前缀，与内核序号互不占用。
>
> **深度剪枝（2026-08-19）**：删除 ADR-009（专注模式，零消费）与 ADR-012（领域切换，已废弃）。序号保持空缺不重用——编号是历史的稳定标识，废弃即让位，避免序号错乱。
>
> **精灵宿主独立（2026-08-21）**：ADR-SP 系列（精灵宿主决策，SP-001~008/015~018）随精灵独立仓库开发，已从本仓库 decisions 移除并归档至精灵仓库。本仓库决策年轮仅保留内核 + 插件宿主（memora-vscode，第一宿主）。
>
> **年轮修剪（2026-09-04）**：删除 ADR-013（零外部引用，实现代码已移除）、ADR-014（已废弃，被 ADR-021 写取代检测取代）、ADR-019（精灵宿主 CSS 分组，精灵移出）、ADR-020（精灵宿主错误体系，精灵移出）、ADR-026（已被 ADR-028 替代）。ADR-018 保留更新（CSS 三层模型被 vscode 宿主继承消费），去精灵宿主死链并加宿主迁移注记。

---

## 类别分布

| 类别   | 数量 | ADR 列表             |
| ------ | ---- | -------------------- |
| 运行时 | 1    | ADR-001 |
| 数据层 | 2    | ADR-002, ADR-016 |
| 集成层 | 2    | ADR-003, ADR-017-web-search |
| 架构   | 14   | ADR-004, ADR-010~011, ADR-015, ADR-021~025, ADR-027~031 |
| 安全   | 1    | ADR-006 |
| 质量   | 1    | ADR-007 |
| 工程   | 3    | ADR-008, ADR-017, ADR-032 |
| 前端   | 1    | ADR-018 |
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
