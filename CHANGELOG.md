# Changelog

本文件记录 **@zooique/memora（内核 npm 包）**的版本变更。**宿主**（`hosts/memora-vscode`）不在发布包 `files` 白名单内（见 `package.json`），不占内核版本号——其变更与本轮**已定档 3.1.0** 的项一并归入 `[Unreleased]` 区。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> **版本定位（v3.0.0）**：**Node.js 专属 · 零第三方运行时依赖的 Agent 内核**（依赖 `node:*` 内置模块，不引第三方运行时依赖 / native / 宿主 API）。早期版本（2.1.0 及以下）为探索性迭代；**3.0.0 是架构收敛后的第一个稳定基线**，API 与结构以 3.0.0 为准。内核不内置 agent 级行为评估（eval）/ 独立验证——由宿主基于内核可观测性（ITracer / 事件 / 指纹）自行承担；内核对接口契约与单测（2700+ 用例）负责，不对"agent 整体行为稳定"作承诺。

## [Unreleased]（宿主变更 · 不占内核版本号）

> **本区归属**：仅**宿主**（`hosts/memora-vscode`）变更——不占内核版本号（理由见文首说明）。内核 3.0.0 的发版内容在其下方。

### Fixed（宿主 · 纯删除块装饰改红：删除点被染成新增色的语义错位）

**问题**：`buildDecorationItems` 把纯删除块的锚行走与新增/修改**同一个绿色装饰**——绿底直觉是「这行是新内容」，而删除锚行本身是**未变的其他内容**（删除点在新文件中不覆盖任何行，装饰只能落在锚行），颜色语义相反；且行尾红色预览删除后，删除点只剩 hover 一层信息。

- **修法**：装饰成对化（`DecorationPair`：added 绿 / removed 红）。红侧 = 红竖条主信号 + 极淡红底（0.10，远淡于绿 0.18，避免「该行被删」误读）+ 红 overview ruler；同样**惰性构建**（模块顶层求值 `OverviewRulerLane` 会炸最小 mock 环境，同前轮教训）。`buildDecorationItems` 拆两侧返回，两侧用不同 decorationType
- **空侧不调 `setDecorations`**：空数组调用是纯噪音；曾挂载的装饰随旧 type 的 dispose 一并清除，无残留面
- **选择性吸收**（对照同类 IDE 变更确认视图的评估结论，详见方案文档 §11.14）：只吸收行级「新增绿 / 删除红」分流；词级内联幽灵文本属扩展 decoration API 硬边界、渲染态叠加与「先改后审」模型（与 DIFF-7 残留同源，memora 先审后写天然避开）均**不追**
- **验证（先红后绿）**：新增守卫 2 条（修改/新增块挂绿且红侧空不产生调用 / 纯删除块挂红且 `renderOptions` 仍 undefined、hover 保留）；**变异**（红/绿分流删除）→ **恰 1 红**、红在断言本体，还原复绿；宿主 `tsc` 0 / `eslint` 0 / fileChange 三套件 **90 passed**

### Changed（宿主 · 文件改动可视化的 SSOT 收口 + 描述层回扫）

**问题（SSOT 收敛 · 内核零改动）**：上一批「文案口径单源」提交（`COMPARE_LABEL`）自身仍留 **2 处并列真理源**，且 `docs/` 第 1 层回扫漏网——即「改一处碰一片」的反面：**两处各写一份，改一处只碰一处**。

- **① 忽略目录改派生内核真源**：`chatPanel.ts` 原手写 14 项 `IGNORED_DIRS`。内核 `IGNORED_DIR_NAMES`（`builtinToolHandlers.ts`，注释原文「宿主通过主入口 import 此常量对齐忽略目录，**避免数值/规则漂移**」）早已由 `src/index.ts` 导出、宿主 `projectSearchProvider.ts` 亦已 import 复用 ⇒ 本次新写的第二份是**并列副本**（6 项重合）。改 `new Set([...IGNORED_DIR_NAMES, ...宿主独有产物目录])`；危害面：内核新增忽略目录时快照仍扫它 → 内部数据混进改动可见性（静默）
- **② 降级提示抽单点常量**：写前降级 / 写后降级两条路径各写一遍同一句文案（相隔 9 行）⇒ 抽 `SNAPSHOT_OVERSIZE_NOTICE`，并把重复的 `post` + 重复的 `ok && !blocked` 判据收敛为两分支各一次调用（行为等价）
- **③ 描述层回扫（`docs/` 第 1 层）**：`方案-文件改动diff可视化-20260926.md` 尚有 **3 处「打开对比」（本轮改名漏扫）+ 10 处「恢复旧版」（上一轮改名漏扫）**，全落在 §3.4 / §3.5 / §7 等**现状断言**段 ⇒ 统一为实际发货标签（查看对比 / 回退本文件改动 / 确认改动）。`tasks/` 中的同名旧称属**历史过程记录**，按 `legacy-contract-audit-rules` §3.3 第 8 层边界**不动**
- **④ 同一设计真值去重复陈述**：「左右分栏 vs 自渲染上下视图」的选型理由原在 `fileChangeView.ts` 文件头与 `openCompare` jsdoc **各写一遍**（第二真理源）⇒ jsdoc 删复述改指针，文件头去日期编年、保留「勿改回」防回归信号；并去痕一个残缺变体选择符（U+FE0F）
- **⑤ 回退安全判据「判据面 / 通道面」分离**：§4.4 原措辞「必须经内核工具路径**或**同源校验」+「宿主 fs 直写属禁止项」读起来否定现状；§7 第 6 条（断言走内核写路径）与第 10 条（断言走宿主直写）**自相矛盾**。据实收敛：**判据面** = 必过 `assertPathAllowed`（与内核 SecurityGuard 同源，守卫缺失 fail-closed）；**通道面** = 宿主直写（无活跃 loop 时内核工具不可达，且经工具会伪造 `tool_start`/`tool_result` 污染时间线），故**宿主直写为定案、非带伤**
- **验证（实测）**：宿主 `tsc` 0 / `eslint` 0；fileChange 四套件 **93 passed**（与改前同数，零行为变更）；根 `terminology:check` 0；`prettier --check` 全绿
- **入档**：`CHAT-SNAP-1` 补第 ④ 条残留缺口（`scriptSnapshots` 异常流不回收，严重度按「全量快照 × 可并发驻留」记）

### Fixed（宿主 · 问答卡纳入工具批切段：外部可见条目作断面 BATCH-SPLIT-1）

**问题（登记在案缺陷 BATCH-SPLIT-1 · 纯宿主渲染层，内核零改动）**：`groupToolBatches` 只吃 `events`，而问答卡（`.round-block__input`）来自 `interactiveInputs` / 运行时缓存——**无 seq、不在 events 里** ⇒ 对切段判据天然不可见。两段工具之间夹一张问答卡时（工具 A → ask_user → 卡片 → 工具 B），A 与 B 被并成一批、批块锚在段内首工具 ts，卡片被推到整块**之后**（观感「问答卡之后的工具跑到卡片前面」）。复现路径 `renderReplayRound`（打开历史会话走它）+ 运行时流式（`renderProcessFlow`），两路同病。

- **根因（同屏两套键 · 与 PLAN-GROUP-ORDER-1 同族）**：切段判据按 **seq** 扫描（`[...events].sort((a, b) => a.seq - b.seq)`），条目落位按 **ts**（`insertPlanItemInOrder`）⇒ 无 seq 的外部可见条目对切段天然不可见
- **修法（最小 · 不碰内核）**：新增 `visibleInputTs(root, extra)` 抽出「同容器里实际可见的问答卡 ts」，作**虚拟断面**注入 `groupToolBatches`。判据 = 「桶号」（小于该工具 ts 的边界数）变化即断段——**与落位同用 ts 键**（呈现在哪、断面就在哪），不引入第三套键（缝合风险按此规避）
- **接线两处**：finalize 重建（DOM 快照 + `interactiveInputs` 入参）/ 运行时流式（`flow` 内已上屏问答卡）——同一判据、同一入参名，禁内联三份
- **清账**：封存期 `it.fails` 守卫（「期望失败」）**转红 ⇒ 升格为普通 `it`**，该动作即清账触发器、已触发；另补**流式对拍用例**一条（同一不变量），防「只修一路」
- **验证（先红后绿 + 变异）**：隔离 `3 passed`；**变异**（`bucketOf` 恒返回 0）→ 两条守卫**恰 2 红**、前置自检仍绿 ⇒ 守卫有牙；宿主全量 `785 passed | 2 skipped`、`tsc` 0
- **内核侧事实（已核实，非推理）**：提问走 `ask_user` 内置工具（唯一通道）⇒ 真实轮次在 A 与 B 之间必有该工具行（夹具已补，保真度修复）；工具轮 narrate 为**条件产出**（`if (narration)`）⇒「无 narrate」边界真实可达；`willSuspendForAsk` 命中时**不产出** `plan_item_boundary`
- **入档**：判据并入 `docs/方案-工具批按step断段-20260926.md` §4.1 表 + §4.2 伪码（此前只存在于代码注释 ⇒ 真理源缺层）
- **真机待复验**：两处接线（重放打开历史会话 / 运行时流式）的真机效果需「重载扩展宿主 + 开一轮含提问的对话」复看——与上方批次真机复看同批待办。故本项定级 **✅ 测试级**（单测 + 重放 + 变异），非真机闭合

### Fixed（宿主 · 任务项组位置判据归位：纯 seq → 任务项 / 时间轴插入域的 (ts, seq)）

**问题（SSOT 收敛 · 带伤收口，内核零改动）**：`insertPlanItemGroupInOrder` 摆组时只比 `dataset.seq`，而**任务项 / 时间轴插入域**唯一的排序键是 **(ts, seq)**——`bounds` 排序（`a.ts.localeCompare(b.ts) || a.seq - b.seq`）、「任务项 N」编号（`bounds.indexOf + 1`）、归属判定（`planItemContainerFor`）、行插入（`insertPlanItemInOrder`）四处同源，只有摆组这一处偏出 ⇒ 组的**视觉位置**与它的**编号**可出自两把不同的键。（注：`renderReplayRound` 的重放中段内容另有一处 ts-only 排序，属内容装配域、不在此键域内。）

- **实锤（先红后绿，非推理）**：补守卫测试喂「边界 ts 与 seq 逆序」的病理样本（时钟回拨 / 历史补写），旧实现下第一个组的标题是 **「任务项 2 · 任务甲」**——编号序与视觉序分家 → 红；判据归位后绿
- **修法**：比较键改 **(ts, seq)**（ts 优先、同 ts 回落 seq）；签名加 `boundTs`，调用点改传 `bound.ts`
- **零正常差异**：正常数据下组按创建序插入 ⇒ `find` 恒空、旧判断等于未生效；本改动只在 ts/seq 逆序时改变行为——而那正是编号已按 (ts, seq) 排出的口径，属**向真理归位**
- **定性订正**：本题原以 `PLAN-GROUP-ORDER-1`「观察项」登记（定级偏轻）；按 `legacy-contract-audit-rules` §1「从零不会这么写」+ §2「同语义多实现」实为**带伤**，本轮按 §5 收敛流程收口
- **验证**：宿主全量 **782 passed / 2 skipped / 0 failed**、`tsc` 0

### Fixed（宿主 · 任务项组外过程条目沉底：任务项组纳入统一 (ts, seq) 排序候选）

**问题（纯宿主渲染层，内核零改动）**：`plan_item_boundary` 排在**本轮首个工具之前**时（续会 / prepare 预置 / 上一 turn 遗留计划），本轮工具全被边界收进任务项组内、根层只剩组外条目（narrate / thought / 工具批块）。宿主 `insertPlanItemInOrder` 的候选集合原只列「行」、不含任务项组 ⇒「行 vs 组」永不比较，根层无同层行可锚时即走 `appendChild` 落尾 → 组外条目沉到**全部任务项组之下**（真机 `round-1790411133316` 表现为「建表工具夹在倒数第一与倒数第二个标题之间」）。

- **修法（喂料止血，零触碰排序判据）**：`getOrCreatePlanItemGroup` 补挂 `dataset.ts`（边界事件自身的排序键）；`insertPlanItemInOrder` 候选集合加 `:scope > .round-block__plan-item`。比较判据（`ts` 升序、同 `ts` 回落 `seq`）**原样未动**——只是让组**进入**已有的那条排序逻辑，不新增第二条
- **组内零误伤**：候选限定 `:scope >`（直接子节点），而组不嵌套组（`getOrCreatePlanItemGroup` 的 root 恒为 flow / details）⇒ 往组**内**插行时该选择器恒 0 命中
- **守卫**：`chatView.test.ts` +2 例（真机两形态——边界前置于首个工具 / 建表工具在边界之前）；变异退回候选那半 → 恰 1 红、零误伤。宿主全量 **781 passed / 2 skipped**、`tsc` 0、`eslint` 0
- **存量旁路（同批已收口）**：`insertPlanItemGroupInOrder` 原按**纯 seq** 定位组，与上行的 (ts, seq) 键偏离——见上方 `### Fixed（宿主 · 任务项组位置判据归位…）`
- **真机待复验**：`dist` 已随本批 `pre-push` full 档的宿主构建重建（实测 `dist/webview/scripts/chatView.js` 已含 `grp.dataset.ts`）⇒ 只剩「重载扩展宿主 + 开一轮带任务表的对话」复看建表工具落点

### Added（宿主 · 文件改动 diff 可视化 DIFF-1：打开真实文件 + 改动行内联高亮 + 顶/底各一组确认·回退）

**性质**：host-only，**内核零改动**（渲染与动作全在 `hosts/memora-vscode/src/extension/host/fileChange*.ts`）。

- **形态**：不强制弹 diff 窗口——改动已生效，直接打开真实文件，改动行**块级高亮**；hunk 首行行尾**内联旧内容**（删除线灰字）+ 悬停看完整旧内容（仅内存展示、全程零落盘）；文件**顶部与底部各一组四按钮**（确认本文件 / 回退本文件 / 全部确认 / 全部回退）
- **为何不挂 per-hunk 按钮（2026-09-26 真机修正）**：CodeLens 渲染在**所在行上方**，挂在 hunk 首行时按钮紧贴**上一个 hunk 末尾**之下 → 真机上被读成「回退上一段」，而动作粒度本就是**整个文件**；收敛为顶/底两组
- **真机三连击的根因与修法**（已固化进技能 `memora-host-ui-consistency` 规则 6）：① 装饰是 **per-editor** 绑定，切走再切回**不会**自动恢复；而 CodeLens 走 provider 模式自己活 ⇒ 症状恰是「高亮丢、按钮留」→ 对全部显示该文档的可见编辑器逐个 `setDecorations` + 挂 `onDidChangeVisibleTextEditors` 补齐；② 内核**直写盘、不经编辑器** ⇒ 文档缓存仍是旧行数时 range 会**画到错误的行** → 渲染前非 dirty 且内容不符即 `workbench.action.files.revert` 重载；③ 一个 step 内并发写同文件的多条 `tool_result` 连着触发渲染 ⇒ `renderSeq` 只让最新一次落地 + `await` 后**重取最新记录**
- **回退语义（勿按「清空」实现）**：回到 agent 动手前的状态——新建的文件→删除，已有文件中新增的行→去掉，而**已有文件被改过时是写回改动前正文**（清空会连原有内容一起抹掉）。两个入口统一走同一回退逻辑
- **守卫**：`__tests__/fileChangeCommands.test.ts` 命令 id **双向**对拍（3 个对外命令必须在 `contributes.commands` / 2 个 CodeLens 内部命令必须不在），断言**不复制 id 字面量**（从模块 import）；`__tests__/fileChangeView.test.ts` 装饰存活 4 例。变异验证：删监听 → 3 红 1 绿；`slice(0,1)` 退化 → **恰 1 红**
- **同批修掉的 SSOT 违例**：`isRemovedOnly` 在 `fileChangeView` 的内联副本 → 改 import（该函数生产侧零消费，副本是真违例而非「同模式重复」）

### Fixed（宿主 · 文件改动回退的未保存编辑守卫 W2：fail-closed 闸 + 模态确认）

**问题（数据丢失类）**：`applyRestore` 不看 `doc.isDirty`——文件有未保存编辑时点「回退本文件改动 / 全部回退」，写回 `beforeContent` 会把用户缓冲区里的编辑**静默覆盖**（无 git 时无法找回）。上条的 `!doc.isDirty` 守卫只管渲染重载、不管回退。

- **修法（用户拍板「弹模态确认」）**：`applyRestore` 加 fail-closed 闸（返回改 `RestoreOutcome` 三态，`dirty` 单列、不混进失败原因），单文件回退遇 dirty **弹模态确认**（取消 = 不动文件、记录保留）；批量回退**一个模态一次列出全部 dirty 文件**（明细含「（含未保存编辑）」+ 计数），`overwriteDirty` 只放行清单内文件——确认之后才变 dirty 的仍被拦、如实报失败
- **守卫**：`fileChangeView.test.ts` +4 例（全走真实命令路径，不私调内部方法）。变异验证：删 fail-closed 闸 → 恰 2 红；删 `isDirty` 判据 → 恰 1 红；零误伤
- **内核导出面同批收编（DIFF-2 闭合）**：内核 `pathGuard` 导出 `MAX_DIFF_CONTENT_LENGTH`、`WRITE_PATH_EXTRACTORS` 过 `src/index.ts`（见 [3.0.0] Added）；宿主并列副本删除、`DISK_WRITE_TOOLS` 派生自内核键（跨包双枚举收编单源，字面量断言升为跨包契约钉）。⚠️ 只统一数值、不统一行为（两侧超限行为仍不同）
- **新缺口登记**：DIFF-4（无 `path` 改盘工具双盲）/ DIFF-5（写工具「谁会改盘」判据：新工具**整行漏写** `diskWrite` 声明位 = 串行不防 + 追踪不报 + 契约钉不红的三重静默。⚠️ 2026-09-27 订正：原登记写「两处枚举无对拍守卫」**机理已过时**——收编后是「一处声明 + 两级派生 + 契约钉」，无两处枚举，故不存在「补对拍守卫」这种修法）

### Fixed（宿主 · 对比预览体积闸在删除场景失效 + 回退审计 tool 名失真）

- **体积闸漏判（删除场景）**：`openCompare` 判据原为 `rec.afterContent !== null && max(before,after) > MAX_DIFF_CONTENT_LENGTH`——`delete_file` 时 `afterContent === null` **短路为假** ⇒ 删几 MB 的文件时整份旧内容照样进虚拟文档 + `vscode.diff` 渲染，正是这道闸要防的事（该 `!== null` 本意是防 null 解引用，非有意放行）。**修法**：两侧长度各自 `?? ''` 后取 max，null 与非 null 一视同仁
- **回退审计 tool 名失真**：`applyRestore` 恒传 `assertPathAllowed(path,'write_file')`，而「原为新建」的回退实际动作是**删除**。该参数**只进审计事件的 `tool` 字段、不参与放行判定**（判定只用黑名单 + 白名单前缀）⇒ 非安全洞，但审计里「删了什么」全记成写。**修法**：按实际动作传（`beforeContent === null ? 'delete_file' : 'write_file'`）
- **守卫**：`fileChangeView.test.ts` +3 例（8→11），全走真实路径（事件 / `registerCommand` 捕获的处理器）：删除大文件→提示且**不开** `vscode.diff`；**反向守卫** 小文件删除→正常开对比；回退新建→走删除分支且审计记为 `delete_file`。**变异验证**：退回 `afterContent !== null &&` → 恰 1 红；退回恒传 `'write_file'` → 恰 1 红；零误伤

### Added（宿主 · 文件改动三层粒度归位：文件级上标题栏 + 新增块级「接受此处 / 拒绝此处」）

> **订正上节（形态已变，勿按旧文验收）**：上面 `Added（DIFF-1）` 里「顶部与底部各一组四按钮」与「为何不挂 per-hunk 按钮」两条 **已被 2026-09-27 真机反馈推翻**——按钮嵌在文件正文里用户明确不接受；且那里否决的是「**文件级**按钮挂在每个 hunk 上」（粒度 + 位置双重错位），不是「块级按钮」本身。现形态见本节。

- **文件级按钮迁出正文 → 编辑器标题栏**：`menus.editor/title` 的 `navigation` 组（标签栏右侧图标按钮），配 `when: memora.fileChangePending`（`setContext` 维护，取「活动文件是否有未确认改动」，不在每个文件上都挂按钮）。VS Code 扩展 API **没有**编辑器内悬浮操作条（Trae / Qoder 那条提示条是 fork 内核级 UI，扩展层拿不到），标题栏是扩展能拿到的最接近形态。命令 id 随之改名 `memora.fileChange.confirmFile` / `.restoreFile`（原 `…confirmInline` / `…restoreInline` 命名在迁走后失真），并从「内部命令」翻转为**必须贡献**（菜单依赖声明才渲染）⇒ 参数归一化 `string | Uri | undefined`、无参回落活动编辑器
- **块级按钮（命题 B）**：每个改动块末尾一组「接受此处 / 拒绝此处」，落点 `hunk.endLine + 1` —— CodeLens 渲染在所在行**上方** ⇒ 视觉上紧跟该块**之后**；挂首行会贴在上一个 hunk 末尾之下被误读（§11.8 旧伤）。纯删除块 `endLine = startLine - 1` ⇒ 落点正好是删除位置，无需分支
- **块级动作是纯逻辑派生，无新状态**（与 git `add -p` 的 index 模型同构）：接受 = 基线改为「当前内容剔除未接受的块」（**不动盘**）；拒绝 = `applyHunkReverts` 区间替换后写盘。块全部处理完 ⇒ diff 为空 ⇒ 与文件级确认**同一收口**，无特判、无「已接受块集」、无坐标迁移
- **纯逻辑层新增两个导出**（`fileChangeDiff.ts`，可 node 单测）：`applyHunkReverts`（多块按 `startLine` **降序**——插入块还原会改行数，升序会让后一块 `splice` 打空）/ `hunkKey`（位置 + 内容指纹；渲染 → 点击若对不上即 **fail-closed**，绝不按下标猜块——回退是写盘动作，猜错即吃掉用户内容）
- **守卫**：`fileChangeCommands.test.ts` 分类断言翻转（5 个对外命令必须贡献 / 2 个块级命令必须不贡献）+ 新增「标题栏菜单必须带 `when`」守卫；`fileChangeView.test.ts` 改块级粒度与落点用例 + 新增块级动作 8 例。fileChange 四单测合计 **79 passed**。**变异验证**：落点改回块首行 → 恰 1 红；接受后不失效 `hunkCache` → 2 红；指纹失效按下标兜底 → 1 红（硬证据是**真的写了盘**）
- **⚠️ 变异验证的自我排雷**：最初「多块一次性还原 = 写前内容」用的是等长替换（行数不变 ⇒ 升序降序同结果），变异**不变红** ⇒ 先怀疑断言没咬住判据（补真机那组两块插入后才红），而不是怀疑代码

### Fixed（宿主 · 块级按钮「跑到改动上方」+ Changed：改动对照改上下排列）

> **本节的形态变化覆盖上节部分描述**：上节「块级按钮落点 `endLine + 1` ⇒ 视觉紧跟该块之后」在**末块贴文件最后一行**时不成立（见下第 1 条）；对照视图由 `vscode.diff`（左右并排）**改为自渲染单列上下排列**。

- **BUG「点了一个按钮后，底部修改的按钮跑到上面去了」= 结构性边界，非行号算错**（2026-09-27 真机反馈，硬证据）：真机文件 `创意杠杆候选.md` 为 `endsWithNewline = false` / `lineCount = 28`，被改行 = 第 28 行 = **文件最后一行** ⇒ 末块 `endLine + 1 = 28` 越界、`safeLineRange` clamp 回 27，而 **CodeLens 恒渲染在所挂行上方** ⇒ 末块按钮必然落在该块**上面**。VS Code 扩展 API **给不出「渲染在行下方」的 CodeLens** ⇒ 位置不可解。用户观感「点一下才跑上去」的真因：点掉前一块后只剩末块，场上唯一的按钮就是那颗被 clamp 的。
  - **修法（位置解不了 ⇒ 让归属不依赖位置）**：块按钮标题**恒带序号** `（N/M）`（`$(check) 接受此处（1/2）`），单块也显 `（1/1）`，不搞「时有时无」；顺带补上旧根因「看不出共几处」。
  - **守卫 2 例**（末行 clamp 形态 + 序号恒显）；变异 `const suffix = ''` → **恰 2 红**。
- **对照视图由左右并排改为上下排列**（用户「现在的左右排列看不清楚原文」）：`vscode.diff` 是左右分栏，窄编辑器里长行被挤成两个半栏。**为什么不能「把 diff 设成 inline 再打开」**——扩展 API 拿不到该入口：`vscode.diff` 第 4 参数（`TextDocumentShowOptions`）**不含布局**，布局只受用户全局 `diffEditor.renderSideBySide` 或**切换型**命令影响（盲调 = 改用户设置）⇒ 自渲染统一视图是唯一确定性路线。
  - **纯逻辑新增 `formatUnifiedDiff(before, after, title)`**（`fileChangeDiff.ts`）：单列 `- `/`+ ` 文本 + 每块分隔头 `──────── 改动 N/M · 新文件第 X 行 ────────` + `共 N 处改动`。⚠️ 与 `MAX_DIFF_CONTENT_LENGTH` 的关系：**只统一取值、不统一行为**（宿主仍「跳过对照只提示」）。
  - **呈现层改用只读虚拟文档 + `showTextDocument`**：零落盘、天然只读；删除 `executeCommand('vscode.diff')` 路径、`existsSync` 导入与 `rightSeed`（「删除场景右侧给空虚拟文档」分支随左右并排一起消失）。
  - **守卫**：正文为单列、同一处**先旧后新**、`executed` 中**不得出现 `vscode.diff`**。变异：把 `openCompare` 改回 `vscode.diff` → **3 红**。
- **⚠️ 方法论教训（变异验证的「守卫可达性」）**：等待条件最初写成「等虚拟文档已打开」⇒ 变异回 `vscode.diff` 时 `waitFor` **先超时变红**，形态守卫**根本没跑到**（红在等待、不在守卫）。改为「等对照视图以**任一形态**出现」+ 形态断言并列后才精确命中。**守则：变异必须红在断言上，不能红在等待/前置条件上。** 已固化到常驻载体（不留在本节）：`memora-host-ui-consistency` 技能**规则 4**。
- **验证终值**：fileChange 四单测 **89 passed**；`tsc --noEmit -p ./` = 0；`eslint --max-warnings 0` = 0。宿主全量 `Tests 5 failed | 774 passed | 2 skipped`，**AssertionError = 0**；按「先数 AssertionError、再隔离复跑」定性：只跑那两个文件 → `1 failed | 32 passed`（**只剩 `projectSearchProvider` 501 文件 30s 超时**），另 4 条为并发 I/O 争用假红。**未改任何 timeout 迁就。**
- **同批修正（源文件裸 NUL 字节污染 git / ripgrep）**：`fileChangeDiff.ts` 的 `hunkKey` 里 `removed` / `added` 的拼接分隔符原为**裸 `0x00` 字节**，落在 **offset 7751**——恰好在 git 二进制判窗（头 8000 字节）之内 ⇒ `git diff --stat` 显示 **`Bin …`**、`Grep` 返回 **`binary file matches` 而非命中行**，该文件改动**在提交里完全不可读**（tsc / 单测全绿、门禁查不出）。改为 **`\u0000` 转义**（运行期仍是同一字符 ⇒ hash 与 89 项单测不变），并在 `hunkKey` 的 JSDoc 写明「勿写裸 NUL 及原因」。复验：`tsc --noEmit -p ./` = 0；fileChange 四单测 **89 passed**。⚠️ **提交前必须重新 `git add` 该文件**（`git diff` 比两侧，索引里仍是带 NUL 的旧 blob 则依旧判二进制）。**已归位真源载体**：`.trae/rules/generic/coding-convention-rules.md` **§10「源码文本卫生」**（源码禁裸控制字节——工具链整体失明属通用编码约束，不落在 host-UI 技能）。

### Changed（工具批按 step 断段：思考换步即断段，工具块与思考块对齐）

**问题证据（真机）**：一轮连做 9 步，每步思考后调工具；因步骤之间无 `narrate`（也无其它可见分隔物），前后相邻工具之间**无任何打断物** → 宿主 `groupToolBatches` 判为一大段连续工具，合并成**一个「工具×23」大块**（锚在第 1 步首个工具），用户看不到「哪几个工具属于哪一步」。根因 = 切段判据的打断物只有 `{narrate, text_self_review, plan_item_boundary}`，而 `thought` 明确「穿插不断段」→ 模型不吐叙述时跨 step 工具之间无判据可断。

- **判据扩展（宿主 `chatView.ts` `groupToolBatches`）**：新增打断物「**新 step 的思考**」——`thought.stepIndex` ≠ 当前批所属 step 时断段。**同 step 的思考碎片不断段**（step 内伴随物）；**无思考分隔的连续 step 工具维持相邻合并**（无可见分隔物即不切）。`currentStep` 取自开批 `tool_start.stepIndex` → 该字段由「零消费」转为真实消费方（解除僵尸键疑云）
- **反转 09-25 决议（显式）**：前置方案曾「否决按 step 分组」（理由=跨 step 连续工具正是要合并的对象）。本次反转——依据=思考分桶落地后「一步 = 思考 + 工具」成真机预期（前提变了，非原判错）。已在前置方案 §一 / §六 落反转注
- **不带伤定性**：改切段判据（`legacy-contract-audit-rules` §7 高风险动作）→ 带 ②可观测（切段矩阵用例）+ ③可退出（单函数回退，无 schema / 协议 / 落盘变更）+ ①可追溯（真机反馈）。五类带伤预检全过
- **内核零改动**：纯宿主渲染投影，`ProcessEvent` 契约与落盘结构不变
- **验证（变异闭合）**：宿主 `chatView.test.ts` **230 passed**（+3 新用例：步切换断段 / 同 step 不断段 / 无分隔合并）；`chatView + chatPanelHistory` **277 passed**；临时关闭判据 → 恰 1 红，恢复后全绿；宿主 `tsc --noEmit` EXIT=0、`eslint --max-warnings 0` EXIT=0；术语门禁 code 65 / text 77 无漂移
- **文档同步**：新增 `docs/方案-工具批按step断段-20260926.md`（闭合闭环，先文档后代码）；前置方案 `方案-工具批折叠合并-20260925.md` §一 / §六 加反转注
- **口径收口（09-26 续落 · 零行为变更）**：打断物集合由**散落重述**收敛为**具名唯一声明** `BATCH_SPLITTER_TYPES`（`chatView.ts`，他处只指路——散落重述正是误称反复传播的土壤）；订正全程误称「**正文（text）**」→「**自审查输出**」（`text_self_review` **非**正文：主回答正文走内容轨 `chunk`、落盘不产过程事件）。它**不是**批间常态切口（自审查只在工具循环后终审一次），但**可达**（审查轮交付后排队插话续跑、续跑再调工具）→ **保留，非僵尸键**；订正范围含内核 `stepBoundary.test.ts` 的「两层判定同构」错误断言（chunk `text` 含 `answer` / `self_review` 两档，**非严格同构**）与归档源头行。验证：宿主 **230 passed** / 内核 `stepBoundary` **10 passed** / `tsc`、`eslint`、术语门禁 EXIT=0 / 切段矩阵变异捕红**恰 1 红**
- **观察登记**：`BATCH-SPLIT-1`（QA/交互输入行是可见分隔物却不参与切段 → 潜伏错序；触发驱动，见台账观察区）

### Added（工具批折叠合并 TOOL-RUN-1 · 方案 B 纯宿主 · 内核生产代码 0 改动）

- **webview**：`groupToolBatches()`（`chatView.ts`，与 `groupThoughtBuckets` 同层并列）把**相邻连续、无打断物**的工具条目合并为「批」块——打断物 = `narrate` / 自审查输出（落盘层 `text_self_review`，**非**正文）/ 任务项边界，`thought` 穿插不断段；块内按工具名小计（「读取文件×2 · 网络搜索×1」），块标题「第 N 批」（挂 STEP-ID-1 文案约定）；失败 / 被拒工具留段内、块级标红。**三渲染上下文共用同一分组单点**（流式增量 / finalize 重建 / pending 行升级归段，禁内联三份）；单工具批视觉等价现状，纯渲染投影 → 旧数据零兼容成本。
- **内核（仅测试）**：`stepBoundary.test.ts` 登记第 5 条不变量「**打断物不劈同一 step 的工具段**」（TOOL-RUN-1 前提固化，STEP-BUCKET-1 同范式：测试固化前提，不加防御分支）。
- **方案文档**：`docs/方案-工具批折叠合并-20260925.md`（三口径定案 + `toolBatch` 命名契约 + 不带伤五类预检单；内部文档不进 npm 发布包，故去链接化）。
- **验证**：宿主 682（+10）/ 内核 2792（+1）；变异捕红 3 场——「`thought` 也打断」回退 → 2 红；工具段中插打断物 → 2 红（含「无任务表不产任务项边界」连带守卫双命中）；「内联分组」模拟（单上下文分组分歧）→ 2 红（切段矩阵·thought 穿插 + 三上下文一致，恰中方案 §五 预期）；`ci:local --preset=full` 12/12 全绿。
- **两处设计判定留档**：①过程流中间文本型打断物在落盘层的承载 = `text_self_review`（**自审查输出，非正文**——主回答正文走内容轨 `text` chunk，落盘不产过程事件；判据只读落盘数据以保「运行时所见 = 重放所见」）；②`data-tool-batch` = 段 id 挂批容器，行级 `data-tool-call-id` 保留为 `tool_result` 配对键（非僵尸 key）。

### Changed（工具批叙述口径收口：全链路统一到工具显示名 + 取消「第 N 批」序号）

- **问题（实锤）**：TOOL-RUN-1 初版落地后，屏上同一个事实长出**两条形成路径**——轮收尾摘要按类别粗分（`countEvents` + `toolActionType`：「读取 2 · 搜索 1」），工具批标题按工具名计数（`getToolDisplayName`：「读取文件×2」）。同一次调用在屏上被叫成两种名字；两份相隔一天各自落地，**不是历史遗留而是并行生长** = 漂移起点。
- **收敛（两步）**：①抽 `toolSummaryText()` 为唯一叙述形成点、取消批序号（连带删掉 finalize / 流式**各自一份**的 `batchOrder` 递增计数，消灭「两份计数器必须同步」的隐患）；②**统一词表到工具显示名**——轮摘要也改用工具名小计，类别词（读取 / 搜索 / 写入 / 运行）整套退役。
- **为何不留「概览 / 明细」两层**：轮=概览、批=明细看似合理，但同一动词两套中文名 = **两张映射表**，可按不同节奏更新（新增工具只补 `toolNameMap` 不补类别 → 立刻不一致）。一个词表后这类漂移不再可能。
- **连带清理**：`countEvents` 的分型字段（tools/reads/searches/writes/runs/others）随类别词退役后清零消费者 → 按「不用就删」删除，只留 `countReviews`（不做僵尸结构留存）；`toolActionType` 职责收窄为「该工具能否进句」（`other` 类不可辨识 → 只计入 N、不占一段）；顺带消掉一处 `as` 断言。
- **取消批序号**：批按事件相邻性切段，与 `stepIndex` **无单调对应**，「第 N 批」必然和「思考 · 第 N 步」互不对齐——那是 STEP-ID-1 想消灭的第二套编号换了个马甲。连带删掉 finalize / 流式**各自一份**的 `batchOrder` 递增计数（两份计数器必须同步 = 潜在双源），净简化。
- **取舍（如实记）**：代价是折叠态一行可能变长（`toolNameMap` 现 24 键 vs 原 4 类别）。**暂不加「超过 N 段折叠为其他」**——属猜测性复杂度，若真机观察到换行 / 挤压再按观察驱动补（D6 触发驱动）。
- **文档同步**：方案 §3.4 口径重写并留「2026-09-26 口径修订」档；`process-event-log-replay-design.md` 的 `tool_start` 行加**零消费方**标注。
- **措辞订正（历史条目不改写，在此留注）**：上上条「tool×step 交叉事实（同号对齐 / 按 step 统计工具用量）自此有据可查」把「数据可落盘」说成了「价值已兑现」——宿主 UI 至今**零读取** `tool_start.stepIndex`（工具批按相邻性切段，不按 step 归组）。应按 single-truth-source「预留键 vs 僵尸键」口径理解：真实消费方落地前它是**预留键**，不是已兑现能力。
- **验证**：变异验证闭合——改断言时 227 中恰 4 红 / 223 绿（零误伤）→ 改实现后 227 全绿；`tsc -p ./` 0 / eslint 0（改动文件）；dist 产物含 `toolSummaryText`、`countToolTypes` / `toolBatchTotalsText` / `toolBatchTitleText` 零残留；`terminology:check` code 64 / text 76 无漂移。宿主全量另有 3 个 `rmSync` 钩子超时红，经隔离复跑与 IO 基准定性为**环境假红**（本机递归删 501 文件 99.6s ≫ 10s hook 上限；三套件与本次改动零引用链）。

### Fixed（宿主 · 脚本类写工具文件改动可视化闭环：执行前后 workspace 快照 diff 收口 + 恢复文案诚实化）

- **问题（DIFF-4 可视化半盲，本轮闭环）**：脚本类写工具（`run_code` / `run_skill_script` / `run_project_script`，内核标 `diskWrite:'opaque'`）目标路径**运行时才可知**，静态无法定位 ⇒ 不进宿主 `DISK_WRITE_TOOLS` 可视化（只含 `diskWrite:'path'` 工具）。用户看不到脚本改了哪些文件，无法确认/回退。内核写串行闸的 opaque 屏障**已防并行丢内容**，盲区只在宿主可见性，非内核写闸。
- **修法（运行时事实回报，非静态枚举；零新增状态面，不破内核边界）**：ext 进程在脚本类 `tool_start` 扫一遍 workspace 文本文件快照、`tool_result` 再扫一遍，`diffWorkspaceSnapshots(before, after)` 产出外部变更集（新增/修改/删除三类），经 `FileChangeSink.noteExternalMutations` 按路径合并进 `FileChangeTracker`（复用 `upsert` 单源逻辑，保留最早 `beforeContent`、writeCount+1）。脚本目标不可静态知 ⇒ 改以「执行前后目录快照 diff」这一**运行时事实**收口。排除 `node_modules`/`.git`/`dist`/`.memora` 等目录、跳过 >2MB 与含 NUL 的二进制文件。真源 = 内核 `OPAQUE_WRITE_TOOL_NAMES`（新导出 `src/index.ts`），宿主派生 `SCRIPT_WRITE_TOOLS`，**禁并列维护第二份脚本清单**（两份必漂移 = 脚本类改动静默不追踪）。
- **恢复文案诚实化（DIFF-1 标签语义漂移 #7 闭环）**：部分接受后 `beforeContent` 已被改写为「已接受基线」，文件级「恢复旧版」写的其实是基线而非 agent 介入前原文。标签统一改为「回退本文件改动」，提示文案改为「恢复到『你尚未接受的改动之前』的内容」，与 git `add -p` 模型自洽、消除误导。涉及 `fileChangeView.ts` 通知 / CodeLens / 状态栏 / 确认模态四处文案。
- **守卫（fileChangeTracker.test.ts +6 例）**：`diffWorkspaceSnapshots` 新增/修改/删除三类 + 空集；`noteExternalMutations` 脚本新建文件 / 与 `write_file` 合并保留最早 `beforeContent` / writeCount 累加 / 空变更集无影响。变异：`!==` 改 `===` → 恰 2 红（修改检测漏报被咬住），还原复绿。
- **验证（实测）**：宿主 `tsc --noEmit` = 0；`eslint --max-warnings 0` = 0；fileChange 相关定向 **48 passed**（含新增 6）；变异精确红 / 还原绿。内核 `npm run build` 已成功（本轮导出 `OPAQUE_WRITE_TOOL_NAMES` 经 dist 供宿主 tsc 解析）。⚠️ **宿主 dist 未含本轮**（本环境 esbuild 在 `copyRolePacks` 结构性超时）→ 真机验收前必须 `npm run compile`
- **台账 DIFF-4 状态**：可视化半盲已闭环（2026-09-27）

### Fixed（宿主 · 脚本类快照扫描上限守卫：大仓库防卡死 extension host）

- **问题（本轮新加，吸收最新养分重判）**：上一轮落地「脚本类执行前后 workspace 快照 diff」时，`scanWorkspaceTextFiles` 用同步 `readdirSync`/`statSync`/`readFileSync` 全量扫描 workspace 文本文件存入 `Map<path,content>`。功能正确、盲区已闭环，但**在 extension host 用同步全扫**违反 VS Code 扩展性能准则（扩展 host 同步 IO 反模式）；同步阻塞的是整个扩展进程（所有扩展卡），不止本面板。量级：memora 自身排除忽略目录后约 800–1500 文本文件、同步读 ~100–600ms（亚秒，非秒级）；仅病理级大 monorepo（排除后仍数万源码）才数秒。属「建议级架构瑕疵」，非逻辑带伤。
- **修法（止血型上限守卫，只加退出条件、不造复杂度）**：`scanWorkspaceTextFiles` 遍历中累计 `totalBytes`/`fileCount`，任一超阈值（`SNAPSHOT_MAX_TOTAL_BYTES=64MB` / `SNAPSHOT_MAX_FILES=8000`）即中止递归、清空已收集内容、返回 `null`。调用方（`chatPanel` tool_start/tool_result 分支）据 `null` 降级：不存快照、不跑 diff，仅经既有低扰 `notice` 通道提示「工作区文本文件过多，脚本改动未自动追踪——请用 git 核对改动」。正常仓库仍走完整快照 + 逐文件「回退本文件改动」；仅大仓库放弃自动追踪、交 git 核对。阈值常量与扫描同文件，零新增状态面、不破内核边界。
- **守卫（chatPanelScriptSnapshot.test.ts +5 例）**：正常目录返回 Map（不降级）/ 总字节超 64MB 返回 null / 判据边界精确（64×1MB 不降级、65×1MB 降级）/ IGNORED_DIRS 不被扫描且不误触发降级 / 含 NUL 二进制跳过不计入（旧逻辑未破坏）。变异：`>` 改 `<` → 恰 4 红（正常/边界/IGNORED/NUL 全转红）、降级用例巧合仍绿，还原复绿——判据可达性钉死。⚠️ **用例规模后续下调（2026-09-28 实测订正）**：原「64×1MB 不降级 + 65×1MB 降级」要写 129MB、删 129 个文件，本容器删 ~200ms/个 ⇒ 光清理就远超默认 10s 钩子（全量并发下必红，但 **AssertionError 计数为 0**）。改为 **32×2MB = 恰好 64MB 不降级**（I/O 减半、语义等价；降级侧由既有「33×2MB → null」覆盖），并给边界用例与两个清理钩子显式超时——放宽的是**等待时间**，判据与断言一律不变。
- **验证（实测）**：宿主 `tsc --noEmit` = 0；宿主 `eslint --config eslint.config.mjs`（测试文件在 `ignores` 内不查）= 0；定向 **5 passed**；变异红→绿。
- **残留缺口（如实记，登记技术债）**：① 降级推 `notice` 的**集成守卫未做**（逻辑在私有 `consumeFlow` 内联，全路径集成测试成本高 + 本环境 `rmSync` 删 8001 文件超时假红风险）；逻辑直白、tsc 已保障类型，留待补 `consumeFlow` 集成测试。② 文件数 8000 阈值降级**缺单测**（真实构造 8001 文件删除超时）；与总字节降级共用 `aborted` 机制，边界测试已证明该机制咬住判据。③ 阈值 64MB/8000 为经验值，真机大仓库反馈后再调。
- **生效前提**：改动在宿主 `chatPanel.ts`，**宿主 dist 未含本轮**（本环境 esbuild 在 `copyRolePacks` 结构性超时）→ 真机验收前必须 `npm run compile`。

### Changed（宿主 · 文件改动对照回滚为 git 同款左右分栏 + 删掉行尾红色预览，2026-09-28 真机反馈）

- **回滚 1：「查看对比」回到 `vscode.diff` 左右分栏**（推翻 2026-09-27 的「上下统一视图」）。真机再测结论相反：**git 同款左右分栏更直观**。`openCompare` 恢复 `executeCommand('vscode.diff', 左, 右, 标题)`：左 = 旧内容虚拟文档（`memora-diff:`，不落盘），右 = **真实文件**（`file:`，可编辑）；删除场景无真实文件可指 ⇒ 右侧给空虚拟文档。`existsSync` 导入与 `rightSeed` 随回滚恢复。⚠️ **布局仍由用户全局设置 `diffEditor.renderSideBySide` 决定**（默认左右），扩展不去改它——扩展 API 给不出「以 inline 布局打开」的入口，改布局 = 动用户设置或盲调切换型命令，皆属侵入。
- **连带删除**：`formatUnifiedDiff`（`fileChangeDiff.ts`）专为上下统一视图而生，形态回滚后零生产消费 ⇒ 连同 6 个单测删除（净减债，git 历史可溯）。
- **回滚 ≠ 回退修复**：体积闸「两侧长度都判」**保留**——旧版 `afterContent !== null && …` 的前缀会在删除场景短路放行（该缺口已修，本次不回退）。
- **回滚 2：删掉行尾常驻的红色旧内容预览**（`INLINE_OLD_TEXT_STYLE` / `inlinePreview`，即 hunk 首行行尾那行红色删除线「⟵ 原: …」）。真机反馈：与 hover 说的是同一件事却长期占版面 = **视觉噪音**。**hover 保留**（旧内容只在内存里，hover 是用户看它的唯一入口）；并排看新旧走「查看对比」。
- **守卫（fileChangeView.test.ts）**：对照形态 3 条（走 `vscode.diff`／左栏是虚拟文档且正文为改动前原文、**不带** -/+ 前缀／标题带相对路径）＋右栏真实文件 1 条（另开真实临时目录——判据含 `existsSync`，内存 mock 下恒为「文件不存在」，只能走到空虚拟文档分支）＋装饰不挂 `renderOptions` 1 条＋体积闸 2 条（删除大文件跳过／小文件不误伤）。
- **变异验证 2 组**：① 把行尾预览加回 → **1 红**（装饰守卫）；② 把 `openCompare` 改回上下视图（`showTextDocument`）→ **5 红**（形态守卫）。两组都**红在断言本体**：等待条件刻意不绑死形态（绑死则变异先超时、守卫根本跑不到）。
- **验证（实测）**：宿主 `tsc --noEmit -p ./` = 0；`eslint --config eslint.config.mjs`（改动源码文件）= 0；fileChange 两套件 **67 passed**（fileChangeView 32 + fileChangeDiff 35）；变异红→绿。
- **文档同步**：`docs/方案-文件改动diff可视化-20260926.md` 加 §11.13 回滚注记；`docs/方案-文件改动分块呈现与块级动作-20260927.md` §8.7 第 2 条划线订正 + 新增 §8.8（历史正文不重写，只加注记）。
- **生效前提**：改动在宿主 `fileChangeView.ts` / `fileChangeDiff.ts`，**宿主 dist 未含本轮**（本环境 esbuild 在 `copyRolePacks` 结构性超时）→ 真机验收前必须 `npm run compile`。

### Fixed（宿主 · diff 模块复盘收口：文案口径单源 + 文档/台账失真订正 + 规则补第 8 层）

真机通过后的对抗式复盘（判据 = `.trae/rules/generic/legacy-contract-audit-rules.md` §2/§3/§3.3/§4）：**代码侧不带伤、不违 SSOT**（§2 三条判别与 §3 五类带伤全不命中），问题全在「描述层」——形态回滚后描述没跟上代码。本段是这些问题的收口。

- **文案口径单源（口径带伤 → 已修）**：同一动作两个名字——通知按钮叫「查看对比」、QuickPick 与状态栏悬停叫「打开对比」。已统一并抽为常量 `COMPARE_LABEL`（`fileChangeView.ts`），三处入口（通知按钮 / QuickPick 项 / 状态栏 tooltip）**同一真源**，禁各自写字面量（字面量散落正是本次漂移的成因）。`$(diff)` 图标前缀属装饰、不并入措辞。
- **台账失真（最致命 · 已修）**：`tasks/待完成任务.md` DIFF-1 的**销项验收标准**写「对照页是否单列上下排列」，而该形态已回滚 ⇒ 照单验收会把刚通过真机的左右分栏**判成不合格**；同批 DIFF-6 行仍描述已删的 `formatUnifiedDiff`。均已订正。
- **docs 失真（已修）**：`可视化-20260926.md` 的「落地形态」表仍写行尾 `⟵ 原: …`（已删）与「每 hunk 上方 2 个 CodeLens」（09-27 已改），其「人工验收清单」第③⑤条同样失真；`分块呈现-20260927.md` 实证表加「当时现状」注记。
- **规则补第 8 层（新增判据，带观测 + 退出条件）**：§3.3 退役概念回扫清单原 7 层**漏了 `tasks/` 台账**——台账是验收标准的落点，失真比 docs 更致命。已补为第 8 层，并写明观测依据（本条 DIFF-1 实证）与退出条件（台账不再承载验收标准即可删）。
- **补守卫（隐私承诺）**：回滚后一条记录占**两个**虚拟 URI（左 = 旧内容、右 = 删除场景空文档），而上下视图只占一个 ⇒ `releaseVirtual` 漏清任一即违反「旧内容零落盘、可释放」。新增 1 例钉**非空**的左栏；变异（删掉左栏那行 `delete`）→ **恰 1 红**，还原复绿。
- **观测边界（如实记，不写假绿断言）**：右栏在删除场景是**空串**虚拟文档，而 provider 读路径是 `get(...) ?? ''` ⇒「已建立但为空」与「已释放」**返回同形** ⇒ 空串那一栏的释放**不可观测**。故不为它编恒真断言；空串侧靠同一段代码对称保证。
- **DIFF-7 登记（已知残留，触发驱动，不预支）**：右栏是真实文件（对齐 git 同款 ⇒ 可编辑）。用户在对比页手改并**保存**后文档不再 `isDirty` ⇒ 点「回退本文件改动」**无任何提示、直接整体覆盖**（未保存编辑有模态确认 ✅，已保存的没有 ❌）。与 git `discard` 语义同构 ⇒ **非带伤**，但属静默数据丢失面。触发：真实出现「我自己改过、点回退被吞」的反馈 ⇒ 把「文档内容 ≠ `afterContent`」纳入与 dirty 同级确认通道（约 1 判定 + 1 文案）。
- **自纠（本轮差点造的假注释）**：初稿把上述风险写成「已明确告知」——**不实**：模态文案只在 dirty 分支出现。已改为如实描述并同步登记台账。
- **验证（实测）**：宿主 `tsc --noEmit -p ./` = 0；`eslint --config eslint.config.mjs` = 0；fileChange 三套件 **88 passed**。

## [3.0.0] - 待发布（发版日补日期）

### Fixed（内核 · maxTokens 上限不再静默丢弃：上限不裁决，交服务端可见报错）

**问题（哲学不对称 · 跨包镜像同源）**：`normalizeMaxTokens`（请求参数归一）原对 `maxTokens` 做 1–65536 区间裁决、超限**静默丢弃**（不传 `max_tokens`）——与同申请书参数 `contextWindow` 的既有裁决（`resolveContextWindow` 只做 undefined 回落默认、**不裁决区间**）不对称；且逼出宿主护栏**跨包数值复制**（宿主无法 import 内核私有常量，只能注释对齐 65536）——单侧漂移即重现「UI 显示值 ≠ 真实生效值」（护栏本要防的坑）。对第三方 npm 集成方是结构性考题：内核只要保留静默丢弃，集成方护栏无论松紧都难根治。

- **修法**：`normalizeMaxTokens` 只做**形态防御**（非数值 / 非有限 / <1 → undefined 不传，回服务端默认；正整数 floor 透传）；**上限不裁决**（有意为之，注释钉死「勿加回」）。超模型能力的值原样进请求体，由服务端**可见报错**——本地任何一层静默替换都造「显示 ≠ 生效」的坑（与 contextWindow 同哲学）
- **宿主护栏定位重写（零行为变更）**：`providerStore.MAX_TOKENS_MAX = 65_536` 由「对齐内核」改述为**独立 sanity**（宿主是输入边界的唯一可见裁决点，只防手滑；真实上限由模型/API 决定）。UI 行为不变（仍 1–65536 可见拒绝）。跨包数值镜像由此消除，§7 登记不再必要
- **验证（变异双端）**：上限裁决加回 → 恰 1 红（70_000 被吞）；形态防御去掉 → 恰 1 红（-5 透传）；均还原复绿。门禁：内核 `typecheck` / `eslint` 0 / 全量 **2824 passed | 4 skipped**；宿主 `typecheck` / `eslint` 0 / 全量 **826 passed | 2 skipped**
- **文档清算**：`tasks/审查-空响应根因排雷与优化方案-20260929.md` §五 T1 行与「依赖与边界」两处过时表述修订（原文「护栏对齐 normalizeMaxTokens / 越界→undefined」已不成立）

### Added（内核 · 截断型空响应换策略重试：降思考 + 纠正提示双轨）

**背景（EMPTY-RESP-1 · T2）**：同参重试对确定性截断无效（真机 3 连空、5 分钟白烧）——thinking 吃满输出预算后原参重发必然再炸。本条让截断型在**迭代内部**被救回（依赖 T3 的 finishReason 消费约定；排雷与方案见 `tasks/审查-空响应根因排雷与优化方案-20260929.md`）。

- **截断判定**：llmCaller 空响应分支消费末次 `finishReason='length'` = 截断型 → 换策略重试（粘性至收场）；无 finishReason（中转不回传）= 瞬态型 → 维持同参重试（降级不劣化）
- **双轨策略**：① `effectiveOpts.reasoning_effort='low'`（复用 `multiStepReasoning='manual'` 既有转达通道，provider 支持才生效）；② 纠正提示「上一次回复因思考耗尽输出预算被截断，请直接给出结论或工具调用」注入消息尾（`TRUNCATION_RECOVERY_HINT` 内联常量——协议级模型指令，非 UI 文案不进 UIMessages）——**每请求恰一条**：requestMessages 每次从 safeMessages 重建、提示不进历史，多轮重试恒 1 条（一次性 = 不堆叠，非只注首次）
- **测试**：2 例（换策略救回 + 双轨断言 / 粘性 + 恒 1 条不堆叠），mock 救回行为与双轨耦合——变异 2 方向（判定 `'length'`→`'stop'` / 摘提示注入）各恰红（「去策略则仍空」实证）→ 恢复复绿。门禁：内核 `typecheck` / `eslint` 0 / 全量 **2827 passed | 4 skipped**（宿主零改动，沿用上批 827）

### Added（内核+宿主 · 空响应诊断分型：证据三字段 + 兜底文案分型 + metrics 诚实信号）

**背景（EMPTY-RESP-1 · T3）**：真机空响应轮（round-1790649685702）暴露「截断型与瞬态型混为一谈」——finishReason 流层已透传但消费端未用、兜底文案单一无诊断、metrics 把兜底轮记成 `success:true`。本条落地诊断分型（排雷与方案见 `tasks/审查-空响应根因排雷与优化方案-20260929.md`）。

- **证据三字段**：`empty_response` 证据 payload 补 `{ finishReason, thinkingChars, attempts }`——llmCaller 逐 chunk 采集（finish_reason 末条覆盖、thinking 增量累计，重试重置取**末次尝试口径**）→ `LlmCallResult` 透传 → loop 落盘；`attempts` = 收场前 chat 尝试总数（空响应重试属**同一步内**多次尝试，step 术语红线不破）
- **文案分型**：`UIMessages.emptyResponseFallbackTruncated(attempts)` 新键——末次 `finishReason='length'` 判截断型 →「模型思考过长耗尽输出预算，已自动重试 N 次——建议调大模型输出上限」（宿主中文覆盖，内核默认英文）；无 finishReason（中转不回传）按瞬态型降级，维持现状文案不劣化
- **metrics 诚实信号**：`ProcessMetricsPayload.emptyResponseCount`（可选、旧数据缺省，镜像 `unparsedToolIntentCount` 模式）——**不动 `success`**（其语义是「流程跑完没有」，空响应轮正常收场；置 false 会把「流程未完」与「产出不合格」压进一个布尔）；宿主 chatPanel 流尾 diff 取本轮增量，chatView `finalSuccess` 合成 +「空响应兜底 N 次」指标行
- **测试**：roundEvidence 2 例（瞬态/截断分型 + 末次口径 7≠15）+ llmCaller 三字段 + chatView 展示合成；变异 4 方向（分型判据 `'length'`→`'stop'` / thinkingChars 重置摘除 / `finalSuccess` 摘 `emptyResp` / 证据 payload 摘 `attempts`）各恰红 → 恢复复绿。门禁：内核 `typecheck` / `eslint` 0 / 全量 **2825 passed | 4 skipped**；宿主 `typecheck` / `eslint` 0 / 全量 **827 passed | 2 skipped**

### Added（内核 · `AgentOptions.maxTokens` 输出预算透传链 + 热切换）

**背景（EMPTY-RESP-1 根治）**：推理模型 thinking 与正文共享输出预算，无显式 `max_tokens` 时 thinking 吃满服务端默认 → 正文被挤空（空响应）。本条补齐配置向根治链（排雷与方案见 `tasks/审查-空响应根因排雷与优化方案-20260929.md`）。

- **内核**：`AgentOptions` 新增 `maxTokens` → assembler 解构 → loop 持有 `defaultMaxTokens` → `buildChatOptions` 填底座（角色包 `chatOptions` 可覆盖，优先级：角色包 > per-LLM 默认）；`setMaxTokens` 热切换配套
- **宿主**：配置面板新增「输出上限 (K)」（K = ×1000 口径，`TOKENS_PER_K` 单一真理源；厂商口径自相矛盾——gpt-4o 同卡混用 128,000/16,384、Claude 3.7 输出上限 64,000 十进制——按误差方向安全性裁决：×1000 低估优雅降级、×1024 高估有 400 硬风险）→ `LlmProviderConfig.maxTokens` → assemble → AgentOptions；providerStore 护栏 + chatPanel 热同步
- **请求层归一**：`normalizeMaxTokens` 唯一收口；**归一语义后经上方 Fixed 条（2026-09-29）收敛**——只做形态防御、上限不裁决（本条落地时的 1–65536 越界裁决不再保留）
- **测试**：内核 loop 新增 4 例 + 变异验证（摘注入 → 恰红 → 恢复复绿）；宿主 configView / settingsView / providerStore 全绿；两侧 `tsc` / `eslint` 0 错

### Added（内核 · write_file 新增 `replace` 精确串替换 + mode 枚举双源收敛）

**问题（两项）**：① `write_file` 只有 overwrite/append/insert——大文件改一处局部时，模型手上没有整份内容（读不全），只能 overwrite 全量重写硬凑、或退回大量 append/insert 拼接，token 与出错面双高；② `mode` 枚举**双源并列**：schema 描述（`builtinTools.ts`）与 handler 校验清单（`builtinToolHandlers.ts`）各写一份，漏改一处即「描述允许而校验拒绝」的静默漂移（与 TASKTABLE-NAME-1 同族）。

- **收敛（SSOT）**：`builtinTools.WRITE_FILE_MODES` 作单一真理源（枚举 + 简介表）；schema 描述与 handler `validModes` 均从它派生，工具描述里的模式数量也由 `length` 派生（不写死「三种」）⇒ 新增模式只改一处
- **原语**：新增 `mode=replace`，配 `old_string`（须在文件中**唯一**出现）——只替换命中片段、不动其余。**匹配不到 → 报错**（禁静默 no-op）；**多处匹配 → 报错**要求补足上下文，**不做 replace_all**（改错地方毁代码 > 让模型多试一次，与 `toolResultCache` 同哲学）；目标文件不存在 → `FILE_NOT_FOUND`（新文件走 overwrite）
- **零额外接线的自动对齐（本方案最省事处）**：`diskWrite:'path'` 派生 ⇒ replace 自动进同 step 写串行闸（`WRITE_PATH_EXTRACTORS`）；`WriteExtensions.onBeforeWrite` 无条件调用 ⇒ 自动被已落地的 diff 可视化捕获；`invalidateFile` 按路径失效读缓存 ⇒ replace 自动作废旧读缓存
- **描述引导**：`write_file` 描述改为「改局部优先 replace（无需持有整份文件）；大文件没有完整内容无法 overwrite；文末追加 append / 单点插入 insert；只有新建或结构性多处重写才 overwrite」
- **SSOT 问诊 · 炼化归元（同族静默回落 2 处，顺手收口）**：① 结果标签 `modeLabel` 原以 `: '精确替换'` 作三元链**隐式兜底** ⇒ 未来新增模式会被静默标成「精确替换」，改为显式 `replace` 分支 + `default: mode` 如实回显；② `computeWriteContent` 原 `default: return content` 会在模式表与本 switch 脱节时**静默按 overwrite 落盘**（假阴性）⇒ 改抛 `ARGUMENT_ERROR` 响亮失败。两处均属「静默回落 = 缺陷行为」同族
- **验证**：handler `replace` 6 例（唯一匹配成功 / 未匹配报错且文件不变 / 多处报错且文件不变 / 新文件 FILE_NOT_FOUND / 缺 old_string ARGUMENT_ERROR / `onBeforeWrite` 收到替换前后完整内容）+ `builtinTools` 补「mode 描述与 `WRITE_FILE_MODES` 同源」守卫（防描述退回手工硬编码）。门禁：`typecheck` 0 / `eslint` 0 / `format:check` 0 / `docs:links` 0 / `rules:refs` 0 / `terminology:check` 0 / 全量 **2820 passed | 4 skipped**
- **顺带对齐**：宿主 `fileChangeTracker.ts` 注释模式清单与 `docs/memora-api-reference.md` 工具表补 `replace` / `old_string`（描述层跟随，无行为变更）

### Fixed（内核 · 读取防重回显文案诚实化：删「原文已在流程中被压缩」状态断言）

**问题**：`formatLedgerStub`（台账替身文案）被两个语境共用——① 压缩链把 read_file 结果**原位替换**为台账摘要（loop 装配 `readFileReplacement`）；② LLM 变体/同参重读被分支②拦截时的**回显**。文案写死「原文已在流程中被压缩」：压缩语境为真，但回显语境原文可能仍在上下文（变体重读不经 L2 精确判重的「仍在上下文」前提）⇒ **文案撒谎**——guardRail 防死锁前提（「告知基于已有 = 指令撒谎」）的同型问题在台账分支复现。

- **修法**：删状态断言，只陈述两语境皆真的事实（读过 / 覆盖区间 / 要点 / 续读出路）；SSOT 不破（两语境仍共用一个 formatter，文档注释钉死「不得内嵌单语境状态断言」）
- **验证**：守卫 `not.toContain('被压缩')`（二字根，咬住「已被压缩 / 已在流程中被压缩」一切改写回潮）+ **变异实弹**：子句回潮 → 恰 1 红（红在断言本体）→ 还原复绿。（守卫针头首版误写「已被压缩」——非真实字面的子串、恒绿咬不到人，排雷实证后与文案一并修正、变异补做通过）

### Fixed（内核 · 读取防重续读死结：无 limit 续读被台账分支②误拦）

**问题（可用性级 · 大文件必然触发）**：`shouldEchoLedgerStub`（分支②判定的单一真理源）原判据「无 limit 请求一律拦」只看了 limit 有无、未看 offset 落点。而 `offset=N` 不带 limit 的 handler 语义是「从 N 读到文件末尾」——**合法续读**。后果：文件被单次读取预算（`SINGLE_TOOL_RESULT_MAX_TOKENS` 5900，约 300–500 行）截断后，模型照分段脚注与拦截文案给出的写法（二者均为 `offset=coverEnd+1`、均不带 limit）续读，**会被同一条判据再次拦下** ⇒ 拦据与引导互为死结，memora 体量的大文件（如 `loop.ts` 约 4000 行，需约 10 次续读）永远读不到第二段。登记行「ADR-031 补缝过度拦截候选」的原始假设（「全文比对」类任务被迫绕路）由此**代码级实锤**——且成因比设想的更硬，非仅「摘要替身信息不足」。

- **修法（判据面，非场景特判）**：无 limit 分支改按 offset 落点判定——`(offset ?? 1) <= coverEnd` → 拦（起点落在已覆盖区间内，含省略 offset 的整读；截断后返回的仍是同一段已读头部）；起点超出覆盖区间 → 放行（真续读，恰是引导给出的那一步）。`limit` 变体整读与区间续读两条既有判据不动。
- **先红后绿（实证，非推理）**：探针复现旧行为下 `offset=401`（台账覆盖 1–400）判 `true`；原用例 `expect({ offset: 100 }).toBe(true)` 即**把该 bug 固化成期望**，一并订正为「整读拦 / 续读放行」两条。
- **验证（变异双端）**：**变异 A**（判据还原旧行为「一律拦」）→ 恰 1 红、**恰红在续读放行断言本体**；**变异 B**（改「全放行」）→ 恰 1 红、红在整读拦断言 ⇒ 两端都真在咬人，均还原复绿。`typecheck` 0 / `eslint` 0 / `format:check` 0 / 全量 **2813 passed | 4 skipped**。
- **未闭合（如实记）**：本修只解「无 limit 续读」这一成因；`ADR-031 补缝`（整读小文件记全覆盖）本身未动，§7 该登记行维持观察其余面向。

### Fixed（内核 · 读取防重证据字段面镜像收敛：三处手工枚举 → 一处定义 + 一处透传）

**问题**：`DedupSubject`（去重主体，形状真源 = `toolResultCache`）字段面被**三处手工枚举**——类型定义 ↔ loop 侧证据落盘逐字段展开 ↔ roundStore `read_dedup_block` payload。因 `memory → agent` **类型禁向**（真源 `.trae/rules/backend_layers_rules.md`，不随包故不作链接），roundStore 无法 import 该类型，只能人肉抄字段清单 ⇒ `DedupSubject` 增字段时另两处**静默漏采**（探针丢定位字段，逐案裁决无米下锅）。

- **修法（第三路，非登记时列的两路）**：loop 侧 `payload: { toolName, ...dedupSubject }` 整体 spread 透传（不再逐字段 `x !== undefined ? { x } : {}`）；roundStore payload 改**开放式索引签名** `[dedupField: string]: string | number | undefined` **停止枚举**。镜像由此降为「一处定义（`DedupSubject`）+ 一处透传」，两侧零同步。**为何不走原两路**：下沉共享层 = 新增单元（违最小单元）；`Record<keyof DedupSubject, …>` 编译期对拍仍要求 roundStore 侧知道字段清单 = 镜像未除。
- **契约等价（实证）**：落盘 JSON 形状**不变**（`undefined` 值由 `JSON.stringify` 自然丢弃）；`read_dedup_block` 全库**零代码消费**（grep 仅命中类型定义、落盘点与登记文档）；`memory → agent` 类型禁向未破。
- **验证**：`typecheck` 0 / `eslint` 0 / `format:check` 0 / `rules:refs` 0（闸门自检 8/8 + 裸路径引用全可解析）/ 全量 **2813 passed | 4 skipped**。`legacy-contract-audit-rules.md` §7「读取防重证据字段镜像」登记行 → **收敛（结案）**。

### Added（内核 · read_dedup 撞墙升级 + 兜底观测 + 读后即记引导）

- **撞墙升级**：同一读取主体被 `read_dedup` 硬拦 2 次后，第 3 次命中起文案升级为强禁令（`[ALREADY_READ] 你已第 {count} 次尝试重复获取…`）。出口引导收敛 `{tail}` 单源按主体分流：read_file 给 offset/limit 续读出口，非文件主体（query/url/会话等）不给——单语境断言不内嵌共用文案；另加 `search_memories` 记忆检索。阈值 `READ_DEDUP_ESCALATE_THRESHOLD = 2`（用户裁决 2026-09-28：第 2 次即升级太激进、第 3 次合适）；计数经 `GuardRail.notifyBlocked` **拦截归属回喂**（新钩子 `onBlocked`）喂数——`onExec` 只知「被某种护栏拦」，台账替身回显等非本护栏拦截不会误计；随 `reset('perTurn')` 轮界归零
- **兜底观测**：`readDedupBlockCount` 指标（`LoopMetrics` / `AgentMetrics.tools` / tracer 透传）+ `read_dedup_block` 裁决证据（`RoundEvidenceEvent` 新变体，含 toolName + 去重主体字段）——判「模型乒乓」vs「合理重读被误拦」的量化基线，与 `ledgerStubEchoCount`（L3 变体顶替）互补；证据字段面三处镜像已登记 `legacy-contract-audit-rules.md` §7 待验证候选（**该镜像已于同版收敛结案**，见上方 Fixed 条）
- **读后即记引导（内核侧，非角色包）**：`read_file` 工具描述追加「读到需长期引用的要点随即 `remember_intel` 记入工作笔记，查证用 `search_memories`，不要靠重复读文件」——工具描述是工具行为的 how 单源（用户裁决：该引导属内核职责，不进角色包）
- **验证（变异闭合）**：`guardRail.test.ts` 升级判定 6 例（前两次温和 / 第 3 次升级保留 read_file 出口 / web_search 主体不带 offset/limit / 主体隔离 / 轮界归零 / 阈值语义钉）+ `loop.test.ts` 集成 1 例（loop→guard 连线 + 指标 + 文案落位，按文案特征分流计数——压缩替身同含 `[ALREADY_READ]` 令牌，按令牌计数会误算）；**变异四组均还原复绿**：阈值 2→1 → 恰 2 红、断开 `notifyBlocked` 连线 → 恰 1 红（集成）、断开 `promptArgs` 裁决连线 → 恰 2 红、出口分流回潮 → 恰 1 红。`typecheck` 0 / `eslint` 0 / `rules:refs` 0 / `format:check` 0 / 全量 **2812 passed | 4 skipped**

### Fixed（内核 · 写串行闸收口：`diskWrite` 声明位 + 不透明写屏障，DIFF-4/5）

- **问题**：「谁会改盘」散在两处枚举（builtinTools 工具表语义 ↔ `WRITE_PATH_EXTRACTORS` 键），新增写工具忘加提取器 = 串行不防 + 追踪不报 + 契约钉不红的三重静默（DIFF-5）；且 `run_code` / `run_*_script` 等**无 `args.path` 的写工具**不进串行闸——同 step 并行脚本写/脚本×write_file 同目标 = DIFF-3 同型丢内容（DIFF-4）
- **修复（SSOT：构造级单源）**：`ToolDefinition` 增 `diskWrite?: 'path' | 'opaque'` **行内声明**（真源 = 定义行，与 `readonly` 正交）；`PATH_WRITE_TOOL_NAMES` / `OPAQUE_WRITE_TOOL_NAMES` / `WRITE_PATH_EXTRACTORS` 全部**派生**（漂移不可构造），`toolExecutor.builtinDefinitions` 与 loop 的「写后失效 read_file 缓存」分支**同批收编**各自的内联枚举（后者顺带修掉潜伏 miss：原用 raw 路径失效台账，`./a.md` 式入参会失效不中，改走同一提取器的归一路径）。契约钉 3 例（含 `'path'` 行必带 `path` 参数的语义自洽断言）
- **串行闸补齐（不带伤三条件齐）**：不透明写（`run_code` / `run_skill_script` / `run_project_script` / `register_work`，后者经核查证实为异步读-改-写）升为**屏障**——与一切写互斥；声明 `'path'` 但目标提取失败 → **降级屏障**（不确定即保守串行）；同路径串行维持现状、不同路径仍并发（反向守卫保绿）
- **验证（变异闭合）**：loop 峰值活跃数断言 ×3 新例；变异 3 场精确命中（删声明→恰 1 红 / 短路屏障→恰 3 红 / 拆降级半→恰 1 红），既有 DIFF-3 两例与反向守卫全程零误伤
- **边界（如实记）**：自定义工具的 `diskWrite` 声明暂不生效；「新工具整行忘声明」靠行内同处 + 契约钉复审兜住；脚本改盘的**可视化盲区**保留（宿主 FS watcher 触发驱动，见台账 DIFF-4）

### Added（内核 · 公开导出面补齐：`MAX_DIFF_CONTENT_LENGTH` / `WRITE_PATH_EXTRACTORS`）

- `src/security/pathGuard.ts` 导出 `MAX_DIFF_CONTENT_LENGTH`（diff 内容上限 10240），`src/index.ts` 安全层导出面收录——宿主 UI 展示阈值 `import` 对齐，消除跨包同值并列（DIFF-2）。⚠️ 两侧超限行为不同（内核 = 截断后加「已截断」标记照常展示 / 宿主 = 跳过对比只提示），导出只统一**数值**、不统一行为
- `src/agent/toolResultCache.ts` 的 `WRITE_PATH_EXTRACTORS`（按 `args.path` 改盘工具清单，loop 同路径写串行闸判据）经 `src/index.ts` 导出——宿主改动追踪据其键派生触发集合，跨包双枚举收编为单源（内核新增按 path 写工具时宿主自动跟随）
- **覆盖边界（如实记）**：清单只认 `args.path` 定位的写工具，`run_code` / `run_*_script` 类不在内（台账 DIFF-4 / DIFF-5 登记）

### Fixed（内核 · 同一 step 并行写同一文件会丢内容 DIFF-3：按目标路径批内串行）

**问题证据（真机两次实证）**：一个 step 内模型可能**并行**多次写同一文件（`round-1790411133316` / `round-1790412202553` 两轮实测 `insert` + `append` 同时发出）。`write_file` 是「读盘 → 改 → 写盘」，并行时两次都基于**同一份旧快照**（两条结果的 summary 各自自报「旧文件: 28 行」）⇒ 后落地者整体覆盖先落地者，**插入的行被静默吃掉**（31 → 34 行，插入内容丢失）；模型串行重发才恢复。

- **改法**：新增 `WRITE_PATH_EXTRACTORS`（`toolResultCache.ts`）——与 `DEDUP_SUBJECT_EXTRACTORS` **并列而非合并**（后者是**防重**判据，写工具正是被防重刻意排除的对象；并入会让「同文件分次追加」被误拦，属语义反转）。loop 发起工具时按**规范化目标路径**（复用 `normalizePathKey`，路径等价语义只有一套）把同路径的写**串成链**；不同路径之间维持完全并发
- **边界（不改单次语义）**：只串行「同路径的**写**」（`write_file` / `delete_file`），不排队所有写工具、**读不参与**（读-写竞态本次不动，未观察到损害）；工具结果仍按 `toolCalls` 原序对齐回填，`tool_start` 仍批量先发。**覆盖边界（如实记）**：清单只认 `args.path` 定位的写工具 ⇒ `run_code` / `run_skill_script` / `run_project_script`（能改盘但无 `path`）不在闸内
- **验证（变异闭合）**：`loop.test.ts` 新增 2 例——同路径写串行（峰值活跃数恒 1，且 `a.md` / `./a.md` 等价写法被归一为同一文件）、不同路径写仍并发（峰值 ≥ 2，**反向守卫**防「凡写工具一律排队」的退化实现）。**变异**：短路串行分支 → 串行例**恰 1 红**（`maxActive` 2→1 失守）、并发例仍绿；恢复后 `grep` 复核零残留。内核全量 **2795 passed**（较改动前 +2，零回归）
- **归属口径**：原登记在 3.1.0，2026-09-26 决议**改归 3.0.0**——代码已过 13 步门禁落在 main，为保标签去切发布源的成本 > 收益；且它是带守卫的 bug fix，纳入 3.0.0 不破坏任何契约。决策留档见 `tasks/待完成任务.md` DIFF-3 行

### Fixed（内核 · 任务表工具契约收敛：必填参数删除不可达缺省 + `update` 模式全量替换语义钉死）

**问题（五类带伤复审 · 口径伤 + 命名伤）**：① `task_table_write` 的 `mode` 与 `task_table_update` 的 `status` 在 `builtinTools` 工具表标 `required`，却在 `toolExecutor` 派发处各给 `'overwrite'` / `'done'` 缺省——schema 与实现自相矛盾（**口径伤**）；② `task_table_write` 的 `update` 模式按 `items` 索引全量重建（`writePlan` 整体替换 `checkpoint.plan`），对外描述只说「替换」，LLM 极易与单任务项工具 `task_table_update` 混淆、漏列即丢项（**命名伤 + 口径伤**）。

- **修法（止血不造伤 · 零行为变更）**：① 删 `task_table_write`/`task_table_update` 派发处两处**不可达**缺省（`strArg('mode')` / `strArg('status')` 不再给回退值）——`required` 校验层（`validateAndCoerceArgs`）本就在派发前拦截缺失，缺省是永不可达的死代码，删后唯一区别是「校验被绕过时 fail-loud 而非静默覆盖」；② `task_table_write` 的 `update` 模式描述补全「须传完整任务项列表，未列出的会被丢弃——勿与 `task_table_update` 混淆」（工具级描述 + `mode` 参数级描述双处对齐，单一口径）
- **验证（回归钉锁死契约）**：新增 `sessionManager.test.ts` 守卫「`writePlan` update 模式全量替换：未列出的任务项被丢弃」（3 项基线 → update 传 2 项 → plan 长度=2、保留原 id、第 3 项消失）。**实测**：`builtinTools.test.ts` 70 passed / `toolExecutor.test.ts` task_table 14 passed / `sessionManager.test.ts` 整文件 74 passed，全绿零回归
- **残留已知伤（已收口，见下方 Changed）**：`update` 模式 与 `task_table_update` 工具**撞名**是结构性命名带伤，描述缓解仅止血；改名已于同批落地（见下方 Changed 段），台账 `TASKTABLE-NAME-1` 销项

### Changed（任务表写入模式正名：`task_table_write` 的 `update` → `replace`，TASKTABLE-NAME-1 收口）

**问题**：`task_table_write` 的 `update` 模式（全量替换整张表）与单任务项工具 `task_table_update` 撞名——两种语义共用一个词，内核注释已被污染（`updatePlan` 头注释曾把生产点误写成 `task_table_update mode='update'`）。

- **改名窗口（证伪旧定性）**：`git tag` 最高 `v2.0.3`、`package.json` 虽为 3.0.0 但未发布 npm ⇒ **不存在任何已发布消费者**，改名是纯内部改动，无需 deprecation 周期（原「须走 deprecation」定性已被 tag 实证推翻）
- **选词**：`replace` 与 `overwrite`（清空重写）/`append`（追加）三词互不重叠，与 `task_table_update`（单项状态）彻底不撞
- **自愈路径**：mode 校验本就 fail-loud（`[ERR:INVALID_ARG]` 列出全部可用值）——模型输出旧词 `update` 会拿到含 `replace` 的明确错误，可自行重试；守卫钉死「旧词不得静默下发（writePlan else 兜底是 no-op，下发即静默丢写）」
- **二次收口（自审揪出漏网）**：`assembler.ts` 任务表「未完成硬约束」nudge（每轮注入 LLM 的生产提示词）仍写 `task_table_write (update)`——首轮 grep 判据只扫 mode 字面量赋值，漏了形态相异的提示词文案；且该句语义本就与工具契约不符（`task_table_write` 任何 mode 都不改 status，「标记已阻塞」只有 `task_table_update` 能置 `blocked`）。一并正名 + 纠语义（改指 `task_table_update` 置 `blocked`），并补 `assembler.test.ts` 词表 + 语义双钉
- **改动面**：`builtinTools.ts` 描述 ×2、`toolExecutor.ts` 校验 + 接口类型 + 注释、`sessionManager.ts` 类型/分支/注释（顺带修正生产点工具名笔误）、`assembler.ts` 未完成硬约束 nudge 正名 + 纠语义、测试 ×5；宿主零消费（只按工具名匹配）、docs/角色包零提及 mode
- **验证（变异闭合）**：变异 A（判据改回 `update`）→ 新钉 2 条**恰 2 红**；变异 B（`replace` 分支短路 no-op）→ 语义钉**恰 1 红**；变异 C（nudge 还原旧词 + `task_table_write` 误引）→ `assembler.test.ts` 新钉**恰 1 红**，零误伤。恢复后 `tsc` 0、`eslint` 0、`sessionManager`+`builtinTools` **144 passed**、`toolExecutor` task_table **16 passed**、`assembler` **34 passed**

### Added（新增门禁 `rules:refs`：规则裸路径引用有效性 · 补 `docs:links` 同族盲区）

**问题证据（血训）**：`413e1046` 把 14 个规则文件从 `.trae/rules/` 移入 `.trae/rules/generic/`，引用漏改分**两类书写形态**——① markdown 链接形态（`](...)`，`docs:links` 能抓，已修 15 处）；② **反引号 / 纯文本形态的裸路径**（本次修 12 处）。后者是**判据失明的盲区**：`docs:links` 只认 `](...)` 语法，且**主动剥离行内代码跨度**（见 `check-publish-links.ts` 的 `LINK_RE` / `INLINE_CODE_RE`）→ 裸路径根本不在其扫描面内。两类是同一族「参考腐烂」，只是书写形态不同。

- **新增 `scripts/check-rule-refs.ts`**：扫全仓文本文件（`.md` / `.ts` / `.mjs` / `.yml`）里的 `.trae/rules/` 裸路径引用，解析不到目标文件即 exit 1。与 `check-publish-links.ts` 同型（纯 FS / 零三方依赖 / 零网络 / 确定性 / 只读 + 退出码），可进 CI
- **判据边界（刻意排除，非豁免清单）**：① 源文件位于 `.trae/skills/**` —— 技能手册是**可移植模板**，其中引用的规则文件由 big-tree-seeder 在**目标项目**生成，本仓内本就不该存在；② **脚本自身** —— 否则脚本内作为样例的旧路径文本会给「旧路径基线」续命（同术语门禁教训：扫自身 → 消失检测失效）
- **闸门自检（每次运行都跑，不可关闭）**：先对 3 条内置样例跑**同一套判据**（`scanLine`，与主扫描同源，非另写一套），未全过即 exit 2 —— 「0 命中即成功」这类断言若判据本身失明（正则改坏 / 排除逻辑写反）会**静默假绿**
- **修复 12 处陈旧裸路径引用（9 文件）**：`docs/` × 4、`prompts/` × 1、`tasks/` × 2、`vitest.config.ts` × 1 —— 全部补 `generic/`。其中 `vitest.config.ts` 一处是首轮 grep 正则漏掉下划线文件名所致（`[a-z0-9-]` → `[A-Za-z0-9_./-]` 才现形），属「排雷发现取证不完整」的实例
- **接线**：`package.json` 新增 `rules:refs` 脚本；`scripts/local-ci.mjs` 步骤清单 full 档新增同名步骤（位于术语门禁之后、audit 之前）
- **验证（变异闭合）**：自检 **3/3**、扫 **556** 文本文件、**0 命中** EXIT=0；临时把 `vitest.config.ts` 引用改回旧路径 → **恰 1 红**（正确定位到该行）→ 恢复全绿；`docs:links:repo` 自检 4/4 / 208 链接 / 0 死链；`terminology:check` 零漂移；`tsc -p tsconfig.scripts.json` / `eslint --max-warnings 0` EXIT=0
### Changed（任务项折叠边界 `plan_item_boundary` 产出时机前移：边界产在它所罩住的内容之前）

**问题证据**：真机观察「触发任务表后 step 没收进任务项折叠块」。先打掉误判——宿主两条渲染路径（运行时 `renderProcessFlow` / 收尾 `renderRoundBlock`）共用同一归组判据 `planItemContainerFor`，实测（3 迭代 / 2 任务项 / 真实递增 `ts`）两路径结果**逐字相同**（组内 `t2,t3`、游离 `t1`），**不存在「运行时不收、收尾收」的机制差异**。真身是：**每个任务项的首个迭代（思考 + 首批工具）恒在折叠块外**——因为边界产在本迭代工具落定**之后**，而宿主判据 `b.ts < ts` 只能**向前**找边界，对首个迭代必然落空；且批块首次插入即定位容器、之后不搬家。

- **产出点前移**：`_maybeEmitPlanItemBoundary()` 从「工具落定后 / 无工具分支」**两处**调用点，收敛为**唯一一处**——`handleIteration` 内 `_handleInterrupt` 之后、`_prepareContext` 之前（迭代开始、LLM 调用前）。边界语义由「我现在在这项」回到「**以下内容**属于该项」
- **落点必须早于 LLM 调用**（而非 `onPlanItemBoundary` 所在的「LLM 后 / 工具前」）：后者会把边界插在本 step 思考流之后，把思考与它驱动的工具劈进两个任务项容器
- **调用次数不变**：原实现每迭代调一次（工具分支经 `_emitStepBoundary` / 无工具分支单独调），前移后仍是每迭代一次（迭代开头），挂起/中止迭代因 `_handleInterrupt` 提前返回而不调——与原来一致。**不是新增开销**
- **不带伤判定（五类逐条）**：双轨镜像——2 处产出点收敛为 1 处 🟢 净减伤；降级兜底残留——旧实现里边界产在内容**之后**，末尾那条边界之后已无内容 → 只剩标题的**空折叠块**；前移后边界必然罩住本迭代内容，空折叠块消失 🟢 净减伤（注意：**终态迭代仍会产边界**，旧实现同样会——工具分支的 `_maybeEmitPlanItemBoundary()` 原本就是无条件调用，只有 `step_boundary` 条件化。差别只在边界的**位置**，不在有无）；类型 hack / 重复实现 🟢 无伤；僵尸声明 🟡 需注释回扫（已做）
- **被否决的备选**：宿主侧放宽判据允许「归入紧随其后的边界」——判据与内核语义对不上，形成双判据，属拿实现迁就显示
- **语义后果（可接受，非缺陷）**：任务表若由本轮某迭代的工具**新建**，该迭代仍留在组外（那个时刻任务表还不存在）。本次修的是「任务表在本轮开始前已存在」（续会 / prepare 预置 / 上一 turn 遗留 / checkpoint 恢复）的场景
- **`lastBoundaryPlanItemId` 跨 turn 不重置**：刻意设计（`metrics.test.ts` 两个用例锁死），本次不动
- **文档同步**：`docs/方案-任务项边界产出时机前移-20260926.md`（闭合闭环，先文档后代码）；`docs/architecture/step-atomic-persistence.md` 档 3 两处订正（原述「复用两个既有调用点」「由 `_emitStepBoundary` 单函数内串联两者」已废止，先后序改由「分居迭代首尾」保证）；`types.ts` 顺序契约注释、`assembler.ts` 装配注释、`loop.ts` 时序分叉注释同步
- **验证（变异闭合）**：新增用例先红（`expected 4 to be less than 1`——边界下标 4 晚于思考下标 1，实锤旧行为）→ 改实现转绿；`stepBoundary.test.ts` 10/10，顺序契约 / STEP-BUCKET-1 / TOOL-RUN-1 三条老守卫全绿零误伤；内核 `tsc --noEmit` EXIT=0

### Removed（`ProjectContext.dbPath` 退役：内核不再持宿主持久化形态）

`ProjectContext.dbPath` 是「内核自带 SqliteStorage」时代的遗留字段。ADR-002 把 SqliteStorage 移出内核、持久化改由宿主经 `IMemoryStorage` 注入之后，它的消费者已清零：内核既不创建也不打开它，第一宿主 memora-vscode 的 `WorkspaceStorage` 走自己的 `.memora/memories.json`，从未读它。字段注释自称「Agent 级 `memora.db` 路径（全局共享）」，实值却是 `join(agentDataDir, 'memora.db')`，而 `agentDataDir` 由宿主传入的 `dataDir` 决定（vscode 宿主传的是项目级 `.memora`）——照它开库会得到「每个子项目一个 `memora.db`」，正撞架构规则明令禁止的形态。

- **删除 `ProjectContext.dbPath`** 字段声明与赋值；`ProjectContext.index` 注释去掉「SQLite 索引」具象化（内核不假设宿主持久化形态）
- **文档同步**：`docs/memora-api-reference.md` 的 `ProjectContext` 字段表移除该行；`storage` × `dataDir` 对照表去掉 `join(dataDir, 'memora.db')` 与「内核推导 dbPath」两处表述
- **破坏性但零成本**：`ProjectContext` 经 `src/index.ts` 导出的 `AgentContext` 别名对外可见，故此行属公共 API 变更；**不提供兼容层**——3.0.0 尚未发布（npm 最新为 2.0.3），无外部用户依赖该字段，且它本身零消费者、无行为可兼容

### Changed（`AgentOptions.dataDir` 收紧为必填 + `switchProject` 拒绝未解析的非绝对路径）

同一根因的两处收口：**「Agent 级数据目录」在内核与宿主之间没有定死**。`dataDir` 类型标可选、文档称「缺省 `~/.memora`」，代码却写着 `opts.dataDir!` 非空断言——而 `src/` 里从来没有 `~/.memora` 这个默认值（`homedir` 仅出现在 `expandHome` 内部；唯一的 `~/.memora` 在 `config.example.json`，且 `config.memory.dataDir` 内核**不消费**，全仓只有测试读它）。照文档省略 `dataDir` 的后果是 `expandHome(undefined)` 抛 `Cannot read properties of undefined`。

- **`dataDir` 改为必填**：`AgentOptions.dataDir?: string` → `dataDir: string`，并删掉 `agent.ts` 的 `!` 断言——把运行期爆炸换成编译期保证。目录位置与其层级语义（项目级 / 用户级）是宿主的产品决策，内核不提供默认值、也不做假设
- **`registryDir` 注释诚实化**：缺省随 `dataDir`（原注释自称「优先宿主指定用户级路径，避免每项目重复存储」，而缺省分支恰恰就是每项目一份）。注册表的用途是**跨项目按名解析**，只有多项目共用一份目录时才兑现；`dataDir` 为项目级时，注册表随项目落盘、只含项目自身条目
- **`switchProject` 加守卫**：`nameOrPath` 只接受「注册表中的项目名」或「项目根目录的绝对路径」，二者都不满足时抛 `configError`。此前未命中会原样当路径 → `resolve('...', '.memora')` 以 `process.cwd()` 为基准，**静默建出伪项目目录、占用其锁、写入注册表**
- **文档同步**：api-reference §〇.3 去掉 `dataDir` 的假默认、补「`config.json` 的 `memory.dataDir` 内核不读」、订正「锁文件由 `dataDir` 推导」（锁固定落 `<projectPath>/.memora/.lock`，与 `dataDir` 无关）；README 中英双版与接入指南的构造示例原先**漏传 `dataDir` 或传相对路径**，补绝对路径；接入指南 §8 拆「按路径（推荐）/ 按名（需先注册 + 注册表共享）」两式
- **随包文档两处冲突表述订正**：api-reference「内部数据写入（不越界）」段与接入指南 §十 关键约束 3 原先分别称两个状态文件在 `~/.memora/`、`.memora/` 只放 `rules/`+`skills/`——均与本次收敛后的路径契约矛盾，同步改正

> **破坏性但零成本**（对齐本文件既有口径）：`AgentOptions.dataDir` 由可选改必填是对外可见的类型变更；但仓内**无一处**省略它——内核 `tsc --noEmit`（`include` 覆盖 `src/**/*`，含全部测试文件）与宿主 10 处构造点全数通过，改动实质是把 `!` 断言换成编译期保证。`registryDir` 保留（它是宿主把注册表提到用户级的唯一通道），仅订正注释；宿主零消费 `switchProject`，故守卫不构成在网行为变更。

### Changed（术语正名：任务项 `PlanStep` → `PlanItem` + `step_boundary` 归位为迭代边界）

根治项目内两个「step」的术语撞车——① **loop 迭代 step**（一次 LLM 交互 + 其工具执行，`stepBudget` 属此阵营）；② **任务表 plan step**（一行任务）。阵营②此前占用 `step_boundary` 事件名，导致阵营①没有自己的边界信号——这同时是「无任务表长工具循环零增量落盘」缺口的根因。

- **事件对调**：迭代边界 `iteration_boundary` **归位**为 `step_boundary`；任务表边界 `step_boundary` 改名 **`plan_item_boundary`**
- **内核标识符**：`PlanStep` → `PlanItem`（连同 `planStepId` → `planItemId` / `getActiveStepMeta` → `getActivePlanItemMeta` / `updatePlanStepStatus` → `updatePlanItemStatus` / `appendPlanStep` → `appendPlanItem` / `completeStep` → `completePlanItem` / `STEP_DESC_MAX_CHARS` → `PLAN_ITEM_DESC_MAX_CHARS`）
- **宿主标识符 / 协议 / 样式**：`PlanStepDto` → `PlanItemDto`、`currentPlanSteps` → `currentPlanItems`、`insertStepInOrder` → `insertPlanItemInOrder` 等；`plan_update` 消息字段 `steps` → `items`；CSS 类 `.plan-step*` → `.plan-item*`、`.round-block__step*` → `.round-block__plan-item*`；DOM 属性 `data-step` → `data-plan-item`（**仅任务项段**；`data-step-bucket` = thought 按 stepIndex 分桶，属 step 阵营，**不改、也不得改**）；折叠块标题 `step-N` → **「任务项 N」**
- **不动（硬边界）**：`stepBudget` / `multiStepReasoning` / `toolStepLimit`（角色包策略键 = 对外契约）、`task_table_*`（工具名，见下条）、CSS 关键字 `step-end`、历史档号与本文件旧版本条目（`step_id` / `steps` 两个**参数名**当时一并保留，已于 Unreleased 内后续条目正名）

> **对内核公共 API 非破坏**：改动集中在内部标识符与宿主协议；`Round.processEvents` / `SessionCheckpoint` 等持久化 schema 未动。**唯一语义变更是事件名 `step_boundary`**（原任务表边界 → 现迭代边界），宿主与内核须同批升级。**不提供兼容层**（测试阶段无外部用户；`.memora/` 为本地桌面数据，重新生成即可）。

### Changed（术语收口补完：函数名归位 + LLM 可见文案与错误码正名）

承接上条 `PlanStep → PlanItem` 正名——上条落到**事件名与标识符**为止，遗留两处半补丁：① `_maybeEmitStepBoundary` 名为 step 却产 `plan_item_boundary`、`_emitIterationBoundary` 用历史别名命名却产 `step_boundary`（**函数名与产出事件互换**——只修事件名不修函数名，正是术语锚点 §7 后果链第一环的复刻）；② LLM 可见文案与错误码仍以「步骤」指任务项。3.0.0 未发布，此处无兼容代价，一次收口。

- **函数名归位**：`_maybeEmitStepBoundary` → `_maybeEmitPlanItemBoundary`、`_emitIterationBoundary` → `_emitStepBoundary`（均 `private`，零外部契约；`docs/architecture/step-atomic-persistence.md` 与 `loop-design.md` 同步）
- **错误码正名**：`[ERR:STEP_NOT_FOUND]` → `[ERR:PLAN_ITEM_NOT_FOUND]`（LLM 可见，无外部消费者）
- **LLM 可见文案与注释**：「步骤」→「任务项」——`builtinTools`（两个任务表工具描述）、`assembler`（任务表回执 / 未完成硬约束 / `updatePlanItem` 回执）、`toolExecutor`（寻址三类错误提示）、`taskTableRenderer`、`sessionManager`、`types.ts`、`scripts/test-tasktable-real.ts`
- **宿主注释**：`protocol.ts` / `chatView.ts` / `chatStyles.ts` / `chatPanel.ts` 共 33 处「步骤」「步级」→「任务项」「任务项级」（**纯注释，零字符串与标识符变更**）
- **仍不动（冻结例外）**：`task_table_*`（工具名）、`stepBudget` / `multiStepReasoning` / `toolStepLimit`、CSS 关键字 `step-end`、`data-step-bucket`（thought 按 stepIndex 分桶，属 step 阵营）；`handoffPrompt` 属**同名异义**（角色接手话术，非已废的 Handoff 衔接决策）——已补入术语锚点 §3 冻结例外（`step_id` / `steps` 两个参数名当时暂留，见下条正名）
- **fixture 边界**：录制轮次 fixture `realRound-*.ts` 内的「步骤 [xxx]」为**当时真实输出**，不改（改了即伪造证据）

### Added（术语载体扫描门禁：把「载体清单」机械化）

前两条落到「已发现的载体」为止，而三次半补丁（`.prettierignore` 只挡一半 / 函数名改了事件名没改 / 本文件过度声明）的共同根因是**载体清单不完整**。本轮把这个清单本身机械化。

- **新增 `scripts/terminology-carrier-snapshot.ts`**（`npm run terminology:report` 看报表 / `terminology:check` 做门禁，已接入 `ci:local` full 档）：扫全仓抽取 `step` 正名族与 `iteration` / `迭代` / `内循环` 历史别名族的**全部载体**（标识符 / 事件名 / CSS 类 / DOM 属性 / 中文词 / 文件名与目录名），与基线集合比对，有新增或消失即 `exit 1` 并打印可直接粘贴的基线。
- **不建第二份例外清单**：冻结例外由 `.trae/rules/terminology-anchor-rules.md` §3 表格**解析**得到（解析数不足即报错退出，防「静默返回空集 → 门禁永远绿」）。
- **只锁集合、不锁次数**：次数会因任意一次注释改动而漂移，门禁天天红必然被绕过；锁集合只对「新词出现 / 旧词消失」报警，语义对错仍由人显式确认（git diff 即审计痕迹）。
- **扫描范围边界（非逐词豁免）**：排除录制 fixture（`__tests__/fixtures/`，改了即伪造证据）与依赖 / 构建产物 / 工具内部状态。基线首版 102 个载体（随后续正名条目更新：见下两条）。

### Changed（术语载体扫描查出的 src 层三处漏网正名）

上一轮审计按「事件名 / 函数名 / 文案 / 错误码」分类去查，未扫全词根，漏了三处在 `src/` 生产代码里的 `step` 撞车——本轮由扫描清单反查出来。

- **`perStep` → `perTurn`**（`guardRail.ts` 的 `GuardRailDef.life` / `GuardRail.reset` + 4 处护栏定义、`loop.ts` 调用点、`guardRail.test.ts`）：该 `life` 的归零点在 `resetTurnState`，其原注释亦自称「按闭环累计」——**名字说 step、语义是 turn**，与「step 指任务项」方向相反的同族撞车。`GuardRailDef` 未经 `src/index.ts` 导出、宿主零消费，改动无外部契约影响。
- **`STEP_LOG_PER_STEP_LIMIT` → `PLAN_ITEM_LOG_PER_ITEM_LIMIT`**（`sessionManager.appendPlanItemLog`，连同其 JSDoc 4 处「step」）：该段全程按 `planItemId` 分组，`step` 在此即任务项（术语锚点 §4.1 红线）。同步测试内局部量 `stepLogLenBefore` → `planItemLogLenBefore`。
- **仍不动（冻结例外）**：`task_table_*`（工具名）、`stepBudget` / `multiStepReasoning` / `toolStepLimit`、CSS 关键字 `step-end` / `animation-iteration-count`、GitHub Actions 的 `steps`（外部生态词，非本仓术语）、过程文档与台账内的历史记录（`PlanStep` / `getActiveStepMeta` 等旧名属「怎么变过来的」，改写即伪造记录）（`step_id` / `steps` 两个参数名当时暂留，见下条正名）

### Changed（任务表工具参数正名：`step_id` → `plan_item_id` / `steps` → `items` + 同族 bare「步」收尾）

上三条把正名推到「事件名 / 函数名 / 文案 / 错误码」，仍把两个**工具参数名**留在冻结例外里。3.0.0 未发布 ⇒ 改名零成本；而工具参数名是**每轮都进 LLM 上下文的契约面**，长期占用 `step` 就是持续教坏模型与后来者（术语锚点 §4.1 明文禁止用 `step` 表任务表语义）。本轮把它降级为**历史别名**，并顺手扫掉同族漏网的第三种形态——bare「步」（前几轮只认「步骤 / 步级」两词，`某步` / `逐步` / `该步` / `active 步` 全在网外）。

- **工具参数正名**：`task_table_update` 寻址参数 `step_id` → **`plan_item_id`**；`task_table_write` 列表参数 `steps` → **`items`**。全链同步：内核 `builtinTools`（工具描述 + JSON schema）、`toolExecutor`（寻址解析 + 三类错误文案）、`assembler` / `sessionManager` 的 `writePlan` 形参、`scripts/test-tasktable-real.ts`、宿主 `chatView.test.ts`
- **术语锚点同步**：§2 任务表阵营新增「任务表工具参数」行（`plan_item_id` / `items`）；§3 **删除 `step_id` 条目**（冻结例外收敛为 3 个 `stepBudget` 词根键 + `handoffPrompt` 同名异义）；§4.1 明列「含**工具参数名**」；§6 新增历史别名行——旧名只可用于读懂历史记录
- **内核注释同族收尾（bare「步」形态）**：`assembler`（会议逐项切换 / 任务项边界回调 / 末项兜底）、`agent`（turn 收尾清空 / 可续跑判据 / 装配视角日志）、`loop`（任务项日志回调 / 在途判定注释 / 会议轮判据）、`sessionManager`（`ensureActivePlanItem` / `hasInflightPlan` / `completePlanItem` / `concludeActivePlanItemIfPlanFullyReached` / `getActivePlanItem` 的 JSDoc 与内联注释）、`orchestrator`（续跑对称刷新 / 兜底收尾）、`prepare`（会议骨架守卫 + 装配入口说明）、`rolePackManager`（会议组上下文文案注释）、`types`（`plan_item_boundary` / `plan` / `planItemLog` 字段注释）、`taskTableRenderer`（收尾验证 nudge 注释与**文案正文**）、`builtinToolHandlers`（保留文件名错误的建议条）、`needsPlanning`（`PLAN_NUDGE_PROMPT` 正文）
- **活跃架构文档**：`docs/architecture/role-pack-exclusivity-relocation.md` 全篇把任务项称「步」的表述正名（含 §4.3 装配驱动点、§4.5 会议执行流、S5 行的 2026-08-29 补强注记、`task_table_write` 参数示例 `steps` → `items`）；§6.3 的「实施步骤 S0→S8 / | 步 |」属**通用程序步骤**（第三种语义），不动
- **边界（不改）**：测试样本数据字面量（`description: '步骤一'` / `id: 'a1b2c3d4-step-1'`）与录制 fixture 内「步骤 [xxx] 已标记为 done」是**内容而非术语载体**，改即纯 churn 或伪造证据；`step` 本义用法（`stepBudget` / 多步推理 / 工具步 / `data-step-bucket`）与通用程序用词（`needsPlanning` 的用户输入检测词 `多步` / `分步骤`）一并不动
- **本条作废前三条的「仍不动」表述**：`step_id` / `steps` 曾被列为硬边界或冻结例外，正名后该表述作废；`task_table_*`（工具名）与 `stepBudget` / `multiStepReasoning` / `toolStepLimit` 仍在硬边界内不动

### Fixed（术语载体门禁结构性失效：脚本扫自身致「旧词消失」永不报警）

- **根因**：`scripts/terminology-carrier-snapshot.ts` 的 `walk()` 扫全仓时**包含自身**，而 `BASELINE` 常量里的字面量本身就是 step 族 token ⇒ 基线里的旧词永远被自己续命 ⇒「旧词消失」这条检测**结构性失效**（只报新增、不报消失）。实证：本轮正名后 `terminology:check` 仍报「无漂移（104 个载体）」。
- **修复**：新增 `SELF_REL` 自排除（本文件是门禁工具＝元数据，不属被纪律的载体对象），并在文件头「明确不扫」清单写明理由；复跑立刻得到真实的 `新增 0 / 消失 4`，删掉那 4 条基线条目后 104 → 100 复绿（`MIN_FROZEN` 仍为 3，与锚点 §3 解析数一致）。⚠️ 本条**刻意不列出那 4 个 token 的字面量**——本文件也在扫描范围内，写出旧名等于把它们重新挂回载体集合，门禁会立刻报「新增 4」。
- **已知边界（设计使然，非缺陷）**：历史记录（本文件旧条目、`tasks/` 台账、`.trae/documents/` 过程方案）会被扫描且**理应**保留旧名 ⇒ 旧名只要还在记录里被引用，就不会被判为「消失」。集合纪律的重心在**新增报警**（新代码误用旧词根），消失报警只是次级信号。

### Changed（内核零运行时模块解析：移除 pino 可选 peer 与内核侧文件日志）

内核定位「零第三方运行时依赖」的收口——移除内核**唯一**的运行时第三方模块解析点，让声明与实现一致。

- **移除 `import('pino')`**：删除 `tryCreatePinoLogger()` / `wrapPinoAsLogger()` / `maybeUpgradeToPino()` 及配套懒升级机制；内核不再加载任何第三方日志库、不做任何运行时模块解析（此前该动态导入会被宿主 bundle 内联，把内核运行时绑到宿主模块图）
- **`package.json`**：删除 `peerDependencies` / `peerDependenciesMeta`（pino 为唯一条目）；`devDependencies` 删除 `pino` / `pino-pretty`
- **内核侧文件日志退场**：随之删除 `MEMORA_DATA_DIR` / `MEMORA_LOG_FILE` 两个进程级隐式契约（仅文件日志在用，宿主从未设置）
- **日志形态对宿主零影响**：仍为「默认内置 console fallback（写 stderr，级别由 `MEMORA_LOG_LEVEL` 控制）+ 宿主经 `setLogger()` 注入」，VS Code 宿主注入通道（`hosts/memora-vscode/src/extension/host/assemble.ts`）不变；`logger` 门面由 getter 改为普通委托闭包（函数身份稳定）
- **`setLogger` 注入即唯一出口**：注入分支补齐 utils 层桥接（`utils/loggerHolder`），`scanner` / `eventEmitter` / `rolePackManager` 等 utils 侧模块随宿主注入统一切换（此前注入只覆盖 `logging/` 门面，utils 侧停留在 console fallback）
- **文档收口**：api-reference / 接入指南 / ADR-002 补充节同步订正「零控制台输出」「pino 可选 peer」等过时表述

> 非破坏性变更：宿主注入通道与 `ILogger` 契约不变；未注入时行为从「尝试 pino、失败降级 console」变为「始终内置 console fallback」。README 双语（console fallback 口径）此前已一致，无需变更。

### Added（外部世界工具族：`web_fetch` 搜索→抓取闭环 + `run_code` 通用代码执行）

源自工具面盘点（tool-surface-roadmap.md）：`web_search` 只搜不抓、通用计算缺失。沿既有范式（接口注入 + 条件性暴露 + 降级优先 + 零依赖边界）补齐两个「连接外部世界」的条件工具。

- **网页抓取（`src/web-fetch/`）**：`IFetchProvider` 接口（与 `IWebSearchProvider` 同构）；`FetchWebFetchProvider` 零依赖默认实现（内置 fetch + 正则清洗 HTML + `<title>` 提取 + maxChars 截断）；`safeFetch` 30s 超时保护包装（失败/超时降级友好提示，不中断主流程）
- **代码执行（`src/code-exec/`）**：`ICodeExecutionProvider` 接口（沙箱完全由宿主 provider 决定，内核零运行时依赖）；`safeExecuteCode` 120s 超时保护包装（失败/超时降级返回错误结果）
- **工具集成（`agent/builtinTools.ts` + `toolExecutor.ts`）**：新增 `WEB_FETCH_TOOL` / `RUN_CODE_TOOL` 定义 + 幂等标记（web_fetch=idempotent，run_code=non-idempotent）；条件性暴露（注入 provider 才进入 LLM 工具面）；执行分支含 URL 协议白名单 / 长度上限 / 结果净化 / 三态格式化
- **注入链打通**：`AgentOptions.fetchProvider` / `codeExecutionProvider` 经 `assembler.ts` → `agent.ts` → `index.ts` 导出（接口 + 默认实现 + safe 包装）
- **能力映射**：`capabilityMap` 新增 `web:fetch` → web_fetch、`code:execute` → run_code
- **文档收口**：api-reference（注入接口 / AgentOptions / 内置工具表 / §8.4-8.5 / 类型导出）、接入指南（§4.5 外部世界工具注入）、module-inventory（§3.5）、README（核心能力 + 示例角色包随包）
- **测试**：新增 7 组（provider 纯函数 × 2、默认实现解析 × 1、工具定义 × 2、条件暴露/执行/冲突 × 2、capability 映射 × 2），含本次 web-fetch/code-exec 共 130 用例全绿

> 非破坏性变更：未注入 provider 时工具不暴露（零依赖边界保持）；`run_code` 沙箱隔离等级由宿主 provider 决定，接入前需评估安全边界。

### Added（结构化信息保真 + 提炼侧视角下沉：`summaryFocus` 提炼视角机制）

源自 LLM 视角 memora-as-agent 体感评估 P1 缺口「结构化信息保真」 + P2「提炼侧视角对齐」——代码/diff/表格等结构化信息经 round-summary 浓缩后保真度低，且提炼侧「值得记什么」仍为通用视角。沿内核哲学（领域无关 + 角色包插卡）落地的通用机制，让角色包声明「摘要提炼的视角（判断维度 + 结构保留形式）」。

- **内核机制（`role-pack/types.ts`）**：`PrepareStrategy` 新增可选 `summaryFocus`（角色包提炼视角）；新增 `resolveSummaryFocus` 解析函数（合法非空字符串采用、缺失/空白归位 undefined=通用浓缩）
- **摘要参数化（`roundSummaryGenerator.ts`）**：拆出 `SUMMARY_JSON_CONTRACT`（JSON 输出 + SummaryType 硬契约，角色包不可替换，写路径 metadata 稳定）与 `DEFAULT_SUMMARY_PERSPECTIVE`（通用"意图/回答/决策"归纳）；`generate` 第 5 参 `focus` 存在时以角色包提炼视角**替换**通用视角；缺省时逐字节零回归
- **装配接线（`agent.ts`）**：postProcess 注入激活角色包的 `summaryFocus`（`resolveSummaryFocus(this.getActiveStrategy())`）
- **验证器（`validator.ts`）**：`STRATEGY_KEY_RULES.prepare` 注册 `summaryFocus`（非空字符串校验），避免角色包声明产生未知键警告
- **角色包消费者**：示例库 `代码助手`、两库 `方案设计师` 声明完整提炼视角（判断维度 + 结构保留，首个消费者，尚未触发「≥2 处复用」机制化提炼）

> 非破坏性变更：内核零领域特化（提炼视角内容全由角色包提供，未 hardcode 代码/表格）；角色包未声明 `summaryFocus` 时摘要输出与升级前逐字节一致；typecheck + 全量测试通过。

### Added（插件 MVP：方案设计师 showcase 体验——空状态示例提问随角色特化）

插件 MVP 落地——让用户能通过插件一键体验 memora 最吸引人的设计魅力。审查插件与 memora 内核对齐情况后，聚焦「方案设计师 showcase」体验：把空状态示例提问从"文档打磨通用引导"升级为"随 showcase 角色动态渲染"，新用户切到方案设计师时，首屏即见「种子收敛」引导示例。

- **空状态示例提问动态化（chatView.ts）**：新增 `ROLE_SUGGESTION_SETS`（SSOT 映射，key=角色显示名）+ `DEFAULT_SUGGESTIONS` 通用回退；`renderEmptySuggestions(name)` 按激活角色渲染示例 chips——方案设计师展示「设计知识库 / 设计记忆系统 / 找最小单元」种子收敛引导，其余角色回退「审阅架构 / 精简表达 / 对齐实现」通用打磨引导
- **示例容器改造（chatPanel.ts）**：`#emptySuggestions` 从静态三个 chip 改为空容器，由脚本填充；HTML 注释同步更新
- **事件委托**：chips 点击改为 document 级委托，兼容动态渲染新增元素（dropdown 同类惯例）
- **测试**：chatView.test.ts 新增 showcase 特化用例（方案设计师专属 / 非 showcase 回退通用），测试骨架补 `#emptySuggestions` 容器

> 非破坏性变更：仅插件 UI 层空状态引导演进，内核与角色包内容零改动；插件 typecheck / 66 测试 / esbuild 构建（webview 打包）全通过。

### Added（方案设计师角色包：memora 设计哲学沉淀为可复用装载卡）

把 memora 的设计哲学（单一真理源 · 最小单元 · 网络为土壤）抽象为可复用的角色包「方案设计师」，供新开项目方案时直接装载复用——基于 `.trae/rules/` 的 `single-truth-source-mindset` / `network-soil-mindset` / `architecture_philosophy_rules` 提炼为 LLM 可执行的设计指令。

- **persona.md**：定位「从模糊想法设计自洽项目方案的顾问」，承载种子（最小单元锚点）/ 土壤（网络信息养分）两条设计主线
- **rules.md**：设计指令——先搜索再构思、种子定位、SSOT、最小单元解题、识别补丁思维、外部方案种子过滤、搜索结论进入决策、记录来源、种子收敛交互、产出结构、SSOT 三问收敛自检、不越界生成骨架
- **manifest.skills**：声明 `file:read` / `file:write` / `web:search` / `memory:recall` / `llm:summarize` 五个可调用能力，让角色能真正「先搜索再构思」、读写方案文档
- **落地**：插件生产库（`hosts/memora-vscode/src/extension/role-packs/方案设计师/`，随 VSIX 分发）+ 根示例库（`role-packs/方案设计师/`，参考指引），两包 manifest 均通过标准校验（`validateManifestText` valid=true）

> 非破坏性变更：纯新增角色包，内核零改动；新增包经 validator 校验合规，全量测试无回归。

### Added（方案设计师：种子收敛交互引导）

设计评审收敛——最小单元（种子）藏在用户业务里，LLM 无法凭空替用户定义，故把角色包从"被动澄清"升级为"主动引导用户收敛种子"的交互方法论（承载于 persona.md + rules.md，非工具能力）。

- **persona.md 新增「种子收敛交互」章节**：收敛五步——问最小闭环（一次触发→处理→输出）→ 问边界（谁触发/给谁用）→ 问不可再拆 → 问三性（自足/可重复/可观察）→ 复述确认；拿到用户确认的种子前不急于设计
- **核心能力「种子识别」→「种子引导收敛」**：从"替用户提炼"改为"引导用户自己收敛"
- **rules.md「主动澄清」→「种子收敛交互」**：设计前先收敛种子，不替用户定义；用户明确拒绝探讨时，提示"种子未锁定可能返工"并按指示继续
- 两库（生产 + 示例）persona.md / rules.md 同步更新；manifest 未变

> 非破坏性变更：仅角色包内容演进，内核与 manifest 零改动。

### Added（召回互斥前置过滤：跨会话记忆补位 top-limit）

基于设计评审（recall-mutex-pre-filter）落地——把"召回后互斥排除"改为"recall 内取 limit 前过滤"，修复单会话聚焦时跨会话记忆被挤出 top-limit 的缺陷，补齐新会话 0 上下文时召回最近摘要的自然行为（memory-as-summary §4.3）。

- **`recall` 新增 `excludeRoundIds` 选项**：在 `hybridMerge` 排序取 limit **前**过滤命中集合的 round-summary，让跨会话/更早轮次记忆补位；保底补足同样应用该过滤，避免把正文已加载的摘要补回（重复注入）
- **`agent.ts` 移除后置互斥过滤块**：`recallAndInject` 把 `getRecentRoundIds(recentRounds)` 结果作为 `excludeRoundIds` 传入 recall()，去重职责收敛到 recall 一处（SSOT）
- **向后兼容**：`excludeRoundIds` 缺省为空集合，纯检索调用方（multiHop、memoryInspector 等）行为完全不变

> 非破坏性变更：仅新增可选参数；去重语义等价（同一 roundId 集合、同一 N 来源 `resolveRecentRounds`），跨会话召回能力修复。

### Added（建议B落地："模型看到了什么"的指纹可追溯）

基于 Harness 排雷评估（harness-borrowing-assessment 建议B），落地可观测性指纹埋点——记录"模型看到了什么"的指纹 hash，**不记录全量内容、不入 sessionStore**（memory-as-summary §5.2.1 可追溯性边界）。

- **新增 `sha256Fingerprint`**：`src/utils/hash.ts` 通用 SHA-256 指纹纯函数，并复用于 `workProjection.ts`（消除重复 createHash 实现）
- **`llm.call` span 补 `systemPromptHash`**：最终发给模型的全部 system 消息内容指纹（loop.ts LLM_CALL 埋点）
- **`recall.recall` span 补 `attachedMemoryCount` / `attachedMemoryFingerprint`**：附着进上下文的记忆条数与 ID 集合指纹（loop.ts 记忆注入点埋点）
- **零开销边界**：宿主未注入 Tracer（NOOP）时不计算指纹；span 属性由宿主自行采集/落盘/展示（机制/策略分离）

> 非破坏性变更：仅新增 span 属性与工具函数，无公共 API 变更。

### Added（召回保底：兜底最近记忆，保证每轮记忆下限）

基于会话冷启动评估收敛（放弃独立"固定注入摘要"、信任 recall）后的落地补充——当语义召回结果不足时，用最近记忆补足，避免"零召回/极少召回"导致 LLM 完全无记忆可依（memory-as-summary §4.7）。

- **`recall` 新增 `minFallback` 选项**：语义召回结果少于阈值时，经 `storage.search('', n)` 空查询通道按 score 降序补足最近记忆；补足项排语义命中之后、与主流程同过滤（excludeSources + 差异化时间窗口 + 去 superseded）；置 0 彻底关闭
- **角色包 `prepare.minFallback`**：宿主可配置召回保底下限，非法/缺失回退内核默认 2；`resolveMinFallback` SSOT 归位
- **`DEFAULT_MIN_FALLBACK` 下沉 `utils/recallDefaults.ts`**：跨 role-pack 与 memory 共享同一默认值（SSOT 单一来源）

> 非破坏性变更：仅新增可选参数与配置维度，默认值 2 保持原有召回行为，无公共 API 破坏。

### Removed（洞察层移除，记忆收敛为 round-summary 单轨）

基于"摘要即记忆"架构定案（memory-as-summary §七 最终形态），移除独立洞察提炼层——其能力被 round-summary 的 type 分类吸收，记忆收敛为单一存储层。同时移除用户画像层（已收敛为 `type=preference` 差异化召回）。

- **移除 InsightExtractor 自动抽取**：`src/agent/managers/insightExtractor.ts` 删除，`assembler` 不再装配，`Agent.archiveInsight()` / `insight` getter 删除
- **移除 `insightExtracted` 事件**：不再有发射方，从 `AGENT_EVENTS` 与 `AgentEventMap` 清除
- **`archiveFailed.stage` 收敛为 `'content'`**：原 `'insight' | 'content'`，洞察阶段移除后仅剩 content
- **`ArchiveMode` 三态收敛为二态 `'full' | 'manual'`**：原 `'insights-only'`（仅洞察自动）因洞察移除失去语义，与 `manual` 等价，一并移除
- **memoryAdded 事件出口迁移**：由 RoundSummaryGenerator 在 round-summary 写入后发射（`setOnMemoryAdded`），替代原洞察层"已沉淀"通知
- **SessionArchiver（content 会话归档）保留**：非洞察，承载会话级综合提炼，粒度（会话级）与 round-summary（轮次级）不同

> ⚠️ **破坏性变更**：移除 `ArchiveMode` 的 `'insights-only'` 值与 `insightExtracted` 事件。宿主若使用需适配（sprite 适配另行处理）。

### Changed（架构文档排雷：角色包优先级后置）

基于架构交叉审查（agent-design-philosophy / memory-as-summary / role-pack-spec / mvp-scope），确立**角色包优先级后置于内核基础**（问答闭环 + 记忆系统），并解除基础模块对未定型角色包键的耦合——避免角色包接口随基础演进反复横跳。纯文档/架构层变更，无公共 API 变更。

- **记忆模块解耦**：互斥窗口 N 改由内核上下文装配提供默认值，角色包 `recentRounds` 仅作后置可覆盖项（memory-as-summary §4.3），记忆模块不再依赖草案键即可独立运行
- **召回开关 × type 差异化**：新增 §4.2.1 明确角色包召回开关（memoryRecall/summaryRecall，角色级总开关）与 type 差异化召回（召回内策略）的两层协作语义
- **配额分层**：§6.5 补记忆/摘要 token 配额分层约束
- **§14.3 定位澄清**：明确为 memora 内部设计全景，是否入标准由角色包标准双闸门裁决（避免僵尸键）
- **主动提问定位**：§14.3 全局策略补 `askOn/askLimit`，统一"理解确认/用户追问/askOn"命名关系
- **标准滞后修正**：`reflect.insightExtraction` 标注为兼容键（独立洞察层已随"记忆即摘要"移除）
- **标准演进状态**：role-pack-spec 声明处草案演进期，v1 字段冻结延后至基础定型
- **MVP 对齐**：角色包样例重写为 spec §2.3 标准格式；记忆措辞对齐"摘要即记忆"；补记忆跨任务验收项；temperature 改为不承诺随包生效

第二轮质量审查（对齐设计哲学 + 2026 行业）排雷落地——纯文档/架构层变更：

- **记忆维护取舍声明**（memory-as-summary §5.4）：显式声明 append-only 模型将"重复/冲突/过期"交 LLM 时间序聚合是有意取舍，type 分层作确定性兜底；记忆维护列为远期锚点（在闭环后处理内生长，不引入 merge/supersede 状态机）
- **检索侧补写**（memory-as-summary §4.7）：rerank / 同窗口优先对齐实现；query 改写等标远期不预埋
- **自审查轮定义**（mvp-scope，正文已随 2026-09-18 瘦身）：判据绑定外部确定性验证信号，防纯 LLM 自审的"自说自话"
- **可观察契约**（agent-design-philosophy §13.x）：闭环"可观察"固有属性产品化为"内核产活动事件、宿主渲染"，守零依赖内核边界

第三轮对抗性审查（第一性原理 + SSOT 自检）排雷落地——纯文档/架构层变更：

- **G2 写路径取代检测**（memory-as-summary §5.4）：记忆冲突消解从"读时靠 LLM 时间序猜"改为"写时定"——闭环后处理生成摘要时检测同类覆盖，给旧摘要打确定性 `superseded` 标记；SSOT 自检通过（不新增存储/系统/关系图，效率挪移）
- **G5 结构化提问事件**（mvp-scope（正文已随 2026-09-18 瘦身）/ philosophy §13.x / §14.3）：LLM 以 `[ASK]` 结构化输出 → 内核确定性解析为 `question_pending` 事件，消除"避免启发式却靠宿主猜文本"的逻辑矛盾；为活动事件流落地首个真实用例
- **G4 对话记录定位统一**（memory-as-summary §5.2）：从"展示层"改为"展示层 + 溯源兜底的运行依赖"，消除定位分裂
- **G1 摘要保真声明**（§5.4）：摘要是"有损线索"，保真由 traceSummary 兜底，诚实声明
- **G3 串行边界声明**（philosophy §13）：串行是单 Agent 阶段刻意约束，非普适真理，化解与多 Agent 愿景的张力
- **G6 角色包差异化天花板**（role-pack-spec §三 L2）：声明 L2 枚举只承诺行为参数，价值分层 = L1 专业性 / L2 行为偏好 / L3 能力扩展
- **G9 删 Trigger 三元组预埋**（philosophy §2.1）：删除 `{意图,载荷}` 预埋字段，保留扩展性说明，遵守"不预埋接口"
- **G0 三阶段措辞**（philosophy §1.2）：明确三阶段是"经验证的合理划分"而非"公理必然"

第四轮质量审查（安全 / 可观测 / 2026 生态）排雷落地——纯文档/架构层变更：

- **H1 信任边界**（philosophy §6.3）：装配区分信任等级——召回/工具结果是 untrusted data、保持来源标记，system prompt 只由高信任源构成，防间接注入/记忆投毒
- **H3 评估视角**（philosophy §13.x，远期）：事件流承载 run/session 两级轨迹可回放，结合自审查轮验证信号导出回归用例；复用已有组件，不引入独立评估引擎
- **H2 角色包安全审计**（role-pack-spec §七）：确立"安全审计是角色包发布前提"硬门槛（行业实证 36% 注入），当前声明、远期实现

第五轮排雷落地（梁文锋视角对抗审查 → 真实代码核实）——ADR-023 + 设计文档更新：

- **C1 摘要成本重构**（philosophy §12.2 / ADR-023）：修正"截断时现调 LLM"实现缺口——截断优先取用 round-summary、保留更多原始对话靠 prompt cache、摘要生成退出关键路径
- **C2 即时注入防御**（philosophy §6.3 / ADR-023）：工具结果 `<tool_result>` 隔离包裹 + 参数校验 + 返回净化，防间接注入
- **C3 loop 收敛方向**（ADR-023）：解耦 UI/可观测/外围策略，让最小闭环（调 LLM→路由→循环）渐进可见

SSOT 第三轮排雷：15 项契约/一致性缺陷清零，无公共 API 变更（内部修复）。

### Fixed（修复）

- **执行流单一收口**：`processEvent` / `executeChatLoop` / `resumeExecution` 统一走 `consumeExecutionStream`，清理放 finally；修复 async generator 被 `void` 调用导致函数体不执行（跨进程边界断裂）（T0-1）
- **门面等宽**：`Agent.pause` 透传 `lowRisk`，连续暂停计数不再误计；`requestPause` 空闲态立即翻转、流中延迟翻转两端对称（T0-2 / T1-1 / T2-8）
- **状态恢复强制归零**：`restoreFromCheckpoint` 统一 `resetToRunning()`，检查点与状态机不再分叉（T0-3）
- **checkpoint schema 版本化**：`CURRENT_SCHEMA_VERSION` 写入/比对（T1-4）
- **暂停超时信息事件化**：`sessionPauseTimedOut` 载荷携带 sessionId/date/session（T1-2）
- **任务项状态唯一写点**：`completeRound` 改走 `updatePlanItemStatus`，消灭旁路直改（T2-1）
- **暂停元数据时序修正**：`setPauseMeta` 首轮 checkpoint 兜底，注释纠正 onPaused 先于 pause()（T2-6）
- **配置建议重建复活**：`confirmConfigSuggestion` upsert 前 restore 同名软删记忆 + name 白名单堵路径穿越（T2-4）
- **暂停起点与心跳解耦**：新增 `checkpoint.pausedAt`，暂停后 touchCheckpoint 刷新不再推迟超时判定（T2-2）
- **孤儿向量清理**：`writePurge` / `writePurgeExpired` 同步清理 vectorStore，消除 30 天自动清理后的孤儿向量（T2-5）

### Removed（移除）

- 零注册的 `onBootstrapSyncFailed` 死回调（失败可观测性由 logger.warn 承担）（T2-3）
- `SessionStateMachine.onEvent` 空壳与失效注释（T2-7）

### Internal（内部变更，不影响公共 API）

- 测试用例总数 1949 → 1983（+34，80 个测试文件）

### Fixed（术语载体门禁「历史层续命」：旧词消失检测失效 + 旧词复活不可见）

- **根因**：CHANGELOG / ADR / 过程文档 / 台账按「历史不改写」纪律永久保留旧词，与代码共锁一份集合时旧词被历史层**续命**——①「旧词消失」对已正名词永不报警；②旧词**复活进代码**也不报警（集合没变）。与「脚本扫自身」是同一失效模式的第二个载体（`SELF_REL` 的教训推广到历史层）。
- **收敛（同模式，非新机制）**：分层基线——**code 层**（`src` / `hosts` / `scripts` = 现行契约）与 **text 层**（文档 / 台账 / 历史档）各锁一份集合（`BASELINE_CODE` / `BASELINE_TEXT`）。旧词从 code 消失 = 正名完成信号；旧词出现在 code = 回归报警（门禁的牙在此）。text 层为弱判据（历史续命仍在层内，文档层回归靠审查）——边界写进脚本「范围边界与已知盲区」。
- **本条更新两条旧表述**：①「Fixed（脚本扫自身）」条的「已知边界」——消失报警在 code 层内已是一级信号，且分层后该条「写出旧名即报新增」的自限不再适用于 text 层旧词；②同条 `MIN_FROZEN` 随锚点 §3 收口升为 6。
- **变异实测（双向）**：`PlanStep` / `perStep` / `step_id` 注入 code 层 → code 层报警「新增 3」、text 层纹丝不动（修复前此场景静默绿）；基线幽灵条目 → 报警「消失 1」；还原后 code 63 / text 75 双绿。

### Changed（冻结例外收口锚点 §3 单一真源 + 测试注释 bare「步」收尾）

- **冻结例外单一真源**：`step-end` / `data-step-bucket` / `animation-iteration-count` 补入术语锚点 §3（原先仅在本文件口头列为硬边界，门禁 frozen 解析不知情）；门禁 `MIN_FROZEN` 阈值 3 → 6。
- **测试注释收尾（58 处）**：测试文件注释与 it 标题中指任务表一行的「步骤 / 提问步 / 当前步 / 下一步」等正名为「任务项 / 项」；「工具步」（step 阵营 = 一次产工具调用的 LLM 调用）统一为「带工具调用的 step」。**边界不动**：样本数据字面量（`description: '步骤一'` 等，内容非载体）、断言引用的生产原文、通用词（同步 / 逐步 / 多步 / 按步推进）。

### Changed（收尾叙述句正名「执行 N 步工具」→「工具×N（分型）」+ 宿主测试注释收尾）

- **UI 文案（`hosts/memora-vscode` webview）**：收尾叙述句「执行 N 步工具（读取 x · 搜索 y）」把**一次工具调用**叫「步」——违术语锚点 §1「step 不是一次工具调用」+ 工具类文案「用批或纯计数」约定。改「工具×N（读取 x · 搜索 y · 写入 z）」：形状取纯计数，拼写并入既有 `工具×N`（U+00D7 语义乘号）形态，与同表达式 fallback 及 `iconLanguage` 判据同拼写，不造第二种乘号写法。测试断言联动 2 处。
- **宿主测试注释收尾（14 处）**：`chatView.test.ts` 任务表语义「步 / 步骤 / 步级」（按步归组 / ≥3 步 / 当前步骤 / 两步边界 / 工具步）→「任务项 / 项」或「工具叙述」；样本数据字面量与 step 阵营断言（「第 1 步」等）不动。
- **顺带**：webview 注释「active step」→「active 任务项」（同句 UI 文案本就是「执行任务项 N」）。
- **门禁首次实战（消失信号）**：「步级」随正名从 code 层消失 → 分层基线报警「消失·code 1」→ 回填后 code 62 / text 75 双绿——「正名完成信号」按设计工作，非误报。

### Added（tool 的 step 归属补齐：`tool_start.stepIndex` 与 thought 同构）

- **内核事实层**：`AgentChunk.tool_start` 与 `ProcessEvent.tool_start.payload` 增可选 `stepIndex`（与 `thought.stepIndex` 逐字同构，缺省 = 无归属）；`loop.executeToolCalls` 发射点单点打标（`handleToolCalls` → `executeToolCalls` 调用链逐级传号）。**单点纪律**：`tool_result` 刻意不盖章——经 `toolCallId` 归属 `tool_start`（防双写守卫测试在案）。
- **宿主**：`chatPanel` `tool_start` 透传落盘——重放可读「工具是第几步执行的」，tool×step 交叉事实（同号对齐 / 按 step 统计工具用量）自此有据可查。
- **测试**：内核 4 例（多 step 递增 / 同 step 并发同号 / 续跑续号 / 新轮起数）+ 防双写守卫 1 例 + 落盘断言 1 例；**变异捕红 2 场精确命中**（删打标 → 3 红零误伤；双写 tool_result → 恰 1 红 = 守卫）。
- **设计裁决留档**：`step_boundary` **维持不落盘的既定契约**（`types.ts`「触发点非历史内容」）——`stepIndex` 落地后 step 边界在重放中可由序号跳变直接读出，再落盘 = 同一事实两处记载（双轨镜像），「同族半补丁」判断作废。

## 历史试验版本（已在 npm 作废，请勿使用）

## [2.1.0] - 2026-08-08

不中断工作模式 v2.0 与网络搜索接口版本。

### Added（新增）

- **不中断工作模式 v2.0**：支持会话暂停/恢复/分叉，通过检查点机制实现断点续跑；四级补全机制（P1-explicit / P2-memory / P3-builtin / P4-clarify）确保不中断场景下的输入完整性
- **IWebSearchProvider 接口**：网络搜索能力抽象，宿主可注入自定义搜索引擎实现，内核提供默认降级策略
- **FetchWebSearchProvider**：基于 DuckDuckGo HTML 的零依赖默认搜索实现，内置超时保护与错误降级
- **web_search 工具**：条件性暴露，注入 IWebSearchProvider 时自动可用，未注入时 LLM 被告知搜索不可用

### Fixed（修复）

- **P0-1: MemoryRelation 孤儿边清理**：`memoryInspector.writeDelete()` / `writePurge()` 前置清理关系边，防止记忆删除后关系边残留
- **P0-2: 运行时暂停超时检测**：暂停状态启动定时器，30 秒检测一次心跳，超 30 分钟自动清理检查点并重置状态机
- **P1: Composer 停滞时忽略显式任务输入**：计划停滞路径前增加 `event.delta?.task === undefined` 判断，确保用户显式指定任务时优先走 P1 显式输入而非 P4 澄清
- **P1-1: refreshBootstrapMemories 改为必选参数**：修复 SSOT 违反——CRUD 操作后 system prompt 中的 bootstrap 段必须同步
- **P1-2: goalVersion 漂移强制暂停**：`updateGoal()` 检测到 drift 级别时自动暂停（低风险，不计入连续暂停计数）
- **P2-1: consecutivePauseCount 时间衰减**：用时间戳数组替代简单计数，1 小时衰减窗口，旧暂停自动过期
- **P2-2: ChatMessage 增加 name 字段**：`extractHotMemory()` 和 `restoreFromCheckpoint()` 透传 name 字段，LLM 上下文一致性增强

### Internal（内部变更，不影响公共 API）

- 版本号 v2.0.3 → v2.1.0
- 新增 `src/web-search/` 模块（fetchWebSearchProvider.ts / webSearchProvider.ts / 类型定义）
- `ToolExecutor` 扩展：支持 `IWebSearchProvider` 注入，条件性注册 `web_search` 工具
- `builtinTools.ts` 新增 `WEB_SEARCH_TOOL` 定义与幂等性映射
- 新增 16 个测试用例覆盖 web search 功能（工具结构完整性 / 执行逻辑 / provider 行为）
- SSOT 修复新增 17 个测试用例（Composer 边缘场景 + checkpoint 全路径 + FetchWebSearchProvider 降级场景）
- 测试文件总数 80 个，测试用例总数增至 1949 个

## [2.0.3] - 2026-08-01

npm 发布配置修复与质量加固版本。

### Added（新增）

- **`publishConfig.access = "public"`**：修复 scoped package 发布阻塞（@zooique/memora 是私有作用域，npm 默认拒绝发布）
- **`keywords` 扩充至 18 个**：新增 memora / agent-memory / local-ai / embedding / vector-search / rag / zero-dependency / semantic-search / knowledge-base 及中文关键词，提升 npm 搜索曝光
- **`exports` 增加 `default` 回退条件**：增强混合解析场景的兼容性

### Internal（内部变更，不影响公共 API）

- 版本号 v2.0.2 → v2.0.3

## [2.0.2] - 2026-07-27

设定模块（Persona/Skill/Rule）全链路审查与修复版本。核心收敛：角色/技能从 SQLite 记忆索引解耦、"万物皆记忆"升级为 v2 双轨模型、技能从延迟注入改为当轮实时生效。

### Changed（变更）

- **万物皆记忆 v2**：Persona 和 Skill 从 SQLite 索引解耦，改为纯文件 + 内存缓存（设定记忆不参与 recall 管线）
- **Skill 当轮实时生效**：`matchAndInjectSkill()` 在 `chat()` 内 recall 后执行，匹配即注入，不再延迟到下一轮
- **Persona 默认回退泛化**：`shouldFallbackToDefault()` 从硬编码 `'default'` 改为 `list[0]?.name`
- **bootstrap 收敛**：`bootstrapMemories` 从 `rule + skill + persona` 收敛为仅 `rule`
- **PersonaManager / SkillManager 去 SQLite 依赖**：移除 `IMemoryStorage` 构造参数，移除 `writeAllToIndex()` 调用
- **自动匹配时机统一**：Persona 和 Skill 均在 `chat()` 开头执行匹配，LLM 当轮即用新设定

### Fixed（修复）

- **P0: Manual 模式角色回退**：`shouldFallbackToDefault()` 新增 mode 检查，manual 模式下不再自动回退
- **P1: 消息角色标签不一致**：`chatStreamHandler` 的 `SPRITE_STREAM_START` 延迟到首个 chunk 后发送，确保 persona 已匹配
- **Persona 切换参数同步**：锁定时长从 60s/3次/5分钟 更正为 30s/5次/2分钟（日志 + JSDoc + 测试）
- **关键词匹配同分 tie-break**：Persona/Skill 匹配同分时增加 name 字母序二级排序

### Internal（内部变更，不影响公共 API）

- `PersonaManager.autoMatch()` 去 async（函数体无 await）
- `configIndexWriter.ts` 移除（共享工具不再有消费者）
- `skillManager.ts` 移除 `writeAllToIndex()` / `writeSkillToIndex()` 方法
- `activeSkill` 字段移除（匹配改为当轮注入，无需跨轮状态）
- `injectActiveSkill()` 方法移除（被 `matchAndInjectSkill()` 替代）
- `personaManager.ts` / `skillManager.ts` 移除 `IMemoryStorage` 类型导入
- 架构文档 `architecture_philosophy_rules.md` v0.8→v1.0（万物皆记忆 v2）
- 分层文档 `backend_layers_rules.md` v1.1→v1.2（persona/skill 去 memory 依赖）

从 1.0.1 到 2.0.0 的架构收敛版本。核心目标：读写统一、记忆治理 L1~L4 全链路、god function 拆分、可观测性补全。

### Breaking Changes

> **升级指南**：以下变更需要消费者修改代码。

#### 1. MemoryMutator 移除，读写统一入口

`MemoryMutator` 类（1.0.0 引入的读写分离）已合并回 `MemoryInspector`。写方法以 `writeXxx` 前缀命名，与读方法统一在 `agent.memory` 上。

| 1.0.1 调用方式 | 2.0.0 迁移路径 |
|---|---|
| `agent.memoryMutator.upsert(memory)` | `agent.memory.writeUpsert(memory)` |
| `agent.memoryMutator.delete(id)` | `agent.memory.writeDelete(id)` |
| `agent.memoryMutator.restore(id)` | `agent.memory.writeRestore(id)` |
| `agent.memoryMutator.purge(id)` | `agent.memory.writePurge(id)` |
| `agent.memoryMutator.purgeExpired(before)` | `agent.memory.writePurgeExpired(before)` |
| `agent.memoryMutator.addRelation(rel)` | `agent.memory.writeAddRelation(rel)` |
| `agent.memoryMutator.removeRelation(...)` | `agent.memory.writeRemoveRelation(...)` |
| `import type { MemoryMutator }` | 移除，不再导出 |

**保留在 `agent.memory` 的只读方法**：`snapshot()` / `search()` / `searchHybrid()` / `stats()` / `getById()` / `list()` / `listDeleted()` / 关系查询方法等（不变）。

### Added（新增功能）

- **LLM 记忆治理 L1~L4**：
  - L1 语义去重：`agent.deduplicateMemories()` — 扫描名称相似记忆对，LLM 判断语义等价，降级重复记忆
  - L2 时效性评估：`agent.evaluateTimeliness()` — 扫描低分记忆，LLM 判断是否过时，降级过时记忆
  - L3 冲突检测：`agent.detectConflicts()` — 同 source 内配对，LLM 判断语义冲突，仅检测不修复
  - L0 手动衰减：`agent.runMemoryDecayOnce()` — 触发一次 score 衰减
  - 新增类型：`DedupPair` / `DedupVerdict` / `DedupReport`、`TimelinessVerdict` / `TimelinessReport`、`ConflictVerdict` / `ConflictReport`
- **TextPolishManager**：LLM 文本润色（语法修正 + 表达优化），独立于 Agent 生命周期，通过 `TextPolishManager` 类使用
- **EvalRunner 公开**：评估框架从 `@internal` 提升为公开 API，新增 `EVAL_SCENARIOS` / `EvalRunner` / `EvalRunnerOptions` / `EvalSummary` 导出
- **segmentLower**：分词工具扩展，返回小写分词结果（宿主 SqliteStorage 依赖）
- **isPlainObject**：纯对象类型守卫（宿主 spriteConfig 依赖，校验 JSON.parse 结果）
- **ChatLockManager**：对话锁管理器（从 AgentLoop 拆分），基于 token 的并发安全机制
- **ArchiveCoordinator**：归档协调器（从 postProcessInner 拆分），统一管理会话归档 + 洞察提取 + 角色匹配
- **MemoryDecayScheduler**：记忆衰减调度器（从 agent.ts 拆分），定时衰减 + L2 时效性评估 + 指标统计
- **MemoryAdvisor**：记忆顾问（从 MemoryInspector 拆分），sourceHealth 诊断 + suggest 关联推荐 + L3 冲突检测
- `TypedEventEmitter` 新增 `emitAsync` 方法（支持异步事件处理器的 await 等待）

### Changed（改进）

- **processUserInput 拆分**：从 550+ 行 god function 拆分为 4 个职责清晰的子方法（`handleRecallAndInputGuard` / `handleIteration` / `handleToolCalls` / `handleTextResponse`），每个方法独立可测
- **nullifyAllComponents 统一**：Agent.close() 中 13 个组件字段置空集中到 `nullifyAllComponents()` 私有方法，消除遗漏风险
- **requireNonNull 消除**：全量替换为局部变量提取 + non-null assertion `!`，减少代码噪音
- **personaManager LLM 调用迁移**：角色匹配的 LLM 调用从 persona 层迁移到 agent 层（架构分层合规）
- **toError 行为对齐**：跨模块统一错误处理，`toError(nonError)` 不再抛出 TypeError
- **formatDateKey 提取**：消除 3 处重复的日期格式化逻辑
- **抽象剪枝 3 轮**：DRY 收敛——消除重复的工具函数、常量定义、类型推导
- **types.ts 依赖图注释**：index.ts 新增完整的类型依赖图，降低新开发者学习成本
- 提示词优化 + 并发工具调用 + 可观测性补全（Tracer Span 覆盖衰减/归档/冲突检测）

### Fixed（修复）

- 神木回天 6 项修复：日志改进、硬约束测试补全、错误处理路径修复
- 感知层模式陈旧 bug：`welcomeBack` 文案 + 冷启动 blend 逻辑修复
- P3 静默 catch 修复：不再吞掉关键错误
- 归档失败事件 `archiveFailed` 可观测性补全（11 处测试覆盖）

### Internal（内部变更）

- `memoryMutator.ts` 文件删除，写方法合并到 `memoryInspector.ts`（`writeXxx` 前缀）
- `archiveCoordinator.ts` 独立模块（从 `agent.ts` 提取）
- `chatLockManager.ts` 独立模块（从 `loop.ts` 提取）
- `memoryDecayScheduler.ts` 独立模块（从 `agent.ts` 提取）
- `memoryAdvisor.ts` 独立模块（从 `memoryInspector.ts` 提取）
- `textPolishManager.ts` 新增模块（纯 LLM 调用，无存储依赖）
- 测试补强：L2 时效性评估测试、衰减边界测试、各 Manager 测试大幅扩展（+500+ 测试用例）

## [1.0.2] - 2026-07-11

### Changed

- `EmbeddingOptions` 接口归属位置从 `llm/embedding.ts` 调整到 `memory/vectorStore.ts`（符合依赖倒置原则：消费者定义接口，提供者通过 `import type` 引入）
- 顶层导出不变（`index.ts` 已同步更新导出路径），外部消费者无需修改导入语句

## [1.0.1] - 2026-07-08

### Fixed（P2 遗留项修复）

- coverage 阈值从 75/85/70/75 提升至 80/88/75/80
- pathGuard 黑名单新增 `.envrc` 拦截规则（direnv 配置文件）
- decisions/README.md ADR 索引补全 ADR-005 保留行
- kernel-ci.yml 测试数量注释更新

## [1.0.0] - 2026-07-08

从 0.3.0 到 1.0.0 的完整架构收敛版本。核心目标：接口稳定化、职责分离、韧性补齐、公共 API 收敛。

### Breaking Changes

> **升级指南**：以下变更需要消费者修改代码。所有 Breaking Changes 均有 1:1 迁移路径。

#### 1. 记忆读写分离：`agent.memory` → `agent.memoryMutator`

`MemoryInspector` 中的写操作方法已迁移到新类 `MemoryMutator`，实现读写职责严格分离（ADR-010 补充）。

| 0.3 写方法（`agent.memory.xxx`） | 1.0 迁移路径（`agent.memoryMutator.xxx`） |
|---|---|
| `agent.memory.upsert(memory)` | `agent.memoryMutator.upsert(memory)` |
| `agent.memory.delete(id)` | `agent.memoryMutator.delete(id)` |
| `agent.memory.restore(id)` | `agent.memoryMutator.restore(id)` |
| `agent.memory.purge(id)` | `agent.memoryMutator.purge(id)` |
| `agent.memory.purgeExpired(before)` | `agent.memoryMutator.purgeExpired(before)` |
| `agent.memory.addRelation(rel)` | `agent.memoryMutator.addRelation(rel)` |
| `agent.memory.removeRelation(...)` | `agent.memoryMutator.removeRelation(...)` |

**保留在 `agent.memory` 的只读方法**：`snapshot()` / `search()` / `searchHybrid()` / `stats()` / `getById()` / `list()` / `listDeleted()` / `getDeletedById()` / 关系查询方法等。

#### 2. `VectorStore` 重命名为 `JsonVectorStore`

向量存储从具体类重构为接口 + 实现（ADR-016）。

| 0.3 导出 | 1.0 迁移路径 |
|---|---|
| `import { VectorStore } from '@zooique/memora'` | `import { JsonVectorStore } from '@zooique/memora'` |
| `new VectorStore(path, embeddingProvider)` | `new JsonVectorStore(path, embeddingProvider)` |

新增 `IVectorStore` 接口，宿主可实现自定义向量存储（如 SqliteVectorStore / LanceDBVectorStore）。

#### 3. `ChatOptions.channel` 字段移除

`ChatOptions.channel?: 'chat' | 'background'` 字段从未被任何 LLM 调用路径读取，已移除。多 Provider 路由通过 `AgentOptions.backgroundProvider` 注入独立 LlmProvider 实例实现，不通过 `ChatOptions` 字段路由。

#### 4. `AgentChunk` 流式事件结构变化

多个 chunk 类型的字段结构发生变化，宿主需更新 chunk 处理逻辑：

| chunk 类型 | 0.3 结构 | 1.0 结构 |
|---|---|---|
| `recall` | `{ type: 'recall'; count: number }` | `{ type: 'recall'; memories: RecalledMemorySummary[] }`（携带记忆摘要列表，非计数） |
| `text` | `{ type: 'text'; content: string }` | `{ type: 'text'; content: string; guardrailBlocked?: boolean }`（新增护栏阻断标志） |
| `tool_start` | `{ type: 'tool_start'; name: string; args?: string }` | `{ type: 'tool_start'; toolCallId: string; name: string; args?: string }`（新增 toolCallId） |
| `tool_result` | `{ type: 'tool_result'; name: string; ok: boolean; summary?: string }` | `{ type: 'tool_result'; toolCallId: string; name: string; ok: boolean; summary?: string }`（新增 toolCallId） |
| `error` | 不存在 | `{ type: 'error'; message: string }`（新增，流式错误替代裸 throw） |
| `retry` | 不存在 | `{ type: 'retry'; attempt; maxRetries; delayMs; error }`（新增，指数退避重试信号） |

新增 `RecalledMemorySummary` 类型（`{ id, name, score, source }`），仅暴露 UI 展示所需字段，不含 `content`。

#### 5. `Memory` 类型新增 `deletedAt` 字段（7→8 字段）

`Memory` 接口新增可选字段 `deletedAt?: string`（ISO 8601），支持软删除/回收站机制（ADR-004 GAP-6 扩展）。所有查询方法自动过滤 `deletedAt != undefined` 的记忆。

#### 6. `IMemoryStorage` 接口扩展（7→15 方法）

新增 8 个方法，宿主实现的 `IMemoryStorage` 需补全：

| 新增方法 | 用途 |
|---|---|
| `restore(id)` | 恢复软删除记忆 |
| `purge(id)` | 物理删除（不可恢复） |
| `listDeleted(limit?)` | 列出回收站 |
| `getDeletedById(id)` | 按 ID 获取软删除记忆 |
| `purgeExpired(before)` | 清理过期回收站 |
| `decayScores(sources, now)` | 批量衰减 score |
| `getAllSources()` | 获取 source→count 映射 |

（`close?()` 已在 0.3 存在）

#### 7. `AgentOptions` 字段变化

| 变化 | 0.3 | 1.0 | 迁移路径 |
|---|---|---|---|
| `logger` 字段移除 | `AgentOptions.logger?: ILogger` | 移除 | 改用全局 `setLogger(customLogger)` 注入 |
| `archiveMode` 新增 | 不存在 | `archiveMode?: ArchiveMode`（默认 `'full'`） | 可选，不传则默认 `'full'` 全自动归档 |
| `enableContextSummary` 默认值 | `false` | `true` | 如需关闭显式传 `false` |

#### 8. 事件载荷变化

三个事件的载荷结构变化，宿主事件处理器需更新：

| 事件 | 0.3 载荷 | 1.0 载荷 |
|---|---|---|
| `conflictDetected` | `{ memoryId, conflictingId, relationType }` | `{ newMemoryId, newInsight, targetId, targetContent }` |
| `projectSwitched` | `{ from, to }` | `{ from: string \| null, to: string, projectName: string }` |
| `skillMatched` | `{ skillName, keywords }` | `{ skill: string, score: number }` |

#### 9. 会话/项目方法迁移到专职 Manager

以下方法从 Agent 面类迁移到专职 Manager（P1-4 拆分）：

| 0.3 调用方式 | 1.0 迁移路径 |
|---|---|
| `agent.switchSession(name)` | `agent.sessionManager.switchSession(name)` |
| `agent.loadSessionMessages(date, session)` | `agent.sessionManager.loadSessionMessages(date, session)` |
| `agent.restoreMostRecentSession(...)` | `agent.sessionManager.restoreMostRecentSession(...)` |
| `agent.restoreSession(date, session)` | `agent.sessionManager.restoreSession(date, session)` |
| `agent.listProjects()` | `agent.projects.listProjects()` |

**保留在 Agent 面类**：`switchProject()` / `rebuildComponents()` / `forkSession()`（常用入口）。

#### 10. `ToolExecutor` 移除 `getToolDefinitions()`

`agent.tools.getToolDefinitions()` 已移除，改用 `agent.tools.list`（getter）。

| 0.3 调用 | 1.0 迁移路径 |
|---|---|
| `agent.tools.getToolDefinitions()` | `agent.tools.list` |

#### 11. Agent 移除 `inspect()` / `getBuildCtx()`

`agent.inspect()` 和 `agent.getBuildCtx()` 已移除。宿主可通过事件系统、ITracer、`agent.memory.snapshot()` 观察内核状态。

### Added（新增功能）

- **`MemoryMutator`**：记忆写入器，与 `MemoryInspector` 严格分工（读写分离）
- **`RelationBuilder`**：关系构建器，从 `InsightExtractor` 提取（P1-3），支持冲突检测回调
- **`ProjectRegistry`** + **`LockManager`**：从 `ProjectManager` 拆分（P1-4），宿主可直接使用
- **`IVectorStore`** 接口：向量存储抽象，宿主可注入自定义实现（ADR-016）
- **`EmbeddingOptions`**：embedding 调用选项（`signal?: AbortSignal` + `timeoutMs?: number`），`EmbeddingProvider.embed/batchEmbed` 和 `IVectorStore` 方法支持外部取消 + 超时中断（P1-8）
- **`ConflictInfo`** 类型：关系冲突信息，`RelationBuilder.bindOnConflict()` 回调参数
- **`RecalledMemorySummary`** 类型：recall chunk 载荷，仅暴露 UI 展示所需字段（id/name/score/source），不含 content
- **`archiveMode`** 选项：ADR-015 三态归档控制（`full` / `insights-only` / `manual`），默认 `full`
- **AgentChunk 新增 `error` / `retry` 类型**：流式错误事件替代裸 throw，指数退避重试信号让宿主感知重试
- **`mergeSignals`** 工具：AbortSignal 合并工具，将多个 signal 合并为一个（用于工具执行超时 + 用户取消合并）
- **`guardrail.ts`** 独立模块：内容护栏纯函数 `runGuardrails()`，从 `AgentLoop` 提取（P1-1）
- **`sourceValidation.ts`**：source 校验工具从 `types.ts` 拆分（P1-2）
- **AgentChunk `guardrailBlocked`** 标志位：结构化护栏信号，替代中文字符串匹配（P0-7）
- **`SessionArchiver`**：会话内容归档器，支持 content 类记忆归档
- **`MemoryAdvisor`**：记忆建议器，提供 suggest / sourceHealth 查询
- **`MemoryDecayScheduler`**：记忆衰减调度器，init 首次 + 每小时定时衰减
- **ADR-016**：向量存储接口化决策记录
- **ADR-015**：archiveMode 三态归档控制决策记录
- **ADR-002/004/014 补充**：Logger 懒初始化、content 多用途、关系查询归属 + RelationBuilder 拆分

### Changed（改进）

- **zod schema 单一真理源**：`DEFAULT_CONFIG` 常量移除，配置默认值由 zod schema `.default()` 声明（P0-1）
- **Logger 懒初始化**：`maybeUpgradeToPino()` 延迟触发，import 零 fs 副作用（P0-6）
- **EmbeddingProvider 默认超时**：60 秒默认请求超时（可通过 `timeoutMs` 覆盖）
- **`ProjectManager` 瘦身**：从 640 行缩减到 410 行，注册表/锁文件操作委托给 `ProjectRegistry`/`LockManager`
- **`InsightExtractor` 瘦身**：关系构建逻辑委托给 `RelationBuilder`
- **测试目录镜像**：`managers/__tests__/` 严格镜像 `src/` 目录结构（ADR-007）

### Fixed（修复）

- **zod schema 与 DEFAULT_CONFIG 不一致**：配置默认值单一真理源
- **eval 护栏检测依赖中文魔法字符串**：改用 `guardrailBlocked` 结构化标志位
- **Logger import 触发 fs 副作用**：懒初始化，import 零 IO
- **Embedding 请求无超时/取消保护**：支持 AbortSignal + timeoutMs
- **`insightExtractor.ts` inline `import()` 类型**：改为顶层 type import

### Internal（内部变更，不影响公共 API）

- `types.ts` 拆分为 `types.ts` + `sourceValidation.ts` + `segmenter.ts`（STOPWORDS 迁移）
- `MemoryInspector` 移除写方法，保留只读编排职责
- `safeTimer` 的 `clearAllSafeTimers`/`getActiveTimerCount` 已不在公共导出（早期迭代已收敛）
- 11 个 manager 测试文件迁移到 `managers/__tests__/`

## [0.3.0] - 2026-06-27

Phase 5.1/5.2 初始 npm 发布版本。
