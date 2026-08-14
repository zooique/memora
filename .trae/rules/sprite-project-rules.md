---
alwaysApply: false
description: "memora-sprite 宿主项目总则、技术栈清单、目录结构、与内核的关系"
---

# memora-sprite · 宿主项目总则

> **设计哲学**：上下文感知，非内容感知 **核心矛盾**：被动响应 ←→ 主动进化
> **定位**：memora 内核的早期桌面精灵宿主——**已搁置**（当前第一宿主为 [vscode-plugin](../../hosts/vscode-plugin/)，本规则保留供搁置前实现参考，不继续演进）
> **决策追溯**：`.trae/decisions/` 下 ADR-SP-001~008 + ADR-SP-015~018
>
> **重构哲学**：底层设计优秀才能自然生长——不畏惧对底层架构动手术（功能定版后不盲目新增模块，但持续打磨架构与代码质量）。

## 1. 与 memora 内核的关系

| 维度 | 内核 | 精灵 |
|------|------|------|
| 依赖方向 | 被依赖（纯逻辑库） | 依赖方（宿主） |
| native 模块 | 零（ADR-002） | better-sqlite3（ADR-SP-002） |
| 接口实现 | 定义接口 | 实现接口（IMemoryStorage / ISessionStore） |
| 规则关系 | 内核规则精灵必须遵守 | 精灵规则仅约束精灵代码 |
| ADR 前缀 | ADR-001~019（跳过 005） | ADR-SP-001~008 + ADR-SP-015~018 |

**内核 ADR 精灵必须遵守，精灵 ADR 内核不需要知道。**

### 1.1 文档分工（双 .trae / 双 tasks）

| 位置 | 用途 |
|------|------|
| `memora/.trae/rules/` | **规则中枢**：12 个规则文件 + 30 个 ADR（内核 18 + 精灵 12） |
| `hosts/memora-sprite/.trae/rules/` | **宿主实现文档**：仅 [directory-structure.md](../../hosts/memora-sprite/.trae/rules/directory-structure.md)（描述 src/ 目录树） |
| `memora/tasks/` | **统一任务追踪**（唯一真理源）：内核 + 精灵健康度快照 + 待完成/已完成 + 打包前审查 + 归档 |

> 决策在外层（ADR 集中原则），实现文档跟宿主项目走（monorepo 最佳实践）。任务追踪统一在根 `tasks/`（精灵历史任务已归档至 `tasks/归档/sprite-*`，精灵健康度快照在 `tasks/精灵健康度快照/`）。

## 2. 内核同步工作流（sync-memora 脚本）

> 精灵不通过 npm `file:` 依赖内核（避免 Junction 将全量仓库打入 asar）。
> `sync-memora.mjs` 负责：编译内核 → 创建最小化 `node_modules/memora/`（仅 dist + 元数据）。
> 源码中 import 保持 `from 'memora'`，TypeScript 通过 `node_modules/memora/dist` 解析。

### 2.1 开发工作流

`build:electron` 自动调用 `sync-memora`，开发者无需手动操作：

```bash
# 在 hosts/memora-sprite/ 目录
npm run build:electron   # 自动：sync-memora → check-ipc → generate-icons → tsc → ...
npm run start:electron   # 自动：build:electron → electron
```

仅修改内核源码时，可手动执行同步（避免完整 rebuild）：

```bash
npm run sync-memora   # 编译内核 src/ → dist/ + 同步到 node_modules/memora/
```

> **效率原则**：不修改内核时，`sync-memora` 检测 dist 已存在会跳过编译（--no-build 模式）。

### 2.2 打包工作流

打包脚本（`scripts/package.mjs`）在执行 electron-builder 前自动调用 `sync-memora`，确保 asar 内仅含最小化内核：

```bash
# 在 hosts/memora-sprite/ 目录
npm run package:win   # 自动：build:electron（含 sync-memora） → clean-release → electron-builder → verify
```

`sync-memora` 创建的 `node_modules/memora/` 仅含运行时文件（dist + package.json），
不含 src/、tasks/、hosts/、.trae/ 等开发文件，确保 electron-builder 不会将全量仓库打入 asar。

## 3. 技术栈清单

| 类别 | 选型 | 决策 |
|------|------|------|
| 运行时 | Node.js 24 LTS + TypeScript 5 strict + ESM | ADR-SP-001 |
| 数据库 | better-sqlite3（native 模块，^12.10.0） | ADR-SP-002 |
| 桌面壳 | CLI 起步，演进至 Electron 40 | ADR-SP-003 |
| 感知层 | 上下文感知，非内容感知 | ADR-SP-004 |
| 包管理 | npm + `sync-memora.mjs`（编译 → 最小化复制） + @electron/rebuild | [ADR-SP-005](../decisions/ADR-SP-005-package-management.md) v3 |
| 测试 | Vitest + InMemoryStorage + 临时 SQLite | ADR-SP-006 |

## 4. 目录结构

> 详见 [ADR-SP-007](../decisions/ADR-SP-007-directory-structure.md) 和 [directory-structure.md](../../hosts/memora-sprite/.trae/rules/directory-structure.md)（真理源，随迭代同步）

### 4.1 渲染进程分层约束（C-8 确立）

> **原则**：控制器不直接操作 DOM，通过 UIManager 门面委托。

| 层 | 职责 | 禁止 |
|----|------|------|
| `controllers/` | 业务编排（IPC 调用 + 回调注册 + 状态决策） | 直接访问 `document.getElementById` / `querySelector` / `classList` 等 DOM API |
| `panels/` | DOM 绑定 + 渲染逻辑（事件监听 + 元素操作） | 跨面板业务编排（应由 controllers/ 协调） |
| `components/` | 可复用 UI 组件（按 base/feedback/form/navigation/data 分层，见 [ui-engineering-mindset-rules.md §四.3](./ui-engineering-mindset-rules.md)） | 直接依赖 panels/ 或 controllers/（反向依赖） |
| `ui.ts` | UIManager 门面（组合持有所有子模块 + 薄委托方法） | 内联复杂 DOM 渲染逻辑（应拆分到 panels/） |

**依赖方向**：

> `panels/` → `components/` 是**合法正向依赖**（leaf 组件被 panels 消费），不算越权。
>
> - `components/` 定位为"可复用 UI 组件"，存在的意义就是被上层（panels/helpers）消费；组件内部分层（base/feedback/form/navigation/data）见 [ui-engineering-mindset-rules.md §四.3](./ui-engineering-mindset-rules.md)
> - 分层规则只禁止 `components/` **反向依赖** `panels/` 或 `controllers/`
> - 现有 10 处 `panels → components` 引用（renderMarkdown / ToastManager / ModalManager / RelationGraphRenderer 等）均为合理消费模式

**执行方式**：controllers/ 需要访问 DOM 时，通过 UIManager 提供的门面方法（如 `getMemorySearchParams()` / `triggerMemorySearchInput()` / `setMemoryListState()`），由 UIManager 内部委托到对应 PanelManager。

#### 4.1.1 Panel Manager IPC 调用边界

> **背景**：为避免"所有 IPC 必须经 Controller"的过度约束，明确 IPC 归属的判断标准——归属取决于业务编排职责，而非 IPC 调用本身。

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
 * 拆分来源：从 UIManager 拆分，统一管理"剪贴板三重保护"的 UI 联动。
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

每个 PanelManager 文件必须包含以下注释要素（与 [ADR-SP-015](../decisions/ADR-SP-015-panel-manager-composition.md) 一致）：

- **文件级**：① 模块职责 ② 拆分来源（如 C-5-x） ③ 设计原则（依赖注入模式）
- **类级**：① 类的职责概述 ② 依赖（如 ToastManager / ModalManager / EventTracker） ③ 生命周期说明（init/cleanup 行为）
- **字段级**：每个 `private` 字段必须有单行 `/** ... */` 说明用途
- **方法级**：公共方法必须含 `@param` / `@returns`，私有方法可简化但需说明意图

### 4.3 Web 调试通道

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

> **历史**：web/ 最初作为临时开发辅助创建，后正式接纳为与 Electron 平行的部署模式（共享内核，经原生 HTTP 提供 REST API + 静态前端）。

## 5. 命名规范

命名规范与内核一致（详见 [project-rules.md §4](./project-rules.md)）。

## 6. 不做清单

1. 不做多用户——单精灵单用户，与 memora 单 Agent 模型一致
2. 不做云端同步——纯本地，隐私优先，数据不出本机
3. 不做语音交互——当前范围只做文本交互
4. 不做插件市场——技能通过 configManager.addSkill 本地添加
5. 不做移动端——专注桌面场景
6. 不做被动内容监听——永远不做 keylogger、屏幕截图、网络流量监听（ADR-SP-004）
7. 不做手动会话管理——精灵自动按天归档会话，用户通过日期导航回溯历史，不暴露"空白新建会话"等手动管理入口（内核 forkSession API 保留，仅后端可用）
   - **例外**：允许"分叉当前会话"作为唯一的新会话入口——基于当前对话上下文分叉出独立分支（保留全部历史消息 + 工作记忆连续性），而非空白创建。分叉入口通过 `btn-fork-session` UI 按钮暴露，由 `sessionController.forkSession()` 编排。
   - 剪贴板感知不属于"被动内容监听"，而是"用户主动触发的上下文感知"：
     采用三重保护方案（被动检测变化 + 主动触发读取 + 用户确认写入），
     仅在用户主动操作（复制/粘贴）时触发，且写入需用户显式确认。

## 7. 能力扩展

> **自然生长原则**（[ADR-017](../decisions/ADR-017-natural-growth-redefinition.md) 分层适用）：架构层（根须）先行——新能力接入前先评估架构归属；枝叶层（helper/组件）中，**领域原语**（满足"领域动词 √ + 接口稳定 √ + 独立语义 √"三项判定标准）在设计期即提取，**技术性偶然相似**等 2+ 处重复再提取。本节"只接入内核已就绪的能力"是架构层原则的体现——不闭门造接口。
> **触发条件**：识别到"内核机制已建、宿主尚未接入"的能力缺口时，按架构层原则评估归属后接入，不闭门造接口。

### 7.1 工具注册（`agent.tools.registerTool`）

**抽取阈值**：领域原语 / 明确复用在**设计期即提取**通用 helper；出现 2+ 处重复作为"该抽却漏抽"的回溯补抽信号（ADR-017 Scenario A：新代码设计期抽取）。领域原语的判定标准（三项同时满足）详见 [coding-convention-rules.md §3 的 AI 编程范式补充](./coding-convention-rules.md)——领域动词测试 √ + 接口稳定性测试 √ + 独立语义测试 √。

**当前实现**（[hosts/memora-sprite/src/sprite/tools.ts](../../hosts/memora-sprite/src/sprite/tools.ts)）：

- 工具定义 + handler 同文件聚合，`index.ts` 一次性注册
- 跨平台 `execFile` 替代 `exec`（命令注入防护，迁移自 `/web` CLI）
- handler 委托内核能力（memorySearch 委托 `agent.searchMemories`），避免重复实现

**未来扩展点**：

- 当工具数 ≥ 3 时，提取 `registerDefaultTools(agent)` helper
- 当 ≥ 5 时，提取工具配置 schema + 启用/禁用开关

### 7.2 事件订阅（L5 补全）

**设计原则**：

- 静默模式过滤：项目切换/技能匹配/记忆召回在静默模式下不弹 toast
- 24h 节流：衰减完成通知（每小时触发，节流到 24h 一次）
- 分数阈值：技能匹配 score < 0.5 不通知
- 0 条跳过：decayedCount=0 / count=0 不通知

**实现位置**（[hosts/memora-sprite/src/electron/renderer/ipcListeners.ts](../../hosts/memora-sprite/src/electron/renderer/ipcListeners.ts)）：

- 4 个 handler 集中定义在文件顶部
- `onSpriteEvent` 统一入口 + type 分发（避免重复监听器）

### 7.3 多 Provider 路由

**配置入口**：`ConfigSchema.llm.background`（独立块，温度 0.5 默认）。  
**路由策略**：`AgentOptions.backgroundProvider` 注入独立 LlmProvider 实例，workProjection / autoConfigRefiner 直接调用 `backgroundProvider.chat()`，不通过 `ChatOptions` 字段路由。

### 7.4 写入确认闭环

**数据流**：

```
SecurityGuard.requestWriteConfirmation
  → IPC WRITE_CONFIRMATION 推送到渲染进程
  → 用户决策
  → IPC WRITE_CONFIRMATION_RESPONSE 回传
  → resolve pending Promise
```

**超时保护**：30s 未响应自动拒绝（主进程 Map + setTimeout）。

## 8. 会话资源层与运行状态模型（用户设计定案 2026-08-10）

> **核心原则**：记忆与上下文是**静态常驻的资源**（SSOT），会话的「空闲 / 运行」是叠加其上的**动态状态**。资源永远在，状态只在需要时挂载、完成后卸载。

### 8.1 两层模型

| 层 | 定位 | 内容 | 生命周期 |
|----|------|------|---------|
| **资源层** | 静态常驻（SSOT 单一真源） | 记忆（Memory）、上下文（Context）、消息历史 | 始终存在，不随状态切换创建或销毁 |
| **状态层** | 动态挂载 | 空闲（idle） / 运行（running） / 暂停（paused） / 异常（error） | 互斥切换：idle ↔ running 双向、running → paused/error |

**核心认知**：资源是「物」，状态是「挂载」。资源始终在那里（符合资源的定位——常驻、不消失）；状态只是「当前是否有任务挂在资源上」。

### 8.2 状态切换语义 = 挂载 / 卸载

| 切换 | 语义 | 动作 |
|------|------|------|
| **空闲 → 运行** | 挂载（mount） | 用户输入激活，**创建本轮任务状态**：任务表 plan、checkpoint、暂停申请等全部挂载上来 |
| **运行 → 空闲** | 卸载（unmount） | 任务完成或用户直接停止，**清空本轮运行挂载的所有任务内容**（plan、checkpoint、暂停态、任务表），只把运行过程中产生的上下文和记忆**沉淀**回资源层 |

### 8.3 归属判定（判断某份数据属于哪一层）

| 数据 | 层 | 理由 |
|------|----|------|
| 记忆（Memory）、上下文、消息历史 | 资源层 | 静态常驻，跨会话持续存在 |
| plan（任务表）、checkpoint、暂停申请/暂停态 | 状态层（挂载物） | 由「运行」创建，随「回到空闲」清空 |

**判定标准**：数据是否会因「会话回到空闲」而消失？会 → 状态层挂载物（应被卸载）；不会 → 资源层（应常驻）。

### 8.4 与现有交互规范的对应

- 输入框 / 任务清单的「运行中」「空闲」判断，本质就是状态层的 idle/running 判断（详见 §11）。
- 渲染层 `sessionStatus` 初始 `'idle'` 即资源层常态——无任务挂载，面板不应显示任务表或暂停按钮（实测纠偏 2026-08-10：重启后显示"正在生成任务表…"+ 暂停按钮即违反本模型，已修复）。
- **沉淀动作的落点**：运行 → 空闲时，任务产物（记忆/上下文）写入资源层（记忆存储 / 会话归档），挂载物（plan/checkpoint）由状态层清理，两者不可混用。

### 8.5 idle 只存在于宿主：卸载责任的分界

**核心事实**：内核 `SessionStateMachine` 只有 `running / paused / error` **三态，没有 idle**。「空闲」是宿主渲染层的概念——没有活跃任务挂载时的呈现状态，内核不建模、也观察不到。

**推论：内核不存在「运行 → 空闲」这个状态转换，因而不可能在内核内部触发卸载。**

| 职责 | 归属 | 落点 |
|------|------|------|
| 判定「任务流结束、回到空闲」 | **宿主** | `chatStreamHandler.ts` 在广播 `idle` 前调用 `agent.clearPlan()` |
| 提供卸载能力 | 内核 | `Agent.clearPlan()` → `SessionManager.clearPlan()`（清 plan + roundLog 并落盘） |
| 跨会话残留兜底 | 内核 | `SessionManager.switchSession()`：`flushCheckpoint(true)` + `checkpoint = null`，新会话 `createCheckpoint` 时 `plan` 必为 `[]` |
| 暂停态挂载物卸载 | 内核 | `SessionManager.resume()` → `setPauseMeta(undefined)`（唯一写入口，含落盘） |

**对非 Electron 宿主（CLI / 第三方集成）的约束**：若自行驱动 `Agent.chat()`，**必须**在任务流以非 paused 状态结束、界面回到空闲前调用 `agent.clearPlan()`；否则下一轮会看到上一轮的残留任务表。内核只保证跨**会话**干净（`switchSession`），不保证跨**轮次**干净。

## 9. 感知层规范（上下文感知而非内容感知）

> **核心原则**：精灵知道你在做什么，不知道你在打什么。
> **决策追溯**：ADR-SP-004

### 9.1 感知层级

| 层级 | 能力 | 状态 | 示例 |
|------|------|------|------|
| L1 热键 | 用户主动召唤 | 已实现 | Ctrl+Shift+Space |
| L2 定时 | 周期性检查触发条件 | 已实现 | 每分钟检查 insight/profile |

> 其余层级（文件变化 / 窗口上下文 / 日程模式）为演进方向，不冻结于本规范，避免迭代路线图腐化契约。

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

## 10. 快速输入浮窗模块（quick-input）

> **架构决策**：详见 [ADR-SP-017](../decisions/ADR-SP-017-quick-input-architecture.md)
> **窗口标题编码**：详见 [ADR-SP-018](../decisions/ADR-SP-018-cross-process-encoding.md)（nut-js GetWindowTextA 编码 bug 绕过：提取 HWND + PowerShell GetWindowTextW + 文件 I/O 传递）
> **定位**：用户主动召唤的轻量级输入浮窗，不属于 §9 感知层（感知层是精灵主动感知，quick-input 是用户主动触发）

### 10.1 模块架构

| 组件 | 文件 | 职责 |
|------|------|------|
| 窗口管理器 | `src/electron/windows/quickInputWindow.ts` | BrowserWindow 生命周期 + IPC 注册（内联模式）+ 剪贴板预填 + 粘贴协调 |
| 交互控制器 | `src/electron/renderer/quick-input/quickInput.ts`（QuickInputController） | 键盘事件 / 常驻模式 / 展开收起 / LLM 润色 / 拖动 / 确认流程 / 布局调整 |
| 补全逻辑 | `src/electron/renderer/quick-input/quickInputCompletion.ts`（QuickInputCompletion） | 防抖 / 并行搜索 / 合并去重 / 多样性过滤 / 采纳反馈 / ARIA |
| 浮窗样式 | `src/electron/renderer/styles/windows/quick-input.css` | 独立窗口样式（CSS-R6 后迁入 windows/，详见 [ADR-019](../decisions/ADR-019-css-functional-grouping.md)） |

### 10.2 IPC 通道管理（窗口管理器内联注册）

> **例外说明**：quick-input 的 IPC 通道在 `quickInputWindow.ts` 内注册，而非 `ipc/` 下的 handler 文件。判定标准详见 [ADR-SP-017 §1](../decisions/ADR-SP-017-quick-input-architecture.md#1-窗口管理器内联-ipc-模式)。完整通道清单见源码 `quickInputWindow.ts`，此处不重复冻结。

### 10.3 状态持久化策略

quick-input 状态分两类：跨会话持久状态（展开模式、常驻模式、最近提交历史、采纳反馈）通过 `localStorage` 存储；运行时状态（流式模式、拖动位置）单次会话有效。完整策略详见 [ADR-SP-017](../decisions/ADR-SP-017-quick-input-architecture.md)。

## 11. 对话输入框与任务清单交互规范（用户设计定案 2026-08-10）

> **核心原则**：输入框只负责发送/停止，任务清单负责暂停/继续/取消暂停。不把流程控制按钮混入输入区。

### 11.1 输入框区域（#btn-send）

**核心原则**：输入框只有一个按钮，两种互斥状态——空闲时发送/运行时停止。关键语义：

- **运行中有输入 → 发送 = 补充插入**：当前问答结束后，内核基于插入内容继续后续任务，不打断当前执行。
- **已暂停有输入 → 发送 = auto-resume + 携带内容继续**：内核 processEvent 对 PAUSED 会话自动恢复，携带新内容执行。
- **已暂停空输入 → 禁用**：纯恢复请用任务清单「继续」按钮，不在输入框承载此语义。
- **输入框严禁出现**：暂停、继续、取消暂停按钮。这些按钮统一在任务清单列表。

### 11.2 任务清单列表（taskTablePanelManager）

暂停/继续/取消暂停三态按钮放在任务清单列表，与输入框完全解耦。

**三态互斥逻辑**：无暂停态 + 无在途申请 → 显示「暂停」；点击后立即变为「取消暂停」；系统触发暂停后显示「继续」。

**关键规则**：
- 暂停是异步申请，点击后按钮立刻变为「取消暂停」，不等状态机翻转——给用户反悔窗口。
- 取消暂停只在申请未触发时有意义；已暂停态只有「继续」，无「取消暂停」。
- 暂停和继续互斥，不会同时出现。

### 11.3 数据流

```
用户点击「暂停」→ IPC SESSION_PAUSE → agent.requestPause()
  → WorkContext.pausePending = true（在途）
  → 按钮变为「取消暂停」

系统 loop 边界挂起 → WorkContext.pausePhase = 'suspended', pausePending = false
  → 按钮变为「继续」

用户点击「继续」→ IPC SESSION_RESUME → agent.resume()
  → 回到运行态

用户点击「取消暂停」→ IPC SESSION_CANCEL_PAUSE → agent.cancelPauseRequest()
  → pausePending = false，回到运行态
```

### 11.4 与输入框的联动

- 暂停态时，输入框 `updateSendButton()` **不应**显示 `#btn-stop`——`#btn-stop` 仅在流式生成中可见。
- 暂停态时，输入框发送按钮为「发送（恢复会话并继续）」，有输入启/空输入禁。
- 恢复运行后，输入框回到运行态（空输入=停止/有输入=发送补充插入）。
