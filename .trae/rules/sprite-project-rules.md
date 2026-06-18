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
