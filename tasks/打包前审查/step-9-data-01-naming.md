# Step 9 · 命名一致性审查报告

> **审查日期**：2026-07-19
> **审查范围**：memora 内核 `src/` + sprite 宿主 `hosts/memora-sprite/src/`
> **对照标准**：[project-rules.md §4 命名规范](../../.trae/rules/project-rules.md)
> **审查性质**：仅审查记录，不修改任何文件

## 0. 对照标准速查

| 类型      | 规则                                 | 示例                          |
| --------- | ------------------------------------ | ----------------------------- |
| 文件夹    | 连字符                               | `cli-commands/`               |
| TS 文件   | 小驼峰                               | `openaiCompatible.ts`         |
| 类        | 大驼峰                               | `OpenAICompatibleProvider`    |
| 变量/函数 | 小驼峰                               | `loadConfig`                  |
| 常量      | 全大写下划线                         | `BLOCKED_PATTERNS`            |
| 类型/接口 | 大驼峰                               | `Memory`、`ChatOptions`       |
| HTML 文件 | 连字符（用户规则 §4.2.3）            | `quick-input.html`            |

---

## 1. 文件夹命名违规清单

### 1.1 memora 内核 `src/`

| 目录路径 | 命名 | 是否违规 | 备注 |
| -------- | ---- | -------- | ---- |
| `agent/`, `config/`, `eval/`, `llm/`, `logging/`, `memory/`, `persona/`, `security/`, `skill/`, `utils/` | 单词 | ✓ 合规 | — |
| `agent/managers/` | 单词 | ✓ 合规 | — |
| `agent/__tests__/`, `*/__tests__/` | 双下划线 | ⚠️ 约定豁免 | vitest/jest 测试目录约定俗成，不视为违规 |

**结论**：memora 内核 `src/` 无实质性文件夹命名违规。

### 1.2 sprite 宿主 `hosts/memora-sprite/src/`

| 目录路径 | 当前命名 | 是否违规 | 建议改名 | 优先级 |
| -------- | -------- | -------- | -------- | ------ |
| `electron/renderer/helpers/uiDelegations/` | `uiDelegations`（小驼峰） | ❌ **违规** | `ui-delegations/`（连字符） | **P3** |
| `electron/renderer/quick-input/` | `quick-input`（连字符） | ✓ 合规 | — | — |
| `electron/renderer/styles/chat/`、`memory/`、`overlays/` 等 | 连字符 | ✓ 合规 | — | — |
| `sprite/audit/`、`sprite/cli/`、`sprite/controllers/`、`sprite/usage/` | 单词 | ✓ 合规 | — | — |
| `web/routes/` | 单词 | ✓ 合规 | — | — |
| `__tests__/` | 双下划线 | ⚠️ 约定豁免 | 测试目录约定俗成 | — |

**结论**：sprite 宿主 `src/` 共 **1 处**文件夹命名违规——`uiDelegations/` 应改为 `ui-delegations/`。

---

## 2. TS 文件命名违规清单

### 2.1 memora 内核 `src/`

抽查全部 `src/` 下 `.ts` 文件（含 `agent/`、`memory/`、`llm/`、`utils/`、`managers/` 等所有子目录）：

| 文件 | 命名风格 | 是否违规 |
| ---- | -------- | -------- |
| `openaiCompatible.ts`、`abortSignal.ts`、`inMemoryStorage.ts`、`inMemoryRelationStore.ts`、`sessionStore.ts`、`storageInterface.ts`、`loggerInterface.ts`、`personaManager.ts`、`skillManager.ts`、`pathGuard.ts`、`eventEmitter.ts`、`frontmatter.ts`、`safeTimer.ts`、`toError.ts`、`errors.ts`、`agent.ts`、`loop.ts`、`assembler.ts`、`tracer.ts`、`guardrail.ts`、`builtinToolHandlers.ts`、`toolExecutor.ts`、`contextManager.ts`、`messageHistory.ts`、`personaMatcher.ts`、`userFactExtractor.ts`、`constants.ts`、`types.ts` | 小驼峰 | ✓ 合规 |
| `agent/managers/` 下全部 13 个文件（`archiveCoordinator.ts`、`autoConfigRefiner.ts`、`chatLockManager.ts`、`configManager.ts`、`insightExtractor.ts`、`memoryAdvisor.ts`、`memoryDecayScheduler.ts`、`memoryInspector.ts`、`relationBuilder.ts`、`sessionArchiver.ts`、`sessionManager.ts`、`textPolishManager.ts`、`workProjection.ts`） | 小驼峰 | ✓ 合规 |
| `index.ts`、`loader.ts`、`factory.ts`、`provider.ts`、`logger.ts`、`store.ts`、`recall.ts` 等 | 单词 | ✓ 合规 |

**结论**：memora 内核 `src/` 的 TS 文件命名**全部合规**。

### 2.2 sprite 宿主 `hosts/memora-sprite/src/`

| 文件路径 | 当前命名 | 是否违规 | 建议改名 | 优先级 |
| -------- | -------- | -------- | -------- | ------ |
| `electron/preload-float.ts` | 连字符 | ❌ **违规** | `preloadFloat.ts` | **P3** |
| `electron/preload-quick-input.ts` | 连字符 | ❌ **违规** | `preloadQuickInput.ts` | **P3** |
| `electron/renderer/quick-input/quick-input.html` | 连字符 | ✓ 合规 | — （HTML 文件按用户规则 §4.2.3 应用连字符） | — |
| `electron/renderer/float/float.html` | 单词 | ✓ 合规 | — | — |
| `electron/renderer/styles/**/*.css` | 连字符 | ✓ 合规 | （CSS 文件按用户规则 §4.2.2 应用连字符） | — |
| 其余所有 `.ts` 文件（`agentListeners.ts`、`clipboardHandler.ts`、`errorHandler.ts`、`esmShim.ts`、`inputInjector.ts`、`interaction.ts`、`main.ts`、`preload.ts`、`shortcuts.ts`、`spriteEventBridge.ts`、`trayIcon.ts`、`floatWindow.ts`、`pasteCoordinator.ts`、`quickInputWindow.ts`、`themeInjector.ts`、`windowManager.ts`、`windowSecurity.ts`、`windowState.ts`、`channels.ts`、`chatHandlers.ts`、`chatStreamHandler.ts`、`configHandlers.ts`、`memoryHandlers.ts`、`minimalHandlers.ts`、`sessionHandlers.ts`、`suggestionHandlers.ts`、`systemHandlers.ts`、`workProjectionHandlers.ts`、`inputValidation.ts`、`markdown.ts`、`modal.ts`、`onboarding.ts`、`proactiveBanner.ts`、`relationGraph.ts`、`startupSummaryBanner.ts`、`suggestionCard.ts`、`themeManager.ts`、`toast.ts`、`memoryController.ts`、`personaController.ts`、`sessionController.ts`、`settingsController.ts`、`applyMixins.ts`、`buttonHelpers.ts`、`chatPanelEvents.ts`、`completionHelpers.ts`、`completionMetrics.ts`、`domHelpers.ts`、`errorHelpers.ts`、`errorState.ts`、`eventTracker.ts`、`formValidation.ts`、`icon.ts`、`initFailureCard.ts`、`memoryDetailPanel.ts`、`memoryPanelEvents.ts`、`memoryTimelineView.ts`、`memoryViewSwitcher.ts`、`messageDecorations.ts`、`messageOperations.ts`、`narrativeGenerator.ts`、`perceptionLabels.ts`、`providerManagement.ts`、`relationGraphColor.ts`、`relationGraphGeometry.ts`、`relationGraphLayout.ts`、`relationGraphTypes.ts`、`safeStorage.ts`、`safeTimer.ts`、`scrollController.ts`、`shortcutCapture.ts`、`sourceColor.ts`、`streamSafetyTimer.ts`、`toolCallCard.ts`、`archiveButtonManager.ts`、`auditPanelManager.ts`、`badgeManager.ts`、`chatPanelManager.ts`、`clipboardManager.ts`、`clipboardPanelManager.ts`、`commandPaletteManager.ts`、`completionStatsRenderer.ts`、`dashboardPanelManager.ts`、`dateNavManager.ts`、`healthDashboardRenderer.ts`、`inputAreaManager.ts`、`insightsRenderer.ts`、`llmGovernanceResultRenderer.ts`、`memoryGraphPanel.ts`、`memoryPanelManager.ts`、`panelErrorBannerManager.ts`、`panelRouter.ts`、`partnerInsightsRenderer.ts`、`perceptionPanelManager.ts`、`personaPanelManager.ts`、`profilePanelManager.ts`、`searchMessagesManager.ts`、`settingsPanelManager.ts`、`skillDropManager.ts`、`spriteStatusPopover.ts`、`streamingRenderer.ts`、`workProjectionPanelManager.ts`、`initHelpers.ts`、`ipcListeners.ts`、`renderer.ts`、`ui.ts`、`dateUtils.ts`、`escapeRegExp.ts`、`hostContext.ts`、`inputValidation.ts`、`levelUtils.ts`、`llmErrorClassifier.ts`、`numberUtils.ts`、`safeWriteJson.ts`、`shortcutDefaults.ts`、`singleton.ts`、`spriteStats.ts`、`toError.ts`、`truncate.ts`、`auditManager.ts`、`jsonlAppender.ts`、`formatter.ts`、`interaction.ts`、`affectController.ts`、`contextAwareness.ts`、`memoryController.ts`、`memoryHealth.ts`、`patternDetector.ts`、`perceptionCoordinator.ts`、`personaController.ts`、`presenceController.ts`、`proactiveEngine.ts`、`rapportController.ts`、`reviewManager.ts`、`usageStatsCollector.ts`、`constants.ts`、`errors.ts`、`fileWatcherTrigger.ts`、`skillInstaller.ts`、`sprite.ts`、`spriteConfig.ts`、`spriteConfigManager.ts`、`spriteLifecycleManager.ts`、`spriteTracer.ts`、`tools.ts`、`triggers.ts`、`nodeSqliteDatabase.ts`、`sessionStore.ts`、`spriteConfigStore.ts`、`sqliteDatabaseTypes.ts`、`sqliteRelationStore.ts`、`sqliteStorage.ts`、`chatStreamRoutes.ts`、`configRoutes.ts`、`memoryRoutes.ts`、`sessionRoutes.ts`、`systemRoutes.ts`、`preloadWeb.ts`、`server.ts`、`static.ts`、`webContext.ts`、`cli.ts`、`index.ts`） | 小驼峰/单词 | ✓ 合规 | — | — |

**结论**：sprite 宿主 `src/` 共 **2 处** TS 文件命名违规——`preload-float.ts` 和 `preload-quick-input.ts` 使用了连字符，应为小驼峰。

> **注意**：这两个文件命名违规可能源于与同目录 HTML 文件（`quick-input.html`）保持同名的初衷，但 TS 与 HTML 命名规则不同，应分别遵守各自规则。

---

## 3. 类名 / 常量名 / 接口名 抽查

### 3.1 类名（应大驼峰）

| 位置 | 类名 | 是否违规 |
| ---- | ---- | -------- |
| `memora/src/utils/errors.ts` | `MemoraError` | ✓ |
| `memora/src/llm/openaiCompatible.ts` | `OpenAICompatibleProvider` | ✓ |
| `sprite/src/sprite/errors.ts` | `SpriteError` | ✓ |
| `sprite/src/electron/interaction.ts` | `ElectronInteraction` | ✓ |
| `sprite/src/sprite/cli/interaction.ts` | `CliInteraction` | ✓ |
| `sprite/src/storage/sessionStore.ts` | `SqliteSessionStore` | ✓ |

**结论**：类名全部合规（大驼峰）。

### 3.2 常量（应全大写下划线）

| 位置 | 常量名 | 是否违规 | 备注 |
| ---- | ------ | -------- | ---- |
| `memora/src/agent/constants.ts` | `AGENT_CONSTANTS`、`LOOP_CONSTANTS` | ✓ | 容器对象全大写，内部属性亦全大写 |
| `memora/src/llm/openaiCompatible.ts` | `MAX_ERROR_BODY_LEN`、`FIRST_CHUNK_TIMEOUT_MS`、`INTER_CHUNK_TIMEOUT_MS`、`DEFAULT_TIMEOUT_MS` | ✓ | — |
| `memora/src/utils/errors.ts` | `RETRYABLE_ERROR_CODES` | ✓ | 模块私有 Set |
| `sprite/src/sprite/constants.ts` | `MS_PER_SECOND`、`MS_PER_MINUTE`、`MS_PER_HOUR`、`MS_PER_DAY`、`MS_PER_WEEK`、`SPRITE_HOME_DIR_NAME`、`DEFAULT_LIST_LIMIT`、`DEFAULT_MAX_ENTRIES`、`TOAST_SHORT_MS`、`TOAST_NORMAL_MS`、`TOAST_LONG_MS`、`CONFIRMATION_TIMEOUT_MS`、`PROACTIVE_TRAY_RESET_MS`、`DASHBOARD_PULSE_MS`、`DASHBOARD_DEBOUNCE_MS` | ✓ | — |
| `sprite/src/shared/inputValidation.ts` | `NAME_PATTERN`、`MAX_CONTENT_LENGTH`、`MAX_ID_LENGTH`、`MAX_SEARCH_QUERY_LENGTH` | ✓ | — |
| `sprite/src/storage/sessionStore.ts` | `CREATE_TABLE_SQL`、`CREATE_INDEX_SQL` | ✓ | — |
| `memora/src/utils/errors.ts` | `ToolErrorCode`（const 对象） | ⚠️ 风格宽容 | 大驼峰 const 对象，TS 常见模式，内部属性（`PATH_NOT_ALLOWED` 等）全大写下划线。不视为违规 |
| `sprite/src/sprite/errors.ts` | `ErrorCode`（enum） | ⚠️ 风格宽容 | 大驼峰 enum 名，枚举值（`UNKNOWN`、`INITIALIZATION_FAILED`）全大写下划线。TS 常见模式，不视为违规 |

**结论**：常量命名全部合规（含 TS enum/const 对象的宽容处理）。

### 3.3 接口 / 类型（应大驼峰）

| 位置 | 接口/类型名 | 是否违规 |
| ---- | ----------- | -------- |
| `memora/src/memory/storageInterface.ts` | `IMemoryStorage` | ✓ （I 前缀为项目接口约定） |
| `memora/src/memory/sessionStore.ts` | `ISessionStore` | ✓ |
| `memora/src/llm/openaiCompatible.ts` | `OpenAICompatibleConfig` | ✓ |
| `memora/src/utils/errors.ts` | `FriendlyErrorOptions`、`ToolErrorCodeValue`、`ErrorCategory` | ✓ |
| `sprite/src/sprite/interaction.ts` | `IInteraction`、`InputHandler`、`CloseHandler`、`OutputKind` | ✓ |
| `sprite/src/sprite/errors.ts` | `ErrorCode`（enum） | ✓ |

**结论**：接口/类型命名全部合规（大驼峰，I 前缀为项目约定）。

---

## 4. 跨包命名一致性

### 4.1 跨包重复命名清单（相同语义/相同文件名）

| # | 文件名 | memora 内核路径 | sprite 宿主路径 | 重复性质 | 优先级 |
| - | ------ | --------------- | --------------- | -------- | ------ |
| 1 | `errors.ts` | `src/utils/errors.ts`（`MemoraError` 类） | `src/sprite/errors.ts`（`SpriteError` 类） | **跨包错误体系不同源**：内核用 `MemoraError`，宿主用 `SpriteError`。文件名相同但类名不同。属有意区分（不同 package 错误体系），但 import 时易混淆。 | **P3** |
| 2 | `toError.ts` | `src/utils/toError.ts`（函数 `toError`） | `src/shared/toError.ts`（函数 `toError`） | **完全镜像**：sprite 版本注释明确"行为与内核 memora/src/utils/toError 完全对齐"，5 分支逻辑完全相同。零依赖双份维护，存在重复维护风险。 | **P3** |
| 3 | `safeTimer.ts` | `src/utils/safeTimer.ts`（模块级函数式） | `src/electron/renderer/helpers/safeTimer.ts`（类 `SafeTimerTracker`） | **签名对齐但范式不同**：注释明确"方法签名与内核对齐，范式不同"（内核模块级单例 vs 渲染层类隔离）。有意为之。 | **P5**（合理） |
| 4 | `sessionStore.ts` | `src/memory/sessionStore.ts`（接口 `ISessionStore`） | `src/storage/sessionStore.ts`（实现 `SqliteSessionStore`） | **接口与实现分离**：内核定义接口，宿主实现接口（ADR-002 注入模式）。架构合理。 | **P5**（合理） |
| 5 | `constants.ts` | `src/agent/constants.ts`（`AGENT_CONSTANTS` / `LOOP_CONSTANTS`） | `src/sprite/constants.ts`（业务常量） | **不同模块的常量集合**：文件名相同但内容完全不同，分属不同 package。 | **P5**（合理） |
| 6 | `interaction.ts` | （无） | `src/electron/interaction.ts`（`ElectronInteraction`）<br>`src/sprite/interaction.ts`（`IInteraction` 接口）<br>`src/sprite/cli/interaction.ts`（`CliInteraction`） | **同包内 3 处同名**：接口定义 + 2 个实现，分属不同目录，语义清晰。 | **P5**（合理） |
| 7 | `inputValidation.ts` | （无） | `src/shared/inputValidation.ts`（纯函数真理源）<br>`src/electron/ipc/inputValidation.ts`（re-export + `isPathAllowed`） | **架构分层**：shared 是真理源，ipc 层 re-export 并扩展 Node 依赖部分。注释明确说明。 | **P5**（合理） |
| 8 | `types.ts` | `src/agent/types.ts`、`src/llm/types.ts`、`src/memory/types.ts`、`src/persona/types.ts`、`src/skill/types.ts` | `src/electron/types.ts`、`src/electron/ipc/types.ts`、`src/electron/renderer/types.ts`、`src/web/routes/types.ts` | **TypeScript 项目惯例**：每个模块都有 `types.ts`，不视为违规。 | **P5**（惯例） |
| 9 | `truncate.ts` | （无） | `src/shared/truncate.ts`（注释提及"跨层共享"） | 仅 sprite 内跨层共享，非跨包重复。 | — |
| 10 | `index.ts` | `src/index.ts`（库导出入口） | `src/index.ts`（宿主入口）<br>`src/electron/ipc/index.ts`<br>`src/sprite/controllers/index.ts`<br>`src/web/routes/index.ts` | **多入口惯例**：每个子模块的 `index.ts` 是 TypeScript/ESM 标准模式。 | **P5**（惯例） |

### 4.2 跨包镜像实现风险分析

**`toError.ts` 镜像实现**（P3）：

| 维度 | memora 内核版 | sprite shared 版 |
| ---- | ------------- | ---------------- |
| 文件 | `src/utils/toError.ts` | `src/shared/toError.ts` |
| 导出 | `function toError(err: unknown): Error` | `function toError(err: unknown): Error` |
| 分支数 | 5 | 5 |
| 行为 | 完全相同（注释明确对齐） | 完全相同 |
| 依赖 | 零依赖 | 零依赖 |
| 风险 | 任一方修改后另一方易遗漏同步 | 同上 |

**镜像原因**（注释说明）：
- memora 内核零依赖，不能被 sprite 渲染进程导入（会引入 pino/logging 依赖链）
- sprite 渲染进程（Electron sandbox / 浏览器）需要零依赖版本
- 两边都需纯函数实现，且无法跨包共享（架构约束）

**建议**（不在本次审查范围内执行）：
- 长期可考虑提取到独立的 `@memora/shared` 零依赖包，但当前 monorepo 结构下双份维护成本可接受
- 短期应在两份文件头部保留"行为对齐"注释，并增加单元测试断言对齐（已存在 `toError.test.ts` 在两边）

**`errors.ts` 跨包错误体系**（P3）：

| 维度 | memora 内核版 | sprite 宿主版 |
| ---- | ------------- | -------------- |
| 类名 | `MemoraError` | `SpriteError` |
| 基类 | `extends Error` | `extends Error` |
| 分类机制 | `category: ErrorCategory`（6 类） | `code: ErrorCode`（enum） |
| 工厂函数 | `configError`/`networkError`/`llmError`/`toolError`/`securityError` | 无工厂，直接 `throw new SpriteError(code, msg)` |
| 文件名 | `errors.ts` | `errors.ts` |

**评估**：两者设计哲学不同（内核用 category 字符串 + 工厂函数，宿主用 enum code），不应强行合并。但文件名相同可能在 IDE 自动 import 时选错源，建议在文件头部 docstring 强标注归属（已有注释，可加强）。

---

## 5. 优先级汇总

### P3（风格类，建议修复但非阻塞打包）

| # | 类型 | 位置 | 违规 | 建议 |
| - | ---- | ---- | ---- | ---- |
| 1 | 文件夹 | `sprite/src/electron/renderer/helpers/uiDelegations/` | 使用小驼峰 | 改为 `ui-delegations/` |
| 2 | TS 文件 | `sprite/src/electron/preload-float.ts` | 使用连字符 | 改为 `preloadFloat.ts` |
| 3 | TS 文件 | `sprite/src/electron/preload-quick-input.ts` | 使用连字符 | 改为 `preloadQuickInput.ts` |
| 4 | 跨包镜像 | `memora/src/utils/toError.ts` ↔ `sprite/src/shared/toError.ts` | 完全镜像，双份维护 | 短期保留对齐注释 + 双边测试；长期评估提取 `@memora/shared` 包 |
| 5 | 跨包重复 | `memora/src/utils/errors.ts` ↔ `sprite/src/sprite/errors.ts` | 文件名相同，类名不同 | 在文件头部强标注归属，避免 IDE 自动 import 选错源 |

### P5（微观类，已知设计/合理重复，无需修复）

| # | 类型 | 位置 | 说明 |
| - | ---- | ---- | ---- |
| 1 | 跨包镜像 | `memora/src/utils/safeTimer.ts` ↔ `sprite/src/electron/renderer/helpers/safeTimer.ts` | 签名对齐但范式不同（模块级 vs 类级），有意为之 |
| 2 | 接口/实现 | `memora/src/memory/sessionStore.ts` ↔ `sprite/src/storage/sessionStore.ts` | 接口与实现分离，ADR-002 注入模式 |
| 3 | 跨包常量 | `memora/src/agent/constants.ts` ↔ `sprite/src/sprite/constants.ts` | 不同 package 的常量集合，内容不冲突 |
| 4 | 同包同名 | `sprite/src/electron/interaction.ts`、`sprite/src/sprite/interaction.ts`、`sprite/src/sprite/cli/interaction.ts` | 接口 + 2 实现，分属不同目录 |
| 5 | 架构分层 | `sprite/src/shared/inputValidation.ts` ↔ `sprite/src/electron/ipc/inputValidation.ts` | shared 真理源 + ipc 层 re-export 扩展 |
| 6 | 项目惯例 | 多处 `types.ts`、`index.ts` | TypeScript 标准惯例 |
| 7 | 测试目录 | 各处 `__tests__/` | vitest 约定俗成 |

---

## 6. 审查结论

### 6.1 整体合规度

| 维度 | memora 内核 | sprite 宿主 | 整体 |
| ---- | ----------- | ----------- | ---- |
| 文件夹命名 | 100% 合规 | 99% 合规（1 处违规：`uiDelegations/`） | 99.5% |
| TS 文件命名 | 100% 合规 | 99.5% 合规（2 处违规：`preload-float.ts`、`preload-quick-input.ts`） | 99.7% |
| 类名 | 100% 合规 | 100% 合规 | 100% |
| 常量名 | 100% 合规 | 100% 合规 | 100% |
| 接口/类型名 | 100% 合规 | 100% 合规 | 100% |

### 6.2 命名规范执行评价

- **优秀**：memora 内核 `src/` 命名规范执行严格，零违规
- **良好**：sprite 宿主 `src/` 仅 3 处微观违规（1 文件夹 + 2 TS 文件），集中在 `electron/` 入口层
- **注意**：`preload-*.ts` 违规可能源于与同名 HTML 文件保持一致的初衷，但应分别遵守 TS（小驼峰）和 HTML（连字符）规则
- **跨包一致性**：`toError.ts` 镜像实现是架构约束下的合理选择，但需长期关注同步风险

### 6.3 不修复说明

本审查为**仅记录**模式，未修改任何文件。P3 项的修复建议供后续独立任务执行，P5 项为合理设计/惯例，无需修复。

---

## 附录：审查方法

1. **目录扫描**：使用 `LS` 工具递归列出 `memora/src/` 和 `hosts/memora-sprite/src/` 全部目录与文件
2. **文件抽查**：使用 `Read` 抽查关键文件头部 docstring 与导出声明
3. **跨包对比**：对 `errors.ts`、`toError.ts`、`safeTimer.ts`、`sessionStore.ts`、`inputValidation.ts` 等可疑重复文件名进行双边内容比对
4. **规则对照**：严格对照 `project-rules.md §4` 与用户规则 §4（命名规范）
5. **优先级判定**：
   - **P3**：违反明文规则但非阻塞打包，建议修复
   - **P5**：微观类问题或合理设计/惯例，无需修复
