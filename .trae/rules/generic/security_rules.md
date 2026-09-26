---
alwaysApply: false
description: 安全规范（最小权限、显式允许、审计可追溯）
---

# 安全规范

> 详见 [ADR-006 · 安全模型](../../decisions/ADR-006-security-model.md)

## 1. 三条底层原则

| 原则 | 含义 | 落地手段 |
| -------------- | -------------------- | ---------------------------- |
| **最小权限** | 默认拒绝所有敏感操作 | 所有工具调用、文件访问需授权 |
| **显式允许** | 白名单机制 | 工具白名单、路径白名单 |
| **审计可追溯** | 写操作可回溯 | 写入日志 + 用户主动记录 |

## 2. 路径白名单

**4 类允许**：

- ✅ 项目目录（`process.cwd()`）
- ✅ 数据目录（内核由宿主经 `SecurityGuard` 构造参数注入，如 `memoraDir` / `agentDataDir` / `configDir`，非环境变量）
- ✅ 用户显式白名单（`config.allowedPaths`）
- ✅ stdout/stderr（不需要路径）

**7 类禁止**（黑名单优先，正则匹配大小写不敏感）：

- ❌ `~/.ssh/` — SSH 密钥
- ❌ `~/.aws/` — AWS 凭证
- ❌ `~/.gnupg/` — GPG 私钥
- ❌ `.env` / `.env.<name>` — 环境变量（不拦截 `.env.example` 等）
- ❌ `*/System32/*` — Windows 系统目录
- ❌ `*/Windows/System*` — Windows 系统目录（比 System32 更宽泛）
- ❌ `/etc/passwd` — Unix 密码文件

详见 [src/security/pathGuard.ts](../../../src/security/pathGuard.ts)

## 3. API Key 存储

**绝对禁止**：

- ❌ 把 API Key 硬编码在代码中
- ❌ 把 API Key 提交到 Git
- ❌ 把 API Key 写到日志

**正确做法**：

- ✅ 用环境变量 `MEMORA_API_KEY`
- ✅ 配置文件中用占位符 `"apiKey": "${MEMORA_API_KEY}"`
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

## 6. Prompt 注入防御

- 所有用户/外部输入用 `<user_input>` 等标签包裹
- 检测常见注入模式（"忽略以上指令"等）
- 工具结果必须 schema 校验

## 7. 渲染进程 CSP 与内联样式约定

> **适用范围（2026-09-19 标注）**：原约束对象 `renderer/index.html` 与 `float.html` 属 memora-sprite 宿主（已独立仓库，不在本仓库）。memora-vscode 为 webview 架构、无本地渲染进程 html。本节作为**通用 Electron 渲染进程 CSP 安全纪律**保留，遇新宿主含渲染进程 html 时适用；审查清单仅对存在 `index.html` 渲染进程的宿主执行。

> 详见 [ADR-006 · 安全模型补充说明（2026-07-02）](../../decisions/ADR-006-security-model.md)

**通用原则（任何含本地渲染进程 html 的宿主）**：

- **CSP 声明**：渲染进程 `index.html` 须声明 CSP `<meta>`，`style-src` 限定 `'self'`（不含 `'unsafe-inline'`）。
- **内联 style 外置**：任何内联 `style=""`（静态 HTML 或动态 `innerHTML` 拼接）一律外置为 CSS 类——进度条宽度、提示布局、图标尺寸、动态颜色等均用 `class` 或 `data-*` + CSS 选择器表达。
- **动态样式注入**：运行时动态样式须经 `data-*` 属性 + CSS 选择器表达，或主进程 `executeJavaScript()` 注入；渲染进程直写内联颜色/尺寸会被 CSP 静默丢弃。
