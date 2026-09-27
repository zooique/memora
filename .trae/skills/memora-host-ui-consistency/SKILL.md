---
name: memora-host-ui-consistency
description: 在 memora 双包架构（内核 @zooique/memora + VS Code 宿主 hosts/memora-vscode）中改「宿主 UI 的可见性/呈现」时使用——例如技能启停徽章、下拉项禁用标记、状态后缀、任何「某对象当前处于受限状态」的 UI 呈现，以及**内联呈现**（decoration 高亮 / 行内幽灵文本 / CodeLens 行内按钮 / 文件内 diff 标记）；也用于「改了配置但界面/行为不生效」类问题、以及「抽出一个常量却引发一批无关套件整片加载失败」类问题。覆盖七条硬规则：改可见集必须枚举全部消费通道（含**生效时机**这个时间维度）、判定必须与内核真源同源且拦截逻辑只能落 host、webview 测试骨架须比对生产 HTML 结构否则该路径零覆盖、新增断言必须做变异验证（含「一次变异命中多条 = 覆盖充分而非过粗」的判据）、零测试覆盖区（extension.ts）用编译产物实读兜底、内联呈现五条硬约束（设了装饰≠看得见：须 revealRange / 字面色 / 不静默吞异常 / **装饰按编辑器补齐——切走再切回不会自动恢复，而 CodeLens 走 provider 模式会，故症状是「高亮没、按钮在」**；**坐标系错位——内核直写盘不经编辑器，须 revert 重载后再渲染**；**并发写同文件的渲染竞态——须 renderSeq 只让最新一次落地**；`CodeLens.command` 单命令 ⇒ 多按钮 = 同 range 多 CodeLens；空行 range 会抛错须 safeLineRange；**模块顶层禁求值 vscode 运行时枚举**，否则最小 mock 环境 import 即崩一批套件）、**跨语言真源（TS 常量 ↔ `package.json` 声明面）必须写守卫对拍**（JSON 无法 import TS ⇒ 只能靠守卫，且守卫内不得复制 id 字面量）。当用户提到「UI 看不出效果」「禁用/受限状态没提示」「改了设置没反应」「静默失败」「看不出改了哪里」「没有确认/回退按钮」时加载。
agent_created: true
---

# memora 宿主 UI 一致性规范（可见集 × 真源判定 × 生效时机 × 测试覆盖）

> 起因（2026-09-22 实锤）：给技能加「启停（S4）」时，**同一份技能清单有多个消费通道**
> （注入面 / 工具面 / 设置页 / 对话区），改动只落到其中一个，其余通道静默失效。
> 更糟的是**同一模式在一天内犯了四次**：①漏 `list_skills` 工具侧（禁用形同虚设）；
> ②漏对话区下拉（按名选中后静默落空）；③补 ② 时只修 `disabled` 漏了 `health`；
> ④「配置变更后重推」这条**生效时机**通道整体缺失（用户改 `memora.disabledSkills` 后
> 内核与两条 UI 全停在旧值，须手动跑命令）。
>
> **①②③ 是「空间维度」漏面，④ 是「时间维度」漏面**：前者漏「哪个界面没标」，后者漏
> 「什么时候该重算」。两个维度都要过检查表，本文把它们都固化成规则。

## 规则 1 —— 改「可见集」必须枚举**全部**消费通道，逐个确认

「某对象对谁能见 / 何时生效」在本仓至少有五个通道（**四个空间面 + 一个时间面**），
改任何一个都要过一遍这张表：

| 维度 | 通道 | 典型位置 | 检查问句 |
|---|---|---|---|
| 空间 | **注入面** | assembler 拼进 system prompt 的清单（如 `SkillManager.buildSkillList`） | 该清单是否消费了新的过滤判据？ |
| 空间 | **工具面** | `list_skills` / 检索类工具的返回（如 `assembler.ts` 里 `toolExec.listSkills`） | 工具侧与注入面**同集合**吗？ |
| 空间 | **设置页** | `settingsView.ts`（详情面板、徽章、开关） | 有可见标记吗？条目被隐藏还是保留？ |
| 空间 | **对话区** | `chatView.ts`（下拉、chip、composer 旁挂载态） | 与设置页**同源**吗？ |
| **时间** | **生效时机** | 配置变更监听（`onDidChangeConfiguration`）／手动重载命令 | 改了之后**由谁**触发重算？**所有空间面**都重推了吗？ |

**实证教训**：S4 落地时只改了注入面 → 工具面仍能激活已禁用技能（**禁用形同虚设**）；
补工具面后，对话区下拉仍未带标记 → 用户主动选中已禁用技能后**静默落空**（技能不注入、
界面零提示）。第三次：给对话区补标记时只修了 `disabled`、**漏了 `health`**。
第四次（SKILL-S3b）：四个空间面都标对了，但**没有任何东西在配置变更后重算**——
`memora.disabledSkills` **只在 Agent 装配期读一次**、全仓零 `onDidChangeConfiguration`
⇒ 用户改设置**不生效**、须手动跑重载命令，且当时连重推入口都不存在。

**时间面检查清单**（缺一条即静默失效）：

1. **配置读取单点**了吗？（抽 `readDisabledSkills()`——别在装配期/变更监听/手动重载
   三处各内联一次 `getConfiguration`，键名与默认值会有三份）
2. 变更监听注册在**恒存活**的位置了吗？（必须 `activate()`；寄在 provider 的
   `resolveWebviewView` 里则「面板从未打开」= **零监听**，缺陷原样保留）
3. 未就绪（agent 未装配）时**安全跳过**了吗？（别用会触发**懒装配**的
   `getAgentForCommand`——不该为「改一次设置」付整个 Agent 装配成本）
4. 每个空间面通道都**重推**了吗？（对话区下拉 + 设置页卡片，两条都要；
   设置页那条复用其既有加载方法以保住 health 等附加标注，别另写轻量版）

**收口做法**：让所有通道消费**同一个单点**，而不是各自写 filter。例：
`SkillManager.listAvailable()` 作 LLM 可见集唯一真理源，`buildSkillList()` 与
`list_skills` 工具侧**双双改调它**；配置同步同理收口到 `readDisabledSkills()`（唯一读点）
+ `syncDisabledSkills()`（唯一「配置 → 内核 → 双通道 UI」实现，**配置变更监听与手动重载
命令共用**，防两处各写一份）。

**别急着调重载**：判断「改配置后 L1 清单何时重建」有实证路径——本例禁用集是**读期过滤**
（`listAvailable()` 与 `get()` 读同一集合），loop 前缀由 `SeedPrepare.run` **每轮重建**
（`prepare.ts:52-58` 注释「每次回答前清临时 system 消息」），且 `buildSkillList()`
**无缓存**直读 `listAvailable` ⇒ **下一次回答即对模型生效，无需 `reloadConfig`**
（技能文件未变时重扫磁盘无意义，还会引入「忙碌态需排队」的额外语义）。**先读代码确认
生效路径，再决定要不要重载** —— 别凭「大概是装配期算的」下结论。

## 规则 2 —— 判定与内核真源同源；**拦截逻辑只能落 host**

- **判据同源**：宿主不要自读一份配置副本（如 `vscode.workspace.getConfiguration`）
  去判断「某对象是否受限」。内核已经持有**实际生效**的判据集（例：
  `SkillManager.disabledSkillNames` 是 `get()` 短路的同一集合），宿主读它才不会分叉
  （`reloadConfig` 重设后副本会过期）。
- **同名冲突时判据必须与解析器**同序**：若解析是「角色包 → 全局池」，那么
  「是否受限」的判定也必须先查角色包。漏了这一步会**假报**
  （实际注入成功却报「已禁用」）。
  实证：`skillAggregation.isSkillDisabled()` 与 `resolveSkill()` 同序（角色包先）。
- **拦截只能放 host**：webview 侧的 `disabled` 标记**可能过期**——`skills_loaded` 只在
  角色切换 / replaySession / 装配后重推；**配置变更后重推需显式接监听**
  （2026-09-22 SKILL-S3b 已接：`extension.ts` 的 `onDidChangeConfiguration` →
  `syncDisabledSkills` → 两条通道各自的 `refreshSkillList()`）。即便接了监听，
  webview 侧仍是「可能过期」的弱防护 ⇒ **在 webview 里拒绝选择 = 假拒绝**
  （配置已允许、UI 却拒绝）。
  ⇒ 正确分层：**webview 只做显示**（弱化 + 后缀徽记），**host 做判定与响亮失败**。
  ⚠️ 分层不要反过来：标记过期只让「预防」通道变弱；「诊断」通道（host 的 notice）
  判据是真源、**永不过期**。

```ts
// host 侧（chatPanel.handleSend）：注入确实落空 + 命中真源禁用 → 响亮失败，但不拦截发送
if (!skillBlock && isSkillDisabled(this._agent, skillName)) {
  this.post({ type: 'notice', level: 'error', message: `技能「${skillName}」已禁用，本次未注入…` });
}
```

三个边界（勿越）：① 照常发送（拒绝发送 = 改语义，需单独拍板）；② `!skillBlock` 前置
（只在**确实落空**时报，防假报）；③ notice 只进 UI **不喂模型**（否则破坏「对 LLM 静默」语义）。

## 规则 3 —— 写 webview 测试前，先比对**生产 HTML 结构**（否则该路径零覆盖）

`chatView.test.ts` 的 `HTML` 骨架是**手写桩**，容易缺节点。缺失的后果是
**该段逻辑静默不执行、测试全绿但零覆盖**。

实证：骨架里只有 `model-picker`（且**漏了 `treedd` 类**），**没有 `skill-picker`**
⇒ 技能下拉的所有行为此前**从未被测过**。

**动作**：改 webview 逻辑前，先 `grep` 该节点在**生产代码**里的生成点，照真实结构补骨架：

```ts
// 生产：chatPanel.ts 引 buildDropdownHtml([], { extraClass: 'skill-picker treedd--capsule', … })
// 其产物结构（components/dropdown.ts:62-66）必须是：
<div class="treedd skill-picker treedd--capsule" data-treedd data-on-select="__skillPickerOnSelect">
  <button class="treedd__trigger" …></button>
  <div class="treedd__menu" role="menu"></div>
</div>
```

- `.treedd` 类**必须有**（`initDropdowns` 用 `querySelectorAll('.treedd')` 遍历，
  只写 `treedd--capsule` 修饰符不会命中 → 事件全不绑定）。
- 事件模拟：菜单选择走 `menu.addEventListener('click', …)` 委托 ⇒ `item.click()` 即可。

## 规则 4 —— 新增断言必须做**变异验证**（三态判定）

| 变异结果 | 含义 |
|---|---|
| 全绿 | **假护栏**——断言没锁住任何东西 |
| 全红 | 变异过粗，无法定位 |
| **恰好命中目标用例，其余绿** | ✅ 合格 |

做法：临时改坏被测代码 → 跑该文件 → 记录红/绿分布 → **恢复后字节级复核**
（`grep` 变异占位串，确认 0 残留 + 改回内容在位）。

实证（SKILL-S2 三场）：①移除 host 响亮分支 → 1 红/3 绿；②`map` 回退丢弃 `disabled`
→ 2 红/1 绿；③移除角色包同序判定 → 仅「判据同源守卫」红。

**「恰好命中」≠「只红一条」**：同一判据被多个用例以不同**输入形态**覆盖时（例：LCS 的
「旧行记录」被「单行替换 / 纯删除 / 首行 / 末行 / 多处 / 裁剪后回精确」六种形态各测一次），
一次变异会**同时命中多条** —— 这是覆盖充分的表现，**不是**「变异过粗」。
判定依据是「红的那几条是否**都指向被改坏的那个判据**」，而非红的条数：若红到无关用例上才是过粗。
实证（DIFF-1，2026-09-26）：注释掉 `cur.removed.push(...)` → 6 红 / 13 绿，6 条全指向该判据。

**反向守卫是必须的**：只测「禁用时报错」不够，还要测「启用时不报错」「不存在时不报错」
「未带参数时不报错」——否则实现退化成「无条件报错」也能全绿。

**变异必须红在「断言」上，不能红在「等待 / 前置条件」上**（守卫可达性）：若断言藏在
`vi.waitFor(某形态出现)` 之后、而等待条件只认**一种**形态，把代码变异成**另一种**形态时，
测试会红在 `waitFor` **超时**上——**断言根本没跑到**。红/绿分布看着正常（一条红、其余绿），
实则是**假验证**：那条断言到底有没有效，完全未知（等价于被等待条件挡住了）。
修法：等待条件只等「**任一**形态出现过」、不绑定具体形态，让并排的**形态断言**自己去区分；
这样一个变异才打得到正确的那一条断言。
实证（DIFF-1 第十二轮，2026-09-27）：对照视图守卫最初写「等虚拟文档已打开」⇒ 变异回
`vscode.diff` 时红在 `waitFor`、不在守卫；改成「等对照以**任一形态**出现」+ 形态断言并列后精确命中。

## 规则 5 —— 零测试覆盖区（`extension.ts`）用**编译产物实读**兜底，并如实标注

`hosts/memora-vscode/src/extension/extension.ts` 是**零测试覆盖区**：宿主没有 vscode mock
基建、`vitest.config.ts` 的 `environment` 是 `node` ⇒ `activate()` 内的逻辑（命令注册、
配置监听、装配时序、`syncDisabledSkills` 这类模块级函数）**测不到**。

改它时的兜底链（缺一不可）：

1. `tsc --noEmit -p ./` + `eslint . --max-warnings 0`（类型与风格）；
2. 重建 dist（`rm dist → tsc -p ./ → node esbuild.config.mjs`）后**实读产物**，确认逻辑
   真的进了 bundle（没被 tree-shake、没拼错标识符），且回调原文与预期一致；
3. 在新增测试的注释里**显式声明该段覆盖不到**，不把测试当闭环证明。

### ⚠️ 产物 grep 坑：esbuild `charset=ascii` 把中文转 `\uXXXX`

`dist/extension/extension.js` 里**字符串内的中文已被转义**（双引号串与模板串都会）⇒
直接搜中文字面量**必然 MISS（假阴性）**，极易误判成「代码没进 bundle」。

```bash
# ✗ 假阴性：
grep -c "技能启停配置同步失败" dist/extension/extension.js    # → 0（其实代码在）

# ✓ 搜 ASCII 标识符（函数名 / API 名）：
grep -c "onDidChangeConfiguration\|affectsConfiguration\|syncDisabledSkills" dist/extension/extension.js
# ✓ 或按转义序搜：技能 = \u6280\u80FD
```

实证（SKILL-S3b）：先按中文搜得 `MISS ×0`，一度疑为「代码没打包」，实为 grep 方式错；
改搜 `affectsConfiguration` 后 ×1 命中，并实读到完整回调原文（含 `agentPromise` guard
+ `syncDisabledSkills` 调用 + `.catch` 出口）。

## 规则 6 —— 宿主**内联呈现**（decoration / CodeLens）的五条硬约束（①表现 ②API 契约 ③文案粒度 ④副作用自查 ⑤顶层求值）

> 起因（2026-09-26 真机两连击）：DIFF-1（文件改动内联 diff）首次落地后用户反馈
> 「文件打开了，但**看不出改了哪里**，也没有确认/回退按钮」。当时逻辑层 13 项单测全绿
> ——**渲染层一行没验**。下列约束逐条固化。

### ① 设了装饰 ≠ 用户看得见（六个真实断点，缺一即「看不出效果 / 看错位置」）

| 断点 | 症状 | 修法 |
|---|---|---|
| **未移动视口** | 文件停在顶部，改动行不在视野内 | `editor.revealRange(range, TextEditorRevealType.InCenter)` |
| **用主题色** | 部分主题下装饰几乎透明 | 用**字面高对比色**（`rgba(...)`），别依赖 `diffEditor.*` 主题色 |
| **静默吞异常** | 真机失败零诊断线索 | 装饰 / 打开 / 恢复全部经 `deps.log`（接输出通道）留痕；**禁 `try/catch{}` 空捕获** |
| **切走再切回**（2026-09-26 真机） | 「高亮全没、**只剩按钮**」 | 装饰是 **per-editor** 的、绑在编辑器实例上，VS Code **不会**在编辑器重新可见时替你恢复；CodeLens 走 **provider 模式**（VS Code 主动回调 `provideCodeLenses`）**自己活** ⇒ 症状恰好是「装饰丢、按钮留」。修法：渲染时对**所有** `window.visibleTextEditors` 里显示该文档的编辑器逐个 `setDecorations`（只设一个 ⇒ 分屏另一侧无高亮）；并挂 `window.onDidChangeVisibleTextEditors` → 按 `uri.fsPath` 去重后逐文件补齐（补齐时 `reveal=false`，别抢视口） |
| **坐标系错位**（2026-09-26 真机截图） | 「插入行**没**高亮、相邻行**反被**高亮」 | 内核**直写盘、不经编辑器** ⇒ VS Code 文档缓存可能仍是旧内容，按旧 `lineCount` 算的 range 会画到**错误的行**。渲染前若 `!doc.isDirty && doc.getText() !== afterContent` → `workbench.action.files.revert` 重载后再渲染；末尾仍不符则**留痕**（`高亮范围可能错位`） |
| **并发写同文件的渲染竞态**（2026-09-26 真机） | 「分批修改导致**部分**内容没高亮」 | 一个 step 内模型可能**并行多次写同一文件**（真机实测 `insert` + `append` 同 step 发出），`tool_result` 连着触发多次 `revealChange`；`openTextDocument` 是异步的 ⇒ **先发起的渲染可能后完成并覆盖最新装饰**。修法：每文件一个 `renderSeq`，只让序号最新的那次落地；`await` 之后**重取最新记录**再渲染；hunk 缓存值里带**写后内容指纹**（只按 path 命中会拿旧 hunk 渲染） |

**衍生判据**：「按钮还在」**不能**证明「装饰也在」——两者存活机制不同（provider 模式 vs 编辑器实例绑定）。真机反馈出现「只剩按钮」时，直接按「装饰未按编辑器补齐」这条查。

**排坑（写守卫用例时必踩）**：假文档 `uri.fsPath` 必须与记录键**同源**——tracker 用 `resolve(root, 'a.md')`，**Windows 下得 `\proj\a.md`（反斜杠）**；手写 `/proj/a.md` 对不上 ⇒ `tracker.get()` 返 undefined、装饰一个不设、守卫**先假红**。修法：`const FILE = resolve(ROOT, REL)`。

### ② VS Code 内联呈现的 API 契约（实证自 `@types/vscode`，勿凭记忆）

- **行内幽灵文本**：`ThemableDecorationRenderOptions.before/after`（**类型级**）与
  `DecorationOptions.renderOptions`（**实例级**）**都支持**；
  `ThemableDecorationAttachmentRenderOptions` 提供 `contentText` / `textDecoration`（删除线）/
  `color` / `fontStyle` / `margin`。**实例级附件**是「同一装饰类型下、每处改动显示不同旧内容」的
  唯一做法（类型级的 `contentText` 是固定字符串，无法逐处不同）。
- **附件只能「行内附着」，不能另起一行**：`before` / `after` 的 `contentText` 附在该行文本的
  **同一行**上（`after` = 行右端、`before` = 行左端）⇒「旧内容显示在行右侧」是 **API 的必然结果**，
  不是样式没调好。**扩展 API 没有「在某行上方 / 下方插入一行」的能力**：
  想在「行上方」呈现，唯一载体是 **CodeLens**（VS Code 渲染在所挂行**上方**）——但它同时是
  **命令载体**（未绑命令 = unresolved、不渲染 title）、**无删除线样式**、且可被用户
  `editor.codeLens` 关掉（fail-silent）；**「行下方」则无任何扩展 API**（同类限制在案：
  CodeLens 无「渲染在行下方」、编辑区内悬浮操作条属 fork 内核级 UI）。
  ⇒ 文件内呈现旧内容 / 对照只有三条路：**行尾内联附件**、**悬停**、**另开单页（虚拟文档上下对照）**；
  「文件内改成上下排版」不是可选项——**别据此再提**。
- **多按钮 = 同 range 多 CodeLens**：`CodeLens.command` 只接受**单个** `Command`
  ⇒ Trae 那种「✓ 确认 | ↩ 回退」并排按钮，靠**在同一 range 上 push 多个 CodeLens** 实现
  （VS Code 自动并排渲染）。别去找「一个 lens 挂多命令」的写法——不存在。
- **空行 range 是空 range**：`TextLine.range` 对空行返回 empty；`setDecorations` 传空 range 会
  **抛错**，CodeLens 传空 range 则**静默不显示**。必须过一层 `safeLineRange()`
  （空行扩到「下一行行首」）。
- **带参数的内部命令不进 `contributes.commands`**：CodeLens 命令要携带文件路径，暴露到命令面板
  会得到**无参调用而静默失败**；只 `registerCommand` 即可。
- **数据源 SSOT**：装饰与 CodeLens 必须消费**同一份缓存**（同一次 diff 计算结果）——
  两处各算一遍必然漂移（高亮位置与按钮位置对不上）。

### ③ 文案必须与**动作粒度**一致

CodeLens 挂在**每个**改动块上，但「确认」若作用于**整个文件**（记录粒度 = 文件），
文案就必须写「确认本文件」——写「确认此处」= 骗用户。
**先确定动作粒度，再定文案**，别让按钮位置暗示一个它做不到的精度。

### ④ 副作用自查（内联呈现不该改变文件状态）

decoration 与 CodeLens 都是**虚拟 UI**，不写入文档、不让文件变 `dirty` ✓。
但**视口移动会打扰用户**（`preserveFocus` 与 `revealRange` 的取舍要想清楚）：
- 需要「跳到改动处」→ `revealRange` + **抢焦点**（打断用户输入）；
- 需要「不打断」→ `preserveFocus: true`（用户可能没注意到文件已打开，须另给通知/状态栏入口）。
DIFF-1 选了后者 + 通知按钮 + 状态栏警示底兜底。

### ⑤ 模块顶层**不得**求值 vscode 运行时成员（否则最小 mock 环境 import 即崩）

**症状**：某 UI 逻辑改动**全量测试通过**，但把「命令 id 字符串常量」从 A 模块 import 进 B 模块后，
一批**看似无关**的套件（只要 import 了 B）**整片加载失败**：
```
Error: [vitest] No "OverviewRulerLane" export is defined on the "vscode" mock.
 ❯ fileChangeView.ts:103   overviewRulerLane: vscode.OverviewRulerLane.Left,
 ❯ chatPanel.ts:22          ← 只是 import 了常量
```
**根因**：`vscode.***` 枚举（`OverviewRulerLane`/`TextEditorRevealType`/`StatusBarAlignment`…）
是**运行时值**，写在**模块顶层常量**里会在 **import 阶段**求值。宿主各测试套件的 `vi.mock('vscode')`
只 mock「该套件自己用到的 API 子集」（**无共享 mock 文件**，每个套件内联一份），于是
**「只想引用一个字符串常量」的导入方也会 import 即崩**——与是否真正调用该功能无关。

**修法（修在唯一根因点，勿改 N 个 mock）**：

```ts
// ✗ 顶层常量：import 阶段即求值 vscode 运行时枚举
const HIGHLIGHT_OPTIONS: vscode.DecorationRenderOptions = { …, overviewRulerLane: vscode.OverviewRulerLane.Left };

// ✓ 惰性构建：仅在真正使用时才碰 vscode，import 零副作用
let highlightOptionsCache: vscode.DecorationRenderOptions | undefined;
function highlightOptions(): vscode.DecorationRenderOptions {
  highlightOptionsCache ??= { …, overviewRulerLane: vscode.OverviewRulerLane.Left };
  return highlightOptionsCache;
}
```

**判据**：
- 顶层 `const/let` 里出现 `vscode.<成员>`（**非**类型注解、非字符串字面量）= 立即改成函数/惰性。
  `import * as vscode from 'vscode'` 本身无害；`{ color: 'rgba(...)' }` 这类纯字面量也无害——
  **只有取值才致命**。类型注解（`vscode.DecorationRenderOptions`）编译期擦除，无害。
- **改 4 个 mock 是治症状于 N 处**（且未来新增 import 该模块的套件会复发）——违反 SSOT。修在模块本身。
- 这类崩**只在「B 模块被别的套件 import」时才暴露**，本模块自己的单测可能全绿 ⇒ 改「被跨模块引用
  的 UI 模块」后**必须跑全量**，别只跑本文件单测。
实证（DIFF-1 第四轮，2026-09-26）：宿主全量 4 套件（chatPanelHistory/Input/PauseProjection/
settingsPanelRoles）整片加载失败、单跑本模块却全绿；惰性化后全量归位，tsc/eslint 均 0。

## 规则 7 —— 跨语言真源（TS 常量 ↔ `package.json` 声明面）必须写**守卫对拍**

**形状**：同一个命令 id / 配置键物理上必然存在两处——TS 常量（`registerCommand` 用）与
`package.json#contributes.*`（VS Code 的声明面）。JSON 无法 `import` TS ⇒
**无法靠单一真源消灭**，只能靠**守卫测试**钉死二者一致。

**实证（DIFF-1 第五/六轮，2026-09-26）**：`memora.revertAllFileChanges` 在代码里
`registerCommand`、却在 `contributes.commands` **漏声明**——webview 与状态栏都能用，
唯独命令面板看不到，而**当时零测试报警**（靠真机复现才发现）。当轮修法是
**补一行 JSON**（= 补数据）而非补守卫 ⇒ 同类漂移**必再犯**。第六轮补守卫后，
变异（改掉一条贡献项）恰好 1 红、另一方向用例不误伤。

**守卫必须双向**（缺一即半守卫）：

- 对外命令（状态栏 / 对话区 / 命令面板入口）**必须**已贡献；
- 内部命令（如 CodeLens 携带文件路径参数那种，无参调用会静默失败）**必须不**贡献。

```ts
// ✓ 常量从真源 import、JSON 从盘上读——两侧都是真源，测试自己不复制任何 id 字面量
import { REVIEW_FILE_CHANGES_COMMAND } from '../fileChangeView.js';
const PKG = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../package.json');
const contributed = new Set(
  (JSON.parse(readFileSync(PKG, 'utf-8')).contributes?.commands ?? []).map((c) => c.command),
);
```

- **用 `import.meta.url` 上溯定位包根，别用 `process.cwd()`**——从仓库根跑 vitest 时会指错。
- **测试内不得硬编码 id 字符串**：那就成了第三处副本，守卫自身反成漂移源。
- 待测模块若含 vscode import，空 `vi.mock('vscode', () => ({}))` 即可（前提：已满足规则 6 ⑤）。

## 本环境命令（Windows / 缺 coreutils）

```bash
NODE=C:/Users/SJ/.workbuddy/binaries/node/versions/22.22.2-3/node.exe
cd /f/zooique/memora/hosts/memora-vscode
$NODE ../../node_modules/typescript/bin/tsc --noEmit -p ./
$NODE ../../node_modules/eslint/bin/eslint.js . --max-warnings 0
$NODE ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --no-file-parallelism
# 单文件 + 用例名过滤
$NODE ../../node_modules/vitest/vitest.mjs run --root <hostDir> --config vitest.config.ts \
  --no-file-parallelism src/webview/__tests__/chatView.test.ts -t "技能启停"

# 重建宿主 dist + 产物实读（extension.ts 零覆盖区的兜底；rm 用 node —— Bash 无 coreutils）
$NODE -e "require('node:fs').rmSync('dist',{recursive:true,force:true})"
$NODE ../../node_modules/typescript/bin/tsc -p ./ && $NODE esbuild.config.mjs
$NODE -e "const t=require('fs').readFileSync('dist/extension/extension.js','utf8');console.log(t.split('onDidChangeConfiguration').length-1)"

# 提交信息预验（node 直跑；本环境 npx 报 env: bash: No such file）
cd /f/zooique/memora
$NODE node_modules/@commitlint/cli/lib/cli.js --edit F:/zooique/memora/.workbuddy/tmp/<msgfile>.txt
```

- **不要用管道**（`| tail`/`| head`/`| grep` 不可用）——会被 shell 吞掉退出码造成**假绿**。
  需要过滤时用 `node -e "let d='';process.stdin.on('data',…)"` 承接 stdout。
- `chatStyles.ts` / `dropdown.ts` 是**模板字符串**：注释里写反引号会**截断字符串**导致
  parse error。样式文件的注释里只用中文引号「」。
- 改宿主 src 后必须重建 dist（见 `memora-kernel-release-readiness`，勿重复踩）。
