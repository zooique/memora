---
alwaysApply: false
description: "memora-sprite 宿主项目总则、技术栈清单、目录结构、与内核的关系"
version: v0.6
date: 2026-07-01
---

# memora-sprite · 宿主项目总则

> **设计哲学**：上下文感知，非内容感知 **核心矛盾**：被动响应 ←→ 主动进化
> **定位**：memora 内核的第一个真实宿主——能自我进化的桌面精灵
> **决策追溯**：`.trae/rules/decisions/` 下 ADR-SP-001~008 + ADR-SP-015

## 1. 与 memora 内核的关系

| 维度 | 内核 | 精灵 |
|------|------|------|
| 依赖方向 | 被依赖（纯逻辑库） | 依赖方（宿主） |
| native 模块 | 零（ADR-002） | better-sqlite3（ADR-SP-002） |
| 接口实现 | 定义接口 | 实现接口（IMemoryStorage / ISessionStore） |
| 规则关系 | 内核规则精灵必须遵守 | 精灵规则仅约束精灵代码 |
| ADR 前缀 | ADR-001~015 | ADR-SP-001~008 + ADR-SP-015 |

**内核 ADR 精灵必须遵守，精灵 ADR 内核不需要知道。**

## 2. 内核更新工作流（npm alias 模式）

> 内核已发布至 npm（`@zooique/memora`），精灵通过 npm alias 引用：`"memora": "npm:@zooique/memora@^0.1.0"`。  
> 源码中 import 保持 `from 'memora'`，包管理层自动完成 `@zooique/memora` → `memora` 的映射。

### 2.1 本地开发工作流（推荐日常迭代使用）

当内核和精灵需要联调时，使用 `npm link` 建立本地软链接，内核编译后精灵立即生效，无需发布 npm：

```bash
# 在 memora 根目录（首次）
npm run build          # 编译内核 src/ → dist/
npm link               # 全局注册 @zooique/memora 软链接

# 在 hosts/memora-sprite/ 目录（首次）
npm link memora        # 建立 node_modules/@zooique/memora → 本地内核目录的 Junction

# 后续迭代：每次改内核代码后
npm run build          # 在 memora 根目录编译，精灵立即生效
# 或开启 watch 模式：npx tsc -w
```

> **注意**：`npm link` 仅影响本地开发环境，不修改 package.json 或 package-lock.json。  
> 提交代码前需确保精灵的 package.json 中 `memora` 依赖仍指向 `npm:@zooique/memora@^0.1.0`（而非 `file:` 协议）。  
> 发布正式版本前，在精灵目录执行 `npm unlink memora && npm install` 切回 npm 正式包。

### 2.2 正式发布工作流（用于发布 npm 版本）

当内核改动需要发布到 npm 供其他宿主或 CI 使用时：

**Step 1 — 内核发布**

```bash
# 在 memora 根目录
npm test              # 924 测试全绿
npm run typecheck     # 零错误
npm run build         # 生成 dist/
npm version patch     # 或 minor / major
npm publish --access public
```

**Step 2 — 精灵更新**

```bash
# 在 hosts/memora-sprite/ 目录
npm update memora     # 解析 alias 到最新匹配的版本
npm run typecheck     # 验证类型兼容
npm run build         # 验证构建通过
```

> **注意**：`npm update memora` 更新的是 alias 指向的实际包（`@zooique/memora`），而非 alias 本身。alias 声明 `"memora": "npm:@zooique/memora@^0.1.0"` 中的版本约束（`^0.1.0`）决定可更新的范围。

## 3. 技术栈清单

| 类别 | 选型 | 决策 |
|------|------|------|
| 运行时 | Node.js 24 LTS + TypeScript 5 strict + ESM | ADR-SP-001 |
| 数据库 | better-sqlite3（native 模块，^12.10.0） | ADR-SP-002 |
| 桌面壳 | 阶段一 CLI → 阶段二 Electron 40 | ADR-SP-003 |
| 感知层 | 上下文感知，非内容感知 | ADR-SP-004 |
| 包管理 | npm + npm alias（`npm:@zooique/memora`）+ @electron/rebuild | ADR-SP-005 |
| 测试 | Vitest + InMemoryStorage + 临时 SQLite | ADR-SP-006 |

## 4. 目录结构

> 详见 [ADR-SP-007](./decisions/ADR-SP-007-directory-structure.md) 和 [directory-structure.md](../../hosts/memora-sprite/.trae/rules/directory-structure.md)

```
hosts/memora-sprite/
├── package.json              ← 独立依赖（memora + better-sqlite3 + electron）
├── tsconfig.json / tsconfig.electron.json
├── vitest.config.ts
└── src/
    ├── index.ts              ← 纯库导出入口（类型 + 接口 + startSprite）
    ├── cli.ts                ← CLI 入口（setupWizard + 命令路由 + REPL）
    │
    ├── electron/             ← Electron 主进程 + 渲染进程
    │   ├── main.ts           ← 主进程入口（窗口生命周期 + 应用启动）
    │   ├── preload.ts        ← 预加载脚本（contextBridge 暴露 API）
    │   ├── esmShim.ts        ← ESM 兼容 shim
    │   ├── errorHandler.ts   ← 全局错误处理
    │   ├── interaction.ts    ← Electron 交互实现（IInteraction 接口）
    │   ├── agentListeners.ts ← Agent 事件监听器
    │   ├── spriteEventBridge.ts ← 精灵事件桥接
    │   ├── trayIcon.ts       ← 系统托盘管理
    │   ├── clipboardHandler.ts ← 剪贴板三重保护处理器（Phase 3.1）
    │   ├── shortcuts.ts      ← 全局快捷键管理器（Phase 3.3）
    │   ├── types.ts          ← Electron 主进程类型 barrel（S-03 阶段 2）
    │   │
    │   ├── ipc/              ← IPC 通信层
    │   │   ├── index.ts / channels.ts / handlers.ts / minimalHandlers.ts
    │   │   ├── types.ts / inputValidation.ts
    │   │   └── chatHandlers.ts / configHandlers.ts / memoryHandlers.ts / ...
    │   │
    │   ├── windows/          ← 窗口管理
    │   │   ├── floatWindow.ts / windowManager.ts / windowState.ts
    │   │
    │   └── renderer/         ← 渲染进程（UI 层，不直接导入 electron）
    │       ├── index.html / renderer.ts / ui.ts / types.ts
    │       ├── ipcListeners.ts / initHelpers.ts
    │       ├── controllers/   ← 面板控制器（业务逻辑，不直接操作 DOM）
    │       │   ├── settingsController.ts / sessionController.ts
    │       │   ├── memoryController.ts / personaController.ts
    │       ├── helpers/       ← 渲染进程工具函数
    │       │   ├── domHelpers.ts / errorHelpers.ts / eventTracker.ts
    │       ├── components/    ← 可复用 UI 组件
    │       │   ├── themeManager.ts / modal.ts / toast.ts / ...
    │       ├── panels/        ← 面板管理器（DOM 绑定 + 渲染逻辑）
    │       │   ├── chatPanelManager.ts / memoryPanelManager.ts / ...
    │       ├── float/         ← 浮动窗口
    │       │   ├── float.ts / float.html
    │       └── styles/        ← CSS 样式表
    │           ├── base.css / chat.css / layout.css / ...
    │
    ├── sprite/               ← 精灵核心层（纯逻辑，零 Electron 依赖）
    │   ├── sprite.ts / spriteConfig.ts / spriteTracer.ts
    │   ├── triggers.ts / tools.ts / constants.ts
    │   ├── fileWatcherTrigger.ts / interaction.ts
    │   ├── skillInstaller.ts ← 技能安装器（拖入安装，Phase 4.3）
    │   ├── cli/              ← CLI 专属模块
    │   │   ├── formatter.ts / interaction.ts
    │   ├── audit/            ← 审计日志
    │   │   ├── auditManager.ts / jsonlAppender.ts
    │   └── controllers/      ← 精灵控制器（Agent 能力扩展）
    │       ├── index.ts / memoryController.ts
    │       ├── personaController.ts / proactiveEngine.ts
    │       └── presenceController.ts ← 在场状态控制器（Phase 3）
    │
    ├── storage/              ← 持久化层
    │   ├── sessionStore.ts / sqliteStorage.ts
    │   ├── spriteConfigStore.ts / sqliteDatabaseTypes.ts
    │
    └── __tests__/            ← 测试文件（按模块分组）
        ├── electron/         ← ipcHandlers.test.ts / ui.test.ts
        ├── sprite/           ← sprite.test.ts / spriteIntegration.test.ts
        ├── storage/          ← sessionStore.test.ts / sqliteStorage.test.ts + helpers/
        └── renderer/         ← float.test.ts / sessionController.test.ts
```

### 4.1 渲染进程分层约束（C-8 确立）

> **原则**：控制器不直接操作 DOM，通过 UIManager 门面委托。

| 层 | 职责 | 禁止 |
|----|------|------|
| `controllers/` | 业务编排（IPC 调用 + 回调注册 + 状态决策） | 直接访问 `document.getElementById` / `querySelector` / `classList` 等 DOM API |
| `panels/` | DOM 绑定 + 渲染逻辑（事件监听 + 元素操作） | 跨面板业务编排（应由 controllers/ 协调） |
| `components/` | 可复用 UI 组件（Toast / Modal / Theme 等 leaf 组件） | 直接依赖 panels/ 或 controllers/ |
| `ui.ts` | UIManager 门面（组合持有所有子模块 + 薄委托方法） | 内联复杂 DOM 渲染逻辑（应拆分到 panels/） |

**执行方式**：controllers/ 需要访问 DOM 时，通过 UIManager 提供的门面方法（如 `getMemorySearchParams()` / `triggerMemorySearchInput()` / `setMemoryListState()`），由 UIManager 内部委托到对应 PanelManager。

### 4.2 注释规范（文件头与类级注释关系）

> **原则**：文件头注释和类级注释各司其职，禁止重复内容。

#### 4.2.1 四级注释体系

继承用户规则中的四级注释要求，明确每级注释的内容边界：

| 层级 | 位置 | 必含内容 | 禁含内容 |
|------|------|----------|----------|
| 文件级 | 文件首部 `/** ... */` | 模块职责、来源（如 "C-5-x 拆分"）、设计原则 | 类的具体实现细节、字段说明 |
| 类级 | `export class Foo` 上方 | 类的职责概述、依赖、生命周期 | 与文件级重复的"模块职责" |
| 函数级 | 方法上方 | 用途、参数、返回值、副作用 | 显而易见的实现 |
| 变量级 | 字段/局部变量声明处 | 字段用途（私有字段必须） | 类型已说明的冗余解释 |

#### 4.2.2 文件头 vs 类级注释的分工

**典型示例**（ClipboardManager）：

```typescript
/**
 * 剪贴板保护面板管理器
 *
 * C-5-2：从 UIManager 拆分（约 61 行），统一管理"剪贴板三重保护"的 UI 联动。
 *
 * 职责：
 * - 被动检测到剪贴板变化时，显示带"分析"按钮的 Toast
 * - 内容通过敏感检测后，弹出确认对话框供用户预览
 *
 * 设计原则：
 * - 依赖注入：通过构造函数接收 ToastManager / ModalManager 引用
 * - 无事件监听器，无需 EventTracker
 */
// ↑ 文件级注释：说明"这是什么模块、从哪来、设计原则"

/**
 * 剪贴板保护面板管理器类
 *
 * 职责：被动检测剪贴板变化 → 用户确认 → 存为记忆
 * 依赖：ToastManager（显示提示）、ModalManager（确认对话框）
 * 生命周期：无事件监听器，cleanup() 为空实现
 */
export class ClipboardManager { ... }
// ↑ 类级注释：说明"这个类的运行时行为、依赖、生命周期"
```

**判定原则**：

| 是否文件级 | 是否类级 | 适用场景 |
|------------|----------|----------|
| ✅ | ✅ | 单文件单类的标准结构（推荐） |
| ✅ | ❌ | 单文件多函数/常量的工具模块（如 constants.ts） |
| ❌ | ✅ | 文件中仅 1 个类，类注释已涵盖文件级信息（不推荐，建议补文件级） |
| ❌ | ❌ | 禁止——文件必须有至少一级注释说明 |

**禁止**：文件级和类级注释复制粘贴相同内容。若两者内容高度重叠，保留文件级注释（含来源/设计原则），类级注释改为聚焦"运行时行为"。

#### 4.2.3 PanelManager 必含的注释要素

每个 PanelManager 文件必须包含以下注释要素（与 [ADR-SP-015](./decisions/ADR-SP-015-panel-manager-composition.md) 一致）：

- **文件级**：① 模块职责 ② 拆分来源（如 C-5-x） ③ 设计原则（依赖注入模式）
- **类级**：① 类的职责概述 ② 依赖（如 ToastManager / ModalManager / EventTracker） ③ 生命周期说明（init/cleanup 行为）
- **字段级**：每个 `private` 字段必须有单行 `/** ... */` 说明用途
- **方法级**：公共方法必须含 `@param` / `@returns`，私有方法可简化但需说明意图

## 5. 命名规范（与内核一致）

| 类型 | 规则 |
|------|------|
| 文件夹 | 连字符 |
| TS 文件 | 小驼峰 |
| 类 | 大驼峰 |
| 变量/函数 | 小驼峰 |
| 常量 | 全大写下划线 |
| 类型/接口 | 大驼峰 |

## 6. 不做清单

1. 不做多用户——单精灵单用户，与 memora 单 Agent 模型一致
2. 不做云端同步——纯本地，隐私优先，数据不出本机
3. 不做语音交互——阶段一只做文本交互
4. 不做插件市场——技能通过 configManager.addSkill 本地添加
5. 不做移动端——专注桌面场景
6. 不做被动内容监听——永远不做 keylogger、屏幕截图、网络流量监听（ADR-SP-004）
   - 剪贴板感知不属于"被动内容监听"，而是"用户主动触发的上下文感知"：
     采用三重保护方案（被动检测变化 + 主动触发读取 + 用户确认写入），
     仅在用户主动操作（复制/粘贴）时触发，且写入需用户显式确认。

## 7. 阶段规划

| 阶段 | 目标 | 交付物 |
|------|------|--------|
| 一 | CLI 宿主验证跑通 | SqliteStorage + SqliteSessionStore + CLI 交互 + 热键唤醒 |
| 二 | 桌面存在感 | Electron 窗口 + 系统托盘 + 通知 + 文件监听 + 窗口感知 |
| 三 | 多模态 | 语音输入/输出 + 高级 UI |
| 四 | 能力扩展 | 工具化（registerTool）+ 事件补全 + 后台 Provider + 写入确认 |

## 8. 阶段四：能力扩展（迭代 7-9 沉淀）

> **自然生长原则**：只接入"内核已就绪但宿主未消费"的能力，不闭门造接口。
> **触发条件**：审核报告（`docs/memora-sprite-交叉对齐审核报告.md`）识别出"机制已建、宿主未用"。

### 7.1 工具注册（`agent.tools.registerTool`）

**沉淀时机**：迭代 9 出现 1 次工具注册（web_search + memory_search）。  
**抽取阈值**：第 3 次出现时提取通用 helper（当前不抽取，避免过度抽象）。

**当前实现**（[hosts/memora-sprite/src/sprite/tools.ts](../../hosts/memora-sprite/src/sprite/tools.ts)）：

- 工具定义 + handler 同文件聚合，`index.ts` 一次性注册
- 跨平台 `execFile` 替代 `exec`（命令注入防护，迁移自 `/web` CLI）
- handler 委托内核能力（memorySearch 委托 `agent.searchMemories`），避免重复实现

**未来扩展点**：

- 当工具数 ≥ 3 时，提取 `registerDefaultTools(agent)` helper
- 当 ≥ 5 时，提取工具配置 schema + 启用/禁用开关

### 7.2 事件订阅（L5 补全）

**沉淀时机**：迭代 9 补齐 4 种未订阅事件（projectSwitched / skillMatched / memoryRecalled / decayCompleted）。  
**设计原则**：

- 静默模式过滤：项目切换/技能匹配/记忆召回在静默模式下不弹 toast
- 24h 节流：衰减完成通知（每小时触发，节流到 24h 一次）
- 分数阈值：技能匹配 score < 0.5 不通知
- 0 条跳过：decayedCount=0 / count=0 不通知

**实现位置**（[hosts/memora-sprite/src/electron/renderer/ipcListeners.ts](../../hosts/memora-sprite/src/electron/renderer/ipcListeners.ts)）：

- 4 个 handler 集中定义在文件顶部
- `onSpriteEvent` 统一入口 + type 分发（避免重复监听器）

### 7.3 多 Provider 路由

**沉淀时机**：迭代 7-8 引入后台 Provider（`agent.setBackgroundProvider`）。  
**配置入口**：`ConfigSchema.llm.background`（独立块，温度 0.5 默认）。  
**路由策略**：`ChatOptions.channel: 'chat' | 'background'`。

### 7.4 写入确认闭环

**沉淀时机**：迭代 8 完成写入确认 UI（M1）。  
**数据流**：

```
SecurityGuard.requestWriteConfirmation
  → IPC WRITE_CONFIRMATION 推送到渲染进程
  → 用户决策
  → IPC WRITE_CONFIRMATION_RESPONSE 回传
  → resolve pending Promise
```

**超时保护**：30s 未响应自动拒绝（主进程 Map + setTimeout）。
