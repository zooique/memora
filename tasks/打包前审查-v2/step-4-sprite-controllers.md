# Step 4 审查报告：Sprite 宿主控制器层

> **审查范围**：`src/sprite/controllers/`（12 文件，~4066 行）+ `src/sprite/audit/`（2 文件）+ `src/sprite/cli/`（2 文件）+ `src/sprite/usage/`（1 文件）
> **审查日期**：2026-07-19
> **审查方式**：凭工程经验审查，不依赖项目规则
> **前序成果**：Step 1-3 报告

---

## 1. 审查范围清单

| 模块 | 文件数 | 行数 | 审查重点 |
|------|--------|------|----------|
| `controllers/memoryController.ts` | 1 | 806 | 职责边界、是否是"上帝 controller" |
| `controllers/proactiveEngine.ts` | 1 | 800 | 状态复杂度和触发逻辑 |
| `controllers/perceptionCoordinator.ts` | 1 | 456 | 协调器设计、依赖注入 |
| `controllers/patternDetector.ts` | 1 | 450 | 算法合理性、中文分词策略 |
| `controllers/presenceController.ts` | 1 | 378 | 生命周期、幂等保护 |
| `controllers/memoryHealth.ts` | 1 | 373 | 纯函数纯度、阈值合理性 |
| `controllers/contextAwareness.ts` | 1 | 344 | 节奏/连贯性/深度推导逻辑 |
| `controllers/affectController.ts` | 1 | 311 | 情感四维算法、关键词匹配 |
| `controllers/reviewManager.ts` | 1 | 275 | 纯函数模块、趋势判断 |
| `controllers/rapportController.ts` | 1 | 251 | 与 MemoryController.rapportLevel 重复 |
| `controllers/personaController.ts` | 1 | 67 | 薄层封装是否必要 |
| `controllers/index.ts` | 1 | 27 | 聚合导出 |
| `audit/auditManager.ts` | 1 | 67 | 审计闭环 |
| `audit/jsonlAppender.ts` | 1 | 188 | 写入串行化、截断策略 |
| `cli/formatter.ts` | 1 | 104 | CLI 格式化纯度 |
| `cli/interaction.ts` | 1 | 55 | readline 封装 |
| `usage/usageStatsCollector.ts` | 1 | 176 | 匿名统计、隐私保护 |

**测试覆盖**：11/12 个 controller 有测试文件（contextAwareness / patternDetector / proactiveEngine / presenceController / affectController / rapportController / memoryController / personaController / perceptionCoordinator / reviewManager / memoryHealth），缺 `cli/` 和 `usage/` 测试。

---

## 2. 模块评分

| 模块 | 评分 | 说明 |
|------|------|------|
| **PerceptionCoordinator** | **9.0/10** | 协调器设计范本：纯编排层无业务逻辑，读/写路径分离，单点抛错不阻塞，回调注入解耦 |
| **PresenceController** | **9.0/10** | 依赖注入典范：`IPowerMonitor`/`IApp` 接口抽象，`stop()` 手动注销监听器，`debounce` 防误触，幂等保护完善 |
| **AffectController** | **8.5/10** | 四维情感算法清晰，EWMA 平滑设计合理，冷启动 `applyDelta` vs 常规 `blendAffect` 区分明确 |
| **RapportController** | **8.5/10** | 信任度/熟悉度公式合理，加权合成清晰，与 `MemoryController.rapportLevel()` 自觉区分（统计 vs 行为） |
| **ContextAwareness** | **8.0/10** | 节奏/连贯性/深度三轴推导直观，`buildContextPrompt` 策略指导具体可用 |
| **PatternDetector** | **7.5/10** | 三种模式类型覆盖全面，但中文分词用简单字符切分，重复主题检测无 TF-IDF 加权 |
| **ProactiveEngine** | **7.5/10** | 事件累积+冷却+自适应+里程碑+模式注入，功能完整；但 17 个字段状态复杂，`buildSuffix` 硬编码随机文案 |
| **MemoryController** | **7.0/10** | 功能最全但职责过重：CRUD + 仪表盘 + 默契度 + 关系图谱 + 健康度 + 回顾 + LLM 治理，806 行 |
| **reviewManager** | **8.0/10** | 纯函数模块，趋势判断用前后半对比法简单有效 |
| **memoryHealth** | **8.0/10** | 纯函数模块，Jaccard 相似度 + 三重检测 + 三维评分，算法选型合理 |
| **PersonaController** | **6.0/10** | 67 行薄层封装，仅做 `agent.persona` 透传，存在价值存疑 |
| **auditManager** | **8.0/10** | 审计闭环简洁，`JsonlAppender` 提取为公共基础设施，sessionId 分段设计好 |
| **jsonlAppender** | **8.5/10** | 写入链串行化防竞态，间隔截断避免 O(n) 写放大，ENOENT 与真实 IO 错分级处理 |
| **cli/formatter** | **7.5/10** | 纯函数，职责清晰，但硬编码了 CLI 显示格式 |
| **cli/interaction** | **7.5/10** | 实现 `IInteraction` 接口，可替换设计好，但依赖 `process.stdin` 不可注入 |
| **usageStatsCollector** | **8.0/10** | 匿名统计设计合理，定时批量写入 + 退出写入，`enabled` 开关控制全局 |

**综合评分**：**8.0/10**（感知栈设计优秀，MemoryController 职责过重拉低均分）

---

## 3. 问题清单

### 3.1 P1（高优先级，建议修复）

#### P1-1. MemoryController 是"上帝 controller"，职责过重

**描述**：`MemoryController`（806 行）承载了 8 类职责：CRUD、仪表盘、默契度评估、关系图谱、健康度、回顾、LLM 治理、向量搜索。其中健康度（`buildHealthDashboard`）和回顾（`buildReviewData`）已提取为独立纯函数模块，但调用入口仍在 MemoryController 上，使其成为"超级委托者"。`rapportLevel()` 更是与 `RapportController` 形成功能重叠（见 P1-2）。

**位置**：
- `memoryController.ts:146-806` — 8 类职责集中在一个类

**修复建议**：
1. 将 `getHealthDashboard()` 委托给 `HealthDashboardProvider` 接口（当前 `buildHealthDashboard` 已是纯函数，只需在 MemoryController 上改为委托调用即可，无需重构）
2. 将 `getReviewData()` 同理委托
3. 将 `rapportLevel()` 标记为 `@deprecated`，引导调用方使用 `RapportController.deriveRapport()`
4. 长期：拆分出 `MemoryDashboardController` 和 `MemoryGovernanceController`，各司其职

#### P1-2. `rapportLevel()` 与 `RapportController` 功能重叠

**描述**：`MemoryController.rapportLevel()`（统计驱动：计数阈值）和 `RapportController.deriveRapport()`（行为驱动：信任度/熟悉度加权）都输出 `RapportLevel` 等级，但计算逻辑完全不同。前者定义在 `memoryController.ts` 中，后者定义在 `rapportController.ts` 中。两者类型定义共享但计算路径独立，新开发者不易理解该用哪个。

**位置**：
- `memoryController.ts:589-637` — `rapportLevel()` 统计型
- `rapportController.ts:110-132` — `deriveRapport()` 行为型

**修复建议**：在 `RapportController` 文件头部增加"与 MemoryController.rapportLevel() 的关系"文档（已有注释但不够显眼），并在 `rapportLevel()` 方法上标注 `@deprecated Use RapportController.deriveRapport() for behavioral signal-based rapport`。确认所有调用方后逐步迁移。

#### P1-3. `ProactiveEngine` 状态字段过多（17 个），缺乏状态快照

**描述**：`ProactiveEngine` 持有 17 个实例字段，涵盖配置、事件队列、感知状态、里程碑幂等、模式幂等、持久化回调、统计计数。其中 `contextState`/`rapportLevel`/`affectState`/`detectedPatterns` 四个字段由 `PerceptionCoordinator` 通过 setter 注入，但 `ProactiveEngine` 自身也在 `tryEmit` 中消费这些字段，构成"被动注入 + 主动消费"的混合模式。状态复杂度已超过单类舒适区。

**位置**：
- `proactiveEngine.ts:86-134` — 17 个字段声明

**修复建议**：
1. 提取 `ProactiveState` 值对象，将 `contextState`/`rapportLevel`/`affectState`/`detectedPatterns` 封装为 `PerceptionContext`
2. 将 `suggestCount`/`acceptCount`/`consecutiveRejects`/`lastRejectAt` 封装为 `FeedbackState`
3. `injectPatternNotices` 和 `promptedPatterns` 可提取为 `PatternPromptManager`

### 3.2 P2（中优先级，可在下个迭代修复）

#### P2-1. PatternDetector 中文分词策略过于简陋

**描述**：`extractKeywords()` 使用 `split(/[\s,，。.!！?？;；:：、""''（）()【】\[\]《》<>\/\\|@#$%^&*+=~`]+/)` 按标点切分后过滤停用词。这种策略对中文分词精度有限——例如"机器学习"会被切成一个整体（因为没有内部标点），但"我喜欢机器学习"中的"喜欢"和"机器学习"无法正确分离。对于"重复主题检测"场景，当前精度可能可接受，但"知识缺口检测"中的问题提取（取前 30 字符）可能截断关键信息。

**位置**：
- `patternDetector.ts:336-357` — `extractKeywords()`
- `patternDetector.ts:245-248` — 问题文本截取 `slice(0, 30)`

**修复建议**：
1. 问题文本截取：用 `slice(0, 30)` 替代 `slice(0, 30)` 可能截断中文字符，建议改为按字符数截断（`[...content].slice(0, 30).join('')`）
2. 关键词提取：当前精度对"重复主题检测"场景可接受，暂不引入分词库（保持零依赖）。在文件注释中标注当前精度边界

#### P2-2. `getSnapshot()` 有副作用，名义上是读路径

**描述**：`PerceptionCoordinator.getSnapshot()` 文档自称"读路径，不修改 Coordinator 自身状态"，但实际调用了 `this.opts.affectController.updateOptions()` 和 `this.opts.rapportController.updateOptions()`，修改了子控制器的内部状态。虽然未修改 `PerceptionCoordinator` 的 `lastAffect`/`lastRapport` 缓存，但"读路径"的语义约定被打破——调用方无法安全地并发调用 `getSnapshot()`。

**位置**：
- `perceptionCoordinator.ts:180-226` — `getSnapshot()`
- 其中 `affectController.updateOptions()`（L195）和 `rapportController.updateOptions()`（L211）有副作用

**修复建议**：在 `getSnapshot()` 文档注释中明确标注"会刷新子控制器配置（`updateOptions`），但不会修改 Coordinator 自身缓存"。或为 `AffectController`/`RapportController` 增加 `deriveAffect(memories, options)` 重载，将配置作为参数传入而非修改内部状态。

#### P2-3. `PersonaController` 薄层封装价值存疑

**描述**：`PersonaController`（67 行）仅做 `agent.persona` 的透传封装：`list()` → `pm.list.map()`、`activeName` → `pm.activeName`、`setMode()` → `pm.setMode()`。未增加任何业务逻辑或校验。若未来不计划在此层增加逻辑（如角色切换审计、权限校验），当前封装纯属间接层开销。

**位置**：
- `personaController.ts:25-67` — 整个类

**修复建议**：保留当前形态，但在类注释中明确声明"当前为薄层封装，预留角色切换审计/权限校验等扩展点"。若 3 个月内无新增逻辑，考虑下沉为 `agent.persona` 的直接调用。

#### P2-4. CLI `interaction.ts` 依赖 `process.stdin` 不可注入

**描述**：`CliInteraction` 在 `start()` 中直接 `createInterface({ input: process.stdin, output: process.stdout })`，不可注入。这使得单元测试无法替换 I/O 流，只能通过 mock `process.stdin` 做集成测试。

**位置**：
- `cli/interaction.ts:23` — `createInterface({ input: process.stdin, output: process.stdout })`

**修复建议**：在构造函数中接收 `input: NodeJS.ReadableStream` 和 `output: NodeJS.WritableStream`，默认值为 `process.stdin`/`process.stdout`。

#### P2-5. `ProactiveEngine.buildSuffix()` 硬编码随机文案

**描述**：`buildSuffix()` 中定义了 3 套语气文案（调皮/温暖/默认），通过 `Math.random()` 随机选择。这导致相同情感状态下生成的提示文本不一致，不利于测试断言和用户体验一致性。随机选择也可能导致男/女频用语不匹配（如"施展整理魔法吗？✨"偏女性化）。

**位置**：
- `proactiveEngine.ts:670-701` — `buildSuffix()`

**修复建议**：改为基于 `affect.playfulness` 的具体值做确定性选择（如 `playfulness >= 0.85` 用幽默文案 A，`0.67-0.85` 用文案 B），移除 `Math.random()`。文案中的 emoji 也需评估是否与 persona 风格一致。

### 3.3 P3（低优先级，可归档）

#### P3-1. `reviewManager` 和 `memoryHealth` 不是"controller"但放在 controllers 目录

**描述**：`reviewManager.ts` 和 `memoryHealth.ts` 是纯函数模块（导出 `buildReviewData` 和 `buildHealthDashboard`），不持有状态、不实现类、不符合"controller"命名惯例。放在 `controllers/` 目录下容易让人误以为它们是可实例化的控制器。

**位置**：
- `controllers/reviewManager.ts` — 纯函数模块
- `controllers/memoryHealth.ts` — 纯函数模块

**修复建议**：可归档，当前目录结构已有足够注释说明。若未来 controllers 目录膨胀，可考虑创建 `controllers/analytics/` 子目录收纳纯计算模块。

#### P3-2. `MemoryController` 中 `RAPPORT_THRESHOLD_*` 常量与 `RapportController` 的阈值常量各自独立

**描述**：`MemoryController` 定义了 `RAPPORT_THRESHOLD_TOTAL_STRANGER = 5` 等三级阈值，`RapportController` 定义了 `ACCEPTANCE_RATE_FOR_FULL_TRUST = 0.8` 等不同维度阈值。两者都是默契度相关但计算模型不同，常量命名空间各自独立。当后续需要统一调参时，需要跨两个文件修改。

**位置**：
- `memoryController.ts:33-37` — RAPPORT_THRESHOLD_*
- `rapportController.ts:58-67` — ACCEPTANCE_RATE_FOR_FULL_TRUST 等

**修复建议**：可归档。两者计算模型不同，强行合并常量反而混淆。当前各文件内部注释已标注"经验值，后续校准"。

#### P3-3. `usageStatsCollector` 的 `load()` 合并策略是"累加"而非"覆盖"

**描述**：`load()` 从文件读取历史快照后，将计数累加到内存计数器。这意味着如果文件被外部修改（如手动编辑 JSON），累加可能导致计数虚高。当前设计假设"文件仅由本 Collector 写入"，但缺乏文档说明。

**位置**：
- `usageStatsCollector.ts:137-161` — `load()` 合并逻辑

**修复建议**：在 `load()` 方法注释中标注"采用累加策略，假设文件仅由本 Collector 写入，外部修改会导致计数不准确"。

---

## 4. 设计评价

### 4.1 亮点

1. **感知栈架构设计优秀**：`PerceptionCoordinator` 统一编排 4 个感知控制器，读/写路径分离（`refreshBeforeChat` 写路径 vs `getSnapshot` 读路径），单点抛错不阻塞其他推导。这是教科书级别的协调器模式。

2. **依赖注入实践出色**：`PresenceController` 通过 `IPowerMonitor`/`IApp` 接口完全解耦 Electron 依赖，测试时注入 mock 即可。`ProactiveEngine` 的 emitter/persistCallback/milestoneCallback 通过 setter 注入，避免构造器膨胀。

3. **纯函数模块化**：`reviewManager` 和 `memoryHealth` 作为纯函数模块，零副作用，零状态，可独立测试。`buildHealthDashboard(buildReviewData(...))` 调用链清晰。

4. **错误隔离设计**：`PerceptionCoordinator.refreshBeforeChat()` 中 6 个推导步骤各自 `try/catch`，单个失败不阻塞其他注入。`PresenceController.onWelcomeBack` 回调失败不影响 `checkPending`。`jsonlAppender` 写入链中单个写入失败恢复链为 resolved。

5. **自适应冷却算法**：`ProactiveEngine` 的冷却时间 = `baseCooldown × (1 - rapportLevel × 0.5) × (1 + consecutiveRejects × 0.5)`，同时结合时间衰减（24h 自动 -1），破解"连续拒绝死锁"。

6. **情感算法分层清晰**：`AffectController` 区分了长期情感（`deriveAffect` 从记忆统计）和实时语气（`deriveAffectFromMessages` 从关键词），冷启动用 `applyDelta`（直接生效），常规用 `blendAffect`（EWMA 平滑）。分层合理。

### 4.2 架构问题

1. **MemoryController 职责过重**：806 行、8 类职责，是 controllers 目录中唯一的"上帝对象"。虽然部分功能已提取为纯函数（`reviewManager`/`memoryHealth`），但调用入口仍在 MemoryController 上，形成"超级委托者"模式。

2. **rapportLevel 双重实现**：`MemoryController.rapportLevel()`（统计型）和 `RapportController.deriveRapport()`（行为型）共存，新开发者需要理解两者差异才能正确选择。

3. **ProactiveEngine 状态复杂度**：17 个字段、4 个 setter 注入、3 个回调注入。虽然功能完整，但状态管理已接近单类舒适区上限。

### 4.3 通信模式总结

```
Sprite (main orchestrator)
  ├── MemoryController ←→ agent.memory (CRUD + dashboard)
  ├── PersonaController ←→ agent.persona (thin wrapper)
  ├── ProactiveEngine ← setter注入 ← PerceptionCoordinator
  │   ├── setContextState() ← contextAwareness.deriveContext()
  │   ├── setRapportLevel() ← rapportController.deriveRapport()
  │   ├── setAffectState() ← affectController.deriveAffect()
  │   └── setPatterns() ← patternDetector.detectPatterns()
  ├── PerceptionCoordinator (协调器)
  │   ├── AffectController (四维情感)
  │   ├── RapportController (信任度/熟悉度)
  │   ├── ContextAwareness (节奏/连贯性/深度)
  │   └── PatternDetector (重复主题/知识缺口/兴趣漂移)
  ├── PresenceController ← powerMonitor + app (依赖注入)
  │   └── → ProactiveEngine.checkPending() (用户回来时)
  └── reviewManager / memoryHealth (纯函数，由 MemoryController 调用)
```

**通信方式**：
- **直接调用**：Sprite → MemoryController/PersonaController 方法调用
- **Setter 注入**：PerceptionCoordinator → ProactiveEngine（上下文/状态推送）
- **事件发射**：PerceptionCoordinator → Sprite → UI（affectUpdated/rapportUpdated/contextUpdated/patternsUpdated）
- **回调注入**：ProactiveEngine → Sprite（proactivePrompt 事件）
- **纯函数调用**：MemoryController → reviewManager/memoryHealth

**未发现**：controller 之间的直接相互调用（绕过 Sprite）、全局状态共享、事件总线滥用。

### 4.4 与 Agent 门面的交互

所有 controller 通过 `agent.memory`（MemoryInspector）/ `agent.persona`（PersonaManager）/ `agent.injectAffect()` / `agent.getMetrics()` 等公共 API 访问内核，未发现绕过门面直接访问内核内部模块的情况。符合 ADR 分层规范。

---

## 5. 修复建议汇总

| 编号 | 优先级 | 问题 | 建议动作 | 预计改动量 |
|------|--------|------|----------|-----------|
| P1-1 | 高 | MemoryController 职责过重 | 委托 health/review 调用，标记 rapportLevel 为 deprecated | ~30 行 |
| P1-2 | 高 | rapportLevel 双重实现 | 补充文档，标记 deprecated，逐步迁移调用方 | ~10 行 |
| P1-3 | 高 | ProactiveEngine 状态复杂 | 提取 PerceptionContext 和 FeedbackState 值对象 | ~80 行 |
| P2-1 | 中 | PatternDetector 中文分词简陋 | 修复字符截断问题，标注精度边界 | ~5 行 |
| P2-2 | 中 | getSnapshot 有副作用 | 补充文档注释，明确"刷新子控制器配置" | ~5 行 |
| P2-3 | 中 | PersonaController 薄层 | 补充扩展点注释，设 3 个月观察期 | ~5 行 |
| P2-4 | 中 | CliInteraction 不可注入 | 构造器接收可选的 input/output 流 | ~10 行 |
| P2-5 | 中 | buildSuffix 随机文案 | 改为确定性选择，评估 emoji 一致性 | ~15 行 |
| P3-1 | 低 | 纯函数模块放 controllers 目录 | 可归档，注释已足够 | 0 行 |
| P3-2 | 低 | 阈值常量命名空间独立 | 可归档，计算模型不同 | 0 行 |
| P3-3 | 低 | usageStatsCollector load 合并策略 | 补充文档注释 | ~3 行 |

---

## 6. 后续步骤

- **Step 5**：Sprite Web 服务层（`src/web/` 路由 + 中间件 + 静态资源）
- **建议在 Step 5 前**：P1-1（MemoryController 职责拆分）和 P1-2（rapportLevel deprecated）是架构级改进，建议在后续 step 中逐步修复，不阻塞当前审查流程