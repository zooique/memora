---
id: tool:memory-searcher
type: tool
permanence: on-demand
tags: 工具, 记忆, 搜索
weight: 0.6
createdAt: 2026-06-02T00:00:00.000Z
updatedAt: 2026-06-02T00:00:00.000Z
---

# 工具：memory-searcher（M-204 新增）

**用途**：在记忆索引中搜索关键词，让 LLM 主动召回相关上下文。

## 参数

| 字段    | 类型   | 必填 | 默认值  | 说明                                  |
| ------- | ------ | ---- | ------- | ------------------------------------- |
| `query` | string | ✅   | —       | 搜索关键词（中文分词 Intl.Segmenter） |
| `limit` | string | ❌   | `10`    | 返回结果数量上限（最大 50）           |
| `mode`  | string | ❌   | `match` | `match`（任一命中）/ `near`（全部）   |

## 返回

```
搜索 "Memora"（match 模式）找到 2 条：
1. [rule:core-rule] (weight=0.9)
   Memora 万物皆记忆，记忆统一为类型 + 永久性
2. [skill:typescript-skill] (weight=0.7)
   TypeScript strict 模式下禁止 any 隐式转换
```

## 匹配模式

- `match`（默认）：token 任一命中即匹配（OR 语义）
- `near`：所有 token 必须同时出现（AND 语义）
- 空查询（分词后 tokens 为空）：按 weight 降序返回前 N 条

## 安全约束

- 不涉及路径 IO，无需白名单校验
- limit 超过 50 自动降为 50
- 匹配大小写不敏感（LIKE 模式）

## 典型用法

回想核心规则：`search_memories({ query: 'Memora 哲学' })`。精确查找：`search_memories({ query: '类型 永久性', mode: 'near' })`。
