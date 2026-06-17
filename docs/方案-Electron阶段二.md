# 方案：Electron 阶段二

> **创建**：2026-06-17
> **入口**：问诊（文档炼化）← 方案更新 + 模块重思 + 排雷
> **依赖**：ADR-SP-003（桌面壳）、ADR-SP-004（感知原则）、ADR-SP-007（目录结构）、ADR-006（安全模型）
> **合并自**：方案-外壳打磨与Electron阶段二.md + 模块重思-桌面UI设计.md + 方案-Electron阶段二-排雷后优化.md

---

## 一、背景与目标

### 1.1 背景

sprite CLI 功能已完整（对话、记忆 CRUD、角色、配置、搜索），但存在两个阻碍实际使用的体验缺口：

1. **启动不便捷**：每次需输入 `npx tsx src/index.ts` 长命令
2. **对话不连续**：重启后丢失上下文，而 `restoreMostRecentSession()` 已实现却未被调用

ADR-SP-003 阶段一（CLI 验证核心机制）已完成，阶段二（Electron）触发条件已满足。

### 1.2 目标

| ID | 目标 | 状态 |
|---|---|---|
| E-1 | 全局命令一键启动 | ✅ 已完成 |
| E-4 | 启动时自动恢复上次会话 | ✅ 已完成 |
| E-2 | Electron 桌面 UI 实现 | ⏳ 待实现 |

---

## 二、已完成项

### 2.1 E-1：全局命令

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

**约束**：不引入 commander/yargs（CLI 路由已自建，自然生长原则）；不添加 `--help` flag。

### 2.2 E-4：对话历史持久化

**改动**：`hosts/memora-sprite/src/index.ts` 的 `startSprite()`，在 `agent.init()` 后、`sprite.start()` 前调用：

```typescript
await agent.init();
const restored = await agent.restoreMostRecentSession('main');
if (restored > 0) {
  console.log(`已恢复上次会话（${restored} 条消息）\n`);
}
sprite.start();
```

**无新增代码**——`restoreMostRecentSession()` 和 `SqliteSessionStore` 已完整实现，只是未被调用。

**约束**：不添加 `/resume` 命令（自动恢复已足够）；不显示历史消息内容（CLI 只提示条数，避免刷屏；Electron 阶段会显示）。

---

## 三、设计哲学

**桌面精灵，不是聊天工具。**

Memora Sprite 的核心定位是"能自我进化的本地 AI 伙伴"，不是又一个 ChatGPT 克隆。UI 设计围绕四个关键词：

| 关键词 | 含义 | UI 体现 |
|---|---|---|
| **存在感** | 精灵始终在，但不打扰 | 系统托盘常驻 + 浮动图标 + 轻量窗口 |
| **主动性** | 精灵会主动关心，不只在被问时才回应 | 托盘通知 + 非侵入式提示 |
| **记忆可视** | 用户能看到精灵记住了什么 | 记忆面板 + 召回透明度 |
| **形态进化** | 精灵随记忆成长而变化形态 | 浮动图标进化系统（阶段三） |

---

## 四、能力映射

将 memora 内核 + sprite 的能力映射到 UI 元素：

| 内核/Sprite 能力 | CLI 现状 | UI 映射 |
|---|---|---|
| `agent.chat(input)` 流式 | readline 输入 → 输出 | 对话窗口（消息气泡 + 流式输出） |
| `sprite.dashboard()` | `/dashboard` 文本 | 侧边栏仪表盘（实时统计） |
| `sprite.listMemories()` | `/memories list` 文本 | 记忆面板（列表 + 筛选） |
| `sprite.searchMemories()` | `/memories search` 文本 | 记忆面板搜索框 |
| `sprite.showMemory(id)` | `/memories show` 文本 | 记忆详情弹窗 |
| `sprite.deleteMemory(id)` | `/memories delete` | 记忆详情删除按钮 |
| `sprite.upsertMemory()` | `/memories add` | 记忆面板添加按钮 |
| `sprite.listPersonas()` | `/persona` 文本 | 角色选择器（顶栏下拉） |
| `sprite.switchPersona()` | `/switch` 命令 | 角色选择器点击切换 |
| `sprite.setPersonaMode()` | `/mode` 命令 | 角色选择器模式开关 |
| `sprite.getConfig()` | `/config` 文本 | 设置面板 |
| `sprite.updateConfig()` | `/config` 命令 | 设置面板表单 |
| `sprite.on('proactivePrompt')` | 控制台输出 | 托盘通知 + 窗口脉冲 |
| `sprite.on('memoryNoticed')` | 控制台输出 | 侧边栏记忆计数 +1 动画 |
| `sprite.on('personaChanged')` | 控制台输出 | 顶栏角色标签切换动画 |
| `sprite.on('insightGained')` | 控制台输出 | 侧边栏 insight 计数 +1 |
| `agent.restoreMostRecentSession()` | 启动时自动恢复 | 对话窗口显示历史消息 |

---

## 五、窗口架构

### 5.1 三态模型

**托盘态 ↔ 浮动态 ↔ 完整态**

```
┌─────────────────┐     ┌───────────┐     ┌─────────────────────────────────┐
│   托盘态         │     │  浮动态    │     │         完整态                   │
│  系统托盘图标    │ ←→  │  桌面悬浮  │ ←→  │  完整对话窗口                    │
│  最低存在感      │     │  小窗口    │     │                                 │
└─────────────────┘     └───────────┘     └─────────────────────────────────┘
```

| 状态 | 触发 | 表现 | 存在感 |
|---|---|---|---|
| **托盘态** | 启动默认 / 最小化到托盘 | 仅系统托盘图标 | 最低 |
| **浮动态** | 托盘右键"显示浮动图标" / 从托盘态双击 | 桌面悬浮小窗口（80x80） | 中等 |
| **完整态** | 点击浮动图标 / 从托盘态双击 | 完整对话窗口 | 最高 |

**切换逻辑**：
- 完整态 → 关闭按钮 / Esc → 浮动态（不是退出，不是托盘态）
- 浮动态 → 单击 → 完整态
- 浮动态 → 右键"隐藏到托盘" → 托盘态
- 托盘态 → 双击 → 完整态
- 托盘态 → 右键"显示浮动图标" → 浮动态

**关键**：关闭完整窗口 = 回到浮动态，精灵始终可见。只有从浮动图标右键"隐藏到托盘"才进入托盘态。

### 5.2 三态状态机实现

主进程统一管理状态，使用两个独立 BrowserWindow：

```typescript
// electron/windowState.ts
type WindowState = 'tray' | 'float' | 'full';

class WindowStateManager {
  private state: WindowState = 'float';  // 默认浮动态
  private floatWindow: BrowserWindow | null = null;
  private fullWindow: BrowserWindow | null = null;

  constructor(private config: { floatPosition: { x: number; y: number } }) {}

  async transition(target: WindowState): Promise<void> {
    if (this.state === target) return;
    // 隐藏当前窗口
    if (this.state === 'float') this.floatWindow?.hide();
    if (this.state === 'full') this.fullWindow?.hide();
    // 显示目标窗口
    if (target === 'float') {
      this.floatWindow?.setPosition(this.config.floatPosition.x, this.config.floatPosition.y);
      this.floatWindow?.show();
    }
    if (target === 'full') {
      this.fullWindow?.show();
      this.fullWindow?.focus();
    }
    this.state = target;
    saveWindowState(target);  // 持久化到 sprite.json
  }

  getState(): WindowState { return this.state; }
}
```

### 5.3 完整窗口布局

```
┌─────────────────────────────────────────────────────┐
│  [精灵头像] Memora Sprite          [角色: 小说家助手 ▼] │  ← 顶栏
├──────────┬──────────────────────────────────────────┤
│  仪表盘   │            对话区域                       │
│ 记忆 104 │  [用户] 今天写了一章新小说                │
│ 洞察 12  │  [精灵] 记得你上次提到用第三人称叙事...    │
│ 角色 5   │                                          │
│  ──────  │  [用户] 对，我想试试非线性时间线          │
│ 推荐     │  [精灵] 这让我想起你读过的《百年孤独》...  │
│ · 技巧   │                                          │
│ · 灵感   │                                          │
│  ──────  │  ┌────────────────────────────────────┐  │
│ [记忆]   │  │ 输入消息...                    [发送] │  │
│ [设置]   │  └────────────────────────────────────┘  │
└──────────┴──────────────────────────────────────────┘
```

### 5.4 浮动图标

**形态**：80x80 无边框悬浮窗口，始终置顶，可拖动。

```
    ┌──────┐
    │      │
    │  🌿  │   ← 精灵当前形态（阶段二：emoji；阶段三：进化形态）
    │      │
    └──────┘
     ●  ← 状态指示点（绿=idle / 蓝=active / 黄=sleeping）
```

**交互**：

| 操作 | 行为 |
|---|---|
| 单击 | 展开为完整窗口 |
| 双击 | 展开为完整窗口 + 聚焦 |
| 拖动 | 移动位置（持久化到 sprite.json） |
| 右键 | 快速菜单 |
| 主动提示时 | 图标弹跳动画 + 状态点闪烁 |

**右键菜单**：
```
─────────────
展开窗口
─────────────
切换角色 ▶
  小说家助手
  日記夥伴
  ...
静默模式 ☐/☑
─────────────
隐藏到托盘
退出
```

**拖动实现**（排雷修正）：使用鼠标事件手动处理拖动，避免 `-webkit-app-region: drag` 吞掉单击事件。

```typescript
// 注入到浮动窗口渲染进程
let isDragging = false;
let startX = 0, startY = 0;

document.addEventListener('mousedown', (e) => {
  isDragging = false;
  startX = e.screenX;
  startY = e.screenY;
});

document.addEventListener('mousemove', (e) => {
  if (e.buttons === 1) {
    const dx = e.screenX - startX;
    const dy = e.screenY - startY;
    if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      isDragging = true;
    }
    if (isDragging) {
      window.electronAPI.moveFloatWindow(dx, dy);
    }
  }
});

document.addEventListener('mouseup', () => {
  if (isDragging) window.electronAPI.saveFloatPosition();
  isDragging = false;
});

document.addEventListener('click', () => {
  if (!isDragging) window.electronAPI.expandToFull();
});
```

**位置持久化**：拖动后位置保存到 `sprite.json` 的 `floatIconPosition: { x, y }`，下次启动恢复。

### 5.5 系统托盘

```
托盘图标（精灵状态指示）：
  🟢 idle    — 绿色圆点
  🔵 active  — 蓝色脉冲（正在对话）
  🟡 sleeping — 黄色月牙

托盘右键菜单：
  ─────────────
  显示窗口
  ─────────────
  静默模式 ☐/☑
  切换角色 ▶
    小说家助手
    日記夥伴
    学習伴走
    ...
  ─────────────
  退出
```

### 5.6 浮动与完整窗口消息同步

浮动窗口仅显示状态指示点 + 未读计数，不显示对话内容：

```typescript
class FloatWindowManager {
  private unreadCount = 0;

  onSpriteOutput(): void {
    if (windowState.getState() !== 'full' || !fullWindow?.isVisible()) {
      this.unreadCount++;
      this.updateBadge();
    }
  }

  onExpandToFull(): void {
    this.unreadCount = 0;
    this.updateBadge();
  }
}
```

---

## 六、核心区域设计

### 6.1 对话区域

**消息气泡**：

```
用户消息（右对齐，浅色背景）：
┌──────────────────────────┐
│ 今天写了一章新小说         │
└──────────────────────────┘

精灵消息（左对齐，白色背景 + 精灵头像）：
[头像] ┌────────────────────────────────────┐
       │ 记得你上次提到用第三人称叙事，这次   │
       │ 还是延续了这个风格。                │
       │                                     │
       │ 💡 召回记忆：文笔风格（score: 0.85） │
       └────────────────────────────────────┘
```

**召回透明度**：精灵回复中如果召回了记忆，在消息底部显示召回的记忆名称和相似度，用户可点击展开查看。（P2 优先级，依赖内核 AgentChunk 扩展，延后实现）

**流式输出**：文字逐字出现（复用 `agent.chat()` 的 chunk 事件），打字机效果。

**代码块**：等宽字体 + 语法高亮 + 复制按钮。

### 6.2 流式输出架构（排雷修正）

**问题**：IInteraction.output() 无流式语义，多次调用无法区分 chunk 与独立消息。

**修正**：Electron 主进程**不通过 IInteraction 发送流式 chunk**，而是直接消费 `agent.chat()` 的 AsyncGenerator，通过专用 IPC 通道发送。

```typescript
// electron/main.ts
async function handleUserInput(text: string): Promise<void> {
  const messageId = crypto.randomUUID();
  mainWindow.webContents.send('sprite-stream-start', { messageId });

  const abortController = new AbortController();
  currentAbortController = abortController;  // 供 chat-abort 使用

  try {
    for await (const chunk of agent.chat(text, abortController.signal)) {
      if (chunk.type === 'text') {
        mainWindow.webContents.send('sprite-stream-chunk', {
          messageId,
          text: chunk.content,
        });
      } else if (chunk.type === 'done') {
        mainWindow.webContents.send('sprite-stream-end', { messageId });
      }
    }
  } catch (err) {
    mainWindow.webContents.send('sprite-error', { text: (err as Error).message });
  }
}

// chat-abort 通道处理
ipcMain.on('chat-abort', () => {
  currentAbortController?.abort();
});
```

**IInteraction 职责调整**：ElectronInteraction 仅负责非流式输出（主动提示、系统消息），通过 `sprite-output` 通道发送，载荷含 `kind` 字段区分类型。

### 6.3 侧边栏

**仪表盘区**（始终可见）：

```
── 仪表盘 ──
记忆    104
洞察     12
角色      5

── 推荐 ──
· 文笔风格（相关度 0.92）
· 叙事结构（相关度 0.78）

── 导航 ──
[记忆管理]
[设置]
```

数字实时更新——当 `memoryNoticed` 事件触发时，记忆数 +1 并有轻微脉冲动画。推荐列表来自 `sprite.dashboard().suggestions`，点击可查看对应记忆详情。

### 6.4 记忆管理面板

点击侧边栏 `[记忆管理]` 进入，覆盖对话区域：

```
┌─────────────────────────────────────────────────────┐
│  记忆管理                    [🔍 搜索框]  [+ 添加]   │
├─────────────────────────────────────────────────────┤
│  筛选: [全部 ▼]  [来源: profile ▼]                  │
├─────────────────────────────────────────────────────┤
│  📌 文笔风格                    source: profile     │
│     偏好简洁有力的短句，少用形容词...                 │
│     score: 0.85  ·  创建: 2026-06-15               │
│                                                     │
│  📌 叙事视角                     source: insight    │
│     用户擅长第三人称有限视角，受加缪影响...           │
│     score: 0.72  ·  创建: 2026-06-16               │
└─────────────────────────────────────────────────────┘
```

- **搜索框**：调用 `sprite.searchMemories()`，结果高亮匹配词，显示相似度百分比
- **筛选**：按 source 下拉筛选（profile/insight/guardrail/skill/rule）
- **点击条目**：弹出详情弹窗（完整内容 + 元数据 + 删除按钮）
- **添加按钮**：弹出表单（source/name/content 三个字段）

### 6.5 设置面板

点击侧边栏 `[设置]` 进入：

```
┌─────────────────────────────────────────────────────┐
│  设置                                                │
├─────────────────────────────────────────────────────┤
│  ── LLM 配置 ──                                     │
│  提供商:    [DeepSeek ▼]                            │
│  模型:      [deepseek-chat        ]                 │
│  API Key:   [sk-****              ]  [测试]         │
│  Base URL:  [https://api.deepseek.com]              │
│                                                     │
│  ── Embedding 配置（可选）──                         │
│  启用语义搜索: [☑]                                   │
│  模型:      [text-embedding-3-small]                │
│  API Key:   [sk-****              ]                 │
│  Base URL:  [https://api.openai.com/v1]             │
│                                                     │
│  ── 精灵配置 ──                                     │
│  静默模式:          [☐]                             │
│  主动提示阈值:      [3] 个事件                       │
│  主动提示冷却:      [5] 分钟                         │
│  定时触发间隔:      [60] 分钟                       │
│                                                     │
│  ── 文件监听 ──                                     │
│  启用:              [☑]                             │
│  监听路径:          [.]                             │
│  忽略模式:          [node_modules, .git, dist]      │
│  防抖时间:          [1000] 毫秒                     │
│                                                     │
│  ── 角色 ──                                         │
│  匹配模式:          [自动 ◉] [手动 ○]               │
│  默认角色:          [小说家助手 ▼]                   │
│                                                     │
│                              [取消]  [保存]         │
└─────────────────────────────────────────────────────┘
```

保存时调用 `sprite.updateConfig()` + 写入 `~/.memora/config.json`。

### 6.6 主动提示

精灵主动说话时（`proactivePrompt` 事件），不弹窗打断用户，而是：

1. **托盘图标脉冲**（蓝色 → 橙色 → 蓝色）
2. **系统通知**（OS 原生通知，点击聚焦窗口）
3. **窗口内非侵入式提示**（如果窗口可见）：

```
┌─────────────────────────────────────────────────────┐
│  [精灵头像] 精灵有话想说                              │  ← 顶部滑入
│  "你刚才连续写了 2 小时，要不要休息一下？"            │
│  [查看]  [稍后]  [静默 1 小时]                        │
└─────────────────────────────────────────────────────┘
```

**静默模式**时，只做托盘脉冲，不弹通知。

**主动提示分发逻辑**（排雷修正）：主进程负责托盘脉冲和系统通知（不依赖渲染进程），渲染进程只在窗口可见且非静默时显示窗口内提示。

```typescript
sprite.on('proactivePrompt', ({ prompt, triggers }) => {
  const isSilent = sprite.getConfig().silentMode;
  const isFullVisible = fullWindow?.isVisible() && !fullWindow?.isMinimized();

  trayIcon.pulse('orange');                          // 始终执行
  if (!isSilent) new Notification({ body: prompt }).show();  // 非静默
  if (!isSilent && isFullVisible) {
    fullWindow.webContents.send('sprite-event', {
      type: 'proactivePrompt',
      payload: { prompt, triggers },
      silent: isSilent,
    });
  }
  if (windowState.getState() === 'float') {
    floatWindow.webContents.send('sprite-event', {
      type: 'proactivePrompt', payload: {}, silent: isSilent,
    });
  }
});
```

---

## 七、视觉风格

### 7.1 色彩

| 用途 | 色值 | 说明 |
|---|---|---|
| 主背景 | `#1e1e2e`（深色）/ `#fafafa`（浅色） | 跟随系统主题 |
| 侧边栏背景 | `#181825`（深色）/ `#f0f0f0`（浅色） | 略深于主背景 |
| 精灵气泡 | `#89b4fa`（蓝）/ `#e8f0fe`（浅蓝） | 精灵主色 |
| 用户气泡 | `#a6e3a1`（绿）/ `#e6f4ea`（浅绿） | 用户主色 |
| 强调色 | `#f5c2e7`（粉） | 用于通知/活跃状态 |
| 文字主色 | `#cdd6f4`（深色）/ `#1e1e2e`（浅色） | 高对比度 |

**灵感**：Catppuccin Mocha 配色。

### 7.2 字体

| 用途 | 字体 | 说明 |
|---|---|---|
| UI 文字 | 系统默认（Segoe UI / SF Pro / Noto Sans CJK） | 零配置 |
| 代码块 | JetBrains Mono | 用户偏好 |
| 精灵消息 | 霞鹜文楷 | 用户偏好，营造"伙伴"感 |

### 7.3 间距与圆角

- 窗口圆角：8px
- 气泡圆角：12px
- 按钮圆角：6px
- 间距基准：8px（4/8/16/24/32）
- 气泡最大宽度：窗口宽度的 70%

### 7.4 动画

| 场景 | 动画 | 时长 |
|---|---|---|
| 窗口显示/隐藏 | 淡入淡出 + 轻微上移 | 200ms |
| 消息出现 | 从下方滑入 + 淡入 | 150ms |
| 流式输出 | 逐字打字机 | 跟随 chunk 速度 |
| 数字更新 | 脉冲放大 → 回缩 | 300ms |
| 托盘脉冲 | 颜色渐变循环 | 2s |

---

## 八、Electron 架构

### 8.1 目录结构

```
hosts/memora-sprite/
├── src/                          ← CLI 入口（保留，零改动）
│   ├── index.ts
│   ├── storage/
│   ├── sprite/
│   └── __tests__/
├── electron/                     ← 阶段二新增
│   ├── main.ts                   ← 主进程：窗口管理 + 托盘 + 生命周期 + Agent 实例
│   ├── preload.ts                ← 预加载：contextBridge 暴露 IPC API
│   ├── interaction.ts            ← ElectronInteraction 实现 IInteraction
│   ├── trayIcon.ts               ← 托盘图标 + 状态指示 + 右键菜单
│   ├── floatWindow.ts            ← 浮动窗口管理（拖动 + 位置持久化 + 状态点）
│   ├── windowState.ts            ← 三态状态机（tray/float/full）
│   └── renderer/                 ← 渲染进程（原生 TS + DOM API，零框架）
│       ├── index.html            ← 主窗口 HTML（含 CSP meta）
│       ├── renderer.ts           ← 渲染进程入口
│       ├── renderer.css          ← Catppuccin Mocha 配色
│       ├── chat.ts               ← 对话区域（消息气泡 + 流式追加）
│       ├── sidebar.ts            ← 侧边栏（仪表盘 + 推荐 + 导航）
│       ├── memories.ts           ← 记忆管理面板
│       ├── settings.ts           ← 设置面板
│       └── float.html            ← 浮动窗口 HTML
├── resources/                    ← 应用资源
│   └── tray-icon.png             ← 托盘图标
└── package.json                  ← 添加 electron + @electron/rebuild 依赖
```

**技术栈选择**（排雷修正）：MVP 用原生 TS + DOM API，零框架（自然生长原则，等 3+ 次复杂度需求再引入框架）。

### 8.2 IPC 通道设计（17 个）

| 方向 | 通道名 | 载荷 | 用途 |
|---|---|---|---|
| 渲染→主 | `user-input` | `{ text: string }` | 用户发送消息 |
| 主→渲染 | `sprite-output` | `{ text, kind: 'proactive' \| 'system' }` | 非流式输出（主动提示/系统消息） |
| 主→渲染 | `sprite-stream-start` | `{ messageId: string }` | 流式输出开始 |
| 主→渲染 | `sprite-stream-chunk` | `{ messageId, text }` | 流式 chunk |
| 主→渲染 | `sprite-stream-end` | `{ messageId }` | 流式输出结束 |
| 主→渲染 | `sprite-error` | `{ text: string }` | 错误信息 |
| 主→渲染 | `sprite-event` | `{ type, payload, silent: boolean }` | 精灵事件 |
| 渲染→主 | `chat-abort` | `{}` | 中断当前对话 |
| 渲染→主 | `memories-list` | `{ source? }` | 请求记忆列表 |
| 主→渲染 | `memories-list-result` | `{ memories: [] }` | 返回记忆列表 |
| 渲染→主 | `memories-search` | `{ query }` | 搜索记忆 |
| 主→渲染 | `memories-search-result` | `{ hits: [] }` | 返回搜索结果 |
| 渲染→主 | `memories-delete` | `{ id }` | 删除记忆 |
| 渲染→主 | `memories-add` | `{ source, name, content }` | 添加记忆 |
| 渲染→主 | `session-load` | `{ date?, session? }` | 请求历史会话消息 |
| 主→渲染 | `session-load-result` | `{ messages: SessionMessage[] }` | 返回历史消息 |
| 渲染→主 | `config-get` | `{}` | 请求配置 |
| 主→渲染 | `config-result` | `{ config }` | 返回配置 |
| 渲染→主 | `config-update` | `{ key, value }` | 更新配置 |
| 渲染→主 | `persona-switch` | `{ name }` | 切换角色 |
| 渲染→主 | `persona-mode` | `{ mode }` | 设置匹配模式 |

### 8.3 IInteraction 适配

ElectronInteraction 仅负责非流式输出（流式由主进程直接处理）：

```typescript
// electron/interaction.ts
class ElectronInteraction implements IInteraction {
  constructor(private mainWindow: BrowserWindow) {}

  start(handler: InputHandler): void {
    ipcMain.on('user-input', (_, text: string) => handler({ text }));
  }

  output(text: string): void {
    this.mainWindow.webContents.send('sprite-output', { text, kind: 'proactive' });
  }

  error(text: string): void {
    this.mainWindow.webContents.send('sprite-error', { text });
  }

  stop(): void {
    ipcMain.removeAllListeners('user-input');
  }

  onClose(handler: CloseHandler): void {
    this.mainWindow.on('closed', handler);
  }
}
```

**零内核改动**：Sprite 和 Agent 完全不知道交互层是 CLI 还是 Electron。

### 8.4 会话历史显示（排雷修正）

新增 `session-load` / `session-load-result` 通道。主进程启动时自动加载并推送历史消息：

```typescript
async function restoreSession(): Promise<void> {
  const restored = await agent.restoreMostRecentSession('main');
  if (restored > 0) {
    const sessions = sessionStore.listSessions();
    const today = new Date().toISOString().slice(0, 10);
    const preferred = sessions.find(s => s === `${today}-main`) ?? sessions[sessions.length - 1];
    if (preferred) {
      const match = preferred.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
      if (match) {
        const [, date, session] = match;
        const messages = sessionStore.loadMessages(date, session);
        mainWindow.webContents.send('session-load-result', { messages });
      }
    }
  }
}
```

### 8.5 安全配置（排雷修正）

所有 BrowserWindow 强制安全配置：

```typescript
function createFullWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: {
      contextIsolation: true,      // 强制 true
      nodeIntegration: false,      // 强制 false
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
}
```

**preload.ts** 使用 contextBridge 暴露最小 API：

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  sendMessage: (text: string) => ipcRenderer.send('user-input', text),
  abortChat: () => ipcRenderer.send('chat-abort'),
  onStreamStart: (cb) => ipcRenderer.on('sprite-stream-start', (_, { messageId }) => cb(messageId)),
  onStreamChunk: (cb) => ipcRenderer.on('sprite-stream-chunk', (_, { messageId, text }) => cb(messageId, text)),
  onStreamEnd: (cb) => ipcRenderer.on('sprite-stream-end', (_, { messageId }) => cb(messageId)),
  onSpriteOutput: (cb) => ipcRenderer.on('sprite-output', (_, { text, kind }) => cb(text, kind)),
  onSpriteError: (cb) => ipcRenderer.on('sprite-error', (_, { text }) => cb(text)),
  onSpriteEvent: (cb) => ipcRenderer.on('sprite-event', (_, event) => cb(event)),
  onSessionHistory: (cb) => ipcRenderer.on('session-load-result', (_, { messages }) => cb(messages)),
  loadMemories: (source?) => ipcRenderer.invoke('memories-list', { source }),
  searchMemories: (query) => ipcRenderer.invoke('memories-search', { query }),
  deleteMemory: (id) => ipcRenderer.invoke('memories-delete', { id }),
  addMemory: (data) => ipcRenderer.invoke('memories-add', data),
  getConfig: () => ipcRenderer.invoke('config-get'),
  updateConfig: (key, value) => ipcRenderer.invoke('config-update', { key, value }),
  switchPersona: (name) => ipcRenderer.invoke('persona-switch', { name }),
  setPersonaMode: (mode) => ipcRenderer.invoke('persona-mode', { mode }),
  moveFloatWindow: (dx, dy) => ipcRenderer.send('move-float-window', dx, dy),
  saveFloatPosition: () => ipcRenderer.send('save-float-position'),
  expandToFull: () => ipcRenderer.send('expand-to-full'),
});
```

**index.html** CSP meta 标签：

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:;">
```

### 8.6 better-sqlite3 兼容（排雷修正）

package.json 添加 postinstall 钩子 + @electron/rebuild 依赖：

```json
{
  "scripts": {
    "postinstall": "electron-rebuild -f -w better-sqlite3",
    "start:cli": "tsx src/index.ts",
    "start:electron": "npm run build:electron && electron .",
    "build:electron": "tsc -p tsconfig.electron.json",
    "build": "npm run build:cli && npm run build:electron"
  },
  "devDependencies": {
    "@electron/rebuild": "^3.6.0",
    "electron": "^31.0.0"
  },
  "main": "dist-electron/main.js",
  "bin": {
    "memora-sprite": "./dist/index.js"
  }
}
```

**tsconfig.electron.json**（独立配置，输出到 dist-electron/）：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist-electron",
    "module": "CommonJS",
    "target": "ES2022"
  },
  "include": ["electron/**/*"]
}
```

### 8.7 sprite.json 字段扩展（排雷修正）

spriteConfig.ts 新增 3 个字段：

```typescript
export interface SpriteConfig {
  // ... 现有字段 ...
  /** 浮动图标位置 */
  floatIconPosition: { x: number; y: number };
  /** 窗口状态（持久化） */
  windowState: 'tray' | 'float' | 'full';
  /** 浮动图标是否可见 */
  floatIconVisible: boolean;
}

export const DEFAULT_SPRITE_CONFIG: Required<SpriteConfig> = {
  // ... 现有默认值 ...
  floatIconPosition: { x: -1, y: -1 },  // -1 表示首次启动居中
  windowState: 'float',
  floatIconVisible: true,
};
```

### 8.8 文件监听默认关闭（排雷修正）

Electron 模式下默认关闭文件监听，避免无效提示（工作空间目录变化与用户实际工作无关）：

```typescript
const spriteConfig = loadSpriteConfig(dataDir);
if (spriteConfig.fileWatcherEnabled === undefined) {
  spriteConfig.fileWatcherEnabled = false;
  saveSpriteConfig(dataDir, { fileWatcherEnabled: false });
}
```

---

## 九、浮动图标进化系统（阶段三预留）

### 9.1 核心理念

**桌面宠物养成——精灵的形态随用户的记忆画像进化。**

每个用户的精灵形态都是独一无二的，因为形态由用户的记忆数据驱动。程序员养出的精灵和小说家养出的精灵，形态完全不同。这不是皮肤切换，而是真正的"成长"。

### 9.2 进化机制

```
用户记忆画像（profile + insight 记忆）
        │
        ▼
   画像摘要生成（定期提取关键词 + 偏好 + 领域）
        │
        ▼
   形态 prompt 生成（"一个偏好简洁代码风格的程序员精灵，蓝色调，几何形态..."）
        │
        ▼
   图像生成 LLM（DALL-E / SD / Flux）
        │
        ▼
   新形态渲染到浮动图标
```

### 9.3 进化阶段

| 阶段 | 触发条件 | 形态特征 |
|---|---|---|
| **种子期** | 首次启动 | 默认形态（简单 emoji 🌿） |
| **萌芽期** | 记忆达 50 条 | 生成第一张个性化形态 |
| **生长期** | 记忆达 200 条 / 每月一次 | 形态细化（颜色 + 配饰 + 表情） |
| **成熟期** | 记忆达 500 条 / 季度一次 | 形态定型，微调细节 |
| **进化期** | 用户主动触发"进化" | 基于全量记忆重新生成 |

### 9.4 画像维度

| 维度 | 数据来源 | 形态影响 |
|---|---|---|
| **领域** | profile 记忆中的职业/兴趣 | 主体形态（程序员→几何/电路纹理；作家→羽毛/墨水元素） |
| **偏好** | insight 记忆中的风格偏好 | 色彩倾向（偏好暗色→深色调；偏好明亮→暖色调） |
| **性格** | profile 记忆中的性格特征 | 表情/姿态（内向→含蓄；外向→活泼） |
| **角色** | 最常用角色 | 配饰（小说家助手→书本；学習伴走→眼镜） |
| **记忆量** | 总记忆数 | 复杂度（记忆越多→细节越丰富） |

### 9.5 用户控制

| 功能 | 说明 |
|---|---|
| **锁定形态** | 用户满意当前形态时可锁定，不再自动进化 |
| **手动进化** | 用户主动触发"进化"，基于最新画像重新生成 |
| **形态历史** | 保留历次形态，用户可回看/回退 |
| **形态偏好** | 用户可指定方向（"更可爱"/"更酷"/"更简约"） |

### 9.6 技术依赖

| 能力 | 阶段三依赖 | 当前状态 |
|---|---|---|
| 记忆画像提取 | memora 内核 insight + profile | ✅ 已实现 |
| 画像摘要生成 | LLM 调用（复用现有 chat API） | ✅ 已实现 |
| 图像生成 | 多模态/图像生成 LLM（DALL-E / SD / Flux） | ❌ 未接入 |
| 形态存储 | sprite.json 添加 formHistory 字段 | ❌ 待实现 |
| 形态渲染 | 浮动图标窗口加载图片 | ❌ 待实现（阶段二先实现浮动图标） |

### 9.7 阶段二与阶段三的衔接

**阶段二**（当前）：
- 实现浮动图标窗口（80x80 无边框置顶）
- 用简单 emoji + 状态指示点
- 位置持久化
- 交互（单击展开 / 拖动 / 右键菜单）

**阶段三**（未来，接入图像生成 LLM 后）：
- 浮动图标加载生成的形态图片
- 进化机制自动触发
- 形态历史 + 锁定 + 手动进化
- 设置面板添加"精灵形态"区

**关键**：阶段二的浮动图标设计已为阶段三预留接口——只需把 emoji 替换为图片加载即可，窗口框架和交互逻辑零改动。

---

## 十、实现优先级

### 10.1 步骤一：MVP（P0）

| 优先级 | 区域 | 内容 |
|---|---|---|
| P0 | 项目骨架 | package.json + tsconfig.electron.json + electron/ 目录 |
| P0 | 安全配置 | BrowserWindow 安全配置 + preload contextBridge + CSP |
| P0 | 主进程 | main.ts：Agent 实例 + 窗口管理 + IPC 注册 |
| P0 | 三态状态机 | windowState.ts + 两 BrowserWindow |
| P0 | 浮动窗口 | floatWindow.ts + 拖动 + 位置持久化 |
| P0 | 托盘 | trayIcon.ts + 状态指示 + 右键菜单 |
| P0 | 对话区域 | chat.ts + 流式输出 + 历史消息显示 |
| P0 | IInteraction | ElectronInteraction 实现 |
| P0 | 会话恢复 | 启动时加载历史消息推送 |

### 10.2 步骤二：完整体验（P1）

| 优先级 | 区域 | 内容 |
|---|---|---|
| P1 | 侧边栏 | sidebar.ts + 仪表盘 + 推荐 + 导航 |
| P1 | 记忆管理面板 | memories.ts + 列表 + 搜索 + 详情 + 删除 |
| P1 | 角色选择器 | 顶栏下拉 + 模式切换 |
| P1 | 主动提示 | 托盘脉冲 + 系统通知 + 浮动弹跳 + 窗口内提示 |
| P1 | 浮动窗口同步 | 未读计数 + 状态点 |
| P2 | 设置面板 | settings.ts + LLM/Embedding/精灵/角色配置 |
| P2 | 视觉打磨 | Catppuccin 配色 + 动画 + 霞鹜文楷 |

### 10.3 步骤三：延后项

| 优先级 | 区域 | 内容 | 延后原因 |
|---|---|---|---|
| P2 | 召回透明度 | 消息底部显示召回记忆 | 依赖内核 AgentChunk 扩展 |
| P3 | 打包分发 | electron-builder + 跨平台 + 图标 | 阶段三 |
| P3 | 形态进化 | 浮动图标进化系统 | 阶段三，依赖图像生成 LLM |

---

## 十一、不做什么

- **不做多窗口**：1 人团队不需要，单窗口 + 托盘足够
- **不做主题编辑器**：跟随系统深浅色 + Catppuccin 配色，不提供自定义
- **不做快捷键设置**：Ctrl+Shift+M 召唤固定，不提供自定义
- **不做消息搜索**：对话历史搜索是低频需求，等 3 次以上再考虑
- **不做记忆编辑**：只提供删除 + 添加，不提供内容编辑（记忆是只读快照）
- **不做多语言**：中文界面，不提供 i18n
- **不做自动更新**：阶段二不引入 electron-updater
- **不做系统通知交互**：通知只负责聚焦窗口，不在通知内回复
- **不引入前端框架**：MVP 用原生 TS + DOM API（自然生长原则）
- **不实现打包**：阶段二仅开发模式运行
- **不实现召回透明度**：依赖内核扩展，延后
- **不在 Electron 模式默认开文件监听**：避免无效提示

---

## 十二、验证标准

| 验证点 | 标准 |
|---|---|
| 零内核改动 | memora 内核零修改，sprite.ts 零修改（仅扩展 spriteConfig） |
| IInteraction 复用 | ElectronInteraction 实现接口，Sprite 无感知 |
| 流式输出正确 | 对话逐字出现，单条气泡，不拆分 |
| 会话历史可见 | 启动后 UI 显示上次对话消息 |
| 三态切换无冲突 | 任意时刻只有一个窗口可见 |
| better-sqlite3 可用 | Electron 启动无 native 模块错误 |
| 浮动图标可拖动可单击 | 拖动不触发展开，单击不误判拖动 |
| 静默模式生效 | 静默时无系统通知，仅托盘脉冲 |
| 安全配置合规 | contextIsolation=true, nodeIntegration=false, CSP 生效 |
| 可中断对话 | 点击停止按钮，流式输出立即停止 |
| 浮动窗口未读计数 | 完整窗口隐藏时，浮动图标显示未读数 |
| 托盘常驻 | 关闭按钮最小化到托盘，不退出进程 |
| 主动提示不突兀 | 静默模式下只脉冲托盘，不弹通知 |
| 记忆可视 | 用户可在 UI 中查看/搜索/删除所有记忆 |

---

## 十三、执行建议

按以下顺序执行方案更新：

1. **先扩展 spriteConfig.ts**：新增 3 个字段（floatIconPosition / windowState / floatIconVisible）
2. **搭建 electron/ 骨架**：package.json + tsconfig + 安全配置
3. **实现主进程核心**：main.ts + windowState.ts + IPC 注册
4. **实现浮动窗口 + 托盘**：floatWindow.ts + trayIcon.ts
5. **实现渲染进程 MVP**：chat.ts + 流式输出 + 历史消息
6. **验证**：按第十二章验证标准逐项检查

---

## 十四、UI 设计契约

> **demo 先行策略**：HTML 预览作为 UI 设计契约，方案文档作为架构契约，两者互补。
> HTML 修改成本远低于 Electron 实现后修改，先在 HTML 中验证 UI 设计可行性。

### 14.1 设计契约文件

| 文件 | 角色 | 职责 |
|---|---|---|
| `docs/memora-sprite-preview.html` | UI 设计契约 | 视觉效果、交互逻辑、动画验证 |
| `docs/方案-Electron阶段二.md` | 架构契约 | 目录结构、IPC 通道、安全配置、实现优先级 |

### 14.2 对齐状态（2026-06-17）

#### 已对齐（12 项）

| 维度 | 对齐情况 |
|---|---|
| 配色方案 | ✅ Catppuccin Mocha 完全一致 |
| 字体 | ✅ 霞鹜文楷 + JetBrains Mono + 系统默认 |
| 主界面布局 | ✅ 标题栏 + 侧边栏 + 对话区 + 输入框 |
| 系统托盘 | ✅ 3 状态 + 右键菜单 |
| 主动提示 | ✅ banner + 托盘脉冲 + 静默模式 |
| 记忆管理面板 | ✅ 列表 + 筛选 + 搜索 + 详情弹窗 + 删除 |
| 设置面板 | ✅ LLM/Embedding/精灵/文件监听/角色 5 区 |
| 动画效果 | ✅ 淡入/滑入/脉冲/打字机 |
| 实现优先级 | ✅ MVP + 完整体验 |
| **三态窗口模型** | ✅ 托盘↔浮动↔完整切换演示 + 浮动图标 mockup |
| **流式输出** | ✅ 逐字打字机 + chat-abort 中断按钮 |
| **浮动图标交互** | ✅ 单击展开 + 主动提示弹跳 + 未读计数 badge |

#### 待补充（6 项，P1-P2）

| # | 待补充项 | 优先级 | 说明 |
|---|---|---|---|
| 1 | 会话历史显示 | P1 | 启动时显示历史消息的视觉效果 |
| 2 | 拖动演示 | P1 | 浮动图标拖动 + 位置持久化 |
| 3 | 添加记忆表单 | P2 | 当前只弹 alert，需补充表单弹窗 |
| 4 | 测试 API Key 交互 | P2 | 设置面板"测试"按钮交互 |
| 5 | 形态进化预留卡片 | P3 | 阶段三，可选 |
| 6 | 设计哲学第 4 关键词 | P3 | "形态进化"卡片 |

### 14.3 demo 先行工作流

```
方案文档（架构契约）
    ↓
HTML 预览（UI 设计契约）← 验证 UI 可行性
    ↓
发现 UI 问题 → 修改 HTML（低成本）
    ↓
HTML 稳定 → Electron 实现（参考 HTML）
    ↓
Electron 实现完成 → 对照 HTML 验证
```

### 14.4 HTML 预览章节结构（9 章）

| 章 | 内容 | 对应方案章节 |
|---|---|---|
| 一 | 主界面预览 | 五、六 |
| 二 | 三态窗口模型 | 5.1-5.4 |
| 三 | 流式输出与中断 | 6.2 |
| 四 | 系统托盘状态 | 5.5 |
| 五 | 主动提示效果 | 6.6 |
| 六 | 视觉风格 | 七 |
| 七 | 交互动画 | 7.4 |
| 八 | 设计原则 | 三 |
| 九 | 实现优先级 | 十 |

### 14.5 维护规则

1. **方案变更 → 同步 HTML**：架构契约变更时，评估是否影响 UI 设计契约
2. **HTML 变更 → 同步方案**：UI 设计契约变更时，更新本章节对齐状态
3. **不实现真实逻辑**：HTML 只做视觉和交互验证，不实现 IPC、Agent 调用
4. **保持单文件**：HTML 不拆分，不引入框架（与方案"零框架"一致）
