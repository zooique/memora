# Memora MVP 边界（写作助手初版）

> **定位**：MVP = 验证「先聊后干」主链路的第一个可用产品——陪用户聊出思路，拍板后自动生成文章并写入本地文件。
> **原则**：MVP 是**全量设计的子集**。MVP 内不引入全量设计之外的新机制；砍掉的能力一律后置，不预埋接口、不半实现。
> **关联**：[role-pack-spec.md](role-pack-spec.md)（角色包标准本体）· [architecture_philosophy_rules.md §11](../.trae/rules/architecture_philosophy_rules.md)（插卡机设计哲学）

---

## 一、MVP 能力边界

| 维度 | ✅ MVP 做 | ⏸ 后置（不做） |
|------|---------|--------------|
| 闭环 | 单轮闭环 + 对话模式 + Loop 模式 + **自审查轮** | 目标模式（远期） |
| **角色包** | **角色包系统核心完整落地（MVP 第一公民，见 §二）**：L1 内容层 + L2 策略层 + 匹配/粘性/装载 + rule→护栏 + skill→工具 | 多角色合并与冲突裁决 / 漂移检测 / L3 代码层 |
| 工具 | **写文件 `writeFile` + 读文件 `readFile` + Web 搜索 `web_search`**（绑定角色包 skill） | 复杂工具链、自定义工具注册 |
| 记忆 | 自动摘要（round-summary）入库，跨任务按需聚合召回（摘要即记忆，见 memory-as-summary） | 显式记忆指令、记忆管理面板 |
| 打断 | **插话**（输入让位纠偏）+ **停止**（abort）+ **Agent 主动提问**（写作关键节点征询） | 用户手动暂停面板 |
| 上下文 | L1 最近轮 + 基础截断 + 摘要注入 | 成本预算、性能预算 |
| 持久化 | 基础检查点（写文件后落一次） | 多模式恢复、热更新 |
| 并发/隔离 | 单会话串行 | 多会话并行、资源锁、共享记忆 |
| 护栏 | 基础输入/输出过滤（SecurityGuard 最小集，由角色包 rule 驱动） | 完整规则体系 |

---

## 二、角色包：MVP 第一公民（引领 Agent 范式）

**范式定位（方向宣言）**：角色包不是"一个 prompt 模板"，而是 **Agent 的最小可插拔行为单元**——也是**可共享的装载卡**（中立标准，任何 Agent 可装载，memora 是首个实现；标准本体见 [role-pack-spec.md](role-pack-spec.md)）。MVP 落地的是**该标准的核心子集**（L1 + 核心 L2 键），主链先立住，后置能力在它上面自然生长。

| 构成 | 语义 | 回答"Agent 的什么" |
|------|------|------------------|
| `persona`（L1 内容） | 身份与视角 | **怎么看问题** |
| `rule`（L1 内容） | 边界与安全契约 | **什么不能做**（接入 SecurityGuard） |
| `skill`（L1 内容） | 能力清单 | **能调什么工具**（工具与角色包绑定） |
| L2 策略 | 行为开关枚举 | **怎么做**（提问/工具/风格等） |

**换装 = 换 Agent**：Agent 的专业性由装载的角色包决定，而非代码分支——这是与传统"写死 system prompt"范式的分水岭，也是后续一切角色系统（多角色、冲突裁决、市场）的生长点。MVP 率先把这条主链立住，后置能力在它上面自然生长。

**MVP 落地范围（重点打磨，不裁剪核心）**：
1. **结构**：L1（persona/rule/skill）+ L2 策略层完整实现（§README 9.1）；L3 代码层远期；
2. **匹配**：触发词确定性匹配 + 默认兜底（§README 4.2）+ 会话粘性锁定；
3. **装载**：persona/rule/skill → system prompt 组装（§README 4.4）；`skill` 决定工具暴露——MVP 三工具（writeFile/readFile/web_search）**挂在角色包上，而非全局注册**；
4. **rule 生效**：角色包 rule 段 → SecurityGuard 最小集（输入/输出过滤，§runtime 13.8）；
5. **L2 生效**：已冻结核心维度随角色包生效——主动提问（askOn/askLimit）、工具允许（toolMode）、记忆召回（memoryRecall）等；草案维度（如 temperature）MVP 不承诺随包生效（spec §六 状态列）。

**MVP 内置角色包样例**（骨架，对齐 role-pack-spec §2.2 文件夹形态：`manifest.json` 为核心控制文件，persona/rules 为独立内容文件，skills 用对象数组注册 + capability 中立命名）：

```text
role-packs/小说写作/
├── manifest.json   # 元数据 + strategy + 内容路径注册 + skills 注册
├── persona.md      # 身份设定（正文）
└── rules.md        # 确定性规则（正文）
```

**manifest.json**：

```json
{
  "name": "小说写作",
  "formatVersion": "1.0.0",
  "description": "短篇小说与文案写作助手",
  "keywords": ["写作", "小说", "故事"],
  "trigger": ["写作", "小说", "故事", "文案", "小作文"],
  "author": "memora",
  "version": "1.0.0",
  "interactionType": "tool_assistant",
  "strategy": {
    "prepare": { "memoryRecall": "full" },
    "act": { "toolMode": "allow" },
    "reflect": { "handoff": "wait" },
    "global": { "askOn": ["ambiguity", "decision", "missing_info"], "askLimit": 3 }
  },
  "persona": "persona.md",
  "rules": "rules.md",
  "skills": [
    { "file": "skills/write.md", "name": "write", "capability": "file:write" },
    { "file": "skills/read.md", "name": "read", "capability": "file:read" },
    { "file": "skills/search.md", "name": "search", "capability": "web:search" }
  ]
}
```

**persona.md**：

```markdown
你是一位擅长短篇小说与文案的写作助手，先与用户讨论思路，成稿时结构完整、有细节、结尾留余味。
```

**rules.md**：

```markdown
- 不写真实姓名、身份证号、手机号、银行卡等敏感信息
- 结尾留白，不把反转写死
```

> **实施优先级（2026-08-13）**：角色包是**架构**上的第一公民，但**开发排期后置于内核基础**——先打牢单轮闭环与记忆系统（其运行不依赖角色包键，如互斥窗口 N 由内核默认值提供，见 memory-as-summary §4.3），再冻结角色包 v1 字段，避免角色包接口随基础演进反复横跳。

> MVP 只装载**一个**角色包（写作助手）；多角色合并（§9.4）与漂移检测（§4.2）后置——但**角色包的结构、匹配、装载、生效链路必须按全量设计完整落地**，不能做成一次性硬编码。
>
> **合规定位**：写作助手属「工作助手」服务（《人工智能拟人化互动服务管理暂行办法》2026-07-15 施行，豁免条款明确工作助手不涉及持续性情感互动不适用）——MVP 角色包声明 `interactionType: tool_assistant`，AI 身份标注 + rule 段内容红线随包生效（spec §七）。

---

## 三、Agent 主动提问（MVP 内）

写作场景的天然刚需——Agent 在关键节点停下来问你，而不是闷头写偏：

- **触发条件**（L2 策略 `askOn`）：
  - `ambiguity`：指令歧义（"结尾想要什么基调？"）
  - `decision`：关键决策点（"反转落在人身上还是猫身上？"）
  - `missing_info`：缺前置事实（"主角职业是？"）
- **机制**：prompt 级指令注入——`assembleRolePack()` 将 `askOn`/`askLimit` 转为 LLM 指令（"当遇到模糊不清时主动提问"），LLM 提问时以**结构化形式输出**（如 `[ASK] 问题文本`），内核**确定性解析**为 `question_pending` 事件（问题文本 + 挂起原因），用户自然回复。**不引入运行时暂停通道，也不靠宿主从 text chunk 猜"是不是提问"**——结构化输出 + 确定性解析（约定优于检测），避免"检测提问 vs 陈述"的不可靠启发式（SSOT §2.2 输入触发；agent-design-philosophy §13.x 事件契约）。
- **MVP 形态**：问题文本 + 补充输入窗口（宿主基于 `question_pending` 事件渲染提问 UI）
- **约束**：`askLimit` 默认 3（超限按默认方案继续并在输出标注不确定性）；问题文本过输出护栏；提问挂起不计入 `maxRoundDuration`
- **答复继续**：`resumeExecution(答复)` 注入，走恢复通道非 Trigger 通道（不触发 recall/角色重匹配）

### 三·一 自审查轮（MVP 内）

MVP 闭环含**自审查轮**（§一）：成品写入前，Agent 基于**外部确定性信号**自审一遍，而非纯 LLM 自我评价——

- **判据绑定外部验证**：自审查只校验**可验证的确定性信号**——本轮目标点是否覆盖、关键 rule 约束是否遵守、产出结构是否完整、可运行项是否通过（如格式/测试校验）。自审查轮是回答中工具结果校验与回答后收尾校验的落点，**不引入独立引擎**（闭环内环节）。
- **防"自说自话"**：无外部信号的纯 LLM 自审不可靠（同一模型复查自己的输出可能越改越差）。因此自审查轮**只在有可校验判据时启用**，判据来自本轮目标与 rule 契约，而非模型自我感觉。无确定性信号时不做"为审而审"的复查（对齐"反思需绑定验证信号"的 2026 行业共识）。

---

## 四、Web 搜索（MVP 内）

写作查资料（科幻设定、地名细节、专业术语）：

- **机制**：既有 `web_search` 工具（`query`, `limit?`）+ `IWebSearchProvider`（`FetchWebSearchProvider` 默认实现），注入 `AgentOptions.webSearchProvider` 后条件性暴露——代码已实现（api-reference v2.1.0）
- **MVP 约束**：搜索失败静默降级（哲学 §6「降级优先」定案），不阻塞写作主流程；结果作为工具结果回填上下文（§README 5.2）

---

## 五、与既有实施文档的关系

| 文档 | 关系 |
|------|------|
| [role-pack-spec.md](role-pack-spec.md) | 角色包标准本体，MVP 是其中 L1 + 核心 L2 键子集 |
| [memory-as-summary.md](memory-as-summary.md) | 记忆 = 摘要即记忆的 MVP 落地（§一 记忆行、§六-8 记忆跨任务复用验收） |
| [architecture_philosophy_rules.md §11](../.trae/rules/architecture_philosophy_rules.md) | 插卡机设计哲学，定义 MVP 的角色包定位（通用引擎 ↔ 专业卡） |

---

## 六、MVP 验收标准

1. 用户与 Agent 对话讨论写作思路 ≥3 轮（对话模式），**对话全程角色包（写作助手）已装载并生效**（persona 视角 + rule 护栏 + skill 工具可用）；
2. 拍板后 Agent 自动生成完整短篇小说（Loop 模式，含自审查轮）；
3. 成品写入本地文件（`writeFile`——由角色包 skill 暴露）；
4. 生成中 Agent 可在关键节点主动提问（≤3 次，`askOn` 由角色包 L2 驱动），答复后继续；
5. 写一半用户插话可纠偏；可停止（abort 后清任务、对话历史保留）；
6. 需要时可用 `web_search` 查资料（角色包 skill 暴露），失败不阻塞；
7. **换角色验证**：加载第二个角色包（如"代码助手"）后，工具集与行为偏好随之切换——证明角色包是独立可插拔的行为单元（范式主张的最小验证）。
8. **记忆跨任务复用**：对话产生的思路摘要入库后，新会话（新窗口）能召回此前摘要并在回答中体现——验证"摘要即记忆"跨窗口链路（memory-as-summary）。
