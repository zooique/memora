---
id: tool:directory-lister
type: tool
permanence: on-demand
tags: 工具, 目录, 列表
weight: 0.5
createdAt: 2026-06-02T00:00:00.000Z
updatedAt: 2026-06-02T00:00:00.000Z
---

# 工具：directory-lister（M-204 新增）

**用途**：列出目录内容，用于让 LLM 了解项目结构。

## 参数

| 字段        | 类型   | 必填 | 默认值  | 说明                                   |
| ----------- | ------ | ---- | ------- | -------------------------------------- |
| `path`      | string | ❌   | `.`     | 相对项目根的目录路径                   |
| `recursive` | string | ❌   | `false` | 是否递归（`"true"` / `"false"`）       |
| `maxDepth`  | string | ❌   | `2`     | 递归最大深度（1-3，超过 3 自动降为 3） |

## 返回

```
目录 <绝对路径> 共有 N 个条目：
  📁 src/
  📄 README.md
  📁 docs/
  📄 package.json
```

## 安全约束

- 不在白名单 → 抛 `toolError`
- 命中黑名单 → 抛 `toolError`
- 自动忽略：`.git` / `node_modules` / `.memora` / `dist` / `coverage` / `.next`
- 递归深度硬上限 3（防止无限展开）
- 不可访问的条目标记为 `❓` 不中断

## 典型用法

查看项目根：调用 `list_dir({})`。查看 src 子目录：调用
`list_dir({ path: 'src' })`。查看 src 全部子目录：调用
`list_dir({ path: 'src', recursive: 'true', maxDepth: '3' })`。
