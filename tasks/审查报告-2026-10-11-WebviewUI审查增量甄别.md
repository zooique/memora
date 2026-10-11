# 宿主 Webview UI 审查 · 增量甄别（2026-10-11 · 第二轮）

> 定位：对今日两份报告（`审查报告-2026-10-11-宿主UI设计与SSOT审查.md` +
> `审查报告-2026-10-11-宿主UI质量回顾与优化路线.md`）的**对抗式增量复核**——
> 独立重跑实测，甄别「已闭环 / 未闭环 / 新发现」三类。不重复已立项内容。
> 审查口径：SSOT 不带伤；每项附可复现实测命令与输出。

---

## 一、结论速览

| # | 发现 | 级别 | 性质 | 与既有报告关系 |
|---|------|------|------|----------------|
| N1 | **颜色域 fallback 漂移 83 处零守卫**（守卫自述「颜色另行处理」从未落地） | 🔴 P1 | 带伤（px 域同族病的另一半） | **新发现** |
| N2 | `styles/README.md` 铁律 4 注入说明漂移 + 路线文档 §1.2 拍板的 dropdown 注入契约未补 | 🟡 P2 | 文档撒谎 + 拍板未落地 | **新发现** |
| N3 | 图标体系选型未决：自绘 Trae 风格 SVG vs VS Code codicon | 🟡 P2 | 设计决策点（非缺陷） | **新发现** |
| N4 | `settingsView.ts:237` 唯一内联 `style="display:none"` | 🟢 P3 | 显隐纪律不一致（一行修正） | 旧报告仅计数未判性 |

---

## 二、🔴 N1 · 颜色域 fallback 漂移 83 处零守卫

### 2.1 Claim

tokensClosure 值守卫自述「只管 px：颜色/复合值的定义形态不同，**另行处理**」
（`__tests__/tokensClosure.test.ts:237`）——但「另行处理」从未落地。颜色域存在与
px 域当年 88 处同量级的「第二套值」债务，且**无任何守卫可见**。

### 2.2 Evidence（实测，2026-10-11）

脚本口径：剥离 `var()` 整体后按声明分类，颜色值做归一化（`#fff`≡`#ffffff`、`.4`≡`0.4`），
剔除 `--vscode-*` 主题域合法回退（主题变量由 VS Code 注入，fallback 属正当防御）。

```
tokens 颜色定义数: 66 | 样式层颜色回退引用: 382 | 一致: 299 | 真实漂移: 83
```

TOP 漂移（同一令牌、多种回退值 = 同一契约的多套真理源）：

| 令牌 | 定义值 | 散落的回退值（次数） | 漂移类型 |
|------|--------|---------------------|----------|
| `--surface-hover` | rgba(128,128,128,**0.2**) | .04(1) .08(3) .10(2) .12(1) .18(1) .3(1) | **七种强度** |
| `--text-muted` | **#9a9a9a** | #888(7) #6e7681(2) | 三种灰度 |
| `--border-panel` | rgba(128,128,128,**0.4**) | .15(1) .2(5) .24(1) .3(3) | 五种强度 |
| `--text-tertiary` | **#6e7681** | #666(6) #607d8b(1) | 两种灰度 |
| `--text-primary` | **#cccccc** | #e0e0e0(3) #e6e6e6(3) #1f1f1f(1) | 亮暗各一套 |
| `--accent` | **#0e639c** | #007acc(2) #4c8dff(1) #4fc1ff(2) | 三种品牌色 |
| `--surface-code` | rgba(127,127,127,0.15) | rgba(0,0,0,.08)(4) rgba(0,0,0,.2)(1) rgba(128,128,128,.12)(3) | 三种底色 |
| `--feedback-error-bg` | **#442726** | rgba(180,40,30,.14)(4) | 暗色 vs 半透明两套形态 |

分布：chatStyles 71 / rolesStyles 17 / memoryStyles 13 / settingsStyles 15 /
configStyles 5 / skillsStyles 7 / dropdown 3（同令牌跨文件重复计入总数）。

### 2.3 Conclusion 与修正方向

1. **债务性质与 px 域完全同族**：tokens 恒注入 ⇒ 回退值全是死值 ⇒ 全量对齐定义值
   = 零视觉变化（与 px 批次同判据）。83 处可一次消化。
2. **⚠️ 勿机械归一（防造伤）**：`--surface-hover` 七种强度、`--border-panel` 五种强度
   暗示**一个令牌承载了多种语义强度**——修正前须逐处分诊：
   - 真漂移（笔误/历史遗留）→ 对齐定义值；
   - 强度分化（设计意图）→ 建分级令牌（**先例已有**：`--accent-bg-hover/subtle/active`
     三档就是为此而设），令牌化后回退值自然归一。
   顶部明暗族（`--text-primary` #e0e0e0/#e6e6e6 vs 定义 #cccccc）疑似亮色主题下
   「定义值对比度不足」的历史补偿——分诊时须带浏览器实测，不能只对字符串。
3. **守卫扩展**：在 tokensClosure 现有 fallback 硬门旁并列一条颜色版
   （判据同款：归一化后比对），先挂 warning 观察假阳性率，可控后升 fail——
   与 px 门同款升档路径，勿一步到位（对齐 testing_rules §6 纪律）。

---

## 三、🟡 N2 · 文档层两处漂移

### 3.1 styles/README.md 铁律 4 已过时

| 项 | 事实 |
|----|------|
| Claim | README 描述的注入方与实际不符 |
| Evidence | `styles/README.md:25`：「`chatStyles` / `configStyles` 在自身字符串头部拼接 `${tokens}`」<br>实测：`grep -c '${tokens}'` → chatStyles=1、settingsStyles=1、configStyles=**0**、rolesStyles/memoryStyles/skillsStyles/dropdown=0<br>真实链：`settingsStyles.ts:18` 注入 tokens 后于 :219-222 聚合四个子视图样式；dropdown 借 chatPanel 拼装链间接获得 |
| Conclusion | configStyles **从未**自己注入——README 写的是旧形态（settingsStyles 聚合制建立前）。照文档理解注入链会得出错误心智模型。`tokens.ts:11` 的列举「(chatStyles / configStyles / dropdown)」同病。 |

修正：README 铁律 4 改写为「注入制 = chatStyles（chat 面板）+ settingsStyles（设置面板，
聚合 roles/config/memory/skills 四子视图）；dropdown 只引用不注入，依赖宿主面板拼装链」。

### 3.2 路线文档 §1.2 已拍板项未落地

`审查报告-2026-10-11-宿主UI质量回顾与优化路线.md` §1.2 拍板：「dropdownStyles 依赖
『宿主已注入 tokens』这一未表达的前提，建议在 tokens 侧补一条注释级契约，或让
dropdown 自带注入（**二选一，勿两处都写**）」。实测：`tokens.ts` 无 dropdown 注入前提
说明、`components/dropdown.ts` 头注释只讲图标注入不讲 tokens 前提——**两项均未做**。
建议选注释级契约（dropdown 自带注入会与 chatStyles 头部重复定义 `:root`，违背收敛方向）。

---

## 四、🟡 N3 · 图标体系选型（设计决策点，非缺陷）

| 项 | 事实 |
|----|------|
| 现状 | `scripts/icons.ts`（215 行）：自绘 SVG，16×16 viewBox、stroke=currentColor 跟随主题色、stroke-width 1.5 圆端点，Trae 风格 |
| 对照 | VS Code 官方 webview 图标语言 = codicon（原生面板 100% 同源）。`--vscode-charts-*` 等主题色已在令牌层跟随，唯独图标形状体系自成一派 |
| 判定 | stroke=currentColor 已保证主题跟随；自绘一致性内部成立，**不构成缺陷**。但本轮目标「整体风格贴近 VS Code」下，codicon 是唯一与原生图标完全同源的路径 |
| 建议 | 暂不动。理由：① 18+ 图标全量替换成本 vs 收益需真机对比（自绘线条在深浅主题下渲染质量 vs codicon 字体渲染）；② 若日后再提，替换点集中在 `icons.ts` 单文件（`createIcon`/`populateIcons` 双路径已收口），改造面可控。登记为设计决策点，随真机验收一并看观感。 |

---

## 五、🟢 N4 · 显隐纪律孤例

`settingsView.ts:237`：`<div class="skill-content" style="display:none" ...>`
——全 webview 唯一的内联 style（旧报告量化基线已计数，未判性）。
显隐契约应为 `hidden` 属性（chatView 侧纪律：显隐一律 hidden + CSS `[hidden]` 兜底）。
一行修正，无风险。

---

## 六、复核确认已闭环（本轮对抗式复验通过，无需动）

| 项 | 复验证据 |
|----|----------|
| 闪烁三病根（P7/P8/C1） | `resolveDock` 单点裁决 + 免重排守卫（`chatView.ts:2657` head 已紧邻 anchor 不搬）+ 物理相邻纪律（非活跃条退 dockChip 之上）；台账 UI-CONFIRM-P9 已关闭 |
| 确认卡 30 分钟 fail-closed | host CONFIRM_TIMEOUT_MS 真源 + 末 60 秒倒计时（webview 不自算时长，协议违约显式抛错防静默） |
| 确认卡安全与可达性 | 全字段 textContent 防注入；焦点落「拒绝」与 fail-closed 同向 |
| tokens 运行时注入链 | settingsStyles 头部注入聚合四子视图 = 全面板覆盖，无幽灵面板 |
| 非豁免裸色值 | 0（仅 mask-image 渐隐遮罩 `#000` ×2 属豁免技术值） |
| 动画时长 | 全部走 `--dur-*` 令牌，零裸值 |
| 可访问性三件套 | prefers-reduced-motion 全局兜底 + forced-colors 压平 + `:where()` 零特异性焦点环（今日批次已落地） |
| 裸 px 冻结门 | 实测 74 = 基线 74，门在位未松 |

---

## 七、处置建议（待拍板后回写台账）

| # | 建议 | 建议台账条目 |
|---|------|--------------|
| N1 | **必修**。分两步：① 守卫扩展（颜色版 fallback 门，warning 档）② 83 处分诊消化（真漂移对齐 / 强度分化令牌化），门随消化升 fail | `UI-TOKEN-COLOR-1` |
| N2 | **必修**（文档撒谎成本最低、修正最快）。README 铁律 4 + tokens.ts:11 列举改写；dropdown 注入前提注释补齐（选注释方案，勿自带注入） | 并入 `UI-TOKEN-COLOR-1` 同批 |
| N3 | **搁置观察**。随真机验收看图标观感，不动代码 | `UI-ICON-1`（决策登记） |
| N4 | **随手修**。与其他显隐纪律归一 | 并入任意下一批 |

> 台账回写依 iron rule 待拍板执行；本报告为上述条目的证据锚点。
