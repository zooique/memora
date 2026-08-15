# 角色包 skills 演进方案 · 渐进披露（Progressive Disclosure）

> **定位**：角色包 `manifest.skills` 从"能力声明"演进为"可装载技能系统"，对齐 Agent Skills 行业标准。
> **状态**：设计定案（2026-08-15）——行业做法 + 角色包交互审查。**当前不落地**，memora 处于草案演进期（v1 字段冻结延后），本方案为后续实现的蓝本。
> **关联**：[role-pack-spec.md](./role-pack-spec.md) §四（能力声明）/ §2.1（角色包 vs Skills）；样例见 [角色包 manifest 示例](./role-pack-spec.md)。

---

## 一、问题定义（种子）

### 1.1 现状（诚实缺口）

角色包 `manifest.skills` 的 `file` 指针当前**不装载正文**，内核仅消费 `capability`（映射工具白名单）：

```json
"skills": [
  { "file": "skills/write.md", "name": "write", "capability": "file:write", "description": "把成稿写入本地文件" }
]
```

- `capability: file:write` → 生效（映射 `write_file` 工具白名单）
- `file: skills/write.md` → **不生效**（生态兼容指针，正文不装载）
- `name` / `description` → **不暴露给 LLM**（仅存于元数据）

**缺口**：角色包声明了"有这篇技能"，但 LLM 既看不到它的存在（无 name/description 常驻），也无法读取它的正文（无装载工具）。`file` 是"挂着但没通"的指针。

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
   ├─ file ──→ read_skill 工具 ──→ SkillManager 装载正文（复用）
   └─ name+description ──→ L1 元数据注入 system prompt（新增）
```

**关键**：复用现有 `SkillManager` 的扫描/装载能力（`SkillEntry` 已含 `content`/`filePath`），**不新建并行技能系统**。角色包内嵌技能注册进 `SkillManager` 即可被 read_skill 读取。

### 3.3 新增 `read_skill` 工具（内核）

```typescript
/**
 * 渐进披露 L2：按需读取技能正文
 * 参数：name（技能名，来自 L1 元数据）
 * 返回：技能正文（skills/*.md 内容）
 */
read_skill: {
  name: 'read_skill',
  description: '读取指定技能的完整正文（渐进披露，按需调用）',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  handler: (args) => skillManager.get(args.name)?.content ?? '技能不存在',
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
- **不破坏**：当前"正文不装载"是 memora 的诚实声明，演进后变为"按需装载"，是能力增强非格式变更。

### 4.2 SSOT 审查

| 检查 | 结论 |
|------|------|
| 是否新建平行技能系统？ | ❌ 复用 `SkillManager`，`read_skill` 是工具接线 |
| 字段职责是否重叠？ | ✅ capability/file/name 三职责分离，单一真理源 |
| 是否越层？ | ✅ 内核只产工具+元数据，宿主装配，UI 不动 |
| 是否重复造轮子？ | ✅ `name+description` 复用 `RolePackCapability`，正文复用 `SkillEntry.content` |

### 4.3 风险与边界

| 风险 | 缓解 |
|------|------|
| LLM 频繁调 read_skill 增加延迟 | L1 元数据充分描述，LLM 精准判断；技能正文 ≤500 行（既有约束） |
| 技能正文注入污染上下文 | 渐进披露天然省 token；仅需时装载 |
| 与宿主全局技能混淆 | 分治策略（§3.5），来源边界清晰 |
| 幂等/安全 | read_skill 只读，标记 idempotent，受白名单约束 |

---

## 五、落地清单（后续实现时）

- [ ] 内核：新增 `read_skill` 工具（注册 BUILTIN_TOOLS + 幂等映射）
- [ ] 内核：L1 元数据注入（激活角色包的 skills name+description 入 system prompt）
- [ ] 内核：角色包内嵌技能注册进 SkillManager（加载阶段）
- [ ] 测试：read_skill 读取正文 / 元数据注入 / 白名单约束 / 幂等
- [ ] 文档：role-pack-spec §四 更新"正文按需装载"声明
- [ ] 评估：与 matchAndInjectSkill 的长期统一策略

---

## 六、结论

本方案将角色包 skills 从"能力声明"演进为"渐进披露的可装载技能系统"，对齐 Agent Skills 行业标准（L1 元数据常驻 + L2 按需装载）。**核心是复用现有 SkillManager，不新建平行系统**；`file` 指针从"空壳"变为 read_skill 的装载入口，`capability`/`file`/`name` 三者职责分离，单一真理源。

**决策**：当前仅记录为演进方向，不落地实现（memora 草案演进期）。用户确认后按 §五 清单实施。