# 方案：外壳打磨与 Electron 阶段二

> **创建**：2026-06-17
> **入口**：方案更新
> **依赖**：ADR-SP-003（桌面壳分阶段策略）、ADR-SP-007（目录结构）

## 一、背景

当前 sprite CLI 功能已完整（对话、记忆 CRUD、角色、配置、搜索），但存在两个阻碍实际使用的体验缺口：

1. **启动不便捷**：每次需输入 `npx tsx src/index.ts` 长命令
2. **对话不连续**：重启后丢失上下文，而 `restoreMostRecentSession()` 已实现却未被调用

ADR-SP-003 阶段一（CLI 验证核心机制）已完成，阶段二（Electron）的触发条件已满足。

## 二、目标

- E-1：全局命令一键启动
- E-4：启动时自动恢复上次会话
- 设计 Electron 阶段二架构（不实现，仅设计）

## 三、执行方案

### E-1：全局命令

**改动**：`hosts/memora-sprite/package.json` 添加 `bin` 字段

```json
{
  "bin": {
    "memora-sprite": "./dist/index.js"
  }
}
```

**配套**：
- `src/index.ts` 顶部添加 shebang `#!/usr/bin/env node`
- `npm run build` 后 `npm link` 即可全局使用
- `npm start` 保留（开发时用 tsx 热跑）

**约束**：
- 不引入 commander/yargs（CLI 路由已自建，自然生长原则）
- 不添加 `--help` flag（欢迎消息已列命令）

### E-4：对话历史持久化

**改动**：`hosts/memora-sprite/src/index.ts` 的 `startSprite()`

在 `agent.init()` 后、`sprite.start()` 前调用：

```typescript
await agent.init();

// 恢复上次会话（连续演化任务的核心体验）
const restored = await agent.restoreMostRecentSession('main');
if (restored > 0) {
  console.log(`已恢复上次会话（${restored} 条消息）`);
}

sprite.start();
```

**无新增代码**——`restoreMostRecentSession()` 和 `SqliteSessionStore` 已完整实现，只是未被调用。

**约束**：
- 不添加 `/resume` 命令（自动恢复已足够，自然生长原则）
- 不显示历史消息内容（只提示条数，避免刷屏）

### Electron 阶段二设计（不实现）

**目录结构**（ADR-SP-007 已预留）：

```
hosts/memora-sprite/
├── src/
│   ├── index.ts              ← CLI 入口（保留）
│   ├── storage/
│   ├── sprite/
│   └── __tests__/
├── electron/                 ← 阶段二新增
│   ├── main.ts               ← 主进程：窗口 + 托盘 + 生命周期
│   ├── preload.ts            ← 预加载：IPC 桥接
│   └── renderer/             ← 渲染进程：UI
│       ├── index.html
│       ├── renderer.ts
│       └── renderer.css
└── package.json              ← 添加 electron 依赖
```

**架构关键点**：

1. **IInteraction 复用**：Electron 渲染进程实现 `IInteraction` 接口，替换 `CliInteraction`
   - `start(handler)` → 渲染进程监听输入框提交
   - `display(text)` → 渲染进程追加到对话区
   - `close()` → 窗口关闭

2. **主进程职责**：
   - 创建 BrowserWindow + 系统托盘
   - 实例化 Agent + Sprite（与 CLI 共用代码）
   - IPC 转发用户输入/精灵输出

3. **零内核改动**：内核和 sprite 逻辑完全复用，只替换交互层

4. **better-sqlite3 兼容**：Electron 主进程是 Node.js 运行时，需 `electron-rebuild`

**阶段二触发条件**（当前已满足）：
- ✅ 阶段一核心机制验证完成
- ✅ IInteraction 接口已设计为可替换
- ✅ better-sqlite3 在 Electron 主进程可直接使用

**阶段二不包含**：
- 多窗口（1 人团队不需要）
- 自动更新（electron-updater，阶段三）
- 系统通知（Notification API，阶段三按需）

## 四、任务清单

| ID  | 任务 | 文件 | 优先级 |
|-----|------|------|--------|
| E-1 | package.json 添加 bin + shebang | package.json, src/index.ts | P3 |
| E-4 | startSprite 调用 restoreMostRecentSession | src/index.ts | P3 |

## 五、不做什么

- 不添加 `/resume` 命令（自动恢复已足够）
- 不添加 `--help` flag（欢迎消息已列命令）
- 不实现 Electron（仅设计，下一轮迭代）
- 不添加彩色输出（Electron 渲染进程会解决）
- 不添加 `/config` 编辑命令（Electron 设置面板会解决）

## 六、验证

- `npm run build` + `npm link` → `memora-sprite` 全局可用
- 启动后若有历史会话 → 显示"已恢复上次会话（N 条消息）"
- 对话后退出重启 → 上次对话上下文延续
- 487 测试全量通过
