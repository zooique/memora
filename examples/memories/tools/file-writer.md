---
id: tool:file-writer
type: tool
permanence: on-demand
tags: 工具, 文件, 写入
weight: 0.5
createdAt: 2026-06-02T00:00:00.000Z
updatedAt: 2026-06-02T00:00:00.000Z
---

# 工具：file-writer（M-204 新增）

**用途**：在路径白名单内安全写入或创建文件。owner 模式可配置二次确认。

## 参数

| 字段      | 类型   | 必填 | 说明                 |
| --------- | ------ | ---- | -------------------- |
| `path`    | string | ✅   | 相对项目根的文件路径 |
| `content` | string | ✅   | 要写入的完整文件内容 |

## 返回

字符串：`✅ 已写入：<绝对路径>（<N> 字符）`

## 安全约束

- 不在白名单 → 抛 `toolError("路径不在白名单内", ...)`
- 命中黑名单（.ssh / .env / credentials 等）→ 抛 `toolError`
- guest 模式：强制 y/N 确认
- owner + `confirmWrites=true`：y/N 确认
- owner + `confirmWrites=false`：自动批准
- 自动创建父目录（`mkdir recursive`），但父目录必须在白名单内

## 典型用法

写入新文件：调用
`write_file({ path: 'src/utils.ts', content: '...' })`。覆盖已有文件：再次调用同一路径，content 完全替换。
