# Webview UI 审查结论落地报告（SSOT 不带伤 · 2026-10-11）

> 配套：增量甄别报告（`审查报告-2026-10-11-WebviewUI审查增量甄别.md`）+ 排雷复核（`审查报告-2026-10-11-WebviewUI审查排雷复核.md`）。
> 本轮 = 排雷后拍板落地的实码改动 + 验证收据。内核 4.0.0 已发，聚焦宿主 webview UI 质量打磨。

## 一、拍板结论与落地动作

| 项 | 排雷定级 | 落地动作 | 文件 | 状态 |
|---|---|---|---|---|
| N1 颜色 fallback 漂移 | 🟡 P2（原 🔴 P1 实锤降级） | 84 处对齐到令牌最内层颜色 + 新增颜色版守卫 | 7 样式文件 + `tokensClosure.test.ts` | ✅ |
| N2 文档漂移 + dropdown 契约 | 🟡 P2 | README 铁律4 改写 + dropdown 注入前提注释 | `styles/README.md` + `components/dropdown.ts` | ✅ |
| N3 图标选型 | 🟢 搁置 | 仅登记，零代码改动 | — | ⏳ |
| N4 settingsView 内联 style | 🟢 P3 | 统一为 `.hidden` 属性 | `scripts/settingsView.ts` | ✅ |

## 二、N1 落地的「不带伤」论证（核心）

### 2.1 真值核定
- 初版扫描归一化正则 `/.(\d)/g` 把 `0.5` 错补成 `00.5` → 假阳性 178；修正为「仅给非数字前缀的点补前导零」后回落 83。
- 但 83 仍低估：比对目标错用了「令牌定义末位色」，未处理**嵌套括号**（`rgba(...)` 内的 `)` 截断回退 → 纯格式等价误判）。重写**括号平衡解析器**递归解析令牌定义**最内层颜色**（处理 `accent-soft` 经 `--accent-bg-subtle` 链式解析到 `.08`）→ **真实漂移 = 84 处**（剔 `--vscode-*` 主题域合法回退后）。

### 2.2 严重度降级的根因（为何不是 P1）
tokens 颜色定义普遍是**双层** `var(--vscode-y, INNER)`：
- **主路径（tokens 恒注入）**：`var(--sp-x, OLD)` 永远解析到 `--sp-x` → 进一步解析到 `--vscode-y`（主题值）或 INNER；**OLD 是死值，从不参与渲染** → 主路径视觉零影响。
- **脱钩路径（dropdown 脱离 tokens）**：`--sp-x` 未定义时 OLD 才生效 → 此处 OLD≠INNER 才构成「第三套值」。
- 与 px 域「回退直接落地成视觉不一致」**本质不同** ⇒ 降 🟡 P2。

### 2.3 对齐的数学保证（不带伤）
- coupled 主路径：改 OLD 不影响任何已渲染像素（OLD 从未被求值）。
- uncoupled 脱钩路径：OLD → INNER 使 fallback 与令牌定义第二跳**同值** = 严格更一致，非带伤。
- **git diff 复核**：净 83/83（每行单点 fallback 替换）；被删行 100% 含 `var(--`，**零注释误删、零结构改动**。

### 2.4 分类（禁盲归一先止血）
| 类 | 量 | 形态 | 处置 |
|---|---|---|---|
| A 强度随手写 | ~70 | `surface-hover` .04/.08/.10→.2、`text-muted` #888→#9a9a9a、`border-panel` .2→.4 等 | 批量对齐内层 = 零视觉风险 |
| B 语义冲突 | ~13 | `accent` #4fc1ff→#0e639c、`surface-code` 黑透→灰透、`feedback-error-bg` 红透→#442726、`status-fail` #f14c4c→#b3261e、`surface-input` 黑透→#3c3c3c、`accent-soft` 链式→.08 | 逐处核对后**对齐到令牌最内层**（令牌定义即真义，B 类值本就是错配第三套值） |

> B 类「先核对再对齐」已逐处过：令牌定义（如 `--accent: var(--vscode-button-background, #0e639c)`）为真源，亮蓝回退是 stale 错配；对齐到深蓝 = 纠正而非造伤。

## 三、守卫盲区堵漏（N1 附带的真伤）
`tokensClosure.test.ts` 旧注释「只管 px，颜色另行处理」**从未落地** → 颜色域 fallback 零守卫。
- 新增 `设计令牌颜色 fallback 一致性守卫` describe：复用 `tokensText`/`STYLES_DIR`，移植括号平衡解析器 + `normalizeColor`，反向守卫 `scanned>100` 防空绿，硬门 `toEqual([])`。
- 形态与既存 px 守卫**同构**，防第三套值复发。

## 四、N2 落地
- `styles/README.md` 铁律4 改写：原「chatStyles/configStyles 自拼接 `${tokens}`」→ 真实链 = **settingsStyles 注入后聚合四子视图**（configStyles/rolesStyles/memoryStyles/skillsStyles 零自带注入），chatStyles 注入后聚合 dropdownStyles（组件 scoped 到 `.treedd`）。
- `components/dropdown.ts` 补「令牌注入前提契约（勿自带注入）」注释：dropdownStyles 不内嵌 tokens，唯一挂载点 = chatPanel（`styles: \`${chatStyles}\n${dropdownStyles}\``），迁到不注入 tokens 的面板须显式注入，否则 sp-* 落裸色回退。

## 五、N4 落地（排雷更正定性）
- `settingsView.ts:237` 全库唯一内联 `style="display:none"` 与 JS `contentEl.style.display` 直写**自洽**（非 `.hidden` 冲突 bug）。
- 全局 `[hidden]{display:none!important}`（chatStyles.ts:47）兜底 + `.skill-content` 无 display 覆盖规则 ⇒ 转 `hidden` 属性**安全**。
- 落点：模板 `hidden` 属性 + 切换逻辑 `contentEl.hidden` 布尔（3 处 `style.display` 改写），消除全库唯一内联 style、对齐既有 `el.hidden` 约定。

## 六、验证收据（2026-10-11）
| 门 | 命令/范围 | 结果 |
|---|---|---|
| 漂移复扫 | 括号平衡解析器 | **DRIFT_TOTAL=0** |
| 令牌守卫 | `tokensClosure.test.ts` | **7/7**（含新增颜色门） |
| 类型检查 | 宿主 `tsc --noEmit -p ./` + `-p ./tsconfig.scripts.json` | **双配置零错** |
| 行为回归 | `settingsView.test.ts`(22) + `dropdown.test.ts`(12) | **34/34** |
| 内联 style 清零 | `grep 'style="' scripts/` | **0 残留** |

## 七、排雷暴露的脚本教训（已修正，记入不改判据）
- 颜色归一化 `/(^|[^\d.])\.(\d)/g` 补前导零，避免 `0.5`→`00.5` 假阳性。
- 嵌套括号回退提取须用**括号平衡**解析，不能用 `[^)]*`（截掉外层 `)` → 纯格式等价误判为漂移）。
- 守卫注释写「另行处理」= **空头支票**；落地前该域零守护，漂移静默累积 84 处——注释即债务。

## 八、未闭合 / 待观察
- **N3 图标选型**：零改动，随真机验收看观感再拍板（若改，前置 = 走 `icons.ts` 单一真源、禁内联裸 SVG）。
- **真机复验**：N1/N4 对齐的是 uncoupled 死值，主路径零影响；建议真机走一遍暗/亮主题确认下拉/设置面板观感无回退（属预防性确认，非回归预期）。
- 台账回写见 `待完成任务.md` 宿主 0.1.0 打磨残项区：`UI-TOKEN-COLOR-1` / `UI-DOM-1` / `UI-ICON-1`。
