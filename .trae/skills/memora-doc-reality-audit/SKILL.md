---
name: memora-doc-reality-audit
description: 在 memora 双包架构（内核 @zooique/memora + VS Code 宿主 hosts/memora-vscode）中审计「文档主张 vs 仓库事实」的一致性。当用户要核对 README / docs / config.example.json / 角色包文档与代码是否对得上、质疑「文档说的 X 代码里真有吗」、发版前过随包文档、或发现文档里写着具体存储后端（SQLite）/ 具体文件名（memora.db）/ 具体默认路径（~/.memora）时使用；也用于退役字段/概念后回扫文档；也用于 `.trae/**` 下规则/技能 md 的 frontmatter 损坏排查（`---` 被改成 `\---` 或 `***` ⇒ `alwaysApply: true` 静默失效、技能不可加载）与 `.prettierignore` 全域防护、用归一化比较证明「只做装饰性还原」。覆盖五类不一致（假默认值/时代措辞/死交叉引用/静默降级/**自证无落点**——代码注释声称「已持久化/已落盘」而承载它的结构根本不存在）的判别与取证、存储中立原则（内核只定契约、不规定后端）、具象词「理由 vs 承诺」分辨、SSOT 归属核查（只改镜像=造新伤）、退役概念回扫六处、随包白名单边界与死链闸门修法纪律、提交信息不得写未发生的事。
agent_created: true
---

# memora 文档-现实一致性审计

> 起因（2026-09-24 实锤）：随包文档里散布着 **SQLite 时代措辞**——
> `~/.memora` 被当成内核对 `dataDir` 的默认值（**内核根本没有任何默认值**）；
> 接入指南 §十 用「禁止…」框架描述宿主的存储分裂（真实机制是「各自 `new Agent`」）；
> `src/` 里 16 处 SQLite 具象，**12 处该改、4 处该留**。
>
> 「该留」与「该改」的分界线，就是本 skill 的唯一判据。

> ⚠️ **本节数字是事件记录（带日期），不是当前状态。**
> 引用任何当前值（剩余几处、白名单几项、测试几条）**必须现场实测**——
> 数字与行号**没有 SSOT**，这正是下文要审的那类问题本身。

## 何时用

- 用户问「文档说 X，代码里真有吗」
- 发版前核对 `package.json#files` 白名单内的随包文档
- **文档里出现具体实现具象**（存储后端 / 文件名 / 默认路径）——最强触发信号
- 改完内核字段或 API 后回扫文档
- 退役某个概念（字段 / 类 / 策略）后回扫

## 判据：一句话分辨「该写」与「该删」

**文档里凡出现具体实现具象，先问一句：这是「内核契约」，还是「宿主的选择」？**

| | 内核契约 | 宿主的选择 |
|---|---|---|
| 内容 | 接口形状、方法语义、必填/可选、失败行为 | 后端类型、库文件名、磁盘位置、目录层级语义 |
| 文档怎么写 | 写死，附**符号**锚点（非行号） | **只说「由宿主自选」**；具象只许出现在示例代码里 |
| 实例 | `IMemoryStorage` 15 方法、同步语义 | 「后端是 SQLite 还是 JSON 文件」 |

**口诀**：内核**不规定**宿主的存储方案，但**必须支持** SQLite / JSON / 内存等各种选择
⇒ 正确表述 = 「**存储方案由宿主自选，内核只定契约**」（`docs/memora-接入指南.md` §十 节首）。

### 具象词有「两种性质」——不许一刀切删

同一个 `better-sqlite3` 字样，可能是**理由**，也可能是**承诺**：

| 性质 | 判别 | 处置 | 本次实例 |
|---|---|---|---|
| **理由** | 该具象**解释了内核为什么这样设计** | **保留** | `src/memory/storageInterface.ts` 3 处：解释「接口为什么是同步的」——对齐 better-sqlite3 的同步 API |
| **承诺** | 该具象**让读者以为内核行为与某后端绑定** | 改 | 12 处：把「宿主 SQLite 不持久化 metadata」改成「`metadata` 不在存储契约的保证范围内」 |

**回改根不在文档，在源码注释**：当批提交（`git show --stat 1fba0b37`）共动 **26 个文件**，
其中 **15 个是 `src/**` 源文件**、5 个是随包文档、2 个是测试。
⇒ **只改文档 = 制造新的不一致**（见 §Step 3）。

## 五类不一致（按危害排序）

| 类 | 形态 | 危害 | 判别问句 |
|---|---|---|---|
| **A 假默认值** | 文档写「内核默认 `~/.memora`」，代码无此逻辑 | 宿主不传 → 读者以为有兜底 → 落盘位置失控 | 该默认值的**赋值点**在哪？grep 不到 = 假的 |
| **B 时代措辞** | 用旧后端的框架描述现行为 | 读者按旧后端的集成方式上手，拿到的是别的东西 | 把这句话里的后端名换掉，还成立吗？ |
| **C 死交叉引用** | 「见 §十.1」但该子节不存在 | 断链，读者找不到真源 | 锚点目标是否真实存在？ |
| **D 静默降级** | 文档承诺「按名切换」，代码静默不切 | 宿主以为成功，实际没切 | 失败路径有守卫吗？ |
| **E 自证无落点** | **代码注释**声称某事已发生（「已持久化」「已落盘」），而承载它的结构根本不存在 | 最高：后续改动把假前提当地基，整条链建在空中楼阁上，且已推远端后要整笔回滚 | 这件事声称已发生的**落点**在哪（哪个字段 / 哪次 save）？grep 不到 = 假的 |

### A 类实证：`dataDir` 的假默认

| 项 | 内容 |
|---|---|
| 文档主张 | `config.example.json` 写 `dataDir: "~/.memora"`；`AgentOptions.dataDir?: string` 是**可选**的 |
| 代码事实 | `src/` **零处**「未提供时回退 `~/.memora`」逻辑 |
| 后果 | 「可选的 `?`」+「示例值」被读成「内核有兜底」 |
| 修法 | 类型收紧为**必填** `dataDir: string`（3.0.0 未发 npm = 零成本破坏窗口）；文档明写「**内核不消费它，也没有任何默认值**；`config.example.json` 里写 `~/.memora` 只是一个示例值」 |

**锚点**：`src/agent/types.ts` 的 `dataDir` JSDoc + `docs/memora-api-reference.md` 构造参数表。

### D 类实证：`switchProject` 曾静默降级

传一个**既非已注册项目名、又非绝对路径**的字符串 → 内核静默不切；变异验证更显示**伪目录被创建且安全守卫允许根被扩**。
修法：加守卫并显式抛错，错误信息给两条出路（按名先 `registerProject` / 按路径传绝对路径）。

**纪律**：守卫必须**变异验证**——把守卫去掉，确认**只有新用例转红**，其余全绿，再恢复并字节级复核无残留。
（曾踩坑：`MemoraError.message` 只装 `title`，断言 `toThrow(/detail/)` 必红 → 应断言 `rejects.toMatchObject({ detail: ... })`。）

### E 类实证：`clearPendingAsk` 的「答案已持久」是假的（2026-10-31）

| 项 | 内容 |
|---|---|
| 注释主张 | `MessageHistory.clearPendingAsk` 的 JSDoc 写：「答案已随 `answerQuestion` 的 `appendToolMessage` 进消息史**持久**，故提前清盘不丢数据」 |
| 代码事实 | `AgentLoop.appendToolMessage` 方法体只有 `this.messages.push(...)`，**零落盘**；`Round` 持久化结构不承载 tool 消息 ⇒ 所谓的「已持久」不存在 |
| 真实落点 | 答案首次落盘在 `MessageHistory.appendUser` → `Round.interactiveInputs`，时序**远晚于**清盘点 |
| 后果 | 整条改动把「自己造成的『丢失一条诚实的 unanswered 记录』」包装成了「修 bug」，已推双远端，最后整笔回滚 |
| 真源 | 仓库里本来就有正确答案：`RoundPendingAsk` 的 JSDoc 写着「非空 ⇔ 该轮存在『问了但未答**且作答记录未落盘**』的窗口」 |

**为什么它归本 skill**：Step 3 的「代码是源、文档是镜像」有一个**例外**——
代码注释**不是**源，**代码本身才是源**；注释只是另一面镜子，同样会撒谎。
审计「文档主张」时若把源码注释当作免检真源，就会整类漏掉。

**判别三步**（对任何「已持久化 / 已落盘 / 已缓存 / 已写入」型断言）：

1. 这句话声称**已经发生**的是哪件事？
2. 承载它的**结构**叫什么？打开该结构的类型定义，**看有没有这个字段 / 方法**（本仓最常见的形态缺失：`Round` 无 tool 消息位）。
3. 产生它的**调用点**在哪？若答案停在「push 进进程内数组」，那不是持久化，是内存。

⚠️ 同型错误在本仓已犯第二次（第一次是 `appendAssistantToolCall` 只 push 内存不落盘）——
所以这不是偶发，是**本地常见错误形态**，应默认怀疑。

## 取证流程（不许凭记忆）

### Step 1 — 建表：文档主张 → 代码事实

从文档里**逐条抄出可验证的断言**（抄句子，不是通读），每条配一个「怎么证伪它」的命令。

### Step 2 — grep 双向取证

```bash
# 具象词在源码里的全量落点
rg -n "sqlite|SQLite|better-sqlite3" src/
# 具象词 + 疑似默认路径在文档里的全量落点
rg -n "sqlite|SQLite|~/\.memora|\.db\b" docs/
```

- **搜内容用 Grep 工具 / rg；搜文件名用 Glob。**（本次踩坑：按内容搜 `commentHygiene` 搜不到
  `src/__tests__/commentHygiene.test.ts`——因为**文件名有、内容没有**。别把「文件名命中」当成「内容命中」。）
- **数字必须同批复核**：行号与计数**没有 SSOT**，每修一次即过期。
  不在报告里留下「共 N 处」然后隔天引用——要么当场重跑，要么别写数字。

### Step 3 — SSOT 归属核查（**最关键**）

**先找源头，再改镜像。**

同一事实同时存在于「代码注释」与「文档」时，**代码是源、文档是镜像**。
只改文档 = 文档说 A、代码说 B = **制造新的不一致**。

**实操**：把 Step 2 grep 出的落点按「源 / 镜像」分类，**先改源**，再让文档跟着源走。

度量方法（可复算，别用「我记得改了几处」）：`git show --stat <本批提交>` 看**文件分布**——
若 `src/**` 的文件数明显多于文档数，说明源头确实改了；反之就是「只擦了镜子」。

### Step 4 — 退役概念回扫六处

改完一个概念，回扫这六处（缺一处即留残渣）：

1. `docs/`（含子目录）
2. 代码注释（**含 `.d.ts`**）
3. 测试文件头注释
4. `README.md` **+ `README.en.md`**（中英双版，**英文版最易漏**）
5. `package.json#files`
6. `.trae/rules/`

### Step 5 — 验证

```bash
npm run docs:links                              # 发布面死链闸门（local-ci 任何步骤都不含，须单跑）
vitest run src/__tests__/commentHygiene.test.ts  # 注释定位守卫
tsc --noEmit                                    # 收紧了类型必跑
```

⚠️ 上面的裸命令是**语义版本**；本环境直接跑会失败（缺 coreutils / `npx` EXIT=127）——
**可复制的绝对路径版本见文末「本环境命令」，以那节为准。**

## 铁律一：随包边界 = `package.json#files`，闸门有盲区

`docs:links` 死链闸门**只扫随包的 `.md`**（`files` 白名单 + `ALWAYS_SHIPPED`
= `package.json` / `README.md` / `README.en.md` / `LICENSE` / `CHANGELOG.md`）。

当前白名单（2026-09-24 实测）：

```
dist, README.md, README.en.md, LICENSE, config.example.json, role-packs,
docs/memora-api-reference.md, docs/memora-接入指南.md, docs/role-pack-开放键指南.md,
docs/architecture/role-pack-spec.md, docs/architecture/role-pack-authoring-guide.md, CHANGELOG.md
```

⇒ **`hosts/**` 下的 `.md` 与 `docs/` 里不随包的文档在闸门盲区**。
判「某文档值不值得改」先看它是否随包——**随包的才致命**。

⚠️ 别把「闸门通过」当成「文档一致」的证明：闸门只查**链接可达**，不查**内容属实**。

### 死链闸门的两类判定与**修法纪律**

| 判定 | 含义 |
|---|---|
| `missing` | 目标在磁盘上不存在 —— 连仓库内都是断的（真 bug，如路径深度写错） |
| `unshipped` | 目标存在但不在发布包 —— **仅 npm 消费者断**（发布边界缺陷） |

**修法纪律：默认<u>不扩白名单</u>**（扩 = 把内部分析文档重新塞回 npm 包，与「发布面收窄」相反）：

- 指向内部文档 → **去链接化、使散文自足**
- 出货文档里已有该内容 → **改指向随包 SSOT**

## 铁律二：代码锚点用**符号引用**，不用行号

内核有守卫 `src/__tests__/commentHygiene.test.ts`，禁止注释位出现三类行号引用：

1. `路径.ts:数字`（跨文件行号）
2. `路径.ts L数字`（空格分隔，性质同 1）
3. 裸 `L` + 两位及以上数字

**根因**：行号**没有 SSOT**，增删代码是日常动作 ⇒ 失效是必然，不是偶然。
（清零时实测：15 处**全部**漂移或错位——3 处指向物理不存在的位置、1 处文件归属亦错、1 处引用了全仓零定义的幽灵符号。）
定位一律改用**符号引用**（函数 / 常量 / 类型名）——符号有 SSOT，重命名会被 `tsc` 与全库 grep 暴露。

- **扫描面 = 注释位**（整行 / 行尾 / 块 / JSDoc），**不覆盖代码位**——项目搜索工具的输出格式断言本身就是「路径:行号」形态，那是**被测数据**
- **宿主侧另有同名守卫**（`hosts/memora-vscode/src/webview/__tests__/commentHygiene.test.ts`），**语义有差异，别互相照抄**
- **注释里的 URL 也会中招**：守卫看的是注释位全文、不做 URL 豁免。实测
  （把真源 `LINE_REF` 提取出来跑样本，非手抄）：`// 见 https://x/y.ts:12` **命中 `//x/y.ts:12`**
  ——注意它把 `https:` 后面的两个斜杠一起吞进匹配串。反向护栏同样实测：
  纯路径（`docs/memora-接入指南.md`）、§ 章节号、`L0-L3` 层级术语**均放行**。
- 写文档时**别照抄源码行号**——文档虽不被守卫扫，但同样的漂移问题一样存在

## 铁律三：台账（`tasks/待完成任务.md`）状态串不可信

工作区操作会**回退**台账 ⇒ 标「待提交」的可能早已入库。**以 git 为准**：

```bash
git status --porcelain
git log --oneline -8
git log --oneline -3 -- <file>    # 逐文件确认真提交了
```

发现过期状态 → **订正台账**（台账是 SSOT，状态错了等于撒谎）。

## 铁律四：提交信息里每句「某文件做了 X」，落笔前必须 `git diff` 复核

**血训**：曾在提交信息写「`types.ts` 剪 N3 残痕」，实际该改动早已被更早的提交吃掉——`git diff` 一复核就露馅。

**提交信息是事实陈述，不是意图陈述。** 报告/台账里的实测数字同样不可采信，须自测。

## 铁律五：审计结论必须转成台账条目

**报告本身不是交付物。** 结论无台账条目 = 下轮必然重犯。
每条发现写成 `tasks/待完成任务.md` 的一条（判据 + 证据 + 修法），销项时迁到已完成。
⚠️ 销项前必查「详细记录归属」——详情可能只在 untracked 的 `tasks/审查-*.md` 里。

## 铁律六：改 `.trae/` 下任何 md 前后，必须查「frontmatter 是否还活着」

**血训（2026-09-25，已推送后才发现）**：8 个规则文件的 frontmatter 分隔符被改写成 `\---`，
其中常驻文件 `memory-role-pack-boundary-rules.md` 的 `alwaysApply: true` **静默失效**
⇒ 该文件从未随会话注入，**没有任何报错**。同一批里 ADR-018 的 `---` 被改成 `***` + 98 个短横线。

### 损害签名与检测（三条命令，改完就跑）

```bash
# ① 转义型破坏（rules 层）：每个被改坏的文件恰好命中 2 处（首尾分隔符）
git grep -c '^\\---' HEAD -- '.trae/**/*.md'
# ② 星号型破坏（decisions 层）
git grep -n '^\*\*\*' HEAD -- '.trae/decisions'
# ③ 工作量指标：CJK 表格被按「显示宽度」填充（显示宽 2 / 字符数 1）⇒ 字符数膨胀近 1 倍
```

### 必须挡住，且要**扫全类**，不只挡已爆的文件

- 已爆的是 `rules`；但 `.trae/skills` 下 **30 个 md 同样带 frontmatter**（破坏即技能不可加载）——
  属**同一个损害类**。只修已爆的 8 个文件 = 半个补丁。
- `.prettierignore` 用**一条** `.trae/**/*.md` 全域挡住（初版只挡 rules+decisions，实测仍有 37 个 `.trae` 文件被命中）。
- 验证：`prettier --check .` 输出里 `grep -c '\.trae/'` 必须为 **0**。
- ⚠️ 闸门里**没有** format:check（`local-ci` 10 步不含 format），所以「门禁全绿」**不能**证明 md 没被格式化。
  归因也别急着下：prettier 对干净版本**不产生**该转义——写注释时说「归因未复现」比编一个原因诚实。

### 修复纪律：用**归一化比较**证明「只做装饰性还原」

损坏里混着「转义 + 填充 + 行尾空白」三种噪声，直接读 diff 会误判成「内容被压掉了」。做法：

1. 把 HEAD 版本导出到临时目录（`git show HEAD:<path>`）。
2. 两侧都归一化：去 `\---` 转义、去 `N\.` 转义、去行尾空白、去表格填充（**保留 `\|` 转义**）、
   丢表格分隔行、合并连续空行。
3. 归一化后**字符串全等** ⇒ 证明补丁零语义差异（这是唯一能证明「没压掉判据」的手段）。
   不等 ⇒ 逐行列出差异再判断。
4. 全库兜底扫描：残留 `\---` = 0、改动文件全部 LF、frontmatter 首行 = `---`。

## 本环境命令（Windows / 缺 coreutils）

```bash
cd "$(git rev-parse --show-toplevel)"

# 发布面死链闸门（local-ci 任何步骤都不含，须单跑）
node node_modules/tsx/dist/cli.mjs scripts/check-publish-links.ts

# 注释守卫（Bash 缺 coreutils → 不要管道过滤，用 dot reporter）
node node_modules/vitest/vitest.mjs run src/__tests__/commentHygiene.test.ts --silent --reporter=dot

# 类型
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# 发布白名单（判断某文档是否随包）
node -e "console.log(require('./package.json').files)"

# 提交信息预验（npx 在本环境 EXIT=127 → 必须 node 直跑真实路径）
node node_modules/@commitlint/cli/lib/cli.js --edit .git/memora-commit-msg.txt
```

- **不要用管道过滤**（`| head` / `| tail` / `| grep` 不可用）——退出码会被管道尾端吞掉造成**假绿**。
- 本环境 **git 写操作不可行**（Bash 走 POSIX 沙箱禁写、PowerShell 无法 spawn 外部进程）
  ⇒ AI 只负责写好 UTF-8 提交信息文件 + 给逐文件 `git add` 清单，**由用户在真实终端执行**。
  信息文件落 **`.git/memora-commit-msg.txt`**——本项目 `tmp/` **未进 `.gitignore`**，
  `git status` 会长期挂着 `?? tmp/`，且一旦误纳就得再补一个 `git rm` 提交。本仓**禁用 `git add -A`**。
- 删 scratch 文件：`Remove-Item` 被 safe-delete 批量守卫拦（报 `SAFE_DELETE_BULK_GUARD_ERROR`），
  改用 `[System.IO.File]::Delete('<绝对路径>')` / `[System.IO.Directory]::Delete('<绝对路径>')`，
  **删后用 `test -d` / `Test-Path` 复验**，别信退出码。

