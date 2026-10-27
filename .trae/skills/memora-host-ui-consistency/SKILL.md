---
name: memora-host-ui-consistency
description: 在 memora 双包架构（内核 @zooique/memora + VS Code 宿主 hosts/memora-vscode）中改「宿主 UI 的可见性/呈现」时使用——例如技能启停徽章、下拉项禁用标记、状态后缀、任何「某对象当前处于受限状态」的 UI 呈现、**底部状态条新增条目（StatusDock 第 N 条 / 浮层 / 状态条）**、**webview 新接内核数据通道**，以及**内联呈现**（decoration 高亮 / 行内幽灵文本 / CodeLens 行内按钮 / 文件内 diff 标记）；也用于「改了配置但界面/行为不生效」类问题、以及「抽出一个常量却引发一批无关套件整片加载失败」类问题。覆盖十一条硬规则：改可见集必须枚举全部消费通道（含**生效时机**这个时间维度）、判定必须与内核真源同源且拦截逻辑只能落 host、webview 测试骨架须比对生产 HTML 结构否则该路径零覆盖、新增断言必须做变异验证（含「一次变异命中多条 = 覆盖充分而非过粗」的判据）、零测试覆盖区（extension.ts）用编译产物实读兜底、内联呈现硬约束（断点清单见规则 6）、**跨语言真源（TS 常量 ↔ package.json 声明面）必须写守卫对拍**、**底部条/协议载荷/替身契约三坑（规则 8：新增条是注册不是造 chip · CSS 令牌连注释都不能写 · 协议禁带 UI 零消费字段 · 宿主新增agent 方法必须补替身且不加 `?.()` · 推送去重签名非条数 · onDidReceiveMessage 挂在 webview 上）**、**要用户立刻看见/操作的 UI 绝不可挂 `#messages` 滚动容器（规则 9，三次实证）**、**`el.hidden = true` 不等于用户看不见（规则 10：author 层 display 覆盖 hidden 属性 ⇒ jsdom 结构性假绿，须读生产 CSS 文本写源码级守卫 + 全局 `[hidden]` 兜底；附 commitlint把 `#选择器` 当 footer 的坑）**、**DOM 位置裁决器三坑（规则 11：终态断言抓不到 insertBefore 有没有搬，须写行为观测 + 容器 remove 会带走内部条目 + 隐藏条目夹在主位与锚点之间使位置范式与免重排判据同时失效；附 HTML 模板注释禁 `--`、相邻性断言方向不许靠推理）**。当用户提到「UI 看不出效果」「禁用/受限状态没提示」「改了设置没反应」「静默失败」「看不出改了哪里」「没有确认/回退按钮」「底部状态条」「加个状态条/浮层」「面板显示在上方/没替换输入框」「测试全绿但真机不对」时加载。
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

### ⚠️ 回归护栏必须喂**真机事件序**（夹具 ts 空串 ⇒ 排序路径零覆盖）

仓库里那种 `realRound-*.ts` 夹具**事件 `ts` 全是空串**（走 `seq` 回落分支）；而真机 round
`<workspace>/.memora/rounds/*.json` 的事件带**真实 ISO ts**。两者走**不同的排序分支**——
拿空串夹具写「顺序类」回归护栏，**真机那条路径零覆盖**，护栏全绿却锁不住 bug。

实证（2026-09-27 任务表错位）：用 `ts: ''` 的夹具怎么摆都复现不出用户的错位；
换成**真机 ts 序**（并让「任务项边界相对首个工具前/后」成为**独立变量**）才复现。

⇒ 构造顺序类护栏时：
1. **喂真机事件序**（从 `rounds/*.json` 抄 ts/seq），别用空串夹具；
2. 把「首个 `plan_item_boundary` 在首个工具**之前 / 之后**」当**显式维度**各测一遍
   （这是「根层内容 vs 任务项组」排序的关键分叉，不是可以默认的细节）；
3. 判定写**因果断言**（如「建表批索引 < 首组索引」），而非「元素存在于某处」。

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

### ⚠️「单跑绿 + 全量红」先怀疑**自己的用例**，别先怪环境（2026-10-04 实踩两次）

**形态**：新写的用例**单跑绿、全量并发稳定红**。直觉会判成「环境负载假红」，**但这次是真缺陷**——
用例本身不可靠。两种真实成因：

| 成因 | 症状 | 修法 |
|---|---|---|
| **`vi.waitFor` 默认超时不够** | 断言 `expected 'running' not to be 'running'` —— 等的真实进程还没退出，1s 先到 | 命令改快（`echo` 而非 `node -e`）+ 等待显式 `{ timeout: 5_000 }` |
| **凭对称性推断错了实现的刻意设计** | 断言「A 与 B 同走某链」全红，收集器为空 | **先读实现注释**：注释里写「为什么不……」的地方就是定案（如「主动 kill 刻意不回调 listener，输出已由 `kill_command` 返回，再回流一次会让模型收到第二份副本」）|

**判别流程**：单跑绿 + 全量红 ⇒ ① 先跑该文件 **2–3 次**看是否稳定红（稳定 = 真问题）；
② 读失败断言的**实际值 vs 期望值**（`expected [] to deeply equal [...]` 收集器空 ⇒ 事件没到）；
③ **读被测实现的注释**，找「刻意如此」的设计定案。

**反模式**：为了「不依赖真实进程耗时」把触发源从 `settle` 换成 `kill` —— 两个入口**不一定同源**。
**注释里写「为什么」的地方 = 设计定案，改判据前必须先读，别凭对称性推断。**

**⚠️ 变异必须红在「断言」上，不能红在「等待 / 前置条件」上**（守卫可达性，2026-09-27 实锤）：
若某个用例先 `await vi.waitFor(() => expect(形态A).toBe(true))` 再做断言，而变异恰好把实现改成**形态 B**，
则 `waitFor` **先超时变红**、后面的形态断言**根本没跑到** —— 表现为「变异确实红了」，实则**守卫不可达**（谁把实现改回 B 都不会被那条断言抓到）。
排查信号：**变异后红的是 timeout / 前置，而不是断言 ⇒ 先修测试可达性，别急着怀疑产品代码。**
修法：等待条件只等「**出现了**」（不预设形态），形态交给并列的显式断言：
`const seen = opened.length > 0 || executed.includes('vscode.diff'); expect(seen).toBe(true)`，再断言 `expect(executed).not.toContain('vscode.diff')`。
实证：DIFF-1 对照视图改自渲染后，守卫写「等虚拟文档已打开」⇒ 变异回 `vscode.diff` 时 3 红全在 `waitFor`；
改成「等任一形态出现」后，变异精确红在 2 条形态断言上（另 1 条红在正文内容断言）。

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

### ⚠️ 判「dist 里有没有这个修复」必须**双向探针**（只搜新符号会假阳性）

改完源码 **不等于** dist 生效：用户 F5（不 compile）或忘了重建时跑的是**旧 bundle**，
症状与「修复根本没写」一模一样。判代次只搜「新符号在不在」不够——**旧符号给的是更硬的判据**。

```bash
# ✓ 双向：新符号应「有」、旧符号应「无」
grep -c ":scope > .round-block__plan-item" dist/webview/scripts/chatView.js   # 新 → 期望 ≥1
grep -c "\.process-flow__input')))" dist/webview/scripts/chatView.js           # 旧结尾 → 期望 0
```

实证（2026-09-27，任务表错位）：`dist/webview/scripts/chatView.js` 候选选择器结尾仍是
`… :scope > .process-flow__input'`（**无** `plan-item`），且无 `grp.dataset.ts` ⇒ 断定
**pre-Fix1 代次**，用户只是没重编 dist 就跑 —— 及时排除了「再改代码」的错误方向。
**结论先行**：症状 = 某修复「没生效」时，**先验 dist 代次**（双向探针 + 文件时间戳），
再怀疑源码。选择器等**纯 ASCII** 串不受 `charset=ascii` 转义影响，可直接搜。

**并行检索的坑**：`dist/` 与 `src/` 同名文件同时 grep 时只看行号会串台 —— 用 `-n` + 显式
`path` 逐文件查，别用一次跨目录的模糊匹配下「符号存在」的结论。

## 规则 6 —— 宿主**内联呈现**（decoration / CodeLens）的三条硬约束

> 起因（2026-09-26 真机两连击）：DIFF-1（文件改动内联 diff）首次落地后用户反馈
> 「文件打开了，但**看不出改了哪里**，也没有确认/回退按钮」。当时逻辑层 13 项单测全绿
> ——**渲染层一行没验**。三条教训按下面固化。

### ① 设了装饰 ≠ 用户看得见（六个真实断点，缺一即「看不出效果 / 看错位置」）

| 断点 | 症状 | 修法 |
|---|---|---|
| **未移动视口** | 文件停在顶部，改动行不在视野内 | `editor.revealRange(range, TextEditorRevealType.InCenter)` |
| **用主题色** | 部分主题下装饰几乎透明 | 用**字面高对比色**（`rgba(...)`），别依赖 `diffEditor.*` 主题色 |
| **静默吞异常** | 真机失败零诊断线索 | 装饰 / 打开 / 恢复全部经 `deps.log`（接输出通道）留痕；**禁 `try/catch{}` 空捕获** |
| **切走再切回**（2026-09-26 真机） | 「高亮全没、**只剩按钮**」 | 装饰是 **per-editor** 的、绑在编辑器实例上，VS Code **不会**在编辑器重新可见时替你恢复；CodeLens 走 **provider 模式**（VS Code 主动回调 `provideCodeLenses`）**自己活** ⇒ 症状恰好是「装饰丢、按钮留」。修法：渲染时对**所有** `window.visibleTextEditors` 里显示该文档的编辑器逐个 `setDecorations`（只设一个 ⇒ 分屏另一侧无高亮）；并挂 `window.onDidChangeVisibleTextEditors` → 按 `uri.fsPath` 去重后逐文件补齐（补齐时 `reveal=false`，别抢视口） |
| **坐标系错位**（2026-09-26 真机截图） | 「插入行**没**高亮、相邻行**反被**高亮」 | 内核**直写盘、不经编辑器** ⇒ VS Code 文档缓存可能仍是旧内容，按旧 `lineCount` 算的 range 会画到**错误的行**。渲染前若 `!doc.isDirty && doc.getText() !== afterContent` → `workbench.action.files.revert` 重载后再渲染；末尾仍不符则**留痕**（`高亮范围可能错位`） |
| **并发写同文件的渲染竞态**（2026-09-26 真机） | 「分批修改导致**部分**内容没高亮」 | 一个 step 内模型可能**并行多次写同一文件**（真机实测 `insert` + `append` 同 step 发出），`tool_result` 连着触发多次 `revealChange`；`openTextDocument` 是异步的 ⇒ **先发起的渲染可能后完成并覆盖最新装饰**。修法：每文件一个 `renderSeq`，只让序号最新的那次落地；`await` 之后**重取最新记录**再渲染；hunk 缓存值里带**写后内容指纹**（只按 path 命中会拿旧 hunk 渲染） |
| **末块贴文件最后一行**（2026-09-27 真机） | 「按钮一开始在改动下方，点了一个按钮后**跑到上面去了**」 | **CodeLens 恒渲染在「所挂行」的上方**，而挂点取 `endLine + 1`（= 视觉在块**之后**）；当块末行 = 文件最后一行时 `endLine + 1` **越界**，`safeLineRange` clamp 回末行 ⇒ 按钮**必然落在该块上面**。**API 给不出「渲染在行下方」的 CodeLens ⇒ 位置不可解，不是行号算错**（同一次计算的坐标与装饰高亮仍一致）。「点一下才跑上去」的真因：点掉前一块后**场上只剩末块**，唯一的按钮就是那颗被 clamp 的 —— 位置没变，变的是**还有没有别的按钮作参照**。**修法 = 位置解不了就让归属不依赖位置**：按钮标题**恒带序号** `（N/M）`（单块也显 `（1/1）`，不搞时有时无），顺带补「看不出共几处」 |

**衍生判据**：「按钮还在」**不能**证明「装饰也在」——两者存活机制不同（provider 模式 vs 编辑器实例绑定）。真机反馈出现「只剩按钮」时，直接按「装饰未按编辑器补齐」这条查。

**排坑（写守卫用例时必踩）**：假文档 `uri.fsPath` 必须与记录键**同源**——tracker 用 `resolve(root, 'a.md')`，**Windows 下得 `\proj\a.md`（反斜杠）**；手写 `/proj/a.md` 对不上 ⇒ `tracker.get()` 返 undefined、装饰一个不设、守卫**先假红**。修法：`const FILE = resolve(ROOT, REL)`。

### ② VS Code 内联呈现的 API 契约（实证自 `@types/vscode`，勿凭记忆）

- **行内幽灵文本**：`ThemableDecorationRenderOptions.before/after`（**类型级**）与
  `DecorationOptions.renderOptions`（**实例级**）**都支持**；
  `ThemableDecorationAttachmentRenderOptions` 提供 `contentText` / `textDecoration`（删除线）/
  `color` / `fontStyle` / `margin`。**实例级附件**是「同一装饰类型下、每处改动显示不同旧内容」的
  唯一做法（类型级的 `contentText` 是固定字符串，无法逐处不同）。
- **多按钮 = 同 range 多 CodeLens**：`CodeLens.command` 只接受**单个** `Command`
  ⇒ Trae 那种「✓ 确认 | ↩ 回退」并排按钮，靠**在同一 range 上 push 多个 CodeLens** 实现
  （VS Code 自动并排渲染）。别去找「一个 lens 挂多命令」的写法——不存在。
- **空行 range 是空 range**：`TextLine.range` 对空行返回 empty；`setDecorations` 传空 range 会
  **抛错**，CodeLens 传空 range 则**静默不显示**。必须过一层 `safeLineRange()`
  （空行扩到「下一行行首」）。
- **带参数的内部命令不进 `contributes.commands`**：CodeLens 命令要携带文件路径，暴露到命令面板
  会得到**无参调用而静默失败**；只 `registerCommand` 即可。
- **`vscode.diff` 打不开「inline / 上下排列」**（2026-09-27 实证）：`TextDocumentShowOptions`（`vscode.diff` 第 4 参数）**不含布局字段**；布局只受用户全局 `diffEditor.renderSideBySide` 或**切换型**命令影响（盲调 = 改用户设置）。⇒ 用户嫌「左右两栏看不清原文」时，**唯一确定性路线是自己渲染单列 `- `/`+ ` 文本 + `showTextDocument` 只读虚拟文档**（零落盘、天然只读），别去试 `override: 'inline'`（那是 editor-resolver id，不是布局）。同批可**删掉**「删除场景右侧给空虚拟文档」这类为左右并排而生的分支。
- **「一个改动块 = 一组按钮」是硬前提**（2026-09-27 实锤）：块级按钮的**分母 = `snapshot.hunks.length`**（`provideCodeLenses` 逐个出按钮）⇒ **数按钮标签的分母 = 数 diff 的块数**，这是最快的「渲染漏画 vs 逻辑只给这么多」判别器。⚠️ **替换（删一行+插一行）= 同一个块**（实测 `A\nB\nC → A\nX\nC` = **1 块**，removed=[B]）⇒ 被删内容**不会丢**，它以**行尾删除线预览**（`⟵ 原: …`）呈现、**没有独立按钮**。删/插之间**只要有一个共同行相隔**就分成两块。⇒ 用户说「改了三处只显示两块」时，先查是不是**相邻改动落在同一个连续改动区**。
- **数据源 SSOT**：装饰与 CodeLens 必须消费**同一份缓存**（同一次 diff 计算结果）——
  两处各算一遍必然漂移（高亮位置与按钮位置对不上）。
- **⚠️ 但「同一份缓存」≠「同一次渲染」**（2026-09-27 实锤，与上一条的边界）：装饰是**命令式、per-editor**设置的，CodeLens 是**provider 由 VS Code 主动拉取** ⇒ 两者可以在时间上错开。症状可以是**「旧装饰残留 + 新按钮」**（反向于此前的「高亮丢、按钮留」）：截图里同屏出现「一组删除线预览」+「按钮分母说没有删除块」= **互相矛盾 ⇒ 必有一次渲染的装饰没落地**。取证顺序：① 数按钮分母 vs 预览；② 查 Memora 输出通道有无 `[fileChange] 打开/渲染失败`；③ 让用户先「全部确认」清空记录再复现一次（清空后仍是 N-1 ⇒ 逻辑归并；变回 N ⇒ 残留装饰）。

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

## 规则 8 —— 底部状态条（StatusDock）新增条目 + webview↔内核边界 + 替身契约

> 起因（2026-10-04 CMD-1 刀 3 实证）：给底部加「后台任务」条时，连踩四类坑——
> ①以为要自己造 chip（既有收纳器已完备）；②CSS 凭习惯写 `var(--token)` 而令牌不存在；
> ③协议里带了 UI 零消费的字段；④新增 agent 方法没补测试替身，打断整条 `consumeFlow`。

### ① 新增底部条 = 注册第 N 条，**不是**造新 chip

`chatView.ts` 的 StatusDock 已是**底部条收纳器**：`DOCK_PRIORITY` 决定主位，
非主位条自动进既有 `+N` chip / `status-dock__panel`。**再造第二个 chip = 两套 chip +
两套展开态 + 两套显隐裁决，纯负收益。**

```ts
const DOCK_PRIORITY = {
  confirm: 10, // A 类阻断面板：恒主位，优先于 error 豁免（见下）
  fileChanges: 3,
  pendingQueue: 2,
  activity: 1,
  background: 0,
} as const;
```

- **A 类（阻断面板）与 B 类（信息条）共用这一个裁决器**——**别再造第二个裁决器**
  （如 `resolvePromptSlot()`）。两个裁决器会争同一个插入锚点、`insertBefore` 顺序不定
  ⇒ 那就是双源。A 类作为最高优先级 entry **注册进来**即可，复用既有 fixed/主位/收纳机制。
- **A 类恒主位必须优先于 error 豁免**（2026-10-05 定案）：确认卡一旦被收进浮层就不可见，
  超时后 fail-closed 自动拒绝（「命令确认不弹 UI」的同款病灶）；而 error 被收纳仍可从
  图标条点开。两者代价不对称，故主位裁决顺序 = A 类 → fixed → priority 最大。

- **显隐/归位只由 `resolveDock()` 裁决**——各条更新函数只上报 `setDockActive(id, bool)`，
  **禁直写 `hidden` / `insertBefore`**（散写即回到堆叠现状）。
- **空态必须在懒创建 _之前_ return**：dock 注册初值 `active=false`；若先创建再
  `setDockActive(false)` 属状态未变 no-op ⇒ `resolveDock` 永不裁决该节点，**裸插入的
  空条永久可见且任何后续空投影都关不掉**。
- **`registerDockEntry` 必须在 `dockEntries`（const Map）初始化之后**——放声明区踩 TDZ。
  `activityBar` 是静态节点可提前注册；懒创建的条在创建处注册。
- **优先级取值要说得出理由**。「垫底 0」的判据：承载主状态的条不能被顶掉；而当其他条
  归位、自己是唯一活跃条时自动升主位，**恰是最需要它的时刻直接可见**（原取舍：收纳时
  先看到无语义的 `+1`，需点开才知是哪条——与既有条同一取舍，不为其破例）。
- CSS 记得把新条加进 `.status-dock__panel X { margin: 0 }` 那条归位规则。

### ② CSS 令牌：**先查 `tokens.ts`，连注释里都不能写令牌名**

`tokensClosure` 守卫扫**样式层原文**里引用的每个 `var(--x)`，要求在 `tokens.ts` 有定义。

- 无定义 ⇒ **恒走 fallback、不跟随主题**（看着能跑，主题一换就露馅）。
- ⚠️ **注释里写出令牌名同样触发守卫**（扫原文，不解析注释）——想说「这么写会被判幽灵令牌」
  得换个说法，不能把令牌名打出来。
- 没有对应令牌时**用既有令牌或字面量**（等宽字体在 `tokens.ts` 里根本没有令牌 ⇒ 随 code
  块写法用 `ui-monospace, Consolas, monospace` 字面量）。
- 另：`chatStyles.ts` 是**模板字符串**，注释里写反引号会**截断字符串**导致 parse error。

### ③ 协议只带 **UI 真消费**的字段（禁预支）

- **`Pick<内核类型, ...>` 只挑 UI 三个消费点之外的零消费字段 = 僵尸载荷**：本轮 Pick 了
  `startedAt` 而 UI 零消费 ⇒ 删（真需要时按触发驱动再加）。判据：写得出「哪个消费点用
  它」才留。
- **webview 侧对 `@zooique/memora` 只能 `import type`**——值导入会把整个内核包打进
  bundle。需要在 webview 展示的**字面量**（如状态词表）由 **extension 侧读内核真源后
  走协议下发**（`statusLabel`），真源仍是内核那张表，宿主零自建。
- **终态不给无效按钮**：已结束的行再点「终止」宿主只会当「已终结」处理 ⇒ 留着就是
  「点了没反应」的僵尸交互。

### ④ 宿主新增 agent 方法 ⇒ **必须补测试替身，且不加 `?.()` 兜底**

**症状**：宿主加了 `agent.foo()` 调用后，`chatPanelHistory` 的落盘用例红成
「两次迭代只落一次盘」——`chatAgentStub` 缺 `foo` ⇒ 抛错**中断整条 `consumeFlow`**。

**处置：补桩**（`foo: () => []`），**不要**写 `this._agent.foo?.() ?? []`。
`?.()` 是给替身违约打掩护，会把真实契约缺口藏进 optional 链——本仓已有前科
（`syncPendingQueue` 的 `getPendingInterjections?.()`）。判据：**真实 agent 的公共面
方法恒存在，optional 调用等于宣称「它可能不存在」= 对契约说谎**。

写完顺手在替身工厂上方留一句「同型第 N 次」，这个坑会复发。

### ④' 宿主订阅内核事件 ⇒ 三条桩纪律（2026-10-04 实踩）

新增 `AgentEventMap` 事件后，宿主侧测试替身必须满足：

| 纪律 | 反例 | 为什么 |
|---|---|---|
| **`on` 必须真转发**（`Map<event, handlers[]>`） | `on: vi.fn()` | 空实现下「事件名错配 / 处理器没绑上」**测不出来**——测试全绿但零覆盖 |
| **不暴露 `emit`** | 桩上挂 `emit` 供测试直调 | 真实 Agent 的 `emit` 是 `protected`；直调**绕过事件名检查**。改用桩捕获的处理器投递：`stub.handlers.get(evt)?.[0]?.(payload)` |
| **造数据自洽** | 事件说 `completed`、注册表仍报 `running` | 自相矛盾假数据会让用例「绿得毫无意义」。先让桩改状态，再发事件 |

订阅写 `off` + `on` 成对（宿主 `bindAgentNoticeEvents` 幂等模式）。
⚠️ **重复 `on` 是真实风险**（本轮回滚变异时误插两行 ⇒ 一次终态推两遍相同快照，
且**签名去重在处理器内部拦不住**——那是两条独立调用）。加一条「同一事件只 `on` 一次」
的守卫用例。

### ⑤ 推送去重：用**内容签名**，不用条数

三个推送点（事件 A / 事件 B / 用户动作后回推）共用一个去重守卫时，判据取
`taskId:status` 拼接串而**非 `items.length`**——「状态迁移但条数不变」（kill 后
`running→killed`，条数恒 1）会被长度守卫判成 no-op，**关键刷新被吞**。同
`syncPendingQueue` 长度守卫的反向教训。

⚠️ **哨兵值不能取业务空间的合法值**（2026-10-04 实踩）：「强制重推」时把签名字段置
空串是自然写法，但**当过滤后集合为空时，签名本身就是空串** ⇒ 去重判成 no-op ⇒
**「强制」失效、UI 根本不更新**。哨兵必须用 `null`（或业务空间外的符号），
字段类型相应改为 `string | null`。

同型场景：任何「作废缓存/去重键 ⇒ 强制下一次必生效」的逻辑，哨兵值都要检查
**是否会与该空间的合法值撞车**。

### ⑥ 写路由 harness：`onDidReceiveMessage` 挂在 **webview** 上

`webviewView.webview.onDidReceiveMessage(cb)`，**不是** `webviewView.onDidReceiveMessage`
（挂错层 ⇒ `is not a function`）。要测「webview 消息真能走到某私有方法」这一跳，就在
`resolveWebviewView` 的 mock view 里**捕获注册的回调再驱动它**，别直接调私有方法——
后者把中间的消息类型判据测没了。桩掉与该消息无关的 `render` / `ensureEditorTracking` /
`ensureAgent`（后者 async 且要真配置）。

## 规则 9 —— 「要用户立刻看见/操作」的 UI **绝不可挂在 `#messages` 内**（滚动容器红线）

> 起因（2026-10-05 实锤，**同型第三次**）：`confirmWrites` / 命令确认的审批卡挂
> `#writeConfirmCard` 在 `#messages` 里，表现为「**确认 UI 根本没弹**」，30 秒后
> fail-closed 自动拒绝 ⇒ 命令确认（CMD-1 阶段 1 新路径）**首跑即翻车**。

### 为什么挂进去就等于「不存在」

`#messages` 是 `overflow-y:auto` 滚动容器（chatStyles.ts:34），而消息全部走
`messages.appendChild()` 追加。两个后果叠加：

1. 静态插在 `#messages` 里的节点**位置固定在最前面**（它是第 2 个子节点，紧跟
   `#emptyState`），后续所有消息都排在它**之后**；
2. 流式渲染全程吸底（`helpers/scrollToBottom.ts`，13 处调用）⇒ **视口恒钉在底部**。

⇒ 节点物理上在消息流**最顶端**，视口在**最底端** —— 只要会话有历史内容，它就在视口上方
几千像素处，**永远看不见**。

### 判据（一句话）

**用户必须立刻看见或点击的东西，一律放 `#inputBar` 之前、与 `#messages` 同级。**
判据只有一条：这个 UI 是不是「不看/不点就会出错」。是 ⇒ 不许进滚动容器。

### 三次实证（同一个坑，别第四次）

| # | 组件 | 症状 | 处置 |
|---|---|---|---|
| 1 | `#planBar` 任务进度条 | 被滚走 | 挪出，与 `#messages` 同级 |
| 2 | `#scrollToBottomBtn` 一键到底 | 「和会话记录一起滚走」 | 挪进 `#inputBar`（已 `position:relative`）锚其顶边 |
| 3 | `#writeConfirmCard` 审批卡 | 「确认 UI 根本没弹」+ 30s 自动拒绝 | 挪到 `#inputBar` 之前 |

### 落地要求（缺一即复发）

1. **守卫用例两条**：①DOM 层 `expect(messages.contains(el)).toBe(false)`；
   ②**源码层**——`readFileSync` 生产 `chatPanel.ts` 断言节点缩进是 **2 空格**（骨架层），
   不是 4 空格（嵌在 `#messages` 内）。
   ⚠️ ② 不可省：测试夹具 `chatViewTestEnv.ts` 的 HTML 是生产 `buildHtml` 的**手工镜像**，
   只写 ① 的话夹具一漂就失效（**守卫只锁夹具、不锁生产**）。
   源码层守卫沿用 `iconLanguage.test.ts` / `tokensClosure.test.ts` 的 readFileSync 范式。
2. **断言别只锁 `hidden`**：审批卡旧用例断言 `hasAttribute('hidden') === false`，真机也是
   false（确实显示了，只是在视口外）⇒ **假绿**。必须补**结构断言**（不在滚动容器内）。
3. `absolute` 定位的子元素同样随内容滚——别以为加了 `position:absolute` 就钉得住。

### 相关：阻断类 UI 的「请求已终结」必须回传

超时自动拒绝后，若宿主不通知 webview，**卡片残留、按钮点了没反应** = 终态仍可交互的
僵尸交互。推送 `write_confirm_closed`（裁决 / 超时两个终点同源），requestId 不匹配不关
（防旧终结通知关掉新卡）。

## 本环境命令（Windows / 缺 coreutils）

```bash
cd "$(git rev-parse --show-toplevel)/hosts/memora-vscode"
node ../../node_modules/typescript/bin/tsc --noEmit -p ./
node ../../node_modules/eslint/bin/eslint.js . --max-warnings 0
node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --no-file-parallelism
# 单文件 + 用例名过滤
node ../../node_modules/vitest/vitest.mjs run --root <hostDir> --config vitest.config.ts \
  --no-file-parallelism src/webview/__tests__/chatView.test.ts -t "技能启停"

# 重建宿主 dist + 产物实读（extension.ts 零覆盖区的兜底；rm 用 node —— Bash 无 coreutils）
node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})"
node ../../node_modules/typescript/bin/tsc -p ./ && node esbuild.config.mjs
node -e "const t=require('fs').readFileSync('dist/extension/extension.js','utf8');console.log(t.split('onDidChangeConfiguration').length-1)"

# 提交信息预验（node 直跑；本环境 npx 报 env: bash: No such file）
cd "$(git rev-parse --show-toplevel)"
node node_modules/@commitlint/cli/lib/cli.js --edit .workbuddy/tmp/<msgfile>.txt
```

- **不要用管道**（`| tail`/`| head`/`| grep` 不可用）——会被 shell 吞掉退出码造成**假绿**。
  需要过滤时用 `node -e "let d='';process.stdin.on('data',…)"` 承接 stdout。
  ⚠️ 若确实用了 `| tail`，**切不可再用 `$?` 判退出码**（那是 tail 的码，恒 0）⇒ 必须另跑一次**不带管道**的 `cmd && echo OK` 作为凭据。

### ⚠️ 源码里禁落**裸控制字节**（0x00 等）——否则 git / ripgrep 把整个文件判为二进制（2026-09-27 实锤）

**症状**：`Grep` 某 `.ts` 返回的是 **`binary file matches (found "\0" byte around offset N)`** 而非命中行；
`git diff --stat` 显示 **`Bin A -> B bytes`**、`--numstat` 显示 **`-  -`** ⇒ 该文件的改动
**在提交里完全不可读**（与「surgical、可审阅 diff」直接冲突）。**而 tsc / vitest 全绿，单一门禁查不出**。

**根因**：git 的二进制判据 = **头 8000 字节内出现 0x00**（`FIRST_FEW_BYTES`）；ripgrep 同理。
实证（DIFF-6）：裸 NUL 落在 **offset 7751**，**恰好卡在 8000 窗口内**——差一点就躲过，纯属巧合。

**修法**：控制字符一律写**转义**（`\u0000` / `\0`），绝不落裸字节。运行期仍是同一字符 ⇒
**行为不变**（FNV 之类 hash 也不变，故单测仍全绿）。`fileChangeDiff.ts` 的 `hunkKey` 用 NUL 作
`removed`/`added` 分隔符即此写法，并在 JSDoc 里写明「勿写裸 NUL」。

**排查单行（全仓扫 NUL）**：

```bash
node -e "const fs=require('fs'),p=require('path');const hits=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);e.isDirectory()?w(f):(/\.(ts|tsx|js|mjs|cjs|json|md)$/.test(e.name)&&fs.readFileSync(f).includes(0))&&hits.push(f)}})('hosts/memora-vscode/src');console.log(hits.join('\n')||'NO-NUL')"
```

**⚠️ 修完必须重新 `git add` 该文件**：`git diff` 比**两侧**——索引里若仍是带 NUL 的旧 blob，
git **依旧判二进制** ⇒ 不重新暂存 = 白修。

## 规则 10 —— `el.hidden = true` **不等于**用户看不见（display 覆盖 hidden 属性）

> 起因（2026-10-05 真机实锤）：A 类阻断面板激活时本应「替换 composer」（用户只能选
> 确认/拒绝），真机却显示为「确认卡在输入框**上方**，输入框完好」⇒ 交互约束完全失效，
> 用户仍可乱打字。tsc 0、eslint 0、**336 用例全绿** —— 结构性假绿。

### 根因：CSS 规范行为，不是 bug

`hidden` 属性的 `display: none` 来自 **UA 样式表**；**author 层任何 `display` 声明都赢它**。
`chatStyles.ts` 里 `#inputWrap { display: flex }` ⇒ JS 写的 `inputWrap.hidden = true`
**确实为 true**（断言恒真），但**视觉纹丝不动**。

### 排他性推理（下次直接用，别逐层猜）

同一裁决函数（`resolveDock`）**同时**决定「卡可见」与「composer 让位」。所以
「A 生效了、B 没生效」只可能是「JS 属性写对了，但 CSS 把它盖了」——
**直接锁定根因层**，不必再猜是不是逻辑没走到。

### 为什么测试抓不到（三重巧合）

1. **jsdom 不加载 `<style>`**；
2. 测试夹具（`chatViewTestEnv.ts`）**不含样式表**；
3. `hidden` 是**属性**不是**计算样式** —— 断言 `el.hidden === true` 与视觉零关联。

⇒ **假绿是结构性的，不是疏漏**。同类坑本文件已逐个补过 **18 处** `.xxx[hidden]`
兜底（`.activity-bar` 的注释里就写着同一句警告），**全是打补丁**。

### 修法：一条全局规则治本

```css
/* Base 段首 */
[hidden] { display: none !important; }
```

- 配`.xxx[hidden] { display: none; }` 双保险（对齐既有 18 处写法）。
- **`!important` 的正当性**（别凭感觉删）：同specificity 下**后声明者胜**，而全局那条在
  文件靠前 ⇒ 去掉 important 会输给下方显式兜底（那些恰好也是 `display:none`，故可接受）；
  `!important` 只为兜住「**未来新增且忘了补**」的那些。误伤面已实查：零处
  `setAttribute('hidden')` 旁路、零处依赖 hidden 做非显隐语义、`details` 用 `open`
  不受影响。
- **实测规模**：`chatStyles.ts` 74 处 `display` 声明中约 60+ 处自身无兜底
  （该数是**上界** —— 粗扫正则会误抓嵌套子选择器，**别把它当精确值写进注释**）。

### 唯一能在 jsdom 抓到此病 的测试形态

**读生产 CSS 文本，不读计算样式**：

```ts
const src = readFileSync(join(__dirname, '..', 'styles', 'chatStyles.ts'), 'utf-8') as string;
expect(src).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
```

既有 `el.hidden` 属性断言**保留**（验「JS 有没有写」），新守卫验「CSS 会不会盖掉」
—— **两者互补，缺一不可**。变异验证：去掉 `!important` → 守卫必须变红。

### 排查单行：哪些选择器缺兜底

```bash
cd "$(git rev-parse --show-toplevel)/hosts/memora-vscode" && node --input-type=module -e "
import { chatStyles } from './src/webview/styles/chatStyles.ts';
" 2>/dev/null || echo "用 vitest 跑一次性 .test.ts 取值（node 直读 .ts 不可行）"
```

（实操：写临时 `*.test.ts` 跑 vitest 取 `chatStyles` 字符串，跑完删。）

###顺带：commitlint 会把「列表项里的 CSS 选择器」当footer

提交信息里写 `- #inputWrap[hidden] xxx` ⇒ commitlint 判为 BREAKING CHANGE 风格
footer ⇒报 `footer-leading-blank` warning，**与空行无关**。最小复现：

```bash
printf 'test: x\n\n- aaa\n- #foo[bar] baz\n- ccc\n' > f.txt && npx commitlint --edit f.txt
```

**修法**：提交信息里不写 `#选择器` 开头的列表项，改写成「id 为 inputWrap」这类措辞。
**别用全角＃**（代码语境里是错字符）。定位此类问题用**二分砍段 + 最小复现**，别猜
（我先猜花括号、猜 `!`、猜 `##`，全错，浪费 4 轮工具调用）。

### 真机 diff/块数类问题的诊断法（2026-09-27 新增，`.workbuddy/tmp/` 放探针，不入库）

**先记住一条硬边界：真机会话里拿不到 `beforeContent`。** `.memora/rounds/*.json` 只存工具**参数**与**截断到 100 字**的结果摘要，写前快照只活在宿主内存里 ⇒ **不能靠历史 round 反推「宿主当时比的是什么」**。可用的三条路：

```bash
TSX="$(git rev-parse --show-toplevel)/node_modules/tsx/dist/cli.mjs"   # 用顶层入口；别写 .pnpm 下带版本号的路径（版本一变即失效）
cd "$(git rev-parse --show-toplevel)/hosts/memora-vscode" && node "$TSX" ../../.workbuddy/tmp/probe.mts
```

探针要点：文件名用 **`.mts`**；import 宿主源码用 `file://<仓库根>/hosts/memora-vscode/src/extension/host/fileChangeDiff.ts` 绝对 URL（`file://` 后接本机仓库根路径）；裸包名 `@zooique/memora` 按**导入文件所在目录**解析，故 cwd 设在宿主目录即可。**`computeFileDiff` 返回 `{hunks, degraded}`（不是数组）**，另有 `hunkAnchorLine` / `isRemovedOnly` 同源导出。

1. **合成用例跑真算法**：钉住「替换=1 块 / 纯删除=1 块 / 中间隔一个共同行=2 块」这类基本行为（先证机制，再谈个案）。
2. **取真数据**：从 rounds JSON 里取该文件**每一次** `write_file` 的 `args`（`overwrite` 的 content 就是完整快照）⇒ 可重建大部分历史版本，但**最早那份 / 用户手写的版本拿不到**。
3. **穷举复现签名**：把「不确定的那几行」在**所有可能位置**上枚举，要求复现用户截图里的全部可观测量（块数、每块的 `removed` 是否为空、预览落在哪一行）⇒ **命中 0 = 截图里的两件事互相矛盾**（比空口推断强得多）。

## 规则 11 —— DOM「位置裁决器」的三个必踩坑（2026-10-05 P4 血训）

改`resolveDock` 这类**反复重排 DOM 的裁决器**（StatusDock / 列表头 / 折叠区）时必读。
三个坑都表现为「测试全绿、真机错位」，静态断言天生抓不到。

### 坑 1：终态断言抓不到「有没有搬」

`insertBefore` 搬一个**已在位**的节点，**最终 DOM 完全相同** ⇒ 任何终态位置断言都绿。
实测：把免重排判据退化成「无条件重排」，静态断言**全绿**。

**必须另写行为观测**：

```ts
const parent = inputBar.parentNode as HTMLElement;
const orig = parent.insertBefore.bind(parent);
const moved: Node[] = [];
parent.insertBefore = function patched<T extends Node>(n: T, ref: Node | null): T {
  moved.push(n); return orig(n, ref);
} as typeof parent.insertBefore;
try { dispatch(/* 触发一次重排 */); } finally { parent.insertBefore = orig; }
expect(moved).not.toContain(主位条);
```

⚠️ 选场景要挑「**主位构成不变**」的那条路径。加一条低优先级 B 类条会引出 chip/panel
插到主位之上，那是**必要**重排，不归免重排判据管，用它当场景会得到假红。

### 坑 2：`container.remove()` 会把容器里的条目一并带走

浮层/面板被 `remove()` 时，**嵌在它内部的条目节点跟着从DOM 消失**——而条目自己
不知道自己「住在」面板里。实测：一条 error 提示的整条状态条凭空消失（探针实证）。

**修法**：摘容器**之前**先把所有条目搬回共同父节点。

```ts
for (const e of entries.values()) {
  if (e.el.parentNode !== parent) parent.appendChild(e.el);
  if (e.follower && e.follower.parentNode !== parent) parent.appendChild(e.follower);
}
container?.remove();
```

### 坑 3：隐藏条目夹在主位与锚点之间，位置范式与免重排判据**同时**失效

非活跃条目若退到锚点（`inputBar`）**之前**，它们天然夹在「主位条↔inputBar」中间：

- 「主位条紧贴输入区」的位置范式破（既有契约当场变红）；
- 「`anchor.previousElementSibling === head`」的免重排判据恒假 ⇒ **退化成每轮重排**
  = 修掉的闪烁复发。

**修法**：非活跃条目退到**主位之上**（`insertBefore(el, headEl)`），且该退位目标必须
与主位裁决**共用同一函数**（`pickDockHead`）——两处各判一次，改一处忘另一处就复现。

**守卫写法**：断言**物理相邻**，不要写「跳过隐藏节点后相邻」——隐藏节点夹中间一样破坏
位置范式（点击穿透、点击区错位）。

### 附带：HTML 模板注释里禁写 `--`

`chatPanel.ts` 的 `buildHtml` 是模板字符串，注释里出现 `--` 序列会让 `<!--` **提前闭合**，
TS 报 `TS1005`。写模板内注释时避开双连字符；写完跑 `tsc` 才知。

### 附带：相邻性断言的方向，**不许靠推理**

探针若从锚点**往回**打印链（`n = anchor.previousElementSibling` 循环），则打印顺序
`A <- B <- anchor` 表示**DOM 上 B 在 A 之上**。我据此连改 3 次断言方向全错。

**探针必须双向打全**：`el.previousElementSibling?.id` 与 `el.nextElementSibling?.id` 一次
输出，再写断言。规则 10 的「相邻性判据」是同一条纪律的下游。

- `chatStyles.ts` / `dropdown.ts` 是**模板字符串**：注释里写反引号会**截断字符串**导致
  parse error。样式文件的注释里只用中文引号「」。
- 改宿主 src 后必须重建 dist（见 `memora-kernel-release-readiness`，勿重复踩）。
