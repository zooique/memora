# ADR-027 · 过程事件日志 + 重放重建（单文件内聚 + 展示层单形态）

> **状态**：✅ 已接受
> **日期**：2026-08-28 **播种批次**：日常生长 **来源**：[process-event-log-replay-design.md](../docs/architecture/process-event-log-replay-design.md)（v1.5）

## 背景

对话中大量运行时状态（角色徽章、LLM 名、召回记忆、工具调用、自审查、已停止标记、执行指标）只在内存展示，重启/切会话后丢失，只剩干巴巴正文——展示层存在「内存投影 vs 磁盘正文」两份状态，违反「运行时所见 = 真理源读视图」。

## 决策

1. **单文件内聚**：过程事件并入 Round 文件（`Round.processEvents?: ProcessEvent[]` 可选字段），与正文同文件同轮——删 round 即删事件、分叉即共享、截断即覆盖，生命周期原子，无独立事件存储。
2. **ProcessEvent 是唯一事件载体**：十种类型（meta/thinking/recall/memory_added/tool_start/tool_result/self_review/text_self_review/aborted/metrics），运行时缓冲 → 流结束附到 Round 一次性落盘；重放读同一份数据。
3. **展示层单形态**：webview 渲染真相源 = 当前轮 `processEvents[]`，「运行时 `process_event` 增量 + 重放 `replay_events` 整批」汇入同一数组、同一 `renderRoundBlock()` 渲染；每轮消息身份标签由 `currentRoundMeta`（meta 事件写入）单源驱动，会话级顶栏独属 `chat_role_pack`。
4. **过程事件存储只存最小重建信息**：`tool_args` 截断、记忆只存摘要、metrics 只存本轮汇总——事件不含正文全文。

## 理由

- **SSOT**：过程数据单一存储点（Round.processEvents）、单一渲染输入（events[]）、单一身份来源（meta → currentRoundMeta），不存在「运行时 vs 落盘」两套卡片。
- **生命周期正确性**：分轨存储需为 GC/分叉/截断维护双边联动（曾为此付出复杂度），单文件内聚天然原子，零联动代码。
- **降级优先**：写盘 fire-and-forget + catch-only-log；流式中途崩溃仅损失本轮事件缓冲，正文不受影响。
- **自然生长**：基于既有 Round 生命周期扩展，不新增存储后端、不改 Agent Loop、不新建顶层模块。

## 替代方案

| 方案 | 放弃原因 |
| ---- | -------- |
| 分轨 JSONL（`round-events/<roundId>.jsonl`，v1.3） | 宿主流式期间拿不到当前 roundId 导致写入路径受阻；GC 双路径清理复杂度；重放交织需 host 编排——整体不如单文件内聚 |
| 多类卡片并行渲染（tool-card/review-block/thought-block，v1.2 前） | 渲染输入两套（运行时消息类型 vs 重放批量），同一信息多处定义，违反 SSOT |
| 事件随会话级存储（不随 Round） | 分叉/截断语义错误：分叉共享 roundId 后事件归属漂移 |

## 影响

- `Round` 接口新增可选字段 `processEvents`（向后兼容，pending/error 轮天然无事件）；`@zooique/memora` 导出 ProcessEvent 家族类型。
- 宿主协议：删除 thinking/tool_start/tool_result/self_review/memory 渲染类消息，新增 `process_event` / `replay_events`；展示层收敛为 round-block 单一折叠块。
- 旧会话（无 processEvents）仅回放正文，不产生空过程块。

## 何时回顾

- 当过程事件需要独立于 Round 的检索/订阅/分析诉求出现（事件量增长到影响 Round 文件大小）时，重新评估分轨存储。
- 当展示层出现第二套渲染输入（如独立的 trace 可视化面板进入 round-block）时，检查 SSOT 是否仍在。