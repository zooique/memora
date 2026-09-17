# Memora VS Code 插件 · UI 视觉审查（常驻）

> **定位**：本文件是 `hosts/memora-vscode/docs/` 的**常驻 UI 审查文档**——随 UI 迭代持续更新，记录当前视觉缺陷与整改清单。
> 历史对齐结论与视觉重构落地形态见 [host-overview.md](./host-overview.md)（单一事实入口）；目录结构见 [directory-structure.md](./directory-structure.md)。
> 日期：2026-08-24（首版）
> ⚠️ **失效提示（2026-09-18 复核）**：文中 `.checkpoint-banner`（G3 断点续跑横幅）**已从代码移除**（宿主 `src/` 零命中；`chatView.ts` 现为「不再弹硬编码 banner」），且 `chatView.ts:166`/`:200` 等行号引用**已漂**。以下相关小节保留为历史审查快照，**勿据此定位代码或推断现行 UI**。
> 方法论：visual-design-philosopher skill（先布局后样式 / 三层分类 / 视觉层级四维 / 聚合隔离 / 评审十问）+ 对抗式实锤核验
> 审查范围：`hosts/memora-vscode/src/webview/**` 全部样式与渲染现状

---

## 一句话先行

`ui-redesign.md` 那一轮的视觉重构**已基本全部落地**（身份标签 / 日期分隔 / 思考折叠 / 空态引导 / Composer / 工具卡片 / 配置面板分组都已实现）；但 8/15 之后**功能侧反向生长**出一批新组件（软暂停检查点横幅、任务看板、主动提问条、记忆治理区、后台通道 / Embedding 配置、技能选项卡），它们**各自克制、但彼此之间缺乏统一的布局编排纪律**——这才是本轮"UI 基于功能生长"真正要审查与收口的对象。

---

## 一、ui-redesign.md 落地核验（实锤，已做完）

| 设计项（ui-redesign.md） | 落地位置 | 状态 |
|---|---|---|
| 身份条 / 角色整合 | `chatStyles.ts` `.msg-ai-label`（顶部弱标签）+ `.role-badge`（footer 只读徽章） | ✅ 已落地（演进为更克制的"顶部标签 + footer 徽章"，非侧边头像） |
| 日期分隔线 | `chatStyles.ts` `.date-divider`（L151-159） | ✅ 已落地 |
| 思考折叠块 | `chatStyles.ts` `.thought-block` + `.thought-block__trace`（L610-652） | ✅ 已落地，并扩展 `.self-review` |
| 空状态引导 | `chatStyles.ts` `.empty-suggestions` chips（L137-144） | ✅ 已落地 |
| Composer 模型 + 附加能力 | `chatStyles.ts` `.composer-left/.composer-actions/.model-picker` | ✅ 已落地；附加能力收敛为角色徽章 + 工具权限徽章 |
| 工具卡片状态化 | `toolCard.ts` `--capsule` + 状态左边框色（L27-29, 55-64） | ✅ 已落地 |
| 配置面板顶栏统计 + 分区 | `configStyles.ts` `.stat-bar` + `.group-title`（L15-23） | ✅ 已落地 |
| 卡片图标 / 空态引导 | `configStyles.ts` `.cfg-icon` + `.empty-state`（L66, 74-76） | ✅ 已落地 |
| 设计令牌 SSOT | `tokens.ts` `--surface-thought` 等（L91-92） | ✅ 已落地，无裸值 |

**结论**：视觉重构定稿已被实现吸收，无需重审那一轮。本轮审查转向"功能生长出的增量组件"的布局编排。

---

## 二、功能生长出的增量组件清单（本轮新审查对象）

| 组件 | 引入标记 | 所属面板 | 形态 |
|---|---|---|---|
| 会话标题条 | `.session-title-bar`（含改名/新建/历史） | 对话 | **面板级常驻**顶部 + border-bottom（唯一硬边界） |
| 主活动条 | `.activity-bar`（error/info 分级） | 对话 | **面板级临时通知**（error 8s / info 2.5s 自动隐藏，error 优先保护） |
| 断点续跑横幅 | `.checkpoint-banner`（G3） | 对话 | **消息区内 prepend**（顶部，可关闭/续跑） |
| 任务看板 | `.plan-board`（H4） | 对话 | **消息区内 prepend**（顶部，任务完成移除） |
| 主动提问条 | `#clarifyBar` | 对话 | 面板级，activityBar 之后 / inputBar 之前（贴近输入区） |
| 记忆治理区 | `.governance`（G4） | 记忆子视图 | 顶部 border + 统计卡 + 操作 |
| 后台模型通道 | `.cfg-bg`（G5） | 配置子视图 | 顶部 border + 下拉（无分区标题） |
| Embedding 配置 | `.embedding-cfg`（G1） | 配置子视图 | 折叠区（无分区标题） |
| 写入审批开关 | `.security-*`（H0） | 设置安全子视图 | toggle |
| 技能选项卡 | `skillsStyles.ts`（2026-08-22 新增） | 设置技能子视图 | 卡片列表 |

---

## 三、对抗式审查发现（P0 / P1 / P2）

### 🟡 P1-0：checkpoint-banner / plan-board 抢占消息区顶部同一 prepend 点位（2026-08-24 复核修正）

> **对抗式复核修正**：首版将本项定性为 P0-1"四条灰线常驻主焦点模糊"（基于样式文件静态阅读）。核实渲染逻辑（chatView.ts）后**降级为 P1**：实际只有 `.session-title-bar` 面板级常驻（唯一硬边界 ✅）；`.activity-bar` 是临时通知（error 8s / info 2.5s 自动隐藏，且 error 优先保护，chatView.ts:995-1018）；`.checkpoint-banner` 与 `.plan-board` 均为 **messages.prepend()**（消息区内，随滚动）。"常驻灰线稀释主焦点"不成立。

**仍成立的真实问题**：
- checkpoint-banner（chatView.ts:166）与 plan-board（chatView.ts:200）**都 prepend 到消息区顶部**，后创建的盖住先创建的——任务执行中软暂停出现恢复横幅时，若 plan-board 尚在，恢复横幅被压在下面，用户需决策的"续跑"入口被遮挡。
- 三个临时块视觉同质（灰底 + border-bottom + 小字），虽底色已有区分（activity=info/error、checkpoint=info 底、plan=card 底），但无统一状态层级认知。

**整改方向**（聚合隔离四问 + 优先级协议，最小改动）：
1. **插入顺序协议**：checkpoint（需用户决策）永远在 plan（需感知）之上——`showRestoreBanner` 时若 planBoard 存在，插到其之前；`renderPlanBoard` 创建时若 restoreBanner 存在，插到其之后。一句话注释锁定协议。
2. 视觉区分维持现状（底色已不同），仅补 checkpoint 的强调（其携带"续跑"操作，可沿用 info 底 + accent 按钮，已具备）。

### 🔴 P0-2：skillsStyles.ts 裸值违规（违反 tokens.ts 令牌铁律）

**实锤**（skillsStyles.ts）：
- L62：`border-left: 3px solid #4caf50;`（用户技能绿）
- L68：`border-left: 3px solid #0e639c;`（内置技能蓝）
- L94：`color: #90caf9;` / L95：`background: rgba(14, 99, 156, 0.2);`
- L99：`color: #81c784;` / L100：`background: rgba(76, 175, 80, 0.15);`
- L38：`padding: 4px 10px;`（裸间距，不在 `--sp-*` 刻度）
- L89/L108：`border-radius: 8px` / `3px`（裸圆角，不在 `--radius-*` 刻度）
- L106：`var(--accent-subtle, ...)` —— `--accent-subtle` 在 tokens.ts 中**未定义**，回退裸值

**根因**：技能选项卡是 2026-08-22 最后加入的文件，功能生长时未守 `tokens.ts` 铁律（"裸值只能出现在令牌文件"）。这是"新功能赶工漏守纪律"的病灶。

**整改方向**：
1. 在 `tokens.ts` 新增 L2 语义令牌：`--skill-user-accent`（绿系，复用 `--status-pass` 体系或独立定义）、`--skill-agent-accent`（蓝系，复用 `--accent`）、`--accent-subtle`（accent 的低透明底，已有多处 `--accent` 半透明写法可统一）。
2. `skillsStyles.ts` 全部改用令牌引用，`4px 10px` → `var(--sp-2,6px) var(--sp-5,12px)` 等刻度值，`8px/3px` → `--radius`/`--radius-sm`。
3. 与 `memoryStyles.ts` 的 `source-badge-*` 同构：语义色集中在令牌层，组件层只引用。

### 🟡 P1-1：配置子视图"区块堆叠"无统一分区间距协议

**实锤**（configStyles.ts）：`.cfg-bg`（G5 后台通道）、`.embedding-cfg`（G1）、Provider 列表、`.governance`（记忆侧无，但设置侧有 security）各自用 `border-bottom` 平铺。新增的 G1/G5 区块与原有 Provider 分区视觉权重相同，用户难区分"这是全局设置还是某个 provider 的设置"。

**整改方向**：遵循 ui-redesign.md 已建立的 `.group-title` 分区标题语言（L23），把 G1/G5 也归入显式分区标题下（如"检索增强"、"后台通道"），用分组标题而非仅靠 `border-bottom` 表达层级。

### 🟡 P1-2：主动提问条 `#clarifyBar` 位置与活动条语义重叠

**实锤**：`#clarifyBar` 用 `border-top` + warn 底置于消息区**底部**（L727-747），与活动条（顶部）+ 检查点横幅（顶部）形成"顶部通知 / 底部提问"的割裂。提问是"等待用户输入"的高优先级交互，却沉在底部，易被长消息淹没。

**整改方向**：提问条上升为顶部二级状态（与检查点同优先级，甚至更高），或至少在全屏消息区滚动时保持吸顶（`position: sticky`），保证"用户需回应"的操作不被滚走。

### 🟢 P2-1：配置/角色/记忆三子视图样式高度同构但未抽共享

**实锤**：`rolesStyles.ts` / `configStyles.ts` / `memoryStyles.ts` 的 `.card` / `.header` / `.stat-bar` / `.empty-state` / `.btn` 几乎逐行重复（仅前缀不同）。当前靠 `#xxx-root` 前缀隔离是正确的（避免串扰），但**重复定义**意味着未来改一处卡片样式要改三处。

**整改方向**：在不破坏前缀隔离的前提下，把 `.card` / `.header` / `.empty-state` 的**视觉定义**收敛到 `settingsStyles.ts`（已内嵌 tokens），子视图文件只保留差异（前缀限定 + 特有元素）。属于 ui-engineering 层纪律，不紧迫但值得在本次 UI 编排轮一并收口。

### 🟢 P2-2：记忆治理区"衰减/清理"危险操作视觉降级不足

**实锤**（memoryStyles.ts L159-171）：`.btn` 用于"清理"危险操作，与"衰减"次按钮同为 accent 实心。危险操作未与安全的"衰减"拉开强度差，违反视觉哲学 skill"危险操作降噪原则"。

**整改方向**：清理按钮改用 `--btn-danger-bg`（已存在令牌，L79）或至少 `--btn-secondary-bg` + 危险色文字，与可逆的"衰减"拉开强度差；并复用 ui-redesign.md §七 的"审批三档"语义（可逆=软确认，破坏性=硬确认）。

---

## 四、布局决策清单（视觉哲学 skill）逐条核验

| 检查项 | 现状 | 结论 |
|---|---|---|
| A 元素归类（一/二/三） | 角色切换（每天）→ 一级 footer 徽章 ✅；检查点续跑（每周）→ 二级 ✅；Embedding 配置（每月）→ 专家挖掘（折叠区）✅ | 基本合理 |
| B 聚合 vs 隔离四问 | 会话历史聚合到标题条 ✅；危险操作（删除会话 hover 显 / 清理按钮未降级）⚠️ | P2-2 待修 |
| C 主焦点三问 | 对话面板主焦点被四条灰线稀释 ❌ | **P0-1 核心问题** |
| D.1 Agentic 三要素 | Context-aware（inline 思考/工具）✅；Transparent（活动条/轨迹）✅；Controllable（停止/暂停/续跑）✅ | 已对齐 |
| D.2 信任增量 | 工具状态色 ✅；任务看板 N/M ✅；逃逸舱（停止/续跑/润色）✅ | 已对齐 |
| D.3 核心五原则 | 工具卡片可视 ✅；自主模式（角色/能力徽章）✅；进度（plan-board）✅；审批分级（清理已降级为 danger 按钮）✅ | 已修复 |
| E 反模式速查 | checkpoint/plan 抢占同点位（修复后按优先级插序）；skills 裸值（已收敛令牌） | P1-0 / P0-2 |

---

## 五、整改落地记录（2026-08-24 已执行）

| 优先级 | 任务 | 落地 | 验证 |
|---|---|---|---|
| ~~P0-1~~ → **P1-0** | checkpoint/plan 抢占消息区同一 prepend 点位 | chatView.ts 新增 `prependStatusBlock()` 插入协议：检查点横幅（需决策）恒在任务看板（需感知）之上 | ✅ tsc 无新增错误 + chatView.test 69 过 |
| **P0-2** | skillsStyles 裸值收敛 | tokens.ts 新增 `--skill-agent-accent`（=accent）/ `--skill-user-accent`（=status-pass）/ `--accent-subtle`（补定义）；skillsStyles 全部改令牌引用，删 `#4caf50/#0e639c/#90caf9/#81c784` 与裸间距/圆角 | ✅ settingsView.test 5 过 |
| **P1-1** | 配置子视图 G1/G5 归入显式分区 | settingsPanel.ts 在 cfg-bg 前加 `<div class="group-title">模型通道</div>`（复用已有 group-title 样式） | ✅ settingsView.test 5 过 |
| **P1-2** | 主动提问条吸顶 / 升优先级 | **裁定不修**：复核 DOM 后 clarifyBar 位于 activityBar 之后 / inputBar 之前（贴近输入区，非"沉底被淹没"），且为等待输入的高优先级交互，当前位置符合"输入前置"语义 | 维持现状 |
| **P2-2** | 记忆治理"清理"按钮危险降级 | settingsPanel.ts `#btnCleanup` 改 `btn-danger` 类；memoryStyles.ts 补 `.btn-danger`（复用 `--btn-danger-bg`），与可逆"触发衰减"拉开强度差 | ✅ memoryView.test 15 过 |
| P2-1 | 三子视图 `.card/.header/.empty-state` 收敛 | **本轮不做**：三处重复为同构复制但各自带前缀隔离，.card 存在 align-items 差异（roles=flex-start / config=center）；无第三消费者需求时收敛属提前抽象，违背复杂度守恒。留待出现实际改动需求时再收敛 | 开放项 |

**质量门**：宿主 `tsc --noEmit` 错误全部为 pre-existing（hostIntegration.test / writeConfirm.test / assemble.ts vscode 命名空间），本次改动文件零新增；webview 三测试文件 89 用例全过（chatView 69 / settingsView 5 / memoryView 15）。

**trae 跟进修复（commit 2e0f8355，2026-08-24，已推送 gitee main）**：
| # | 修复项 | 落地 | 质量评估 |
|---|---|---|---|
| P1 | 设置面板加载态 | 5 子视图 `<p class="hint">加载中…</p>` → `.loading-hint`（spinner + accent 左边框 + info 底），settingsStyles.ts:55-82 | ✅ 优秀——补真实四态缺口（加载与空态此前同视觉）；令牌零裸值；reduced-motion 覆盖 |
| P2-A | 看板 vs 思考块 | `.plan-board` 加 `border-left: 3px solid var(--accent)` | ✅ 合理——进度可感知（D.3 检查项 10）；与 checkpoint 按钮焦点不冲突 |
| P2-B | 自审查信任信号 | `.self-review` `transparent` → `var(--feedback-info-bg)` | ✅ 方向对——透明背景浪费信任信号，低对比 info 底"看得见不抢"；与 activity-bar.info 同底但靠圆点+文本区分 |
| P3 | 卡片外壳对齐 | `.skill-item` 背景 `surface-hover→surface-sidebar` + 边框 0.2→0.4 | ✅ 比预期更完整（背景一并并入 A 类语言）；**未动 security-item 是正确边界**（低频设置项形态不同，浅底是"设置项 vs 数据卡片"层级区分，非遗漏） |

**第三轮审查新发现（2026-08-24 续）**：
- 🟡 **搜索无结果空态无引导**（memoryView.ts:89）：'没有匹配的记忆' 是高频场景（用户搜不存在的词），缺"换个关键词"引导——违反四态空态要求（告诉用户怎么让它出现）。
- 🟡 **roles/memory 空态无动作**（rolesView.ts:66 / memoryView.ts:89）：'暂无角色包'/'暂无记忆' 只有标题（低频：角色包出厂自带、记忆聊天即生成，但一句话可补）。
- 🟢 **P2-1 收敛时机已到**：P3 后 `.skill-item` 与 `.card` 视觉一致，代码 4 处同构重复（roles/config/memory/skills）——"三次以上重复才提取"触发线已过，可收敛公共卡片外壳到 settingsStyles（保留前缀隔离与内容布局差异）。

**纪律红线**（对齐 ui-engineering-mindset-rules + tokens.ts）：
- 本轮只做**布局编排与视觉优化**，不改协议、不引入框架、不重写架构（延续 ui-redesign.md §十）。
- 所有裸值改动必须回到 `tokens.ts` 单一真理源；组件层只引用令牌。
- 每步独立可验证：typecheck 干净 + 现有渲染测试全过。

---

## 六、结论

memora 种子完善、插件基于种子生长完毕这一前提成立——**功能与视觉骨架都已到位**。首版审查的"四条灰线稀释主焦点"（P0-1）经渲染逻辑复核修正为"checkpoint/plan 抢占消息区同一点位"（P1-0），并已通过插入顺序协议修复；skills 令牌裸值（P0-2）已收敛；G1/G5 分区（P1-1）、清理按钮危险降级（P2-2）已落地。trae 第二轮修复（P1 加载态 / P2-A 看板区分 / P2-B 自审查可见 / P3 卡片外壳）经实锤评估质量良好、零裸值零回归。剩余：P2-1（卡片外壳代码收敛，时机已到）、记忆搜索空态引导（高频，待补）。
