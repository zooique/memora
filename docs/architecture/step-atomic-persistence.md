# step 原子级落盘（探索中 → 崩溃后过程可恢复）

> **状态**：🔍 探索中 → **档2 部分落地 + T1 恢复接入已实现**（2026-09-09）。**可逆探索决策，不预写 ADR、不占编号、不改决策 README 索引。** 验证被真实崩溃场景消费、确认稳定后再固化为 ADR。
>
> **落地进度**：
> - ✅ **写侧**（step 原子落盘）：已实现并验证——宿主 `checkpointRound` 在 `step_boundary` 时增量落盘 pending Round，流尾复用同一合并函数（SSOT 单一合并语义）；内核 / 宿主测试全绿、tsc/lint 通过。
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
2. 流运行期间：内核产 chunk → **宿主**派生 ProcessEvent → 暂存内存 `eventsByRound`（[chatPanel.ts#L2309-2335](../hosts/memora-vscode/src/webview/panels/chatPanel.ts)）
3. 流结束：内核 `appendAssistant` 完成 Round（写 assistantMessage）+ 宿主流尾把 `eventsByRound` 附各 Round.processEvents 落盘（[chatPanel.ts#L2498-2517](../hosts/memora-vscode/src/webview/panels/chatPanel.ts)）

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

- **过程事件是宿主派生的，非内核写**（[roundStore.ts#L165](../src/memory/roundStore.ts)）：宿主从原始 AgentChunk 翻译成带 seq 的 ProcessEvent。恢复"过程渲染"正依赖这批派生后数据 → **落盘动作必须在宿主**（SSOT，避免内核重复派生）。
- **step 边界信号内核已具备**：`step_boundary` chunk（[loop.ts#L978-986](../src/agent/loop.ts)）+ `chunk.roundId` 轮归属。
- **pending Round 可覆盖写**：roundStore.save 覆盖 pending（[roundStore.test.ts 增量覆盖用例](../src/memory/roundStore.ts) 已验证）。
- **崩溃轮是孤儿**：`refCount=0`、`status=pending`、`appendRoundId` 只在 complete 时登记 → **不在正式会话 roundIds 里**，会话重放遍历不到。**修订（§一·五）**：这不是目标态——中断轮应**升级为正常 stop turn 并登记进 roundIds**，「孤儿」只是升级前的中间态。
- **GC 回收崩溃残留轮**（[gcService.ts#L6](../src/memory/gcService.ts)：refCount=0 且超龄，pending/error 不分状态）。**修订（§一·五）**：中断轮升级为正常 turn 后不再是无引用孤儿，GC 按普通 turn 生命周期处理（随会话删除）；`listInterruptedRecent` 打捞口只服务「崩溃后尚未升级」的短暂窗口。

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
2. `step_boundary` chunk 时调用 `checkpointRound`（每个 step 完成增量落盘）。
3. 流尾仍保留 + `checkpointRound`（语义不变，含暂停/中断末段）。
4. 重启后用 `listInterruptedRecent(date)` 打捞中断轮 → **升级为正常 stop turn** 并入会话 roundIds → 按普通 turn 回放（§八细化）。

**不改**：存储格式、`Round` schema、`appendAssistant` 完成语义。

## 五、崩溃恢复语义（收益）

- 崩溃只丢**进行中那一个 step**；之前所有完成 step 的过程已在库。
- 恢复 = **将中断轮升级为正常 stop turn 入会话**（登记 roundIds + stop 收场），按普通 turn 渲染/可删/可作后续上下文（§一·五）。**不做断点续跑**（续跑需完整上下文，不在本探索范围）。
- 升级后中断轮不再是孤儿 → GC 按普通 turn 生命周期处理（随会话删除）。

## 六、待验证 / 风险

- [x] **写侧已初步验证**：`checkpointRound` 在 `step_boundary` 增量落盘 + 流尾复用同一合并语义；内核 `2955 passed`、宿主 `26 files / 443 passed`、双端 tsc/lint 通过。
- [ ] `checkpointRound` 高频覆盖写对 roundStore 写性能的影响（step 边界频率 vs 全量流尾）——待真实长任务场景采样（T4）。
- [x] **恢复接入 + 升级登记（代码落地，单测覆盖）**——「中断轮 → 升级为正常 stop turn 入会话」已实现：内核 `appendInterrupted` + 宿主 `upgradeInterruptedRounds`，按普通 turn 渲染（复用 roundIds 回放，无需半成品分支）。**端到端验证（杀进程→重启真实插件环境）仍待办**（§八 T1 验收）。
- [x] **与 view 折叠重建（`_viewEpoch`）互斥**——设计上已互斥：升级不打第二条回放通道，升级轮随 `ready → replaySession` 首次回放一次性投递；宿主 once-guard + 内核 `appendInterrupted` isReappend 防重（幂等断言测试，T3）。
- [x] **`date` 过滤取舍（T2 定案）**——**保留 `date` 维度**：宿主重启后只持「当前会话日期」（`_currentSessionId.slice(0,10)`），崩溃发生在 `appendUser` 后 `appendRoundId` 前时宿主侧并不持有该 roundId 引用；date 过滤已足够支撑崩溃场景（崩溃轮的 createdAt 与崩溃前活跃会话同日）。

## 七、衔接提示词（新会话专项处理用）

> step 原子级落盘**已收口过半**（2026-09-09）：写侧 `checkpointRound`（宿主 chatPanel.ts，`step_boundary` 增量落盘 + 流尾共用 `mergeProcessEvents` 单一合并语义，seq 实例级单调 `_processSeq`）+ 打捞口 `IRoundStore.listInterruptedRecent`（InMemory + Workspace 均实现含单测）+ **T1 恢复接入**（内核 `MessageHistory.appendInterrupted` 收场方法 + 宿主 `chatPanel.upgradeInterruptedRounds` 打捞升级，双端单测全绿，tsc + lint 通过）。
>
> **语义定案（2026-09-09 用户澄清，§一·五）**：中断轮 = **正常 turn（等同用户点停止）** —— 可删、可登记进会话 roundIds、可作后续上下文。**不是**半成品草稿 / 孤儿。恢复 = 把中断轮**升级为正常 stop turn**，按普通 turn 渲染，无需特殊草稿卡。
>
> **剩余任务 见可执行清单**：`tasks/step原子落盘收口-任务清单-20260909.md`（T1 验收端到端待办 + T3/T4）。推进前先读 §一·五 语义 + §四/§八 现有改动与定案，避免回退到"孤儿/半成品"方向。
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