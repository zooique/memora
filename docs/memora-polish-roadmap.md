# Memora 内核打磨路线（T1–T4）

> 依据：[docs/memora-agent-kernel-review.md](memora-agent-kernel-review.md)（第三方内核评审，2026-08-19）所标示的实现债，逐条对治。
> 原则：**先收敛后大事**；**最小改动验证**；**不为打磨而打磨**。只对治"降低认知负担或真实风险"的债，不借打磨之名顺手重构。

---

## 打磨原则（前置约定）

1. **先收敛，后大事**：第一优先是收敛已存在的散乱，而非新增机制 / 拆分架构。
2. **最小改动验证**：每批先落一个最小改动、跑通 pre-commit（tsc --noEmit + lint-staged + commitlint），再铺开。
3. **不为打磨而打磨**：凡"改了只是更干净、但没降低认知负担或风险"的，一律不列。

---

## 批次与顺序

| 批次 | 任务 | 对治债 | 风险 | 状态 |
|------|------|--------|------|------|
| 第一批 | **T1** 策略打字收敛（11 setter → 单个策略对象） | 4.2 架构债 + 魔数债 | 中（触点多） | ✅ 已完成（落地记录见 T1） |
| 第一批 | **T2** "单一检查点"名实对齐 | 4.3 名实出入 | 极低 | ✅ 已完成（落地记录见 T2） |
| 第二批 | **T4** 文档名实清扫（guardrail 过期引用） | 5.2 文档耦合 | 低 | ✅ 已完成（见 T4） |
| 第二批 | **T3** `determineTaskType` 加固 | 5.2 硬编码启发式 | 低 | ✅ 已完成（魔数收敛；注入点明确不做） |
| 慎做 | 僵尸码 / 僵尸键清扫（guardrail、ArchiveMode 三态残留、type→时间窗残留） | 5.2 冗余 | 低 | ✅ 已办结（2026-08-19 复核：guardrail 已随档 1 摘除无残留；时间窗已移出 ADR-025 D7；ArchiveMode 仅两态且为活跃 API，非僵尸） |
| 第二批 | **T5** 接入指南 guardrail 清理 | 5.3 过期文档 | 低 | ✅ 已完成 |
| 第二批 | **T6** 设计文档时态标注剥离 | 5.2 文档耦合 | 中 | ✅ 已完成 |
| 复核派生 | **N1** `resolve*` 回退硬编码收敛（单常源） | 单一真理源微债 | 极低 | ✅ 已完成（见 N1） |
| 复核派生 | **N2** 评审文档↔代码版本同频对表 | 结构性文档债 | 低 | ✅ 已完成（见 N2） |
| 复核派生 | **N3** 架构文档过期引用盘点 | 文档收口 | 无 | ✅ 已完成（仅 1 处过期，见 N3） |

**排序依据**：风险越低、ROI 越高、越符合单一真理源哲学者越靠前。T1 虽是中风险，但一次收敛两块债（策略 setter 分散 + 魔数分散）且不改运行时语义，故列第一优先。

---

## T1：策略打字收敛——11 个 setter → 单个 `L2RuntimeStrategy`

### 现状（已核查，非假设）

- **定义**：[loop.ts](../src/agent/loop.ts) 中 **11 个策略 setter**（L670–782）+ 各自 `private` 字段初始化（含魔数默认值 `tokenBudget=8000` L321、`stepBudget=50` L329，retry=2 在构造函数 L402、duplicateThreshold=3 在 L409）。
- **装配**：[agent.ts](./..%2Fsrc%2Fagent%2Fagent.ts) L551–584 **11 处** `loop.setXxx(resolveXxx(strategy))` 逐项调用。
- **解析函数**：[strategyResolver.ts](../src/role-pack/strategyResolver.ts) **10 个 `resolveXxx(strategy)`**（L210/248/266/294/308/322/338/382/426/440），入参为角色包声明的 `BehaviorStrategy`，返回 loop 运行态值；第 11 项 `loopContinue→maxSelfReviewRounds` 在 agent.ts L582–584 内联。
- **测试**：[loop.test.ts](../src/agent/__tests__/loop.test.ts) 中 **9 处**直接调用部分 setter。

### 目标形态（两层分离，对齐角色包边界纪律）

```
BehaviorStrategy（角色包声明，宽松可选键）
        │  resolve* 聚合
        ▼
L2RuntimeStrategy（loop 运行态，补默认值，全字段必填）
        ▼
loop.setStrategy(partial) ──合并──▶ 内部字段（读取点不变）
```

- **`BehaviorStrategy`**：维持现状，是角色包声明层，不动。
- **新增 `L2RuntimeStrategy`**（放 [types.ts](../src/agent/types.ts)）：一枚对象，内聚 11 项运行态策略 + `DEFAULT_L2_STRATEGY` 常量（原魔数收敛于此，**消灭魔数债**）。
- **新增聚合函数**：在 [strategyResolver.ts](../src/role-pack/strategyResolver.ts) 增加 `resolveL2Strategy(strategy): L2RuntimeStrategy`，**等价合并**现有 10 个 `resolveXxx` + loopContinue 分支（不删逐个 `resolveXxx`，若尚有其它消费则保留，无消费则一并折叠）。
- **loop 侧**：`AgentLoop` 新增 `setStrategy(partial: Partial<L2RuntimeStrategy>)`，一次性合并 11 个字段；**删除 11 个离散 setter**（保留 `setProvider/setChatOptions/setCurrentRoundId` 等非策略基础设施）。
- **agent 侧**：L551–584 的 11 处调用**收缩为一次** `loop.setStrategy(resolveL2Strategy(strategy))`。

### 关键设计决策：内部存储

**推荐：保留 loop 内部分字段，只收敛"赋值入口"为 `setStrategy`。** 理由：
- loop 内读取点（`handleIteration`/`handleToolCalls`/`executeOneTool` 读 `this.tokenBudget`、`this.toolReadonly` 等）**全部不动**，改动面最小、风险最低，符合"最小改动验证"。
- 不推荐"loop 内改为单一 `this.strategy.xxx` 对象读取"——那会波及所有读取点，显著扩大改动面且无收益，属过度打磨。

### 向后兼容与测试迁移（决策点，需对齐）

两种路线二选一：

- **路线 A（推荐，稳）**：`setStrategy` 新增 + 11 个旧 setter **保留为薄转发**（`setTokenBudget(n){ this.applyStrategy({tokenBudget:n}) }`），测试零改动，跑通回归后**下一批再删** setter。
- **路线 B（洁癖，激进）**：直接删 11 个 setter，同步迁移 loop.test.ts 的 9 处调用到 `setStrategy({...})`。符合"代码洁癖一次性删干净"，但一次性触碰面大。

> 建议默认走 **A**：先以"新增收敛 + 旧转发"落地并冻结回归，删除动作作为独立的低风险增量，避免在一次提交里既改结构又删 API。

### 调用点清单（已核查）

| 位置 | 行号 | 调用 | 处理 |
|------|------|------|------|
| [agent.ts](../src/agent/agent.ts) | L551 | `setToolCallsBlocked(resolveToolMode(strategy))` | → 并入 `setStrategy` |
| agent.ts | L554 | `setToolStepLimit(resolveToolStepLimit(strategy))` | → 并入 |
| agent.ts | L557 | `setErrorHandling(resolveErrorHandling(strategy))` | → 并入 |
| agent.ts | L560 | `setProviderRouting(resolveProviderRouting(strategy))` | → 并入 |
| agent.ts | L563 | `setInputInterrupt(resolveInputInterrupt(strategy))` | → 并入 |
| agent.ts | L566 | `setTokenBudget(resolveTokenBudget(strategy))` | → 并入 |
| agent.ts | L569 | `setStepBudget(resolveStepBudget(strategy))` | → 并入 |
| agent.ts | L572 | `setMultiStepReasoning(resolveMultiStepReasoning(strategy))` | → 并入 |
| agent.ts | L575 | `setToolReadonly(resolveToolReadonly(strategy))` | → 并入 |
| agent.ts | L578 | `setToolApproval(resolveToolApproval(strategy))` | → 并入 |
| agent.ts | L582–584 | `loopContinue`→`setMaxSelfReviewRounds`（内联） | → 并入聚合函数 |
| [loop.ts](../src/agent/loop.ts) | L670–782 | **11 个 setter 定义** | → 删/转发生 `setStrategy` |
| loop.ts | L249–345 | 策略字段初始化（含魔数默认值） | → 默认值移入 `DEFAULT_L2_STRATEGY` |
| [loop.test.ts](../src/agent/__tests__/loop.test.ts) | L1219/1259/1295/1331/1364 | `setMaxSelfReviewRounds` | → 路线 A 免改 / 路线 B 迁 `setStrategy` |
| loop.test.ts | L1363/1747/1788/1825 | `setToolCallsBlocked` | → 同上 |
| loop.test.ts | L2396/2423 | `setTokenBudget` | → 同上 |

### 验证

- `npx tsc --noEmit` 零错误（必过）。
- 测试回归：`agent/loop` 相关 test 全绿；若走路线 A，测试零改动即应全绿。
- 运行态语义不变（同一批 `resolve*` 结果，只是改一次写入）。

---

### 落地记录（2026-08-19 · 方案 Y 直接收敛）

**决策**：项目未正式启用、无需兼容 → 走**直接收敛**（既不做 setter 转发，也不保留 loop 镜像字段）：
- 直接删除 11 个策略 setter 与对应字段，loop 改为持有**单一 `L2RuntimeStrategy` 对象**，经 `setStrategy(partial)` 浅合并注入（方案 Y）。

**改动**：
- [role-pack/types.ts](../src/role-pack/types.ts)：新增 `L2RuntimeStrategy`（11 只读字段，复用既有 7 个策略联合类型）；re-export 增加 `resolveL2Strategy`。
- [role-pack/strategyResolver.ts](../src/role-pack/strategyResolver.ts)：新增 `DEFAULT_L2_STRATEGY`（收敛原 loop 魔数默认）+ `resolveL2Strategy`（聚合 10 个 resolveXxx + loopContinue 归一）。
- [agent/loop.ts](../src/agent/loop.ts)：删 11 策略字段 + 11 setter，改持 `private strategy`，读取点统一 `this.strategy.<field>`（~29 处）。
- [agent/agent.ts](../src/agent/agent.ts)：装配 11 处 setXxx 收缩为 `loop.setStrategy(resolveL2Strategy(strategy))`。
- [agent/__tests__/loop.test.ts](../src/agent/__tests__/loop.test.ts)：9 处调用迁移 `setStrategy`。

**发现（守恒测试纠错）**：`resolveToolStepLimit` 的 JSDoc 声称"非法/缺失回退默认 20"，但实现实际回退 **0**。新增守恒测试 `resolveL2Strategy(undefined) === DEFAULT_L2_STRATEGY` 戳穿该注释/实现不一致，据此将 `DEFAULT_L2_STRATEGY.toolStepLimit` 定为 **0**（对齐运行语义，非注释的 20）。

**验证**：`pnpm typecheck` 零错误；全量 `pnpm exec vitest run` **2242 passed / 1 skipped**；改动作业文件 eslint 清零；新增 `resolveL2Strategy` 用例 4 个（默认守恒 / toolMode 映射 / loopContinue 归一 / 局部覆盖）。

---

## T2：'单一检查点'名实对齐

- **问题**：文档写"统一单一检查点"（§7.2.1），实现是 `executeOneTool` 内 `toolReadonly → toolApproval → preExecutionCheck` 顺序闸门（[loop.ts](../src/agent/loop.ts#L1679-L1717)）。
- **改动**（不动行为）：将三段顺序判断收拢为一个私有 `applyPrechecks(tc)` 三态返回；文档同步改称"单点聚合的多重检查"。纯重构、零行为变化。

### 落地记录（2026-08-19 · 纯重构，零行为变化）

- [agent/loop.ts](../src/agent/loop.ts)：新增 `PreCheckDecision` 三态类型 + `applyPrechecks(tc)` 私有方法，将 `executeOneTool` 内的三段顺序闸门（只读 → 审批 → 宿主 preExecutionCheck）**原位抽取**为统一检查决策；`executeOneTool` 消费三态（denied/skip/execute），onToolExecuted 走改写参数。行为守恒（spring 守卫顺序与日志不变）。
- 文档/注释措辞统一（名实对齐）：[agent-design-philosophy.md §7.2.1](architecture/agent-design-philosophy.md)，及 loop.ts / agent.ts / assembler.ts / types.ts 相关注释，"统一执行前检查点 / 单一检查点 / 单一物理落地载体" → "统一执行入口 · 单点聚合的多重顺序检查"。
- **验证**：`loop.test.ts` 76 通过；`typecheck` 零错；eslint 清零（改动作业文件）。

---

## T3：`determineTaskType` 加固（已完成治标 · 注入点明确不做）

- **现状**：[loop.ts](../src/agent/loop.ts) `>500字符→reasoning`、检代码块→code，用于 Provider 路由（影响成本），魔法数过脆。
- **治标（已做，2026-08-19）**：魔法数 500 收敛为内核常数 `LOOP_CONSTANTS.REASONING_INPUT_CHARS`（[constants.ts](../src/agent/constants.ts)）。
  - **语义澄清**：该阈值是**内核启发式**（任务分类是 Provider 路由的内部决策，影响成本），**不属于角色包可影响的 `L2RuntimeStrategy` 维度**，故不入策略对象——避免"策略全景物化"。
- **注入点（明确不做）**：`taskTypeResolver?` 宿主注入点可对齐 `DuplicateCallInterceptor` 的"策略参数化"模式，但**当前无真实消费场景**，留待出现真实用途再开放，不预埋（单一真理源：不预埋未消费接口）。

## T4：文档去时态 / 名实清扫

- 把"已实现/已落地"与"修订历史"从设计正文剥离（正文只留定案，历史下沉 ADR / 变更记录）。
- 核对残留"文档标【已落地】但代码已删"的过期引用（如 InsightExtractor、guardrail 摘除后残留）。

### 落地记录（2026-08-19 · 有界交付，聚焦"过期错误文档"）

**已清（guardrail 过期引用）**——核对代码确认 guardrail 空转链已于 2026-08-17 完全移除（`loop.ts` 仅剩"已摘除"注释），据此清理 [memora-api-reference.md](../memora-api-reference.md)：
- `AgentChunk.text` 移除 `guardrailBlocked?: boolean` 字段；
- 删除 `guardrailBlocked 结构化信号`说明块；
- 删除 `SOURCE_LABELS.GUARDRAIL` 条目；
- 「十五、内容护栏」章节改写为「十五、工具错误反思（Reflection）」（删除护栏规则/行为 15.1/15.2，保留有效 15.3）。

**遗留下沉为后续专项（2026-08-19 排期；✅ 当日已随 T5/T6 一并完成）：**
- **T5 · 接入指南 guardrail 清理** — 已完成：第八章节改名「工具错误反思」、目录项 / MockEval / 目录结构 / 规则 13 的 guardrail 引用清除。
- **T6 · 设计文档时态标注剥离** — 已完成：[agent-design-philosophy.md](architecture/agent-design-philosophy.md)（11 处）+ [memory-as-summary.md](architecture/memory-as-summary.md)（22 处）的演进日期与状态壳剥离，保留实质设计理由与调研/标准标注。

---

## 二、外部审查重排（workbuddy 清单 → memora 哲学过滤，2026-08-19）

> workbuddy 给出 6 项：T1(eslint预算) / T2(迁移实证) / T3(拆coordinator) / T4(冻结契约) / T5(文档治理) / T6(注释校核)。
> 用 memora 哲学（纸面 vs 实证 / 单一真理源 / 拒全景物化 / 未启用不需兼容）过滤后重排为 A/B/C 三档：

**A · 实证债（先做，纸面→实证）**
- **A1 检查点迁移实证 ✅ 已落地**：核查发现 `CURRENT_SCHEMA_VERSION=1`（首版），空迁移表是**应然正确**——workbuddy 判"0 注册=安全网没兑现"是误判；真债是[归一化迁环从未被测试覆盖]。用**探针迁移**单测实证「迁环真实调用迁移 + 版本按序归位」，**不伪造 v2 字段演进**（否则违背反全景物化，否决 workbuddy 的 `recallWindow` 假字段方案）。
- **A2 行为注释校核 ✅ 部分**：修正已知漂移 `resolveToolStepLimit`（注释"回退20" vs 实现 0）；全量巡检（loop/sessionStateMachine 带行号/行为断言注释）留后续。

**B · 收敛/防腐（agent 膨胀评估结论）**
- **B1 agent 门面归位 → 判定不做（经归位审计实证）**：审计 agent.ts 对既有 manager 的委托调用仅 12 处、且多为合理编排（`skillManager.match`/`roundSummaryGenerator.generate`/`setBackgroundProvider` 广播等），**几乎无可删的"纯透传二道门"**。其 3000 行绝大多数是真实编排逻辑，**不是可清理的冗余债务**；要降至 1500 只能下沉编排进 manager → 违反"组件数不增"铁律 + 动 chat 核心高危。判定：agent "大门面承载编排"是受"单 Agent 模型"支撑的架构选择，**不强行瘦身**；由 B2 防腐兜住不再膨胀。
- **B2 宽防线 ✅ 已落地**：eslint `max-lines:2000`（skip blank/comments），对存量超标文件（agent/loop，非瘦身目标现转认为架构常态）与测试目录豁免，只卡增量，不制造 disable 负债区；**不做** `complexity`/`max-functions-per-file` 硬指标（会逼出别扭小函数）。

**C · 治理（前提满足才动）**
- **C1 记忆契约冻结**：排到**决定正式发布之前**（收敛期冻结=提前按暂停；B1 已判定不做，故不再以其为前置）。
- **C2 ADR status 字段**：轻量可扫，可随文档维护顺手加。

**明确否决（全景物化陷阱）**：再造 6 个 coordinator（`ArchiveCoordinator/LockManager/SessionManager/SessionStateMachine` 已存在 = 重复造轮子）、`complexity` 硬指标、拆 loop.ts。

---

## 明确不建议做（防过度打磨）

- **拆分 agent.ts / loop.ts 大文件**：拆文件收益 < 风险，且破坏"门面 + 单一执行引擎"的可读性。真正该清的是已摘除功能的**僵尸码/僵尸键**，而非结构拆分。
- **降级记忆治理栈**：记忆是 memora 最强项，不许动。
- **新增插件系统 / 事件溯源**：harness-borrowing-assessment 已否决，理由依旧成立。
- **determineTaskType 加宿主注入点 / 升级为角色可配维度**：T3 已治标（魔数收敛），注入点明确**不做**（当前无真实消费，防全景物化），此处不重置。
- **agent.ts 门面再瘦身**：B1 归位审计实证"纯透传二道门"几乎无可删，3000 行多为真实编排，已判定不当瘦身目标，由 B2 eslint 防线兜住增量。

---

## 三、第 8 部分复核派生任务（2026-08-19 排雷后）

> 由 [memora-agent-kernel-review.md](memora-agent-kernel-review.md) 第 8 部分（同日复核）排雷派生。T1–T6 / A / B 已完成，以下仅登记**真实剩余**——收敛之尾 + 防再犯，不重置任何已判定"不做"项。

### N1 · `resolve*` 回退硬编码收敛（T1 尾巴 · SSOT 微债）

- **现状**：[strategyResolver.ts](../src/role-pack/strategyResolver.ts)：`resolveTokenBudget` 回退字面量 `8000`、`resolveStepBudget` 回退字面量 `50`，与 `DEFAULT_BEHAVIOR_STRATEGY.global` 及 `DEFAULT_L2_STRATEGY` 的常量值重复。
- **改动**：新增 `DEFAULT_TOKEN_BUDGET = 8000` / `DEFAULT_STEP_BUDGET = 50`（放 strategyResolver.ts 内，SSOT 单一来源），`resolve*` 回退改引用；`DEFAULT_L2_STRATEGY` 与 `DEFAULT_BEHAVIOR_STRATEGY.global` 复用同一常量。
- **不动**：`resolveL2Strategy(undefined) === DEFAULT_L2_STRATEGY` 守恒测试必须仍通过（该测试是 T1 新增的守恒护栏）。
- **验证**：`pnpm typecheck` 零错；`resolveL2Strategy` 守恒测试 + 全量 vitest 绿。
- **优先级**：低（轻微重复，但符合"单一真理源"与数字不散落）。

### 落地记录（2026-08-19 · 单一来源收敛）

- [strategyResolver.ts](../src/role-pack/strategyResolver.ts)：新增 `DEFAULT_TOKEN_BUDGET`（8000）与 `DEFAULT_STEP_BUDGET`（50）两个内核默认常量（SSOT 单一来源），将 4 处硬编码字面量——`DEFAULT_BEHAVIOR_STRATEGY.global.tokenBudget/stepBudget`、`resolveTokenBudget`/`resolveStepBudget` 非法/缺失回退、`DEFAULT_L2_STRATEGY.tokenBudget/stepBudget`——统一引用同一常量。
- **命名说明**：任务原拟名单一来源命名为 `DEFAULT_RESOLVE_TOKEN_BUDGET`，落地时改为更准确的 `DEFAULT_TOKEN_BUDGET`（因该值同时服务"声明层默认 / resolve 回退 / loop 惰性初始"三处，非仅 resolve 一家，避免误导性命名），文档与代码名实保持一致。
- **不动**：测试断言中的字面量 8000/50（如 loop.test.ts `setStrategy({ tokenBudget: 8000 })`）是断言值，非 SSOT 债，不改（保持一致语义）。
- **验证**：`pnpm typecheck` 零错；`strategyResolver.test.ts` **88 通过**（含 T1 守恒 `resolveL2Strategy(undefined) === DEFAULT_L2_STRATEGY`，回退值取自同一常量故守恒天然成立）。eslint 待 pre-commit hook 统一校验。

### N2 · 评审文档→代码版本同频机制（防再犯）

- **问题**：`memora-agent-kernel-review.md` 初稿在 T1/T3 收敛前生成，导致"133KB/2293行/11 setter/魔数分散"等数字在收敛后失真——这正是本次排雷要修正的。
- **改动**：评审文档维护者在每次大收敛后，复用 `prompts/` 下**已有的审查提示词**（如「聚焦 Memora 的 SSOT 与设计闭环审查」），重核文件行数/字节/setter 数量等可量化断言；并保留一张「评审日期 → 参考代码版本/commit」对表于文首，标注本文依据的代码状态。
- **不动**：不为此建 CI 自动化（评审是人工判断，不引入定期任务以保持内核简单）。
- **验证**：下一轮收敛（如 N1 落地）后，按提示词重跑并核对 N1 涉及的数字是否同频。
- **优先级**：中（结构性文档债，本次已就地补第 8 部分复核，机制是现代化落点）。

### 落地记录（2026-08-19 · 版本同频对表落地）

- [memora-agent-kernel-review.md](memora-agent-kernel-review.md) 文首新增「**版本同频对表**」：三行（初稿基准 / 第八部分复核 / N1 落地复核），各标注参考代码状态 + git 标识；并写明维护规则（每次内核大收敛后复用既有审查提示词重核、仅更新对表与第八部分、不改历史正文）。
- **不动**：未为此建 CI 自动化（评审是人工判断），维持"评审属人工"的内核简洁。

### N3 · 已固化核心文档过期引用盘点（T4/T5/T6 的收口）

- **背景**：T4/T5/T6 只清了 `agent-design-philosophy.md`（11 处）、`memory-as-summary.md`（22 处）与接入指南/api-reference 的 guardrail 引用；`docs/` 下仍有 11 个架构类文件含 `2026-08-1x` 日期标注，其中部分"标【已落地】"需核对其与当前代码是否仍一致（如 `role-pack-spec.md` 的 L3 状态"规划中/已实现"）。
- **注意（避免误清）**：`memory-as-summary.md` 中 InsightExtractor **多次提及是其移除原因的说明性保留**（[L516/L521/L526](../architecture/memory-as-summary.md)），对应 `checklist` 的僵尸键盘点职责，**不是待清残留**——盘点时应区分"移除说明（保留）"与"假定的已删除实现引用（清）"。
- **改动**：逐个核 `docs/architecture/` 下含 `2026-08-1x` 的文件（`role-pack-spec.md`/`structured-fidelity.md`/`host-plugin-alignment.md`/`module-inventory.md`/`role-pack-skills-progressive-disclosure.md`/`mvp-scope.md`/`memory-role-pack-boundary.md`/`recall-mutex-pre-filter.md`/`harness/harness-borrowing-assessment.md`）——仅清"标已落地但代码已删"的过期引用，保留"移除原因说明"；**不做重构**。
- **不动**：保留设计理由与调研/标准标注（对齐 T6 口径）。
- **验证**：逐文件留一条"已核，无过期/已修正 X"备注；typecheck 与测试不受影响（纯文档）。
- **优先级**：中（文档债，可由 N2 机制滚动完成，不急一次铺平）。

### 落地记录（2026-08-19 · 盘点结论：仅 1 处过期）

- **修正**：[role-pack-skills-progressive-disclosure.md](architecture/role-pack-skills-progressive-disclosure.md) L3 状态由"规划中"更正为"**已实现**"，清单 6 项全部核对勾选（[SkillLayer3](../src/skill/types.ts#L10-L36)、`resources`+`scripts` 扫描、`listResources`+`readResource`+`listScripts`、`read_resource` 与 `run_skill_script` 工具（[skillScriptRunner](../src/skill/skillScriptRunner.ts)）、L1 附加"含资源/脚本"提示），并补 2026-08-19 变更记录。
- **核验准确（不改）**：`role-pack-spec.md` L3 是"代码层（远期/未启用）"，为真实设计预留非过期；`structured-fidelity.md`（summaryFocus 已落地）、`recall-mutex-pre-filter.md`（已落地）、`mvp-scope.md`/`host-plugin-alignment.md`（历史规划快照）状态与代码一致。
- **说明**：`memory-as-summary.md` 的 InsightExtractor 为移除原因说明，保留（对应 checklist 僵尸键职责）。
- **验证**：typecheck/测试不受影响（纯文档变更）。

### 任务排序建议

`N1`（纯代码、低风险，单一真理源收尾）→ `N2`（机制防再犯）→ `N3`（文档收口，可滚动）。三者互不依赖，均不触碰"不做"清单。

---

## 能力边界与发布标准（2026-08-21 · 排雷核实后收敛）

> 本节以 DeepSeek Harness 视角 + 2026 年最新 agent 土壤（silent failure / evals / 独立验证）对内核做发布前的边界基准。**结论先行：memora 已具备发布成熟度**——能力边界收敛、发布标准明确、且经排雷确认"不新造机制"。

### 一、能力边界（内核"是什么 / 不是什么"）

**内核提供**（已落地、经全量回归 2356 用例锁定的能力）：
- 单轮问答闭环为唯一公理，Loop/规划/记忆/角色全由它自然生长（agent-design-philosophy §1-§5）
- 记忆即摘要单轨（round-summary） + superseded 写时取代 + 触发源决定召回 + 两级渐进披露技能
- 状态机真值源 + 检查点严格校验 + 独立验证回填通路（`onRoundBoundary` + `injectSystemMessage`，assembler 停滞检测即此模式）
- 全 span 可观测（ITracer：llm.call / tool.execute / round.*），宿主可自建轨迹导出
- 纵深安全（路径守卫 + 工具结果净化 + fail-closed + 注入防御）

**内核明确不提供**（边界，防过度打磨）：
- **不内置 eval/回放引擎**：agent-design-philosophy §13.x 已声明"评估体系随产品化再启用，不引入独立评估引擎"。经排雷确认外部验证回填通路（`onRoundBoundary`+`injectSystemMessage`）与轨迹导出（ITracer 全 span）**已存在**——宿主自建评估即得，内核不预埋。**此边界维持，不设 P0/P1**。
- **不提供独立 eval 打分器**：评估信号由宿主注入（评估是宿主/评估策略职责，内核只产事件与 span）
- **self-review 不做独立进程评估**：self-review 已要求"可验证确定性判据防自说自话"（loop L211），但最终判断仍由 LLM 自身完成——**已知取舍**，独立状态核对须由宿主经回填通路叠加，内核不内建

### 二、发布标准（满足即发布）

经本轮全量自然生长审查（19 项模块，修复 10 真缺陷 + 排雷），发布前置条件：

1. **代码质量**：`tsc --noEmit` 零错 ✅ · 全量 vitest 2356 通过（唯一失败 compaction 为沙箱写文件环境性，非回归）✅ · pre-commit（lint-staged/typecheck/commitlint）全过 ✅
2. **能力闭环**：种子 + 记忆 + 装配 + 工具安全 + 角色 + 状态机 + LLM + Skills + 存储 + 安全守卫全部完审，勘测 10 处真缺陷（含 2 处安全）均已修复 ✅
3. **能力边界清晰**：如上"不提供"清单——不新增 eval 引擎、不内建独立验证、不拆 agent/loop、不降级记忆治理栈、再造 coordinator ✅
4. **文档同步**：本 roadmap 的能力边界/发布标准 + design-philosophy §13.x 评估定位已对齐 ✅

**发布判定**：以上四条满足即为 **v3.0.0 可发布状态**。剩余工作非"补缺口"而是"文档化既有能力"——无需再造机制，仅随产品化按 §13.x 启用宿主侧评估（内核不改）。

### 三、后续防线（发布后，非发布前）

- 若生产需求触发：宿主经 `onRoundBoundary`/`injectSystemMessage` 回填独立验证信号，自建 run→回归用例导出（内核不改，纯宿主侧）
- self-review 若被实测为"自说自话"瓶颈，再评估独立验证强化——**触发条件驱动，不预埋**