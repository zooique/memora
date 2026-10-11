# Webview UI 排雷复核 + 推进落地报告（2026-10-11）

> 对象：上轮《Webview UI 扩散审计》的 5 条结论（C1/C5 已落地 + UI-SSOT-1/2 + UI-DRY-1 标记观察）。
> 方法：对抗式排雷（逐条实码实锤，区分真伤 / 误判 / 设计意图）+ SSOT 不带伤推进落地。

## 一、排雷结论总表

| 项 | 上轮定性 | 排雷证据 | 修正 verdict |
|---|---|---|---|
| C1 chatStyles focus ×7 | 真伤已修 | grep：旧值 0、新值 `var(--border-focus)` 7 处 | ✅ 真伤，已落地（改走自有语义令牌，解析值一致） |
| C5 memoryStyles 错误文本 ×2 | 真伤已修 | grep：`var(--text-error,#f14c4c)` 2 处 | ✅ 真伤，已落地（收敛孤值 #f48771） |
| UI-SSOT-1（剩余 20 处 `--vscode-*`） | 「SSOT 泄漏」 | `tokens.ts` 整文件即 `var(--vscode-x,fb)` 堆成；20 处直引**主题令牌本身**、内部零漂移；dropdown 头部注释明示「复用原生 menu 变量」 | 🟢 **过度标记 → idiom/设计意图**，非泄漏 |
| UI-SSOT-1 子项：roles charts-orange fallback | （未单列） | `:131`=#ffa500、`:137`=#ff9800，同引 `--vscode-charts-orange` 却 fallback 不一致 | 🔴 **真·微伤，本轮已修**（统一 #ffa500） |
| UI-SSOT-2 errorBoundary 崩溃横幅 | 「守卫盲区泄漏」 | 卡片 append 到 `document.body`（令牌可引用）；但崩溃 UI 需主题无关高可见红，刻意裸写有意为之 | 🟢 **设计意图，非泄漏** |
| UI-DRY-1 divider `border-top` ×~11 | 「DRY 债」 | 均走 `--border-panel`（单源令牌），fallback `.4`=`.0.4` 数值等价，无漂移 | 🟢 **纯 DRY 债，非 SSOT 泄漏** |

## 二、核心纠偏（方法论）

上轮将「20 处 `--vscode-*` 直引」整体判为「SSOT 泄漏」是**过度标记**。根因区分：

- **真·危险泄漏** = 绕过令牌的**裸写** `#hex` / `px` / `rgba()`，产生「第二/第三套值」不跟主题（即 `tokensClosure` 守卫锁定的 74 裸值债）。
- **idiom / 设计意图** = 直引 `--vscode-*` **主题令牌本身**。`tokens.ts` 整个文件就是 `var(--vscode-x, fallback)` 堆出来的——直引基础层令牌与 tokens.ts 自身构造同构，**不是泄漏**，至多是可选项语义包装（L1/L2 命名层）。

排雷后唯一真伤 = roles 的 fallback 不一致（#ffa500 / #ff9800），已落地；其余经用户拍板**维持现状**。

## 三、推进落地（SSOT 不带伤）

### 已落地（本轮）
- **rolesStyles.ts:137** `#ff9800` → `#ffa500`，与 `:131` readonly 的 `--vscode-charts-orange` fallback 统一。
  - 不带伤论证：主路径（主题在场）两者解析相同（主题变量覆盖 fallback），零视觉变化；脱钩路径从「两橙分裂」收敛为「一致橙」，严格改进。
  - 验证：`tokensClosure` **7/7**（裸值基线 74 冻结无回退）、`rolesView` **22/22**。

### 维持现状（用户拍板，2026-10-11）
- dropdown ×10 菜单色：刻意贴原生菜单观感（头部注释明示），维持 `--vscode-menu-*`。
- settings ×3（list-hover / tag bg+fg）+ roles ×7（策略 chip charts）：idiom 基础层令牌直引、内部零漂移，不令牌化。
- errorBoundary 崩溃横幅：主题无关高可见红是设计意图，不令牌化。
- UI-DRY-1 分隔线：纯 DRY 债（颜色已走单源 `--border-panel`），归 U5 组件层收拢批次。

## 四、验证收据（实锤）

- `tokensClosure` 7/7（裸值基线 74 冻结无回退）· `rolesView` 22/22 · 早前 C1/C5 关联 `chatView` 369/369 · `memoryView` 35/35 · 宿主 `tsc --noEmit` 0 错。
- grep 复核：chatStyles `var(--vscode-focusBorder)`=0 / `var(--border-focus)`=7；memoryStyles `var(--text-error,#f14c4c)`=2；tokens.ts:273 `[hidden]{display:none!important}` 单源在位。

## 五、台账回写

`tasks/待完成任务.md` UI-SSOT-1 / UI-SSOT-2 / UI-DRY-1 三条由「⏳ 观察」更正为「⏸ 维持现状（排雷定性 + 用户拍板）」，并记录 roles 微伤已修。

## 六、排雷教训

- 「SSOT 泄漏」判定必须区分「裸写值」与「主题令牌直引」——后者是 idiom，过度标记会制造无收益 churn，违背不带伤原则。
- `tokens.ts` 自身即 `var(--vscode-x,fb)` 构造，是判定「直引是否泄漏」的参照系。
- 跨面板注入链（tokens 共用基）仍是 SSOT 落地关键耦合点（上轮 N4 真伤已修）；本轮无新增跨面板问题。
