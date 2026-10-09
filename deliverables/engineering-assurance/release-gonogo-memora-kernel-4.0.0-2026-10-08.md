# memora 内核 4.0.0 发版前综合审查（SSOT 不带伤 + 文档对齐 + Go/No-Go）

**日期**：2026-10-08
**工作流**：工作流 1（综合代码审查）× 工作流 4（部署前检查）组合
**参与成员**：Cody（代码审查）/ Archi（架构）/ Tessa（测试）/ Docu（文档），主理人 Zhen 汇编
**审查对象**：内核 `@zooique/memora` 自 tag `memora@3.0.1`（2026-09-30）→ HEAD `fa461023`：144 提交，51 个触及 `src/`，59 文件 +8080/-609。宿主忽略（仅作消费证据源）。
**方法**：四位成员独立实证（grep/Read/git 对象库/变异验证），不采信既有报告摘要；主理人交叉复核关键结论；结论冲突以证据链仲裁。

---

## 📌 TL;DR（执行摘要）

- **整体结论：架构与代码的 SSOT 修复大体闭环、方向正确（有条件 Go），但发布凭据（随包文档 + CHANGELOG + 版本号）存在 5 条硬阻塞，当前状态 No-Go。** 清完 B1–B5 即可 Go。
- 严重度分布：🔴严重 5 项（全部集中在文档/发布凭据）/ 🟠高 12 项 / 🟡中 10 项 / 🟢低 3 项。
- 最重的新发现：①CHANGELOG 自称"移除 53 个导出"，实测 **55 个，漏登 4 个**（含 2 个值导出，外部 import 直接编译红）；②随包接入指南 :239 给消费者一段**调用已删 API 的编译不过示例**；③`memoryInspector` 删 5 条用例时"未丢覆盖"的提交声明**被变异验证证伪**（截断常量 120→60 全绿）。
- 测试/守卫侧全部放行：4 个新守卫经 15 次变异验证**全部能红、无假绿**；`PRODUCER_FILES` 差分为空集。
- 流程事故 1 起（共享工作树并发变异污染）已闭案，裁决固化为「变异验证仓库外隔离 + 串行」。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| 整体评级 | 🟡 **有条件通过** —— 架构 Go、代码 Go、测试 Go、**文档 No-Go**；清 5 条阻塞后整体 Go |
| 阻塞项数量 | **5**（B1–B5，全部为文档/发布凭据，无一代码阻塞） |
| 关键行动项 | 9 条（见行动清单） |
| 建议下一步 | 先清 B1–B5（约半天工作量）→ 重跑 `docs:links` + `publicApiSurfaceGuard` → 跑完整发布门禁 → bump 4.0.0 → 双远端发版 |

---

## 🔍 审查发现（按严重度排序，去重合并后 30 项）

### 🔴 阻塞级（B1–B5，清零才能发版）

| # | 严重度 | 类别 | 文件:行 | 问题描述 | 实证 evidence | 建议修复 | 来源 |
|---|--------|------|---------|---------|--------------|---------|------|
| B1 | 🔴P0 | 死条目 | `docs/memora-接入指南.md:239` | 随包文档给出**编译不过的示例代码**：`const hits = agent.memory.search('世界观');` —— 该方法已随 `f552695e` 物理删除，且示例连 `await` 都没有（替代 API 返回 `Promise`） | `git show f552695e`（commit 带 `!` + `BREAKING CHANGE:` footer）；`searchByKeyword` 签名 `Promise<AgentSearchHit[]>`（api-ref:425） | 改为 `const hits = await agent.memory.searchByKeyword('世界观');` | Docu+Cody 双重坐实 |
| B2 | 🔴P0 | 死条目 | `docs/memora-接入指南.md:451` | API 速查表仍列 `search()`：`agent.memory.snapshot()/search()/writeXxx()` | grep 实证 | 改为 `snapshot()/searchByKeyword()/writeXxx()` | Docu |
| B3 | 🔴P0 | Breaking漏登 | `CHANGELOG.md`（内核区 9–403 行） | **4.0.0 三条最重磅破坏性变更零收录**：删 `search()`（`f552695e`）、错误码收口单一构造点（`6ce81139`）、公共面守卫（`536c54fa`）；另有 5 个小提交未收录。**commit 自带 BREAKING CHANGE footer 却未登账** | 对内核区 grep `search()/errorCode/publicApiSurfaceGuard` 命中全 0；`git show f552695e --format=%B` 含 BREAKING CHANGE | 补 3 条 Breaking + 1 条 Added（草稿见附录 A） | Docu+Archi |
| B4 | 🔴P0 | 版本口径分裂 | `CHANGELOG.md:3,9,11,13,48,77,108,306,314,326,335,351,358,381` × `package.json:3` × `docs/*:1` | **版本号三处分裂**：CHANGELOG 13+ 处「已定档 3.1.0」、`package.json` 仍 `3.0.1`、API 手册标题却写 v3.0.0 且正文写「已于 4.0.0 移除」——同一批发布物给出三个互相矛盾的版本号。SemVer 上删 55 导出+删方法是 major，标 minor = 对消费者谎报兼容性 | `grep -c "4\.0\.0" CHANGELOG.md` = **0** | 13 处 3.1.0→4.0.0（逐行清单见附录 B）+ bump `package.json` + 统一文档标题；⚠️ `CHANGELOG.md:880` 的 3.1.0 是历史决议留档，**不改** | Docu+Archi |
| B5 | 🔴P1 | 清单对账 | `CHANGELOG.md:20-38` | 「53 个移除清单」与实测不符：**实际移除 55，漏登 4，误报 2**。漏登：`validateManifest`（值）、`WorkProjectionManager`（类值）、`RolePackAssembly`、`ProcessMetricsPayload`——前两个是值导出，外部 import **直接编译红**。误报：`BackgroundTaskStatus`/`COMPRESS_TARGETS` 在 3.0.1 导出面上不存在（系 3.0.1 后新增→`b69f85ff` 收回），不构成 3.0.1→4.0.0 breaking | `git show memora@3.0.1:src/index.ts` 逐符号核对（Docu、Archi 两条独立路径同结果）；宿主 84 个真实 import 与移除集**零交集**（无实际伤害，但凭据必须诚实） | 重写清单：「51 实移（3.0.1 起）+ 4 漏登补登 + 2 曾短暂挂面后收回（注明来源 commit）」；:301 的 `BackgroundTaskStatus` 补回改标注（**勿删**，那是真实历史） | Docu+Archi 双重独立坐实 |

### 🟠 高优先（强烈建议随本版同批清，不硬阻塞）

| # | 严重度 | 类别 | 文件:行 | 问题描述 | 建议修复 | 来源 |
|---|--------|------|---------|---------|---------|------|
| H1 | 🟠P1 | 真文案 bug | `src/agent/backgroundTasks.ts:326` | `timedOut` 状态产出自相矛盾文案：`[后台命令完成] taskId=bg-1 · 超时被终止`——首标签说"完成"，同行词表说"超时被终止"；测试只断言 `toContain(LABELS.timedOut)` 放行了矛盾 | 通知首标签与 `BACKGROUND_TASK_STATUS_LABELS` 同源派生（如 `Record<Status,{noticeTag,label}>`），测试补「首标签不得与 label 矛盾」断言 | Cody |
| H2 | 🟠P1 | 注释失实 | `src/agent/backgroundTasks.ts:12` | 模块头自称「内核内部模块：不进 src/index.ts 公出面（宿主零消费）」——与事实相反（该文件恰有 2 个公共导出且宿主真实消费 `hosts/.../chatPanel.ts:51,3695`） | 改为如实稿：「只出只读投影类型+状态词表；注册表类不导出（导出类会让宿主跨会话 kill）」 | Cody |
| H3 | 🟠P1 | 注释失实 | `src/agent/loop.ts:3449` | 注释仍称「ERR 前缀保留在包裹内，供 `isRetryableToolError` 识别」——该文本判据路径已在 `6ce81139` 物理消失（生产唯一调用点 `loop.ts:1792` 读 outcome），与刚订正过的 `toolExecutor.ts:1630` 同型残留 | 改注为「包裹仅为隔离间接注入，此文本不承担任何判据职能」 | Cody |
| H4 | 🟠P1 | 覆盖静默丢失 | `src/agent/managers/memoryInspector.test.ts` | `f552695e` 删 5 条用例时提交信息与代码注释均宣称「未丢覆盖」，**变异证伪**：`SEARCH_PREVIEW_LEN` 120→60 后 143 用例全绿（「120 截断」零守护）；未继承 3 条：纯空格 query 抛错、非整数 limit 抛错、`toHaveLength(121)` 精确断言+「短内容不截断」反面 | 补 3 条用例（同文件 `memoryAdvisor.test.ts:319-344` 有现成三段断言范式可抄）；并在台账/发布说明订正「未丢覆盖」的说法——否则留下「文档主张>事实」先例 | Tessa（变异实证） |
| H5 | 🟠P1 | 守卫无删除闸 | `src/__tests__/publicApiSurfaceGuard.test.ts:160-184` | 守卫对「**增**」有双向闸（加未登记导出→A 向红；加幻影→B 向红，Tessa 变异实证），但对「**删**」无闸：B 向 `existsInSrc` 是全 src 词边界匹配（`:136`），符号定义还在 src 就算"存在"——删 55 个导出全程绿。**下一个 major 仍会无声删一批导出** | 补 C 向断言：手册 §十六 承诺的模块级符号必须仍在 `parsePublicSurface()` 结果中（Agent 实例成员走显式豁免名单） | Archi 提出，Tessa 交叉确认（B 向判据读源码坐实） |
| H6 | 🟠P1 | 漏文档 | `docs/memora-api-reference.md:617-627` | §8.1 内置工具表缺 `run_command`/`kill_command`（`toolExecutor.ts:486-487` 默认常驻开放）；接入指南全篇 grep 后台任务/命令执行 0 命中 | §8.1 补两行（含 deny/ask/allow 三层护栏）；接入指南速查补两行并指向 §8.7 | Docu |
| H7 | 🟠P1 | 幻影配置 | `config.example.json:26-32` | `llm.background` 示例键内核根本不读（`loader.ts:45-49` 仅 `providers?/active?`，全树 grep `background` 零命中） | 删除该块或注明「预留、当前不消费」 | Docu |
| H8 | 🟠P1 | 边界越界 | `src/skill/skillScriptRunner.ts:413,517-521` | 内核注释内嵌宿主文件路径要求跨仓同步（shell 映射双源靠人工）；`runSkillScript(nodePath?)` 自承「宿主零注入点、恒走缺省」却保留参数，且同段详述 VS Code Electron 知识——与该注释自述的「内核不持有平台知识」铁律直接冲突 | shell 事实改由既有 `IEnvironmentProvider` 通道上报；删未接入的预留参数或登记带退出条件 | Archi |
| H9 | 🟠P1 | 约定无守卫 | `toolCallHelpers.ts` / `toolFailurePrefixGuard.test.ts` | 「failed outcome 带码才能进 Reflection」这条约定没有守卫——`failedOutcome(` 生产 21 处无白名单钉死，新增无码失败不红 | 加「`failedOutcome(` 调用点清单」对账断言（当前 12 emit + 4 主链路），新增点即红，迫使作者显式决策带码/不带码 | Tessa+Cody |

### 🟡 中优先（登记观察项，不阻塞 4.0.0）

| # | 类别 | 位置 | 问题 | 来源 |
|---|------|------|------|------|
| M1 | 守卫承诺失实 | `publicApiSurfaceGuard.test.ts:13` | 头注释称「变异验证见文件尾」，185 行文件里无此段——注释描述不存在的内容（项目已知复发形态） | Archi |
| M2 | 守卫边界 | `publicApiSurfaceGuard.test.ts:119-143` | B 向只扫 §十六 区间；§十六外 231 个 backtick token 有 12 个 src 不存在（多概念词，实害低）；README 20 个同理。建议守卫头注释登记「§十六区间外不受约束」为已知边界 | Tessa+Cody |
| M3 | 文档侧缺口 | 公开面四集合分析 | **50 个公共导出（32.5%）仅靠宿主消费、零文档提及**——文档漏写它们守卫静默（判据本是"消费 OR 承诺"，非缺陷，但消费者视角是缺口）。名单已备好可交 Docu | Tessa |
| M4 | 文法盲区 | `toolFailurePrefixGuard.test.ts:201` | 首标签文法只认全大写蛇形，`[Context summary of earlier conversation]` 等 2 处既不在扫描面也不在排除清单（实害低：非工具结果通道） | Cody |
| M5 | 命名误导 | `src/security/confirmEntries.ts` | 键集双向相等只对账 `OPAQUE_WRITE_TOOL_NAMES`（执行面），**写入确认闸不在表内**；模块名易被读成「全部确认入口 SSOT」。改名 `executionConfirmEntries` 或头注释首行明示 | Archi |
| M6 | 死分支 | `src/role-pack/strategyKeys.ts:199` | 「防御分支：check 无 range 的数值键（当前无此类键）」——建议编译期穷尽或删除 | Archi |
| M7 | 判据措辞 | `backgroundTasks.ts` | 「只出类型不出类」真实判据是「宿主是否真实 import」而非「实例级」（同为实例级的 `RolePackManager` 就出了类）；防后人按后者推错 | Archi |
| M8 | ADR 缺口 | `.trae/decisions/` | B4 口径变更、B5 判据桥退役、ToolOutcome 三值契约、REL-3.1 挂面判据均无 ADR；决策依据落在**不随包发布**的方案文档里——外部消费者拿到 breaking 看不到 rationale | Archi |
| M9 | 契约不上面 | `toolCallHelpers.ts:198-219` | 4.0.0 头号新契约 `ToolOutcome` 未挂 `src/index.ts`，宿主无法类型安全消费（现状与判据自洽，但与「头号契约」定位不匹配，二选一：挂面，或在 Breaking 条目写明「内部契约」） | Archi |
| M10 | 无码失败语义 | `toolExecutor.ts:1254/1508/1575/1676` | 四条命令/脚本主链路失败全走无码路径 ⇒ **Reflection 恒不触发**。经 Tessa 文档链仲裁：三份设计文档零处承诺可重试，**属设计口径非回归**——LLM 看到错误文本自行决定重试。但此决策只存在于不被发布的文档里，建议在 api-ref §14 显式写明「执行类失败不进自动 Reflection」 | Cody 发现 → Tessa 仲裁 |

### 🟢 低优先

| # | 位置 | 问题 | 来源 |
|---|------|------|------|
| L1 | `memoryInspector.ts:133` | `list()` 注释用已删名 `search()` 描述现行行为（**同文件 186-189 的退役注是合规范畴，勿一刀切删**） | Cody |
| L2 | `README.en.md:274-284` | EN 缺角色包指南链接与示例角色包节；`## Why Memora?` 标题重复 | Docu |
| L3 | `config.example.json:35` | `dataDir: "~/.memora"` 与 api-ref:1259「内核不假设用户级默认位置」矛盾，改占位路径 | Docu |

---

## ✅ 正面确认（可放行的部分，均有实证）

| 项 | 实证 | 来源 |
|---|------|------|
| 4 个新守卫全部"能红"、无假绿 | 15 次变异验证，唯一全绿的是有意边界（新错误码自动跟随真源）；`toolFailurePrefixGuard` 五层冗余最硬 | Tessa |
| `PRODUCER_FILES` 完备 | 全树独立差分 = ∅；四处手写字面量（READONLY_DENIED/PERMISSION_DENIED/ABORTED×2）均被登记钉住（A3 变异从反面证明） | Tessa |
| `errorCode` 优先分支有专门变异守卫 | 禁用该分支 → `toolCallHelpers.test.ts:223` 专设用例转红 → 还原转绿 | Tessa |
| confirmEntries 单源名副其实 | 键集与 `OPAQUE_WRITE_TOOL_NAMES` 双向相等；四执行面逐一实证走登记入口；`ConfirmingEntry` 类型化让误接编译期红 | Archi+Cody |
| backgroundTasks「只出类型不出类」一贯 | 唯一 `new` 在 `assembler.ts:683`（Agent 实例装配），无模块级单例 | Archi |
| 宿主零改动实证 | 55 个移除符号与宿主 84 个真实 import **零交集** | Archi |
| 错误码枚举文档逐值对齐 | api-ref §14.1 十值 == `errors.ts:24-52` 十值；`TOOL_TIMEOUT` 死条目已订正 | Docu |
| 静态门全绿 | `tsc --noEmit` EXIT=0（Cody 复现）；针对性 vitest 192 passed | Cody |
| SSOT 教科书范本 4 处 | `confirmEntries` 类型化判据 / `failedOutcomeWithCode` 同源产出 / guard 扫描面完整性断言 / `terminate(mode)` 必传参消灭默认值 | Cody |

---

## 🚦 Go / No-Go 决策

| 维度 | 判定 | 依据 |
|------|------|------|
| 架构/契约 | 🟢 Go | 4.0.0 名副其实：55 移除+8 新增全部真实、成批；无 deprecated 留壳；宿主零改动 |
| 代码质量 | 🟢 Go | SSOT 修复闭环（带伤1 已修、判据面结构化）；残留 4 处失实注释 + 1 个文案 bug（H1–H3），非阻塞 |
| 测试/守卫 | 🟢 Go | 4 守卫能红无假绿；仅 1 条覆盖静默丢失（H4，3 条用例可补） |
| **随包文档** | 🔴 **No-Go** | B1（编译不过的示例）+ B3（漏登 Breaking）+ B4（三处版本号互相矛盾）——发出去即对消费者说谎 |
| **整体** | 🟡 **有条件 Go**：清完 B1–B5 → 重跑 `docs:links` + `publicApiSurfaceGuard` + 完整发布门禁 → 发版 |

**回滚方案**：4.0.0 发版后若发现重大问题，npm `dist-tag` 回指 3.0.1 + 双远端 revert 提交；`search()` 删除无灰度路径（方法已物理不存在），回滚即整包回 3.0.1。

---

## ✅ 行动清单（按优先级）

| # | 行动 | 负责角色 | 紧急度 | 预期工作量 |
|---|------|---------|--------|-----------|
| 1 | B1+B2：接入指南 :239/:451 改 `searchByKeyword`（含 `await`） | Docu | P0 | 10 分钟 |
| 2 | B3：CHANGELOG 内核区补 3 条 Breaking + 1 条 Added（附录 A 草稿） | Docu | P0 | 30 分钟 |
| 3 | B5：重写 CHANGELOG:20-38 移除清单（51+4+2 口径）+ :301 补回改标注 | Docu | P0 | 20 分钟 |
| 4 | B4：13 处 3.1.0→4.0.0 + bump package.json + 统一文档标题（附录 B） | Docu | P0 | 20 分钟 |
| 5 | H1：backgroundTasks 通知标签同源化 + 矛盾断言 | Cody | P1 | 30 分钟 |
| 6 | H2+H3：订正 backgroundTasks:12 / loop.ts:3449 两处失实注释 | Cody | P1 | 10 分钟 |
| 7 | H4：补 3 条 memoryInspector 用例 + 台账订正「未丢覆盖」 | Tessa | P1 | 30 分钟 |
| 8 | H5：publicApiSurfaceGuard 补 C 向（承诺面 ⊆ 公开面）断言 | Tessa | P1 | 1 小时 |
| 9 | H6–H9 + M1–M10：按表登记进 `tasks/待完成任务.md`，随下版本清偿 | 主理人归档 | P2 | 台账登记 |

**发版门禁（清完 1–4 后执行）**：内核 tsc/eslint/全量 vitest（先数 AssertionError 判假红）→ 清 dist 重建 + tsc-alias → 宿主 rebuild → `verify-dist-contract` 同代 → `check-publish-links` → 台账销项 → tag `memora@4.0.0` → gitee+github 双 push → npm publish。

---

## ⚠️ 待完善 / 已知局限

- **变异污染事件（已闭案）**：审查期间共享工作树出现并发变异（秒级改-还原窗口），一度使"绿→破坏→红→还原→绿"取证链失效。裁决：变异验证全员串行、锁与探针目录移出仓库根（`%TEMP%/memora-mutation/`）、每条变异附 `git status` 前后快照。泰莎最终报告全部条目以"亲手变异+亲手还原+快照"为准；因污染重跑过的 3 条已标注。
- **未复跑的门**：全量内核 vitest（~7 分钟，环境假红定性方法已由历史门禁报告与本次针对性测试双重复核）、build/dist 链、宿主 57 文件全量——清完阻塞项后的正式发布门禁仍须完整跑一遍，本报告不替代。
- **主理人未独立重算**：55/8 导出全表采信两条独立路径互证（Docu 逐符号 × Archi diff 全表）；`PRODUCER_FILES` 差分采信 Tessa 独立脚本。若需第三重复核可再开工作树验证。
- **流程偏差登记**：多库→阿奇发生一次成员直连同步（结论经主理人复核有效，但违反"信息流经主理人中转"纪律，下不为例）。
- **工作树卫生（发版前需用户定夺）**：`hosts/memora-vscode/package.json` 有未提交修改（+`"icon": "resources/icon.png"` 一行）及一批未跟踪 icon 资源——属宿主侧动作，不阻塞内核发包，但「工作树干净」门禁前需提交或还原。

---

## 📚 数据来源 & 成员产出索引

- **Cody（代码审查师）**：11 条问题 + 历史报告逐条复核（带伤1/2 修复坐实，带伤3/修复4 部分坐实）+ 正面范本 4 处；独立复现 tsc EXIT=0。
- **Archi（架构师）**：导出面 3.0.1→HEAD 全表（201→154，移除 55/新增 8）+ 半吊子四形态逐项判定 + 4.0.0 Breaking 官方清单草稿 + ADR 盘点；反驳"锁方案"并给出 worktree/仓库外隔离的更硬方案（被采纳）。
- **Tessa（测试专家）**：15 次变异验证全记录（4 守卫全部能红）+ memoryInspector 覆盖损益变异实证 + 四集合公开面分析（154=70 文档承诺+34 双覆盖+50 仅消费+0 无覆盖）+ PRODUCER_FILES 差分 ∅ + 对"四主链路无 Reflection"的设计口径仲裁（三份文档证据链）。
- **Docu（技术文档师）**：随包 12 文件逐项对账 + 死条目全枚举（§十六 116 token 零幻影；接入指南 2 处 + CHANGELOG 1 处幻影）+ CHANGELOG 13 处口径改写清单 + 4.0.0 条目草稿 + 自我修正（#5 幻影→口径未回改）。
- **主理人（Zhen）**：变更盘点（144 提交/51 src/59 文件）、独立复核（守卫源码 :144-184 读判、错误码产出点 grep、loop.ts:1792 判据面确认、接入指南:239 与 CHANGELOG:301 复核）、并发变异裁决与修订、结论冲突仲裁、交叉汇编。
- 历史参考（**未采信摘要，仅作线索**）：`deliverables/内核4.0.0发布前审计-20261007.md`、`deliverables/内核4.0.0-SSOT不带伤修复-20261008.md`、`deliverables/内核4.0.0-发布门禁结果-20261008.md`。

---

## 附录 A：CHANGELOG 需补的 3 条 Breaking（草稿）

```
### ⚠️ Breaking（内核 · 记忆搜索唯一入口收敛：删除已退役的 MemoryInspector.search() · f552695e）
- 删除 agent.memory.search(query, limit?)（同步），含其 5 条测试。唯一入口 = searchByKeyword()
  （Promise，需 await；能力超集：superseded 过滤 / excludeRoundIds 互斥 / accessedAt 刷新）。
- 迁移：agent.memory.search(q, n) → await agent.memory.searchByKeyword(q, n)。

### ⚠️ Breaking（内核 · 工具错误码收口为单一构造点，重试分类改读结构化字段 · 6ce81139）
- ToolOutcome 新增 errorCode?: ToolErrorCodeValue；带码失败一律走 failedOutcomeWithCode(code, detail)，
  文本 [ERR:TOOL:XXX] 前缀由 errorCode 派生，单一构造点同源产出一次。
- isRetryableToolError 优先读 outcome.errorCode，无码才回退解析文本前缀（兼容路径）。
- 新增枚举值 NOT_AVAILABLE（不可重试：缺的是宿主装配，重试空转）。

### Added（内核 · 公共导出面双向机器对账守卫 · PUBLIC-API-SURFACE-1 · 536c54fa）
- 向 A：公开面 ⊆ 宿主真实消费 ∪ README/手册§十六 承诺（防未登记公开）；
  向 B：手册 §十六 承诺符号在 src 真实存在（防幻觉文档）。
- 已知边界（登记）：B 向只扫 §十六 区间；「文档承诺但未挂面」暂无反向断言（见审查报告 H5）。
```

## 附录 B：版本口径改写清单（13 处 + 连带）

- `CHANGELOG.md` 行 3/9/11/13/48/77/108/306/314/326/335/351/358/381：`3.1.0` → `4.0.0`（行 9 建议直接改 `## [4.0.0] · 2026-10-08`；行 880 的 3.1.0 是历史决议留档**不改**）。
- `package.json:3`：`3.0.1` → `4.0.0`（发版动作）。
- `docs/memora-api-reference.md:1,7,1266` 与 `docs/memora-接入指南.md:1,5`：v3.0.0 → v4.0.0。
- `README.md:94`/`README.en.md:88`「版本定位（v3.0.0）」：**原句保留**（历史陈述）+ 追加「4.0.0：导出面收敛 55 项 + search() 退役，首个 major」。

---

> 本报告由工程保障团队 AI 协作生成（Zhen/Cody/Archi/Tessa/Docu），关键决策请由人类工程负责人（萧然）复核。
