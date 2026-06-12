---
alwaysApply: false
description: 安全规范（最小权限、显式允许、审计可追溯）
version: v0.1
date: 2026-06-02
---

# 安全规范

> 详见 [ADR-006 · 安全模型](./decisions/ADR-006-security-model.md)

## 1. 三条底层原则

| 原则           | 含义                 | 落地手段                     |
| -------------- | -------------------- | ---------------------------- |
| **最小权限**   | 默认拒绝所有敏感操作 | 所有工具调用、文件访问需授权 |
| **显式允许**   | 白名单机制           | 工具白名单、路径白名单       |
| **审计可追溯** | 写操作可回溯         | 写入日志 + 用户主动记录      |

## 2. 路径白名单

**4 类允许**：

- ✅ 项目目录（`process.cwd()`）
- ✅ 数据目录（`~/.memora/`）
- ✅ 用户显式白名单（`config.allowedPaths`）
- ✅ stdout/stderr（不需要路径）

**6 类禁止**（黑名单优先）：

- ❌ `~/.ssh/`
- ❌ `~/.aws/`
- ❌ `.env` 文件
- ❌ `C:\Windows\System32\`
- ❌ `/etc/passwd`
- ❌ `~/.gnupg/`

详见 [src/security/path-guard.ts](../../src/security/path-guard.ts)

## 3. API Key 存储

**绝对禁止**：

- ❌ 把 API Key 硬编码在代码中
- ❌ 把 API Key 提交到 Git
- ❌ 把 API Key 写到日志

**正确做法**：

- ✅ 用环境变量 `MEMORA_LLM_API_KEY`
- ✅ 配置文件中用占位符 `"apiKey": "${MEMORA_LLM_API_KEY}"`
- ✅ `.gitignore` 必须包含 `.env` / `*.key`

## 4. 工具调用校验

每个工具调用必须经过：

1. **存在性**：工具是否在白名单中
2. **参数 schema**：参数是否符合 JSON Schema
3. **路径校验**：参数中的路径是否在白名单内（路径类工具）

## 5. 写入二次确认

- `owner` 模式：默认不确认（开发效率优先）
- `guest` 模式：强制确认
- 配置文件可显式开启 `security.confirmWrites: true`

## 6. Prompt 注入防御（阶段三）

- 所有用户/外部输入用 `<user_input>` 等标签包裹
- 检测常见注入模式（"忽略以上指令"等）
- 工具结果必须 schema 校验
