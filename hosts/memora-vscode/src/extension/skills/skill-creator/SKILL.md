---
name: skill-creator
description: 创建或修改 memora 技能（SKILL.md）——采集需求、复制模板填槽、精修内容、跑确定性校验、冒烟后交付。当用户要新建技能、把重复流程沉淀成技能、或初始化技能骨架时使用；制作角色包请用 role-pack-creator，不要用本技能。
layer: agent
---

# 技能制作器

把一个真实需求做成 memora 可发现、可触发、可读取的技能。产出是项目级技能目录，不是角色包，也不是一份说明文档。

## 何时使用

- 用户说「新建技能」「把这个流程做成技能」「给刚做的工作沉淀一个技能」「初始化技能骨架」。
- 用户要把一段反复使用的操作步骤、判据或脚本固化成可复用能力。

## 何时不用

- 要做角色包（manifest、persona、行为策略）——用 `role-pack-creator`。
- 只是解释现有技能怎么工作——直接读对应 `SKILL.md`，不要生成新文件。
- 用户要求安装第三方技能——memora 没有技能市场安装流程，指引到设置页「导入资产」（命令 `memora.importAsset`）。

## 执行骨架（8 步，缺一步不算完成）

### 第 0 步：路由

先判这次是 create、update、explain 还是 install，再动手。判据是用户有没有明说「新建/写一个/做一个」或「改已有/补一下」。拿不准时先问一句，不要默认覆盖。

### 第 1 步：采集需求

只问缺失项，不把五个问题一次性糊给用户：

1. 技能名（kebab，和目录名一致）。
2. 一句话用途：解决什么问题、交付什么结果。
3. 触发场景 + 不触发场景（这决定 description 能不能被模型选中）。
4. 输入与返回：用户给什么、技能产出什么。
5. 是否需要长文档（`references/`）或脚本（`scripts/`）。
6. 落点：默认项目级，不允许直接写用户级。

产出：一小段结构化需求，留在对话里即可，不要先建文件。

### 第 2 步：命名与落点

硬判据：

- 名字匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`，且 `name` 等于目录名。
- 落点必须是 `<workspace>/.memora/skills/<name>/SKILL.md`。
- 不与当前可见技能重名（内置池、项目级、角色包内嵌技能都算；用户级用 `--user-skills-dir` 补查）。
- 目标已存在时默认拒绝，只有用户明说「更新」才在原目录修改；不要用 `--force` 重建已有技能。

落点真源：内核 `src/agent/assembler.ts` 的技能写入位置提示；用户级目录不在代理写入白名单（`hosts/memora-vscode/src/extension/host/assemble.ts`）。

### 第 3 步：生成骨架（脚本只复制填槽）

```bash
node scripts/skaffold-skill.mjs <name> --desc "单行用途与触发场景" --display 中文展示名
```

- 模板是静态文件 `templates/standard/SKILL.md`，脚本只做复制与占位符替换，不生成正文内容。
- 脚本会前置校验名字、description、目标是否已存在；失败就停，不要手写绕过。
- 更新模式跳过本步，直接在已有目录精修。

### 第 4 步：写内容

frontmatter 只有三件事：

| 字段 | 规则 |
|------|------|
| `name` | kebab，等于目录名 |
| `description` | 单行、不带引号、不含 `: `、不含 `<` 或 `>`，含 what + when，建议 ≤200 字符 |
| `layer` | `project`；内置技能写 `agent`，普通用户技能不要写 `agent` |

正文硬判据：

- 首个 H1 是中文展示名，不能重复英文 id。
- 正文非空，命令式，单文件不超过 500 行。
- 长内容进 `references/`，一次性命令进 `scripts/`，引用只允许一层。
- 内核 L3 只索引 `resources/`、`references/`、`scripts/` 三个目录，不要自造 `assets` 目录。
- 正文里点名 references 目录下的文件、resources 目录下的文件、scripts 目录下的脚本时，必须真的落盘，不写未来文件。

### 第 5 步：确定性自校验（重点）

```bash
node scripts/verify-skill.mjs <技能目录|SKILL.md>
```

六条硬判据，任一条失败都不得交付：

| 判据 | 脚本检查什么 | 内核 SSOT |
|------|--------------|-----------|
| frontmatter | 可解析、description 非空且合规、正文非空、layer 合法 | `src/skill/skillManager.ts` 的 `validateFile`、`src/utils/frontmatter.ts` |
| name | kebab，且等于目录名 | `src/skill/skillManager.ts` 的 `validateFile`（运行时真源）+ `globalSkillsConformance.test.ts`（kebab 字符集） |
| landing | 必须是 `<workspace>/.memora/skills/<name>/SKILL.md` | `src/agent/assembler.ts` 的写入位置提示 |
| doc-refs | 正文引用的三个 L3 目录路径逐个存在，禁止目录逃逸 | `src/skill/skillManager.ts` 的 `validateFile` + `src/utils/scanner.ts` 的 L3 白名单 |
| collision | 不与可见技能重名 | 同上守卫测试（跨源重名会被 UI 静默去重） |
| scripts | 正文指向的每个脚本实际跑一次 | 与角色包生成器同一条写→验→用纪律 |

补充说明：

- 脚本在临时目录执行冒烟，并注入 `MEMORA_VERIFY_SMOKE=1`。技能脚本应识别这个变量，冒烟模式只做语法/依赖自检，不执行破坏性动作。
- `--skip-scripts` 只用于只读预检，交付前必须跑完整校验。
- 校验脚本与角色包生成器共用 `_lib/verify-core.mjs` 的同一套判据原语；不要另写一份手写清单。

### 第 6 步：冒烟（用真加载器再验一次）

1. 执行命令 `memora.reloadSkills` 让宿主重新扫描。
2. 打开设置页技能列表，健康徽章不能是错误态。
3. 调 `read_skill` 传入技能名，正文能读回。
4. 有 `references/` 时调 `read_resource` 读一个具体文件。
5. 有 `scripts/` 时调 `run_skill_script` 跑一次真实入口。

### 第 7 步：交付

报告四件事：技能目录绝对路径、最终 description 原文、六条判据的通过结果、用户级迁移方式（设置页「添加到用户级」或导入资产，不直接写 globalStorage）。没有跑完第 5、6 步之前，不要说「完成」。

## description 四问（语义自查，脚本判不了）

1. 做什么——一句话说清交付物。
2. 何时用——写出具体触发词和场景。
3. 输入是什么——用户要给什么。
4. 返回什么——读完技能正文后模型能拿到什么。

触发信息只写在 description，不要只埋正文。正文不要复述 description。

## 与 role-pack-creator 的共同纪律

两条生成器只允许在「结构判据」和「落点」上不同，以下纪律必须一致：

- 静态模板是结构唯一真相源，脚本只复制填槽。
- 生成前先校验名字、覆盖、落点。
- 精修只在产出文件内进行，不回头改模板。
- 产出后必须跑确定性校验，再冒烟，再交付。
- 校验脚本与判据说明都指向内核真源，不维护第二份语义。

## SSOT 指针

- frontmatter 解析：`src/utils/frontmatter.ts`
- 技能校验与加载：`src/skill/skillManager.ts`
- 扫描与 L3 目录：`src/utils/scanner.ts`
- 技能写入位置：`src/agent/assembler.ts`
- 名称与跨源重名守卫：`hosts/memora-vscode/src/extension/host/__tests__/globalSkillsConformance.test.ts`
- 共用校验原语：`hosts/memora-vscode/src/extension/skills/_lib/verify-core.mjs`

以上任一真源变化时，先改脚本再改本文，不要反过来。
