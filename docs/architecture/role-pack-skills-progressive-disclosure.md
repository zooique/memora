# Skills 三级渐进披露设计（Progressive Disclosure）

> **定位**：Skills 系统采用三级渐进披露模式，对齐 Claude Skills / Agent Skills 行业标准。
> **状态**：**L1+L2 已实现**（2026-08-15 read_skill + L1）；**L3 资源/代码分离规划中**（2026-08-18）
> **关联**：[role-pack-spec.md](./role-pack-spec.md)、[memory-role-pack-boundary.md](./memory-role-pack-boundary.md)

---

## 一、三级渐进披露模型

### 1.1 设计哲学

Skills 系统的核心设计是**渐进披露（Progressive Disclosure）**——从最小元数据到完整能力，逐级释放信息，避免一次性把所有技能内容塞进上下文窗口。

### 1.2 三级层次

| 层级 | 内容 | 装载时机 | Token 成本 | 用途 |
|------|------|---------|-----------|------|
| **L1 元数据** | `name` + `description` + `keywords` | **常驻**（每轮 system prompt） | ~100 token/skill | LLM 知道"有哪些技能，各是什么" |
| **L2 正文** | `SKILL.md` / `.md` 文件全文 | **按需**（LLM 调用 `read_skill` 工具） | ~1k-5k token/skill | LLM 判定需要时获取完整指令 |
| **L3 资源/脚本** | `resources/`（参考资料）+ `scripts/`（可执行脚本） | **按需**（LLM 调用 `read_resource` / `run_skill_script`） | 0 token/skill（脚本执行结果单独注入） | 资源供参考、脚本执行返回结果 |

### 1.3 与主流方案对齐

| memora | Claude Skills | Agent Skills 标准 |
|--------|--------------|------------------|
| L1 元数据 → system prompt | Level 1 Metadata → system prompt | name + description 常驻 |
| L2 read_skill → 按需读正文 | bash 读取 SKILL.md | 指令正文动态加载 |
| L3 resources + scripts | references + scripts | 资源/代码与指令分离 |

### 1.4 关键设计决策

#### 决策 1：L1 元数据常驻，不用 `list_skills` 工具查询

**理由**：
- 元数据（~100 token/skill）成本极低，20 个技能仅 ~2k token
- LLM 始终可见可用技能，自然选择，无需主动查询
- 避免多一轮 LLM 调用带来的延迟和成本
- **与 Claude Skills / OpenAI FC / LangChain Tools 全部一致**

**阈值保护**：当技能数量 > 30 个时，L1 清单自动降级为精简摘要（仅 name + 20 字描述），超过 50 个时切换为 `list_skills` 工具动态查询模式。

#### 决策 2：L3 脚本执行结果不进上下文

**理由**：
- 脚本可能执行大量计算（数据库查询、文件处理等），结果可能很大
- 脚本源代码**永远不进入** LLM 上下文——只有脚本的执行结果（最终答案）注入
- 这确保 Skill 可以包含复杂逻辑而不消耗宝贵的 context window
- **与 Claude Skills 的 scripts/ 设计完全一致**

#### 决策 3：两级技能同构

| 级别 | 存储位置 | 激活条件 |
|------|---------|---------|
| **全局通用技能** | `<configDir>/skills/` | 始终激活 |
| **角色包技能** | `<configDir>/role-packs/<包>/skills/` | 角色激活时才激活 |

两级技能共享同一套渐进披露机制（L1 清单 + L2 read_skill + L3 resources/scripts），数据源分治，接口统一。

---

## 二、L3 资源/代码分离规范

### 2.1 技能目录结构（三级完整形态）

```
<skill-name>/
  ├── SKILL.md              # L1 + L2：frontmatter 元数据 + 指令正文
  ├── resources/            # L3：参考资料（供 read_resource 读取）
  │   ├── api-spec.md       #   API 规范文档
  │   └── reference.json    #   结构化参考数据
  └── scripts/              # L3：可执行脚本（供 run_skill_script 执行）
      ├── query.sh          #   Shell 脚本
      ├── process.py        #   Python 脚本
      └── transform.ts      #   TypeScript 脚本
```

**也支持单文件形式**（简化版，无 L3）：
```
skills/
  └── 代码审查.md           # 单文件 SKILL.md 格式（无 resources/scripts）
```

### 2.2 L3 资源（resources/）

**用途**：存放技能的参考资料、规范文档、结构化数据等。这些内容不需要常驻上下文，但 LLM 在需要时可以通过 `read_resource` 工具读取。

**工具接口**：
```typescript
read_resource: {
  name: 'read_resource',
  description: '读取技能的参考资源文件（渐进披露 L3，按需调用）',
  parameters: {
    type: 'object',
    properties: {
      skillName: { type: 'string', description: '技能名' },
      resourcePath: { type: 'string', description: '相对 resources/ 的路径' }
    },
    required: ['skillName', 'resourcePath']
  }
}
```

### 2.3 L3 脚本（scripts/）

**用途**：存放可执行脚本。脚本在宿主环境中执行，**源代码不进入 LLM 上下文**——只有执行结果注入。

**脚本执行规则**：
1. 脚本必须声明 `runtime`（`node` | `python` | `shell`）
2. 脚本接受参数（从 LLM 的工具调用中传入）
3. 脚本的 stdout/stderr 捕获后作为工具返回值
4. 脚本执行有超时限制（默认 30s，最大 120s）
5. 脚本执行在沙箱中进行，不暴露宿主环境

**脚本 frontmatter 声明**（嵌入 SKILL.md 的 frontmatter，或脚本文件自身的 frontmatter）：
```yaml
---
name: 代码审查
description: 审查代码质量
scripts:
  - path: scripts/lint.ts
    runtime: node
    description: 运行代码 lint 检查
    timeout: 30
  - path: scripts/analyze.py
    runtime: python
    description: 分析代码复杂度
    timeout: 60
---
```

**工具接口**：
```typescript
run_skill_script: {
  name: 'run_skill_script',
  description: '执行技能的可执行脚本（渐进披露 L3，脚本结果返回，源码不进上下文）',
  parameters: {
    type: 'object',
    properties: {
      skillName: { type: 'string', description: '技能名' },
      scriptPath: { type: 'string', description: '相对 scripts/ 的路径' },
      args: { type: 'array', items: { type: 'string' }, description: '传递给脚本的参数' }
    },
    required: ['skillName', 'scriptPath']
  }
}
```

### 2.4 L3 实现清单

- [x] 设计文档（本文件）
- [ ] `skill/types.ts`：添加 `SkillResource`、`SkillScript`、`SkillLayer3` 类型
- [ ] `scanner.ts`：扫描时发现 `resources/` 和 `scripts/` 目录
- [ ] `SkillManager` / `RolePackManager`：暴露 `listResources()`、`readResource()`、`listScripts()` 方法
- [ ] `read_resource` 工具实现
- [ ] `run_skill_script` 工具实现（含沙箱执行、超时控制、结果捕获）
- [ ] system prompt L1 清单附加 L3 提示（"本技能含资源/脚本"）

---

## 附录 · 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-15 | 渐进披露 L1+L2 实现（read_skill + L1 元数据注入） |
| 2026-08-18 | 两级技能统一；C2 能力独立顶层 capabilities |
| 2026-08-18 | **重写文档**：明确三级渐进披露模型（L1 元数据 / L2 正文 / L3 资源脚本），对齐 Claude Skills 行业标准 |