# Step 2 · Memora 内核基础设施层 · 打包前审查报告

> **审查模式**：问诊·炼化归元（规则对齐 → 剪枝 → 提交前审查）
> **审查范围**：`src/llm/`（6 文件）+ `src/utils/`（15 文件）+ `src/eval/`（3 文件）+ `src/config/`（1 文件）+ `src/logging/`（2 文件）+ `src/persona/`（2 文件）+ `src/security/`（1 文件）+ `src/skill/`（2 文件）= 32 源文件 + 26 测试文件
> **审查日期**：2026-07-19
> **后续衔接**：Step 3（sprite 主进程层）

---

## 1. 规则对齐

### 1.1 已对齐项（合规无问题）

| # | 规则 | 验证方式 | 结果 |
|---|------|----------|------|
| AL-1 | ADR-002 内核零依赖（无 better-sqlite3/electron/commander/zod） | Grep 全量扫描 8 模块 | ✅ 0 处违规 |
| AL-2 | project-rules §7.1 零容忍 `@ts-ignore` / `as any` | Grep 全量扫描 | ✅ 0 处违规 |
| AL-3 | project-rules §7.1 零容忍生产 `console.log` | Grep `console\.(log\|debug\|info\|warn\|error)` | ✅ 0 处违规（仅 JSDoc 示例 + 测试文件） |
| AL-4 | coding-convention §2 不吞异常（无空 catch 块） | Grep multiline `catch\s*\([^)]*\)\s*\{\s*\}` | ✅ 0 处违规 |
| AL-5 | 无 TODO/FIXME/XXX/HACK 遗留 | Grep 全量扫描 | ✅ 0 处遗留 |
| AL-6 | ADR-003 OpenAI Chat Completions 兼容协议 | 检查 openaiCompatible.ts | ✅ 流式 SSE + tool_calls delta 累积 + response_format 透传 |
| AL-7 | ADR-006 两级权限 + 路径白名单 | 检查 pathGuard.ts | ✅ BLOCKED_PATTERNS(28) + allowedRoots + fail-closed 写入确认 |
| AL-8 | ADR-006 符号链接逃逸防护 | 检查 resolveRealpath | ✅ 逐级向上查找已存在父目录 |
| AL-9 | ADR-006 NFKC 规范化防全角字符绕过 | 检查 assertPathAllowed:254 | ✅ absolutePath.normalize('NFKC') |
| AL-10 | ADR-006 SEC-AUDIT redact 配置 | 检查 logger.ts | ✅ PINO_REDACT_PATHS + SENSITIVE_KEY_PATTERN 双重脱敏 |
| AL-11 | project-rules §7.4 LlmProvider 构造函数注入 | 检查 OpenAICompatibleProvider | ✅ constructor(name, config)，Agent 不管理 API keys |
| AL-12 | project-rules §7.4 Agent 不含 CLI/REPL 逻辑 | 检查 llm/ + config/ + logging/ | ✅ 全部为接口/实现，无 CLI |
| AL-13 | ADR-017 枝叶层 2 次提取：mergeAbortSignals | openaiCompatible + embedding 共用 | ✅ 已提取到 abortSignal.ts |
| AL-14 | ADR-017 枝叶层 2 次提取：byScoreDesc | 5 文件消费（skillManager/personaManager/memoryInspector/memoryAdvisor/inMemoryStorage） | ✅ 已提取到 utils/array.ts |
| AL-15 | ADR-017 枝叶层 2 次提取：isPlainObject | lockManager + projectRegistry 共用 | ✅ 已提取到 utils/objects.ts |
| AL-16 | ADR-017 枝叶层 2 次提取：getBaseName | agent.ts + workProjection.ts 共用 | ✅ 已提取到 utils/path.ts |
| AL-17 | ADR-017 枝叶层 2 次提取：parseLlmJson | insightExtractor + workProjection 共用 | ✅ 已提取到 utils/json.ts |
| AL-18 | ADR-017 枝叶层 2 次提取：truncate | 15 处散落 slice+suffix 模式 | ✅ 已提取到 utils/strings.ts |
| AL-19 | ADR-017 枝叶层 2 次提取：chatBusyError | 12 处调用点 | ✅ 已提取到 utils/errors.ts |
| AL-20 | ADR-017 枝叶层 2 次提取：segmentLower | 6 处散落 .map(toLowerCase) 模式 | ✅ 已提取到 utils/segmenter.ts |
| AL-21 | ADR-002 logger pino 动态 import | 检查 logger.ts | ✅ `await import('pino')`，pino 是 peerDependency |
| AL-22 | backend_layers §依赖方向（utils/ 不反向依赖 agent/） | Grep `from '@/agent/'` in utils/ | ✅ 0 处反向依赖 |
| AL-23 | backend_layers §依赖方向（logging/ 不反向依赖 agent/） | Grep `from '@/agent/'` in logging/ | ✅ 0 处反向依赖 |
| AL-24 | backend_layers §依赖方向（config/ 不反向依赖 agent/+memory/+llm/） | Grep in config/ | ✅ 0 处反向依赖 |
| AL-25 | backend_layers §依赖方向（utils/loggerHolder type-only import） | 检查 loggerHolder.ts:24 | ✅ `import type` 编译时擦除 |
| AL-26 | backend_layers §依赖方向（llm/embedding → memory/vectorStore type-only） | 检查 embedding.ts:20 | ✅ `import type` 依赖倒置 |
| AL-27 | project-rules §1.5 配置文件是真理源：DEFAULT_CONFIG 单一真理源 | 检查 config/loader.ts:161 | ✅ parseConfig({}) 得到完整默认配置 |
| AL-28 | project-rules §1.5 expandEnvVars 覆盖所有通道 | 检查 expandEnvVars | ✅ llm + providers + background + embedding 四通道 |
| AL-29 | ADR-007 Number.isFinite 校验（排除 NaN/Infinity） | Grep `Number.isFinite` | ✅ 9 处使用（loader.ts 3 + vectorStore.ts 1 + types.ts 1 + store.ts 1 + personaManager.ts 1） |
| AL-30 | project-rules §7.2 utils/ 工具函数纯净性 | 检查 utils/* | ✅ 仅 scanner.ts 用 node:fs/promises（合理文件 I/O 工具），path.ts 用 node:os（合理） |
| AL-31 | ADR-002 eval 框架零依赖（仅内核模块） | 检查 evalRunner.ts | ✅ 仅 `import type Agent` + evalTypes |
| AL-32 | ADR-004 记忆统一模型（source 开放字符串） | 检查 personaManager/skillManager | ✅ SOURCE_LABELS.PERSONA/SKILL 作为 source 写入 SQLite |

### 1.2 规则对齐发现的违规

| ID | 规则 | 文件:行号 | 性质 |
|----|------|----------|------|
| AL-V1 | project-rules §7.1 零容忍裸 throw Error（统一 MemoraError 体系） | src/config/loader.ts:262,283,301,325,332,335,368,371,399 | 9 处违规 |

---

## 2. 剪枝（识别冗余，不立即删除）

### 2.1 死代码（P0 · 零容忍）

无。本次审查范围内无死代码。

### 2.2 重复代码（P1 · 枝叶层 2 次提取原则候选）

| ID | 文件:行号 | 重复次数 | 描述 |
|----|----------|---------|------|
| PR-1 | src/config/loader.ts:300-399 | 9 次 | `typeof xxx !== 'string'` + `throw new Error('xxx 必须是字符串/对象')` 校验模式重复（allowedPaths[i] / providers.${key} / providers.${key}.provider / providers.${key}.model / background.provider / background.model / embedding.model 等） |
| PR-2 | src/logging/logger.ts:99-135 | 4 次 | console fallback logger 的 info/warn/error/debug 4 个方法实现完全同构：`if (!shouldLog('xxx')) return; const text = ...; if (typeof objOrMsg === 'object') console.error(...); else console.error(...);` |

### 2.3 预留字段（P2 · LONG-B2 类型）

| ID | 文件:行号 | 描述 | 处置 |
|----|----------|------|------|
| PR-3 | src/llm/provider.ts:49-56 | `stream?: boolean` 字段注释为"预留字段，当前无消费者"——Grep `\.stream\b` 在生产代码 0 处消费 | 归档观察项 LONG-B18 |
| PR-4 | src/skill/types.ts:19-27 | `layer: 'agent' \| 'project'` 字段注释为"预留字段，当前仅写入无读取消费者"——Grep `\.layer\b` 在生产代码 0 处读取（仅 skillManager.ts:261 写入 + configManager.ts:251 写入） | 归档观察项 LONG-B19 |

### 2.4 测试镜像缺失（P3 · ADR-007 宽松覆盖）

| ID | 文件 | 描述 | 处置 |
|----|------|------|------|
| PR-5 | src/utils/array.ts | 1 函数工具文件（byScoreDesc），无独立 array.test.ts，通过 5 个消费者测试间接覆盖 | 归档观察项 |
| PR-6 | src/utils/objects.ts | 1 函数工具文件（isPlainObject），无独立 objects.test.ts，通过 lockManager/projectRegistry 测试间接覆盖 | 归档观察项 |
| PR-7 | src/llm/abortSignal.ts | 1 函数工具文件（mergeAbortSignals），无独立 abortSignal.test.ts，通过 openaiCompatible.test.ts + embedding.test.ts 间接覆盖 | 归档观察项 |

### 2.5 STEP1-12 重新评估

| ID | 原状态 | 重新评估结论 |
|----|--------|-------------|
| STEP1-12（src/agent/managers/workProjection.ts:31 `import { toError } from '@/utils/toError.js'`） | ⏸️ 待实施 | **非违规**：errors.ts:19 注释明确支持两种导入路径——"单独需要零 logger 依赖的 toError 时应直接 import from '@/utils/toError.js'（浏览器友好）"。workProjection.ts 只用 toError 走 toError.js 路径符合设计意图，无需修改。建议从待完成任务中迁移到已完成（标注"重新评估为非违规"）。 |

---

## 3. 提交前审查

### 3.1 异常处理一致性（P0 · 必须打包前修复）

config/loader.ts 内 9 处裸 `throw new Error`，违反 project-rules §7.1 零容忍规则：

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-1 | src/config/loader.ts:262 | `throw new Error(\`temperature 必须在 0-2 之间，当前值: ${value}\`)` | 改为 `throw configError('配置校验失败', \`temperature 必须在 0-2 之间，当前值: ${value}\`, ['检查 config.json 的 llm.temperature 字段'])` |
| QC-2 | src/config/loader.ts:283 | `throw new Error(\`security.permission 必须为 "owner" 或 "guest"，收到: ${JSON.stringify(value)}\`)` | 同上模式，suggestions: ['修改 security.permission 为 "owner" 或 "guest"'] |
| QC-3 | src/config/loader.ts:301 | `throw new Error(\`allowedPaths[${i}] 必须是字符串，当前类型: ${typeof value[i]}\`)` | 同上模式 |
| QC-4 | src/config/loader.ts:325 | `throw new Error(\`providers.${key} 必须是对象\`)` | 同上模式 |
| QC-5 | src/config/loader.ts:332 | `throw new Error(\`providers.${key}.provider 必须是字符串\`)` | 同上模式 |
| QC-6 | src/config/loader.ts:335 | `throw new Error(\`providers.${key}.model 必须是字符串\`)` | 同上模式 |
| QC-7 | src/config/loader.ts:368 | `throw new Error('background.provider 必须是字符串')` | 同上模式 |
| QC-8 | src/config/loader.ts:371 | `throw new Error('background.model 必须是字符串')` | 同上模式 |
| QC-9 | src/config/loader.ts:399 | `throw new Error('embedding.model 必须是字符串')` | 同上模式 |

**修复策略**：9 处统一改为 `configError` 工厂；同时提取 `assertString(value: unknown, field: string): string` 工具函数消除 PR-1 重复模式。修复后 PR-1 + QC-1~9 一并消解。

### 3.2 重复代码提取（P1 · 建议打包前修复）

| ID | 文件:行号 | 问题 | 修复建议 |
|----|----------|------|---------|
| QC-10 | src/logging/logger.ts:99-135 | 4 处 console fallback logger 方法（info/warn/error/debug）实现同构：shouldLog 守卫 + text 提取 + redactSensitiveKeys + console.error | 提取 `createConsoleLogFn(level: 'info' \| 'warn' \| 'error' \| 'debug'): LogFn` 高阶函数。修复后 PR-2 自动消解 |

### 3.3 文件长度监控

| 文件 | 当前行数 | 阈值 | 状态 |
|------|---------|------|------|
| src/config/loader.ts | 519 | 800 | ✅ 在控 |
| src/logging/logger.ts | 339 | 800 | ✅ 在控 |
| src/llm/openaiCompatible.ts | 448 | 800 | ✅ 在控 |
| src/security/pathGuard.ts | 439 | 800 | ✅ 在控 |
| src/persona/personaManager.ts | 454 | 800 | ✅ 在控 |
| src/skill/skillManager.ts | 271 | 800 | ✅ 在控 |
| src/eval/evalRunner.ts | 195 | 800 | ✅ 在控 |
| src/llm/embedding.ts | 230 | 800 | ✅ 在控 |
| src/llm/factory.ts | 149 | 800 | ✅ 在控 |
| src/utils/scanner.ts | 134 | 800 | ✅ 在控 |

无文件长度告警。

---

## 4. 已归档项重新评估（来自 tasks/待完成任务.md）

| 原编号 | 当前状态 | 重新评估结论 |
|--------|---------|-------------|
| LONG-B2（4 处文档化预留字段/参数清理） | ⏸️ 暂缓 | 本次新发现 2 处预留字段（PR-3 `ChatOptions.stream` + PR-4 `SkillEntry.layer`），追加到 LONG-B2 范围。LONG-B2 现共 6 处预留字段待统一评估 |
| STEP1-12（workProjection.ts import 不一致） | ⏸️ 待实施 | **重新评估为非违规**：errors.ts:19 注释明确支持 `@/utils/toError.js` 路径。建议迁移到已完成任务.md（标注"重新评估为非违规"） |

---

## 5. 汇总

### 5.1 量化指标

| 维度 | 数量 |
|------|------|
| 已对齐项（AL-1 ~ AL-32） | 32 项 |
| 已剪枝识别（PR-1 ~ PR-7） | 7 项 |
| 已审查发现（QC-1 ~ QC-10） | 10 项（其中 9 项 P0 + 1 项 P1） |
| 归档待办（STEP2-1 ~ STEP2-2） | 2 项（1 项 P0 + 1 项 P1） |
| 归档观察项（LONG-B18 ~ LONG-B19） | 2 项 |
| STEP1-12 重新评估为非违规 | 1 项 |

### 5.2 优先级分布

| 优先级 | 数量 | 项目 |
|--------|------|------|
| P0 零容忍（必须打包前修复） | 1 项（含 9 处） | AL-V1 / QC-1~9（config/loader.ts 9 处裸 throw，可与 PR-1 提取合并修复） |
| P1 中优先级（建议打包前修复） | 1 项 | PR-2 / QC-10（logger.ts 4 处 console fallback 重复） |
| P2 低优先级（可下一轮迭代） | 0 | — |
| P3 观察项（不立即处理） | 7 项 | PR-3/PR-4（预留字段 → LONG-B18/19）+ PR-5/PR-6/PR-7（测试镜像缺失）+ STEP1-12（重新评估为非违规）+ LONG-B2 追加 2 处 |

### 5.3 ADR-017 枝叶层 2 次提取原则触发清单

| 候选 | 触发次数 | 建议提取目标 |
|------|---------|------------|
| 配置字符串校验模式（PR-1） | 9 次 | `src/utils/assertString.ts`（或合并到 `src/config/validators.ts` 私有函数） |
| console fallback log 方法（PR-2） | 4 次 | `src/logging/logger.ts` 私有 `createConsoleLogFn` 高阶函数 |

### 5.4 与 Step 1 对比

| 维度 | Step 1（agent + memory） | Step 2（基础设施 8 模块） |
|------|-------------------------|-------------------------|
| 已对齐项 | 10 项 | 32 项 |
| 违规数 | 3 项（含 8 处） | 1 项（含 9 处） |
| 重复代码候选 | 5 项 | 2 项 |
| 死代码 | 1 项（decayTimer） | 0 项 |
| 归档待办 | 4 项 | 4 项 |
| 测试基线 | 1544 通过 / 0 失败 | 待 Step 2 完成后全量验证 |

Step 2 范围整体健康度优于 Step 1——基础设施层模块设计成熟，枝叶层 2 次提取原则已大量应用（mergeAbortSignals/byScoreDesc/isPlainObject/getBaseName/parseLlmJson/truncate/chatBusyError/segmentLower 共 8 处合规提取）。

---

## 6. Git Commit 建议

本次审查为只读扫描，未修改任何代码。建议按以下顺序提交后续修复（每条独立可回滚）：

```
# P0 修复（必须打包前完成）
refactor(config): 提取 assertString 工具 + 统一 9 处裸 throw 为 configError
   - 新增 src/utils/assertString.ts（或私有函数）
   - config/loader.ts:262,283,301,325,332,335,368,371,399 改用 configError 工厂
   - 顺便消除 PR-1（9 次重复校验模式）
   - 参考：tasks/打包前审查/step-2-memora-infra.md QC-1~9 + PR-1

# P1 修复（建议打包前完成）
refactor(logging): 提取 createConsoleLogFn 高阶函数消除 4 处 console fallback 重复
   - logging/logger.ts:99-135 info/warn/error/debug 4 方法实现同构
   - 提取后顺便消除 PR-2
   - 参考：tasks/打包前审查/step-2-memora-infra.md QC-10 + PR-2

# 任务清单维护
chore(tasks): STEP1-12 重新评估为非违规，迁移到已完成任务.md
   - 参考：tasks/打包前审查/step-2-memora-infra.md §2.5
```

---

## 7. 后序衔接

完成本步审查后，建议进入 **Step 3 · sprite 主进程层**：

- `hosts/memora-sprite/src/electron/main/`（Electron 主进程入口 + IPC + 系统 API 封装）
- `hosts/memora-sprite/src/electron/ipc/`（IPC 通道处理，当前 117 通道接近 130 治理阈值）
- `hosts/memora-sprite/src/electron/storage/`（better-sqlite3 + 向量存储注入）

预计文件数：约 25-35 个，行数约 5000-7000 行。
