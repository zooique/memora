---
id: tool:file-reader
type: tool
permanence: on-demand
tags: 工具, 文件
weight: 0.5
createdAt: 2026-06-02T00:00:00.000Z
updatedAt: 2026-06-02T00:00:00.000Z
---

# 工具：file-reader

**用途**：在路径白名单内安全读取文本文件。

## 参数

| 字段       | 类型   | 必填 | 说明                                   |
| ---------- | ------ | ---- | -------------------------------------- |
| `path`     | string | ✅   | 绝对路径，必须在 `config.allowedPaths` |
| `encoding` | string | ❌   | 默认 `utf-8`                           |
| `maxBytes` | number | ❌   | 默认 1MB，防止 OOM                     |

## 返回

```ts
{
  content: string;
  bytes: number;
  mtime: string;
}
```

## 安全约束

- 不在白名单 → 抛 `securityError("路径越界", ...)`
- 文件 > maxBytes → 抛 `toolError("文件过大", ...)`
- 任何 IO 错误 → 包装为 `toolError` 并 `logger.error` 留痕
