# Changelog

本文件记录 **@zooique/memora（内核 npm 包）**的版本变更。**宿主**（`hosts/memora-vscode`）不在发布包 `files` 白名单内（见 `package.json`），不占内核版本号：内核与宿主各按自己的版本号成区（ADR-033），**已发布与否以 npm registry 为准**（内核 `npm view @zooique/memora dist-tags.latest`；宿主见 Marketplace / Open VSX）——本文件不复述该状态，只记各版本改了什么。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> **版本定位（v5.x）**：**Node.js 专属 · 零第三方运行时依赖的 Agent 内核**（依赖 `node:*` 内置模块，不引第三方运行时依赖 / native / 宿主 API）。**4.0.0**：导出面收敛（−54）+ `agent.memory.search()` 退役（唯一入口 `searchByKeyword()`）。**5.0.0**：公开面大收面（删 23 导出 + 32 成员 + 3 事件）+ 多项目形态定案（一个 Agent = 一个项目）+ 三套空转机制退役 + SQLite 存储——逐项改法见[升级指南](docs/memora-升级指南-4.x-到-5.0.0.md)。**5.1.0**：MCP 工具接入的内核接口（`ToolDefinition.confirmPolicy` + `SecurityGuard` 单一确认入口）+ 脚本族执行面四面按正文裁决（`CMD-1-BYPASS` / `CMD-1-CONTENT`）——零删除、零既有签名变更。**4.0.0 及更早版本全文**：`docs/CHANGELOG-归档.md`（仓库内归档，npm 包不含）。内核不内置 agent 级行为评估（eval）/ 独立验证——由宿主基于内核可观测性（ITracer / 事件 / 指纹）自行承担；内核对接口契约与全量单测负责，不对"agent 整体行为稳定"作承诺。
>
> 本文件 2026-10-19 起按 `CHLOG-TRIM-1` 精简：只记「改了什么 + 为什么 + 对消费者的影响」；逐批拍板过程、变异验证收据、台账叙事的 SSOT 在仓库台账 `tasks/待完成任务.md` 对应 ID 条目（npm 包不含），此处只留 ID 锚保交叉引用。

## [5.3.0] · 2026-10-31

### Added（内核）

- **`Agent.currentRoundId()`**（`INTERRUPT-SETTLE-1`）：读当前在途轮次 id（`''` = 无在途轮），与 loop 层同源同值、不缓存副本。**为什么**：`TurnState.waiting` 投影**不含** roundId（ask 挂起时轮身份从快照里消失），而 ask 期停止收场需要轮身份做归属（折叠区归属 / 容器底栏时间与复制/分叉/删除 / 分叉锚点）；缺它时宿主 `settleRoundFooter` 首行 `if (!roundId) return` 直接早退，中断轮底栏整块不出现（真机 2026-10-31 实证）。**对消费者**：纯新增成员，零既有签名变更、零行为变化；放弃动作走独立的 `abandonTurn()` 读口（见下），轮身份与放弃结果互不耦合、两个读口各管一件事。

- **`Agent.abandonTurn()`**（`TURN-EXISTENCE-1` · ADR-044 二/三刀）：主动放弃当前在途轮的单点原语——① `cancelAsk()` 取消在途提问（只动进程内 `pendingAsk`，保 tool 配对不变量）；② `appendInterrupted` 中断收场落盘（盘面得一条诚实的中断记录，失败降级告警不抛）；③ 清当前暂停检查点并以结果作 `boolean` 返回（宿主据此提示「检查点已清理」；无检查点返回 `false`）。**为什么**：停止一个停在 ask / 长循环的轮此前没有内核原语，「放弃」语义散在宿主各处。**对消费者**：纯新增成员，零既有签名变更、零删除。
- **导出 `isRoundSuccessful`**（`METRICS-OWNER-1` 缓冲 · `INTERRUPT-SETTLE-1` 顺手修）：「轮是否成功收场」判据单点（盘面 `status === 'complete'` 投影），与既有 `isRoundSettled` 同文件同族挂出。**为什么**：宿主 `metrics.success` 原为宿主私有口径（`!aborted && !paused`），会把内核 failed 收场（盘面 `interrupted`）误标成功；判据收口内核后宿主不再自写状态比较。**对消费者**：需要「成功/失败」口径的面直接消费该函数，勿再自写 `status` 比较（与 `isRoundSettled` 同一条禁令）。
- **导出 `isWithinLocalDay`**（`E2E-TZ-SALVAGE-1`）：本地日期 ↔ UTC 时间戳换算判据单点（本地日区间 `[D 00:00, D+1 00:00)` → UTC 比较）。**为什么**：会话 ID 用本地日期、轮 `createdAt` 用 UTC 的双口径换算此前内核与宿主各写一份（宿主那份写错即漏打捞，见 Fixed）。**对消费者**：任何「按本地日过滤 UTC 时间戳」的面复用同一函数，不另立换算。
- **`AskQuestion` 增可选 `askCallId`**（`ASK-BATCH-IDENTITY-1` · ADR-043）：多问批次每题的身份 = 对应 `ask_user` 工具调用 id，由 `parseAskCalls` 按序单点填入（第 i 题 ↔ 第 i 个 toolCallId，与 `pendingAsk.toolCallIds` 同序同源，零新增状态），并随 `onPendingQuestion` / `question_pending` chunk / `takeAnsweredAsk` 快照贯通到落盘链路。**为什么**：运行时行 id（宿主自造）与盘面行 id（内核装配）两个产地、永不相遇，「实时行-重放行」配对只靠时序巧合。**对消费者**：纯新增可选字段，零既有签名变更；不做身份配对者可忽略。

### Fixed（内核）

- **ask_user 整批空问题不再挂起**（`ASK-QGUARD-1`）：`question` 空 / 纯空白的整批调用此前照常挂起等用户作答，只能干等 ask 超时（默认 30 分钟）。现整批空当场拒收：以明确错误回喂 tool result，让模型同轮重问。不变量保持：整批逐条回填 tool 消息（配对不变量不破）；`askCountThisTurn` 不计未发出的提问（askLimit 语义是防打扰，空问题不构成打扰）。**对消费者**：行为变更——全空批次立即收到错误而非静默等待；含至少一个非空问题的混合批仍正常挂起（混合批里的空问题单列 `ASK-MIXED-BATCH-1` 观察中）。
- **在途提问崩溃前落盘**（`E2E-ASK-LOSS-1`）：AI 已提问、用户未答时进程死亡 ⇒ 问题文本此前**完全丢失**（盘上轮只有 user 消息，重启只剩「没有问题的中断」，真杀进程实测）。现提问在挂起前随轮落盘，重启后收场转化出逐题 `unanswered` 记录——「问了什么、给了什么候选项」重启可回看。**对消费者**：自实现 `IRoundStore` 者无需改接口（落盘走既有 `pendingAsk` 字段）；崩溃重启后提问不再丢。
- **多问批次逐题落盘**（`ASK-MULTI-Q-1`）：作答 / 超时 / 批次内跳过三形态每题各落一条持久记录——作答题 `question-answer` + 各自答案、跳过题 `unanswered` + `[ASK_ABORTED]` 占位（与 LLM 收到的 tool result 同构）、超时整批 `timeout` + 超时通知。此前落盘只取首问，Q2..N 的问题与候选项只存活在内存。**对消费者**：重启回放多题批次可见完整 N 条问答对；`takeAnsweredAsk` 返回元素结构扩宽（成员名不动，旧读者结构兼容）。
- **凌晨崩溃轮打捞的时区口径**（`E2E-TZ-SALVAGE-1`）：会话 ID 用本地日期、轮 `createdAt` 用 UTC ⇒ 本地 00:00–08:00 创建的中断轮打捞不到（UTC+8 下每天 8 小时窗口静默丢轮）。换算判据收敛为单点 `isWithinLocalDay`（见 Added），内核 `inMemoryRoundStore` 与宿主 `WorkspaceRoundStore` 同一函数同判据（单侧改 = 分叉，已被测试钉死）。**对消费者**：打捞过滤如自行实现，复用该单点，勿再手写换算。
- **未收场轮不再「凭空消失」**（`TURN-EXISTENCE-1` · ADR-044 一/四刀）：轮的存在性不再绑死「收场」——建轮即入会话视图（此前一轮要等收场才可见；ask 超时等停滞轮在会话视图不可见、重启后也不被当「需打捞的中断轮」，用户体感「说过的话凭空消失」而盘上仍在，真机 2026-10-31 实证）；ask 超时兜底去相位化（停滞轮有确定性收场兜底）；孤儿判据口径随之收窄。**对消费者**：自实现会话视图 / 回收判定者将看到轮在创建期即出现；`Round.refCount` 语义以 `roundStore.ts` 注释为准。

## [5.2.0] · 2026-10-29

> **本区归属**：仅**内核**变更；SemVer 定档**随本区收口复核**——本区现有三批：①**文档 + 测试守卫**（**运行时代码零变更、公开面零变更**），含**三件契约守卫增量**（公开面 diff 快照 / 可达成员面冻结表 / 随包接入指南一致性，封住三处「消费者可感知的契约变更会静默通过」的真实漏洞）与**一件文本卫生守卫**（全仓 U+FFFD 乱码扫描）；②**一处运行时行为修复**（`ISessionStore.loadMessages` 的附件契约补齐，见 Fixed 小节，**公开面零变更、零签名变更**）；③**一处运行时功能项**（图片输入内核面，见 Added 小节——`ImageRef` / `ImageResolver` / `imageTokens` 三导出与三个 `attachments?` 字段在 5.1.0 中均不存在，**公开面纯新增、零删除、零既有签名变更**）。③ 使本区按 SemVer 定档 **minor（5.2.0）**——与 2026-10-27 拍板的版本号自洽；①②单看是 patch，被③吸收。
> **收据与拍板过程**：见仓库台账（npm 包不含）ID 锚 `RUNTIME-TIER-1`（运行时门槛）/ `PUB-SNAPSHOT-1`（公开面快照守卫）/ `PUB-REACHABLE-1`（可达成员面守卫）/ `GUIDE-AUDIT-1`（接入指南核查）/ `GUIDE-GUARD-1`（接入指南守卫）/ `ONBOARD-MIN-1`（最小接入面叙事）/ `FFFD-GUARD-1`（全仓乱码清零与扫描守卫）/ `IMG-1`（图片内核面）/ `IMG-3`（能力位透传链）。
> **发版纪律**：本区标题日期须在打 tag 前改为实际发布日（`scripts/verify-changelog-version.mjs` 挂 `release.yml` 校验；已发布 tarball 不可变，见 `RELEASE-CHLOG-DATE-1`）。

### Added（内核）

- **公开面 diff 守卫「向 E」**（`PUB-SNAPSHOT-1`）：`publicApiSurfaceGuard.test.ts` 新增公开面 ↔ **冻结快照**（2026-10-27 冻结，计数以快照数组自身为准）逐位对账——删除或改名任一 `src/index.ts` 导出即红。**为什么**：原向 A/B/C/D 全部从「现存集合」出发迭代，符号一旦被删就不再被任何闸门检查——**任何被删除的导出都会全库静默**（实测：删 `isRoundSettled`，它**宿主真实消费**但不挂文档承诺面 ⇒ 仅向 E 变红、其余全绿）。**对消费者**：零运行时行为变化；此后删除公开导出必走「清算 README / 手册承诺与全部消费方 → major」的显式流程。新增导出仍先过向 A，同批补进快照（快照注释写明二选一更新纪律，不存在「改断言让它绿」的第三选项）。
- **可达成员面守卫**（`PUB-REACHABLE-1`）：`publicMemberSurfaceGuard.test.ts` 新增「可达成员面」层——冻结**经已登记符号的公开 getter 返回、但未挂 `src/index.ts` 导出面**的类的公开成员清单（实测 **7 类型 / 133 成员** = `AgentLoop` / `ToolExecutor` / `MessageHistory` / `SkillManager` / `SecurityGuard` / `WorkProjectionManager` / `TextPolishManager`），增删即红。**为什么**：该守卫原只遍历**导出符号** ⇒ 不挂导出面的类完全不在射程——`SecurityGuard` 虽未从包入口导出，但 `Agent.get security` 返回它，消费者（宿主设置面板 / 装配层）**真实在调** `agent.security.setConfirmWrites(...)` 等方法，而 5.1.0 新增的 `requestToolCallConfirmation` 也在该面上 ⇒ **删改这些方法此前任何闸门都不红**（消费侧仅 TS 编译期拦截）。**对消费者**：零运行时行为变化；此后这类「经公开 getter 可达」的方法增删同样必走审查（新增 = 真能力还是谎报？删除 = 纠谎还是误删？），不再静默。冻结范围经三轮收紧（排除 TS 内置类型 / 内部协作对象 / 零消费类型），避免「为完整性而完整性」给内部实现上枷锁。
- **随包接入指南一致性守卫**（`GUIDE-GUARD-1`）：`integrationGuideGuard.test.ts` 把 `docs/memora-接入指南.md`（**随包发布**、22 个可照抄的 TS 代码块）纳入机检——① 代码块 `import` 的符号必须存在于 `src/index.ts` 导出面；② 代码块与行内 `agent.X` 必须是 `Agent` 公开成员（**解析 `extends` 链**，故 `agent.on` 不假红）；③ 文档**自称「接口全集」**时示例类必须实现接口全部必需成员；④ 扫描面归零即红（防路径漂移导致恒绿）。**为什么**：该文档此前**不在任何文档守卫射程**（既有守卫只对账 README 与 API 手册），两处真伤因此长期存活——示例里的 `appendMessage` **内核全仓不存在**（`ISessionStore` 有 11 个必需方法，示例只写 3 个 ⇒ 消费者照抄必编译失败）、`agent.projects` 僵尸引用（该 getter 已于 5.0.0 随项目层退役）。**对消费者**：零运行时行为变化；此后该指南的 API 引用与「照抄可编译」承诺随内核一起被机检。判据全部**实时读源码**（不建冻结表 ⇒ 无第二份真源）；**历史留痕**（明写「已移除 / 已退役」的表述）与**合法节选**示例均豁免，不误伤正确写法。
- **全仓 U+FFFD 乱码清零 + 替换字符扫描守卫**（`FFFD-GUARD-1`）：新增 `src/__tests__/replacementCharGuard.test.ts`——对全仓十二种文本后缀（含 `.trae` / `.github` 等隐藏目录）扫 U+FFFD 替换字符，判据为「零违例 + 扫描面下限断言（防空集假绿）+ 判据探针自检 + 与 `scan:phrase` 排除集的逐元素同源契约（防双写漂移）」；同批清零 **4 处存量乱码**（内核 `textSanitize.ts` 生产注释、宿主 `chatView.ts` 注释、仓库台账与方案文档各 1 处——生产注释**随编译进 dist .js 出货**，见 `package.json` 构建无 `removeComments`）。**为什么**：乱码是「没有任何测试会红」的伤（读者肉眼可见、机器不报错，与措辞折叠同族），4 处经 git 溯源均 **born corrupt**（入仓即带、原文不可从 VCS 恢复，只能语义重构），此前无任何闸门扫描此类损坏。**对消费者**：dist 注释里一处乱码的文本修复（零运行时行为变化）；此后文本文件混入替换字符在测试闸门即红。
- **图片输入（多模态用户输入）内核面**（`IMG-1` / `IMG-3`）：公开面**纯新增**——① `ImageRef`（宿主采集侧构造的图片引用：`sha256` / `mime` / `width` / `height` / `bytes` / 必填 `name`）；② `ImageResolver`（宿主持有的**运行时回调**，把 `ImageRef` 物化为 `{url}` 或 `{text}` 占位文案——内核零外部 IO，回调不可持久化、不进任何配置 DTO）；③ `imageTokens`（单图 token 估算**单点公式**，入参只要宽高子集，宿主入口限额直接复用，不各写一份数学）；④ `Message` / `RoundMessage` / `SessionMessage` 各增可选 `attachments` 字段（随 `loadMessages` 恢复链带回，见 Fixed 小节）；⑤ `ProviderConfig` 增 `supportsVision`（缺省 `false`——「声称看得见图却看不懂」比「坦承不支持」危害更大）与 `imageResolver`；⑥ `Agent.chat` / `AgentLoop.processUserInput` 增可选 `attachments` 参（仅流式入口承载）。带图请求发往未声明 `supportsVision` 的模型时**一级门禁 fail-closed 明确拒绝**（读**路由后** provider，非配置快照）；resolver 未命中的图推**可见占位文本块**，绝不静默丢。**为什么**：多模态输入的内核契约与执行面——OpenAI `image_url` 形态序列化、token 计量与占用环复用同一公式、无附件请求体**字节级不变**（快照守门）。**对消费者**：不用图片的既有代码零影响（`attachments` 不带即字段不存在）；要用图须三件齐备——模型声明 `supportsVision` + 注入 `imageResolver` + 调 `chat()` 时传 `attachments`。

### Fixed（内核）

- **`ISessionStore.loadMessages` 的附件契约补齐：历史图片随轮恢复，并按窗口衰减**（`IMG-2` 断点B）：`ISessionStore.loadMessages` 的 JSDoc 新增契约句——user 消息**必须**带 `attachments`，且经 `LOOP_CONSTANTS.RETAIN_IMAGE_ROUNDS` 窗口衰减；内核 `InMemorySessionStore.loadMessages` 与宿主 `WorkspaceSessionStore.loadMessages` 同批落地，两实现与 `messageHistory.loadRoundBasedMessages` **同判据同构**（`当前索引 − 消息索引 < 4`，索引一律 `roundIds.indexOf(round.id)` 取位——`getByIds` 会跳过缺失轮，用返回数组下标必错位）。**为什么**：本方法是内核 `restoreHistory` 的**唯一上游**，此前只透传 `role / content / timestamp / roundId`，漏掉了 5.0.0 起就存在于 `RoundMessage` 的 `attachments` ⇒ **重启宿主后历史图片全灭**（模型只见纯文本，连 D7 占位都没有；真机验收实锤）。**对消费者**：`loadMessages` 返回的 user 消息此后**会带** `attachments`（仅窗口内轮次）——自行实现 `ISessionStore` 的消费者不补该字段不会有任何报错，但历史图对其模型不可见；不需要该行为者可忽略该字段。**零签名变更、零公开面变更**；`RETAIN_IMAGE_ROUNDS` 仍是单点常量（其注释已同步登记**四个消费点**：三处窗口衰减 + 一处预读量）。

### Changed（内核 · 文档）

- **运行时门槛双档口径**（`RUNTIME-TIER-1`）：README 中英各三处对齐（「运行时要求」声明块 / 技术栈表行 / IMemoryStorage 表行）——包门槛 Node.js ≥ 22.0.0（与 `package.json#engines` 同源，**engines 刻意不收紧**，2026-10-16 A1 拍板）；SQLite 落盘工厂 `createNodeSqliteStorage`（`node:sqlite`）需 **Node ≥ 22.13**（22.13 起免 `--experimental-sqlite` 标志）。低于 22.13 时包可正常加载、内存存储照常可用，仅调用该工厂抛「需 Node ≥22.13」的 `NOT_AVAILABLE` 明确错误，**不会静默失败**。**对消费者**：npm 安装面此前只见 22.0.0 门槛、不知第二档能力线，现补齐双档事实。
- **最小接入面叙事**（`ONBOARD-MIN-1`）：README 中英边界声明后各增一段——构造 `Agent` 必填仅 **`projectPath` / `provider` / `dataDir` 三项**（`dataDir` 无缺省值，与 API 手册 §〇.5 同口径）；`storage` 缺省为内置内存实现（对话与记忆闭环照常，仅不持久化），`sessionStore` / `roundStore` / `tracer` 与五个外部工具 provider（`web_search` / `web_fetch` / `run_code` / `search_project` / 环境上报）均可选，不配只是不启用对应能力、不阻塞启动。**对消费者**：纠正「接入需自实现一整套存储/会话接口」的错觉——要落盘直接用内置 `createNodeSqliteStorage` 工厂，无需自实现存储接口。

## [5.1.0] · 2026-10-25

> **本区归属**：仅**内核**变更；SemVer = **minor**（零删除 / 零既有签名变更；**行为变化共三处、均为修复方向、不构成破坏性**：① 脚本族执行面按正文裁决，命中黑名单/恒弹清单的执行行为收紧；② 写侧护栏判据改为「无进展」（`write_loop` 只计整文件覆盖与连续失败写，增量写不再计数）；③ `task_table_update` 不再被跨轮幂等跳过（防回喂旧任务表）。三者均见 Fixed 区）。公开面**分两层**：① **包入口符号面**增量 = **仅** `ToolDefinition` 加可选字段 `confirmPolicy`（类型面）——`SecurityGuard` 类与 `SCRIPT_READ_MAX_LEN` 均**未**从包入口 `src/index.ts` 导出；② **公开成员面**零新增（`publicMemberSurfaceGuard` 成员表未增元素），但 `agent.security` 本就是公开成员，其新增方法 `requestToolCallConfirmation(toolName, summary, needConfirm)` 对消费者**可达**（文档见 `docs/memora-api-reference.md` §2.6）。宿主侧 MCP 消费面（连接 / 设置页 / 审批卡）随宿主下一版独立成区、不占内核版本号（ADR-033）。逐条拍板与变异验证收据见仓库台账（npm 包不含），**按条目 ID 检索**（`tasks/待完成任务.md` 与 `tasks/archive/5.1.0-kernel.md`，不按区名——已发行版本区已于 2026-10-26 归元折叠）：`D1-MCP`（顶层条目仍留主台账 `tasks/待完成任务.md`）；`CMD-1-BYPASS` 的实现收据见主台账 `㉔` 条、最后一面见 `tasks/archive/5.1.0-kernel.md` 的 `CMD-1-CONTENT` 条目；`CMD-1-CONTENT` / `GUARD-WRITE-PROGRESS-1` / `IDEM-TASK-TABLE-1` 均在 `tasks/archive/5.1.0-kernel.md`。
> **发版纪律**：本区标题日期即**实际发布日**——`scripts/verify-changelog-version.mjs`（挂 `release.yml`，不进 pre-push）校验「合法日历日期 + 与发布日相差 ≤1 天」；已发布版本的 npm tarball 不可变、改不回来（`RELEASE-CHLOG-DATE-1` 血训），故日期须在打 tag 前定稿。
> **日期口径（2026-10-27 澄清）**：本区标题日期 = **打 tag 的那个日历日（本地时区）**；台账「版本索引」的发布日期列 = **npm 上架日（北京时间）**。二者可能差一天（5.1.0 = 本区 10-25 / 上架 10-26，跨午夜）⇒ **两者都正确，非笔误**。

### Added（内核）

**MCP 工具接入的内核接口（`D1-MCP` 切片 0 · 2026-10-23）**——MCP SDK 与传输全在宿主依赖，内核仍不认识 MCP、零第三方运行时依赖不变

- `ToolDefinition.confirmPolicy?: 'always' | 'audit'`：自定义/外部工具（如宿主接入的 MCP 工具）声明审批意图的**唯一字段**。**缺省 = 字段不存在 = 不过闸 = 现状**；刻意不设 `'never'`——宿主只需「关弹窗」，不需「关审计」。
- `SecurityGuard.requestToolCallConfirmation(toolName, summary, needConfirm)`：复用私有 `confirmGate` 的**单一确认入口**（一次入口、两种模式），`ToolExecutor.execute()` 的 custom 分支按上述字段过闸——`'always'` 弹确认、`'audit'` 自动放行但仍落审计，拒绝则不调 handler（`[ERR:TOOL_DECLINE]` + blocked outcome）。**为什么重要**：此前 custom 分支完全不过闸 = 动态工具源（MCP）零审批；补后**全仓仍只有一条审批路径**，不存在第二条。
- 审计**零新增类型**：确认统一走后恒落既有三值（`write-auto` / `write-confirm` / `write-decline`），工具调用补 `source: 'custom'` + `tool` + `path`（= 调用摘要，与 `run_command` 把命令塞 `path` 同构）；`confirmGate` 加可选 `source` 末参并透传**全部四个**审计出口（写入类不传 = `undefined`，零行为变化）⇒ 宿主既有「denied 计数」自动覆盖 MCP，宿主审计面零改动。
- `ToolExecutor.removeTool()` 的 JSDoc 由「供测试场景使用」扩为「运行时可注销」（`K2`，零代码改动）——宿主据此实现 MCP server 停用与工具集整换。
- **对消费者**：纯增量。不声明 `confirmPolicy` 的既有自定义工具行为完全不变；要接入动态工具源的宿主声明字段即得审批 + 审计。
- ⚠️ **本期刻意不做**（`K3`，有判据的拒绝）：不放宽 `ToolDefinition.parameters` 的 schema 类型（不支持嵌套 object / enum / anyOf）——`loop.ts` 的 prompt 渲染器只读顶层 `type`/`description`，放宽须连带改模型可见文案并回归全部内置工具，收益不抵风险；宿主侧以「结构映射 + 约束搬 description」适配。

**内置角色包 L1 增「编辑纪律基线」（`GUARD-WRITE-PROGRESS-1` 配套 · 2026-10-25）**

- 三个内置包（`memora助手` / `共鸣小说家` / `白话方案设计师`）的 `rules.md` 增一条**领域无关的编辑纪律**：增量写入优先（`replace` / `insert` / `append`）、同一文件多处修订在**同一回复内连续发出**、整文件覆盖仅用于确需重建且不反复覆盖、复核只读改动片段。`role-packs/` 在 `package.json#files` 内，**消费者可见**。
- 作者指南 §2.4 同步该基线，并明示 **L1（`rules.md` / `persona.md`）不得写运行时拒绝令牌**（`[WRITE_LOOP_STOP]` / `[WRITE_FAIL_STOP]`）——L1 常驻 system prompt，令牌会干扰「按令牌定位运行时拒绝消息」的消费方（纪律真源 `src/agent/guardRail.ts` GUIDELINES）。
- **为什么**：写侧护栏只拦「无进展」，**不拦「慢」**——真正决定模型行为的纪律必须写在 L1；真机 `round-1792904123909`（7 次被拦、5 处修订拖到下轮、27 分钟 / 116 万输入 token）即缺该条所致。

### Fixed（内核）

**脚本面内容裁决（`CMD-1-BYPASS` · 2026-10-25）**

- `SecurityGuard.confirmScriptRun` 接受可选第 4 参 `content`（= 将被执行的脚本/代码正文），内部喂给**同一个** `classifyCommand`：`deny` 恒拦（任何档位/权限，不进确认流程）／`always-ask` 恒弹（`owner` + `confirmScripts=false` 也弹）／`normal` 回落原档位判据。**为什么**：此前 `classifyCommand` 的唯一调用点是 `confirmCommandRun`，脚本面只看档位不看内容 ⇒「把 `git push` / `rm -rf` 写进脚本」零护栏，恒弹清单成了纸墙（一次工具调用即可绕过）。
- 已接入两面：`run_code`（内联代码传正文）、`run_project_script`（确认前读脚本文本）；正文 > `SCRIPT_READ_MAX_LEN`（20 万字符）**拒绝执行**（fail-closed，不给「读不动就放行」的口子）。
- `ALWAYS_ASK` 清单补 `git clean`（此前落 normal 档 = 默认档直接执行，真洞）。
- `BuiltinToolHandlers.readScriptFile` 加可选 `label`（默认 `run_code script_path`）：复用读正文时审计归属不再写死 `run_code`（原会把项目脚本的路径审计记到 `run_code` 头上 = 归属说谎）。
- 三处 decline 文案改中性措辞（「未获执行许可（命中恒拦 / 用户拒绝 / fail-closed）」）——原写「未获确认（用户拒绝…）」会把命中黑名单说成用户拒绝。

**技能脚本内容裁决（`CMD-1-CONTENT` · 2026-10-25）**

- `run_skill_script` 是脚本族最后一面（此前只判档位）。现确认点经装配期新注入字段 `ToolExecutor.resolveSkillScript`（与执行回调**共用** assembler 的 `resolveSkillScriptTarget`：角色包 → 全局池，解析顺序天然单点）定位脚本文件读正文，喂同一个 `classifyCommand`。
- 长度上限复用 `SCRIPT_READ_MAX_LEN`（本轮改为导出常量，三消费面共用，**不造第二上限**）；**不走项目根白名单**——技能目录 = 可信根（脚本经作者审阅），路径防逃逸由解析器自身保证（角色包 layer3 白名单 + `resolveSafePath` 边界 / 全局 `resolveLayer3ScriptPath` + 存在性校验）。
- fail-closed 分级：解析不到 = 不传正文（维持 `[ERR:SCRIPT_NOT_FOUND]`，执行点同一解析必返 null）；读失败 / 超长 = `[ERR:SCRIPT_DECLINE]` 拒绝执行。
- **对消费者**：`runSkillScript`（执行回调）契约与行为不变；不注入 `resolveSkillScript` 的装配（含既有单测）行为与补齐前完全一致。**至此四个执行面（`run_command` / `run_code` / `run_project_script` / `run_skill_script`）全部按正文裁决。**

> **不声称的内容（防误读）**：`classifyCommand` 是**字符串判据**——拦「模型手滑 / 幻觉 / 提示注入直接写出危险命令」，不是「危险执行总闸」；正文之外的间接载体（变量展开、编码混淆、执行期才决定的路径）拦不住。语义防护由**用户审批 + 审计溯源**承担，不由 denylist 承担。

**写侧护栏判据改为「无进展」（`GUARD-WRITE-PROGRESS-1` · 2026-10-25）**

- `write_loop` 原判据 = 「同路径连续写 N 次」，把 `mode=replace` 的逐处修订与整文件覆盖混算：第 5 次写入即硬拦，且被拦后 `read_file` **不复位**计数（`notifyExec` 原先只按 `matches` 分发，读事件根本喂不到该护栏）⇒ 该路径在**本 turn 内永久封死**。真机 `round-1792904123909` 实证：7 次被拦、5 处修订拖到下轮、27 分钟 / 116 万输入 token。
- 现判据 = **无进展信号**：① 仅整文件覆盖（`mode=overwrite`，缺省）计入连写（阈值 `writeLoop` 不变 = 5）；② 增量写（`replace` / `insert` / `append`）每次改不同片段，**永不计数**；③ 同路径连续**失败写**达新增静态阈值 `writeFail`（= 3）即拦，读成功 / 写成功即清；④ `failed` 不再被当作一次写（原实现会推进 streak）。
- `notifyExec` 改为**全量分发**（各护栏在 `onExec` 内按工具自过滤）——原「借 `matches` 路由」让一个字段担两份职责，护栏文案承诺的「先读再写」出口从未生效。
- 新增**放行钩子** `onAllow` / `notifyAllow`（同批洞补丁，真机 `round-1792919558093`）：同批工具调用先集中判定、后统一执行，判定阶段看不到结果 ⇒ 只靠执行后回喂的连写计数会被「一条回复内连发 N 次整文件覆盖」整批绕过（实测 6 次全部放行）。现于派发时**预登记整文件覆盖意图**，第 5 次同批覆盖即拦；执行回喂消费预登记（一次写只计一次），被拦未执行则撤销。增量写不登记（批量逐处修订仍零计数）。`write_fail` 刻意不预登记——批内看不到失败结果，预拦会误伤同批中本可成功的写。
- 文案：`[WRITE_LOOP_STOP]` 的出口改为**可执行**的「改用 replace/insert/append 增量写入」；新增 `[WRITE_FAIL_STOP]`（先读最新原文再写）。
- **对消费者**：`BlockedReason` 未新增/未改名（仍是 `write_loop`）、零公开签名变更、零新增 metrics 字段（拦截事实已在 round 事件的 `tool_result.blocked` 中，另立计数即第二真理源）。行为向修复：同一 turn 内对同一文件的增量修订不再被封顶。

**任务表更新不再被跨轮幂等跳过（`IDEM-TASK-TABLE-1` · 2026-10-25）**

- `BUILTIN_TOOL_IDEMPOTENCY.task_table_update`：`idempotent` → `non-idempotent`。**为什么**：幂等键只有 `name + 完整 args`，而 `task_table_update` 的 `plan_item_id` 是**位置序号**——跨轮 `task_table_write` 重写任务表后，同序号可能指向另一个任务项；此时同 args 重发会被「仅一次语义」跳过并回喂上一轮的旧任务表摘要 = **向模型谎报「已更新」而实际未更新**（真机观测：回显旧任务项）。重跑本身无害（状态确定），故与 `delete_file` 同判据——归入「禁止跳过」而非「重跑有害」。
- **对消费者**：`IdempotencyLevel` 枚举未变、零签名变更；仅该工具不再被跳过。内置映射现**无** `idempotent` 级工具（级别本身保留，供宿主自定义工具声明）。
- 同族**未改**（登记观察，不随本版动）：`write_file`（`idempotent-key`）跨轮「同 path + 同 content」仍会跳过——若文件在两次调用间被外部删除/改动，同内容重写不会落盘。无真机实证，且该跳过是核心重试去重通道，改动面大。

## [5.0.0] · 2026-10-23

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
- ⚠️ 上述多项随 4.0.0 已发布，直删失去 deprecation 预警期，由本 Breaking 明示；`loadSessionMessages` 原走 `DEPRECATE-1` 周期，用户拍板提前直删。决策依据 = 三面零消费 + 5.0.0 定档时点未发布（npm 最新 4.0.0）零外部破坏窗口。

**选项与常量**

- 删 `AgentOptions.fileConsistencyCheck`（透传链路先删后字段零读取的僵尸）/ `LOOP_CONSTANTS.MAX_WEB_SEARCH_CALLS`（搜索上限改策略键后零读取的幽灵旋钮，缺省 6 真源归 `DEFAULT_BEHAVIOR_STRATEGY.global.webSearchLimit`）。

### Added（内核）

- **SQLite 存储切片**（2026-10-16，服务 `DSH-1` / `MCP-SERVER-1`）：`createNodeSqliteStorage(dbPath[, { readOnly: true }])` 工厂 + `ReadOnlyMemoryStorage` 类型导出。基于 `node:sqlite` 内建模块**延迟加载**，零三方依赖、`engines` 不收紧（不可用抛 `NOT_AVAILABLE`）；**可用性判据唯一来源 = 调用工厂结果**（宿主禁自行解析 `process.versions.node`）。只读形态写方法结构上不存在、连接只读模式打开不建库（库缺失抛 `MemoraError{FILE_NOT_FOUND}`，`HOST-ALIGN-1`）。语义与 InMemoryStorage 逐位对齐（共用契约套件参数化跑两实现）；写模式 `journal_mode = WAL`。
- **归档防重意图解耦 + 跨进程持久化**（`ARCH-GAP-2`，2026-10-19）：`ArchiveTriggerOptions.skipIfUnchanged?: boolean`（显式优先，否则随 `autoTriggered`，既有语义不动）；防重快照落盘副本 `SessionMeta.archivedMessageCount`（内存 Map 优先双源读写）——宿主重启后不再对「内容未变」的会话重复烧 LLM。
- **记忆命中可见**（`MEM-EVENT-1` / `MEM-EVENT-2` / `MEM-EVENT-3`，2026-10-19）：`memoryRecalled` 载荷补可选 `hits`（命中条目）与 `toolCallId`（与工具调用 1:1 配对，缺省不带键）；`Round.evidence` 新增 `memory_hits` 变体——**实时面走事件、回看面走证据轨**，宿主重放历史轮不再丢命中明细。同批载荷扩展（`MEM-UI-1`）：`hits[]` 元素补可选 `contentPreview`、`memoryAdded` 载荷补可选 `content`（实时轨与 evidence 落盘轨同批，支撑宿主记忆显示正文为主位）。
- **web_search 增强**（`GUARD-SEARCH-1` / `SEARCH-QUALITY-1` P1-1）：联网搜索硬上限抬为角色包策略键 `webSearchLimit`（1~20，默认 6，与 `askLimit` 同构——只解决「不能调」，不改护栏）；新增裁决证据 `web_search_result`（query/endpoint/count/titles 随 Round 持久化，`toolCallId` 配对根治证据错配，0 结果同样留痕）。
- **悬空取代单一判据**（2026-10-16）：`hasActiveSuperseder()` 导出——替代物经物理删/软删移除时旧摘要回退为当前版本可正常召回；判据与移除路径解耦（原「移除点 eager 收敛」是半修复），零数据删除、不改写入语义。
- **单段文本 token 估算挂公共面**（2026-10-20）：`estimateTokensText(text)` 导出——宿主注入量归因（`HOST-CTX-6②`）需要单段计量，原「不挂公共面」是当时无消费面的决定；若宿主自写换算即与运行时口径漂移（第二真理源）。单段用本函数；多段一律 `estimateTokensMessages`（逐段调用会放大取整误差）。

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

## [0.5.0] · 未发布 · 宿主

> **本区归属**：仅**宿主**（`hosts/memora-vscode`）变更，随 `vsce package` 定版，不进内核 npm 包（ADR-033）。**开区原因**：`vscode@0.4.0` tag 早于宿主面收口（停止/中断收场链、操作菜单单源、Marketplace 中英双语）。**主体条目随 `git log vscode@0.4.0..HEAD -- hosts/` 补齐**；切片叙事不复述，逐笔变更以该 tag 区间为准。**对外文档不引用内部台账坐标**（区名会随台账重组失效，tag 区间不会）。
> **随包内核代次 = `5.3.0`**（esbuild 内联 dist，内核自身变更见内核区）。

### Added（宿主）

- **Marketplace 元数据中英双语**（`HOST-I18N-1`）：新增 `package.nls.json`（英文）+ `package.nls.zh-cn.json`（中文）+ `%key%` 占位，Marketplace 展示与扩展详情页不再全中文硬编码。**为什么**：此前打包面元数据只有中文，非中文 VS Code 环境下显示中文、且不符 Marketplace 惯例。**对消费者**：扩展在 Marketplace / Open VSX 的中英文展示随系统 locale 切换；运行时 UI 本地化不在本版（仅包面最小切片，决策真源 ADR-042）。
- **右键上下文菜单语义级操作**（`COPY-2`）：对话消息条右键新增「重新生成 / 分叉 / 删除 / 复制 / 引用回复」语义级操作。**为什么**：此前这些动作只能从容器底栏触发，消息条缺右键入口。**对消费者**：在消息条上右键即可执行这些操作；与容器底栏动作收敛为同一真源（见 Changed，两边永远同名同序）。

### Changed（宿主）

- **操作菜单收敛为单一真源**（`ACTIONS-SSOT-1`）：右键菜单与容器底栏的操作动作原本各维护一套、易漂移。现收敛为单一派生源，右键五项 = 底栏三键 + 复制，两边永远同名同序。**为什么**：同一组动作两份实现 = 迟早不一致（实测曾出现右键有「重新生成」而底栏无）。**对消费者**：两处菜单行为完全一致；「重新生成」为破坏性动作（重发整轮），操作前有明确提示。
- **停止 / 中断收场链补齐**（`INTERRUPT-SETTLE-1`）：ask 期停止、异常中断不再「悬着」——过程收进折叠块，底栏出现时间与复制 / 分叉 / 删除按钮，终态标签三态判据归一（异常收场不再被「已完成」抹掉）。**为什么**：此前停止后提问卡悬空、无终态标签、无底栏，用户看不到「已中断」。**对消费者**：正常完成 / 用户中断 / 异常中断三种场景，结束后过程都收起、可展开回看，底栏终态标签正确；真机三场景验收通过。

### Fixed（宿主）

- **多问批次部分作答答案错位**（`ASK-PARTIAL-ANSWER-1`）：提交入口过滤未答项后按位配对，答案串到别人头上。`parseAskCalls` 改用身份配对（与内核 `askCallId` 同序同源），同批多问每题答案落在对应题上。**对消费者**：多问批次部分作答不再答错对象。
- **引用回复事务修复**（`COPY-2-QUOTE-TXN-1`）：引用草稿在发送早退路径被提前消费（丢引用 + chip 与状态分叉），已修。
- **消息条锚点修复**（`COPY-2-ANCHOR-1`）：用户消息条缺 `dataset` 锚导致删除 / 分叉在用户条缺位，已修。
- **截断契约修复**（`COPY-2-OK-CONTRACT-1`）：`truncateTurnCore` 恒返回 `ok: true` 与自身注释契约相反，已修。

## [0.4.0] · 2026-10-29 · 宿主

> **本区归属**：仅**宿主**（`hosts/memora-vscode`）变更，随 `vsce package` 定版，不进内核 npm 包（ADR-033）。**开区原因**：`vscode@0.3.0` tag 早于图片输入全链（`IMG-1`~`IMG-13` 宿主面 + `IMG-3` 视觉能力位宿主面），已发布版无图片输入能力。**主体条目随 `git log vscode@0.3.0..HEAD -- hosts/` 补齐**；切片叙事不复述，逐笔变更以该 tag 区间为准。**对外文档不引用内部台账坐标**（区名会随台账重组失效，tag 区间不会）。
> **随包内核代次 = `5.2.0`**（esbuild 内联 dist，内核自身变更见内核区）。

### Added（宿主）

- **图片输入全链（多模态用户输入）**：对话里现在能直接发图片——四种入口汇流到**同一执行面**（落盘 / 校验 / 真 chip 建连），无第二份循环 / 第二份扩展名表 / 第二份能力判据：**① 粘贴**图片到输入框；**② 上传按钮**选本地图片（模型未声明支持视觉时按钮置灰并跳设置——这是可发现性，不是裁决）；**③ 资源管理器 / 编辑器右键「Memora: 添加到对话」**命中真图时直入摄取面（不再是「拒挂 + 指路」）；**④ 从文件系统拖入**（外部 OS 文件须按住 `Shift`，VS Code 1.140+ 资源管理器内拖入受上游回归阻塞、等 1.142）。**为什么**：此前模型看不到图，图文混聊要绕文件引用。**对消费者**：发图即建可发送的图片 chip；模型未声明 `supportsVision` 时一级门禁 fail-closed 明确拒绝并给理由（不静默丢）；字节只走 base64（不过 `postMessage` 传 `File`/`Blob`），host→webview 单向高效传输；未命中推可见占位而非静默丢。回执复用既有 `image_picked` 消息（协议零新 op）；历史图片随对话轮次恢复（窗口衰减）。视觉能力位在设置面板 Provider 配置新增「支持图片输入（多模态视觉理解）」复选框（五跳透传，内核面见 `IMG-3`），由 `IMG-2` / `IMG-5` 承载宿主侧落地与热刷新。

### Fixed（宿主）

- **对话记录选区复制兜底（修复 WebviewView 原生复制失效）**（`COPY-1`）：选中消息正文后 Ctrl+C / 右键「复制」都不落盘。根因：VS Code WebviewView 里非输入区原生剪贴板不可靠，且原 `copyText` 只服务 hover 动作按钮（整条 / 原始文本 / 代码块），**自由选区（选一句 / 一段）无入口**——「选中对话记录复制不出」与「右键菜单能弹但复制无效」是同一根因（都走原生复制）。现 webview 侧复制逻辑抽单点 `webview/helpers/selectionClipboard.ts`——`installSelectionCopyGuard` 在 document `copy` 事件**同步**写 `clipboardData`（`if (!sel) return` 仅接管文档选区、放行输入框原生复制，不与图片粘贴 / 原生剪贴板打架）；`copyText` 从 `chatView` 外置到此（4 处调用方不变）。**为什么**：13 处 `user-select:none` 全挂标签 / 日期分隔、document 唯一 keydown 只处理 Esc、全仓无清选择逻辑、CSP 无 `clipboard` 限制——均逐符号排除假凶手。行数闸：`chatView.ts` 5097→5091（抽 `copyText` 定义 −11 + 导入 / 调用 +2，守 5098 闸门）；新文件 `selectionClipboard.ts` 58 行不计入四闸门文件。**对消费者**：选中消息正文 Ctrl+C / 右键复制 → 字节落盘；输入框内选中仍走原生（不被吞）；无选区时平台菜单复制行为不变。测试 `selectionClipboard.test.ts` 5 条（有选区写盘 + preventDefault / 无选区放行 / textarea 选区放行 / 幂等 / copyText 优先 `navigator.clipboard`）。

- **占用圆环「空态」滞留修复**（`OCC-STALE-1`）：配置热刷新（改窗口 / 切 Provider）重推 `chat_providers` 触发空态渲染后，圆环显示「0 条对话 · 100% 可用」且与真实占用矛盾，切会话才恢复。根因（两缺口叠加，均既有代码）：① `renderOccupancyLimit` 空态语义假设「首轮对话前」、配置变更也走同一分支 = 假事实（`contextLimitShown` 防误清零只比对数值，「变过去再变回来」即放行空态）；② 真实快照到达时机族漏了「配置热刷新」面，拦截类不发消息则空态无限滞留（非 IMG-8 引入，occupancy 链路零触碰）。现 `chatPanel.applyActiveProviderRefresh`（IMG-5 热刷新唯一入口，覆盖配置监听 / 切 Provider / 发送前 stale 补做 3 调用方）在 `refreshActiveProvider` 返回后补推 `postHistoryOccupancy()`；`handleSetProvider` 回滚分支 `pushProviders` 后同样补推。**对消费者**：改窗口配置保存后、无需发生 round，圆环即恢复真实占用；切 Provider 失败回滚后回到 prev 口径真实占用；切会话 / 流尾既有路径不回归（守内核 / 宿主边界，webview 侧零改动）。协议零新增（复用 `context_occupancy`，计数不变）。守卫 `chatPanelHistory.test.ts` 新增「配置热刷新（retryAgentAssembly）→ 补推 context_occupancy 纠正空态」——修复前红（`expected 0 ≥ 1`，红在判据上）、修复后绿。

- **中断兜底行直出裸英文 `interrupted`**（`TERM-REASON-1`）：`decideTerminus` 兜底分支构造对象写 `reason: 'interrupted'`（语义键）却当展示文案用，`stopReasonLabel` 无 `stopReason` 时回落原文 ⇒ 中断行出现裸英文。`decideTerminus` 兜底改传 `stopReason: 'interrupted'`（`reason` 仍填同键保可追溯），下游 `appendInterruptedRow` 对 `verdict.reason` 仅 `textContent` 纯展示、无字符串匹配（grep 实证零破坏面）。**为什么**：文案回落判据与调用点意图不同源（语义键 ≠ 展示文案）；取「构造点改字段」单点修正，不破坏 `stopReasonLabel` 的自由文本原文回落契约（调试可追溯）。**对消费者**：中断行显示「对话已中断」（中文），不再出裸英文。测试判据随事实更新（`'interrupted'` → `'对话已中断'`），prettier / tsc / eslint / processFlowModel 23 例 / 宿主全量 vitest 绿。

- **能力徽章链路补断言覆盖**（`CAPB-1`）：`#currentCapabilityBadge` 在生产骨架与测试夹具都存在、骨架 id 三方一致性守卫也覆盖其存在性，但全仓**无任何用例** dispatch `capability_badge`、也没断言过 `textContent` / `title` / `hidden` ⇒ 三分支（block 纯 LLM / allow + 无能力「全部工具」/ allow + 能力列表）全无守护。属静默失测形态（节点在、链路可跑、断言缺失），非代码缺陷。现补 4 例（block / allow + 空 / allow + 能力列表含重复 label 验去重 / 骨架初始 hidden）断言文案与 title；顺带修正 `roleBadgeView` 注释撒谎（实为骨架初始 hidden、无隐藏分支）。**为什么**：CHATVIEW-SLIM-3 第三刀搬迁前扫覆盖发现，行为等价不受影响，但缺口不补下次改动该链路无网可守。**对消费者**：无行为变化；能力徽章（模型支持的工具 / 视觉等能力）的展示逻辑此后有测试钉住。

## [0.3.0] · 2026-10-26 · 宿主

> **本区归属**：仅**宿主**（`hosts/memora-vscode`）变更，随 `vsce package` 定版，不进内核 npm 包（ADR-033）。**开区原因**：`vscode@0.2.0` tag 早于宿主 MCP 接入 ⇒ 已发布版没有任何 MCP 能力。**主体条目（MCP 接入）已于 2026-10-26 按 `git log vscode@0.2.0..vscode@0.3.0 -- hosts/` 补齐**（该区间实测 63 笔宿主提交，其中 33 笔属 MCP 接入）；切片叙事不复述，逐笔变更以该 tag 区间为准。**对外文档不引用内部台账坐标**（区名会随台账重组失效，tag 区间不会）。
> **随包内核代次 = `5.1.0`**（esbuild 内联 dist，内核自身变更见内核区）。

### Added（宿主）

- **MCP 工具接入（本地 stdio）：对话里可以直接调用外部工具服务器**（2026-10-23 ~ 10-25 落地，2026-10-26 补记）：Memora 现在是一个 **MCP 客户端**——你告诉它有哪些工具服务器，它把这些服务器暴露的工具注册进 Agent，模型在对话里能像调内置工具一样调用，工具名形如 `mcp__<服务器名>__<工具名>`。配置在**设置面板 → MCP** 页（每台服务器一张卡片 + 表单增删改），写用户级 `memora.mcpServers`；工作区级配置**不读**（可被他人提交进仓库 = 让任意仓库拉起任意命令，2026-10-25 定案不开放）。启动前做一次**静态预检**（命令是否存在 / 是否把脚本当命令 / 工作目录是否存在），不通过就不拉起并把原因写在卡片上。卡片给的是**真实状态**而非「我以为连上了」：已连接 / 启动失败（附原因）/ **待接入**（配置在、运行态还没追平——不是故障）/ 已停用 / 配置不完整。配置**改完即时生效**：新增立即拉起、改参数先停后起、停用与删除立即注销工具、改白名单只重算档位不重连；配置没变但连接已坏（子进程被外部杀掉）时热更不触发，用卡片「重启」按名字重建。也支持**粘贴 JSON 片段批量导入**（Claude Desktop / Cursor / VS Code `mcp.json` 均可），同名与字段不合法的条目逐条跳过、不覆盖已有配置。**为什么**：`vscode@0.2.0` tag 早于本接入，已发布版**没有任何 MCP 能力**，这 33 笔提交（占 0.2.0 之后宿主提交的六成）此前在本区一条未记。**对消费者**：这是 0.3.0 唯一的功能级新增；调用面如实登记四条边界——单次转发 60s 超时（超时不断连接，其余工具照常可调）、单条结果超 20,000 字符截断、图片/音频等非文本内容丢弃并注明类型、合计工具数 > 64 时在输出面板告警（工具过多会降低模型选对工具的概率，可停用部分服务器收敛）。**排障入口**：输出面板 → Memora（server 的 stderr 与宿主接入告警都在此处）；完整用法见 `hosts/memora-vscode/docs/mcp-setup.md`。

- **MCP 免确认白名单（工具级 / 整台级）**（2026-10-23 ~ 10-25 落地，2026-10-26 补记）：默认**每次调用都弹确认**（MCP 工具来源不可信，宁多弹窗不静默放行）；写进 `memora.mcpToolAllowlist` 后免弹窗但**仍写审计**（`write-auto`，可在审计记录里回查）。两种键都按**原始名**寻址：`mcp__<服务器名>__<工具名>` 只放行一个工具，`mcp__<服务器名>__*` 放行整台。最省事的做法是在 MCP 页的工具行勾「免确认」，写的就是这个键。**为什么**：只给「全问」或「全不问」两端，用户会在第三次弹窗时去关掉整个功能；放行必须逐台/逐工具显式表达才既能用又不失控。**对消费者**：① 没有「一次放行所有服务器」的写法（`mcp__*` 不是合法键，防「自动化默认」）；② 键若写成**显示名**（如 `my-tool` 被清洗成 `mcp__fs__my_tool`）**不命中**、回落为每次确认——写错的表现是「还在问」，不是「悄悄放行」（fail-closed）；③ 删除服务器**不联动**清白名单（那是逐条授予的信任记录），重新添加同名服务器时档位自动恢复；④ **整台级键是服务器级授权，不是工具名快照**——该台之后新增的工具（server 升级后多出工具、或同名换了另一台）**自动**落进免确认范围，不会重新问你，批准时也不存在「我当初批了哪几个工具」的记录可回查；工具名无法预知 ⇒ 想让新工具仍需确认的只能用工具级键逐个放行。

- **MCP 远程服务器接入（Streamable HTTP，无 OAuth）**（2026-10-25 落地，2026-10-26 补记）：配置项新增 `transport: 'http'` + `url`；**stdio 仍是缺省**，既有配置零迁移（写盘只在 http 时落 `transport`）。从外部格式导入时 `type: "http"` 映射到本仓 `transport`（别名只在写入点映射一次，读面零第二字段名）。**为什么**：远程 MCP 是社区主流形态，只支持本地子进程等于把一半生态排除在外。**对消费者**：① 远程服务器**没有表单编辑**（本期未做）——用页脚「粘贴 JSON」导入或手写 settings.json，面板只读标注 `http · <url>`，卡片上的「编辑」按钮对远程**置灰**（表单里没有 `url` / `headers` 字段，打开也只能填 command，而 command 与 http 互斥 ⇒ 那会是个点了必然失败的假动作）；② **SSE 已定案不支持**（只接 Streamable HTTP）；③ 本期**不含 OAuth**，需要鉴权的远程服务器会在 401 时落到「启动失败」（归因见下方 Fixed 条）；④ **`headers` 一律明文落盘**——作用域 `machine` 只表示不随 Settings Sync 同步到别的设备，**不是**加密存储，本机任何能读 `settings.json` 的程序都能看到里面的令牌；当前版本**没有** SecretStorage 托管入口，别把长期有效的高权限令牌放进去。

- **设置面板入口：侧栏「对话」视图标题栏齿轮**（2026-10-26）：`menus.view/title` 挂 `memora.openSettings`（`when: view == memora.chat`，icon `$(settings-gear)`），点开即 editor tab 形态的设置面板（默认落「记忆」页，单例复用已开面板）。**为什么**：设置整体迁 editor tab 后侧栏不再有设置入口，只剩命令面板——真机反馈「输入框没有直接打开设置页的按钮」，可发现性不足。**取舍**：走 VS Code 原生 view 标题栏而非 webview 内自建按钮 ⇒ **零协议改动、零 webview 改动**；刻意不给「当前角色徽章」挂齿轮（图标承诺全局设置、行为却落角色页 = 视觉谎报），也未给徽章加常驻描边（齿轮方案落地后即取代该思路，两处都做 = 同一问题双补丁）。角色徽章维持原职（点开落角色页），与齿轮职责不同、不构成双入口。

### Changed（宿主）

- **设置六页从侧栏 view 迁到 editor tab（L3 设置分家）**（2026-10-26）：`MemoraSettingsViewProvider`（`registerWebviewViewProvider`）→ `MemoraSettingsPanel`（`createWebviewPanel`）；package.json 侧栏 `memora.settings` 视图贡献项删除，对话 view 独占侧栏。导航仍走既有 `switchTab` + `_pendingTab` + ready 握手单点（`memora.configureModel` / `memora.openRoles` 落点不变）；panel 单例 reveal-or-create，**设 `retainContextWhenHidden: true` 保上下文**（切走 tab 是 editor tab 的常态用法，不设则每次失焦销毁上下文 ⇒ 六页表单草稿全丢；隐藏态投递语义官方注释两说，故导航在隐藏期只记 pending、转可见时补发，数据面同一时机补刷兜底，见下方条目），关 tab 仍走 dispose 后重开 + ready 握手重建；协议**零新增消息**、内核 `src/` 零改动、设置样式 / HTML 零逻辑改动（九条判据全过，收据见台账「L3 设置分家方案」条）。**为什么**：真机 UI 评审实测设置六页挤占对话空间、对话→设置→返回三层级导航、危险按钮贴脸、回执离视线远。**对消费者**：活动栏不再有设置入口，改用 `memora.openSettings` 命令或侧栏标题栏齿轮（见 Added）。

- **设置面板：上下文保留 + 打开入口收 tab 参数 + 挂载链数据驱动**（2026-10-26，L3 落地后审查修复）：
  **① 假前提订正（先认错再改）**：L3 落地时记「panel 无 `retainContextWhenHidden` 选项（API 本就不存在）」，据此判定「与侧栏隐藏销毁语义等价」——**该前提是假的**。`createWebviewPanel` 的 options 类型是 `WebviewPanelOptions & WebviewOptions`，后者明载 `retainContextWhenHidden?: boolean`，且默认行为是「面板不可见即销毁 html context」。后果真实存在：editor tab 切走是常态用法（改一半配置去看代码），而 webview 侧零 `setState` 兜底 ⇒ 六页表单草稿每次切换全丢。现设 `retainContextWhenHidden: true`。**代价不是「消息全丢」，而是官方文档在此自相矛盾**：`retainContextWhenHidden` 的注释写「You cannot send messages to a hidden webview, even with retainContextWhenHidden enabled」，同一份 `index.d.ts` 里 `Webview.postMessage` 的注释却把「hidden webviews that set retainContextWhenHidden」算作 live（可投递）——两句不可能同时为真。处理方式是不赌任何一侧：隐藏期导航只记 pending、转可见时补发（见下方条目），重新可见时另全量补刷一次作为**收敛网**（覆盖那些没有推送路径的宿主侧变更）。**对消费者**：切走再切回的设置页保状态，回来看到的是当前态。
  **② 打开入口收 `tab` 参数**：`memora.openSettings` 接受可选 `SettingsTab`，`memora.configureModel` / `memora.openRoles` 变为它的薄包装（命令名保留，既有 keybinding 不断）。`chatPanel` 的「tab → 命令名」映射表删除，`open_settings_tab` 的 tab 由 `Extract<…,'config'|'roles'>` 放宽回全集——收窄的前提（其余页无导航入口）已不成立。**对消费者**：无行为变化；**对后续加页**：不必新增命令或映射表，`executeCommand('memora.openSettings', '<tab>')` 直达。
  **③ 挂载链数据驱动**：`settingsView.ts` 六段手抄 try/catch → 一张 `mounts` 表，异常隔离语义不变（每项独立 try/catch，不截断末尾 ready 握手）。**为什么**：手抄版漏一段不会让任何测试红（该页有按钮无内容，只有真机能发现）；`settingsTabs.ts` 旧注释承诺「加 tab = 一行数组 + 两张 Record」与实际改动面差 5 处，已按实测订正为完整清单。
  **守卫**：`settingsPanelRoles.test.ts` 新增两例（创建参数含 `retainContextWhenHidden` / 仅由隐藏转可见才补刷），`settingsTabs.test.ts` 新增一例类型级（tab 收窄即 TS2322）。变异实测三条全红：`expected false to be true` / `expected "refreshAll" to not be called at all` / `TS2322: Type '"skills"' is not assignable to type '"config" | "roles"'`。

- **设置面板：导航落点可靠性 + 遗留四项收口**（2026-10-26，`L3-AUDIT-FIX-2`）：
  **① 导航判据从「panel 存在」改为「可投递」**：`_panel` 有值只说明 tab 存在，不说明脚本已注册监听器——`postMessage` 契约原文「A response of `true` does not mean that the message was actually received … no message listeners may have been hooked up」，而隐藏态又两说（见上条）。旧实现「投出即清 `_pendingTab`」在这两类时机（open→ready 之间 / 面板在后台）会把导航指令丢掉且宿主侧无痕，用户落在默认「记忆」页。现单点：`isDeliverable()`（`_panel` ∧ `_webviewReady` ∧ `visible`）+ `flushPendingTab()`（唯一投递点与唯一清空点，`switchTab` / `ready` / 由隐藏转可见三个时机共用）；不可投递时只记 pending。**对消费者**：设置已开但还在加载、或设置 tab 在后台时点角色徽章，仍会落在「角色」页。
  **② `settingsPanelHostDiag` 补接线自证**：`expect(posted).toHaveLength(0)` 是负向断言，`post → postMessage` 通道断线时照样绿（只证明「没发」，证明不了「发得出」）。现每例先投一条已知消息断言被捕获，再清空验零下行。
  **③ `memora.settings.focus` 消失记入 Removed**（见下）。
  **④ 闸门数字与注释对齐**：eslint 的 `settingsPanel.ts` 注「一 class 扛 5 个 tab」改为六页；三条 `max-lines` 按「闸门自报」口径下调（chatView 6716→6715 / chatPanel 4516→4515 / settingsPanel 2041→2037，只降不升）。
  **守卫**：`settingsPanelRoles.test.ts` 新增两例（未 ready 不投递且 pending 保留 / 已 ready 但后台不投递、转可见补发），`settingsPanelHostDiag.test.ts` 加接线自证。变异实测三条全红：判据退回 `_panel !== undefined` ⇒ 两例 `expected [ { …(2) } ] to deeply equal []`；去掉 `visible` ⇒ 后台例同上；`post()` 断线 ⇒ `接线自证失败：post → webview.postMessage 捕获链断了: expected [] to have a length of 1 but got +0`。

- **设置面板：切走再切回不再丢列表态（重推非破坏化）**（2026-10-26，`L3-CTX-KEEP-1` + `L3-CTX-KEEP-2`）：
  **现象**：`retainContextWhenHidden` 只保住了「输入框里还没提交的草稿」，保不住「列表正在看哪一页」——面板由隐藏转可见时宿主会重推一次数据（`refreshAll` 收敛网，覆盖那些没有推送路径的宿主侧变更），而 webview 侧把每次重推都当「新数据」处理：技能页 `pager.show(1, …)` + `contentMap.clear()` ⇒ 翻到第 N 页被打回第 1 页、已展开的技能正文收起并需要重新向宿主取；记忆页回第 1 页，且**搜索框里的词没清、列表却回全量**（界面自相矛盾）。**即：草稿保住了，列表态被反向洗掉 = 只保一半。**
  **修法（留触发、消代价）**：不删重推触发——「隐藏期消息是否可达」VS Code 自己的两份注释互相矛盾（`retainContextWhenHidden` 注说不可投递，`Webview.postMessage` 注把设了该选项的隐藏 webview 算作 live），两边各赌一半是最坏组合。改为让重推**非破坏**：① 技能页把展开态收进 `expanded` 集合（唯一真源，DOM 只做投影），`skills_loaded` 改为「留在原页（页数变少时向前夹取）+ 按名字逐出已消失技能」，不再整体清缓存；「整体清空」只保留给用户显式点刷新（显式意图与被动重推判据不同源，刻意不合并）。② 记忆页三条分支：搜索框有词 ⇒ 按原词重放 `memory_search`（检索只走一条路，不在 webview 本地过滤数组）；当前页 > 1 ⇒ 走既有 `memory_page` 增量通道取该页（首屏载荷只含第 1 页，直接铺会把第 1 页数据贴上第 N 页页码）；其余直接填充。③ 角色页同样漏扫（`roles_loaded` 无条件回第 1 页），本批一并收口，并把「保持当前页 + 越界夹取」的判据下沉到 `PagerController.showKeepingPage` 单点——调用方不得再各写一份 `Math.min(getPage(), pageCount)`。
  **对消费者**：切去别的 tab 再切回设置页，页面停在你离开时的那一页，展开的技能正文仍展开，搜索词与结果仍在同一上下文。**代价**：重推数据变了（例如角色包被删除）时按新页数向前夹取，落到最后一个有内容的页而不是空页。
  **守卫**：`settingsView.test.ts` 3 例（留在当前页 / 已展开正文保持展开 / 页数变少向前夹取）、`memoryView.test.ts` 2 例（第 2 页不被第 1 页数据顶替 / 搜索词重放且输入框与列表同上下文）、`pager.test.ts` 3 例（保持当前页 / 变少夹取 / 空数据集收敛）、`rolesView.test.ts` 2 例（重推保页 / 重推变少夹取），全部变异验证。

- **设置面板：子视图挂载表可被测试钉住**（2026-10-26，`L3-CTX-KEEP-2`）：`settingsView.ts` 的六页挂载表原在 `createSettingsView` 函数作用域内 ⇒ `settingsTabs.ts` 承诺的「加一页 = 挂载表一行」**没有任何测试能守住**，而漏一行的表现是「该页有按钮、无内容」：tsc 不报错、其余测试全绿，只有真机能发现。现提到模块级导出 `SETTINGS_VIEW_MOUNTS`，由 `settingsView.test.ts` 断言「表内 name 集合 == `SETTINGS_TABS`」+ 无重复 + 每项工厂为函数（断言集合相等而非顺序相等：UI 顺序与初始化时序刻意不同源）。**对消费者**：无行为变化；**对后续加页**：漏挂载从「真机才发现」变成「测试红」。

- **MCP 两键作用域 `application` → `machine`**（`H0-2`，2026-10-25）：`memora.mcpServers` / `memora.mcpToolAllowlist` 不再随 VS Code Settings Sync 同步。**为什么**：`application` 会把 `headers` 里的明文令牌与免确认批准带到同账号的其他设备——批准的语义是「本机用户同意本机进程」，跨机继承等于替另一台机器点同意。**对消费者**：① 只写用户设置、工作区 / 文件夹写入仍被忽略（`.mcp.json` 不读的红线不变）；② **升级后每台机器需各配一次**，原先靠设置同步带过来的 MCP 配置不会再自动出现；③ 本机已有配置不受影响。断言钉在 `mcpConfig.test.ts`（结构机制不在代码里，改 scope 只有这条测试能拦住）。

### Removed（宿主）

- **`memora.settings.focus` 命令**（2026-10-26，L3 设置分家的连带影响）：该命令**不是本扩展显式贡献的**——VS Code 为每个 `contributes.views` 视图自动提供 `<viewId>.focus`（本仓全历史 grep 无一处置，键位设置里却能搜到），`memora.settings` 视图贡献项删除后它随之消失。**对消费者**：若曾绑过该命令的快捷键，绑定会**静默失效**（按 id 调用不抛错，只是不再发生）；聚焦设置请改用 `memora.openSettings`。

### Fixed（宿主）

- **安装包夹带本地文件（出包前复核发现，2026-10-26）**：0.3.0 首版 `memora-vscode.vsix`（183 条目）里实际混进了 `mcp-acceptance-server.mjs`（手工验收脚本）、`.workbuddy/*.log` ×3（本地调试日志）、`.tmp-vsce.log`（vsce 自身临时日志）、`dist/.bundle-smoke/vscode-stub.mjs`（打包前门禁探针）。**成因**：`.gitignore` 与 `.vscodeignore` 是**两套判据**——前三个前缀都已在 `.gitignore` 里，`git status` 干净，但 `vsce` **不读 `.gitignore`** ⇒ 「仓库干净」被当成了「包内干净」。**修法**：`.vscodeignore` 补 `.workbuddy/**` / `*.log` / `.tmp-vsce.log` / `mcp-acceptance-server.mjs` / `dist/.bundle-smoke/**`，本地日志与临时产物同批删除。**对消费者**：安装包不再包含验收脚本与本地日志（183 → 177 条目，1,852,326 → 1,809,088 字节），运行时行为零变化。**守卫缺口如实登记**：无自动闸门——`vsce ls` 断言只查「该有的在」（`dist/extension/host/mcp/*.js`），不查「不该有的不在」，本次靠人工按条目清单逐条核对，登记于台账 F 段。

- **MCP 连接失败归因订正**（`H0-1`，2026-10-25）：没有 `tools` 能力的 server 此前被判成「server 未声明 tools 能力」并置 `failed`——但纯 `resources` / `prompts` 的 server 是**合法形态**，这是本宿主只接 tools 的**覆盖面边界**，不是对方故障。现文案改为「本宿主当前只接 tools 能力；该 server 只提供 X / Y，暂不支持（不是 server 故障）」，并对连上后被忽略的非 tools 能力打一次 info 日志（不静默）。**为什么**：谎报成因与谎报能力同族——原文案会让用户去查一台没坏的 server。**对消费者**：仅失败原因文案变化；无 tools 的 server 仍不注册空工具清单（不静默成功）。**登记**：方案-MCP工具接入 §10 新增「`resources` / `prompts` 零接入（能力边界 · 非功能缺口）」行。

- **角色页：角色包被清空后不再留着幽灵分页条**（2026-10-26，`L3-ROLES-SLIM-1`）：`roles_loaded` 收到空列表时，列表正确地换成了「暂无角色包」空态，但**分页条没被收掉**——它保留着上一轮的页码与条数（实测：17 个角色翻到第 2 页后角色包被清空 ⇒ 条上仍写「第 2 / 2 页（共 16 条）」且上下页都能点）。于是页面上同时存在「一个声称有 16 条内容、可双向翻页的条」和「一个永远空着的列表」，点翻页也翻不出任何东西。**成因**：空态分支渲染完空态引导就 `return`，跳过了分页态的收敛（`othersAll` 因早退没被清、`pager` 也没被重置 ⇒ 翻页切的是上一轮的旧数组）。现空态分支同批收敛两件事：`othersAll` 随 `lastData` 一并清空（派生数据必须随源更新），`pager.showKeepingPage([])` 让分页条隐藏、页码回到 1/1、上下页均禁用。**对消费者**：角色包全删光 / 切到没有角色包的工作区时，看到的是干净的空态，不会再有翻不出内容的条。**守卫**：`rolesView.test.ts` 新增一例（先翻到第 2 页，再投空载荷，断言分页条 `hidden`、双向 `disabled`、卡片数 0），变异实测：删掉收敛 ⇒ `expected false to be true`。

## [0.2.0] · 2026-10-23 · 宿主

> 仅**宿主**（`hosts/memora-vscode`）变更，随 `vsce package` 定版。**随包内核代次 = `5.0.0`**（esbuild 内联 dist，内核自身变更见内核区）。逐条拍板与变异验证收据见台账对应 ID。

### Added（宿主）

- **`@problems`：把工作区错误 / 警告挂进对话（有界注入第一笔）**（`HOST-CTX-4`，2026-10-21）：对话框原本只能挂「文件 / 目录 / 当前文件」——它们都只给**指针**，内容由模型自己读。但 VS Code 的诊断是**瞬态派生数据**，内核工具箱里没有 diagnostics（也没有 git / 终端读取），「提示模型去看」这条路根本不通 ⇒ 定案（`HOST-CTX-0`）为这类数据开了**唯一一处例外**：允许有界注入。本笔只落 `@problems` 一源（同版另有 `@git-changes` 有界注入二笔，见下条；terminal 源 spike 结论 = 不做、维持触发登记）。用法：输入框打 `@` → 列表置顶多一项「诊断（问题面板）」→ 选中挂一枚**与引用 chip 明显不同长相**的 chip（圆角矩形 + warn 色 + ⚠，形状/颜色/图标三通道可辨；**无锁**）→ 发送。**体验要点**：① 选中那一刻**不取数**，按下发送那刻才去问题面板拉最新（按严重度取前 20 条，每条带 `文件:行:列` + 错误文案 + 该行源码，超限明说「已截断」）；② chip **发完即消**——注入的是那一刻的快照，钉住就是下轮拿过期数据糊弄模型，要新鲜的下轮重点；③ 圆环 hover 卡片底部出「本轮注入 N」回执（分项明细同屏：当前文件正文 / 工作区诊断），下一轮发送覆盖；④ 历史里你的消息仍只显示你打的字（注入块回放时剥掉），但模型确实收到了。**同一笔的类型级重构**：`ActiveFileProjection.injectedTokens` 迁出为 `injection_summary.segments` 的 `active-file` 分项（三个源各挂一个字段 = 并列腐化 + 违反「与 CTX-6 同一处呈现」），本轮注入量自此**按源分项**回推、「渲染两处、数据一次」。协议 +2 条（消息计数 126 → **128**，治理阈值 130，**余 2**）。逐条拍板过程与 14 次变异验证签名见台账 `HOST-CTX-4`。**真机验收第一项通过**（2026-10-21 用户实测功能通过；反馈「徽记突然出现在状态行有点奇怪」⇒ 已按 `.injection-badge` 样式注释里预登记的回退方向，把回执从状态行徽记整模迁入圆环 hover 卡片底部、分项明细同屏可见，新形态与浅色主题 chip 对比度均于 2026-10-23 真机复验通过，`HOST-CTX-4` 关账）。
- **`@git-changes`：把 git 未提交改动挂进对话（有界注入二笔）**（`HOST-CTX-4`，2026-10-21 落地 · 10-22 三轮硬化）：@ 提及置顶项「未提交改动（git）」→ **发送时刻**宿主只读采集（`git status --porcelain -z` + `git diff` + `git diff --cached`；固定开关防中文路径八进制转义、防 ANSI 污染、防仓库配置借 diff 执行外部程序；子目录工作区按工作区根换算坐标），有界三道闸（≤20 文件 / 单文件 ≤200 行 / 合计 ≤12K 字符，超出明示截断），非 git 仓库 / git 缺失 / 执行失败一律给**事实行**、不给空。语义给的是真 `git diff`（未提交），不是「本会话助手改动快照」——「帮我的改动写提交信息」场景下模型看到的即 git 所见；未跟踪文件只给 `?? 路径`（git 不对未跟踪文件做 diff，如实为限）。注入形态与 `@problems` 同款（chip 无锁 · 发送即取即清 · 回执按源归因）。
- **输入框 @ 提及挂引用**（`HOST-CTX-1`，2026-10-20）：主输入框键入 `@` 弹出工作区文件 QuickPick（多选、模糊过滤），选中即挂引用 chip——想加文件不再必须去资源管理器右键。引用模式红线守住：@ 只是「挂引用的快捷入口」，宿主侧零内容注入。触发时 `@` 先留在正文（Esc 取消文本零扰动），mention 通道挂载成功后按触发点精准撤除该字符（判据不猜，其余入口不带信源不撤——防误删正文里邮箱等合法 `@` 字样）；文件列表逐项过首根归属判据（`relativeUnderPrimaryRoot`，第二根 / 根外连列表都不进，与 addToChat 拒挂同一契约两半）。协议最小改动：W→E `mention_open`（只报意图不传过滤词）+ E→W `addRef.source?: 'mention'`。守卫 webview 3 例 + 宿主 2 例，变异验证摘撤除调用即红。
- **@ 提及落地补强：判据守卫 + 截断明示 + 防重入**（`HOST-CTX-11`，2026-10-20，CTX-1 落地次日对抗式审查后当日修）：① 撤除 `@` 的判据中真正带语义的只有「落点恰为 `@`」一条（另两条 null / 越界删掉行为等价），而它此前**零测试**——实测删掉该行 chatView 448 例全绿；现补 2 例守卫（触发后文本被编辑 / @ 已被删，均不撤不猜），并订正「判据三重」的夸大措辞。② `findFiles` 上限命中即**静默截断**（大仓里搜不到目标文件还以为仓库里没有）——现上限提为导出常量 `MENTION_FILE_LIMIT`，命中时 placeholder 明示「已截断，请输入关键词缩小范围」（不用「提示项」进列表：QuickPickItem 无 disabled，选中即变伪引用）。③ 连按 `@` 会各开一个 QuickPick、后开的静默覆盖先开的且只撤一个 `@`——现加 in-flight 守卫（try/finally 保证异常路径也归位）。④ 订正退化分支注释的**描述性撒谎**：该分支唯一可达场景是「QuickPick 打开期间视图被销毁」，不是注释原写的「webview 未就绪」；代价如实改写为「多出一个延迟注入的引用」。守卫 chatView 450 / chatPanelMention 4，变异三次均红后还原。
- **修复输入 `@` 无反应：未知消息不再静默丢弃 + 消息链获得可测入口**（`HOST-CTX-12`，2026-10-20，真机验收发现当日修）：真机输入 `@` 字符正常落入输入框但 QuickPick 毫无反应。根因不是 `@` 分支写错，而是 **webview 脚本与扩展宿主不是同一版本**——webview 脚本是外部文件（`dist/webview/scripts/chatView.js`，从磁盘读 ⇒ 重编译后是新的），而宿主的消息分发活在进程内存里（旧的）⇒ 新 webview 朝旧宿主发 `mention_open`，旧宿主**没有任何分支匹配、静默丢弃**。修法第一动作是 Reload Window 重启扩展宿主，但真正的伤是「静默丢弃」本身：消息链**没有 else 兜底**，123 个类型里任何一个因版本错位不到达都表现为功能凭空消失、零反馈（「静默失败」族第三次踩）。① 加 else 兜底，未知类型落 `console.warn`（含类型名与「最可能原因：扩展宿主未重启」），不驱动 UI 不弹提示；② 🔴 把整条 120+ 分支的消息链从匿名回调**摘为 `private handleWebviewMessage`**——它原先零可测入口（加上兜底后立刻发现「有守卫却验证不了」），摘出后与 `handleInput` 等同构、测试可直接驱动。守卫 +1 例，变异（摘 `console.warn`）红后还原。
- **中文输入法 / 粘贴也能触发 `@` 提及**（`HOST-CTX-13`，2026-10-20，真机验收反馈当日修）：原触发判据是 `keydown` 的 `e.key === '@'`——那是**按键事实**，依赖键盘布局与 IME 行为；中文输入法插入的 `@` 不保证走 keydown，粘贴 `@` 根本不产生 keydown，两条路都表现为「要英文 @ 才有反应」。改为在既有 `input` 监听里加兜底：`inputType` 属 `insert` 家族 + 光标前恰为 `@`（**文本事实**）。`inputType` 判据不可省——删除文本同样触发 `input`，用户在「帮我@x」里删掉「我」后光标仍停在 `@` 后，不判 inputType 会把删除误判成插入而误弹列表。keydown 快路径保留（offset 语义更直接），英文键盘一次 `@` 两条路径都 fire 由 CTX-11 的 in-flight 守卫拦掉（复用既有机制，不新建第二套防抖）。守卫 chatView 453（+3），变异红后还原。
- **当前文件 chip：上下文附加可见 + 本会话可关**（`HOST-CTX-3`，2026-10-20）：输入框上方新增第三种 chip，把「当前打开文件会不会进本轮上下文」摊开——干净文件显示 `📄 docs/白话设计文档.md`（只给指针、不占预算），**有未保存修改 / 未命名 / 工作区外**时显示 `… · 未保存·全文已附`（这三类磁盘不是真相，注入正文），因此用户第一次能看懂「这条消息为什么突然贵了」。chip 上的 ✕ = **本会话**不再附加（关掉后整枚变虚线胶囊「当前文件未附加 · 点击启用」，点一下即回开，不留死角；重开面板复位为开）。开关状态与注入判据归宿主单点（同一份快照既拼信封又产出 chip），webview 只渲染不推断。
- **上下文透明性：指针提示 + 注入量归因**（`HOST-CTX-6`，2026-10-20）：①引用 chip 的 title 首句改为「仅挂指针，正文由模型按需读取（不占预算）」——挂了 ≠ 注入了，目录引用尤其如此（信封只给一张目录地图，内容按需 `list_dir`）；②发送后的本轮 chip 徽记短显注入规模（`未保存·全文已附 ≈3.3k`），title 给全数（`注入约 N token`）——「这轮贵在哪」有归因入口（圆环只示总量，这里示出处）。取数纪律：估算**只在发送时刻**取（正文块已在手，零额外读取），token 口径与内核 `estimateTokensText` 同源（宿主自估即第二真理源）；实时投影刻意不带此字段，正文惰性（CTX-3 收尾）不被显示需求破坏。
- **会话大纲导航条**（`HOST-NAV-1`，2026-10-20）：对话流右缘一列细横条，每轮用户输入一根；**视口内当前轮加粗高亮**，hover 弹浮层列出各轮输入预览（当前轮粗体），点击滚动定位——长会话「回到我上次说了什么」不再滚轮硬扒（ChatGPT 同款范式）。不足两轮或不可滚动时整条隐形。预览文本 = 上屏文本过 `stripInjectedContextPrefix` 归一（重放带注入前缀 / 运行时无前缀两路同源）；条列重建挂既有 MutationObserver 拍子（签名比对防流式期每帧重建）；点击定位后显式重算吸底标记（对齐一键到底纪律）。**2026-10-20 二轮加固（边界收口）**：长会话极端轮数不再外溢——改为**全量条 + 自适应压密**（轮数超出可用高时先压间隙、再压条高至下限，极端仍不足交条列自身滚动兜底，绝不画到输入区上）；高度上限按视口高内联下发（**条列** CSS 不再设 `max-height`，上限单一真源；浮层面板的 `max-height` 与该比例同判、另留在 CSS）；条更短、右缘更紧（条宽 `--sp-6`→`--sp-5`、`right` `--sp-2`→`--sp-1`、去横向内距）；修复重建指纹「条数 + 首尾长」在重放 / 分叉（中段变化而首尾同长）下静默失效（改全量预览拼接）；`resize` 触发压密重算。**2026-10-20 三轮复核（SSOT / 不带伤）**：轮次收集锚由 `.msg-wrapper` 改为 `.msg.user`——该外壳由 `append()` 的 else 分支创建、**同包 user 与 error**（错误气泡会被误算作一轮、错误文案进条列与预览），锚 `.msg.user` 天然筛除；压密常量（条高 / 间隙 / 高度比例）与设计令牌的镜像补**测试守卫**（漂移即红，闭合「仅注释自认」的静默风险）。
- **文档上下文改按引用模式注入**（`HOST-CTX-0` 落地，2026-10-20）：活动文件**干净**时不再把全文塞进每轮消息（此前最多 12000 字符 ≈ 3~4k token），改为一行指针（`当前打开文件：path`）让模型按需 `read_file`；文件**有未保存修改 / 未命名 / 不在工作区内**时仍注入正文（这三种情形磁盘不是真相，只给指针会让模型读到旧版或读不到）。对消费者：预算显著下降；未保存编辑的可见性与「编辑器随手一开就注入」的旧观感不同——现在只有脏文件才注入。
- **引用 chip 点击跳回编辑器**（`HOST-CTX-8`，2026-10-20）：chip 的路径与行号是两个独立可点域（补 `role=button` / `tabindex` / Enter-Space），点击打开文件并选中该行区间，目录则在资源管理器露出；失败走面板内提示单一出口。
- **编辑器选区引用带行号**（`HOST-CTX-2`，2026-10-20）：右键「添加到对话」对当前编辑器文件挂 `path#L{start}-L{end}` 指针（1-based 闭区间，0→1 基准只在宿主转一次），信封把 `read_file` 的 `offset`/`limit` 预先算好给模型——选中 20 行不必读整个文件，引用模式仍不注入内容。
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

- **当前文件气泡也只显示文件名**（`HOST-CTX-18`，2026-10-20 真机验收 CTX-16/17 通过后即修，CTX-17 同族延伸）：输入盒上方「当前文件」chip 的可见文本同步降噪为文件名（`docs/白话设计文档.md` → `白话设计文档.md`）——复用 CTX-17 同一纯函数，不新建第二份判据；完整路径保留在 title 末尾括号（注入语义仍是第一问）与 ✕ 的 aria-label。活动文件永远只有一个，不存在引用气泡的同名撞车，纯文件名零歧义代价。守卫 +1 例、原「干净文件」例断言同步订正；变异（退回全路径）红后还原。

- **@ 提及列表收起后焦点自动回到输入框**（`HOST-CTX-16`，2026-10-20 真机验收通过后反馈即修）：Esc 取消或确认选中文件后，VS Code 不会把焦点还给 webview 输入框（QuickPick 是宿主全局 UI，焦点被它拿走就不还）⇒ 想继续打字得先用鼠标点一下。协议加 E→W `focus_input`，宿主在 QuickPick dispose 后、确认/取消分叉前发一条（两条收场路共用一个出口；未开工作区 / findFiles 抛错时 QuickPick 从未开出，天然不发），webview 只 focus、不动文本（@ 撤不撤归 addRef 的 source 分支）。守卫 accept/cancel 两路 + webview focus 例，变异双红后还原。
- **引用气泡只显示文件名**（`HOST-CTX-17`，2026-10-20 真机反馈即修）：附件行引用 chip 的可见文本从完整相对路径改为文件名（`src/webview/scripts/chatView.ts` → `chatView.ts`）——信息不丢：chip title 末尾括号（hover 消歧同名文件）、pin/remove 的 aria-label（屏幕阅读器）、open_ref 载荷与发送信封三处各司其职。范围只及用户添加的引用；活动文件 chip（自动投射）语义不同不动。已知限制：同名文件可见标签相同靠 hover 区分（刻意不上父目录消歧，复杂度守恒）。

- **@ 文件列表不再被 node_modules 挤爆 + 排除语义注释谎言订正**（`HOST-CTX-14`，2026-10-20 当日三审发现即修）：输入 `@` 弹出的文件 QuickPick 此前给 `findFiles` 传 `undefined` 排除——VS Code 源码一手实读：legacy `findFiles` 只应用 `files.exclude`、**不应用** `search.exclude`、`.gitignore` **默认不尊重**（1.87 起硬编码，PR #204845）⇒ `node_modules`（本仓实测 32,040 文件）/ `dist` / `coverage` 全进列表、撞 2,000 上限**静默截断**，用户想引的源码文件随机缺席，而 placeholder 只说「已截断」不说原因（搜不到还以为没有）。修：① 新建 `extension/host/ignoredDirs.ts` 单一真源（派生自内核 `IGNORED_DIR_NAMES`，与 `search_project` / `list_dir` 同一套忽略规则），mention 与 `projectSearchProvider` 两处 `findFiles` 同挂（消一份行内第二基线）；② placeholder 补「内置忽略目录已排除、仍超上限」；③ 订正两处注释的三项断两项谎话。守卫 chatPanelMention +1 例 + 截断例 +1 断言；变异三连均红后还原；全量 78 套件 1396 passed / 2 skipped。

- **编辑器右键「登记作品投影」在选中行时仍出现**（`HOST-MENU-2`，2026-10-20）：该命令只登记整个文件（`works` 存储无区间字段），带选区时出现会让人以为「登记了这几行」⇒ `editor/context` 的 `when` 加 `!editorHasSelection`，编辑器入口只在无选区时出现；命令面板入口不变。
- **引用标签与定位的四处漂移**（`HOST-CTX-2` / `HOST-CTX-8` 收尾，2026-10-20）：① `#L` 标签改由 `shared/refKey.formatRefRange` 单点产出——此前键 / chip / 行号 span / 信封各写一套，单行引用在 chip 显示 `#L7`、喂给模型却是 `#L7-L7`；② `open_ref` 定位改用与内核 `read_file` cwd **同源的首个工作区根**（原「逐根取第一个存在」在多根工作区会打开另一根的同名文件，用户核对的和模型读到的不是同一个）；③ 非法行区间（`start > end`）统一降级为整文件引用，不再算出 0 或负数 `limit`；④ 目录引用的读取工具名改为 `list_dir`（原写 `read_file`，而 `read_file` 只读文件——等于给模型一条必然失败的指令）。
- **当前文件上下文：显示订阅不再每次击键读全文**（`HOST-CTX-3` 收尾，2026-10-20）：为修「缓存撒谎」把快照改为发送时实时读之后，显示订阅（换文件 / 同文件被编辑 / 保存）按**每次击键**取快照，而旧快照顺带产出注入正文（`getText()` 全篇）⇒ 大文件下**每敲一个字就全量读一遍文档**。已拆为「廉价事实快照（文件名 / 脏态 / 相对路径，不读正文）+ `readDocBody` 惰性读取」，`resolveActiveFile(withBody)` 显示路径恒 `withBody=false`（零 `getText`）、仅发送且本轮**真要注入**时才读。守卫 `chatPanelHistory` +1 例（快照 `getText` 读取次数恒 0）。
- **多根工作区右键「添加到对话」挂出模型读不到的引用**（`HOST-CTX-9` 创建侧，2026-10-20）：原 `addToChat` 用 `asRelativePath` 生成 `ref.path`（相对**「所在根」**），而模型 `read_file` 的 cwd 与 `open_ref` 定位都恒取**首个工作区根** ⇒ 在**第二根**下落引用，chip 显示正常、模型却按首根读到同名路径（不存在即失败）。新增根归属纯函数 `extension/host/refPath.relativeUnderPrimaryRoot`（以首根为唯一基准，越出即拒），`addToChat` 改为 **fail-closed**：不在首根下的目标不挂引用并提示（挂一条注定读错的指针比不挂更坏）。同批把**消费侧**（`open_ref` 点击定位的越界守卫）也收口到同一模块（`refPath.resolveUnderPrimaryRoot`，含规范形往返校验）——此前生成 / 消费两半各写一套判据且消费侧零测试，属第二真理源。
- **引用文件失效后信封仍给出死指针**（`HOST-CTX-9` 发送侧，2026-10-20）：引用挂上后文件被删 / 改名，下一轮信封仍写 `- 参考文件：old/path.ts（offset=… limit=…）`，模型照读撞一次错、用户只看到「模型读文件失败」，不知道引用已过期。发送前新增**无状态**存在性核实 `extension/host/refProbe.collectMissingFileRefPaths(refs, rootFsPath, stat)`（`stat` 注入式、`Promise.all` 并发、空 root / 零文件引用短路；解析器**复用** `refPath.resolveUnderPrimaryRoot` 首根 SSOT，不另写守卫），失效者在 `docContext.refItemLine` 降级为**裸指针 + 「注意：添加后已不存在，请向用户确认」**，并**去掉 `#L` 区间与 `offset/limit`**（死文件上的精确读参数同样注定读空——纪律「绝不给 `read_file` 一条必然失败的指令」）。刻意**不维护「失效引用集合」**（那是第二真理源、必与磁盘漂移）。**偏离登记**：① 台账原写 `fs.stat`，实现改用 `vscode.workspace.fs.stat`（异步、兼容远程 / 虚拟 FS，与 `extension.ts` 既有用法同源）；② 标记文案原拟 `⚠`，改**纯文本**——`iconLanguage` 守卫把 `⚠` 列为 webview 代码内禁用的字符图标，且该块被剥离契约从 UI 隐藏、只喂模型，纯文本无损。守卫 `refProbe.test.ts` 6 例（存在 / 不存在 / 目录忽略 / 解析失败计入 / 空 root / 多引用并发）+ `docContext.test.ts` +4 例（失效带 range 去参数 / 无 range / 目录不标 / 未命中与缺省原样）。
- **引用 chip 行缺批量出口**（`HOST-CTX-7`，2026-10-20）：挂 6 个引用要逐个点 ✕ 六次。引用行在引用存在时追加**「清空全部引用（含常驻）」**按钮（范式照抄待发送行的 `pending-queue-bar__clear`），点击 = webview 本地清 `currentRefs` 并重渲染——**刻意不走上行消息**：待发送队列清空走 `clear_pending_queue` 是因为其 SSOT 在宿主，而引用 SSOT 在 webview（单删 ✕ 同为纯本地过滤），上行等于让宿主镜像一份引用状态（第二真理源）。范围**只及引用**：活动文件 chip（CTX-3 本会话开关、宿主投影）不受牵连；pinned 一并清（与 ✕ 语义一致，🔒 只管「发送后是否保留」）。样式零新增规则（`.ref-chips__clear` 并列进 `.skill-chip__remove` 既有选择器组，一份规则多锚点）。守卫 `chatView.test.ts` +4 例（批量清空 + 断言无上行 / pinned 一并清 / 活动文件 chip 不受牵连 / 无引用无按钮）。
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

- **附件行改单轨横向滚动**（`HOST-CTX-10`，2026-10-20）：输入框上方的技能 chip 行与引用 chip 行不再换行堆高（挂 3 枚以上就顶起输入区、压扁对话区），改为单轨排列、超出横向滚动、滚动条隐藏，**鼠标滚轮直接横切查看**（触控板原生横滑不受影响）；两侧按溢出位置做边缘渐隐，作为「这一侧还有 chip」的唯一可见线索。拦截只在**真的溢出**时发生——装得下时滚轮照旧滚对话，不劫持。
- **记忆显示正文为主位**（`MEM-UI-1`，2026-10-19）：设置记忆卡片（含回收站）与聊天命中项不再默认展示机器 id/name，改显示记忆正文预览（内核 `contentPreview`/`content` 新字段，旧内核按 name→id 回退链降级）；id 保留于 dataset 反馈寻址与 tooltip、卡片详情保留全文与溯源。
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
