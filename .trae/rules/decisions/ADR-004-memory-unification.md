---
alwaysApply: false
description: 记忆统一为"类型 + 永久性标记"模型
---

# ADR-004 · 记忆统一为"类型 + 永久性标记"模型

> **状态**：✅ 已接受 **日期**：2026-06-02 **播种批次**：Memora 模式 A v1
> **来源**：[01-主架构-v4.0.md §3.3-3.4](../../docs/基础设计文档/01-主架构-v4.0.md)

## 背景

主流 Agent 架构把"规则 / 技能 / 人格 / 对话历史"作为独立子系统（如 Claude
Code 的 CLAUDE.md / skills / commands /
hooks）。这种设计导致：每个子系统有自己的存储、检索、加载逻辑，认知负担重；记忆召回管线碎片化。

## 决策

把"规则 / 技能 / 人格 / 对话历史 / 工具定义"统一视为**记忆**，区别仅在两个维度：

| 维度            | 取值                                                            |
| --------------- | --------------------------------------------------------------- |
| **memory_type** | `personality` / `rule` / `skill` / `tool` / `topic` / `archive` |
| **permanence**  | `always` / `domain` / `topic` / `on-demand`                     |

## 理由

- **统一召回管线**：所有记忆走同一套检索逻辑（按关键词 / 向量 / 文件名）
- **永久性分级替代"子系统"**：召回确定性 = 永久性等级，机制一致
- **领域无关**：切换领域 = 注入不同 `permanence: domain` 的记忆，核心代码零改动
- **扩展性好**：新增记忆类型只需在枚举中添加，无须新建子系统

## 反例（传统 Agent 架构的问题）

```
CLAUDE.md       ← 规则系统
.claude/skills  ← 技能系统
.claude/commands← 命令系统
.claude/hooks   ← 钩子系统
对话历史        ← 历史系统
```

→ 5 个独立子系统 → 5 套加载/检索/存储逻辑 → 学习成本高

## Memora 的实现

```
personality.md          ← memory_type: personality, permanence: always
rules/                  ← memory_type: rule, permanence: always|domain
skills/                 ← memory_type: skill, permanence: domain
tools/                  ← memory_type: tool, permanence: domain
topics/2026-06-02.md    ← memory_type: topic, permanence: topic
archive/                ← memory_type: archive, permanence: archive
```

→ 1 套统一管线 → 1 套加载/检索/存储逻辑 → 学习成本低

## 影响

- SQLite 索引表必须有 `memory_type` 字段
- 召回算法按 `permanence` 决定是否必召
- 工具白名单通过 `memory_type: skill` 的 frontmatter `tools:` 字段实现
- 文件命名规范：`<memory_type>-<name>.md`

## 何时回顾

- 当发现某种记忆类型需要完全独立的检索机制（如纯向量的图像记忆）
- 当永久性分级模型无法表达复杂约束
