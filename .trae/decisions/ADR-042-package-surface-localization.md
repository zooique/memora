---
alwaysApply: false
description: package 面本地化定案——VS Code 原生 package.nls* 两文件（默认英文 + zh-cn），语言真源 = VS Code 显示语言；键命名契约与机检判据（条数以 verify-nls 自检清单为准）；运行时 UI 分切片推进（切片 1 只做元数据面，半本地化边界如实登记）
---

# ADR-042 · package 面本地化（默认英文 + zh-cn + 机检判据）

> **状态**：✅ 已接受
> **日期**：2026-10-30（`HOST-I18N-1` 切片 1 落地时定案）
> **定案真源**：本 ADR + `hosts/memora-vscode/scripts/verify-nls.mjs`（判据）
> **关联**：ADR-VC-001（VS Code 插件宿主）、ADR-032（门禁所有权闭环）
> **前身过程稿**：`docs/方案-宿主本地化-20261022.md`（切片 2-4 的落地操作手册，决策以本 ADR 为准）

## 背景

0.4.0 之前，宿主 `package.json` 的命令标题、配置描述、视图名**全是中文硬编码字面量**，仓库内无任何 `package.nls*.json`。后果不是「体验不佳」，而是三类结构性缺陷：

1. **Marketplace 元数据对非中文用户不可读**——扩展详情页与命令面板全是中文，等于对英文用户关上了门。
2. **`%key%` 是字符串替换，不是编译期检查**。键拼错、键面两侧不等、翻译文件被 `.vscodeignore` 排掉——VS Code 一条错都不报，它会把 `%key%` **原样显示在命令面板和设置页上**。这类缺陷没有红，只有用户看到。
3. **文案改动没有配对机制**。命令标题、配置描述在仓库里只有一份中文，改一次不涉及任何「另一侧要不要同步」的强制动作。

第 2 条是本 ADR 存在的主要理由：一旦引入 nls，就同时引入了「静默失效面」，必须有能红的判据兜住。

## 决策

1. **用 VS Code 原生机制，不自建语言开关、不自建字典。**
   `package.nls.json`（默认语言）+ `package.nls.zh-cn.json`（中文）+ `package.json` 里的 `%key%` 占位。语言真源 = VS Code 显示语言（`vscode.env.language`），不新增 `memora.language` 配置——那会造出第二套语言真源，并与「切语言需重启」的宿主行为分叉。

2. **默认文件必须是英文，中文只能进 `zh-cn` 文件。**
   这是原生机制的硬约束（默认语言文件没有语言后缀，不能设成中文）。因此本切片必然包含一次「中文原文 → 英文默认 + 中文译文」的**双写成本**，无法绕过。已知残余风险：守卫能守键面相等，守不住语义相等；文案改动必须成对提交，靠 review 与纪律而非机器。

3. **键命名契约（键即契约，禁止随手起名）。**
   - 顶层描述：`description`
   - 命令标题：`command.<命令 id 去掉 memora. 前缀>.title`
   - 配置描述：`config.<配置键去掉 memora. 前缀>.description`；数组项的子字段继续点分，如 `config.mcpServers.transport.description`
   - 视图名：`view.<视图 id 去掉 memora. 前缀>.name`
   - **品牌名与标识符永不进 nls**：`displayName`、视图容器标题、命令 id、配置键、`when` 子句、枚举值一律保持字面量。翻译标识符是功能伤害，不是本地化。

4. **机检判据 = `scripts/verify-nls.mjs`，全部对真实文件断言。** 判据编号与条数以脚本内 `--self-test` 清单为准（本 ADR 不抄数量快照——增删判据即过期，见「描述性计数 = 时点快照」纪律）。
   ① 引用闭合（每个 `%key%` 两侧都有定义）② 键面相等（两侧键集合完全相同）③ 无孤儿键（nls 有、manifest 未引用 = 僵尸译文）④ 默认文件不含 CJK（中文混进默认文件 = 英文用户看到中文）⑤ 本地化面无中文残留（命令/配置/视图三面出现 CJK ⇒ 忘了走 `%key%`）⑥ 无空值 ⑦ 射程下限（命令数与配置项数不得低于基线——防 `contributes` 结构漂移导致遍历静默变空集而「全绿」）。
   ⑧-⑮ 为切片 2 起的 bundle / 窗口面判据（bundle 键面相等、源码 `t()` 键全覆盖（动态键源以 `@nls-keys` 标记收录，不锚变量名）、无孤儿、译文非空、`t()` 首参须静态字面量、窗口面中文残留（QuickPick / 开框 / 输入框 / 状态栏 / CodeLens 全扫）、已迁移模块登记完整、动态键源标记不塌空）。
   判据⑦ 是必须的：①②⑤ 全都以「遍历 manifest」为前提，结构一改名，它们会一起变成空集然后报绿。⑭⑮ 同理，是「防扫描面塌空」的同族下限判据。

5. **闸门两处都挂。**
   `package.json#scripts.package`（vsce 打包前）+ `scripts/local-ci.mjs` 的 full 档步骤 `host:manifest`。只挂打包链 ⇒ 日常提交永不触发，等于「有实现 ≠ 会跑」。

6. **清单守卫同步扩白名单。**
   `verify-package-manifest.mjs` 的 `ALLOWED_EXACT` 加两个 nls 文件（白名单是契约，不是误报），并把两者列入 `REQUIRED_ENTRIES`——默认文件缺失 ⇒ 全员看到 `%key%`；中文文件缺失 ⇒ 中文用户界面退化英文，都是打包前必须红的缺陷。

7. **本切片范围钉死为 package 面。**
   运行时 UI（webview 文案、通知、确认卡、协议 DTO）**不在本切片**。半个本地化必须如实登记为「半本地化」，写进 CHANGELOG，不许当成「已支持英文」。

## 边界与不做

- **不做 `memora.language`（UI 语言开关）**：UI 语言真源只有一个 = VS Code 显示语言。原生 NLS 按显示语言取文件、运行时无法被配置项改写 ⇒ 自建开关只会造出「设置了但界面不变」的静默失效。**注意区分**：`memora.answerLanguage`（`HOST-I18N-LLM-2`）**不是** UI 开关——它只决定注入给模型的回答语言指令，不改任何界面文案，见下条边界。
- **不假设 `zh-tw` 自动回落 `zh-cn`**：VS Code 按 locale 精确取文件，要覆盖繁中需另给 `zh-tw` 并真机验证。
- **Marketplace README 不随语言切换**：原生无此机制，不做第三方翻译扩展。
- **角色包、提示词、工具描述不翻译**：模型可见内容，语言影响模型行为，属功能而非外观。
- **日志保持中文**：内部事实，不属 UI。
- **AI 回答语言联动不是本 ADR 的 UI 本地化机制**（`HOST-I18N-LLM-1`，2026-11-09 独立落地）：
  走 `HostEnvironmentInfo.responseLanguageDirective`（宿主按 `vscode.env.language` 产出、
  内核零解释转发），与 `package.nls*` / `l10n bundle` 两套字典完全分离；两者只共用
  `vscode.env.language` 这一个真源，机制互不夹带。方案 §7「AI 回答语言与 UI 语言分开」
  在此兑现为**机制分离、真源唯一**，不是把两件事焊进一个开关。
- **回答语言的两级语义（`HOST-I18N-LLM-2` 追加，2026-11-09）**：
  ① **软默认** = 界面语言只作锚点，指令里同时写「若用户本轮用其他语言提问则跟随」——
  只写「请用 X 回答」会把用户主动改用英文的提问也拽回 X，且本仓 system prompt（角色包 /
  工具描述 / UI 消息）整体中文，纯靠模型猜语言在短消息与贴英文报错时会失准；
  ② **硬指定** = `memora.answerLanguage` 自由文本（空 / `auto` = 不覆盖），填了即优先于
  界面语言、不再让位。自由文本而非枚举：语言是开放集合，枚举每加一种都要改代码 + 翻标签，
  与本 ADR「未来加语言只改一处」的取向相反。该项**只喂那条指令**，不参与 UI 本地化，
  也不构成第二套真源（判定唯一在 `buildResponseLanguageDirective`）。

## 后果与残余风险

1. **半本地化**：英文用户在 Marketplace 与命令面板看到英文，进入面板后仍是中文界面。这是本切片有意接受的取舍，必须在 CHANGELOG 写明，否则属误导性半成品。

2. **⚠️ 运行时提示里硬编码了命令标题字面量（本 ADR 定案时发现的真耦合）。**
   `addToChat` 与 `registerWork` 的守卫提示，文案里直接写着「请右键选择『Memora: 添加到对话』」这类**菜单标题原文**。中文 locale 下 nls 解析出的标题与它一致，故当前不构成错误；但一旦切片 2 把运行时文案倒成英文，这些提示就会**指路指错**（提示说 A，菜单显示 B）。切片 2 落地前必须把这些字面量改为引用同一个 nls 键，而不是再抄一遍标题。

3. **长配置描述的英文信息密度低于中文原文。** 如 `mcpServers` / `mcpToolAllowlist` 两条安全说明，中文用分号断句承载了多层限定，英译在同等篇幅下更松散。这类文本的英译需人工校对，不能当成机械替换的产物。

4. **两条描述引用了 mcp-setup 文档**（位于 `docs/` 目录），而 `docs/**` 被 `.vscodeignore` 排除——该路径在安装包里不存在，对市场用户是可读但不可达的指引。属既有缺陷、与本切片正交，单独登记不下沉进本 ADR。

5. **回答语言联动落地不改变半本地化结论**（2026-11-09，同日随切片 2 落地更新）：
   `HOST-I18N-LLM-1` 之后，英文 VS Code 用户会得到英文回答指令；同日切片 2（宿主运行时面）
   落地后，**窗口通知 / QuickPick / 开框 / 状态栏**按 locale 走 `l10n.t`，`CHINESE_MESSAGES`
   有损镜像已删（前置批），但**进入 webview 面板后界面仍全中文**——切片 3-4 未动。
   这不构成「英文用户可用」的证据，不得在 CHANGELOG / 市场描述里宣称已支持英文。
   未来加日语是**两件事**：回答语言在宿主 `DIRECTIVE_BY_LOCALE` 加一条即可；
   界面语言须按切片 2-4 补 `bundle.l10n.ja.json` / `package.nls.ja.json`，二者不得互相替代。

## 落地与销项

- 切片 1（package 面）已落地：两份 nls 文件 + 46 个 `%key%` + 机检判据 + 打包白名单。
- 切片 1 真机两态验收：随 `HOST-I18N-LLM-1` 真机验证（2026-11-09）顺带确认——`en` 下扩展描述 / 命令面板 / 设置描述走英文，`zh-cn` 下走中文。
- **三拍板项已答（2026-11-09，方案 §8 同步）**：① 做全切片 1-4（目标 = 英文用户真可用）；② 接受源码倒英文 + `l10n.t()`（原生机制前置条件）；③ 覆盖 `zh-tw`（单独 bundle，避免「简体界面 + 繁体回答」混搭）。
- 切片 2（宿主运行时）→ 3（webview 静态模板）→ 4（webview 动态脚本）按过程稿的操作指点分片推进，各自独立提交与验收；本 ADR 不预先承诺它们的时间点。
- 切片 2 范围内已定案的两条实现决策：**运行时提示嵌命令标题**用「占位符 + 读 `package.nls.<locale>.json` 解析」实现同源引用（VS Code 无运行时取标题 API，`packageJSON` 返回未解析原始值）；**bundle 不引入 `@vscode/l10n-dev`**（生成工具降级为手工维护 + 键面三面对账守卫：源码 `t()` 键集合 = 默认 bundle 键集合 = zh-cn bundle 键集合，漏键即红）。
- 切片 2 宿主面代码已落地（2026-11-09）：l10n 管线骨架（manifest `"l10n"` 声明 + 双 bundle + `verify-nls.mjs` 判据 ⑧-⑮）+ `host/manifestNls.ts` 标题解析（三命令：addToChat / registerWork / toggleResidentRule）+ 宿主窗口面 `l10n.t` 化（含 QuickPick 标题占位 / 开框标题 / CodeLens 标题 / 状态栏文案）+ `CHINESE_MESSAGES` 按 `vscode.env.language` 供给；**前置批已修**：删除宿主 `interrupted` / `reflectionHint` / `selfReviewPrompt` 有损镜像（走内核默认）、`kernelResultNotice` 的 `reason` 改为从 `Agent.works` 方法返回类型推导（内核扩码即 tsc 红）；遗留（`zipImport.ts` / `shared/errorText.ts` 双消费者 / 间接传参盲区 / `MemoraError.format()` 中文正文）登记台账 HOST-I18N-2；**切片 2 真机验收已通过（2026-11-09，en / zh-cn 两态重启冒烟，含真机反馈收口批复验）**，zipImport 批与切片 3-4 继续按台账推进。
- 真机反馈收口批（2026-11-09 第二批，用户截图实证英文界面弹内核中文回执）：**窗口面与 webview 面分界拍板**——内核回执到窗口通知**不透传散文**，宿主按结构化 `reason` 码本地化渲染（`workProjectionBridge.kernelResultNotice` 单点，未知码原文兜底 fail-visible）；内核散文仍是聊天/工具回执面的文案真源（零内核改动）。同批补窗口面遗漏（恢复初始状态 modal / 图片限额 / 插话上限 / 流内错误实时路）+ verify-nls 采集器补转义还原（多行键假红修复）。宿主经 post 送 webview 的通知串归切片 4（面板中文语境下混排即撒谎）。
