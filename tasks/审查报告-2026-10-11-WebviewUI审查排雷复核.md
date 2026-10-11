# 审查报告-2026-10-11-WebviewUI 审查排雷复核（SSOT 不带伤）

> 对 `审查报告-2026-10-11-WebviewUI审查增量甄别.md` 的 N1–N4 结论做对抗式实锤排雷。
> 方法：独立重跑实测 + 逐处读源码上下文 + 分诊「真伤 / 误判 / 假阳性 / 定性修正」。
> 铁律：判据须与 SSOT（tokens.ts 真实定义）同源；修法不得因错误的原因通过 / 不得带伤。

## 〇、排雷结论总表

| 结论 | 上轮定性 | 排雷后定性 | 处置 |
|---|---|---|---|
| N1 颜色 fallback 漂移 83 处 | 🔴 P1 | **🟡 P2（降级）** | 真伤存在，但严重度被高估；需加守卫 + 分诊修正 |
| N1 守卫颜色门缺失 | 结论一部分 | **真伤确认** | tokensClosure:235 自陈「只管 px，颜色另行处理」从未落地 |
| N2 README 铁律4 漂移 | 🟡 P2 | **真伤确认** | configStyles 零注入，真实为 settingsStyles 聚合 |
| N2 dropdown 注入契约未补 | 🟡 P2 | **真伤确认** | 路线文档 §1.2 拍板项未落地 |
| N3 图标自绘 vs codicon | 🟡 搁置 | **真结论确认** | 全仓零 codicon 引用；非缺陷，登记搁置 |
| N4 settingsView:237 内联 style | 🟢 | **🟢（更正定性）** | 与 JS `style.display` 自洽，非 .hidden 冲突 bug；仅风格不统一 |

**排雷新发现（排雷本身的价值）**：
- 初版归一化脚本有前导零 bug（`/\.(\d)/g` 把 `0.5` 错补成 `00.5`），导致假阳性 178 处；修正为 `(^|[^\d.])\.(\d)` 后回落到 **83**。证明"重跑实测"这步不可替代——否则会按假数字盲目修。
- 颜色域回退是「第三套值」，非 px 域的「第二套值」：tokens 定义普遍为双层 `var(--vscode-*, #fallback)`，`--vscode-*` 主题层优先，样式回退只在 tokens 整体缺失时生效。

---

## 一、N1 排雷（核心，定性修正）

### 1.1 数字校正（真伤存在，口径已夯实）
修正归一化（仅给非数字前缀的点补前导零）后重扫 7 个样式文件：
- **真数值漂移 = 83 处**（与上轮巧合一致，但上轮口径有瑕疵，本轮已校正）。
- 剔除了 `--vscode-*` 主题域合法回退；硬编码散落回退值集中在 `rgba(128,128,128,N)` 中性灰与各类 hex。
- 按令牌分布（BYTOK）：border-panel 8 / surface-hover 11 / text-muted 9 / text-primary 7 / text-tertiary 7 / surface-code 8 / border-subtle 5 / accent 5 / text-secondary 4 / feedback-error-bg 4 / surface-input 4 / 其余各 1–2。

### 1.2 双层结构认知（严重度降级的根因）
读 `tokens.ts` 真实定义，确认颜色令牌**普遍是双层结构**：
```
--surface-input:  var(--vscode-input-background, #3c3c3c);
--surface-hover:  var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
--accent:         var(--vscode-button-background, #0e639c);
--text-muted:     var(--vscode-descriptionForeground, #9a9a9a);
```
样式文件写 `var(--surface-input, rgba(0,0,0,.2))` 形成**三层解析链**：
1. `--vscode-input-background`（VS Code 主题，运行时优先）
2. `#3c3c3c`（tokens 内层 fallback）
3. `rgba(0,0,0,.2)`（样式文件回退，仅 tokens 整体缺失时生效）

**对比 px 域**：px 令牌定义是裸 `4px`（无 `--vscode-*` 外层），回退 `2px` 会直接落地成视觉不一致（真第二套值）。
**颜色域**：主路径走 `--vscode-*` 层，样式回退（第三层）**永不生效**（已复验 tokens 恒注入）。
⇒ 83 处对**当前渲染视觉零影响**，仅在 **dropdown 脱离 tokens 注入**时暴露不一致。

**结论：N1 从 🔴 P1 降为 🟡 P2**——真实的一致性债 + 守卫盲区，但非主路径视觉 bug。

### 1.3 分诊框架（不带伤红线：禁全量归一先止血）
83 处不能机械对齐 def，分两类：

**A 类 · 纯强度随手写（约 70 处，可批量对齐，零视觉风险）**
回退多为中性灰半透明、强度低于 def（如 border-panel 回退 .2/.3/.24/.15 vs def .4；surface-hover 回退 .04~.18 vs def .2）。
- 修法：回退值改为 tokens 内层 fallback（如 `.4`/`.2`）。
- 安全性：运行时不走回退层 ⇒ 对齐 = 零视觉变化、零回归风险。

**B 类 · 语义冲突点（约 13 处，需逐处核对设计意图，禁盲归一）**
回退与 def **语义不同**（不透明 vs 半透明 / 深蓝 vs 亮蓝），盲对齐会带伤：
- `accent` 回退用亮蓝 `#4c8dff`/`#4fc1ff`/`#007acc`（浅色主题残留？），def 深蓝 `#0e639c`
  —— chatStyles:231/256/256/259、rolesStyles:54/217
- `surface-input` def 不透明 `#3c3c3c`，回退半透明 `rgba(0,0,0,.2)`/`rgba(128,128,128,.1)`/`rgba(255,255,255,.04)`
  —— chatStyles:352、rolesStyles:320、settingsStyles:255/261
- `surface`/`surface-thought`/`surface-sidebar` def 不透明 `#252526`，回退半透明灰
  —— rolesStyles:133、settingsStyles:240、chatStyles:1595/1807、rolesStyles:287/306
- 修法：逐处读上下文，决定「改回退对齐 def」还是「改 def 为半透明 + 同步回退」（以 dropdown 脱钩场景的视觉一致性为真目标）。**判据 vs 事实抉择，不得盲从 def**。

### 1.4 守卫盲区（真伤确认）
`tokensClosure.test.ts:235` 注释自陈「只管 px：颜色/复合值的定义形态不同，另行处理」——颜色版 fallback 守卫从未落地。
- 修法：复刻 px 门口径（正则 `var\(--([\w-]+),\s*(#[0-9a-fA-F]{3,8}|rgba?\(...\))\s*\)` 比对 tokens 内层 fallback），**warning 起步**（颜色域散落历史久、分诊粒度大，fail 直接卡 CI 过早），跑通后再升 fail。
- 反向空集守卫：扫不到任何带颜色回退的引用即判提取口径失效（对齐 px 门:259 的 `toBeGreaterThan(200)` 思路）。

---

## 二、N2 排雷（文档漂移，真伤确认）

- `styles/README.md:25` 铁律4：「`chatStyles` / `configStyles` 在自身字符串头部拼接 `${tokens}`」。
  实测：全仓 grep `configStyles` 注入点 = 零；真实链是 `settingsStyles` 头部注入 `${tokens}` 后聚合四子视图（configStyles/rolesStyles/memoryStyles/skillsStyles 均不自带注入）。
  ⇒ 文档与实际**已漂移**，铁律4 注入方描述过时。
- 今日路线文档 §1.2 拍板的「dropdown 注入前提契约」（组件样式只引用令牌、不自带注入）未补到 `dropdown.ts` 注释。
- 结论：🟡 P2 真伤（文档类，低风险）。

---

## 三、N3 排雷（图标选型，真结论确认）

- 全仓 grep `codicon` → **No files found**（零引用）。
- `scripts/icons.ts:1-20` 头注释自陈「Trae 风格 / 16x16 viewBox / `stroke="currentColor"` 跟随父色 / `stroke-width="1.5"`」。
- 结论：自绘 SVG 体系属实，且 `currentColor` 已跟随主题 ⇒ 内部自洽、非缺陷。
  属「选型登记」议题（与 VS Code 原生 codicon 100% 同源的唯一路径），严重度低，搁置合理，**随真机验收观感再拍板**是否迁移。

---

## 四、N4 排雷（内联 style，定性更正）

- `settingsView.ts:237` `<div class="skill-content" style="display:none" ...>` 是全库唯一内联 style 散写（grep 全 scripts 仅此 1 处）。
- 排雷澄清：JS 显隐用 `contentEl.style.display` 直写（settingsView:288 `isHidden = style.display==='none'`、:290/:337/:341），与初始内联 `display:none` **同一套机制、自洽**。
- 上轮「与项目 `.hidden` 显隐纪律冲突」的担忧**不实**——项目 `.hidden` 属性纪律见于 chatView dock 裁决等，但 settingsView 此处因需读 `isHidden` 状态 + 渐进披露缓存，选用 `style.display` 直控是合理选型。
- 真实定性：settingsView **同文件显隐机制不统一**（既用 `.hidden` 于 :77/383/385/510…，又用 style.display 于 :237/288/290）——轻微风格不一致，非功能 bug。
- 结论：🟢 P3（原 🟢 维持），标注更正定性说明。

---

## 五、待拍板 / 台账回写建议

1. **N1 定级修正**：自 `🔴 P1` 降为 `🟡 P2`；建议台账项 `UI-TOKEN-COLOR-1` 收「颜色版 fallback 守卫 + 83 处分诊（A 类批量对齐 / B 类逐处核对）」。
2. **N2**：台账项收「README:25 铁律4 修正 + dropdown 注入契约注释补」。
3. **N3**：`UI-ICON-1` 登记选型，搁置。
4. **N4**：并入样式一致性观察项，🟢 不单列任务。
5. **红线重申**：N1 修复阶段禁「全量归一先止血」——B 类语义冲突点必须逐处核对 dropdown 脱钩场景视觉，判据与事实抉择。

---
**UI Designer 排雷复核** · 2026-10-11 · 所有结论附 file:line 实证，数字经归一化 bug 修复后复验。
