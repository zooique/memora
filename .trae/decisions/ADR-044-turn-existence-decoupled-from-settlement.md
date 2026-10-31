# ADR-044 · 轮的存在性与收场解耦（建轮即入会话）

> **状态**：✅ 已落地（四刀全部完成；各刀「仍未覆盖」段如实登记残留）**日期**：2026-10-31
> **播种批次**：ask 批次链路真机验收（0.5.0 轮）**来源**：真机停滞轮 + 三条同源缺陷复盘

## 背景

真机验收暴露一组现象，初看是三个独立缺陷，回源后是**同一条设计假设**的三处投影。

该假设是：**一个轮只有「收场之后」才算存在。** 具体表现为三处：

1. **不可见**：`MessageHistory.appendUser` 建轮时写 `refCount: 0` 且不登记会话
   `roundIds`——登记发生在 `appendAssistant` / `appendInterrupted`（收场侧）。
   而宿主会话视图按 `roundIds` 加载 ⇒ **未收场的轮在视图里不存在**。
2. **不回收**：GC 的孤儿判据是 `refCount === 0 && status === 'pending'`（带 24h 存活保护）。
   未收场的轮恰好满足该条件 ⇒ 它被视为「崩溃孤儿」，24h 后静默回收。
3. **不兜底**：两个兜底机制都挂在收场之后——
   - 打捞 `upgradeInterruptedRounds` 有 `_salvageUpgraded` once-guard，且只在视图 ready 触发一次
     ⇒ 本次会话内**之后产生的**停滞轮永不被打捞；
   - ask 超时保底 `AskCoordinator.handleAskTimeout` 首行 `if (!isAskWaiting()) return`，
     而停止/异常已使相位离开 `waiting(ask)` ⇒ **超时回调静默早退**，永不收场。

于是「半死的轮」三重兜底全失效：**不可见 → 不打捞 → 超时也不收场 → 24h 后被回收**。
用户的体感是「我说过的那句话凭空消失了」，而磁盘上它其实一直在。

### 与既有定案的冲突（本 ADR 要消除的矛盾）

`Round.refCount` 的注释写着：interrupted 轮「运行期收场已即时标 interrupted 且 refCount 0→1，
不再符合 `refCount===0 && pending` 的崩溃孤儿条件」。

这条定案**把「可见」和「可回收」绑在同一个字段上**：`refCount` 同时表达
「被会话引用（可见）」与「不是孤儿（可回收）」。两者本是两件事，绑在一起后必然出现
「要么都成立、要么都不成立」的死角——停滞轮恰好落在「都不成立」的那一格。

## 决策

**把「存在」与「收场」解耦：轮一旦创建就属于会话；收场只改变状态，不改变归属。**

1. **建轮即入会话**：`appendUser` 建 pending 轮时直接
   `refCount: 1` + `sessionStore.appendRoundId(currentSessionName, roundId)`。
2. **收场不再登记归属**：`appendAssistant` / `appendInterrupted` 只更新
   `status` / `assistantMessage`，**不再** `incrementRef` / `appendRoundId`
   （判据保留 `isRoundSettled` 防重复登记，但动作降级为纯幂等校验）。
3. **中断 = 主动收场**：用户停止、流异常、崩溃重启三条路径**统一走 `appendInterrupted`**。
   停止不是「不处理」，是「明确地以中断收场」。
4. **超时保底去相位化**：`handleAskTimeout` 的判据从「相位是否仍 waiting(ask)」
   改为「该提问是否仍未被消费」（落点 = 宿主在途快照 `_pending`，相位本就由它派生）；
   「还能不能续跑」另判内核是否仍持暂停检查点——不可续跑时以中断收场，不「假续跑」。
5. **GC 孤儿判据换轴**：已入会话的 pending 轮**不再视为孤儿**（它可见、可删、可续跑）；
   判据仍是 `refCount === 0`，但语义收窄为**「真正无人引用」**——新轮建轮即 1，故
   「进行中」本身不再构成孤儿；能落到 0 的只有存量轮、删会话/截断后归零的轮。
   ⚠️ **「归属登记失败」这一面不落入该判据**（refCount 已写 1、只是 `roundIds` 没写上）⇒
   该轮**不可见且不会被 GC 回收**，属**有意取舍**（宁可留一个看不见的文件，不静默删用户
   刚输入的内容）。勿据此宣称「判据完备」——它不覆盖登记失败面，已在代码注释与本 ADR 写明。
   24h 存活保护保留，作用改为「给刚归零的轮留后悔窗口」。

## 理由

- **消除死角，而不是补第三层兜底**：现有三处失效都源于同一假设，逐处打补丁会得到三层
  互相不知道对方存在的兜底——本项目已经因此付过一次代价（三重兜底全挂在收场之后）。
- **语义与用户直觉一致**：「我说了就算存在」。存在性由**创建**决定，不由**成功**决定。
- **`refCount` 语义归位**：它是**真引用计数**（`forkSession` 会给共享轮 +1），
  不该兼职「孤儿标记」。让它只表达引用关系，回收判据另找事实。
- **不引入新状态**：不改 `Round` 结构、不加 `draft` 状态、不加新表——只改三个写点与一个判据。
- **半截轮不会污染模型上下文**：上下文装配读的是消息史 + round 内容，
  与「视图是否可见」是两条正交的路（本决策只动后者）。

## 替代方案

| 方案 | 放弃原因 |
|---|---|
| 只修中断路径（让停止也调 `appendInterrupted`） | 治不了崩溃/断电：那两条路径根本没有收场调用点，轮仍是 pending 且不可见 |
| 保留「收场才入会话」，把打捞改成常驻定时器 | 仍不可见——用户重启后看不见它，直到打捞跑完；且定时器引入新生命周期与停机关闭问题 |
| 视图改为「扫 RoundStore 全量 + 按日期过滤」 | 视图依赖全库扫描，会话边界失效（会看到别的会话的轮）；且与 `roundIds` 这个既有 SSOT 并列成第二真源 |
| 新增 `draft` 状态表达「可见但未收场」 | 复杂度不匹配：只是「存在性」一个维度，用状态机表达会与 `pending/complete/interrupted` 正交，产生组合爆炸 |

## 影响

- **内核**：`appendUser` / `appendAssistant` / `appendInterrupted` 三处归属写点；
  `Round.refCount` 注释与 `roundStore` 孤儿注释需同步改口径（否则又是注释撒谎）。
- **宿主**：`upgradeInterruptedRounds` 的 once-guard 语义重审（有了「停止即收场」之后，
  打捞只服务跨重启残留，once 是否仍合适需实测）；`handleAskTimeout` 判据换源。
- **GC**：孤儿判据注释与默认参数注释同步（24h 保护的存在理由从「防删未答轮」变为
  「防删连归属都没写成的残留」）。
- **数据兼容**：历史数据里已存在的 `refCount: 0 && pending` 轮，升级后仍按旧判据可回收
  ——不迁移、不回溯登记（存量半截轮本就该被清）。
- **公开面**：若新增/删除公开成员，须按 ADR-039 准入并同步 `publicMemberSurfaceGuard`
  （该守卫现已挂进 fast 档，忘登记会在提交前红）。

## 分层刀法（禁止混刀）

1. **第一刀（内核契约 + 打捞判据）**：`appendUser` 建轮即登记归属 + 收场侧降级为幂等校验；
   **同时**把 `listInterruptedRecent`（内核 `inMemoryRoundStore` 与宿主 `workspaceRoundStore`
   两处同款实现）的筛选条件从 `refCount === 0 && (pending|error)` 改为 `(pending|error)`。
   判据 = 新建轮在 `sessionStore.getRoundIds(sessionId)` 内立即可见、`refCount === 1`；
   收场后 `refCount` 不再增加；**真杀进程后重启仍能打捞到该轮**。
   变异：登记移回收场侧 ⇒ 可见性用例红；打捞判据改回 `refCount === 0` ⇒ 跨重启 e2e 红。

   ⚠️ **为什么打捞判据必须并入本刀（本 ADR 初稿的分层错误，实测订正）**：初稿把「判据换轴」
   整体归入第四刀，只点了 GC。实测（2026-10-31）把登记提前后，宿主 `crossRestartRecovery`
   e2e 立刻 4 红——`listInterruptedRecent` 筛的正是 `refCount === 0`，新轮 refCount 1 就
   **永远捞不到** ⇒ 跨重启恢复直接失效。**`refCount` 有两个消费者：GC 与打捞**，初稿只数了
   一个。教训：改一个字段的语义前，先枚举它的全部读取点（`grep refCount` 而非凭记忆）。
2. **第二刀（中断路径统一）✅ 已落地**：停止 / 异常 / 崩溃重启三路统一走 `appendInterrupted`。
   前置依赖第一刀（否则中断轮仍不可见）。落地载体 = 内核公开 `Agent.abandonTurn()`：
   `cancelAsk` + `appendInterrupted(当前轮)` + `discardCurrentCheckpoint`，宿主停止路径消费。
3. **第三刀（超时保底去相位化）✅ 已落地**：`handleAskTimeout` 判据改为「提问是否仍未被消费」，
   并删掉 `isAskWaiting` / `getTurnState` 两个反向依赖；不可续跑 ⇒ 走同一 `abandonTurn` 收场。
   ⚠️ **原始归因（「被 isAskWaiting() 守卫早退」）已被实测证伪**，详见下文落地记录的「先说被推翻的归因」。
4. **第四刀（GC 判据确认 + 注释同步）✅ 已落地**：`sweepOrphans` / `listOrphaned` 的孤儿判据仍为
   `refCount === 0`——本刀确认它在 ADR-044 后**依然成立且语义正确**（新轮 refCount 1 不再落入
   该判据，即「已入会话的 pending 轮不会被超龄静默回收」，与决策 5 一致），并同步
   `DEFAULT_SWEEP_MIN_AGE_MS` / `listOrphaned` / `sweepOrphans` / `gcService` 四处注释口径
   （「存活保护」的理由从「防删未答轮」改为「给刚归零的轮留后悔窗口」）。
   ⚠️ **打捞判据已在第一刀处理，勿在此重复**——两者虽都曾读 `refCount`，但一个判「可回收」、
   一个判「待收场」，职责正交。

## 第一刀落地记录（2026-10-31）

**改动面 6 文件**：`messageHistory`（建轮即 `refCount: 1` + 归属登记；收场两处降级为
`attachUnownedRound` 兼容面；新增 `registerRoundInSession` 单点）/ `roundStore`（`refCount` 与
打捞关系注释订正）/ `inMemoryRoundStore` + 宿主 `workspaceRoundStore`（打捞判据去掉
`refCount === 0`）/ 三份测试（契约翻转 + 两条新用例）。

**关键设计点：`save()` 已是计数的单点，不要再调 `incrementRef`**
宿主 `workspaceRoundStore.save(round)` 用 `round.refCount` 重建索引条目 ⇒ 构造时写
`refCount: 1` 一次落盘即可。若沿用「save 后再 incrementRef」，会二次落盘，且让「建轮」与
「收场」两处并改写同一个计数——那是两个真相源。

**兼容面（不带伤的关键）**：**不能直接删掉收场侧的归属登记**。`refCount === 0` 的存量轮
（ADR-044 之前落盘、或建轮时登记失败的异常残留）若被删登记，会**永久不可见**——比「被 GC
回收」更糟（用户连删都删不到）。故收场统一走 `attachUnownedRound`：`refCount 0` 才补登记 +
补到 1，新数据 no-op。

**判据与变异（全部实测）**：

| 项 | 结果 |
|---|---|
| 新建轮在会话 `roundIds` 内 + `refCount 1` + 收场后仍为 1 | 新用例 2 条（含断开「收场不再 +1」与「不重复登记」） |
| 变异 A：不登记归属（`if (false)`） | 红 4 例，`expected [] to include 'round-…'` |
| 变异 B：`refCount` 改回 0 | 红 2 例，`expected +0 to be 1` + 重复登记（`length 1 → 2`） |
| 真杀进程 → 重启 → 打捞 → 收场 | 宿主 `crossRestartRecovery` **9/9 绿** |
| 内核全量 | 3081 passed / 120 文件 / EXIT=0（+2 = 新用例） |
| 宿主全量 | 2275 passed / 129 文件 / EXIT=0 |

**契约测试翻转**（旧断言 = 本条要消灭的形态，逐条改成新契约）：`sessionStoreContract`
三条（「仅写 pending 不登记」「收场登记 refCount 0→1」「缓存丢失补登记」）、`degradation`
两条（「不登记」）、`crossRestartRecovery` 一条（「崩溃瞬间会话不认它」⇒ 改为「已认它」）。

**ADR 分层订正**：初稿把打捞判据归第四刀，实测证明它必须与建轮登记同批——详见「分层刀法」
第一刀的 ⚠️ 段。

## 第二 + 三刀落地记录（2026-10-31 · 一次落地，共用一条收场原语）

### 先说被实测推翻的归因（原始报告 → 事实）

真机复盘报告把「停止后超时兜不住」归因为 **`handleAskTimeout` 首行 `isAskWaiting()` 守卫静默早退**。
**该归因不成立**（代码 + 盘面双向取证）：

- `deriveTurnState` 的判据①是「`questions` 非空即 ask」，**压过 paused / streaming** ⇒
  只要宿主在途快照 `_pending` 非空，相位恒为 `waiting/ask`，`isAskWaiting()` 恒为真。
  停止只弃检查点、并不清 `_pending`，故**那个守卫从未触发**。
- 盘面佐证（真机 `E:\ceshi\.memora\rounds`）：停滞轮 `status: pending`、`pendingAsk` 三条俱在、
  **无 `assistantMessage`**——与「守卫早退」无关，是轮根本没进收场。

### 真实机制（三重，逐条回源）

1. **ask 挂起轮没有收场调用点**：`handleAskUser` 只 yield `paused`，没有正文 ⇒ 回到
   `SeedOrchestrator.act()` 时 `appendAssistant(content)` 命中空正文守卫
   `if (!content.trim()) return` ⇒ 轮不落 assistant、不转状态，**停在 pending 等 `resume`**。
2. **停止只弃暂停上下文**：`handleStop` 的 paused 分支原为 `discardCurrentCheckpoint()`
   （清 checkpoint + 排队插话 + 状态机 resetToRunning），**不动轮、不动宿主 `_pending`、不清 timer**。
3. **超时保底的唯一收场通道会静默空转**：`Agent.resumeExecution` 首部
   `if (resumeStatus !== 'paused') return;` —— 检查点已弃时它既不续跑也不报错，
   于是超时打出的「未回答」行**只上屏、不落盘**，轮仍 pending。

### 比原报告更重的一条（本刀实测新发现）

停止后 `_pending` 未清 ⇒ `_turnState` 恒 `waiting/ask` ⇒ `handleInput` 把用户**下一句话**
路由进 `answerInput` ⇒ `answerQuestion` 在进程内消费掉提问 + `resumeExecution` 静默 return
⇒ **用户输入凭空蒸发（既不进消息史、也不落盘、模型更没看到）**。
这解释了「停止之后这个面板像哑了一样」的体感，比「轮挂在 pending」严重。

### 决策落地（两条互补，共用 `Agent.abandonTurn()`）

| 面 | 改动 | 判据 |
|---|---|---|
| 内核 | 新增公开 `Agent.abandonTurn()`：`cancelAsk`（保 `assistant.tool_calls` 配对）+ `appendInterrupted(当前轮)`（盘上 `pendingAsk` **整组**转 `unanswered` 交互输入）+ `discardCurrentCheckpoint`；返回「检查点是否被清」 | 盘面 `status: interrupted`、`pendingAsk` 消失、N 条 `unanswered` 带题面；幂等重跑不二次写 |
| 宿主停止 | `handleStop` paused 分支改走 `AskCoordinator.abandonOnStop()`（清 `_pending` + 清 timer + 逐条 post `unanswered` 行 + `abandonTurn`），随后 `syncPendingQueue(true)` **无条件**重投影相位 | 相位不再停在 `waiting/ask`；未答行与盘面同文案同身份 |
| 宿主超时 | `handleAskTimeout` 判据收窄为「提问是否仍未被消费」（本域 `_pending` 非空），**删掉相位判据与 `getTurnState` 依赖**；可续跑（`status === 'paused'`）走原续跑，否则走 `abandonTurn` 收场 | 无可续跑点时不再「假续跑」；轮不残留 pending |

**决策 4 原文的订正**：原文写「以 `pendingAsk` 快照是否存在为事实判据」——落地后判据落在
**宿主在途快照 `_pending`**（内核 `pendingAsk` 的宿主侧唯一 intake，相位由它派生），
「可续跑性」另判内核是否仍持暂停检查点（与 `resumeExecution` 内部判据同源）。
两件事分开判，才不会有第二条真相。

**依赖收敛**：`AskDeps` 从 5 个降到 3 个（删 `isAskWaiting` / `getTurnState`）——域不再反向
依赖相位投影，而相位本就由域内快照派生（反向依赖 = 第二真相）。

**变异（全部实测，红→绿闭环）**：

| 变异 | 结果 |
|---|---|
| 去掉 `abandonTurn` 内的 `appendInterrupted` 调用 | 内核新用例 2 例红：`expected 'pending' to be 'interrupted'` |
| `abandonOnStop` 不清 `_pending` | 协调器 + chatPanel 2 例红（`expected [...] to deeply equal []`） |
| `handleStop` 不重投影相位 | `expected 'waiting' not to be 'waiting'`（红在该判据上） |

⚠️ **首轮变异假绿教训**：新写的 stop 用例最初从 `setup()` 起手，起始相位本就是 `idle`，
「停止后不再是 waiting」恒真 ⇒ 删掉重投影仍绿。改成先走**真实事件链**（`driveSuspendedFlow`
坐实 `waiting/ask`）再停止，变异才红。**断言必须锚在状态迁移上，不能锚在迁移后的静态值上。**

**收据**：内核全量 **3083 passed / 120 文件 EXIT=0**（+2 新用例）；宿主全量
**2277 passed / 129 文件 EXIT=0**；`chatPanel` 4526 行 ≤ 4529 闸门。

### 仍未覆盖（如实登记）

- **abort-during-ask 微窗口**：`_streaming` 为真时按停止走 `abort()`，轮经 `act()` 的
  `aborted` 分支收场（已有路径），但宿主 `_pending` 若此刻非空不会被同帧清掉；
  超时保底现在会以 `abandonTurn` 收场（不再空转），故只影响「下一次投影前的相位」。
- **`unanswered` 行的题身份仍退化**：`RoundPendingAsk` 未承载 `askCallId` ⇒
  `appendInterrupted` 走 `buildInteractiveInputs` 的序号回退，与运行时行（`askCallId`）
  不同 id。功能无影响（重放重建时只读盘面），但 ADR-043「题身份跨面恒定」在该分支未闭合。

## 第四刀落地记录（2026-10-31 · 只改判据口径与注释，**判据代码不变**）

**本刀结论**：`sweepOrphans` / `listOrphaned` 的孤儿判据 `refCount === 0` 在 ADR-044 后
**依然成立**，且语义变干净了——`refCount` 现在只表达引用关系，不再兼职「孤儿标记」：
新轮建轮即 1 ⇒ 在途轮根本不进候选集；能落到 0 的就是「删会话/截断归零」与「升级前存量」。

**判据不变，但四处注释在撒谎（全部订正）**——它们都写着「进行中轮（pending）的 refCount
**恒为 0**」，这是 ADR-044 之前的旧口径，被第一刀直接推翻：

| 位置 | 旧口径（假） | 新口径 |
|---|---|---|
| 宿主 `DEFAULT_SWEEP_MIN_AGE_MS` | 「进行中轮 refCount 恒为 0，故必须带存活保护，否则删掉未答轮」 | 新轮 refCount 1 不进判据；保护改为「给刚归零的轮留后悔窗口」，并列出仍会落到 0 的三类 |
| 宿主 `listOrphaned` @param | 「传 0 会连带删除进行中轮（refCount 恒 0）」 | 传 0 只影响刚归零的轮；**旧口径已不成立** |
| 宿主 `sweepOrphans` @param | 「进行中轮 refCount 恒为 0…若默认为 0 会删未答轮」 | 同上，并指向常量注释 |
| 内核 `inMemoryRoundStore.listOrphaned` 行内 + `roundStore.listOrphaned` 接口 + `gcService` `minAgeMs`/`shouldSkip` | 「进行中轮由 minAgeMs 兜底保护」 | 一阶防线是 `refCount === 0`；`minAgeMs` / `shouldSkip` 退为二阶（后悔窗口 / 活跃写入避让） |

**新增判据锚点**（`workspaceSessionStore.test`）：`pending + refCount 1` 的轮即便
`sweepOrphans(0)` 也不被回收——变异（`listOrphaned` 忽略 refCount）⇒ 该例与另外两例共
**3 例红**，还原复绿。

**顺带写清的一处取舍（不是 bug，但必须留痕）**：`registerRoundInSession` 失败时轮已按
`refCount: 1` 落盘、`roundIds` 里却没有它 ⇒ 不可见、也不会被 GC 回收。**不改成「失败即降级
为 0」**的理由：那要在错误路径上再写一次盘，且会把「用户刚输入的内容」交给 24h 后的保洁；
当前取舍是保留。已写进 `registerRoundInSession` 注释（原文写「退回 ADR-044 之前的行为」，
那句已不成立——之前 refCount 0 会被回收，现在是永久保留）。

**收据**：内核 / 宿主 tsc 0 错；`workspaceSessionStore` 45 passed（+1）；内核
`gcService` + `roundStore` 47 passed；变异红→绿如上。

## 不并入本 ADR 的独立缺陷

**部分作答的答案错位**（另立条目，不与本刀混）：

`chatView` 的提交入口用 `reduce` **过滤掉未答项**后再提交，而 `chatPanel.answerInput`
用 `pendingQs[i]` 按位配对 ⇒ 一旦允许部分作答，答案会串到别人头上。
当前「全部答完才 enabled」把它掩盖成恒等变换。

⚠️ 该处注释写着「filter 保序：跳过未答题，与按序对话保持对应」——**这句话是假的**：
跳过未答项后按序即断。属 `memora-doc-reality-audit` E 类（注释自称的事实无落点）。
修法方向：答案必须**带题身份**（`askCallId`）回传，而不是靠数组位次。

## 何时回顾

- 出现第二个消费 `roundIds` 的视图（如 MCP 宿主渲染历史）时，复核「入会话」时机是否仍单拍。
- `forkSession` 或 `refCount` 语义变更时。
- GC 真的误删过一次「用户可见的轮」时——说明判据换轴引入了新的盲区。
