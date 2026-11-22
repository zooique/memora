---
name: memora-live-replay-parity
description: 在 memora 双包架构（内核 @zooique/memora + VS Code 宿主 hosts/memora-vscode）中诊断和修复「同一事实的运行时（live）投影与重放（replay）投影不一致」时使用——尤其是重放/关页刷新显示正常、但 live 运行时不显示 / 显示成不同形态 / 显示位置错（挂在回答后而非首句气泡后）/ 同一条画两次（双画）。覆盖「重放正常 ≠ live 正常」的反推禁令、四层定位法（数据 → 注入 → 投影 → 渲染）、「看见」三维度（形态 / 时机 / 位置）独立验收、投影落点的会话身份（sid）与轮锚（roundId）判据、以及 parity 机器守卫的覆盖缺口。当用户提到「重放正常但实时不显示」「关页刷新才出来」「显示站错位置」「双画」「live 和 replay 不一致」「测试全绿但真机不对」「补充输入没上屏 / 上屏了却挂在回答后面」「我在助手窗敲的话没反应」时加载。
agent_created: true
---

# memora live/replay 渲染一致性（四层定位 × 三维验收）

> **一条事实的两种投影必须同形、同时、同位。** 本 skill 只给「触发词 + 检查表 + 案例索引 + 缺口登记」，不复述原则本身——原则真源在下方「真源指针」，本节一个字都不复制。

## 何时用（触发词）

- 重放正常但 live 不显示 / 关页刷新才出来 / 重启后才有
- 显示但站错位置（挂在回答后、不在首句气泡后、顺序颠倒）
- 同一条补充画两次（双画）
- live 与 replay 形态不同（一个过程行、一个气泡）
- 测试全绿但真机不对 / 门禁绿了但看着不对
- 补充输入 / interject / question-answer 上屏相关问题

## 真源指针（只引用，不复述）

原则性断言一律回源，本 skill 不建第二份判据：

| 命题 | 唯一真源 |
|---|---|
| UI = f(rounds, turnState)、运行时特判 = bug 信号、投影层收口 | `docs/architecture/turn-runtime-render-ssot.md` |
| 重放渲染走同一渲染函数、过程事件唯一落盘面 | `docs/architecture/process-event-log-replay-design.md`、`.trae/decisions/ADR-027-process-event-log.md` |
| 「第三条呈现路径」为何退役、排队中 ≠ 已说出 | `tasks/archive/0.1.0-host.md` |
| live×replay 同形对拍的机器守卫现状 | `hosts/memora-vscode/src/webview/__tests__/runtimeReplayParity.test.ts` |
| 完工事实与判据（按 ID 查，不复制正文） | 台账 `INTERJECT-LIVE-SYNC-1` / `ASSISTANT-INPUT-BUBBLE-1` |

## 核心心法

**① 重放正常 ≠ live 正常。** 两条路共用渲染函数，但数据源与触发时机不同：重放直读落盘 `rounds` / `interactiveInputs`（真实 ts / roundId），live 走运行时消息投影。所以「关页重开对了」只证明重放链完好，不能反推 live 链。反过来「测试绿」也不代表真机对——先把这个反推禁令立住，再动手。

**② 先分四层，再动手。** 遇到「显示问题」逐层取证，不跳层下结论：

| 层 | 问句 | 本仓取证面 |
|---|---|---|
| 数据层 | 落盘有没有这条事实？ | `round-*.json` 的 `interactiveInputs` / `processEvents` |
| 注入层 | 模型吃到没？ | round 的 `assistantLog` / thought / tool 调用 |
| 投影层 | 宿主投到哪个会话（sid）、有没有投、投几次？ | `chatPanel.ts` 的 `postToSession` / `syncPendingQueue` / `viewsMayShow` |
| 渲染层 | DOM 落点、形态、轮锚对不对？ | `chatView.ts` / `statusBarsView.ts` / `interjectEcho.ts` |

本仓血训：曾经判定「渲染坏了」，实为投影层跨会话断链；也曾经判定「输入被吞」，实为数据层完好、只渲染层没画。**任一层缺证据，不许进入下一层。**

**③「看见」有三个独立维度，必须分别验收。** 任一维都能单独出错、且都能藏在「重放正常」之下：

| 维度 | 含义 | 典型症状 | 关键判据 |
|---|---|---|---|
| 形态 | 长什么样 | 运行时是灰色过程行、重放是用户气泡 | 同一 `appendInteractiveInput` 入口，助手形态走 `append('user')` |
| 时机 | 什么时候画 | 要消费后才显示 / 关页才有 | 上屏挂在入队回执，不是队列消费 |
| 位置 | 落在哪 | 挂在回答后、不在首句气泡后 | 必须带真实 `roundId` 轮锚，禁止 `new Date()` 当 ts |

## 诊断检查表（逐条勾，缺一不收）

**投影层（最易断，优先查）**

- [ ] 入队/消费/清空每个调用点都传了本流 sid？（跨会话场景 sid ≠ current 必测）
- [ ] 投送判据用既有路由（`viewsMayShow` / `postToSession`），没另造「是不是后台流」的第二判据？
- [ ] 长度/去重缓存按 sid 分片，没用宿主单份缓存吞掉另一会话的入队快照？
- [ ] 上屏证据取的是已落盘事实（带真实 ts / roundId），不是检测时刻的 `new Date()`？

**渲染层**

- [ ] live 与 replay 共用同一上屏入口，助手形态同形？
- [ ] 有入队回执即时上屏时，队列 diff 只撤待发送条、不画第二颗（防双画）？
- [ ] 轮锚随消息透传，气泡归位到首句之后、回答之前？

**工作模式不回退**

- [ ] 新回执/新分支只在助手形态消费，侧栏过程行逐字不动？

## 机器守卫缺口（改时机 / 位置时主动补）

`runtimeReplayParity.test.ts` 当前只守**形态**（轮级 4 字段 + 交互行 tag/content），**「时机」与「位置」两维没有 parity 断言**。这意味着「即时上屏」「轮锚归位」这类修复目前靠台账真机证据兜底，未来重构可能悄悄回退。凡改这两维：

1. 主动补一条 live×replay 对拍断言（同一条补充两路同形、同位、同轮锚）；
2. 做变异验证——撤掉实现里的判据，新断言必须转红；不红 = 没咬住，不算守卫。

## 案例索引（复算走台账 ID，本 skill 不复制正文）

| 台账 ID | 命中维度 | 真机证据落点 |
|---|---|---|
| `INTERJECT-LIVE-SYNC-1` | 时机 + 位置（并含跨会话投影三层断点） | `E:/ceshi/.memora` 的 `round-1d0b9cc6`；截图 `局部截取_20261122_205638/210029/215143/215204.png` |
| `ASSISTANT-INPUT-BUBBLE-1` | 形态 | 截图 `局部截取_20261122_200902.png` |
| `ASK-ANSWER-RECEIPT-1` | 注入层（正文说已答 vs 工具回执） | `round-ba63a640` 的 `answer_session_question` 回执 |

## 反模式（禁止）

| 反模式 | 为什么错 | 正确做法 |
|---|---|---|
| 看到「重放正常」就判 live 渲染链完好 | 两路数据源不同，重放对了不证明 live 对 | 四层逐层取证 |
| 改了 UI 只看重放 / 只跑单测 | 时机与位置无 parity 守卫，绿了也会回退 | 真机 + 三维分别验收 + 补 parity 断言 |
| 上屏用 `new Date()` 当 ts、不传 roundId | 无轮锚 → 纯 appendChild 落消息尾 → 位置错 | 带真实落盘 ts / roundId |
| 入队即画一条「超前」消息 | 复活已退役的第三条呈现路径，取消排队留孤儿行 | 画同一次落盘事实，撤销时随之消失 |
| 跨会话场景只测 sid = current | 断链恰在 sid ≠ current 时暴露 | 每次补 sid ≠ current 的投影用例 |
| 新增判据不做变异验证 | 绿 ≠ 有判力 | 撤判据必须转红 |

## 本环境命令

```
# 定向（先锁相关文件）
cd /f/zooique/memora/hosts/memora-vscode
env -u NODE_OPTIONS node ../../node_modules/vitest/vitest.mjs run \
  src/webview/__tests__/runtimeReplayParity.test.ts \
  src/webview/__tests__/chatPanelInterject.test.ts \
  src/webview/__tests__/chatViewInterject.test.ts --no-file-parallelism

# 双包类型检查
env -u NODE_OPTIONS node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# 判红先隔离复跑，别把 --no-file-parallelism 写成常驻默认（见 test-red-triage）
```
