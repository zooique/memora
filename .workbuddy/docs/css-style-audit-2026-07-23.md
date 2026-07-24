# 样式系统全量审计 + 迭代方案

> 审计范围：`hosts/memora-sprite/src/electron/renderer/styles/`（41 个 CSS 文件 / 13083 行）
> 审计日期：2026-07-23 ｜ 方法：脚本实测 + 对抗式审查（不凭记忆估算）
> 背景：已完成 CSS-R1~R12（控件/输入框/洞察栏/健康度面板收口）

---

## 0. 方法论（第一性原理）

CSS 抽象只为解决三件事，命中其一才值得做：

1. **去重**——同一显示逻辑在 N 处重复
2. **单点决策**——改一处即全局生效
3. **强制一致**——防止不同人写出不同值

不命中任一的「抽象」= cargo-cult，不做。每条结论均用脚本实测，且对脚本自身结果做对抗式复核。

> ⚠️ **审计过程中的关键自我推翻**：初版脚本（v1）报「157 个硬编码色」，曾据此怀疑 chat 文件用了整套 Catppuccin 调色板绕过 token。复核发现脚本把 `tokens.css` 里的 **token 定义值**（`--red: #dc2626`）也算进了「硬编码色」。排除 tokens.css 后真实数字仅 **3 个**。结论因此被整体修正——颜色系统实际已 ~100% token 化。

---

## 1. 全量实测信号

| 维度 | 实测结果 | 判定 |
|---|---|---|
| 文件/行数 | 41 文件 / 13083 行 | — |
| 硬编码色（token 外） | **仅 3 个**（float.css×2、sprite-settings.css×1） | ✅ 极健康 |
| 缺失 token 引用 | `--success-10` 被 `var(--success-10, rgba(34,197,94,0.1))` 引用，但 tokens.css **未定义** → fallback 在掩盖缺失 | ⚠️ 真 bug |
| box-shadow | 全部走 `var(--shadow-*)`；5 处 `0 0 0 2px var(--accent-20)` 引用变量 | ✅ 已 token 化 |
| z-index | 走 `var(--z-*)` / `calc()`，无散落魔法数 | ✅ 已 token 化 |
| 裸 px 总数 | 1019；`1px:199` / `2px:130` 为结构性边框（合理） | — |
| spacing 值裸写 | `4px:81 / 8px:45 / 12px:44 / 10px:37 / 20px:19 / 24px:23 / 28px:21 / 32px:26`（均为 `--space-*` 对应值却写裸数字） | ⚠️ **唯一真问题：spacing 纪律不一致** |
| 重复选择器 | 多数为误报（状态扩展 / 后代覆写 / 动画钩子） | — |
| R9–R12 死代码 | 无新增；`.health-action-btn`/`.modal-content`/`.modal-footer`/`.btn-*` 均合法 | ✅ |

### 重复选择器的对抗式澄清（均为误报，非真重复）

- `memory-graph-misc.css` 的 `.health-action-btn` → 实为 `.recycle-bin-item-actions .health-action-btn`（**后代作用域覆写**，引用已迁走的基类），R11 无回归。
- `modal.css` 的 `.btn-primary:focus-visible` → **状态扩展**（无障碍 outline），基类在 controls.css。
- `memory-graph-detail.css` 的 `.modal-content` → 仅 `animation` 钩子，非重定义。
- `.modal-footer` 在 misc.css → 实为 `.xxx .modal-footer` 作用域规则，非基类重定义。

**唯一真实残留**：`.lineage-source-tag` 基类仍定义在 `memory-graph-detail.css:143`（R9 标签收口后 controls.css 已是单一真理源，此处重复定义 base，且无 `.source-x` 配色）→ 应删。

---

## 2. 真实抽象需求（按价值排序，已验证）

### R13 ｜补缺失 token `--success-10`（Trivial / Safe）
`chat-messages-input.css:26` 用 `var(--success-10, rgba(34,197,94,0.1))`，但 token 不存在。在 `tokens.css` 的 light + dark 两段补 `--success-10: rgba(34,197,94,0.1)`（dark 段可微调 alpha），消除「fallback 掩盖缺失 token」的隐患。
**工作量**：1 文件 +2 行。

### R14 ｜清除 `.lineage-source-tag` 残留基类（Low risk）
删 `memory-graph-detail.css:143-148` 的 `.lineage-source-tag { font-size; padding; border-radius; font-weight }`。controls.css（R9）已定义同款 base + `.source-x` 配色，删除不影响显示（仍由 controls.css 提供 base，由 `.source-x` 提供颜色）。
**工作量**：1 文件 −6 行。需 grep 确认该文件无 `.source-x` 本地配色（已确认：无）。

### R15 ｜spacing token 纪律（核心抽象需求，须分阶段）
**不是**盲目替换 629 处裸 px。真实缺口：spacing 刻度值（4/8/10/12/16/20/24/28/32px 等）大量裸写未用 `var(--space-*)`，导致「微调间距刻度需改几百处」。
正确做法：
1. 核对 `--space-*` 是否覆盖所有常用值（4/6/8/10/12/14/16/18/20/24/28/32…）；不足的补 token。
2. **优先迁移 L1/L2 共享文件**（controls.css、base.css、layout/*），再逐面板。
3. 每批迁移后视觉回归（启动应用抽检），避免纯 CSS 无 `@extend` 引发的隐性错位。
**注意**：`16px`(图标/`font`)、`14px`、`48px`(组件宽) 等属组件尺寸，不该盲目 token 化——逐案判断。

### R16 ｜引入 stylelint 守卫（最高杠杆，meta-win）
项目当前**无任何 CSS lint**（无 stylelint / postcss 配置）。新增：
- `.stylelintrc.json`：继承 `stylelint-config-standard`，启用 `color-no-invalid-hex`、`declaration-block-no-duplicate-properties`、`csstree/validator`（校验 `var()` 引用存在）、针对硬编码 `px`/`color` 的告警规则。
- 在 `lefthook.yml` 加 `stylelint` pre-commit 钩子 + `package.json` 加 `lint:css` 脚本。
作用：**从根上防止 regression**——R13/R14/R15 修完后再也不会悄悄长出硬编码色/裸 px。

### R17（可选收尾）｜3 个一次性硬编码色 token 化
`float.css` 的 `#bad`（浮窗浅紫强调）、`sprite-settings.css` 的 `rgba(76,175,80,0.12)`（绿色健康底）。极低优先，可在 R16 告警驱动下顺手补 `--float-accent` / `--green-12`。

---

## 3. 明确不做（对抗式否决的伪需求）

| 伪需求 | 否决理由（实测） |
|---|---|
| 卡片去重 | 纯 card 形态类实为带 header/icon/actions 的复杂组件，无安全合并候选（沿用 CSS-R10 结论） |
| 表单输入逐个加 `.input` | 已被 `.settings-group input` / `.modal-body input` 等上下文选择器兜底，硬加零收益且漏改即破样式 |
| 157 硬编码色大清洗 | 测量 bug，真实仅 3 处（见 §0） |
| chat Catppuccin 调色板重构 | 不存在，chat 文件 token 外零硬编码色 |
| box-shadow 聚焦环统一 | 已引用 `var(--accent-20)`，非问题 |

---

## 4. 迭代路线图（建议顺序）

| 阶段 | 内容 | 风险 | 估计 |
|---|---|---|---|
| ① | R13 + R14（小修，1 个 PR） | 零 | ~30min |
| ② | R16 stylelint 守卫（基础设施，先建后管） | 低 | ~1h |
| ③ | R15 spacing 纪律（R16 告警驱动，按文件分批 + 视觉回归） | 中（需逐案判断） | 分批持续 |
| ④ | R17 收尾 3 色 | 零 | 顺手 |

---

## 5. 验证方法

- 每步 `npm run typecheck`（`tsc --noEmit`）通过。
- R13/R14：grep 确认 `--success-10` 已定义、`.lineage-source-tag` 仅在 controls.css。
- R15：每批迁移后启动应用抽检记忆/设置/对话面板布局无错位。
- R16：stylelint 全量跑通、0 违规，且故意写入一个硬编码色能被钩子拦截。

---

## 附录：审计脚本（可复用）

- `.workbuddy/css_audit.py` — v1（含 token 定义误报，供对照）
- `.workbuddy/css_audit2.py` — v2（排除 tokens.css，颜色/px 分类定位）
- `.workbuddy/css_audit3.py` — v3（散落色现场 + 裸 px 频率）

> 复用要点：**统计硬编码色必须排除 `tokens.css` 的定义值**，否则会把 `--x: #fff` 误计为硬编码色。
