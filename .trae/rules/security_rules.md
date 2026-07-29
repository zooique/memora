---
alwaysApply: false
description: 安全规范（最小权限、显式允许、审计可追溯）
version: v0.2
date: 2026-07-26
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
- ✅ 数据目录（内核由宿主通过 `MEMORA_DATA_DIR` 环境变量注入 / `~/.memora-sprite/` 精灵宿主）
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

详见 [src/security/pathGuard.ts](../../src/security/pathGuard.ts)

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

## 6. Prompt 注入防御

- 所有用户/外部输入用 `<user_input>` 等标签包裹
- 检测常见注入模式（"忽略以上指令"等）
- 工具结果必须 schema 校验

## 7. 渲染进程 CSP 与内联样式约定

> 详见 [ADR-006 · 安全模型补充说明（2026-07-02）](./decisions/ADR-006-security-model.md)

### 7.1 三条硬约束

| # | 约束 | 违反后果 |
|---|------|---------|
| 1 | 渲染进程 `index.html` 必须声明 CSP `<meta>`，`style-src` 限定为 `'self'`（不含 `'unsafe-inline'`） | 内联 `style=""` 属性全部失效，元素样式回退到默认值 |
| 2 | 渲染进程 HTML 严禁出现任何内联 `style=""` 属性（含静态 HTML 与动态 `innerHTML` 拼接产物） | Web 模式下样式失效、布局错位、进度条满格闪烁 |
| 3 | 主题初始化等运行时动态样式必须由主进程 `webContents.executeJavaScript()` 注入，或通过 `data-*` 属性 + CSS 选择器表达 | 渲染进程直接内联颜色/尺寸会被 CSP 静默丢弃 |

### 7.2 适用范围

| 文件 | CSP 严格度 | 说明 |
|------|-----------|------|
| `renderer/index.html` | **严格**（`style-src 'self'`） | Web/Electron 共用入口，必须 CSP 兼容 |
| `float.html` | 严格（`style-src 'self'`，与 `index.html` 一致） | 悬浮窗内联样式已全部外置为外部 stylesheet，不再保留 `'unsafe-inline'`（见 ADR-006 §7 修正记录） |
| 主进程注入的脚本 | 不受 CSP meta 限制 | 通过 `executeJavaScript` 注入视为可信源 |

### 7.3 替代模式

| 场景 | ❌ 禁止 | ✅ 正确 |
|------|---------|---------|
| 隐藏 SVG 精灵 | `style="display:none"` | `class="svg-sprite"` + CSS `.svg-sprite { display: none; }` |
| 初始宽度进度条 | `style="width:0%"` | CSS `.affect-fill { width: 0; }` + JS 设置 `.style.width` |
| 行内提示布局 | `style="display:inline;margin-left:4px;"` | `.settings-hint-inline` class |
| 动态颜色状态 | `style="color:var(--accent)"` | `data-visible="true"` + CSS `[data-visible="true"] .icon { color: var(--accent); }` |
| 图标尺寸修饰 | `style="width:12px;height:12px"` | `.icon-xs` / `.icon-sm` class |

### 7.4 审查清单

提交前审查（翠幕天罗）必须执行：

- [ ] `renderer/index.html` 全文搜索 `style="`，应为 0 处
- [ ] TS 文件 `innerHTML =` 拼接产物不含 `style="` 字面量
- [ ] `.affect-fill` / `.health-metric-fill` 等动态进度条在 CSS 中声明默认 width
- [ ] 动态颜色状态通过 `data-*` 属性 + CSS 选择器表达
