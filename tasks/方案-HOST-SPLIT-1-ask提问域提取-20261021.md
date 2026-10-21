# 方案-HOST-SPLIT-1-ask提问域提取-20261021

> **任务 ID**：HOST-SPLIT-1 第 4 刀（台账已改：第 3 刀安全审计域 ❌ 否决后，本刀为下一刀）
> **前置**：第 1 刀 `bba90481`、第 2 刀 `41f19211` 已落地；第 3 刀候选已否决（`1137eeed`）
> **本刀定位**：**至今最重的一刀**——域体量 81 行、**外部依赖 5 个**、**测试穿透 13 处**（前两刀分别为 1–2 依赖 / 0–少穿透）。方案须逐条列清不变式，否则必带伤

---

## 一、现状分析

### 1.1 🔴 先更正台账的错误前提（本轮第一手实证）

上一轮否决记录写：「ask 域必须等第 4 刀 `consumeFlow` 阶段化**解耦 `runFlow`** 后才能拆」。
**该前提错误**——实测 `runFlow` 只有 **18 行**（chatPanel.ts:3331-3348）：

```ts
private async runFlow(factory, seed?): Promise<void> {
  this._abortController = new AbortController();
  try { this._currentFlow = this.consumeFlow(factory(...), this._abortController, seed); await this._currentFlow; }
  catch (err) { this._abortController = undefined; this.post({ type: 'error', ... }); }
}
```

它只做三件事：建 controller、挂 `_currentFlow`、同步抛错兜底。**`runFlow` ≠ 529 行的 `consumeFlow`。**

⇒ **我上一轮「让域反向持有宿主主循环 = 撞红线」的判断过严**：真正的红线是「域持有宿主**实例/状态**」，
而**注入宿主能力回调**（`post` / `getAgent` / `runFlow`）与前两刀同形态，不构成反向持有。
**ask 域现在就可拆，不必等 `consumeFlow` 阶段化。**

### 1.2 域边界枚举（2026-10-21 实测，HEAD = `1137eeed`，chatPanel 4607 行）

| 类别 | 成员 | 位置 | 行数 |
|---|---|---|---|
| 常量 | `ASK_TIMEOUT_MS` + JSDoc | chatPanel.ts:271-285 | 15 |
| 常量 | `ASK_TIMEOUT_NOTICE` + JSDoc | chatPanel.ts:287-293 | 7 |
| 字段 | `_pendingQuestions` + JSDoc | chatPanel.ts:482-490 | 9 |
| 字段 | `_askTimeout` + JSDoc | chatPanel.ts:491-496 | 6 |
| 方法 | `armAskTimeout()` + JSDoc | chatPanel.ts:3228-3235 | 8 |
| 方法 | `clearAskTimeout()` + JSDoc | chatPanel.ts:3237-3243 | 7 |
| 方法 | `handleAskTimeout()` + JSDoc | chatPanel.ts:3245-3273 | 29 |

**迁出合计 81 行**。

### 1.3 外部依赖（5 个——比前两刀多，须逐个设计注入形态）

| 依赖 | 用在哪 | 注入形态 | 设计要点 |
|---|---|---|---|
| `this._agent` | `cancelAsk()` / `resumeExecution()` | `getAgent: () => Agent \| undefined` | getter 委托（禁快照，同前两刀） |
| `this.isAskWaiting()` | `handleAskTimeout` 相位守卫 | `isAskWaiting: () => boolean` | 🔴 **必须注入、不得在域内重写判据**——`isAskWaiting` 是相位判据单点（chatPanel 内 3 个调用点：2983 / 3091 / 3256），域内再写一份 `phase==='waiting' && reason==='ask'` 就是**判据第二处 = SSOT 违例** |
| `this._turnState` | 读 `waiting.questions[0]`（提问原文） | `getTurnState: () => TurnState` | getter 委托（`_turnState` 被 `postTurnUpdate` 整体替换，必须读最新） |
| `this.post()` | 推「问 + 未回答」交互行 | `post: (msg) => void` | 同前两刀 |
| `this.runFlow()` | 起流续跑 `resumeExecution(undefined, signal, 'timeout')` | `runFlow: (factory) => Promise<void>` | 窄类型只声明第 1 参（`seed?` 可选参数兼容）；chatPanel 侧传 `(factory) => this.runFlow(factory)` |

### 1.4 域外调用点（6 处，跨 5 个方法）

| # | 位置 | 场景 | 搬迁后 |
|---|---|---|---|
| 1 | `postTurnUpdate` :2885 | 读 `questions` 供 `deriveTurnState` 投影 | `this._ask.pendingQuestions()` |
| 2 | `handleInput` :3099 | 暂停态补充 = 已响应 ⇒ 关超时保底 | `this._ask.clearAskTimeout()` |
| 3 | `answerInput` :3290 + :3300 | 提问被回答 ⇒ 关保底 + 整体清空 | `clearAskTimeout()` + `clearPending()` |
| 4 | `onPendingQuestion` :3609 + :3614 | 事件写入源头 + 补推投影 + 起保底 | `setPending(questions)` + `armAskTimeout()` |
| 5 | `consumeFlow` 流尾兜底 :3957 + :3959 | chunk 兜底装载提问 + 起保底 | `setPending(clarifyChunkQueue)` + `armAskTimeout()` |

> 调用点 4/5 位于 `bindAgentEvents` / `consumeFlow` 闭包内部 ⇒ 迁移后仍是「宿主订阅 agent 事件 → 回调写入域状态」，
> 订阅关系留在宿主（订阅是宿主的职责），域只接收写入。

### 1.5 ⚠️ 测试穿透 13 处（前两刀最多 3 处，且多为只读）

| 文件 | 处数 | 形态 |
|---|---|---|
| `chatPanelInput.test.ts` | 9（:123 类型声明 / :176 :214 :248 :318 **写入** / :236 **断言** `toEqual([])` / 另 3 处注释引用） | **写入驱动为主** |
| `chatPanelPauseProjection.test.ts` | 4（:94 类型 / :107 :121 :136 **写入** `[]`） | 写入驱动 |

🔴 **这是本刀最大风险**：写入型测试若改路径漏改，会落到**野属性**且**自写自读自洽 ⇒ 用例照样绿**，
但生产逻辑已不再读该状态 ⇒ 测试变成「因错误的原因通过」（第 1 刀血训的升级形态）。
**处置**：§6.3 变异验证设**专门一发**——「生产侧断掉对域状态的读取」必须转红。

### 1.6 判据③诚实记账

```
迁出 81 行 − 新增 ~20 行（import 2 + 字段 JSDoc 6 + 字段 3 + 构造注入 6 + 调用点注释增量 3）
          = 净降 ~61 行   （判据 ≥40，余量 21 行）
```

余量比第 3 刀候选（24 行 / 余量 2 行）健康得多——因域体量 81 行 > 安全审计域的 54 行，
JSDoc 增量占比约 25%（第 3 刀候选为 113%）。**但仍需按 §1.5 把 13 处穿透逐处改完，不留「顺手」**。

---

## 二、目标类设计

### 2.1 新模块 `extension/host/askCoordinator.ts`

```ts
import type { Agent, AgentChunk } from '@zooique/memora';
import type { PendingQuestionDto, TurnState, ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** ASK_TIMEOUT_MS / ASK_TIMEOUT_NOTICE 原样搬迁（含「只对齐时长严禁对齐语义」互引注释） */

/** ask 域全部反向依赖（5 个，逐一按 §1.3 设计） */
export interface AskDeps {
  getAgent: () => Agent | undefined;
  /** 相位判据单点（chatPanel.isAskWaiting）——🔴 禁在域内重写判据（SSOT） */
  isAskWaiting: () => boolean;
  getTurnState: () => TurnState;
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 起流续跑（chatPanel.runFlow，18 行包装；窄类型只声明 factory，seed 域内不用） */
  runFlow: (factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>) => Promise<void>;
}

export class AskCoordinator {
  private _pending: PendingQuestionDto[] = [];
  private _timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly _deps: AskDeps) {}

  /** 提问写入源（overwrite 全量写）——事件驱动与流尾兜底两处共用 */
  setPending(questions: PendingQuestionDto[]): void { /* 原样赋值 */ }
  /** 只读投影（postTurnUpdate 派生 turnState 用） */
  pendingQuestions(): PendingQuestionDto[] { return this._pending; }
  /** 提问被回答 / 被新提问覆盖 ⇒ 整体清空（非消费式 splice） */
  clearPending(): void { this._pending = []; }

  /** 启动/重置超时保底（覆写式） */
  armAskTimeout(): void { /* clearAskTimeout → 0/负值不 arm → setTimeout(handleAskTimeout) */ }
  /** 清除超时保底 */
  clearAskTimeout(): void { /* if (this._timer) clearTimeout + undefined */ }
  /** 超时保底（自动继续，非拒绝） */
  async handleAskTimeout(): Promise<void> { /* 八步顺序原样搬迁，见 §2.2 */ }
}
```

### 2.2 🔴 时序不变式清单（迁移前后逐条须成立，§6.3 据此设计变异）

| # | 不变式 | 出处 |
|---|---|---|
| T1 | `armAskTimeout` **覆写式**：先 `clearAskTimeout()` 再起新 timer（不叠加第二个 timer） | 3230 |
| T2 | `ASK_TIMEOUT_MS <= 0` ⇒ **不 arm**（0/负值 = 禁用超时保底） | 3231 |
| T3 | `handleAskTimeout` **八步顺序不可调换**：① timer 置 undefined（一次性）② pending 空则 return ③ `isAskWaiting()` 守卫 ④ 从 `_turnState.waiting.questions[0]` 读提问原文 ⑤ `_pendingQuestions = []` ⑥ post 超时记录 ⑦ `cancelAsk()` ⑧ `runFlow(resumeExecution(undefined, signal, 'timeout'))` | 3253-3272 |
| T4 | ⑦ 在 ⑧ **之前**：`cancelAsk` 先注入 `[ASK_ABORTED]` 占位 + 转存提问快照（`runResume` timeout 分支取走落盘 question） | 3270-3272 |
| T5 | **不随 `consumeFlow` finally 清**——ask 暂停后流已结束但等待仍活（生命周期仅限「存在未答提问」窗口） | 494 |
| T6 | `_pendingQuestions` 是**写入源**；读取一律经 `_turnState.waiting.questions`（`postTurnUpdate` 派生），**不做消费式 splice 镜像** | 485-488 / 2886-2887 |
| T7 | 提问原文唯一读点 = `_turnState.waiting.questions[0]`，域内**不自持第二份** | 3258-3260 |

### 2.3 chatPanel 侧残留形态

```ts
private readonly _ask = new AskCoordinator({
  getAgent: () => this._agent,
  isAskWaiting: () => this.isAskWaiting(),
  getTurnState: () => this._turnState,
  post: (msg) => this.post(msg),
  runFlow: (factory) => this.runFlow(factory),
});
```

无 sugar（5 处调用点均改经 `this._ask.xxx()`，路径变化、语义零变化）。

---

## 三、改动文件清单

| 文件 | 变更 | 预估 |
|---|---|---|
| `extension/host/askCoordinator.ts` | **新建** | ~120 行 |
| `webview/panels/chatPanel.ts` | 改：删域全部代码（81 行）+ 加字段与构造注入（~15 行）+ 5 处调用点改路径 | 4607 → **~4546** |
| `webview/__tests__/chatPanelInput.test.ts` | 改：9 处穿透路径随迁 | 断言语义零变化 |
| `webview/__tests__/chatPanelPauseProjection.test.ts` | 改：4 处穿透路径随迁 | 同上 |
| `extension/host/__tests__/askCoordinator.test.ts` | **新建** | 补 §6.2 用例 |

`max-lines` 豁免清单 chatPanel 条**暂不删**（仍 >1000）。

---

## 四、不提取的归档（含理由）

| 候选 | 规模 | 不提取理由 |
|---|---|---|
| **`consumeFlow` 阶段化**（原台账「下一刀」） | 529 行 | 🔴 **判据③从定义上不成立**——模式 B（方法内阶段化）把一个方法拆成几个，**总行数不降甚至升**（加 JSDoc/注释），拿「净降 ≥40 行」判它无意义。且它是全文件时序最密集处（第 1 刀已实证「关键词高命中里绝大多数是合法时序契约」），改动风险最高、收益（可读性）不可量化。**降级为独立议题**，不在 HOST-SPLIT-1 序列内做。 |
| `postTurnUpdate` + `deriveTurnState` 投影域 | ~60 行 | `deriveTurnState` 已是独立模块（真源在 helpers），`postTurnUpdate` 内混了 round 历史加载 / live 合并 / webview 投递 / 流尾收口四职责，**不是单一域**；且它是 ask 域的**上游消费者**（§2.2 T6），先拆消费者会让本刀的依赖链更长。 |
| `isAskWaiting` / `isPauseWaiting` 相位判据成域 | ~20 行 | 仅 2 个纯判据方法、各 3 个调用点，**不达 §5.2「≥3 处真实调用」的提取门槛**（且判据单点正是 §1.3 要保护的东西，抽走反而多一处跳转）。 |
| ask 域的订阅（`agent.on('questionPending')`）一并搬 | — | 订阅/退订是**宿主生命周期职责**（`bindAgentEvents` 还订了 memoryAdded 等 6 个事件）；把单个事件订阅拆进域会让事件注册散落两处。**留在宿主，域只接收写入**。 |

---

## 五、后续演进路径

```
第 0 步 ✅ max-lines 闸门（8ddf4a9e）
第 1 刀 ✅ 活动文件域（bba90481，4962→4762）
第 2 刀 ✅ 确认队列域（41f19211，4762→4607）
第 3 刀候选 ❌ 安全审计域否决（1137eeed，净降 24<40）
第 4 刀 ◀ 本方案：ask 提问域（81 行，预期 4607→~4546）
  ↓ 至此 chatPanel 三个「安全/交互关键域」全部物理隔离
终态 chatPanel.ts < 1500 行（距今约 3000 行，剩余大块：consumeFlow 529 / postTurnUpdate /
      handleWebviewMessage 分发链 —— 均需独立立项，不在本序列）
```

**终态目标不变**：chatPanel.ts < 1500 行；consumeFlow < 150 行（后者已降级为独立议题）。

---

## 六、验证计划

### 6.1 前置基线

| 门禁 | 结果 |
|---|---|
| 全量测试 `npm test` | **82 文件 / 1452 passed / 2 skipped / EXIT=0**（HEAD = `1137eeed` 无代码改动，`git status` 干净；实测取自第 3 刀否决轮同一 HEAD） |
| 类型 `npm run typecheck` | EXIT=0 / EXIT=0 |
| Lint `npm run lint` | EXIT=0 |

### 6.2 新增测试（askCoordinator 单测——现有覆盖为 0）

| 用例 | 断言要点 |
|---|---|
| 注册/状态 | `setPending` 写、`pendingQuestions` 读、`clearPending` 清（非 splice） |
| **T1 覆写式 arm** | 连 arm 两次 ⇒ 只有**一个** timer 生效（先清后起，不叠加） |
| **T2 禁用判据** | `ASK_TIMEOUT_MS <= 0` ⇒ 不起 timer（改用注入的时长或直接验「未 setTimeout」） |
| **T3 八步顺序** | pending 空 ⇒ 无 post 无 runFlow；`isAskWaiting` false ⇒ 无 post 无 runFlow |
| **T4 cancelAsk 先于 resume** | 记录调用序列，`cancelAsk` 索引 < `resumeExecution` 索引 |
| **T5 生命周期不随流清** | 无 `consumeFlow` 交互面（域内无流清理入口）——静态断言：域无 dispose 类方法被调用 |
| **T6/T7 提问原文读点** | post 载荷的 `question`/`options` 取自注入的 `getTurnState().waiting.questions[0]`，**不取自 `_pending` 写入值**（防第二真相） |
| 超时 notice 镜像 | post 的 text === `ASK_TIMEOUT_NOTICE`（镜像内核常量，防文案分叉） |
| `kind: 'timeout'` + question/options 透传 | 有 question 时带 question/options，无则不带（`...(...)` 条件展开） |

### 6.3 变异验证（每发记录三件）

| 变异 | 预期红 |
|---|---|
| **🔴 生产侧断链专用**：`postTurnUpdate` 的 `pendingQuestions()` 改返回 `[]` | `chatPanelInput` / `chatPanelPauseProjection` 相关用例红 —— **专门证伪「测试写到野属性仍绿」** |
| T1：`armAskTimeout` 删 `clearAskTimeout()` 首行 | 覆写式用例红 |
| T2：`ASK_TIMEOUT_MS <= 0` 判据删掉 | 禁用判据用例红 |
| T3-③：`isAskWaiting` 守卫删掉 | 相位守卫用例红 |
| T3-⑤：`clearPending()` 提前到 ④ 之前 | 提问原文用例红（读到已清空态） |
| T4：`cancelAsk()` 移到 `runFlow` 之后 | 调用序列表用例红 |
| T6：`clearPending` 改 `pop()` 单条弹出 | 非 splice 用例红 |
| notice 文案改写 | notice 镜像用例红 |

### 6.4 契约不变式（拆完必须仍成立）

1. `shared/protocol.ts` **零改动**（`TurnState` / `PendingQuestionDto` 只 import）
2. `MemoraChatViewProvider` public 签名零变化
3. `max-lines` 豁免清单仍 7 条
4. `isAskWaiting` **判据仍单点**（grep 全仓 `_turnState.reason === 'ask'` 只在 chatPanel 出现）
5. 超时/回答**竞态语义不变**：暂停态补充（3099）与提问被回答（3290）都仍只 `clearAskTimeout`，
   `answerInput` 的「先 clearAskTimeout 再 clearPending」顺序不变

---

## 七、实施完成

> 实施完毕（2026-10-21）。

### 7.1 验证结果（实际数据）

| 门禁 | 结果 |
|---|---|
| 全量测试（串行） | **83 文件 / 1464 passed / 2 skipped / EXIT=0**（195.29s） |
| 类型（双配置） | EXIT=0 / EXIT=0 |
| Lint（`--max-warnings 0`） | EXIT=0 / 0 warning |

- **对比基线** = 82 文件 / 1452 passed / 2 skipped ⇒ **净增 1 文件 12 例，零回归**
  （`grep -cE "^ FAIL|AssertionError"` = 0）。
- **体量**：`chatPanel.ts` **4607 → 4545（−62）**，超过收敛判据③的 40 行（余量 22 行，
  比第 3 刀候选的余量 2 行健康得多——因域体量 81 行 > 安全审计域 54 行，JSDoc 增量占比约 25%）。
- 新增：`extension/host/askCoordinator.ts` **147 行**、`__tests__/askCoordinator.test.ts` **285 行 / 12 例**。

### 7.2 实际改动文件清单

| 文件 | 变更 |
|---|---|
| `extension/host/askCoordinator.ts` | **新建** 147 行（类 + 2 常量 + `AskDeps` 5 依赖，JSDoc 原样搬迁） |
| `extension/host/__tests__/askCoordinator.test.ts` | **新建** 285 行 / 12 例 |
| `webview/panels/chatPanel.ts` | 删域全部代码（81 行）+ 加字段与构造注入（5 依赖）+ 5 处调用点改路径 + 删 `PendingQuestionDto` import + 4 处失效注释符号改写；4607 → 4545 |
| `webview/__tests__/chatPanelInput.test.ts` | 6 处穿透随迁（4 写 + 1 断言 + 1 类型声明）+ 3 处失效注释；cast 类型新增 `_ask` 窄接口 |
| `webview/__tests__/chatPanelPauseProjection.test.ts` | 3 处写入随迁 + cast 类型更新 |
| `shared/turnProjection.ts` | 1 处**失效行号引用**改符号引用（原写 `chatPanel L2566/L2811`，搬迁后全失效） |

**零改动**：`shared/protocol.ts`、`confirmCoordinator.ts` 的逻辑（仅 1 处注释符号引用修正）。

### 7.3 契约不变式核验（五条全过）

1. **`shared/protocol.ts` 零改动**——`TurnState` / `PendingQuestionDto` 只 import。
2. **`MemoraChatViewProvider` public 签名零变化**——5 处调用点全在 private 方法内。
3. **max-lines 豁免清单仍 7 条**。
4. **`isAskWaiting` 判据仍单点**——grep 全仓 `reason === 'ask'` 的**判据式**仅在 chatPanel
   （域内 T7 的 `state.reason === 'ask' ? … : undefined` 是**提问原文取值**而非相位判据，
   与原实现逐字一致，非新增判据面）。
5. **超时/回答竞态语义不变**——3099（暂停态补充）与 3228（提问被回答）仍只
   `clearAskTimeout()`；`answerInput` 的「先 clearAskTimeout → 后 clearPending」顺序不变。

### 7.4 变异验证记录（8 发：4 红 / 3 不红 / 1 计划外）

| # | 改前原文 → 改后形态 | 实测 | 失败签名原文 |
|---|---|---|---|
| 1 | `const questions = this._ask.pendingQuestions();` → `.slice(0, 0)`（**生产侧断链**） | **0 红** | — |
| 2 | `armAskTimeout` 删 `this.clearAskTimeout();` 首行 | **1 红** | `AssertionError: expected "clearTimeout" to be called with arguments: [ { refed: true, …(4), …(1) } ]` |
| 3 | 删 `if (!ASK_TIMEOUT_MS \|\| ASK_TIMEOUT_MS <= 0) return;` | **0 红** | — |
| 4 | 删 `if (!this._deps.isAskWaiting()) return;` | **1 红** | `AssertionError: expected [ { type: 'user', …(5) } ] to have a length of +0 but got 1` |
| 5 | `this._pending = []` 提到读 `getTurnState()` **之前** | **0 红** | — |
| 6 | `cancelAsk()` 与 `runFlow(...)` 对调 | **2 红** | `AssertionError: expected [ 'resume', 'cancel' ] to deeply equal [ 'cancel', 'resume' ]` |
| 7 | `clearPending` 的 `this._pending = []` → `this._pending.pop()` | **2 红（跨 2 文件）** | `AssertionError: expected [ { slot: 'q1', question: '语言？' } ] to deeply equal []` |
| 8 | `text: ASK_TIMEOUT_NOTICE` → `text: '提问超时了'` | **1 红** | `AssertionError: expected '提问超时了' to contain '用户未在时限内回答，已自动继续'` |

全部还原后 4 文件 55 passed；`grep -n "MUTATION-TEST"` 在本次改动文件内**零命中**
（chatPanel.ts:3198 那一条是 CTX-4 上一轮遗留，非本次引入，见 §7.6）。

### 7.5 🔴 三处方案↔实测偏差（如实登记，勿按方案原文引用）

**① 变异 1「生产侧断链 ⇒ 用例红」预期错误（0 红）**

计划断掉 `postTurnUpdate` 对域状态的读取，预期 `chatPanelInput` / `chatPanelPauseProjection` 转红。
**实测 43 passed 全绿。** 根因链（已 grep 实证）：

- `handleInput` 的相位路由读的是 **`_turnState`**（上一次投影的结果），**不读** `_ask._pending`；
- 测试用例如「多 ask 聚合」同时写了 `_turnState` 与 `_ask.setPending`，
  ⇒ **`setPending` 是装饰性写入**——它只影响 `postTurnUpdate` 的投影输出，而路由判据绕过了投影链；
- `onPendingQuestion` 事件回调（在 `bindAgentEvents` 闭包内）**零测试覆盖**——
  `grep questionPending --include=*.test.ts` 只命中一条注释。

⇒ 真实覆盖缺口 = **「事件 → setPending → postTurnUpdate → turnState 派生」这条链端到端无测试**。
**这是既有缺口，非本次引入**（搬迁前同样存在：那些 `_pendingQuestions = [...]` 写入也不影响被测逻辑）。

**② 自我纠错：「`_ask._pending` 完全无有效覆盖」这个中间结论是错的**

变异 1 的 0 红一度让我推出「该状态无任何有效断言消费者」。**变异 7 推翻了它**——
`clearPending` 改 `pop()` 时 `chatPanelInput.test.ts` 的「多 ask 聚合」用例转红
（残留一条 pending ⇒ 第二行 question 配不上）。
⇒ 精确表述：**状态本身被有效覆盖（变异 7 证明）；但「`postTurnUpdate` 消费该状态」这一面无覆盖（变异 1 证明）**。
两件事必须分开说，混起来就是错误归因。

**③ 变异 5 是等价变异，且方案把 T3-⑤ 写成了假「顺序不变式」**

方案 §2.2 的 T3-⑤「⑤ `_pendingQuestions = []`」被列为「顺序不可调换」，实测**调换后 0 红**：
提问原文真源是 `getTurnState()`，与 `_pending` **无耦合** ⇒ 两种顺序行为完全等价。
⇒ T3-⑤ **不是真不变式**，方案该条应作废（原文注释里「先读原文、后清状态」本就是两条独立语句的并列，非因果）。

### 7.6 遗留与后续

- **`chatPanel.ts:3198` 有 CTX-4 上一轮遗留的 `// MUTATION-TEST: 临时对调顺序` 注释**——
  语义不明（既像变异标记，又像临时改动的说明）。本刀**不顺手清理**（违「不顺便优化」），
  登记待独立处理。
- **T2「0/负值禁用保底」分支确认不可测**：`ASK_TIMEOUT_MS` 是模块级常量，不做依赖注入就无法注入 0。
  `confirmCoordinator` 的 `CONFIRM_TIMEOUT_MS` **同款不可测**。⇒ 若要覆盖需把时长改为注入参数，
  属「为测试改设计」，本刀不做，登记为两域共有的已知不可覆盖面。
- **真正的下一步不是继续拆域**：`chatPanel` 剩余大块为 `consumeFlow` 529 行 / `postTurnUpdate` /
  `handleWebviewMessage` 分发链。`consumeFlow` 阶段化（模式 B）**判据③从定义上不成立**
  （总行数不降），已在 §四归档为独立议题。chatPanel 终态目标（<1500 行）距今约 3000 行，
  **HOST-SPLIT-1 序列建议就此收口**，剩余块各自独立立项。