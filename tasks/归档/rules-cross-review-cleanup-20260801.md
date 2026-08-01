# 规则文件全量交叉审查与深度清洗 · 变更摘要

> **日期**：2026-08-01
> **范围**：`memora/.trae/rules/` 全部 12 个规则文件 + `decisions/ADR-017`（抽象时机权威源）
> **方法**：第一性原理 + 对抗式审查；保持按领域分文件（preserve AI 按需加载上下文），不做整文件合并；用「单一真理源 + 精简引用」消除条目级冗余。

---

## 一、清洗前诊断（核心发现）

| 问题类别 | 具体表现 |
|---------|---------|
| **冗余 #1（最严重）** | 「抽象/复用时机」原则在 **6 个非 ADR 文件**各自完整重述，且数字互相打架：`backend_layers` 说"2 次"、`progressive-refactor` 说"≥3 次"、`ui-engineering` 说"不再等 3 次"、`coding-convention`/`sprite` 说"2+ 作为信号"、`programmer-mindset` 另有"技术债务阈值公式"。ADR-017 虽已是权威源却被各文件旁路重述。 |
| **矛盾 #1** | 上述"2 vs 3 阈值"表象冲突——实为**场景混淆**（新代码设计期抽取 vs 既有代码回溯提取），非真矛盾，但未被显式区分，AI 易误读。 |
| **冗余 #2** | `programmer-mindset` §2.2 中"复用调用链而非复制代码"与"新逻辑要嫁接而非并列"是同一原则的两次表述。 |
| **冗余 #3** | `architecture_philosophy` §9「在代码中的体现」整段重复 §6 的召回双通道 / excludeSources / 向量搜索静默降级 / 衰减机制。 |
| **冗余 #4** | `backend_layers` §模块内文件命名 含 **58 行** `agent/managers` + `utils` 详尽文件树，自身标注"快照、随重构漂移、不构成冻结契约"——典型腐化高风险冗余。 |
| **冗余 #5** | `project-rules` §6 规则文件索引拆成 6 个子表（6.1~6.7），冗长且检索不便。 |
| **缺陷 #1** | `coding-convention` 中 3 处"Memora 适配"交叉引用**指向错误章节**（§2→§7.1、§4→§3 实为目录结构、§5 三重引用），违反 `cross-document-reference.md` 的"章节号必须真实存在"。 |

---

## 二、解决的矛盾点（1 项，已闭合）

**矛盾：「2 次 vs 3 次」抽象阈值**
- **根因**：ADR-017 已区分两层，但各文件未对齐场景。
- **统一方案**（写入 ADR-017 两层模型，各文件显式标注场景）：
  - **Scenario A（新代码设计期抽取）**：领域原语 / 明确第二消费者 → 首次实现即抽最小公共原语；纯臆测不抽；2+ 处重复作为"该抽却漏抽"的回溯信号。适用：`coding-convention` §3、`ui-engineering` §四.2、`sprite` §8.1。
  - **Scenario B（既有代码回溯提取）**：已有真实重复 → ≥2 处真实复用（上帝对象拆分可取 ≥3 处调用，因提取成本更高）。适用：`backend_layers` §判断标准、`progressive-refactor` §5.2/§9。
- **结论**：两场景非矛盾，已在 `progressive-refactor` §5.2 显式声明"与 Scenario A 不同场景，非矛盾"。grep 全量复核无遗留"2/3 次"打架表述。✅

---

## 三、删除 / 合并的冗余条目统计

| 动作 | 位置 | 说明 | 量级 |
|------|------|------|------|
| **合并条目** | `programmer-mindset` §2.2 | "复用调用链" + "嫁接而非并列" 合并为 1 条 | 2→1（删 1 冗余条目） |
| **单源化（消除重述）** | 6 个非 ADR 文件 | 抽象时机原则统一引用 ADR-017，移除各自的完整重述 + 冲突数字 | 消除 **5 处**冗余重述 |
| **删除冗余代码证据** | `architecture_philosophy` §9 | 删除与 §6 重复的召回/衰减整段 | 删 ~4 行 |
| **删除腐化快照** | `backend_layers` §模块内文件命名 | 删除 58 行详尽文件树（改为"以 src/ 实际代码为真理源"） | 删 ~58 行 |
| **结构合并** | `project-rules` §6 | 6 个子索引表（6.1~6.7）→ 1 个分类总表 | 删 ~40 行 |
| **修正错误交叉引用** | `coding-convention` §2/§4/§5 | 修正 3 处指向错误章节的"Memora 适配"引用 | 3 处 |

**汇总**：合并规则条目 **1 对**；跨文件单源化 **1 组（6→1 权威 + 5 引用）**；结构合并 **1 处（6 子表→1）**；删除冗余条目/快照/错误引用合计 **约 103 行**。

---

## 四、各文件主要调整说明

| 文件 | 调整 |
|------|------|
| **ADR-017**（权威源） | 内容未改；被确立为抽象时机的唯一真理源，各文件统一引用。 |
| `coding-convention-rules.md` | §3 显式标注 Scenario A；§1 补回"2 次即抽"DON'T 与 §3 对齐；修正 §2/§4/§5 三处错误章节交叉引用。 |
| `ui-engineering-mindset-rules.md` | §四.2 / §六 #6 / 判定流程图 统一 Scenario A 措辞，消解旧"3 个以上才抽工厂"表述。 |
| `sprite-project-rules.md` | §8.1 明确 Scenario A；§4.1 components 定义补 base/feedback/data 分层交叉引用，消除与 `ui-engineering` §四.3 的错位。 |
| `backend_layers_rules.md` | §判断标准 对齐 Scenario B（≥2 真实复用，上帝对象 ≥3）；§模块内文件命名 58 行快照压缩为分层原则 + 以源码为真理源。 |
| `progressive-refactor-rules.md` | §5.2/§9 标注 Scenario B（上帝对象回溯提取，阈值 ≥3 因提取成本更高），与 Scenario A 显式区分。 |
| `programmer-mindset-rules.md` | §2.2 合并"复用调用链/嫁接"为一条；技术债务阈值公式标注对齐 ADR-017 Scenario B。 |
| `architecture_philosophy_rules.md` | §9 删除与 §6 重复的召回/衰减代码证据，改为交叉引用。 |
| `project-rules.md` | §6 规则文件索引 6 子表合并为 1 个分类总表。 |
| `security_rules.md` / `testing_rules.md` / `cross-document-reference.md` / `new-module-guide.md` | 维持不变（已较精简，无交叉冗余）。 |

---

## 五、结构整理说明

- **保持按领域分文件**：`architecture_philosophy`（领域架构）、`ui-engineering`（UI）、`sprite-project`（宿主）、`backend_layers`（分层）、`security`/`testing`（横切）、`programmer-mindset`/`coding-convention`/`progressive-refactor`（通用工程）、`project-rules`（总则）、`cross-document-reference`/`new-module-guide`（元规范）。分文件利于 AI 按需加载、便于检索，未强行合并。
- **每个文件维持清晰逻辑章节**（心智模型/编码契约/分层/速查表等），未打乱既有结构。

---

## 六、刻意未做（透明告知）

1. **未整文件合并** `programmer-mindset` + `coding-convention` + `progressive-refactor`。理由：① `progressive-refactor` 是 257 行程序性重构规范（上帝对象拆分流程），并入会撑大通用文件、违背"控制篇幅"要求；② 分文件利于 AI 按需加载；③ 条目级冗余已通过单源化消除。如需进一步合并可另行执行。
2. **未删** `sprite-project` §10.2 的 IPC 通道清单——属必要的参考数据结构，非规则冗余，删除会丢失实现坐标。
3. **未动** `decisions/` 下 30 个 ADR——本次仅调整 rules 层对 ADR-017 的引用一致性，未触及决策记录本体。

---

## 七、验证

- 全量 grep `.trae/rules/` 复核：所有"2 次/3 次/Scenario A/B/ADR-017"表述现已自洽，无遗留打架。
- 修正的 3 处交叉引用目标章节（project-rules §1/§7.1、src/logging/、project-rules §1.4/§1.5/§7.3）均真实存在，符合 `cross-document-reference.md`。
- 无功能性代码改动，纯文档清洗，零回归风险。
