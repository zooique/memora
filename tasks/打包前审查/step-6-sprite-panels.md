# Step 6 · Sprite 渲染层面板与组件层 · 打包前审查报告

> **审查模式**：问诊·炼化归元（规则对齐 → 剪枝 → 提交前审查）
> **审查范围**：sprite 渲染层面板与组件层 37 文件 ~14000 行
>   - `src/electron/renderer/panels/`（28 文件，archiveButtonManager/auditPanelManager/badgeManager/chatPanelManager/clipboardManager/commandPaletteManager/dashboardPanelManager/dateNavManager/healthDashboardRenderer/inputAreaManager/insightsRenderer/llmGovernanceResultRenderer/memoryGraphPanel/memoryPanelManager/panelErrorBannerManager/panelRouter/perceptionPanelManager/personaPanelManager/profilePanelManager/searchMessagesManager/settingsPanelManager/skillDropManager/spriteStatusPopover/streamingRenderer/workProjectionPanelManager 等）
>   - `src/electron/renderer/components/`（9 文件，markdown/modal/onboarding/proactiveBanner/relationGraph/startupSummaryBanner/suggestionCard/themeManager/toast）
> **审查日期**：2026-07-19
> **执行模式**：问诊·炼化归元
> **测试基线**：64 测试文件 / 2279 测试通过 / 0 失败（renderer 全量）
> **后续衔接**：Step 7（sprite 渲染层 helpers + 入口）

---

## 1. 规则对齐

### 1.1 已对齐项（合规无问题）

| # | 规则 | 验证方式 | 结果 |
|---|------|----------|------|
| AL-1 | project-rules §7.1 零容忍 `@ts-ignore` / `as any` | Grep 全量扫描 panels/ + components/ 37 文件 | ✅ 0 处违规 |
| AL-2 | project-rules §7.1 零容忍生产 `console.*` | Grep 全量扫描 | ✅ 0 处违规（renderer 统一走 reportError/reportWarn 入口） |
| AL-3 | coding-convention §2 不吞异常（无空 catch 块） | 子代理扫描 37 文件 | ✅ 0 处违规 |
| AL-4 | 无 TODO/FIXME/XXX/HACK 遗留 | Grep 全量扫描 | ✅ 0 处违规 |
| AL-5 | renderer/ 四层分层（controllers/helpers/panels/components） | LS 验证目录结构 | ✅ 四层独立，无跨层违规 |
| AL-6 | Panel 命名前缀 completion-stats- / llm-result- | 验证 completionStatsRenderer.ts / llmGovernanceResultRenderer.ts | ✅ 命名前缀已对齐（completion-stats- 已用于 CompletionStatsRenderer 文件名，llm-result- 已用于 LlmGovernanceResultRenderer 类内 DOM 命名） |
| AL-7 | ADR-SP-015 Panel Manager 组合模式（不提取基类） | UIManager 持有各 PanelManager 实例模式扫描 | ✅ 28 个 Panel Manager 均通过组合持有，未提取基类 |
| AL-8 | project-rules §7.4 Agent 门面不直接输出终端 | panels/ + components/ 不直接调用 process.stdout | ✅ 全部走 DOM 渲染 |
| AL-9 | ADR-017 枝叶层 2 次提取 | 重复模式扫描（clearElement/escapeHtml/formatTimeAgo 等） | ✅ 已提取至 helpers/domHelpers.js + shared/escapeRegExp.js + shared/truncate.js + helpers/relationGraph*.js 等 |
| AL-10 | coding-convention §3 函数/类/文件级注释 | 37 文件抽样 | ✅ 文件级 JSDoc + 类级注释 + 函数级注释齐全 |
| AL-11 | 主动可见原则（操作按钮不依赖 hover 显示） | 关键面板按钮扫描 | ✅ archiveButtonManager / commandPaletteManager / searchMessagesManager 等操作按钮均常驻可见 |
| AL-12 | state 自管理（每个 Panel 自管理状态，不全局共享） | PanelManager 字段扫描 | ✅ 每个 PanelManager 自持 state，无全局 store |
| AL-13 | EventTracker 模式（统一事件监听器管理） | panels/ + components/ addEventListener 跟踪 | ⚠️ 大部分已纳入 EventTracker，少数函数式模块裸 addEventListener 归档待办（STEP6-3/6/7） |

### 1.2 规则对齐发现的违规

| ID | 规则 | 文件:行号 | 性质 |
|----|------|----------|------|
| AL-V1 | coding-convention §异常体系 | onboarding.ts:452 | `throw new Error(result.error \|\| '保存失败')` 裸 throw → 已修复（见 §3.1 QC-1） |
| AL-V2 | renderer/ 四层分层中"函数式模块"事件管理一致性 | streamingRenderer.ts / memoryGraphPanel.ts / spriteStatusPopover.ts / modal.ts | 部分函数式模块未纳入 EventTracker → 归档待办（STEP6-3/6/7） |
| AL-V3 | project_memory.md "localStorage 不可靠"教训 | clipboardPanelManager.ts:395,421 | localStorage 用于 onboarding dismissed 状态 → 归档待办（STEP6-2） |
| AL-V4 | directory-structure.md 规则文档同步 | `hosts/memora-sprite/.trae/rules/directory-structure.md` | 文档未列 clipboardPanelManager/completionStatsRenderer/llmGovernanceResultRenderer/startupSummaryBanner 4 个新文件 → 归档待办（STEP6-5） |

---

## 2. 剪枝

### 2.1 已剪枝项（本次完成）

#### 2.1.1 修改痕迹注释清理（grower skill DON'T）

| ID | 范围 | 数量 | 描述 |
|----|------|------|------|
| PR-1 | onboarding.ts | 4 处 | 清理 AUDIT-5-4 系注释（行 115/482/516/526），保留当前状态描述 |
| PR-2 | settingsPanelManager.ts | 7 处 | 清理 AUDIT-5-4 系（行 105/380/477/537/741/808/920）+ "已提取到 shortcutCapture" 痕迹，统一为当前状态描述 |
| PR-3 | chatPanelManager.ts | 5 处 | 清理"修复 UTC 跨天 bug"（行 383）+ "B1：新增"/"新增"（行 806-807）+ "Phase 2："（行 859）+ "翠幕天罗 P2：补齐"（行 1111）|
| PR-4 | searchMessagesManager.ts | 1 处 | 清理行 306-310 "修复 P1 断点（R1）"+"修复策略"块，改为当前状态描述 |
| PR-5 | dashboardPanelManager.ts | 3 处 | 清理"Phase 6.2：新增"（行 201）+ "安全审计修复"（行 570/603）|
| PR-6 | profilePanelManager.ts | 1 处 | 清理 "Q9 使用 clearElement 工具函数替代手写 while+removeChild" → "使用 clearElement 工具函数清空容器" |
| PR-7 | memoryPanelManager.ts | 1 处 | 清理 "getSourceColorClass 已提取到模块顶层" → "getSourceColorClass 位于模块顶层" |
| PR-8 | spriteStatusPopover.ts | 1 处 | 清理 "统一真理源，修复文案不一致 + 阈值硬编码" → "统一真理源" |
| PR-9 | suggestionCard.ts | 2 处 | 清理行 137 "U3 用 createElement 替代 innerHTML 模板" + 行 246 "剪枝：复用 domHelpers.clearElement" |
| PR-10 | relationGraph.ts | 2 处 | 清理行 71 "ADR-017 枝叶层 2 次提取，修复跨显示器 dpr 不更新 bug" → "ADR-017 枝叶层 2 次提取产物"；行 614 "修复跨显示器移动后 dpr 不更新" → "支持跨显示器移动后 dpr 更新，避免渲染模糊" |

**剪枝合计**：10 文件 28 处 AI 修改痕迹全部清理。

#### 2.1.2 重复模式识别（ADR-017 枝叶层 2 次提取）

| ID | 模式 | 文件 | 触发次数 | 处置 |
|----|------|------|---------|------|
| PR-11 | clearElement（while+removeChild 替代） | helpers/domHelpers.js + suggestionCard.ts + profilePanelManager.ts + memoryPanelManager.ts 等 | 已提取 | ✅ 已在 domHelpers.js 中提供，本次仅清理未引用注释 |
| PR-12 | relationGraph 模块拆分 | relationGraph.ts → helpers/relationGraphTypes/Layout/Color/Geometry.js | 已提取 | ✅ 枝叶层 2 次提取产物，本次仅清理变更说明痕迹 |
| PR-13 | escapeRegExp / truncate | shared/escapeRegExp.js + shared/truncate.js | 已提取 | ✅ 跨模块复用 |

### 2.2 重复代码（候选，未触发或暂缓）

| ID | 文件 | 重复次数 | 描述 | 处置 |
|----|------|---------|------|------|
| PR-14 | spriteStatusPopover.ts:55-66 + modal.ts 多处 | 6+11 处 | 裸 addEventListener 未纳入 EventTracker | 归档待办（STEP6-6/7） |
| PR-15 | 5 文件超 800 行 | — | memoryPanelManager 1322 / chatPanelManager 1240 / settingsPanelManager 1161 / relationGraph 995 / dashboardPanelManager 904 | 归档待办（STEP6-8） |

### 2.3 死代码（P3 · 归档观察）

本次范围内无新增死代码。原有 STEP3-1 pin-toggle 死代码已在 Step 3 归档。

### 2.4 硬编码不一致（P3 · 归档观察）

| ID | 文件 | 描述 | 处置 |
|----|------|------|------|
| PR-16 | 5 文件超 800 行（含硬编码常量分散） | relationGraph / dashboardPanelManager 等大文件中常量分散 | 归档待办（STEP6-8）|

---

## 3. 提交前审查

### 3.1 已审查修复（本次完成）

| ID | 类型 | 文件:行号 | 问题 | 修复 | 验证 |
|----|------|----------|------|------|------|
| QC-1 | 裸 throw 改造（coding-convention §异常体系） | onboarding.ts:452 | `throw new Error(result.error \|\| '保存失败')` 违反 SpriteError 体系 | 改为 `throw new SpriteError(ErrorCode.STORAGE_ERROR, result.error \|\| '保存失败')`；新增 `import { SpriteError, ErrorCode } from '../../../sprite/errors.js';` | ✅ tsc --noEmit 通过 + 2279 测试全通过 |
| QC-2 | 修改痕迹注释（PR-1） | onboarding.ts | 4 处 AUDIT-5-4 系注释（行 115/482/516/526） | 全部清理为当前状态描述 | ✅ tsc --noEmit 通过 |
| QC-3 | 修改痕迹注释（PR-2） | settingsPanelManager.ts | 7 处修改痕迹（行 105/380/477/537/741/808/920，AUDIT-5-4 系 + "已提取到 shortcutCapture"） | 全部清理为当前状态描述 | ✅ tsc --noEmit 通过 |
| QC-4 | 修改痕迹注释（PR-3） | chatPanelManager.ts | 5 处修改痕迹（行 383 "修复 UTC 跨天 bug" + 行 806-807 "B1：新增"/"新增" + 行 859 "Phase 2：" + 行 1111 "翠幕天罗 P2：补齐"） | 全部清理为当前状态描述 | ✅ tsc --noEmit 通过 |
| QC-5 | 修改痕迹注释（PR-4） | searchMessagesManager.ts | 行 306-310 "修复 P1 断点（R1）"+"修复策略"块 | 改为当前状态描述 | ✅ tsc --noEmit 通过 |
| QC-6 | 修改痕迹注释（PR-5） | dashboardPanelManager.ts | 3 处（行 201 "Phase 6.2：新增" + 行 570/603 "安全审计修复"） | 全部清理为当前状态描述 | ✅ tsc --noEmit 通过 |
| QC-7 | 修改痕迹注释（PR-6） | profilePanelManager.ts | 1 处 "Q9 使用 clearElement 工具函数替代手写 while+removeChild" | 改为 "使用 clearElement 工具函数清空容器" | ✅ tsc --noEmit 通过 |
| QC-8 | 修改痕迹注释（PR-7） | memoryPanelManager.ts | 1 处 "getSourceColorClass 已提取到模块顶层" | 改为 "getSourceColorClass 位于模块顶层" | ✅ tsc --noEmit 通过 |
| QC-9 | 修改痕迹注释（PR-8） | spriteStatusPopover.ts | 1 处 "统一真理源，修复文案不一致 + 阈值硬编码" | 改为 "统一真理源" | ✅ tsc --noEmit 通过 |
| QC-10 | 修改痕迹注释（PR-9） | suggestionCard.ts | 2 处（行 137 "U3 用 createElement 替代 innerHTML 模板" + 行 246 "剪枝：复用 domHelpers.clearElement"） | 全部清理为当前状态描述 | ✅ tsc --noEmit 通过 |
| QC-11 | 修改痕迹注释（PR-10） | relationGraph.ts | 2 处（行 71 "ADR-017 枝叶层 2 次提取，修复跨显示器 dpr 不更新 bug" + 行 614 "修复跨显示器移动后 dpr 不更新"） | 改为 "ADR-017 枝叶层 2 次提取产物" + "支持跨显示器移动后 dpr 更新，避免渲染模糊" | ✅ tsc --noEmit 通过 |

**已审查修复合计**：11 项（1 项裸 throw 改造 + 10 文件 28 处修改痕迹批量清理）。

### 3.2 归档待办（P1/P2/P3 · 移交待完成任务.md）

| ID | 优先级 | 类型 | 文件:行号 | 任务 |
|----|--------|------|----------|------|
| STEP6-1 | 🟡 P1 | 资源清理 | onboarding.ts | OnboardingManager 缺失 cleanup() 方法，10 处裸 addEventListener 未纳入 EventTracker。补 cleanup() 方法 + 改用 EventTracker |
| STEP6-2 | 🟡 P1 | 教训对齐 | clipboardPanelManager.ts:395,421 | localStorage 用于 onboarding dismissed 状态，违反"localStorage 不可靠"教训。建议迁移到主进程 config 持久化（preload IPC） |
| STEP6-3 | 🟡 P1 | 资源清理 | streamingRenderer.ts / memoryGraphPanel.ts | 函数式模块缺失统一 cleanup 入口，事件监听器零散注册。评估补 cleanup() 函数 + EventTracker |
| STEP6-4 | 🟢 P2 | 命名一致性 | relationGraph.ts:339 | destroy() 命名与 cleanup() 不一致。Canvas 行业惯例为 destroy()，可保留，归档观察 |
| STEP6-5 | 🟢 P2 | 规则文档同步 | `hosts/memora-sprite/.trae/rules/directory-structure.md` | 文档未列 4 个新文件：clipboardPanelManager.ts / completionStatsRenderer.ts / llmGovernanceResultRenderer.ts / startupSummaryBanner.ts |
| STEP6-6 | 🟢 P2 | 事件监听器治理 | spriteStatusPopover.ts:55-66 | 6 处裸 addEventListener 未纳入 EventTracker。评估改造为 EventTracker 模式 |
| STEP6-7 | 🟢 P2 | 事件监听器治理 | modal.ts | 11 处裸 addEventListener（promise 内）。评估改造为 EventTracker 模式（注意 promise 生命周期与 EventTracker.cleanup() 时机） |
| STEP6-8 | 🟢 P3 | 文件长度监控 | memoryPanelManager.ts(1322) / chatPanelManager.ts(1240) / settingsPanelManager.ts(1161) / relationGraph.ts(995) / dashboardPanelManager.ts(904) | 5 文件超 800 行阈值，评估继续按 memoryPanelManager 拆分模式（helpers/ 子模块）拆分 |
| STEP6-9 | 🟢 P3 | DOM 查询治理 | panels/ + components/ 125 处 | document.getElementById 直接调用 125 处（LONG-C19 已归档），本次仅统计，不新增 |
| STEP6-10 | 🟢 P3 | API 注入治理 | panels/ + components/ 33 处 | window.electronAPI 直接调用 33 处。建议长期抽 Host 接口注入（与 MemoryPanelHost 同模式） |

### 3.3 文件长度监控

| 文件 | 当前行数 | 阈值 | 状态 |
|------|---------|------|------|
| memoryPanelManager.ts | 1322 | 800 | ⚠️ 超阈值（已拆分多个 helpers/ 子模块，仍超） |
| chatPanelManager.ts | 1240 | 800 | ⚠️ 超阈值 |
| settingsPanelManager.ts | 1161 | 800 | ⚠️ 超阈值 |
| relationGraph.ts | 995 | 800 | ⚠️ 超阈值（已拆分 4 个 helpers/relationGraph*.ts） |
| dashboardPanelManager.ts | 904 | 800 | ⚠️ 超阈值 |
| 其余 32 文件 | < 800 | 800 | ✅ 在控 |

5 文件超阈值，归档待办（STEP6-8）评估继续拆分。memoryPanelManager 已采用"helpers/memoryPanelEvents.ts + memoryDetailPanel.ts + memoryViewSwitcher.ts + memoryTimelineView.ts"拆分模式，可作为其他大文件拆分参考。

---

## 4. 已归档项重新评估

无。本次审查范围内无已归档项需重新评估。

---

## 5. 汇总

### 5.1 量化指标

| 维度 | 数量 |
|------|------|
| 已对齐项（AL-1 ~ AL-13） | 13 项 |
| 规则对齐违规（AL-V1 ~ AL-V4） | 4 项（1 项已修复 + 3 项归档待办） |
| 已剪枝识别（PR-1 ~ PR-16） | 16 项 |
| 已审查修复（QC-1 ~ QC-11） | 11 项（含 28 处修改痕迹批量清理 + 1 处裸 throw 改造） |
| 归档待办（STEP6-1 ~ STEP6-10） | 10 项（3 项 P1 + 4 项 P2 + 3 项 P3） |

### 5.2 优先级分布

| 优先级 | 数量 | 项目 |
|--------|------|------|
| 🔴 P0 零容忍 | 0 项 | — |
| 🟡 P1 归档待办 | 3 项 | STEP6-1（onboarding cleanup）+ STEP6-2（localStorage 迁移）+ STEP6-3（函数式模块 cleanup） |
| 🟡 P2 归档待办 | 4 项 | STEP6-4（destroy 命名）+ STEP6-5（文档同步）+ STEP6-6（spriteStatusPopover 事件治理）+ STEP6-7（modal 事件治理） |
| 🟢 P3 归档待办 | 3 项 | STEP6-8（5 文件超阈值）+ STEP6-9（DOM 查询治理）+ STEP6-10（API 注入治理） |

### 5.3 ADR-017 枝叶层 2 次提取触发清单

| 候选 | 触发次数 | 处置 |
|------|---------|------|
| clearElement（while+removeChild 替代） | 多处已用 | ✅ 已提取到 helpers/domHelpers.js |
| relationGraph 模块拆分 | 5+ 处重复模式 | ✅ 已拆分到 helpers/relationGraph{Types,Layout,Color,Geometry}.ts |
| escapeRegExp / truncate | 跨模块复用 | ✅ 已提取到 shared/ |
| EventTracker 模式 | 部分模块未用 | 归档 STEP6-1/3/6/7（评估推广） |

### 5.4 与 Step 1-5 对比

| 维度 | Step 1（agent+memory） | Step 2（infra 8 模块） | Step 3（sprite 主进程 35 文件） | Step 4（sprite 控制器 17 文件） | Step 6（sprite 渲染层 panels+components 37 文件） |
|------|------------------------|------------------------|-------------------------------|-------------------------------|------------------------------------------------|
| 已对齐项 | 10 项 | 32 项 | 18 项 | 13 项 | 13 项 |
| 规则对齐违规 | 3 项 | 1 项 | 7 项 | 4 项 | 4 项（1 已修复 + 3 归档） |
| 重复代码候选 | 5 项 | 2 项 | 11 项 | 5 项 | 3 项（已提取） |
| 死代码/死字段 | 1 项 | 0 项 | 1 项 | 2 项 | 0 项 |
| 修改痕迹注释 | 未单独统计 | 未单独统计 | 28 处 | 25 处 | 28 处（全部本次清理） |
| 已审查修复 | 0 项（全归档） | 0 项（全归档） | 0 项（全归档） | 5 项（含 25 处批量清理） | 11 项（含 28 处批量清理 + 1 处 throw 改造） |
| 归档待办 | 4 项 | 2 项 | 35 项 | 9 项 | 10 项 |
| 文件超 800 行 | 0 | 0 | 2（preload.ts + main.ts） | 0 | 5（memoryPanelManager / chatPanelManager / settingsPanelManager / relationGraph / dashboardPanelManager） |

Step 6 健康度评估：
- **0 项 P0**（与 Step 4 持平，优于 Step 3 的 1 项）
- **本次已审查修复 11 项**（含 28 处修改痕迹批量清理 + 1 处裸 throw 改造，与 Step 4 同步推进"扫描即修复"模式）
- **5 个文件超阈值**（多为面板管理器，已采用 helpers/ 拆分模式渐进收敛，归档观察）
- **28 处修改痕迹全部本次清理**（与 Step 3/4 节奏一致）

渲染层整体代码质量较高，主要健康问题是函数式模块事件治理不彻底（3 项 P1）+ 5 文件超阈值（P3）。归档待办 10 项均为 P1/P2/P3 观察项，不阻塞打包。

### 5.5 关键修复路径

**本次已完成**（11 项，单次提交）：
1. QC-1 onboarding.ts:452 裸 throw new Error → SpriteError(ErrorCode.STORAGE_ERROR) 改造
2. QC-2 onboarding.ts 4 处 AUDIT-5-4 注释清理
3. QC-3 settingsPanelManager.ts 7 处修改痕迹清理
4. QC-4 chatPanelManager.ts 5 处修改痕迹清理
5. QC-5 searchMessagesManager.ts 1 处修改痕迹清理
6. QC-6 dashboardPanelManager.ts 3 处修改痕迹清理
7. QC-7 profilePanelManager.ts 1 处修改痕迹清理
8. QC-8 memoryPanelManager.ts 1 处修改痕迹清理
9. QC-9 spriteStatusPopover.ts 1 处修改痕迹清理
10. QC-10 suggestionCard.ts 2 处修改痕迹清理
11. QC-11 relationGraph.ts 2 处修改痕迹清理

**归档待办**（10 项，不阻塞打包）：
- P1: STEP6-1（onboarding cleanup）+ STEP6-2（localStorage 迁移）+ STEP6-3（函数式模块 cleanup）
- P2: STEP6-4（destroy 命名）+ STEP6-5（文档同步）+ STEP6-6（spriteStatusPopover 事件治理）+ STEP6-7（modal 事件治理）
- P3: STEP6-8（5 文件超阈值）+ STEP6-9（DOM 查询治理）+ STEP6-10（API 注入治理）

---

## 6. Git Commit 建议

本次审查已修复 11 项（1 项裸 throw 改造 + 10 文件 28 处 AI 修改痕迹批量清理），建议单次提交：

```
refactor(sprite-renderer): 清理 28 处 AI 修改痕迹 + onboarding throw 改造

  - onboarding.ts:452 裸 throw new Error 改为 SpriteError(ErrorCode.STORAGE_ERROR)
    新增 import { SpriteError, ErrorCode } from '../../../sprite/errors.js'
    清理 4 处 AUDIT-5-4 系注释（行 115/482/516/526）

  - settingsPanelManager.ts: 清理 7 处修改痕迹
    AUDIT-5-4 系（行 105/380/477/537/741/808/920）+ "已提取到 shortcutCapture"
    统一为当前状态描述

  - chatPanelManager.ts: 清理 5 处修改痕迹
    "修复 UTC 跨天 bug"（行 383）+ "B1：新增"/"新增"（行 806-807）
    + "Phase 2："（行 859）+ "翠幕天罗 P2：补齐"（行 1111）

  - searchMessagesManager.ts:306-310: 清理 "修复 P1 断点（R1）"+"修复策略"块
    改为当前状态描述

  - dashboardPanelManager.ts: 清理 3 处修改痕迹
    "Phase 6.2：新增"（行 201）+ "安全审计修复"（行 570/603）

  - profilePanelManager.ts: 清理 1 处 "Q9 使用 clearElement 工具函数替代手写 while+removeChild"
    改为 "使用 clearElement 工具函数清空容器"

  - memoryPanelManager.ts: 清理 1 处 "getSourceColorClass 已提取到模块顶层"
    改为 "getSourceColorClass 位于模块顶层"

  - spriteStatusPopover.ts: 清理 1 处 "统一真理源，修复文案不一致 + 阈值硬编码"
    改为 "统一真理源"

  - suggestionCard.ts: 清理 2 处修改痕迹
    "U3 用 createElement 替代 innerHTML 模板"（行 137）
    + "剪枝：复用 domHelpers.clearElement"（行 246）

  - relationGraph.ts: 清理 2 处修改痕迹
    "ADR-017 枝叶层 2 次提取，修复跨显示器 dpr 不更新 bug"（行 71）
    → "ADR-017 枝叶层 2 次提取产物"
    "修复跨显示器移动后 dpr 不更新"（行 614）
    → "支持跨显示器移动后 dpr 更新，避免渲染模糊"

  验证：tsc --noEmit exit 0 + 64 测试文件 / 2279 测试全通过
  （renderer 全量测试）

  参考：tasks/打包前审查/step-6-sprite-panels.md QC-1~11
```

---

## 7. 后序衔接

完成本步审查后，建议进入 **Step 7 · sprite 渲染层 helpers + 入口**：

- `hosts/memora-sprite/src/electron/renderer/helpers/`（含 domHelpers.js / eventTracker.js / errorHelpers.js / icon.js / memoryPanelEvents.js / memoryDetailPanel.js / memoryViewSwitcher.js / memoryTimelineView.js / relationGraphTypes.ts / relationGraphLayout.ts / relationGraphColor.ts / relationGraphGeometry.js / sourceColor.js 等）
- `hosts/memora-sprite/src/electron/renderer/` 根级入口（ui.ts / renderer.ts / ipcListeners.ts / initHelpers.ts / uiDelegations/ 等）

预计文件数：约 15-20 个，行数约 4000-5000 行。

重点关注：
1. helpers/ 是否有循环依赖（relationGraphTypes.ts 之前已为消除循环依赖提取）
2. ui.ts / renderer.ts 入口文件长度是否超阈值
3. ipcListeners.ts 与 main 进程 IPC 通道的对应关系
4. uiDelegations/ 委托模式是否与 controllers/ 形成清晰边界
5. EventTracker 模式在 helpers/ 中是否被正确使用（与 STEP6-1/3/6/7 待办相关）
