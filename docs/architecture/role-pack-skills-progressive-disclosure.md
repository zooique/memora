# Skills 三级渐进披露设计（Progressive Disclosure）

> **定位**：Skills 系统采用三级渐进披露模式，对齐 Claude Skills / Agent Skills 行业标准。
> **状态**：L1/L2/L3 渐进披露已落地——L1 元数据清单、L2 `read_skill` 按需读正文、L3 `read_resource`/`run_skill_script`（实现见 [skillManager.ts](../../src/skill/skillManager.ts) `read_resource`/`listResources`、`skillScriptRunner.ts` 沙箱脚本，assembler 注入 L3 回调）
> **形态定案（2026-08-30）**：**以主流文件夹形式为标准**（`<名>/SKILL.md` 为唯一入口，Agent Skills 开放标准），**兼容轻量单文件形式**（顶层裸 `.md`，纯 L1/L2）；L3（`resources/` `references/` `scripts/`）**仅归属文件夹形式**——L3 隔离纪律（详见 §2.1，判定单一真理源 `isFolderFormSkill`，见 [scanner.ts](../../src/utils/scanner.ts)）。
> **字段对齐（2026-09-01，B1）**：技能 frontmatter **必填仅 `name` + `description`**（error 级，对齐 agentskills.io / TRAE 标准）；`keywords`/`trigger` 关键词命中系统已于 2026-09-08 全链移除（不再是可选增强字段）；只写两个字段的主流技能可直接加载运行。L3 资源兼容主流辅助文档目录 `references/`（与 `resources/` 并列，`read_resource` 按 subdir 选基目录，见 [scanner.ts](../../src/utils/scanner.ts)）。
> **关联**：[role-pack-spec.md](./role-pack-spec.md)、[memory-role-pack-boundary.md](./memory-role-pack-boundary.md)

---

## 一、三级渐进披露模型

### 1.1 设计哲学

Skills 系统的核心设计是**渐进披露（Progressive Disclosure）**——从最小元数据到完整能力，逐级释放信息，避免一次性把所有技能内容塞进上下文窗口。

### 1.2 三级层次

| 层级 | 内容 | 装载时机 | Token 成本 | 用途 |
|------|------|---------|-----------|------|
| **L1 元数据** | `name` + `description`（必填） | **常驻**（每轮 system prompt） | ~100 token/skill | LLM 知道"有哪些技能，各是什么"（L1 清单仅输出此两字段） |
| **L2 正文** | `SKILL.md` / `.md` 文件全文 | **按需**（LLM 调用 `read_skill` 工具） | ~1k-5k token/skill | LLM 判定需要时获取完整指令 |
| **L3 资源/脚本** | `resources/`（参考资料）+ `scripts/`（可执行脚本） | **按需**（LLM 调用 `read_resource` / `run_skill_script`） | 0 token/skill（脚本执行结果单独注入） | 资源供参考、脚本执行返回结果 |

### 1.3 与主流方案对齐

| memora | Claude Skills | Agent Skills 标准 |
|--------|--------------|------------------|
| L1 元数据 → system prompt | Level 1 Metadata → system prompt | name + description 常驻 |
| L2 read_skill → 按需读正文 | bash 读取 SKILL.md | 指令正文动态加载 |
| L3 resources + references + scripts | references + scripts | 资源/代码与指令分离 |

### 1.4 关键设计决策

#### 决策 1：L1 元数据常驻，不用 `list_skills` 工具查询

**理由**：
- 元数据（~100 token/skill）成本极低，20 个技能仅 ~2k token
- LLM 始终可见可用技能，自然选择，无需主动查询
- 避免多一轮 LLM 调用带来的延迟和成本
- **与 Claude Skills / OpenAI FC / LangChain Tools 全部一致**

**阈值保护**：当技能数量 > 30 个时，L1 清单自动降级为精简摘要（仅 name + 20 字描述），超过 50 个时切换为 `list_skills` 工具动态查询模式。

**SSOT 下沉实现**：
- 技能格式化与压缩逻辑统一由 `SkillManager.formatSkillForPrompt` 方法承载。
- 角色包管理器（`RolePackManager`）与全局技能管理器（`SkillManager`）均调用此方法，并通过 `compress` 参数控制是否启用压缩模式。
- 这确保了所有技能展示的格式与压缩策略单一，避免了多处硬编码正则或截断逻辑，符合 SSOT 原则。

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

### 2.1 技能目录结构（三形态定位）

> **L3 隔离纪律（2026-08-30 定案，对齐 Agent Skills 主流）**：仅「文件夹形式」（入口为 `SKILL.md`）发现 `resources/` `scripts/`。顶层裸 `.md` 的单文件技能所在目录 = 技能池共享根，如果对它做同级扫描，会把**别的技能的** `resources/` `scripts/` 误归给自己 → 污染。因此：
>
> - **文件夹形式（标准）**：拥有完整 L1/L2/L3；
> - **单文件形式（轻量兼容）**：纯 L1/L2，不拥有 L3——需要资源/脚本必须升级为文件夹形式。
>
> 判定单一真理源：`isFolderFormSkill(filePath)`（[scanner.ts](../../src/utils/scanner.ts)），`skillManager` / `rolePackManager` 复用，杜绝重复硬编码。

**文件夹形式（标准，三级完整形态）**：
```
<skill-name>/                # 技能文件夹（层级可嵌套，如 <pool-root>/<skill-name>/）
  ├── SKILL.md              # L1 + L2：frontmatter 元数据 + 指令正文（唯一入口，约定名强制）
  ├── resources/            # L3：参考资料（供 read_resource 读取）
  │   ├── api-spec.md       #   API 规范文档
  │   └── reference.json    #   结构化参考数据
  ├── references/           # L3：主流辅助文档目录（Agent Skills 兼容，B1；与 resources/ 并列）
  │   └── modes.md          #   参考手册
  └── scripts/              # L3：可执行脚本（供 run_skill_script 执行）
      ├── query.sh          #   Shell 脚本
      ├── process.py        #   Python 脚本
      └── transform.ts      #   TypeScript 脚本
```

**单文件形式（轻量兼容，纯 L1/L2）**：
```
skills/
  └── 代码审查.md           # 顶层裸 .md：纯 L1/L2（无 resources/scripts）
```

> **用户视角取舍**：主流开放标准（Claude Code / Codex / Cursor）只认文件夹形式；memora 作为落地项目，额外兼容单文件形式降低轻量技能的使用门槛——一条快忘的指令写成裸 `.md` 即可生效。二者加载语义一致（L1/L2），差异仅在 L3 归属，不会造成双标准割裂。

### 2.2 L3 资源（resources/ + references/）

**用途**：存放技能的参考资料、规范文档、结构化数据等。这些内容不需要常驻上下文，但 LLM 在需要时可以通过 `read_resource` 工具读取。

**目录约定（B1 兼容主流）**：
- `resources/`：memora 原生参考资料目录；
- `references/`：Agent Skills / TRAE 主流辅助文档目录（[modes-guide](../../../.trae/skills/big-tree-grower/references) 等大量开放技能使用此目录），为兼容直接复制来的主流技能而支持。

**工具接口**：
```typescript
read_resource: {
  name: 'read_resource',
  description: '读取技能的参考资源文件（渐进披露 L3，按需调用）。技能含 resources/ 或 references/ 目录时，可通过此工具读取参考资料。资源路径相对技能的 resources/ 或 references/ 目录。',
  parameters: {
    type: 'object',
    properties: {
      skillName: { type: 'string', description: '技能名' },
      resourcePath: { type: 'string', description: '相对 resources/ 或 references/ 的路径' }
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
- [x] `skill/types.ts`：添加 `SkillResource`、`SkillScript`、`SkillLayer3` 类型（[types.ts](../../src/skill/types.ts#L10-L36)）
- [x] `skillManager.ts`：扫描时发现 `resources/` 和 `scripts/` 目录（`discovered.resources/scripts`，[skillManager.ts](../../src/skill/skillManager.ts)）
- [x] `SkillManager` / `RolePackManager`：暴露 `listResources()`、`readResource()`、`listScripts()` 方法（[skillManager.ts](../../src/skill/skillManager.ts)）
- [x] `read_resource` 工具实现（[assembler.ts](../../src/agent/assembler.ts) L387 注入回调）
- [x] `run_skill_script` 工具实现（含沙箱执行、超时控制、结果捕获，[skillScriptRunner.ts](../../src/skill/skillScriptRunner.ts)；assembler L395 注入）
- [x] system prompt L1 清单附加 L3 提示（"本技能含资源/脚本"，[skillManager.ts](../../src/skill/skillManager.ts)）

---

> **状态**：L1+L2 已实现，L3 资源/代码分离已实现（三级渐进披露完整落地，上方正文即当前权威形态，不再保留逐次变更流水）。
>
> **诚实标注（已定案）**：L3 按需加载工具（`read_resource`/`run_skill_script`）为技能加载的**唯一**披露路径——v0.13 起 `matchAndInjectSkill` 预注入式匹配已随角色包手动切换收敛移除（角色自动匹配全链删除），技能正文一律按需披露，无"预先给"取向共存。