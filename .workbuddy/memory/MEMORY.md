# 项目长期记忆（memora 样式系统）

## 样式系统审计方法论（可复用，避免再踩坑）
- **统计「硬编码色」必须排除 `tokens.css` 的定义值**：`--red: #dc2626` 是 token 定义不是泄露。脚本里先 `var_re.sub('', text)` 去掉 `var(...)`（含 fallback 颜色），再对剩余文本找色值；且遍历文件时跳过 `foundation/tokens.css`。否则会把定义值误计为硬编码色（曾误报 157→真实 3）。
- **「重复选择器」多为误报**：`.x` 出现在 2+ 文件时，先确认是「基类重定义」还是「后代作用域覆写 / `:focus-visible` 状态扩展 / `animation` 钩子」。后者合法，不算真重复。
- **csstools stylelint 插件不跨 glob 聚合 `:root`**：`stylelint-value-no-unknown-custom-properties` 只在单文件沿 `@import` 聚合，整目录 glob 会把全部合法 token 误报为 unknown（曾误报 3260 条）；跨文件 token 必须用 `importFrom` 绝对路径（`.mjs` 配置用 `fileURLToPath`）提供，或给叶子文件加 `@import tokens.css`。验证守卫有效性时务必注入幻影 token 到叶子文件确认能抓到（避免假绿）。
- **对抗式核查习惯**：grep 实测优先于记忆估算；每轮 R 改完跑 `tsc --noEmit` + grep 回归（确认 graph 文件无实际规则、新类均被使用）。
- **CSS 批量迁移脚本必须保留 `/* */` 注释定界符**：按 `/*` 切分注释片段时若把 `/*` opener 一并消费，会导致整文件注释定界符被删除（曾把 27 文件「损坏」成 1428/1428 diff）；正确做法是注释片段从 `/*` 起到 `*/` 止原样保留、仅对 code 片段做替换，并跨行维护 in_comment 状态以覆盖多行注释块。

## 设计令牌与架构约定（ADR）
- 三层 scope：L1 全局基础（foundation/）/ L2 面板前缀 / L3 组件；BEM；单文件单真理源。
- 双主题：`:root` 浅色，`[data-theme="dark"]` 深色。颜色/阴影/z-index 已 100% token 化（实测）。
- 控件收口：`.card`、按钮系统、`.input`/`.input--pill`/`.input-with-action`、标签系统均在 `foundation/controls.css`（L1 单一真理源）。
- 记忆面板洞察栏/健康度栏样式已抽到 `memory/insights.css` + `memory/health.css`（从 graph 文件迁出，聚合器 `memory.css` 在 `completion-stats.css` 前 @import）。

## 已知小债（迭代 backlog）
- ~~`--success-10` token 缺失（chat-messages-input.css 用 fallback 掩盖）~~ → **已修（CSS-R13，2026-07-24）**：双主题补 token + 去 chat fallback 遮罩。
- ~~`.lineage-source-tag` 基类在 memory-graph-detail.css:143 是 R9 残留~~ → **已删（CSS-R14，2026-07-24）**：单一真理源收敛到 controls.css。
- ~~**R13-bis（幻影 token）**~~ → **已修（CSS-R13-bis，2026-07-24）**：实际范围比初判更广——`--text-secondary` 是直接幻影（无 fallback），横跨 completion-stats.css(5)/dashboard.css:236(1)/health.css(4) 共 10 处；加 completion-stats.css 的 --orange(3)/--orange-20(1)/--text-tertiary(4)，合计 18 处全目录清零（→ --accent/--accent-20/--text-2/--text-3）。
- ~~spacing 刻度值（4/8/10/12/16/20/24/28/32px 等）裸写未用 `--space-*`~~ → **已修（CSS-R15，2026-07-24）**：注释感知脚本批量迁移 27 文件 118 处裸 px→var(--space-*)（仅 spacing 语义属性，1px/2px 次像素与非栅格值故意保留）；tokens.css 补 --space-7:28px 补全 4px 栅格。替换 computed-identical，零视觉变化，lint:css 守卫 0 错误。
- ~~**R16 样式守卫**~~ → **已实现（2026-07-24）**：stylelint v16 + `stylelint-value-no-unknown-custom-properties`@6（npm 上**无** `@csstools/` 作用域包，其注册规则名是 `csstools/value-no-unknown-custom-properties`）；关键修正——插件**不跨 glob 聚合 `:root`**，必须用 `importFrom` 绝对路径（`.mjs` 配置）提供 token 集，整目录 glob 会误报 3260 条合法 token；首跑即抓 6 处真幻影 token 并修复（`--weight-normal`→`--weight-regular`、`--overlay`→`--surface2`、补 `--surface3` 双主题）；守卫接入 `lint:css` 脚本 + lefthook pre-commit 阻塞步骤，现状 0 错误。设计文档已同步修正（docs/css-stylelint-guard-R16.md）。
