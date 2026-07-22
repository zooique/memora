# Step 2 · memora 内核基础设施层审查报告

> **审查日期**：2026-07-19
> **审查范围**：`src/llm/`（6 文件）+ `src/utils/`（15 文件）+ `src/eval/`（3 文件）+ `src/config/`（1 文件）+ `src/logging/`（2 文件）+ `src/persona/`（2 文件）+ `src/security/`（1 文件）+ `src/skill/`（2 文件）
> **审查方式**：不依赖项目规则，凭工程经验逐文件阅读关键代码
> **审查人**：资深程序员（AI 代理）

---

## 一、模块总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **总体评分** | **8.0 / 10** | 基础设施层质量扎实，安全与错误处理突出。存在少量职责边界问题和潜在的 fire-and-forget 风险 |
| **LLM 适配层** | ★★★★☆ (4/5) | Provider 抽象简洁，SSE 解析健壮，超时/中止机制完善。预设 Provider 硬编码与项目记忆决策矛盾 |
| **utils 工具函数** | ★★★★☆ (4/5) | 大部分纯函数，设计良好。`scanner.ts` 和 `path.ts` 引入 I/O 依赖，违反 utils 纯函数预期 |
| **eval 评估框架** | ★★★★★ (5/5) | 设计简洁，类型定义清晰，错误隔离完善，超时保护到位 |
| **config 配置加载** | ★★★★☆ (4/5) | 手动校验完备，环境变量展开全面。无 schema 声明文件，新增字段需修改多处 |
| **logging 日志** | ★★★★★ (5/5) | 懒加载 pino 升级、敏感信息脱敏、console fallback、宿主注入——设计成熟 |
| **persona 角色管理** | ★★★★☆ (4/5) | 防抖机制合理，热重载完善。`writeAllToIndex` fire-and-forget 存在静默失败风险 |
| **security 安全** | ★★★★★ (5/5) | 符号链接解析、NFKC 规范化、黑名单全面、fail-closed 写入确认——安全实践标杆 |
| **skill 技能管理** | ★★★★☆ (4/5) | 匹配逻辑清晰，热重载完善。与 PersonaManager 同构的 write-to-index 问题同样存在 |

---

## 二、逐模块审查

### 2.1 LLM 适配层（`src/llm/`）

#### 2.1.1 Provider 抽象（provider.ts）

**结论**：🟢 抽象简洁有效。

- `LlmProvider` 抽象类仅需子类实现 `name` 和 `chat()`，最小化接口
- `ChatOptions` 覆盖了 `signal`、`timeoutMs`、`tools`、`response_format`、`stream` 等关键选项
- `supportsStructuredOutput` 默认为 `false`，子类可按需覆盖——合理的渐进增强
- `Message` 接口涵盖 `tool_calls` 和 `toolCallId`，支持完整的工具调用往返

**评分**：🟢 优秀

#### 2.1.2 SSE 流式解析（openaiCompatible.ts）

**结论**：🟢 流式处理健壮，超时机制完善。

**正面评价**：
- SSE 解析器正确处理 `tool_calls` delta 累积（按 index 分片累积 name + arguments）
- finish_reason 为 `stop`/`length` 等非 tool_calls 值时主动清空累积器，防止污染下一次调用
- `[DONE]` 标记时兜底输出累积的 tool_calls
- 首 chunk 超时 120s + chunk 间超时 60s 的区分设计，适配 reasoning 模型（DeepSeek-R1/o1 等）
- `reader.cancel()` 在 finally 中确保底层 TCP 连接释放
- `safeCancelBody()` 在 HTTP 错误和 SSE 异常路径中均调用，防止连接泄漏
- `formatMessages()` 处理了空字符串 content → null 的兼容性转换（部分 provider 对空字符串 content 处理异常）

**改进建议**：

🟡 STEP2-ATTN-1：`parseSseStream` 中 `choice.delta?.content` 使用 truthy 检查（[openaiCompatible.ts:373](file:///f:/zooique/memora/src/llm/openaiCompatible.ts#L373)），空字符串 `""` 会被跳过。虽然注释说"空字符串在流式中极少出现"，但严格来说应该用 `!= null` 而非 truthy 检查，以区分 `null`/`undefined` 和合法的空字符串。当前行为在极端情况下可能丢失空字符串内容。

```typescript
// 当前（truthy 检查，"" 被跳过）
if (choice.delta?.content) chunk.content = choice.delta.content;

// 建议（null/undefined 检查，"" 保留）
if (choice.delta?.content != null) chunk.content = choice.delta.content;
```

⚪ STEP2-SUG-1：`handleResponseError` 中 `errorText.slice(0, 200)` 在 4 处重复（[openaiCompatible.ts:195-221](file:///f:/zooique/memora/src/llm/openaiCompatible.ts#L195-L221)），虽然已有 `MAX_ERROR_BODY_LEN` 常量，但 `.slice(0, MAX_ERROR_BODY_LEN)` 本身仍重复 4 次。可提取为局部变量 `errorPreview`。

**评分**：🟢 优秀

#### 2.1.3 AbortSignal 合并（abortSignal.ts）

**结论**：🟢 设计精巧。

- `mergeAbortSignals` 返回 `{ signal, clearTimer, dispose }` 三个清理函数，语义清晰
- `clearTimer` 仅清超时（流式阶段保留外部信号监听），`dispose` 完整清理——区分场景使用
- 外部信号已 abort 时立即同步 abort 内部 controller（`optsSignal.aborted` 检查）
- 外部信号监听使用 `{ once: true }`，防止重复触发

**评分**：🟢 优秀

#### 2.1.4 Provider 工厂（factory.ts）

**结论**：🟡 预设 Provider 硬编码。

- `createLlmProvider` 兼容新旧两种配置格式，过渡平滑
- `createProviderFromConfig` 中 `baseUrl` 使用 `||` 而非 `??`（空字符串视为未配置）——正确
- apiKey 缺失在工厂阶段就报错，比等到 `chat()` 调用时失败更友好

**改进建议**：

🟡 STEP2-ATTN-2：`presets` 对象（[factory.ts:14-18](file:///f:/zooique/memora/src/llm/factory.ts#L14-L18)）硬编码了 deepseek/doubao/openai 的默认 baseUrl 和 model。项目记忆明确记录"Built-in LLM Provider presets are rejected due to rapid changes in models and providers — a single custom configuration entry is preferred for flexibility"。当前代码中预设仍存在，虽然用户配置了自定义 provider 时不会触发预设，但代码层面存在矛盾——建议要么移除预设，要么更新项目记忆。

**评分**：🟢 良好（预设问题是已知决策，非设计缺陷）

#### 2.1.5 Embedding Provider（embedding.ts）

**结论**：🟢 设计良好。

- LRU 缓存（Map 迭代顺序 = 最近访问顺序）实现简洁，上限 1000 条防内存泄漏
- `batchEmbed` 先过滤缓存命中，仅对未命中文本调用 API——减少 API 调用
- 复用 `mergeAbortSignals`（与 openaiCompatible.ts 同构，已按 ADR-017 提取）
- 按 index 排序 API 返回结果，处理 API 不保证顺序的情况

**评分**：🟢 优秀

---

### 2.2 utils 工具函数（`src/utils/`，15 个文件）

#### 2.2.1 整体架构评价

**结论**：🟡 大部分是纯函数，但 `scanner.ts` 和 `path.ts` 引入了 I/O 依赖，削弱了 utils 层的纯净性。

| 文件 | 纯函数 | 副作用 | 外部依赖 |
|------|--------|--------|---------|
| `errors.ts` | ✅ | 无 | `toError.ts`（re-export） |
| `toError.ts` | ✅ | 无 | 零依赖 |
| `eventEmitter.ts` | ✅ | 无 | `loggerHolder.ts`（仅日志） |
| `safeTimer.ts` | ✅ | `setTimeout`/`setInterval` | 无 |
| `time.ts` | ✅ | 无 | 零依赖 |
| `segmenter.ts` | ✅ | 无 | `Intl.Segmenter`（内置 API） |
| `objects.ts` | ✅ | 无 | 零依赖 |
| `strings.ts` | ✅ | 无 | 零依赖 |
| `array.ts` | ✅ | 无 | 零依赖 |
| `math.ts` | ✅ | 无 | 零依赖 |
| `json.ts` | ✅ | 无 | 零依赖 |
| `frontmatter.ts` | ✅ | 无 | 零依赖 |
| `path.ts` | ⚠️ | `homedir()` 调用 | `node:os` |
| `scanner.ts` | ❌ | 文件 I/O | `node:fs/promises`, `node:path` |
| `loggerHolder.ts` | ✅ | 无 | `@/logging/loggerInterface.js`（type-only） |

**改进建议**：

🟡 STEP2-ATTN-3：`scanner.ts` 是 I/O 密集型模块（`readFile`、`readdir`、`access`），不应放在 `utils/` 下。`utils/` 在分层架构中的定位是"纯函数工具层"，但 `scanner.ts` 的职责是"Markdown 目录扫描 + frontmatter 解析"，更接近一个业务组件。建议迁移到 `src/scanner/` 或保留在 `utils/` 但明确标注其非纯函数属性。

`path.ts` 引入 `node:os` 的 `homedir()` 是轻量依赖（`homedir()` 本质是读取环境变量/系统 API），在 Node.js 专用内核的语境下可接受，但技术上不是纯函数。

#### 2.2.2 errors.ts vs toError.ts 职责分析

**结论**：🟢 无重叠，职责互补。

- `toError.ts`：纯函数，将 `unknown` → `Error`，零依赖，浏览器/Node.js 通用
- `errors.ts`：`MemoraError` 类 + 6 个工厂函数 + `ToolErrorCode` 枚举 + `chatBusyError` 模板，依赖 `toError.ts`
- `errors.ts` 第 20 行 re-export `toError`，提供"一站式 import"便利性

两者职责边界清晰：`toError` 是类型转换工具，`errors.ts` 是领域错误体系。无重叠。

#### 2.2.3 各文件要点

**eventEmitter.ts**：
- `TypedEventEmitter<EventMap>` 泛型约束事件名与载荷类型，编译期类型安全
- `emit()` 中 handler 异常被 catch 并记录日志，不中断其他 handler——符合事件发射器惯例
- `once()` 实现正确（wrapper 中先 `off` 再调用 handler）

**safeTimer.ts**：
- `activeTimers` 注册表用于追踪所有活跃定时器，`clearAllSafeTimers()` 用于测试隔离
- `safeSetTimeout` 回调中自动从注册表删除——注册表不会无限增长
- `clearSafeTimeout` 和 `clearSafeInterval` 接受 `null` 参数，调用方无需判空

**segmenter.ts**：
- `tokenizeKeywords` 是内部函数（不导出），仅供 `scoreByKeywords` 使用——封装良好
- `STOPWORDS` 从 `memory/types.ts` 迁入，职责归属正确（停用词是分词关注点）
- `segmentLower` 消除 6 处散落的 `.map(t => t.toLowerCase())` 模式

**json.ts**：
- `parseLlmJson` 4 级回退策略：直接解析 → 剥离代码块 → 修复单引号/尾逗号 → 正则提取
- 单引号修复正则 `(?<=[{\[:,\s])'|'(?=[}\]:,\s])` 使用 lookbehind/lookahead，精确匹配定界符位置的单引号
- 修复尾逗号：`, }` → `}`，`, ]` → `]`——覆盖 LLM 常见输出错误

**strings.ts**：
- `truncate` 统一 15 处散落的 `slice + suffix` 模式，后缀约定为 `…`（U+2026）
- `slugify` 保留中文字符（`\u4e00-\u9fff`），适合中文项目场景

**frontmatter.ts**：
- `parseFrontmatter` 正确处理空 frontmatter 块、空 body、两者皆空三种边界情况
- `serializeFrontmatter` 过滤 `undefined`/`null` 值，避免序列化出 `key: undefined`

**评分**：🟢 良好。`scanner.ts` 的职责归属是唯一的扣分点

---

### 2.3 eval 评估框架（`src/eval/`）

**结论**：🟢 设计简洁，质量高。

- `EvalScenario` 类型定义清晰，`expect` 字段涵盖 7 个检查维度
- `EvalRunner.runScenario` 错误隔离：任何异常都返回 `passed=false`，不中断批量执行
- `#runWithTimeout` 使用 `Promise.race` + `AbortController` 实现超时，finally 清理 timer
- `void runPromise.catch(() => {})` 抑制超时后的 unhandled rejection——考虑周全
- 每个场景创建独立 Agent 并 `close()`，通过 `try/finally` 确保资源释放
- 8 个标准场景覆盖护栏、工具调用、召回、完成状态、长输入、空召回六个维度
- `evaluateResult` 失败消息包含中文描述 + 实际值，便于定位

**改进建议**：

⚪ STEP2-SUG-2：`recallSources` 字段（[evalTypes.ts:75](file:///f:/zooique/memora/src/eval/evalTypes.ts#L75)）在 `EvalExpectation` 中定义但 `evaluateResult` 不检查，`SkillEntry.layer`（[skill/types.ts:26](file:///f:/zooique/memora/src/skill/types.ts#L26)）同样标注"预留字段，当前仅写入无读取消费者"。这些是合理的预留字段，但应在打包前确认是否需要在正式发布前移除或实现。

**评分**：🟢 优秀

---

### 2.4 config 配置加载（`src/config/`）

**结论**：🟢 手动校验完备，但缺少 schema 声明文件。

**正面评价**：
- 加载优先级链：显式指定 → 项目级 → 用户级 → 内置默认值，逐级 fallback
- `DEFAULT_CONFIG` 作为单一真理源，所有默认值集中声明
- `validateTemperature` 使用 `Number.isFinite` 排除 NaN/Infinity——正确
- `validatePermission` 对 `undefined`/`null` 回退默认值，对非法值抛错——合理
- `assertString` 消除 6 处重复的 `typeof x !== 'string' → throw` 模式
- `expandEnvVars` 覆盖 `providers`、`background`、`embedding` 三个通道的 `apiKey`/`baseUrl`
- `parseProviders` 过滤空字符串 `baseUrl`/`apiKey`（与顶层逻辑一致）

**改进建议**：

⚪ STEP2-SUG-3：`DEFAULT_MAX_CONTEXT_TOKENS` 与 `agent/constants.ts` 的 `AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS` 需要同步修改（[loader.ts:28-30](file:///f:/zooique/memora/src/config/loader.ts#L28-L30) 注释已说明）。虽然注释标注了"修改时需同步两处"，但缺乏编译期约束。建议在 `agent/constants.ts` 中引用 `DEFAULT_MAX_CONTEXT_TOKENS`（或反之），消除手动同步风险。

⚪ STEP2-SUG-4：无独立的配置 schema 声明文件。当前所有字段类型和默认值仅通过 `Config` 接口 + `DEFAULT_CONFIG` 常量表达，新增字段需要修改 `Config` 接口、`parseConfig`、`DEFAULT_CONFIG` 三处。虽然"单一真理源"原则避免了 schema 和代码打架，但缺少一份可供用户参考的配置字段清单。

**评分**：🟢 良好

---

### 2.5 logging 日志（`src/logging/`）

**结论**：🟢 设计成熟，是基础设施层的亮点。

- `ILogger` 接口仅 4 个方法（`info`/`warn`/`error`/`debug`），最小化接口
- `LogFn` 类型兼容 pino 的双参数签名：`(objOrMsg, msg?) => void`
- `logger` 单例使用 getter 模式懒触发 pino 升级——确保模块 import 零 fs 副作用
- pino 不可用时回退到 console fallback——零配置可用
- 敏感信息脱敏：`SENSITIVE_KEY_PATTERN` 正则匹配 `apiKey`/`token`/`password`/`secret` 等
- pino redact 路径配置覆盖 3 层嵌套（`*.*.apiKey`）
- `setLogger` 检测覆盖：多次注入时输出警告
- `setLogger(undefined)` 恢复默认时零 fs 副作用（不主动触发 pino 升级）
- 日志轮转保护：超过 10MB 截断重写，防止长期运行生成巨大文件
- `createConsoleLogFn` 消除 4 处同构的 info/warn/error/debug 方法实现

**改进建议**：

⚪ STEP2-SUG-5：`PINO_REDACT_PATHS` 数组（[logger.ts:44-49](file:///f:/zooique/memora/src/logging/logger.ts#L44-L49)）与 `SENSITIVE_KEY_PATTERN` 正则（[logger.ts:37](file:///f:/zooique/memora/src/logging/logger.ts#L37)）是两套独立的敏感键定义，需手动保持同步。pino redact 不支持正则，所以这是必要的重复，但应在注释中标注同步要求。

**评分**：🟢 优秀

---

### 2.6 persona 角色管理（`src/persona/`）

**结论**：🟢 设计良好，防抖机制合理。

**正面评价**：
- 角色切换防抖：60s 窗口内最多 3 次切换，超出后锁定 5 分钟——防止 LLM 反复触发角色切换
- `autoMatch` 关键词高置信度 ≥ 0.5 直接返回，低置信度返回 null 由 agent 层决定是否调 LLM——分层职责清晰
- `reload` 正确处理激活角色被删除的回退场景
- `close()` 清理 `unlockTimer`，防止 Agent 关闭后定时器触发
- `parseTraits` 防御性解析：非数值或超出 0-1 范围的值静默忽略

**改进建议**：

🟡 STEP2-ATTN-4：`writeAllToIndex()` 和 `writePersonaToIndex()` 调用 `index.upsert(memory)` 但未 await（[personaManager.ts:413-419](file:///f:/zooique/memora/src/persona/personaManager.ts#L413-L419)）。`IMemoryStorage.upsert` 返回 `Promise<void>`，promise 被 fire-and-forget。如果 upsert 失败（如 SQLite 写入错误），错误会被静默吞掉。虽然调用方 `load()` 和 `reload()` 是 async 函数，但 `writeAllToIndex` 自身声明为 `void` 返回类型。

**同样的问题存在于 `skillManager.ts` 的 `writeAllToIndex()` 和 `writeSkillToIndex()`**（[skillManager.ts:215-238](file:///f:/zooique/memora/src/skill/skillManager.ts#L215-L238)）。

建议方案：
```typescript
// 方案 A：改为 async + await
private async writeAllToIndex(): Promise<void> {
  if (!this.index) return;
  for (const persona of this.personaList) {
    await this.writePersonaToIndex(persona);
  }
}

// 方案 B：使用 Promise.all 并行写入
private async writeAllToIndex(): Promise<void> {
  if (!this.index) return;
  await Promise.all(this.personaList.map(p => this.writePersonaToIndex(p)));
}
```

**评分**：🟢 良好。fire-and-forget 写入是唯一的扣分点

---

### 2.7 security 路径安全（`src/security/`）

**结论**：🟢 安全实践标杆。

- `resolveRealpath` 递归解析符号链接链，覆盖文件存在/不存在/父目录不存在三种情况
- `assertPathAllowed` 先 NFKC 规范化再解析符号链接——防御 Unicode 同形异义字符攻击
- 黑名单优先于白名单——安全策略正确
- 白名单使用 `startsWith(allowedRoot + sep)` 而非 `startsWith(allowedRoot)`——防止 `/project` 匹配 `/project-evil`
- `BLOCKED_PATTERNS` 覆盖 28 类禁止规则：系统凭证、云服务凭证、环境变量文件、系统目录
- 写入确认 fail-closed：未注入 `confirmationHandler` 时直接拒绝写入——安全优先
- `confirmationHandler` 抛错视为拒绝——fail-closed
- 审计事件缓冲（最近 100 条）+ pino 日志 + 订阅者通知——三重审计
- `truncateForDiff` 重载签名确保 `null`/`undefined` 语义正确传递

**评分**：🟢 优秀。无明显改进点

---

### 2.8 skill 技能管理（`src/skill/`）

**结论**：🟢 与 PersonaManager 结构一致，匹配逻辑清晰。

**正面评价**：
- `match()` 先检查 trigger 正则（最高优先级，score=1.0），再检查关键词匹配
- `SKILL_MATCH_MIN_SCORE = 0.3` 与 PersonaManager 的 `0.5` 形成梯度：技能注入宽松（隐式辅助），角色切换严格（显式行为）
- 阈值作为唯一真理源，宿主不二次过滤——避免"激活但不提示"的静默激活
- `reload()` 与 PersonaManager 同模式，热重载后同步 SQLite 索引
- `register()` 检测重复注册，抛 `configError` 而非静默覆盖

**改进建议**：

🟡 STEP2-ATTN-4（同上）：`writeAllToIndex()` 和 `writeSkillToIndex()` 同样存在 fire-and-forget 问题。

⚪ STEP2-SUG-2（同上）：`SkillEntry.layer` 字段标注"预留字段，当前仅写入无读取消费者"。

**评分**：🟢 良好

---

## 三、亮点（值得肯定的设计）

1. **`mergeAbortSignals` 的 `clearTimer`/`dispose` 分离**：流式场景中清超时但保留外部信号监听，最终清理时完整释放——这是 SSE 流式读取中容易被忽略的细节
2. **SSE 解析器的 tool_calls delta 累积**：按 index 分片累积 name + arguments，`[DONE]` 时兜底输出——覆盖了 OpenAI 协议中 tool_calls 流式传输的所有边界情况
3. **首 chunk / chunk 间超时区分**：120s / 60s 的分级超时适配 reasoning 模型——这是对 LLM 实际行为有深入理解才能做出的设计
4. **`SecurityGuard.resolveRealpath` 三级递归**：文件存在/不存在/父目录不存在三种情况全覆盖——防御符号链接逃逸的完整方案
5. **`SecurityGuard` 的 fail-closed 写入确认**：未注入 handler = 拒绝写入，回调抛错 = 拒绝写入——安全优先原则贯彻到底
6. **logging 的懒加载 pino 升级**：getter 模式 + 竞态守卫 + 覆盖检测——在零 fs 副作用的前提下实现了优雅的渐进增强
7. **`loggerHolder` 的依赖倒置**：utils 层通过 holder 引用日志，logging 层反向注入——解耦了底层工具层和业务日志层
8. **`evalRunner` 的 `void runPromise.catch(() => {})`**：超时后抑制 unhandled rejection——这是 Promise.race 超时模式的常见陷阱，处理得当
9. **`parseLlmJson` 的 4 级回退**：覆盖 LLM 输出的常见格式错误（代码块包裹、单引号、尾逗号、JSON 嵌套在文本中）
10. **PersonaManager 的角色切换防抖**：60s 窗口 + 3 次上限 + 5 分钟锁定——防止 LLM 反复触发角色切换的实用机制

---

## 四、问题清单

### 🔴 严重（无）

当前审查范围内无严重问题。

### 🟡 需要关注（4 项）

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| STEP2-ATTN-1 | SSE 内容提取使用 truthy 检查 | [openaiCompatible.ts:373](file:///f:/zooique/memora/src/llm/openaiCompatible.ts#L373) | `if (choice.delta?.content)` 在 content 为空字符串 `""` 时跳过，应改为 `!= null` 以区分 null 和空字符串。当前影响极小（空字符串在流式中极少出现），但严格来说不是正确的类型检查 |
| STEP2-ATTN-2 | 预设 Provider 硬编码与项目记忆矛盾 | [factory.ts:14-18](file:///f:/zooique/memora/src/llm/factory.ts#L14-L18) | `presets` 对象硬编码了 deepseek/doubao/openai 的默认值。项目记忆记录"Built-in LLM Provider presets are rejected"，建议移除预设或更新项目记忆 |
| STEP2-ATTN-3 | `scanner.ts` 和 `path.ts` 引入 I/O 依赖 | [scanner.ts](file:///f:/zooique/memora/src/utils/scanner.ts) / [path.ts](file:///f:/zooique/memora/src/utils/path.ts) | `scanner.ts` 依赖 `node:fs/promises` + `node:path`，`path.ts` 依赖 `node:os`。`scanner.ts` 是 I/O 密集型模块，建议迁移出 `utils/` 到独立目录（如 `src/scanner/`）。`path.ts` 的 `homedir()` 依赖在 Node.js 专用内核中可接受 |
| STEP2-ATTN-4 | `writeAllToIndex`/`writeSkillToIndex` fire-and-forget | [personaManager.ts:413-419](file:///f:/zooique/memora/src/persona/personaManager.ts#L413-L419) / [skillManager.ts:215-238](file:///f:/zooique/memora/src/skill/skillManager.ts#L215-L238) | `index.upsert(memory)` 返回 `Promise<void>` 但未被 await，写入失败会被静默吞掉。两处共 4 个方法需改为 `async` + `await` |

### 🟢 建议（5 项）

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| STEP2-SUG-1 | `handleResponseError` 中 `.slice(0, 200)` 重复 4 次 | [openaiCompatible.ts:195-221](file:///f:/zooique/memora/src/llm/openaiCompatible.ts#L195-L221) | 虽然有 `MAX_ERROR_BODY_LEN` 常量，但 `.slice(0, MAX_ERROR_BODY_LEN)` 仍重复 4 次。可提取局部变量 `errorPreview` |
| STEP2-SUG-2 | 预留字段确认 | [evalTypes.ts:75](file:///f:/zooique/memora/src/eval/evalTypes.ts#L75) / [skill/types.ts:26](file:///f:/zooique/memora/src/skill/types.ts#L26) | `recallSources`（eval）和 `layer`（skill）标注为预留字段，当前无消费者。打包前确认是否保留或移除 |
| STEP2-SUG-3 | `DEFAULT_MAX_CONTEXT_TOKENS` 需手动同步 | [loader.ts:28-30](file:///f:/zooique/memora/src/config/loader.ts#L28-L30) | 与 `agent/constants.ts` 的 `AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS` 需手动同步。建议建立单向引用消除同步风险 |
| STEP2-SUG-4 | 缺少配置 schema 声明文件 | [loader.ts](file:///f:/zooique/memora/src/config/loader.ts) | 新增字段需修改 `Config` 接口 + `parseConfig` + `DEFAULT_CONFIG` 三处。可考虑生成 `config.schema.json` 或 `config.example.json` 供用户参考 |
| STEP2-SUG-5 | `PINO_REDACT_PATHS` 与 `SENSITIVE_KEY_PATTERN` 需手动同步 | [logger.ts:37-49](file:///f:/zooique/memora/src/logging/logger.ts#L37-L49) | 两套敏感键定义独立维护。pino redact 不支持正则，但应在注释中标注同步要求 |

### ⚪ 归档待办（2 项）

| ID | 问题 | 位置 | 说明 |
|----|------|------|------|
| STEP2-TODO-1 | `scanner.ts` 迁移出 `utils/` | [scanner.ts](file:///f:/zooique/memora/src/utils/scanner.ts) | 评估是否将 `scanner.ts` 迁移到 `src/scanner/` 或 `src/loader/`，保持 `utils/` 的纯函数定位。低优先级，不影响功能 |
| STEP2-TODO-2 | 预设 Provider 清理 | [factory.ts](file:///f:/zooique/memora/src/llm/factory.ts) | 与项目记忆对齐——移除 `presets` 或更新项目记忆。非阻塞，当前预设仅作为 fallback |

---

## 五、立即修复项

**STEP2-ATTN-4**（fire-and-forget 写入）是唯一建议在打包前修复的项。影响范围：
- [personaManager.ts](file:///f:/zooique/memora/src/persona/personaManager.ts)：`writeAllToIndex()` + `writePersonaToIndex()`
- [skillManager.ts](file:///f:/zooique/memora/src/skill/skillManager.ts)：`writeAllToIndex()` + `writeSkillToIndex()`

修复方式：将 4 个方法改为 `async` + 调用方 `await`，约 10 行改动。

---

## 六、总体评价

memora 内核基础设施层在代码质量和设计逻辑上表现扎实：

- **LLM 适配层**：SSE 解析器健壮，超时/中止机制完善，是生产级实现。预设 Provider 硬编码是可接受的已知遗留
- **utils 工具函数**：大部分是纯函数，`toError`、`parseLlmJson`、`truncate` 等设计良好。`scanner.ts` 的 I/O 性质与 utils 定位不完全匹配，但影响有限
- **eval 评估框架**：设计简洁，错误隔离和超时保护到位，可作为其他模块的参考实现
- **config 配置加载**：手动校验完备，环境变量展开全面。缺少 schema 声明文件，但"单一真理源"原则避免了配置分裂
- **logging 日志**：懒加载 pino 升级 + 敏感信息脱敏 + console fallback + 宿主注入——设计成熟，是基础设施层的亮点
- **persona/skill 管理**：防抖机制合理，热重载完善。fire-and-forget 写入是唯一需要修复的问题
- **security 安全**：符号链接解析 + NFKC 规范化 + 黑名单优先 + fail-closed 写入确认——安全实践标杆

**与 Step 1（核心引擎）相比**：基础设施层质量略低于核心引擎层（8.0 vs 8.5），差异主要来自 `scanner.ts` 的职责边界问题和 fire-and-forget 写入风险。修复 STEP2-ATTN-4 后，基础设施层质量可达到与核心引擎同等的可发布水平。

---

> **下一步**：Step 3 · sprite 主进程层（`hosts/memora-sprite/src/electron/`，不含 renderer）