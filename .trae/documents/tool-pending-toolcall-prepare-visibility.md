# 流式工具调用提前感知（tool_pending）— 实施计划

## Context（问题与根因）

用户反馈：调用 write_file（全量写入，参数 = 整个文件内容）时，LLM 流式生成大 JSON 参数耗时数十秒，期间 UI 只有正文闪烁光标，没有任何"正在准备工具"的指示 → "写入无感、静默"。

已实证根因：`src/llm/openaiCompatible.ts` 的 `parseSseStream`（async generator）用 `toolCallAccumulators` 跨 delta 累积 `tool_calls`，但**只在 `finish_reason='tool_calls'` 或流结束才 yield 完整 toolCalls**（L444-L467、L486-L509）。参数生成时段（可能几十秒）零工具信号——事件层存在真空期，不是执行快慢问题。

目标：**工具名在流式参数中一成形，立即上报"正在准备调用 X 工具"**（瞬态展示轨 tool_pending，不落盘），UI 提前渲染工具折叠行（"准备中"态，不转 spinner——区别于执行中的旋转环），忠实表达"收紧形态"（思考折叠 / 文本直展 / 工具折叠三类平铺，工具执行全程可感知）。

## 改动清单（按依赖顺序）

### 内核 src/

**1. `src/llm/types.ts`** — `LlmChunk` 加可选字段（现有 `usage` 即同类扩展先例）：
```ts
/** 流式工具意图预告（2026-09-17）：tool_call 的 name 在 delta 中成形即上报，无需等 finish_reason。瞬态展示轨，不落盘 */
partialToolCall?: { id: string; name: string };
```

**2. `src/llm/openaiCompatible.ts`** — delta 累积循环（L444-L452）：
- 维护 `Set<number> emittedPendingIndexes`（**必须是 parseSseStream 局部变量**，随生成器回收，禁止类级——防跨请求泄漏，见审校 g）
- 某 idx 的 `acc.name` **首次由空变非空** 时：若 `acc.id === ''` 则按与 `buildToolCallsFromAccumulators` **同一规则合成 id**（复用同类 `toolCallIdSeq` 计数 `call_${seq}`——保证与最终 toolCalls 同源，修复审校 c 的最大缺口）；将 `{ id, name }` 挂到本 %循环% chunk 的 `partialToolCall` 上，并记入 Set（同一 idx 只发一次，防风暴）
- 完成后照旧（finish_reason / [DONE] / stop 清理分支均不动）

**3. `src/agent/types.ts`** — `AgentChunk` 加成员（参照 thought 的瞬态展示轨模式，注释注明不落盘、不进 ProcessEvent）：
```ts
| { type: 'tool_pending'; toolCallId?: string; name: string }
```
roundId 由 loop.ts `withRound`（L663-L667）统一附加，无需自行处理。

**4. `src/agent/managers/llmCaller.ts`** — 主循环（L271-L314）消费 `chunk.partialToolCall`：
```ts
if (chunk.partialToolCall) {
  yield { type: 'tool_pending', toolCallId: chunk.partialToolCall.id || undefined, name: chunk.partialToolCall.name };
}
```
与 thought 并列透传；narrate 仍按消息级延迟分类（L289-L295 buffer），时序审校已确认终态叙述在前、工具在后，语义正确（审校 d）。

### 宿主 hosts/memora-vscode/

**5. `src/shared/protocol.ts`** — `FromHostToWebview` union 加顶层消息 `tool_pending`（`{ type: 'tool_pending'; toolCallId?: string; name: string; roundId?: string }`）。process_event 通道不动（pending 不落盘，不进 eventsByRound；protocolGuard 130 配额实计 100，+1 无风险）。

**6. `src/webview/panels/chatPanel.ts`** — `consumeFlow`（L2343 起）加分支（放在 question_pending 分支附近）：
- `chunk.type === 'tool_pending'` → `this.post({ type: 'tool_pending', toolCallId, name, roundId: chunk.roundId })`，**必须 `continue`**、**不调 emitEvent（不落盘、不进 eventsByRound、不吃 seq）**
- roundId 自带在消息上（不依赖 currentRoundKey 变量，审校遗漏 4）

**7. `src/webview/scripts/chatView.ts`**：
- `consumeExecutionStream` 加 `msg.type === 'tool_pending'` 分支：`ensureProcessFlow` + 渲染 pending 工具行（复用 `renderToolRow` 行结构，状态走 `toolRowStatus` 新态）——append 到 process-flow 流尾（无 seq；流式期间"新的在最下"语义正确，finalize 全量重建时天然消失，审校 b）
- **pending 行不入 `currentEvents` 数组**（chatView L3433 的 push 分支跳过——否则 finalize 重建会残留幽灵行）
- `toolRowStatus` 加 pending 态：无 result && 无 start → `{ label: '准备中', open: true, running: false }`；行 class `is-tool-pending`
- **升级路径**：`tool_start` 到达时，`renderProcessFlow` 先按 `[data-tool-call-id]` 查 pending 行（复用现有 dedup selector）→ 命中则**显式** `classList.remove('is-tool-pending')` + `add('is-tool-running')` + 更新 label（含参数），不新建行；未命中才新建（缺 id 场景降级：pending 行短暂并存，finalize 清除，可接受）

**8. `src/webview/styles/chatStyles.ts`** — 新增：
```css
/* 工具准备中态（2026-09-17）：参数生成段可见性——静态浅环 ≠ 执行中旋转环 */
.round-block__tool.is-tool-pending > summary::before {
  content: ''; display: inline-block; width: 10px; height: 10px;
  margin-right: var(--sp-2, 6px); vertical-align: -1px;
  border: 1.5px solid var(--border-panel, rgba(128,128,128,.4)); border-top-color: transparent;
  border-radius: 50%; box-sizing: border-box;
}
```
（`is-tool-running` 前置旋转环已在上轮落地，不动）

### 测试

**9. `src/llm/__tests__/openaiCompatible.test.ts`**：新增用例——tool_calls delta 分片流中，**name 首片段到达即产出 partialToolCall（每 idx 一次）**，后续参数 delta 不再重复发；无 id 时合成的 `call_${seq}` 与 finish_reason 最终 toolCalls 的 id 一致。

**10. `hosts/memora-vscode/src/webview/__tests__/chatView.test.ts`**：新增用例——`tool_pending` → 工具行"准备中"（is-tool-pending）、不转 spinner（running=false）→ `tool_start` 同 id 到达 → 升级 `is-tool-running` → `tool_result` → 终态收起；并行多工具各自独立。

## 不做的事（范围纪律）

- 不改 ProcessEvent / roundStore（pending 不落盘，重放 = 定格结果，无"准备中"合理）
- 不改 loop.ts 执行路径（pending 是纯展示轨）
- 不新增 guardrail / 消息配额
- 写环成功态"保持展开"：**本轮不做**（上一轮已确认的选项，但其感知价值已由以上 pending 提前感知覆盖；待本方案落地验证后在真机复评是否需要，避免"写环特化"与"工具一视同仁"语义冲突）

## Verification

1. `cd hosts/memora-vscode && npx vitest run`（内核 openaiCompatible + 宿主全量 485 项全绿）
2. 真机：让 LLM 执行一次大尺寸 write_file（长文件内容），观察——参数生成段即出现该工具折叠行（"准备中"浅环）→ 执行段转旋转环 → 成功收起；对比修改前"只有光标闪烁"
3. 回归：多工具并行、被拦截工具（blocked 无 running）、暂停/继续/插话中断后 pending 行随 finalize 重建自然消失