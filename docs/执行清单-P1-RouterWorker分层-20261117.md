# P1 落地执行清单：memora宝 Router/Worker 分层

> **面向**：编程 Agent（读这份清单就能独立改代码）
> **前置**：已读 `docs/方案-memora宝设计定案-20261117.md`
> **范围**：P1 全量（含 7 条边界 B1-B7），不含 P2（Hand back）和 P3（Subscription）
> **原则**：每笔改动必须走全量单测 + `publicMemberSurfaceGuard` 冻结守卫 + 门禁

---

## 任务清单（按依赖顺序）

### T1：SessionMeta 扩 `workOrder` + `workStatus` 可选字段

| 项 | 内容 |
|---|---|
| **文件** | `src/memory/sessionStore.ts` 第 150-182 行（`declaredPaths` 之后、`pinnedItems` 之前） |
| **现状** | 已有托管相关字段：`origin`、`declaredPaths`、`activeRolePackName`，均可选、宿主写入、JSDoc 注释完整 |
| **改法** | 在 `declaredPaths` 之后插入两个新字段（同块归为"托管开活的状态追踪"） |
| **字段定义** | 见下方"新字段规格" |
| **验收** | `publicMemberSurfaceGuard.test.ts` 新增 ⑲（workOrder）+ ⑳（workStatus），守卫通过 |
| **风险** | 低——同方向第三/四个托管字段，Pattern 已跑通（⑰⑱ 先例） |

#### 新字段规格（必须照抄，不许改写）

```typescript
// ── 托管开活的状态追踪 ──
/**
 * 这条活的语义边界（Mandate）：一段话，「要解决什么问题、不解决什么问题」
 *
 * 与 declaredPaths 的边界（极易混淆，必须同时写进 JSDoc）：
 *   - declaredPaths = 技术范围（动哪些仓库相对路径）
 *   - workOrder = 语义边界（解决什么问题、不解决什么问题）
 *   两者不同维度，不可互相替代。Worker 拿到 declaredPaths=['src/agent'] 知道不能动 ui/，
 *   但不知道"能不能重构 src/agent 的结构"——这是 workOrder 回答的。
 *
 * 语义：记录不是权限。workOrder 只供 Worker 理解任务 + 未来 Hand back 做边界比对，
 *      不表达父子关系、不当门禁授权依据。
 *
 * 写入方 = 宿主 createSession 时由主控 create_session 工具的 mandate 参数一次性写入，
 *       **不从父会话继承**（分叉是另一条活，边界要重新声明）。
 * 读取方 = Worker loop（消费前检查字段存在）+ 宿主事件钩子更新 workStatus 时对比边界。
 * 缺省 undefined = 旧数据 / 用户自助开的会话（自助会话**永远不写本字段**，读侧如实降级）。
 */
workOrder?: string;

/**
 * 托管活的工作状态（枚举，不可自由字符串）
 *
 * 状态值与含义（必须按此枚举，不许发明新值）：
 *   - 'working'：活正在执行（会话创建后立即进入此态，无 queued 中间态）
 *   - 'blocked'：活被 ask_user 挂起（Worker 发出决策层提问，等待用户回答）
 *   - 'completed'：活正常完成（Worker 正常收场）
 *   - 'failed'：活异常终止（Worker error/aborted）
 *
 * 谁写、什么时候写：
 *   - 'working'  → 宿主 createSession 时**直接写入**（Worker 会话创建后马上执行，
 *                  没有"排队中"的实际语义）
 *   - 'blocked'  → 宿主收到 Worker 发射的 questionPending 事件时写入
 *   - 'completed'/ 'failed' → 宿主收到 Worker 终态通知时写入
 *
 * **Worker loop 不直接写本字段**——AgentLoop 在 src/agent/loop.ts 与 SessionMeta 零耦合
 *  （grep 确认），所有更新必须经宿主事件钩子 → 宿主调用 updateSessionMeta。
 *
 * 缺省 undefined = 旧数据 / 用户自助开的会话（自助会话**永远不写本字段**，
 *  工作台消费时判断字段存在才用，否则 fallback 到轮次状态投影）。
 */
workStatus?: 'working' | 'blocked' | 'completed' | 'failed';
```

#### 冻结守卫更新

在 `src/__tests__/publicMemberSurfaceGuard.test.ts` 的 `SessionMeta` members 列表里，在 `'declaredPaths'` 之后加 `'workOrder'` + `'workStatus'`，并在 section 注释里加两条新增说明：

```typescript
// ⑲ SessionMeta.workOrder 新增（2026-11-17 · 托管开活语义边界，非 Breaking）：
//    定性 = 真能力：记录这条活要解决什么问题、不解决什么问题，供 Worker 理解任务 +
//    未来 Hand back 做边界比对；写入方 = 宿主 createSession（主控 create_session 工具
//    的 mandate 参数），不从父会话继承；缺省 undefined = 旧数据 / 自助会话。
//
// ⑳ SessionMeta.workStatus 新增（2026-11-17 · 托管活状态追踪，非 Breaking）：
//    定性 = 真能力：枚举字符串，追踪这条活当前状态（working / blocked / completed / failed）；
//    写入方 = 宿主事件钩子（createSession 直接写 working + questionPending 写 blocked +
//    终态通知写 completed/failed），Worker loop 零直接写入；缺省 undefined = 旧数据 / 自助会话。
```

---

### T2：create_session 工具加 `mandate` 参数

| 项 | 内容 |
|---|---|
| **文件** | `hosts/memora-vscode/src/extension/host/workSessionTools.ts` 第 678-710 行 |
| **现状** | schema 四参数：`rolePack`（必填）/`title`（必填）/`text`（必填）/`paths`（必填） |
| **改法** | 加 `mandate` 可选字段，描述写"这条活的语义边界"；**不砍现有 text 参数**（text 是 Worker 第一轮具体指令，mandate 是更高层边界） |
| **验收** | `workSessionTools.test.ts` 新增用例：带 mandate 创建会话 → SessionMeta.workOrder 非空 |
| **风险** | 低——加可选字段不是 Breaking；但 description 要说明和 text 的区别（容易混淆） |

#### 参数定义（插入在 paths 之后、required 数组之前）

```typescript
mandate: {
  type: 'string',
  maxLength: 200,
  description:
    '这条活的语义边界（要解决什么问题、不解决什么问题），≤200字。' +
    '与 text 的区别：text 是交给 Worker 的第一轮具体指令（如"写一个 PermissionManager 类"），' +
    'mandate 是这条活的整体边界（如"解决用户权限校验绕过问题，不做权限系统重构"）。' +
    'Worker 会同时拿到两者，mandate 约束它的工作范围，text 给它起步方向。',
},
```

#### required 数组不变

`required: ['rolePack', 'title', 'text', 'paths']`——mandate 可选，不进 required。

#### description 更新（工具顶部的那段说明也要同步）

在"返回新会话的 sid 与 title"之前加一句：`mandate（可选）= 这条活的语义边界，用于约束 Worker 的工作范围。`

---

### T3：宿主 createHostedSession 时同批写入 `workOrder` + `workStatus='working'`

| 项 | 内容 |
|---|---|
| **文件** | `hosts/memora-vscode/src/webview/helpers/hostedSessionCreate.ts` 第 75 行 `createHostedSessionWith` 函数 |
| **现状** | 调用 `ISessionStore.createSession(meta)` 时传 title + paths + origin + agentCreated，**没有 workOrder/workStatus** |
| **改法** | 函数签名加可选 `mandate?: string` 形参；`createSession` 调用时同批写入：`workOrder: mandate` + `workStatus: 'working'`（仅当 mandate 存在时写 workOrder；workStatus 永远写） |
| **验收** | ① `chatPanelSessionAgents.test.ts` 新增断言：hosted 会话创建后 workStatus === 'working'；② 用户自助开的会话 workStatus === undefined |
| **风险** | 低——同批写入，不破坏现有流程；调用方传 mandate 是主控 create_session 工具的事，不会有"自助会话误写"的问题（自助会话走自己的 createSession 链路，不经过 createHostedSessionWith） |

#### 函数签名变更示意

```typescript
export async function createHostedSessionWith(
  deps: { /* 现有 deps */ },
  input: {
    sessionTitle: string;
    senderName: string;
    text: string;
    declaredPaths: readonly string[];
    mandate?: string; // ← 新增
  },
): Promise<CreateSessionResult> {
  // ... 现有逻辑 ...
  const meta: SessionMeta = {
    // ... 现有字段 ...
    declaredPaths: paths,
    agentCreated: true,
    // ↓ 新增两字段，同批写入
    workOrder: input.mandate,              // mandate 存在时写，undefined 自动不写
    workStatus: 'working',                 // 永远写，Worker 会话创建后立即执行
  };
  // ... 继续 createSession 调用 ...
}
```

---

### T4：宿主事件钩子消费 → workStatus 更新

| 项 | 内容 |
|---|---|
| **文件** | `hosts/memora-vscode/src/extension/host/assemble.ts`（现有宿主装配层，`registerWorkerCallbacks` 或同位置加回调） |
| **现状** | ① `questionPending` 钩子已存在（`src/agent/assembler.ts` 主动提问检出时发射），宿主**只用来渲染提问 UI**，不更新 SessionMeta；② 托管终态通知已落地（`.trae/documents/托管会话中断通知-20261114.md`），宿主**只通知主控**，不更新 SessionMeta |
| **改法** | 给现有两个钩子**各加一行** `sessionStore.updateSessionMeta(sid, { workStatus: 'blocked' | 'completed' | 'failed' })` |
| **验收** | ① Worker 发出 ask_user → 宿主 updateSessionMeta workStatus='blocked'；② Worker done → workStatus='completed'；③ Worker aborted → workStatus='failed'；④ 自助会话的 questionPending/终态事件**不写 workStatus**（加判定：只对 origin='hosted' 的会话写） |
| **风险** | 中——要在正确的宿主侧位置加回调，不能误写到内核；判定逻辑"只对 hosted 会话写"必须有（否则自助会话也会被写）；先在 assemble.ts 里 grep 现有 questionPending 和终态通知的处理位置，再加 |

#### 判定逻辑（伪代码）

```typescript
// questionPending 处理（找到现有渲染提问 UI 的位置，加一段）
host.on('questionPending', (sid, question) => {
  // 现有：渲染提问 UI ...
  // ↓ 新增
  const meta = sessionStore.getSessionMeta(sid);
  if (meta?.origin === 'hosted') {
    sessionStore.updateSessionMeta(sid, { workStatus: 'blocked' });
  }
});

// 终态通知处理（找到现有通知主控的位置，加一段）
host.on('workerTerminated', ({ sid, reason }) => {
  // 现有：通知主控 ...
  // ↓ 新增
  const meta = sessionStore.getSessionMeta(sid);
  if (meta?.origin === 'hosted') {
    const newStatus = reason === 'done' ? 'completed' : 'failed';
    sessionStore.updateSessionMeta(sid, { workStatus: newStatus });
  }
});
```

---

### T5：工作台状态投影 → 优先读 `workStatus`

| 项 | 内容 |
|---|---|
| **文件** | `hosts/memora-vscode/src/shared/sessionStatus.ts` 或工作台状态投影层（grep 找 `projectSessionStatus` 函数） |
| **现状** | 工作台状态"从既有事实推"——读会话最近一轮的 RoundStatus（done/pending/error） |
| **改法** | 加一层分支：如果 SessionMeta.workStatus 存在且非空 → **直接用它**；否则 fallback 到既有逻辑 |
| **验收** | 工作台快照（workbench_snapshot 协议）里的 hosted 会话状态优先反映 workStatus 字段值；自助会话的状态投影和之前完全一致 |
| **风险** | 低——加分支，不改现有逻辑；fallback 保障自助会话零改动 |

#### 伪代码

```typescript
export function projectSessionStatus(meta: SessionMeta | undefined, ...rounds): RoundStatus {
  // ↓ 新增分支（优先读 workStatus，且只对 hosted 会话）
  if (meta?.origin === 'hosted' && meta.workStatus) {
    return mapWorkStatusToRoundStatus(meta.workStatus);
  }
  // ↓ 既有逻辑（不变）
  return ...fromLastRound(rounds);
}

function mapWorkStatusToRoundStatus(workStatus: NonNullable<SessionMeta['workStatus']>): RoundStatus {
  switch (workStatus) {
    case 'working':   return 'pending';   // Worker 在跑
    case 'blocked':   return 'pending';   // 等用户回答
    case 'completed': return 'done';
    case 'failed':    return 'error';
  }
}
```

---

### T6：守卫测试（1 个新文件 + 2 个现有文件加断言）

#### T6a：`publicMemberSurfaceGuard.test.ts` 加 ⑲⑳ 说明（随 T1 一起做）

在 SessionMeta members 列表里加 `'workOrder'` + `'workStatus'`，并在 section 注释里加两条新增说明（内容见 T1 上面的"冻结守卫更新"段）。

#### T6b：`chatPanelSessionAgents.test.ts` 加两个断言

在现有 `代理能开会话 · createHostedSession` 测试块里加断言：

```typescript
// 断言：hosted 会话创建后 workStatus === 'working'（身份时序边界 B1）
expect(meta?.workStatus).toBe('working');
// 断言：workOrder === 传入的 mandate
expect(meta?.workOrder).toBe('这条活的语义边界...');
```

在用户自助开的会话测试块里加断言：

```typescript
// 断言：用户自助会话 workStatus === undefined（自助零改动边界 B7）
expect(meta?.workStatus).toBeUndefined();
```

---

### T7：完整单测 + 门禁

| 项 | 内容 |
|---|---|
| **命令** | `npm.cmd test -- host -- full`（宿主全量单测，不能只跑受影响文件） + `npm.cmd run gate-fast`（快速门禁） |
| **验收** | ① 全部单测绿；② `docs:links` 检查通过；③ `publicMemberSurfaceGuard` 守卫通过；④ 协议守卫不超阈值 |
| **风险** | 低——T1-T6 全部加的是可选字段，理论上零 Breaking；如果协议守卫超阈值，需要检查是哪条协议被我加了字段 |

---

## 不在本清单（文档类，需单独处理）

按定案文档 §六 订正清单（R1/R2/R3/R4/R5）更新的设计文档，**不在本技术清单内**，落盘在 `docs/` 目录。本文是纯技术执行清单，只管代码。

---

## 三原则快速校验（每笔改动前扫一眼）

| 原则 | 校验问题 | 过才动手 |
|---|---|---|
| **SSOT** | 这是不是在既有真源（SessionMeta / ISessionStore / customTools）上长的？有没有造平行实体？ | ✅ 是，SessionMeta 扩字段、workSessionTools 加参数，都是既有真源上长 |
| **自然生长** | Worker loop 有没有直接写 SessionMeta？入口层（create_session 工具 schema）有没有写技术方向参数位？ | ✅ Worker loop 零直接写入（宿主事件钩子写），入口层 schema 只加 mandate（语义边界）不加技术方向 |
| **不带伤** | 自助会话的代码路径有没有被改？ | ✅ T4/T5 都有 `origin === 'hosted'` 判定守卫，自助会话零影响 |
