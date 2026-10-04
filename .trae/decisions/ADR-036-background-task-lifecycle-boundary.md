---
alwaysApply: false
description: 后台命令任务双生命周期边界定案——turn 终态脱管不杀（回流跨 turn 留存）、Agent 实例终态真杀（close 收割 + exit 钩子同步兜底双通路）、主动终止单点不回调 listener、诚实边界覆盖正常退出（崩溃/强杀除外）
---

# ADR-036 · 后台命令任务的双生命周期边界与回流留存

> **状态**：✅ 已接受
> **日期**：2026-10-04 真机定类 + 落地，同日定案补录（S2 固化触发 1：src 生产引用 ≥1）；同日第二轮复测实锤 31ms 关窗窗口后补 exit 钩子第二触发通路（见决策 1 注）
> **过程稿**：`docs/方案-后台任务跨轮存活-20261004.md`（对标实锤 / SSOT 论证 / 刻意不做清单 / §4.2 第二触发通路论证，「怎么变过来的」归该稿）；`docs/方案-命令执行能力-run_command-20260922.md` §14.5（旧「turn 终态收割」语义的修订记录）
> **背景**：0922 的「turn 终态收割 + 回流不跨 turn」在真机被证伪（90 秒 ping 在 turn 6.3 秒结束时被杀，用户从未操作）；修订为脱管后，观察点 ⑧ 真机定类又实锤「宿主退出无收割 = OS 层孤儿」（ping.exe 存活而父进程已亡，Windows / Job Object 均不兜底）——两个生命周期终点缺一不可

## 决策

1. **两个生命周期终点分开，禁折叠为一个机制**：
   - **turn 终态 = `detachAll` 脱管不杀**：进程跨轮存活、输出继续捕获；turn 是问答归档单元，不是进程容器。
   - **Agent 实例终态 = 真杀，且有两个触发通路**：注册表按实例隔离是硬不变量——实例销毁后任务不可寻址（`kill_command` 找不到、UI 快照空表），不杀即无人可收的 OS 孤儿。通路一 = `Agent.close` 内 `shutdown()`（收割 + 注销钩子，loop 置 null 之前）；通路二 = 注册表构造时注册的 **`process.on('exit')` 同步兜底钩子**——第二轮复测实锤 Windows 正常关窗只给扩展宿主 **31ms** 清理窗口，async close() 深处的收割跑不到，须在钩子里用同步杀树原语（`execFileSync` taskkill）在进程消失前落地。两通路共用 terminate 单点，非两套机制。
2. **回流（command-result）与插话同性质 ⇒ 同标准**：跨 turn 留存，下个 turn 的 step 边界照常吸收；`MAX_PENDING_COMMAND_RESULTS=3` 只限每步注入条数（防灌爆上下文），不限队列总量（队列与注册表终态条目均无 GC，是已登记缺口，触发再立项）。
3. **主动终止单点 `terminate`（kill / killAllRunning / exit 兜底共用，mode 档位必传：异步=运行时收割、同步=exit 兜底），刻意不回调 completion listener**：主动终止的输出已由调用方直接取得，再回流 = 同一份结果双份消费。`backgroundTaskSettled` 事件因此只承载自然终态（completed / timedOut，类型即契约）。
4. **诚实边界（模型可见文案三处统一）**：退出杀树覆盖扩展正常停用——close 赶得上走通路一、赶不上由 exit 钩子通路二兜底（31ms 窗口实证第二通路的必要性）；扩展崩溃 / 被 OS 强杀 / 断电时两通路都来不及执行，**不承诺清理**。工具描述 / `BACKGROUND_STARTED` 回执 / turn 收尾报告统一为「正常退出 VS Code 时终止；崩溃 / 被强杀不保证」。缺省 `timeoutMs=null` = 永不超时，`BACKGROUND_MAX_TIMEOUT_MS` 仅钳制显式传值。

## 理由

- 真机定类（观察点 ⑧ 第一轮）：完全退出 VS Code 后 `ping.exe` 存活、父进程（扩展宿主）已亡 ⇒ 实例终态必须显式杀树，OS / Job Object 兜底在此环境不成立。
- 真机定类（观察点 ⑧ 第二轮，同日）：新 dist 重测——terminate 到宿主进程消失仅 **31ms**，Memora 日志零收割痕迹，ping 成孤儿跑至自然结束 ⇒ 仅靠 deactivate → close 一条通路 = 承诺落空，exit 钩子同步兜底是必要的而非冗余。
- 真机证伪「turn 终态收割」：用户起 90 秒 ping、turn 6.3 秒结束进程即被杀，UI 显示「已终止」而用户从未操作——「后台」名不副实。
- 回流与插话是同一现象（外部产生的事实 + 显式一条消息），只封杀回流、放行插话 = 同一现象两套生命周期，违反 SSOT。
- 不可逆性：模型可见契约（三处文案）+ UI 跨轮任务条 + 回流留存语义已按 3.1.0（Unreleased）口径定形，反转即破契约。

## 引用方

- `src/agent/backgroundTasks.ts`：`shutdown`（收割+注销钩子）/ `killAllRunning` / `terminate`（mode 档位）/ `exitHook` / `detachAll` / `SettledBackgroundTask`（自然终态窄类型）
- `src/agent/loop.ts`：`shutdownBackgroundTasks`（透传 shutdown）/ `finalizeBackgroundTasksOnTurnEnd`（脱管报告）/ `_consumeCommandResults`（回流限量注入）
- `src/agent/agent.ts`：`close` 收割接线（loop 置 null 之前）
- `src/skill/skillScriptRunner.ts`：`killProcessTreeSync`（exit 兜底同步原语，与异步 `killProcessTree` 共享 taskkill 参数构造）
- `src/utils/eventEmitter.ts`：`backgroundTaskSettled` 仅自然终态
- `hosts/memora-vscode/src/extension/extension.ts`：`deactivate → await close`（零行为改动）

## 何时回顾

- 修复后真机复测**再**不通过时（验收教程 §五之四）。复测记录：第二轮实锤 31ms 窗口缺口 →
  exit 钩子兜底落地 → 第三轮（2026-10-04 16:58）**通过**（26ms 窗口零 ping 残留；杀树日志未及
  flush 落盘，通路归因存灰区但结果层锚达成，收据见 CHANGELOG）。
- 出现「宿主崩溃后孤儿进程」真实反馈、需要 OS 级兜底（Job Object）时——exit 钩子覆盖不到崩溃路径，那是梯度 B 的触发条件。
