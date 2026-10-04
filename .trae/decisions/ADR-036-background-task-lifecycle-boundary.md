---
alwaysApply: false
description: 后台命令任务双生命周期边界定案——turn 终态脱管不杀（回流跨 turn 留存）、Agent 实例终态真杀（killAllRunning）、主动终止单点不回调 listener、诚实边界只覆盖正常退出
---

# ADR-036 · 后台命令任务的双生命周期边界与回流留存

> **状态**：✅ 已接受
> **日期**：2026-10-04 真机定类 + 落地，同日定案补录（S2 固化触发 1：src 生产引用 ≥1）
> **过程稿**：`docs/方案-后台任务跨轮存活-20261004.md`（对标实锤 / SSOT 论证 / 刻意不做清单，「怎么变过来的」归该稿）；`docs/方案-命令执行能力-run_command-20260922.md` §14.5（旧「turn 终态收割」语义的修订记录）
> **背景**：0922 的「turn 终态收割 + 回流不跨 turn」在真机被证伪（90 秒 ping 在 turn 6.3 秒结束时被杀，用户从未操作）；修订为脱管后，观察点 ⑧ 真机定类又实锤「宿主退出无收割 = OS 层孤儿」（ping.exe 存活而父进程已亡，Windows / Job Object 均不兜底）——两个生命周期终点缺一不可

## 决策

1. **两个生命周期终点分开，禁折叠为一个机制**：
   - **turn 终态 = `detachAll` 脱管不杀**：进程跨轮存活、输出继续捕获；turn 是问答归档单元，不是进程容器。
   - **Agent 实例终态（close / deactivate）= `killAllRunning` 真杀**：注册表按实例隔离是硬不变量——实例销毁后任务不可寻址（`kill_command` 找不到、UI 快照空表），不杀即无人可收的 OS 孤儿。接线在 `Agent.close` 内、loop 置 null 之前。
2. **回流（command-result）与插话同性质 ⇒ 同标准**：跨 turn 留存，下个 turn 的 step 边界照常吸收；`MAX_PENDING_COMMAND_RESULTS=3` 只限每步注入条数（防灌爆上下文），不限队列总量（队列与注册表终态条目均无 GC，是已登记缺口，触发再立项）。
3. **主动终止单点 `terminate`（kill 与 killAllRunning 共用），刻意不回调 completion listener**：主动终止的输出已由调用方直接取得，再回流 = 同一份结果双份消费。`backgroundTaskSettled` 事件因此只承载自然终态（completed / timedOut，类型即契约）。
4. **诚实边界（模型可见文案三处统一）**：退出杀树仅覆盖扩展正常停用（close 来得及执行）；扩展崩溃 / 被 OS 强杀不承诺清理。工具描述 / `BACKGROUND_STARTED` 回执 / turn 收尾报告统一为「正常退出 VS Code 时终止；崩溃 / 被强杀不保证」。缺省 `timeoutMs=null` = 永不超时，`BACKGROUND_MAX_TIMEOUT_MS` 仅钳制显式传值。

## 理由

- 真机定类（观察点 ⑧）：完全退出 VS Code 后 `ping.exe` 存活、父进程（扩展宿主）已亡 ⇒ 实例终态必须显式杀树，OS / Job Object 兜底在此环境不成立。
- 真机证伪「turn 终态收割」：用户起 90 秒 ping、turn 6.3 秒结束进程即被杀，UI 显示「已终止」而用户从未操作——「后台」名不副实。
- 回流与插话是同一现象（外部产生的事实 + 显式一条消息），只封杀回流、放行插话 = 同一现象两套生命周期，违反 SSOT。
- 不可逆性：模型可见契约（三处文案）+ UI 跨轮任务条 + 回流留存语义已按 3.1.0（Unreleased）口径定形，反转即破契约。

## 引用方

- `src/agent/backgroundTasks.ts`：`killAllRunning` / `terminate` / `detachAll` / `SettledBackgroundTask`（自然终态窄类型）
- `src/agent/loop.ts`：`shutdownBackgroundTasks`（透传）/ `finalizeBackgroundTasksOnTurnEnd`（脱管报告）/ `_consumeCommandResults`（回流限量注入）
- `src/agent/agent.ts`：`close` 收割接线（loop 置 null 之前）
- `src/utils/eventEmitter.ts`：`backgroundTaskSettled` 仅自然终态
- `hosts/memora-vscode/src/extension/extension.ts`：`deactivate → await close`（零行为改动）

## 何时回顾

- 修复后真机复测不通过时（验收教程 §五之四：重建 dist → 后台 ping → 完全退出 → 进程应消失）。
- 出现「宿主崩溃后孤儿进程」真实反馈、需要 OS 级兜底（Job Object）时。
