# 方案 · HOST-CTX-4 第二笔 `@git-changes`：三路径拍板材料（2026-10-21）

> **状态：已拍板（2026-10-21）**——用户以「按照你的推荐思路拍板推进」指令采纳 §8 六项推荐全数（路径 C / 白名单含 --cached / 三道闸 20·200·12K / 建命名 SSOT 单点 / 缺口登记不引机制 / 信任类声明）。拍板结论已回写台账 HOST-CTX-4「二笔拍板记录」段（SSOT 在台账，本文保留推理过程备查）。
> 台账锚：`tasks/待完成任务.md` HOST-CTX-4 条目「二笔边界订正」段（2026-10-21 同批订正）。
> 上游定案：HOST-CTX-0「定案例外清单」四硬约束（有界 / 计预算 / 明示 / 不泛化）+ CTX-4 四问拍板定案（2026-10-21 采纳）。
> 本文回答一个问题：**第二笔到底做什么形态**——台账原标题写的是「`@git-changes`（未提交改动）」，即拍板意图本就是真 git 语义；2026-10-21 调查报告曾建议缩窄为「复用 fileChangeTracker 改名 `@改动`」，该建议建立在**假二选一**上（详见 §2 路径伤）。本文把第三路补回，交用户拍板。

---

## §1 问题定义与主场景

「改动」类上下文的高频场景（台账原文 + 报告共认）：

| # | 场景 | 谁产生了改动 |
|---|---|---|
| S1 | 「给我的改动写提交信息」 | **用户手动编辑**（+ 可能有助手改动） |
| S2 | 「解释我改了啥」 / 「审一遍我的改动」 | 用户手动编辑为主 |
| S3 | 「审一下你刚才改的」（memora-native 扩展场景） | **助手经工具落盘** |
| S4 | 混合一轮后「总结这轮改了啥」 | 两者都有 |

判据问题：**数据源覆盖谁，决定形态**。若数据源只看得到助手改动，S1/S2 交不出数据——这不是体验折扣，是能力真空（详见 §4 矩阵）。

## §2 事实底座（全部代码实证，2026-10-21 只读核实）

1. **`fileChangeTracker` 的口径（订正「本会话改动快照」表述）**：输入面只有三个——`noteToolStart`/`noteToolResult`（内核 `write_file`/`delete_file` 的 tool_start/tool_result 宿主事件，工具清单 `DISK_WRITE_TOOLS` 派生自内核 `WRITE_PATH_EXTRACTORS`）+ `noteExternalMutations`（脚本类工具执行前后工作区快照 diff）。**无编辑器事件订阅 ⇒ 用户手动编辑不在内**。且 `noteExternalMutations` 的目录快照 diff 会把脚本执行窗口内的用户手改 / 外部变更一并捕获（误归「助手改动」——面板场景可接受，注入场景 = 对模型撒谎，须信封明示边界）。记录含 `beforeContent`/`afterContent`（`fileChangeTracker.ts:44-60`）；`snapshotFiles()` 只返路径（`fileChangeView.ts:357`），注入要内容须 `tracker.get(absPath)`。
2. **diff 算法已就绪**：`fileChangeDiff.ts`（252 行纯逻辑，零 vscode 依赖）= 前缀/后缀裁剪 + 行级 LCS → `DiffHunk[]`，`MAX_LCS_LINES=1200` 降级。注入文本可复用，无需新写 diff。
3. **宿主 `spawn` 先例（第三路的存续依据）**：`environmentProvider.ts:41` = `spawn(command, ['--version'])`——**宿主自发探测、不经裁决链**、`PROBE_TIMEOUT_MS=5000`、`windowsHide`、ENOENT / 非 0 退出不上报。`codeExecutor.ts` 亦 spawn（内核 run_code 用）。裁决链边界实证：`classifyCommand` 唯一调用点 = `confirmCommandRun` ⇒ **只覆盖内核 `run_command`；宿主自发 spawn 不在链上**。
4. **协议成本实证（复刻 protocolGuard V-1 提取器实跑）**：消息类型现值 **128**；`InjectionSource` 联合扩员（+`git-changes`/`terminal`）→ **仍 128**；新增消息类型 → **129**。⇒ 二笔无论选哪条路，**协议 0 增量**（复用已落地的 `add_injection` / `input.injections[]` / `injection_summary`）。枚举扩员纪律 = protocol.ts:198-199 D6「不预建未落地的源」——随落地逐笔追加即合规。
5. **主流实证（2026-10-21 联网，报告与台账共记，本轮抽查复证两条）**：Roo `@git-changes` = `getWorkingState` 真跑 `git status --short` + `git diff` + `git diff --cached`（✅ 复证）；Cursor `@Commit`/`@Branch` 工作区 / 分支 diff（台账记）；Cline ❌（但其最新官方文档已把终端 / git 改述「描述即可，Cline 自己跑」——主流往代理自取迁移，与 A' 触发条件同向，不抢跑）。
6. **engines 地板**：`hosts/memora-vscode/package.json` = `^1.90.0`（与 terminal spike 的 1.93+ 前置相关，见台账 spike 四问；本笔不涉）。

## §3 三路径定义

- **路径 A「@助手改动」（缩窄交付）**：复用 `fileChangeTracker`，枚举建议 `assistant-changes`；发送时刻取 `tracker.list()` → 经 `fileChangeDiff` 产有界文本 → 信封块。零新依赖、零 exec。覆盖 = **仅助手经工具落盘的改动**。
- **路径 B「run_command git diff」（否）**：让模型跑 `git diff`——撞权限档 + 裁决链，且让模型侧绕路取本可宿主直取的数据。**否决，不进拍板选项**（登记理由防后人重提）。
- **路径 C「@git-changes 真 diff（推荐）**：宿主新建 `gitCollector.ts`（`problemsCollector.ts` 同形态：零 vscode 依赖、依赖注入式、可纯 node 单测），spawn 只读 git 子命令白名单（建议 `git status --porcelain` + `git diff` + `git diff --cached`，同 Roo 三口），用户挂载 chip 触发、**发送时刻取数**（CTX-4 ④）、三道闸有界、fail-closed 事实行。覆盖 = **全部未提交改动（用户手改 + 助手改动）**，与台账原标题「未提交改动」及拍板枚举名 `git-changes` 一致。

## §4 场景覆盖矩阵（拍板的核心判据）

| 场景 | A（tracker） | C（gitCollector） |
|---|---|---|
| S1 用户手改后「帮我的改动写提交信息」 | ❌ **tracker 为空**（主场景能力真空） | ✅ 全量未提交 |
| S2 用户手改后「审我的改动」 | ❌ 只有助手部分（若有） | ✅ |
| S3 助手刚写盘「审一下你改的」 | ✅ | ✅（未提交即见；已提交则无——与 A 同限） |
| S4 混合一轮「总结改了啥」 | ⚠️ 只见助手部分，信封须明示边界 | ✅ |
| 非 git 环境 / git 未安装 | ✅（tracker 不依赖 git） | ⚠️ fail-closed 事实行「当前不是 git 仓库 / 未检测到 git」 |
| 已提交后回顾 | ❌ | ❌（只取未提交；`@Commit` 类属另一题，不泛化） |

⇒ **A 是「审助手改动」专用工具，C 是「未提交改动」通用工具**。台账主场景（S1/S2）只有 C 交得出数据；A 的正当用法是给 S3 一个更便宜的形态（若拍 C，S3 被 C 覆盖，A 无存在必要）。

## §5 成本 / 风险 / 依赖对比

| 维度 | A | C |
|---|---|---|
| 协议 / 枚举 | 枚举 +1（改名 `assistant-changes`） | 枚举 +1（维持拍板名 `git-changes`） |
| 新代码 | tracker 读取 + 有界文本 ~100 行 | + gitCollector（spawn 封装 ~120-150 行：白名单 / 超时 / 编码 / 分文件解析 / 三道闸） |
| 新依赖 | 无 | git 二进制（fail-closed 兜底） |
| 执行面 | 无 exec | 宿主 spawn（**写死三边界：只读子命令白名单 / 用户挂载触发不可模型触发 / 禁 config·remote·commit 等写操作**——防 exec 先例外溢） |
| 主要风险 | 语义缩窄 = 承诺小于场景；用户可能误以为含自己的编辑 | ① diff 体量无天然上限 ⇒ 三道闸（建议：文件 ≤20、单文件 diff ≤200 行、合计 ≤12K token，截断明示——problems 同族）；② 多根工作区取首根（`relativeUnderPrimaryRoot` 同款先例）；③ 与裁决链文化的关系须拍板明示「**用户挂载触发的只读采集 ≠ 代理发起命令**」（getDiagnostics 同信任类） |
| 对齐拍板意图 | ❌ 缩窄（标题「未提交改动」、枚举 `git-changes`、S1/S2 主场景全部背离） | ✅ |

## §6 命名与 SSOT 前置（两路都躲不开，建议先行）

**命名散面实证**：`problems` 的可见名字活在 **4 处字面量**——QuickPick 关键字项 label + description（`chatPanel.ts:1065-1066`）、QuickPick placeholder 整句（`:1082`，label「诊断（问题面板）」内嵌其中）、chip/徽记 label（`chatView.ts:6195` `INJECTION_SEGMENT_LABELS` 表内 `problems` 项）、信封块头（`docContext.ts:41` `PROBLEMS_CONTEXT_OPEN`）。其中 chip/徽记两面已 SSOT 化（`INJECTION_SEGMENT_LABELS`，第一笔时的「短名双写」修复）；**QuickPick label / description 与信封头仍是独立字面量，placeholder 是内嵌 label 的整句（label 改而 placeholder 不改 = 下拉提示与实际选项对不上），均无编译器跨模块检查**。

**建议**：建 `shared/injectionSourceMeta.ts`（**值模块**，非 type——运行时常量禁入 protocol.ts，理由见 protocol.ts:236-240「值导入会打进 webview bundle」；`shared/refKey.ts` 同款先例），每源登记 `{ source、quickPick{label,description}、segmentLabel、envelope{open,close} }`，四处改读单点。**这是修模式再复制模式**（不带伤：第一笔已为「短名双写」付过一次代价）。

命名建议：C ⇒ source 维持 `git-changes`，用户可见 label「未提交改动（git）」；A ⇒ source `assistant-changes`，label「助手改动（本会话）」。**枚举值是协议载荷、label 是 UI 文案，两者分开拍**。

## §7 跨源总量兜底（缺口登记）

现状：每源各自有界（problems 20/200/12K），`injection_summary` 有 `total` 无 cap，上下文圆环显示总量但不拦截。二落地时二选一：① 定义总量软顶（超限按挂载序截断 + 明示）；② 显式登记为已知缺口（注释写死「按源有界 ≠ 总量有界」）。**建议 ②**（复杂度守恒：现有源总量 = 活动文件 3~4k + problems ≤12K + git diff 有三道闸封顶，圆环已可见；为假想超标引截断机制 = 第二套判据）。但 **C 的 diff 闸必须单独设**——git diff 是唯一无天然上限的源。

## §8 拍板记录（2026-10-21 已拍板，六项全数采纳推荐）

1. **路径 = C**（推荐采纳）。理由 = §4 矩阵 + §5 对齐行；A/B 否决理由登记于台账。
2. **采集器白名单含 `--cached`**：三口 `git status --porcelain` + `git diff` + `git diff --cached`；三边界（只读 / 用户触发 / 禁写操作）写进模块头。
3. **三道闸**：文件 ≤20 / 单文件 diff ≤200 行 / 合计 ≤12K token，截断明示。
4. **建命名 SSOT 单点** `shared/injectionSourceMeta.ts`（§6 建议采纳），第 1 笔零行为变更落地。
5. **跨源总量兜底 = 登记缺口**（§7 建议采纳），不引总量软顶机制；git diff 闸单独设。
6. **信任类明示**：拍板记录写死「用户挂载触发的只读 git 采集 ≠ 代理发起命令，不经裁决链」（getDiagnostics 同信任类）。

## §9 实施预案（已开工，分笔；每笔门禁 + 变异）

1. **第 1 笔（零行为变更）✅ 已落地（2026-10-21 · `9530c8d4`）**：`shared/injectionSourceMeta.ts` + 4 处命名改读单点 + problems 数据回填（新旧值逐字相同）；守卫 = 既有 chip/徽记/信封/QuickPick 测试零改动全绿（实测 5 套件 508 例 + 全量 84 文件 / 1467 passed / 2 skipped / EXIT=0，与基线逐字一致）；变异 = segmentLabel 施加即 2 红（回执 + chip name）、还原即绿；chip name 断言本次新增（原仅回执一面有覆盖）。**暴露缺口**：chatPanel max-lines 贴限 4546/4546，第 3 笔动它前须先拆域或零净增设计。
2. **第 2 笔（采集器）✅ 已落地（2026-10-21 · `8038c431`）**：`gitCollector.ts`（拍板路径 C）+ 纯 node 单测（exec 注入式假执行器，不真跑 git）；三道闸 + fail-closed 事实行（非 git 仓库 / git 缺失 / 段执行失败 / 零改动）。守卫：12 例全绿 + 全量 85 文件 / 1479 passed / 2 skipped；变异 7 发全擒。spawn wrapper（第 3 笔）契约已写进 `GIT_COMMAND_WHITELIST` 注释。
3. **第 3 笔（接线）**：协议枚举 +1（protocol.ts:203）+ QuickPick 关键字项（`chatPanel.ts:1055` 的 `injection?: 'problems'` 字面量同步拓宽）+ sendInput 采集（挂载只记 source、发送时刻取数）+ 信封块（`docContext` 成对 OPEN/CLOSE，`stripInjectedContextPrefix` 同步认新标记——第一笔踩过的点）+ `INJECTION_SEGMENT_LABELS`/`INJECTION_CHIP_META` 加源。
4. **变异计划（≥5 发）**：三道闸各一（超限不截断即红）、fail-closed 摘除（非 git 仓库返空串即红）、枚举漏加（tsc 穷尽性红——`Record<InjectionSource,string>` 兜底）、接线断裂（挂载不发 `add_injection` 即红）、strip 漏认新标记（重放露出原文即红）。
5. **真机验收四态**：非 git 仓库 / git 未安装（或 PATH 无 git）/ 大 diff 截断明示 / 用户手改 + 助手改动混合。

## §10 验证基线

- 宿主全量基线：**84 文件 / 1467 passed / 2 skipped / EXIT=0**（2026-10-21 · HOST-SPLIT-1 P2 第 6 刀后，`a6235d43`）——按「数字无 SSOT、引用前重算」纪律，实施首日重跑锁新数。
- 协议守卫：protocolGuard V-1（阈值 130）全程绿；本笔协议 0 增量（§2.4）。
- 门禁：宿主 `npm test`（串行官方口径）+ `npm run typecheck`（双 tsconfig）+ `npm run lint`（0 警告）+ `npm run compile`。

---

**本文不写一行实现码的纪律已随拍板解除**（2026-10-21）。第 1 笔（命名 SSOT 单点，零行为变更）按 §9 预案开工；实施进展以台账 HOST-CTX-4「二笔拍板记录」段为 SSOT。
