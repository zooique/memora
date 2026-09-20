# 文档层行号存量清算 · B 轮执行报告（DOC-HYG-2）

> **日期**：2026-09-20 **触发**：DOC-HYG-1 裁决「开这一轮」+ 用户指令「其他文档评估是否可以删除，**确认保留的才更新**」
> **范围**：`docs/**` · `.trae/documents/**` · `.trae/decisions/**` · `.trae/rules/**`（= `single-truth-source-mindset.md` 审计四层中的文档三层）
> **方法**：全量只读探针 + 逐条人工证真（拒绝启发式结论）

---

## 0. 结论先行

1. **A 轮的扫描面是错的**——「140 处、全在 `docs/**`」漏掉了 `.trae/documents/**` 与 `.trae/decisions/**` 两层，**少报 108 处（44%）**。四层重扫：**240 处（去重后 224）**。
2. **md 行号只有两种合法身份**，此前无判据 → 每轮重新推演。本轮把判据写入 `cross-document-reference.md` §7：**现行导航必清**（收敛为符号名）· **时点证据可留但须头部声明**。
3. **处置 24 份文档**：**清坐标 7 份（24 处 → 0）** · **加坐标声明 17 份**。终态 **216 处命中 / 未声明文档 0**。
4. **查出 4 类真实损伤**（逐条证真，非启发式）：其中 `compaction.ts` 的「第 78 行」被 **3 份文档**共同引用作「第二级策略落点」，而该行实为一句无关的 Map 声明；另有一处**文件级错引**（与 A 轮 `sessionStore.ts` 同型）。
5. **附带发现**：一份方案的**决策与实现背离**且文档无状态标注（待拍板）。

---

## 1. 扫描面自纠：A 轮少报 44%

| | A 轮 | B 轮（四层） |
|---|---|---|
| 扫描面 | `docs/**` + `.trae/rules/**` = 63 md | + `.trae/documents/**` + `.trae/decisions/**` = **132 md** |
| 命中 | 140（全在 `docs`） | **240**（`docs` 132 · `.trae/documents` 88 · `.trae/decisions` 20） |
| 结论 | 「`.trae/rules` 零命中」 | 仍然成立；但**另两层从未被扫过** |

**根因**：A 轮把「本轮要动的对象」误当成了「扫描面」。而 `single-truth-source-mindset.md` 第 16–21 行明确写着审计四层，**缺一层即视为未收口**。

**去重**：F2 形态（`` loop.ts` L2069 ``）与 F4 形态（裸 `L2069`）会对**同一文本**各计一次，实测重复 **16 处** → 唯一命中 **224**。

**探针自身的 bug（已修）**：F4 的正则 `m[1]` 捕获的是数字而非路径，首版把 105 条裸行号全判成「目标文件不存在」——假数据。修正后裸行号归入「需上下文」类。

---

## 2. 判据：md 行号坐标的两种身份（已写入规则）

| 身份 | 判据 | 处置 |
|---|---|---|
| **现行导航** | 读者会照着这个行号去**当前**代码里定位 | **必清** → 收敛为符号名或文件名 |
| **时点证据 / 作业坐标** | ADR 记录当时实证；方案记录当时改动清单与验收行 | **可保留** → 须由头部 `> **坐标**：…` 声明覆盖 |

**判据一句话**：*读者会不会照着这个行号去定位？* 会 → 清；不会（纯记录）→ 声明。

**为什么记录类不能靠「改写成符号引用」修**：改写封存记录 = **篡改决策依据**；而方案里的行号是**作业指令本体**（「更新 `L101-115` 注释」去掉行号后不成立）。

**豁免设计**：声明是**逐文档可机检的凭据**，不是全局白名单——未来加 md 侧守卫时，判据 = 该文档头部存在 `坐标` 声明。已写入规则（v0.5 → v0.6）+ 速查表 2 行。

---

## 3. 存量处置

### 3.1 清坐标 7 份（24 处 → 0）

| 文档 | 改前 | 改后 | 做法 |
|---|---|---|---|
| `docs/architecture/memory-as-summary.md` | 5 | 0 | 同句已点名 `reflect`/`orchestrator.ts` → 删冗余坐标 |
| `docs/architecture/role-pack-exclusivity-relocation.md` | 6 | 0 | 同句已点名 `refreshAssemblyForRolePack`/`prepare.run`/`runResume` |
| `docs/architecture/role-pack-skills-progressive-disclosure.md` | 5 | 0 | 去掉 `#L10-L36` 锚点、`L387`/`L395` |
| `docs/architecture/round-independent-storage-design.md` | 3 | 0 | 已被下一条补记取代 → 标「历史记录 · 已由下一条收口」 |
| `docs/评估-memora设计质量-20260910.md` | 2 | 0 | 被引作实锤的行 → 改 `compaction.ts` 的 `ReplaceRoundsStrategy` |
| `docs/读取防重与压缩协同-方案.md` | 2 | 0 | 同上（`ResultReplacementStrategy`） |
| `docs/重读永动机-主流收敛与最终落地-方案.md` | 1 | 0 | 同句已点名符号 → 删坐标 |

### 3.2 加坐标声明 17 份

- **5 份 ADR**（002/006/025/029/032）· **7 份 `.trae/documents`**（已落地方案 6 + 未实施 1）· **5 份 `docs`**
- 措辞按文档状态两选一：已终结 → 「**历史记录的时点快照**，代码演进后不再核对」；仍在指导未完成工作 → 「**撰写时点快照**，实施前须按符号名复核」
- `memory-tool-recall-design.md` 原已有「批次级失效声明」覆盖行号，**补统一 `坐标` 字段**以取得机检凭据（原声明保留）

---

## 4. 实锤损伤（逐条证真）

改前先核实「我要引用的符号是否真实存在、被引行号处到底是什么」：

| 引用 | 声称 | 该行真身 | 级 |
|---|---|---|---|
| `compaction.ts` 第 78 行（**3 份文档**引用） | 第二级 `ResultReplacementStrategy` 落点 | `const toolNameMap = new Map<string, string>();` | 🔴 |
| `loop.ts` 第 339 行（被引作「**实锤**」） | `private readonly contextManager: ContextManager` | 一段 answerQuestion 注释 | 🔴 |
| `assembler.ts` 第 137 行 | `refreshAssemblyForRolePack` | **该函数不在 assembler.ts**，真身 `seed/prepare.ts` → **文件级错引** | 🔴 |
| `assembler.ts` 第 843/844 行、`builtinToolHandlers.ts` 第 864 行 | 「现行实现」 | deps 字段 / `) {` | 🟠 |
| `compaction.ts` 第 105 行 | `ReplaceRoundsStrategy` | `}` | 🟠 |
| `prepare.ts` 第 58 行 · `orchestrator.ts` 第 122/248/265 行 | — | ✅ **准确** | — |

**符号本身全部真实存在**（`ResultReplacementStrategy` / `ReplaceRoundsStrategy` / `contextManager` / `setExclusionRoundIdsProvider` 等）→ 清坐标时改符号引用是**真修复**，不是把「行号漂移」换成「符号漂移」。

---

## 5. 附带发现（待拍板 · 非坐标问题）

`.trae/documents/删除会议确定性预置-归LLM通道-方案-20260906.md` 记：

> **决策**：删除「小组会议」的确定性任务表自动预置，改由 LLM 经 `task_table_write` 自主建表/覆盖。…本次彻底删确定性。

**实测**：`tryBuildMeetingPlan` **仍在 `src/` 中（5 处）**，且**仍被 `seed/prepare.ts` 调用**；`rolePackManager.test.ts` 注明「2026-09-07『最小受控起点』**半反转**」。

→ 该方案的决策**从未实施、反被后续决策推翻**，而文档仍以「决策：删除」表述且**无状态标注**。本轮**未擅自改写结论**（不臆造后续决策的正式表述），仅加坐标声明并登记待拍板。

---

## 6. 验证

| 检查 | 结果 |
|---|---|
| 探针复扫 | 240 → **216**；**未声明且有命中的文档 = 0**；17 份带 `坐标` 声明 |
| `docs:links`（发布边界闸门） | **EXIT=0** · 42 随包 md · 0 问题 |
| md 表格结构体检 | 428 表格 · **1** 处异常（`tasks` 既有排版意图，未新增） |
| 改动体量 | 24 文件，每文件 diff **1–3 行**（若行尾被整体改写会是数百行） |
| 行尾一致性 | `git` 报 `LF will be replaced by CRLF` → 仓库 `autocrlf`，**行尾非被跟踪属性**；「CRLF→LF」疑虑经 numstat 实证**否定** |

---

## 7. 未纳入（诚实登记）

- `role-packs/**`（随包 34 md）· `hosts/**` 的 md · `prompts/**`
- **md 侧守卫未立**（本轮只立判据与豁免凭据，未写测试）
- **文档内容级过时**（本报告只判行号坐标与存废，不判论述是否仍成立）

## 8. 报告口径纪律

本报告中的数字均为本轮实测；**行号坐标一律写作「`file.ts` 第 N 行」而不写 `file.ts:N`**——与 §7 新规一致，避免本报告自身成为未来守卫的假阳性来源。
