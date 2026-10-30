# ADR-043 · ask 批次题身份内核单源（toolCallId 即题身份）

> **状态**：✅ 已接受
> **日期**：2026-10-31 **播种批次**：ASK-MULTI-Q-1 后续切片 **来源**：宿主批次身份双轨审计（2026-10-31 对抗式复审）

## 背景

ask 多题批次（ASK-MULTI-Q-1）落盘后，同一条「用户作答」事实在两面各有一个身份：

- **盘面（重放）**：`RoundInteractiveInput.id` = `msg-${roundId}-input-${序号}`，由内核
  `buildInteractiveInputs` 单点装配（轮内位置序号）。
- **运行时（即时渲染）**：`inputId` = `live-input-${ts}-${批内下标}`，由宿主
  `askCoordinator` / `chatPanel` **自造**。

两面 id 处于不同命名空间、永不相遇。宿主 `qaDedupKey`（身份优先、缺省退化时间键）
只能保证「同批 N 条不被时间键吃掉」（同批共享 ms 级 ts，按 ts 单键会丢第 2..N 条），
**无法保证「运行时行」与「盘面行」是同一条**。于是「不重复渲染」依赖的是
**时序巧合**（ finalize 时运行时行恰好不在 `round-block` 内），而非**身份保证**。
时序一变（重建、折叠、跨重启重放）即有可能同一条渲染两遍。

根因不是去重函数写得不好，而是：**事实的身份有两个产地**。

## 决策

**ask 批次的题身份唯一真源 = 内核 `ask_user` 工具调用 id（`toolCallId`）**，
内核在提问挂起时即产出并下发，宿主**纯消费、不自造**。

1. `AskQuestion` 增加可选字段 `askCallId`，由 `parseAskCalls` 在解析 `askCalls` 时填入
   （批内第 i 题的 `askCallId` = 第 i 个 `askCallId`，与 `pendingAsk.toolCallIds` 同序同源）。
2. 该字段随 `onPendingQuestion` 回调、`questionPending` 事件、`question_pending` chunk
   **自然透传**（不改事件负载类型、不改签名字面）。
3. 落盘时 `buildInteractiveInputs` 的草稿可携带 `id`：**有则直接用**（题身份），
   无则回退现有轮内序号公式（supplement / 历史数据 / 未带身份的收场转化）。
4. 宿主运行时 `inputId` 一律取内核下发的 `askCallId`；自造键
   （`live-input-*`）在宿主消费刀完成后物理删除。

## 理由

- **零新增状态**：`toolCallIds` 与 `questions` 在 `handleAskUser` 中由**同一 `askCalls`
  按序派生**，天然一一对应，不需要自增计数器、不需要新表。
- **与位置解耦**：题身份不依赖「轮内第几条交互输入」，因此不受期间插入 supplement /
  补充输入导致的位置漂移影响（若改用「按内核 id 公式预测」，预测位置必漂移）。
- **跨重启稳定**：`toolCallId` 已随 `assistant.toolCalls` 落盘，运行时（刚挂起）与
  重放（读盘）拿到**同一个值** ⇒ 运行时行与盘面行天然配对，去重从「时序巧合」
  升级为「身份保证」。
- **不可逆操作判据前置**：清盘/去重都吃这个身份，身份错即重复或丢失，故身份必须
  落在内核已持久的事实上，而非宿主的临时时钟。

## 替代方案

| 方案 | 放弃原因 |
| --- | --- |
| 宿主按内核公式自造 `msg-${roundId}-input-${n}` | 需预测 `existingCount`（未来落盘位置），期间插入补充输入即漂移；且公式散在两处 = 并列事实源 |
| 盘上 `RoundPendingAsk` 加自增 id 字段 | 需新增状态 + 老数据兼容，收益与 `toolCallId` 等价但成本更高 |
| 增强去重（按 question 文本 + ts 内容匹配） | 同一批次允许两题文本相同 ⇒ 内容判据不可靠；且治标（判据层）不治根（身份层） |
| 维持现状（双轨 + 时序保证） | 「不重复」无身份保证，重建/折叠/跨重启路径随时可能复现 |

## 影响

- **内核**：`AskQuestion` 加可选字段（类型扩张，向后兼容）；`parseAskCalls` 填值；
  `buildInteractiveInputs` 支持草稿携带 `id`；`orchestrator.runResume` 与
  `appendInterrupted` 透传题身份。公开面若因此新增成员，须按 ADR-039 准入并同步
  `publicMemberSurfaceGuard` 登记。
- **协议**：`PendingQuestionDto` 加 `askCallId`（加字段，非新增 type；协议守卫计数阈值
  按现行纪律同步 +1）。
- **宿主**：`askCoordinator` / `chatPanel` 改用内核身份；`chatView` 去重单点
  `qaDedupKey` 语义不变（身份优先），但两轨归一后键可相遇。
- **数据兼容**：历史盘面数据仍用旧序号 id，新数据用题身份；去重键在同一批次内不会
  跨代混用（不同批次本来就不该匹配），故无需数据迁移。

## 分层刀法（本 ADR 定案，禁止混刀）

1. **第一刀（内核产出）**：`AskQuestion.askCallId` 产出 + 落盘草稿支持 `id` +
   透传；保持缺省回退，宿主未改前行为完全不变（不带伤）。
2. **第二刀（宿主消费）**：需内核 `build` + 宿主 `pnpm install --offline`
   （宿主载的是内核 dist），改 `PendingQuestionDto` 与两处 `inputId` 取值。
3. **第三刀（收口）**：物理删除宿主自造键与内核回退分支（回退分支删除前须确认
   supplement 路径确无身份来源）。

## 何时回顾

- 出现第二条 ask 消费面（如 MCP 宿主渲染提问）时，须复核题身份是否仍单源。
- `pendingAsk` 结构或 `RoundInteractiveInput.id` 公式变更时。
- 去重逻辑（`qaDedupKey` 或其调用面）再次改动时——改去重而不改身份即本末倒置。
