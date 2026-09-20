# 会话任务汇总（2026-09-20）

> **性质**：本会话（注释定位卫生 → 文档层行号清算 → 文档存废评估）的任务全景与完成度收口。
> **数据口径**：全部为只读实测（`git status` / `git diff --numstat` / 探针脚本 / 门禁实跑），非记忆复述。
> **关联台账**：`tasks/待完成任务.md` L164（DOC-HYG-1）· L165（DOC-DISPOSAL-1）· L166（DOC-HYG-2）· L183（COMMENT-HYG-1 已收口）。
> **关联报告**：本目录 `doc-linenum-hygiene-eval-2026-09-20.md` · `doc-linenum-hygiene-roundB-2026-09-20.md` · `doc-disposal-eval-2026-09-20.md` · `code-review-cross-abort-2026-09-20.md`。

---

## 一、总览

会话沿一条链推进：**「注释里的行号坐标无守卫」** 这一个起点，向外滚出三层（内核代码注释 → 项目 md 文档 → 文档存废与结构）。

| 序 | 任务 | 触发 | 状态 | 产物 |
|---|---|---|---|---|
| 0 | 内核行号引用残留 **评估** + 是否单独立项 | 用户提问 | ✅ 完成 | 记忆 §15 |
| 1 | **COMMENT-HYG-1 Step 1**：内核 `src/` 行号清零 | 用户「启动 Step 1」 | ✅ 完成 · **已提交 `9cc48995`** | 11 文件改符号引用 |
| 2 | **COMMENT-HYG-1 Step 2**：内核侧注释定位守卫 | 用户「评估推进 Step 2」 | ✅ 完成 · **待提交** | `src/__tests__/commentHygiene.test.ts`（125 行） |
| 3 | **DOC-HYG-1 评估**：文档层行号引用立项 | 用户「深入评估」 | ✅ 裁决「开」 | 报告 `doc-linenum-hygiene-eval` |
| 4 | **DOC-HYG-1 A 最小止血**（A1–A4） | 用户「执行落地修复」 | ✅ 完成 · 待提交 | 4 文件 |
| 5 | 停电后 **复核** A 落地 + 表格结构体检 | 用户「审查完成情况」 | ✅ 完成 · 待提交 | 6 处真损伤修复 |
| 6 | **DOC-DISPOSAL-1**：`docs/**` 存废评估 | 用户「其他文档评估是否可以删除」 | ✅ 完成 · 物理删除 **0** | 报告 `doc-disposal-eval` |
| 7 | **DOC-HYG-2（B 轮）**：保留文档行号存量清算 | 用户「继续下一步」 | ✅ 完成 · 待提交 | 24 文件处置 + 报告 |
| 8 | 本汇总 | 用户「总结整理」 | ✅ | 本文件 |

---

## 二、三层成果的量化

### 第 1 层 · 内核代码注释（COMMENT-HYG-1）

| 项 | 实测 |
|---|---|
| 清存量命中 | **18 处**（跨文件行号引用 12 + 裸行号 6）→ 真引用 **14 处**，其中 **10 处已失真（71%）** |
| 失真分布 | **100% 落在 `src/agent`**（churn 最高区） |
| 立守卫判据 | 三类形式**零例外**：`file.ts:数字` · `file.ts L数字` · 裸 `L数字`（两位以上，避开 L0–L3 记忆层级术语） |
| 关键判据差异 | 扫描面收窄为**注释位**（宿主同名守卫扫全位置）——内核项目搜索工具的**输出格式断言本身就是「路径:行号」**，照搬会造必现假红；收窄后豁免需求 3 → **0** |
| 四向实证 | 边界 27 例假阳/假阴 **0** · 当前树 226 文件 0 命中 · **清零前 `HEAD~1` 命中 15 = 100% 召回** · 变异四向（跨文件→红 · 裸行号→红 · 代码位→保持绿 · 扫描塌陷→反向守卫红） |

> **方法论最关键一步**：拿**清零前的真实版本**当阳性样本跑判据，比变异验证更硬——变异只证明「判据会报」，它证明「判据能报**真实发生过的全部**违反」。且该过程**全只读**（`git ls-tree` + `git show`），未用 `git worktree add`（本环境 git 写操作红线）。

### 第 2 层 · 项目 md 文档（DOC-HYG-1 + DOC-HYG-2）

| | A 轮 | B 轮（**自纠**） |
|---|---|---|
| 扫描面 | `docs/**` + `.trae/rules/**` = 63 md | **四层全扫** = 132 md |
| 命中 | 140（称「全在 docs」） | **240**（去重 224）→ 处置后 **216** |
| 未声明文档 | — | **0** |

**A 轮扫描面错在哪**：`single-truth-source-mindset.md` §审计四层已写死「`src/` · `.trae/rules/` · **`.trae/documents/`** · `docs/architecture/`，**缺一层即视为未收口**」。我把「本轮要动的对象」当成了「扫描面」→ 少报 **44%**。

**处置（24 文件）**：清坐标 7 份 / 24 处 → 0；加 `坐标` 声明 17 份。

**判据成文**（`cross-document-reference.md` v0.5 → v0.6）：md 行号只有两种身份——
- **现行导航**（读者会照它去当前代码定位）→ **必清**，收敛符号名
- **时点证据 / 作业坐标**（ADR 记当时实证、方案记当时改动清单）→ **可留但须头部声明**
- 判据一句话：**读者会不会照着这个行号去定位？**

### 第 3 层 · 文档存废（DOC-DISPOSAL-1）

**物理删除候选 = 0。** 三条实证：45/45 docs 全部 git 跟踪（无 untracked 过程产物）· 零引用 7 份逐个核实无「信息已在别处且未用既有形态承载」· 探索草稿按 `exploration-decision-sedimentation-rules` **S1/S3 属永久保留层**（S3 明写「被否方案明细留在 docs/」）。

**已修 1 个真缺口**：`白话设计文档-模块篇.md`（692 行）**零入引用**，与主文档 `白话设计文档.md`（246 行、入引用 8、被 3 处 src 注释引用）**互不引用** → 孤儿 SSOT。已建**双向引用**（主文档 L9 ⇄ 模块篇 L5）。

> 这是 `docs:links` 的**结构性盲区**：闸门只验「已写的链接是否可达」，**不验「该有的链接是否缺失」**。

---

## 三、🔴 三类真损伤（逐条实证，非启发式）

| # | 位置 | 事实 | 来源 |
|---|---|---|---|
| 1 | 随包 `memora-接入指南.md` | 称「原子写已实现（`sessionStore.ts:96`）」，而内核 `src/memory/sessionStore.ts` **共 122 行、零文件写入** → **文件级错引**（真身 `src/utils/atomicWrite.ts`） | 历史遗留 |
| 2 | `assembler.ts` 第 137 行（`role-pack-exclusivity-relocation`） | 引 `refreshAssemblyForRolePack`，**该函数不在 assembler.ts**，真身 `seed/prepare.ts` → **文件级错引** | 历史遗留 |
| 3 | `compaction.ts` 第 78 行（**3 份文档共用**） | 声称「第二级 `ResultReplacementStrategy` 落点」，该行真身 `const toolNameMap = new Map<string, string>()` | 历史遗留 |
| 4 | `loop.ts` 第 339 行（被引作「**实锤**」） | 声称 `private readonly contextManager`，该行真身是一段 answerQuestion 注释 | 历史遗留 |
| 5 | markdown 表格结构 6 处（台账 / 规则 / 随包 spec） | 单元格内**裸 `\|`** 被当列分隔符 → 渲染错位；台账 1 处两行粘连 | **1 处本次操作引入**，余为历史遗留 |

**全仓表格体检**（111 md / **433 表格**）修复后残留 **1 处**：台账 L140-143 + L155 把「编号 · 标题」写在一列——**排版意图，未擅动**。

---

## 四、门禁与验证收据

| 项 | 结果 |
|---|---|
| `local-ci --preset=fast` | **EXIT=0** · 收据 `preset=fast head=9cc489955842 tree=2ce7cd79b3ff dirty=37` |
| 内核全量 vitest（`--no-file-parallelism`） | **107 passed ｜ 1 skipped（文件）／ 2707 passed ｜ 4 skipped（用例）** —— 相对 Step 1 基线 +1 文件 +1 用例，**零回归** |
| `tsc --noEmit` / `eslint --max-warnings 0` | EXIT=0 / 0 |
| `docs:links`（发布边界闸门） | **EXIT=0**（自检 3/3 · 42 随包 md · 0 问题）— A 前基线与 B 后复跑均绿 |
| 探针复扫（终态） | 216 处 · **未声明文档 0** · `.trae/rules` 零命中 |
| 提交信息 | `commitlint --edit` **EXIT=0**（负面控制 `BADTYPE` 实测 EXIT=1，证明闸门真跑） |

---

## 五、五处**自我推翻**（本会话方法增量的主体）

| # | 我起初的判断 | 实证后 | 教训 |
|---|---|---|---|
| 1 | 「45 docs 只有 29 跟踪，两个随包文档没入库」 | **虚警**——`git ls-files` 把中文名转八进制转义，被 `.endsWith('.md')` 静默丢弃；`-z` 重取后 **45/45 全跟踪** | 解析器窄 ≠ 数据有问题 |
| 2 | 「A 轮 140 处，全在 `docs/**`」 | **错**，按审计四层重扫为 **240**（少报 44%） | 扫描面错 = 结论错 |
| 3 | 「`novel-three-layer-design.md` 是强删除候选」 | **错**——项目早有「指针文档」归档形态（5 个同类实例），它是**第 6 个** | 先问「项目是否已有处置形态」，再判「该不该动」 |
| 4 | 「CRLF → LF 是本次造成的行尾损伤」 | **否定**——git 报 `autocrlf`，索引存 LF，`numstat` 每文件仅 1–3 行改动（整体改写会是数百行） | 告警 ≠ 损伤 |
| 5 | 「numstat 显示 59 文件改动」 | **错**——`2>&1` 把 27 行 CRLF 警告混入输出，**真实 32 文件** | 管道脏数据会伪造计数 |

**归纳（同型出现 4 次）**：假阳性共性 = **判据取了与语义无关的表面特征**（符号首次出现行 / 关键词全文出现 / 竖线计数 / 输出行计数）。→ **自动判据只能分诊，结论必须人工实锤。**

---

## 六、未完成 / 待拍板

| 项 | 内容 | 归属 |
|---|---|---|
| ⏳ **待提交** | 32 个 M + 5 个 untracked（见下） | 用户终端 |
| 🟡 **待拍板 ①** | 「指针文档」归档形态**未成文**——`comment-doc-slimming-rules` 管注释减法、`exploration-decision-sedimentation-rules` 管 ADR 生命周期，**都不定义「失效 docs 如何处置」** | DOC-DISPOSAL-1 |
| 🟡 **待拍板 ②** | `novel-three-layer-design.md` 自述「探索中」，而 21 个技能**已落地** `role-packs/共鸣小说家/`；按 S2 固化条件（被 rules 引用 ≥3 处）**疑似已满足** | DOC-DISPOSAL-1 |
| 🔴 **待拍板 ③** | `删除会议确定性预置-归LLM通道-方案-20260906.md` 写着「决策：删除…本次彻底删确定性」，但 `tryBuildMeetingPlan` **仍在 `src/`（5 处）且仍被 `seed/prepare.ts` 调用**，测试注释称 09-07「半反转」→ **该决策未实施、反被推翻，文档无状态标注**。本轮**未臆造**后续决策表述，只加坐标声明 + 登记 | DOC-HYG-2 附带发现 |
| 🟡 **未覆盖面** | `role-packs/**`（随包 34 md）· `hosts/**` 的 md · `.trae/skills` · 文档**内容级**过时（本轮只判存废与坐标） | 诚实登记 |
| 🔵 **发版前** | `npm run build`（`src/` 新增文件，dist 注释副本已过期）；内核 npm 先、宿主 vsce 后 | 发版纪律 |

---

## 七、待提交清单（实测 32 M + 5 untracked）

**改动分布**：`.trae/decisions/` 5 · `.trae/documents/` 7 · `.trae/rules/` 2 · `docs/`（含 architecture）17 · `tasks/` 1 = **32 文件 · +88 / −29 行**。

**⚠️ A 轮与 B 轮的文件已重叠**（`cross-document-reference.md` 同时含 v0.5 与 v0.6；台账含全部条目）→ **无法按路径干净拆分**，建议一次提交：

```powershell
git add -u          # 只暂存已跟踪修改，天然排除 untracked
git commit -F "C:/Users/SJ/AppData/Local/Temp/memora_commit_msg_20260920h.txt"
```

**untracked（不属于本批，勿用 `git add -A`）**：`src/__tests__/`（Step 2 守卫，**属本批但单独提交**）· 4 份 `deliverables/engineering-assurance/*.md`（本轮报告）。

---

_本汇总由只读实测生成；所有数字均可由 `git status --porcelain` / `git diff --numstat` / `local-ci --preset=fast` 复现。_
