# 角色包 skills 演进方案 · 渐进披露（Progressive Disclosure）

> **定位**：角色包 `manifest.skills` 从"能力声明"演进为"可装载技能系统"，对齐 Agent Skills 行业标准。
> **状态**：**已实现**（2026-08-15 read_skill + L1；2026-08-18 两级技能统一 + C2 能力独立），本方案为实现蓝本与演进记录。
> **关联**：[role-pack-spec.md](./role-pack-spec.md) §四（能力声明）/ §2.1（角色包 vs Skills）；样例见 [角色包 manifest 示例](./role-pack-spec.md)。

---

## 一、问题定义（种子）

### 1.1 现状（诚实缺口）

角色包 `manifest.skills` 的 `file` 指针当前**不装载正文**；能力面独立为顶层 `capabilities`（C2，2026-08-18），映射工具白名单：

```json
"skills": [
  { "file": "skills/write.md", "name": "write", "description": "把成稿写入本地文件" }
],
"capabilities": [
  { "capability": "file:write", "description": "写入文件" }
]
```

- `capabilities[].capability: file:write` → 生效（映射 `write_file` 工具白名单）
- `skills[].file: skills/write.md` → **不生效**（生态兼容指针，正文不装载）
- `skills[].name` / `description` → L1 常驻暴露给 LLM（渐进披露 L1）

**缺口**：角色包声明了"有这篇技能"，但 LLM 既看不到它的存在（无 name/description 常驻），也无法读取它的正文（无装载工具）。`file` 是"挂着但没通"的指针。

> **已解决（2026-08-15）**：本缺口经渐进披露实现关闭——L1 元数据常驻 + read_skill 工具按需装载正文（见 §五 落地清单）。本节为演进动因的历史记录。

### 1.2 演进目标

对齐 Agent Skills 渐进披露（Progressive Disclosure）行业标准：

| 层级 | 内容 | 装载时机 | 用途 |
|------|------|---------|------|
| L1 元数据 | name + description | **常驻**（每轮 system prompt） | LLM 知道"有哪些技能，各是什么" |
| L2 正文 | skills/*.md 全文 | **按需**（LLM 调用工具读取） | LLM 判定当前任务需要时获取细节 |

**核心转变**：技能装载的判断权从**宿主**（当前 `matchAndInjectSkill` 预匹配注入）转移到 **LLM**（运行时按需调用 `read_skill` 工具）。

---

## 二、行业做法（土壤）

### 2.1 Agent Skills（Anthropic 开放标准，2025-12-18）

- **格式**：文件夹 `SKILL.md` + frontmatter（name/description）+ references/scripts；
- **渐进披露**：会话开始仅注入每个技能的 name+description（约 100 token/技能），LLM 判定需要时读取完整正文——成本约一行 prompt/技能；
- **发现**：SDK 索引所有技能，name+description 入 system prompt，正文延迟加载。

### 2.2 Agent Plugins 1.0（2026-08-06，五方+Google）

- **打包**：`plugin.json` + `skills/` + `mcp.json`，文件夹包分发；
- **仅两种可移植组件**：Agent Skills 与 MCP servers；
- **与角色包关系**：骨架同构（§十），角色包在其上增加行为层（persona/rules/strategy）。

### 2.3 vs 现有 memora 预匹配注入

| 维度 | 现状（matchAndInjectSkill） | 渐进披露（本方案） |
|------|---------------------------|-------------------|
| 判断权 | 宿主（关键词/正则 match） | **LLM**（语义理解） |
| 上下文占用 | 命中即注入整篇正文 | 元数据常驻，正文按需 |
| 匹配精度 | 关键词，可能误判 | LLM 语义，更准 |
| 与行业对齐 | 无对应 | **标准做法** |

---

## 三、方案设计（自然生长）

### 3.1 职责分离（SSOT）

以单一真理源为原则，`manifest.skills` 每项字段职责清晰、互不重叠：

| 字段 | 职责 | 消费方 |
|------|------|--------|
| `capability` | 中立能力声明 → 映射工具白名单 | `resolveCapabilityTools`（已有） |
| `file` | **技能正文装载路径** → read_skill 读取 | 新增 `read_skill` 工具 |
| `name` + `description` | **L1 常驻元数据** → 暴露给 LLM | 新增 L1 元数据注入 |

### 3.2 四层接线（内核 → 宿主 → UI 不动）

```
manifest.skills
   ├─ capability ──→ resolveCapabilityTools ──→ 工具白名单（已有，不动）
   ├─ file ──→ read_skill 工具 ──→ RolePackManager.readSkillContent（新增）
   └─ name+description ──→ L1 元数据注入 system prompt（新增）
```

**关键**：read_skill 直接读取激活角色包内嵌技能正文（`RolePackManager.readSkillContent`），**不新建并行技能系统、不混入宿主全局 SkillManager**——角色包内嵌技能与宿主全局技能来源分治（职责分离，SSOT）。

### 3.3 新增 `read_skill` 工具（内核）

```typescript
/**
 * 渐进披露 L2：按需读取激活角色包内嵌技能正文
 * 参数：name（技能名，来自 L1 元数据）
 * 返回：技能正文（manifest.skills 的 file 指向内容）
 */
read_skill: {
  name: 'read_skill',
  description: '读取指定技能的完整正文（渐进披露，按需调用）',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  handler: (name) => rolePackManager.readSkillContent(name) ?? '技能不存在',
}
```

- 标记 **idempotent**（只读，幂等——对齐现有内置工具幂等映射）；
- 注册进 `BUILTIN_TOOLS`；
- 受工具白名单约束：角色包需声明 `capability` 才能暴露。

### 3.4 L1 元数据注入（新增）

在 `applyRolePackToolExposure` 同阶段，将激活角色包的 `manifest.skills` 的 name+description 注入 system prompt：

```text
【可用技能】
- write：把成稿写入本地文件
- search：写作查资料
```

- 复用 `RolePackCapability` 已有 name/description 数据，无需新数据源；
- 每技能一行，常驻省 token。

### 3.5 与现有 `matchAndInjectSkill` 的关系

**共存策略（不替换，不冲突）**：

| 机制 | 适用技能 | 触发 |
|------|---------|------|
| `matchAndInjectSkill`（保留） | 宿主全局技能（configDir/skills/） | 关键词/正则预匹配 |
| `read_skill`（新增） | 角色包内嵌技能（manifest.skills） | LLM 按需调用 |

两者分治不同技能来源，不重复。角色包内嵌技能走渐进披露，宿主全局技能保留预匹配注入——职责边界清晰，未来可评估统一（非本方案范围）。

---

## 四、交互审查（角色包 ↔ 行业 ↔ 内核）

### 4.1 与 Agent Skills 生态互认

- 角色包 `skills/*.md` 即 Agent Skills 格式（同构，§十）；
- `file` 指针指向的文件符合 Agent Skills 目录规范时，可被其他实现直接装载；
- **兼容性**：演进为"正文按需装载"是能力增强，非格式变更——`file`/`capability`/`name` 字段语义不变，仅 `file` 由生态指针升级为装载入口。

### 4.2 SSOT 审查

| 检查 | 结论 |
|------|------|
| 是否新建平行技能系统？ | ❌ 复用 `RolePackManager.readSkillContent`，`read_skill` 是工具接线 |
| 字段职责是否重叠？ | ✅ capability/file/name 三职责分离，单一真理源 |
| 是否越层？ | ✅ 内核只产工具+元数据，宿主装配，UI 不动 |
| 是否重复造轮子？ | ✅ `name+description` 复用 `RolePackAssembly.skills`，正文经 `readSkillContent` 按需读取 |

### 4.3 风险与边界

| 风险 | 缓解 |
|------|------|
| LLM 频繁调 read_skill 增加延迟 | L1 元数据充分描述，LLM 精准判断；技能正文 ≤500 行（既有约束） |
| 技能正文注入污染上下文 | 渐进披露天然省 token；仅需时装载 |
| 与宿主全局技能混淆 | 分治策略（§3.5），来源边界清晰 |
| 幂等/安全 | read_skill 只读，标记 idempotent，受白名单约束 |

---

## 五、落地清单（2026-08-15 已实现）

- [x] 内核：新增 `read_skill` 工具（注册 BUILTIN_TOOLS + 幂等映射）
- [x] 内核：L1 元数据注入（`buildSystemPrompt` 暴露激活角色包 skills name+description）
- [x] 内核：`RolePackManager.readSkillContent()` 读取内嵌技能正文（L2 数据源）
- [x] 内核：`ToolExecutor.readSkill` 回调注入 + `read_skill` 执行分支
- [x] 内核：两级技能统一（2026-08-18）——全局 `buildSkillList` L1 + `read_skill` 双源；C2 能力独立顶层 capabilities
- [x] 装配：`assembler.ts` 注入 readSkill 回调（rolePackManager → toolExec）
- [x] 测试：read_skill 读正文 / 元数据注入 / 回调接线 / 幂等（84 文件 / 1986 测试全通过）
- [x] 文档：role-pack-spec §四 更新"正文按需装载"声明（本文件同步）
- [x] 评估：与 matchAndInjectSkill 的长期统一策略——**结论：维持双轨，不强行统一**（见 §七）

> **实现决策（偏离原方案一处）**：原方案设想"角色包内嵌技能注册进 SkillManager"，实现时改为**直接经 `RolePackManager.readSkillContent()` 读取**，未混入宿主全局 SkillManager——保持角色包内嵌技能与宿主全局技能来源分治（职责分离，SSOT），read_skill 只读激活角色包的内嵌技能。

---

## 六、结论

本方案将角色包 skills 演进为"渐进披露的可装载技能系统"，对齐 Agent Skills 行业标准（L1 元数据常驻 + L2 按需装载）。**核心是复用现有数据源，不新建平行系统**；`file` 指针从"生态指针"变为 read_skill 的装载入口。**C2 定案（2026-08-18）**：能力声明已独立为 manifest 顶层 `capabilities`（能力面=工具白名单），`skills` 回归纯技能文件引用（内容面）——`capabilities`/`file`/`name` 职责分离，单一真理源。

**决策**：已实现。两级技能统一渐进披露（2026-08-18）：全局通用技能（buildSkillList）+ 角色包技能（manifest.skills）同构，read_skill 双源读取。

---

## 七、与 matchAndInjectSkill 的统一策略评估（2026-08-15 定案，2026-08-18 两级技能演进）

> **结论**：两级技能统一渐进披露已实现（2026-08-18）——全局技能与角色包技能**同构**（L1 清单 + L2 read_skill），同时保留 `matchAndInjectSkill` 作为全局技能的可选确定性触发（双轨并存的演进路径，非强制统一）。

### 7.1 演进后的事实（2026-08-18）

| 机制 | 数据源 | 形态 |
|------|--------|------|
| `buildSkillList`（渐进披露 L1） | 全局 `SkillManager` + 角色包 `manifest.skills` | 两级技能清单常驻 system prompt |
| `read_skill`（渐进披露 L2） | 双源：先角色包 `readSkillContent`，再全局 `skillManager.get()` | LLM 按需读正文 |
| `matchAndInjectSkill` | 全局 `SkillManager.match` | 可选确定性触发（保留） |

### 7.2 历史结论（保留为演进记录）

1. 数据源天然分治：宿主全局技能在 `configDir/skills/`，角色包内嵌技能在 `role-packs/<名>/skills/`，共享 configDir 但子目录不同，无重叠。
2. 职责互补而非冗余：matchAndInjectSkill 解决"宿主确定性触发"，read_skill 解决"LLM 按需装载"。
3. 统一不能破坏 SSOT：两套来源并入一机制需引入"来源标签"，制造冗余（避免）。

### 7.3 边界

- **两级技能统一（已实现）**：全局 + 角色包同构渐进披露；
- **matchAndInjectSkill 保留**：全局技能确定性触发，不删除；
- **能力面独立（C2）**：capabilities 顶层声明（工具白名单），与技能内容面分离。

### 7.4 结论

统一策略 = **维持双轨 + 明确边界**。两套机制服务不同来源、不同判断权，职责互补，共同构成"确定性触发 + 按需装载"的完整技能体系。未来若宿主全局技能需按需装载，由宿主复用 read_skill 路径实现，内核不统一。

---

## 附录 · 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-15 | read_skill 工具实现 + L1 元数据注入 + 统一策略评估 |
| 2026-08-18 | 两级技能统一（全局 buildSkillList + read_skill 双源）；C2 能力独立顶层 capabilities |