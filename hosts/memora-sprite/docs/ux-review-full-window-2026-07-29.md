# 体验评审报告 · 完整窗口（Memora Sprite）· v2（规则对齐修订版）

> **激活声明**：已激活 `big-tree-grower` 技能「体验评审」模式（入口 8），针对 `hosts/memora-sprite` 的**完整窗口**（主 Electron 窗口渲染层 `src/electron/renderer/` + `styles/` + `index.html`，不含浮动窗口 / 快速输入窗）执行 7 维度体验评审。
>
> **评审日期**：2026-07-29
> **项目名称**：memora-sprite（桌面 sprite 宿主）
> **评审范围**：完整窗口（全站级，覆盖窗口骨架 + 全部主面板 + 浮层组件）
> **项目阶段**：生长稳定期 → 成熟期（核心面板已完成，以优化/打磨为主）

---

## 一、前置规则加载与映射（修正 v1 的流程误判）

v1 报告误判「三份前端规则文件缺失」。经在 **memora 内核 `.trae/rules/`** 核查，技能 `ux-review-guide.md` 引用的三份文件名是**抽象别名**，实际存在但拆分/改名如下（以 `abstract-term-mapping.md` 的「规则定义怎么做，Skill 定义做什么」原则映射）：

| 技能引用的文件名（别名） | 实际对应（内核 `.trae/rules/`） | 内容 |
|------|------|------|
| `frontend_architecture_rules.md` | `sprite-project-rules.md` §3 技术栈 / §4.1 渲染进程分层约束 + `ui-engineering-mindset-rules.md` §一~§三 | 前端技术栈、组件规范、设计令牌、样式入口 |
| `architecture-quickref.md` | `ui-engineering-mindset-rules.md` §四（组件抽象/工厂/分层速查）+ `sprite-project-rules.md` §4 | 前端工厂模式、通用组件、命名约定 |
| `project-rules.md` | `project-rules.md`（精确命中）+ `sprite-project-rules.md` §5 命名 | 项目通用约定、命名规范 |

**本轮已加载**：`sprite-project-rules.md`、`ui-engineering-mindset-rules.md`、`project-rules.md` 三份。

> **技能体验缺陷（需反馈给 skill 维护者）**：`ux-review-guide.md` 硬编码了三份「期望存在」的规则文件名，但项目实际文件名/拆分不同。技能应改为「经 `abstract-term-mapping.md` 映射到实际文件」或显式列出内核实际文件名，否则每次评审都会误报「规则缺失」。

---

## 二、总体评分表

| 维度 | 评分 | 状态 | 一句话 |
|------|------|------|--------|
| 1. 视觉一致性 | 8 | ✅ 优秀 | 令牌系统完整双主题；仅 `.empty-state` 垂直 48px 裸值泄露（已核实） |
| 2. 交互模式一致性 | 8 | ✅ 优秀 | modal/toast/button/confirm 模式收敛，不可逆操作保护完善 |
| 3. 操作路径与心智模型 | 7 | ⚠️ 良好 | 术语本地化彻底；侧边栏纯图标无标签/tooltip（设计取舍） |
| 4. 状态覆盖 | 5 | ⚠️ 需关注 | 加载态严重不足 + 空态碎片化（规则已点名的架构债） |
| 5. 认知负荷 | 7 | ⚠️ 良好 | 中文标签清晰；高密度面板 + 个别技术词 |
| 6. 导航与信息架构 | 7 | ⚠️ 良好 | Grid 骨架/快捷键完整；响应式按「不做移动端」设计为非适用 |
| 7. 视觉审美（千树一面检测） | 7 | ⚠️ 良好 | 青绿强调色避开模板风；CJK 用 system-ui 是合理选择（非千树一面误报） |
| **综合** | **7.0** | **良好** | 功能扎实、令牌化到位；短板集中在「加载态」与「空态一致性（规则已预判的架构债）」 |

> 综合评定：8+=优秀、6-7=良好、4-5=需关注、<4=需重点改进。

---

## 三、问题清单

### 🔴 严重（阻塞用户操作）
**无。** 最强保障（不可逆操作 `danger:true` 确认、发送按钮 loading 防重复、错误态 `renderErrorState`/`initFailureCard`、Toast FIFO）均已落地，不存在「提交/删除无反馈」「回不去的页面」「关键 CTA 不可点」类阻塞。问题集中在一致性打磨，非功能阻断。

### 🟡 中等（影响体验，且多数已被项目自身规则点名）

**M1 · 加载态覆盖严重不足（规则已预判）**
- 维度：4（状态覆盖）
- 位置：`helpers/domHelpers.ts:149` `showPanelLoading` 仅 3 处调用（`healthDashboardRenderer.ts:88`、`insightsRenderer.ts:83-84`）。
- 规则依据：`ui-engineering-mindset-rules.md` §四.2「加载状态、空状态、骨架屏、错误处理是**工厂的职责**」——即加载/空/错属跨面板横切关注点，应集中而非散落。当前未建工厂，故横切态未覆盖。
- 影响：dashboard / perception / profile / audit / workProjection / memory 等异步面板首屏数据返回前**无 loading 占位**，存在「空白突然出现」风险。
- 建议：异步加载入口统一套用 `.panel-loading` 骨架（可抽取共享函数）；长期按 §四.2 抽 `ListPanel` 工厂统管。

**M2 · 侧边栏 64px 纯图标、无文字标签、无 tooltip（设计取舍，非规则违规）**
- 维度：3（操作路径与心智）+ 6（导航）
- 位置：`styles/layout/sidebar.css:11`（固定 64px 图标模式）、`:41-43`（`.sidebar-brand-name{display:none}`）、`:145-146`（导航名称提示气泡 `data-tooltip ::after` **已弃用**，注释称「.active 态已足以表达位置」）；`index.html:217-240` 导航按钮仅靠 `aria-label`/`aria-labelledby`。
- 说明：**无任何项目规则禁止此设计**，属有意的紧凑取舍。但视觉用户首次访问无 active 提示时仅靠图标识别，新用户发现性仍有风险（无障碍名由 aria 提供，视觉名缺失）。
- 建议：低成本的 hover `data-tooltip` 气泡即可消除风险，且不破坏 64px 紧凑；或图标下加极简文字。

**M3 · 空状态碎片化 + 共享基类自身令牌泄露（规则已点名架构债）**
- 维度：4（状态覆盖）+ 1（视觉一致性）
- 规则依据（强支撑）：
  - `ui-engineering-mindset-rules.md` §二「通用组件封装完整交互状态——必须覆盖 `:empty`（空状态）」——空态是组件契约的一部分；
  - §四.2「记忆面板、审计面板、设置面板有共同结构（标题 + 列表 + 详情）…应抽离 `ListPanel`/`DetailPanel` 工厂」——**项目自身规则已预判此债**。
- 位置与证据：
  1. 共享工厂 `createEmptyState`（`domHelpers.ts:388`）仅 2 处调用（`memoryTimelineView.ts:78`、`memoryPanelManager.ts:341`）；其余 10+ 处手写 `.xxx-empty` 裸 div（`auditPanelManager.ts:162`、`.profile-empty`、`.completion-stats-empty`、`.date-nav-empty`、`.llm-result-empty`、`.perception-proactive-empty`、`.memory-graph-empty`、`.lineage-empty`、`.search-messages-empty`、`.work-projection-empty` 等），视觉可能偏离 `.empty-state` 基线。
  2. **共享基类自身泄露**：`base.css:332` `.empty-state { padding: 48px var(--space-6) }` —— 垂直 `48px` 为裸值，不在 `--space-*`（4/8/12/16/24/32）刻度，且 padding 不属于「布局 width/height」例外 → 违反 `ui-engineering-mindset-rules.md` §一「令牌即契约（17px 不是差一点，是差一个体系）」+ `directory-structure.md` §2.4.6「间距走 `--space-*`，禁止裸写 px（布局 width/height 等除外）」。`width:48px/height:48px`（`.empty-icon`，base.css:338-339）属布局尺寸例外，不算泄露。
- 建议：① 收敛空态到 `createEmptyState` 工厂 + 统一 `.empty-state` 基线类；② 将 `.empty-state` 的 `48px` 收为令牌（新增 `--space-12: 48px` 或改用 `--space-8`/`--space-10`）以消除令牌泄露；③ 长期按 §四.2 抽 `ListPanel` 工厂统管空/加载/错三态。

### 🟢 轻微（影响精致度）

**L1 · 画布强调色 fallback 硬编码蓝（潜在地雷）**
- 位置：`relationGraphColor.ts:70` `'--accent': () => '#0066ff'`、`partnerInsightsRenderer.ts:340` `--accent-20` fallback `rgba(0, 102, 255, 0.1)`、`dashboardPanelManager.ts:689` `#0066ff`。
- 说明（实测）：`resolveCssVar` 先读 `getComputedStyle(documentElement).getPropertyValue('--accent')`，**非空即返青绿 `--accent:#0d7377`**；正常运营 token 已定义，蓝色 fallback **不触发**。但 fallback 值与「避开蓝白企业风」设计意图冲突，属潜在品牌一致性地雷 + 手动同步脆弱（注释自称「与 base.css 保持同步」）。
- 建议：fallback 对齐 teal（`rgba(13,115,119,…)`）；或读取失败时「不绘制」而非退化蓝。

**L2 · icon-btn 点击区 28×28（桌面可接受，非触控缺陷）**
- 位置：`base.css:230-231`（`.icon-btn` 默认 28×28，另有 32/36 尺寸）。
- 说明（修正 v1）：技能 ux-review-guide 的「≥44×44px 可点击区域」是**移动端触控建议**；项目 `sprite-project-rules.md` §6 明确「**不做移动端——专注桌面场景**」，故 44px 基准**不适用于本桌面应用**。桌面鼠标精度下 28px 可接受，仅密集工具栏（chat 工具栏、graph 工具）偶有拥挤感。
- 建议：可选——关键主操作按钮（非全量）适度放大热区或加内边距；非阻塞。

**L3 · 视觉个性偏弱（非缺陷，设计取舍）**
- 位置：`app-grid.css` 灰底 + 白色悬浮卡单阴影，无纹理/层次。
- 说明：悬浮卡于中性底是通用 SaaS 套路，品牌辨识度有限；但已用青绿强调色 + 品牌渐变 logo 拉开距离，属克制取向。
- 建议：底板/卡片引入极淡渐变或分隔肌理强化品牌，保持克制。

**L4 · 个别可见技术词**
- 位置：`index.html:334` `token-usage` 等；高密度面板（`settingsPanelManager` 47KB、`memoryPanelManager` 65KB 含嵌套 tab）。
- 建议：用户可见处用语义化中文（如「令牌用量」）。

**L5 · aria-labelledby 引用可能被隐藏的面板标题**
- 位置：`index.html:220/224/228`（nav-btn `aria-labelledby="panel-title-*"`）指向 `:450/503/...` 中默认 `aria-hidden="true"` 的面板标题。
- 说明：非激活/初始态下被引用标题对辅助技术不可见，导航按钮可能缺可访问名。
- 建议：导航名改用独立 `aria-label`，不依赖可能被隐藏的面板标题。

---

## 四、各面板评审详情

| 面板 / 组件 | 1 视觉 | 2 交互 | 3 路径 | 4 状态 | 5 负荷 | 6 导航 | 7 审美 | 小结 |
|------|----|----|----|----|----|----|----|------|
| 窗口骨架（titlebar/sidebar/main-content/aux-sidebar） | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ | Grid 清晰；侧边栏无标签为有意取舍 |
| 对话面板 chat | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | 发送防重复/流式安全计时器完善；首屏 loading 缺 |
| 记忆面板 memories | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | 视图多（列表/时间线/图谱/详情）；密度偏高；空态已用工厂 |
| 设置面板 settings | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | 嵌套 tab 多；不可逆操作均 danger:true（已验证） |
| 精灵设定 sprite-settings | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | 角色/规则/技能三类 CRUD 隔离良好 |
| 感知面板 perception（aux） | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | 异步加载无 loading 占位 |
| 仪表盘 dashboard（aux） | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | 增长趋势图 canvas 蓝 fallback（L1） |
| 剪贴板面板 clipboard | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 待处理角标 nav-badge 设计用心 |
| 浮层：modal | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | 焦点陷阱 + 危险态 + 并发保护完善 |
| 浮层：toast | ✅ | ✅ | — | ✅ | ✅ | — | ✅ | FIFO 上限 5，样式统一 |
| 浮层：command palette（Ctrl+K） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 类 VS Code 浮层，路由覆盖主/aux 面板 |
| 确认弹窗 confirm | ✅ | ✅ | — | ✅ | ✅ | — | ✅ | 宽度 400px 规范，danger 态统一 |

> 注：「—」表示该维度对该组件不适用（如浮层无导航维度）。

---

## 五、优先行动（按严重程度，已对齐项目规则）

1. **[M3 高优先·规则已点名]** 空态收敛 + 令牌修复：① `createEmptyState` 工厂统一收口，替换散落手写 `.xxx-empty`；② 修 `base.css:332` `.empty-state` 的 `48px` 裸值为令牌；③ 长期按 `ui-engineering-mindset-rules.md` §四.2 抽 `ListPanel`/`DetailPanel` 工厂统管空/加载/错。
2. **[M1 高优先·规则已点名]** 统一加载态：抽取/复用 `.panel-loading` 骨架，覆盖所有异步面板（dashboard/perception/profile/audit/workProjection/memory）。
3. **[M2 中优先]** 侧边栏补发现性：恢复 hover `data-tooltip` 气泡或加极简文字标签（低成本、不破坏 64px 紧凑）。
4. **[L1 中优先]** 画布 fallback 对齐青绿（teal），消除蓝值潜在地雷；`--accent-20` 蓝 rgba 同步修正。
5. **[L2-L5 低优先/非阻塞]** icon-btn 热区（桌面可接受）、底板纹理、技术词本地化、nav `aria-label` 独立化。

---

## 六、UX 亮点（值得保留）

- **设计令牌系统完整且双主题**：`tokens.css` 全套变量 + WCAG AA 对比度注释；激活态语义令牌统一 `.active`/`.selected`/`.current`（`:62-67`）。符合 `ui-engineering-mindset-rules.md` §一「令牌即契约」主体要求（仅一处 48px 泄露，见 M3）。
- **术语本地化彻底**：`sourceLabel.ts` / `personaLabel.ts` / `toolNameMap.ts` 消除英文直显，符合「命名匹配用户语言」。
- **不可逆操作保护完善**：modal `danger` 态（确认按钮变红 + 焦点落取消键，`modal.ts:248-323`），18 处 `danger:true`，含 settings 三处已对抗式验证全部带危险标记。
- **发送防重复**：`setButtonLoadingEl` + `aria-busy` + 发送时 `btn.disabled`。
- **动效克制且 token 化**：`base.css` 动画走 `--duration-*` + 支持 `prefers-reduced-motion`（`:195-205`），无障碍友好。
- **浮层工程扎实**：Toast FIFO 上限 5、Modal 焦点陷阱 + 并发保护。
- **快捷键体系完整**：`Ctrl+1-5`/`.`/`/` + `Ctrl+K` 命令面板 + `Esc` 分层处理。
- **前端架构分层清晰**：`sprite-project-rules.md` §4.1 渲染进程分层约束（controllers/panels/components/ui.ts 单向依赖）+ `ui-engineering-mindset-rules.md` §四 组件生命周期/工厂/分层导出口，为一致性提供制度保障。

---

## 七、技能体验适配说明（meta）

本轮评审暴露 **「通用 UX 清单 × 项目规则」冲突** 的技能体验问题，值得反馈给 `big-tree-grower` 维护者：

1. **规则文件名硬编码**：`ux-review-guide.md` 写死 `frontend_architecture_rules.md` 等三份文件名，但项目实际以 `sprite-project-rules.md` + `ui-engineering-mindset-rules.md` 拆分承载 → 每次评审误报「规则缺失」。应改为经 `abstract-term-mapping.md` 映射或引用实际文件名。
2. **通用清单的移动端假设**：ux-review-guide 维度 6 的「375px/768px 响应式」「≥44×44px 触控热区」默认假设移动端；但本项目 `sprite-project-rules.md` §6 明确「**不做移动端**」。盲目套用会产出**误报**（v1 报告的「响应式断点失效」「44px 触控不达标」已被证伪）。**结论：技能通用清单须以项目规则为覆盖层，冲突时项目规则优先。**
3. **千树一面清单的 system-ui 误报**：`frontend-aesthetics-guide.md` 将 `system-ui` 列入禁用字体；但本项目对中文桌面应用采用 `system-ui + Microsoft YaHei/PingFang SC` 是**合理工程选择**（非模板化 Inter/Roboto）。该清单项在此场景下是误报，评审时应结合项目语言环境判定。

> **退出声明**：已按 `big-tree-grower`「体验评审」模式、加载 memora 内核前端规则后完成完整窗口 7 维度评审（v2 规则对齐修订版）。未执行任何代码修改（诊断模式）。本版修正了 v1 的移动端/触控/规则缺失三类误判，并依项目自身规则强化了空态/加载态两项架构债的优先级。建议的优先行动可经「提交前审查」或「方案更新」链路落地。
