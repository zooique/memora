# 从 4.x 升级到 5.0.0

> 适用对象：直接 import `@zooique/memora` 的宿主 / 接入方。
> 本文只讲**你怎么改代码**，不讲内部决策过程；删除理由见 `CHANGELOG.md` 的 `[5.0.0]` 区，逐批拍板过程见 `tasks/待完成任务.md` 对应 ID 条目。
> 数据口径：4.0.0（npm 已发布）与 5.0.0（本仓库）的 `dist/index.d.ts` 导出面 —— 从 barrel
> 逐层解析到真实声明文件后**按 TypeScript AST 比对**（非正则、非记忆）。复现脚本见文末。

---

## 一句话

5.0.0 是 major，删了 **23 个导出符号 + 32 个公开成员 + 3 个事件**。
被删的东西分两类：

1. **从未通电**（写了但没人调用、或调用后无效果）；
2. **结构性恒空**（代码路径上永远拿不到输入，配置什么都无效）。

**没有一条是「还在正常工作、且有真实消费方，却被砍掉」**——最接近的是记忆治理门面
（`agent.governance`）：`sourceHealth()` 确实有效但零消费，另外三个方法恒空转，
详见 §3.3。

---

## 30 秒自查

回答三个问题，决定你要读哪几节：

| 你做过这些吗 | 去哪看 |
|---|---|
| `import { MemoryGovernance / ProjectRegistry / InMemoryStorage / safe* / truncate / toError ... }` | §2 符号级删除 |
| 调过 `agent.governance` / `agent.projects` / `agent.switchProject` / `agent.recover` / `agent.injectSystemMessage` / `agent.canContinueWithoutInput()` | §3 成员级删除 |
| 订阅过 `dedupCompleted` / `projectSwitched` / `goalDriftDetected` | §4 事件删除 |
| **都没有** → 直接升级，跑一次 `tsc --noEmit` 即可 | §6 核对清单 |

---

## §1 版本事实

| 项 | 4.0.0 | 5.0.0 | 差额 |
|---|---|---|---|
| 导出符号（含类型） | 156 | 136 | −23 删 / +3 新增 |
| `Agent` 公开成员 | 70 | 58 | −12 删 / 0 新增 |
| `SessionManager` 公开成员 | 50 | 36 | −14 删 / 0 新增 |
| `RolePackManager` 公开成员 | 32 | 31 | −1 删 |
| `AgentOptions` 字段 | 33 | 31 | −2 删 |
| `AgentEventMap` 事件键 | 28 | 25 | −3 删 |
| `SessionCheckpoint` 字段 | 12 | 9 | −3 删 |
| `FetchedPage` 字段 | 4 | 5 | +1 新增 |

**算术可自证**：`32 = 12（§3.1）+ 14（§3.2）+ 6（§3.4：RolePackManager 1 + AgentOptions 2 + SessionCheckpoint 3）`。

口径：只数**消费者看得见**的成员（`private` / `protected` 在 d.ts 里留存但不计入）。

SemVer 定为 major 的依据：**编译期破坏**（删导出 + 删成员 + 改签名），不是行为悄悄变了。

---

## §2 符号级删除（23 个）

### 2.1 有一对一替代（改 import 即可）

| 4.x 写法 | 5.0.0 改成 |
|---|---|
| `import { createLlmProvider } from '@zooique/memora'` | `import { createProviderFromConfig } from '@zooique/memora'`（本来就是规范入口，前者是重复包装） |
| `import { InMemoryStorage }` | 自己实现 `IMemoryStorage`（接口未变，15 方法）；或 `createNodeSqliteStorage()`（§5） |
| `import { InMemorySessionStore }` | 自己实现 `ISessionStore`（接口未变，12 方法；`setSessionTitle` 可选） |
| `import { NOOP_TRACER }` | 不传 tracer 即可（`AgentOptions.tracer` 是可选注入，内核内部有缺省实现） |

> `InMemoryStorage` / `InMemorySessionStore` 的**类本体仍在内核内部使用**，只是不再挂公共面。
> 如果你之前 `new` 它们当作「默认实现」，现在请显式实现接口——这是有意的边界收紧。
>
> ⚠️ **只读容器场景别自己复刻检索语义**：若你原来用 `InMemoryStorage` 只是「装载一份数据 + 借用
> 内核的分词/排序/软删过滤」（典型 = 只读宿主），**不要**自己写第二套 `Map + 分词 + 排序`——
> 那会和内核并列、漂移后同一份数据搜出两种结果。直接用
> `createNodeSqliteStorage(dbPath, { readOnly: true })` 拿 `ReadOnlyMemoryStorage`
> （仅 9 个读方法，写方法在类型上就不存在），见 §5。
>
> 注意：只读模式**不建库**——库文件不存在时抛 `MemoraError{ errorCode: FILE_NOT_FOUND }`（5.0.0 起）。
> 请据此提示用户「先用写宿主打开一次工作区」，**不要**自己 `existsSync` 后再猜（判据散点）。

### 2.2 内核内部工具，不再对外（能力不需要）

这 11 个是内核自己用的通用小工具，**函数本体仍在**（内核内部照常调用），只是不导出：

`truncate` / `isPlainObject` / `safeSetTimeout` / `safeSetInterval` / `clearSafeTimeout` /
`clearSafeInterval` / `segmentText` / `escapeLike` / `escapeLikeSnippet` / `serializeFrontmatter` / `toError`

改法：自己写。都是 3–10 行的东西：

```ts
// toError
const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

// truncate
const truncate = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

// isPlainObject
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;
```

`safeSetTimeout` 一族在 Node 下**不需要包装**：宿主进程生命周期由宿主自己管，
内核不再替宿主兜「定时器阻止进程退出」。

> ⚠️ `escapeLike` 的**知识**不能丢：如果你自己实现 `IMemoryStorage` 的 SQLite 后端，
> 仍须转义 `%` / `_` 并写 `LIKE ? ESCAPE '\'`。规则写进了 `IMemoryStorage` 的接口注释。

### 2.3 无替代（能力不再对外）

| 符号 | 为什么没替代 |
|---|---|
| `MemoryGovernance`（类） | 见 §3.3，整链退役 |
| `ProjectRegistry` | 跨项目注册表概念废止：一个 Agent = 一个项目，多项目由宿主各建实例 |
| `ProjectEntry`（类型） | 同上；`agent.projects.list` 的返回类型随之消失 |
| `LockManager` | 项目级 `.memora/.lock` 文件锁。**类本体仍在内核内部**（`projectManager` 写记忆库时加锁），只是不再导出——宿主本就不该直接操作锁文件，这是边界收紧而非能力丢失 |
| `safeFetch` / `safeExecuteCode` / `safeSearchProjectFiles` / `safeSearchProjectText` | 内核内部超时包装，宿主注入 provider 时由内核自己用 |

**`ProjectRegistry` 的迁移姿势**：

```ts
// 4.x：宿主自己 new 一个注册表读写 projects.json
const reg = new ProjectRegistry(dir);

// 5.0.0：不管项目名单。每个项目一个 Agent，「切项目」= 换实例
const agents = new Map<string, Agent>();
function agentFor(projectPath: string) {
  if (!agents.has(projectPath)) {
    agents.set(projectPath, new Agent({ ...opts, dataDir: join(projectPath, '.memora') }));
  }
  return agents.get(projectPath)!;
}
```

---

## §3 成员级删除（32 个）

### 3.1 `Agent`（12 个）

| 4.x | 5.0.0 改成 |
|---|---|
| `agent.canContinueWithoutInput()` | **无替代，也不需要**。软暂停模型下暂停恒安全（无在途目标时暂停即收场）、空输入续跑由 waiting 原因位表达——「可否无输入续跑」不再需要向宿主暴露查询口（5.0.0 内翻案删除，见 CHANGELOG `PUB-API-PRUNE-5`） |
| `agent.appendPlanItem(desc, pack?)` | `agent.sessionManager.appendPlanItem(desc, pack?)` |
| `agent.triggerError(cause)` | `agent.sessionManager.triggerError(cause)` |
| `agent.recover()` | `agent.sessionManager.recover()` |
| `agent.injectSystemMessage(msg)` | **无公开替代**。它原本直通 `loop.injectSystemMessage`，属内核内部机制外漏；需要引导模型请在 `chat()` 输入或角色包 rules 里写 |
| `agent.getRecentToolExecutions()` | **无替代**。订阅 `tool_start` / `tool_result` 事件自己聚合——事件流才是可观测面 |
| `agent.getBackgroundTaskStats()` | **无公开替代**。⚠️ 别拿 `listBackgroundTasks()` 顶——那个是后台**命令**（shell 进程），这里是内核后台**副作用池**（摘要生成 / 记忆命中刷新 / 会话命名）。它的 `completed`/`failed` 只写不读、`pending` 仅服务 `close()` 的收尾等待（上限 5s），在途数不再对外暴露 |
| `agent.forceReleaseChatLock()` | **无替代**。锁释放只走 `release(token)` 与 `close()`；「无进展超时兜底」从未接线 |
| `agent.governance` | **无替代**，见 §3.3 |
| `agent.projects` | **无替代**。多项目 = 宿主多实例，见 §2.3 |
| `agent.switchProject(path/name)` | **无替代**。换项目请新建 Agent 实例 |
| `agent.rebuildComponents()` | **无替代**。内部装配细节，本就不该是公开面 |

### 3.2 `SessionManager`（14 个）

| 4.x | 5.0.0 改成 |
|---|---|
| `isRunning()` | `status === 'running'` |
| `isPaused()` | `status === 'paused'` |
| `heartbeat()` | **直接删调用**。它只是私有 `touchCheckpoint` 的外漏，无观察者 |
| `loadSessionMessages(date, session)` | 由你的 `ISessionStore.loadMessages(date, session)` 直接读（**接口是同步返回**，不再有 Promise）；要「切换并加载」用 `switchToSession()` |
| `restoreSession(date, session)` | `switchToSession(sessionId)` —— ⚠️ **签名不同**：前者两个参数，后者一个 `'YYYY-MM-DD-session'` 复合 ID。改法：`switchToSession(`${date}-${session}`)` |
| `restoreMostRecentSession()` | `switchToSession(meta.sessionId)`，最近会话从你自己的 store 取：`store.listSessionMetas()[0]`（降序契约，`[0]` 即最近活跃） |
| `updateGoal(goal)` | **无替代**。目标漂移检测整链退役，目标对齐交还「用户在环 + `ask_user`」 |
| `isPauseLimitReached()` / `getConsecutivePauseCount()` / `resetConsecutivePauseCount()` | **无替代**。连续暂停计数链从未通电（生产恒传 `lowRisk=true`，数组恒空） |
| `compensateTool(id)` / `compensateAllNonIdempotent()` | **无替代**。二者只生成文案 + warn，零状态变更 |
| `flushNow()` / `flushOnShutdown()` | **直接删调用**。二者是 no-op 清脏（检查点本就不落盘），保留只为语义边界 |

> `status` 的取值是 `'running' | 'paused' | 'error'`。**`error` 没有对应布尔**——
> 这正是删 `isRunning/isPaused` 的原因：三态被两个布尔吞掉一个，判不完整。

### 3.3 唯一的能力退回：记忆治理门面

| 4.x | 5.0.0 |
|---|---|
| `agent.governance.deduplicate()` | 无（LLM 语义去重） |
| `agent.governance.detectConflicts()` | 无（冲突检测）——**冲突消解仍在**：写路径的 `supersede` + `supersededBy` 软指针 |
| `agent.governance.suggest(query)` | 无（关联推荐） |
| `agent.governance.sourceHealth()` | `agent.memory?.stats().bySource` —— ⚠️ **降级不是等价**：只剩 per-source 计数，原报告的 `daysSinceLastAccess` / `diagnosedAt` 没有替代（宿主从未消费这两个字段） |

**为什么删**：`deduplicate()` / `detectConflicts()` / `suggest()` 逐 `GOVERNANCE_SOURCES` 取样，
而该常量在「设定记忆归角色包」后就是**字面量空数组、非注入项**——代码路径上永远拿不到输入。
不是「暂时没人用」，是**没有可接线的地方**。留着只会让读者以为有这能力。

`sourceHealth()` 不受这条约束（它走 `getAllSources()`，本来有效），删它另有一条理由：
零消费，且计数口径已由 `memory.stats()` 承担——留两个「健康度」入口必然算法漂移。

**能力对比**：

| | 4.x 实际行为 | 5.0.0 |
|---|---|---|
| 写时取代 | ✅ 生效 | ✅ 生效（未动） |
| 语义去重 | ❌ 恒空转 | 无入口（也不会再被误以为有） |
| 冲突检测 | ❌ 恒返回空报告（`skippedReason` 有值、`conflictCount: 0`） | 无入口 |
| 关联推荐 | ❌ 恒返回 `[]` | 无入口 |
| 源健康度 | ✅ 生效（但宿主零消费） | `memory.stats().bySource`（仅计数） |

### 3.4 其它（6 个）

| 位置 | 删除项 | 改法 |
|---|---|---|
| `RolePackManager` | `tryBuildMeetingPlan(...)` | 用 `getActiveTeam()`（当前组）或 `getTeam(group)`（指定组）拿队伍快照，自己组 `{ description, rolePack? }[]`；内核内部的 `buildMeetingPlanSkeleton` 不对外 |
| `AgentOptions` | `fileConsistencyCheck` | 直接删该字段。它是**从未被读取**的僵尸字段（透传链路早已先删） |
| `AgentOptions` | `registryDir` | 直接删该字段。跨项目注册表废止，无消费方 |
| `SessionCheckpoint` | `mainGoal` / `currentGoal` / `goalChangeSeq` | 直接删。随目标漂移链退役 |

---

## §4 事件删除（3 个）

```ts
// 4.x —— 这三个订阅在 5.0.0 全部失效，TypeScript 会直接报「事件键不存在」
agent.on('dedupCompleted', () => {});   // 随治理门面退役
agent.on('projectSwitched', () => {});  // 随跨项目切换退役
agent.on('goalDriftDetected', () => {});// 随目标漂移链退役
```

改法：**整段订阅与配套 UI 一起删**。这三个在 4.x 里也没有真实触发路径
（`projectSwitched` 只在被删的 `switchProject` 里 emit；`dedupCompleted` 的载荷恒为零值
——`deduplicatedCount: 0` / `demotedIds: []`，因为去重链本来就扫不到候选；
`goalDriftDetected` 的检测器判据实测零区分度）。

---

## §5 新增能力（非破坏）

**新增导出符号（3 个）**：

| 符号 | 用途 |
|---|---|
| `createNodeSqliteStorage(dbPath)` | 可选 SQLite 存储实现（延迟加载 `node:sqlite`，**不用即不加载**）。装配：`new Agent({ storage: createNodeSqliteStorage('.../memories.db') })` |
| `createNodeSqliteStorage(dbPath, { readOnly: true })` | 同一符号的只读形态：返回 `ReadOnlyMemoryStorage`，写方法在类型上就不存在；**文件不存在直接抛错**，不做建库/迁移 |
| `ReadOnlyMemoryStorage`（类型） | `Pick<IMemoryStorage, 9 个只读方法>`，供 MCP 类只读宿主复用 |
| `hasActiveSuperseder()` | 悬空取代判据的唯一入口：`supersededBy` 指向的记忆若已被删/软删，旧摘要应回退为当前版本 |

> `createNodeSqliteStorage` 是**一个**符号的两种形态，上表 4 行 = 3 个符号。

**新增字段（1 处）**：`FetchedPage.fetchFailed?: true` —— 据此区分「抓取失败降级」与「成功但内容为空」。

> `Agent` 本身**没有任何新增公开成员**（70 → 58 全是删，见 §1 差额列）。

---

## §6 升级后核对清单

```bash
# 1. 编译期：这一步能抓出 90% 的破坏
npx tsc --noEmit

# 2. 运行时：确认事件订阅没有静默失效（TypeScript 已挡，但 JS 项目要自己查）
grep -rn "dedupCompleted\|projectSwitched\|goalDriftDetected" src/

# 3. 行为：跑你自己的集成测试，重点看「会话切换 / 记忆检索 / 归档」三条链
npm test
```

**JS（无类型检查）项目额外做一步**：全局搜 `agent.governance`、`agent.projects`、
`agent.switchProject`、`\.recover\(`、`\.isPaused\(`、`\.isRunning\(`——这些在 JS 里会静默变成
`undefined is not a function`。

---

## §7 已知的「不迁移」代价（诚实登记）

- **失去 deprecation 预警期**：这些符号在 4.0.0 里没有标 `@deprecated`，5.0.0 直接删。
  原因是 4.0.0 到 5.0.0 之间没有中间版本可承载预警（npm 上 4.0.0 是唯一 4.x 发布版）。
- **`agent.governance` 时代写过的代码需要重写语义**，不是改个名字：它的返回结构（`deduplicatedCount`
  / `skippedReason` / `suggestions[]`）没有对等物。
- **`ProjectRegistry` 使用者要自己接管项目名单**：内核不再提供跨项目视图（多进程并发写无锁的
  风险也一并交回宿主）。

---

## 附：本文的数据来源

```bash
# 4.0.0 真实产物（npm）
npm pack @zooique/memora@4.0.0 && tar -xzf zooique-memora-4.0.0.tgz
# 5.0.0 本地产物
npm run build
```

比对脚本（放在仓库根，`node .tmp-surface-diff.mjs <旧 dist 目录> <新 dist 目录>`）：

```js
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const MEMBER_KINDS = new Set([ts.SyntaxKind.PropertyDeclaration, ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor]);
const cache = new Map();
const parse = (f) => cache.get(f) ?? cache.set(f, ts.createSourceFile(f,
  fs.readFileSync(f, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)).get(f);

/** 导出面：d.ts barrel 顶层 `export` 声明的名字 + `export { … } from` 的具名转发 */
function exportsOf(file) {
  const out = new Set();
  for (const st of parse(file).statements) {
    const mods = st.modifiers ?? [];
    if (mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (st.name) out.add(st.name.text);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (d.name.text) out.add(d.name.text);
      }
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) out.add((el.name ?? el.propertyName).text);
    }
  }
  return out;
}

// barrel 逐层解析：符号可能在 `export { X } from './y.js'` 的深层文件里
function findDecl(name, file, seen = new Set()) {
  if (seen.has(file)) return null;
  seen.add(file);
  const sf = parse(file);
  for (const st of sf.statements) {
    if (st.name?.text === name) return st;
    if (ts.isVariableStatement(st) && st.declarationList.declarations
      .some((d) => d.name.text === name)) return st;
  }
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier) continue;
    const base = path.resolve(path.dirname(file), st.moduleSpecifier.text).replace(/\.js$/, '');
    const mod = [`${base}.d.ts`, path.join(base, 'index.d.ts')].find((p) => fs.existsSync(p));
    const hit = !st.exportClause || !ts.isNamedExports(st.exportClause) || st.exportClause.elements
      .some((el) => (el.name ?? el.propertyName).text === name);
    if (mod && hit) { const r = findDecl(name, mod, seen); if (r) return r; }
  }
  return null;
}

function members(st) {
  const out = new Set();
  if (!st) return out;
  const list = ts.isInterfaceDeclaration(st) ? st.members
    : ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type) ? st.type.members
    : ts.isClassDeclaration(st) ? st.members.filter((m) => MEMBER_KINDS.has(m.kind)
        && !(m.modifiers ?? []).some((x) => x.kind === ts.SyntaxKind.PrivateKeyword
          || x.kind === ts.SyntaxKind.ProtectedKeyword)) : [];
  for (const m of list) {
    // `#name` 是 ES private（无 private 修饰符），同样不该计入公开面
    if (m.name && !ts.isPrivateIdentifier(m.name)) out.add(m.name.getText());
  }
  return out;
}

const [oldDist, newDist] = process.argv.slice(2);
const oldEntry = path.join(oldDist, 'index.d.ts');
const newEntry = path.join(newDist, 'index.d.ts');
const ea = exportsOf(oldEntry);
const eb = exportsOf(newEntry);
console.log(`EXPORTS 4.0.0=${ea.size} 5.0.0=${eb.size}`
  + ` removed=${[...ea].filter((x) => !eb.has(x)).length}`
  + ` added=${[...eb].filter((x) => !ea.has(x)).length}`);
for (const name of ['Agent', 'SessionManager', 'RolePackManager', 'AgentOptions',
  'AgentEventMap', 'SessionCheckpoint', 'FetchedPage', 'IMemoryStorage', 'ISessionStore']) {
  const a = members(findDecl(name, oldEntry));
  const b = members(findDecl(name, newEntry));
  console.log(name, `${a.size}→${b.size}`,
    '删:', [...a].filter((x) => !b.has(x)).join(',') || '-',
    '增:', [...b].filter((x) => !a.has(x)).join(',') || '-');
}
```

口径：只数**导出面**与**消费者看得见的成员**——`private` / `protected` 在 d.ts 里留存但计入不 Breaking。

本文首次成稿时的实测输出（脚本逐行还会打印「删:/增:」名单，此处只留计数）：

```text
EXPORTS 4.0.0=156 5.0.0=136 removed=23 added=3
Agent 70→58   SessionManager 50→36   RolePackManager 32→31
AgentOptions 33→31   AgentEventMap 28→25
SessionCheckpoint 12→9   FetchedPage 4→5
IMemoryStorage 15→15   ISessionStore 12→12
```

> 时点注记：Agent 首次实测为 70→59（当时 `canContinueWithoutInput` 尚未删除）；
> `PUB-API-PRUNE-5`（2026-10-19）删除该方法后终值 70→58，已按上文「以脚本结果为准并回改本文」原则回改。

> 这组数字与 §1 表格逐格对应——§1 若与你的重跑结果不一致，**以脚本结果为准并回改本文**。
