# loop 运行时护栏 SSOT 收敛 + 衔接提示词统一真理源

> **坐标**：正文行号为**历史记录的时点快照**，代码演进后不再核对——定位请按符号名检索，勿依赖行号。
>
> **术语退役注记（2026-09-25）**：本文写于护栏收敛期，文中 `life: 'perStep'` 是**当时的命名**——该档语义实为「按 turn（问答闭环）累计」，归零点在 `resetTurnState`（名字说 step、语义是 turn，与「step 被复用于任务表」方向相反的同族撞车），现已正名 **`perTurn`**（见术语锚点 §6）。读本文时 `perStep` 一律按 `perTurn` 理解；`perInput` 命名未变、语义未变。

## Context（为什么做）

最新实测（round-1789539624589）再次暴露 loop 运行时问题，而用户在上一轮就点破本质：**loop「改来改去一直有问题」**。三路排查证实根因不是单个 bug，而是 **loop.ts 散落 12+ 种运行时护栏机制，全为内联 if 分支 + 独立字段 + 参差生命周期 + 阈值散布（3/5/50…）**——每加一种护栏就要改主循环、加字段、加 reset、加阈值，永远打补丁。本会话已修的 write_file 硬拦（`WRITE_LOOP_THRESHOLD=5`）正是第 N 个 patch。

用户拍板：**收敛护栏为统一抽象，但不全量重写 loop 主循环**（`loop.test.ts` 约 150 个契约测试是红线）；**护栏提示词统一真理源**（把散落文案收敛，统一注入 systemPrompt）。

目标：SSOT + 自然生长出一个不带伤的护栏子系统——**新增一种护栏只需"注册一个 guard"，不再动主循环**。

## 一、模块边界判断（收敛哪类，不硬吞哪类）

**收敛：前置拦截型护栏（同构）。** 判据——在 `executeToolCalls`（loop.ts L1535-1678）内，每个都以「单工具 `if`→算计数→`blockedFlags.push(true)`+`toolPromises.push(文案)`+`continue`」收尾，产出同一形态（blocked tool_result）。同构四段：

| 护栏 | 现 file:line | prompt tag | 生命周期 |
| --- | --- | --- | --- |
| web_search 硬上限 | L1537-1567 | `[SEARCH_LIMIT_REACHED]` | perStep |
| ask_user 超 askLimit | L1569-1580 | `[ASK_LIMIT]` | **perInput**（按输入累计） |
| write_file 同路径连写 | L1581-1612 | `[WRITE_LOOP_STOP]` | perStep |
| read 系防重 + 失败硬闸 | L1613-1678 | `[ALREADY_READ]`/`[READ_FAILED_LIMIT]` | perStep + 台账替身 |

**不收敛（异构，维持各自为政）——形态/作用层不在同一切口，硬吞会削足适履引入新伤：**
- `duplicateToolCallInterceptor`（软警告，`handleIteration` L1252-1290，作用于整体工具集非单工具）
- `maxIterations/stepBudget`（循环终止）、`tokenBudget`（终止）、`self_review`（后处理）
- `interruptQueue`/pause/ask/续跑（已在 docs/architecture/pause-ask-resume-design.md 定稿，**不动**）
- search 收敛软提示、`fileExposure` 台账、`ledgerStubEchoCount` 指标

**近同构特例：web_search 带副钩**（命中后 `searchDisabled=true`→`rebuildSystemMessage` 剔除描述，L1547-1558）。它注册为 guard 但挂可选 `afterBlock` 副钩；**不**纯化为无副作用的拦截。

## 二、GuardRail 抽象设计

新文件 `src/agent/guardRail.ts`（camelCase、零运行时依赖）。收敛载体单一职责，符合"新增模块是必要才加"。

```ts
// 护栏上下文：单工具 + 本 turn 运行态
interface GuardContext {
  toolCall: { name: string; arguments: string; id: string };
  toolResultCache: ToolResultCache;
  fileExposure: ReadFileExposureLedger;
}

interface GuardRailDef {
  id: GuardRailId;
  matches: (c: GuardContext) => boolean;              // 适用工具判定
  shouldBlock: (c: GuardContext) => boolean;          // 前置 predicate：true=需拦截
  blocked: boolean;                                    // true=真拦截 / false=软提示
  promptId: GuardRailPromptId;                         // 命中文案 key（SSOT 引用，勿内联）
  promptArgs?: (c: GuardContext) => Record<string, unknown>; // 模板插值（路径/次数/阈值）
  life: 'perInput' | 'perStep';                        // 生命周期
  afterBlock?: (c: GuardContext) => void;              // 仅 search：置 searchDisabled + rebuild（幂等）
  onExec?: (c: GuardContext) => void;                  // 写侧钩子：结果处理阶段喂计数
}

// 阈值真源（S6 审查后炼化定案 2026-09-16）：静态表只承载纯静态护栏，剔除死值/僵尸键
const GUARD_THRESHOLDS = { writeLoop: 5, readFailed: 3 } as const;
// 动态真源（不入静态表，调用方运行时组装 ctx.thresholds 时注入，避免"静态默认"与"运行时覆盖"双轨矛盾）：
//   askLimit     = role-pack strategy.askLimit（默认 10，按角色包可配置）
//   maxWebSearch = LOOP_CONSTANTS.MAX_WEB_SEARCH_CALLS（=6）
// 注：初版曾把 duplicateToolCall/askLimit:20/maxWebSearch:8 塞进静态表（duplicateToolCall 无 guard 消费、
// askLimit/maxWebSearch 运行时恒被覆盖 → 均为死值），且 readFailed 误复用 duplicateToolCallThreshold
// （隐藏耦合、S6 本意颠倒）。已经同日审查修正：readFailed 独立真源化、死键清除（见 tasks/archive/completed-history.md §五）。
```

- **统一判定入口**：插进 `executeToolCalls` per-tool 循环、`toolPromises.push`（L1680）之前一个点，有序遍历注册表首个 `matches && shouldBlock`。
- **生命周期**：`perStep` → `resetTurnState`（L729）清；`perInput` → 仅 `resetAskBudget`（L768，processUserInput 入口）清。**必须保留 askCountThisTurn 跨续跑累计语义，不得并入 perStep 清空。**
- **写侧喂计数**：`_processToolResults`（L1754-1780）调各 guard `onExec`（失败+1/成功清0/连写递增），计数状态**内聚到 guard 自身**，从 loop.ts 删除单点字段 `lastWritePath`/`samePathWriteStreak`/`infoToolFailureBySubject`。
- 注册表显式排序：`read_failed` 先于 `read_dedup`（保持现 L1626 前置于 L1641 语义）。

## 三、护栏提示词统一真理源（衔接提示词）

同一文件 `GUARD_RAIL_PROMPTS: Readonly<Record<GuardRailPromptId, string>>`，模板带 `{n}/{subject}/{limit}` 占位，命中时 `renderPrompt(promptId, promptArgs)` 产出；**格式统一 `[TAG] 已…/请…`，消除每个护栏自写一段、格式不一**。

> ⚠️**【已回退，保留为宿主可选】`buildPromptSection`**：曾计划把「## 行为护栏」通用声明节注入 systemPrompt，实测撞两问题（① 内含 `[TAG]` 令牌字面量会干扰测试 `messages.find(includes('[X]'))` 对运行时拒绝消息的定位；② 注入节超极小 `maxContextTokens` 预算破坏截断计数标定）。处置：`GUIDELINES` 改为纯描述性（去令牌），`buildPromptSection()` 保留为宿主可选能力，不走内核默认装配路径（对齐 loop-design.md §八、tasks §四）。

`buildSystemPrompt`（L1956 工具描述节之后）追加统一 **「## 行为护栏」** 节：遍历注册表，对常驻护栏注入**通用性约束声明**（不暴露逐轮内部计数），示例文案：

```
## 行为护栏
- 重复读取同一文件/搜索同一主体将被拦截并提示（[ALREADY_READ]）。
- 同一文件被反复重写会触发写作死循环保护（[WRITE_LOOP_STOP]）；请先 read_file/list_dir 确认真实状态再落笔。
- 每个问答闭环仅允许有限次提问（[ASK_LIMIT]）；联网搜索达上限后视为信息已足（[SEARCH_LIMIT_REACHED]）。
- 命中任一护栏时，工具会返回一条带 [TAG] 的拒绝消息：据此调整策略继续，不要反复重试已被拦截的同一调用。
```

> 运行时命中文案**不强塞 systemPrompt**（避免逐轮膨胀）——systemPrompt 只放通用声明，逐条命中文案由 guard 命中时引用 `GUARD_RAIL_PROMPTS` 常量即时渲染。两者同源，SSOT。

## 四、渐进式落地（每步独立全绿，可中途叫停）

- **S1 骨架 + 空跑**：建 `guardRail.ts`（类型 + 注册表容器 + evaluate/onExec + PROMPTS/THRESHOLDS + buildPromptSection）。`guardier` 先 shadow evaluate（只日志不改变行为），跑 loop.test.ts 全绿 → 证明注册顺序可 reproduces 现有判定。
- **S2 迁 read 两闸**（READ_FAILED_LIMIT + ALREADY_READ）：判定移入 guard，文案改引 SSOT 模板；删 loop 字段。测试：去重 / READ_FAILED_LIMIT / CTX-1 三态。
- **S3 迁 write_loop**：`onExec` 承载连写递增。测试：WRITE_LOOP_STOP 残留不跨轮 + 换路径重置 + 第5次硬拦。
- **S4 迁 ask_limit**：`life:'perInput'`，验证暂停-续跑跨续跑累计。测试红线：askLimit 回归。
- **S5 迁 search 硬上限含副钩**：guard + `afterBlock`，验证 rebuild 幂等。测试：MAX_WEB_SEARCH_CALLS 停搜。
- **S6 收尾**：`duplicateToolCallThreshold` 改引 `GUARD_THRESHOLDS`；删 `WRITE_LOOP_THRESHOLD` 等散常；全量 loop.test.ts（~150）+ 更新 `docs/architecture/loop-design.md`（护栏子系统章节）+ `tasks/archive/completed-history.md`。

## 五、不带伤自检清单（红线测试）

| 红线 | 守住方式 |
| --- | --- |
| ≥150 契约测试全绿 | 每步独立跑 loop.test.ts；S1空跑先保兼容 |
| `askCountThisTurn` 按输入累计、续跑不 reset | `life:'perInput'` 与 resetAskBudget 分开；测试查续跑行为 |
| 拦截顺序（read_failed 先于 read_dedup） | 注册表显式排序 |
| 结果仍在上下文才拦（CTX-1 防死锁） | `shouldBlock` 保留 `isCachedResultStillInContext` 逻辑 |
| 拦截不污染 metrics（blocked≠失败） | 沿用 blockedFlags，不碰 L1699-1700 ok 判定 |
| 副钩幂等（search rebuild 仅一次） | `if(!this.searchDisabled)` 保留在 afterBlock |

**达成目标验证**：新增一种护栏 = 注册一个 guard（matches/shouldBlock/文案/阈值/life）+ 写侧 onExec，主循环零改动。

## 六、交付物与验证

**改动文件**：新增 `src/agent/guardRail.ts`；改 `src/agent/loop.ts`（评估入口 + 迁移 + 删字段 + buildSystemPrompt 加节）；补 `src/agent/__tests__/guardRail.test.ts`（注册表/生命周期/提示词渲染）+ 维护 loop.test.ts 现有用例；更新 `docs/architecture/loop-design.md`、`tasks/archive/completed-history.md`。

**验证**：每步 S1→S6 `npx tsc --noEmit` 零错误 + `npx vitest run loop.test.ts guardRail.test.ts sessionManager.test.ts` 全绿；S6 后 `git diff` 核对被删字段无残留引用。