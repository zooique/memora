---
name: project-onboarding
description: >
  Project onboarding / 构造扫描 for the memora repository. This skill should be
  used when starting a new conversation (or resuming after a gap) and needing to
  understand the project's structure before acting: locate and summarize
  .trae/rules (rules) and .trae/skills (skills), read README.md and package.json
  files for the kernel+host architecture, and load .workbuddy/memory + tasks/
  for long-term conventions and current work. Trigger phrases (Chinese or English):
  "了解项目", "项目构造", "扫描项目", "项目结构", "项目基本情况", "项目有哪些规则和技能",
  "项目在做什么", "项目红线", "onboarding", "新开窗口先了解", "先熟悉一下项目",
  "project structure", "what rules/skills does this repo have".
agent_created: true
---

# Project Onboarding（构造扫描）

Boot a WorkBuddy session on the memora repo with a verified, source-grounded
picture of its construction. The goal is **not** to dump files but to produce a
concise, accurate snapshot the agent can act on without re-deriving context.

## Core Principle — Auto-injected vs. Must-read

Two kinds of context exist; conflating them causes stale assumptions.

1. **Auto-injected (already in context):** `SOUL.md`, `IDENTITY.md`, `USER.md`,
   and the distilled project `MEMORY.md` summary. These are a *starting point*,
   not ground truth — they may lag behind the live repo.
2. **Must-read (NOT auto-loaded):** The contents of `.trae/rules/` and
   `.trae/skills/` are only *named* by a custom instruction ("项目的 .trae\rules
   是规则，.trae\skills是技能"); their file contents are **never injected**.
   To obey "do not rely on memory for facts," explicitly read them.

> Rule of thumb: if a decision depends on a rule or skill, read the actual file
> in this session — do not trust the injected summary alone.

## Procedure (read-only scan)

Execute these steps with read/search tools. Do not modify any file.

1. **Rules inventory** — Glob `.trae/rules/**/*.md`; for each, read the file
   (or at least its heading/frontmatter) and summarize its theme in one line.
   Known set (verbatim from each rule's frontmatter `description`):
   - `programmer-mindset-rules`: 资深程序员心智模型（Bug 修复 + 逻辑设计）
   - `ui-engineering-mindset-rules`: UI 工程化心智模型（设计令牌 + 组件抽象 + 样式继承 + JS 层生命周期 + 声明式工厂）
   - `progressive-refactor-rules`: 渐进式重构规范——覆盖"领域容器提取"与"职责拆分"两类模式，指导上帝类/上帝对象的安全拆分
   - `architecture_philosophy_rules`: 架构哲学原则（10 条：万物皆记忆 v2、永久性分级、冷热分离、模型分工、领域无关、增量召回、降级优先、自然遗忘、专注模式、单 Agent 模型）
   - `coding-convention-rules`: 通用编码约束规则（TS/JS 适用，兼顾 Electron、Node 本地项目）
   - `new-module-guide`: 新增模块的标准流程（防止随意加模块破坏架构）
   - `security_rules`: 安全规范（最小权限、显式允许、审计可追溯）
   - `cross-document-reference`: 跨文档交叉引用规范
   - `testing_rules`: 测试规范（三层金字塔 + Mock LLM 策略）
   - `sprite-project-rules`: memora-sprite 宿主项目总则、技术栈清单、目录结构、与内核的关系
   - `backend_layers_rules`: 后端分层规范（src/ 各模块的职责边界 + 核心库 vs 宿主项目边界）
   - `project-rules`: Memora 项目总则、技术栈清单、目录结构
2. **Skills inventory** — Glob `.trae/skills/**/SKILL.md`; read each
   `frontmatter` (`name`/`description`) and summarize capability. Known set:
   `big-tree-seeder` (播种: 规则/技能播种, ADR, 哲学摘要), `big-tree-grower`
   (生长: 重构/发布/剪枝/审查/UX 审查/炼化归元).
3. **Architecture** — Read `README.md` (philosophy + capabilities),
   root `package.json` (`@zooique/memora`, v2.x, zero runtime deps, Node ≥22),
   `hosts/memora-sprite/package.json` (`memora-sprite` v1.5.0, Electron host).
   State the kernel/host split and that the kernel is frozen into asar via
   `scripts/sync-memora.mjs`.
4. **Conventions & state** — Read `.workbuddy/memory/MEMORY.md` (long-term
   project notes; includes git red lines: Windows git writes via PowerShell +
   UTF-8, never Bash) and `tasks/待完成任务.md` (in-progress) +
   `tasks/已完成任务.md` (history).
5. **Synthesize** — Emit a snapshot (≤12 bullets):
   - 项目是什么（内核 + 宿主一句话）
   - 有哪些规则（按主题分组，一行一条）
   - 有哪些技能（一行一条 + 何时用）
   - 现在在做什么（待完成任务 top 项）
   - 我该守的红线（git 操作、单一真理源、复杂度守恒、提交前质量门）

## Variant Prompts (reusable text)

Embed these in user messages to invoke the workflow precisely.

**通用构造扫描（新窗口第一句）：**
```
请按"构造扫描"引导（只读，不改文件）：
1. 读取 .trae/rules/ 下全部 *.md 文件名，各用一句话摘要主题；
2. 读取 .trae/skills/ 下每个技能的 SKILL.md 的 frontmatter（name/description），摘要能力；
3. 读取 README.md 与根 package.json、hosts/memora-sprite/package.json，总结"内核+宿主"架构与版本；
4. 读取 .workbuddy/memory/MEMORY.md 与 tasks/待完成任务.md，提取长期约定与当前任务；
5. 用 ≤12 条要点输出：项目是什么 / 有哪些规则 / 有哪些技能 / 现在在做什么 / 我该守的红线。
```

**任务驱动型（做具体事之前，指定加载）：**
```
我接下来要做 [任务X]。请先加载 .trae/rules/[相关规则].md 与 .trae/skills/[相关技能]/SKILL.md
（如重构看 progressive-refactor-rules + big-tree-grower），按其中流程执行；
涉及提交时走炼化归元 §8。
```

**动手前验证（对抗式，防误判）：**
```
改动前先用 Grep/Read 定位真实调用链，再动手；完成后跑 tsc --noEmit + 相关 vitest
+ stylelint 作为提交前审查。
```

## Gotchas / Red Lines

- **Never skip step 1–2.** Rules/skills are the project's constitution; acting
  without them risks violating conventions the injected summary omitted.
- **git writes on Windows** must go through PowerShell with
  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`, never Bash — the
  POSIX sandbox desyncs from the real FS and can report phantom deletions.
- **Quality gate before commit:** `tsc --noEmit` + `eslint` + `lint:css`
  (stylelint) + `vitest`. Do not present work as done without these passing.
- This skill is **read-only**. It must not edit files, run builds, or commit.
