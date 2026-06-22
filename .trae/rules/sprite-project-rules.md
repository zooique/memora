---
alwaysApply: false
description: "memora-sprite 宿主项目总则、技术栈清单、目录结构、与内核的关系"
---

# memora-sprite · 宿主项目总则

> **设计哲学**：上下文感知，非内容感知 **核心矛盾**：被动响应 ←→ 主动进化
> **定位**：memora 内核的第一个真实宿主——能自我进化的桌面精灵
> **决策追溯**：`.trae/rules/decisions/` 下 ADR-SP-001~007

## 1. 与 memora 内核的关系

| 维度 | 内核 | 精灵 |
|------|------|------|
| 依赖方向 | 被依赖（纯逻辑库） | 依赖方（宿主） |
| native 模块 | 零（ADR-002） | better-sqlite3（ADR-SP-002） |
| 接口实现 | 定义接口 | 实现接口（IMemoryStorage / ISessionStore） |
| 规则关系 | 内核规则精灵必须遵守 | 精灵规则仅约束精灵代码 |
| ADR 前缀 | ADR-001~013 | ADR-SP-001~007 |

**内核 ADR 精灵必须遵守，精灵 ADR 内核不需要知道。**

## 2. 技术栈清单

| 类别 | 选型 | 决策 |
|------|------|------|
| 运行时 | Node.js 24 LTS + TypeScript 5 strict + ESM | ADR-SP-001 |
| 数据库 | better-sqlite3（native 模块，^12.10.0） | ADR-SP-002 |
| 桌面壳 | 阶段一 CLI → 阶段二 Electron 40 | ADR-SP-003 |
| 感知层 | 上下文感知，非内容感知 | ADR-SP-004 |
| 包管理 | npm + file: 协议 + @electron/rebuild | ADR-SP-005 |
| 测试 | Vitest + InMemoryStorage + 临时 SQLite | ADR-SP-006 |

## 3. 目录结构

> 详见 [ADR-SP-007](./decisions/ADR-SP-007-directory-structure.md)

```
hosts/memora-sprite/
├── package.json              ← 独立依赖（memora + better-sqlite3 + electron）
├── tsconfig.json / tsconfig.electron.json
├── vitest.config.ts
└── src/
    ├── index.ts              ← 入口：Agent 实例化 + 生命周期
    ├── storage/              ← IMemoryStorage / ISessionStore 实现
    │   ├── sqliteStorage.ts
    │   └── sessionStore.ts
    ├── sprite/               ← 精灵主控 + 触发器 + 控制器
    │   ├── sprite.ts
    │   ├── spriteConfig.ts
    │   ├── triggers.ts
    │   ├── fileWatcherTrigger.ts
    │   ├── interaction.ts / cliInteraction.ts
    │   └── controllers/      ← 专职控制器（阶段二新增）
    │       ├── memoryController.ts
    │       ├── personaController.ts
    │       └── proactiveEngine.ts
    ├── electron/             ← Electron 主进程 + 渲染进程（阶段二新增）
    │   ├── main.ts / preload.ts
    │   ├── windowManager.ts / windowState.ts / floatWindow.ts
    │   ├── trayIcon.ts / ipcHandlers.ts
    │   ├── interaction.ts / errorHandler.ts
    │   └── renderer/         ← index.html / float.html / renderer.ts / ui.ts / renderer.css
    └── __tests__/
        ├── sqliteStorage.test.ts
        ├── sessionStore.test.ts
        ├── sprite.test.ts
        └── sprite-integration.test.ts
```

## 4. 命名规范（与内核一致）

| 类型 | 规则 |
|------|------|
| 文件夹 | 连字符 |
| TS 文件 | 小驼峰 |
| 类 | 大驼峰 |
| 变量/函数 | 小驼峰 |
| 常量 | 全大写下划线 |
| 类型/接口 | 大驼峰 |

## 5. 不做清单

1. 不做多用户——单精灵单用户，与 memora 单 Agent 模型一致
2. 不做云端同步——纯本地，隐私优先，数据不出本机
3. 不做语音交互——阶段一只做文本交互
4. 不做插件市场——技能通过 configManager.addSkill 本地添加
5. 不做移动端——专注桌面场景
6. 不做内容感知——永远不做 keylogger、剪贴板监听、屏幕截图（ADR-SP-004）

## 6. 阶段规划

| 阶段 | 目标 | 交付物 |
|------|------|--------|
| 一 | CLI 宿主验证跑通 | SqliteStorage + SqliteSessionStore + CLI 交互 + 热键唤醒 |
| 二 | 桌面存在感 | Electron 窗口 + 系统托盘 + 通知 + 文件监听 + 窗口感知 |
| 三 | 多模态 | 语音输入/输出 + 高级 UI |
| 四 | 能力扩展 | 工具化（registerTool）+ 事件补全 + 后台 Provider + 写入确认 |

## 7. 阶段四：能力扩展（迭代 7-9 沉淀）

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
