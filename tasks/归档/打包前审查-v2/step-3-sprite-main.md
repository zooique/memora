# Step 3 审查报告：Sprite 宿主主进程

> **审查范围**：`src/electron/` 主进程层（~4400 行，21 文件）
> **审查日期**：2026-07-19
> **审查方式**：凭工程经验审查，不依赖项目规则
> **前序成果**：Step 1-2 报告

---

## 1. 审查范围清单

| 目录/文件 | 文件数 | 审查重点 |
|-----------|--------|----------|
| `src/electron/ipc/` | 14 | IPC handler 职责单一性、输入校验、错误兜底 |
| `src/electron/windows/` | 7 | 窗口状态机、生命周期管理、BrowserWindow 泄漏 |
| `main.ts` | 1 | 应用启动流程、资源清理、全局异常处理 |
| `preload.ts` / `preloadFloat.ts` / `preloadQuickInput.ts` | 3 | contextBridge 暴露面最小化 |
| `spriteEventBridge.ts` | 1 | 事件桥接、类型安全 |
| `shortcuts.ts` | 1 | 快捷键注册/注销、冲突处理 |
| `errorHandler.ts` | 1 | 异常处理体系 |
| `agentListeners.ts` | 1 | 回调注册、重新初始化 |
| `clipboardHandler.ts` | 1 | 剪贴板轮询、敏感内容过滤 |
| `pasteCoordinator.ts` / `inputInjector.ts` | 2 | 跨进程数据传递、PowerShell 调用 |
| `trayIcon.ts` / `interaction.ts` / `esmShim.ts` | 3 | 托盘管理、交互层、路径工具 |

---

## 2. 模块评分

| 模块 | 评分 | 说明 |
|------|------|------|
| IPC 层（channels + handlers） | **8.0/10** | 通道数偏高但职责清晰，输入校验分层合理，流式输出超时兜底出色 |
| 窗口管理（windows/） | **8.5/10** | 三态状态机设计干净，显示器边界校验完善，BrowserWindow 生命周期管理严格 |
| main.ts 启动流程 | **9.0/10** | 两阶段初始化设计优秀，`appState` 集中状态管理，`nullifyAllComponents` 清理彻底 |
| preload 脚本 | **7.0/10** | 主 preload 暴露面过大，但浮动/快速输入 preload 最小权限实践优秀 |
| 快捷键管理 | **8.5/10** | 依赖注入可测试，注册失败通知用户，热更新支持完整 |
| 错误处理 | **8.0/10** | 全局兜底完善，错误分类合理，但 ErrorCode 降级路径有误匹配风险 |
| 事件桥接 | **9.0/10** | 泛型 `forwardSimpleEvent` 消除大量模板代码，取消订阅机制完善 |
| 剪贴板/输入注入 | **8.5/10** | 三重保护设计合理，PowerShell 绕过 nut-js 编码 bug 修复彻底，`as unknown as` 类型转换有改进空间 |

**综合评分**：**8.3/10**（高质量，少数改进点）

---

## 3. 问题清单

### 3.1 P1（高优先级，建议修复）

#### P1-1. preloadFloat.ts / preloadQuickInput.ts 无通道同步测试

**描述**：主 preload.ts 的 `IPC_CHANNELS` 通过 `channelParity.test.ts` 断言与 `channels.ts` 键集一致。但 `preloadFloat.ts`（8 个通道）和 `preloadQuickInput.ts`（10 个通道）没有对应的 parity 测试。若 `channels.ts` 修改了某个通道名，这两个 preload 的内联副本会静默失配，导致全链路 UI 失效（sandbox 模式下无运行时错误，仅表现为功能无响应）。

**位置**：
- `preloadFloat.ts:33-54` — 内联 IPC_CHANNELS / MAIN_TO_RENDERER_CHANNELS（8 个通道）
- `preloadQuickInput.ts:28-50` — 内联 IPC_CHANNELS / MAIN_TO_RENDERER_CHANNELS（10 个通道）
- `channelParity.test.ts` — 仅覆盖主 preload.ts

**修复建议**：在 `channelParity.test.ts` 中增加浮动窗口和快速输入窗口的通道子集断言：验证 `preloadFloat.ts` 的 8 个通道值在 `channels.ts` 中存在且值一致，`preloadQuickInput.ts` 同理。或提取一个 `SubsetParity` 辅助函数。

#### P1-2. IPC handler 输入校验覆盖不完整

**描述**：`inputValidation.ts` 提供了 `validated` / `validateString` / `validateNumber` 等校验工具，但并非所有 handler 都使用了这些校验。检查发现：

- `chatHandlers.ts` / `chatStreamHandler.ts`：有完善的前置校验（Agent 就绪、竞态保护、窗口销毁）
- `memoryHandlers.ts`：`searchMemories` 使用 `validateString`，`showMemory`/`deleteMemory` 使用 `validated` 包装
- `configHandlers.ts`：`updateConfig` 有 key/value 校验
- `sessionHandlers.ts`：部分 handler 有参数校验
- `systemHandlers.ts` / `suggestionHandlers.ts` / `workProjectionHandlers.ts`：部分 handler 参数直接透传，未经过 `validateString` 等校验

**位置**：各 handler 文件中的 `ipcMain.handle` 注册点

**修复建议**：对所有接收外部输入（渲染进程参数）的 IPC handler 统一使用 `validated` 或 `validateString`/`validateNumber` 包装。`send` 风格（fire-and-forget）的 handler 至少应做 `typeof` 检查。

#### P1-3. `appState` 的 `null!` 断言存在运行时风险

**描述**：`main.ts:98-149` 中 `appState` 有 3 个字段使用 `null!` 断言（`windowStateManager`、`windowManager`、`interaction`）。注释说明"使用前必定赋值"，但在 `before-quit` 的 `nullifyAllComponents` 中这些字段被重置为 `null!`。如果在 `before-quit` 和 `app.exit(0)` 之间有任何异步回调访问这些字段，会触发 `Cannot read properties of null` 崩溃。

**位置**：`main.ts:98-101`

**修复建议**：
1. 将 `null!` 改为 `null as T | null`，在访问处加 `?.` 可选链
2. 或在 `nullifyAllComponents` 之后、`app.exit(0)` 之前确保没有异步回调可能执行

---

### 3.2 P2（中优先级，建议修复）

#### P2-1. IPC 通道数接近治理阈值，但无合并计划

**描述**：当前 IPC 通道数（renderer→main）约 115 个（含 preload 中移除 `QUICK_INPUT_SET_PINNED_MODE` 后从 117 降至 115）。项目 memory 中记录的治理触发阈值是 130，差距仅 15 个通道。以下通道可以考虑合并：

| 可合并通道组 | 当前设计 | 建议 |
|-------------|---------|------|
| MEMORIES_RESTORE / MEMORIES_PURGE / MEMORIES_RESTORE_ALL / MEMORIES_PURGE_ALL / MEMORIES_LIST_DELETED（5 个） | 5 个独立通道 | 合并为 `MEMORIES_TRASH` 统一通道，通过 action 字段区分（`restore`/`purge`/`restoreAll`/`purgeAll`/`list`） |
| MEMORIES_RELATION_GRAPH / MEMORIES_RELATION_PATH / MEMORIES_RELATION_NEIGHBORS（3 个） | 3 个独立通道 | 合并为 `MEMORIES_RELATION` 统一通道，通过 `query.type` 区分 |
| SUGGESTION_ACCEPT / SUGGESTION_REJECT（2 个） | 2 个独立通道 | 合并为 `SUGGESTION_RESPOND`，通过 `accepted: boolean` 区分 |
| PROACTIVE_ACCEPT / PROACTIVE_REJECT（2 个） | 2 个独立通道 | 合并为 `PROACTIVE_RESPOND`，通过 `accepted: boolean` 区分 |
| AUDIT_LOG_LIST / AUDIT_LOG_CLEAR（2 个） | 2 个独立通道 | 合并为 `AUDIT_LOG`，通过 action 字段区分 |
| LLM_PROVIDER_LIST / LLM_PROVIDER_SAVE / LLM_PROVIDER_DELETE / LLM_PROVIDER_SET_ACTIVE（4 个） | 4 个独立通道 | 合并为 `LLM_PROVIDER`，通过 action 字段区分（`list`/`save`/`delete`/`setActive`） |

**预期效果**：以上合并可将通道数从 115 降至约 97，为未来扩展留出空间。

**位置**：`channels.ts` 通道定义 + 各 handler 注册点

**建议**：当前通道数 115 距离 130 阈值还有 15 个余量，暂不强制合并。建议在通道数达到 130 时执行上述合并方案。或先合并 P2-1 中建议的 4 组（MEMORIES_TRASH / PROACTIVE_RESPOND / SUGGESTION_RESPOND / AUDIT_LOG），减少 9 个通道至 106。

#### P2-2. `preload.ts` 的 `ElectronAPI` 接口暴露面过大

**描述**：`preload.ts` 暴露了 896 行代码的 `ElectronAPI` 接口，包含 ~100+ 个方法。虽然所有方法都通过 `contextBridge` 安全暴露，但接口体量本身意味着：
1. 渲染进程可以访问主进程的所有能力（包括 `installSkill`、`deleteMemory`、`clearAuditLog` 等危险操作）
2. 接口变更时需同步更新 `preload.ts` 的类型定义和实现，维护成本高

**正面因素**：
- `preloadFloat.ts` 和 `preloadQuickInput.ts` 已正确实施最小权限（分别仅暴露 8 和 10 个方法）
- 所有方法都是 `ipcRenderer.invoke` 或 `ipcRenderer.send` 的薄包装，不直接暴露系统能力

**位置**：`preload.ts:385-896`

**建议**：当前设计合理（主窗口需要全功能，浮动/快速输入窗口最小权限已实施）。不需要修改，但需保持警惕：新增 API 时评估是否真的需要暴露到主窗口。

#### P2-3. `ErrorHandler.extractErrorCode` 降级路径存在误匹配风险

**描述**：`errorHandler.ts:92-107` 的 `extractErrorCode` 方法通过 `error.message.includes('关键词')` 推断错误码。注释明确标注为 `@deprecated` 降级路径，但以下场景仍可能误匹配：
- 用户消息中包含"文件"、"网络"、"初始化"等关键词 → 被错误分类
- 非中文错误消息（如 `'Failed to fetch'`）→ 匹配 `'fetch'` 关键词 → 误判为 `NETWORK_ERROR`

**位置**：`errorHandler.ts:92-107`

**修复建议**：
1. 降级路径仅匹配 `ENOENT` / `ECONNREFUSED` 等系统错误码前缀（`error.code`），不匹配 `error.message` 中的中文关键词
2. 对于 `fetch` 关键词，增加 `error.message.includes('fetch failed')` 等更精确的模式匹配
3. 长期方案：确保所有新增 `throw` 使用 `SpriteError` 携带 code，使降级路径仅服务于遗留代码

---

### 3.3 P3（低优先级，可延期）

#### P3-1. `inputInjector.ts` 中 `as unknown as NutJsWindow` 绕过了类型检查

**描述**：`inputInjector.ts:350` 将 `nutJs.getActiveWindow()` 的结果通过 `as unknown as NutJsWindow` 双重转换。虽然 `NutJsWindow` 接口已声明 `windowHandle` 字段，但 `as unknown as` 绕过了 TypeScript 的类型收窄——如果 nut-js 未来版本修改了 Window 类的内部结构，`windowHandle` 可能为 `undefined`，而 `as unknown as` 不会给出编译期错误。

**位置**：`inputInjector.ts:350`

**当前状态**：已有 `STEP3-7` 注释说明此转换的原因（消除双重转换），`NutJsWindow` 接口已显式声明 `windowHandle?: number` 字段。`pasteCoordinator.ts:212` 在使用 `hwnd` 时也有 `?? null` 降级。

**建议**：当前风险可控。保持在 `@nut-tree-fork/nut-js` 版本升级时验证 `windowHandle` 字段仍存在即可。

#### P3-2. `pasteCoordinator.ts` 临时文件清理存在竞态

**描述**：`pasteCoordinator.ts:51-107` 的 `getWindowTitleViaPS` 函数使用 `os.tmpdir()` 创建临时文件，文件名包含 `process.pid` 和 `Date.now()`。虽然 `finally` 块清理了临时文件，但以下场景可能导致泄漏：
- 进程崩溃时临时文件残留（文件名包含 PID，重启后不会冲突）
- 多个快速输入浮窗同时调用（`Date.now()` 精度在毫秒级，理论上可能冲突）

**位置**：`pasteCoordinator.ts:51`

**建议**：当前风险极低（单进程 + 毫秒级时间戳）。不需要修改，但可考虑在应用启动时清理 `memora_title_*` 残留临时文件。

#### P3-3. `clipboardHandler.ts` 中 `djb2` 哈希碰撞概率

**描述**：`clipboardHandler.ts:186-195` 使用 `djb2` 算法（32 位）计算剪贴板内容哈希。32 位哈希空间约 40 亿，对于剪贴板变化检测场景足够，但理论上存在碰撞可能（两个不同内容产生相同哈希，导致变化漏检）。

**位置**：`clipboardHandler.ts:186-195`

**建议**：剪贴板变化检测场景下碰撞概率极低（用户不会在 2 秒轮询间隔内复制 2 个不同内容且碰巧哈希相同）。不需要修改。

---

### 3.4 P4（观察项，无需修复）

#### P4-1. `main.ts` 中 `boundsSaveTimer` 防抖 500ms 可能丢失最后的位置

**描述**：`main.ts:584-601` 的窗口 resize/move 监听使用 500ms 防抖。如果用户在 500ms 内关闭应用，最后的位置不会持久化。但 `before-quit` 中未触发 `saveBounds`。

**位置**：`main.ts:584-609`

**建议**：在 `before-quit` 的清理流程中加入 `saveBounds()` 调用（或 `nullifyAllComponents` 之前），确保最终位置不丢失。

#### P4-2. `spriteEventBridge.ts` 中 `proactiveTrayResetTimer` 无法在 `unsubscribeSpriteEvents` 时清理

**描述**：`spriteEventBridge.ts:151` 的 `proactiveTrayResetTimer` 是在 `setupSpriteEventListeners` 内部创建的局部变量。`unsubscribeSpriteEvents` 清理了事件订阅但未清理此定时器。虽然 `reinitAgent` 走 `setupAgentReady` → `setupSpriteEventListeners` 时会先调用 `unsubscribeSpriteEvents` 再重新注册（新闭包会创建新定时器），旧定时器在旧闭包中无法被 `clearTimeout`。

**位置**：`spriteEventBridge.ts:151`

**建议**：当前行为无实际危害（旧定时器到期后调用 `setState('idle')` 因幂等保护无副作用）。但为保持定时器生命周期清晰，可将 `proactiveTrayResetTimer` 提升为模块级变量，在 `unsubscribeSpriteEvents` 中清理。

---

## 4. 设计评价

### 4.1 亮点

1. **两阶段初始化设计**（`main.ts`）：阶段 1 创建窗口+托盘（始终成功），阶段 2 初始化 Agent（可能因配置缺失跳过）。这确保了即使 LLM 未配置，用户也能看到设置界面，不会出现"白屏"。

2. **`appState` 集中状态管理**（`main.ts:95-149`）：17 个可变状态集中到一个对象，消除了 `MinimalIpcState` 代理层。注释清晰标注了初始化时序和字段归属。

3. **`nullifyAllComponents` 集中清理**（`main.ts:935-967`）：在 `before-quit` 中系统性地置空所有持有原生资源的字段，防止内存 dump 泄漏、定时器残留、引用循环。敏感字段（`lastApiKey`）显式置 null。

4. **泛型 `forwardSimpleEvent` 消除模板代码**（`spriteEventBridge.ts:66-74`）：16 个简单转发事件通过类型安全的泛型函数逐个注册，消除了 `SIMPLE_EVENT_FORWARDERS` 映射表 + `as` 断言的反模式。

5. **流式输出超时兜底**（`chatStreamHandler.ts:129-156`）：主进程 60 秒无进展超时 + `forceReleaseChatLock` 强制解锁，比内核 3 分钟锁超时更早触发，用户可立即发起新对话。

6. **PowerShell 绕过 nut-js 编码 bug**（`pasteCoordinator.ts`）：通过文件 I/O 传递 UTF-16LE 字节，彻底解决中文 Windows 下 nut-js `GetWindowTextA` 导致的 U+FFFD 乱码。设计过程有完整的 ADR 记录（ADR-SP-018）。

7. **剪贴板三重保护**（`clipboardHandler.ts`）：被动检测（仅哈希比较）→ 主动触发（用户点击分析）→ 敏感过滤（`isSensitive`），不自动读取/存储剪贴板内容，隐私设计完善。

8. **窗口安全防护抽取**（`windowSecurity.ts`）：从 3 处散落的 `will-navigate + setWindowOpenHandler` 模式中提取为独立模块，遵循 ADR-017 枝叶层 2 次提取。

### 4.2 架构决策评价

1. **IPC 通道手动维护**：sandbox 模式下 preload 无法运行时导入 `channels.ts`，导致 3 个 preload 文件各自内联通道常量。虽然 `channelParity.test.ts` 提供了主 preload 的同步断言，但浮动/快速输入 preload 缺乏同等保护。**评价**：必要的妥协，但同步保障不完整。

2. **`appState` 集中管理 vs 分散注入**：`appState` 集中了所有主进程状态，通过 `IpcContext` 和 `SpriteEventBridgeDeps` 等接口注入到各模块。`createIpcContext` / `createSilentModeCallbacks` 等工厂函数避免了重复构造。**评价**：设计优秀，状态流向清晰。

3. **`minimalHandlers` 与 `registerIpcHandlers` 的分层**：最小化 IPC（Agent 未就绪时可用）与完整 IPC（Agent 就绪后）分层注册，确保了配置缺失时用户仍可打开设置面板。**评价**：设计合理，职责清晰。

4. **`pasteCoordinator` 从 `QuickInputWindow` 抽离**：将自动粘贴的编排逻辑独立为 `PasteCoordinator` 类，`QuickInputWindow` 仅负责窗口管理 + IPC 路由。**评价**：符合 ADR-017 架构层分离原则。

---

## 5. 重点关注项逐项分析

### 5.1 IPC handler 职责单一性、输入校验、错误兜底

- **职责单一性**：`chatHandlers.ts` 仅注册通道，流式逻辑委托给 `chatStreamHandler.ts`。各 handler 文件按领域划分（memory/config/session/system/suggestion/workProjection），职责清晰。
- **输入校验**：`inputValidation.ts` 提供了 `validated` 包装器，但并非所有 handler 都使用（见 P1-2）。
- **错误兜底**：大部分 handler 有 `try/catch` 包装，错误通过 `errorHandler.handle` 或 `logger.error` 上报。`chatStreamHandler.ts` 的异常处理尤其完善（区分用户中断 vs 错误，超时兜底）。

### 5.2 IPC 通道数量（115 个）

- 当前 115 个，距离 130 治理阈值 15 个余量
- 通道按领域分组后语义清晰，未出现"万能通道"反模式
- 可合并通道组见 P2-1（预计可减少 9-18 个）
- **结论**：暂时不强制合并，通道数达到 130 时执行合并方案

### 5.3 窗口状态机（tray/float/full 三态）

- `windowState.ts` 实现了三态状态机，`transition()` 方法有幂等保护（`target === this.state` 早返回）
- 显示器边界校验（`clampFloatPositionToDisplay` / `clampFullWindowBoundsToDisplay`）处理了多显示器断开外接场景
- 窗口 resize/move 事件防抖 500ms 持久化边界
- 浮动窗口位置通过 `FLOAT_SIZE` CSS 变量统一管理（`floatSize` 为定义源）
- `windowUtils.ts` 的 `isFullWindowAccessible` 作为 type guard 统一了窗口可见性判断
- **结论**：状态机设计正确，边界处理完善

### 5.4 BrowserWindow 生命周期管理

- `windowManager.ts` 管理 `fullWindow` + `floatWindow` 的创建和销毁
- `before-quit` 流程：`setQuitting(true)` → 中断对话 → 注销快捷键 → 停止剪贴板轮询 → 销毁快速输入浮窗 → 停止统计 → 关闭 Sprite → 销毁托盘 → 关闭窗口 → `nullifyAllComponents` → `app.exit(0)`
- `isQuitting` 标志防止 `before-quit` 重复触发
- `window-all-closed` 事件不退出（托盘常驻）
- 窗口 resize/move 监听在 `closed` 事件中清理防抖定时器
- **结论**：生命周期管理严格，无泄漏风险

### 5.5 preload 脚本的 contextBridge 暴露面

- **主 preload.ts**：暴露 ~100+ 方法，接口体量大但每个方法都是 `ipcRenderer.invoke/send` 的薄包装。`preloadFloat.ts` 仅暴露 8 个方法，`preloadQuickInput.ts` 仅暴露 10 个方法，正确实施了最小权限。
- 所有 `ipcRenderer.on` 监听器都提供了对应的 `remove*Listener` 方法
- `contextBridge` 条件保护（`typeof contextBridge !== 'undefined'`）兼容测试环境
- **结论**：主 preload 暴露面大但无安全风险（所有方法都是 IPC 通道的薄包装），浮动/快速输入 preload 最小权限实践优秀

### 5.6 主进程异常处理

- `process.on('unhandledRejection')` + `process.on('uncaughtException')` 全局兜底
- `ErrorHandler` 类提供结构化错误处理：`normalizeError` → `showErrorToUser` → `logError`
- 错误码体系（`ErrorCode`）覆盖 8 种错误类型，用户友好消息映射
- `chatStreamHandler.ts` 区分用户中断 vs 系统错误，中断不记录为 error
- `spriteEventBridge.ts` 的 `unsubscribeSpriteEvents` 中取消订阅失败仅 warn 不阻断
- **结论**：异常处理体系完善，进程不会因未捕获异常静默崩溃

### 5.7 跨进程数据传递

- 剪贴板内容：仅传 `preview`（前 100 字符）+ `length`，不传完整内容
- 写入确认：`beforeContent` / `afterContent` 截断到 10KB
- 流式输出：累积文本通过 IPC 逐 chunk 推送，每次发送完整累积文本（非 delta）
- 快速输入：`confirmQuickInput` 的 `text` 通过 IPC invoke 传递，无法绕过
- PowerShell 窗口标题：通过临时文件 I/O 传递 UTF-16LE 字节（ADR-SP-018），避免 stdout 管道编码污染
- **结论**：大数据传递策略正确，没有大文件/大文本走 IPC 的情况

### 5.8 快捷键注册

- `ShortcutManager` 通过依赖注入 `globalShortcut` 接口实现可测试性
- 注册失败时通知用户（系统通知，列出被占用的快捷键）
- 支持热更新 `updateShortcut`（先注销旧再注册新）
- 支持批量配置替换 `setConfig`（`unregisterAll` → 替换配置 → `registerAll`）
- 应用退出时 `unregisterAll` 清理
- `enabled=false` 时跳过所有注册
- **结论**：快捷键管理完善，冲突处理友好

### 5.9 fs 操作的错误处理

- `main.ts` 中 `fs.access(TRAY_ICON_PATH)` 用 `.then().catch()` 降级
- `pasteCoordinator.ts` 中 `getWindowTitleViaPS` 的临时文件读写有完善的 `try/catch/finally` 清理
- `skillInstaller.ts` 的文件写入有校验
- `configHandlers.ts` 的配置读写有 try/catch
- **结论**：fs 操作错误处理完善，`ENOENT` / 权限问题不会导致进程崩溃

### 5.10 类型安全与 any 滥用

- `appState` 使用 `null!` 断言（3 处）—— 见 P1-3
- `inputInjector.ts:350` 的 `as unknown as NutJsWindow` —— 见 P3-1
- `inputInjector.ts:361-364` 的 `as NutJsKeyType[]` 类型断言，用于 nut-js keyboard 方法类型适配
- `preload.ts` 的 `onSpriteEvent` 回调中 `payload: unknown` 未做运行时类型校验
- 其余位置类型使用规范，`unknown` 替代 `any` 使用得当
- **结论**：类型安全整体良好，`as` 断言集中在 nut-js 适配层（有文档说明），业务层类型使用规范

---

## 6. 修复建议汇总

| 编号 | 优先级 | 问题 | 修复方向 | 预估影响 |
|------|--------|------|----------|----------|
| P1-1 | 高 | `preloadFloat.ts` / `preloadQuickInput.ts` 无通道同步测试 | 补充 parity 测试的子集断言 | 新增测试，无代码变更 |
| P1-2 | 高 | IPC handler 输入校验覆盖不完整 | 统一使用 `validated` 包装所有外部输入 | 修改 ~5-8 个 handler 注册点 |
| P1-3 | 高 | `appState` 的 `null!` 断言运行时风险 | 改为 `T | null` + 可选链 | 修改 `main.ts` 3 处 |
| P2-1 | 中 | IPC 通道数 115，可合并 9-18 个 | 合并 4 组通道，减少至 106 | 修改 `channels.ts` + 各 handler |
| P2-2 | 中 | `preload.ts` 暴露面过大 | 暂无行动（当前设计合理） | 无 |
| P2-3 | 中 | `extractErrorCode` 降级路径误匹配 | 改用系统错误码前缀匹配 | 修改 `errorHandler.ts` 1 处 |
| P3-1 | 低 | `as unknown as NutJsWindow` 绕过类型检查 | nut-js 升级时验证 | 无代码变更 |
| P3-2 | 低 | 临时文件清理竞态 | 可选：启动时清理残留 | 新增 ~5 行 |
| P3-3 | 低 | djb2 哈希碰撞 | 不需要修改 | 无 |
| P4-1 | 观察 | `boundsSaveTimer` 防抖丢失最后位置 | `before-quit` 追加 `saveBounds` | 修改 `main.ts` 1 处 |
| P4-2 | 观察 | `proactiveTrayResetTimer` 清理不完整 | 提升为模块级变量 | 修改 `spriteEventBridge.ts` 1 处 |

---

## 7. 与前序步骤的交叉验证

| 前序发现 | 本次验证结果 |
|---------|-------------|
| Step 1 内核审查：无直接交叉 | — |
| Step 2 存储层审查：`SqliteStorage` 在宿主层实现 | 确认：主进程通过 `startSprite()` 获取 `sessionStore`，存储层不在主进程审查范围 |

---

## 8. 下一步

Step 4（sprite 控制器层）审查范围：
- `src/sprite/controllers/`：各控制器职责、依赖方向、错误处理
- 控制器与主进程的 IPC 交互接口
- 控制器内部状态管理

建议在 Step 4 中重点关注：
1. 控制器层与主进程 IPC handler 的接口一致性（是否有 handler 调用了不存在的控制器方法）
2. 控制器层的依赖注入是否合理（是否反向依赖了 Electron 层）
3. 控制器层是否有独立的单元测试覆盖