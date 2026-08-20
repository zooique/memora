# Changelog

本文件记录 @zooique/memora 的版本变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> **正式首发说明**：`3.0.0` 为 @zooique/memora 的正式首发版本。npm 上早于 3.0.0 的所有版本（2.1.0 及以下）均为早期试验版，已作废（安装即警告），API 与结构以 3.0.0 为准。

## [3.0.0] - 2026-08-20

### Added（外部世界工具族：`web_fetch` 搜索→抓取闭环 + `run_code` 通用代码执行）

源自工具面盘点（tool-surface-roadmap.md）：`web_search` 只搜不抓、通用计算缺失。沿既有范式（接口注入 + 条件性暴露 + 降级优先 + 零依赖边界）补齐两个「连接外部世界」的条件工具。

- **网页抓取（`src/web-fetch/`）**：`IFetchProvider` 接口（与 `IWebSearchProvider` 同构）；`FetchWebFetchProvider` 零依赖默认实现（内置 fetch + 正则清洗 HTML + `<title>` 提取 + maxChars 截断）；`safeFetch` 30s 超时保护包装（失败/超时降级友好提示，不中断主流程）
- **代码执行（`src/code-exec/`）**：`ICodeExecutionProvider` 接口（沙箱完全由宿主 provider 决定，内核零运行时依赖）；`safeExecuteCode` 120s 超时保护包装（失败/超时降级返回错误结果）
- **工具集成（`agent/builtinTools.ts` + `toolExecutor.ts`）**：新增 `WEB_FETCH_TOOL` / `RUN_CODE_TOOL` 定义 + 幂等标记（web_fetch=idempotent，run_code=non-idempotent）；条件性暴露（注入 provider 才进入 LLM 工具面）；执行分支含 URL 协议白名单 / 长度上限 / 结果净化 / 三态格式化
- **注入链打通**：`AgentOptions.fetchProvider` / `codeExecutionProvider` 经 `assembler.ts` → `agent.ts` → `index.ts` 导出（接口 + 默认实现 + safe 包装）
- **能力映射**：`capabilityMap` 新增 `web:fetch` → web_fetch、`code:execute` → run_code
- **文档收口**：api-reference（注入接口 / AgentOptions / 内置工具表 / §8.4-8.5 / 类型导出）、接入指南（§4.5 外部世界工具注入）、module-inventory（§3.5）、README（核心能力 + 示例角色包随包）
- **测试**：新增 7 组（provider 纯函数 × 2、默认实现解析 × 1、工具定义 × 2、条件暴露/执行/冲突 × 2、capability 映射 × 2），含本次 web-fetch/code-exec 共 130 用例全绿

> 非破坏性变更：未注入 provider 时工具不暴露（零依赖边界保持）；`run_code` 沙箱隔离等级由宿主 provider 决定，接入前需评估安全边界。

### Added（结构化信息保真 + 提炼侧视角下沉：`summaryFocus` 提炼视角机制）

源自 LLM 视角 memora-as-agent 体感评估 P1 缺口「结构化信息保真」 + P2「提炼侧视角对齐」——代码/diff/表格等结构化信息经 round-summary 浓缩后保真度低，且提炼侧「值得记什么」仍为通用视角。沿内核哲学（领域无关 + 角色包插卡）落地的通用机制，让角色包声明「摘要提炼的视角（判断维度 + 结构保留形式）」。

- **内核机制（`role-pack/types.ts`）**：`PrepareStrategy` 新增可选 `summaryFocus`（角色包提炼视角）；新增 `resolveSummaryFocus` 解析函数（合法非空字符串采用、缺失/空白归位 undefined=通用浓缩）
- **摘要参数化（`roundSummaryGenerator.ts`）**：拆出 `SUMMARY_JSON_CONTRACT`（JSON 输出 + SummaryType 硬契约，角色包不可替换，写路径 metadata 稳定）与 `DEFAULT_SUMMARY_PERSPECTIVE`（通用"意图/回答/决策"归纳）；`generate` 第 5 参 `focus` 存在时以角色包提炼视角**替换**通用视角；缺省时逐字节零回归
- **装配接线（`agent.ts`）**：postProcess 注入激活角色包的 `summaryFocus`（`resolveSummaryFocus(this.getActiveStrategy())`）
- **验证器（`validator.ts`）**：`STRATEGY_KEY_RULES.prepare` 注册 `summaryFocus`（非空字符串校验），避免角色包声明产生未知键警告
- **角色包消费者**：示例库 `代码助手`、两库 `方案设计师` 声明完整提炼视角（判断维度 + 结构保留，首个消费者，尚未触发「≥2 处复用」机制化提炼）

> 非破坏性变更：内核零领域特化（提炼视角内容全由角色包提供，未 hardcode 代码/表格）；角色包未声明 `summaryFocus` 时摘要输出与升级前逐字节一致；typecheck + 全量测试通过。

### Added（插件 MVP：方案设计师 showcase 体验——空状态示例提问随角色特化）

插件 MVP 落地——让用户能通过插件一键体验 memora 最吸引人的设计魅力。审查插件与 memora 内核对齐情况后，聚焦「方案设计师 showcase」体验：把空状态示例提问从"文档打磨通用引导"升级为"随 showcase 角色动态渲染"，新用户切到方案设计师时，首屏即见「种子收敛」引导示例。

- **空状态示例提问动态化（chatView.ts）**：新增 `ROLE_SUGGESTION_SETS`（SSOT 映射，key=角色显示名）+ `DEFAULT_SUGGESTIONS` 通用回退；`renderEmptySuggestions(name)` 按激活角色渲染示例 chips——方案设计师展示「设计知识库 / 设计记忆系统 / 找最小单元」种子收敛引导，其余角色回退「审阅架构 / 精简表达 / 对齐实现」通用打磨引导
- **示例容器改造（chatPanel.ts）**：`#emptySuggestions` 从静态三个 chip 改为空容器，由脚本填充；HTML 注释同步更新
- **事件委托**：chips 点击改为 document 级委托，兼容动态渲染新增元素（dropdown 同类惯例）
- **测试**：chatView.test.ts 新增 showcase 特化用例（方案设计师专属 / 非 showcase 回退通用），测试骨架补 `#emptySuggestions` 容器

> 非破坏性变更：仅插件 UI 层空状态引导演进，内核与角色包内容零改动；插件 typecheck / 66 测试 / esbuild 构建（webview 打包）全通过。

### Added（方案设计师角色包：memora 设计哲学沉淀为可复用装载卡）

把 memora 的设计哲学（单一真理源 · 最小单元 · 网络为土壤）抽象为可复用的角色包「方案设计师」，供新开项目方案时直接装载复用——基于 `.trae/rules/` 的 `single-truth-source-mindset` / `network-soil-mindset` / `architecture_philosophy_rules` 提炼为 LLM 可执行的设计指令。

- **persona.md**：定位「从模糊想法设计自洽项目方案的顾问」，承载种子（最小单元锚点）/ 土壤（网络信息养分）两条设计主线
- **rules.md**：设计指令——先搜索再构思、种子定位、SSOT、最小单元解题、识别补丁思维、外部方案种子过滤、搜索结论进入决策、记录来源、种子收敛交互、产出结构、SSOT 三问收敛自检、不越界生成骨架
- **manifest.skills**：声明 `file:read` / `file:write` / `web:search` / `memory:recall` / `llm:summarize` 五个可调用能力，让角色能真正「先搜索再构思」、读写方案文档
- **落地**：插件生产库（`hosts/memora-vscode/src/extension/role-packs/方案设计师/`，随 VSIX 分发）+ 根示例库（`role-packs/方案设计师/`，参考指引），两包 manifest 均通过标准校验（`validateManifestText` valid=true）

> 非破坏性变更：纯新增角色包，内核零改动；新增包经 validator 校验合规，全量测试无回归。

### Added（方案设计师：种子收敛交互引导）

设计评审收敛——最小单元（种子）藏在用户业务里，LLM 无法凭空替用户定义，故把角色包从"被动澄清"升级为"主动引导用户收敛种子"的交互方法论（承载于 persona.md + rules.md，非工具能力）。

- **persona.md 新增「种子收敛交互」章节**：收敛五步——问最小闭环（一次触发→处理→输出）→ 问边界（谁触发/给谁用）→ 问不可再拆 → 问三性（自足/可重复/可观察）→ 复述确认；拿到用户确认的种子前不急于设计
- **核心能力「种子识别」→「种子引导收敛」**：从"替用户提炼"改为"引导用户自己收敛"
- **rules.md「主动澄清」→「种子收敛交互」**：设计前先收敛种子，不替用户定义；用户明确拒绝探讨时，提示"种子未锁定可能返工"并按指示继续
- 两库（生产 + 示例）persona.md / rules.md 同步更新；manifest 未变

> 非破坏性变更：仅角色包内容演进，内核与 manifest 零改动。

### Added（召回互斥前置过滤：跨会话记忆补位 top-limit）

基于设计评审（recall-mutex-pre-filter）落地——把"召回后互斥排除"改为"recall 内取 limit 前过滤"，修复单会话聚焦时跨会话记忆被挤出 top-limit 的缺陷，补齐新会话 0 上下文时召回最近摘要的自然行为（memory-as-summary §4.3）。

- **`recall` 新增 `excludeRoundIds` 选项**：在 `hybridMerge` 排序取 limit **前**过滤命中集合的 round-summary，让跨会话/更早轮次记忆补位；保底补足同样应用该过滤，避免把正文已加载的摘要补回（重复注入）
- **`agent.ts` 移除后置互斥过滤块**：`recallAndInject` 把 `getRecentRoundIds(recentRounds)` 结果作为 `excludeRoundIds` 传入 recall()，去重职责收敛到 recall 一处（SSOT）
- **向后兼容**：`excludeRoundIds` 缺省为空集合，纯检索调用方（multiHop、memoryInspector 等）行为完全不变

> 非破坏性变更：仅新增可选参数；去重语义等价（同一 roundId 集合、同一 N 来源 `resolveRecentRounds`），跨会话召回能力修复。

### Added（建议B落地："模型看到了什么"的指纹可追溯）

基于 Harness 排雷评估（harness-borrowing-assessment 建议B），落地可观测性指纹埋点——记录"模型看到了什么"的指纹 hash，**不记录全量内容、不入 sessionStore**（memory-as-summary §5.2.1 可追溯性边界）。

- **新增 `sha256Fingerprint`**：`src/utils/hash.ts` 通用 SHA-256 指纹纯函数，并复用于 `workProjection.ts`（消除重复 createHash 实现）
- **`llm.call` span 补 `systemPromptHash`**：最终发给模型的全部 system 消息内容指纹（loop.ts LLM_CALL 埋点）
- **`recall.recall` span 补 `attachedMemoryCount` / `attachedMemoryFingerprint`**：附着进上下文的记忆条数与 ID 集合指纹（loop.ts 记忆注入点埋点）
- **零开销边界**：宿主未注入 Tracer（NOOP）时不计算指纹；span 属性由宿主自行采集/落盘/展示（机制/策略分离）

> 非破坏性变更：仅新增 span 属性与工具函数，无公共 API 变更。

### Added（召回保底：兜底最近记忆，保证每轮记忆下限）

基于会话冷启动评估收敛（放弃独立"固定注入摘要"、信任 recall）后的落地补充——当语义召回结果不足时，用最近记忆补足，避免"零召回/极少召回"导致 LLM 完全无记忆可依（memory-as-summary §4.7）。

- **`recall` 新增 `minFallback` 选项**：语义召回结果少于阈值时，经 `storage.search('', n)` 空查询通道按 score 降序补足最近记忆；补足项排语义命中之后、与主流程同过滤（excludeSources + 差异化时间窗口 + 去 superseded）；置 0 彻底关闭
- **角色包 `prepare.minFallback`**：宿主可配置召回保底下限，非法/缺失回退内核默认 2；`resolveMinFallback` SSOT 归位
- **`DEFAULT_MIN_FALLBACK` 下沉 `utils/recallDefaults.ts`**：跨 role-pack 与 memory 共享同一默认值（SSOT 单一来源）

> 非破坏性变更：仅新增可选参数与配置维度，默认值 2 保持原有召回行为，无公共 API 破坏。

### Removed（洞察层移除，记忆收敛为 round-summary 单轨）

基于"摘要即记忆"架构定案（memory-as-summary §七 最终形态），移除独立洞察提炼层——其能力被 round-summary 的 type 分类吸收，记忆收敛为单一存储层。同时移除用户画像层（已收敛为 `type=preference` 差异化召回）。

- **移除 InsightExtractor 自动抽取**：`src/agent/managers/insightExtractor.ts` 删除，`assembler` 不再装配，`Agent.archiveInsight()` / `insight` getter 删除
- **移除 `insightExtracted` 事件**：不再有发射方，从 `AGENT_EVENTS` 与 `AgentEventMap` 清除
- **`archiveFailed.stage` 收敛为 `'content'`**：原 `'insight' | 'content'`，洞察阶段移除后仅剩 content
- **`ArchiveMode` 三态收敛为二态 `'full' | 'manual'`**：原 `'insights-only'`（仅洞察自动）因洞察移除失去语义，与 `manual` 等价，一并移除
- **memoryAdded 事件出口迁移**：由 RoundSummaryGenerator 在 round-summary 写入后发射（`setOnMemoryAdded`），替代原洞察层"已沉淀"通知
- **SessionArchiver（content 会话归档）保留**：非洞察，承载会话级综合提炼，粒度（会话级）与 round-summary（轮次级）不同

> ⚠️ **破坏性变更**：移除 `ArchiveMode` 的 `'insights-only'` 值与 `insightExtracted` 事件。宿主若使用需适配（sprite 适配另行处理）。

### Changed（架构文档排雷：角色包优先级后置）

基于架构交叉审查（agent-design-philosophy / memory-as-summary / role-pack-spec / mvp-scope），确立**角色包优先级后置于内核基础**（问答闭环 + 记忆系统），并解除基础模块对未定型角色包键的耦合——避免角色包接口随基础演进反复横跳。纯文档/架构层变更，无公共 API 变更。

- **记忆模块解耦**：互斥窗口 N 改由内核上下文装配提供默认值，角色包 `recentRounds` 仅作后置可覆盖项（memory-as-summary §4.3），记忆模块不再依赖草案键即可独立运行
- **召回开关 × type 差异化**：新增 §4.2.1 明确角色包召回开关（memoryRecall/summaryRecall，角色级总开关）与 type 差异化召回（召回内策略）的两层协作语义
- **配额分层**：§6.5 补记忆/摘要 token 配额分层约束
- **§14.3 定位澄清**：明确为 memora 内部设计全景，是否入标准由角色包标准双闸门裁决（避免僵尸键）
- **主动提问定位**：§14.3 全局策略补 `askOn/askLimit`，统一"理解确认/用户追问/askOn"命名关系
- **标准滞后修正**：`reflect.insightExtraction` 标注为兼容键（独立洞察层已随"记忆即摘要"移除）
- **标准演进状态**：role-pack-spec 声明处草案演进期，v1 字段冻结延后至基础定型
- **MVP 对齐**：角色包样例重写为 spec §2.3 标准格式；记忆措辞对齐"摘要即记忆"；补记忆跨任务验收项；temperature 改为不承诺随包生效

第二轮质量审查（对齐设计哲学 + 2026 行业）排雷落地——纯文档/架构层变更：

- **记忆维护取舍声明**（memory-as-summary §5.4）：显式声明 append-only 模型将"重复/冲突/过期"交 LLM 时间序聚合是有意取舍，type 分层作确定性兜底；记忆维护列为远期锚点（在闭环后处理内生长，不引入 merge/supersede 状态机）
- **检索侧补写**（memory-as-summary §4.7）：rerank / 同窗口优先对齐实现；query 改写等标远期不预埋
- **自审查轮定义**（mvp-scope §三·一）：判据绑定外部确定性验证信号，防纯 LLM 自审的"自说自话"
- **可观察契约**（agent-design-philosophy §13.x）：闭环"可观察"固有属性产品化为"内核产活动事件、宿主渲染"，守零依赖内核边界

第三轮对抗性审查（第一性原理 + SSOT 自检）排雷落地——纯文档/架构层变更：

- **G2 写路径取代检测**（memory-as-summary §5.4）：记忆冲突消解从"读时靠 LLM 时间序猜"改为"写时定"——闭环后处理生成摘要时检测同类覆盖，给旧摘要打确定性 `superseded` 标记；SSOT 自检通过（不新增存储/系统/关系图，效率挪移）
- **G5 结构化提问事件**（mvp-scope §三 / philosophy §13.x / §14.3）：LLM 以 `[ASK]` 结构化输出 → 内核确定性解析为 `question_pending` 事件，消除"避免启发式却靠宿主猜文本"的逻辑矛盾；为活动事件流落地首个真实用例
- **G4 对话记录定位统一**（memory-as-summary §5.2）：从"展示层"改为"展示层 + 溯源兜底的运行依赖"，消除定位分裂
- **G1 摘要保真声明**（§5.4）：摘要是"有损线索"，保真由 traceSummary 兜底，诚实声明
- **G3 串行边界声明**（philosophy §13）：串行是单 Agent 阶段刻意约束，非普适真理，化解与多 Agent 愿景的张力
- **G6 角色包差异化天花板**（role-pack-spec §三 L2）：声明 L2 枚举只承诺行为参数，价值分层 = L1 专业性 / L2 行为偏好 / L3 能力扩展
- **G9 删 Trigger 三元组预埋**（philosophy §2.1）：删除 `{意图,载荷}` 预埋字段，保留扩展性说明，遵守"不预埋接口"
- **G0 三阶段措辞**（philosophy §1.2）：明确三阶段是"经验证的合理划分"而非"公理必然"

第四轮质量审查（安全 / 可观测 / 2026 生态）排雷落地——纯文档/架构层变更：

- **H1 信任边界**（philosophy §6.3）：装配区分信任等级——召回/工具结果是 untrusted data、保持来源标记，system prompt 只由高信任源构成，防间接注入/记忆投毒
- **H3 评估视角**（philosophy §13.x，远期）：事件流承载 run/session 两级轨迹可回放，结合自审查轮验证信号导出回归用例；复用已有组件，不引入独立评估引擎
- **H2 角色包安全审计**（role-pack-spec §七）：确立"安全审计是角色包发布前提"硬门槛（行业实证 36% 注入），当前声明、远期实现

第五轮排雷落地（梁文锋视角对抗审查 → 真实代码核实）——ADR-023 + 设计文档更新：

- **C1 摘要成本重构**（philosophy §12.2 / ADR-023）：修正"截断时现调 LLM"实现缺口——截断优先取用 round-summary、保留更多原始对话靠 prompt cache、摘要生成退出关键路径
- **C2 即时注入防御**（philosophy §6.3 / ADR-023）：工具结果 `<tool_result>` 隔离包裹 + 参数校验 + 返回净化，防间接注入
- **C3 loop 收敛方向**（ADR-023）：解耦 UI/可观测/外围策略，让最小闭环（调 LLM→路由→循环）渐进可见

SSOT 第三轮排雷：15 项契约/一致性缺陷清零，无公共 API 变更（内部修复）。

### Fixed（修复）

- **执行流单一收口**：`processEvent` / `executeChatLoop` / `resumeExecution` 统一走 `consumeExecutionStream`，清理放 finally；修复 async generator 被 `void` 调用导致函数体不执行（跨进程边界断裂）（T0-1）
- **门面等宽**：`Agent.pause` 透传 `lowRisk`，连续暂停计数不再误计；`requestPause` 空闲态立即翻转、流中延迟翻转两端对称（T0-2 / T1-1 / T2-8）
- **状态恢复强制归零**：`restoreFromCheckpoint` 统一 `resetToRunning()`，检查点与状态机不再分叉（T0-3）
- **checkpoint schema 版本化**：`CURRENT_SCHEMA_VERSION` 写入/比对（T1-4）
- **暂停超时信息事件化**：`sessionPauseTimedOut` 载荷携带 sessionId/date/session（T1-2）
- **计划步骤状态唯一写点**：`completeRound` 改走 `updatePlanStepStatus`，消灭旁路直改（T2-1）
- **暂停元数据时序修正**：`setPauseMeta` 首轮 checkpoint 兜底，注释纠正 onPaused 先于 pause()（T2-6）
- **配置建议重建复活**：`confirmConfigSuggestion` upsert 前 restore 同名软删记忆 + name 白名单堵路径穿越（T2-4）
- **暂停起点与心跳解耦**：新增 `checkpoint.pausedAt`，暂停后 touchCheckpoint 刷新不再推迟超时判定（T2-2）
- **孤儿向量清理**：`writePurge` / `writePurgeExpired` 同步清理 vectorStore，消除 30 天自动清理后的孤儿向量（T2-5）

### Removed（移除）

- 零注册的 `onBootstrapSyncFailed` 死回调（失败可观测性由 logger.warn 承担）（T2-3）
- `SessionStateMachine.onEvent` 空壳与失效注释（T2-7）

### Internal（内部变更，不影响公共 API）

- 测试用例总数 1949 → 1983（+34，80 个测试文件）

## 历史试验版本（已在 npm 作废，请勿使用）

## [2.1.0] - 2026-08-08

不中断工作模式 v2.0 与网络搜索接口版本。

### Added（新增）

- **不中断工作模式 v2.0**：支持会话暂停/恢复/分叉，通过检查点机制实现断点续跑；四级补全机制（P1-explicit / P2-memory / P3-builtin / P4-clarify）确保不中断场景下的输入完整性
- **IWebSearchProvider 接口**：网络搜索能力抽象，宿主可注入自定义搜索引擎实现，内核提供默认降级策略
- **FetchWebSearchProvider**：基于 DuckDuckGo HTML 的零依赖默认搜索实现，内置超时保护与错误降级
- **web_search 工具**：条件性暴露，注入 IWebSearchProvider 时自动可用，未注入时 LLM 被告知搜索不可用

### Fixed（修复）

- **P0-1: MemoryRelation 孤儿边清理**：`memoryInspector.writeDelete()` / `writePurge()` 前置清理关系边，防止记忆删除后关系边残留
- **P0-2: 运行时暂停超时检测**：暂停状态启动定时器，30 秒检测一次心跳，超 30 分钟自动清理检查点并重置状态机
- **P1: Composer 停滞时忽略显式任务输入**：计划停滞路径前增加 `event.delta?.task === undefined` 判断，确保用户显式指定任务时优先走 P1 显式输入而非 P4 澄清
- **P1-1: refreshBootstrapMemories 改为必选参数**：修复 SSOT 违反——CRUD 操作后 system prompt 中的 bootstrap 段必须同步
- **P1-2: goalVersion 漂移强制暂停**：`updateGoal()` 检测到 drift 级别时自动暂停（低风险，不计入连续暂停计数）
- **P2-1: consecutivePauseCount 时间衰减**：用时间戳数组替代简单计数，1 小时衰减窗口，旧暂停自动过期
- **P2-2: ChatMessage 增加 name 字段**：`extractHotMemory()` 和 `restoreFromCheckpoint()` 透传 name 字段，LLM 上下文一致性增强

### Internal（内部变更，不影响公共 API）

- 版本号 v2.0.3 → v2.1.0
- 新增 `src/web-search/` 模块（fetchWebSearchProvider.ts / webSearchProvider.ts / 类型定义）
- `ToolExecutor` 扩展：支持 `IWebSearchProvider` 注入，条件性注册 `web_search` 工具
- `builtinTools.ts` 新增 `WEB_SEARCH_TOOL` 定义与幂等性映射
- 新增 16 个测试用例覆盖 web search 功能（工具结构完整性 / 执行逻辑 / provider 行为）
- SSOT 修复新增 17 个测试用例（Composer 边缘场景 + checkpoint 全路径 + FetchWebSearchProvider 降级场景）
- 测试文件总数 80 个，测试用例总数增至 1949 个

## [2.0.3] - 2026-08-01

npm 发布配置修复与质量加固版本。

### Added（新增）

- **`publishConfig.access = "public"`**：修复 scoped package 发布阻塞（@zooique/memora 是私有作用域，npm 默认拒绝发布）
- **`keywords` 扩充至 18 个**：新增 memora / agent-memory / local-ai / embedding / vector-search / rag / zero-dependency / semantic-search / knowledge-base 及中文关键词，提升 npm 搜索曝光
- **`exports` 增加 `default` 回退条件**：增强混合解析场景的兼容性

### Internal（内部变更，不影响公共 API）

- 版本号 v2.0.2 → v2.0.3

## [2.0.2] - 2026-07-27

设定模块（Persona/Skill/Rule）全链路审查与修复版本。核心收敛：角色/技能从 SQLite 记忆索引解耦、"万物皆记忆"升级为 v2 双轨模型、技能从延迟注入改为当轮实时生效。

### Changed（变更）

- **万物皆记忆 v2**：Persona 和 Skill 从 SQLite 索引解耦，改为纯文件 + 内存缓存（设定记忆不参与 recall 管线）
- **Skill 当轮实时生效**：`matchAndInjectSkill()` 在 `chat()` 内 recall 后执行，匹配即注入，不再延迟到下一轮
- **Persona 默认回退泛化**：`shouldFallbackToDefault()` 从硬编码 `'default'` 改为 `list[0]?.name`
- **bootstrap 收敛**：`bootstrapMemories` 从 `rule + skill + persona` 收敛为仅 `rule`
- **PersonaManager / SkillManager 去 SQLite 依赖**：移除 `IMemoryStorage` 构造参数，移除 `writeAllToIndex()` 调用
- **自动匹配时机统一**：Persona 和 Skill 均在 `chat()` 开头执行匹配，LLM 当轮即用新设定

### Fixed（修复）

- **P0: Manual 模式角色回退**：`shouldFallbackToDefault()` 新增 mode 检查，manual 模式下不再自动回退
- **P1: 消息角色标签不一致**：`chatStreamHandler` 的 `SPRITE_STREAM_START` 延迟到首个 chunk 后发送，确保 persona 已匹配
- **Persona 切换参数同步**：锁定时长从 60s/3次/5分钟 更正为 30s/5次/2分钟（日志 + JSDoc + 测试）
- **关键词匹配同分 tie-break**：Persona/Skill 匹配同分时增加 name 字母序二级排序

### Internal（内部变更，不影响公共 API）

- `PersonaManager.autoMatch()` 去 async（函数体无 await）
- `configIndexWriter.ts` 移除（共享工具不再有消费者）
- `skillManager.ts` 移除 `writeAllToIndex()` / `writeSkillToIndex()` 方法
- `activeSkill` 字段移除（匹配改为当轮注入，无需跨轮状态）
- `injectActiveSkill()` 方法移除（被 `matchAndInjectSkill()` 替代）
- `personaManager.ts` / `skillManager.ts` 移除 `IMemoryStorage` 类型导入
- 架构文档 `architecture_philosophy_rules.md` v0.8→v1.0（万物皆记忆 v2）
- 分层文档 `backend_layers_rules.md` v1.1→v1.2（persona/skill 去 memory 依赖）

从 1.0.1 到 2.0.0 的架构收敛版本。核心目标：读写统一、记忆治理 L1~L4 全链路、god function 拆分、可观测性补全。

### Breaking Changes

> **升级指南**：以下变更需要消费者修改代码。

#### 1. MemoryMutator 移除，读写统一入口

`MemoryMutator` 类（1.0.0 引入的读写分离）已合并回 `MemoryInspector`。写方法以 `writeXxx` 前缀命名，与读方法统一在 `agent.memory` 上。

| 1.0.1 调用方式 | 2.0.0 迁移路径 |
|---|---|
| `agent.memoryMutator.upsert(memory)` | `agent.memory.writeUpsert(memory)` |
| `agent.memoryMutator.delete(id)` | `agent.memory.writeDelete(id)` |
| `agent.memoryMutator.restore(id)` | `agent.memory.writeRestore(id)` |
| `agent.memoryMutator.purge(id)` | `agent.memory.writePurge(id)` |
| `agent.memoryMutator.purgeExpired(before)` | `agent.memory.writePurgeExpired(before)` |
| `agent.memoryMutator.addRelation(rel)` | `agent.memory.writeAddRelation(rel)` |
| `agent.memoryMutator.removeRelation(...)` | `agent.memory.writeRemoveRelation(...)` |
| `import type { MemoryMutator }` | 移除，不再导出 |

**保留在 `agent.memory` 的只读方法**：`snapshot()` / `search()` / `searchHybrid()` / `stats()` / `getById()` / `list()` / `listDeleted()` / 关系查询方法等（不变）。

### Added（新增功能）

- **LLM 记忆治理 L1~L4**：
  - L1 语义去重：`agent.deduplicateMemories()` — 扫描名称相似记忆对，LLM 判断语义等价，降级重复记忆
  - L2 时效性评估：`agent.evaluateTimeliness()` — 扫描低分记忆，LLM 判断是否过时，降级过时记忆
  - L3 冲突检测：`agent.detectConflicts()` — 同 source 内配对，LLM 判断语义冲突，仅检测不修复
  - L0 手动衰减：`agent.runMemoryDecayOnce()` — 触发一次 score 衰减
  - 新增类型：`DedupPair` / `DedupVerdict` / `DedupReport`、`TimelinessVerdict` / `TimelinessReport`、`ConflictVerdict` / `ConflictReport`
- **TextPolishManager**：LLM 文本润色（语法修正 + 表达优化），独立于 Agent 生命周期，通过 `TextPolishManager` 类使用
- **EvalRunner 公开**：评估框架从 `@internal` 提升为公开 API，新增 `EVAL_SCENARIOS` / `EvalRunner` / `EvalRunnerOptions` / `EvalSummary` 导出
- **segmentLower**：分词工具扩展，返回小写分词结果（宿主 SqliteStorage 依赖）
- **isPlainObject**：纯对象类型守卫（宿主 spriteConfig 依赖，校验 JSON.parse 结果）
- **ChatLockManager**：对话锁管理器（从 AgentLoop 拆分），基于 token 的并发安全机制
- **ArchiveCoordinator**：归档协调器（从 postProcessInner 拆分），统一管理会话归档 + 洞察提取 + 角色匹配
- **MemoryDecayScheduler**：记忆衰减调度器（从 agent.ts 拆分），定时衰减 + L2 时效性评估 + 指标统计
- **MemoryAdvisor**：记忆顾问（从 MemoryInspector 拆分），sourceHealth 诊断 + suggest 关联推荐 + L3 冲突检测
- `TypedEventEmitter` 新增 `emitAsync` 方法（支持异步事件处理器的 await 等待）

### Changed（改进）

- **processUserInput 拆分**：从 550+ 行 god function 拆分为 4 个职责清晰的子方法（`handleRecallAndInputGuard` / `handleIteration` / `handleToolCalls` / `handleTextResponse`），每个方法独立可测
- **nullifyAllComponents 统一**：Agent.close() 中 13 个组件字段置空集中到 `nullifyAllComponents()` 私有方法，消除遗漏风险
- **requireNonNull 消除**：全量替换为局部变量提取 + non-null assertion `!`，减少代码噪音
- **personaManager LLM 调用迁移**：角色匹配的 LLM 调用从 persona 层迁移到 agent 层（架构分层合规）
- **toError 行为对齐**：跨模块统一错误处理，`toError(nonError)` 不再抛出 TypeError
- **formatDateKey 提取**：消除 3 处重复的日期格式化逻辑
- **抽象剪枝 3 轮**：DRY 收敛——消除重复的工具函数、常量定义、类型推导
- **types.ts 依赖图注释**：index.ts 新增完整的类型依赖图，降低新开发者学习成本
- 提示词优化 + 并发工具调用 + 可观测性补全（Tracer Span 覆盖衰减/归档/冲突检测）

### Fixed（修复）

- 神木回天 6 项修复：日志改进、硬约束测试补全、错误处理路径修复
- 感知层模式陈旧 bug：`welcomeBack` 文案 + 冷启动 blend 逻辑修复
- P3 静默 catch 修复：不再吞掉关键错误
- 归档失败事件 `archiveFailed` 可观测性补全（11 处测试覆盖）

### Internal（内部变更）

- `memoryMutator.ts` 文件删除，写方法合并到 `memoryInspector.ts`（`writeXxx` 前缀）
- `archiveCoordinator.ts` 独立模块（从 `agent.ts` 提取）
- `chatLockManager.ts` 独立模块（从 `loop.ts` 提取）
- `memoryDecayScheduler.ts` 独立模块（从 `agent.ts` 提取）
- `memoryAdvisor.ts` 独立模块（从 `memoryInspector.ts` 提取）
- `textPolishManager.ts` 新增模块（纯 LLM 调用，无存储依赖）
- 测试补强：L2 时效性评估测试、衰减边界测试、各 Manager 测试大幅扩展（+500+ 测试用例）

## [1.0.2] - 2026-07-11

### Changed

- `EmbeddingOptions` 接口归属位置从 `llm/embedding.ts` 调整到 `memory/vectorStore.ts`（符合依赖倒置原则：消费者定义接口，提供者通过 `import type` 引入）
- 顶层导出不变（`index.ts` 已同步更新导出路径），外部消费者无需修改导入语句

## [1.0.1] - 2026-07-08

### Fixed（P2 遗留项修复）

- coverage 阈值从 75/85/70/75 提升至 80/88/75/80
- pathGuard 黑名单新增 `.envrc` 拦截规则（direnv 配置文件）
- decisions/README.md ADR 索引补全 ADR-005 保留行
- kernel-ci.yml 测试数量注释更新

## [1.0.0] - 2026-07-08

从 0.3.0 到 1.0.0 的完整架构收敛版本。核心目标：接口稳定化、职责分离、韧性补齐、公共 API 收敛。

### Breaking Changes

> **升级指南**：以下变更需要消费者修改代码。所有 Breaking Changes 均有 1:1 迁移路径。

#### 1. 记忆读写分离：`agent.memory` → `agent.memoryMutator`

`MemoryInspector` 中的写操作方法已迁移到新类 `MemoryMutator`，实现读写职责严格分离（ADR-010 补充）。

| 0.3 写方法（`agent.memory.xxx`） | 1.0 迁移路径（`agent.memoryMutator.xxx`） |
|---|---|
| `agent.memory.upsert(memory)` | `agent.memoryMutator.upsert(memory)` |
| `agent.memory.delete(id)` | `agent.memoryMutator.delete(id)` |
| `agent.memory.restore(id)` | `agent.memoryMutator.restore(id)` |
| `agent.memory.purge(id)` | `agent.memoryMutator.purge(id)` |
| `agent.memory.purgeExpired(before)` | `agent.memoryMutator.purgeExpired(before)` |
| `agent.memory.addRelation(rel)` | `agent.memoryMutator.addRelation(rel)` |
| `agent.memory.removeRelation(...)` | `agent.memoryMutator.removeRelation(...)` |

**保留在 `agent.memory` 的只读方法**：`snapshot()` / `search()` / `searchHybrid()` / `stats()` / `getById()` / `list()` / `listDeleted()` / `getDeletedById()` / 关系查询方法等。

#### 2. `VectorStore` 重命名为 `JsonVectorStore`

向量存储从具体类重构为接口 + 实现（ADR-016）。

| 0.3 导出 | 1.0 迁移路径 |
|---|---|
| `import { VectorStore } from '@zooique/memora'` | `import { JsonVectorStore } from '@zooique/memora'` |
| `new VectorStore(path, embeddingProvider)` | `new JsonVectorStore(path, embeddingProvider)` |

新增 `IVectorStore` 接口，宿主可实现自定义向量存储（如 SqliteVectorStore / LanceDBVectorStore）。

#### 3. `ChatOptions.channel` 字段移除

`ChatOptions.channel?: 'chat' | 'background'` 字段从未被任何 LLM 调用路径读取，已移除。多 Provider 路由通过 `AgentOptions.backgroundProvider` 注入独立 LlmProvider 实例实现，不通过 `ChatOptions` 字段路由。

#### 4. `AgentChunk` 流式事件结构变化

多个 chunk 类型的字段结构发生变化，宿主需更新 chunk 处理逻辑：

| chunk 类型 | 0.3 结构 | 1.0 结构 |
|---|---|---|
| `recall` | `{ type: 'recall'; count: number }` | `{ type: 'recall'; memories: RecalledMemorySummary[] }`（携带记忆摘要列表，非计数） |
| `text` | `{ type: 'text'; content: string }` | `{ type: 'text'; content: string; guardrailBlocked?: boolean }`（新增护栏阻断标志） |
| `tool_start` | `{ type: 'tool_start'; name: string; args?: string }` | `{ type: 'tool_start'; toolCallId: string; name: string; args?: string }`（新增 toolCallId） |
| `tool_result` | `{ type: 'tool_result'; name: string; ok: boolean; summary?: string }` | `{ type: 'tool_result'; toolCallId: string; name: string; ok: boolean; summary?: string }`（新增 toolCallId） |
| `error` | 不存在 | `{ type: 'error'; message: string }`（新增，流式错误替代裸 throw） |
| `retry` | 不存在 | `{ type: 'retry'; attempt; maxRetries; delayMs; error }`（新增，指数退避重试信号） |

新增 `RecalledMemorySummary` 类型（`{ id, name, score, source }`），仅暴露 UI 展示所需字段，不含 `content`。

#### 5. `Memory` 类型新增 `deletedAt` 字段（7→8 字段）

`Memory` 接口新增可选字段 `deletedAt?: string`（ISO 8601），支持软删除/回收站机制（ADR-004 GAP-6 扩展）。所有查询方法自动过滤 `deletedAt != undefined` 的记忆。

#### 6. `IMemoryStorage` 接口扩展（7→15 方法）

新增 8 个方法，宿主实现的 `IMemoryStorage` 需补全：

| 新增方法 | 用途 |
|---|---|
| `restore(id)` | 恢复软删除记忆 |
| `purge(id)` | 物理删除（不可恢复） |
| `listDeleted(limit?)` | 列出回收站 |
| `getDeletedById(id)` | 按 ID 获取软删除记忆 |
| `purgeExpired(before)` | 清理过期回收站 |
| `decayScores(sources, now)` | 批量衰减 score |
| `getAllSources()` | 获取 source→count 映射 |

（`close?()` 已在 0.3 存在）

#### 7. `AgentOptions` 字段变化

| 变化 | 0.3 | 1.0 | 迁移路径 |
|---|---|---|---|
| `logger` 字段移除 | `AgentOptions.logger?: ILogger` | 移除 | 改用全局 `setLogger(customLogger)` 注入 |
| `archiveMode` 新增 | 不存在 | `archiveMode?: ArchiveMode`（默认 `'full'`） | 可选，不传则默认 `'full'` 全自动归档 |
| `enableContextSummary` 默认值 | `false` | `true` | 如需关闭显式传 `false` |

#### 8. 事件载荷变化

三个事件的载荷结构变化，宿主事件处理器需更新：

| 事件 | 0.3 载荷 | 1.0 载荷 |
|---|---|---|
| `conflictDetected` | `{ memoryId, conflictingId, relationType }` | `{ newMemoryId, newInsight, targetId, targetContent }` |
| `projectSwitched` | `{ from, to }` | `{ from: string \| null, to: string, projectName: string }` |
| `skillMatched` | `{ skillName, keywords }` | `{ skill: string, score: number }` |

#### 9. 会话/项目方法迁移到专职 Manager

以下方法从 Agent 面类迁移到专职 Manager（P1-4 拆分）：

| 0.3 调用方式 | 1.0 迁移路径 |
|---|---|
| `agent.switchSession(name)` | `agent.sessionManager.switchSession(name)` |
| `agent.loadSessionMessages(date, session)` | `agent.sessionManager.loadSessionMessages(date, session)` |
| `agent.restoreMostRecentSession(...)` | `agent.sessionManager.restoreMostRecentSession(...)` |
| `agent.restoreSession(date, session)` | `agent.sessionManager.restoreSession(date, session)` |
| `agent.listProjects()` | `agent.projects.listProjects()` |

**保留在 Agent 面类**：`switchProject()` / `rebuildComponents()` / `forkSession()`（常用入口）。

#### 10. `ToolExecutor` 移除 `getToolDefinitions()`

`agent.tools.getToolDefinitions()` 已移除，改用 `agent.tools.list`（getter）。

| 0.3 调用 | 1.0 迁移路径 |
|---|---|
| `agent.tools.getToolDefinitions()` | `agent.tools.list` |

#### 11. Agent 移除 `inspect()` / `getBuildCtx()`

`agent.inspect()` 和 `agent.getBuildCtx()` 已移除。宿主可通过事件系统、ITracer、`agent.memory.snapshot()` 观察内核状态。

### Added（新增功能）

- **`MemoryMutator`**：记忆写入器，与 `MemoryInspector` 严格分工（读写分离）
- **`RelationBuilder`**：关系构建器，从 `InsightExtractor` 提取（P1-3），支持冲突检测回调
- **`ProjectRegistry`** + **`LockManager`**：从 `ProjectManager` 拆分（P1-4），宿主可直接使用
- **`IVectorStore`** 接口：向量存储抽象，宿主可注入自定义实现（ADR-016）
- **`EmbeddingOptions`**：embedding 调用选项（`signal?: AbortSignal` + `timeoutMs?: number`），`EmbeddingProvider.embed/batchEmbed` 和 `IVectorStore` 方法支持外部取消 + 超时中断（P1-8）
- **`ConflictInfo`** 类型：关系冲突信息，`RelationBuilder.bindOnConflict()` 回调参数
- **`RecalledMemorySummary`** 类型：recall chunk 载荷，仅暴露 UI 展示所需字段（id/name/score/source），不含 content
- **`archiveMode`** 选项：ADR-015 三态归档控制（`full` / `insights-only` / `manual`），默认 `full`
- **AgentChunk 新增 `error` / `retry` 类型**：流式错误事件替代裸 throw，指数退避重试信号让宿主感知重试
- **`mergeSignals`** 工具：AbortSignal 合并工具，将多个 signal 合并为一个（用于工具执行超时 + 用户取消合并）
- **`guardrail.ts`** 独立模块：内容护栏纯函数 `runGuardrails()`，从 `AgentLoop` 提取（P1-1）
- **`sourceValidation.ts`**：source 校验工具从 `types.ts` 拆分（P1-2）
- **AgentChunk `guardrailBlocked`** 标志位：结构化护栏信号，替代中文字符串匹配（P0-7）
- **`SessionArchiver`**：会话内容归档器，支持 content 类记忆归档
- **`MemoryAdvisor`**：记忆建议器，提供 suggest / sourceHealth 查询
- **`MemoryDecayScheduler`**：记忆衰减调度器，init 首次 + 每小时定时衰减
- **ADR-016**：向量存储接口化决策记录
- **ADR-015**：archiveMode 三态归档控制决策记录
- **ADR-002/004/014 补充**：Logger 懒初始化、content 多用途、关系查询归属 + RelationBuilder 拆分

### Changed（改进）

- **zod schema 单一真理源**：`DEFAULT_CONFIG` 常量移除，配置默认值由 zod schema `.default()` 声明（P0-1）
- **Logger 懒初始化**：`maybeUpgradeToPino()` 延迟触发，import 零 fs 副作用（P0-6）
- **EmbeddingProvider 默认超时**：60 秒默认请求超时（可通过 `timeoutMs` 覆盖）
- **`ProjectManager` 瘦身**：从 640 行缩减到 410 行，注册表/锁文件操作委托给 `ProjectRegistry`/`LockManager`
- **`InsightExtractor` 瘦身**：关系构建逻辑委托给 `RelationBuilder`
- **测试目录镜像**：`managers/__tests__/` 严格镜像 `src/` 目录结构（ADR-007）

### Fixed（修复）

- **zod schema 与 DEFAULT_CONFIG 不一致**：配置默认值单一真理源
- **eval 护栏检测依赖中文魔法字符串**：改用 `guardrailBlocked` 结构化标志位
- **Logger import 触发 fs 副作用**：懒初始化，import 零 IO
- **Embedding 请求无超时/取消保护**：支持 AbortSignal + timeoutMs
- **`insightExtractor.ts` inline `import()` 类型**：改为顶层 type import

### Internal（内部变更，不影响公共 API）

- `types.ts` 拆分为 `types.ts` + `sourceValidation.ts` + `segmenter.ts`（STOPWORDS 迁移）
- `MemoryInspector` 移除写方法，保留只读编排职责
- `safeTimer` 的 `clearAllSafeTimers`/`getActiveTimerCount` 已不在公共导出（早期迭代已收敛）
- 11 个 manager 测试文件迁移到 `managers/__tests__/`

## [0.3.0] - 2026-06-27

Phase 5.1/5.2 初始 npm 发布版本。
