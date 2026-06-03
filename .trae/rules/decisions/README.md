---
alwaysApply: false
description: Memora 关键决策年轮
---

# ADR 索引 · Memora 关键决策年轮

> **创建日期**：2026-06-02 **播种批次**：模式 A v1 **总决策数**：13

---

## 索引

| ID                                          | 标题                                                      | 状态      | 类别   |
| ------------------------------------------- | --------------------------------------------------------- | --------- | ------ |
| [ADR-001](./ADR-001-runtime-stack.md)       | 选用 Node.js 20 LTS + TypeScript 5 + ESM 作为运行时栈     | ✅ 已接受 | 运行时 |
| [ADR-002](./ADR-002-storage-layer.md)       | 选用 better-sqlite3 + sqlite-vec 作为存储层（统一索引表） | ✅ 已接受 | 数据层 |
| [ADR-003](./ADR-003-llm-adapter.md)         | LLM 适配层使用 OpenAI Chat Completions 兼容协议           | ✅ 已接受 | 集成层 |
| [ADR-004](./ADR-004-memory-unification.md)  | 记忆统一为"类型 + 永久性标记"模型                         | ✅ 已接受 | 架构   |
| [ADR-005](./ADR-005-cli-first.md)           | CLI 优先于 Web 形态（阶段一交付）                         | ✅ 已接受 | 形态   |
| [ADR-006](./ADR-006-security-model.md)      | 安全采用两级权限 + 工具白名单 + 路径白名单                | ✅ 已接受 | 安全   |
| [ADR-007](./ADR-007-testing-strategy.md)    | 测试使用 Vitest + MSW（Mock LLM）                         | ✅ 已接受 | 质量   |
| [ADR-008](./ADR-008-directory-structure.md) | 目录结构按"职责分层"而非"按类型分层"                      | ✅ 已接受 | 工程   |
| [ADR-009](./ADR-009-focus-mode.md)          | 专注模式与记忆衰减                                        | ✅ 已接受 | 架构   |
| [ADR-010](./ADR-010-agent-facade.md)        | Agent 门面类（宿主项目接入入口）                          | ✅ 已接受 | 架构   |
| [ADR-011](./ADR-011-multi-project.md)       | 多项目并发（ProjectManager + 锁文件）                     | ✅ 已接受 | 架构   |
| [ADR-012](./ADR-012-domain-switch.md)       | 领域切换（DomainManager + /domain 命令）                  | ✅ 已接受 | 架构   |
| [ADR-013](./ADR-013-archive-pipeline.md)    | 记忆归档三步价值过滤（judge → distill → converge）        | ✅ 已接受 | 架构   |

---

## 类别分布

| 类别   | 数量 | ADR 列表             |
| ------ | ---- | -------------------- |
| 运行时 | 1    | ADR-001              |
| 数据层 | 1    | ADR-002              |
| 集成层 | 1    | ADR-003              |
| 架构   | 5    | ADR-004, ADR-009~013 |
| 形态   | 1    | ADR-005              |
| 安全   | 1    | ADR-006              |
| 质量   | 1    | ADR-007              |
| 工程   | 1    | ADR-008              |

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
docs/创意设计单页纸.md    →  核心矛盾 + 主要任务
  ↓
docs/土壤分析报告.md       →  环境 + 约束
  ↓
docs/项目决策表.md         →  具体技术选型
  ↓
.trae/rules/decisions/    →  关键决策的不可逆约束（ADR）
  ↓
.trae/rules/              →  编码规范与架构约束
  ↓
src/                      →  代码实现
```

**任何代码改动违反 ADR 时，必须先更新 ADR 状态（改为 🚧 草案 → 重新评估）**。
