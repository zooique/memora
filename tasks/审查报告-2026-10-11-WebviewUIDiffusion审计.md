# Webview UI 扩散审计（SSOT 收紧）· 2026-10-11

> 本轮目标：把审计从「颜色 fallback 漂移」单点**扩散**到 webview 全貌——样式层 `--vscode-*` 直引、TS 脚本层硬编码样式、跨文件重复工具块、跨视图逻辑重复。
> 方法：第一性原理 + 对抗式审查 + 第二工具交叉验证（杜绝自写扫描器假阴性）。

## 一、方法论更正（关键）

首轮自写 node 扫描器结论「样式文件零 `--vscode-*` 直引泄漏」是 **假阴性**。
用 Grep 工具交叉验证，实锤存在 **29 处**直引（chatStyles 7 focus / dropdown 10 菜单色 / rolesStyles 7 策略色 / settingsStyles 3 / memoryStyles 2）。

**教训**：自写工具的结论必须第二独立工具交叉验证，否则落入「因错误的原因通过」。本报告所有结论均经 Grep/Read 实证。

## 二、已落地（SSOT 收紧 · 严格不带伤）

### C1 — chatStyles 焦点环 ×7
- 改动：`var(--vscode-focusBorder)` → `var(--border-focus)`（7 处 `:focus-visible` 规则）。
- 不带伤论证：`--border-focus` = `var(--vscode-focusBorder, #0e639c)`，解析值与前者**完全一致**，且多一层 fallback 安全网。零视觉变化。
- 证据：grep 确认 chatStyles 现 7× `var(--border-focus)`、0× `var(--vscode-focusBorder)`。

### C5 — memoryStyles 错误文本 ×2
- 改动：`var(--vscode-errorForeground, #f48771)` → `var(--text-error, #f14c4c)`（2 处 `.gov-error` / `.mem-hint-error`）。
- 不带伤论证：主题内 `--vscode-errorForeground` 有定义时解析值不变；fallback 由孤立的 `#f48771` 收敛为与 `--text-error`/`--danger` 一致的 `#f14c4c`，消除双源 fallback 分歧。
- 守卫反查（关键价值）：初改写 `#f48771` 被「颜色 fallback 一致性守卫（防第三套值）」**当场判漂移**（`#f14c4c` 才是 `--text-error` 最内层色），修正后过门。守卫拦住了我自己的第三套值引入。

## 三、标记观察（待拍板，未落地）

### C2/C3/C4 — 样式层 `--vscode-*` 直引 29 处
- **dropdown.ts ×10**：菜单 `menu-background/foreground/border/selection*`。刻意贴 VS Code 原生菜单观感 = 设计意图，但是裸主题变量；是否牺牲原生观感换 `--surface-menu-*` 语义令牌需拍板。
- **settingsStyles ×3**：`list-hoverBackground`、`tag-background/foreground` → 应包 `--surface-list-hover` / `--tag-bg` / `--tag-fg`。
- **rolesStyles ×7**：策略 chip `charts-orange/green/purple/cyan/blue` → 应包 `--strategy-*` / `--chart-*` 语义家族。
- 修法共性：归一到 `tokens.ts` 语义令牌层，样式文件只引用语义令牌（消除第二真理源）。

### B1 — errorBoundary 崩溃横幅（TS 层守卫盲区）
- `helpers/errorBoundary.ts:76-78` 整条崩溃横幅内联样式全裸写（`8px`/`10px 14px`/`6px`/`rgba(244,67,54,0.95)`/`#fff`/`13px`/shadow），不跟主题。
- CSS 令牌守卫扫不到 TS 层 `card.style.cssText`，属真盲区。该卡片 append 到 webview `document.body`，令牌已注入 ⇒ 可安全引用。
- 修法：布局值映射精确令牌（`--sp-3`=8px、`--sp-4`=10px、`--radius`=6px、`--font-base`=13px、`--shadow-toast`、红色 `var(--danger, rgba(244,67,54,0.95))` 保原值）；唯一离刻度 14px 落 `--sp-5`(12px) 属刻度对齐。因是崩溃兜底 UI，视觉稳定性优先，建议评审后落地。

### B2 — 分隔线 `border-top` 重复 ×10+（UI-DRY-1）
- chatStyles/memoryStyles/rolesStyles/settingsStyles 共 ~12 处重复 `border-top: 1px solid var(--border-panel,...)`（fallback 写法 `.4`/`0.4` 同色，无视觉不一致，纯 DRY 债）。令牌 `--border-panel` 已单源。
- 修法：tokens.ts 加全局工具类 `.divider-top { border-top: 1px solid var(--border-panel); }`，各处置换为加类。触碰 10+ 站点，属 U5 组件层收拢，归 0.1.0 后批次。

## 四、非缺陷确认

- **B3 modal**：config `.modal`/`.modal-mask` 与 roles `.team-modal`/`.team-modal-overlay` 是各自视图独立弹窗，共享 `--overlay-mask`/`--shadow-modal`/`--surface-sidebar`/`--radius-lg`/`--border-panel` 等令牌，无第二真理源。非泄漏。
- **代码质量**：`showToast`/`openModal`/`closeModal` 仅 `configView.ts` 定义（87/184/241），未跨视图 3× 重复。无硬伤。

## 五、验证收据

- `tokensClosure` **7/7**（含颜色 fallback 一致性守卫；裸值基线 74 冻结无回退）
- `chatView` **369/369** · `memoryView` **35/35** · 宿主 `tsc --noEmit` 零错
- 台账回写：`UI-SSOT-0`（已落地）/ `UI-SSOT-1` / `UI-SSOT-2` / `UI-DRY-1`

## 六、排雷教训（沉淀）

1. **自写扫描器须第二工具交叉验证**——否则「零泄漏」结论可能是假阴性（本次实锤）。
2. **守卫是活的检查器**：C5 初改即被「颜色 fallback 一致性守卫」判漂移，证明 N1 轮新增的守卫已在守门，不是摆设。
3. **「对齐全局 X 兜底」类论述须核对该规则是否真在消费面板的注入集内**（上轮 N4 真伤即此）；本轮 B1 是同一类盲区在 TS 层的变体。
4. **设计意图 vs SSOT 泄漏要区分**：dropdown 菜单色是刻意原生观感（泄漏但有因），roles 策略色/settings 标签色是无意裸引（应包语义令牌）——分类处置，不一刀切。
