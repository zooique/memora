# 技能语义路由（Tool RAG）探索草稿

> **定位**：技能数量越过阈值后，从"LLM 自己翻 list\_skills"升级为"系统先语义预筛 Top-K 再注入"的触发条款与落点设计。**属探索期草稿，非 ADR、不占编号**。
> **状态**：**探索中**（未实现，仅条款）。当前技能规模未到阈值，不写代码、不建模块。
> **关联**：[role-pack-skills-progressive-disclosure.md](./role-pack-skills-progressive-disclosure.md)（L1/L2/L3 渐进披露现状）、[memory-role-pack-boundary.md](./memory-role-pack-boundary.md)、`单一真理源思维模型`

***

## 一、背景：业界已验证的共性问题

| 数据点                                                                             | 来源                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------- |
| 工具数 50 → 200 → 740，LLM 选择准确率 84-95% → 41-83% → 0-20%                            | Tool Catalog 规模研究（vLLM Semantic Router 引） |
| "Lost in the Middle"：741 工具时列表中部准确率 22-52%（两端 31-32%）                           | 同上                                        |
| 50+ MCP 工具定义 \~55K token；Anthropic 内部最高 134K token 纯工具定义                        | Anthropic Advanced Tool Use（2025-11-24）   |
| **Tool Search Tool**：`defer_loading` + BM25/正则路由，token 降 85%，Opus 4 准确率 49%→74% | Anthropic                                 |
| **vLLM Semantic Router**：工具描述向量化入库，query 语义检索 Top-K 再注入，token 降 90%+            | 微软/AMD                                    |
| **MCP-Zero**：两级路由（server→tool），LLM 自产结构化工具请求，token 降 98%，95.19% 准确率             | 中科大/厦大                                    |
| **Tool RAG**：经典 RAG 同款思路，只呈现最相关工具，调用准确率提升 3 倍、prompt 减半                         | Red Hat                                   |

**收敛结论**：业界已从「让 LLM 自己翻目录」演进到「系统先路由、LLM 只从收敛集选」。当前 memora 的 `L1_LIST_TOOL_THRESHOLD = 50`（[skillManager.ts](../../src/skill/skillManager.ts)）切 `list_skills` 正是"自己翻"模式——是计数保护，不是语义匹配，50 是准确率悬崖起点。

## 二、吸收方式：复用最小单元，不做场景特化

**核心约束（单一真理源）**：不在技能侧新建独立检索引擎。memora 记忆召回（`recall()`）已是"向量化 → 语义检索 → 按需注入"的最小单元——技能语义路由是**同一套逻辑换场景复用**。

| 现状（记忆）                       | 复用落点（技能）                                   |
| ---------------------------- | ------------------------------------------ |
| `VectorStore` 向量索引           | 技能 description 向量化入库（同库分 collection，不新建存储） |
| `recall.ts` query 语义检索 Top-K | 触发时按 query 召回技能 Top-K                      |
| 命中后注入 system（零 step）         | 收敛后的技能清单进 L1 槽位（替代 list\_skills）           |

## 三、触发条款（满足其一才实施）

1. **技能数量 > 50**（与现有 `L1_LIST_TOOL_THRESHOLD` 对齐）且实测 `list_skills` 出现漏召/误选；
2. **描述压缩漏召**：技能数 > 30 压缩模式（20 字描述）被 LLM 目测漏选，日志或用户反馈复现 ≥1 次；
3. 角色包技能 + 全局技能总量 > 50 时同上。

**未触发前**：维持渐进披露现状（L1 常驻 / 30 压缩 / 50 list\_skills），不预做、不写代码。

## 四、落点设计（触发后实施，现仅留记录）

- **`skillManager.ts`**：`buildSkillList()` 的 `skillCount > L1_LIST_TOOL_THRESHOLD` 分支，由"list\_skills 工具提示"升级为"语义预筛 Top-K 注入 L1 槽位"（LLM 只见收敛清单，`list_skills` 工具仅保留作兜底）。

- **`recall.ts`** **/** **`VectorStore`**：技能描述走与记忆相同的向量化与检索通道（复用 embedding、不新增 provider 调用）。

- **配置开关**：探索验证期用显式开关（默认关），回退即删开关——保证可逆，符探索期"可回退"标准。

## 五、已弃用选项（土壤筛选结论，记录以免回捞）

| 方案                                  | 弃用理由                                         |
| ----------------------------------- | -------------------------------------------- |
| Graph/知识图谱路由（ToolNet/KG）            | 结构性维护成本高，项目级单仓库规模撑不起，复杂度不成比例                 |
| 多 Agent 路由（PwC Tool-to-Agent）       | 与单 Agent 模型架构哲学冲突（架构哲学第 9 条）                 |
| AWS verified semantic cache（问答对缓存表） | 引入新存储表；记忆 round-summary 召回已是同构"验证过问答摘要"，无需重复 |
| MCP-Zero LLM 自请求路由                  | 50+ 以后的再细化，现阶段过度设计；与"目录常驻"分层冲突               |

***

> **何时固化**：触发条款 1/2 复现并被真实场景消费、预筛方案验证稳定后，按探索期机制补 ADR（届时保留"决策 + 理由 + 引用方"，本草稿降级保留验证过程于 docs）。

