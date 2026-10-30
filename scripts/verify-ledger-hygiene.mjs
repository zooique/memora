#!/usr/bin/env node
/**
 * 台账结构卫生检查 —— 归档纪律的**四态分诊**从人工闸升级为机检
 *
 * 为什么存在（缺口 · 2026-10-26 实证）：
 *   归档脚本 `.trae/skills/memora-kernel-release/scripts/archive-kernel-release.mjs`
 *   按 `--ids` **人肉白名单**跑，补漏靠纪律里的一条「apply 后 commit 前逐条三态分诊」——
 *   **人工闸不是闸门**：`ARCH-DRAIN-1`（2026-10-23）补过 9 条，台账继续编辑就又漂回去。
 *   实测：0.2.0 区 140 个 ID，`archive/0.2.0-host.md` 里只有 40 个有副本。
 *
 *   2026-10-26 观察区归位迁移又暴露两条**无任何门拦截**的回归：
 *     ① 条目被切走后源区留下 **22 处连续空行**（最大 14 行），迁移前该指标为 0；
 *     ② 已发布区可**整区滞留**（5.1.0 171 行 / 5.0.0 111 行），违反纪律 6「发版整区迁入归档」。
 *
 * 判据（**工作树语义**，与 `verify-ledger-receipt.mjs` 的 git 区间语义不重叠）：
 *   本闸扫 `tasks/待完成任务.md` 的**当前内容**，不是提交区间 ⇒
 *   **不存在「推送后区间为空 = 恒绿假象」**（那是 ledger:receipt 的 ⚠️ 空集语义坑）。
 *
 *   ① **欠账态**：条目标题含收口标记、但**无 `archive/` 指针** ⇒ 已收口却没归档（纪律 41 行判据）。
 *   ② **假指针态**：标题含 `archive/…` 指针、但该归档文件里**查不到该条目 ID** —— 「加指针」
 *      被当成「已归档」的完成标记是最阴的一类：手工补指针只改标题行，**正文不会自动删除**，
 *      归档里也可能**根本无副本**。实证：0.2.0 区 10 条标指针条目里 9 条是假指针。
 *   ③ **开放态错置**：观察/挂起态条目出现在**已发布区** —— 纪律 3「观察项留主台账」
 *      ≠「留在版本区」；观察项永不随发版归档 ⇒ 留在已发布区会让该区**永远清不空**。
 *   ④ **格式态**：连续 ≥2 空行 —— 机械搬移条目后的空洞，无语义、纯膨胀。
 *
 *   ⑤ **版本索引三方一致**（2026-10-27 补）：「版本索引」表每行必须同时满足——
 *      归档文件存在 ∧ 该文件 H1 **声明了本行版本** ∧ **git tag 存在**。
 *      为什么补：①②③ 的投放面是「区」，归元后主台账不再有版本区 ⇒ ①②③ 恒空恒绿。
 *       TableRow↔归档文件↔git tag 三方是**不依赖区名**的稳定坐标，哪怕台账再重组也仍然可判。
 *   ⑥ **待执行无完成判据**（2026-10-27 补）：📌 待执行条目正文**必须含一行 `完成判据：`**。
 *      「待执行」= 已拍板待人/机落地，没有完成判据就无法判断做完没有，会变成永久占位条目。
 *   ⑦ **版本索引 ↔ README 归档表一致**（2026-10-27 补）：同一份「哪些归档文件在册」的事实，
 *      主台账「版本索引」与 `tasks/archive/README.md` 各登记一份 ⇒ 两处文件名集合**必须双向相等**。
 *      为什么补：两处登记无机器校验就是注定漂移的第二真源（治理技能曾把这条列为已知风险）。
 *   ⑧ **已落态跨过发版线却无归档副本**（2026-10-27 补）：观察区里已收口（✅/❌…）的条目，
 *      若其标题行**在 HEAD 里的最后改动时间早于该轴最近 tag**（且整条 tag 后未被改过）、
 *      又**没有任何归档副本** ⇒ 该版发版时就该收进归档，没没收 = 漏归档（L3 四例的实际形态）。
 *      「跨过发版线」用 git 时间判定，不靠条目标记措辞——统计口径不依赖作者记得写什么。
 *      ⚠️ 边界（fail-open，刻意）：① 标题行在工作树与 HEAD 不一致（正在改写）⇒ 跳过，
 *      以提交后判据为准；② 新条目在 HEAD 中不存在 ⇒ 跳过；③ 该轴尚无 tag ⇒ 跳过。
 *
 *   ⑨ **刻意不设**：观察态条目「必须字面含『触发』」——**否决**（2026-10-27 实测）。
 *      存量 95 条观察态里 19 条字面不含「触发」，逐条读正文后多数已用散文写明升档出口
 *      （「等用户说…再动」/「仅在用户实际体验后仍感…才需补齐」/「到期 2026-11-19」/「与 G35 同批评估」）。
 *      词面门判的是**写法不是内容**，只会催生「触发：无」这类合规空话，且逼真条目改写成套话
 *      ⇒ 比不设更差。判断「这条有没有升档出口」属人工审核，不机器代判；此处留痕防后人重提。
 *      （编号 ⑨ 永久留给本否决记录，后续判据从 ⑩ 起编，不回收空号。）
 *
 *   ⑩ **跨条目逐字克隆**（2026-10-27 补，`LEDGER-DUP-GUARD-1`）：同一条目正文行（去空白指纹，
 *      ≥16 字符）出现在 **>1 个顶层 ID** 下 ⇒ 红。**诚实定位：只抓逐字克隆，不治语义重复**
 *      （语义层 = `PHRASE-SCAN-1` 余项④「事实位点同源检查器」，指纹门抓不住形态不同的复述）。
 *      豁免：`**版本归属**：` 前缀行 —— 归属注是刻意同构的模板句（多条 ✅ 条目共用同一句式），
 *      属格式而非登记事实；豁免名单**零累积**纪律：新增模板族必须先在这里写明理由再加前缀。
 *      实证来源：`LEDGER-AXIS-1` 自证的 Edit 吞标题两连 + ㉘F 段与 `PUB-REACHABLE-1` 的
 *      「冻结规模」225 字符逐字重复行（2026-10-27 实测存量，同批压缩为指针）。
 *
 *   ⑪ **结构锚点缺失**（2026-10-27 补，吸收 `LEDGER-AXIS-1`）：两起实吞事故（`### 宿主轴`
 *      被吞、`## 注记类` 被吞）门禁全绿 ⇒ `parseSections()` 只按 `^## ` 切区、子标题不参与
 *      任何判据。判据分两层，**真源都是台账头部明文，不是脚本私设**：
 *      a. **六区齐备** —— 头部「排序原则」明列的四个待办/注记区（版本索引 / 观察·待拍板 /
 *         注记类 / 明确不推进）+ 结构区（设计纪律 / 已关闭决策）必须全部存在；
 *      b. **观察区两轴同存** —— 头部「双轨规则」（ADR-033）明列的 `### 内核轴` / `### 宿主轴`
 *         必须在观察区内同时存在（缺一即红；将来真要合并轴，红 = 人工确认时刻）。
 *      ⚠️ **刻意否决「对 HEAD 基线只增不减」层**（AXIS-1 曾提的「更彻底口径」，2026-10-27
 *      实测推翻）：本闸挂在 local-ci full 档 = **pre-push 时机，改动已提交** ⇒ HEAD 基线
 *      与工作树同步漂移 ⇒ 吞标题的提交在 push 时基线对比恒绿 = 假闸。标题计数对 HEAD 的
 *      比对只在「改完未提交、人工跑」的窗口有效，那由 `LEDGER-AXIS-1` 保留的「临时自查法」
 *      承担，不进本闸。锚点断言不依赖基线，提交后依然可判。
 *
 *   ⑫ **观察区条目体量超限**（2026-10-30 补）：观察区单个顶层条目 >40 行 ⇒ 红。
 *      为什么补：观察区是**每个会话都要读**的区，而它是单向阀（纪律 3 观察项永不归档 +
 *      D6 触发驱动 ⇒ 只进不出）。实测 2026-10-30：观察区 91 条里 63 条只占 2-3 行，
 *      而单条 `D1-MCP` 曾占 99 行（14%）——**行数不是条目数撑起来的，是极少数超长条目撑的**。
 *      ⚠️ 阈值 40 是**存量归零后的硬闸**（补门当天实测最大条目 35 行 ⇒ 存量 0 命中）；
 *      今后若再超：首选**把过程叙述 / 实施流水整段迁归档、原位只留判据行**（`D1-MCP` 的
 *      做法），**不是**改阈值。改阈值 = 门失明。
 *      为什么只判观察区：注记类 / 明确不推进不属待办、不参与每会话决策循环，
 *      且其长文是「防重复论证」，删即失去防重提价值 ⇒ 不设限。
 *
 *   ⑬ **新登记观察项无到期复查日期**（2026-10-30 补，同日改为双时相判据）：观察区里
 *      **本次新登记**的顶层条目，正文必须含 `到期复查 YYYY-MM-DD` ⇒ 否则红。
 *      为什么补：纪律 3（观察项永不归档）+ D6（无触发不行动）合起来 = **观察区没有出口**。
 *      实测 2026-10-30：观察区 91 条顶层条目里**只有 1 条**写了合规复查日（`ARCH-4`；
 *      `HOST-S15` 的「到期 …」形态同批订正为「到期复查 …」）。一个无限期不触发的观察项
 *      价值≈0，却永久占用每个会话的阅读成本。
 *      ⚠️ **只对新增条目判是刻意的**：存量均无日期，全量硬闸 ⇒ 门一建就被存量淹没 ⇒
 *      必然走「改 required:false」的老路（本闸 2026-10-27 已明确「不许把档位调回去」）。
 *      ⚠️ **「新登记」必须双时相界定**（2026-10-30 实测推翻单时相）：
 *        ① 未提交窗口 —— ID 不在 HEAD；② 已提交 —— 条目首行 blame 时间 ≥ 建门时点。
 *        单靠 ① ⇒ 本闸在 pre-push（改动已提交）恒绿 = 假闸（隔离仓库双相实测：未提交红、
 *        提交后命中 0）；单靠 ② ⇒ 未提交窗口失明（新行无 blame 时间）。
 *        这与 ⑪ 刻意否决「对 HEAD 基线只增不减」是**同一类错**：判据依赖 HEAD 基线，
 *        而挂载点在提交之后 ⇒ 基线与工作树同步漂移 ⇒ 恒绿。
 *
 *   ⑭ **复查日已过期未处置**（2026-10-30 补）：观察区条目写了 `到期复查 YYYY-MM-DD`、
 *      但日期早于今天 ⇒ 红。为什么补：⑬ 只校验格式存在、**不比较日期** ⇒ 「保质期」只有
 *      登记闸、没有到期闸，写个 2020 年的日期也永不过期，头部「到期无信号 ⇒ 转封存 / 归档」
 *      因此没有执行面。存量：补门当天两条复查日（`ARCH-4` 2026-11-26 / `HOST-S15`
 *      2026-11-19）都在未来 ⇒ 0 命中，符合「存量清零才建闸」。
 *      ⚠️ 到期后**改期**是允许的，但必须写新证据；无理由顺延 = 把保质期改成无限期。
 *
 *   ⑮ **顶层条目 ID 撞名**（2026-10-30 补）：全台账任一顶层 ID 出现两次及以上 ⇒ 红
 *      （只报第二条及以后，第一条是原名）。为什么补：按 ID 索引的判据（⑧ 的 byId、
 *      ⑬ 的 headIds、`verify-ledger-fold.mjs` 的 Set）都是**后者覆盖前者** ⇒ 取到的是
 *      后一条的行号与时间，判据**静默失明**——不报错、不判红，只是悄悄用错数据。
 *      实证：`D1-MCP` 在观察区有本体、在注记类区有指针且同 ID ⇒ 118 个条目首行、
 *      去重仅 117，且 ⑬ 取到的是指针行的时间而非常被剪枝的本体行时间。
 *      存量：`D1-MCP` 指针已改 `D1-MCP-PTR` ⇒ 0 命中后才建的本闸。
 *
 * 档位（2026-10-27 由告警升硬闸，兑现上一版写明的升档条件）：
 *   当初挂 required:false 是为 0.2.0 区的存量欠账/假指针让路，避免门一建就被绕。
 *   该存量已于 2026-10-27 清零：①②③④⑥ 五类 0 命中，⑤ 三方一致全绿。
 *   ⇒ local-ci 的 `ledger:hygiene` 步已改 `required: true`，此后任一命中 = 真回归。
 *   ⚠️ 今后若再生存量：**先清零**，不要把 required 改回 false（改回即重演「门被绕过」）。
 *
 * 空集语义（fail-closed）：
 *   台账缺失 / 区解析为 0 / 条目解析为 0 ⇒ **判据失明比假绿更危险**，一律判红。
 *
 * 用法：
 *   node scripts/verify-ledger-hygiene.mjs            # 分诊并列出命中
 *   node scripts/verify-ledger-hygiene.mjs --self-test # 自检：注入变异确认各判据都能红（⑧ 另含反例控制）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { arcHasEntryForId } from './lib/ledger-archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_REL = 'tasks/待完成任务.md';

/**
 * 收口标记 —— 命中即视为「该归档」（与归档纪律的「已关闭」口径同族）。
 *
 * 🔴 **不含「已评估」**（2026-10-26 实测冲突）：`archive/5.0.0-kernel.md` 文件头明写
 *   「开放项（观察 / 进行中 / 未修 / **已评估**）一律留主台账」。首版判据把「已评估」
 *   当收口 ⇒ `MEM-GOV-1`（🟢 已评估）被判欠账、差点归档，**直接违反归档纪律本身**。
 */
const CLOSED_RE = /✅|❌|🟢|已销项|已落地|已关闭|已核\b|已解决|已执行|已迁出|证伪|已升档|已升入/;

/**
 * 收口的**否定条件** —— 命中即**不**算收口（2026-10-26）。
 * 只删 `CLOSED_RE` 里的「已评估」字样不够：`MEM-GOV-1` 标题是 `🟢 已评估`，`🟢` 仍命中
 * ⇒ 换个写法照样进欠账。故用显式否定：`🟢 已评估` 属归档纪律明列的「留主台账」开放项。
 */
const NOT_CLOSED_RE = /已评估/;

/**
 * 开放态的**段首**判据 —— 只看 `｜` 分隔后的状态段开头。
 *
 * 为什么不用整行匹配（2026-10-26 实测假红）：`PR-SWITCH-1` 标题是
 * `✅ 已落地 …（形态定案后升级为「建议删」，待拍板）→ 见 archive/…`，整行含「待拍板」
 * ⇒ 被误判开放态，但它**已归档**。`MEM-EVENT-1` 的 `⏳ 待 5.0.0 发版` 同理——
 * 那是发版前的临时标记，版本已发布后属历史态，不是「待办」。
 * 段首匹配只认状态段真正以开放标记起头的形态（`｜⏸ 观察`、`｜⏳ 远期`）。
 *
 * 🔴 **`🔄` 必须算开放态**（2026-10-26 补，此前漏判）：`🔄` 在台账里表示
 *   「进行中 / 待查 / 待处置 / 已定档但方案在推进」——**全都是未闭合**。实证：
 *   `D1-MCP 🔄 已定档`、`ENV-COV-1 🔄 待查`、`㉘ 🔄 待处置（P0 须发版前修）`、
 *   `LOOP-CONTRACT-1 🔄 进行中（仅剩 ④ 缓办）`。首版判据漏了它 ⇒ 5.1.0 区 151 行
 *   活条目被静默当成「可归档」，照单执行**会销毁在途信息**。
 *
 * 🔴 **必须写成「交替 + u 标志」，不能写成字符类 `[⏸⏳📌🟡👁🔵]`**（2026-10-26 实测血训）：
 *   📌/🟡/👁/🔵 是 U+1F4CC 等**非 BMP 字符**，在字符类里会被拆成**代理对的两个 code unit**
 *   ⇒ 字符类实际含裸 `D83D` ⇒ `｜🔄`(D83D DD04) / `｜🟢`(D83D DFE2) / `｜📝` / `｜🗄`
 *   **全部因高代理相同而假命中**（一轮刷出 22 处，其中 7+ 处是 🔄/🟢/📝/🗄 的假红）。
 *   写 `u` 标志或改用非捕获交替 `(?:⏸|⏳|…)`，按**码点**而非 code unit 匹配。
 */
const OPEN_SEG_RE = /｜\s*(?:⏸|⏳|📌|🟡|👁|🔵|🔄)/u;

/** 已发布区的标题判据 */
const RELEASED_RE = /已发布|已发版|已定案归档/;

/**
 * ⑫ 观察区条目体量硬上限（行）。
 * 40 不是拍脑袋：补门当天实测观察区最大条目 35 行 ⇒ 存量 0 命中，门可即时为硬闸；
 * 同时它离「一条该有的信息量」足够远——正常条目 2-3 行，超 40 行必然混入了过程叙述。
 */
const MAX_ITEM_LINES = 40;

/** ⑬ 到期复查日期：`到期复查` 后跟 `YYYY-MM-DD`（捕获组供 ⑭ 取日期，形态真源 = 台账头部「登记规范」）。 */
const EXPIRY_RE = /到期复查\s*(\d{4}-\d{2}-\d{2})/;

/**
 * ⑬ 建门时点 = 补 ⑬ 那笔提交的 committer-time（秒，UTC，2026-10-30）。
 * 条目首行 blame 时间 ≥ 此值 ⇒ 建门后新登记，必须自带复查日。
 * ⚠️ **不能用「ID 是否在 HEAD」当唯一判据**：本闸挂 pre-push，改动已提交 ⇒ 新条目 ID
 * 必然已在 HEAD ⇒ 判据恒豁免 = 假闸（2026-10-30 隔离仓库双相实测：未提交红、提交后命中 0）。
 * 故用 blame 时间兜住「提交后」这一相，与 ID 差集兜住的「未提交」一相合成双时相。
 * ⚠️ 已知边界（刻意接受）：条目被整段搬家 / 剪枝改写后，blame 时间会刷新到搬家那笔 ⇒
 * 老条目可能被判为新登记而要求补复查日。这是**有益误报**——动过的条目顺手确认一次出口，
 * 比让它在搬家后永久豁免更接近「保质期」的本意。不要为消除它而回退到单时相判据。
 * ⚠️ 换「ID 首次引入时间」的方案**已实测否决**（2026-10-30）：`git log -S` 单条 **3.46s**，
 *    91 条约 5 分钟，而现方案 blame 一次全量 ~3s。为消掉剪枝时才出现的几条误报，把门禁
 *    从秒级拖到分钟级 = 逼人绕过它。误报的处置文案已分两路（见 ⑬ 的 `rewritten` 分支）。
 */
const GATE13_BORN_AT = 1793315659;

/** ⑭ 到期判定基准：今天（`YYYY-MM-DD`，UTC）。日期串可直接字典序比较，故不转 Date。 */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 自检用：取台账观察区**第一个**顶层条目 ID —— ⑬c 的存量豁免探针必须复用**真实存量 ID**，
 * 才能验证「ID 在 HEAD 且 blame 早于建门时点 ⇒ 不报」。写死一个 ID 会随台账改名而漂移，
 * 故动态取；取不到 = 判据失明，直接抛错（自检宁可红，不要静默变绿）。
 */
function stockObservationId(text) {
  const i = text.search(/^##\s*观察/m);
  if (i < 0) throw new Error('自检失明：台账无观察区，取不到存量条目 ID');
  const m = /^-\s+\*\*(.+?)\*\*/m.exec(text.slice(i));
  if (!m) throw new Error('自检失明：观察区无顶层条目，取不到存量条目 ID');
  return m[1];
}

/**
 * 观察区标题判据 —— ⑧ 的投放面。
 * 归元后主台账里**只有这个区长期承载条目**（注记类 / 明确不推进不属待办，不参与归档判定）。
 */
const OBSERVATION_RE = /观察\s*\/\s*待拍板/;

const MAX_PRINT = 20;

function parseSections(lines) {
  const heads = [];
  lines.forEach((l, i) => {
    if (/^## /.test(l)) heads.push({ title: l.replace(/^##\s*/, ''), start: i });
  });
  return heads.map((h, k) => ({
    ...h,
    end: k + 1 < heads.length ? heads[k + 1].start : lines.length,
  }));
}

function parseItems(lines, sec) {
  const raw = [];
  let cur = null;
  for (let i = sec.start; i < sec.end; i++) {
    const m = /^- \*\*(.+?)\*\*/.exec(lines[i]);
    if (m) {
      if (cur) cur.end = i;
      cur = { id: m[1], head: lines[i], start: i, end: sec.end };
      raw.push(cur);
    }
  }
  if (cur) cur.end = sec.end;
  raw.forEach((c) => {
    let e = c.end;
    while (e > c.start && lines[e - 1].trim() === '') e--;
    c.end = e;
  });
  return raw.map((c) => ({
    id: c.id,
    head: c.head,
    start: c.start,
    end: c.end,
    lines: c.end - c.start,
  }));
}

/** 版本索引表的数据行：| 版本轴 | 版本 | 发布日期 | 归档（真理源） | */
function parseVersionIndex(lines) {
  const rows = [];
  let inTable = false;
  for (const line of lines) {
    if (/^\|\s*版本轴/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!/^\|/.test(line)) break;
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // 表头下的分隔行
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length >= 4) {
      rows.push({ line, axis: cells[0], version: cells[1], date: cells[2], archiveCell: cells[3] });
    }
  }
  return rows;
}

/**
 * ⑤ 版本索引三方一致：行 ↔ 归档文件 ↔ git tag。
 *
 * 为什么用这三方（2026-10-27）：归元后主台账**不再有版本区**，而 ①②③ 的投放面就是「区」
 * ⇒ ①②③ 恒空恒绿（那是「查无可查」，不是「查过都合规」）。版本索引表 / 归档文件 H1 / git tag
 * 三者都不依赖区名，台账再怎么重组也仍然可判，是唯一稳定的坐标。
 */
function checkVersionIndex(lines, tags, readmeText) {
  const rows = parseVersionIndex(lines);
  const issues = [];
  // 版本索引里出现过的归档文件名（basename），供 ⑦ 与 README 归档表对账
  const indexFiles = new Set();
  if (rows.length === 0) return [{ row: null, why: '版本索引解析为 0 行（判据失明比假绿更危险）' }];

  for (const r of rows) {
    const target = /archive\/[A-Za-z0-9._/-]+\.md/.exec(r.archiveCell)?.[0] ?? null;
    if (!target) {
      issues.push({ row: r, why: '归档单元格无 archive/*.md 链接目标' });
      continue;
    }
    indexFiles.add(target.replace(/^archive\//, ''));
    const abs = join(ROOT, 'tasks', target);
    if (!existsSync(abs)) {
      issues.push({ row: r, why: `归档文件不存在：${target}` });
      continue;
    }
    const arc = readFileSync(abs, 'utf8');
    const h1 = /^#\s+(.*)$/m.exec(arc)?.[1] ?? '';
    const primary = r.version.split('（')[0].trim();
    if (!h1.includes(primary)) {
      issues.push({ row: r, why: `文件 H1 未声明版本 ${primary}（实际「${h1.slice(0, 28)}」）` });
    }
    const versions = r.version.match(/\d+\.\d+\.\d+/g) ?? [];
    if (versions.length === 0) {
      issues.push({ row: r, why: `版本单元格解析不出版本号：${r.version}` });
      continue;
    }
    for (const v of versions) {
      // `memora@` 是**已废弃的 tag 命名**（见 memora-kernel-release 技能「`memora@` 漂移」：不会触发
      // 发布链，禁止再打）。此处保留为候选是历史事实，不是放开口子——实测 tag 列表确有
      // `memora@3.0.0 / memora@3.0.1 / memora@4.0.0`，去掉它 ⇒ 3.0.x 与 4.0.0 两行当场假红。
      // ⚠️ 想清理它，必须先给这三行找到别的验收判据，而不是直接删候选。
      const cands = /宿主/.test(r.axis) ? [`vscode@${v}`] : [`v${v}`, `memora@${v}`];
      if (!cands.some((t) => tags.has(t))) {
        issues.push({ row: r, why: `版本 ${v} 无 git tag（候选 ${cands.join(' / ')}）` });
      }
    }
  }

  // ⑦ 版本索引 ↔ archive/README.md 归档表：两处登记同一份「在册归档文件」事实 ⇒ 集合必须双向相等。
  //    只认表格首列被反引号包裹的 `*.md`，且**排除带路径的条目**（README 另有「审查报告」等
  //    指向 tasks/*.md 的行，它们不是 tasks/archive 下的归档文件，掺进来即假红）。
  const readme = readmeText ?? readFileSync(join(ROOT, 'tasks', 'archive', 'README.md'), 'utf8');
  const readmeFiles = new Set();
  for (const line of readme.split(/\r?\n/)) {
    const m = /^\|\s*`([^`]+\.md)`/.exec(line);
    if (m && !m[1].includes('/')) readmeFiles.add(m[1]);
  }
  if (readmeFiles.size === 0) {
    issues.push({ row: null, why: 'archive/README.md 归档表解析为 0 行（判据失明比假绿更危险）' });
  }
  for (const f of indexFiles) {
    if (!readmeFiles.has(f)) {
      issues.push({ row: null, why: `版本索引引用了 ${f}，但 archive/README.md 归档表未登记` });
    }
  }
  for (const f of readmeFiles) {
    if (!indexFiles.has(f)) {
      issues.push({ row: null, why: `archive/README.md 登记了 ${f}，但版本索引无对应行` });
    }
  }
  return issues;
}

/** ⑥ 待执行条目的完成判据：📌 段首即「已拍板待人/机落地」，无完成判据 = 永久占位。 */
const PENDING_SEG_RE = /｜\s*📌/u;
// 加粗位置不限（`**完成判据：**` 与 `**完成判据**：` 都算），但必须是显式写法而非顺口提及。
const DONE_CRITERION_RE = /完成判据\**\s*：/;

/**
 * 从标题行里取「归档指针」目标。
 *
 * 真实归档指针只有两种形态：
 *   ① markdown 链接目标：`见 [文本](./archive/x.md)` / `见 [tasks/archive/x.md](./archive/x.md)`
 *   ② 裸引用且紧跟「见」：`→ 见 tasks/archive/x.md`
 *
 * ⚠️ 行内散文引用（如 `(见 \`archive/completed-history.md\`「…」节)`）描述「该归档里的某一节」，
 *    不是「本条目归档于此处」的指针，必须排除——否则会误把散文文件名当指针目标
 *    （实测 TERM-FDBK-1 因此假红：散文 `archive/completed-history.md` 抢在真实指针前）。
 *    散文引用的 archive 名被反引号包裹，故「见」与 `archive` 之间夹着反引号，bare 形态正则自然不匹配。
 */
function pointerFile(head) {
  // ① 链接目标优先（真实指针恒在此）：`（./archive/x.md）` 或 `（archive/x.md）`
  const link = /\]\((\.?\/?archive\/[A-Za-z0-9._\/-]+\.md)\)/.exec(head);
  if (link) return link[1].replace(/^\.\//, '').replace(/^tasks\//, '');
  // ①b 链接文本含 archive 名（自检注入格式 `见 [archive/x.md](#x)`）
  const linkText = /见\s+\[[^\]]*?(archive\/[A-Za-z0-9._\/-]+\.md)\]/.exec(head);
  if (linkText) return linkText[1].replace(/^\.\//, '').replace(/^tasks\//, '');
  // ② 裸引用：`见` 后紧跟（可选 tasks/）`archive/x.md`，且非反引号包裹
  const bare = /见\s+(?:tasks\/)?archive\/[A-Za-z0-9._\/-]+\.md/.exec(head);
  if (bare) {
    const m = /archive\/[A-Za-z0-9._\/-]+\.md/.exec(bare[0]);
    return m ? m[0] : null;
  }
  return null;
}

function hasBlankRuns(lines) {
  const runs = [];
  let run = 0;
  lines.forEach((l, i) => {
    if (l.trim() === '') run++;
    else {
      if (run >= 2) runs.push({ end: i, n: run });
      run = 0;
    }
  });
  return runs;
}

/**
 * ⑩ 跨条目逐字克隆（判据与豁免面见文件头说明）。
 *
 * 实现口径：
 *   - 顶层条目 = `^- **ID**` 行，其后非空、非标题（`^#`）的行归该条目（与 parseItems 的
 *     归属规则同构，但这里必须跨区全文件扫——克隆往往跨区）。
 *   - 指纹 = 行文本去掉**全部**空白（格式重排不改内容仍算克隆）。
 *   - 只报「首个条目」一处命中，`why` 里列全部涉事 ID——输出噪音有上限，修复靠人读。
 */
const DUP_EXEMPT_PREFIX = /^\*\*版本归属\*\*：/;
const DUP_MIN_LEN = 16;

function checkClones(lines) {
  const items = [];
  let cur = null;
  lines.forEach((l, i) => {
    const m = /^- \*\*(.+?)\*\*/.exec(l);
    if (m) {
      cur = { id: m[1], start: i, rows: [] };
      items.push(cur);
    } else if (cur && l.trim() !== '' && !/^#{1,6}\s/.test(l)) {
      cur.rows.push({ i, t: l.trim() });
    }
  });

  const byFp = new Map(); // 指纹 → [{ id, start, text }]
  for (const it of items) {
    for (const r of it.rows) {
      if (r.t.length < DUP_MIN_LEN || DUP_EXEMPT_PREFIX.test(r.t)) continue;
      const fp = r.t.replace(/\s+/g, '');
      if (!byFp.has(fp)) byFp.set(fp, []);
      byFp.get(fp).push({ id: it.id, start: it.start, text: r.t });
    }
  }

  const out = [];
  for (const hits of byFp.values()) {
    if (hits.length < 2) continue;
    const ids = [...new Set(hits.map((h) => h.id))];
    if (ids.length < 2) continue; // 同一条目内的重复行不属「跨条目克隆」
    out.push({
      id: ids[0],
      start: hits[0].start,
      why: `逐字克隆 ×${hits.length}（涉事 ID：${ids.join(' / ')}）——同一事实两处登记必漂移，真源留一处、其余改指针`,
    });
  }
  return out;
}

/**
 * ⑪ 结构锚点缺失（真源 = 台账头部「排序原则」与「双轨规则」明文，见文件头说明）。
 */
const REQUIRED_SECTIONS = [
  '设计纪律',
  '版本索引',
  /观察\s*\/\s*待拍板/,
  '注记类',
  '已关闭决策',
  '明确不推进',
];

function checkAnchors(lines, sections) {
  const issues = [];
  for (const a of REQUIRED_SECTIONS) {
    const label = a instanceof RegExp ? a.source.replaceAll('\\s*', ' ').replaceAll('\\/', '/') : a;
    const hit = sections.some((s) => (a instanceof RegExp ? a.test(s.title) : s.title.includes(a)));
    if (!hit)
      issues.push({
        id: `⑪结构区:${label}`,
        start: 0,
        why: `结构区标题缺失：「${label}」——台账头部「排序原则」明列的区不可缺`,
      });
  }
  const obs = sections.find((s) => /观察\s*\/\s*待拍板/.test(s.title));
  if (obs) {
    const seg = lines.slice(obs.start, obs.end);
    for (const ax of ['内核轴', '宿主轴']) {
      const re = new RegExp(`^###\\s+${ax}\\s*$`);
      if (!seg.some((l) => re.test(l.trim()))) {
        issues.push({
          id: `⑪轴标题:${ax}`,
          start: obs.start,
          why: `观察区缺 \`### ${ax}\` 子标题——头部「双轨规则」（ADR-033）明列，缺即结构降级（实吞事故形态，见 LEDGER-AXIS-1）`,
        });
      }
    }
  } else {
    issues.push({ id: '⑪轴标题:*', start: 0, why: '观察区不存在，两轴判据无投放面' });
  }
  return issues;
}

/** 收口态的单点判据（① 与 ⑧ 共用一份拼写；开放态优先——🔄/⏳/📌 一律不算收口）。 */
const isClosedHead = (head) =>
  CLOSED_RE.test(head) && !NOT_CLOSED_RE.test(head) && !OPEN_SEG_RE.test(head);

/** 条目所属子区（最近的上层 `###` 标题），用于把条目映射到版本轴。 */
function axisAt(lines, sec, idx) {
  for (let i = idx; i >= sec.start; i--) {
    const m = /^###\s+(.+)$/.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

/** 所有归档文件的副本查询（缓存文本，逐 ID 复用 `lib/ledger-archive.mjs` 的同一判据）。 */
function archiveCopies() {
  const dir = join(ROOT, 'tasks', 'archive');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  const texts = files.map((f) => readFileSync(join(dir, f), 'utf8'));
  return { has: (id) => texts.some((t) => arcHasEntryForId(t, id)) };
}

/**
 * ⑧ 的判据输入：发版线时间 + HEAD 版本台账的逐行改动时间。
 *
 * 为什么时间取自 HEAD、归档副本取自工作树：条目「何时落态」只能问已提交历史（未提交改动没有时间），
 * 而「有没有归档副本」是当前结构事实（与 ①②③ 同源）。
 * 为什么一次 blame 取全文件：逐条 `-L` 会产生 N 次子进程；行数对不齐即判据失明，宁可抛错。
 */
function ledgerTiming() {
  const refs = execFileSync(
    'git',
    [
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(refname:short) %(creatordate:unix)',
      'refs/tags',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 两条版本轴各取最近一条：内核轴 = `v<semver>`（`memora@` 是已废弃命名，不计），宿主轴 = `vscode@`。
  let kernelTagTime = null;
  let hostTagTime = null;
  for (const r of refs) {
    const [name, ts] = r.split(/\s+/);
    const t = Number(ts);
    if (!Number.isFinite(t)) continue;
    if (hostTagTime === null && name.startsWith('vscode@')) hostTagTime = t;
    if (kernelTagTime === null && /^v\d+\.\d+\.\d+$/.test(name)) kernelTagTime = t;
    if (kernelTagTime !== null && hostTagTime !== null) break;
  }

  const headText = execFileSync('git', ['show', `HEAD:${LEDGER_REL}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  // maxBuffer 必须显式放大：porcelain 每行约 10 行元信息，台账 1272 行时输出已破 Node 默认的
  // 1 MiB ⇒ `spawnSync git ENOBUFS` **硬崩**（不是判据红，且崩前不打印任何分诊结果），
  // 表现为「闸门恒红但看不出哪一条红」。不设上限 ⇒ 台账每增几行就可能崩一次。
  const porcelain = execFileSync('git', ['blame', '--line-porcelain', 'HEAD', '--', LEDGER_REL], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const times = [];
  for (const line of porcelain.split(/\r?\n/)) {
    const m = /^committer-time (\d+)$/.exec(line);
    if (m) times.push(Number(m[1]));
  }
  const headLines = headText.replace(/\r?\n$/, '').split(/\r?\n/);
  if (headLines.length !== times.length) {
    throw new Error(
      `blame 行数 ${times.length} ≠ HEAD 台账行数 ${headLines.length}（判据失明比假绿更危险）`,
    );
  }

  const byId = new Map();
  const headIds = new Set();
  for (const sec of parseSections(headLines)) {
    for (const it of parseItems(headLines, sec)) {
      headIds.add(it.id);
      byId.set(it.id, {
        headTime: times[it.start],
        lastTime: Math.max(...times.slice(it.start, it.end)),
        headLine: it.head,
      });
    }
  }
  // headIds = HEAD 台账里的顶层条目 ID 全集，供 ⑬ 界定「本次新登记」（存量豁免）。
  return { kernelTagTime, hostTagTime, byId, headIds };
}

/** 秒级时间戳 → `YYYY-MM-DD HH:mm`（UTC，够判先后，不用来展示时区）。 */
function stamp(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * ⑧ 已落态跨过发版线却无归档副本。
 * 三个跳过分支都是**刻意 fail-open**（见文件头 ⑧ 的边界说明），不是遗漏。
 */
function checkArchiveTiming(cands, timing, archives) {
  const out = [];
  for (const c of cands) {
    if (archives.has(c.id)) continue; // 任一归档文件有副本 ⇒ 已归档
    const t = timing.byId.get(c.id);
    if (!t) continue; // 新条目：HEAD 里不存在，无时间可判
    if (t.headLine !== c.head) continue; // 标题行正在改写（工作树 ≠ HEAD），以提交后判据为准
    const tagTime =
      c.axis === '内核轴' ? timing.kernelTagTime : c.axis === '宿主轴' ? timing.hostTagTime : null;
    if (tagTime === null) continue; // 该轴尚无发版线
    // 双条件：标题行落态时间与整条最后改动都早于 tag ⇒ 该版发版时它已定型却没收进归档
    if (t.headTime < tagTime && t.lastTime < tagTime) {
      out.push({
        ...c,
        why: `落态 ${stamp(t.headTime)} 早于 ${c.axis} 发版线 ${stamp(tagTime)}，且无归档副本`,
      });
    }
  }
  return out;
}

function diagnose(text, opts = {}) {
  // 去**尾部换行**再切分：文件以 \n 结尾时 `split` 会多出一个空串 ⇒ 自报行数比 `wc -l`
  // 多 1（实测 713 vs 712）。同一事实两处数字必漂移，故此处统一到「文件的真实行数」。
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  const sections = parseSections(lines);
  const arcCache = new Map();
  const readArc = (rel) => {
    if (!arcCache.has(rel)) {
      const p = join(ROOT, 'tasks', rel);
      arcCache.set(rel, existsSync(p) ? readFileSync(p, 'utf8') : null);
    }
    return arcCache.get(rel);
  };

  const debt = [];
  const fake = [];
  const misplaced = [];
  const pending = [];
  const oversize = []; // ⑫ 观察区条目体量超限
  const noExpiry = []; // ⑬ 新登记观察项无到期复查日期
  const overdue = []; // ⑭ 观察项复查日已过期仍未处置
  const dupIds = []; // ⑮ 顶层条目 ID 撞名
  const allIds = []; // ⑮ 的全量条目（跨区）
  const closedCands = []; // ⑧ 的候选：观察区内已收口、且标题行无归档指针
  let itemTotal = 0;
  const releasedSections = [];
  // ⑬ 需要「HEAD 里有没有这个 ID」来界定新增 ⇒ timing 必须提到条目循环之前取。
  const timing = opts.timing ?? ledgerTiming();
  const headIds = timing.headIds ?? new Set();

  for (const sec of sections) {
    const items = parseItems(lines, sec);
    itemTotal += items.length;
    for (const it of items) allIds.push({ ...it, sec: sec.title });
    const released = RELEASED_RE.test(sec.title);
    if (released) {
      releasedSections.push({ title: sec.title, items: items.length, lines: sec.end - sec.start });
    }
    for (const it of items) {
      const ptr = pointerFile(it.head);

      // ② 假指针：**只在已发布区判**。观察区 / 未发布区 / 非待办区的条目本就不该有指针，
      //    在那里判「归档无副本」是噪音（实测：观察区 `rules-B2` 被误判）。
      if (released && ptr) {
        const arc = readArc(ptr);
        if (arc === null) {
          fake.push({ ...it, sec: sec.title, why: `指针目标不存在：${ptr}` });
        } else if (!arcHasEntryForId(arc, it.id)) {
          fake.push({ ...it, sec: sec.title, why: `归档 ${ptr} 无该条目副本` });
        }
      }

      // ① 欠账：**只在已发布区判**。0.3.0（Unreleased）区与观察区的收口条目按纪律
      //    本就留在主台账（纪律 3、纪律 6 的前提是「已发布」），在那里报欠账 = 假红
      //    （实测：H0-1 / S1 / T4-FOLD-1 / 明确不推进区的 WRITE-APPROVAL-1 全被误判）。
      //    注意**开放态优先**：`LOOP-CONTRACT-1` 是 `🔄 进行中（①②③ 已落地，仅剩 ④ 缓办）`，
      //    既含「已落地」又是未闭合 ⇒ 只报错置、不报欠账（未闭合的先归位，不催归档）。
      if (released && !ptr && isClosedHead(it.head)) {
        debt.push({ ...it, sec: sec.title });
      }

      // ③ 开放态错置：已发布区 + 状态段以开放标记起头 + **无归档指针**。
      //    有指针者视为「已归档的历史态」，不再要求迁出（见 OPEN_SEG_RE 注释）。
      if (released && !ptr && OPEN_SEG_RE.test(it.head)) {
        misplaced.push({ ...it, sec: sec.title });
      }
      // ⑥ 待执行无完成判据
      if (PENDING_SEG_RE.test(it.head)) {
        const body = lines.slice(it.start + 1, it.end).join('\n');
        if (!DONE_CRITERION_RE.test(body)) {
          pending.push({ ...it, sec: sec.title, why: '📌 待执行条目缺「完成判据：」行' });
        }
      }
      // ⑧ 候选：观察区（主台账里唯一长期承载条目的区）内已收口、标题行无归档指针。
      //    判据本体（跨发版线 + 无副本）在 checkArchiveTiming 里，故此处只收集，不判定。
      if (OBSERVATION_RE.test(sec.title) && !ptr && isClosedHead(it.head)) {
        closedCands.push({ ...it, sec: sec.title, axis: axisAt(lines, sec, it.start) });
      }
      // ⑫ 观察区条目体量：超过上限必是混入了过程叙述（判据与阈值理由见文件头 ⑫）。
      if (OBSERVATION_RE.test(sec.title) && it.lines > MAX_ITEM_LINES) {
        oversize.push({
          ...it,
          sec: sec.title,
          why: `观察区条目 ${it.lines} 行 > 上限 ${MAX_ITEM_LINES} 行`,
        });
      }
      // ⑬ 新登记观察项必须自带到期复查日期。**双时相**界定「新登记」：
      //   ① 未提交窗口 —— ID 不在 HEAD（工作树刚加的条目，blame 无时间可判）；
      //   ② 已提交 —— 条目首行 blame 时间 ≥ GATE13_BORN_AT。
      //   缺 ② 时本闸在 pre-push（改动已提交）恒绿 = 假闸；缺 ① 时未提交窗口失明。
      // ⑭ 复查日已过期：只校验格式不校验时间 ⇒ 过期条目永不红，保质期没有执行面。
      if (OBSERVATION_RE.test(sec.title)) {
        // ⚠️ body 必须**含标题行**：存量 `ARCH-4` 把复查日写在标题行（`…｜⏳ 观察｜到期复查 …`），
        //    `HOST-S15` 写在正文条款里。两种写法都是「同一事实」，判据不该挑位置——
        //    只扫正文会让 ARCH-4 这类被判为「无复查日」（2026-10-30 实测：只认到 1 条）。
        const body = lines.slice(it.start, it.end).join('\n');
        const born = timing.byId.get(it.id)?.headTime ?? null;
        const isNew = !headIds.has(it.id) || (born !== null && born >= GATE13_BORN_AT);
        if (isNew && !EXPIRY_RE.test(body)) {
          // 文案分两路（两种红、处置动作不同）：ID 已在 HEAD ⇒ 老条目被改写（多为剪枝 / 搬家
          // 刷新 blame），该做的是「确认它还有没有出口」；ID 不在 HEAD ⇒ 真新登记，该做的是
          // 「补一条出口」。混成一句话会让人以为门认错了条目。
          const rewritten = headIds.has(it.id) && born !== null;
          noExpiry.push({
            ...it,
            sec: sec.title,
            why: rewritten
              ? `条目最后改动 ${stamp(born)} 晚于建门时点（多为剪枝 / 搬家改写 blame，非新登记）——请确认它是否还有出口，补「到期复查 YYYY-MM-DD」或转封存`
              : `新登记观察项缺「到期复查 YYYY-MM-DD」——观察区是单向阀，无复查日即无出口`,
          });
        }
        const m = EXPIRY_RE.exec(body);
        if (m && m[1] < todayISO()) {
          overdue.push({
            ...it,
            sec: sec.title,
            why: `复查日 ${m[1]} 已过期（今天 ${todayISO()}）——按台账头部「登记规范」应转封存 / 归档，不得继续挂 ⏳`,
          });
        }
      }
    }
  }

  // ⑮ 顶层条目 ID 撞名：按 ID 索引的判据（⑧ 的 byId / ⑬ 的 headIds / fold 的 Set）
  //    都会「后者覆盖前者」⇒ 取到错误行的时间，判据**静默失明**（2026-10-30 实证：
  //    `D1-MCP` 在观察区有本体、在注记类区有指针，两处同 ID ⇒ 118 个条目首行、去重 117）。
  //    只报第二条及以后：第一条是原名，改哪一条由人决定（通常改指针 / 衍生条目，保本体 ID）。
  const seenId = new Map();
  for (const it of allIds) {
    if (seenId.has(it.id)) {
      dupIds.push({
        ...it,
        why: `ID 与行${seenId.get(it.id) + 1} 的条目撞名——按 ID 索引的判据会被后者覆盖，判据静默失明`,
      });
    } else {
      seenId.set(it.id, it.start);
    }
  }

  const blanks = hasBlankRuns(lines);
  const clones = checkClones(lines);
  const anchors = checkAnchors(lines, sections);
  const tags = new Set(
    execFileSync('git', ['tag', '--list'], { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const indexIssues = checkVersionIndex(lines, tags, opts.readmeText);
  return {
    sections,
    itemTotal,
    debt,
    fake,
    misplaced,
    pending,
    indexIssues,
    timing: checkArchiveTiming(closedCands, timing, archiveCopies()),
    oversize,
    noExpiry,
    overdue,
    dupIds,
    clones,
    anchors,
    releasedSections,
    blanks,
    lines,
  };
}

function report(r) {
  const problems = [];
  if (r.debt.length) problems.push(['①欠账', r.debt]);
  if (r.fake.length) problems.push(['②假指针', r.fake]);
  if (r.misplaced.length) problems.push(['③开放态错置', r.misplaced]);
  if (r.blanks.length) problems.push(['④连续空行', r.blanks]);
  if (r.indexIssues.length)
    problems.push(['⑤⑦版本索引不一致（三方 / README 归档表）', r.indexIssues]);
  if (r.pending.length) problems.push(['⑥待执行无完成判据', r.pending]);
  if (r.timing.length) problems.push(['⑧落态跨发版线但无归档副本', r.timing]);
  if (r.oversize.length) problems.push(['⑫观察区条目体量超限', r.oversize]);
  // 标题必须与两路文案自洽：判据同时命中「真新登记」与「老条目被改写」，写死「新登记」会说谎。
  if (r.noExpiry.length) problems.push(['⑬观察项缺到期复查（新登记 / 被改写）', r.noExpiry]);
  if (r.overdue.length) problems.push(['⑭复查日已过期未处置', r.overdue]);
  if (r.dupIds.length) problems.push(['⑮顶层条目 ID 撞名', r.dupIds]);
  if (r.clones.length) problems.push(['⑩跨条目逐字克隆', r.clones]);
  if (r.anchors.length) problems.push(['⑪结构锚点缺失', r.anchors]);

  console.log(
    `\n[ledger-hygiene] 台账结构分诊：${r.sections.length} 区 / ${r.itemTotal} 条目 / ${r.lines.length} 行`,
  );
  console.log(
    '  已发布区：' +
      (r.releasedSections.length
        ? r.releasedSections
            .map((s) => `${s.title.slice(0, 18)} ${s.lines}行/${s.items}条`)
            .join(' · ')
        : '(无 · 归元后主台账不再按版本分区 ⇒ ①②③ 无投放面，结构事实改由 ⑤⑥⑦⑧ 承担)'),
  );

  if (problems.length === 0) {
    console.log(
      '✅ [ledger-hygiene] 十四类判据全部通过（欠账 0 / 假指针 0 / 错置 0 / 连续空行 0 / 版本索引三方一致 / 待执行均有完成判据 / 版本索引↔README 归档表一致 / 无落态跨版未归档 / 观察区条目体量未超限 / 新登记观察项均有到期复查 / 无过期未处置复查日 / 无 ID 撞名 / 无跨条目逐字克隆 / 结构锚点齐备）',
    );
    return 0;
  }

  for (const [label, list] of problems) {
    console.log(`\n❌ ${label}：${list.length} 处`);
    for (const h of list.slice(0, MAX_PRINT)) {
      if (h.n !== undefined) {
        console.log(`   行${h.end - h.n + 1}..${h.end}  ${h.n} 个连续空行`);
      } else if (h.start !== undefined) {
        console.log(
          `   行${h.start + 1}  [${h.id.slice(0, 30)}]  ${h.lines}行  ${h.why ?? h.sec.slice(0, 24)}`,
        );
      } else {
        console.log(`   ${h.why ?? ''}`);
        if (h.row) console.log(`      ${h.row.line.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    if (list.length > MAX_PRINT) console.log(`   … 另有 ${list.length - MAX_PRINT} 处`);
  }
  console.log(
    '\n   处置：①②③ 见 `tasks/archive/README.md` 七条纪律（原 `archive-discipline.md` 副本已于 2026-10-27 删除，' +
      '其纪律 7 与真源字面相反，勿从 git 历史转抄）；' +
      '\n   ④ 连续空行压成 1 行（写盘前须断言非空行序列不变）；' +
      '\n   ⑤ 校准「版本索引」表 ↔ 归档文件 H1 ↔ git tag 三方；⑥ 给 📌 待执行条目补「完成判据：」行；' +
      '\n   ⑦ 让「版本索引」与 `tasks/archive/README.md` 归档表的文件名集合双向相等（改一处必须同步另一处）；' +
      '\n   ⑧ 把该条目搬进对应版本归档（发版时就该做），或在标题行注明归档去向；' +
      '\n   ⑫ 把过程叙述 / 实施流水整段迁归档、原位只留判据行 + 指针（`D1-MCP` 的精简做法）——**改阈值即门失明**；' +
      '\n   ⑬ 给新登记观察项补一行「到期复查 YYYY-MM-DD」（建门前的存量豁免，不回填；建门后新登记一律要写）；' +
      '\n   ⑭ 复查日过期即处置：转封存 / 归档，或**有信号就改期**（改期须写新证据，禁止无理由顺延）；' +
      '\n   ⑮ 撞名的**后一条**改 ID（通常改指针 / 衍生条目，保本体 ID 不变 ⇒ 外部引用不断）；' +
      '\n   ⑩ 同一事实只准在一处登记：真源留一处，其余改指针（形态参照 LEDGER-AXIS-1 → LEDGER-DUP-GUARD-1 的并入写法）；' +
      '\n   ⑪ 补回缺失的结构区/轴标题——真源 = 台账头部「排序原则」与「双轨规则」，先读台账头部再动结构。' +
      '\n   本闸已是硬闸（local-ci required:true）——存量回涨时先把存量清零，不许把档位调回去。',
  );
  return 1;
}

/**
 * 自检：注入四类变异，确认判据**确实能捕获新命中**。
 *
 * ⚠️ 为什么用「注入前后差值」而不是「注入后 > 0」（2026-10-26 实测教训）：
 *   首版只断言 `命中数 > 0`，四类全部返回 41 —— 那是**基线存量**的数字，
 *   说明注入根本没生效、或判据根本没看见新东西，**门建了却失明，而自检还是绿的**。
 *   判据：① 注入后文本必须真的变了（`assertApplied`）；② 注入的探针 ID 必须出现在
 *   对应类别的命中里，且基线不含它。两条都过才算该判据有效。
 */
function selfTest() {
  const base = readFileSync(join(ROOT, LEDGER_REL), 'utf8');
  const baseReadme = readFileSync(join(ROOT, 'tasks', 'archive', 'README.md'), 'utf8');
  // ⑧ 的真实时间输入只取一次；各用例用桩覆盖探针的时间，避免逐例重跑 blame
  const baseTiming = ledgerTiming();
  const baseR = diagnose(base, { timing: baseTiming });
  const idsOf = (list) => new Set(list.map((x) => x.id));
  const stockId = stockObservationId(base);

  // 注入锚点 = 观察区标题（2026-10-26 台账归元后，主台账不再常驻「已发布版本区」⇒
  // 自检必须**自建**一个已发布区，否则 ①②③ 判据无投放面 ⇒ 自检会因「锚点不存在」失明）
  const anchor = base.includes('## 观察 / 待拍板') ? '## 观察 / 待拍板' : null;
  if (!anchor) {
    console.error('❌ 自检锚点 `## 观察 / 待拍板` 不存在，无法注入 —— 自检前提失效');
    return 1;
  }
  // 自建已发布区标题（RELEASED_RE 命中「已发布」），供 ①②③ 探针落位
  const probeSection = '## ZZ-RELEASED 自检注入（已发布）';
  // ⑧ 的探针必须落在**版本轴**下（axisAt 向上找最近的 `###`），否则 axis=null ⇒ 被跳过 ⇒ 自检假绿
  const axisAnchor = base.includes('### 内核轴') ? '### 内核轴' : null;
  if (!axisAnchor) {
    console.error('❌ 自检锚点 `### 内核轴` 不存在，⑧ 探针无法定位版本轴 —— 自检前提失效');
    return 1;
  }
  /** ⑧ 探针的注入行（与桩数据里的 headLine 必须逐字一致，否则被「标题行正在改写」分支跳过） */
  const probeTimeLine = (id) => `- **${id}** — 自检注入｜✅ 完成`;

  const cases = [
    {
      label: '①欠账',
      probe: 'ZZ-DEBT-1',
      mutate: (t) =>
        t.replace(
          anchor,
          `${probeSection}\n\n- **ZZ-DEBT-1** — 自检注入｜✅ 已落地（无指针）\n\n${anchor}`,
        ),
      pick: (r) => idsOf(r.debt),
    },
    {
      label: '②假指针',
      probe: 'ZZ-FAKE-1',
      mutate: (t) =>
        t.replace(
          anchor,
          `${probeSection}\n\n- **ZZ-FAKE-1** — 自检注入 → 见 [archive/0.2.0-host.md](#x)\n\n${anchor}`,
        ),
      pick: (r) => idsOf(r.fake),
    },
    {
      label: '③开放态错置',
      probe: 'ZZ-OPEN-1',
      mutate: (t) =>
        t.replace(anchor, `${probeSection}\n\n- **ZZ-OPEN-1** — 自检注入｜⏳ 观察\n\n${anchor}`),
      pick: (r) => idsOf(r.misplaced),
    },
    {
      // ⑤ 的探针不是 ID 而是 version：注入一个三方全假的索引行，必须被「文件不存在」拦下。
      label: '⑤版本索引三方不一致',
      probe: '9.9.9',
      mutate: (t) =>
        t.replace(
          /(\| 内核 npm \| 3\.0\.x[^\n]*\n)/,
          '$1| 内核 npm | 9.9.9 | 2026-10-27 | [archive/9.9.9-kernel.md](./archive/9.9.9-kernel.md) |\n',
        ),
      pick: (r) => new Set(r.indexIssues.map((x) => x.why ?? '')),
    },
    // ⑤b：指向**存在**的归档文件但版本号对不上 ⇒ 同时探「H1 未声明版本」与「无 git tag」两个分支。
    {
      label: '⑤b版本索引 H1/tag 不符',
      probe: '9.9.8',
      mutate: (t) =>
        t.replace(
          /(\| 内核 npm \| 3\.0\.x[^\n]*\n)/,
          '$1| 内核 npm | 9.9.8 | 2026-10-27 | [archive/5.1.0-kernel.md](./archive/5.1.0-kernel.md) |\n',
        ),
      pick: (r) => new Set(r.indexIssues.map((x) => x.why ?? '')),
    },
    {
      label: '⑥待执行无完成判据',
      probe: 'ZZ-PEND-1',
      mutate: (t) => t.replace(anchor, `${anchor}\n\n- **ZZ-PEND-1** — 自检注入｜📌 待执行\n`),
      pick: (r) => idsOf(r.pending),
    },
    // ⑧ 正向：探针落到内核轴下、无归档副本、落态时间早于发版线 ⇒ 必须命中。
    //    时间由桩注入（探针不在 HEAD，真实 blame 里查不到它）。
    {
      label: '⑧落态跨发版线无归档',
      probe: 'ZZ-TIME-1',
      mutate: (t) => t.replace(axisAnchor, `${axisAnchor}\n\n${probeTimeLine('ZZ-TIME-1')}`),
      timing: (b) => {
        const tag = b.kernelTagTime ?? 1000; // 无 tag 时给个确定的假发版线，保证判据可判
        return {
          ...b,
          kernelTagTime: tag,
          // 桩：标题行与整条最后改动都早于 tag
          byId: new Map(b.byId).set('ZZ-TIME-1', {
            headTime: tag - 1,
            lastTime: tag - 1,
            headLine: probeTimeLine('ZZ-TIME-1'),
          }),
        };
      },
      pick: (r) => idsOf(r.timing),
    },
    // ⑧ 反例控制（invert）：落态时间在发版线**之后** ⇒ 不该报（防「凡已收口就报」的过度拦截）。
    {
      label: '⑧b落态在发版线后不误报',
      probe: 'ZZ-TIME-2',
      invert: true,
      mutate: (t) => t.replace(axisAnchor, `${axisAnchor}\n\n${probeTimeLine('ZZ-TIME-2')}`),
      timing: (b) => {
        const tag = b.kernelTagTime ?? 1000;
        return {
          ...b,
          kernelTagTime: tag,
          byId: new Map(b.byId).set('ZZ-TIME-2', {
            headTime: tag + 1,
            lastTime: tag + 1,
            headLine: probeTimeLine('ZZ-TIME-2'),
          }),
        };
      },
      pick: (r) => idsOf(r.timing),
    },
    // ⑦a：README 归档表删掉 0.1.0 行 ⇒ 版本索引引用了但表未登记（只改 README，不改台账）
    {
      label: '⑦a归档表漏登记',
      probe: '0.1.0-host.md',
      mutate: (t) => t,
      readmeMutate: (rm) => rm.replace(/^\|\s*`0\.1\.0-host\.md`[^\n]*\n/m, ''),
      pick: (r) => new Set(r.indexIssues.map((x) => x.why ?? '')),
    },
    // ⑦b：README 归档表多出一行 ⇒ 表登记了但版本索引无对应行
    {
      label: '⑦b归档表多登记',
      probe: 'zz-probe.md',
      mutate: (t) => t,
      readmeMutate: (rm) =>
        rm.replace(
          /(\| --- \| --- \| --- \| --- \| --- \|\n)/,
          '$1| `zz-probe.md` | 9.9.9 | 内核 npm | 自检注入 | 无 |\n',
        ),
      pick: (r) => new Set(r.indexIssues.map((x) => x.why ?? '')),
    },
    // ⑩：同一行正文落进两个不同顶层 ID ⇒ 跨条目逐字克隆必须被抓。
    //
    // 🔴 **克隆源必须自给自足，不许从台账存量里抽锚行**（2026-10-30 实测血训）：
    //    原实现是 `/^\s+(\*\*冻结规模（实测）\*\*：[^\n]+)$/m` 从台账正文抽一行当克隆源，
    //    该行属 `D1-MCP` / ㉘ 正文，两次剪枝把它整段迁进归档后 ⇒ **注入未生效 ⇒ 自检红**，
    //    而判据本身完好 —— 这是「自检有实现 ≠ 自检不依赖易变存量」：门没坏，样例锚点没了。
    //    台账每剪一次枝，任何「从存量抽锚行」的自检都可能静默失明 ⇒ 一律改成注入自带的
    //    确定性文本，探针与台账内容正交。
    {
      label: '⑩跨条目逐字克隆',
      probe: 'ZZ-CLONE-1',
      mutate: (t) =>
        t.replace(
          anchor,
          `${anchor}\n\n- **ZZ-CLONE-1** — 自检注入｜📝 注记\n  自检克隆锚行：同一事实两处登记必漂移（探针自带，不依赖台账存量）。\n\n- **ZZ-CLONE-2** — 自检注入｜📝 注记\n  自检克隆锚行：同一事实两处登记必漂移（探针自带，不依赖台账存量）。`,
        ),
      pick: (r) => idsOf(r.clones),
    },
    // ⑫：观察区注入一条 41 行正文的条目 ⇒ 体量超限必须被抓（存量最大 35 行 ⇒ 基线不含）。
    //    填充行逐字相同但落在**同一条目内** ⇒ ⑩ 克隆门不报（跨条目才报），互不干扰。
    {
      label: '⑫观察区条目体量超限',
      probe: 'ZZ-SIZE-1',
      mutate: (t) =>
        t.replace(
          anchor,
          `${anchor}\n\n- **ZZ-SIZE-1** — 自检注入｜⏳ 观察\n${Array(41).fill('  体量探针填充行（无语义，仅占行）').join('\n')}`,
        ),
      pick: (r) => idsOf(r.oversize),
    },
    // ⑬：新登记观察项（ID 不在 HEAD）不带到期复查日期 ⇒ 必须红。
    {
      label: '⑬新登记观察项无到期复查',
      probe: 'ZZ-EXPIRE-1',
      mutate: (t) =>
        t.replace(
          anchor,
          `${anchor}\n\n- **ZZ-EXPIRE-1** — 自检注入｜⏳ 观察\n  本条刻意不写复查日期。`,
        ),
      pick: (r) => idsOf(r.noExpiry),
    },
    // ⑬b 反例控制：带了「到期复查 YYYY-MM-DD」的新条目不该报（防「凡新增就报」的过度拦截）。
    //    日期取 2099 而非近年：它同时是 ⑭ 的反例（不过期），避免将来某天这个探针自己过期
    //    而让本条反例悄悄变成 ⑭ 的命中（判据互污染 = 自检自己漂移）。
    {
      label: '⑬b新登记观察项有复查日不误报',
      probe: 'ZZ-EXPIRE-2',
      invert: true,
      mutate: (t) =>
        t.replace(
          anchor,
          `${anchor}\n\n- **ZZ-EXPIRE-2** — 自检注入｜⏳ 观察\n  到期复查 2099-12-31`,
        ),
      pick: (r) => idsOf(r.noExpiry),
    },
    // ⑬c 反例控制：**存量**条目（ID 在 HEAD 且首行 blame 早于建门时点）不带复查日也不该报，
    //    防「把存量误判成新登记」——那会让门一建就被 90 条存量淹没，进而被改成 required:false。
    //    ⚠️ ②「提交后仍红」那一相**无法在脚本内自检**（伪造不出 blame 时间），
    //    只能用隔离仓库做双相实测：复制 scripts/ + tasks/ 到临时目录 git init →
    //    注入缺复查日条目 → 未提交跑（应红）→ git commit 后跑（应仍红）。
    //    改 ⑬ 判据时必须重做这个双相实验，只跑 --self-test 不足以证明门没瞎。
    {
      label: '⑬c存量观察项不带复查日不误报',
      // probe 必须是**真实存量 ID**（不是 ZZ- 前缀）：invert 断言的是「这个 ID 没被误判」，
      // 若探针 ID 与实际注入的 ID 不一致，反例会恒绿 —— 自检自己变成假闸。
      probe: stockId,
      invert: true,
      mutate: (t) =>
        t.replace(
          anchor,
          `${anchor}\n\n- **${stockId}** — 自检注入（存量豁免探针，复用 HEAD 已有 ID）｜⏳ 观察\n  本条刻意不写复查日期。`,
        ),
      pick: (r) => idsOf(r.noExpiry),
    },
    // ⑭：复查日已过期（2020）⇒ 必须红。带日期 ⇒ 不触发 ⑬（互不污染，便于定位）。
    {
      label: '⑭复查日已过期',
      probe: 'ZZ-OVERDUE-1',
      mutate: (t) =>
        t.replace(
          anchor,
          `${anchor}\n\n- **ZZ-OVERDUE-1** — 自检注入｜⏳ 观察\n  到期复查 2020-01-01`,
        ),
      pick: (r) => idsOf(r.overdue),
    },
    // ⑭b 反例控制：未来的复查日不该报（防「凡带日期就报」的过度拦截）。
    {
      label: '⑭b未来复查日不误报',
      probe: 'ZZ-OVERDUE-2',
      invert: true,
      mutate: (t) =>
        t.replace(
          anchor,
          `${anchor}\n\n- **ZZ-OVERDUE-2** — 自检注入｜⏳ 观察\n  到期复查 2099-12-31`,
        ),
      pick: (r) => idsOf(r.overdue),
    },
    // ⑮：注入两条**同 ID** 的顶层条目 ⇒ 撞名必须被抓。
    //    注入在观察区，两条都带复查日 ⇒ 不触发 ⑬/⑭，避免用例互相污染。
    {
      label: '⑮顶层条目 ID 撞名',
      probe: 'ZZ-DUP-1',
      mutate: (t) =>
        t.replace(
          anchor,
          `${anchor}\n\n- **ZZ-DUP-1** — 自检注入（撞名第一条）｜⏳ 观察\n  到期复查 2099-12-31\n\n- **ZZ-DUP-1** — 自检注入（撞名第二条）｜⏳ 观察\n  到期复查 2099-12-31`,
        ),
      pick: (r) => idsOf(r.dupIds),
    },
    // ⑪a：删掉一个结构区标题（实吞事故形态 #2：## 注记类 被吞）⇒ 必须红
    {
      label: '⑪a结构区被吞',
      probe: '注记类',
      mutate: (t) => t.replace('## 注记类（防误判，非待办）\n', ''),
      pick: (r) => new Set(r.anchors.map((x) => x.why ?? '')),
    },
    // ⑪b：删掉观察区一个轴标题（实吞事故形态 #1：### 宿主轴 被吞）⇒ 必须红
    {
      label: '⑪b轴标题被吞',
      probe: '宿主轴',
      mutate: (t) => t.replace('### 宿主轴\n', ''),
      pick: (r) => new Set(r.anchors.map((x) => x.why ?? '')),
    },
  ];

  let allOk = true;
  for (const c of cases) {
    const after = c.mutate(base);
    const afterReadme = c.readmeMutate ? c.readmeMutate(baseReadme) : baseReadme;
    if (after === base && afterReadme === baseReadme) {
      console.log(`  ❌ ${c.label} 注入未生效（文本未变）`);
      allOk = false;
      continue;
    }
    const r = diagnose(after, {
      readmeText: afterReadme,
      // ⑧ 的时间输入：有桩用桩（探针不在 HEAD），无桩沿用基线（避免逐例重跑 blame）
      timing: c.timing ? c.timing(baseTiming) : baseTiming,
    });
    // ⑤ 的投放面是「描述字符串」而非条目 ID ⇒ 命中判定用包含而非等值（见 pick 的返回形态）。
    const contains = (set) =>
      [...set].some((x) => String(x) === c.probe || String(x).includes(c.probe));
    const hit = contains(c.pick(r));
    const clean = !contains(c.pick(baseR));
    // invert = 反例控制：判据**不该**命中（防过度拦截），故只要求 not hit
    const ok = c.invert ? !hit : hit && clean;
    if (!ok) allOk = false;
    console.log(
      c.invert
        ? `  ${ok ? '✅' : '❌'} ${c.label} 探针 ${c.probe} ${ok ? '未被误报' : '被误报'}`
        : `  ${ok ? '✅' : '❌'} ${c.label} 探针 ${c.probe} ${ok ? '被捕获' : '未被捕获'}（基线含=${!clean}）`,
    );
  }

  // ④ 连续空行：比较空块数增量
  const afterBlank = diagnose(base.replace(anchor, `${anchor}\n\n\n\n`), { timing: baseTiming });
  const blankOk = afterBlank.blanks.length === baseR.blanks.length + 1;
  if (!blankOk) allOk = false;
  console.log(
    `  ${blankOk ? '✅' : '❌'} ④空行 注入后空块 ${baseR.blanks.length} → ${afterBlank.blanks.length}（期望 +1）`,
  );

  console.log(
    allOk
      ? '\n✅ 自检通过：十四类判据（①–⑧ + ⑩⑪⑫⑬⑭⑮；⑨ 为刻意否决记录、无判据体）均可捕获新命中\n   ⚠️ ⑬ 的「提交后」一相不在此覆盖内（伪造不出 blame 时间）⇒ 改 ⑬ 后必须做隔离仓库双相实测'
      : '\n❌ 自检失败：存在失明判据',
  );
  return allOk ? 0 : 1;
}

function main() {
  const ledgerPath = join(ROOT, LEDGER_REL);
  if (!existsSync(ledgerPath)) {
    console.error(`❌ [ledger-hygiene] 台账缺失：${LEDGER_REL}`);
    process.exit(1);
  }
  const text = readFileSync(ledgerPath, 'utf8');

  if (process.argv.includes('--self-test')) {
    process.exit(selfTest());
  }

  const r = diagnose(text);
  if (r.sections.length === 0) {
    console.error('❌ [ledger-hygiene] 区标题解析为 0 —— 判据失明比假绿更危险');
    process.exit(1);
  }
  if (r.itemTotal === 0) {
    console.error('❌ [ledger-hygiene] 条目解析为 0 —— 条目格式可能已变，判据失明');
    process.exit(1);
  }
  process.exit(report(r));
}

main();
