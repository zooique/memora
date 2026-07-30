# Step 9 · ESM 导入规范 + 循环依赖审查报告

> **审查日期**：2026-07-19
> **审查范围**：memora 内核 `src/` + sprite 宿主 `hosts/memora-sprite/src/`
> **对照标准**：
> - [ADR-001 运行时栈](../../.trae/decisions/ADR-001-runtime-stack.md)（Node.js 22 LTS + TS 5 strict + ESM）
> - [ADR-002 存储层抽象](../../.trae/decisions/ADR-002-storage-layer.md)（零 native 依赖内核）
> - [ADR-008 目录结构](../../.trae/decisions/ADR-008-directory-structure.md)（按职责分层）
> - [project-rules.md §1.6 零依赖内核](../../.trae/rules/project-rules.md)
> - [backend_layers_rules.md](../../.trae/rules/backend_layers_rules.md)（src/ 各模块职责边界）
> **审查性质**：仅审查记录，不修改任何文件

## 0. 审查项与判定标准速查

| # | 审查项 | 判定标准 | 工具方法 |
| - | ------ | -------- | -------- |
| 1 | ESM `.js` 扩展名规范 | 相对路径 import 必须显式带 `.js` 扩展名（NodeNext moduleResolution 强制要求） | PowerShell 遍历每行 + regex 匹配 |
| 2 | 路径别名（`@/`）使用规范 | 别名配置应集中在 tsconfig.json `paths`，禁止与相对路径混用；跨包禁止使用别名 | 读取 tsconfig.json + 全量统计 |
| 3 | 循环依赖检测 | 静态扫描双向 import 对，区分 value import 与 `import type`（后者编译时擦除） | 解析 `from './x.js'` 解析为绝对路径 + 构建有向图找双向边 |
| 4 | 跨包导入方向 | sprite → memora 必须通过 `'memora'` 包名；禁止 sprite 引用 `memora/src/internal` 等私有路径；禁止 memora 反向依赖 sprite | regex 全量扫描 |

---

## 1. ESM `.js` 扩展名规范审查

### 1.1 memora 内核 `src/`

| 项目 | 数值 | 说明 |
| ---- | ---- | ---- |
| `@/` 别名导入总数 | 622 处 | 全部带 `.js` 扩展名 |
| 相对路径（`./`、`../`）导入总数 | 4 处 | 全部带 `.js` 扩展名（`eval/` 内部 3 处 + `utils/loggerHolder.ts` 注释中 1 处） |
| 不带 `.js` 的违规数 | **0** | ✓ 100% 合规 |

**memora 内核 4 处相对路径导入清单**（数量极少，全量列出）：

| 文件 | 行号 | 导入语句 | 备注 |
| ---- | ---- | -------- | ---- |
| `src/eval/scenarios.ts` | 26 | `import type { EvalScenario } from './evalTypes.js';` | ✓ 合规 |
| `src/eval/evalRunner.ts` | 17 | `import type { EvalScenario, EvalResult } from './evalTypes.js';` | ✓ 合规 |
| `src/eval/evalRunner.ts` | 18 | `import { collectAgentChunks, evaluateResult } from './evalTypes.js';` | ✓ 合规 |
| `src/utils/loggerHolder.ts` | 17 | （docstring 注释示例 `import { getLogger } from './loggerHolder.js';`） | ✓ 合规（注释非真实导入） |

> **观察**：memora 内核大量使用 `@/` 别名（622 处）替代相对路径，相对路径仅 4 处。这是 ADR-008 分层架构约束下的合理选择——`@/` 别名让模块归属一目了然。

### 1.2 sprite 宿主 `hosts/memora-sprite/src/`

| 项目 | 数值 | 说明 |
| ---- | ---- | ---- |
| 相对路径（`./`、`../`）导入总数 | 1007 处 | 全部带 `.js` 扩展名 |
| `@/` 别名导入总数 | 0 处 | sprite 未配置 `@/` 别名（见 §2.2） |
| 不带 `.js` 的违规数 | **0** | ✓ 100% 合规 |

### 1.3 结论

✅ **ESM `.js` 扩展名规范 100% 合规**：
- memora 内核 626 处导入（622 处 `@/` + 4 处相对路径）全部带 `.js`
- sprite 宿主 1007 处相对路径导入全部带 `.js`
- **无任何违规，无需修复**

---

## 2. 路径别名（`@/`）使用规范审查

### 2.1 memora 内核 tsconfig.json

```jsonc
{
  "compilerOptions": {
    "baseUrl": "./src",
    "paths": { "@/*": ["./*"] },
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

| 项目 | 现状 | 评估 |
| ---- | ---- | ---- |
| `baseUrl` | `./src` | ✓ 标准做法 |
| `paths` | `@/*` → `./*` | ✓ 简洁明确 |
| 使用范围 | 100 个文件 622 处导入 | ✓ 广泛且一致 |
| 是否混用相对路径 | 仅 4 处相对路径（`eval/` 内部 + docstring 注释） | ✓ 不视为混用 |

**结论**：memora 内核别名配置规范、使用一致，无违规。

### 2.2 sprite 宿主 tsconfig 配置链

sprite 采用多 tsconfig 配置：

| 配置文件 | `baseUrl` | `paths` | 使用 `@/` |
| -------- | --------- | ------- | --------- |
| `tsconfig.base.json` | 未配置 | 未配置 | — |
| `tsconfig.json`（extends base） | 未配置 | 未配置 | 0 处 |
| `tsconfig.electron.json`（extends base） | 未配置 | 未配置 | 0 处 |
| `tsconfig.preload.json`（extends base） | 未配置 | 未配置 | 0 处 |
| `tsconfig.web.json`（extends base） | 未配置 | 未配置 | 0 处 |

**结论**：sprite 宿主统一不使用 `@/` 别名，全部采用相对路径。这与 sprite 多入口（Electron 主进程/preload/renderer + Web 模式）的构建链有关——多个 tsconfig 共享相对路径方案更简单稳定。无违规。

### 2.3 别名混用违规清单

| 文件 | 违规描述 | 优先级 |
| ---- | -------- | ------ |
| — | 无违规 | — |

✅ **路径别名规范审查无违规**。memora 用 `@/`、sprite 用相对路径，各自一致，无混用。

---

## 3. 循环依赖检测

### 3.1 检测方法

1. 遍历所有 `.ts` 文件（排除 `__tests__/`）解析 `from './xxx.js'` 形式的相对路径导入
2. 将 `./xxx.js` 解析为绝对路径，构建模块依赖有向图
3. 查找双向边（A→B 且 B→A）作为循环依赖候选
4. 对每个循环对，逐一检查反向 import 是否为 `import type`（编译时擦除）

### 3.2 memora 内核循环依赖

| 循环对 | 数量 |
| ------ | ---- |
| 共检测到 | **0** |

✅ **memora 内核无循环依赖**。

### 3.3 sprite 宿主循环依赖

共检测到 **16 处**循环依赖，**全部为 type-only 单向**（反向引用均为 `import type`，编译时擦除，运行时无循环风险）。

#### 3.3.1 完整循环依赖清单

| # | 循环对（A ↔ B） | value 方向（运行时实际依赖） | type-only 方向（编译时擦除） | 反向引用类型 | 运行时风险 |
| - | --------------- | --------------------------- | --------------------------- | ------------ | ---------- |
| 1 | `sprite/controllers/memoryController.ts` ↔ `memoryHealth.ts` | memoryController → memoryHealth（`buildHealthDashboard`） | memoryHealth:17 → memoryController（`MemoryListItem`） | `import type` | 无 |
| 2 | `sprite/controllers/memoryController.ts` ↔ `reviewManager.ts` | memoryController → reviewManager（`buildReviewData`） | reviewManager:16 → memoryController（`MemoryListItem, DashboardData`） | `import type` | 无 |
| 3 | `electron/renderer/panels/chatPanelManager.ts` ↔ `helpers/chatPanelEvents.ts` | chatPanelManager:54 → chatPanelEvents（`initChatPanelEvents`） | chatPanelEvents:32 → chatPanelManager（`ChatPanelHost`） | `import type` | 无 |
| 4 | `electron/renderer/panels/memoryPanelManager.ts` ↔ `helpers/memoryDetailPanel.ts` | memoryPanelManager:54 → memoryDetailPanel（init fn） | memoryDetailPanel:28 → memoryPanelManager（`MemoryPanelHost`） | `import type` | 无 |
| 5 | `electron/renderer/panels/memoryPanelManager.ts` ↔ `helpers/memoryPanelEvents.ts` | memoryPanelManager:34 → memoryPanelEvents（`initMemoryPanelListeners`） | memoryPanelEvents:28 → memoryPanelManager（`MemoryPanelHost`） | `import type` | 无 |
| 6 | `electron/renderer/panels/settingsPanelManager.ts` ↔ `helpers/providerManagement.ts` | settingsPanelManager → providerManagement（init fn） | providerManagement:38 → settingsPanelManager（`SettingsPanelHost`） | `import type` | 无 |
| 7 | `electron/renderer/ui.ts` ↔ `helpers/uiDelegations/chatDelegations.ts` | ui:87 → chatDelegations（`chatDelegations`） | chatDelegations:12 → ui（`UIManager`） | `import type` | 无 |
| 8 | `electron/renderer/ui.ts` ↔ `helpers/uiDelegations/dashboardDelegations.ts` | ui:91 → dashboardDelegations（`dashboardDelegations`） | dashboardDelegations:13 → ui（`UIManager`） | `import type` | 无 |
| 9 | `electron/renderer/ui.ts` ↔ `helpers/uiDelegations/memoryDelegations.ts` | ui:89 → memoryDelegations（`memoryDelegations`） | memoryDelegations:12 → ui（`UIManager`） | `import type` | 无 |
| 10 | `electron/renderer/ui.ts` ↔ `helpers/uiDelegations/miscDelegations.ts` | ui:97 → miscDelegations（`miscDelegations`） | miscDelegations:13 → ui（`UIManager`） | `import type` | 无 |
| 11 | `electron/renderer/ui.ts` ↔ `helpers/uiDelegations/personaThemeDelegations.ts` | ui:93 → personaThemeDelegations（`personaThemeDelegations`） | personaThemeDelegations:13 → ui（`UIManager`） | `import type` | 无 |
| 12 | `electron/renderer/ui.ts` ↔ `helpers/uiDelegations/settingsModalDelegations.ts` | ui:95 → settingsModalDelegations（`settingsModalDelegations`） | settingsModalDelegations:12 → ui（`UIManager`） | `import type` | 无 |
| 13 | `electron/renderer/ui.ts` ↔ `ipcListeners.ts` | ui:53 → ipcListeners（多个绑定函数） | ipcListeners:19 → ui（`UIManager`） | `import type` | 无 |
| 14 | `electron/renderer/ui.ts` ↔ `panels/commandPaletteManager.ts` | ui:56 → commandPaletteManager（`CommandPaletteManager`） | commandPaletteManager:15 → ui（`UIManager`） | `import type` | 无 |
| 15 | `electron/renderer/panels/memoryPanelManager.ts` ↔ `panels/memoryGraphPanel.ts` | memoryPanelManager:42 → memoryGraphPanel（init fn） | memoryGraphPanel:34 → memoryPanelManager（`MemoryPanelHost`） | `import type` | 无 |
| 16 | `electron/errorHandler.ts` ↔ `electron/ipc/types.ts` | ipc/types:52 → errorHandler（`errorHandler, ErrorCode`） | errorHandler:14 → ipc/types（`SerializedAppError`） | `import type` | 无 |

#### 3.3.2 循环依赖模式归纳

观察 16 处循环依赖，可归纳为 3 类模式：

| 模式 | 循环对数量 | 涉及文件 | 反向 type-only 引用的语义 |
| ---- | ---------- | -------- | ------------------------ |
| **A. Controller ↔ Builder** | 2 | memoryController ↔ memoryHealth/reviewManager | Builder 反向引用 Controller 的列表项类型（`MemoryListItem`），用于函数参数 |
| **B. Panel ↔ Helper** | 4 | chatPanelManager ↔ chatPanelEvents<br>memoryPanelManager ↔ memoryDetailPanel/memoryPanelEvents<br>settingsPanelManager ↔ providerManagement | Helper 反向引用 Panel 的 Host 接口（`XxxPanelHost`），用于事件回调上下文 |
| **C. UI 中心 ↔ 委托/监听/面板** | 10 | ui ↔ 6 个 uiDelegations + ipcListeners + commandPaletteManager + memoryGraphPanel | 委托/监听/面板反向引用 `UIManager` 类型，用于函数签名约束 |

#### 3.3.3 循环依赖图

```text
【sprite/controllers 模块】
                            ┌─────────────────────┐
                            │  memoryController   │
                            └──────────┬──────────┘
                  value import         │         type-only import
            ┌─────────────────────────┘         └─────────────────────────┐
            ▼                                                             ▼
  ┌──────────────────┐  type-only                          ┌──────────────────┐  type-only
  │  memoryHealth    │ ←──────── MemoryListItem ───────── │  reviewManager   │
  └──────────────────┘                                      └──────────────────┘
       （A 类：Controller ↔ Builder）


【electron/renderer Panels ↔ Helpers】
                                              ┌──────────────────────┐
                                              │  chatPanelManager    │
                                              └──────────┬───────────┘
                                  value ─────────────────┘      │ type-only
                                                       ▼         ▼
  ┌──────────────────────┐                  ┌──────────────────────────────┐
  │  memoryPanelManager  │ ── value ──────► │  chatPanelEvents             │
  │         ▲            │                  │  (ChatPanelHost)             │
  │         │            │                  └──────────────────────────────┘
  │  type-only           │
  │  MemoryPanelHost     │                  ┌──────────────────────────────┐
  │         │            │ ── value ──────► │  memoryDetailPanel           │
  │         ▼            │                  │  (MemoryPanelHost)           │
  ┌──────────────────────┐                  └──────────────────────────────┘
  │  memoryPanelEvents   │                  ┌──────────────────────────────┐
  │  (MemoryPanelHost)   │ ◄── value ────── │  memoryGraphPanel            │
  └──────────────────────┘                  │  (MemoryPanelHost)           │
                                            └──────────────────────────────┘

  ┌────────────────────────┐ value           ┌──────────────────────────────┐
  │  settingsPanelManager  │ ──────────────► │  providerManagement         │
  └────────────────────────┘                 │  (SettingsPanelHost)         │
                                             └──────────────────────────────┘
                                  （B 类：Panel ↔ Helper）


【electron/renderer UI 中心辐射】
                                        ┌──────────────────┐
                                        │       ui         │
                                        └────────┬─────────┘
            ┌──────────────┬──────────────┬─────┴──────┬──────────────┬─────────────┐
            ▼              ▼              ▼            ▼              ▼             ▼
       chatDeleg     dashboardDeleg  memoryDeleg  miscDeleg  personaThemeDeleg  settingsModalDeleg
       (UIManager)   (UIManager)     (UIManager)  (UIManager) (UIManager)        (UIManager)
            │              │              │            │              │             │
            └──────────────┴──────┬───────┴────────────┴──────────────┴─────────────┘
                                  │
                                  │ + ipcListeners (UIManager)
                                  │ + commandPaletteManager (UIManager)
                                  ▼
                              （全部 type-only 反向引用）
                                  （C 类：UI 中心辐射）


【electron 错误处理】
  ┌──────────────────────┐  value (errorHandler, ErrorCode)  ┌──────────────────────┐
  │  electron/errorHandler│ ◄─────────────────────────────── │  electron/ipc/types   │
  │                       │ ────── type-only ──────────────► │  (SerializedAppError) │
  └──────────────────────┘                                   └──────────────────────┘
                                  （混合：value + type-only 反向）
```

#### 3.3.4 风险评估

| 维度 | 评估 |
| ---- | ---- |
| 编译时 | ✅ TypeScript `import type` 在编译为 JavaScript 时完全擦除，编译产物无循环 |
| 运行时 | ✅ 16 处循环全部为单方向 value import + 反方向 type-only，运行时仅有单向依赖，无循环引用 |
| ESM 加载顺序 | ✅ 无运行时循环意味着 ESM 模块加载不会出现 "Cannot access before initialization" 错误 |
| 长期维护 | ⚠️ type-only 循环仍是"逻辑循环依赖"——若未来某次重构将 `import type` 改为 `import`（如需要调用 Panel 的方法），将立即变成运行时循环。建议在相关文件头部加注释提示 |
| 重构成本 | ⚠️ 模式 B/C 的根本原因是 "Host 接口定义在 Panel 上，但 Helper 又被 Panel 调用"——彻底消除需提取 Host 接口到独立 `types.ts`，工作量较大 |

#### 3.3.5 建议（不在本次审查范围内执行）

| 优先级 | 建议 | 理由 |
| ------ | ---- | ---- |
| **P4** | 在 16 处循环的 type-only 反向引用上方添加约束注释：`// 反向仅允许 type-only import，禁止改为 value import（否则形成运行时循环）` | 防止未来重构误改 |
| **P5** | 长期可考虑将各 `XxxPanelHost` 接口提取到 `panels/types.ts`，让 Helper 引用 `panels/types.ts` 而非 `panels/xxxManager.ts` | 彻底消除逻辑循环；但当前 16 处均为 type-only，运行时安全，非紧急 |

---

## 4. 跨包导入方向审查

### 4.1 跨包导入方向矩阵

| 源 ↓ \ 目 → | memora 内核 | sprite `shared/` | sprite `sprite/` | sprite `storage/` | sprite `electron/` | sprite `web/` |
| ----------- | ----------- | ---------------- | ---------------- | ----------------- | ------------------ | ------------- |
| **memora 内核** | — | ❌ 禁止 | ❌ 禁止 | ❌ 禁止 | ❌ 禁止 | ❌ 禁止 |
| **sprite `shared/`** | ✅ `'memora'` 包名 + `import type` | — | ⚠️ type-only（HostContext 容器类型） | ⚠️ type-only（HostContext 容器类型） | ❌ 不应反向 | ❌ 不应反向 |
| **sprite `sprite/`** | ✅ `'memora'` 包名 | ✅ 相对路径 | — | ❌ 不应反向 | ❌ 不应反向 | ❌ 不应反向 |
| **sprite `storage/`** | ✅ `'memora'` 包名 | ✅ 相对路径 | ✅ 相对路径（errors/constants） | — | ❌ 不应反向 | ❌ 不应反向 |
| **sprite `electron/`** | ✅ `'memora'` 包名 | ✅ 相对路径 | ✅ 相对路径 | ✅ 相对路径 | — | ❌ 不应反向 |
| **sprite `web/`** | ✅ `'memora'` 包名 | ✅ 相对路径 | ✅ 相对路径 | ❌ 不应反向 | ❌ 不应反向 | — |

**图例**：
- ✅ = 实际允许且已存在的合法方向
- ❌ = 禁止方向（违反 ADR-008 分层或 ADR-002 内核独立性）
- ⚠️ = 仅允许 type-only（编译时擦除）

### 4.2 memora 内核反向依赖 sprite 检查

| 检查项 | 结果 |
| ------ | ---- |
| memora `src/` 内 `from 'memora-sprite'` | **0 处** ✓ |
| memora `src/` 内 `from '../../hosts/memora-sprite'` 等跨包相对路径 | **0 处** ✓ |

✅ **memora 内核零反向依赖 sprite**，符合 ADR-002 "零依赖内核"原则。

### 4.3 sprite 引用 memora 内核方式检查

#### 4.3.1 通过 `'memora'` 包名导入统计

| 项目 | 数值 |
| ---- | ---- |
| sprite `src/` 内 `from 'memora'` 导入总次数 | 123 处 |
| 涉及文件数 | 81 个 |
| `from 'memora/src/...'` 等私有路径导入 | **0 处** ✓ |

✅ **sprite 全部通过 `'memora'` 包名引用内核**，无私有路径违规。

#### 4.3.2 sprite 引用 memora 的机制

| 项目 | 配置/实现 |
| ---- | --------- |
| sprite `package.json` 中的 memora 依赖声明 | **未声明**（不使用 `file:../..` 协议） |
| 内核同步方式 | `scripts/sync-memora.mjs` 脚本：编译 memora → 复制 `dist/` + `package.json` + `LICENSE` + `README.md` 到 `sprite/node_modules/memora/` |
| 不使用 `file:` 协议的原因 | 避免 electron-builder 打包时 Junction 将全量仓库（含 `src/`、`tasks/`、`hosts/`、`.trae/`）打入 asar，导致 asar 体积膨胀 |
| 同步触发场景 | (1) `build:electron` / `start:electron` 自动调用<br>(2) `package.mjs` 打包时调用<br>(3) 手动 `npm run sync-memora` |

✅ **跨包引用机制设计合理**：sync-memora.mjs 创建最小化 `node_modules/memora`（仅 `dist/` + 元数据），既满足 `from 'memora'` 包名解析，又避免 asar 膨胀。

#### 4.3.3 sprite 内部跨层导入抽样

| 源层 | 目层 | 示例文件 | 导入内容 | 评估 |
| ---- | ---- | -------- | -------- | ---- |
| `electron/` | `sprite/` | `electron/main.ts:57-60` | `loadSpriteConfig`、`Sprite`、`AuditManager`、`UsageStatsCollector` | ✓ 合理（Electron 主进程装配 Sprite） |
| `electron/` | `shared/` | `electron/preload.ts` | 共享类型 | ✓ 合理 |
| `electron/` | `storage/` | （通过 sprite 层间接） | — | ✓ 合理 |
| `web/` | `sprite/` | `web/server.ts:37-41` | `Sprite`、`AuditManager`、`installSkill` | ✓ 合理（Web 模式同样装配 Sprite） |
| `web/` | `shared/` | `web/webContext.ts` | `HostContext` | ✓ 合理 |
| `storage/` | `sprite/` | `storage/sqliteStorage.ts:14` | `SpriteError, ErrorCode` | ✓ 合理（错误体系归属 sprite 层） |
| `storage/` | `shared/` | （通过 sprite 层间接） | — | ✓ 合理 |
| `shared/` | `sprite/`、`storage/` | `shared/hostContext.ts:15-18` | `Sprite`、`AuditManager`、`SkillInstallResult`、`SqliteSessionStore` | ⚠️ **type-only**（HostContext 容器类型字段） |

### 4.4 shared 层反向 type-only 依赖说明

`shared/hostContext.ts` 定义 `HostContext` 接口（Electron 与 Web 模式的依赖容器），其字段类型需引用：
- `Agent`（来自 `'memora'` 包，type-only）
- `Sprite`、`AuditManager`、`SkillInstallResult`（来自 `../sprite/`，type-only）
- `SqliteSessionStore`（来自 `../storage/`，type-only）

**这是设计上的妥协**：
- 优点：Electron 和 Web 模式复用同一 `HostContext` 类型，避免双份定义
- 缺点：`shared/` 在类型层面对 `sprite/` 和 `storage/` 有反向依赖（违反严格的"shared 是被依赖层"原则）
- 风险评估：type-only 编译时擦除，运行时 `shared/` 仍只被各层单向引用，无运行时循环
- 替代方案：将 `HostContext` 移到 `sprite/` 层（语义上 HostContext 是宿主核心容器），但代价是 `electron/` 和 `web/` 都需多跨一层

✅ **当前 type-only 反向依赖可接受**，但应在 `shared/hostContext.ts` 头部添加约束注释（建议非本次审查范围执行）。

### 4.5 跨包导入违规清单

| 文件 | 违规描述 | 优先级 |
| ---- | -------- | ------ |
| — | 无违规 | — |

✅ **跨包导入方向审查无违规**。

---

## 5. 优先级汇总

| # | 审查项 | 违规数 | 修复优先级 |
| - | ------ | ------ | ---------- |
| 1 | ESM `.js` 扩展名规范 | 0 | — |
| 2 | 路径别名（`@/`）使用规范 | 0 | — |
| 3 | 循环依赖（运行时风险） | 0（16 处 type-only，运行时无循环） | — |
| 3 | 循环依赖（逻辑层 type-only 循环） | 16 处 | **P4**（建议加约束注释） |
| 4 | 跨包导入方向 | 0 | — |

**总体结论**：✅ **ESM 导入规范 + 跨包导入方向 100% 合规**；循环依赖 16 处均为 type-only 单向，运行时无风险，仅建议在 P4 优先级添加约束注释防止未来重构误改。

---

## 6. 待办事项归档

以下事项建议归档到 `tasks/待完成任务.md`（不在本次审查范围内执行）：

| ID | 事项 | 优先级 | 来源 |
| -- | ---- | ------ | ---- |
| STEP9-IMPORTS-01 | 在 16 处 type-only 反向引用上方添加约束注释：`// 反向仅允许 type-only import，禁止改为 value import（否则形成运行时循环）` | P4 | §3.3.5 |
| STEP9-IMPORTS-02 | 长期重构：将各 `XxxPanelHost` 接口提取到 `panels/types.ts`，让 Helper 引用 `panels/types.ts` 而非 `panels/xxxManager.ts`，彻底消除 16 处逻辑循环 | P5 | §3.3.5 |
| STEP9-IMPORTS-03 | 在 `shared/hostContext.ts` 头部添加约束注释：`// 本文件 type-only 引用 sprite/ 和 storage/，禁止改为 value import（保持 shared 层运行时单向被依赖）` | P4 | §4.4 |

---

## 7. 审查方法学说明

### 7.1 数据采集工具

| 工具 | 用途 |
| ---- | ---- |
| PowerShell `Get-ChildItem` + `[regex]::Matches` | 逐行扫描所有 `.ts` 文件，统计 ESM 导入 |
| `Test-Path` + `Get-Item` | 解析 `./xxx.js` 为绝对路径，构建依赖图 |
| Grep（ripgrep） | 局部验证特定文件、特定 import 模式 |
| `Read` | 读取关键文件头部确认 import 类型（value vs type-only） |

### 7.2 已知限制

1. **type-only 检测精度**：本审查通过读取 import 语句是否以 `import type` 开头判定。若使用 `import { type Foo }` 内联语法，理论上也能擦除，但本项目未使用该语法（全量验证：0 处内联 type 修饰）。
2. **运行时循环验证**：本审查仅做静态分析。运行时是否真的无循环，可通过 `node --input-type=module -e "import('./x.js')"` 加载测试，但不在本次审查范围。
3. **三方库循环**：本审查不涉及 `node_modules` 内部三方库的循环依赖（如 better-sqlite3、nut-js 等）。

### 7.3 与 ADR-017 架构先行原则的对齐

ADR-017 §枝叶层 2 次提取原则要求"同一工具函数在 2+ 文件出现 → 提取"。本次审查发现的 16 处 type-only 循环属于架构层（Panel-Helper 双向协作模式），非枝叶层重复——这些循环是架构契约的体现（Host 接口约定），不应通过"提取"消除，而应通过"接口隔离"重构（见 §6 STEP9-IMPORTS-02）。
