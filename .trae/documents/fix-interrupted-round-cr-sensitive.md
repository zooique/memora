# 修复中断轮假性 complete 吞没（问题 3）

> **坐标**：正文行号为**历史记录的时点快照**，代码演进后不再核对——定位请按符号名检索，勿依赖行号。
>
> **退役注记（2026-09-23）**：本文重放 wire（`replay_events` / `sendRoundView`）已退役——重放现由 `turn_update`（`replay: true` + `rounds`）整轮承载（详见[turn-runtime-render-ssot.md](../../docs/architecture/turn-runtime-render-ssot.md)）；中断轮语义（`interrupted` 状态、独立平铺、§已停止）不变。

## Context（为什么做）

用户在互动叙事平台 `.memora` 真实回放中，LLE 任务被停止/中断后重启，发现**只剩用户提问、过程（思考/工具/中断标记）全丢**。实证于 `round-1789462982489.json`：中断轮被落盘为 `status:"complete"`（假性完成），`processEvents` 有完整过程（ten 条 thought、三次 FILE_NOT_FOUND 后成功的 read_file、aborted/metrics），但无 `assistantMessage`。

两层根因：
1. **内核落盘**：`appendInterrupted` 把中断/失败轮统一标成 `status:'complete'`，仅 content 非空才写 `assistantMessage`。
2. **webview 渲染**：重放 `replay_events` 到达后，`round-block`（任务过程折叠块）必须挂在本轮首个 assistant 消息块上；中断轮无 assistant 正文块 → 折叠块挂不上 → 过程全丢。

用户裁决：**新增 `interrupted` 状态**；**中断轮重放过程独立可见、不收进折叠块**；**不带伤修复**（直接修根因，不叠兼容补丁）。

## 方案总览（数据流一条线）

中断/失败 → `appendInterrupted` 落盘 `status:'interrupted'`（不再 complete）→ refCount+1 入会话 roundIds → 重放 `loadRoundBasedHistory` 读出 → 中断轮 `assistant` 置空、`interrupted:true` 传出 → webview `replay_events` 走**独立平铺**路径（非折叠块）渲染过程 + §已停止。

## 改动清单

### 内核

1. **`src/memory/roundStore.ts`** L116
   - `RoundStatus` 增加 `'interrupted'` → `'pending' | 'complete' | 'error' | 'interrupted'`
   - 更新 L101-115 注释："运行时失败/中断不再一律按 complete 处理，改为 interrupted"

2. **`src/agent/messageHistory.ts`** `appendInterrupted` L432-485
   - L445 幂等守卫"已收场跳过"保持不变（interrupted 也视为已收场）
   - L465 `status: 'complete'` → `status: 'interrupted'`
   - 更新方法 JSDoc 语义（"无写 assistantMessage 时按 stop 语义收场"保留）

3. **`src/agent/seed/orchestrator.ts`** L186-216
   - 更新"非正常收场统一收口"注释：appendInterrupted → interrupted（失败仍并轨为该语义）

4. **`src/memory/inMemoryRoundStore.ts`** L187-213 `listInterruptedRecent`
   - 打捞条件**保持 `pending || error` 不变**（不加入 interrupted）
   - 理由：运行期收场已即时标 interrupted 且 refCount 0→1，不再符合 `refCount===0 && pending` 打捞条件，不会重复命中；崩溃残留轮仍是 pending，打捞照旧。interrupted 轮是"已正常收场的停 turn"，不属崩溃孤儿。

5. **`src/memory/sessionViewLoader.ts`** flattenRoundsToMessages L154
   - 保持 `status === 'complete'` 才产 assistant 消息——中断轮不进会话消息列表（语义自洽，不改）

### 宿主

6. **`hosts/memora-vscode/src/extension/host/workspaceRoundStore.ts`** L404-417
   - 打捞条件与 inMemory 对齐（保持 pending||error，不需加 interrupted，核查注释同步）

7. **`hosts/memora-vscode/src/webview/panels/chatPanel.ts`**
   - `ReplayRound` 接口（约 L83-104）加 `interrupted: boolean`
   - `loadRoundBasedHistory`（L1831-1843）：由 `round.status === 'interrupted'` 派生 `interrupted`；assistant 仅在 `content && status==='complete'` 时 push（中断轮恒置空）
   - `sendRoundView`（L1883-1938）：replay_events 消息携带该 `interrupted` 标志

### webview（核心改造）

8. **`hosts/memora-vscode/src/webview/scripts/chatView.ts`**
   - **抽离平铺锚点**：`ensureProcessFlow`（L727-746）当前依赖 `activeAssistantEl`。新增/改造：当无 assistant host 但属中断轮时，把 `process-flow` 容器挂到 `.messages` 尾部（本轮 user 块之后），用 `data-round-id` 记录所属轮；重放中断轮不计入 `roundBlockHostEl`。
   - **replay_events 分支**（L3311-3322）分流：
     ```ts
     if (msg.interrupted) {
       currentEvents = [...msg.events];
       renderProcessFlow(msg.events);   // 平铺（复用现有函数）
       flagInterruptedMarker(msg.events); // §已停止 平铺行
     } else {
       renderRoundBlock(msg.events, true); // 原路径
     }
     ```
   - **§已停止平铺行**：平铺模式无 `sectionOf`，新增独立 `.process-flow__stopped` 行（复用 `stopReasonLabel` L1008，`events.find(e=>e.type==='aborted')`），并补 metrics 行（沿用 L1304-1312 `finalSuccess` 判定）
   - **生命周期**：中断平铺容器在切会话（clear_ok/新闭环 user）时清理，防残留串轮；中断平铺分支不触 QA 折叠逻辑

## 复用与既有实现

- `renderProcessFlow`（L1339）：现成平铺渲染，直接复用，不新建渲染器
- `stopReasonLabel`（L1008）：§已停止文案单一映射
- `appendInterrupted` / `listInterruptedRecent` / `loadRoundBasedHistory`：均为既有函数，只改语义不变签名主路径

## 需更新测试

- 内核：`messageHistory.test.ts`（appendInterrupted 断 status='interrupted'）、`orchestrator.test.ts` + `uninterruptedWorkflow`（status 断言改 interrupted）、`sessionViewLoader.test.ts`（中断轮不产 assistant）
- 宿主：`chatView.test.ts`（中断轮重放平铺可见、不收折叠、§已停止行）、`chatPanelHistory.test.ts`（loadRoundBasedHistory 中断轮 assistant 空 + interrupted 传出）、`workspaceRoundStore.test.ts` + `workspaceSessionStore.test.ts`（打捞不命中 interrupted 轮）

## 边界与风险（不带伤）

- **旧数据 `status:'complete'` 但含 aborted**：不做状态迁移、不加 shim。旧中断轮在旧 status 下仍按原路径（折叠可见过程，因有 aborted 事件），不回归。新写入的轮才走 interrupted 语义。
- 运行时 `finalize`（done/interrupted）对完整轮**行为不变**；仅重放中断轮走新平铺分支。
- 平铺容器跨轮清理点需覆盖：clear_ok、新闭环 user、interrupted。

## 验证

1. 类型检查：`cd hosts/memora-vscode && npm run typecheck`
2. 单元测试：`npm run test`（全量回归，重点 chatView / chatPanelHistory / messageHistory / orchestrator）
3. 手工真机复查：用 `F:\用户目录\Desktop\互动叙事平台方案\.memora` 的中断轮重开面板，确认该轮思考/工具过程平铺可见 + "已停止"标记，且不再只剩用户提问