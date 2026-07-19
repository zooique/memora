# Step 1 · Memora 内核核心引擎层 · 打包前审查报告

> **审查模式**：问诊·炼化归元（规则对齐 → 剪枝 → 提交前审查）
> **审查范围**：`src/agent/`（27 文件，9187 行）+ `src/memory/`（16 文件，2968 行）
> **审查日期**：2026-07-19
> **测试基线**：68 文件 / 1544 通过 / 1 跳过 / 0 失败（39.36s）
> **后续衔接**：Step 2（memora 内核基础设施层）

---

## 1. 规则对齐

### 1.1 已对齐项（合规无问题）

| # | 规则 | 验证方式 | 结果 |
|---|------|----------|------|
| AL-1 | ADR-002 内核零依赖（无 better-sqlite3/electron/commander/zod） | Grep `from 'xxx'` 全量扫描 src/agent + src/memory | ✅ 0 处违规 |
| AL-2 | project-rules §7.1 零容忍 `@ts-ignore` / `as any` | Grep 全量扫描 | ✅ 0 处违规（仅注释/测试说明中提及） |
| AL-3 | project-rules §7.1 零容忍生产 `console.log` | Grep `console\.(log\|debug\|info\|warn\|error)` | ✅ 0 处违规（仅 JSDoc 示例中提及） |
| AL-4 | coding-convention §2 不吞异常（无空 catch 块） | Grep `catch\s*\([^)]*\)\s*\{\s*\}` multiline | ✅ 0 处违规 |
| AL-5 | 无 TODO/FIXME/XXX/HACK 遗留 | Grep 全量扫描 | ✅ 0 处遗留 |
| AL-6 | ADR-004 记忆统一模型（source 开放字符串） | 检查 `src/memory/types.ts` + `SOURCE_LABELS` 注释 | ✅ source 为 string，SOURCE_LABELS 标注"约定非枚举" |
| AL-7 | ADR-002 IMemoryStorage 15 方法接口完整性 | 检查 `src/memory/storageInterface.ts` | ✅ 14 必填 + 1 可选 close = 15 方法 |
| AL-8 | backend_layers §依赖方向（memory/ 不反向依赖 agent/） | Grep `from '@/agent` in src/memory/ | ✅ 0 处反向依赖 |
| AL-9 | ADR-007 测试镜像（src ↔ __tests__） | 文件名比对 | ✅ 27 源文件 + 30 测试文件，3 个测试文件名差异经核验为合理测试组织（degradation/metrics/sessionStoreContract 测试主体分别为 messageHistory / loop / messageHistory） |
| AL-10 | 单 Agent 模型（无多 Agent 并发实现） | 检查 agent.ts + chatLockManager | ✅ chatLockManager token 机制保证单 Agent 串行 |

### 1.2 规则对齐发现的违规（已纳入剪枝/审查修复）

| ID | 规则 | 文件:行号 | 性质 |
|----|------|----------|------|
| AL-V1 | project-rules §7.1 零容忍裸 throw Error（统一 MemoraError） | src/agent/managers/memoryInspector.ts:1055 + memoryDecayScheduler.ts:345 + memoryAdvisor.ts:533 | 3 处违规 |
| AL-V2 | project-rules §7.1 零容忍裸 throw Error | src/memory/types.ts:55,64,72,80,87 | 5 处违规（parseMemory 内） |
| AL-V3 | project-rules §7.1 零容忍死代码 | src/agent/agent.ts:154,294,1122-1125 | decayTimer 字段已死 |

---

## 2. 剪枝（识别冗余，不立即删除）

### 2.1 死代码（P0 · 零容忍）

| ID | 文件:行号 | 描述 | 处置 |
|----|----------|------|------|
| PR-1 | src/agent/agent.ts:154,294,1122-1125 | `private decayTimer` 字段已迁移至 MemoryDecayScheduler，但字段声明 + init 赋 null + close 时死分支仍保留，注释自承"实际定时器由 MemoryDecayScheduler 管理" | 归档待办 STEP1-1 |

### 2.2 重复代码（P1 · 枝叶层 2 次提取原则候选）

| ID | 文件:行号 | 重复次数 | 描述 |
|----|----------|---------|------|
| PR-2 | src/agent/managers/{memoryInspector:1040-1062, memoryDecayScheduler:330-353, memoryAdvisor:520-545}.ts | 3 次 | LLM judge + demote 三件套：`parseLlmJson<{...}>(llmResponse.trim())` → 判 null → throw → 取字段 → demote 记忆。已 3 次重复，超 ADR-017 枝叶层阈值 |
| PR-3 | src/memory/userProfile.ts:363, 376 | 2 次 | `const validCategories: ProfileCategory[] = ['identity', 'preference', 'expertise', 'habit', 'history']` 在 parseContentField 内重复声明 |
| PR-4 | src/memory/inMemoryStorage.ts:259-287 | 3 次 | `search()` 内 `.sort(byScoreDesc).slice(0, limit).map((m) => ({ ...m }))` 模式重复（含两个等价分支） |
| PR-5 | src/memory/store.ts:53-60, 96-103 | 2 次 | `read()` 和 `list()` 内 "toError + 检查 ENOENT + 其他错误 logger.warn" 模式完全重复 |

### 2.3 过早抽象逆命题（P2 · 单消费者候选）

| ID | 文件:行号 | 描述 | 处置 |
|----|----------|------|------|
| PR-6 | src/agent/managers/insightExtractor.ts:206-208 | `bindOnConflict(fn)` 单行代理方法委托给 relationBuilder，仅 agent.ts:768 一处调用 | 归档观察项 LONG-B14（属 Agent.init 接线门面，可能合理保留） |
| PR-7 | src/agent/managers/sessionArchiver.ts:56-59 | `truncateContent` 单消费者私有函数，封装 MAX_MESSAGE_CHARS 领域常量 | 归档观察项 LONG-B15（封装领域常量，可能合理保留） |
| PR-8 | src/memory/hybridMerge.ts:25, 28 | `VECTOR_SCORE_WEIGHT` 和 `MEMORY_SCORE_WEIGHT` 被 export 但仅本模块内部使用（`RECALL_LIMIT_MULTIPLIER` 才有外部消费者） | 归档待办 STEP1-2 |

### 2.4 冗余 API（P3 · 调用方改动成本高）

| ID | 文件:行号 | 描述 | 处置 |
|----|----------|------|------|
| PR-9 | src/agent/messageHistory.ts:65, 70, 77 | `currentDateValue` / `currentSessionValue` / `session` 三个 getter，其中 `currentSessionValue` 与 `session` 实现完全相同（生产代码 sessionManager.ts:91 + memoryInspector.ts:388 + 4 处测试均有引用） | 归档观察项 LONG-B16（涉及调用方改动） |

### 2.5 未删除的迁移残留

| ID | 文件:行号 | 描述 | 处置 |
|----|----------|------|------|
| PR-10 | src/memory/types.ts:53, 106 | `parseMemory` 函数和 `MemorySchema` 常量仅被 `__tests__/types.test.ts` 使用，生产代码无消费者（store.ts 中的 parseMemory 是 FileStore 私有方法同名不同实现） | 归档待办 STEP1-3（约 50 行测试专用代码，需评估是测试 API 还是死代码） |
| PR-11 | src/agent/managers/workProjection.ts:31 | `import { toError } from '@/utils/toError.js'`，其他 6 处统一从 `@/utils/errors.js` 导入 | 归档待办 STEP1-4 |
| PR-12 | src/memory/projectManager.ts:36 | `ProjectEntry` 双重 re-export（注释"保持公共 API 向后兼容"，index.ts:116 已直连导出） | 归档观察项 LONG-B17（迁移路径残留） |

---

## 3. 提交前审查

### 3.1 异常处理一致性

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-1 | src/agent/managers/memoryInspector.ts:1055 | `throw new Error('LLM 去重判断返回非法 JSON')` | 改为 `throw configError('LLM 去重判断返回非法 JSON', 'parseLlmJson 返回 null', ['检查 backgroundProvider 响应格式'])` |
| QC-2 | src/agent/managers/memoryDecayScheduler.ts:345 | `throw new Error('LLM 时效性判断返回非法 JSON')` | 同上模式 |
| QC-3 | src/agent/managers/memoryAdvisor.ts:533 | `throw new Error('LLM 冲突判断返回非法 JSON')` | 同上模式 |
| QC-4 | src/memory/types.ts:55,64,72,80,87 | `parseMemory` 内 5 处 `throw new Error('Memory 解析失败：...')` | 改为 `throw configError('Memory 解析失败', '<详情>', ['<排查建议>'])`。注：parseMemory 当前仅测试使用（见 PR-10），若决定删除 parseMemory 则本问题自动消解 |

### 3.2 类型与契约

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-5 | src/memory/userProfile.ts:361 | `const parsed = JSON.parse(content) as { category?: string; value?: string }` 使用 `as` 断言，与项目 QC-24 类型守卫模式不一致（lockManager.ts:100、projectRegistry.ts:162 已统一采用 `isXxx` 类型守卫） | 新增 `isProfileContent(value: unknown): value is { category: string; value: string }` 类型守卫替代 `as` |

### 3.3 兜底默认值合规性

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-6 | src/memory/userProfile.ts:384 | `parseContentField` 最终降级 `return { category: 'identity', value: content }`——`identity` 是用户身份画像（高敏感类别），将未知数据默认归为身份可能污染画像（如把"偏好-咖啡"误归为身份） | 降级路径应改为中性默认 `'history'`（低敏感分类），或抛 `configError` 由调用方决定跳过 |

### 3.4 命名与冗余

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-7 | src/memory/lockManager.ts:102 | `const info = parsed;` 在类型守卫 `isLockInfo(parsed)` 之后创建无语义别名 `info`，违反 coding-convention §6.6（`info` 是无语义命名） | 直接使用 `parsed.pid` / `parsed.acquiredAt` / `parsed.hostname`，删除冗余别名；或改名为 `lockInfo` 表达"已校验的 LockInfo"语义 |

### 3.5 文件长度监控（对照 LONG-B1）

| 文件 | 当前行数 | 上次记录 | 增量 | 阈值 | 状态 |
|------|---------|---------|------|------|------|
| src/agent/agent.ts | 1349 | 1293 | +56 | 1500 | ⚠️ 接近阈值，需关注 |
| src/agent/loop.ts | 1036 | 1027 | +9 | 单方法 100 行 | ✅ 在控 |
| src/agent/managers/memoryInspector.ts | 1054 | — | 新发现 | — | ⚠️ 单 Manager 超 1000 行，建议下次年轮审判评估拆分 |

---

## 4. 已归档项重新评估（来自 tasks/待完成任务.md）

| 原编号 | 当前状态 | 重新评估结论 |
|--------|---------|-------------|
| LONG-C13（agent/toolExecutor.ts import node:fs/promises） | ⏸️ 已归档 | 维持归档：内置 read_file/write_file/list_dir 工具实现属设计意图，ADR-002 §"内核浏览器可 import 的定位澄清"已正式文档化 13 个文件的 node:* 依赖 |
| LONG-C16（projectManager.ts listProjects @deprecated 但仍被宿主使用） | ⏸️ 已归档 | 维持归档：本次扫描确认 hosts/memora-sprite/src/electron/ipc/systemHandlers.ts、settingsController.ts、web/routes/systemRoutes.ts 仍在使用，等宿主项目下次重构时迁移 |
| LONG-B1（agent.ts/loop.ts 文件长度监控） | ⏸️ 观察期 | 维持观察：agent.ts 1349 行（阈值 1500），loop.ts 1036 行（单方法阈值 100 行） |
| LONG-B2（4 处文档化预留字段/参数清理） | ⏸️ 暂缓 | 不在本次范围 |

---

## 5. 汇总

### 5.1 量化指标

| 维度 | 数量 |
|------|------|
| 已对齐项（AL-1 ~ AL-10） | 10 项 |
| 已剪枝识别（PR-1 ~ PR-12） | 12 项 |
| 已审查修复发现（QC-1 ~ QC-7） | 7 项 |
| 归档待办（STEP1-1 ~ STEP1-4） | 4 项 |
| 归档观察项（LONG-B14 ~ LONG-B17） | 4 项 |
| 测试基线 | 1544 通过 / 0 失败 |

### 5.2 优先级分布

| 优先级 | 数量 | 项目 |
|--------|------|------|
| P0 零容忍（必须打包前修复） | 3 | AL-V3/PR-1（decayTimer 死代码） + AL-V1/QC-1~3（3 处裸 throw） |
| P1 中优先级（建议打包前修复） | 6 | AL-V2/QC-4（parseMemory 5 处裸 throw） + PR-2（LLM judge 三件套重复） + PR-3/PR-4/PR-5（memory 内 3 处重复） |
| P2 低优先级（可下一轮迭代） | 4 | QC-5（as 断言） + QC-6（兜底 identity） + PR-8（过早 export） + PR-11（import 不一致） |
| P3 观察项（不立即处理） | 5 | PR-6/PR-7（过早抽象候选） + PR-9（冗余 API） + PR-10（测试专用代码） + PR-12（双重 re-export） + QC-7（冗余别名） |

### 5.3 ADR-017 枝叶层 2 次提取原则触发清单

| 候选 | 触发次数 | 建议提取目标 |
|------|---------|------------|
| LLM judge + demote 三件套（PR-2） | 3 次 | `src/agent/managers/llmJudgeHelper.ts` 高阶函数 |
| VALID_PROFILE_CATEGORIES 数组（PR-3） | 2 次 | `src/memory/userProfile.ts` 模块级常量 |
| inMemoryStorage.search 排序切片模式（PR-4） | 3 次 | `inMemoryStorage.ts` 私有 `sortCopyLimit` 方法 |
| store.ts 错误处理（PR-5） | 2 次 | `store.ts` 私有 `handleFsError` 方法 |

---

## 6. Git Commit 建议

本次审查为只读扫描，未修改任何代码。建议按以下顺序提交后续修复（每条独立可回滚）：

```
# P0 修复（必须打包前完成）
fix(agent): 移除 agent.ts 中已死的 decayTimer 字段及 close 死分支
   - 删除 line 154 字段声明
   - 删除 line 294 init 阶段强制赋 null
   - 删除 line 1122-1125 close 死分支
   - 参考：tasks/打包前审查/step-1-memora-core.md PR-1

fix(agent): 统一 LLM judge 异常为 MemoraError 体系
   - memoryInspector.ts:1055 / memoryDecayScheduler.ts:345 / memoryAdvisor.ts:533
   - 改 throw new Error 为 configError 工厂
   - 参考：tasks/打包前审查/step-1-memora-core.md QC-1~3

# P1 修复（建议打包前完成）
fix(memory): parseMemory 异常改用 MemoraError 体系
   - types.ts:55,64,72,80,87 五处 throw new Error 改 configError
   - 或评估删除 parseMemory（若仅测试使用，参见 PR-10）
   - 参考：tasks/打包前审查/step-1-memora-core.md QC-4

refactor(agent): 提取 LLM judge 三件套到 llmJudgeHelper
   - 新增 src/agent/managers/llmJudgeHelper.ts
   - 抽象 runLlmJudge<T> 高阶函数
   - 三个 Manager 改为消费 helper
   - 参考：tasks/打包前审查/step-1-memora-core.md PR-2

refactor(memory): 提取 userProfile VALID_PROFILE_CATEGORIES 常量
   - userProfile.ts:363,376 重复数组提取为模块级常量
   - 参考：tasks/打包前审查/step-1-memora-core.md PR-3

refactor(memory): inMemoryStorage.search 提取 sortCopyLimit 私有方法
   - 合并两个等价分支
   - 参考：tasks/打包前审查/step-1-memora-core.md PR-4

refactor(memory): store.ts 提取 handleFsError 私有方法
   - read/list 错误处理统一
   - 参考：tasks/打包前审查/step-1-memora-core.md PR-5

# P2 修复（可下一轮迭代）
refactor(memory): userProfile.parseContentField 改用类型守卫替代 as 断言
   - QC-24 一致性
   - 参考：tasks/打包前审查/step-1-memora-core.md QC-5

fix(memory): userProfile 兜底分类从 identity 改为 history
   - 避免未知数据污染身份画像
   - 参考：tasks/打包前审查/step-1-memora-core.md QC-6

refactor(memory): hybridMerge 移除 VECTOR/MEMORY_SCORE_WEIGHT 多余 export
   - PR-8
```

---

## 7. 后序衔接

完成本步审查后，建议进入 **Step 2 · memora 内核基础设施层**：
- `src/security/`（路径白名单 + 写入确认 + Prompt 注入防御）
- `src/config/`（配置加载 + 环境变量展开）
- `src/logging/`（ILogger 接口 + console fallback）
- `src/utils/`（13 个工具文件）
- `src/llm/`（LLM 适配层）
- `src/persona/`（角色管理）
- `src/skill/`（技能管理）
- `src/eval/`（评估框架）

预计文件数：约 35-40 个，行数约 4000-5000 行。
