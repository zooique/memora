# Step 3 · Sprite 宿主主进程层 · 打包前审查报告

> **审查模式**：问诊·炼化归元（规则对齐 → 剪枝 → 提交前审查）
> **审查范围**：sprite 宿主主进程层 35 文件 9564 行
>   - `src/electron/ipc/`（14 文件，2997 行，IPC handlers）
>   - `src/electron/windows/`（7 文件，1802 行，窗口管理 + ADR-SP-017/018 关键文件）
>   - `src/electron/` 根级（14 文件，4765 行，main/preload/errorHandler/shortcuts/spriteEventBridge/agentListeners/clipboardHandler/inputInjector 等）
> **审查日期**：2026-07-19
> **执行模式**：问诊·炼化归元
> **后续衔接**：Step 4（sprite 控制器层）

---

## 1. 规则对齐

### 1.1 已对齐项（合规无问题）

| # | 规则 | 验证方式 | 结果 |
|---|------|----------|------|
| AL-1 | project-rules §7.1 零容忍 `@ts-ignore` / `as any` | Grep 全量扫描主进程层 35 文件 | ✅ 0 处违规（仅 2 处 renderer/helpers 注释说明，非代码） |
| AL-2 | project-rules §7.1 零容忍裸 `throw new Error` | Grep 全量扫描 | ✅ 0 处违规（仅 renderer/components/onboarding.ts:453 一处，不在本次范围） |
| AL-3 | project-rules §7.1 零容忍生产 `console.*` | Grep 全量扫描 | ✅ 0 处违规（仅 themeInjector.ts:34 注入脚本中 console.warn，.renderer 层有 reportError 统一入口） |
| AL-4 | coding-convention §2 不吞异常（无空 catch 块） | Grep multiline + 子代理扫描 | ✅ 主进程层 0 处空 catch 块（renderer 层有 4 处裸 catch，见 §3.4） |
| AL-5 | 无 TODO/FIXME/XXX/HACK 遗留 | Grep 全量扫描 | ✅ 0 处违规 |
| AL-6 | ADR-SP-018 跨进程非 ASCII 数据用文件 I/O | pasteCoordinator.ts 检查 | ✅ `[System.IO.File]::WriteAllBytes` + `fs.readFileSync` UTF-16LE，零编码转换 |
| AL-7 | ADR-SP-018 PowerShell `-TypeDefinition` + W 后缀函数 | pasteCoordinator.ts:71,77,80 | ✅ `GetWindowTextW` / `GetWindowTextLengthW`，绕过 `Add-Type -MemberDefinition` bug |
| AL-8 | ADR-SP-018 HWND 捕获时传递消除竞态 | pasteCoordinator.ts:50,83 | ✅ 接受 hwnd 参数，不调用 `GetForegroundWindow()` |
| AL-9 | directory-structure §2.5 quick-input 6 通道例外（ADR-SP-017） | quickInputWindow.ts | ⚠️ 实际 8 通道（白名单 6 + 第 7 `QUICK_INPUT_SET_PINNED_MODE` 死代码 + 第 8 `QUICK_INPUT_FOCUS_CHANGE` 未登记） |
| AL-10 | directory-structure §2.1 windows/ 职责边界 | windows/ 7 文件 | ⚠️ floatWindow.ts 内联 4 handler + windowManager.ts 内联 3 handler（窗口管理性质，违规但需决策） |
| AL-11 | project_memory.md windowState tray/full 二态 | windowState.ts | ✅ 二态 + float 独立偏好，FLOAT_SIZE 令牌同步注释齐全 |
| AL-12 | project_memory.md 快速输入浮窗 alwaysOnTop + skipTaskbar | quickInputWindow.ts:164-165 | ✅ 永远 `true`，无 toggle |
| AL-13 | directory-structure §2.5 IPC 通道校验机制 | scripts/check-ipc-channels.ts | ✅ channels.ts ↔ preload.ts 双向一致性已建 |
| AL-14 | project-rules §7.4 Agent 不管理 LLM API keys | main.ts + minimalHandlers.ts | ✅ 通过 startSprite 注入，main.ts 不直接持有 keys（但 appState.lastApiKey 缓存见 ROOT-12） |
| AL-15 | 窗口安全（contextIsolation/sandbox/nodeIntegration） | floatWindow.ts:71-73 / windowManager.ts:140-142 / quickInputWindow.ts:172-174 | ✅ 三窗口均显式设置安全默认值 |
| AL-16 | windowSecurity.ts window.open 阻止 + will-navigate 过滤 | windowSecurity.ts:30-36 | ✅ `setWindowOpenHandler deny` + `will-navigate` 仅允许当前 URL |
| AL-17 | ADR-017 枝叶层 2 次提取：mergeAbortSignals | （Step 2 已对齐） | ✅ 内核层已合规 |
| AL-18 | ADR-017 枝叶层 2 次提取：spriteEventBridge sendSpriteEventIfVisible | spriteEventBridge.ts | ✅ 已提取但仅服务 SPRITE_EVENT 通道（见 EXT-2 候选） |

### 1.2 规则对齐发现的违规

| ID | 规则 | 文件:行号 | 性质 |
|----|------|----------|------|
| AL-V1 | directory-structure.md §1 完整目录树未列 preload-float.ts + preload-quick-input.ts | directory-structure.md §1 L16-28 | 文档与实现漂移 |
| AL-V2 | directory-structure.md §2.5 IPC 通道规模文档 105 vs 实际 116 | §2.5 L411-417 | 文档失同步（用户口径 117） |
| AL-V3 | directory-structure.md §2.5 治理阈值 150 vs 用户口径 130 | §2.5 L472 | 阈值不一致 |
| AL-V4 | ADR-SP-017 quick-input 例外白名单 6 个 vs 实际 8 个 | quickInputWindow.ts | 第 7 `SET_PINNED_MODE` 死代码 + 第 8 `FOCUS_CHANGE` 未登记 |
| AL-V5 | project_memory.md Agent.close() nullify 集中方法 | main.ts before-quit handler | 缺失 `nullifyAllComponents()`，9+ 字段未 nullify |
| AL-V6 | ADR-SP-018 inputInjector.ts 中文窗口标题比较 | inputInjector.ts:184-186 | 已提取 hwnd 但未在比较逻辑中使用，仍依赖 nut-js 损坏的 title |
| AL-V7 | project_memory.md fs 操作隔离（11 文件） | main.ts:28-29 / esmShim.ts:11-12 / inputInjector.ts:38 | 根级 3 文件 import node 内置模块（部分豁免） |

---

## 2. 剪枝

### 2.1 死代码（P0 · 零容忍）

| ID | 文件:行号 | 描述 | 处置 |
|----|----------|------|------|
| PR-1 | quickInputWindow.ts:138,196,337-345,358,463-469,605 | pin-toggle 功能未彻底移除（pinnedMode 字段 + SET_PINNED_MODE handler + safePinnedMode 校验 + blur 抑制 + destroy 清理）—— project_memory.md 明确"pin-toggle functionality removed" | 必须打包前删除 |

### 2.2 重复代码（P1 · ADR-017 枝叶层 2 次提取原则候选）

| ID | 文件:行号 | 重复次数 | 描述 |
|----|----------|---------|------|
| PR-2 | floatWindow.ts:218,242,260,283 | 4 次 | `isDestroyed + webContents.send` 守卫模式（已有 `send()` 方法未复用） |
| PR-3 | configHandlers.ts:102-121 + 155-173 | 2 次 | CONFIG 副作用 3 件套（silentMode/silentModeExpiresAt/shortcuts） |
| PR-4 | workProjectionHandlers.ts:36-44 + 66-74 | 2 次 | WorkProjection 7 字段映射 |
| PR-5 | main.ts/agentListeners.ts/spriteEventBridge.ts/chatStreamHandler.ts/windowState.ts/windowManager.ts | 19+ 处 | `fullWindow && !fullWindow.isDestroyed()` 可见性检查模式 |
| PR-6 | clipboardHandler.ts:51-109 | 4 处使用 | `isSensitive` + `SENSITIVE_PATTERNS` + `SensitiveCheckResult` 应下沉到 shared/ |
| PR-7 | preload.ts + preload-float.ts + preload-quick-input.ts | 18 通道重复 | preload 三文件 IPC 通道常量重复（sandbox 限制，需 ADR 豁免） |
| PR-8 | quickInputWindow.ts:281,320,407,426,465,523,608,615 | 8 次 | `if (this.win && !this.win.isDestroyed())` 窗口存在性守卫 |
| PR-9 | quickInputWindow.ts:406-420,424-438,442-459 | 3 次 | IPC handler `try/catch + logger.error` 错误包装 |
| PR-10 | pasteCoordinator.ts:217-219 + 283-285 | 2 次 | `catch { return null; }` 静默降级（应加日志） |
| PR-11 | minimalHandlers.ts:151 + 240 | 2 次 | LLM 配置参数校验模式 |

### 2.3 修改痕迹注释（P1 · grower skill DON'T）

| ID | 文件:行号 | 类型 | 描述 |
|----|----------|------|------|
| PR-12 | chatHandlers.ts:8-9,43,50 / chatStreamHandler.ts:2,10,271 / sessionHandlers.ts:111 / systemHandlers.ts:93 / minimalHandlers.ts:436 / channels.ts:110,283,347 / configHandlers.ts:28,135 | "已提取到"/"替代"/"旧实现"/"添加 null 检查"/"修复 TS18047"/"H-0717-3" | IPC 层 14 处修改痕迹 |
| PR-13 | main.ts:184,570,906 / preload.ts:182,233 / preload-float.ts:10-12 / preload-quick-input.ts:16-18 / inputInjector.ts:27-30 | "已移至"/"不需要在此处再次调用"/"原 QUICK_INPUT_SET_ALWAYS_ON_TOP 通道已移除"/"补齐"/"减法（2026-07-18）"/"实施独立化"/"原 v0 设计" | 根级 8 处修改痕迹 |
| PR-14 | windowManager.ts:133,155,158 / windowState.ts:108 / floatWindow.ts:191-192 / themeInjector.ts:40 / quickInputWindow.ts:471-472 | "旧值为"/"添加 isDestroyed 守卫"/"对齐 setUnreadCount 守卫模式"/"P1：补充 logger.debug"/"强耦合并...不再需要" | windows 层 6 处修改痕迹 + 1 处重复注释 |

### 2.4 规则文档漂移（P1 · 真理源失同步）

| ID | 文件 | 描述 | 处置 |
|----|------|------|------|
| PR-15 | directory-structure.md §1 L16-28 | 完整目录树未列 preload-float.ts + preload-quick-input.ts（实际 14 文件，规则列 12） | 补全 |
| PR-16 | directory-structure.md §2.5 L411-417 | 通道规模文档 78+27=105 vs 实际 88+28=116（用户口径 117） | 同步实际数 |
| PR-17 | directory-structure.md §2.5 L472 | 治理阈值 150 vs 用户口径 130 | 对齐 130 |
| PR-18 | directory-structure.md §2.5 表格 | quickInputWindow.ts 例外清单 6 个 vs 实际 8 个 | 删除 SET_PINNED_MODE 死代码 + 补登记 FOCUS_CHANGE 或迁移 |
| PR-19 | directory-structure.md §2.5 L472 | windows/ 职责边界 vs floatWindow.ts 4 handler + windowManager.ts 3 handler 内联 | 决策：更新 ADR-SP-017 扩展例外清单 OR 迁移到 ipc/windowHandlers.ts |

### 2.5 业务逻辑越界（P2 · 架构层违规）

| ID | 文件:行号 | 描述 | 处置 |
|----|----------|------|------|
| PR-20 | minimalHandlers.ts:61-89,101-110,383-457 | reinitAgentRuntime + handleReinitFailure + LLM_PROVIDER_SET_ACTIVE 75 行运行时切换逻辑（非薄层） | 提取到 sprite/controllers/llmConfigController.ts |
| PR-21 | chatStreamHandler.ts 全文件 326 行 | handleUserInput ~240 行完整流式业务逻辑（非薄层） | 提取到 electron/chatStreamOrchestrator.ts |
| PR-22 | configHandlers.ts:31-71 | scheduleSilentRecovery + silentRecoveryTimer 模块级可变状态（非薄层） | 提取到 sprite/controllers/silentModeController.ts |
| PR-23 | clipboardHandler.ts:51-109 | SENSITIVE_PATTERNS + isSensitive 业务逻辑（安全策略） | 提取到 shared/sensitivePatterns.ts |

### 2.6 资源清理缺失（P1 · project_memory.md Agent.close nullify 约束）

| ID | 文件:行号 | 描述 |
|----|----------|------|
| PR-24 | main.ts:923-966 before-quit handler | 9+ 字段未 nullify：agent/sprite/sessionStore/closeSprite/auditManager/interaction/windowStateManager/windowManager/pendingWriteConfirmations/lastApiKey/lastProvider/lastModel/lastBaseUrl |
| PR-25 | main.ts:958 | trayManager.destroy() 后未 nullify |
| PR-26 | windowManager.ts:232-239 closeAll() | floatWindow + fullWindow 未 nullify |
| PR-27 | floatWindow.ts:208-215 close() | win 字段未 nullify（字段声明 `win!` 阻碍 nullify） |
| PR-28 | quickInputWindow.ts:597-612 destroy() | 未清理 pasteCoordinator（持有 nut-js 引用） |

---

## 3. 提交前审查

### 3.1 P0 零容忍（必须打包前修复）

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-1 | quickInputWindow.ts:138,196,337-345,358,463-469,605 | pin-toggle 死代码 6 处（PR-1）+ 第 7 通道违规（AL-V4） | 删除 pinnedMode 字段 + SET_PINNED_MODE handler + safePinnedMode 参数 + blur 抑制 + 注释 line 471-472；同步 preload.ts:184 移除 setPinnedMode API + channels.ts:184 移除常量 |

### 3.2 P1 中优先级（建议打包前修复）

#### 3.2.1 资源清理（PR-24~28）

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-2 | main.ts:923-966 | before-quit 缺失 9+ 字段 nullify，无 nullifyAllComponents() | 提取 `nullifyAllComponents()` 集中清理；尤其 `lastApiKey` 必须显式置 null 防止内存 dump 泄漏 |
| QC-3 | windowManager.ts:232-239 | closeAll() 未 nullify floatWindow + fullWindow | destroy 后 `this.floatWindow = null; this.fullWindow = null;` |
| QC-4 | floatWindow.ts:208-215 + 字段声明 | close() 未 nullify win；字段 `win!` 阻碍 nullify | 改 `private win: BrowserWindow \| null = null` + 加 null 守卫 |
| QC-5 | quickInputWindow.ts:597-612 | destroy() 未清理 pasteCoordinator | PasteCoordinator 增加 destroy() 方法，QuickInputWindow.destroy() 调用并置 null |

#### 3.2.2 ADR-SP-018 中文窗口标题绕过（ROOT-15）

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-6 | inputInjector.ts:184-186 | captureActiveWindow 用 nut-js title 进行中文比较，浮窗自身排除失效 | 改用 HWND 比较（`active.hwnd === floatWindowHwnd`），绕过 nut-js 编码 bug；inputInjector.ts:319 已提取 hwnd 字段但未在内部比较逻辑中使用 |

#### 3.2.3 类型安全（ROOT-11）

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-7 | inputInjector.ts:319 | `as unknown as { windowHandle?: number }` 双重断言绕过类型检查 | 在 NutJsDeps 接口显式声明 `hwnd?: number`，或扩展 ActiveWindow 接口 |

#### 3.2.4 ADR-017 枝叶层 2 次提取（PR-2~11）

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-8 | floatWindow.ts:218,242,260,283 | 4 处 isDestroyed+send 守卫未复用 send() 方法 | 4 处统一改用 `this.send()` |
| QC-9 | configHandlers.ts:102-121 + 155-173 | CONFIG 副作用 3 件套重复 | 提取 `applyConfigSideEffects(ctx, updates)` |
| QC-10 | workProjectionHandlers.ts:36-44 + 66-74 | WorkProjection 7 字段映射重复 | 提取 `toWorkProjectionPayload(entry)` 纯函数 |
| QC-11 | 6 文件 19+ 处 | fullWindow 可见性检查模式 | 提取 `electron/windows/windowUtils.ts` 含 `isFullWindowAccessible` + `safeSendToWindow` |
| QC-12 | clipboardHandler.ts:51-109 | isSensitive 业务逻辑 + 4 处使用 | 提取到 `shared/sensitivePatterns.ts`（纯函数+常量，无 Node 依赖） |
| QC-13 | minimalHandlers.ts:151 + 240 | LLM 配置参数校验 2 次重复 | 提取 `isValidLlmConfigInput(llmConfig)` 到 inputValidation.ts |

#### 3.2.5 IPC 通道治理文档同步（PR-15~19）

| ID | 文件 | 问题 | 修复建议 |
|----|------|------|---------|
| QC-14 | directory-structure.md §1 | 未列 preload-float.ts + preload-quick-input.ts | 补全目录树 |
| QC-15 | directory-structure.md §2.5 L411-417 | 通道规模 105 vs 实际 116 | 同步实际数 |
| QC-16 | directory-structure.md §2.5 L472 | 阈值 150 vs 130 | 对齐 130 |
| QC-17 | directory-structure.md §2.5 表格 + ADR-SP-017 | quick-input 例外 6 vs 实际 8 | 随 QC-1 删除 SET_PINNED_MODE + 补登记 FOCUS_CHANGE 或迁移 |
| QC-18 | directory-structure.md §2.1 + ADR-SP-017 | floatWindow.ts 4 handler + windowManager.ts 3 handler 内联 | 决策：扩展例外清单 OR 迁移到 ipc/windowHandlers.ts |

#### 3.2.6 IPC 层业务逻辑越界（PR-20~22，P2 但建议打包前评估）

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-19 | minimalHandlers.ts:61-89,101-110,383-457 | reinitAgentRuntime + LLM_PROVIDER_SET_ACTIVE 75 行 | 提取到 sprite/controllers/llmConfigController.ts |
| QC-20 | chatStreamHandler.ts 326 行 | handleUserInput 240 行流式业务逻辑 | 提取到 electron/chatStreamOrchestrator.ts（建议后续迭代） |
| QC-21 | configHandlers.ts:31-71 | scheduleSilentRecovery + 模块级可变状态 | 提取到 sprite/controllers/silentModeController.ts |

### 3.3 P2 低优先级（可下一轮迭代）

#### 3.3.1 修改痕迹注释清理（PR-12~14，共 28 处）

| ID | 范围 | 数量 |
|----|------|------|
| QC-22 | IPC 层（chatHandlers/chatStreamHandler/sessionHandlers/systemHandlers/minimalHandlers/channels/configHandlers） | 14 处 |
| QC-23 | 根级（main.ts/preload.ts/preload-float.ts/preload-quick-input.ts/inputInjector.ts） | 8 处 |
| QC-24 | windows 层（windowManager/windowState/floatWindow/themeInjector/quickInputWindow） | 7 处（含 1 处重复注释） |

#### 3.3.2 裸 catch 加日志（4 处）

| ID | 文件:行号 | 问题 |
|----|----------|------|
| QC-25 | quickInputWindow.ts:308-311 | readClipboardForPrefill 裸 catch 无日志 |
| QC-26 | pasteCoordinator.ts:217-219 | resolveAccurateTitle 裸 catch 无日志 |
| QC-27 | pasteCoordinator.ts:283-285 | getCapturedAppName 裸 catch 无日志 |
| QC-28 | themeInjector.ts:34 | 注入脚本中 console.warn（renderer 无 logger 桥接，保留但加注释） |

#### 3.3.3 重复代码提取（PR-8~10）

| ID | 文件:行号 | 问题 |
|----|----------|------|
| QC-29 | quickInputWindow.ts 8 处 | `if (this.win && !this.win.isDestroyed())` 提取 `isWinAlive()` |
| QC-30 | quickInputWindow.ts 3 处 | IPC handler try/catch + logger.error 提取 `wrapIpcHandler(fn, errMsg)` |
| QC-31 | pasteCoordinator.ts 2 处 | `catch { return null; }` 提取 `withSilentFallback<T>(fn, fallback, logMsg)` |

#### 3.3.4 其他

| ID | 文件:行号 | 问题 |
|----|----------|------|
| QC-32 | types.ts:12,68 | IpcContext.windowStateManager 字段 + import 未被 14 个 handler 使用（IPC-2） |
| QC-33 | windowManager.ts:102-112 | createWindows catch 中 throw error 未包装 SpriteError（P2-16） |
| QC-34 | preload-float.ts:5 + preload-quick-input.ts:5 | API 数量描述不一致（266 vs 100+） |
| QC-35 | windowManager.ts:133,155,158 | 注释重复 + "旧值"修改痕迹 |

### 3.4 文件长度监控

| 文件 | 当前行数 | 阈值 | 状态 |
|------|---------|------|------|
| src/electron/preload.ts | 1179 | 800 | ⚠️ 超阈值 +379（IPC 通道常量内联 + ElectronAPI 接口定义庞大，sandbox 限制无法拆分） |
| src/electron/main.ts | 967 | 800 | ⚠️ 超阈值 +167（appState 集中管理 + 两阶段初始化 + before-quit 清理） |
| src/electron/ipc/minimalHandlers.ts | 512 | 800 | ✅ 在控（但承载 5 个不相关功能域，关注膨胀） |
| src/electron/windows/quickInputWindow.ts | 656 | 800 | ✅ 在控 |
| src/electron/ipc/chatStreamHandler.ts | 326 | 800 | ✅ 在控（业务逻辑越界，建议提取） |
| src/electron/ipc/memoryHandlers.ts | 287 | 800 | ✅ 在控 |
| src/electron/ipc/sessionHandlers.ts | 286 | 800 | ✅ 在控 |
| src/electron/windows/pasteCoordinator.ts | 287 | 800 | ✅ 在控 |
| src/electron/ipc/channels.ts | 353 | 800 | ✅ 在控 |
| src/electron/inputInjector.ts | 344 | 800 | ✅ 在控 |
| src/electron/clipboardHandler.ts | 315 | 800 | ✅ 在控 |
| src/electron/spriteEventBridge.ts | 383 | 800 | ✅ 在控 |
| src/electron/trayIcon.ts | 298 | 800 | ✅ 在控 |
| src/electron/shortcuts.ts | 269 | 800 | ✅ 在控 |
| src/electron/ipc/types.ts | 274 | 800 | ✅ 在控 |
| src/electron/ipc/configHandlers.ts | 219 | 800 | ✅ 在控 |
| src/electron/ipc/systemHandlers.ts | 202 | 800 | ✅ 在控 |
| src/electron/agentListeners.ts | 186 | 800 | ✅ 在控 |
| src/electron/preload-quick-input.ts | 180 | 800 | ✅ 在控 |
| src/electron/ipc/suggestionHandlers.ts | 162 | 800 | ✅ 在控 |
| src/electron/errorHandler.ts | 166 | 800 | ✅ 在控 |
| src/electron/preload-float.ts | 146 | 800 | ✅ 在控 |
| src/electron/ipc/index.ts | 142 | 800 | ✅ 在控 |
| src/electron/windows/floatWindow.ts | 292 | 800 | ✅ 在控 |
| src/electron/windows/windowManager.ts | 270 | 800 | ✅ 在控 |
| src/electron/windows/windowState.ts | 216 | 800 | ✅ 在控 |
| src/electron/ipc/workProjectionHandlers.ts | 78 | 800 | ✅ 在控 |
| src/electron/ipc/chatHandlers.ts | 80 | 800 | ✅ 在控 |
| src/electron/interaction.ts | 63 | 800 | ✅ 在控 |
| src/electron/ipc/handlers.ts | 20 | 800 | ✅ 在控（re-export barrel） |
| src/electron/ipc/inputValidation.ts | 56 | 800 | ✅ 在控 |
| src/electron/types.ts | 43 | 800 | ✅ 在控 |
| src/electron/windows/themeInjector.ts | 44 | 800 | ✅ 在控 |
| src/electron/windows/windowSecurity.ts | 37 | 800 | ✅ 在控 |
| src/electron/esmShim.ts | 26 | 800 | ✅ 在控 |

2 个文件超阈值：
- preload.ts（sandbox 限制无法拆分，需 ADR 豁免）
- main.ts（建议提取 setupAgentIndependentResources 到独立文件，可降低 ~120 行）

---

## 4. 已归档项重新评估

无。本次审查范围内无已归档项需重新评估。

---

## 5. 汇总

### 5.1 量化指标

| 维度 | 数量 |
|------|------|
| 已对齐项（AL-1 ~ AL-18） | 18 项 |
| 规则对齐违规（AL-V1 ~ AL-V7） | 7 项 |
| 已剪枝识别（PR-1 ~ PR-28） | 28 项 |
| 已审查发现（QC-1 ~ QC-35） | 35 项（1 项 P0 + 21 项 P1 + 13 项 P2） |
| 归档待办（STEP3-1 ~ STEP3-?） | 见待完成任务.md |

### 5.2 优先级分布

| 优先级 | 数量 | 项目 |
|--------|------|------|
| P0 零容忍（必须打包前修复） | 1 项 | QC-1（pin-toggle 死代码 6 处 + 第 7 通道违规） |
| P1 中优先级（建议打包前修复） | 21 项 | QC-2~7（资源清理 4 + ADR-SP-018 1 + 类型安全 1）+ QC-8~13（枝叶层 2 次提取 6）+ QC-14~18（IPC 通道治理文档同步 5）+ QC-19~21（IPC 业务逻辑越界 3，可选） |
| P2 低优先级（可下一轮迭代） | 13 项 | QC-22~24（修改痕迹 3 批 28 处）+ QC-25~28（裸 catch 加日志 4）+ QC-29~31（重复代码提取 3）+ QC-32~35（其他 4） |

### 5.3 ADR-017 枝叶层 2 次提取原则触发清单

| 候选 | 触发次数 | 建议提取目标 |
|------|---------|------------|
| floatWindow send() 复用（PR-2） | 4 次 | 改用已存在的 `this.send()` 方法 |
| CONFIG 副作用 3 件套（PR-3） | 2 次 | `applyConfigSideEffects(ctx, updates)` 私有函数 |
| WorkProjection 7 字段映射（PR-4） | 2 次 | `toWorkProjectionPayload(entry)` 纯函数 |
| fullWindow 可见性检查（PR-5） | 19+ 处 | `electron/windows/windowUtils.ts` 新增 helper |
| isSensitive + SENSITIVE_PATTERNS（PR-6） | 4 处使用 | `shared/sensitivePatterns.ts` 纯函数+常量 |
| preload 三文件 IPC 通道常量（PR-7） | 18 通道重复 | sandbox 限制豁免，需 ADR 显式声明 |
| quickInputWindow 窗口存在性守卫（PR-8） | 8 次 | `private isWinAlive()` 辅助方法 |
| quickInputWindow IPC handler 错误包装（PR-9） | 3 次 | `wrapIpcHandler(fn, errorMsg)` 高阶函数 |
| pasteCoordinator 静默降级（PR-10） | 2 次 | `withSilentFallback<T>(fn, fallback, logMsg)` |
| LLM 配置参数校验（PR-11） | 2 次 | `isValidLlmConfigInput(llmConfig)` 到 inputValidation.ts |

### 5.4 与 Step 1/2 对比

| 维度 | Step 1（agent+memory） | Step 2（infra 8 模块） | Step 3（sprite 主进程 35 文件） |
|------|------------------------|------------------------|-------------------------------|
| 已对齐项 | 10 项 | 32 项 | 18 项 |
| 规则对齐违规 | 3 项 | 1 项 | 7 项（文档漂移为主） |
| 重复代码候选 | 5 项 | 2 项 | 11 项 |
| 死代码 | 1 项 | 0 项 | 1 项（pin-toggle，跨 6 处） |
| 修改痕迹注释 | 未单独统计 | 未单独统计 | 28 处（IPC 14 + 根级 8 + windows 7） |
| 归档待办 | 4 项 | 2 项 | 35 项 |
| 文件超 800 行 | 0 | 0 | 2（preload.ts 1179 + main.ts 967） |

Step 3 范围整体健康度低于 Step 2——主进程层是 sprite 与 Electron 的耦合点，承载了大量历史决策（pin-toggle 移除未完成、ADR-SP-018 绕过未彻底、IPC 通道治理阈值漂移、nullify 约束未集中实现）。修改痕迹注释 28 处是项目长期迭代累积的典型问题，需统一清理。

### 5.5 关键修复路径

**P0 必须修复**（1 项，独立提交）：
1. QC-1 pin-toggle 死代码清理（quickInputWindow.ts 6 处 + preload.ts:184 setPinnedMode API + channels.ts:184 常量）

**P1 资源清理集中修复**（5 项，1 次提交）：
2. QC-2 main.ts 提取 nullifyAllComponents() + before-quit 调用
3. QC-3 windowManager.closeAll() nullify
4. QC-4 floatWindow.close() nullify + 字段声明改 nullable
5. QC-5 quickInputWindow.destroy() 清理 pasteCoordinator

**P1 ADR-SP-018 修复**（1 项，独立提交）：
6. QC-6 inputInjector.ts 改用 HWND 比较绕过 nut-js 编码 bug

**P1 枝叶层 2 次提取批量修复**（6 项，分批提交）：
7. QC-8 floatWindow send() 复用（4 处）
8. QC-9 + QC-10 configHandlers + workProjectionHandlers 提取（2 项一起）
9. QC-11 windowUtils.ts 新增 + 19 处替换
10. QC-12 shared/sensitivePatterns.ts 提取
11. QC-13 inputValidation.ts 扩展

**P1 IPC 通道治理文档同步**（5 项，1 次提交）：
12. QC-14~18 directory-structure.md §1/§2.5 更新 + ADR-SP-017 例外清单更新

**P1 类型安全修复**（1 项，独立提交）：
13. QC-7 inputInjector.ts:319 双重断言改类型安全

**P2 修改痕迹注释批量清理**（28 处，分 3 次提交）：
14. QC-22 IPC 层 14 处
15. QC-23 根级 8 处
16. QC-24 windows 层 7 处

---

## 6. Git Commit 建议

本次审查为只读扫描，未修改任何代码。建议按以下顺序提交后续修复（每条独立可回滚）：

```
# P0 修复（必须打包前完成）
refactor(sprite-quick-input): 清理 pin-toggle 死代码 + 第 7 IPC 通道违规
   - quickInputWindow.ts: 删除 pinnedMode 字段 + SET_PINNED_MODE handler + safePinnedMode 参数 + blur 抑制 + 注释
   - preload.ts:184: 移除 setPinnedMode API + QUICK_INPUT_SET_PINNED_MODE 常量
   - channels.ts:184: 移除 QUICK_INPUT_SET_PINNED_MODE 常量
   - 随 PR-1 + AL-V4 + QC-1 一并消解
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-1

# P1 修复（建议打包前完成，按修复路径分批）
refactor(sprite-main): 提取 nullifyAllComponents() 集中清理 appState 字段
   - main.ts:923-966 before-quit handler + 9+ 字段 nullify（含 lastApiKey 敏感字段）
   - windowManager.ts:232-239 closeAll() nullify
   - floatWindow.ts:208-215 close() nullify + 字段声明改 nullable
   - quickInputWindow.ts:597-612 destroy() 清理 pasteCoordinator
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-2~5

refactor(inputInjector): 改用 HWND 比较绕过 nut-js 中文标题编码 bug
   - inputInjector.ts:184-186 captureActiveWindow 用 active.hwnd 比较
   - 修复 ADR-SP-018 绕过不彻底（已提取 hwnd 但未在比较逻辑中使用）
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-6 + ROOT-15

refactor(inputInjector): 移除 as unknown as 双重断言
   - inputInjector.ts:319 NutJsDeps 接口显式声明 hwnd 字段
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-7

refactor(floatWindow): 4 处 isDestroyed+send 守卫改用已存在的 send() 方法
   - floatWindow.ts:218,242,260,283
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-8

refactor(ipc): 提取 applyConfigSideEffects + toWorkProjectionPayload
   - configHandlers.ts:102-121 + 155-173 提取 applyConfigSideEffects
   - workProjectionHandlers.ts:36-44 + 66-74 提取 toWorkProjectionPayload
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-9 + QC-10

refactor(windows): 新增 windowUtils.ts 提取 fullWindow 可见性检查模式
   - 新增 electron/windows/windowUtils.ts（isFullWindowAccessible + safeSendToWindow）
   - main.ts/agentListeners.ts/spriteEventBridge.ts/chatStreamHandler.ts/windowState.ts/windowManager.ts 19+ 处替换
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-11

refactor(shared): 提取 isSensitive + SENSITIVE_PATTERNS 到 shared/sensitivePatterns.ts
   - clipboardHandler.ts:51-109 迁移到 shared/sensitivePatterns.ts
   - main.ts/quickInputWindow.ts 4 处调用点导入路径更新
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-12

refactor(ipc): 提取 isValidLlmConfigInput 到 inputValidation.ts
   - minimalHandlers.ts:151 + 240 两处校验提取
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-13

docs(directory-structure): 同步 IPC 通道规模 + 阈值 + 例外清单
   - §1 补列 preload-float.ts + preload-quick-input.ts
   - §2.5 通道规模 105 → 116（实际数）
   - §2.5 治理阈值 150 → 130（对齐用户口径）
   - §2.5 + ADR-SP-017 quick-input 例外清单更新（删 SET_PINNED_MODE + 补 FOCUS_CHANGE）
   - §2.1 + ADR-SP-017 floatWindow.ts/windowManager.ts 内联 handler 决策
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-14~18

# P2 修复（可下一轮迭代，分批提交）
refactor(ipc): 清理 IPC 层 14 处修改痕迹注释
   - chatHandlers.ts/chatStreamHandler.ts/sessionHandlers.ts/systemHandlers.ts
   - minimalHandlers.ts/channels.ts/configHandlers.ts
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-22

refactor(sprite-main): 清理根级 8 处修改痕迹注释
   - main.ts:184,570,906 / preload.ts:182,233 / preload-float.ts:10-12
   - preload-quick-input.ts:16-18 / inputInjector.ts:27-30
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-23

refactor(windows): 清理 windows 层 7 处修改痕迹注释
   - windowManager.ts:133,155,158 / windowState.ts:108
   - floatWindow.ts:191-192 / themeInjector.ts:40 / quickInputWindow.ts:471-472
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-24

refactor(sprite-main): 4 处裸 catch 补日志
   - quickInputWindow.ts:308-311 / pasteCoordinator.ts:217-219,283-285
   - themeInjector.ts:34 加注释说明 renderer 无 logger 桥接
   - 参考：tasks/打包前审查/step-3-sprite-main.md QC-25~28
```

---

## 7. 后序衔接

完成本步审查后，建议进入 **Step 4 · sprite 控制器层**：

- `hosts/memora-sprite/src/sprite/controllers/`（12 个 controller 文件，~3500 行）
- `hosts/memora-sprite/src/sprite/audit/` + `cli/`（4 个文件，~600 行）
- `hosts/memora-sprite/src/sprite/` 根级（sprite.ts/spriteConfig.ts/spriteLifecycleManager.ts/spriteTracer.ts/triggers.ts/tools.ts/constants.ts/fileWatcherTrigger.ts/interaction.ts/skillInstaller.ts/errors.ts/spriteConfigManager.ts，~2500 行）

预计文件数：约 27 个，行数约 6600 行。

重点关注：
1. sprite.ts 是否含 CLI/REPL 逻辑（应仅含核心类）
2. controllers/ 是否有渲染进程 UI 代码（应仅 Agent 能力扩展）
3. audit/ 是否有精灵业务逻辑（应仅审计日志写入/读取）
4. errors.ts ErrorCode 枚举完整性
