---
alwaysApply: false
description: "memora-sprite 宿主项目总则、技术栈清单、目录结构、与内核的关系"
version: v1.0
date: 2026-07-13
---

# memora-sprite · 宿主项目总则

> **设计哲学**：上下文感知，非内容感知 **核心矛盾**：被动响应 ←→ 主动进化
> **定位**：memora 内核的第一个真实宿主——能自我进化的桌面精灵
> **决策追溯**：`.trae/rules/decisions/` 下 ADR-SP-001~008 + ADR-SP-015~016

## 1. 与 memora 内核的关系

| 维度 | 内核 | 精灵 |
|------|------|------|
| 依赖方向 | 被依赖（纯逻辑库） | 依赖方（宿主） |
| native 模块 | 零（ADR-002） | better-sqlite3（ADR-SP-002） |
| 接口实现 | 定义接口 | 实现接口（IMemoryStorage / ISessionStore） |
| 规则关系 | 内核规则精灵必须遵守 | 精灵规则仅约束精灵代码 |
| ADR 前缀 | ADR-001~018（跳过 005） | ADR-SP-001~008 + ADR-SP-015~016 |

**内核 ADR 精灵必须遵守，精灵 ADR 内核不需要知道。**

### 1.1 文档分工（双 .trae / 双 tasks）

| 位置 | 用途 |
|------|------|
| `memora/.trae/rules/` | **规则中枢**：9 个规则文件 + 27 个 ADR（内核 17 + 精灵 10） |
| `hosts/memora-sprite/.trae/rules/` | **宿主实现文档**：仅 [directory-structure.md](../../hosts/memora-sprite/.trae/rules/directory-structure.md)（描述 src/ 目录树） |
| `memora/tasks/` | **内核任务**：内核健康度快照 + 待完成/已完成 |
| `hosts/memora-sprite/tasks/` | **宿主任务**：宿主健康度快照 + 待完成/已完成 + 方案文档 |

> 决策在外层（ADR 集中原则），实现文档跟宿主项目走（monorepo 最佳实践）。任务 ID 命名空间不同（内核用 V-xxx/P-xxx，宿主用 SEC-P2-xx/UX-xx/QC-xx），不合并。

## 2. 内核更新工作流（file: 协议本地链接）

> 精灵通过 `file:../..` 协议直接引用本地仓库根的 memora 内核（npm 包形式，非 workspace）。  
> 源码中 import 保持 `from 'memora'`，npm install 时自动建立 `node_modules/memora` → 仓库根的 Junction（Windows）或 symlink（Unix）。

### 2.1 日常开发工作流（推荐）

不修改内核时无需任何额外操作，sprite 的 `node_modules/memora` 通过 Junction 直接指向仓库根，dist 保持上一次编译的状态。

**修改了内核源码后**，执行一次同步：

```bash
# 在 hosts/memora-sprite/ 目录
npm run sync-memora   # 编译内核 src/ → dist/ + 同步到 node_modules
```

`sync-memora` 脚本（`scripts/sync-memora.mjs`）自动检测安装模式：
- **Junction 模式**（npm on Windows 默认）：`node_modules/memora` 是符号链接指向仓库根，编译后 dist 自动生效，无需复制
- **复制模式**（其他平台或 `--force` 安装）：`node_modules/memora` 是独立目录，需将 dist 从仓库根复制到 `node_modules/memora/dist`

> **效率原则**：不修改内核时零开销；修改内核后只需一次 `npm run sync-memora`（编译 + 同步，几秒）。

### 2.2 打包工作流

打包脚本（`scripts/package.mjs`）在执行 electron-builder 前自动调用 `sync-memora`，确保打包用的是最新内核：

```bash
# 在 hosts/memora-sprite/ 目录
npm run package:win   # 自动：sync-memora → build:electron → clean-release → electron-builder → verify
```

> **注意**：`file:` 依赖被 electron-builder 打入 asar 时，会解引用 Junction/symlink，复制实际文件到 `node_modules/memora/dist/`。`verify-package.mjs` 检查 `node_modules/memora/dist/index.js` 仍然有效。

### 2.3 恢复 npm 发布模式（未来如需）

若未来需要恢复 npm 发布模式：

```bash
# 1. 修改 package.json：将 "memora": "file:../.." 改回 "memora": "npm:@zooique/memora@^1.0.1"
# 2. 删除 node_modules/memora（Junction）+ package-lock.json
# 3. npm install 恢复 npm alias 模式
```

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

> 详见 [ADR-SP-007](./decisions/ADR-SP-007-directory-structure.md) 和 [directory-structure.md](../../hosts/memora-sprite/.trae/rules/directory-structure.md)（真理源，随迭代同步）

### 4.1 渲染进程分层约束（C-8 确立）

> **原则**：控制器不直接操作 DOM，通过 UIManager 门面委托。

| 层 | 职责 | 禁止 |
|----|------|------|
| `controllers/` | 业务编排（IPC 调用 + 回调注册 + 状态决策） | 直接访问 `document.getElementById` / `querySelector` / `classList` 等 DOM API |
| `panels/` | DOM 绑定 + 渲染逻辑（事件监听 + 元素操作） | 跨面板业务编排（应由 controllers/ 协调） |
| `components/` | 可复用 UI 组件（Toast / Modal / Theme 等 leaf 组件） | 直接依赖 panels/ 或 controllers/ |
| `ui.ts` | UIManager 门面（组合持有所有子模块 + 薄委托方法） | 内联复杂 DOM 渲染逻辑（应拆分到 panels/） |

**执行方式**：controllers/ 需要访问 DOM 时，通过 UIManager 提供的门面方法（如 `getMemorySearchParams()` / `triggerMemorySearchInput()` / `setMemoryListState()`），由 UIManager 内部委托到对应 PanelManager。

#### 4.1.1 Panel Manager IPC 调用边界（F-P0 评估沉淀）

> **背景**：F-P0 审计发现 `panels/` 中 34 处 `window.electronAPI.*` 直调，经评估 23 处合理、11 处需处理。此条款明确判断标准，避免"所有 IPC 必须经 Controller"的过度约束。

**核心判断标准**：IPC 调用的归属取决于"是否涉及跨模块业务编排"，而非"是否调用 IPC"。`controllers/` 自身也直接调 IPC（如 `settingsController` 调 `updateConfigBatch`），分层边界是"业务编排职责"而非"IPC 调用权限"。

| 类别 | 特征 | 归属 | 示例 |
|------|------|------|------|
| 合理 UI 联动 | 纯 UI 操作或单一功能专项触发，无跨模块编排 | `panels/` 直调 | 窗口控制（minimize/maximize/close）、命令面板快捷 toggle、拖放安装、剪贴板分析、会话消息搜索 |
| UI 耦合型业务逻辑 | 高度耦合表单校验/按钮状态/toast 反馈，分离会导致 Controller 反向访问 PanelManager 内部状态 | `panels/` 直调 + `host` 回调注入跨模块关注点 | LLM Provider CRUD（save/test/delete/setActive，表单校验 + 按钮禁用 + toast 反馈耦合） |
| 跨模块业务编排 | 涉及多面板协调或复杂状态决策 | `controllers/` 委托 | 批量配置保存（`updateConfigBatch`）、归档模式即时切换、会话加载/分页/分叉、角色切换持久化 |

**关键约束**：

- `panels/` 中的 IPC 调用必须通过 `host` 回调注入 `showToast` / `showConfirmDialog` 等跨模块关注点，不直接访问 UIManager 内部
- `controllers/` 中的 IPC 调用后，通过 UIManager 门面方法通知 PanelManager 刷新 DOM
- 加载操作（如 `listLlmProviders` / `listWorkProjections` / `listAuditLog`）允许在 `panels/` 中直调，因为 PanelManager 是渲染数据源的消费者

**F-P0 评估结论**（2026-07-10）：

| 违规项 | 位置 | 处理方式 |
|--------|------|----------|
| Provider CRUD 7 处 | `settingsPanelManager.ts` | 归类为"UI 耦合型业务逻辑"，允许直调（已通过 `host` 回调注入 toast/confirm） |
| 画像 confirm/reject 3 处 | `profilePanelManager.ts` | 技术债：应委托 `settingsController`（加载已委托，写操作未委托，模式不一致） |
| 审计日志清空 1 处 | `auditPanelManager.ts` | 技术债：应委托 `settingsController`（同上模式不一致） |
| 窗口控制 4 处 | `panelRouter.ts` | 归类为"合理 UI 联动"，允许直调 |
| 命令面板 6 处 | `commandPaletteManager.ts` | 归类为"合理 UI 联动"（快捷启动器定位） |
| 输入区 Provider 选择 5 处 | `inputAreaManager.ts` | 归类为"合理 UI 联动"（独立 UI 表面的快捷操作） |
| 其他 7 处 | skillDrop/clipboard/searchMessages 等 | 归类为"合理 UI 联动"（单一功能专项触发） |

> 技术债（画像 3 处 + 审计 1 处）触发时机：profile/audit 模块下次有功能需求时顺带偿还。

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

## 5. 命名规范

命名规范与内核一致（详见 [project-rules.md §4](./project-rules.md)）。

### 4.3 Web 调试通道（Phase 4 交付）

> **定位**：精灵的平行部署模式——与 Electron 共享同一内核，通过原生 HTTP 提供 REST API + 静态前端。
> **设计原则**：零框架依赖（仅 `node:http`），安全隔离（127.0.0.1 绑定 + 路径穿越防护 + Security Headers）。

| 维度 | 说明 |
|------|------|
| 入口 | `npm run start:web` / `npm run dev:web`（tsx watch） |
| 服务端 | `server.ts`，原生 `http.createServer`，三阶段优雅关闭 |
| 路由 | 7 个 REST 路由文件（chat/config/memory/session/system + types + index） |
| 安全 | 路径穿越防护 + CSP/X-Content-Type-Options 等 Headers + 127.0.0.1 隔离 |
| 测试 | 6 个路由测试文件（chatStream/config/memory/session/system + types），全量通过 |
| 与 Electron 关系 | 平行模式，共享 `sprite/` 核心层和 `storage/` 持久化层，不共享 `electron/` 进程管理 |

> **历史**：web/ 最初作为"临时开发辅助"创建，经 2026-07-05 根须审查正式接纳为 Phase 4 交付物。

## 6. 不做清单

1. 不做多用户——单精灵单用户，与 memora 单 Agent 模型一致
2. 不做云端同步——纯本地，隐私优先，数据不出本机
3. 不做语音交互——阶段一只做文本交互
4. 不做插件市场——技能通过 configManager.addSkill 本地添加
5. 不做移动端——专注桌面场景
6. 不做被动内容监听——永远不做 keylogger、屏幕截图、网络流量监听（ADR-SP-004）
7. 不做手动会话管理——精灵自动按天归档会话，用户通过日期导航回溯历史，不暴露"空白新建会话"等手动管理入口（内核 forkSession API 保留，仅后端可用）
   - **例外**：允许"分叉当前会话"作为唯一的新会话入口——基于当前对话上下文分叉出独立分支（保留全部历史消息 + 工作记忆连续性），而非空白创建。分叉入口通过 `btn-fork-session` UI 按钮暴露，由 `sessionController.forkSession()` 编排。
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

> **自然生长原则**（[ADR-017](./decisions/ADR-017-natural-growth-redefinition.md) 分层适用）：架构层（根须）先行——新能力接入前先评估架构归属；枝叶层（helper/组件）遵循 2 次提取原则。本节"只接入内核已就绪的能力"是架构层原则的体现——不闭门造接口。
> **触发条件**：审核报告（`docs/memora-sprite-交叉对齐审核报告.md`）识别出"机制已建、宿主未用"。

### 7.1 工具注册（`agent.tools.registerTool`）

**沉淀时机**：迭代 9 出现 1 次工具注册（web_search + memory_search）。  
**抽取阈值**：第 2 次出现时提取通用 helper（枝叶层 2 次提取原则，详见 [ADR-017](./decisions/ADR-017-natural-growth-redefinition.md)）。

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
**路由策略**：`AgentOptions.backgroundProvider` 注入独立 LlmProvider 实例，workProjection / autoConfigRefiner 直接调用 `backgroundProvider.chat()`，不通过 `ChatOptions` 字段路由。

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

## 9. 感知层规范（上下文感知而非内容感知）

> **核心原则**：精灵知道你在做什么，不知道你在打什么。
> **决策追溯**：ADR-SP-004

### 9.1 感知层级

| 层级 | 能力 | 阶段 | 示例 |
|------|------|------|------|
| L1 热键 | 用户主动召唤 | 一 | Ctrl+Shift+Space |
| L2 定时 | 周期性检查触发条件 | 一 | 每分钟检查 insight/profile |
| L3 文件变化 | 监听项目文件修改 | 二 | chokidar on change |
| L4 窗口上下文 | 获取活跃窗口标题/进程名 | 二 | active-win |
| L5 日程模式 | 基于时间的主动问候 | 二 | 每日早安/工作日提醒 |

### 9.2 永远禁止的感知方式

| 禁止方式 | 原因 |
|---------|------|
| 全局键盘钩子（iohook 等） | 本质是 keylogger |
| 屏幕截图/OCR | 视觉内容可能包含隐私 |
| 网络流量监听 | 超出本机边界 |
| 任意输入框内容读取 | 侵犯用户隐私 |

**剪贴板感知的例外（三重保护）**：只检测变化不读内容 → 用户点击后才读取 → 敏感内容过滤 → 用户确认写入。

### 9.3 唤醒触发器设计约束

- 触发器回调只传递信号，不传递内容
- 所有触发器必须实现 `stop()`，精灵休眠时停止监听
- 触发器不可用时不阻断精灵运行

**主动唤醒必须同时满足**：① 至少一个触发器发出信号 ② 距上次主动对话 ≥ 30 分钟 ③ 有实质内容可分享。

### 9.4 上下文感知的数据边界

| 可以感知 | 不可以感知 |
|---------|----------|
| 活跃窗口的标题 | 窗口内的文字内容 |
| 活跃窗口的进程名 | 进程内的用户输入 |
| 文件是否被修改 | 文件被修改的具体内容 |
| 用户是否在线（有交互） | 用户具体在做什么操作 |
| 当前时间/日程 | 用户的浏览器历史 |

**文件内容感知的例外**：精灵通过 memora 的 work-projection 机制感知文件——Agent 读取文件时生成摘要（source:work-projection），这是用户主动触发的，不是后台监听。
