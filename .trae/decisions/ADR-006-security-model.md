---
alwaysApply: false
description: 安全采用两级权限 + 工具白名单 + 路径白名单
---

# ADR-006 · 安全采用两级权限 + 工具白名单 + 路径白名单

> **状态**：✅ 已接受 **日期**：2026-06-02 **播种批次**：Memora 模式 A v1
> **来源**：(历史设计文档已归档：03-安全权限-v0.2.md + 项目决策表.md §七)

## 背景

Agent 自动调用工具（文件操作、Shell 命令、外部 API）存在风险：损坏的能力记忆、被注入的话题报告可能导致不可逆损失。横向对比文档维度 7 明确指出"本方案完全没有安全设计"是 P1 缺口。

## 决策

采用**最小安全边界**：

| 维度            | 设计                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| 权限模型        | 两级（owner / guest）                                                                 |
| 工具调用        | skill frontmatter 声明 + 模式校验 + 参数校验                                          |
| 文件路径        | 4 类允许（当前项目/数据目录/显式白名单/stdout 替代）+ 13 类禁止（系统凭证/云服务凭证/.env/系统目录等） |
| 写入二次确认    | owner 可关闭，guest 强制                                                              |
| Prompt 注入防御 | 标签包裹 + 注入检测 + 格式校验                                                        |
| 密钥存储        | 环境变量 + `.gitignore` 强制不入库                                                    |

## 理由

- **最小权限原则**：默认拒绝所有敏感操作
- **显式允许**：白名单机制——未声明的能力一律不可用
- **审计可追溯**：所有写操作和敏感读操作可回溯
- **安全不阻塞迭代**：owner 模式可关闭二次确认，保证开发效率

## 阶段一切分

| 阶段   | 安全内容                                        |
| ------ | ----------------------------------------------- |
| 阶段一 | 路径白名单 + 写入二次确认（owner 模式默认关闭） |
| 阶段二 | 工具调用白名单（5 个工具）                      |
| 阶段三 | Prompt 注入检测 + 完整审计日志                  |

## 影响

- 所有工具调用必须经过 `security/` 模块校验
- 自定义工具通过 `ToolContext.guardPath()` 可选校验路径（S-01 修复后新增）
- 配置文件必须显式声明权限模式
- API Key 强制从环境变量读取，配置文件中的 `${VAR}` 占位符展开
- `.gitignore` 必须包含：`.env`、`config.local.json`、`*.key`

## 何时回顾

- 当发现白名单机制过于严苛影响开发效率
- 当需要多用户/多租户场景（违反"单用户本地"定位）
- 当发现新的攻击向量

## 补充说明（2026-06-15 · 阶段 B 增强）

### 内容护栏（Guardrails）

在原有路径白名单 + 写入确认的基础上，新增**内容级护栏**：

| 维度 | 设计 |
|------|------|
| 护栏类型 | 输入护栏（用户输入注入前）+ 输出护栏（LLM 响应返回前） |
| 规则存储 | 以 `source: "guardrail"` 记忆形式存储，融入"万物皆记忆"模型 |
| 规则格式 | 每条规则包含 `pattern`（正则表达式）和 `action`（`block` / `warn`） |
| 规则来源 | `configDir/rules/guardrails/` 下的 `.md` 文件，启动时由 MemoryLoader 扫描加载 |
| 降级策略 | 护栏自身异常（正则编译失败等）降级为"放行 + 记日志"，永远不阻断用户对话 |

**输入/输出护栏共享同一规则集**，AgentLoop 在对话输入和输出阶段分别调用 `runInputGuardrails()` / `runOutputGuardrails()`。

### 工具错误反思（Reflection）

新增 `ToolErrorCode` 枚举和反思机制：

| 维度 | 设计 |
|------|------|
| 错误码 | 10 种错误码（PATH_NOT_ALLOWED / FILE_NOT_FOUND / ARGUMENT_ERROR 等） |
| 可重试标记 | 5 种错误码标记为 retryable（FILE_NOT_FOUND / ARGUMENT_ERROR / TOOL_TIMEOUT / DIR_NOT_FOUND / CUSTOM_TOOL_FAILED） |
| 反思机制 | 工具失败时，AgentLoop 检查错误码是否为 retryable，若是则在 LLM 上下文中追加 `[REFLECTION_HINT]` 系统消息 |
| 反思上限 | `maxReflectionRetries` 默认 2 次，防止无限重试循环 |

### 更新后的阶段划分

| 阶段 | 安全内容 |
|------|---------|
| 阶段一 | 路径白名单 + 写入二次确认（owner 模式默认关闭） |
| 阶段二 | 工具调用白名单（5 个工具） |
| 阶段三 | 内容护栏（Guardrails）+ 工具错误反思（Reflection） |
| 阶段四 | Prompt 注入检测 + 完整审计日志 |

### 设计哲学

- **护栏不阻断对话**：护栏自身异常时降级放行，这是降级优先原则的直接要求
- **万物皆记忆**：护栏规则以 `source: "guardrail"` 融入记忆统一模型，不创建独立子系统
- **反思是增强而非替代**：LLM 原本就能看到错误消息并自行修正，Reflection 只是在可重试场景下给 LLM 一个明确的"请重试"信号

## 补充说明（2026-07-02 · 渲染进程 CSP 与内联样式）

### 背景

精灵宿主 `memora-sprite` 长期仅在 Electron 模式下运行，`renderer/index.html` 声明的 CSP `style-src 'self'` 在 Electron 下执行较宽松，内联 `style=""` 属性可正常解析。当引入 Web 模式（`dev:web` / `start:web`）后，浏览器严格执行 CSP，所有内联样式被静默丢弃，导致：

1. SVG 精灵容器（`style="display:none"`）失去隐藏，默认 300×150px 占位
2. `#app` 元素被推至 top:153px，界面顶部出现大片空白
3. 进度条（`style="width:0%"`）回退为 `width:auto`，初始满格闪烁
4. 设置图标颜色状态（`style="color:var(--accent)"`）失效

### 决策

在原有安全模型基础上，新增**渲染进程 CSP 与内联样式约束**，固化三条硬约束（详见 [security_rules.md §7](../rules/security_rules.md)）：

| 维度 | 设计 |
|------|------|
| CSP 严格度 | `renderer/index.html` 严格（`style-src 'self'`）；`float.html` 宽松（保留 `'unsafe-inline'`） |
| 内联样式 | 渲染进程 HTML 严禁任何 `style=""` 属性（含静态 HTML 与动态 `innerHTML` 拼接产物） |
| 动态样式来源 | 主题初始化等运行时样式由主进程 `webContents.executeJavaScript()` 注入；动态状态用 `data-*` 属性 + CSS 选择器表达 |
| 替代模式 | 静态布局迁移到 CSS class（`.svg-sprite` / `.settings-hint-inline` / `.icon-xs` 等）；动态宽度由 CSS 默认值 + JS `.style.width` 设置 |

### 理由

- **Web/Electron 一致性**：同一份 HTML 在两种模式下表现一致，避免"Electron 能用 Web 不能用"的隐性 bug
- **CSP 是安全资产**：`style-src 'self'` 阻止样式注入攻击（如 CSS 数据外泄），不应为了开发便利性引入 `'unsafe-inline'`
- **审查可自动化**：`style="` 字面量搜索是 0 引用的硬约束，可被翠幕天罗审查清单覆盖
- **数据属性语义更清晰**：`data-visible="true"` 比内联 `style="color:var(--accent)"` 更具可读性和可测试性

### 影响

- 所有渲染进程 HTML 修改必须经过 CSP 兼容性检查
- TS 文件动态 `innerHTML` 拼接产物必须避免 `style="` 字面量
- 提交前审查新增 4 项 CSP 兼容性检查清单
- ~~`float.html` 因独立悬浮窗场景，保留 `'unsafe-inline'` 不受此约束~~ → **2026-07-24 修正**：`float.html` 内联样式已全部外置为外部 stylesheet，CSP 收紧为严格 `style-src 'self'`（与 `index.html` 一致），原宽松例外作废（详见 [security_rules.md §7.2](../rules/security_rules.md)）

### 修正记录

- **2026-07-24（年轮审判）**：`float.html` 的 CSP 已从宽松（`'unsafe-inline'`）收紧为严格（`style-src 'self'`）。原因：悬浮窗内联样式已全部外置为 `styles/foundation/*.css` + `styles/windows/float.css`（float.html 头部注释已记载此决策），Web 模式合规要求渲染进程统一收紧，且 `'unsafe-inline'` 是样式注入攻击面、不应为悬浮窗保留例外。原 §7「影响」末条宽松例外已作废，操作真相以 [security_rules.md §7.2](../rules/security_rules.md) 为准。

### 何时回顾

- 当 Web 模式被废弃时（CSP 严格度可放宽）
- 当 Electron 也开始严格执行 CSP 时（需进一步收紧约束）
- 当引入需要内联样式的第三方库时（评估 nonce 或 hash 白名单方案）

## 补充说明（2026-07-03 · HC-03 写入确认 fail-closed 决策）

### 背景

`SecurityGuard.requestWriteConfirmation()` 原设计包含两条确认路径：
1. **主路径**：宿主通过 `onWriteConfirmation()` 注入 `confirmationHandler`（Electron/Web/CLI 各自实现 UI）
2. **回退路径**：未注入 handler 时，内核直接调用 `node:readline/promises` + `node:process` 从 stdin 读取用户输入

回退路径存在三个问题：
1. **违反纯逻辑约束**：`security/` 模块作为内核纯逻辑库，硬依赖交互式终端 I/O 模块（与 ADR-002 零依赖内核原则精神不符）
2. **测试死角**：`pathGuard.test.ts` 注释明说"暂无法稳定 mock readline/promises 内部 stdin"，回退路径**无单元测试覆盖**
3. **生产环境零消费者**：
   - Sprite Electron 宿主：`agentListeners.ts:117` **无条件注入** confirmationHandler
   - Sprite CLI 宿主：`cli.ts:133` 配置 `confirmWrites=false`（自动批准，不走确认路径）
   - Web 宿主：`preloadWeb.ts:763` 已有桩函数

### 决策

**完全移除 readline 回退路径，采用 fail-closed 语义**：

| 场景 | 原行为 | 新行为（HC-03）|
|------|--------|----------------|
| `needConfirm=true` + 已注入 handler | 调用 handler | 调用 handler（不变）|
| `needConfirm=true` + **未注入 handler** | 回退到 readline + stdin | **直接拒绝（return false）+ warn 日志 + 审计记录** |
| `needConfirm=false`（owner + confirmWrites=false）| 自动批准 | 自动批准（不变）|

### 理由

- **YAGNI 原则**：生产环境零消费者，保留死代码增加维护负担
- **fail-closed 是正确语义**：未配置确认机制 = 拒绝写入，避免无意识放行（安全优先）
- **符合 ADR-002 注入模式**：宿主负责提供确认 UI（与 `IMemoryStorage` / `LlmProvider` 同模式），内核不提供终端 I/O 默认实现
- **消除测试死角**：fail-closed 路径可完全 mock 测试，无需模拟 stdin
- **宿主已有 readline**：`hosts/memora-sprite/src/sprite/cli/interaction.ts` 提供 `CliInteraction`，未来若 CLI 宿主需要确认 UI，应自行实现 `confirmationHandler` 并注入

### 影响

- 内核 `security/pathGuard.ts` 删除 `node:readline/promises` + `node:process` 两个顶层 import + `confirmViaReadline()` 方法（约 48 行）
- `requestWriteConfirmation()` 新增 fail-closed 分支：未注入 handler 时 `logger.warn` + `emitAudit({type:'write-decline', reason:'未注入 confirmationHandler（fail-closed）'})` + `return false`
- **破坏性变更**：若有宿主依赖 readline 回退（当前无），升级后需要确认的写入将被拒绝。宿主必须显式注入 `confirmationHandler`
- 测试新增 3 个用例：owner+confirmWrites=true fail-closed / guest fail-closed / owner+confirmWrites=false 不受影响

### 何时回顾

- 当新宿主类型出现且需要 readline 确认能力时（评估是否提供官方 `createReadlineConfirmation()` 工厂函数供宿主使用）
- 当 fail-closed 语义导致实际使用阻塞时（评估是否提供配置项允许 owner 模式降级为 auto-approved）
