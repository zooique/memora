# Memora 架构文档体系 · 第三方独立审查报告

> 审查日期：2026-08-12
> 审查对象：`docs/architecture/README.md`（核心闭环）、`docs/architecture/runtime-architecture.md`（运行时）、`.trae/rules/single-truth-source-mindset.md`（思维模型）、`docs/refactoring-roadmap.md`（路线图）
> 审查方法：**第一性原理 + 对抗式核查**。除通读 4 份文档外，对文档中的"现行代码评估"断言与 `src/` 实际代码、`project-rules.md` / `architecture_philosophy_rules.md` 两份项目级硬约束做了交叉验证（grep 实测，非凭记忆）。
> 已知已修复项（第二轮审查 11 项）**不重复报告**。本报告仅列独立发现的新问题。

---

## 〇、总体质量评价

| 维度 | 评分 | 说明 |
|------|------|------|
| 逻辑自洽性 | 72 | 内部矛盾较多（截断语义、版本号、边界声明、超时被中断），且 3 处与项目级硬约束直接冲突 |
| SSOT 合规性 | 80 | 哲学论述扎实，残留冗余（双版本管理/双迁移接口、TriggerQueue+LockManager）已较克制 |
| 覆盖完整性 | 70 | 中断/暂停机制、召回失败、跨会话写入隔离、队列满下游、检查点 O(n²) 均为未设计盲区 |
| 接口质量 | 74 | `any` 泛滥违反 §7.1 零容忍；部分接口字段语义自相矛盾（totalBudget 必填 vs 宿主传入） |
| **综合** | **80 / 100** | 设计哲学成熟、自审纪律好，但进入 Phase 3/4 前必须消掉 3 个 🔴 |

**结论：可以开始实施重构，但设阶段闸门。**
- **Phase 1（RoundHooks + 测试地基）现在即可启动**——本轮发现的问题均不阻塞它。
- **Phase 3（并发 + 护栏）与 Phase 4（检查点 + 恢复）启动前，必须先解决 3 个 🔴**（角色包匹配机制、degrade 语义、检查点机制对齐硬约束），否则会在错误地基上施工。
- 🟡 项随对应 Phase 实施时逐条消化，不阻塞启动。

---

## 一、🔴 严重问题（必须修复，3 项）

### 🔴 R1 · 运行时检查点设计与项目冻结机制冲突（硬约束层面）

- **位置**：`runtime-architecture.md §13.4.2`（`HandoffCheckpoint` / `CheckpointStore` / `RecoveryStrategy`）；`refactoring-roadmap.md §违规3 / Phase 4`
  **对照**：`project-rules.md §1.8 硬约束` + `src/agent/managers/sessionManager.ts`（实测 `SessionCheckpoint.schemaVersion` + `checkpointMigrations` + `normalizeCheckpoint` 已存在）
- **问题**：路线图把"检查点合并到 Handoff"作为修正方案，但新设计的 `HandoffCheckpoint.metadata.version: number` 是一套**全新的、与现有代码脱节的**检查点类型。实测代码里检查点早已是 `SessionCheckpoint`，且 `project-rules.md §1.8` 将其列为**不可违反的硬约束**：
  > 新增检查点字段必须：① 递增 `CURRENT_SCHEMA_VERSION`；② 在 `checkpointMigrations` 中注册迁移。

  运行时文档的 `HandoffCheckpoint` + `CheckpointStore` + `RecoveryStrategy` **绕开了** `schemaVersion` / `checkpointMigrations` / `normalizeCheckpoint` 这套已冻结迁移机制，等于在硬约束之外另起炉灶——这本身就是 SSOT 违规（§违规3 的"修正"又造了一个平行机制）。
- **违反什么**：直接违背 `project-rules.md §1.8` 硬约束；也违背 SSOT"同一类事只在一处定义"。
- **建议修复**：不新造 `HandoffCheckpoint`/`CheckpointStore`。在 `SessionCheckpoint` 上**增量扩展字段** → 升 `CURRENT_SCHEMA_VERSION` → 在 `checkpointMigrations` 注册迁移；`RecoveryStrategy` 直接调用 `SessionManager.restoreFromCheckpoint`。文档 §13.4.2 应改为描述"Handoff 持久化 = `SessionManager.createCheckpoint` 的自然步骤"，与 §1.8 对齐。

### 🔴 R2 · "degrade 未定义" 与项目哲学「降级优先」直接矛盾

- **位置**：`runtime-architecture.md §12.2`（"degrade 的具体行为未定义""内核只提供 retry 和 stop 两种确定性行为，degrade 由宿主实现"）
  **对照**：`architecture_philosophy_rules.md §7 降级优先（Degrade Before Breaking）`
- **问题**：§12.2 声称 degrade 内核不实现、交给宿主。但 `architecture_philosophy_rules.md §7` **已经定义了降级语义**：P0 对话响应不可降级、P1 消息持久化失败记日志不抛、P2 话题归档失败跳过、P3 启动补执归档跳过、P4 项目切换 warn 继续，并明令"归档失败导致对话中断"为禁止项。即：**降级不是"未定义"，而是项目已确立的硬原则**。运行时文档把一项已被哲学定义清楚的能力说成"未定义/宿主专属"，自相矛盾。
- **违反什么**：两份项目级文档在核心降级策略上互相打架；若按 §12.2 实施，内核将缺失哲学 §7 明确要求的行为（如归档失败跳过不中断），实际违反架构哲学。
- **建议修复**：二选一——(a) 内核实现 §7 的 P0–P4 降级层级（推荐，与哲学一致）；(b) 若坚持宿主委派，则从内核面向的 L2 枚举（`§8.7.5` `costOnExceeded` / `§9.2` `错误处理`）中**移除 `degrade` 取值**，仅保留 `retry`/`stop`，并明确标注 `degrade` 为宿主侧扩展；同时把 §12.2 改写为"内核实现哲学 §7 的降级层级，宿主可在 L2 选择 stop/retry，degrade 由宿主扩展"，而非"未定义"。

### 🔴 R3 · 角色包匹配机制自相矛盾，动摇"循环依赖陷阱"的解法根基

- **位置**：`docs/architecture/README.md §4.2 / §4.1`（"角色包匹配基于输入触发词**确定性匹配（精确匹配或正则匹配），不依赖语义理解**"）
  **对照**：`architecture_philosophy_rules.md §1.2`（"Persona 匹配：**关键词 + LLM 辅助语义匹配**，在 `chat()` 开头执行"）
- **问题**：核心说明书断言角色包匹配是**纯确定性**的（这是 §4.1 / §5.1 解决"循环依赖陷阱"的整个论证支点——"确定性匹配打破循环依赖"）。但项目哲学文档明确说 persona 匹配是"**关键词 + LLM 辅助语义匹配**"。persona 是角色包 L1 内容的核心组成，两者描述的是同一对象的两种互斥匹配方式。
  - 若实际用 LLM 语义匹配 → §5.1 的"确定性匹配打破循环依赖"证明不成立（理解输入仍依赖角色包语义）；
  - 若按核心说明书用确定性匹配 → 哲学 §1.2 的描述是错的/过时的。
- **违反什么**：两份权威文档在**最小单元层面最关键的机制**上相互否定；且动摇了思维模型「循环依赖陷阱」解法的正确性。
- **建议修复**：以核心说明书的"确定性触发词匹配"为 SSOT 正确目标（它才满足循环依赖解法），将 `architecture_philosophy_rules.md §1.2` 的"LLM 辅助语义匹配"标注为**历史实现/待改造**，或改为"首次确定性匹配 + 可选 LLM 精排（非必须）"。并在 §4.1 显式声明："角色包匹配全程确定性，LLM 不参与匹配决策，否则循环依赖无法打破。"

---

## 二、🟡 中等问题（建议修复，21 项，按主题分组）

### 2.1 逻辑自洽性（内部矛盾）

**🟡 M1 · L1 截断语义自相矛盾**
- 位置：`README §7.3`（步骤 1"L1 最近 N 轮**不受截断影响（第一优先级保护）**"）vs `runtime-architecture.md §8.3` L1 行（"**超过 N 轮时，最旧被裁**（进入 L2 摘要系统）"）。
- 问题：同一 L1，一处说永不裁、一处说超 N 即裁。§8.3 的"裁"若被实现者理解为"预算溢出时丢弃最旧 L1 轮"，将直接违反 §7.3 第一优先级保护。实为术语歧义（"移出 L1 窗口→降级为摘要" vs "截断丢弃"）。
- 修复：统一术语。§8.3 改为"超 N 轮时最旧轮**移出 L1 窗口、以摘要形式进入 L2**（非截断丢弃）"；明确"截断（预算溢出）时 L1 永不丢弃"与"窗口滚动（超 N 轮）时 L1 自然降级"是两件事。

**🟡 M2 · "不中断在飞闭环" 与 "超时强制终止" 矛盾**
- 位置：`runtime-architecture.md §13.3.5` 纪律 1（"不中断正在执行的闭环"）vs `§13.9.4` 纪律 5（"`maxRoundDuration` 超过时，**强制终止当前闭环**"）以及 `§8.7.4`（"不中断当前轮"）。
- 问题：并发纪律禁止在飞插入操作，性能纪律却要求硬超时杀掉在飞轮。二者对"能否中断在飞轮"给出相反答案。
- 修复：澄清边界——"非致命的控制类操作（并发/成本/护栏）不插入在飞轮；致命的**超时/用户中止**是例外，由唯一中断通道处理"（见 M13）。

**🟡 M3 · 边界纪律过度宣称"核心不引用任何运行时类型"**
- 位置：`runtime-architecture.md §13.1` 纪律 1、§13.5.2、路线图 §违规1（"核心闭环只暴露 RoundHooks，**不引用任何运行时类型**"）。
- 问题：实测核心确实调用 `TriggerQueue.enqueue`、`SecurityGuard.checkInput`、`LockManager.acquireSessionLock`、`SessionManager.createCheckpoint`（见 R1）。这些**主动调用**的运行时接口，与"仅通过 RoundHooks 被动订阅的可观测性组件"性质不同。该纪律对可观测性成立，对并发/护栏/检查点不成立，表述以偏概全，且与 §13.3/§13.8 自相矛盾。
- 修复：将边界拆为两层——(a) 核心**暴露** `RoundHooks` 给被动订阅者（可观测性）；(b) 核心**消费**一组"内核定义、宿主实现"的运行时服务接口（队列/护栏/检查点/锁），注入于构造期。纪律改为"核心不引用可观测性/领域类型，仅引用内核定义的运行时服务接口契约"。

**🟡 M4 · exclusiveWith 自动替换 vs `reject` 冲突策略矛盾**
- 位置：`README §9.4.5`（"互斥角色包同时装载时：**后装载的替换先装载的**（自动卸载）"）vs `§9.4.3` `reject` 策略（"互斥配置……冲突时报错，**阻止装载**"）。
- 问题：同一个事件（装载与已激活角色包互斥的新包）给出两种结局——自动替换（§9.4.5）与阻止装载（§9.4.3 reject）。未定义优先级。
- 修复：明确 `exclusiveWith` 自动替换**优先于** `reject` 冲突策略（互斥是特殊硬规则），或反之并写明理由。

**🟡 M5 · 召回排序键三处不一致**
- 位置：`README §7.4#4`（"recall() …**语义相关度**排序"）vs `runtime-architecture.md §8.3`（L3 记忆"**置信度**从高到低"、L2 摘要"**时间从新到旧**"）vs `architecture_philosophy_rules.md §6`（"双通道：语义+关键词，**合并去重**"）。
- 问题：同一份召回结果出现"语义相关度 / 置信度 / 时间 / 双通道合并"四种排序语义。装配阶段的重排序与召回阶段的排序口径不一，实现者无所适从。
- 修复：统一为"recall() 返回按语义相关度排序的结果（哲学 §6）"，装配阶段**不再二次重排**，预算只控制各类**取前 K 条**的配额，而非改变顺序。

### 2.2 SSOT 合规性与冗余

**🟡 M6 · 两套版本管理 + 两套迁移接口**
- 位置：`runtime-architecture.md §13.6`（`ConfigVersionManager` + `MigrationHook`）vs `§13.11`（`VersionRegistry` + `MigrationPlan` + `RolePackVersion` + `isRolePackCompatible`）。
- 问题："配置热更新版本"与"格式/ schema 兼容版本"被建成两套平行接口（两个 Version Manager、两个 Migration 抽象）。SSOT 三问：去掉任一套，另一套是否能覆盖？基本能——都是"版本号 + 迁移函数表"。
- 修复：收敛为一套版本/迁移原语，用 `kind`（config / format）区分；或至少在文档中明确二者边界与为何不能合并。

**🟡 M7 · 版本号方案不统一（semver vs 单整数）**
- 位置：`§13.4.2` `HandoffCheckpoint.version: number`（单整数）vs `§13.11` `RolePackVersion.formatVersion` semver vs `§13.6` `ConfigVersionManager.version: number` vs 记忆 `schema_version` 单整数。
- 问题：系统内有 semver 与单整数单调递增两种版本范式并存，且 `isRolePackCompatible` 只比 major、`ConfigVersionManager` 却说"版本号不可回退（回滚通过发布新版本）"——与单整数语义耦合却命名混乱。
- 修复：定义全局版本策略——对外格式用 semver，对内快照/配置用单整数 `schemaVersion`，文档统一术语。

**🟡 M8 · "版本号不可回退" 与 `rollback()` 方法矛盾**
- 位置：`§13.6.4` 纪律 2（"版本号单调递增，不可回退"）vs `§13.6.2` `ConfigVersionManager.rollback(configType, targetVersion)`。
- 问题：接口提供回滚到旧版本的方法，纪律却说版本不可回退。二者中只有一方为真。
- 修复：明确 rollback = 发布一个"内容等于旧版本"的**前向新版本**（不反向减版本号），并把方法语义写进纪律。

**🟡 M9 · TriggerQueue 与 SessionLock  intra-session 串行冗余**
- 位置：`§13.3.3`（`TriggerQueue` 串行 + `LockManager.acquireSessionLock`）vs 路线图 §设计哲学反思#3（自认并发控制有冗余）。
- 问题：若 `TriggerQueue` 已保证每会话单轮串行出队，`SessionLock` 再对同一会话加"准入锁"属双重保险。单进程内存队列下完全冗余。
- 修复：说明 `SessionLock` 仅用于**跨进程/分布式宿主队列**的兜底；单进程宿主可省略。或明确"队列负责排序、锁负责防重入绕过"，职责不重叠。

**🟡 M10 · `driftThreshold` 在 §4.2 引用为 L2，但缺席于 §9.2 L2 全景表**
- 位置：`README §4.2`（"可通过 L2 策略 `driftThreshold` 配置，默认 5"）vs `§9.2`（L2 策略全景表无此维）。
- 问题：粘性漂移阈值是被引用的可配置项，却未进入权威 L2 维度表；且 `architecture_philosophy_rules.md §1.2` 用的是**时间+切换次数**模型（"30s 内 5 次切换 → 2 分钟自动恢复"），与 README 的**轮次**模型（连续 N 轮未命中）又是两套不同粘性语义。
- 修复：把 `driftThreshold` 补入 §9.2；并统一粘性模型为"轮次制"（README）或"时间制"（哲学），二选一，避免实现者两套都写。

### 2.3 覆盖完整性（生产盲区）

**🟡 M11 · 中断/暂停机制被声称却未设计（核心能力缺口）**
- 位置：`README §5.1`（"可中断：任何时刻可被**软暂停（挂起）或硬中止（放弃）**"）、状态机 `PAUSED`（`§12.1`）——但 `runtime-architecture.md` 全文无中断设计；`§13.4` 仅覆盖进程退出，不覆盖用户中途暂停。
- 问题：软暂停/硬中止是核心说明书明确声明的属性，运行时层却无机制、无信号入口、无 LLM 流取消方案。`PAUSED` 状态无进入通道。
- 修复：已在项目侧存在（`project-rules.md §6` 指向 `docs/根基/申请暂停模型-最终定论` 与 Composer 不中断工作模型）。**在 4 文档集内**至少应在 §5.1 与 §13.3 交叉引用该机制，并把"暂停信号入口 / 流取消 / PAUSED 进入条件"补入运行时章，否则实施者会误以为需从零设计。

**🟡 M12 · 检查点每轮全量序列化 → O(n²) 写入**
- 位置：`§13.4.2` `HandoffCheckpoint.session.messages: SerializedMessage[]`（每轮 Handoff 持久化**完整**消息数组）。
- 问题：千轮会话 = 千次完整快照，写入量 O(n²)，长会话不可持续。仅 `CheckpointMeta.sizeBytes` 提及大小，无增量/差量策略。
- 修复：检查点只存**增量**（本轮新增消息 + 元数据），恢复时按 Handoff 链重放；或仅持久化"消息引用 + 当前轮偏移"。

**🟡 M13 · 跨会话写入隔离未强制**
- 位置：`§13.7` `IsolatedContext.writeMemory(item)`（"写入时自动标记 sessionId"）。
- 问题：读侧按 `sessionId` 过滤（隔离成立），但写侧仅"自动标记"——若某轮误用他者 sessionId 调用，数据即泄漏到他会话。无"写入 sessionId 必须等于本 scope sessionId"的校验。
- 修复：`writeMemory` 必须以 `IsolatedContext` 自身 `sessionId` 为唯一来源，忽略入参中的 sessionId 字段，从根上杜绝越权写。

**🟡 M14 · 召回/记忆存储失败无降级路径**
- 位置：`§6.1.1` 仅定义"摘要生成失败"降级；`§4.3` 召回三通道无失败处理。
- 问题：记忆存储宕机 / 向量检索超时时的行为完全未定义（fail-open? 重试? 报错?）。与哲学 §6"向量搜索失败静默降级到关键词"也不连贯（运行时文档未承接）。
- 修复：定义召回失败降级——单通道失败回退另一通道，双通道皆败则本轮无召回继续（fail-open），并计入可观测指标。

**🟡 M15 · 队列满（`accepted:false`）下游行为未定义**
- 位置：`§13.3.5` 纪律 4（"队列满直接返回 `accepted:false`，**由触发者决定如何处理**"）。
- 问题："由触发者决定"把责任推给未设计的触发源，无拒绝触发器的兜底（丢弃/重试/死信/用户提示）。生产环境必有此路径。
- 修复：定义默认下游策略（如：用户触发 → 提示"繁忙稍后"；系统触发 → 指数退避重投；并提供宿主覆盖钩子）。

### 2.4 接口质量

**🟡 M16 · 接口大量使用 `any`，违反项目零容忍**
- 位置：`runtime-architecture.md`：`SerializedMessage.tool_calls?: any[]`、`PhaseEndData.result?: any`、`RoundHooks.onEvent(data?: any)`、`LogContext [key:string]: any` 等。
- 问题：`project-rules.md §7.1` 明确"`as any` / `@ts-ignore` **零容忍**"。接口签名用 `any` 会把类型漏洞写进契约，实现时必然传播。
- 修复：用具体类型替换——`ToolCall`、`RoundEventData`、`LogContext` 收敛为已知字段 + 显式可选扩展位。

**🟡 M17 · `totalBudget` 必填字段与"宿主传入"语义冲突**
- 位置：`§8.2` `ContextBudgetConfig.totalBudget: number`（必填，无 `?`）vs `§8.4`（`contextBudget.totalBudget` 为 L2 维度，默认 122K）vs `§8.6.4`（"totalBudget **由宿主传入**""未声明时从宿主配置读取"）。
- 问题：接口把 totalBudget 设为角色包 L2 必填项，但正文又说它由宿主提供、角色包可不声明。字段可选性表述自相矛盾；且把模型相关魔数 122K 写进策略默认，模型一换即失真（与 §8.6.5"百分比是界面、token 是执行单位"也轻度冲突）。
- 修复：`totalBudget` 从 `ContextBudgetConfig` 移除或改为可选（宿主级注入）；角色包只声明百分比与 `recentRounds`，不声明绝对 token 数。

**🟡 M18 · `costOnExceeded`/`错误处理` 枚举含未实现值 `degrade`**
- 位置：`§8.7.5`（`costOnExceeded: stop / degrade`）、`§9.2`（`错误处理: retry / degrade / stop`）。
- 问题：`degrade` 在内核未实现（见 🔴 R2），但作为可选值暴露，实施者会误以为可用。
- 修复：随 R2 处置——要么实现、要么从内核枚举移除并标注宿主扩展。

**🟡 M19 · `SessionScope.checkQuota(resource: string, …)` 资源名无约束**
- 位置：`§13.7.2` `checkQuota(resource: string, delta?)`。
- 问题：`resource` 为自由字符串，调用方与实现方需各自约定 `"token"/"toolCall"/"runtime"` 等，易拼错、难校验。
- 修复：收敛为 `QuotaResource` 联合类型（`'token' | 'toolCall' | 'runtime'`）。

**🟡 M20 · `GuardrailReport` 在 `SecurityGuard` 下但 `getReport()` 未被任何流程引用**
- 位置：`§13.8.2` `SecurityGuard.getReport()`，但 §13.8.3 执行流程只走 `checkInput/checkOutput/checkToolCall` + emit 事件，无 `getReport()` 汇聚点。
- 问题：审计报告如何被宿主拉取未定义（是订阅 `guardrailBlocked` 事件累积，还是调 `getReport()`？）。两通道并存易重复。
- 修复：明确"事件流为主、getReport 可选快照"，或删除 `getReport` 避免双源。

**🟡 M21 · 恢复报告携带存储引用**
- 位置：`§13.4.2` `RecoveryReport.readonly checkpointStore: CheckpointStore`。
- 问题：*报告*（recover() 的返回）不应持有存储实例；这是返回值的职责，放在报告里语义错位，且泄漏内部依赖。
- 修复：从 `RecoveryReport` 移除 `checkpointStore`，恢复时内部直接持引用即可。

---

## 三、🟢 轻微问题（可优化，清单）

- **G1** `RoundHooks.onEvent(type, data?)` 与 `EventEmitter`/`AGENT_EVENTS` 是两套事件面。应注明"`onEvent` 仅承载自定义事件，阶段事件由订阅者自动桥接为 `AGENT_EVENTS`"，避免被误读为第二套事件系统（已知违规 4 已修 EventBus，但此残留需澄清）。
- **G2** 架构 README §2.1 列出 `Composer（不中断工作模型）` 但四份文档从未定义它；应补一句话指向 `docs/根基/申请暂停模型`（与 M11 互补）。
- **G3** 路线图 Phase 1 M1.1 称 "RoundHooks 包含 onPhaseStart/End、onHandoff、onError **四个回调**"，实际含 `onEvent` 共 5 个；计数有误。
- **G4** `persona` 多包合并"串联拼接 + LLM 自行调和矛盾"（§9.4.6）属已知设计异味，建议至少在文档标注"矛盾 persona 由宿主策略预防（exclusiveWith）而非依赖 LLM 调和"。
- **G5** `SessionScope.usage.runtimeMs` 累加但无消费方（与 `maxRuntimeMs` 未接线），属静置字段。
- **G6** `drain(sessionId): Promise<Trigger[]>` 返回被弃队列的触发器，但 §13.4 恢复流程未说明如何重新入队，属悬挂接口。
- **G7** §9.4.4 persona 合并默认 `latest`（后加载 persona 追加在后），与 §9.4.3"非安全规则默认 latest"一致，但与"persona 视角应稳定"的粘性纪律略有张力，建议注明。
- **G8** `RuntimeConfigRegistry.onConfigChanged: EventEmitter['on']`（违规 7 已修为 `EventEmitter`）——建议同步确认 `§13.6.2` 示例里 `EventEmitter['on']` 类型签名与 `src/utils/eventEmitter.ts` 的 `TypedEventEmitter` 实际泛型一致（实测存在 `TypedEventEmitter<EventMap>`，需在文档对齐泛型用法）。

---

## 四、维度审查矩阵（速览）

| 审查维度 | 关键发现 | 最严重项 |
|---------|---------|---------|
| 1. 逻辑自洽性 | M1/M2/M3/M4/M5 内部矛盾；R2/R3 与项目规则矛盾 | 🔴 R2、R3 |
| 2. SSOT 合规 | M6/M7/M8/M9 冗余与版本分裂；R1 修正方案反成平行机制 | 🔴 R1 |
| 3. 覆盖完整性 | M11 中断、M12 O(n²)、M13 写隔离、M14 召回失败、M15 队列满 | 🟡 M11 |
| 4. 接口质量 | M16 `any` 违 §7.1、M17 字段语义、M18/M19/M20/M21 | 🟡 M16 |

---

## 五、重构启动建议（阶段闸门）

```
Phase 1   RoundHooks + 测试地基      ✅ 现在可启动（本轮问题均不阻塞）
Phase 2   可观测性                   ✅ 可启动（仅订阅 RoundHooks）
Phase 3   并发 + 护栏                 ⛔ 启动前解决 R3（角色包匹配）、消化 M3/M4/M9/M15
Phase 4   检查点 + 恢复              ⛔ 启动前解决 R1（对齐 §1.8 冻结机制）、消化 M12/M13
Phase 5   热更新 + 版本兼容          ⚠️ 启动前消化 M6/M7/M8（版本/迁移收敛）
Phase 6   性能预算 + 优化            ⚠️ 启动前解决 R2（degrade）、消化 M2/M16/M17/M18
```

**一句话结论**：文档体系成熟度约 80 分，哲学根基扎实、自审纪律好；3 个 🔴 均为"与项目自身冻结规则/代码冲突"而非推倒重来，可在对应 Phase 启动前定点修复；🟡 项随实施滚动消化。**可以开始重构，但 Phase 3/4 须先过 🔴 闸门。**
