# 工具读图的消息面契约（`read_image` → 合成 user 消息）

> **状态**：口径定案（2026-11-09）；**内核链路与宿主执行端口已落地**（内核 `5020931b` / 宿主 `d2636952`，2026-11-11）；**视觉 provider 下真机读图已完成**（2026-11-12）。未完成面 = §5 过程区缩略图（宿主 webview，已拆为台账 `IMAGE-THUMBNAIL-1`，不在宿主 0.10.0 范围）；跟踪条目 = `IMAGE-TOOL-MESSAGE-1`（2026-11-12 随内核 7.1.0 归档 → [tasks/archive/7.1.0-kernel.md](../../tasks/archive/7.1.0-kernel.md)）。
> **本文件回答**：工具读到的图，怎么送进模型。结论一句话——**不是缺工具，是缺一条能携带图像的通道**。
> **不重复**：[方案-图片输入-20261027.md](../方案-图片输入-20261027.md) 是**用户附图**（输入通道）的方案；
> [边界-图片采集UI-VSCode能力边界-20261028.md](../边界-图片采集UI-VSCode能力边界-20261028.md) 管采集入口边界。
> 三者是同一能力的三条腿，别互相顶替。
> **术语**：turn / step / loop 的定义见 [terminology-anchor-rules.md](../../.trae/rules/terminology-anchor-rules.md)，本文件不重复。

## 1. 结论

运行时读图**不缺工具**，缺的是「工具结果能不能携带图像」这条路；在 OpenAI 兼容协议下这条路只能走
**合成 user 消息**，且必须同时满足四条：**当轮可见、不落盘、不可被窗口衰减误算、判据与能力位同源（不能谎报）**。

## 2. 形态（定案）

### 2.1 合成 user 消息

工具执行面读到图片后，**不把图塞进工具结果**，而是在本轮的消息数组里**追加一条合成的 user 消息**，
内容为该图对应的 `ImageRef`（既有类型，`src/llm/provider.ts` 导出）。模型在同一次 loop 的下一个 step
看到它；turn 结束即消失。

### 2.2 三条实测依据（为什么这条路成立）

- **当轮可见**：`formatMessages` 对带 `attachments` 的 user 消息会展开为 text + `image_url` 块
  （`src/llm/openaiCompatible.ts` 的 user 分支，并会经 `ImageResolver` 端口把 `ImageRef` 物化为 URL）。
  这是唯一能被协议承载图像的形态。
- **不落盘**：落盘与重放读的是 `round.userMessage.attachments`；合成消息不写进 `round.userMessage`
  ⇒ 不进会话文件、不进重放。
- **不被窗口衰减误算**：历史窗口衰减只统计 `round.userMessage.attachments`
  （`src/agent/messageHistory.ts` 的 `loadRoundBasedMessages`，窗口常量 `RETAIN_IMAGE_ROUNDS`
  在 `src/agent/constants.ts`，契约值 4 有单测钉住）。合成消息不在 Round 里 ⇒ 既不占这 4 轮额度，
  也不会被衰减逻辑二次处理。

> **为什么第三条必须写进契约**：它是「不落盘」之外的一个**额外好处**，但后人会「顺手」把它落盘以复用衰减逻辑
> ——于是每张工具图都白占一个用户图额度，且没有任何测试会红。

### 2.3 一条容易漏的前提：合成消息必须可被 `ImageResolver` 解析

`formatMessages` 拿到 `ImageRef` 后要经 `imageResolver` 端口换出 `{ url }`，拿不到就退化成**可见占位文本**
（`[图片不可用 <sha256 前 8 位>]`，这是既有「可见占位、不静默丢」口径）。因此：

> **受理读图的落点必须保证该 `ImageRef` 能被解析器换成 `{ url }`**（缓存/回写由宿主侧承担）。
> 否则工具报成功、模型只看到一段占位文字 = **谎报**（与 §4 第 4 条同族，但发生在另一条路径上）。

### 2.4 合成时机：出站视图尾部（不写 `this.messages`）

合成消息**只在 `_prepareContext` 的返回值里出现**，绝不由 loop 追加进 `this.messages`：

- **位置**：整个工具批次的 tool 消息**之后**追加一条 user 消息（批内 `tool_call` 配对不能被插入的
  user 消息打断）；同批多张图合并为一条，多个 step 累积到本 turn 结束。
- **去重**：按 `ImageRef.sha256`，同一张图重复读只挂一次。
- **生命周期**：turn 级累积，`resetTurnState` 清零。「软暂停续跑保留已读图」是后续独立一笔，
  不得在本笔顺手挪动任何既有清理点。
- **副本语义**：返回的是**新数组**（`[...safeMessages, 合成消息]`），`this.messages` 长度与内容零改动
  ——否则会移动压缩锚点（`findEarliestRound`）、虚增对话计数、污染落盘。
- **路由隔离**：合成消息带 `Message.synthetic: true` 标记（类型上只允许写 `true`，不写 `false`），
  判定唯一入口 = `isSyntheticMessage()`（`src/agent/types.ts`，谓词归 agent 层——`provider.ts`
  只承载标记，不知道「合成」的业务含义）。`determineTaskType` 必须跳过它——一条超长的合成消息
  会把路由从 `simple` 拉成 `reasoning`，且没有任何测试会红。标签与谓词**只有一份**，禁两边各写。
- **已知边界（只记录，不在本笔扩机制）**：合成发生在上下文截断/预算判定**之后**，一轮读多张图时
  出站体积不受预算裁决（单图 ≤ 1568 token）。按定案「挂尾部」执行。

### 2.5 路径边界（与 `read_file` 同源）

- `read_image` 的路径判定**原样复用** `resolveSafePath` + `guardPathOrThrow`：
  黑名单优先、硬拒、**先拒后读盘**（`src/agent/builtinToolHandlers.ts`）。
- **不新增**「根外每次确认」之类审批机制；路径被拒即工具失败，不进入宿主端口。
- 宿主端口只接收**已判定**的绝对路径，不得在宿主再复制一份白名单判据（判据只留一处）。
- 宿主端口内的「当前 provider 不支持视觉」拒绝是**能力拒绝**（执行面第二层，防模型幻觉调用），
  与路径审批正交，不得混写成一件事。

## 3. 为什么不能给 `Message.tool` 加 `attachments`

- **协议层面**：OpenAI 兼容协议的 `tool` 角色消息**内容只能是字符串**；本仓 `formatMessages` 的 tool 分支
  直接返回 `{ role: 'tool', tool_call_id, content }`，没有任何内容块数组的出口。
- **类型层面**：`Message` 的 `attachments` 只在 user 分支声明，tool 分支没有它的位置。
- **判据**：给 `Message.tool` 加 `attachments` 属于**僵尸键**——字段加得上、类型检查过得了、测试也可能绿，
  但发不出去（协议端不认内容块）。僵尸键的危害不是「没用」，是**下一个人读到字段就以为这条路已经通了**，
  于是把「图没到模型」误判成上游 bug。
- **结论**：**不改 tool 角色的形状**；图像走 user 消息。这也符合「契约扩张走最小面」——新增的不是新 op，
  是既有 user 消息形态的一次复用。

## 4. 四条验收契约（实现即按这四条写用例）

1. **当轮可见**：`read_image` 成功后的下一个 step，模型能引用该图内容。
   （用例：Mock LLM 断言第 N+1 次调用的消息数组里存在一条带 `attachments` 的合成 user 消息。）
2. **不落盘**：turn 结束后 `Round` 里 `userMessage.attachments` 与执行前**完全一致**，重放不出现该图。
   （用例：落盘快照对比 + 重放视图无该图。）
3. **不可被误算**：连续 5 轮各读一张图，第 1 轮的**用户附图**仍按 4 轮衰减照常退出窗口；
   工具图数量不改变该衰减行为。（用例：构造 5 轮，断言窗口内 user attachments 计数只受用户附图驱动。）
4. **判据与能力位同源（不许谎报）**：`supportsVision` 默认 false 且 fail-closed（`src/llm/provider.ts`），
   送信前的闸在 `src/agent/managers/llmCaller.ts`（按**路由后** provider 判，含附件即拦）。
   **只在送信处关闸 = 工具会报告成功而模型看不到图**，这是典型谎报位点
   （纪律见 [single-truth-source-mindset.md](../../.trae/rules/generic/single-truth-source-mindset.md) 的「谎报位点」条）。
   因此 `read_image` 的**暴露面**必须与同一判据同源：模型不支持视觉时，该工具不暴露，
   或暴露但明确拒绝并给出可执行原因；**不得**以「读到了字节」当作成功口径。
   - 注意：新增工具**不会自动被任何闸管住**——`DEFAULT_EXPOSED_TOOLS` 是常驻白名单，只读闸是另一条判据。
     这条必须显式做。

## 5. UI 与文案面（宿主，排在宿主批）

- **用户附图**：输入区 chip + 消息气泡附图（既有全链已落地）。
- **模型读取的图**：发生在过程区（工具行），**不得**渲染成用户气泡（会伪造用户输入）。
  建议形态 = 工具行内可展开的缩略图 + 与「用户附图」分开的词表（如「模型读取了 1 张图片」）。
- 实现上优先复用过程事件里已有的工具行渲染（`processFlowCells` 一系），不改协议消息类型；
  但这涉及宿主 webview 改动 ⇒ 与内核契约分开排期。

## 6. 明确不做（写死在契约里，防后人「顺手」）

- ❌ 不给 `Message.tool` 加 `attachments`（§3）。
- ❌ 不把合成 user 消息写进 `round.userMessage`（否则 §2.2 的三条好处全灭，用户附图额度被工具图挤占）。
- ❌ 不为「工具读图」新开工具结果类型 / 新协议 op（语义可由既有 user 消息 + 可选字段表达）。
- ❌ 不做「静默降级」：模型无视觉能力时，不得让工具「成功返回文字描述」冒充读图成功。

## 7. 关联

- 台账条目：`IMAGE-TOOL-MESSAGE-1`（**已归档** → [tasks/archive/7.1.0-kernel.md](../../tasks/archive/7.1.0-kernel.md)：内核链路 + 宿主执行端口已落地，视觉 provider 下真机读图 2026-11-12 通过；剩余面 §5 已拆为 `IMAGE-THUMBNAIL-1`）。
- 用户附图输入通道：[方案-图片输入-20261027.md](../方案-图片输入-20261027.md)。
- 采集入口边界：[边界-图片采集UI-VSCode能力边界-20261028.md](../边界-图片采集UI-VSCode能力边界-20261028.md)。
