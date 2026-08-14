# 插件与 memora 内核设计对齐方案

> 状态：方案已定稿，待评审后分优先级实施
> 日期：2026-08-15
> 关联：[ADR-VC-001](../../../.trae/decisions/ADR-VC-001-vscode-plugin-host.md)（插件 = 第二个、更薄的宿主）、[agent-design-philosophy.md](../../../docs/architecture/agent-design-philosophy.md)（§7.2.1 / §13.x）、[memory-as-summary.md](../../../docs/architecture/memory-as-summary.md)（§5.2.1）
> 定位：本方案是 ADR-VC-001 决策 2「宿主边界」的**落地清单**——基于内核最新设计契约，逐项核对插件现状，给出对齐动作。不新增 ADR。
> **对齐策略（2026-08-15 定案）：激进对齐，不保留兼容层。** 旧版插件为 2026-08-14 开发的雏形，无用户存量、无发布历史，故本方案不做任何向后兼容让步——协议层一次性重构为与内核契约全量对齐，P3 执行前检查直接注入，不保留「不注入」选项。

---

## 一、背景

memora 内核持续演进，宿主契约随之增长。本方案以**内核当前设计文档**为基准，对照 **memora-vscode 插件现状**，识别差距并给出对齐方案。全程遵守「机制/策略分离」「薄壳 + 装配」「自然生长」三条纪律：内核给机制（事件流 / tracer 埋点 / getMetrics），插件做策略（采集 / 落盘 / 展示），不重复实现内核能力。

**对齐基调**：插件处于开发期（无存量用户），**一律以 memora 当前契约为准直接对齐**，不保留旧版兼容层、不做增量补丁——协议层重构、UI 中文化、tracer 注入、执行前检查全部一步到位。

内核演进给宿主带来的三块新增契约：

1. **可观测性契约**（[§13.x](../../../docs/architecture/agent-design-philosophy.md#L682-L693)）：闭环三条件之一「可观察」产品化为「透明面板数据源」——内核只产事件（`tool_start` / `tool_result` / `handoff` / `selfReview` / `question_pending`），宿主负责渲染透明面板。
2. **可追溯性边界**（[§5.2.1](../../../docs/architecture/memory-as-summary.md#L309-L330)）：`llm.call` span 记 `systemPromptHash`、`recall` span 记 `attachedMemoryCount` / `attachedMemoryFingerprint`（只记 hash 不记内容），由 **ITracer** 承载、不入 sessionStore。
3. **执行前检查三态**（[§7.2.1](../../../docs/architecture/agent-design-philosophy.md#L388-L404)）：统一执行入口前的单一检查点，`preExecutionCheck` 支持放行（可改写参数）/ 跳过 / 拒绝三态。

## 二、对齐差距清单

### 2.1 已对齐（无需改动）

| 契约 | 插件现状 | 位置 |
|---|---|---|
| 依赖注入（provider / storage / sessionStore / webSearch） | 已注入 | [assemble.ts](../src/extension/host/assemble.ts#L63-L102) |
| 事件流基础转发（text / tool_start / tool_result / selfReview） | 已转发 | [chatPanel.ts](../src/webview/panels/chatPanel.ts#L660-L683) |
| 会话级可观测事件（sessionError / guardrailError / contextTruncated 等） | 已绑定 | [chatPanel.ts](../src/webview/panels/chatPanel.ts#L273-L293) |
| 主动提问（questionPending → need_clarify） | 已实现 | [chatPanel.ts](../src/webview/panels/chatPanel.ts#L637-L641) |
| 角色包定位（doc-review） | 已实现 | [openChat.ts](../src/extension/commands/openChat.ts#L21) |
| 记忆活动提示（memoryRecalled / memoryAdded） | 已实现 | [chatPanel.ts](../src/webview/panels/chatPanel.ts#L642-L651) |

### 2.2 差距点

| # | 差距 | 现状 | 契约要求 |
|---|---|---|---|
| G1 | **tracer 未注入** | [assemble.ts](../src/extension/host/assemble.ts#L83-L97) 无 `tracer` 字段 → 默认 NOOP，指纹 / span 全丢弃 | §5.2.1：指纹由 ITracer 承载 |
| G2 | **指标面板缺失** | 未调用 `agent.getMetrics()`（内核已导出，[agent.ts](../../../src/agent/agent.ts#L2921)） | §13.x：透明面板 |
| G3 | **事件流不完整** | 只转发 text / tool / selfReview；`handoff` / `retry` / `paused` / `guardrailBlocked` / `error` chunk 未渲染 | §13.x：透明面板数据源全量 |
| G4 | **preExecutionCheck 未注入** | 仅 `permission:'owner'` + `allowedPaths` | §7.2.1：统一检查点 |
| G5 | **UI 消息未中文化** | 未传 `messages` → 内核默认英文（如 `abortedByUser`） | `UIMessages` 契约（[types.ts](../../../src/agent/types.ts#L149-L201)） |

## 二·五、方案排雷（2026-08-15，实施前）

对照架构哲学（机制/策略分离、单一真理源、不重复造轮子）逐层推演，发现 4 个雷区并已在上文方案中修正：

| # | 雷区 | 分析 | 修正 |
|---|---|---|---|
| 雷-1 | **事件/chunk 双通道** | 内核 `recall` / `question_pending` chunk 与 `memoryRecalled` / `questionPending` 事件（[agent.ts](../../../src/agent/agent.ts#L2065)）并存，插件已用事件通道；P1 若再收编这两个 chunk 会双通道重复渲染 | P1 明确**不收入**这两个 chunk |
| 雷-2 | **工具信息三重记录** | `tool_start` chunk（工具卡片）+ `tool.execute` span（tracer）+ P3 审计记录——三者覆盖同一信息 | P3 收敛为**注入放行、不做参数审计** |
| 雷-3 | **error 重复定义** | 流内 `error` chunk 与现有 `error` 协议消息语义相同，webview 已有分支 | P1 复用现有 `error`，不新增类型 |
| 雷-4 | **handoff 低频** | 插件默认 `endingHandoff=wait`，`handoff='loop'` 几乎不触发 | 保留渲染分支作为对齐完整性，标注低频，不做强 UI |

排雷后方案收敛：P1 只新增 `handoff` / `retry` / `paused` / `guardrail_blocked` 四类协议消息，P3 只做「注入放行」最小动作，无冗余、无双通道、无重复定义。

## 三、对齐方案（按 ROI 分层）

### 第 1 层（P0）：UI 消息中文化 —— 最小改动即见效

- **动作**：[assemble.ts](../src/extension/host/assemble.ts) 的 `AgentOptions` 注入 `messages`，覆盖为中文：
  - `abortedByUser`、`maxIterationsReached`、`interrupted`
  - `contextTruncated`、`recentConversationLabel`、`userLabel`、`assistantLabel`
  - `inputBlockedByGuard`、`guardrailWarningPrefix`、`outputBlockedByGuard`
  - `reflectionHint`、`selfReviewPrompt`
- **理由**：插件为中文用户；内核默认英文提示（如 `User cancelled the conversation`）破坏体验。纯配置、零风险、立即见效。

### 第 2 层（P1）：事件流全量对齐 —— 协议层一次性重构

[protocol.ts](../src/shared/protocol.ts) 的 `ExtensionToWebviewMessage` **一次性重构为与内核 `AgentChunk` 全量对齐**（激进对齐，非增量新增）：extension 侧把内核流式 chunk 收编进协议，webview 侧按类型渲染，不再维护「只转发部分类型 + 遗漏兜底」的现状。

| 内核 `AgentChunk` | 协议映射 | UI 形态 |
|---|---|---|
| `text`（含 `guardrailBlocked`） | `chunk` + 新增 `guardrail_blocked` 标记 | 消息区 + 错误级提示条「护栏阻断」 |
| `tool_start` / `tool_result` | `tool_start` / `tool_result`（现状保留） | 工具卡片（现状保留） |
| `selfReview` | `self_review`（现状保留） | 过程性提示（现状保留） |
| `handoff`（decision='loop'） | 新增 `handoff` | 低扰提示条「Agent 将自动续跑…」（对齐 UX 基线「活动透明」；低频：插件默认 endingHandoff=wait，见雷-4） |
| `retry` | 新增 `retry` | 低扰提示条「LLM 重试 2/3…」 |
| `paused` | 新增 `paused` | 提示条「Agent 已暂停」 |
| `error` | **复用现有 `error`**（不新增类型，见雷-3） | 错误提示条（webview 已有分支） |
| `recall` / `question_pending` / `thinking` / `done` / `aborted` | **不收入协议**（已被事件通道覆盖：memoryRecalled / questionPending / status / done，见雷-1） | — |

- **重构原则**：协议消息类型与内核 chunk 字段一一对应、命名对齐（`camelCase` 同源），消除「宿主侧手写字段名与内核漂移」的隐患（对齐 `protocol.ts` 单一真理源纪律）。
- **理由**：激进对齐——既然无兼容负担，就不做「转发白名单 + 未来补漏」的渐进路径，直接让协议成为内核事件流的镜像，透明面板数据源一次到位。

### 第 3 层（P2）：可观测性落地 —— §5.2.1 契约的核心对齐

新增宿主侧 `VscodeTracer`（`src/extension/host/tracer.ts`，实现内核 `ITracer`，从 `@zooique/memora` import 类型）：

- **有界采集**：内存环形缓冲（上限 200 条）记录 span 的 `name` + 属性，FIFO 截断。**收敛：不做落盘**（`traces.jsonl` 延后——默认关闭等于未用，避免未使用功能；如需落盘再按「有界、可选」边界补齐）。
- **指纹可见**：从 `llm.call` span 的 `systemPromptHash`、`recall` span 的 `attachedMemoryCount` / `attachedMemoryFingerprint` 提取，作为本轮「模型看到了什么」指纹展示（webview 新增折叠区，只显示 hash 前 12 位不显示内容）。
- **指标面板**：调 `agent.getMetrics()` 渲染：LLM 调用数 / 召回命中率 / 工具失败数 / 截断数（[AgentMetrics](../../../src/agent/tracer.ts#L182-L226)）。
- **注入**：[assemble.ts](../src/extension/host/assemble.ts) 注入 `tracer: vscodeTracer`；每轮流式结束后 [chatPanel.ts](../src/webview/panels/chatPanel.ts) 调 `postMetrics()` 推送协议 `metrics` 消息，webview 渲染折叠区。
- **理由**：内核已埋好点（`TRACE_SPANS` 十类 span + 属性约定，[tracer.ts](../../../src/agent/tracer.ts#L90-L139)），插件不采集则完全浪费；同时给开发者留下调试抓手。

### 第 4 层（P3）：执行前检查 —— 注入放行（激进对齐，收敛版）

- **动作**：注入 `preExecutionCheck`（选项 A 定案，**经排雷收敛**——不做参数审计记录，见雷-2）：
  - 默认全部放行（返回 `{ skip: false }`），保持 owner 全放行语义；
  - **不记录工具名 / 参数签名**：该信息已被 `tool_start` chunk（工具卡片）与 `tool.execute` span（tracer）覆盖，再记录构成三重冗余（雷-2）；
  - 不拦截、不审批——插件为 owner 权限自用宿主，无白名单 / 确认诉求。
- **理由**：激进对齐——§7.2.1 契约是「宿主以回调注入」承载执行前检查，注入是对齐动作本身；「不注入降级为现状」是兼容选项，开发期无兼容负担时应直接对齐而非留缺口。收敛版只做「放行」这一最小动作，审计职责已由既有链路承担，不重复造轮子。

## 四、边界与纪律（贯穿全部）

1. **不重复实现内核**：tracer 只做「采集 + 展示」，不做「埋点」（埋点已在内核）；事件流只「转发 + 渲染」，不重排、不改造 chunk 语义。
2. **有界 + 可选**：指纹 / 指标只读不写 sessionStore，落盘可开关（默认关闭）。
3. **全量对齐，不保留兼容层**：协议层与内核 `AgentChunk` 一次性对齐（激进对齐，2026-08-15 定案）；所有改动以 memora 当前契约为准，不做旧版兼容补丁。
4. **单一真理源**：协议消息类型集中在 [protocol.ts](../src/shared/protocol.ts) 定义，extension 与 webview 共用；字段命名与内核 chunk 同源，不手写漂移。

## 五、验收标准

- [x] G5：内核默认英文 UI 消息全部被中文覆盖（`CHINESE_MESSAGES` 注入 assemble，覆盖 abortedByUser / 截断 / 护栏 / 自审查等全部 UIMessages 字段）。
- [x] G3：协议层与内核 `AgentChunk` 全量对齐，`handoff` / `retry` / `paused` / `guardrailBlocked` 在 webview 有对应渲染（`error` 复用现有消息，雷-3）。
- [x] G1+G2：注入 `vscodeTracer` 后，每轮结束推送 `metrics` 协议消息，webview 折叠区显示系统提示指纹（前 12 位）与附着记忆条数 + 累计指标。
- [x] G4：`preExecutionCheck` 已注入（放行，收敛版不做参数审计，雷-2）。
- [x] 全量测试通过：typecheck 干净 + 44 个测试全过（新增 5 个事件流/指标渲染测试）。

> **实施记录（2026-08-15）**：P0~P3 已全部落地。P1 收敛为只新增 `handoff` / `retry` / `paused` 三类协议消息 + `chunk.guardrailBlocked` 可选标记；P2 收敛为不做落盘（仅内存采集）。`@zooique/memora` 内核需先 `npm run build` 重建 dist（插件引用构建产物，preExecutionCheck/tracer 新字段才能被类型解析）。

## 六、实施顺序建议

按「装配链路 → 事件流 → 可观测性」顺序一次做完（激进对齐，不渐进保留中间态）：先 P0（中文化）+ P3（preExecutionCheck 注入，均属 assemble 装配改动），再 P1（协议层与事件流全量对齐），最后 P2（tracer + 透明面板）。
