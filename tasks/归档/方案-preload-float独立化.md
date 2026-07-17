# 浮动窗口 preload 独立化方案

> **来源**：2026-07-17 三模式联审（年轮审判+自动体检+自动安全）→ AUDIT-0717-1 触发方案设计
> **架构归属**：精灵宿主 `hosts/memora-sprite/src/electron/`，无内核改动
> **ADR 关联**：[ADR-SP-017](../../.trae/rules/decisions/ADR-SP-017-quick-input-architecture.md) §影响 + §何时回顾

## 背景与目标

### 当前问题

[preload.ts](../../hosts/memora-sprite/src/electron/preload.ts) 单文件 1035 行 / 266 API 方法，被 3 个窗口共用：

| 窗口 | preload 来源 | 实际需要 API 数 | 当前暴露 API 数 | 暴露面倍数 |
|------|-------------|---------------|---------------|----------|
| 主窗口 | preload.cjs | ~266（完整 UI） | 266 | 1x（合理） |
| 浮动窗口 | preload.cjs | **11** | 266 | **24x 过度** |
| quick-input 窗口 | preload-quick-input.cjs | 10 | 10 | 1x（已优化） |

**核心矛盾**：浮动窗口（80x80 悬浮球）只调用 11 个 API（拖动 / 展开未读消息预览 / 主题广播），却继承主窗口全部 266 API 暴露面——包含 `deleteMemory` / `installSkill` / `saveLlmProvider` / `clearAuditLog` 等高危 API，违反 [security_rules.md](../../.trae/rules/security_rules.md) P3 最小权限原则。

### 预期效果

- 浮动窗口暴露面从 266 API → 11 API（**-96%**）
- 高危 API（deleteMemory / installSkill / saveLlmProvider / clearAuditLog）不再暴露给浮动窗口
- 参照已验证的 [preload-quick-input.ts](../../hosts/memora-sprite/src/electron/preload-quick-input.ts) 模式，技术风险低
- 触发 [ADR-SP-017 §何时回顾](../../.trae/rules/decisions/ADR-SP-017-quick-input-architecture.md) L105"当 quick-input 窗口数 > 1 时评估"——浮动窗口作为"第 2 个独立窗口"等价触发

## 涉及范围

- **新增文件**：`hosts/memora-sprite/src/electron/preload-float.ts`（约 80 行，11 API + 4 IPC 通道）
- **修改文件**：
  - [hosts/memora-sprite/src/electron/windows/floatWindow.ts](../../hosts/memora-sprite/src/electron/windows/floatWindow.ts) L69 — `preload.cjs` → `preload-float.cjs`
  - [hosts/memora-sprite/tsconfig.preload.json](../../hosts/memora-sprite/tsconfig.preload.json) L12 — `include` 数组新增 `preload-float.ts`
  - [ADR-SP-017](../../.trae/rules/decisions/ADR-SP-017-quick-input-architecture.md) §影响 — "100+ API" 更新为 "266 API"，§何时回顾 标注"浮动窗口 preload 独立化已实施"
- **数据库变更**：无
- **内核变更**：无

## 浮动窗口 API 子集（12 个）

来源：[renderer/float/float.ts](../../hosts/memora-sprite/src/electron/renderer/float/float.ts) 全量扫描 + [preload.ts](../../hosts/memora-sprite/src/electron/preload.ts) 浮动窗口 API 完整清单

| # | API 方法 | IPC 通道 | 用途 | float.ts 是否调用 |
|---|---------|---------|------|-----------------|
| 1 | `moveFloatWindow(dx, dy)` | MOVE_FLOAT_WINDOW | 拖动浮动窗口（fire-and-forget） | ✅ L269 |
| 2 | `saveFloatPosition()` | SAVE_FLOAT_POSITION | 拖动结束保存位置 | ✅ L288 |
| 3 | `expandToFull()` | EXPAND_TO_FULL | 单击展开为完整窗口 | ✅ L293/309 |
| 4 | `showFloatContextMenu()` | FLOAT_CONTEXT_MENU | 右键菜单 | ✅ L301 |
| 5 | `onFloatUnread(cb)` | FLOAT_UNREAD | 监听未读计数 | ✅ L324 |
| 6 | `onLastMessage(cb)` | FLOAT_LAST_MESSAGE | 监听最后一条消息预览 | ✅ L356 |
| 7 | `onSpriteEvent(cb)` | SPRITE_EVENT | 监听精灵事件（在场状态等） | ✅ L375 |
| 8 | `onThemeBroadcast(cb)` | THEME_BROADCAST | 监听主题变更 | ✅ L404 |
| 9 | `removeFloatUnreadListener()` | FLOAT_UNREAD | 移除未读计数监听 | ❌ 未调用（暴露保持完整性） |
| 10 | `removeLastMessageListener()` | FLOAT_LAST_MESSAGE | 移除消息监听 | ✅ L425 |
| 11 | `removeSpriteEventListener()` | SPRITE_EVENT | 移除精灵事件监听 | ❌ 未调用（暴露保持完整性） |
| 12 | `removeThemeBroadcastListener()` | THEME_BROADCAST | 移除主题监听 | ✅ L423 |

> **排雷修正**：原方案列 11 API，排雷发现遗漏 `removeFloatUnreadListener`（preload.ts:653+1004）。float.ts 当前未调用 #9/#11，但与其他 listener 配对暴露保持 API 完整性。

## 候选方案对比

### 方案 A：浮动窗口 preload 独立化（推荐 ⭐）

- **做法**：新增 preload-float.ts，仅暴露 11 API；floatWindow.ts 改用 preload-float.cjs
- **参照**：preload-quick-input.ts 模式（已验证）
- **优点**：
  - 安全收益直接（-96% 暴露面）
  - 改动小（1 新增 + 1 修改 + 1 tsconfig + 1 ADR）
  - 符合 ADR-SP-017 窗口管理器内联 IPC 模式
  - 符合 ADR-017 架构先行——浮动窗口作为"第 2 个独立窗口"触发架构归属评估
- **缺点**：3 个 preload 文件，公共 API 重复（但 11 个 API 与主 preload 无重复——浮动窗口 API 全是 float 专用）
- **风险**：低（参照已验证模式）

### 方案 B：preload 功能域分文件 + 构建时合并

- **做法**：preload.ts → preload/{chat,session,memory,...}.ts（17 功能域），构建时合并为单 preload.cjs
- **优点**：开发时可读性好
- **缺点**：
  - 构建流程复杂化（需新增合并脚本）
  - 与 sandbox: true 限制冲突需验证
  - 引入新抽象（生成器），违反 ADR-017 枝叶层 2 次提取原则（未达 2 次提取阈值）
- **风险**：中（构建流程变更影响面广）
- **结论**：**不推荐**——过早抽象

### 方案 C：保持现状 + ADR §影响更新

- **做法**：preload.ts 不变，仅更新 ADR-SP-017 §影响 "100+ API" → "266 API"
- **优点**：零代码改动
- **缺点**：不解决浮动窗口暴露面过度问题（24x）
- **风险**：零
- **结论**：**不推荐**——错失高 ROI 安全收益

## 推荐方案：A（排雷修正后）

### 步骤排序（自底向上 + 风险前置）

#### 步骤 1：新增 preload-float.ts（开发层）

- 参照 [preload-quick-input.ts](../../hosts/memora-sprite/src/electron/preload-quick-input.ts) 结构
- 内联 4 个浮动窗口 IPC 通道常量（MOVE_FLOAT_WINDOW / SAVE_FLOAT_POSITION / EXPAND_TO_FULL / FLOAT_CONTEXT_MENU，源自 [ipc/channels.ts](../../hosts/memora-sprite/src/electron/ipc/channels.ts) L207-213）
- 内联 4 个主→渲染通道（FLOAT_UNREAD / FLOAT_LAST_MESSAGE / SPRITE_EVENT / THEME_BROADCAST，源自 channels.ts L289-309）
- 暴露 12 API 方法（含 4 个 on* + 4 个 remove* + 4 个动作 API）
- 顶部注释标注"与 channels.ts 保持手动同步（参照 preload-quick-input.ts 模式，不新增 parity 测试）"
- **验证**：TypeScript 编译通过；channelParity.test.ts 不受影响（该测试仅断言 preload.ts 键集与 channels.ts 完全相同，preload-float.ts 不在测试范围）

#### 步骤 2：更新构建配置（构建层）—— 排雷扩展

**2a. tsconfig.preload.json**
- `include` 数组新增 `"src/electron/preload-float.ts"`

**2b. build-preload.mjs**（排雷发现：硬编码 copyPreload 列表）
- 新增 `copyPreload('preload-float')` 调用
- 新增 `staleFloatJsPath` / `staleFloatMapPath` 清理（参照 L24-27 stale 模式）
- 更新 L9 注释"主窗口 + float 浮窗" → "主窗口"（浮动窗口已独立）

- **验证**：`npm run build:electron` 完整流程通过，产出 `dist-electron/electron/preload-float.cjs`

#### 步骤 3：切换 floatWindow.ts preload 引用（运行时层）

- [floatWindow.ts:69](../../hosts/memora-sprite/src/electron/windows/floatWindow.ts#L69) — `preload.cjs` → `preload-float.cjs`
- **验证**：浮动窗口启动正常 + 12 API 全部可用 + 高危 API（deleteMemory / installSkill / saveLlmProvider / clearAuditLog）不再可访问

#### 步骤 4：更新 ADR-SP-017（规则层）

- §影响 L101 — "100+ API" 更新为 "266 API（主窗口），浮动窗口已独立为 12 API（preload-float.ts）"
- §何时回顾 L105 — 标注"浮动窗口 preload 独立化已实施（2026-07-17），触发条件'quick-input 窗口数 > 1'等价满足（浮动窗口作为第 2 个独立窗口）"
- **验证**：年轮审判规则一致性检查通过

#### 步骤 5：更新待完成任务.md（任务层）

- AUDIT-0717-1 状态从"⏸️ 观察期"→"✅ 已完成"
- 迁移到已完成任务.md
- **验证**：任务清单迁移规范符合 grow-plan-template.md

## 约束条件

- **sandbox: true 不变**——preload-float.ts 必须是单 CommonJS 文件，不能运行时导入外部模块
- **IPC 通道常量内联**——与 [ipc/channels.ts](../../hosts/memora-sprite/src/electron/ipc/channels.ts) 保持手动同步（已有 channelParity.test.ts 防护机制可参照）
- **contextBridge 暴露名**——保持 `electronAPI`（与主 preload 同名，渲染层无感切换）
- **不引入类型重新导出**——preload-float.ts 自包含类型定义（参照 preload-quick-input.ts 模式）
- **不修改主 preload.ts**——主窗口 + 未来其他完整 UI 窗口继续使用 preload.ts

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 浮动窗口 API #11（removeSpriteEventListener）不存在 | 中 | 低 | 排雷阶段验证；不存在则不暴露 |
| 浮动窗口启动后某 API 缺失 | 低 | 中 | 11 API 来源于 float.ts 全量扫描，覆盖完整 |
| channelParity.test.ts 失败 | 低 | 低 | 浮动窗口通道不在主 preload parity 范围 |
| 构建产物 preload-float.cjs 路径错误 | 低 | 高 | 步骤 2 验证构建产出 |

## 何时回顾本方案

- 当浮动窗口需要新增 API（如显示记忆摘要）时，评估是否仍保持独立 preload
- 当主 preload.ts 也需要拆分时（突破 1500 行），评估是否统一 preload 拆分策略
