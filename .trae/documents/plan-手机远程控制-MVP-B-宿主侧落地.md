# 手机远程控制 · MVP B 宿主侧落地（排雷后执行计划）

## 一、Context（为什么做这一刀）

开手机仓有硬闸门（方案 §19.8：S0/S1 销项 + profile 3 六项安全底线 + App 闸门）。宿主侧还差三块可独立销项的能力，缺了它们手机仓只能造出零消费方：

1. **档位门缺失**：`remoteBridge.ts#handleCommand` 只写死「`answer` 需 `approve`」，没有把 §5.9 的 `observe / send / approve` 三档 × 九命令收成一张表。后续每加一条命令都要在桥里手写一遍 if，必然长出第二份权限判据。
2. **快照未裁**：`pushSnapshot` 只剥了 `attachmentUris`，仍在每步重传完整 `processEvents` / `assistantLog`，§6.4 `TrimmedRound` 未落地（手机上等于每步重传整段历史）。
3. **最小可对话闭环缺两条**：只有 `answer`，没有 `send` 与 `resume`，手机连「发一句话」「解暂停」都做不到。

本轮把这些落地，**不**实现 `interject / pause / stop / confirm_answer / remove_pending_item / clear_pending_queue`（后五条中 `confirm_answer` 必须与 confirm 卡下行 `attention` 同批，不许做半条；其余四条宿主尚无按 sid 的落点）。

## 二、排雷结论（SSOT / 自然生长 / 不带伤）

| # | 拟做 | 伤型 | 订正（本计划执行口径） |
|---|---|---|---|
| 1 | 新建 `remoteCommandRouter.ts` 覆盖九命令 | 第二执行面：定址 + 查表 + 投递被复制一份 | **改造既有** `remoteAnswerRouter.ts` → `remoteCommandRouter.ts`，一个执行面只写一次差异段 |
| 2 | 为五条未接入命令在桥里各写一个分支 | 平行判据 / 零消费方 | 桥只保留 `answer / send / resume` 三条 input 映射；其余命令**明确回 `forbidden`** 并在注释与台账写明「本切片未接入」，不伪造执行 |
| 3 | 档位表另立一份「谁能发什么」 | 与 §5.9 双写 | 表格的**唯一落点**是 `remoteCommandPolicy.ts`（已承载相位表与 `forbidden` 常量），桥只查表 |
| 4 | `resume` 与 ctl 帧 `t:"resume"` 同名 | 措辞折叠 | 不改名（协议已定），在命令分派处用一句话指明「业务命令 resume ≠ 重连水位 resume」（§6.5 既有警示） |
| 5 | 快照裁剪散在宿主适配 | 多入口各裁一份（回环 / LAN 两份） | 裁剪收成**纯函数**，由桥的 `pushSnapshot` 单点调用；端口契约不变，任何宿主实现自动受益 |
| 6 | 顺手接 `confirmPending` / `in_flight` | 无消费方的机制先行 | 本轮**不接**：`phaseOf` 仍传 `false`，`in_flight` 不做；两项进台账未做项，随 B2 / 仲裁片落地 |
| 7 | 改完桥不回头改文件头 | 谎报位点（头注释仍写「只投递 answer」） | 头注释与 `handleCommand` 同批改，断言「文档 ↔ 实现 ↔ 测试」三方一致 |

## 三、改动清单

### 1. `hosts/memora-vscode/src/extension/host/remote/remoteCommandPolicy.ts`（扩）

- 新增 `TIER_TABLE`：`RemoteDeviceTier → readonly RemoteCommand[]`，写死并逐档注释判据来源（§5.9）：
  - `observe`：无
  - `send`：`send` / `interject` / `pause` / `stop` / `resume` / `remove_pending_item` / `clear_pending_queue`（resume 与 pause 同一执行控制面对，不单独设档）
  - `approve`：send 档全集 + `answer` / `confirm_answer`（档位**累积**，approve ⊃ send ⊃ observe）
- 新增 `evaluateTierGate(tier, command): RemoteCommandDecision`（放行返回共享 `ALLOW`，拒绝返回 `reject(FORBIDDEN)`）。
- 仅 `import type { RemoteDeviceTier } from './remoteDevices.js'`（纯类型，无运行时依赖、无环；档位语义唯一来源仍是 §5.9）。

### 2. `remoteAnswerRouter.ts` → `remoteCommandRouter.ts`（改造，git mv）

- `routeRemoteAnswer(sid, answers, ports)` → `routeRemoteCommand(command, sessionId, ports)`：
  - ① 定址 `hasSession` → `no_session`；
  - ② 查相位表 `evaluateRemoteCommand(command, phase)`；
  - ③ 调 `ports.deliverInput(sessionId, input)`，`input` 为 `Extract<WebviewToExtensionMessage, { type: 'input' }>`；
  - 返回 `{ ok: true } | { ok: false, code }`。
- 文件头注释同步改写：仍然只做「定址 / 查表 / 投递」，业务判据一条不复制。
- 测试文件同步改名 `remoteAnswerRouter.test.ts` → `remoteCommandRouter.test.ts`，并把用例改成传 input 消息。

### 3. 新增 `remoteSnapshotTrim.ts`（纯函数 + 类型）

- `export type TrimmedRound`：`Omit<RoundView, 'attachmentUris' | 'processEvents' | 'assistantLog'>` + 裁剪后的 `processEvents?` / `assistantLog?` + 可选 `truncated?: { processEvents: number; assistantLog: number }`（0/缺省 = 未裁；blob 通道落地前它是「历史不完整」的唯一诚实信号）。
- `export const TRIMMED_RECENT_EVENTS = 50`、`TRIMMED_RECENT_LOG = 20`（单一常量 + 注释「先到为准，随 §6.7 窗口统一口径前只作展示上限」）。
- `export function trimRound(round: RoundView): TrimmedRound`：剥 `attachmentUris`（整键删除，不留 `undefined`），保留最近 N 条，其余计数进 `truncated`。
- 单测：附件键不出现、超长截断取**尾部**、未超长不产生 `truncated`、原对象不被修改。

### 4. `remoteBridge.ts`

- 端口：`deliverAnswer` → `deliverInput(sessionId, input)`（§6.6 三条命令都落 `handleInput`，一个投递口即够，不建命令→端口映射表）。
- `handleCommand` 改为：
  1. LAN 档（有 `security`）先 `tierOf` → `evaluateTierGate`，`forbidden` 在此返回；
  2. 回环档（无 `security`）保持 profile 2 能力边界：仅 `answer`，其余 `forbidden`；
  3. `buildInput(kind, p)` 构造 input 消息（`send` 校验 `p.text` 非空字符串、`answer` 复用 `readAnswers`、`resume` 无载荷；其余六条返回 `undefined`）；
  4. `undefined` ⇒ `err forbidden`（已接入范围之外，不伪造执行）；
  5. 载荷写坏（如 `answers` 非 string[]）沿用现有 `close(1008)` 语义；
  6. `routeRemoteCommand` → 失败回固定码，成功且已订阅则回推快照。
- `pushSnapshot` 的 `rounds: snapshot.rounds.map(trimRound)`（替换现在的手写解构）。
- **文件头注释同批订正**：profile 2 / profile 3 两段「只投递 answer」改为「本轮接入 answer / send / resume；其余命令回 forbidden（未接入，非相位/档位拒绝）」。

### 5. `remoteBridgeHost.ts`

- 端口实现 `deliverAnswer` → `deliverInput`，实现体仍是 `panel.handleInput(input, sessionId)`（与 webview 同一条路），失败只记日志。
- 不做其它接线（`pause` / `stop` / `interject` / pending 队列 / confirm 待办均不接）。

### 6. 测试

- `remoteCommandPolicy.test.ts`：新增 3 档 × 9 命令穷举（观察档全拒、send 档 7 条、approve 档 9 条；拒绝码恒 `forbidden`；放行返回共享 `ALLOW` 引用）。
- `remoteCommandRouter.test.ts`：`no_session` / `busy` / `stale_phase` / 放行投递且 input 原样透传（含 `send` 的 `text`、`answer` 的空串位次）。
- `remoteBridge.test.ts`：
  - 回环档：`send` → `forbidden`（能力边界不变）；
  - LAN `send` 档：idle 下发 `send` → 端口收到 `{type:'input',kind:'send',text}` 并回推快照；running 下发 → `busy`；
  - LAN `observe` 档下发 `send` → `forbidden`；
  - LAN `send` 档：`waiting-pause` 下发 `resume` → 投递；idle 下发 → `already_resumed`；
  - `pause`（表内允许但未接入）→ `forbidden`，且端口零调用；
  - 快照：`processEvents` 超长被截断、`attachmentUris` 不出现。
- golden fixtures：本轮**不产出**（无手机端消费方，先落测试内联夹具），台账登记为后续。

### 7. 文档与台账

- `docs/方案-手机远程控制-20261110.md` §18.5.2：补 **V3 = 「Flutter/Dart mTLS 客户端证书可行性」** 硬闸门行（状态按 spike 结果如实写「已验 / 未验（原因）」）。
- `docs/施工单-手机远程控制-20261124.md` 第 5 节：同步 V3 与「MVP B 已接入命令集」。
- `tasks/待完成任务.md` 的 `REMOTE-LAN-1`：补未做项——`TrimmedRound`（本轮销项）、`send`/`resume`（本轮销项）、`confirm_answer + attention`（B2）、`interject/pause/stop/pending 队列`（未接入）、`in_flight` 仲裁、`confirmPending` 未接、golden fixtures、V3 spike 结果。
- `docs/CHANGELOG`（宿主区）按宿主发版流程口径补条目（若该区存在对应 Unreleased 段）。

## 四、执行顺序与门禁

| 片 | 内容 | 门禁（每片后跑） |
|---|---|---|
| P1 | 档位表 + `evaluateTierGate` + 单测 | 宿主 `npm run typecheck`；`npx vitest run src/extension/host/remote` |
| P2 | `trimRound` 纯函数 + 单测 + 桥快照改用 | 同上 |
| P3 | 路由改名改造 + 桥命令分派（answer/send/resume）+ 宿主端口 + 单测 + 头注释 | 同上 + `npx eslint src/extension/host/remote --max-warnings 0` |
| P4 | V3 spike（`dart`/`flutter` 可用则临时目录验证 mTLS 客户端证书；不可用则如实记「未验」） | 不建仓、不入仓 |
| P5 | 文档 + 台账 | 根目录 `npm run verify:dist-contract`、`verify:ledger-hygiene`、`verify:ledger-fold`、`docs:links` |
| P6 | 全量回归 + 分片提交（只提交不推送、逐文件 add、commitlint body 每行 <100 字） | 宿主 `npm test` 全量 + `npm run compile` |

## 五、明确不做（防止本计划被读成「桥已完成」）

- 不做 `delta` / 水位 `resume` / `attention` / `blob` / `host_state`；
- 不做 `confirm_answer`（缺 confirm 卡下行，做半条 = 无消费方）；
- 不做 `interject` 回执（需要新的回执载荷，属协议扩张）；
- 不改内核、不新增错误码、不新增封套类型。
