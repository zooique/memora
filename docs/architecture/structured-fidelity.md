# 结构化信息保真（Structured Fidelity）设计

> **状态**：已落地首个消费者 + 提炼侧视角下沉（P1+P2，2026-08-16）
> **来源**：[LLM 视角 memora-as-agent 体感评估排雷](../../tasks/LLM视角memora-agent体感-方案排雷-20260816.md) P1 真实缺口「结构化信息保真」。
> **关联**：[memory-as-summary.md](./memory-as-summary.md)（记忆即摘要单轨）、[architecture_philosophy_rules.md](../../.trae/rules/architecture_philosophy_rules.md)（§5 领域无关 / §11 角色包插卡 / §8 自然遗忘）、`role-pack/types.ts`（PrepareStrategy）、`roundSummaryGenerator.ts`（摘要生成）。

---

## 〇、归属修正记录（v1 内核字段方案被哲学否决）

初版设计将「结构化保真」实现为 **Memory 新增顶层字段 `structured` + SUMMARY prompt 为代码/表格/diff 特化**，属内核升级。经哲学排雷否决：

| 判据 | 结论 |
|------|------|
| backend_layers 归属决策树 | 结构化保真与「编程/结构化工作形态」**领域耦合** → 应走宿主/角色包，非内核 |
| 哲学 §5 领域无关 | 换小说/日程领域不应因「代码保真」改 `src/` 一行 |
| 哲学 §11 角色包插卡 | 领域形态由「卡」注入，内核不 hardcode 领域知识 |
| 哲学 §8 自然遗忘 | 全量结构保真倾向「完美记忆」，与浓缩哲学有张力 |
| 与 supersededBy 区别 | supersededBy 是通用记忆治理（领域无关，内核合理）；structured 是领域形态（宿主/角色包） |

**修正结论**：结构化保真 = **角色包提炼侧视角（机制参数化）+ 宿主溯源增强**，内核不新增记忆字段、不为领域特化。

---

## 一、问题定义

LLM（尤其代码/结构化工作形态）对话中，**代码、diff、表格等结构化信息经 round-summary 浓缩后保真度低**。当前摘要为「1-3 句话、≤500 字」自然语言浓缩（`SUMMARY_CONTENT_LIMIT=500`），结构化片段被稀释，跨会话召回时 LLM 拿不到完整结构。

**目标**：让「高价值且结构化」信息在记忆中得以保真，沿内核哲学（领域无关 + 角色包参数化 + 自然生长）落地，不破坏「记忆即摘要」单轨。

## 二、核心约束（承自排雷 + 哲学）

1. **内核零领域特化**：不新增记忆字段（`source` 仍 `round-summary`）、不为代码/表格 hardcode。
2. **领域无关**：换小说/日程领域，内核 `src/` 零改动。
3. **角色包参数化**：领域形态（重视什么结构）由角色包声明。
4. **自然生长**：不预埋；按 ADR-017，「提炼视角」机制等在 ≥2 处真实复用后落地，当前以编程角色包为首个消费者记录设计意图。

## 三、核心设计决策

### 决策-1（内核机制）：SUMMARY prompt 参数化——提炼视角 `summaryFocus`

现状：`roundSummaryGenerator` 的 `SUMMARY_SYSTEM_PROMPT` 是硬编码常量，构造函数仅注入 `provider` + `storage`，不接触角色包策略。

修正：把「摘要生成时保留什么」从硬编码改为**可选参数化**——新增一个领域无关的「提炼视角」注入点，由角色包策略携带。内核**不预设**视角内容（不 hardcode 代码/表格），只提供「提炼视角可注入」这一通用机制。

**语义升级（2026-08-16，P2 完整下沉）**：`summaryFocus` 从「追加关注点」升级为「角色包提炼视角」。角色包声明时，以其视角**替换**内核默认的「意图/回答/决策/事实」归纳框架（判断「值得记什么」的角色包化）；JSON 输出 `{summary, type}` 与 SummaryType 分类作为**硬契约**拆出固守，写路径 `metadata.summaryType` 稳定不受影响。未声明 → 通用视角兜底，摘要输出与升级前逐字节一致（零回归）。

```typescript
// role-pack/types.ts · PrepareStrategy 新增可选字段（领域无关的"提炼视角"占位）
export interface PrepareStrategy {
  // ...既有字段
  /**
   * 角色包提炼视角（可选，默认 undefined=通用浓缩）
   *
   * 控制 round-summary 生成时「值得记什么」的判断视角（提炼侧视角下沉）。
   * 内核不预设内容，由角色包注入领域重视的信息维度与保留形式（如编程卡声明保留
   * 代码/diff/表格，覆盖意图/决策等维度；替换通用归纳框架，JSON+SummaryType 契约保留）。
   * 非结构化领域不声明 → 摘要行为与现状完全一致。
   */
  readonly summaryFocus?: string;
}
```

### 决策-2（角色包策略）：编程角色包注入提炼视角

编程/结构化工作形态的角色包在 `manifest.strategy.prepare.summaryFocus` 声明提炼视角，使摘要**在 content 内**保留该领域重视的结构与维度（而非新增字段）：

```jsonc
// 编程角色包 manifest.json（完整提炼视角：判断维度 + 结构保留形式）
{
  "strategy": {
    "prepare": {
      "summaryFocus": "以代码工作视角判断本轮值得记的维度：①用户意图/需求 ②技术决策与理由 ③关键错误与排查方案 ④配置/API schema；其中高价值代码片段、函数签名、关键 diff 用 Markdown 代码块/表格原样保留（摘要仍控制在 500 字内）"
    }
  }
}
```

- 摘要仍走 `content`（≤500 字），提炼视角替代通用"意图/回答/决策"框架，驱动 LLM 按角色包判断"值得记什么"并保留其重视的结构，而非新增存储。
- 小说/日程角色包不声明 `summaryFocus`，摘要走通用视角兜底，行为与现状一致（领域无关成立）。

### 决策-3（装配接线）：激活角色包 → 摘要生成

`roundSummaryGenerator` 生成的摘要需感知激活角色包的 `summaryFocus`。装配层将激活角色包的 `prepare.summaryFocus` 注入摘要 prompt（对齐 `resolveMinFallback` 等既有的「角色包策略 → generate 参数」接线模式）。内核 `src/` 零领域特化，仅多一条参数传递。

### 决策-4（宿主溯源增强）：复用 trace_summary

结构化信息本体仍存于原始对话，`trace_summary` 已能按 `sessionId+roundId` 溯源取回。宿主侧可：
- 增强 trace 工具返回（如代码块高亮/折叠），或
- 决定 LLM 在代码续写场景默认附带溯源结果。

此为宿主可选增强，不属内核必需。

## 四、落地节奏（ADR-017 自然生长）

| 阶段 | 内容 | 触发条件 |
|------|------|---------|
| **记录** | 设计意图 + 使用场景（编程角色包） | 已定稿 |
| **首个消费者（✅ 已落地）** | 编程/方案角色包声明 `summaryFocus` + 内核参数化接线 + validator 注册 | 本迭代推进 |
| **机制化** | 提炼视角机制（summaryFocus）正式提炼进标准 | ≥2 处真实复用（如编程 + 数据分析） |

**首个消费者已落地 + 提炼侧视角下沉（2026-08-16，P1+P2 完成）**，实现产物：
- 内核机制：`role-pack/types.ts` `PrepareStrategy.summaryFocus` + `resolveSummaryFocus`；`roundSummaryGenerator` 把 `SUMMARY_JSON_CONTRACT`（硬契约）与 `DEFAULT_SUMMARY_PERSPECTIVE`（通用视角）拆开，`generate` 第 5 参 `focus` 存在时经 `SUMMARY_PERSPECTIVE_PROMPT` 以角色包提炼视角**替换**通用视角（硬契约保留）；`agent.ts` postProcess 接线 `resolveSummaryFocus(this.getActiveStrategy())`；`validator.ts` `STRATEGY_KEY_RULES.prepare.summaryFocus`（非空字符串校验）。
- 角色包策略：示例库 `代码助手`、两库 `方案设计师` 声明完整提炼视角。
- 验证：`resolveSummaryFocus` / 视角渲染（替换通用视角 + 契约保留）/ 缺省兜底 / validator 校验单测 + 全量测试通过。

**机制化尚未触发**：当前仅编程/方案两个结构化消费者，未达「≥2 处真实复用」的提炼标准；等出现第三个领域（如数据分析表格保真）再评估。内核 `src/` 仍零领域特化——提炼视角内容全部由角色包提供，未 hardcode 代码/表格。

## 五、设计验证（单一真理源）

- **领域无关** ✓：内核不 hardcode 代码/表格，只提供 `summaryFocus` 通用注入点；换领域不改 `src/`。
- **角色包插卡** ✓：重视什么结构由卡声明，通用引擎 ↔ 专业卡解耦成立。
- **自然遗忘** ✓：保真在 content 浓缩内由提炼视角引导，不新增全量存储、不造「完美记忆」。
- **单轨不破** ✓：不新增 source、不新增记忆字段，round-summary 仍是唯一记忆单元。
- **自然生长** ✓：当前记录设计意图，不预埋；首个消费者（编程卡）落地时仅需参数化 + 角色包声明。
