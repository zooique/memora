# step 原子级落盘（探索中 → 崩溃后过程可恢复）

> **状态**：🔍 探索中 → **档2 + T1 恢复接入 + 档3（迭代边界落盘）均已落地**（档2/T1：2026-09-09；档3：2026-09-23）。**可逆探索决策，不预写 ADR、不占编号、不改决策 README 索引。** 验证被真实崩溃场景消费、确认稳定后再固化为 ADR。
>
> **⚠ 术语警告（2026-09-23，§九）**：本项目有两个「step」——① **loop 迭代 step** = 一次 LLM 交互 + 其工具执行（`stepBudget` / `runIterationLoop` / `handleIteration` 属此阵营，是本文「一次 step 一次落盘」的真 step）；② **任务表 plan step**（一行任务，用户已裁定更名为 **planItem**）。`plan_item_boundary` 这个名字被阵营 ②占用 → 阵营 ①的边界信号缺失，正是 §九 档3 要补的缺口。
>
> **落地进度**：
> - ✅ **写侧**（step 原子落盘）：已实现并验证——宿主 `checkpointRound` 增量落盘 pending Round，流尾复用同一合并函数（SSOT 单一合并语义）；内核 / 宿主测试全绿、tsc/lint 通过。**⚠ 档2 原覆盖范围有缺口：仅覆盖「有任务表且任务项推进」的 turn，无任务表长工具循环零增量落盘 → 已由 §九 档3 修复（落盘时机迁至 `step_boundary`）。**
> - ✅ **读侧接口**（内核最小支持）：`IRoundStore.listInterruptedRecent(date, limit?)` 已在 `InMemoryRoundStore` + 宿主 `WorkspaceRoundStore` 落地，含单测。
> - ✅ **恢复接入（T1 已实现，端到端验收待办）**：内核新增收场方法 `MessageHistory.appendInterrupted`（中断轮 → 正常 stop turn：complete + refCount 0→1 + appendRoundId，无文本也按 stop 语义收场）+ 宿主 `chatPanel.upgradeInterruptedRounds`（`ready` 流程打捞 → 升级 → 随首次回放投递），双端单测覆盖（内核 4 例 / 宿主 5 例）。**杀进程→重启端到端验收待真实插件环境**（见 §八 T1 验收）。
>
> **一句话**：把过程事件（processEvents）的落盘从「流尾一次性」改为「每个 step 完成一次次性增量」，让进程崩溃只丢当前 step，之前已完成 step 的过程可从库恢复；重启后中断轮**升级为正常 stop turn 入会话**（可删、可作后续上下文），而非半成品孤儿。落盘动作归宿主（数据所在地），内核只补「列出中断轮」只读接口 + 「中断轮收场」写方法——即用户确认的最小支持形态（档2 + T1）。
>
> **本文边界（只覆盖「非自愿中断」）**：进程被杀/断电等**外部强制中断**走本文路径。用户**主动**暂停/插话/补充**不走本文**——那是**同一 turn 内**的申请-介入（step 边界生效，turn 连续性保持），真理源见 [pause-ask-resume-design.md](./pause-ask-resume-design.md)。两条路径**互补而非重叠**：本文保**记录完整性**（收场 → 重开），对方保 **turn 连续性**（申请 → 介入）。
>
> **边界裁决（2026-09-10 定案）**：断电时正处于暂停态 → **以断电为准**，按本文路径处理（中断轮补全为正常 turn 身份 + **只能新开 turn**），**不恢复为暂停态**。理由：进程已死、内存态已失，「在 step 边界接着跑」的前提不再成立，硬恢复成「暂停中」是自欺——暂停的语义基础是内存态连续。

## 一、问题背景

当前 turn 落盘时序：

1. `appendUser` → 创建 pending Round（userMessage 落盘，refCount=0）
2. 流运行期间：内核产 chunk → **宿主**派生 ProcessEvent → 暂存内存 `eventsByRound`（[chatPanel.ts#L2309-2335](../../hosts/memora-vscode/src/webview/panels/chatPanel.ts)）
3. 流结束：内核 `appendAssistant` 完成 Round（写 assistantMessage）+ 宿主流尾把 `eventsByRound` 附各 Round.processEvents 落盘（[chatPanel.ts#L2498-2517](../../hosts/memora-vscode/src/webview/panels/chatPanel.ts)）

**崩溃窗口** = `eventsByRound` 内存缓冲 + 未写的 `assistantMessage`。进程被杀 → 过程全丢，只剩 userMessage 的 pending 孤儿轮。

## 一·五、语义定案：中断轮 = 正常 turn（等同用户点「停止」）

> **2026-09-09 用户澄清（推翻「孤儿/半成品」前提）**：崩溃残留轮**不等同于半成品草稿**，而应**等同于用户直接点「停止」**——是一个完整可用、可删除、可被当作正常 turn 融入后续任务会话记录的 turn。

**三条语义（本次探索的验收口径）**：

1. **等同 stop turn**：崩溃残留轮恢复后视为普通收场的 turn（即使无 assistantMessage 总结，也按 stop 语义收场）。
2. **可删除**：像任何普通 turn 一样可被治理/删除。
3. **可融入后续会话**：应被登记进**会话 roundIds**，作为历史上下文参与后续 turn 的召回/装配——而非独立的"半成品孤儿"。

**对设计的影响（修正本次落地）**：

- 中断轮**要从孤儿升级为受会话引用**：走 `appendRoundId`（或 stop 收场路径）登记，而非仅 `listInterruptedRecent` 旁路打捞——打捞口只负责"找到"，"升级登记"才是核心。
- 恢复时**按普通 stop turn 渲染**，无需特殊「半成品草稿卡」——渲染更简单、与会话流一致。
- 因中断轮进入会话 roundIds，**不再是无引用孤儿** → GC 按普通 turn 生命周期处理（随会话删除），而非"超龄半成品回收"。
- 内核需给出**「中断 → 升级为 stop turn」的收场路径**（补 roundId 登记 + stop 收场语义）——这是后续推进的主任务（§八），当前只完成了「写侧落盘 + 打捞口」。

> 注：本次已落地「写侧 step 原子落盘 + `listInterruptedRecent` 打捞口」；「升级为 stop turn（登记 + 收场路径）」是后续主任务。

## 二、探明的关键事实（决定改动面）

- **过程事件是宿主派生的，非内核写**（[roundStore.ts#L165](../../src/memory/roundStore.ts)）：宿主从原始 AgentChunk 翻译成带 seq 的 ProcessEvent。恢复"过程渲染"正依赖这批派生后数据 → **落盘动作必须在宿主**（SSOT，避免内核重复派生）。
- **任务项边界信号内核已具备**：`plan_item_boundary` chunk（[loop.ts](../../src/agent/loop.ts)）+ `chunk.roundId` 轮归属。
  > **⚠ 订正（2026-09-23，§九 档3）**：此处的「step 边界」实为**任务项边界**——`plan_item_boundary` 由 active 任务项推进驱动，**无任务表不产**。档2 借它当落盘时机，正是 §九 查出的覆盖缺口根因。**迭代边界**信号由档3 新增的 `step_boundary` chunk 承担（`iteration_boundary` 归位更名）。
- **pending Round 可覆盖写**：roundStore.save 覆盖 pending（[roundStore.test.ts 增量覆盖用例](../../src/memory/roundStore.ts) 已验证）。
- **崩溃轮是孤儿**：`refCount=0`、`status=pending`、`appendRoundId` 只在 complete 时登记 → **不在正式会话 roundIds 里**，会话重放遍历不到。**修订（§一·五）**：这不是目标态——中断轮应**升级为正常 stop turn 并登记进 roundIds**，「孤儿」只是升级前的中间态。
- **GC 回收崩溃残留轮**（[gcService.ts#L6](../../src/memory/gcService.ts)：refCount=0 且超龄，pending/error 不分状态）。**修订（§一·五）**：中断轮升级为正常 turn 后不再是无引用孤儿，GC 按普通 turn 生命周期处理（随会话删除）；`listInterruptedRecent` 打捞口只服务「崩溃后尚未升级」的短暂窗口。

## 三、分两侧判断「要不要改内核」

| 侧 | 内容 | 是否改内核 |
| --- | --- | --- |
| **写侧** | step 原子落盘（过程增量写 pending Round） | ✂️ **零改动**。边界信号+轮归属+覆盖写能力早已齐备，宿主消费即可 |
| **读侧** | 崩溃恢复可见（用户能看到"中断在哪"） | ⚠️ **需一处最小支持**。宿主无法从会话 roundIds 发现孤儿中断轮 |

**结论**：写侧宿主自足；读侧存在真实空点——宿主需要一个"列出最近中断/未完成轮"的只读查询入口。当前 `listOrphaned`（给 GC 用，返回超龄孤儿）语义不匹配。

## 四、档2 定案改动面

**改（内核，最小）= 1 个只读接口**

```ts
/** 列出指定日期最近未完成（pending/error）的崩溃残留轮，供宿主重启后恢复展示 */
listInterruptedRecent(date: string, limit?: number): Round[];
```

- 只加**读取能力**，不引入第二条写路径 → 符合 SSOT（内核只"支持"，写归宿主）。
- **打捞口 ≠ 终点**（§一·五）：`listInterruptedRecent` 只负责「找到崩溃残留轮」，其**升级为正常 stop turn（登记 roundIds + stop 收场）是后续 §八 的主任务**——不作为孤立的"半成品草稿"长期悬空。

**改（宿主）**：
1. 抽复用函数 `checkpointRound(roundId)`：读 pending Round → merge 新 events（复用 mergeProcessEvents 单一合并语义）→ save。
2. `plan_item_boundary` chunk 时调用 `checkpointRound`（每个 step 完成增量落盘）。
3. 流尾仍保留 + `checkpointRound`（语义不变，含暂停/中断末段）。
4. 重启后用 `listInterruptedRecent(date)` 打捞中断轮 → **升级为正常 stop turn** 并入会话 roundIds → 按普通 turn 回放（§八细化）。

**不改**：存储格式、`Round` schema、`appendAssistant` 完成语义。

## 五、崩溃恢复语义（收益）

- 崩溃只丢**进行中那一个 step**；之前所有完成 step 的过程已在库。
- 恢复 = **将中断轮升级为正常 stop turn 入会话**（登记 roundIds + stop 收场），按普通 turn 渲染/可删/可作后续上下文（§一·五）。**不做断点续跑**（续跑需完整上下文，不在本探索范围）。
- 升级后中断轮不再是孤儿 → GC 按普通 turn 生命周期处理（随会话删除）。

## 六、待验证 / 风险

- [x] **写侧已初步验证**：`checkpointRound` 在 `plan_item_boundary` 增量落盘 + 流尾复用同一合并语义；内核 `2955 passed`、宿主 `26 files / 443 passed`、双端 tsc/lint 通过。
- [ ] `checkpointRound` 高频覆盖写对 roundStore 写性能的影响（step 边界频率 vs 全量流尾）——待真实长任务场景采样（T4）。
- [x] **恢复接入 + 升级登记（代码落地，单测覆盖）**——「中断轮 → 升级为正常 stop turn 入会话」已实现：内核 `appendInterrupted` + 宿主 `upgradeInterruptedRounds`，按普通 turn 渲染（复用 roundIds 回放，无需半成品分支）。**端到端验证（杀进程→重启真实插件环境）仍待办**（§八 T1 验收）。
- [x] **与 view 折叠重建（`_viewEpoch`）互斥**——设计上已互斥：升级不打第二条回放通道，升级轮随 `ready → replaySession` 首次回放一次性投递；宿主 once-guard + 内核 `appendInterrupted` isReappend 防重（幂等断言测试，T3）。
- [x] **`date` 过滤取舍（T2 定案）**——**保留 `date` 维度**：宿主重启后只持「当前会话日期」（`_currentSessionId.slice(0,10)`），崩溃发生在 `appendUser` 后 `appendRoundId` 前时宿主侧并不持有该 roundId 引用；date 过滤已足够支撑崩溃场景（崩溃轮的 createdAt 与崩溃前活跃会话同日）。

## 七、衔接提示词（新会话专项处理用）

> step 原子级落盘**已收口过半**（2026-09-09）：写侧 `checkpointRound`（宿主 chatPanel.ts，`plan_item_boundary` 增量落盘 + 流尾共用 `mergeProcessEvents` 单一合并语义，seq 实例级单调 `_processSeq`）+ 打捞口 `IRoundStore.listInterruptedRecent`（InMemory + Workspace 均实现含单测）+ **T1 恢复接入**（内核 `MessageHistory.appendInterrupted` 收场方法 + 宿主 `chatPanel.upgradeInterruptedRounds` 打捞升级，双端单测全绿，tsc + lint 通过）。
>
> **语义定案（2026-09-09 用户澄清，§一·五）**：中断轮 = **正常 turn（等同用户点停止）** —— 可删、可登记进会话 roundIds、可作后续上下文。**不是**半成品草稿 / 孤儿。恢复 = 把中断轮**升级为正常 stop turn**，按普通 turn 渲染，无需特殊草稿卡。
>
> **剩余任务**：原可执行清单 `tasks/step原子落盘收口-任务清单-20260909.md` 已随 2026-09-10 tasks 目录整理归档入 `tasks/已完成任务.md`（T1/T2/T3 已 ✅；T4 + 端到端验收缺口转 `tasks/待完成任务.md` 观察区）。推进前先读 §一·五 语义 + §四/§八 现有改动与定案，避免回退到"孤儿/半成品"方向。
>
> **不做**：不动存储格式/schema/appendAssistant 完成语义。不做断点续跑。

## 八、后续推进任务（设计定案 + 落地状态，2026-09-09）

> 基于「中断轮 = 正常 stop turn」语义的任务编排。T1~T3 已实现（单测覆盖），**须真实插件环境端到端验证的项标注待办**；T4 待真实长任务采样。

### T1 · 中断轮 → 升级为正常 stop turn 入会话（核心）✅ 已实现，端到端验收待办
- **收场路径定案：新增 `MessageHistory.appendInterrupted(roundId, opts?)`，不重用 appendAssistant**。理由（SSOT / 最小单元）：
  - `appendAssistant` 顶层跳过空内容（`if (!content.trim()) return`）→ 无文本中断轮无法收场，违 §一·五「即使无 assistantMessage 总结也按 stop 语义收场」验收口径；
  - `appendInterrupted` 与 `appendAssistant` 意图不同（崩溃恢复收场 vs 追加助手消息），独立命名自文档化；**收场约定复用** appendAssistant 同一真理源（refCount 0→1 + appendRoundId + status complete + completedAt + isReappend 防重），Round schema / 存储格式不变。
- **宿主收场链路**：`ready` 处理器改为 `await ensureAgent()`（ensureAgent 可等待化）→ `await upgradeInterruptedRounds()`（once-guard）→ `replaySession()`。升级轮随首次回放一次性投递，**不再有第二条回放通道** → 与 `_viewEpoch` 折叠重建互斥（T3）。
- **文本派生**：narrate 事件按 seq 拼接作恢复的助手文本；无叙述（工具阶段崩溃）传空串，由内核按 stop 语义收场（不写 assistantMessage）。
  * **A1 回抽后（2026-09-12）**：narrate 的 `content` 已含**首轮被回抽的叙述段**（该段先前被逐字流式进正文、不在 narrate 里，见 [process-event-log-replay-design.md](./process-event-log-replay-design.md) 事件表注记）→ 工具轮首个叙述步崩溃时派生文本**不再为空**，恢复出的助手文本更完整。注意 `narrate.withdrawn` 是运行时专有字段、**不落盘**，故本处派生只看 `content`。
- **验收**：中断轮进入会话 roundIds ✅（单测：appendInterrupted 4 例 + 宿主打捞 5 例）、可按普通 turn 删除（入 roundIds 后即普通 turn，随 `deleteTurnFrom`/会话删除生命周期一致，推论成立，端到端复核）、可被后续 turn 召回装配（`loadRoundBasedMessages` 展开 roundIds 时含该轮 user + assistantMessage，推论成立，端到端复核）。**杀进程→重启端到端验证待真实插件环境**。

### T2 · 打捞口定位调整 ✅ 已随 T1 落地
- `listInterruptedRecent` 定位已从「孤儿草稿打捞」改为「**崩溃残留轮升级前的中转**」（接口/两实现注释同步更新）。
- **GC 不误回收确认**：升级动作在启动后的 `ready → 打捞` 内完成，远早于 sweepOrphans 默认 24h 存活保护；升级后轮 complete + refCount>0，不再是无引用孤儿，GC 按普通 turn 生命周期处理（随会话删除）。
- **`date` 过滤定案：保留**（宿主只持当前会话日期，理由见 §六）。

### T3 · 与 `_viewEpoch` 重建回放互斥 ✅ 已设计互斥 + 断言测试
- 升级轮只经「roundIds 回放」一条通道投递（升级完成于首次回放之前），折叠重建的回放与崩溃恢复回放**不双发**。
- 断言：宿主 once-guard（重复调用不再升级）+ 内核幂等（重复 `appendInterrupted` 不二次登记 roundIds / refCount 不虚增）。

### T4 · 写性能采样 ⏳ 待真实长任务环境
- `checkpointRound` step 高频增量写 vs 流尾全量写，真实长任务采样（本专项环境无真实 LLM 长任务，未执行）。

---

## 九、档3 · 迭代边界落盘（补「无任务表」覆盖缺口）

> **2026-09-23 定案**。档2 的自查结论：落盘**动作**对了，落盘**时机**错了——时机挂在 `plan_item_boundary` 上，而该信号只在「有任务表且任务项推进」时才产，导致最常见形态（无任务表的长工具循环）**零增量落盘**，档2 的收益在该形态下归零。

### 9.1 缺口实证

| 事实 | 证据 | 推论 |
| --- | --- | --- |
| `plan_item_boundary` 产出条件 = 有任务表 **且** active 任务项推进 | `loop.ts` `_maybeEmitStepBoundary`：`getActivePlanItemMeta?.()` 返回 null 或 `planItemId === lastBoundaryPlanItemId` → 不 yield | 无任务表 → 恒不产 |
| 该 chunk 的官方语义就是「任务项推进」，不是「迭代完成」 | `types.ts` `plan_item_boundary` 注释：*「迭代完成且 active 任务项**推进**时 emit……无任务表不产」* | 它从未被设计成迭代边界，是**借用** |
| 宿主只在两处落盘：`plan_item_boundary` 分支 + 流尾 | `chatPanel.ts` `plan_item_boundary` 分支内 `checkpointRound`；流尾 `for (const [roundId, roundEvents] of eventsByRound)` | 无任务表 turn = 只有流尾一次 |
| 内核**每次迭代都有天然单点** | `loop.ts` 工具分支（工具执行完后）与无工具分支（LLM 调用后）**均调用** `_maybeEmitStepBoundary()` | 「迭代完成」这个事实内核本来就知道，只是被 AND 掉了 |

**根因 = 术语撞车**：`plan_item_boundary` 这个名字被「任务项」阵营占用，导致「迭代」阵营没有自己的边界信号（详见本文头术语警告）。

### 9.2 定案

**内核**：新增 `step_boundary` chunk（语义单一：一次 LLM 迭代——含其工具执行——结束）。

- **命名依据**：`iteration` 是项目**既有词汇**（`runIterationLoop` / `handleIteration` / `resetTurnState`），复用而非新造；且与 `plan_item_boundary` 不再撞名。
- **产出点**：复用 `_maybeEmitStepBoundary()` 的**两个既有调用点**（工具分支 = 工具落定后；无工具分支 = LLM 调用后），在工具分支**之后条件 yield**。不新增第三个调用点（复杂度守恒）。
- **产出条件 = `handleToolCalls` 返回 `'continue'`（硬，实测校准）**：只有「本迭代完成**且将继续下一轮**」才产。终态迭代（`'done'` 收尾 / `'paused'` 挂起 / `'aborted'` 中断）之后流即结束或宿主 `break` → **流尾落盘**已兜底，此处不产。
  - **为什么不无条件产（实测教训，2026-09-23）**：初版按「无条件 yield」实现 → 内核 6 个既有用例转红（`chunks.at(-1).type` 期望 `done`/`paused`，实得 `step_boundary`）。这些断言背后是**宿主 `paused` 分支依赖「终态 chunk 是末条」才会 `break`**（chatPanel 该分支的注释有 2026-09-22 实证记录）——无条件产 = 在终态之后再塞一条 chunk，破坏了宿主收场判定所依赖的流契约。条件化同时带来第二个好处：与流尾落盘不重复写。
  - 无工具分支（`handleTextResponse`）恒为终态 → 只产折叠边界、**不产本 chunk**。
- **顺序约束（硬）**：`plan_item_boundary`（折叠分组）**先**、`step_boundary`（落盘触发）**后**——保证本次落盘快照**包含**本步的折叠边界事件；反序会导致崩溃时丢边界、重放分组错位。实现上由 `_emitIterationBoundary(result)` 单函数内串联两者，调用方无法只取一半。
- **不落 ProcessEvent**：它是**落盘触发信号**，不是历史内容；`Round.processEvents` / schema 零改动。重放分组仍由 `plan_item_boundary` 事件承担。

**宿主**：

1. 新增 `step_boundary` 分支 → 调 `checkpointRound(currentRoundKey, events)`。
2. **删除** `plan_item_boundary` 分支里的 `checkpointRound` 调用 → **落盘时机单一**（SSOT：一个时机，不是两个）。
3. 流尾 checkpoint 保留（末段 / 暂停 / 中断兜底）。

**覆盖范围（补齐后）**：有任务表 ✅ ｜ 无任务表 ✅ ｜ 有工具 ✅ ｜ 纯文本收尾 ✅（该分支迭代即收尾，与流尾重合，无害）。

### 9.3 被否决的备选（记理由，防回退）

| 备选 | 内容 | 否决理由 |
| --- | --- | --- |
| **B · 宿主从 `tool_result` 触发落盘** | 零内核改动，收到工具结果就 checkpoint | ① **粒度错**：工具 ≠ 迭代，一次迭代 N 个并行工具 → N 次落盘（写放大）；② **判据外置（致命）**：「哪条 `tool_result` 是本次迭代的最后一条」只有内核知道，宿主只能猜 → 宿主侧第二份迭代判据，**违 SSOT**；③ 纯文本迭代仍无覆盖 |
| **C · 放宽 `plan_item_boundary` 条件（无任务表也 emit）** | 复用现有事件，零新增 | **语义污染**：该事件兼作 webview 步级折叠的分组依据，无 `planItemId` 的空边界会造出**无标题折叠块**；且存量落盘数据里该事件语义已被消费，改条件 = 改历史解释 |

### 9.4 不做 / 已知限界

- **不做**断点续跑；**不改** `Round` schema / 存储格式；**不动** `appendAssistant`。
- **ask 挂起当次迭代不产边界**：语义正确（挂起型迭代未「完成」），代价是提问等待期的过程不落盘；但此前迭代均已落盘，等待期新增量极小（一条 narrate + 一条 ask_user tool_start），流尾/续跑会补。**登记为已知限界，不修**。
  - *机制澄清（实测校准）*：ask 并不能靠「提前 return 不经产出点」实现——`handleAskUser` 在 `handleToolCalls` 内部，返回 `'paused'` 后控制流**仍会回到工具分支后的产出点**。真正挡住它的是**产出条件 `result === 'continue'`**。故该限界与「终态不产」是**同一条判据**，不是两处特判。
- **暂停**不受影响：`paused` chunk → 宿主 break → 流尾落盘（既有路径）。
- **中断/失败轮**：同样由流尾兜底（宿主 `break` / 流尾 checkpoint），不依赖本 chunk。
- **无工具迭代（纯文本收尾）**：本 chunk 不产 —— 该迭代即 turn 收尾，流尾落盘覆盖，无中间段可丢。
- **写频次**：由「任务项推进次数」升为「迭代次数」，T4 采样项口径同步更新。

### 9.5 验收口径（✅ 已落地并实测）

| 层 | 判据 | 用例位置 | 实测 |
| --- | --- | --- | --- |
| 内核 | 无任务表 + 2 次工具迭代 → 边界数 = 2；且边界在 `tool_result` 之后、末条仍为终态 | `src/agent/__tests__/stepBoundary.test.ts` | ✅ 7 例通过 |
| 内核 | **档2 缺口锁**：全程无 `plan_item_boundary`（无任务表）仍产边界 | 同上 | ✅ |
| 内核 | 终态不产：策略屏蔽（`done`）/ ask 挂起（`paused`）/ 纯文本收尾 → 0 条，末条不变 | 同上 | ✅ |
| 内核 | **顺序契约**：`plan_item_boundary` 索引 < `step_boundary` 索引 | 同上 | ✅ |
| 宿主 | 两次边界到达 → 两次增量落盘（第一次不含后一迭代工具）+ 流尾一次 = 3 次 `save` | `hosts/.../chatPanelHistory.test.ts`（`spySaves` 观测 save 快照） | ✅ |
| 宿主 | 时机单一：`plan_item_boundary` 到场不写库，全程仅流尾 1 次 | 同上 | ✅ |
| 变异 | A 删产出语句 → 内核 3 例转红；B 无条件产 → 内核 2 例转红；C 顺序倒置 → 顺序用例转红；D/E 宿主落盘条件对调 → 宿主 2 例转红 | 逐条实测执行 | ✅ 全部转红 |
| 质量门 | 内核：`tsc` + `eslint --max-warnings 0` + `vitest`；宿主：同三件 + `tsc -p ./ && esbuild` 构建 | — | ✅ 内核 109 文件 / 2765 passed；宿主 34 文件 / 604 passed（2 skipped），构建通过 |

> 实测环境：2026-09-23，Windows，Node 22.22.2，vitest 4.1.11。数字随改动漂移，引用前重测。

### 9.6 关联

- 术语正名（任务项 `PlanStep` → `PlanItem`、`planStepId` → `planItemId`、`step_boundary` 归位为迭代边界 + 原任务项边界改名 `plan_item_boundary`）**已落地（2026-09-23）**：内核 / 宿主 / scripts / role-packs / 现行文档全覆盖，内核与宿主双侧门禁（tsc + eslint --max-warnings 0 + vitest）+ 宿主 esbuild 构建 + `verify:dist-contract` 同代 + `docs:links` 死链 0 通过；历史档号（step-atomic-persistence.md / 档2 / 档3）与 CHANGELOG 旧版本条目按「历史保留原貌」不动。**档3 不依赖正名，可独立提交早见效**——本次提交即正名收尾。