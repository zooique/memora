---
name: "ssot-ui-matrix"
description: "单一真理源驱动三层 UI 状态矩阵收敛。当任务涉及内核 flag → 宿主镜像 → webview 按钮语义统一时触发（暂停/恢复/插话/按钮态切换）。"
---

# SSOT UI Matrix — 三层状态收敛法

> **从内核 flag 向外生长，不向内造状态。** 收敛三层（内核 / 宿主 / webview）的 UI 状态机，用单一真理源驱动全部按钮语义、图标、可用态。

## 触发场景

- 暂停/恢复（pause/resume）功能重设计
- 按钮语义统一（同一按钮在不同状态下承担不同动作）
- 跨内核→宿主→UI 的状态同步不一致
- 现有 UI 硬编码多路径写 DOM 状态（绕不开统一入口）
- 需要"零内核改动"的宿主层 UI 收敛

## 三步法

### Step 1：锁定真理源（内核层）

**先回答：这个状态的唯一决策者是谁？**

- 内核 flag（如 `loop.pauseRequested`、`sessionManager.status`）是设计原点
- 宿主层只调内核方法写 flag，**不直接写 flag**；如需提前翻 UI 视觉，用同步 post 消息通知 webview，**不自己存 flag**
- 宿主层如需镜像内核队列（如 pendingInterjections），注释明确标注"视觉镜像，非第二真理源"

反例：宿主自己维护一个 `isPaused: boolean` 与内核 status 并跑 → 双写风险。

### Step 2：宿主层做镜像，不另造状态（宿主层）

宿主层的职责：
1. **协议扩展**：`protocol.ts` 加 webview↔host 消息类型（方向明确：宿主→webview post 同步视觉）
2. **toggle 逻辑**：读内核 flag 决定 request 还是 cancel（`agent.isPausePending()` 而非硬编码）
3. **同步 post**：调完内核方法后**立即** post UI 同步消息（不等异步事件，避免乱序）
4. **镜像队列**：宿主 `_pendingQueue` 是内核 `pendingInterjections` 的提前视觉镜像，注释声明语义

宿主不存任何能从内核读到的状态字段（`_sessionStatus`、`_pauseFlag` 这种都属于禁止项）。

### Step 3：抽状态机函数做矩阵（webview 层）

webview 层的核心改造：

1. **抽 `syncButtonSemantics()` 统一入口**：把所有 DOM 状态改动（classList add/remove、hidden、textContent、aria-label）收进一个函数，**其他地方一律不直接碰按钮 DOM**
2. **矩阵参数 = 会话状态 × 输入框内容**：两个轴驱动全部 UI 决策
   ```
   thinking + 空输入 → loading 类（停止方块）
   thinking + 有输入 → 默认发送图标（interject 排队）
   paused   + 空输入 → paused 类（继续 ▶）
   paused   + 有输入 → 默认发送图标（resumeExecution 带补充）
   done     + 空输入 → 发送禁用
   done     + 有输入 → 发送启用
   ```
3. **抽 `syncSendEnabled()` 覆盖全部恒可用态**：除 loading/paused 类外，thinking+有输入 / paused+有输入 也恒可用
4. **写路径唯一**：setStatus（状态变了）+ input 事件（输入变了）+ 宿主 post（flag 变了）→ 都调 syncButtonSemantics + syncSendEnabled

### Step 4：send click handler 路由统一

send 按钮 click handler 里：
- `classList.contains('loading')` → post stop
- `classList.contains('paused')` → post resume
- **其他所有情况** → 统一调 `sendMessage()` post type='send'
- 宿主 handleSend 负责路由到 `chat()` / `interject()` / `resumeExecution()`

**不要用 title/aria-label 判断状态**——那是展示字段，不是决策字段。classList 才是状态机标记。

## 验收清单

| 检查项 | 方法 |
|---|---|
| 所有按钮 DOM 改动走统一入口 | grep pauseBtn / send.classList → 确认全部在 syncButtonSemantics |
| 无宿主自定义 flag 与内核并跑 | grep 宿主字段 → 查 `_isXxx` / `_xxxFlag` 是否有内核对应源 |
| 宿主→webview post 同步无延迟 | 调完内核方法后立即 post，不等事件回调 |
| send click 路由全覆盖 6 状态 | classList 判断 + 统一 sendMessage 兜底 |
| TypeScript 编译零错误 | `npx tsc --noEmit` |
| 内核 tsc + vitest 全绿 | `npx vitest run` |
| 零内核改动 | diff src/ 目录 |

## 反模式（禁止）

| 反模式 | 为什么错 | 正确做法 |
|---|---|---|
| 宿主维护 `isPaused` 与内核 status 双写 | 事件乱序时状态漂移 | 宿主每次用 `agent.isPausePending()` 读内核 |
| webview 用 `title === '继续生成'` 判断状态 | title 是展示字段，随时可能改 | 用 classList.contains('paused') 做决策 |
| handlePause 硬编码 `if (this._isPaused)` | 绕开内核真理源 | 读 `agent.isPausePending()` |
| 在多个函数里散改 pauseBtn.hidden | 写路径不唯一，改矩阵漏改 | 100% 收进 syncButtonSemantics |
| 宿主 `_pendingQueue` 不注释语义 | 后续维护者以为是第二真理源 | 注释"视觉镜像，内核才是真源" |
