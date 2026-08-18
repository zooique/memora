# Memora 模块清单与打磨路线图

> 本文档记录 memora 内核所有模块的当前状态、测试覆盖度、质量评级与打磨优先级。供开发者以模块为单位进行质量改进。
>
> **最近更新**：2026-08-18
> **设计哲学**：万物皆记忆 · 最小问答闭环 · 单一真理源

---

## 状态图例

| 状态 | 说明 |
|------|------|
| 🟢 已打磨 | 核心逻辑有测试覆盖，代码结构稳定 |
| 🟡 部分打磨 | 有测试但覆盖不足，或有未验证的边界场景 |
| 🔴 待打磨 | 无测试覆盖，或涉及复杂逻辑需验证 |
| ⚪ 工具/接口 | 纯函数/接口定义，风险低 |

---

## 一、角色包模块（role-pack/）

> **核心职责**：角色定义、策略装配、能力映射、格式校验
> **哲学关联**：记忆系统 × 角色包边界纪律 · 两级技能渐进披露

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `role-pack/types.ts` | 🟢 已打磨 | `__tests__/types.test.ts` | 36 个导出类型，行为策略全量定义 |
| `role-pack/rolePackManager.ts` | 🟢 已打磨 | `__tests__/rolePackManager.test.ts` | 角色包文件夹形态加载与装配 |
| `role-pack/validator.ts` | 🟢 已打磨 | `__tests__/validator.test.ts` | manifest.json 核心控制校验 |
| `role-pack/capabilityMap.ts` | 🟢 已打磨 | `__tests__/capabilityMap.test.ts` | 能力声明映射与检查 |
| `role-pack/strategyResolver.ts` | 🟢 已打磨 | `__tests__/strategyResolver.test.ts` (84 tests) | 默认值完整性、21 个 resolve 函数、mergeStrategy、assembleRolePack 装配逻辑 |
| `role-pack/strategyKeys.ts` | 🟢 已打磨 | `__tests__/strategyKeys.test.ts` (48 tests) | 6 个校验辅助函数 + 别名映射 + 4 阶段 25+ 策略键规则完整性验证 |

**已打磨**：`strategyResolver.ts` 测试覆盖了默认值完整性、21 个 resolve* 函数的合法/非法/缺失值处理、mergeStrategy 合并行为、assembleRolePack 装配逻辑（含主动提问指令注入）。

---

## 二、技能模块（skill/）

> **核心职责**：技能匹配、脚本执行、渐进披露
> **哲学关联**：两级技能渐进披露（通用全局 + 角色包绑定）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `skill/skillManager.ts` | 🟢 已打磨 | `__tests__/skillManager.test.ts` | 技能加载、匹配、执行调度 |
| `skill/types.ts` | ⚪ 工具 | 无独立测试 | 技能类型定义 |
| `skill/skillScriptRunner.ts` | 🟢 已打磨 | `__tests__/skillScriptRunner.test.ts` (19 tests) | formatScriptResult 三分支 + runSkillScript 跨平台子进程执行（Node/Shell）+ 超时/环境变量隔离/返回结构 |

**打磨建议**：为 `skillScriptRunner.ts` 补充安全边界测试——超时强制终止、白名单 runtime 校验、脚本执行错误捕获。

---

## 三、记忆系统模块（memory/）

> **核心职责**：记忆索引、召回、治理、向量存储
> **哲学关联**：记忆即摘要架构 · 摘要记忆 + 标签 + 粒度统一模型

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `memory/recall.ts` | 🟢 已打磨 | `__tests__/recall.test.ts` | 召回核心逻辑 |
| `memory/store.ts` | 🟢 已打磨 | `__tests__/store.test.ts` | 记忆 CRUD 操作 |
| `memory/types.ts` | 🟢 已打磨 | `__tests__/types.test.ts` | 记忆类型定义 |
| `memory/governance.ts` | 🟢 已打磨 | `__tests__/governance.test.ts` | 分数衰减、clamp 边界 |
| `memory/lockManager.ts` | 🟢 已打磨 | `__tests__/lockManager.test.ts` | 锁文件管理 |
| `memory/inMemoryStorage.ts` | 🟢 已打磨 | `__tests__/inMemoryStorage.test.ts` | 内存存储实现 |
| `memory/sourceValidation.ts` | 🟢 已打磨 | `__tests__/sourceValidation.test.ts` | Source 校验 |
| `memory/sourcePaths.ts` | 🟢 已打磨 | `__tests__/sourcePaths.test.ts` | Source→路径映射 SSOT |
| `memory/loader.ts` | 🟢 已打磨 | `__tests__/loader.test.ts` | 记忆加载器 |
| `memory/projectManager.ts` | 🟢 已打磨 | `__tests__/projectManager.test.ts` | 项目管理 |
| `memory/projectRegistry.ts` | 🟢 已打磨 | `__tests__/projectRegistry.test.ts` | 项目注册表 |
| `memory/vectorStore.ts` | 🟢 已打磨 | `__tests__/vectorStore.test.ts` | 向量存储 |
| `memory/reranker.ts` | 🟢 已打磨 | `__tests__/reranker.test.ts` | 重排序 |
| `memory/multiHop.ts` | 🟢 已打磨 | `__tests__/multiHop.test.ts` | 多跳推理 |
| `memory/hybridMerge.ts` | 🟢 已打磨 | `__tests__/hybridMerge.test.ts` | 混合检索 |
| `memory/sessionStore.ts` | 🟢 已打磨 | `__tests__/sessionStore.test.ts` (22 tests) + `agent/__tests__/sessionStoreContract.test.ts` | ISessionStore 契约：必需方法 + 全部可选方法（copySession/checkpoint/meta）+ 类型验证 |
| `memory/storageInterface.ts` | ⚪ 接口 | 无独立测试 | IMemoryStorage 接口定义 |

**打磨建议**：`sessionStore.ts` 需补充宿主实现的契约测试（copySession 原子性、checkpoint 保存/加载/删除的幂等性）。

---

## 四、Agent 核心模块（agent/）

> **核心职责**：问答闭环、Loop 执行、工具调度、会话管理
> **哲学关联**：最小问答闭环 · Loop = 闭环的重复 · 单轮闭环自足可观察

### 4.1 核心执行

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `agent/agent.ts` | 🟢 已打磨 | `__tests__/agent.test.ts` | Agent 主入口，状态守卫逻辑 |
| `agent/loop.ts` | 🟢 已打磨 | `__tests__/loop.test.ts` (67 tests) | AgentLoop 核心，含拦截器集成 |
| `agent/composer.ts` | 🟢 已打磨 | `__tests__/composer.test.ts` | 上下文组装 |
| `agent/contextManager.ts` | 🟢 已打磨 | `__tests__/contextManager.test.ts` | Token 估算、上下文窗口管理 |
| `agent/compaction.ts` | 🟢 已打磨 | `__tests__/compaction.test.ts` (15 tests) | 微压缩层：ResultReplacement + OffloadCompaction |
| `agent/duplicateInterceptor.ts` | 🟢 已打磨 | `__tests__/duplicateInterceptor.test.ts` (22 tests) | 重复 tool_call 检测拦截器 |
| `agent/messageHistory.ts` | 🟢 已打磨 | `__tests__/messageHistory.test.ts` | 消息历史管理 |
| `agent/personaMatcher.ts` | 🟢 已打磨 | `__tests__/personaMatcher.test.ts` | Persona 粘性匹配 |
| `agent/toolExecutor.ts` | 🟢 已打磨 | `__tests__/toolExecutor.test.ts` | 工具执行器 |
| `agent/builtinTools.ts` | 🟢 已打磨 | `__tests__/builtinTools.test.ts` | 内置工具定义 |
| `agent/builtinToolHandlers.ts` | 🟢 已打磨 | `__tests__/builtinToolHandlers.test.ts` | 内置工具处理器 |
| `agent/assembler.ts` | 🟢 已打磨 | `__tests__/assembler.test.ts` | 组件装配 |
| `agent/tracer.ts` | 🟢 已打磨 | `__tests__/tracer.test.ts` | 可观测性追踪 |
| `agent/constants.ts` | 🟢 已打磨 | `__tests__/constants.test.ts` | 常量定义 |
| `agent/types.ts` | 🟢 已打磨 | 间接测试 | 36 个导出类型定义 |

### 4.2 会话状态机与不中断工作流

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `agent/sessionStateMachine.ts` | 🟢 已打磨 | `__tests__/sessionStateMachine.test.ts` (42 tests) | 三态流转、非法转换防护、ERROR 恢复双重校验、pending 暂停请求管理 |
| `agent/__tests__/uninterruptedWorkflow.test.ts` | 🟢 已打磨 | 现有测试 | 不中断工作流集成测试 |
| `agent/__tests__/degradation.test.ts` | 🟢 已打磨 | 现有测试 | 降级处理测试 |

### 4.3 治理管理器（managers/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `managers/sessionManager.ts` | 🟢 已打磨 | `__tests__/sessionManager.test.ts` | 会话生命周期管理 |
| `managers/sessionArchiver.ts` | 🟢 已打磨 | `__tests__/sessionArchiver.test.ts` | 会话归档 |
| `managers/sessionNamer.ts` | 🟢 已打磨 | `__tests__/sessionNamer.test.ts` | 会话自动命名 |
| `managers/sessionCheckpointLifecycle` | 🟢 已打磨 | `__tests__/sessionCheckpointLifecycle.test.ts` | 检查点生命周期 |
| `managers/archiveCoordinator.ts` | 🟢 已打磨 | `__tests__/archiveCoordinator.test.ts` | 归档协调器 |
| `managers/roundSummaryGenerator.ts` | 🟢 已打磨 | `__tests__/roundSummaryGenerator.test.ts` | 轮次摘要生成 |
| `managers/memoryGovernance.ts` | 🟢 已打磨 | `__tests__/memoryGovernance.test.ts` | 记忆治理统一门面 |
| `managers/memoryInspector.ts` | 🟢 已打磨 | `__tests__/memoryInspector.test.ts` | 记忆快照/诊断 |
| `managers/memoryDecayScheduler.ts` | 🟢 已打磨 | `__tests__/memoryDecayScheduler.test.ts` | L2 时效性评估 |
| `managers/memoryAdvisor.ts` | 🟢 已打磨 | `__tests__/memoryAdvisor.test.ts` | L3 冲突检测 |
| `managers/dedupManager.ts` | 🟢 已打磨 | `__tests__/dedupManager.test.ts` | L1 语义去重 |
| `managers/configManager.ts` | 🟢 已打磨 | `__tests__/configManager.test.ts` | 配置管理 |
| `managers/autoConfigRefiner.ts` | 🟢 已打磨 | `__tests__/autoConfigRefiner.test.ts` | 自动配置精化 |
| `managers/workProjection.ts` | 🟢 已打磨 | `__tests__/workProjection.test.ts` | 作品投影管理 |
| `managers/textPolishManager.ts` | 🟢 已打磨 | `__tests__/textPolishManager.test.ts` | 文本润色 |
| `managers/chatLockManager.ts` | 🟢 已打磨 | `__tests__/chatLockManager.test.ts` | 聊天锁管理 |
| `managers/goalConsistencyChecker.ts` | 🟢 已打磨 | `__tests__/goalConsistencyChecker.test.ts` (51 tests) | 约束提取/文本相似度（bigram+Jaccard）/漂移三级判定/约束一致性检查 |
| `managers/llmJudgeHelper.ts` | 🟢 已打磨 | `__tests__/llmJudgeHelper.test.ts` (18 tests) | 三件套模式：流式累积→parseLlmJson→configError 抛错 |
| `managers/streamAccumulator.ts` | 🟢 已打磨 | `__tests__/streamAccumulator.test.ts` (15 tests) | chunk.content 拼接/空内容跳过/异常传播/options 透传 |

### 4.4 辅助渲染器

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `agent/taskTableRenderer.ts` | 🟢 已打磨 | `__tests__/taskTableRenderer.test.ts` (22 tests) | 任务进度渲染/状态标签映射/回合日志追加/描述截断/防误执行标记 |

---

## 五、LLM 接入模块（llm/）

> **核心职责**：LLM Provider 抽象、流式接口、嵌入服务

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `llm/provider.ts` | 🟢 已打磨 | `__tests__/provider.test.ts` | Provider 抽象基类 |
| `llm/openaiCompatible.ts` | 🟢 已打磨 | `__tests__/openaiCompatible.test.ts` | OpenAI 兼容实现 |
| `llm/factory.ts` | 🟢 已打磨 | `__tests__/factory.test.ts` | Provider 工厂 |
| `llm/embedding.ts` | 🟢 已打磨 | `__tests__/embedding.test.ts` | 嵌入服务 |
| `llm/abortSignal.ts` | 🟢 已打磨 | `__tests__/abortSignal.test.ts` | 中止信号 |
| `llm/types.ts` | ⚪ 工具 | 无独立测试 | LLM 类型定义 |
| `llm/__tests__/llmIntegration.test.ts` | 🟢 已打磨 | 集成测试 | LLM 集成测试 |

---

## 六、配置模块（config/）

> **核心职责**：配置加载、环境变量展开

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `config/loader.ts` | 🟢 已打磨 | `__tests__/loader.test.ts` | 配置加载主入口 |
| `config/expandEnvVars.ts` | 🟢 已打磨 | `__tests__/expandEnvVars.test.ts` (16 tests) | 4 通道环境变量展开（llm/providers/background/embedding）+ 边界场景 |

---

## 七、基础设施模块

### 7.1 工具库（utils/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `utils/eventEmitter.ts` | 🟢 已打磨 | `__tests__/eventEmitter.test.ts` | 类型化事件发射器 |
| `utils/segmenter.ts` | 🟢 已打磨 | `__tests__/segmenter.test.ts` | 分词工具 |
| `utils/strings.ts` | 🟢 已打磨 | `__tests__/strings.test.ts` | 字符串工具 |
| `utils/objects.ts` | 🟢 已打磨 | `__tests__/objects.test.ts` | 对象类型守卫 |
| `utils/frontmatter.ts` | 🟢 已打磨 | `__tests__/frontmatter.test.ts` | Frontmatter 解析 |
| `utils/safeTimer.ts` | 🟢 已打磨 | `__tests__/safeTimer.test.ts` | 安全定时器 |
| `utils/hash.ts` | 🟢 已打磨 | `__tests__/hash.test.ts` | 哈希工具 |
| `utils/json.ts` | 🟢 已打磨 | `__tests__/json.test.ts` | JSON 工具 |
| `utils/errors.ts` | 🟢 已打磨 | `__tests__/errors.test.ts` | 错误类型体系 |
| `utils/toError.ts` | 🟢 已打磨 | `__tests__/toError.test.ts` | 错误转换 |
| `utils/math.ts` | 🟢 已打磨 | `__tests__/math.test.ts` | 数学工具 |
| `utils/array.ts` | 🟢 已打磨 | `__tests__/array.test.ts` | 数组工具 |
| `utils/path.ts` | 🟢 已打磨 | `__tests__/path.test.ts` | 路径工具 |
| `utils/time.ts` | 🟢 已打磨 | `__tests__/time.test.ts` | 时间工具 |
| `utils/scanner.ts` | 🟢 已打磨 | `__tests__/scanner.test.ts` | 文件扫描器 |
| `utils/configResourceManager.ts` | 🟢 已打磨 | `__tests__/configResourceManager.test.ts` | 配置资源管理 |
| `utils/loggerHolder.ts` | 🟢 已打磨 | `__tests__/loggerHolder.test.ts` | Logger 持有者 |
| `utils/atomicWrite.ts` | 🟢 已打磨 | `__tests__/atomicWrite.test.ts` (12 tests) | 原子写：临时文件+rename/覆盖写入/大内容/特殊字符/目录不存在异常 |
| `utils/recallDefaults.ts` | ⚪ 工具 | 无需测试 | 单常量 `DEFAULT_MIN_FALLBACK = 2` |

### 7.2 安全（security/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `security/pathGuard.ts` | 🟢 已打磨 | `__tests__/pathGuard.test.ts` | 路径安全守卫 |

### 7.3 日志（logging/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `logging/logger.ts` | 🟢 已打磨 | `__tests__/logger.test.ts` | Logger 实现 |
| `logging/loggerInterface.ts` | ⚪ 接口 | 无独立测试 | ILogger 接口定义 |

### 7.4 网络搜索（web-search/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `web-search/fetchWebSearchProvider.ts` | 🟢 已打磨 | `__tests__/fetchWebSearchProvider.test.ts` | DuckDuckGo 搜索实现 |
| `web-search/webSearchProvider.ts` | 🟢 已打磨 | `__tests__/webSearchProvider.test.ts` | 搜索包装 |
| `web-search/types.ts` | ⚪ 接口 | 无独立测试 | 搜索类型定义 |

### 7.5 评估框架（eval/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `eval/evalRunner.ts` | 🟢 已打磨 | `__tests__/evalRunner.test.ts` | 评估运行器 |
| `eval/evalTypes.ts` | 🟢 已打磨 | `__tests__/evalTypes.test.ts` | 评估类型定义 |
| `eval/scenarios.ts` | 🟢 已打磨 | `__tests__/scenarios.test.ts` | 评估场景 |

---

## 八、打磨优先级路线图

### 🔴 Tier 1 — 核心逻辑无测试覆盖（最高优先级）

| # | 模块 | 风险 | 预计工作量 | 状态 |
|---|------|------|-----------|------|
| 1 | ~~`sessionStateMachine.ts`~~ | 不中断工作模型的三态流转 | 中 | ✅ 已完成（42 tests） |
| 2 | ~~`strategyResolver.ts`~~ | 角色包装配核心 | 中 | ✅ 已完成（84 tests） |
| 3 | ~~`llmJudgeHelper.ts` + `streamAccumulator.ts`~~ | 3 个治理 Manager 的共用基础 | 小 | ✅ 已完成（18+15 tests） |
| 4 | ~~`goalConsistencyChecker.ts`~~ | P3 目标一致性的关键判定逻辑 | 小 | ✅ 已完成（51 tests） |

### 🟡 Tier 2 — 安全/工具边界验证（中优先级）

| # | 模块 | 风险 | 预计工作量 |
|---|------|------|-----------|
| 5 | ~~`skillScriptRunner.ts`~~ | 涉及子进程安全边界 | 小 | ✅ 已完成（19 tests） |
| 6 | ~~`expandEnvVars.ts`~~ | 涉及 API Key 环境变量展开 | 小 | ✅ 已完成（16 tests） |
| 7 | ~~`strategyKeys.ts`~~ | 20+ 个校验规则的参数化测试 | 中 | ✅ 已完成（48 tests） |

### 🟢 Tier 3 — 低风险补全（低优先级）

| # | 模块 | 风险 | 预计工作量 |
|---|------|------|-----------|
| 8 | ~~`taskTableRenderer.ts`~~ | 纯函数渲染器，风险低 | 小 | ✅ 已完成（22 tests） |
| 9 | ~~`atomicWrite.ts`~~ | 原子写，边界场景 | 小 | ✅ 已完成（12 tests） |
| 10 | ~~`sessionStore.ts` 契约测试~~ | 宿主实现需要 | 小 | ✅ 已完成（22 tests） |

---

## 九、测试覆盖统计

| 层级 | 文件数 | 有测试 | 无测试 | 覆盖率 |
|------|--------|--------|--------|--------|
| role-pack/ | 6 | 6 | 0 | 100% |
| skill/ | 3 | 1 | 2 | 33% |
| memory/ | 16 | 15 | 1 | 94% |
| agent/ (核心) | 15 | 15 | 0 | 100% |
| agent/managers/ | 19 | 16 | 3 | 84% |
| llm/ | 7 | 6 | 1 | 86% |
| config/ | 2 | 1 | 1 | 50% |
| utils/ | 18 | 17 | 1 | 94% |
| 其他 (security/logging/web-search/eval) | 10 | 10 | 0 | 100% |
| **总计** | **96** | **86** | **10** | **90%** |

> 注：纯类型定义文件（types.ts / Interface 文件）不计入"无测试"，其消费方的集成测试已覆盖。

---

## 十、历史打磨记录

| 日期 | 打磨内容 | 状态 |
|------|----------|------|
| 2026-08-17 | 双 LLM 架构 SSOT 修复（backgroundProvider） | ✅ 完成 |
| 2026-08-18 | 上下文微压缩层（ResultReplacement + OffloadCompaction） | ✅ 完成 |
| 2026-08-18 | 重复 tool_call 检测拦截器（DefaultDuplicateCallInterceptor） | ✅ 完成 |
| 2026-08-18 | 策略参数化拦截器宿主扩展点（DuplicateCallInterceptor） | ✅ 完成 |
| 2026-08-18 | 角色包 + Skills 模块模块清单整理 | ✅ 完成 |
| 2026-08-18 | Tier 1: sessionStateMachine.ts（42 tests — 三态流转/非法转换/ERROR 恢复校验/pending 管理） | ✅ 完成 |
| 2026-08-18 | Tier 1: strategyResolver.ts（84 tests — 默认值完整性/21 resolve 函数/mergeStrategy/assembleRolePack） | ✅ 完成 |
| 2026-08-18 | Tier 1: llmJudgeHelper + streamAccumulator + goalConsistencyChecker（84 tests — 三件套模式/流式累积/约束提取+bigram+Jaccard） | ✅ 完成 |
| 2026-08-18 | Tier 2: skillScriptRunner + expandEnvVars + strategyKeys（83 tests — 子进程执行/环境变量展开/策略键校验规则） | ✅ 完成 |
| 2026-08-18 | Tier 3: taskTableRenderer + atomicWrite + sessionStore 契约测试（56 tests — 渲染器/原子写/ISessionStore 全方法契约） | ✅ 完成 |
