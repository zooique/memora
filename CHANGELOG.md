# Changelog

本文件记录 **@zooique/memora（内核 npm 包）**的版本变更。**宿主**（`hosts/memora-vscode`）不在发布包 `files` 白名单内（见 `package.json`），不占内核版本号：内核变更定档独立版本号（当前 **[5.0.0]** 开发中），宿主变更在 `[Unreleased] · 宿主`（随做随用，攒批随 `vsce package` 定版，ADR-033）。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> **版本定位（v5.0.0）**：**Node.js 专属 · 零第三方运行时依赖的 Agent 内核**（依赖 `node:*` 内置模块，不引第三方运行时依赖 / native / 宿主 API）。**4.0.0**：导出面收敛（−54）+ `agent.memory.search()` 退役（唯一入口 `searchByKeyword()`）。**5.0.0（当前）**：公开面大收面（删 23 导出 + 32 成员 + 3 事件）+ 多项目形态定案（一个 Agent = 一个项目）+ 三套空转机制退役 + SQLite 存储——逐项改法见[升级指南](docs/memora-升级指南-4.x-到-5.0.0.md)。**4.0.0 及更早版本全文**：`docs/CHANGELOG-归档.md`（仓库内归档，npm 包不含）。内核不内置 agent 级行为评估（eval）/ 独立验证——由宿主基于内核可观测性（ITracer / 事件 / 指纹）自行承担；内核对接口契约与全量单测负责，不对"agent 整体行为稳定"作承诺。
>
> 本文件 2026-10-19 起按 `CHLOG-TRIM-1` 精简：只记「改了什么 + 为什么 + 对消费者的影响」；逐批拍板过程、变异验证收据、台账叙事的 SSOT 在仓库台账 `tasks/待完成任务.md` 对应 ID 条目（npm 包不含），此处只留 ID 锚保交叉引用。

## [5.0.0] · 未发布

> **📖 升级必读**：[`docs/memora-升级指南-4.x-到-5.0.0.md`](docs/memora-升级指南-4.x-到-5.0.0.md) —— 本区所有 Breaking 项的**改法**逐项在那篇，本区不重复**怎么改**。
> 本区归属：仅**内核**变更；SemVer = **major**（编译期破坏：删 23 个导出符号 + 32 个公开成员 + 3 个事件）。

### ⚠️ Breaking Removed（内核）

**多项目链整体删除（形态定案：一个 Agent = 一个项目 · `PR-SWITCH-1` / `PR-SWITCH-2` / `PUB-API-PRUNE-3`）**

- 删：`Agent.switchProject()` / `projectSwitched` 事件 / `AgentOptions.registryDir` / `agent.projects`（`list`·`registerProject`·`unregisterProject`）/ `ProjectRegistry` 类导出 / `ProjectEntry` 类型 / `projects.json` 写入 / `Agent.init(projectPathOverride?)` 的路径参数（变无参）/ `Agent.rebuildComponents()`。
- 为什么：注入的 storage **不随切换重建**——切了项目、存储不跟着换，**用了会错**（不是「没人用」）。多项目改用「宿主为每个项目各建一个 Agent 实例」；项目名推断摘为 `projectManager` 模块级纯函数保留。

**目标漂移检测链退役（`GOAL-DRIFT-1`）**

- 删：`SessionManager.updateGoal()` / `goalDriftDetected` 事件 / `SessionCheckpoint` 的 `mainGoal`·`currentGoal`·`goalChangeSeq` / `createCheckpoint(mainGoal?)` 入参（变无参，返回类型收窄为非 null）/ `goalConsistencyChecker` 整模块。
- 为什么：字面相似度判据实测**零区分度**（12 组正常子任务 12/12 判漂移，与 6 组真漂移完全不可分）；「两段文本是否意图一致」属语义判断，内核零依赖架构下永无可接模型。目标偏离防范交还用户在环 + `ask_user`（引导句属角色包 `rules.md` 范畴，当前零配置，见台账 `GOAL-DRIFT-2`）。

**记忆治理门面退役（`GOVERNANCE-SRC-1`）**

- 删：`MemoryGovernance` 类导出 / `agent.governance` getter / `dedupCompleted` 事件 / 装配产物 `dedupManager`·`memoryAdvisor`。
- 为什么：`deduplicate()` / `detectConflicts()` / `suggest()` 逐 `GOVERNANCE_SOURCES` 取样，而该常量是**字面量空数组**——代码路径永远拿不到输入，去重数恒 0、冲突报告恒空、推荐恒 `[]`。唯一有效的 `sourceHealth()` 计数口径已由 `agent.memory.stats().bySource` 覆盖（`daysSinceLastAccess` / `diagnosedAt` 无替代，宿主从未消费）。**写时治理不受影响**：`supersede` 写时取代 + `supersededBy` 软指针才是真实生效的治理路径。

**公开面通用工具收面（`PUB-API-PRUNE-1`，函数本体保留在内核内部）**

- 删导出：`truncate` / `isPlainObject` / `safeSetTimeout` / `safeSetInterval` / `clearSafeTimeout` / `clearSafeInterval` / `segmentText` / `escapeLike` / `serializeFrontmatter` / `toError`（11 个通用小工具，均与 Agent 领域无关、宿主零 import）+ `createLlmProvider`（与规范入口 `createProviderFromConfig` 重复）。唯一本体同删：`escapeLikeSnippet`（收面后零调用；SQLite 后端自实现仍须转义 `%`/`_` 并 `LIKE ? ESCAPE '\'`，规则在 `IMemoryStorage` 接口注释）。

**内部机制与默认实现收面（`PUB-API-PRUNE-2` / `PUB-API-PRUNE-4`，能力不撤、只收回公开位）**

- 删导出：`safeFetch` / `safeExecuteCode` / `safeSearchProjectFiles` / `safeSearchProjectText`（provider 超时包装，保护仍生效）/ `InMemoryStorage` / `InMemorySessionStore` / `LockManager`（默认实现收回——显式实现接口或用 `createNodeSqliteStorage`）/ `NOOP_TRACER`（不传 `tracer` 即可）/ `RolePackManager.tryBuildMeetingPlan`（队伍数据改经 `getActiveTeam()` / `getTeam()` 取）。
- 删 Agent 转发门面：`appendPlanItem` / `triggerError` / `recover`（经 `agent.sessionManager.*` 可达）；`injectSystemMessage` 无公开替代（需引导模型写在 `chat()` 输入或角色包 rules）。

**Agent / SessionManager 成员删除（`PUB-API-PRUNE-5` · 2026-10-16 两批 · `CHKPT-1/2/3`）**

- Agent：`canContinueWithoutInput()`（软暂停模型下暂停恒安全，可续跑性由 waiting 原因位表达，方法本身是采样时机不可靠的带陷阱死面）/ `getRecentToolExecutions()`（订阅 `tool_start`/`tool_result` 事件自聚合）/ `getBackgroundTaskStats()` / `forceReleaseChatLock()`（承诺的超时兜底从未接线）/ `heartbeat()`（私有 `touchCheckpoint` 的机制外漏）。
- SessionManager：`flushNow()` / `flushOnShutdown()`（检查点不落盘，二者是 no-op 清脏，方法名谎报持久化）/ `loadSessionMessages()`（改锚点不 restore 工作记忆的陷阱出口）/ `restoreSession(date, session)` / `restoreMostRecentSession()`（恢复双入口并入 `switchToSession('YYYY-MM-DD-session')` 复合 ID，最近会话从自己的 store `listSessionMetas()[0]` 取）/ `isPauseLimitReached()` / `getConsecutivePauseCount()` / `resetConsecutivePauseCount()`（连续暂停计数链从未通电，生产恒传 `lowRisk=true`）/ `compensateTool()` / `compensateAllNonIdempotent()`（只生成文案、零状态变更）/ `isPaused()` / `isRunning()`（三态 `'running'|'paused'|'error'` 被两布尔吞掉 error 态——看 `status`）。
- ⚠️ 上述多项随 4.0.0 已发布，直删失去 deprecation 预警期，由本 Breaking 明示；`loadSessionMessages` 原走 `DEPRECATE-1` 周期，用户拍板提前直删。决策依据 = 三面零消费 + 5.0.0 未发布（npm 最新 4.0.0）零外部破坏窗口。

**选项与常量**

- 删 `AgentOptions.fileConsistencyCheck`（透传链路先删后字段零读取的僵尸）/ `LOOP_CONSTANTS.MAX_WEB_SEARCH_CALLS`（搜索上限改策略键后零读取的幽灵旋钮，缺省 6 真源归 `DEFAULT_BEHAVIOR_STRATEGY.global.webSearchLimit`）。

### Added（内核）

- **SQLite 存储切片**（2026-10-16，服务 `DSH-1` / `MCP-SERVER-1`）：`createNodeSqliteStorage(dbPath[, { readOnly: true }])` 工厂 + `ReadOnlyMemoryStorage` 类型导出。基于 `node:sqlite` 内建模块**延迟加载**，零三方依赖、`engines` 不收紧（不可用抛 `NOT_AVAILABLE`）；**可用性判据唯一来源 = 调用工厂结果**（宿主禁自行解析 `process.versions.node`）。只读形态写方法结构上不存在、连接只读模式打开不建库（库缺失抛 `MemoraError{FILE_NOT_FOUND}`，`HOST-ALIGN-1`）。语义与 InMemoryStorage 逐位对齐（共用契约套件参数化跑两实现）；写模式 `journal_mode = WAL`。
- **归档防重意图解耦 + 跨进程持久化**（`ARCH-GAP-2`，2026-10-19）：`ArchiveTriggerOptions.skipIfUnchanged?: boolean`（显式优先，否则随 `autoTriggered`，既有语义不动）；防重快照落盘副本 `SessionMeta.archivedMessageCount`（内存 Map 优先双源读写）——宿主重启后不再对「内容未变」的会话重复烧 LLM。
- **记忆命中可见**（`MEM-EVENT-1` / `MEM-EVENT-2` / `MEM-EVENT-3`，2026-10-19）：`memoryRecalled` 载荷补可选 `hits`（命中条目）与 `toolCallId`（与工具调用 1:1 配对，缺省不带键）；`Round.evidence` 新增 `memory_hits` 变体——**实时面走事件、回看面走证据轨**，宿主重放历史轮不再丢命中明细。
- **web_search 增强**（`GUARD-SEARCH-1` / `SEARCH-QUALITY-1` P1-1）：联网搜索硬上限抬为角色包策略键 `webSearchLimit`（1~20，默认 6，与 `askLimit` 同构——只解决「不能调」，不改护栏）；新增裁决证据 `web_search_result`（query/endpoint/count/titles 随 Round 持久化，`toolCallId` 配对根治证据错配，0 结果同样留痕）。
- **悬空取代单一判据**（2026-10-16）：`hasActiveSuperseder()` 导出——替代物经物理删/软删移除时旧摘要回退为当前版本可正常召回；判据与移除路径解耦（原「移除点 eager 收敛」是半修复），零数据删除、不改写入语义。

### Fixed（内核）

- **上下文占用快照补动态注入段**（`CTX-OCC-1`，2026-10-16）：此前漏计全部动态 system 注入（最近对话块/情报区/任务表/压力提示等）⇒ `usedPct` 偏小、用户误以为剩余很多。`ContextOccupancy` 增**必填** `dynamicSystemTokens`（杜绝漏填静默归零），段值单点 `loop.getDynamicSystemTokens()`；截断超窗加观测守卫 + 复用摘要 20% 封顶；估算/实测比 >1.5 告警。
- **登录墙识别 + Bing 摘要错位**（`SEARCH-QUALITY-1` P2，2026-10-15）：HTTP 200 登录页不再被洗成正文交付（保守判墙宁漏勿误）；Bing 解析改 `<li>` 块内提取，根除「标题 + 干扰摘要」错位；`FetchedPage.fetchFailed?: true` 区分抓取失败与空内容（失败不谎报为需登录）。
- **技能脚本 cwd 逃逸**（`SKILL-CWD-1`，2026-10-15）：`run_skill_script` 子进程 cwd 由宿主进程 cwd 改为项目根（实锤事故：29 个文件落进 VS Code 安装目录）；`run_code` 内联模式同批对称收口，四执行面 cwd 判据对称。
- **归档模式顺延契约**（`ARCH-GAP-1` / ADR-041，2026-10-17）：`setArchiveMode` busy 时暂存 + 抛错，`chat()` / `resumeExecution()` 双挂点轮终补执行——「对话结束后生效」从文案承诺变真实现。
- **会话替换入口状态闸对称**（2026-10-16）：`assertSessionReplaceable` 单一前置闸，5 个替换入口全部受「非 running 态拒绝」保护（原仅 `switchSession` 有，暂停/错误态替换会留脏快照）。
- **提问链路收口**（2026-10-15）：回答缺答案落 `[ASK_ABORTED]` 占位（杜绝回填他题答案）；暂停记账统一收口 `pause()`，超时清理在途提问。
- **文档与守卫修正**（`DOC-CLAIM-1` / `GUARD-METHOD-1` / `DIST-ORPHAN-1`，2026-10-18）：README 中英 6 处退役能力宣称收回（「发版即失信」级）；API 手册补 9 字段 + 删幻觉符号；`prepublishOnly` 改 `prepack`（堵 `npm pack` 打出含已删模块的 tarball）；新增手册 interface 成员双向守卫（面 B）。

### Changed（内核）

- **后台任务槽位按 Agent 实例隔离**（`MULTI-AGENT-1`，2026-10-18）：模块级槽位 → `class BackgroundTaskScheduler` 实例级，同进程多 Agent 不再交叉等待/挤占（形态定案后多实例是必然）。非公开 API 变更。

## [Unreleased] · 宿主（随做随用 · 不占内核版本号）

> 仅**宿主**（`hosts/memora-vscode`）变更，攒批随下次 `vsce package` 定版。逐条拍板与变异验证收据见台账对应 ID。

### Added（宿主）

- **manual 归档入口**（`ARCH-GAP-2`，2026-10-19）：历史浮层「移入留存区」双动作 = 本地留存 + `agent.archiveSession(…, { skipIfUnchanged: true })`；「归档」（LLM 摘要）与「留存」（视图分组）术语显式分家；按钮文案 = 运行时真值（`chat_archive_mode` 推送）。真机验收通过（跨进程防重真实生效）。
- **自定义搜索引擎**（2026-10-13）：五档预设 + 自定义引擎；保存前实测验证门禁 + 差分探针（区分「策略选错」与「0 命中」）；紧凑手风琴编辑器；重名/非 http(s) 护栏；装配侧脏配置过滤。
- **归档模式设置接线**（2026-10-16）：设置面板「记忆」选项卡接 `agent.setArchiveMode()` 三段式，繁忙顺延不谎报「已生效」。
- **暂停按钮投影**（2026-10-16）：TurnState 单通道投影接线——后被 `ARCH-GAP-F1` 撤除门控改恒显示（见 Fixed）。
- **webview 错误边界 + 丢弃留痕**（2026-10-11）：error/unhandledrejection 兜底卡片 + `host_diag` 通道上报扩展日志（装配期错误也能抓）；错位输入丢弃落日志可观测。
- **文件改动可视化**（DIFF-1~4，2026-09-26~28）：真实文件行内高亮 + 标题栏文件级确认/回退 + 块级「接受/拒绝此处」（git `add -p` 同构模型）+ 脚本类写工具 workspace 快照 diff 追踪（`OPAQUE_WRITE_TOOL_NAMES` 单源派生）+ 未保存编辑 fail-closed 模态（W2）+ 大仓库扫描上限守卫。
- **后台任务可见性**（`CMD-1` 阶段 2）：StatusDock 第四条 + 终止按钮；内容签名去重 + ready 全量对齐（防「面板重开条凭空消失」）。
- **角色包策略键编辑**（`RP-EDIT-1`）：16 键键面单源内核 `describeStrategyKeys()`（宿主零清单维护）；保存全链路 extension 侧（全量保真 + 校验拦截 + reload 失效缓存）。
- **命令注册面守卫 + 默认快捷键**（2026-10-11 / `HOST-KB-1`）：`contributes` ↔ `registerCommand` ↔ `keybindings` 四向对拍；`memora.open` 默认 `ctrl+alt+m`。
- **skill 菜单搜索**（`UI-INPUT-3`，2026-10-11）：名称+描述过滤；分容器重建保焦点（真机打字丢焦实锤修复）。附件行 skill chip 归位输入盒内（`UI-INPUT-1`）。
- **角色包「刷新」按钮**（2026-10-08）：用户角色包目录改动免重启生效（`roles_refresh` → `resyncUserPacks`）。
- **终态标签收口底栏**（2026-10-13）：勾/用户中断/异常中断三档统一 `data-status` 载体契约。

### Fixed（宿主）

- **运行时整轮无暂停按钮**（`ARCH-GAP-F1`，2026-10-19）：撤除 `canContinue` 门控全链（采样时机在流前恒 false 且架构上不可靠），running 相位暂停按钮恒显示。
- **记忆命中明细三连修**（`MEM-EVENT-2/3` 宿主侧，2026-10-19）：明细收进对应工具折叠行（不再沉底遮挡运行时状态）；重渲染改读 `Round.evidence` 证据轨（100 字截断副本退位）；中断轮一并补齐；磁盘实证 3 条命中与 toolCallId 1:1 配对零悬空。
- **底栏终态偶尔不显示**（2026-10-19）：运行态 `data-status` 与终态 `data-terminus` 拆为双通道（SSOT 收敛），终态展示不再依赖容器存在。
- **历史浮层滚动分层**（2026-10-19）：tab/搜索框恒置顶、条目容器成唯一滚动面（纯 CSS，含 dropdown display 特异性回归排雷）。
- **悬空取代展示判据归一**（2026-10-16）：「已被取代」徽标与治理统计改用内核 `hasActiveSuperseder`（原 `!== undefined` 会把悬空指针误标）。
- **提问等待态输入走 answer 通道**（2026-10-15）：修复同一意图两种落盘形态（答案退化成补充、提问原文不落盘）；「拒答也是回答」。
- **真机复盘三连**（2026-10-13）：提问等待对齐 30 分钟（`ASK-TIMEOUT-1`，与 confirm 超时「数值巧合、判据独立、禁合并」）；token 累计口径标注（`ROUND-ANALYTICS-1`）；成文文件分区纪律入技能文档（`ROLEPACK-BODY-1`）。
- **内核错误诊断不再被吞**（2026-10-13）：`MemoraError` 经 `toNoticeText` 全文呈现（此前 37 处边界截断只留标题）；CSP 补 `img-src data:`。
- **启动会话对齐**（2026-10-13）：修「启动即分叉报当前会话不存在」（宿主 current 与内核惰性初值错位），挂 `refreshAfterAssemble` 唯一收口点。
- **配置 LLM 后免重启**（`HOST-BUG-1`，2026-10-12）：装配失败 catch 重置缓存 + `retryAgentAssembly()` + 配置变更监听触发重试（僵尸 Promise 根因）。
- **角色页详情/编辑不可达回归**（`RP-EDIT-1` 后续，2026-10-04）：重挂判据把首挂场景整体挡死，改到达即渲染（纪律：新增判定分支必须补「分支被走到」的用例）。
- **多流续跑 metrics 同轮合并**（2026-10-10）：前段指标不再被静默清零（求和合并、success 取末段）。
- **队伍对账只检测不删除**（`TEAM-GHOST-1`，2026-10-08）：清理写回退役、删除权交还用户（真机事故：瞬时扫描失败被当「全部卸载」静默物理删除队伍）；空池护栏；内核 `effectiveMembers` 同口径收口。
- **历史条目悬停假显「当前会话」+ 归档后不刷新**（`HIST-INFO-1`）：title 移内层防泄漏；订阅 `sessionArchived` 重拉列表。
- **异常终态轮缺底部栏**（2026-10-10）：`settleRoundFooter` 单点收口（锚 roundId 不依赖 DOM 连通性），早相位中断也能拿到复制/分叉/删除/时间戳。
- **消息区自动吸底**（2026-10-10）：`MutationObserver` 收口「高度变更不派发 scroll」整类缺口（思考折叠块/工具流式/长气泡）。
- **设计令牌 SSOT 收口弧**（2026-10-12，四批，`UI-TOKEN-PAIR-1` / `UI-TOKEN-MENU-1` / `UI-TOKEN-WARN-1` / `UI-TOKEN-LAYER-2`）：同变量不同回退 8 组 → 0；`--dim-*` / `--line-*` / z-index / 行高 / 不透明度刻度收口，裸值债 74→20 升硬门；无障碍对比度、`--menu-*` 幻影变量（引不存在的 VS Code 主题键致暗色白底黑字）、角色包卡片双箭头修复。
- **工具批断段与口径收口**（2026-09-25~26，`TOOL-RUN-1`）：思考换步即断段（反转「按 step 分组」前置决议，依据=前提变了）；叙述词表统一到工具显示名、取消「第 N 批」序号；问答卡纳入断面（`BATCH-SPLIT-1`）；任务项组位置判据归位 (ts, seq)、组外条目不再沉底。
- **diff 可视化复盘收口**（2026-09-28）：对照回滚为 git 同款左右分栏（真机定案）、删行尾红色预览；文案口径单源 `COMPARE_LABEL`；台账/docs 失真订正 + 退役概念回扫清单补第 8 层（`tasks/`）。
- **空响应计数假阳**（`EMPTY-RESP-1`，2026-09-29 复核推翻 09-29 验收）：截断救回计数补 `!aborted`（用户中断不再记成救回成功）；取证面改记生效值 `getEffectiveMaxTokens()`（宿主不再重算裁决规则）。
- **市场上传撞键**（2026-10-14）：截图文件名 ASCII 化（门户把非 ASCII 字节替换成 `?` 后等长撞键）。
- **插话丢弃信号成对契约**（2026-10-09）：停止路径补 `syncPendingQueue`，`_lastPendingQueueLen` 折叠 0 误判修为 `undefined`。
- **渲染异常用户侧静默**（2026-10-10）：`onMessage` 兜底补非阻断红条。
- **挂起/插话补充输入渲染根治**（2026-10-07）：user 消息一律不删骨架 + 正文单块续写统一（打断分段形态退役）。
- **任务项组层级与折叠箭头右置**（`TOP-UI-2`/`TOP-UI-3`，2026-10-04）+ **待发送区空条常驻**（`STATUS-DOCK-FIX`，2026-10-04）+ **`backgroundProvider` 声明收口**（`HOST-RESET-2`，2026-10-13：删硬编码补丁，键清单回归纯派生）。

### Changed（宿主）

- **输入条进度信号去重**（2026-10-18）：占用构成条移入圆环 hover 卡片（四段→五段含「动态注入」，`CTX-OCC-1` 宿主侧 + 跨包字段对账守卫）；会话记录量词订正。
- **输出上限裁决改取交集**（2026-09-28）：per-LLM 面板与角色包 `act.outputLimit` 取 min（原角色包直接覆盖 = 允许把用户配的小值顶大）；默认 4096 隐形天花板改 0（不干预），0-哨兵与 `contextLimit`/`stepBudget` 同构。
- **token 显示诚实口径**（`MAXTOKEN-SSOT-1` 销项）：「估算/正文」标注 + 生效上限亮明。
- **示例包行为参数对齐**（2026-09-28）：共鸣小说家 `stepBudget`/`toolStepLimit` → 100、`multiStepReasoning` manual→auto（思考深度听服务端默认）。
- **工程 SSOT 收敛**（2026-10-15）：默认窗口同族数字指针化 ×16；删 `package-lock.json`（`HOST-LOCK-1`）。零行为变化。
- **0.1.0 定版与市场门面对齐**（2026-10-12）：manifest 0.0.1→0.1.0、打包链三缺陷修复、README 市场定稿；真机装包实测通过。

## 历史版本

> 全文见 `docs/CHANGELOG-归档.md`（仓库内归档，npm 包不含；原文迁入，未改写）。

- **[4.0.0] · 2026-10-08** — 首个 major：导出面收敛（−54，桶导出时代收场）+ `agent.memory.search()` 退役（唯一入口 `searchByKeyword()`）+ 角色包 16 策略键定型。
- **[3.0.1] · 2026-09-30** — 开源归口翻转：GitHub 升主仓库。
- **[3.0.0] · 2026-09-30** — 架构收敛后第一个稳定基线（Node.js 专属 · 零第三方运行时依赖）。
- **[2.1.0] · 2026-08-08 / [2.0.3] · 2026-08-01 / [2.0.2] · 2026-07-27** — 探索性迭代期。
- **[1.0.2] · 2026-07-11 / [1.0.1] · 2026-07-08 / [1.0.0] · 2026-07-08 / [0.3.0] · 2026-06-27** — 早期版本。
