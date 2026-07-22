# Step 7 · Sprite 渲染层 helpers + controllers + 入口审查

> **审查日期**：2026-07-19
> **审查模式**：问诊·炼化归元（规则对齐 → 剪枝 → 提交前审查）
> **审查范围**：`hosts/memora-sprite/src/electron/renderer/` 入口 + controllers + helpers（~14600 行，50+ 文件）
>   - `helpers/`（40+ 文件）：uiDelegations/ 子目录 6 文件 + applyMixins/buttonHelpers/chatPanelEvents/completionHelpers/completionMetrics/domHelpers/errorHelpers/errorState/eventTracker/formValidation/icon/initFailureCard/memoryDetailPanel/memoryPanelEvents/memoryTimelineView/memoryViewSwitcher/messageDecorations/messageOperations/narrativeGenerator/perceptionLabels/providerManagement/relationGraphColor/relationGraphGeometry/relationGraphLayout/relationGraphTypes/safeStorage/safeTimer/scrollController/shortcutCapture/sourceColor/streamSafetyTimer/toolCallCard 等
>   - `controllers/`（4 文件）：memoryController / personaController / sessionController / settingsController
>   - 入口（6 文件）：renderer.ts / ui.ts / ipcListeners.ts / initHelpers.ts / types.ts / index.html

---

## 一、规则对齐（已对齐 X=1 项）

### ✅ 1.1 directory-structure.md v2.2 升级

**问题**：`helpers/` 目录实际存在 4 个文件未在规则中登记：
- `buttonHelpers.ts`（按钮 loading 状态辅助，从 settingsPanelManager 提取）
- `completionHelpers.ts`（补全结果聚合辅助）
- `completionMetrics.ts`（补全埋点统计）
- `safeStorage.ts`（安全存储辅助）

此外，`providerManagement.ts` / `memoryPanelEvents.ts` 等 helper 文件以**类形式**封装（导出函数 + Context 接口注入），与 `helpers/` 目录"纯函数模块"传统约定有形态差异，但此前规则未明确说明此类形式是否被允许。

**修复**：
- §1 helpers 节补登 4 文件
- §1 helpers 节追加"类形式例外注释"：明确 helper 文件允许以"导出函数 + Context 接口注入"形式存在（非 class 形式），与 panels/ 的 class 形式区分
- 头部"当前状态"追加本次升级说明
- 版本号 v2.1 → v2.2
- §3 迁移步骤追加 RULE-ALIGN-0719 条目

**收益**：消除规则与代码的形态偏差，新开发者通过 directory-structure.md 能完整索引所有 helper 文件

---

## 二、剪枝（已剪枝 Y=2 处死代码 + 60+ 处去痕）

### ✅ 2.1 dashboardDelegations.ts 死代码 re-export

**位置**：`helpers/uiDelegations/dashboardDelegations.ts`
**剪枝前**：
- 第 28 行 import `ProactiveStats` 类型
- 第 153-155 行 re-export `ProactiveStats`

**验证**：Grep 全仓扫描确认 `ProactiveStats` 类型零外部引用（仅本文件 re-export 自身，形成自引用闭环）

**剪枝后**：删除 import + re-export
**收益**：消除 3 行死代码

### ✅ 2.2 memoryController.ts 死代码导出

**位置**：`controllers/memoryController.ts`
**剪枝前**：return 对象中导出 2 个无引用方法
- `loadHealthDashboard`（原 line 914）
- `updateNarrative`（原 lines 961-968）

**验证**：Grep 全仓扫描确认两方法零外部调用

**剪枝后**：从 return 对象移除两方法
**收益**：消除 9 行死代码导出

### ✅ 2.3 剪枝去痕（17 个文件 ~60+ 处 AI 修改痕迹）

**识别项**：任务编号前缀（F1/F7/B1/G3/UX-xxxx/Phase x 等）+ 新旧对比文案（"已移至/不再/现为/替代旧的/原方案"）+ 修复说明注释 + 自我代码风格说明 + 开发过程术语（"剪枝："）

**清理清单**：

| 文件 | 清理数 | 典型痕迹 |
|------|--------|----------|
| `helpers/chatPanelEvents.ts` | 1 | `B1：` 前缀 |
| `helpers/domHelpers.ts` | 4 | `U5`/`U6`/`剪枝：` 前缀 |
| `helpers/memoryDetailPanel.ts` | 4 | `Phase 5.1/5.2`/`R5` 前缀 |
| `helpers/memoryTimelineView.ts` | 1 | 自我代码风格说明 |
| `helpers/memoryViewSwitcher.ts` | 2 | 自我风格 + `B2:` 前缀 |
| `helpers/messageDecorations.ts` | 2 | `Phase 3`/`UX-08` 前缀 |
| `helpers/messageOperations.ts` | 1 | `Phase 1` + 修复说明 |
| `helpers/providerManagement.ts` | 5 | `UX-0712-x`/`UX-0713-F5/F6` 前缀 |
| `helpers/relationGraphTypes.ts` | 1 | `F-LINE-2` 前缀 |
| `helpers/scrollController.ts` | 1 | `CHAT-A05` 前缀 |
| `helpers/uiDelegations/memoryDelegations.ts` | 1 | `G3：` 前缀 |
| `helpers/memoryPanelEvents.ts` | 8+ | `G3`/`UX-0712-6`/`B2`/`Phase 3` 前缀 + 章节序号修正 + 修复说明 |
| `controllers/memoryController.ts` | 20+ | `P1`/`F6`/`F7`/`UX-0713-L6`/`Phase` 前缀 + 新旧对比文案 |
| `controllers/settingsController.ts` | 3 | `UX-0713-F2`/`AUDIT-5-4`/`Phase 3.3` 前缀 + 对比文案 |
| `ipcListeners.ts` | 11 | `P4`/`Phase 3.x`/`Phase 4` 前缀 + 旧代码/替代旧的/原方案文案 |
| `types.ts` | 2 | "保持向后兼容"/"消除 4 处内联重复定义" 重构说明 |
| `index.html` | 13+ | `UX-0713-x`/`AUDIT-5-4`/`G3`/`Phase` 前缀（HTML 注释） |

**收益**：代码注释回归"描述当前是什么"而非"曾经是什么/为何修改"，符合"剪枝去痕"原则——历史决策应在 ADR/tasks 中追溯，代码注释只描述当前状态

---

## 三、提交前审查（已审查修复 Z=2 项）

### ✅ 3.1 ipcListeners.ts isTrashPurgedPayload 风格不一致

**位置**：`ipcListeners.ts:510-518`
**问题**：使用 `typeof payload === 'object' && payload !== null` + `(payload as Record<string, unknown>)` 内联判断，与同文件其他 9+ 个类型守卫（isProactivePromptPayload/isConflictDetectedPayload/isAffectPayload 等）统一使用 `isObject()` helper 风格不一致

**修复**：
```typescript
// 修复前（5 行）：
return (
  typeof payload === 'object' &&
  payload !== null &&
  typeof (payload as Record<string, unknown>).purgedCount === 'number'
);

// 修复后（1 行）：
return isObject(payload) && typeof payload.purgedCount === 'number';
```

**收益**：风格统一 + 行数缩减 4 行 + 消除冗余 `as` 断言

### ✅ 3.2 ipcListeners.ts isPatternsPayload 冗余 as 断言

**位置**：`ipcListeners.ts:229-241`
**问题**：在 `isObject(p)` 类型谓词已收窄 `p` 为 `Record<string, unknown>` 后，仍重复使用 `(p as Record<string, unknown>)` 断言 3 次，违反"零 `as any` / 冗余断言"约束

**修复**：
```typescript
// 修复前：
(p: unknown) =>
  isObject(p) &&
  typeof (p as Record<string, unknown>).type === 'string' &&
  typeof (p as Record<string, unknown>).summary === 'string' &&
  typeof (p as Record<string, unknown>).confidence === 'number',

// 修复后：
(p: unknown) =>
  isObject(p) &&
  typeof p.type === 'string' &&
  typeof p.summary === 'string' &&
  typeof p.confidence === 'number',
```

**收益**：消除 3 处冗余 `as` 断言，类型守卫语义不变

---

## 四、验证结果

| 验证项 | 结果 |
|--------|------|
| TypeScript 编译（`tsc --noEmit`） | ✅ 0 错误 |
| AI 修改痕迹 Grep 扫描（Step 7 范围内） | ✅ 零残留 |
| 死代码引用 Grep 扫描 | ✅ ProactiveStats / loadHealthDashboard / updateNarrative 零外部引用 |

---

## 五、归档待办（K=7 项，归档到 tasks/待完成任务.md）

### P2 观察项（4 项，待自然生长触发）

| ID | 任务 | 位置 | 建议 |
|----|------|------|------|
| SPRITE-0719-P2-1 | memoryController 6 处直接调用 setButtonLoading 绕过 UIManager 门面 | memoryController.ts:457/476/483/497/509/521 | 待自然生长触发：当前 UIManager 已暴露 setButtonLoading，6 处直接调用 helper 仅为缩短信道。等出现第 7 处或 UIManager 接口扩展时统一收敛 |
| SPRITE-0719-P2-2 | memoryController 直接 import + 实例化 panels/llmGovernanceResultRenderer | memoryController.ts:29/96 | 待自然生长触发：违反 controllers → panels 单向依赖原则。当前仅 1 处，等 panels 渲染器扩展时通过 UIManager 中介收敛 |
| SPRITE-0719-P2-3 | settingsController 直接访问 panel manager 内部 | settingsController.ts:211 | 待自然生长触发：等下次重构 settings panel 时通过公共方法暴露收敛 |
| SPRITE-0719-P2-4 | providerManagement 模块级可变状态 loadToken/isSavingProvider | providerManagement.ts:133/382 | 待自然生长触发：5 处模块级 state 语义不同（竞态守卫/重入保护/节流时间戳），强行收敛违反单一职责。等第 6、7 处类似 state 出现时再触发提取 |

### P3 观察项（3 项，待自然生长触发）

| ID | 任务 | 位置 | 建议 |
|----|------|------|------|
| SPRITE-0719-P3-1 | memoryController 3 类同构模式可提取（withButtonLoading/performRelationOperation/withConfirmAndRefresh） | memoryController.ts 多处 | 待自然生长触发：当前 3 类模式各 2-3 处，触发提取阈值 2 次已满足，但提取后参数化复杂度高，等下次该 controller 大改时一并处理 |
| SPRITE-0719-P3-2 | ipcListeners 感知 payload 类型真理源分散 | ipcListeners.ts 多 interface | 待自然生长触发：感知数据类型真理源应在 sprite/controllers 而非 renderer/ipcListeners，等下次 IPC 类型重构时统一迁移 |
| SPRITE-0719-P3-3 | types.ts S-03 类型分散未解决 | types.ts | 待自然生长触发：S-03 是 Step 1-6 历史遗留项，等下次渲染层类型重构时一并处理 |

---

## 六、与 Step 1-6 衔接

- Step 1-4：已完成 memora 内核 + sprite 主进程 + 控制器 + Web 服务层审查
- Step 5：sprite Web 服务层（src/web/routes/）审查
- Step 6：sprite 渲染层 panels + components 审查
- Step 7（本次）：sprite 渲染层 helpers + controllers + 入口审查
- **下一步**：Step 8 — sprite 样式层（src/electron/renderer/styles/）审查

---

## 七、修改文件清单

| 文件 | 修改类型 | 行数变化 |
|------|----------|----------|
| `.trae/rules/directory-structure.md` | §1 helpers 节补登 4 文件 + 类形式例外注释 + 版本号 v2.2 + RULE-ALIGN-0719 | +15 行 |
| `helpers/uiDelegations/dashboardDelegations.ts` | 删除 ProactiveStats 未使用 import + re-export | -3 行 |
| `controllers/memoryController.ts` | 移除 loadHealthDashboard + updateNarrative 死代码导出 + 20+ 处去痕 | -11 行 |
| `helpers/chatPanelEvents.ts` | `B1：` 前缀清理 | ±0 行 |
| `helpers/domHelpers.ts` | 4 处 `U5`/`U6`/`剪枝：` 前缀清理 | ±0 行 |
| `helpers/memoryDetailPanel.ts` | 4 处 `Phase 5.1/5.2`/`R5` 前缀清理 | ±0 行 |
| `helpers/memoryTimelineView.ts` | 自我代码风格说明清理 | -1 行 |
| `helpers/memoryViewSwitcher.ts` | 自我风格 + `B2:` 前缀清理（2 处） | ±0 行 |
| `helpers/messageDecorations.ts` | `Phase 3`/`UX-08` 前缀清理（2 处） | ±0 行 |
| `helpers/messageOperations.ts` | `Phase 1` + 修复说明清理 | ±0 行 |
| `helpers/providerManagement.ts` | 5 处 `UX-0712-x`/`UX-0713-F5/F6` 前缀清理 | ±0 行 |
| `helpers/relationGraphTypes.ts` | `F-LINE-2` 前缀清理 | ±0 行 |
| `helpers/scrollController.ts` | `CHAT-A05` 前缀清理 | ±0 行 |
| `helpers/uiDelegations/memoryDelegations.ts` | `G3：` 前缀清理 | ±0 行 |
| `helpers/memoryPanelEvents.ts` | 8+ 处 `G3`/`UX-0712-6`/`B2`/`Phase 3` 前缀 + 章节序号修正 + 修复说明清理 | -5 行 |
| `controllers/settingsController.ts` | 3 处 `UX-0713-F2`/`AUDIT-5-4`/`Phase 3.3` 前缀 + 对比文案清理 | ±0 行 |
| `ipcListeners.ts` | 11 处 `P4`/`Phase 3.x/4` 前缀 + 旧代码/替代旧的/原方案文案清理 + isTrashPurgedPayload 改 isObject + isPatternsPayload 移除 3 处冗余 as 断言 | -10 行 |
| `types.ts` | 2 处"保持向后兼容"/"消除 4 处内联重复定义"重构说明清理 | ±0 行 |
| `index.html` | 13+ 处 `UX-0713-x`/`AUDIT-5-4`/`G3`/`Phase` 前缀清理（HTML 注释） | ±0 行 |

**净行数变化**：约 -15 行（含死代码删除 + isTrashPurgedPayload 简化 + 冗余 as 断言清理，去痕为 ±0）

---

_审查完成时间：2026-07-19_
_下一步：进入 Step 8（sprite 样式层）_
