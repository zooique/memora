# 运行时输入并入任务折叠块 · SSOT 收敛设计（B 方案）

- **日期**：2026-09-17
- **作者**：高见远（架构师）+ 用户拍板
- **状态**：**已实现（形态甲，2026-09-17）**——落 `tasks/方案-qa折叠块收敛-20260917.md` 立项实施完成；本文件为设计原始记录
- **性质**：把**运行时输入**（= LLM 主动提问的问答 `question-answer` / 用户主动补全 `supplement` / 提问超时未答 `timeout`）从「消息流平铺 + 事后搬家」双渲染体系，SSOT 收敛为**任务折叠块（round-block）内的过程条目**，与 thought/tool 同源同序渲染。
- **统一前提**：LLM 主动提问（ask_user → 用户回答）与用户主动输入补全（supplement）**是同一逻辑**——都是「loop 运行期间用户注入的输入」（运行时输入）。现状 `interactiveInputs` 数据层与 `appendInlineInputRow` 渲染入口**已经共用同一形态**（仅 kind 语义标签不同），本设计的收敛对象就是这整类（不区分 ask/supplement 两套视觉体系）。

---

## 一、背景与问题（实证）

**用户真机反馈**：ask 问答折入折叠块后**位置飘忽**——有时在顶部、有时在底部。

**根因（代码实证）**：

1. **折入是「搬家」不是「渲染」**：`moveQaIntoRoundBlock`（`chatView.ts`）用 `detailsBody.appendChild(el)` —— **恒追加到折叠区末尾**，不参与 round-block 内部过程流的排序（过程事件由 `renderRoundBlock` 按 seq 全量小节承载）。
2. **折入时机与 finalize 重建交错**：QA 有两个折入路径（运行时即时折入 / 完成后 `foldPendingQaIntoRoundBlock` 批量折入）；而 finalize 会**全量重建 round-block**（`renderRoundBlock(finalize=true)` 替换折叠区内容）。折入与重建的相对时序不固定 → 位置随重建逻辑漂移 → 顶部/底部飘忽。
3. **本质**：QA 是**与 round-block 平行的第二套渲染体系**——运行时消息流平铺（`resolveInteractionAnchor` 挂 assistant 块后）+ 事后搬家 + 成对携带（提问回顾行）+ 收起计数（`refreshRoundBlockQaStats`）+ 归属过滤（`foldPendingQaIntoRoundBlock` 的 round-group 判定）。**过程条目排序无单一真源**（processEvents 用 seq、interactiveInputs 用 ts，两套各自渲染）。

**附加事实**：运行时**没有 round-block**（v1.8 剪枝后运行时为 `process-flow` 平铺容器，round-block 在 finalize 才建立）。因此「运行时即时可见」不能依赖 round-block 存在，须在设计中显式处理。

---

## 二、目标与约束

### 目标
1. **SSOT**：QA 作为折叠块过程条目，与 thought/tool/step 分组**同一渲染数据源、同一排序、同一容器**；删除 msg-qa 独立折叠块 / 搬运 / 计数双体系。
2. **位置确定**：QA 按时间序（ts）落在**对应 step 分组内**，无论运行时/重放/完成态，位置唯一确定。
3. **运行时即时可见（硬约束）**：用户提交回答，**实时**显示在过程容器中对应 step 位置（不等完成）。

### 约束
- **不改变落盘**：`round.interactiveInputs`（带 ts/kind/question/options）已落盘，数据无需新增字段；QA 不进 processEvents（保持两类数据分源）。
- **运行时与重放同构**：同一合并数据源 + 同一渲染器，杜绝「运行时平铺 / 重放折入」分叉。
- **零新增协议字段**（如可能）：QA 提交后经现有 `user(kind)` 消息路径进入过程流。

---

## 三、方案设计

### 3.0 统一模型（用户定案）：step = LLM + 用户 的混合产物流

- **step 是时间窗口**：一次 `step_boundary` 到下一次之间，step 内发生的一切（LLM 产出的 thought/tool/narrate + 用户注入的运行时输入）都是该 step 的过程记录。补充（supplement）就是 step 结束间隙插入的内容。
- **产物条目统一，来源区分**：条目 = 产物类型（thought / tool / narrate / input），携带来源元数据（`llm` / `user`）。**LLM 发送的是 step 内容，用户输入是同一流中的另一来源——本质同构，仅生产者不同。**
- **渲染统一**：过程条目行（同形态），来源以标签区分（LLM 产物按类型；用户输入带「你答 / 你补充 / 未回答」tag）。
- **落盘分源，渲染合并投影**：`processEvents`（内核事件流）与 `interactiveInputs`（用户交互记录）**各自保持真源**；合并只发生在渲染层（SSOT：每类数据单真源，渲染为统一投影）。

### 3.1 数据源（SSOT）：合并过程条目流

**渲染真源 = 按 ts 合并的「过程条目流」**：

```
processItems = sortByTs([
  ...processEvents.map(toItem),      // thought / tool_start+result / narrate / step_boundary
  ...interactiveInputs.map(toItem),  // question-answer / supplement / timeout（运行时输入，统一形态）
])
```

- **运行时输入三类（统一形态，仅 kind 语义标签区分）**：`question-answer`（ask_user 提问→用户回答）、`supplement`（用户主动补全：暂停后补充/插话）、`timeout`（提问超时未答）。均带 ts；question-answer/timeout 可带 `question`/`options`。

- **排序键 = ts**（统一时间戳；同 ts 以稳定序——processEvents 用 seq、interactiveInputs 按写入序）。
- **step 归属**：条目 ts 与 `step_boundary` 的 ts 比较 → 归入对应 step 分组（`step_boundary` 之后的条目属该 step；首个 boundary 之前属「准备段」）。
- 数据来源：
  - **运行时**：`currentEvents`（eventsByRound 累积）+ 流式交互输入（提交回答时入列）。
  - **重放**：round.processEvents + round.interactiveInputs。
- **合并入口唯一**：`renderRoundBlock`（finalize 全量重建）与「运行时增量插入」共用同一 `insertProcessItem(item, stepGroup)` 定位函数。

### 3.2 渲染模型

折叠区（`.round-block__details`）内过程条目统一为 `renderProcessItems`，各类型渲染器：

| 类型 | 渲染 | 形态 |
|---|---|---|
| thought | 思考折叠行（现有） | 保留 |
| tool | 工具行（现有） | 保留 |
| narrate | 叙述行（现有） | 保留 |
| **interactive（新增 `renderQaItem`，覆盖运行时输入三类）** | 提问回顾行 `[问] 问题 + 候选`（仅 question-answer/timeout 带 question 时）；回答/补全/未答行：`[你答] 答案` / `[你补充] 补全文本` / `[未回答]` | **对齐 thought/tool 行样式**（非独立折叠块）；supplement 与 question-answer 同形态，仅 tag 语义区分 |

- 收起态摘要：QA 计数（你答×N · 你补充×N）**从合并流统计**（替代现有 `refreshRoundBlockQaStats` 的 DOM 扫描）。
- 删除清单：`.msg-qa` 折叠块、`.msg-qa--ask` 回顾行、`moveQaIntoRoundBlock`、`foldPendingQaIntoRoundBlock`、成对携带逻辑、归属过滤、`refreshRoundBlockQaStats` DOM 版。

### 3.3 运行时即时可见（关键设计点）

**运行时无 round-block 的事实**决定了两种落地形态：

- **形态甲（主推）**：运行时 QA **实时插入 `process-flow` 过程容器内**（若 process-flow 有 step 分组结构则插对应分组；无分组则插容器尾、finalize 后由 ts 排序归位）。
  - 用户提交回答 → 宿主 post `user(kind)` → webview **立即** `insertProcessItem` 到当前过程容器 → 即时可见。
  - finalize 时 `renderRoundBlock` 由**同一合并流**全量重建 → QA 按 ts 自然落在正确 step 分组 → **无搬家、无飘忽**。
  - **前置确认**：`process-flow` 当前是否含 step 分组结构（决定插入粒度）；若无，形态甲需在运行时容器引入 step 分组（或插容器尾）。
- **形态乙（备选/降级）**：运行时 QA 仍消息流内联（保留现有即时可见），finalize 时按 ts **插入**（非 appendChild 末尾）对应 step 分组——只修位置、双体系仍存（非 B 的完整收敛）。

> 用户已确认「运行时即时可见是必须的」→ 形态甲优先；形态乙作为「若运行时容器无法承载 step 分组」时的降级。

### 3.4 重放与历史

- 重放：`loadRoundBasedHistory` 加载 round → processEvents + interactiveInputs 合并 → 同一 `renderProcessItems` 渲染 → 与运行时最终态一致。
- 历史 round（旧数据）：interactiveInputs 结构与现状一致 → 兼容（渲染器替换渲染形态，数据无需迁移）。

---

## 四、改动面

| 层 | 改动 |
|---|---|
| `chatView.ts` | 新增 `renderQaItem` + `processItems` 合并/排序 + `insertProcessItem(stepGroup)`；`renderRoundBlock` 接入合并流；删除 msg-qa 体系（折叠块/回顾行/搬运/计数/归属过滤） |
| `chatPanel.ts` | QA 提交后进入过程流（现有 `user(kind)` 路径透传 question/options）；确认 process-flow 容器可插 |
| `chatStyles.ts` | 删 `.msg-qa` 系列；新增 QA 条目行样式（对齐过程行） |
| 测试 | ask_user 相关测试重写（消息流平铺 → 过程容器条目）；重放 QA 排序用例；运行时即时插入用例；位置确定性用例（防回归） |

## 五、风险与待确认

1. **运行时容器结构**：`process-flow` 是否有 step 分组（决定形态甲插入粒度）——**待代码确认**。
2. **运行时 round-block 不存在**：形态甲把 QA 插 process-flow，finalize 重建归位——需验证 finalize 重建对「已插入 QA」的衔接（无竞态）。
3. **排序键统一**：ts 精度（毫秒）下同 ts 排序稳定性（processEvents seq vs interactiveInputs 写入序）——需定义稳定序。
4. **UX**：运行时 QA 是否带「问」回顾行（保留在条目内）+ 候选选项静态展示（保留，形态从折叠块→条目行）。

## 六、验收

- [ ] 运行时输入提交（ask 回答 / 主动补全 supplement）→ 即时显示在过程容器对应 step 位置（同形态）
- [ ] 完成后 round-block 内运行时输入位于正确 step 分组（顶部/底部不飘忽）
- [ ] 重放与运行时最终态一致（question-answer / supplement / timeout 三类同形态归位）
- [ ] 删除 msg-qa 双体系后全量测试绿

## 七、下一步

1. 代码确认 `process-flow` 结构与 finalize 重建衔接（形态甲可行性）。
2. 拍板形态甲/乙 → 落 `tasks/方案-qa折叠块收敛-20260917.md` → 立项实施。
