# Step 9 · 跨包重复模式审查报告

> **审查日期**：2026-07-19
> **审查范围**：memora 内核 `src/` + sprite 宿主 `hosts/memora-sprite/src/`
> **对照标准**：[ADR-017 自然生长原则重新定义](../../.trae/decisions/ADR-017-natural-growth-redefinition.md) §枝叶层 2 次提取原则
> **硬约束**：[ADR-002 存储层抽象](../../.trae/decisions/ADR-002-storage-layer.md) — 内核零依赖
> **审查性质**：仅审查记录，不修改任何文件

---

## 0. 判断标准速查

### ADR-017 枝叶层 2 次提取原则

| 触发条件 | 处理动作 |
| -------- | -------- |
| 同一工具函数在 2+ 个文件出现 | 提取到 `utils/` |
| 同一组件模式在 2+ 个页面出现 | 提取到 `components/` |
| 同一流程描述在 2+ 处出现 | 提取到 `references/` |

### 跨包合并的硬约束（ADR-002）

| 约束 | 含义 |
| ---- | ---- |
| 内核零依赖 | memora `src/` 不能 import sprite 任何模块 |
| 渲染进程零 Node 依赖 | sprite `electron/renderer/` 不能 import `node:*` 或 memora 主进程模块 |
| sprite 依赖内核合法 | sprite 可 `from 'memora'` import 内核纯逻辑 |

**核心判断**：跨包重复 ≠ 必须合并。若重复源于架构约束（内核零依赖 + 渲染进程零 Node 依赖），则属于"合理行为对齐"，**保留独立 + 建立行为契约**。

---

## 1. 跨包重复模式矩阵

### 1.1 完整矩阵

| # | 文件名/函数 | memora 路径 | sprite 路径 | 实现相似度 | 重复性质 | 是否应合并 |
| - | ----------- | ----------- | ----------- | ---------- | -------- | ---------- |
| 1 | `errors.ts` | `src/utils/errors.ts` | `hosts/memora-sprite/src/sprite/errors.ts` | **0%** | 非重复（设计目标不同） | ❌ 保留独立 |
| 2 | `toError.ts` | `src/utils/toError.ts` | `hosts/memora-sprite/src/shared/toError.ts` | **100%** | 真重复（行为对齐） | ⚠️ 保留独立（架构约束） |
| 3 | `formatDateKey` | `src/utils/time.ts` | `hosts/memora-sprite/src/shared/dateUtils.ts` | **100%** | 真重复（行为对齐） | ⚠️ 保留独立（架构约束） |
| 4 | `truncate` | `src/utils/strings.ts` | `hosts/memora-sprite/src/shared/truncate.ts` | **90%** | 近似重复（memora 多 suffix 参数） | ⚠️ 保留独立（架构约束） |
| 5 | `pathGuard` / `isPathAllowed` | `src/security/pathGuard.ts` | `electron/ipc/inputValidation.ts` + `sprite/fileWatcherTrigger.ts` | **30%** | 非重复（实现差异巨大） | ❌ 保留独立 |
| 6 | `ILogger` / `logger` | `src/logging/loggerInterface.ts` + `src/logging/logger.ts` | （无独立实现） | N/A | sprite 直接 `from 'memora'` 复用 | ✅ 已正确共享 |
| 7 | `types.ts` | 5 处（agent/memory/llm/persona/skill） | 4 处（electron/ipc/renderer/web） | **0%** | 非重复（各模块独立类型） | ❌ 保留独立 |
| 8 | `STOPWORDS` / `segmentText` / `cosineSimilarity` | `src/utils/segmenter.ts` + `src/utils/math.ts` | `storage/sqliteStorage.ts` 引用 | N/A | sprite 直接 `from 'memora'` 复用 | ✅ 已正确共享 |
| 9 | 测试 fixture（`InMemoryStorage` / `mockLlmProvider`） | `src/memory/inMemoryStorage.ts` 等 | sprite 测试中 import | N/A | sprite 测试直接 `from 'memora'` 复用 | ✅ 已正确共享 |
| 10 | `isNonEmptyString` | （无） | `hosts/memora-sprite/src/shared/inputValidation.ts` | N/A | sprite 独有 | ✅ 无重复 |
| 11 | `escapeRegExp` / `singleton` / `round2` / `describeLevel` / `safeWriteJson` | （无） | `hosts/memora-sprite/src/shared/*` | N/A | sprite 独有 | ✅ 无重复 |

### 1.2 矩阵结论

| 重复性质 | 数量 | 处理动作 |
| -------- | ---- | -------- |
| 真重复（行为对齐，受架构约束保留） | 2（toError、formatDateKey） | 保留独立 + 行为契约已建立 |
| 近似重复（签名差异，受架构约束保留） | 1（truncate） | 保留独立 + 注释明确说明 |
| 非重复（设计目标不同） | 2（errors、pathGuard） | 保留独立 |
| 已正确共享（sprite 复用 memora） | 3（ILogger、STOPWORDS、fixture） | 无需处理 |
| sprite 独有 | 2（isNonEmptyString 等、escapeRegExp 等） | 无需处理 |

---

## 2. 重点重复项详细分析

### 2.1 errors.ts — 非重复（设计目标不同）

**memora 端**（`src/utils/errors.ts`）：
- `ErrorCategory` 类型：`'config' | 'network' | 'llm' | 'tool' | 'security' | 'unknown'`
- `ToolErrorCode` 常量：9 个工具错误码（PATH_NOT_ALLOWED / FILE_NOT_FOUND / PERMISSION_DENIED 等）
- `MemoraError` 类：含 `title / detail / suggestions / category / errorCode / cause`
- 5 个工厂函数：`configError / chatBusyError / networkError / llmError / toolError / securityError`
- **设计目标**：为 LLM Agent Loop 的 Reflection（反思/自修正）逻辑服务，`errorCode + retryable` 标记驱动 LLM 重试决策

**sprite 端**（`hosts/memora-sprite/src/sprite/errors.ts`）：
- `ErrorCode` enum：9 个宿主层错误码（UNKNOWN / INITIALIZATION_FAILED / WINDOW_CREATE_FAILED / STORAGE_ERROR / VALIDATION_ERROR 等）
- `SpriteError` 类：含 `code / context`
- **设计目标**：为宿主 IPC 错误分类服务，替代基于中文字符串匹配的 `extractErrorCode` 推断

**对比结论**：
- 类名不同（MemoraError vs SpriteError）
- 字段不同（category+errorCode vs code+context）
- 错误码语义不同（LLM 工具反射 vs IPC 错误分类）
- 无任何代码重复

**ADR-017 判断**：枝叶层 2 次提取原则不适用——两份 errors.ts 服务于完全不同的领域（内核 Agent 反思 vs 宿主 IPC 分类），属于"同名不同源"。

**推荐处理**：**保留独立**。已正确分层。

---

### 2.2 toError.ts — 真重复（行为对齐，受架构约束保留）

**memora 端**（`src/utils/toError.ts`）：

```typescript
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string') return new Error(err);
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') {
    return new Error((err as { message: string }).message);
  }
  if (typeof err === 'object' && err !== null) {
    try { return new Error(JSON.stringify(err)); }
    catch { return new Error(String(err)); }
  }
  return new Error(String(err ?? '未知错误'));
}
```

**sprite 端**（`hosts/memora-sprite/src/shared/toError.ts`）：5 分支结构与 memora **完全相同**，注释明确写"行为与内核 memora/src/utils/toError 完全对齐"。

**重复触发点**：
- memora 端：8+ 处 import（`@/utils/toError.js` 或 `@/utils/errors.js` re-export）
- sprite 端：2 处 import（`shared/toError.js` + 测试文件）

**架构约束分析**：

| 进程 | 可用 toError 来源 | 选择 |
| ---- | ----------------- | ---- |
| memora 内核 | memora 自己 | ✅ |
| sprite 主进程 | memora（合法内核依赖） | ✅ 从 `from 'memora'` 导入 |
| sprite 渲染进程 | **不能用 memora**（避免渲染进程引入 Node 依赖） | ⚠️ 必须用 sprite 自己的 `shared/toError.ts` |
| sprite Web 模式 | 同上 | ⚠️ 必须用 sprite 自己的 |

**ADR-017 枝叶层 2 次提取判断**：
- ✅ 达到 2 次提取阈值（memora + sprite 两份实现）
- ❌ 但合并违反 ADR-002 内核零依赖约束（不能让 memora import sprite）
- ❌ 也违反渲染进程零 Node 依赖约束（渲染进程不能 import memora，会引入 pino 等 peer dep）

**推荐处理**：**保留独立 + 强化行为契约**

当前实现已正确：
1. sprite 主进程从 memora import（合法）
2. sprite 渲染进程用 sprite 自己的 `shared/toError.ts`（架构必需）
3. 两边文件头部注释互相引用："行为与内核 memora/src/utils/toError 完全对齐" / "5 分支，与精灵 shared/toError.ts 行为对齐"

**可选增强**（不在本次审查范围内）：
- 在 sprite `shared/toError.test.ts` 中添加"行为对齐契约测试"，断言与 memora `toError` 在相同输入下产出相同输出
- 防止未来单边修改导致行为漂移

---

### 2.3 formatDateKey — 真重复（行为对齐，受架构约束保留）

**memora 端**（`src/utils/time.ts:formatDateKey`）：

```typescript
export function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
```

**sprite 端**（`hosts/memora-sprite/src/shared/dateUtils.ts:formatDateKey`）：**完全相同实现**，注释明确写"与内核 memora/src/utils/toError 完全对齐"（实际是 formatDateKey 对齐，注释引用了 memora 的设计）。

**架构约束分析**：与 toError 相同——渲染进程不能 import memora，必须 sprite 自己维护一份。

**ADR-017 枝叶层 2 次提取判断**：
- ✅ 达到 2 次提取阈值
- ❌ 合并违反架构约束

**推荐处理**：**保留独立 + 行为契约已建立**

两边文件头部注释互相引用：
- memora: "与精灵 shared/dateUtils.ts 语义一致"
- sprite: "不与内核 memora 共享（ADR-002 内核零依赖约束）"

**注意**：sprite 端 `shared/dateUtils.ts` 注释中提到"不与内核 memora 共享（ADR-002 内核零依赖约束）"——这是**误述**：ADR-002 约束的是"内核不依赖 sprite"，并未禁止"sprite 渲染进程依赖 memora"。真正的约束是"渲染进程零 Node 依赖"（directory-structure.md §2.1），因为 memora 通过 pino 等可选 peerDep 间接引入了 Node 运行时。建议未来修正注释，避免误引 ADR。

---

### 2.4 truncate — 近似重复（签名差异，受架构约束保留）

**memora 端**（`src/utils/strings.ts:truncate`）：

```typescript
export function truncate(text: string, maxLen: number, suffix: string = '…'): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + suffix;
}
```

**sprite 端**（`hosts/memora-sprite/src/shared/truncate.ts`）：

```typescript
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}
```

**差异**：
- memora 版本支持 `suffix` 参数（默认 `'…'`，可改为 `'…[截断]'` 用于 LLM prompt）
- sprite 版本固定 `'…'` 后缀（UI 场景专用）
- 默认行为完全一致

**ADR-017 枝叶层 2 次提取判断**：
- ✅ 达到 2 次提取阈值
- ❌ 合并违反架构约束（同 toError）

**推荐处理**：**保留独立**

注释已明确："与 sprite 的 shared/truncate.ts 独立（ADR-002 内核零依赖约束，kernel/sprite 各自维护）"。
memora 版本是 sprite 的超集，但 sprite 不需要 suffix 参数（UI 场景固定 `'…'` 足够），保持简洁。

---

### 2.5 pathGuard / isPathAllowed — 非重复（实现差异巨大）

**memora 端**（`src/security/pathGuard.ts`）：
- 完整安全模块：`resolveRealpath`（符号链接解析）+ `BLOCKED_PATTERNS`（28 类禁止规则）+ 4 类允许根 + 审计日志 + 写入确认回调
- 服务于 LLM Agent 工具调用的写入安全（路径越界防护 + 凭证文件保护）

**sprite 端**（`electron/ipc/inputValidation.ts:isPathAllowed`）：
- 简化版：`path.relative` + `startsWith('..')` + `path.isAbsolute` 前缀检查
- 服务于 IPC 输入校验（防止渲染进程传入恶意路径）

**sprite 端**（`sprite/fileWatcherTrigger.ts:isPathAllowed`）：
- 私有方法：`resolve` + `startsWith(allowedRoot + sep)` 简化检查
- 服务于文件监听器路径过滤

**对比结论**：
- 三处实现均不同（完整安全模块 / IPC 输入校验 / 文件监听过滤）
- memora pathGuard 是 P0 安全模块；sprite 两处是简化版输入校验
- 设计目标不同：memora 防御 LLM 工具越界；sprite 防御 IPC 输入越界

**ADR-017 判断**：非枝叶层重复，是不同领域的安全策略。

**推荐处理**：**保留独立**。

**潜在改进**（不在本次审查范围）：sprite `fileWatcherTrigger.ts:isPathAllowed` 注释说"与内核 pathGuard 的 assertPathAllowed 逻辑一致"，但实际实现是 `startsWith` 简化版，与 memora 的 `resolveRealpath` 不对齐。如果未来 fileWatcherTrigger 需要更严格的安全（防符号链接逃逸），应直接 import memora pathGuard。当前简化版对文件监听场景足够（监听目录已由用户配置，非任意路径）。

---

## 3. ADR-017 枝叶层 2 次提取合规性总结

### 3.1 已合规（2 次提取已应用）

| 项 | 状态 |
| - | ---- |
| `shared/escapeRegExp.ts` | ✅ sprite 内部 3 处散落模式已提取（commandPaletteManager / memoryPanelManager / searchMessagesManager） |
| `shared/singleton.ts` | ✅ sprite 内部多模块懒创建模式已提取 |
| `shared/round2` (numberUtils) | ✅ sprite 内部 7+ 处 `Math.round(x*100)/100` 已提取 |
| `shared/describeLevel` (levelUtils) | ✅ sprite affectController + rapportController 两处 `describeLevel` 已提取 |
| `shared/safeWriteJson` | ✅ sprite cli.ts + spriteConfigStore.ts + spriteConfig.ts 三处已提取 |
| `shared/inputValidation.ts` | ✅ sprite IPC + Web 层共用校验已提取 |
| `shared/llmErrorClassifier.ts` | ✅ sprite onboarding + minimalHandlers 两处错误映射已提取 |
| memora `chatBusyError` 工厂 | ✅ memora 内部 12 处 `configError('对话繁忙', ...)` 已提取（errors.ts 注释明确引用 ADR-017） |
| memora `truncate` (strings.ts) | ✅ memora 内部 15 处散落模式已提取 |

### 3.2 跨包 2 次提取受架构约束豁免

| 项 | 跨包重复次数 | 豁免依据 | 处理 |
| - | ------------ | -------- | ---- |
| `toError` | 2 次 | ADR-002 + 渲染进程零 Node 依赖 | 保留独立 + 行为契约注释 |
| `formatDateKey` | 2 次 | 同上 | 保留独立 + 行为契约注释 |
| `truncate` | 2 次（签名差异） | 同上 | 保留独立 + 注释明确说明 |

### 3.3 不构成重复（无需提取）

| 项 | 原因 |
| - | ---- |
| `errors.ts`（memora vs sprite） | 同名不同源，设计目标完全不同 |
| `pathGuard` / `isPathAllowed` | 实现差异巨大，不同领域安全策略 |
| `types.ts`（多处） | 各模块独立类型定义 |
| `ILogger` / `logger` | sprite 直接 `from 'memora'` 复用，已正确共享 |

---

## 4. 推荐处理方式汇总

### 4.1 无需动作（已正确处理）

| 项 | 当前状态 |
| - | -------- |
| `errors.ts` 两边独立 | ✅ 设计目标不同，保留独立正确 |
| `ILogger` / `logger` 共享 | ✅ sprite 全部 60 处通过 `from 'memora'` 复用 |
| `STOPWORDS` / `segmentText` / `cosineSimilarity` 共享 | ✅ sprite 通过 `from 'memora'` 复用 |
| 测试 fixture 共享 | ✅ sprite 测试通过 `from 'memora'` 复用 `InMemoryStorage` 等 |
| `isNonEmptyString` sprite 独有 | ✅ memora 无此需求，sprite 独立保留正确 |
| `escapeRegExp` / `singleton` / `round2` / `describeLevel` / `safeWriteJson` sprite 独有 | ✅ memora 无此需求，sprite 独立保留正确 |
| `types.ts` 各处独立 | ✅ 各模块独立类型，无重复 |

### 4.2 保留独立 + 已有行为契约（无需动作）

| 项 | 契约形式 |
| - | -------- |
| `toError.ts` 两边独立 | ✅ 两边文件头部注释互相引用"行为完全对齐" |
| `formatDateKey` 两边独立 | ✅ 两边文件头部注释互相引用"语义一致" |
| `truncate` 两边独立 | ✅ memora 端注释明确"与 sprite shared/truncate.ts 独立（ADR-002 内核零依赖约束，kernel/sprite 各自维护）" |

### 4.3 可选增强（不在本次审查范围，仅记录建议）

| 建议 | 优先级 | 理由 |
| ---- | ------ | ---- |
| 在 sprite `shared/toError.test.ts` 添加"行为对齐契约测试"，断言与 memora `toError` 在相同输入下产出相同输出 | P3 | 防止未来单边修改导致行为漂移 |
| 修正 sprite `shared/dateUtils.ts` 注释中"不与内核 memora 共享（ADR-002 内核零依赖约束）"为"渲染进程零 Node 依赖约束" | P4 | ADR-002 约束的是内核不依赖 sprite，并未禁止 sprite 渲染进程依赖 memora；真正约束来自 directory-structure.md §2.1 |
| 评估 sprite `fileWatcherTrigger.ts:isPathAllowed` 是否需要升级为 `realpathSync` 防符号链接逃逸 | P4 | 当前简化版对文件监听场景足够，但注释声称"与内核 pathGuard 逻辑一致"实际并不对齐 |

---

## 5. 跨包共享现状图

```
┌─────────────────────────────────────────────────────────────┐
│ memora 内核 (src/)                                          │
│ ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│ │ utils/      │ │ logging/     │ │ security/pathGuard   │  │
│ │ errors.ts   │ │ ILogger     │ │ (完整安全模块)        │  │
│ │ toError.ts  │ │ logger      │ │ BLOCKED_PATTERNS 28类│  │
│ │ time.ts     │ └──────┬──────┘ │ resolveRealpath     │  │
│ │ strings.ts  │        │        └──────────────────────┘  │
│ │ segmenter   │        │                                   │
│ │ math.ts     │        │ shared via `from 'memora'`       │
│ └─────────────┘        │                                   │
└────────────────────────┼──────────────────────────────────┘
                         │
            ┌────────────┴───────────────┐
            │ sprite 主进程合法 import   │
            │ logger / toError /         │
            │ InMemoryStorage / types    │
            └────────────┬───────────────┘
                         │
┌────────────────────────┴──────────────────────────────────┐
│ sprite 宿主 (hosts/memora-sprite/src/)                   │
│ ┌─────────────────┐ ┌─────────────────┐ ┌───────────────┐  │
│ │ sprite/         │ │ shared/         │ │ electron/     │  │
│ │ errors.ts       │ │ toError.ts ⚠️   │ │ ipc/inputValid│  │
│ │ SpriteError     │ │ formatDateKey⚠️ │ │ isPathAllowed │  │
│ │ ErrorCode enum  │ │ truncate.ts ⚠️  │ │ (简化版)      │  │
│ │ (独立设计)      │ │ isNonEmptyStr   │ └───────────────┘  │
│ │                 │ │ escapeRegExp    │                    │
│ │                 │ │ singleton       │ ⚠️ = 行为对齐契约   │
│ │                 │ │ round2/describe │   (受架构约束保留)  │
│ │                 │ │ safeWriteJson   │                    │
│ └─────────────────┘ └─────────────────┘                    │
└──────────────────────────────────────────────────────────┘
```

**图例**：
- 实线箭头 = sprite 通过 `from 'memora'` 合法复用
- ⚠️ = 跨包行为对齐契约（受架构约束保留独立实现）

---

## 6. 审查结论

### 6.1 整体评估

| 维度 | 评估 |
| ---- | ---- |
| 用户关注的 errors.ts 重复 | ❌ 不构成重复（设计目标完全不同） |
| 用户关注的 toError.ts 重复 | ✅ 确认重复，但受架构约束合理保留 |
| 跨包共享机制 | ✅ sprite 通过 `from 'memora'` 已正确共享 logger / InMemoryStorage / 类型 / STOPWORDS 等 |
| ADR-017 枝叶层 2 次提取合规性 | ✅ sprite 内部散落模式均已提取（escapeRegExp / singleton / round2 / describeLevel / safeWriteJson） |
| 行为对齐契约 | ✅ 3 处跨包重复（toError / formatDateKey / truncate）均已建立注释契约 |

### 6.2 是否需要进一步动作

**否**。当前跨包重复处理已符合 ADR-017 枝叶层 2 次提取原则，并正确处理了 ADR-002 内核零依赖约束与渲染进程零 Node 依赖约束的边界。

3 处跨包行为对齐重复（toError / formatDateKey / truncate）属于"架构约束驱动的合理重复"，已通过文件头部注释建立行为契约，不需要合并。

### 6.3 风险提示

| 风险 | 影响 | 缓解措施 |
| ---- | ---- | -------- |
| 跨包行为漂移 | toError / formatDateKey 单边修改导致行为不一致 | 当前仅靠注释契约；建议未来增加行为对齐测试（P3） |
| 注释误引 ADR | sprite `shared/dateUtils.ts` 注释误引 ADR-002 | 未来修正为"渲染进程零 Node 依赖约束"（P4） |
| `fileWatcherTrigger` isPathAllowed 简化版 | 注释声称"与内核 pathGuard 一致"实际不对齐 | 当前场景足够，未来如需严格安全可改用 memora pathGuard（P4） |

---

## 7. 附录：审查过程中检查的文件清单

### memora 内核

- `src/utils/errors.ts` — ErrorCategory + ToolErrorCode + MemoraError + 5 工厂
- `src/utils/toError.ts` — 5 分支 unknown → Error 转换
- `src/utils/time.ts` — formatDateKey + nowIso + todayDate
- `src/utils/strings.ts` — slugify + truncate（含 suffix 参数）
- `src/utils/segmenter.ts` — STOPWORDS + segmentText + segmentLower
- `src/utils/math.ts` — cosineSimilarity
- `src/logging/loggerInterface.ts` — ILogger 接口
- `src/logging/logger.ts` — logger 全局单例 + pino 升级
- `src/security/pathGuard.ts` — 完整安全模块（resolveRealpath + BLOCKED_PATTERNS 28 类）

### sprite 宿主

- `src/sprite/errors.ts` — ErrorCode enum + SpriteError
- `src/shared/toError.ts` — 与 memora 行为对齐
- `src/shared/dateUtils.ts` — formatDateKey（与 memora 行为对齐）
- `src/shared/truncate.ts` — truncate（与 memora 行为对齐，无 suffix 参数）
- `src/shared/inputValidation.ts` — isNonEmptyString + 8 个 isValid* 校验
- `src/shared/escapeRegExp.ts` — sprite 内部 3 处模式提取
- `src/shared/singleton.ts` — createSingleton 工厂
- `src/shared/numberUtils.ts` — round2
- `src/shared/levelUtils.ts` — describeLevel
- `src/shared/safeWriteJson.ts` — safeWriteJson + safeWriteJsonSync
- `src/shared/llmErrorClassifier.ts` — LLM 错误模式映射
- `src/electron/ipc/inputValidation.ts` — isPathAllowed（简化版）
- `src/sprite/fileWatcherTrigger.ts` — isPathAllowed 私有方法
- `src/electron/renderer/helpers/errorHelpers.ts` — re-export shared/toError
- `src/electron/types.ts` — electron 主进程类型 barrel
- 各 types.ts 文件（electron/ipc / electron/renderer / web/routes）
