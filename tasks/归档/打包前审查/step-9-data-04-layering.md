# Step 9 · Data 04 · 跨层调用方向审查报告

> **审查日期**：2026-07-19
> **审查范围**：
> - memora 内核：`f:\zooique\memora\src\`
> - sprite 宿主：`f:\zooique\memora\hosts\memora-sprite\src\`
> **核心审查原则**：
> - 依赖方向：renderer → main → kernel（单向依赖）
> - 禁止反向调用：kernel 不能 import sprite，main 不能 import renderer
> - 禁止跨层调用：renderer 不能直接调用 kernel（必须通过 main 进程 IPC 中介）
> **对照标准**：
> - [project-rules.md §1.6 零依赖内核](../../.trae/rules/project-rules.md)
> - [project-rules.md §7.2 内核独立性](../../.trae/rules/project-rules.md)
> - [backend_layers_rules.md](../../.trae/rules/backend_layers_rules.md)
> - [hosts/memora-sprite/.trae/rules/directory-structure.md §2.1 职责分组原则](../../hosts/memora-sprite/.trae/rules/directory-structure.md)
> **审查性质**：仅审查记录，不修改任何文件

---

## 一、执行摘要

| 维度 | 审查项 | 违规数 | 状态 |
|------|--------|--------|------|
| memora 内核独立性（§1.6） | native 模块 / web 框架 / sprite 引用 / dependencies 空载 | 0 | ✅ 全部通过 |
| sprite 跨进程边界 | renderer→main 运行时 / main→renderer / preload 隔离 | 0 | ✅ 全部通过 |
| sprite 跨层依赖 | controllers→panels / panels→controllers / helpers→panels | 1 P2 + 5 type-only | 🟡 1 处 P2 已知违规 |
| 跨包引用合规性 | sprite→memora 公共 API / 内部路径穿透 | 0 | ✅ 全部通过 |

**总体结论**：
- 🟢 **memora 内核零依赖硬约束完全满足**，src/ 下无任何 native/web 模块 import，dependencies 为空对象
- 🟢 **sprite 跨进程边界清晰**，renderer/main/preload 三方隔离彻底，仅通过 type-only 共享 IPC 契约类型
- 🟢 **跨包引用合规**，sprite 100 处对 memora 的引用全部通过 `'memora'` 公共 API，无内部路径穿透
- 🟡 **sprite 跨层依赖存在 1 处 P2 已知违规**（controllers→panels 运行时 import，已记录于 step-7-sprite-helpers.md SPRITE-0719-P2-2，待自然生长触发收敛）
- 🟡 **5 处 type-only helpers→panels 引用**为依赖注入 Host 接口模式，编译期擦除无运行时循环依赖，归档为风格不一致观察项

---

## 二、memora 内核独立性审查（§1.6 零依赖）

### 2.1 `dependencies` 硬约束验证

```json
// f:\zooique\memora\package.json
"dependencies": {},
"peerDependencies": { "pino": ">=9.0.0" },
"peerDependenciesMeta": { "pino": { "optional": true } }
```

✅ **满足零依赖内核硬约束**：`dependencies` 为空对象，`pino` 仅作为 optional peerDependency 由宿主注入。

### 2.2 native 模块 import 扫描

**扫描模式**：`from\s+['"](better-sqlite3|electron|commander|@nut-tree-fork/nut-js|sharp)['"]` + `require\(['"](better-sqlite3|electron|commander)['"]\)`

| 扫描路径 | 匹配数 | 状态 |
|----------|--------|------|
| `f:\zooique\memora\src\` | 0 | ✅ |

✅ **内核 src/ 下零 native 模块 import**。

### 2.3 web 框架 import 扫描

**扫描模式**：`from\s+['"](express|koa|fastify|next|nuxt|react|vue|svelte|@angular|@nestjs)['"]`

| 扫描路径 | 匹配数 | 状态 |
|----------|--------|------|
| `f:\zooique\memora\src\` | 0 | ✅ |

✅ **内核 src/ 下零 web 框架 import**。

### 2.4 sprite / hosts 反向引用扫描

**扫描模式**：`from\s+['"]memora-sprite` + `from\s+['"](\.\./)+hosts`

| 扫描路径 | 匹配数 | 状态 |
|----------|--------|------|
| `f:\zooique\memora\src\` | 0 | ✅ |

✅ **内核不反向依赖宿主，所有宿主交互通过接口注入**（ADR-002 §三层架构）。

### 2.5 memora 公共 API 入口

`f:\zooique\memora\src\index.ts` 是 memora 包的唯一个公共导出入口（package.json `exports` 字段限定）：

```json
"exports": {
  ".": {
    "import": "./dist/index.js",
    "types": "./dist/index.d.ts"
  }
}
```

✅ **导出边界明确**：仅 `.` 入口对外暴露，无 `./src/*` 子路径导出，从机制上杜绝了 sprite 穿透到内核内部路径的可能。

---

## 三、sprite 跨进程边界审查

### 3.1 跨进程依赖矩阵

> **依赖方向规则**：renderer → main（通过 preload IPC）→ kernel；preload 仅暴露 API，不耦合 main/renderer 运行时

| 源 \ 目标 | renderer/ | electron 根（main.ts 等） | ipc/ | windows/ | preload.ts | sprite/ | shared/ | memora |
|-----------|-----------|--------------------------|------|----------|------------|---------|---------|--------|
| **renderer/** | — | 🟢 0 运行时 | 🟡 1 type-only | 🟢 0 | 🟡 多处 type-only | 🟢 多处（含 type+runtime） | 🟢 多处 | 🟢 多处 type-only |
| **electron 根** | 🟢 0 | — | 🟢 多处 | 🟢 多处 | 🟢 0 运行时 | 🟢 多处 | 🟢 多处 | 🟢 多处 |
| **ipc/** | 🟢 0 | 🟢 多处 | — | 🟢 type-only | 🟢 0 | 🟢 多处 | 🟢 多处 | 🟢 type-only |
| **windows/** | 🟢 0 | 🟢 多处 | 🟢 0 | — | 🟢 0 | 🟢 0 | 🟢 多处 | 🟢 0 |
| **preload.ts** | 🟢 0 | 🟢 0 | 🟡 type-only | 🟢 0 | — | 🟡 type-only | 🟢 0 | 🟡 type-only |
| **preload-float.ts** | 🟢 0 | 🟢 0 | 🟢 0 | 🟢 0 | — | 🟢 0 | 🟢 0 | 🟢 0 |
| **preload-quick-input.ts** | 🟢 0 | 🟢 0 | 🟢 0 | 🟢 0 | — | 🟢 0 | 🟢 0 | 🟢 0 |

**图例**：🟢 = 无引用或方向正确；🟡 = type-only 引用（编译期擦除，无运行时耦合）

### 3.2 renderer → main 进程运行时代码（关键审查项）

**扫描模式**：在 `renderer/` 下扫描 `from\s+['"]electron['"]` / `from\s+['"](\.\./)+ipc/` / `from\s+['"](\.\./)+windows/` / `from\s+['"]\.\./(main|agentListeners|...)['"]`

| 扫描项 | 匹配数 | 状态 |
|--------|--------|------|
| renderer import `'electron'` npm 包 | 0 | ✅ |
| renderer import `../ipc/`（运行时） | 0 | ✅ |
| renderer import `../windows/` | 0 | ✅ |
| renderer import electron 根模块（main/agentListeners 等） | 0 | ✅ |

✅ **renderer 零运行时耦合 main 进程**。

### 3.3 renderer → ipc/types type-only 共享（边界豁免）

| 文件:行号 | 引用 | 类型 | 评估 |
|-----------|------|------|------|
| `renderer/ipcListeners.ts:21` | `import type { SerializedAppError } from '../ipc/types.js'` | type-only | ✅ 合规 |

**判定理由**：
- `import type` 在编译期擦除，无运行时模块加载
- `ipc/types.ts:167-169` 注释明确设计意图："主进程和渲染进程共享此类型，消除两处重复定义"
- `SerializedAppError` 是 IPC 传输 DTO，主进程序列化 → 渲染进程消费，类型共享是必要的契约对齐

### 3.4 main 进程 → renderer 代码

**扫描模式**：在 `electron/` 根及子目录扫描 `from\s+['"]\.\/renderer/`

| 扫描路径 | 匹配数 | 状态 |
|----------|--------|------|
| `electron/main.ts` | 0 | ✅ |
| `electron/` 根（全部 .ts 文件） | 0 | ✅ |
| `electron/ipc/` | 0 | ✅ |
| `electron/windows/` | 0 | ✅ |

✅ **main 进程零反向引用 renderer**。

### 3.5 preload 隔离审查

**preload.ts 运行时 import 清单**（`f:\zooique\memora\hosts\memora-sprite\src\electron\preload.ts`）：

| 行号 | 引用 | 类型 | 评估 |
|------|------|------|------|
| `:22` | `import { contextBridge, ipcRenderer } from 'electron'` | runtime | ✅ 必需（preload 本职） |
| `:23` | `import type { IpcRendererEvent } from 'electron'` | type-only | ✅ |
| `:25` | `import type { SerializedAppError, WorkProjectionPayload } from './ipc/types.js'` | type-only | ✅ |
| `:30-40` | `import type { MemoryListItem, MemoryDetail, ... } from '../sprite/controllers/memoryController.js'` | type-only | ✅ |
| `:42` | `import type { SpriteConfig } from '../sprite/spriteConfig.js'` | type-only | ✅ |
| `:44` | `import type { DedupReport, TimelinessReport, ConflictReport } from 'memora'` | type-only | ✅ |
| `:46` | `import type { AffectState, RapportState, ... } from '../sprite/controllers/index.js'` | type-only | ✅ |

**preload-float.ts / preload-quick-input.ts 运行时 import**：

| 文件 | 引用 | 类型 | 评估 |
|------|------|------|------|
| `preload-float.ts:26-27` | `from 'electron'`（contextBridge + IpcRendererEvent） | runtime + type-only | ✅ |
| `preload-quick-input.ts:20-21` | `from 'electron'`（contextBridge + IpcRendererEvent） | runtime + type-only | ✅ |

✅ **preload 严格隔离**：
- 唯一运行时 import 是 `electron`（contextBridge 本职）
- 所有跨层引用均为 `import type`（编译期擦除，符合 sandbox 兼容性约束）
- preload.ts 注释明确说明："仅保留 `import type`（编译时擦除，不产生运行时模块加载）"
- preload 不 import main.ts / agentListeners / windows/ 等主进程运行时代码

### 3.6 main 进程 → preload 引用

**扫描模式**：在 `electron/` 下扫描 `from\s+['"]\.\/preload`

| 扫描路径 | 匹配数 | 状态 |
|----------|--------|------|
| `electron/`（生产代码） | 0 | ✅ |
| `__tests__/`（测试代码） | 7（全 type-only） | ✅ 测试豁免 |

✅ **main 进程不反向引用 preload 运行时**。测试文件 7 处 type-only 引用（`WorkProjectionPayload` / `ConfigSuggestionPayload` / `ElectronAPI` 等）用于 IPC 契约断言，符合测试需求。

---

## 四、sprite 跨层依赖审查

### 4.1 renderer 四层依赖矩阵

> **依赖方向规则**（directory-structure.md §2.1）：
> - controllers → helpers / components（应通过 UIManager 中介 panels/components）
> - panels → components / helpers（✅ 允许）
> - helpers → helpers（✅ 允许）；helpers 不应 import controllers/panels（应是被调用方）
> - components → helpers（✅ 允许）；components 不应 import controllers/panels

| 源 \ 目标 | controllers/ | panels/ | helpers/ | components/ | ui.ts (UIManager) |
|-----------|--------------|---------|----------|-------------|-------------------|
| **controllers/** | — | 🔴 1 runtime | 🟢 多处 | 🟢 0 | 🟢 多处（DI 注入） |
| **panels/** | 🟢 0 | — | 🟢 多处 | 🟢 10 处 | 🟢 多处 |
| **helpers/** | 🟢 0 runtime | 🟡 5 type-only | — | 🟢 0 | 🟢 0 |
| **components/** | 🟢 0 | 🟢 0 | 🟢 19 处 | — | 🟢 0 |

**图例**：🟢 = 无引用或方向正确；🟡 = type-only 引用（编译期擦除）；🔴 = 运行时违规

### 4.2 违规清单

#### 🔴 P2-2 · controllers → panels 运行时违规（已记录）

| 项 | 值 |
|----|----|
| **文件:行号** | `f:\zooique\memora\hosts\memora-sprite\src\electron\renderer\controllers\memoryController.ts:29` |
| **引用** | `import { LlmGovernanceResultRenderer } from '../panels/llmGovernanceResultRenderer.js';` |
| **类型** | runtime import |
| **违规性质** | controllers 直接实例化 panels 渲染器（memoryController.ts:93 `new LlmGovernanceResultRenderer()`），违反"controllers → panels/components 应通过 UIManager 中介"原则 |
| **优先级** | **P2**（风格不一致） |
| **既有记录** | [step-7-sprite-helpers.md SPRITE-0719-P2-2](./step-7-sprite-helpers.md) 已记录，待自然生长触发收敛 |
| **修复方向** | 通过 UIManager 持有 LlmGovernanceResultRenderer 实例 + DI 注入到 MemoryController；或将其降级到 helpers/（若不持有面板级 DOM 状态） |
| **当前处置** | 维持观察。当前仅 1 处，等 panels 渲染器扩展时通过 UIManager 中介统一收敛（ADR-017 枝叶层 2 次提取原则） |

#### 🟡 helpers → panels type-only 引用（5 处风格不一致）

| 文件:行号 | 引用 | Host 接口 | 优先级 |
|-----------|------|-----------|--------|
| `helpers/providerManagement.ts:38` | `import type { SettingsPanelHost } from '../panels/settingsPanelManager.js'` | SettingsPanelHost | P3 |
| `helpers/messageOperations.ts:17` | `import type { ChatPanelHost } from '../panels/chatPanelManager.js'` | ChatPanelHost | P3 |
| `helpers/chatPanelEvents.ts:32` | `import type { ChatPanelHost } from '../panels/chatPanelManager.js'` | ChatPanelHost | P3 |
| `helpers/memoryDetailPanel.ts:28` | `import type { MemoryPanelHost } from '../panels/memoryPanelManager.js'` | MemoryPanelHost | P3 |
| `helpers/memoryPanelEvents.ts:28` | `import type { MemoryPanelHost } from '../panels/memoryPanelManager.js'` | MemoryPanelHost | P3 |

**判定理由**：
- 全部为 `import type`，编译期擦除，**无运行时循环依赖**
- 5 处均为"依赖注入 Host 接口"模式：helpers 通过 Host 接口约定调用方契约，Host 由 PanelManager 实现
- 各文件注释均明确说明："类型仅导入：运行时不会产生循环依赖（type-only 在编译期擦除）"
- 概念上 helpers 应是被调用方，但 DI 模式下 helpers 反向声明 Host 接口是合理的设计取舍

**当前处置**：归档为 P3 观察项。若未来 helpers 数量增长出现实际循环依赖嫌疑，再评估提取 Host 接口到 `renderer/types.ts` 或独立的 `interfaces/` 层。

### 4.3 sprite 层独立性审查

> **规则**：`sprite/` 是"纯逻辑，零 Electron 依赖"层（directory-structure.md §2.1）

| 扫描项 | 扫描模式 | 匹配数 | 状态 |
|--------|----------|--------|------|
| sprite → electron/renderer | `from\s+['"](\.\./)+electron/renderer/` | 0 | ✅ |
| sprite → electron（npm 包） | `from\s+['"]electron['"]` | 0 | ✅ |
| sprite → electron 根/ipc/windows | 多模式扫描 | 0 | ✅ |

✅ **sprite 层零 Electron 依赖**，纯逻辑边界保持完整。

### 4.4 storage 层独立性审查

> **规则**：`storage/` 是持久化层，不应反向依赖业务逻辑层

| 扫描项 | 扫描模式 | 匹配数 | 状态 |
|--------|----------|--------|------|
| storage → sprite/controllers | `from\s+['"](\.\./)+sprite/controllers/` | 0 | ✅ |
| storage → electron | `from\s+['"](\.\./)+electron/` | 0 | ✅ |

✅ **storage 层零反向依赖**。

### 4.5 panels/components 依赖方向审查

| 扫描项 | 扫描模式 | 匹配数 | 状态 |
|--------|----------|--------|------|
| panels → components | `from\s+['"]\.\./(components)/` | 10 | ✅ 方向正确 |
| components → panels/controllers | `from\s+['"]\.\./(panels\|controllers)/` | 0 | ✅ |
| components → helpers | `from\s+['"]\.\./(helpers)/` | 19 | ✅ 方向正确 |

**panels → components 引用清单**（10 处，全部方向正确）：

| 文件:行号 | 引用 | 类型 |
|-----------|------|------|
| `panels/streamingRenderer.ts:23` | `renderMarkdown` from `components/markdown.js` | runtime |
| `panels/skillDropManager.ts:19` | `ToastManager` from `components/toast.js` | type-only |
| `panels/clipboardManager.ts:19-20` | `ToastManager` / `ModalManager` | type-only |
| `panels/chatPanelManager.ts:25` | `renderMarkdown` from `components/markdown.js` | runtime |
| `panels/chatPanelManager.ts:51` | `showStartupSummary` from `components/startupSummaryBanner.js` | runtime |
| `panels/memoryPanelManager.ts:24` | `RelationGraphRenderer` / `RelationGraphData` | type-only |
| `panels/memoryGraphPanel.ts:31-32` | `RelationGraphRenderer` / `RelationGraphData` | runtime + type-only |
| `panels/insightsRenderer.ts:18` | `RelationGraphData` | type-only |

✅ **panels/components 依赖方向全部正确**。

---

## 五、跨包引用合规性审查

### 5.1 sprite → memora 引用扫描

**扫描模式**：`from\s+['"]memora(/src|/dist)?/` + `from\s+['"]memora['"]`

| 扫描项 | 匹配数 | 状态 |
|--------|--------|------|
| sprite 直接 import memora 内部路径（`memora/src/...` / `memora/dist/...`） | 0 | ✅ |
| sprite 通过公共 API import（`from 'memora'`） | 100 | ✅ |

✅ **跨包引用全部走公共 API**。

### 5.2 引用分布统计

**按文件类别分布**（共 100 处 `from 'memora'` 引用）：

| 类别 | 引用数 | 典型导入内容 |
|------|--------|--------------|
| `sprite/` 业务逻辑层 | ~30 | Agent / Memory / logger / toError / ITracer / safeSetTimeout 等运行时工具 |
| `sprite/controllers/` | ~15 | type-only：Agent / Memory / Persona / MemoryRelation 等 |
| `storage/` 持久化层 | ~10 | IMemoryStorage / IMemoryRelationStore / Memory / segmentLower / validateSource 等接口和工具 |
| `web/` Web 模式 | ~10 | logger / toError / Agent / Config / createProviderFromConfig |
| `electron/` 主进程 | ~5 | logger / toError / setLogger 等 |
| `__tests__/` 测试 | ~30 | 全类型 + setLogger / InMemoryStorage / Agent 等测试夹具 |

**典型引用模式**（抽样）：

```ts
// f:\zooique\memora\hosts\memora-sprite\src\storage\sqliteStorage.ts:10-12
import type { IMemoryStorage } from 'memora';
import type { Memory } from 'memora';
import { segmentLower, validateSource, logger } from 'memora';

// f:\zooique\memora\hosts\memora-sprite\src\sprite\sprite.ts:18-22
import type { Agent, AgentMetrics, Memory, UserProfileEntry } from 'memora';
import type { IVectorStore, ITracer } from 'memora';
import type { RelationPath, RelationNeighbor } from 'memora';
import { logger, toError } from 'memora';
```

✅ **所有引用均通过 memora 包的 `.` 公共入口**，符合 [project-rules.md §2.5](../../.trae/rules/project-rules.md) "精灵依赖内核"约定。

### 5.3 memora 公共 API 导出完整性

`f:\zooique\memora\src\index.ts` 共导出：
- **运行时类/函数**：`Agent` / `loadConfig` / `createLlmProvider` / `OpenAICompatibleProvider` / `InMemoryStorage` / `InMemoryRelationStore` / `JsonVectorStore` / `EmbeddingProvider` / `ProjectRegistry` / `LockManager` / `RelationBuilder` / `recall` / `extractKeywords` / `segmentText` / `isPlainObject` / `parseFrontmatter` / `serializeFrontmatter` / `safeSetTimeout` / `safeSetInterval` / `setLogger` / `logger` / `toError` / `MemoraError` / `EvalRunner` 等
- **type-only**：`AgentOptions` / `AgentContext` / `Memory` / `MemoryRelation` / `IMemoryStorage` / `IMemoryRelationStore` / `ISessionStore` / `IVectorStore` / `LlmProvider` / `ChatOptions` / `ILogger` / `ITracer` / `AuditEvent` / `Persona` / `SkillEntry` / `EvalScenario` 等

✅ **公共 API 覆盖完整**，sprite 所有需求均在导出清单内，无需穿透到内部路径。

---

## 六、优先级分类汇总

### 6.1 P1 架构违规

**无 P1 违规**。

### 6.2 P2 风格不一致

| ID | 违规 | 位置 | 既有记录 | 处置 |
|----|------|------|----------|------|
| LAYER-0719-P2-1 | controllers → panels 运行时 import + 实例化 | `renderer/controllers/memoryController.ts:29,93` | [step-7-sprite-helpers.md SPRITE-0719-P2-2](./step-7-sprite-helpers.md) | 待自然生长触发：等 panels 渲染器扩展时通过 UIManager 中介收敛 |

### 6.3 P3 观察项（type-only 风格不一致）

| ID | 项 | 位置 | 处置 |
|----|----|------|------|
| LAYER-0719-P3-1 | helpers → panels type-only Host 接口引用（DI 模式） | `helpers/providerManagement.ts:38` / `helpers/messageOperations.ts:17` / `helpers/chatPanelEvents.ts:32` / `helpers/memoryDetailPanel.ts:28` / `helpers/memoryPanelEvents.ts:28`（共 5 处） | 维持观察。type-only 编译期擦除，无运行时循环依赖。若未来 helpers 数量增长出现实际循环依赖嫌疑，再评估提取 Host 接口到独立 `interfaces/` 层 |

### 6.4 P3 边界豁免（设计意图明确）

| 项 | 位置 | 豁免理由 |
|----|------|----------|
| renderer → ipc/types type-only | `renderer/ipcListeners.ts:21` | `SerializedAppError` 为 IPC 传输 DTO，主/渲染共享类型是必要的契约对齐（ipc/types.ts:167-169 注释明确） |
| renderer → preload type-only | `renderer/controllers/memoryController.ts:23` 等 | preload 为 IPC 契约类型真理源（preload.ts:26 "重新导出 WorkProjectionPayload，使渲染层统一从 preload 导入"） |
| preload → sprite/memora type-only | `preload.ts:30-46` | preload 需声明 electronAPI 接口形状，type-only 不产生运行时耦合，符合 sandbox 兼容性约束 |
| 测试文件 → preload type-only | `__tests__/` 7 处 | 测试需断言 IPC 契约，type-only 引用符合测试需求 |

---

## 七、审查结论

### 7.1 通过项（4/4 大维度）

| 维度 | 结论 |
|------|------|
| memora 内核独立性（§1.6） | ✅ **完全通过**。零 native/web 模块 import，dependencies 空载，无 sprite/hosts 反向引用 |
| sprite 跨进程边界 | ✅ **完全通过**。renderer/main/preload 三方运行时隔离彻底，仅通过 type-only 共享 IPC 契约类型 |
| 跨包引用合规性 | ✅ **完全通过**。100 处 sprite → memora 引用全部通过 `'memora'` 公共 API，无内部路径穿透 |
| sprite 跨层依赖 | 🟡 **1 处 P2 已知违规 + 5 处 P3 type-only 观察项**。无新增违规，P2 违规已记录于 step-7-sprite-helpers.md |

### 7.2 整体评估

🟢 **可继续打包流程**：

- 无 P1 架构违规
- 1 处 P2 违规（controllers → panels 运行时 import）为已知项，已记录于 step-7-sprite-helpers.md，按 ADR-017 枝叶层 2 次提取原则待自然生长触发收敛，不影响打包
- 5 处 P3 type-only 引用为 DI 模式合理设计取舍，编译期擦除无运行时风险
- 边界豁免项均有明确设计意图（IPC 契约类型共享、preload sandbox 兼容性），不属于违规

### 7.3 后续触发时机

- **LAYER-0719-P2-1 修复触发**：当 panels/ 新增第 2 个被 controllers 直接引用的渲染器时，启动 UIManager 中介收敛重构
- **LAYER-0719-P3-1 重评估触发**：当 helpers/ 中 import panels Host 接口的文件数 ≥ 10 时，评估提取 Host 接口到独立 `interfaces/` 层

---

## 八、引用

- [project-rules.md §1.6 零依赖内核](../../.trae/rules/project-rules.md)
- [project-rules.md §7.2 内核独立性](../../.trae/rules/project-rules.md)
- [project-rules.md §2.5 同仓库多 Package 结构](../../.trae/rules/project-rules.md)
- [backend_layers_rules.md](../../.trae/rules/backend_layers_rules.md)
- [hosts/memora-sprite/.trae/rules/directory-structure.md §2.1 职责分组原则](../../hosts/memora-sprite/.trae/rules/directory-structure.md)
- [ADR-002-storage-layer.md §三层架构](../../.trae/decisions/ADR-002-storage-layer.md)
- [ADR-017-natural-growth-redefinition.md 枝叶层 2 次提取](../../.trae/decisions/ADR-017-natural-growth-redefinition.md)
- [ADR-SP-015-panel-manager-composition.md](../../.trae/decisions/ADR-SP-015-panel-manager-composition.md)
- [step-7-sprite-helpers.md SPRITE-0719-P2-2](./step-7-sprite-helpers.md)
