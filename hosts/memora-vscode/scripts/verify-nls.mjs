#!/usr/bin/env node
/**
 * package 面本地化守卫（`HOST-I18N-1` 切片 1 的机检判据）
 *
 * 存在的理由：`%key%` 是**字符串替换而非编译期检查**——键拼错、键面两侧不等、
 * 或翻译文件被 `.vscodeignore` 排掉，VS Code 都不会报错，它会**把 `%key%` 原样
 * 显示在命令面板与设置页上**。这类缺陷没有红、只有用户看到，故必须机器守。
 *
 * 判据（全部对真实文件断言，任一命中即红）：
 *   ① **引用闭合**：`package.json` 里每个 `%key%` 必须在两个 nls 文件中都有定义。
 *   ② **键面相等**：`package.nls.json` 与 `package.nls.zh-cn.json` 的键集合必须完全
 *      相等——多一条 = 一侧有孤儿译文（改文案时漏同步的化石），少一条 = 该语言会
 *      回退显示 `%key%`。
 *   ③ **无孤儿键**：nls 里存在但 `package.json` 未引用的键 ⇒ 红（僵尸翻译条目，
 *      与「僵尸容器拒入库」同一纪律；删文案不忘删译文）。
 *   ④ **默认文件是英文**：`package.nls.json` 是**默认语言**文件，任何含 CJK 的值 ⇒ 红
 *      （中文只属于 `zh-cn` 文件；默认文件混中文 = 英文用户看到中文，且这类混入
 *      极易因「顺手把中文抄进默认文件」而长期潜伏）。
 *   ⑤ **中文残留（manifest 全文）**：`package.json` 任一处出现 CJK 字面量即红。判定依据 =
 *      「manifest 里出现中文」必有用户看得见的中文没走 `%key%`；**不按 contributes 面白名单
 *      扫描**——白名单每漏一个面（`viewsWelcome` / `walkthroughs` / 未来新面）就开一个静默洞。
 *   ⑥ **空值**：nls 值不得为空串（空串等于界面上什么都不显示，比 `%key%` 更难排查）。
 *   ⑦ **射程下限**：命令数与配置项数不得低于基线——防遍历因结构漂移失明
 *      （`contributes.commands` 改名成别的形状时，①⑤ 会一起变空集而「全绿」）。
 *
 * ## bundle 判据（切片 2 宿主面，`HOST-I18N-2`）——`l10n/bundle.l10n*.json` 与源码 `l10n.t()`
 *
 *   ⑧ **bundle 键面相等**：`bundle.l10n.json`（默认语言，键面真源）与
 *      `bundle.l10n.zh-cn.json` 的键集合完全相等。
 *   ⑨ **源码键全覆盖**：源码里静态 `l10n.t('Key')` 的键 + `REJECT_MESSAGES` 值（动态 t 的
 *      键源，见 workspaceRelativePath.ts）必须在两份 bundle 里都有——缺了就是「中文用户
 *      静默看到英文」，与 `%key%` 失效同性质，没有红只有用户看到。
 *   ⑩ **bundle 无孤儿**：bundle 里的键必须能对应到源码（静态 t() 键 ∪ REJECT_MESSAGES 值）；
 *      改了源码文案忘删译文 = 僵尸译文。
 *   ⑪ **zh-cn 译文非空**：空串 = 界面上什么都不显示。
 *   ⑫ **t() 第一参必须是静态字面量**：模板串作第一参 ⇒ 红（键面守卫拿不到键 = 守卫失明，
 *      宁可红也不放开）；动态拼接一律改 `{0}` 占位符形态。
 *   ⑬ **窗口 API 中文残留**：静态中文字面量直接作为**窗口面可见文案**的第一参或属性值 ⇒ 红。
 *      覆盖面（此前只扫 `show*Message` 首参，其余全在网外——2026-11-09 审查实证漏网）：
 *      - 消息 API：`showErrorMessage|showWarningMessage|showInformationMessage|showQuickPick|<项>.label`
 *      - 开框：`showOpenDialog|showSaveDialog` 的 `title` / `openLabel` / `saveLabel` 与 `filters` 键
 *      - 输入：`showInputBox` 的 `title` / `prompt` / `placeHolder`
 *      - 状态栏：`setStatusBarMessage` 首参、`StatusBarItem` 的 `.text` / `.tooltip` / `.name`
 *      - 行内：`CodeLens` 的 `title`、`QuickPickItem` 的 `label` / `description` / `detail`
 *      判定口径不变（只扫**直接字面量**）：先存中文变量再传的间接形态仍属判据边界，靠台账登记。
 *   ⑯ **`@vscode/l10n` 必须 namespace 导入**（P1 webview 基建引入的形态闸）：
 *      `import { t } from '@vscode/l10n'` 再裸调 `t('…')` ⇒ 红。⑨⑫ 的键面采集认的是字面
 *      `l10n.t(`——裸别名导入后调用点仍能翻译，但**脱离采集面**：缺译文不再红，键面三面对账
 *      （源码 t() 键 = 默认 bundle = zh-cn bundle）在 webview 侧静默失明。`import type` 无运行时
 *      调用，放行。
 *
 * ## webview 面板判据（切片 3-4 前置 · `WEBVIEW_PANELS` 注册制）
 *
 *   ⑰ **已迁移面板 CJK 清零**：`WEBVIEW_PANELS` 里 `state: 'migrated'` 的面板，其登记的
 *      全部文件**非日志 CJK 字面量必须为 0**。口径：
 *      - TS/JS：注释整段跳过；字符串里的 HTML 注释（`<!-- … -->`）跳过；
 *        `console.*` / `logger.*` 的**直接实参**跳过（日志不是给用户看的）；其余含 CJK 的
 *        字符串 / 模板串逐条计红。
 *      - CSS（`styles/*.ts`）：只判 `content: '…CJK…'`，注释不判——CSS 里的中文基本都在
 *        注释中，按字面量全扫会把注释误判成文案。
 *      - **协议标记豁免**：与内核 / 持久化 / 剥离契约对齐的信封块头等值不翻译，按
 *        「文件 + 精确值」双键登记在 `PANEL_CJK_ALLOWLIST`（不按「含转义就放行」——
 *        那等于给所有漏译开后门）。新增条目必须写清「谁对齐谁」。
 *      - **第二登记面 `SHARED_CJK_FILES`**（2026-11-10 立）：跨页签域的共享文件不挂任何面板
 *        state，登记即按同一口径判（非日志 CJK = 0）。理由见该常量注释——同一事实不接受两处表达。
 *      - **第三登记面 `DEFERRED_CJK_FILES`**（2026-11-10 立，B10-F 第二刀）：**已判定「不翻」**
 *        的含 CJK 文件（双面载荷 / 纯模型诊断 / 本地化注入面）。它不判红、也不清零，作用是
 *        把「判定结论」从 `--report` 的待翻清单里摘出去，避免下一批拿「还是中文」当漏项重判。
 *        准入三条 + 每项必带 kind / reason，见该常量注释；self-test 守「不过期、不重叠、不空判据」。
 *   ⑱ **面板清单 = 设置页签 + chat**：`WEBVIEW_PANELS` 的 panel id 集合必须等于
 *      `shared/settingsTabs.ts` 的 `SETTINGS_TABS`（文本抽取）加 `chat`。新增页签未登记 ⇒ 红，
 *      防「新面板天然无判据」。
 *   ⑲ **`--report` 规模报告**（不判红）：对全 `src` 跑⑬ 的窗口面锚点，并按面板打印 CJK 计数。
 *      只用于量规模与出收据，**不参与退出码**。
 *   ⑳ **zh bundle 译文一致性**（B9 收口）：`bundle.l10n.zh-cn.json` 每条译文
 *      ①非空（与⑪ 同判据，此处不重复）②**不得照抄英文源键**（专有名词走
 *      `ZH_SAME_AS_KEY_ALLOWLIST` 白名单）③**`{n}` 插值占位符集合必须与键完全一致**。
 *
 *      **为什么落在这里、而不做「屏级 zh 渲染用例」**（写死理由，免得下次有人再提一遍）：
 *      - 「键加了、译文漏了」已由⑧ 键面相等 + ⑪ 非空挡住——键没进 zh bundle 就红；
 *      - 真正漏得过去的只剩两类**静默失效**：zh 值照抄英文源键、译文丢了 `{n}` 占位符。
 *        这两类在屏级用例里既难稳定复现，又只能覆盖被点到的那几屏，全量覆盖不了；
 *        在 bundle 面判断是**单一判据 + 全量覆盖**，成本远低于屏级用例；
 *      - 「zh 界面不出现英文」这个断言本身会**误报**：MCP / API Key / URL 这类专有名词
 *        在中文界面本就该保留英文，屏级断言写不出可维护的边界。
 *
 * ### 🔴 注册制盲区（如实写死，不假装覆盖）
 *
 *   1. **漏登记不会红**：新建 webview 面板 / 文件而不写进 `WEBVIEW_PANELS`，⑰ 永远扫不到。
 *      补偿只有两条：⑱ 挡「新设置页签没登记」；`--report` 的未登记文件清单进批次收据。
 *      ⑰ 本身**没有**兜底判据（不存在「全 src 无中文」这种判据，未迁移面板本来就有中文）。
 *   2. **`state` 可被人为改回 `pending`**：等于关掉该面板的判据。首次迁移前无法设迁移数下限
 *      （下限为 0 是死判据），故由批次收据 + 代码审查兜；后续批次逐个 `migrated` 后风险递减。
 *   3. **日志白名单是启发式**：只放行「字面量是 `console.*` / `logger.*` 的直接实参」，
 *      包一层 helper 的间接日志会被计为可见文案（误红不误绿）。
 *   4. **白名单只放内部事实（日志），不放「模型可见」整类**：那一类里混着**双面串**
 *      （`tool_result.summary` 由 `toolRunner` 拼给模型看，`loop.ts` 截前 100 字直接上屏，
 *      宿主原样搬运）。按「模型可见」放行 = 守卫报绿而英文用户屏幕仍是中文——**守卫撒谎
 *      比没有守卫更贵**。双面串属未收口缺口，**必须报出来**（分类口径见方案 §4 切片 0）。
 *
 * ## 采集面已知形态清单（B11 第一步立 · 一次说清覆盖什么、不覆盖什么）
 *
 * > 立这条的直接原因：今晚连续两次「以为覆盖了、其实没有」——判据⑬ 不认属性赋值、
 * > 判据⑰ 的模板串采集在嵌套模板处自我截断。**盲区写在明处才不会再付一次学费。**
 *
 * | 形态 | 例子 | ⑰ 采集器 | 说明 |
 * | --- | --- | --- | --- |
 * | 字符串字面量 | `el.title = '删除'` | ✅ 计红 | 单 / 双引号串逐条产出 |
 * | 属性赋值 | `{ label: '删除' }` / `el.title = '删除'` | ✅ 计红 | 它就是字面量；⑨ 的映射表另按 `@nls-keys` 聚合 |
 * | 模板字面量 | `` `<b>删除</b>` `` / `` `${head}<b>删除</b>` `` | ✅ 计红 | 按 `${…}` 切静态片段逐段判；插值**前后**都算 |
 * | 纯插值模板 | `` `${a}${b}` `` | ✅ 不判 | 零静态片段 ⇒ 没有文案可翻（负向自检守着） |
 * | 正则字面量含引号 | `/['"]/` | ⚠️ 可能漏 | 字面量边界会被打乱，同文件后续文案可能漏采 |
 * | 字符串拼接 | `'前缀' + label` | ⚠️ 半采 | 每段本身会被采到，但「这是一句完整文案」判断不了 |
 * | 动态键 | `l10n.t(variable)` | ❌ 不采 | ⑫ 只拦「模板串作第一参」这一种最易犯写法 |
 * | CSS 中文 | `.x { color: red }` 里的中文 | ❌ 不判 | 只认 `content: '…'`；注释不判（见⑰ CSS 口径） |
 * | 宿主产物 / 资源 | `dist` 目录、`.html` 资源、`package.json` | ❌ 不扫 | 扫描面 = `src` 下的 `.ts`（`package.json` 由 ⑧ 单独判 `%key%`） |
 * | ⑬ 窗口 API 的**属性赋值** | `opts.title = '删除'` | ❌ 不判 | **⑬ 的形态缺口**（它只认方法实参），与 ⑰ 采集器无关，勿混为一谈 |
 *
 * ## 判据边界（如实登记，不假装覆盖）
 *
 * - **只认静态字面量**：`l10n.t(variable)` / 拼接 / 模板串第一参之外的动态形态扫不到（⑫ 只拦
 *   模板串第一参这一种最易犯的写法）。
 * - **注释剥离按整行**（⑨⑫⑯ 采集前先剥）：残余边界 = **行尾行内注释**里的调用样例 / import
 *   样例仍会被当代码采集（误红不误绿）——注释里的示例写在独立整行注释内即安全。
 * - **动态键源只认「从源码里抽出的字符串值」**：`REJECT_MESSAGES` 一类映射表按「文件内抽取
 *   全部 `'键': '文案'` 形态」聚合，**不锚定变量名**——改名或新增第二张映射表不会静默脱管。
 *
 * 插点：`package.json#scripts.package`（vsce 打包前）+ `scripts/local-ci.mjs` 的
 *   `host:manifest` 步骤（**fast + full 两档**）。「实现了」不等于「会跑」，两处都要挂；
 *   纯静态、秒级 ⇒ 进 fast 档，改键面时在**提交**就红，而不是推到 pre-push 才发现。
 *
 * 用法：
 *   node scripts/verify-nls.mjs             # 主跑：对真实 manifest / nls / bundle / 源码断言
 *   node scripts/verify-nls.mjs --self-test # 自检：基于真实文件注入变异，确认判据能红
 *   node scripts/verify-nls.mjs --report    # 规模报告：全 src CJK 计数（按面板），不判红
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = join(HERE, '..');

/** 判据⑦ 基线：0.5.0 实测 19 命令 / 13 个顶层配置项。只防「大面积消失」，不追精确相等 */
const MIN_COMMANDS = 15;
const MIN_CONFIG_PROPS = 10;

/** CJK 判定：汉字 + CJK 标点 + 全角字符（中文文案里必然出现其中之一） */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

/**
 * 判据⑳ 白名单：zh 译文**合法地**与英文源键同形的条目（专有名词 / 纯占位符组合）
 *
 * 判据⑳ 的目标是抓「键加了、译文直接照抄英文」这种漏译，而不是逼专有名词硬造中文
 * （MCP / API Key 在中文界面本就保留英文）。加白名单必须逐条给出理由，不整类放行。
 */
const ZH_SAME_AS_KEY_ALLOWLIST = new Set([
  'MCP', // 协议名，无通行中文译名
  'LLM', // 缩写，中文界面通用英文
  'API Base URL', // URL 一词在中文界面保留英文
  'API Key', // 同上
  '{0} {1}%', // 纯占位符组合（拼装「比例」文案），本身不含自然语言
]);

/**
 * 抽取字符串里的 `{n}` 插值占位符，返回**排序后**的列表（顺序无关，集合比对）
 *
 * @param {string} text 待抽取文本
 */
function placeholdersOf(text) {
  return (String(text).match(/\{\d+\}/g) ?? []).sort();
}

/**
 * 收集 manifest 里**所有**字符串叶子（路径 + 值）。
 *
 * 为什么不是「只扫命令标题 / 配置描述 / 视图名三面」：判据⑤ 的职责是「新增可见字段忘了走
 * `%key%`」，而 manifest 的可见字段是会长的——`viewsWelcome`（视图欢迎语，markdown）、
 * `walkthroughs`（引导步骤）、`configuration.title`、未来的新 contributes 面，任一都不在
 * 那三面里。按面白名单扫描的结果是：新增一个面就悄悄开一个洞，而**洞不会红**。
 * 故改为全文扫描——判定依据变成「manifest 里出现中文 = 一定有用户看得见的中文没走占位」。
 */
function collectStrings(node, trail, out) {
  if (typeof node === 'string') {
    out.push([trail.join('.'), node]);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectStrings(child, [...trail, `[${i}]`], out));
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      collectStrings(child, [...trail, key], out);
    }
  }
  return out;
}

/**
 * 判据本体（纯函数，便于自检注入）：入参三类原文，返回问题列表；空数组 = 绿。
 *
 * @param {object} input
 * @param {object} input.pkg  package.json 解析结果
 * @param {object} input.en   package.nls.json（默认语言 = 英文）
 * @param {object} input.zh   package.nls.zh-cn.json
 */
export function auditNls({ pkg, en, zh }) {
  const issues = [];
  const contributes = pkg?.contributes ?? {};
  const commands = contributes.commands ?? [];
  const configProps = contributes.configuration?.properties ?? {};

  // 判据⑦ 射程下限（先查：空集会让后续判据静默变绿）
  if (commands.length < MIN_COMMANDS) {
    issues.push(
      `命令数 ${commands.length} < 基线 ${MIN_COMMANDS}（contributes 结构漂移或遍历失明）`,
    );
  }
  if (Object.keys(configProps).length < MIN_CONFIG_PROPS) {
    issues.push(`顶层配置项 ${Object.keys(configProps).length} < 基线 ${MIN_CONFIG_PROPS}（同上）`);
  }

  // 判据⑤ 中文残留（**manifest 全文**，不是某三面白名单——见 collectStrings 说明）
  const allStrings = collectStrings(pkg, [], []);
  for (const [where, value] of allStrings) {
    if (CJK.test(value)) {
      issues.push(`中文硬编码残留：${where}（应走 %key% 占位）`);
    }
  }

  // 判据① 引用闭合：manifest 内所有整值 `%key%` 占位（含未来新增面的占位）
  const referenced = new Set();
  for (const [, value] of allStrings) {
    const m = /^%(?<key>[^%]+)%$/.exec(value);
    if (m) referenced.add(m.groups.key);
  }
  for (const key of referenced) {
    for (const [lang, dict] of [
      ['package.nls.json', en],
      ['package.nls.zh-cn.json', zh],
    ]) {
      if (!Object.hasOwn(dict, key)) issues.push(`${lang} 缺键：${key}（界面会显示 %${key}%）`);
    }
  }

  // 判据② 键面相等
  for (const key of Object.keys(en)) {
    if (!Object.hasOwn(zh, key)) issues.push(`键面不等：${key} 仅在英文文件`);
  }
  for (const key of Object.keys(zh)) {
    if (!Object.hasOwn(en, key)) issues.push(`键面不等：${key} 仅在中文文件`);
  }

  // 判据③ 无孤儿键
  for (const key of Object.keys(en)) {
    if (!referenced.has(key)) issues.push(`孤儿键：${key} 未被 package.json 引用（僵尸译文）`);
  }

  // 判据④ 默认文件是英文 / 判据⑥ 空值
  for (const [key, value] of Object.entries(en)) {
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push(`package.nls.json 值无效：${key}`);
      continue;
    }
    if (CJK.test(value)) issues.push(`package.nls.json 出现中文：${key}（默认文件必须是英文）`);
  }
  for (const [key, value] of Object.entries(zh)) {
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push(`package.nls.zh-cn.json 值无效：${key}`);
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ *
 * bundle 判据（切片 2，⑧-⑬）
 * ------------------------------------------------------------------ */

/** 递归收集 src 下的 .ts 文件（排除 __tests__ 与 .d.ts；bundle 判据的扫描面） */
function walkTs(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTs(p, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

/**
 * 抽取 REJECT_MESSAGES 常量块里的字符串**值**（动态 t 的键源登记点，唯一）
 *
 * 注意引号分支：值里合法地含双引号字符（如 `no "." or ".." segments`），字符类
 * 若同时排除 `'` 和 `"` 会在第一处双引号截断——必须按开引号类型分支匹配。
 */
/**
 * 把源码字符串字面量的**原始捕获文本**还原为运行时字符串值。
 *
 * 正则从源文件捕获的是原文：`\n` 在源文件里是「反斜杠 + n」两个字符，而 JSON bundle
 * 解析后 `\n` 是真换行——不做还原，多行键（如 modal 文案）两侧比对必假红
 * （2026-11-09 真机反馈批实踩）。覆盖常见转义：`\n` / `\t` / `\r` / `\0` / 行续接 /
 * `\uXXXX` / `\u{...}` / `\xXX` / `\\` `\'` `\"` 等 identity 转义。
 */
function unescapeSourceLiteral(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, g) => {
    if (g[0] === 'u' && g[1] === '{') return String.fromCodePoint(parseInt(g.slice(2, -1), 16));
    if (g[0] === 'u' || g[0] === 'x') return String.fromCodePoint(parseInt(g.slice(1), 16));
    if (g === 'n') return '\n';
    if (g === 't') return '\t';
    if (g === 'r') return '\r';
    if (g === '0') return '\0';
    if (g === '\n') return ''; // 行续接反斜杠（源码折行）
    return g; // \\ \' \" 等 identity 转义 → 还原为字符本身
  });
}

/** 从 `openIndex` 处的开符号取到配对闭符号（含两端）；找不到闭合即取到文末 */
function sliceBalanced(text, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(openIndex, i + 1);
  }
  return text.slice(openIndex);
}

/**
 * 动态 t() 的键源登记点采集（判据⑮ 的扫描面）
 *
 * 约定：在「动态 `l10n.t()` 会用到的映射表」上方写一行 `// @nls-keys`，紧随其后的
 * 第一个 `{ … }` 块即该表，块的字符串值进入键面（键是原因码 / 枚举值，不进键面）。
 *
 * 为什么用**标记**而不是锚定变量名：锚定 `const REJECT_MESSAGES` 时，改个变量名或新增
 * 第二张映射表就静默脱管（2026-11-09 审查实证）。标记与命名解耦，改名不影响判定。
 * 判据边界：新增第二张动态键源表若**不打标记**，仍会脱管——语法上无法推断「谁是键源」，
 * 故配 ⑮「标记数不得低于基线」防清单塌空，并在台账登记该边界。
 *
 * **键名带不带引号都认**（2026-11-09 订正）：本仓 prettier 没配 `quoteProps`，默认
 * `as-needed` 会**自动剥掉**合法标识符键名的引号 ⇒ 旧实现只认 `'键': '值'` 时，提交钩子
 * 一跑就把这批键踢出采集面（实测：settingsTabs 的 8 个页签名全成 bundle 孤儿键，而
 * TYPE_BADGE_LABEL 的 5 个值既不进 bundle 也不报缺键 = 静默脱管）。**约定不能与格式化工具
 * 对抗**，故采集端放行裸标识符键名（值仍必须是字符串字面量）。
 *
 * **数字键也认**（2026-11-10，B10-E 实锤）：`Record<1|2|3, string>` 这类按阶段码索引的表
 * 是合法键源（`imageValidation.REJECT_KEY`），旧实现只认三种键形 ⇒ 六条拒绝文案全成孤儿键。
 */
function collectDynamicKeySources(text) {
  const values = [];
  let markers = 0;
  // 键：单引号 / 双引号 / 裸标识符 / 数字（枚举值表，如 `Record<1|2|3, string>`）；值：单引号或双引号字符串字面量
  const ENTRY_RE =
    /(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*)|(\d+))\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  for (const m of text.matchAll(/@nls-keys/g)) {
    markers++;
    const open = text.indexOf('{', m.index);
    if (open < 0) continue;
    const block = sliceBalanced(text, open, '{', '}');
    for (const mm of block.matchAll(ENTRY_RE)) {
      // mm[5] / mm[6] = 值的正文（单引号 / 双引号），按开引号类型分支避免截断
      values.push(unescapeSourceLiteral(mm[5] !== undefined ? mm[5] : mm[6]));
    }
  }
  return { values, markers };
}

/**
 * 窗口面可见文案的**静态字面量**采集（判据⑬ 的扫描面）
 *
 * 每条规则 = 「锚点正则 + 捕获组序」。锚点命中即判定文案值是否含 CJK——不做 AST，
 * 因为「窗口 API 被包一层 helper 后仍可能漏」这件事 AST 一样挡不住（helper 里同样是动态传参）；
 * 真正决定覆盖面的是「窗口面有哪些写法」，故按 API 面穷举写法而非按语法深度。
 *
 * ⚠️ 新增一个窗口面 API 时**必须**回来加一条锚点：漏加的后果是「新面中文裸串静默上线」。
 */
const WINDOW_LITERAL_ANCHORS = [
  // 消息类：第一参
  /(showErrorMessage|showWarningMessage|showInformationMessage|setStatusBarMessage)\s*\(\s*'((?:[^'\\]|\\.)*)'/g,
  /(showErrorMessage|showWarningMessage|showInformationMessage|setStatusBarMessage)\s*\(\s*"((?:[^"\\]|\\.)*)"/g,
  /(showErrorMessage|showWarningMessage|showInformationMessage|setStatusBarMessage)\s*\(\s*`([^`]*)`/g,
  // QuickPick / 输入框：选项对象的文案属性（label / description / detail / title / prompt / placeHolder）
  /\b(label|description|detail|title|prompt|placeHolder)\s*:\s*'((?:[^'\\]|\\.)*)'/g,
  /\b(label|description|detail|title|prompt|placeHolder)\s*:\s*"((?:[^"\\]|\\.)*)"/g,
  /\b(label|description|detail|title|prompt|placeHolder)\s*:\s*`([^`]*)`/g,
  // 开框选项：openLabel / saveLabel；filters 的键（`{ 压缩包: ['zip'] }` 形态）
  /\b(openLabel|saveLabel)\s*:\s*'((?:[^'\\]|\\.)*)'/g,
  /\b(filters)\s*:\s*\{[^}]*?('((?:[^'\\]|\\.)*)')\s*:/g,
  // 状态栏 item 属性（`.text = '…'` / `.tooltip = '…'` / `.name = '…'`）
  /\.(text|tooltip|name)\s*=\s*'((?:[^'\\]|\\.)*)'/g,
  /\.(text|tooltip|name)\s*=\s*`([^`]*)`/g,
];

/**
 * 按行剥离整行注释（`//` / `/*` 块行 / `*` 续行 / `*​/`）——键面采集认**代码**。
 *
 * 为什么必须剥：注释里写调用样例（``l10n.t('Key')``、`` `l10n.t(` `` 裸提及）会被
 * ⑨⑫ 当真实调用采集 ⇒ 误红（2026-11-09 P1 实测：webviewL10n 注释里的样例直接打红主跑）。
 * 为什么按行剥而非完整词法剥离：字符串字面量里的 `//` 不会顶行首，误伤面可枚举；
 * 残余边界 = **行尾行内注释**里的样例仍会被采集（登记在判据边界，不假装覆盖）。
 * `*` 续行要求后随空白（`* text`），放行生成器方法行（`*gen() {}`）。
 */
function stripCommentLines(text) {
  return text.replace(/^[ \t]*(?:\/\/|\/\*|\*\/|\*\s).*$/gm, '');
}

/**
 * 注入式翻译器模块的标记：文件头注释写 `@nls-injected`
 *
 * **为什么需要第二个标记**：零 vscode 依赖模块（`imageIngest` / `imagePick` / `memoryStorage`
 * ——「能拿真临时目录机测」的前提）拿不到 `vscode.l10n.t`，只能由宿主注入翻译器（形参名 `t`），
 * 于是调用点是 `t('Key')` 而非 `l10n.t('Key')`，**静态采集面认不出** ⇒ 键全成 bundle 孤儿键。
 *
 * 为什么用**文件内标记**而非集中的模块清单：文件改名 / 移动时标记跟着文件走，
 * 集中清单会静默脱管（同 `@nls-keys` 的选型理由）。
 */
const INJECTED_TRANSLATOR_MARKER = '@nls-injected';

/** 源码 l10n 键采集结果 */
function collectTKeyFacts(files) {
  const staticKeys = new Set();
  const dynamicKeys = new Set();
  const templateViolations = [];
  let dynamicKeyMarkers = 0;
  // 按开引号类型分支（键里合法含另一种引号字符，合一字符类会提前截断——同 collectDynamicKeySources）
  const callSingles = [/\bl10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g, /\bl10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g];
  // 注入式翻译器模块：调用点是 `t('Key')`（拿不到 vscode，翻译器由宿主注入）⇒ 需专用采集
  const injectedSingles = [/\bt\(\s*'((?:[^'\\]|\\.)*)'/g, /\bt\(\s*"((?:[^"\\]|\\.)*)"/g];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    // 动态键源的标记 @nls-keys 本身写在注释里 ⇒ 动态采集用原文；静态 / 模板采集剥注释
    const dyn = collectDynamicKeySources(text);
    dynamicKeyMarkers += dyn.markers;
    for (const m of dyn.values) dynamicKeys.add(m);
    const codeText = stripCommentLines(text);
    for (const re of callSingles) {
      for (const m of codeText.matchAll(re)) staticKeys.add(unescapeSourceLiteral(m[1]));
    }
    // `@nls-injected` 标记（写文件头注释）⇒ 本文件的 `t('Key')` 也进静态键面
    if (text.includes(INJECTED_TRANSLATOR_MARKER)) {
      for (const re of injectedSingles) {
        for (const m of codeText.matchAll(re)) staticKeys.add(unescapeSourceLiteral(m[1]));
      }
    }
    // 模板串第一参 = 违规（键面守卫拿不到键）
    if (/\bl10n\.t\(\s*`/.test(codeText)) templateViolations.push(f);
  }
  return { staticKeys, dynamicKeys, templateViolations, dynamicKeyMarkers };
}

/** 窗口 API 直接中文字面量（按 `WINDOW_LITERAL_ANCHORS` 穷举窗口面写法） */
function collectWindowApiCjkInText(text, label) {
  const violations = [];
  for (const re of WINDOW_LITERAL_ANCHORS) {
    for (const m of text.matchAll(re)) {
      // filters 形态的捕获组序不同（第 3 组才是文案键），统一取最后一个含字面量的组
      const raw = m[3] !== undefined ? m[3] : m[2];
      // 转义还原后再判 CJK（`'\u4e2d\u6587'` 形态在原文里不含 CJK 字符，不还原即漏检）
      const value = unescapeSourceLiteral(raw);
      if (CJK.test(value)) {
        violations.push(`${label}: ${m[1]}('${value.slice(0, 30)}…')`);
      }
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ *
 * webview 面板判据（⑰-⑲）
 * ------------------------------------------------------------------ */

/**
 * webview 面板注册表 —— 判据⑰（已迁移面板 CJK 清零）与⑱（面板清单对拍）的真源
 *
 * 状态语义：
 * - `migrated`：登记的全部文件里不得存在**非日志 CJK 字面量**（⑰ 判红）。
 * - `pending`：尚未迁移，**不判红**。`files` 可以非空——那表示「这些文件已在本批翻完并登记
 *   到位，只是所属面板还没整体收口」（B8 起：chat 面板里的状态条 / 活动抽屉两个文件已英文化，
 *   但 chatView 本体等仍在 B9）。判据⑰ 按**文件**登记、按**面板**开关，故 pending 面板的
 *   已翻文件此刻只能靠「批次屏上用例」兜底，面板整体 migrated 时自动进网。
 *
 * 盲区见文件头「注册制盲区」三条：漏登记不红、state 可改回 pending、日志白名单是启发式。
 * 新增面板 = 本表加一项（⑱ 会挡漏登记）+ 迁移批次把 state 改 `migrated` 并列出文件。
 */
const WEBVIEW_PANELS = {
  // chat 面板（B8 起分批迁移）：
  // `statusBarsView.ts` / `activityDrawerView.ts` 已于 B8 英文化（状态条 + 活动抽屉 + 指标详情），
  // `extension/host/tracer.ts` 一并登记——它是活动抽屉「操作流」段的**数据源**，标签是用户可见面，
  // 只翻抽屉不翻数据源 = 屏上仍是中文（半截迁移）。但 `chatView.ts` / `chatPanel.ts` 等对话主体
  // 仍在 B9 ⇒ 面板整体保持 pending。
  // **归属判定（用户提醒第 2 条）**：`processEventText.ts` / `toolNameMap.ts` / `processFlowCells.ts`
  // 的依赖面 = chatView（对话面板）+ 宿主 confirmCoordinator（`toolNameMap`），归 B9 一并翻；
  // `toast.ts` 虽然被 settingsView / configView 消费，但文件内**零 CJK 可见字面量**（中文只在注释里），
  // 无需登记；`dockToast.ts` 只服务 chatView 的浮层放置，归 B9。
  //
  // B9-A（共享渲染件三件套 + 状态属性通道）已收口并登记：
  //   · processEventText / toolNameMap / processFlowModel —— 过程流文案与工具展示名；
  //     toolNameMap 表值改为**英文源键**，webview 与宿主两侧各过本地化器（宿主 confirmCoordinator 同步）；
  //   · statusAttrs —— data-status / data-terminus 的**键面与文案分离**（键给选择器、label 给
  //     CSS content），故属性里不再有 CJK；chatStyles 的三档终态标签随之改读 label 通道。
  //   仍未迁移：imageCapture 等（B9-E）⇒ 面板仍 pending。
  //   （`chatView.ts` 已于 B9-C 三刀迁完、`chatPanel.ts` 的事件出口域已于 B9-D-1 迁完，见下。）
  //
  // B9-B（过程流单元格两件套）已收口并登记：
  //   · processFlowCells —— 任务项标题 / 叙述冒号 / 工具批失败统计 / 搜索证据三件套全部走 l10n；
  //     标点类文案（冒号、包裹括号）按中英形态各一条键，不用 ASCII 凑中文版式；
  //   · toolRowView —— 文件内本就零可见字面量（中文全在注释），登记即把「过期未迁移」变成受判据文件。
  //
  // B9-C-1（过程流文案域，`chatView.ts` 首刀）已收口并登记：
  //   · processEventText —— 新增轮块文案构建器（小节标题 / 收起摘要 / 执行指标 / 交互 tag /
  //     任务项 tag / 进行中工具行 / 叙述冒号），键与标签分离：`data-section` 落机器键；
  //   · qaRowView —— 随本刀迁完（其 tag 文案与 chatView 收起态统计 `<tag>×N` 必须同源，
  //     拆分迁移会让统计与行 tag 各说各话）；仍未迁移：chatView.ts 其余域（C-2/C-3）⇒ 面板仍 pending。
  //
  // B9-C-2（会话 / 输入区 chrome 与状态指示域，`chatView.ts` 第二刀）已收口并登记：
  //   · pendingWaitView —— 「回答等待中」指示器整域外置（元素 / 起算时点 / 1s 定时器），
  //     缺省相位与「已等待」后缀是本域自有键；
  //   · roleBadgeView —— 徽章读屏 / 可见文案 / 悬浮说明 / 组队 tooltip 提为纯函数；
  //   · traitLabels —— 特征名表从 rolesView 提升为唯一真源（chatView 徽章与角色面板共用）；
  //   · fmtTime —— 新增 fmtMonthDay（日期分隔线的月日短格式，中文版式只由 zh 译文给）。
  //
  // B9-C-3（交互确认 / 附件注入域，`chatView.ts` 第三刀 = B9-C 收尾）已收口并登记：
  //   · askInlineView —— 内联提问卡整域外置（逐题累计 / 强制单选 / 位次不变量 / 提交按钮）；
  //   · writeConfirmCardView —— 确认审批卡整域外置（内容填充 / 末段倒计时 / 等待态 / 裁决）；
  //   · chatView —— 剩余散落文案（状态提示 / 附件注入 chip / clarify 兜底）全走 l10n.t，
  //     ⑰ 口径 CJK 字面量 = 0（仅剩 2 条 console.* 日志，白名单）。
  //   **pending 说明已随 B9-E 收口作废**：本行记录当时的判断（登记未齐就翻 = 守卫报绿、
  //   屏幕仍中文）。实际收口见下方 B9-E-5。
  //
  // B9-D-1（会话事件出口域，`chatPanel.ts` 首刀）已收口并登记：
  //   · chatNoticeOps —— 20 个会话级 / 后台事件处理器整域外置（纯「事件 → notice / 派生投影刷新」，
  //     依赖面 = 11 个窄接口）；可见文案全走 l10n，两处**内核中文载荷**（`inputTooLarge.hint` /
  //     `COMPRESS_TARGET_LABELS`）属内核公开面，本批只登记为债、不改；
  //   · chatPanel —— 只留 `_notice` 注入 + 装订表；本刀后仍有未迁移域（会话结构 / 分叉改名 /
  //     输入守卫 / 文案常量）⇒ 面板仍 pending。
  //
  // B9-D-2（引用入口域，`chatPanel.ts` 第二刀）已收口并登记：
  //   · chatRefOps —— `openRefInEditor`（引用打开定位）+ `openMentionQuickPick`（@ 提及选择器）
  //     整域外置；两者同属「引用的入口/出口」一条链、共用 `refPath` 首根判据，故同模块承载；
  //     in-flight 标志收进闭包（面板不再持有），依赖面 = 3 个窄接口（post / pushRefs / hasView）；
  //   · `MENTION_FILE_LIMIT` 随域迁出，测试从 `chatRefOps.ts` 读同一个数（不复制字面量）；
  //   · chatPanel —— 两个方法与旧 `##` 说明只留转发口，`openMentionQuickPick` 保留公开签名
  //     （webview 分发与宿主单测经它驱动）。
  //
  // B9-D-3（问答结构破坏性操作域，`chatPanel.ts` 第三刀）已收口并登记：
  //   · chatTurnStructureOps —— `delete_turn` 与 `regenerate` 共用的截断核（运行时守卫 →
  //     确认 → store 截断 → 现场作废 → 联动软删 → 重放）整域外置；确认文案由调用方本地化后
  //     传入（文案与破坏面一一对应，不在核里按 reason 猜）；依赖面 7 个窄接口；
  //   · `TRUNCATE_FAIL_NOTICE` 迁为 `truncateFailNotice()`（两入口共用同一句，不复制字面量）；
  //   · chatPanel —— 只经 `_turnOps` 转发；测试的白盒驱动改走 `_turnOps`（4 处）。
  //
  // B9-D-4（会话导航域，`chatPanel.ts` 第四刀）已收口并登记：
  //   · chatSessionNavOps —— 分叉 / 改名 / 切换三个导航入口整域外置：三者共用
  //     「拿锁 → 换显示源 → 取/建实例 → 回放」同一套步骤，锁归属 / 实例投影表 / 回放
  //     三条不变量因此只有一份实现；依赖面 13 个窄接口（含 lock 与 sessionAgents 两个
  //     子接口），全部是**延迟取**的闭包（字段初始化早于 `_lockFinalizer` / `_sessionAgents`）；
  //   · chatPanel —— 三个公开方法只留转发口（webview 分发与既有白盒测试按原入口驱动）。
  //
  // B9-D-5（记忆软删域，`chatPanel.ts` 第五刀）已收口并登记：
  //   · chatMemoryOps —— 单条反馈删除（确认框 → `memory.writeDelete` → `memory_deleted` 应答）
  //     与会话删除后的联动软删（Round 物理回收 → `softDeleteRoundSummaries`）整域外置；
  //     两者共用同一套降级口径（Agent 未就绪跳过 / 异常只记录、不阻断主流程），故同域承载；
  //   · 与设置页 `settingsMemoryOps.ts` **不合并**：那边是记忆管理语境（删完刷列表与治理统计），
  //     这边是对话语境（只回 `memory_deleted` 摘行），仅一行内核调用同形，抽象成本高于各写一份；
  //   · chatPanel —— 两个私有方法只留转发口；`confirmModal` 导入随域迁出（本类不再直接开框）。
  //
  // B9-D-6（运行控制域，`chatPanel.ts` 第六刀）已收口并登记：
  //   · chatRunControlOps —— 停止 / 暂停 toggle / 恢复三入口整域外置：共同依赖会话级运行态
  //     （`runtimeFor`）与提问协调器（`askFor`），且「paused 必须以中断收场」的判据只有一份；
  //   · 本域**不做相位裁决**（那是 `handleInput` 的活），只执行并给出点击反馈；
  //   · `postPendingDiscarded` / `syncPendingQueue` 留在面板：它们是队列投影的一对，
  //     与运行控制只共享「停止会丢弃排队插话」一个调用点，搬走反而把投影打散。
  //
  // B9-E-1a（引用 chip 构建域）已收口并登记：
  //   · refChips —— 引用 chip 的可见文本 / title / aria-label 全走 l10n；
  //     钉住二态**复用** skill chip 同一组键（`Pinned (kept after sending)` / `Unpin (cleared after
  //     sending)`，同一「发送后是否保留」语义不另造近似措辞），失效注记用专用键
  //     `Invalid (file no longer exists)`（不复用裸 `Invalid`，避免 zh 译文被别处借用成「无效」）；
  //   · 行号定位提示拆成 `' and locates line {0}'` 拼接进主句的 `{0}`——两个语言各按自语句序给译文，
  //     不在代码里拼中文/英文语序。
  //
  // B9-E-1b（上下文信封域）已收口并登记：
  //   · docContext —— **协议标记不译**：`DOC_CONTEXT_OPEN/CLOSE`、`REF_CONTEXT_OPEN/CLOSE`、
  //     `SKILL_CONTEXT_OPEN`（内核技能块前缀的镜像）、`USER_REQUEST_SEPARATOR` 是信封标记，
  //     属持久化数据 + 剥离契约锚点 ⇒ 值一字不改，改用 Unicode 转义消 CJK（转义前后运行期
  //     字符串完全相同，旧消息的剥离不受影响）；
  //   · 引用块喂给**模型**的提示正文（指针行 + read_file 的 offset/limit 提示）改英文源字面量、
  //     **不过 l10n**——那是模型指令正文，不是界面文案，界面语言与它无关。
  //
  // B9-E-2（按钮语义矩阵 + 会话历史运维）已收口并登记：
  //   · turnUiState —— 按钮 title / ariaLabel 全走 webview 侧 `l10n.t`（namespace 导入）；
  //   · sessionHistoryActions —— 运行在 extension host（依赖 HostSessionStore / confirmModal），
  //     用宿主侧 `vscode.l10n.t`；`SESSION_HELD_NOTICE` 常量改为 `sessionHeldNotice()` 函数
  //     （模块加载期不能定语言，且守卫 ⑨⑩ 认的是静态 `t('键')` 字面量）；两处 console.warn 顺手改英文。
  //
  // B9-E-3（空状态 / 历史菜单 / 上下文占用三视图）已收口并登记：
  //   · 文案一律改为**调用时**取 `l10n.t`（`defaultSuggestions()` / `segmentLabels()` 等工厂），
  //     不用模块级常量——模块加载早于语言包就绪，顶层求值会把默认语言写死；
  //   · showcase 角色显示名（`SHOWCASE_ROLE_NAME`）是角色包 manifest 的**身份串**（映射键 + 比较值），
  //     Unicode 转义只消源码 CJK，运行期字符串与 manifest 一致，不得翻译；
  //   · 历史活跃度标签用专用键 `Awaiting answer` / `Executing`——通用 `Pending` / `Running`
  //     已被别处占用且译文不同（待发送 / 进行中），复用即串味。
  //
  // B9-E-4（图片采集 / 错误文案 / 注入源登记三件套）已收口并登记：
  //   · injectionSourceMeta —— UI 字段（段名 / @ 下拉项 / chip 说明）改为**英文源键**，由
  //     消费侧各过本地化器（宿主 chatRefOps 用 `vscode.l10n.t`、webview chatView 用 `l10n.t`）；
  //     本模块保持**零依赖**（两侧共用，写死任一侧的 t() 都会让另一侧失效），键源用
  //     `// @nls-keys` 登记进 bundle 键面；
  //   · 信封标记（`[工作区诊断]` / `[git 未提交改动]`）是持久化数据 + 剥离契约锚点，
  //     **值不翻译**——Unicode 转义只消源码 CJK，运行期字符串不变；
  //   · errorText —— 文案改**调用时**取 `l10n.t`（switch 里全静态键，不建模块级译文表：
  //     顶层求值会把默认语言写死，且守卫 ⑨⑫ 只认静态 `t('键')`）；
  //   · imageCapture —— 采集 / 拒收 / 预览 / 上传按钮的全部可见文案走 `l10n.t`。
  //
  // B9-E-5（收口）：
  //   · `state` 翻 `migrated`——登记面（35 个文件，含 `chatPanel.ts`）可见 CJK = 0。
  //     口径是「**登记面**全绿」，不是「全目录无中文」：未登记文件由 `--report` 未登记面照旧列出；
  //   · **协议标记不译**（判据⑰ 白名单 `PANEL_CJK_ALLOWLIST`，按「文件 + 精确值」双键）：
  //     `docContext` 的信封块头 / `【当前技能】` / `用户请求：` 分隔符（内核同源写入模型上下文，
  //     剥离侧以闭标签为锚点，翻译即剥离失效）、`injectionSourceMeta` 的 `[工作区诊断]` /
  //     `[git 未提交改动]`（持久化数据）、`emptyStateView` 的角色包 manifest 显示名（映射键 + 对比值）。
  //     这类值是**跨端契约的字节**，与「漏译」本质不同；新增条目须写清「谁对齐谁」；
  //   · `chatPanelHtml.ts` **已登记**（见 `chat.files` 末条）：`f539184b`（B11 第一步）把骨架静态
  //     文案（title / aria-label / placeholder / 按钮文本 / 下拉触发器名）全量迁 `l10n.t`，
  //     并删掉空状态「标题 + 提示」两处默认值（运行期由 `emptyStateView.updateRole` 同步填充），
  //     原先阻塞登记的 7 处中文已清零 ⇒ 登记即真绿。**勿再按「暂不登记 / 登记 = 假绿」理解本文件。**
  chat: {
    state: 'migrated',
    files: [
      'webview/scripts/statusBarsView.ts',
      'webview/scripts/activityDrawerView.ts',
      'extension/host/tracer.ts',
      'webview/helpers/processEventText.ts',
      'webview/helpers/toolNameMap.ts',
      'webview/helpers/processFlowModel.ts',
      'webview/helpers/statusAttrs.ts',
      'webview/styles/chatStyles.ts',
      'webview/scripts/processFlowCells.ts',
      'webview/scripts/toolRowView.ts',
      'webview/scripts/qaRowView.ts',
      'webview/scripts/pendingWaitView.ts',
      'webview/scripts/roleBadgeView.ts',
      'webview/helpers/traitLabels.ts',
      'webview/helpers/fmtTime.ts',
      'webview/scripts/askInlineView.ts',
      'webview/scripts/writeConfirmCardView.ts',
      'webview/scripts/chatView.ts',
      'webview/panels/chatNoticeOps.ts',
      'webview/panels/chatRefOps.ts',
      'webview/panels/chatTurnStructureOps.ts',
      'webview/panels/chatSessionNavOps.ts',
      'webview/panels/chatMemoryOps.ts',
      'webview/panels/chatRunControlOps.ts',
      'webview/helpers/refChips.ts',
      'webview/helpers/docContext.ts',
      'webview/helpers/turnUiState.ts',
      'webview/helpers/sessionHistoryActions.ts',
      'webview/scripts/emptyStateView.ts',
      'webview/scripts/historyMenuView.ts',
      'webview/scripts/contextOccupancyView.ts',
      'webview/helpers/imageCapture.ts',
      'shared/errorText.ts',
      'shared/injectionSourceMeta.ts',
      'webview/panels/chatPanel.ts',
      // B10-D：B9 漏登记的 chat 盲区（计划栏 / 记忆命中块 / 轮级动作真源 / 右键菜单表）
      'webview/scripts/planBarView.ts',
      'webview/scripts/memoryHitsBlock.ts',
      'webview/components/roundActions.ts',
      'webview/components/contextMenuItems.ts',
      // B10-F 第一刀：展示面纯文案（零协议载荷）——代码块复制 / 附件降级语 / 草稿标题 /
      // 底栏整链复制 / 引用胶囊 / 用户气泡折叠 / 大纲导航 / 下拉触发器可达名
      'webview/scripts/codeBlockView.ts',
      'webview/helpers/attachmentStrip.ts',
      'webview/helpers/draftSession.ts',
      'webview/scripts/roundFooterView.ts',
      'webview/helpers/quoteDraft.ts',
      'webview/helpers/userBubble.ts',
      'webview/helpers/roundNav.ts',
      'webview/components/dropdown.ts',
      // 下拉渲染域（B11 第三刀）：唯一 CJK 是 aria-label 里的全角冒号分隔符，改 ASCII 冒号
      // 归零——分隔符不是文案，不为一个标点新增 l10n 键（第二套真源）。
      'webview/scripts/pickerView.ts',
      // chat 面板 HTML 骨架（B11 第一步收口）：可见文案（title / aria-label / placeholder /
      // 按钮文本 / 下拉触发器名）全部改走 `vscode.l10n.t`；空状态「标题 + 提示」两处**删默认值**
      // 而非翻译——运行期由 emptyStateView.updateRole 同步填充，留默认值等于第二套语言真源。
      'webview/panels/chatPanelHtml.ts',
    ],
  },
  // 记忆页（B2）：骨架 / 运行时脚本 / 样式全部迁完，判据⑰ 生效。
  // `shared/settingsTabs.ts` 一并登记：它是页签可见名的唯一真源，虽服务全部面板，但
  // B2 起值已全部是英文源键——任何一处回退成中文都会让所有页签在英文界面下露中文，
  // 没有理由等最后一页才守。
  memory: {
    state: 'migrated',
    files: [
      'shared/settingsTabs.ts',
      'webview/panels/settingsMemoryHtml.ts',
      'webview/scripts/memoryView.ts',
      'webview/scripts/pager.ts',
      'webview/styles/memoryStyles.ts',
    ],
  },
  // 角色页（B3）：骨架 / 运行时脚本 / 卡片动作 / 能力标签 / 策略键面 / 组队文案全部迁完。
  // `roleBadgeView.ts` 与 `sessionRolePack.ts` 虽服务于对话侧徽章，但文案归属角色域
  // （角色名回落 / 能力三态），一并登记——否则它们只有 chat 面板迁移时才第一次进守卫。
  roles: {
    state: 'migrated',
    files: [
      'shared/settingsTabs.ts',
      'webview/panels/settingsRolesHtml.ts',
      'webview/scripts/rolesView.ts',
      'webview/scripts/rolesTeamModal.ts',
      'webview/scripts/roleBadgeView.ts',
      'webview/helpers/rolePackListView.ts',
      'webview/helpers/roleCardActions.ts',
      'webview/helpers/rolePackSelectionActions.ts',
      'webview/helpers/assetPromoteButton.ts',
      'webview/helpers/strategyKeyMeta.ts',
      'webview/helpers/capabilityLabels.ts',
      'webview/helpers/capabilityChips.ts',
      'webview/styles/rolesStyles.ts',
      'extension/host/rolePackTeams.ts',
      'extension/host/sessionRolePack.ts',
    ],
  },
  // 配置页（B4）：骨架 / 运行时脚本 / 样式 + 配置域宿主执行面（Provider 存储 + 密钥通道）全部迁完。
  // `secretsAccess.ts` 与 `settingsWrite.ts` 是写入通道的失败文案单点（`{0}` 占位已全部英文化），
  // 登记在此是因为本批次已把它们的模板与配置域 label 一起改齐——其余域的 label 随各自批次走。
  config: {
    state: 'migrated',
    files: [
      'shared/settingsTabs.ts',
      'webview/panels/settingsConfigHtml.ts',
      'webview/scripts/configView.ts',
      'webview/styles/configStyles.ts',
      'extension/providers/providerStore.ts',
      'extension/host/secretsAccess.ts',
      'extension/settingsWrite.ts',
    ],
  },
  // 技能页（B5）：骨架 / 运行时（已按 tab 外置 skillsView.ts）/ 选择器 / 技能资产校验与命名判据全部迁完。
  // `settingsPanel.ts` **不登记**：技能域消息虽已英文化，但该文件仍混着对话与其他页签文案，
  // 登记会连带判别的页（登记口径是文件，不是「页面」——见文件头注册制盲区）。
  // `settingsView.ts`（容器）已于 B7 随安全页外置后登记在 security 名下。
  skills: {
    state: 'migrated',
    files: [
      'shared/settingsTabs.ts',
      'webview/panels/settingsSkillsHtml.ts',
      'webview/scripts/skillsView.ts',
      'webview/scripts/skillPickerView.ts',
      'webview/styles/skillsStyles.ts',
      'extension/host/userAssets/path.ts',
      'extension/host/userAssets/validateSkill.ts',
      'extension/commands/reloadSkills.ts',
      // B10-C：设置页「添加到用户级」与两个「刷新」按钮的执行面——**技能页与角色包页共用**
      // （⑰ 按文件判、不按页判，故只登记在本页即可覆盖两处的 CJK 判据：notice 文案若回归中文会红）
      'webview/panels/assetCopyToUser.ts',
      'webview/panels/userAssetRefresh.ts',
    ],
  },
  // MCP 页（B6）：骨架 / 运行时脚本 / 样式 / 面板执行面（`mcpServerOps`）+ 连接层全域判据全部迁完。
  // `extension/host/mcp/*` 八件全登记：失败原因、预检原因、跳过原因、约束转述（模型可见）
  // 都是**同一条链上的可见文案**，只登记其中一半等于让另一半静默腐烂。
  mcp: {
    state: 'migrated',
    files: [
      'shared/settingsTabs.ts',
      'webview/panels/settingsMcpHtml.ts',
      'webview/scripts/mcpView.ts',
      'webview/styles/mcpStyles.ts',
      'webview/panels/mcpServerOps.ts',
      'extension/host/mcp/toolRegistry.ts',
      'extension/host/mcp/connectionManager.ts',
      'extension/host/mcp/mcpConfigGuard.ts',
      'extension/host/mcp/runtime.ts',
      'extension/host/mcp/commandProbe.ts',
      'extension/host/mcp/failureLedger.ts',
      'extension/host/mcp/statusView.ts',
      'extension/host/mcp/resultNormalizer.ts',
    ],
  },
  // 安全页（B7）：骨架 / 运行时（已按 tab 外置 securityView.ts）/ 面板执行面（securityServerOps）
  // + 「恢复初始状态」链路（宿主清理与命令层）全部迁完。
  // `settingsView.ts` 于本批登记：容器此前残留安全页中文（L456 注释承诺「待 B7 外置后另行登记」），
  // 外置后它只剩挂载表 / 切换 / ready 握手，零可见文案——登记它等于让容器保持干净。
  // `settingsStyles.ts` 是共享壳样式（含安全页 CSS），当前零 CJK `content` 串；登记在此是为了
  // 让安全页的可见文案成网（后续任何页往壳里加中文文案都会在此处红，红里能看出真因是「壳」）。
  // `settingsPanel.ts` 仍不登记（同一文件混着对话与其他页签文案，登记会连带误判别的页）。
  security: {
    state: 'migrated',
    files: [
      'shared/settingsTabs.ts',
      'webview/panels/settingsSecurityHtml.ts',
      'webview/scripts/settingsView.ts',
      'webview/scripts/securityView.ts',
      'webview/styles/settingsStyles.ts',
      'webview/panels/securityServerOps.ts',
      'webview/helpers/settingsStatusPush.ts',
      'extension/host/userDataReset.ts',
      'extension/commands/userDataReset.ts',
    ],
  },
  // 作品页是首个范式样板：文件清单与文案真源均已迁移（判据⑰ 生效）。
  works: {
    state: 'migrated',
    files: [
      'extension/host/workProjectionRows.ts',
      'webview/panels/settingsWorksHtml.ts',
      'webview/scripts/worksView.ts',
      'webview/styles/worksStyles.ts',
    ],
  },
};

/**
 * 跨页签域共享文件 —— 判据⑰ 的**第二登记面**（与页签登记平级，2026-11-10 立）
 *
 * 为什么不放进 `WEBVIEW_PANELS` 当第八个键：
 * - ⑱ 把 `Object.keys(WEBVIEW_PANELS)` 直接当 panel id 集合 ⇒ 多一个键即被判
 *   「不在设置页签 + chat 集合内」，除非再为它开一个 ⑱ 例外（等于给判据开后门）；
 * - 更要紧的是**语义**：一个文件的迁移状态是**一个事实**。挂到某个具体页签名下 = 同一事实
 *   在两处表达——将来删掉那一页、或把那一页 state 退回 `pending`，这个文件的判据会跟着
 *   那一页一起消失。而共享文件的干净与否**与页签存亡无关**（谁消费它都可能变）。
 *
 * 判据：**非日志 CJK 字面量 = 0**（`collectPanelFileCjk` 同一口径），**无 state 开关**——
 * 登记即判，没有「先登记后收口」的中间态（共享文件登记前须先清零，见下）。
 *
 * 登记条件（两条都满足才放这里）：① 文件被多个页签域消费；② 清零后**无单一页签可归属**。
 * 只服务单页的文件仍登记在 `WEBVIEW_PANELS` 的对应面板下——事实一处表达，不许两边都列。
 */
const SHARED_CJK_FILES = [
  // 七页签的宿主分支集中地：大模型页回执（`setBackgroundProvider` 三条）+ MCP 页装配回执
  // （`mcpOpsDeps` 的 `connect` / `restart`）。2026-11-10（B10-E 组3）清零后登记，
  // 是该文件唯一一道「再塞中文会红」的网。
  'webview/panels/settingsPanel.ts',
  // 两个 webview 入口（chatViewMain / settingsViewMain）各装配一次的全局错误边界：
  // 文案（卡片标题 + 自救指引）不归任何页签域。2026-11-10（B10-F 第一刀）清零后登记。
  'webview/helpers/errorBoundary.ts',
  // 设置面板 HTML 骨架（七页签共用的外壳）：body 由各页签的 `buildXxxBodyHtml(vscode.l10n)`
  // 填充，骨架自身只剩 title / 容器，无单一页签归属。2026-11-10（B11 第一步）核实零可见 CJK
  // 后登记——它此前一直不在任何登记面内，属「骨架天然无判据」的盲区。
  'webview/panels/settingsPanelHtml.ts',
];

/**
 * 第三登记面 `DEFERRED_CJK_FILES`：已判定「**不翻**」的含 CJK 文件（2026-11-10 立）
 *
 * 与另两面的分工：`WEBVIEW_PANELS` / `SHARED_CJK_FILES` 是「已清零，再塞中文即红」；
 * 本面是「中文是**正确形态**，翻了才是错」——两者都是「已判定」，只是后者没有清零动作。
 *
 * 为什么必须落成登记而不能只写进台账：`--report` 的「未登记含 CJK」清单是「下一批翻
 * 哪些」的唯一坐标；把这些文件留在里面，下一批就会拿「还是中文」当漏项再判一遍
 * （B10-F 第一刀末已实际付出过一次判断成本）。**判定结论要可执行，否则等于没判。**
 *
 * 🔴 准入判据（三条全满足才可入表；缺一条 ⇒ 该翻，只是排在后面）：
 *   ① `kind` **只能取枚举值**（`DEFERRED_KINDS`：双面串 / 纯模型面 / 纯诊断 / 本地化注入面），
 *      不许自由文本。理由：这个字段的唯一用途是「按读者面聚合核对」，自由文本既不能聚合、
 *      也无法机检——写成「混合（模型指令 + 双面串）」等于把两件事塞进一个格子（措辞折叠同族）。
 *      一个文件里两种读者都有的，取**更严的那一种**，另一条在 `reason` 里点名。
 *   ② `reason` 必须回答「**翻了会坏在哪**」，不是「为什么不需要翻」。前者可证伪（能指着某条
 *      链路说「这里会随 locale 漂移」），后者是偏好（「界面上看不到」这种话翻不翻都成立）。
 *      机检形态：`reason` 须写成「翻了会…」/「翻成…会…」句式（≥20 字）；**它只能证明作者写了
 *      后果句，证明不了后果为真**，语义仍归 code review——这条判据是「提醒写后果」的闸，
 *      不是「后果成立」的闸。
 *   ③ **禁止「暂时 / 待定 / 后续再看」类延后语**。延后可以，但不能挂在本表里冒充「已判定」：
 *      一旦允许，这张表就从「结论清单」退化成「拖延清单」，下一个读者无法区分
 *      「想清楚了不翻」与「还没想」。
 *
 * 判据实现 = `auditDeferredEntries()`（下方纯函数），self-test 用**伪造条目**做变异
 * ——不靠「改真实常量 → 跑 → 撤销」的一次性手法，否则下次没人复跑，判据静默失明。
 */
const DEFERRED_CJK_FILES = [
  {
    file: 'extension/host/codeExecutor.ts',
    kind: '双面串',
    // stderr 文本同时是 run_code 的工具结果与用户在对话里看到的失败原因
    reason:
      '翻了会让工具结果随 locale 变（同一句失败原因在 zh 用户处中文、en 用户处英文），' +
      '模型输入不可复现、跨会话比对失真。三条都是 run_code 的工具结果（不支持的语言 / ' +
      '执行失败 / 进程树终止未确认）；中文外壳归渲染层。',
  },
  {
    file: 'extension/host/gitExec.ts',
    kind: '双面串',
    reason:
      '翻了会让 git 回执随 locale 变：同一协议在不同语言用户下产出不同文本，模型侧判断与' +
      '测试断言都要跟着漂。三条是拒绝非只读命令 / 输出超上限 / 命令超时。',
  },
  {
    file: 'extension/host/agentRegistry.ts',
    kind: '纯诊断',
    reason:
      '翻了会让「为什么被拒」这一事实出现两种文本：拒绝原因随语言变、工具结果不变，' +
      '诊断链里对不上。三条是登记 / 装配 / 在途装配关闭，经抛错进诊断链，界面上不出现。',
  },
  {
    file: 'extension/host/assemble.ts',
    kind: '本地化注入面',
    reason:
      '翻了会造出第三套语言真源：`CHINESE_MESSAGES` 本就是 `pickUiMessages` 按 ' +
      '`vscode.env.language` 选的中文覆盖表（zh 注入中文、其余走内核英文默认），且这些文案进' +
      '模型上下文与落盘，必须与 locale 同源、不能在渲染前求值。',
  },
  {
    file: 'extension/host/askCoordinator.ts',
    kind: '双面串', // 两条里一条纯模型、一条双面，取更严的双面串（见 reason）
    reason:
      '翻了会让模型输入不可复现：`ASK_TIMEOUT_NOTICE` 是给模型的代选指令（纯模型面），' +
      '`abandonOnStop` 的停止通知是模型与用户同看的回执（双面串）；本表 kind 取更强的双面串。',
  },
  // ---- B11 第四刀（2026-11-10）：宿主采集器 / 命令面的模型载荷与诊断口 ----
  {
    file: 'extension/host/gitCollector.ts',
    kind: '纯模型面',
    reason:
      '翻了会让注入给模型的 git 改动正文随界面语言变：同一份改动在不同语言用户下产出不同事实行、' +
      '截断注记与清单措辞，模型输入不可复现；且这些正文是给模型的读文件指令（路径可直接用于 ' +
      'read_file），不是上屏文案。',
  },
  {
    file: 'extension/host/problemsCollector.ts',
    kind: '纯模型面',
    reason:
      '翻了会让 @problems 注入正文随界面语言变：严重度标签、条数与截断注记都进模型上下文，' +
      '同一诊断集在两种语言下产出不同文本；正文里的「源码行」提示语是模型操作指令，' +
      '翻它会让指令与事实混排。',
  },
  {
    file: 'extension/host/injectionBodies.ts',
    kind: '纯模型面',
    reason:
      '翻了会让两条采集失败事实行随界面语言变：它们是发送时刻补进模型上下文的兜底正文' +
      '（诊断采集失败 / git 采集失败），翻成界面语言会让模型收到的失败原因在两种语言下不可比对，' +
      '而上屏只剩 chip 标签。',
  },
  {
    file: 'extension/host/activeFileTracker.ts',
    kind: '纯模型面',
    reason:
      '翻了会让活动文件信封头与截断标记随界面语言变：`文件名：{name}` 是注入信封的格式契约' +
      '（文件内注释明写勿改格式），翻它等于改模型侧解析约定，同一文件在两种语言用户下注入形态不一致。',
  },
  {
    file: 'extension/host/skillAggregation.ts',
    kind: '纯模型面',
    reason:
      '翻了会让 `【当前技能】` 技能块头随界面语言变：该块由 composer 选中技能后直接拼进模型上下文，' +
      '翻它会让技能注入的格式标记随语言漂移，模型侧对同一技能块的识别不稳定。',
  },
  {
    file: 'extension/host/responseLanguage.ts',
    kind: '本地化注入面',
    reason:
      '翻了会造出第三套语言真源：`DIRECTIVE_BY_LOCALE` 本就是按 `vscode.env.language` 选出的回答' +
      '语言指令（zh 用中文、其余走英文），再套 l10n 会让指令语言受界面 bundle 二次裁决，回答语言反而失真。',
  },
  {
    file: 'extension/host/fileChangeView.ts',
    kind: '纯诊断',
    reason:
      '翻了会让 `[fileChange] … 已忽略` 这类排障日志随界面语言变：本文件用户可见文案（含失败清单的' +
      '`{0}（{1}）` 括号形态）已全量走 `vscode.l10n.t`，剩下的中文只在 `deps.log` 诊断行里' +
      '（采集器按间接日志口径计入），翻它会让排障 grep 在两种语言下对不上。',
  },
  {
    file: 'extension/host/sessionStore.ts',
    kind: '纯诊断',
    reason:
      '翻了会让跨进程写锁断言的抛错文案随界面语言变：这条 Error 只进诊断链与日志' +
      '（「会话文件写入缺少跨进程锁」），界面不呈现，翻它会让排障时同一句断言在两种语言下无法按串检索。',
  },
  {
    file: 'extension/host/workspaceStorage.ts',
    kind: '纯诊断',
    reason:
      '翻了会让人工 source 校验的抛错随界面语言变：这条 Error 只进诊断链与日志（带内核 warning），' +
      '不直接上屏，翻它会让排障串检索在英文界面下失效，而上屏回执由调用方另行本地化。',
  },
  {
    file: 'shared/imageTokenBudget.ts',
    kind: '纯诊断',
    reason:
      '翻了会让这条与内核 `checkImageTokenBudget` 同式的镜像判据文案分叉：本函数当前零生产消费者' +
      '（只有测试驱动），message 从不上屏，翻它只增键面噪音而没有用户收益。',
  },
  {
    file: 'extension/host/userAssets/projectScope.ts',
    kind: '纯诊断',
    reason:
      '翻了会让「信任工作区后补注入」的收尾流水随界面语言变：这三处只经 `deps.report` 写进 ' +
      'Output Channel（extension.ts 接的是 `memoraOutput.appendLine`），界面不弹窗，' +
      '翻它会让排障 grep 在两种语言下对不上。',
  },
  {
    file: 'extension/commands/registerWork.ts',
    kind: '本地化注入面',
    reason:
      '翻了会让作品描述的语言随界面语言漂移：读文件后的「仅前 N 字符」注记、描述生成提示词与' +
      '「只输出一句中文描述」的系统提示共同决定落库描述文本，描述是项目数据，应随内容语言而非界面语言。',
  },
  {
    file: 'extension/commands/demo.ts',
    kind: '纯诊断',
    reason:
      '翻了会让演示提示词与 Output Channel 输出随界面语言变：演示要展示的是同一套固定中文范式' +
      '（写入演示区的摘要与总结语言都是中文），翻它会让演示产出随语言漂移、结果不再可比；' +
      '该面按方案 §11.3 判为非 UI 面。',
  },
];

/**
 * 第三登记面的 `kind` 枚举（与常量上方准入判据 ① 同源，改一处必须同步另一处）
 *
 * 四类按**读者面**分，不按文件位置分：同一目录下两个文件可能一个双面、一个纯诊断。
 */
const DEFERRED_KINDS = ['双面串', '纯模型面', '纯诊断', '本地化注入面'];

/** 延后语黑名单（准入判据 ③；命中即「冒充已判定」） */
const DEFERRED_DEFERRAL_WORDS = [
  '暂时',
  '待定',
  '后续再看',
  '以后再',
  '以后再说',
  '待评估',
  '待补',
];

/**
 * 审 `DEFERRED_CJK_FILES` 的三道准入（准入判据的可执行形态）
 *
 * 为什么独立成纯函数：self-test 要能**注入伪造条目**证明判据会红。若判据直接写在真实常量上，
 * 只能靠「改常量 → 跑 → 撤销」的一次性手法，下次没人复跑 ⇒ 判据随时间失明（同 §5.2 僵尸豁免）。
 *
 * @param {Array<{file: string, kind: string, reason: string}>} entries 待审登记项
 * @returns {string[]} 违规说明（空数组 = 全过）
 */
function auditDeferredEntries(entries) {
  const issues = [];
  for (const d of entries) {
    // ① kind 必须是枚举值；非枚举项不再往下判（否则一次变异报三条噪音，读不出根因）
    if (!DEFERRED_KINDS.includes(d.kind)) {
      issues.push(`${d.file}：kind 非枚举（${d.kind ?? '缺'}）`);
      continue;
    }
    if (!d.reason || d.reason.length < 20) {
      issues.push(`${d.file}：reason 缺失或过短（未写判据）`);
    } else if (DEFERRED_DEFERRAL_WORDS.some((w) => d.reason.includes(w))) {
      issues.push(`${d.file}：reason 是延后语（不算已判定）`);
    } else if (!/翻[了成][^。；]{0,12}会/.test(d.reason)) {
      // ② 形态判据：「翻了会…」/「翻成…会…」句式；只写「不需要翻译」不算后果句
      issues.push(`${d.file}：reason 没写后果句（须回答「翻了会坏在哪」）`);
    }
  }
  return issues;
}

/**
 * 逐字符扫描源码，产出字符串字面量清单（单 / 双引号串 + 模板串的静态片段）
 *
 * 为什么手写扫描而非正则先剥注释：`//` 会出现在字符串里（URL / 路径），按行剥注释会误伤；
 * 逐字符走一遍能同时拿到「字面量边界」与「是否在注释里」两个事实，且不引入 AST 依赖。
 *
 * 🔴 模板串口径（B11 第一步定 · 可检验）：一个模板串按 `${…}` 切成若干**静态片段**，逐段产出记录。
 *   · **静态片段算文案**——插值之前之后的文字都算（`` `${head}<b>删除</b>` `` 的「删除」在插值后，照样是文案）；
 *   · **只有插值、没有静态文字**的模板（`` `${a}${b}` ``）不产出记录 ⇒ 不误红；
 *   · `${…}` 内部按**代码**处理：其中的注释不是文案，其中的嵌套字符串 / 模板串照常产出记录。
 * 旧实现把嵌套模板的反引号当成外层闭合符 ⇒ 外层剩余部分被并成一段（`${}` 里的注释混入文案、
 * 后续 HTML 的中文被 40 字符截断掩盖）。本版用「代码 / 模板片段双模式 + 花括号深度」修掉，
 * 变异见 self-test「模板串静态片段」与负向「纯插值模板不判」。
 *
 * 已知未覆盖形态（不假装支持，见文件头「采集面已知形态清单」）：正则字面量里的引号会扰乱边界判断；
 * `'a' + b` 这类拼接的跨段文案无法还原成语义单元（但每段本身仍被采集）。
 *
 * @param {string} text 源码全文
 * @returns {{start:number, value:string, quote:string, anchor:number}[]} 字面量清单（value 已还原转义）
 */
function scanStringLiterals(text) {
  const out = [];
  const n = text.length;

  /**
   * 记录一条字面量；空片段不记（纯插值模板就是零片段）。
   *
   * `anchor` = 该字面量所属**表达式**的起点（引号串 = 引号本身；模板片段 = 模板的起始反引号）。
   * 为什么片段需要 anchor：日志白名单要拿「字面量之前的文本」判是不是 `logger.x(` 的实参，
   * 而模板的第 2 个片段之前横着 `${…}` ——里面 `String(err)` 这类调用的括号会让
   * `[^()]*$` 失配 ⇒ 纯开发者日志误红（本仓实证：`logger?.warn(\`…${String(err)}…\`)`）。
   */
  function push(start, raw, quote, anchor) {
    if (raw.length === 0) return;
    out.push({ start, value: unescapeSourceLiteral(raw), quote, anchor: anchor ?? start });
  }

  /** 扫一段带引号的字符串（不含反引号）；未闭合时止于行尾，防止一处笔误吞整份文件 */
  function scanQuoted(from, quote) {
    let i = from + 1;
    let raw = '';
    while (i < n) {
      if (text[i] === '\\') {
        raw += text[i] + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (text[i] === quote) {
        i++;
        break;
      }
      if (text[i] === '\n') break;
      raw += text[i];
      i++;
    }
    push(from, raw, quote);
    return i;
  }

  /** 扫一个模板串：静态片段逐段产出，`${…}` 交给 scanCode（按代码扫） */
  function scanTemplate(from) {
    let i = from + 1;
    let fragStart = i;
    let raw = '';
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') {
        raw += ch + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === '`') {
        push(fragStart, raw, '`', from);
        return i + 1;
      }
      if (ch === '$' && text[i + 1] === '{') {
        // 插值前的静态前缀到此为止；插值内部是代码，不是文案
        push(fragStart, raw, '`', from);
        raw = '';
        i = scanCode(i + 2, true);
        fragStart = i;
        continue;
      }
      raw += ch;
      i++;
    }
    push(fragStart, raw, '`', from);
    return i;
  }

  /**
   * 扫一段代码；`inInterpolation` 为真时在**配平的** `}` 处收手（返回其后的位置）。
   * 花括号深度必须记账：`${{ a: `x` }}` 这类插值里的对象字面量 / 函数体不能提前收手。
   */
  function scanCode(from, inInterpolation) {
    let i = from;
    let depth = 0;
    while (i < n) {
      const ch = text[i];
      // 行注释：跳到行尾（插值内的注释也按注释处理，不计入文案）
      if (ch === '/' && text[i + 1] === '/') {
        const end = text.indexOf('\n', i);
        i = end < 0 ? n : end + 1;
        continue;
      }
      // 块注释：跳到闭合标记
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (ch === '{') {
        depth++;
        i++;
        continue;
      }
      if (ch === '}') {
        if (inInterpolation && depth === 0) return i + 1;
        if (depth > 0) depth--;
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        i = scanQuoted(i, ch);
        continue;
      }
      if (ch === '`') {
        i = scanTemplate(i);
        continue;
      }
      i++;
    }
    return i;
  }

  scanCode(0, false);
  return out;
}

/**
 * 日志白名单：字面量是否为 `console.*` / `logger.*` 的**直接实参**（启发式，见注册表盲区 3；只放内部事实，不放模型可见 / 双面，见盲区 4）
 *
 * `?.` 可选链必须同样放行：`this.logger?.warn('…')` 与原形是同一个调用面，漏认会把
 * 纯开发者日志误判成用户可见文案（误红），逼着把日志翻译成键——那是为过闸造噪音。
 */
function isLogArgument(textBefore) {
  return /(?:^|[^\w$])(?:console|logger)\s*(?:\?\.|\.)\s*\w+\s*\([^()]*$/.test(textBefore);
}

/**
 * 采集一个 TS/JS 文件里的「可见 CJK 字面量」（判据⑰ 的判定单元）
 *
 * 口径：注释跳过、字符串里的 HTML 注释跳过、日志实参跳过；其余含 CJK 的字符串 / 模板串逐条计入。
 * 这是**文案面**判据，不是「文件里没有中文」判据——注释里的中文完全合法。
 *
 * @param {string} text 源码全文
 * @returns {string[]} 违规字面量（空白折叠 + 截断，仅用于报错展示）
 */
function collectVisibleCjkInText(text) {
  const hits = [];
  for (const lit of scanStringLiterals(text)) {
    const value = lit.value.replace(/<!--[\s\S]*?-->/g, '');
    if (!CJK.test(value)) continue;
    // 只看字面量前 200 字符：足够覆盖「console.log(a, '…')」这类调用前缀。
    // 取 `anchor`（模板片段取模板起点）而非 `start`——否则第 2 个片段前面横着 `${…}`，
    // 插值里的括号会让日志白名单失配（见 scanStringLiterals 的 push 注释）。
    if (isLogArgument(text.slice(Math.max(0, lit.anchor - 200), lit.anchor))) continue;
    hits.push(value.replace(/\s+/g, ' ').slice(0, 40));
  }
  return hits;
}

/**
 * 采集一个样式文件里的可见 CJK（判据⑰ 的 CSS 口径）
 *
 * CSS 里只有 `content:` 的字符串会显示到屏幕上；样式文件中的中文基本都在注释里，
 * 按字面量全扫会把注释误判成文案。故只认 `content: '…'` / `content: "…"`，注释不判。
 *
 * @param {string} text 样式源码全文（CSS 模板串）
 * @returns {string[]} 违规值
 */
function collectCssCjkContent(text) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = [];
  for (const re of [/content\s*:\s*'((?:[^'\\]|\\.)*)'/g, /content\s*:\s*"((?:[^"\\]|\\.)*)"/g]) {
    for (const m of css.matchAll(re)) {
      const value = unescapeSourceLiteral(m[1]);
      if (CJK.test(value)) hits.push(value.slice(0, 40));
    }
  }
  return hits;
}

/**
 * 判据⑰ 的**协议标记豁免**（B9-E 收口）：不翻译 ≠ 漏译
 *
 * 有一类中文字面量**不是 UI 文案**：它们是与内核 / 持久化数据 / 剥离契约对齐的**协议标记**
 * （信封块头、用户请求分隔符、角色包 manifest 身份串）。翻译它们 = 破坏跨端契约；
 * 源码里用 Unicode 转义只能消掉「肉眼可见的中文」，采集器 unescape 后仍会判红。
 *
 * **为什么按「文件 + 精确值」双键白名单**（而不是「含转义就放行」）：后者等于给所有中文
 * 开一道后门——任何漏译只要写成 `\uXXXX` 就能静默过关，判据形同虚设。
 *
 * 新增条目前先自问：**这个值被谁按字节读取？** 答不出「谁对齐谁」的，一律是漏译，不许进表。
 * 条目必须与真实字面量**逐字相同**（含前导换行等空白；匹配前按采集口径折叠空白 + 截断）。
 */
const PANEL_CJK_ALLOWLIST = {
  // 协议标记：信封块头 / 分隔符（内核同源写入模型上下文，剥离侧以闭标签为锚点）
  'webview/helpers/docContext.ts': [
    '[当前打磨文档内容]',
    '[/当前打磨文档内容]',
    '[参考文件/目录]',
    '[/参考文件/目录]',
    '【当前技能】',
    '\n\n用户请求：',
  ],
  // 注入源信封标记：持久化数据 + `stripInjectedContextPrefix` 以闭标签为锚点
  'shared/injectionSourceMeta.ts': [
    '[工作区诊断]',
    '[/工作区诊断]',
    '[git 未提交改动]',
    '[/git 未提交改动]',
  ],
  // 角色包 manifest 显示名（`ROLE_SUGGESTION_SETS` 的映射键 + 对比值）：随 manifest 字节对齐，
  // 翻译即失配、示例提问整组回落默认——不是 UI 文案
  'webview/scripts/emptyStateView.ts': ['白话方案设计师'],
};

/** 采集口径的归一化（与 collectVisibleCjkInText 的展示形态一致，白名单靠它对齐） */
function normalizeCjkHit(value) {
  return value.replace(/\s+/g, ' ').slice(0, 40);
}

/** 按文件类型分派可见 CJK 采集（`styles/` 走 CSS 口径，其余走 TS 口径） */
function collectPanelFileCjk(rel, text) {
  const hits = /(^|\/)styles\//.test(rel)
    ? collectCssCjkContent(text)
    : collectVisibleCjkInText(text);
  const allow = PANEL_CJK_ALLOWLIST[rel];
  if (!allow) return hits;
  const allowed = new Set(allow.map(normalizeCjkHit));
  return hits.filter((h) => !allowed.has(h));
}

/**
 * 从 `shared/settingsTabs.ts` 文本抽 `SETTINGS_TABS`（判据⑱ 的对拍真源）
 *
 * @param {string} text 文件全文
 * @returns {string[]|null} 页签 id 列表；抽不到返回 null（判据必须红，不许静默放行）
 */
function collectSettingsTabIdsInText(text) {
  const m = /export\s+const\s+SETTINGS_TABS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/.exec(text);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/**
 * 已迁移窗口面模块清单（判据⑬ 的扫描面）
 *
 * 为什么按文件登记，而不是扫全 `src`：未迁移的文件（webview 面板、尚未排期的命令）本来就有
 * 中文裸串，全扫会让判据长期红——长期红等于红灯免疫，比盲区更坏。登记制的代价是
 * 「新文件默认不在网内」，故配套两条机检：⑭ 登记项逐条必须真实存在，且条数不得低于基线
 * （防清单被悄悄清空后「全绿」）。
 *
 * 登记语义 = 「本文件的窗口面可见文案已全量 l10n 化」；往登记文件里塞中文裸串即红。
 */
const MIGRATED_UI_MODULES = [
  'extension/commands/importAsset.ts',
  'extension/commands/registerWork.ts',
  'extension/commands/residentRules.ts',
  'extension/host/fileChangeView.ts',
  'extension/host/workProjectionBridge.ts',
  'extension/host/windowNotices.ts',
  // B10（2026-11-10）：资产导入链路 + 诊断摘要——`reason` / 摘要标签全部改 `l10n.t`
  // （前者经 `Import failed: {0}` 上屏，后者进剪贴板摘要），登记后由判据⑬ 守回归
  'extension/host/userAssets/zipImport.ts',
  'extension/host/userAssets/zipReader.ts',
  'webview/panels/hostDiagnostics.ts',
  // B10-E（2026-11-10）：宿主「文件改动悬停 / 记忆库错误 / 确认决策回执」三条文案面
  // ——分别经 `vscode.l10n.t` 与注入翻译器出键，登记后由判据⑬ 守回归。
  // `extension/host/imageIngest.ts` / `shared/imageValidation.ts` **刻意不登记**：
  // 二者是零 vscode 依赖模块，只产出「英文源键 + 实参」（不直接调窗口 API），
  // 键面由 `@nls-keys`（判据⑮）覆盖——登记进本清单不增加任何判据覆盖。
  'extension/host/fileChangeRenderer.ts',
  'extension/host/memoryStorage.ts',
  'extension/host/confirmCoordinator.ts',
  // B10-E 组2（2026-11-10）：`extension.ts` 的状态栏未信任提示外置为
  // `host/windowNotices.createTrustNotice`（文案与显隐同处，避开 max-lines 顶格），
  // 两处 `throw / Promise.reject` 文案改键，4 个热更失败标签随日志模板改英文。
  // ⚠️ 覆盖边界：判据⑬ 只认 `WINDOW_LITERAL_ANCHORS` 列出的写法（`.text/.tooltip=`、
  // `show*Message`、QuickPick 属性等）；`throw new Error('…')` **不在锚点表内**——
  // 本文件那两处是本次人工清的，不靠判据守（见文件头「采集面已知形态」）。
  'extension/extension.ts',
];

/** 判据⑭ 基线：登记项少于该数 ⇒ 红（清单被清空 = 判据静默失明） */
const MIN_MIGRATED_UI_MODULES = 5;

/** 判据⑮ 基线：动态键源标记 `@nls-keys` 少于此数 ⇒ 红（键面整段脱管） */
const MIN_DYNAMIC_KEY_SOURCES = 1;

/**
 * 按登记清单解析绝对路径并标记缺失项（判据⑭ 的一半：清单里写错路径 = 该文件永不被扫）
 */
function resolveMigratedUiFiles() {
  const missing = [];
  const files = [];
  for (const rel of MIGRATED_UI_MODULES) {
    const abs = join(HOST_ROOT, 'src', rel);
    try {
      statSync(abs);
      files.push(abs);
    } catch {
      missing.push(`判据⑭ 登记项不存在：src/${rel}（路径写错 = 该文件永不被扫）`);
    }
  }
  return { files, missing };
}

/**
 * 判据⑯ 采集（文本级，供自检对合成源码断言）：`@vscode/l10n` 的 import 形态
 *
 * 键面三面对账（⑧⑨⑩）的输入 = 源码里字面 `l10n.t(` 调用。写成
 * `import { t } from '@vscode/l10n'` 再 `t('…')` 时，翻译照常生效但调用点
 * 脱离采集面 ⇒ 缺译文不再红。namespace 导入是唯一让调用点保持 `l10n.t(` 可见的
 * 写法，故其余值导入形态一律判红；`import type` 无运行时调用，放行。
 *
 * @param {string} text 源文件全文
 * @param {string} name 展示名（相对路径）
 * @returns {string[]} 违规清单（空 = 绿）
 */
export function collectL10nImportIssuesInText(text, name) {
  const issues = [];
  const codeText = stripCommentLines(text); // 注释里的 import 样例不是 import（同⑨⑫口径）
  for (const m of codeText.matchAll(/import\s+([^;]*?)\s+from\s+['"]@vscode\/l10n['"]/g)) {
    const spec = m[1].trim();
    if (spec === '* as l10n' || spec.startsWith('type ')) continue;
    issues.push(
      `判据⑯ @vscode/l10n 非 namespace 导入：${name}（import ${spec} from '@vscode/l10n'）——裸调用 t() 脱离键面采集 = 判据⑨失明`,
    );
  }
  return issues;
}

/**
 * bundle 判据本体（纯函数，便于自检注入）
 *
 * @param {object} input
 * @param {object} input.bundleEn  bundle.l10n.json（默认语言 = 键面真源，值为空串是设计形态）
 * @param {object} input.bundleZh  bundle.l10n.zh-cn.json
 * @param {Set<string>} input.staticKeys  源码静态 `l10n.t('Key')` 键集合
 * @param {Set<string>} input.dynamicKeys REJECT_MESSAGES 值集合（动态 t 键源）
 * @param {string[]} input.templateViolations 模板串第一参的文件清单
 * @param {string[]} input.windowViolations 窗口 API 中文字面量违规清单
 * @param {string[]} input.registryIssues 判据⑭ 登记清单问题（路径不存在 / 条数低于基线）
 * @param {number} [input.dynamicKeyMarkers] 判据⑮ 动态键源标记数（`@nls-keys`）
 * @param {string[]} [input.l10nImportIssues] 判据⑯ `@vscode/l10n` 非 namespace 导入清单
 * @param {string[]} [input.webviewViolations] 判据⑰ 已迁移面板的可见 CJK 残留清单
 * @param {string[]} [input.webviewRegistryIssues] 判据⑰ 面板登记项路径不存在清单
 * @param {string[]|null} [input.webviewPanelIds] `WEBVIEW_PANELS` 的 panel id 集合
 * @param {string[]|null} [input.settingsTabIds] 从 `shared/settingsTabs.ts` 抽出的页签 id（null = 抽取失败）
 */
export function auditBundle({
  bundleEn,
  bundleZh,
  staticKeys,
  dynamicKeys,
  templateViolations,
  windowViolations,
  registryIssues = [],
  dynamicKeyMarkers = MIN_DYNAMIC_KEY_SOURCES,
  l10nImportIssues = [],
  webviewViolations = [],
  webviewRegistryIssues = [],
  webviewPanelIds = null,
  settingsTabIds = null,
}) {
  const issues = [];
  const allKeys = new Set([...staticKeys, ...dynamicKeys]);

  // ⑧ bundle 键面相等
  for (const key of Object.keys(bundleEn)) {
    if (!Object.hasOwn(bundleZh, key))
      issues.push(`bundle 键面不等：仅在英文 bundle「${key.slice(0, 40)}」`);
  }
  for (const key of Object.keys(bundleZh)) {
    if (!Object.hasOwn(bundleEn, key))
      issues.push(`bundle 键面不等：仅在中文 bundle「${key.slice(0, 40)}」`);
  }

  // ⑨ 源码键全覆盖（缺 = 中文用户静默看到英文）
  for (const key of allKeys) {
    if (!Object.hasOwn(bundleEn, key)) issues.push(`bundle 缺键（英文）：${key.slice(0, 50)}`);
    if (!Object.hasOwn(bundleZh, key)) issues.push(`bundle 缺键（中文译文）：${key.slice(0, 50)}`);
  }

  // ⑩ bundle 无孤儿（改源码文案忘删译文）
  for (const key of Object.keys(bundleEn)) {
    if (!allKeys.has(key)) issues.push(`bundle 孤儿键（源码已无此键）：${key.slice(0, 50)}`);
  }

  // ⑪ zh-cn 译文非空
  for (const [key, value] of Object.entries(bundleZh)) {
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push(`bundle 中文译文为空：${key.slice(0, 50)}`);
    }
  }

  // ⑳ zh 译文一致性（键面相等⑧ / 非空⑪ 都挡不住的两类静默失效）
  //   a) 照抄英文源键 ⇒ 中文用户看到英文（键加了、译文忘了，⑧⑪ 全绿）
  //   b) 丢 {n} 占位符 ⇒ 运行时该位置为空，信息静默丢失（无异常、无日志）
  for (const [key, value] of Object.entries(bundleZh)) {
    if (typeof value !== 'string' || value.trim() === '') continue; // ⑪ 已报，不重复
    // 只抓「含英文单词的键被照抄」：纯占位符 / 纯标点键（如 `; `）与译文同形属正常
    if (!ZH_SAME_AS_KEY_ALLOWLIST.has(key) && /[A-Za-z]/.test(key) && value === key) {
      issues.push(`判据⑳ zh 译文照抄英文源键（漏译）：${key.slice(0, 50)}`);
    }
    const keyPh = placeholdersOf(key).join(',');
    const valPh = placeholdersOf(value).join(',');
    if (keyPh !== valPh) {
      issues.push(
        `判据⑳ zh 译文占位符与键不一致（键 [${keyPh || '无'}] / 译文 [${valPh || '无'}]）：${key.slice(0, 50)}`,
      );
    }
  }

  // ⑫ 模板串第一参违规
  for (const f of templateViolations) {
    issues.push(`l10n.t 第一参必须是静态字面量（模板串 ⇒ 键面守卫失明）：${f}`);
  }

  // ⑬ 窗口 API 中文残留
  for (const v of windowViolations) issues.push(`宿主窗口面中文残留（应走 l10n.t）：${v}`);

  // ⑭ 登记清单完整性（清单塌空 / 路径写错都会让 ⑬ 静默失明）
  for (const v of registryIssues) issues.push(v);
  if (MIGRATED_UI_MODULES.length < MIN_MIGRATED_UI_MODULES) {
    issues.push(
      `判据⑭ 已迁移模块登记 ${MIGRATED_UI_MODULES.length} < 基线 ${MIN_MIGRATED_UI_MODULES}（判据⑬ 扫描面塌空 = 静默失明）`,
    );
  }

  // ⑮ 动态键源登记（标记塌空 ⇒ 动态 t() 的键面整段脱管，⑨ 再也看不见那批键）
  if (dynamicKeyMarkers < MIN_DYNAMIC_KEY_SOURCES) {
    issues.push(
      `判据⑮ 动态键源标记 @nls-keys 命中 ${dynamicKeyMarkers} < 基线 ${MIN_DYNAMIC_KEY_SOURCES}（动态 t() 键面脱管）`,
    );
  }

  // ⑯ @vscode/l10n 导入形态（裸别名 = 键面采集脱管，⑨ 在该调用点永久失明）
  for (const v of l10nImportIssues) issues.push(v);

  // ⑰ 已迁移面板：可见 CJK 字面量必须为 0（采集范围 = WEBVIEW_PANELS 里 state:'migrated' 的文件）
  for (const v of webviewViolations) issues.push(`webview 面板中文残留（应走 l10n.t）：${v}`);
  // ⑰ 配套：登记项路径写错 = 该文件永不被扫（与⑭ 同一纪律，防止「登记了但扫不到」）
  for (const v of webviewRegistryIssues) issues.push(v);

  // ⑱ 面板清单对拍：WEBVIEW_PANELS 的 id 集合 == 设置页签集合 ∪ { chat }
  if (settingsTabIds === null) {
    issues.push('判据⑱ 无法从 shared/settingsTabs.ts 抽取 SETTINGS_TABS（对拍真源失效）');
  } else if (webviewPanelIds !== null) {
    const expected = new Set([...settingsTabIds, 'chat']);
    for (const id of webviewPanelIds) {
      if (!expected.has(id)) issues.push(`判据⑱ 面板「${id}」不在设置页签 + chat 集合内`);
    }
    for (const id of expected) {
      if (!webviewPanelIds.includes(id)) {
        issues.push(`判据⑱ 页签「${id}」未登记进 WEBVIEW_PANELS（该面板无 CJK 判据）`);
      }
    }
  }

  return issues;
}

function readJson(name) {
  return JSON.parse(readFileSync(join(HOST_ROOT, name), 'utf8'));
}

/**
 * 判据⑰⑱ 的真源装载：面板注册表 + 已迁移文件 CJK 采集 + 设置页签集合抽取
 *
 * 注意采集只发生在 `state: 'migrated'` 的登记文件上——pending 面板本来就有中文，
 * 全量扫会让判据长期红（长期红 = 红灯免疫）。
 *
 * @returns {{panelIds:string[], violations:string[], registryIssues:string[], settingsTabIds:string[]|null}}
 */
function loadWebviewPanels() {
  const panelIds = Object.keys(WEBVIEW_PANELS);
  const registryIssues = [];
  const violations = [];
  for (const [id, panel] of Object.entries(WEBVIEW_PANELS)) {
    for (const rel of panel.files) {
      const abs = join(HOST_ROOT, 'src', rel);
      if (!existsSync(abs)) {
        registryIssues.push(
          `判据⑰ webview 面板登记项不存在：src/${rel}（面板 ${id}，路径写错 = 永不被扫）`,
        );
        continue;
      }
      if (panel.state !== 'migrated') continue;
      for (const hit of collectPanelFileCjk(rel, readFileSync(abs, 'utf8'))) {
        violations.push(`${id} · src/${rel}：${hit}`);
      }
    }
  }
  // ⑰ 第二登记面：共享文件无 state 开关，登记即判（口径与 migrated 面板完全一致）
  for (const rel of SHARED_CJK_FILES) {
    const abs = join(HOST_ROOT, 'src', rel);
    if (!existsSync(abs)) {
      registryIssues.push(`判据⑰ 共享文件登记项不存在：src/${rel}（路径写错 = 永不被扫）`);
      continue;
    }
    for (const hit of collectPanelFileCjk(rel, readFileSync(abs, 'utf8'))) {
      violations.push(`共享 · src/${rel}：${hit}`);
    }
  }
  const tabsText = readFileSync(join(HOST_ROOT, 'src', 'shared', 'settingsTabs.ts'), 'utf8');
  return {
    panelIds,
    violations,
    registryIssues,
    settingsTabIds: collectSettingsTabIdsInText(tabsText),
  };
}

function loadReal() {
  const bundleEn = readJson(join('l10n', 'bundle.l10n.json'));
  const bundleZh = readJson(join('l10n', 'bundle.l10n.zh-cn.json'));
  const files = walkTs(join(HOST_ROOT, 'src'));
  const tKeys = collectTKeyFacts(files);
  // 判据⑯：全 src 的 @vscode/l10n import 形态（键面采集面完整性）
  const l10nImportIssues = files.flatMap((f) =>
    collectL10nImportIssuesInText(readFileSync(f, 'utf8'), f.slice(HOST_ROOT.length + 1)),
  );
  const ui = resolveMigratedUiFiles();
  const windowViolations = ui.files.flatMap((f) =>
    collectWindowApiCjkInText(readFileSync(f, 'utf8'), f.slice(HOST_ROOT.length + 1)),
  );
  const webview = loadWebviewPanels();
  return {
    pkg: readJson('package.json'),
    en: readJson('package.nls.json'),
    zh: readJson('package.nls.zh-cn.json'),
    bundle: {
      bundleEn,
      bundleZh,
      staticKeys: tKeys.staticKeys,
      dynamicKeys: tKeys.dynamicKeys,
      templateViolations: tKeys.templateViolations,
      windowViolations,
      registryIssues: ui.missing,
      dynamicKeyMarkers: tKeys.dynamicKeyMarkers,
      l10nImportIssues,
      webviewViolations: webview.violations,
      webviewRegistryIssues: webview.registryIssues,
      webviewPanelIds: webview.panelIds,
      settingsTabIds: webview.settingsTabIds,
    },
  };
}

/**
 * 自检：以**真实文件**为基线注入变异，逐条确认判据能红。
 * 不用手搓 fixture——全 ASCII 假数据测不出真形态（见变异验证纪律）。
 */
function selfTest() {
  const base = loadReal();
  const cases = [
    {
      label: '① 引用闭合（英文缺键）',
      mutate: (d) => {
        delete d.en['command.open.title'];
      },
      expect: 'package.nls.json 缺键',
    },
    {
      label: '② 键面不等（中文多一条）',
      mutate: (d) => {
        d.zh['command.ghost.title'] = '幽灵';
      },
      expect: '键面不等',
    },
    {
      label: '③ 孤儿键',
      mutate: (d) => {
        d.en['command.ghost.title'] = 'Ghost';
        d.zh['command.ghost.title'] = '幽灵';
      },
      expect: '孤儿键',
    },
    {
      label: '④ 默认文件混入中文',
      mutate: (d) => {
        d.en['view.chat.name'] = '对话';
      },
      expect: '默认文件必须是英文',
    },
    {
      label: '⑤ 中文硬编码残留',
      mutate: (d) => {
        d.pkg.contributes.commands[0].title = 'Memora: 打开对话面板';
      },
      expect: '中文硬编码残留',
    },
    {
      // 射程回归锚：旧实现只扫「命令 / 配置 / 视图」三面，新增面里的中文一路绿灯
      label: '⑤ 中文残留（三面白名单之外的新面：viewsWelcome）',
      mutate: (d) => {
        d.pkg.contributes.viewsWelcome = [
          { view: 'memora.chat', contents: '还没有对话，点这里开始' },
        ];
      },
      expect: '中文硬编码残留',
    },
    {
      label: '⑥ 空值',
      mutate: (d) => {
        d.zh['command.open.title'] = '';
      },
      expect: '值无效',
    },
    {
      label: '⑦ 射程下限（命令面塌空）',
      mutate: (d) => {
        d.pkg.contributes.commands = [];
      },
      expect: '命令数',
    },
    // ---- bundle 判据（⑧-⑬）----
    {
      label: '⑧ bundle 键面不等',
      mutate: (d) => {
        delete d.bundle.bundleZh[d.bundle.bundleEn && Object.keys(d.bundle.bundleEn)[0]];
      },
      expect: 'bundle 键面不等',
    },
    {
      label: '⑨ 源码键缺译文（静默回退）',
      mutate: (d) => {
        const key = [...d.bundle.staticKeys][0];
        delete d.bundle.bundleZh[key];
        delete d.bundle.bundleEn[key];
      },
      expect: 'bundle 缺键',
    },
    {
      label: '⑩ bundle 孤儿键',
      mutate: (d) => {
        d.bundle.bundleEn['Stale key from removed source'] = '';
        d.bundle.bundleZh['Stale key from removed source'] = '陈旧译文';
      },
      expect: 'bundle 孤儿键',
    },
    {
      label: '⑪ zh 译文空串',
      mutate: (d) => {
        const key = [...d.bundle.staticKeys][0];
        d.bundle.bundleZh[key] = '';
      },
      expect: 'bundle 中文译文为空',
    },
    {
      label: '⑳ zh 译文照抄英文源键（漏译）',
      mutate: (d) => {
        // 挑一条「像句子的」键（长且有空格），避开专有名词白名单
        const key = [...d.bundle.staticKeys].find((k) => k.length > 20 && k.includes(' '));
        d.bundle.bundleZh[key] = key;
      },
      expect: 'zh 译文照抄英文源键',
    },
    {
      label: '⑳ zh 译文丢 {n} 占位符',
      mutate: (d) => {
        const key = Object.keys(d.bundle.bundleZh).find((k) => /\{\d+\}/.test(k));
        d.bundle.bundleZh[key] = d.bundle.bundleZh[key].replace(/\{\d+\}/g, '');
      },
      expect: '占位符与键不一致',
    },
    {
      label: '⑫ t() 模板串第一参',
      mutate: (d) => {
        d.bundle.templateViolations.push('src/extension/mutated.ts');
      },
      expect: '静态字面量',
    },
    {
      label: '⑬ 窗口通知中文残留',
      mutate: (d) => {
        d.bundle.windowViolations.push("src/extension/mutated.ts: showWarningMessage('中文提示')");
      },
      expect: '中文残留',
    },
    {
      // 采集器级变异：证明「往已迁移文件里塞中文」不只是判据函数能红，**扫描器本身**能抓到
      label: '⑬ 采集器：QuickPick 占位/标题中文',
      mutate: (d) => {
        d.bundle.windowViolations.push(
          ...collectWindowApiCjkInText(
            `await vscode.window.showQuickPick(items, { title: '本次文件改动', placeHolder: '选择操作' });`,
            'mutated',
          ),
        );
      },
      expect: '中文残留',
    },
    {
      label: '⑬ 采集器：开框标题 / openLabel / filters 键中文',
      mutate: (d) => {
        d.bundle.windowViolations.push(
          ...collectWindowApiCjkInText(
            `vscode.window.showOpenDialog({ filters: { 压缩包: ['zip'] }, openLabel: '导入', title: '选择压缩包' });`,
            'mutated',
          ),
        );
      },
      expect: '中文残留',
    },
    {
      label: '⑬ 采集器：CodeLens 标题 / 状态栏文案中文',
      mutate: (d) => {
        d.bundle.windowViolations.push(
          ...collectWindowApiCjkInText(
            `new vscode.CodeLens(range, { title: '接受此处' }); statusBar.text = '未确认改动';`,
            'mutated',
          ),
        );
      },
      expect: '中文残留',
    },
    {
      label: '⑮ 动态键源标记塌空',
      mutate: (d) => {
        d.bundle.dynamicKeyMarkers = 0;
      },
      expect: '动态键源标记',
    },
    {
      label: '⑭ 登记清单路径写错',
      mutate: (d) => {
        d.bundle.registryIssues.push('判据⑭ 登记项不存在：src/extension/nope.ts');
      },
      expect: '登记项不存在',
    },
    {
      // 采集器级变异：证明裸别名导入由**扫描器本身**判出，而非只测判据函数透传
      label: '⑯ @vscode/l10n 裸导 t（键面采集脱管）',
      mutate: (d) => {
        d.bundle.l10nImportIssues.push(
          ...collectL10nImportIssuesInText(
            `import { t } from '@vscode/l10n';\nexport const s = t('Key');`,
            'mutated',
          ),
        );
      },
      expect: '非 namespace 导入',
    },
    {
      label: '⑰ 已迁移面板中文残留',
      mutate: (d) => {
        d.bundle.webviewViolations.push('works · src/webview/scripts/worksView.ts：移除登记');
      },
      expect: 'webview 面板中文残留',
    },
    {
      // 采集器级变异：证明 TS 口径由**扫描器本身**判出（字符串 + 模板串 + 属性值）
      label: '⑰ 采集器：TS 字面量 / 模板串中文',
      mutate: (d) => {
        d.bundle.webviewViolations.push(
          ...collectVisibleCjkInText(`el.textContent = '移除登记'; el.title = \`设为\${x}\`;`).map(
            (s) => `mutated：${s}`,
          ),
        );
      },
      expect: 'webview 面板中文残留',
    },
    {
      // 模板串口径（B11 第一步）：插值**之后**的静态片段同样是文案。
      // 旧实现在 `${…}` 里遇到嵌套模板就把那个反引号当外层闭合，后续 HTML 不再按字面量扫。
      label: '⑰ 采集器：模板串静态片段中文（插值前后都算）',
      mutate: (d) => {
        d.bundle.webviewViolations.push(
          ...collectVisibleCjkInText(
            'el.innerHTML = `${head({ title })}\n<b title="移除登记">x</b>`;',
          ).map((s) => `mutated：${s}`),
        );
      },
      expect: 'webview 面板中文残留',
    },
    {
      // 插值里的**嵌套模板**不得吞掉外层剩余部分（反引号误闭合是旧实现的核心缺陷）
      label: '⑰ 采集器：插值内嵌套模板的中文',
      mutate: (d) => {
        d.bundle.webviewViolations.push(
          ...collectVisibleCjkInText('const s = `${`${a}`}<b>移除登记</b>`;').map(
            (s) => `mutated：${s}`,
          ),
        );
      },
      expect: 'webview 面板中文残留',
    },
    {
      // 采集器级变异：CSS 口径只认 content 字符串
      label: '⑰ 采集器：CSS content 中文',
      mutate: (d) => {
        d.bundle.webviewViolations.push(
          ...collectCssCjkContent(`.x::after { content: '中文提示'; }`).map((s) => `mutated：${s}`),
        );
      },
      expect: 'webview 面板中文残留',
    },
    {
      label: '⑰ 登记项路径写错',
      mutate: (d) => {
        d.bundle.webviewRegistryIssues.push('判据⑰ webview 面板登记项不存在：src/nope.ts');
      },
      expect: '登记项不存在',
    },
    {
      // 第二登记面的红必须带「共享」前缀，否则红里看不出该查哪一侧的登记
      label: '⑰ 共享文件中文残留',
      mutate: (d) => {
        d.bundle.webviewViolations.push(
          ...collectPanelFileCjk(
            'webview/panels/settingsPanel.ts',
            `panel.webview.postMessage({ message: '切换失败' });`,
          ).map((s) => `共享 · src/webview/panels/settingsPanel.ts：${s}`),
        );
      },
      expect: 'webview 面板中文残留',
    },
    {
      label: '⑰ 共享文件登记项路径写错',
      mutate: (d) => {
        d.bundle.webviewRegistryIssues.push('判据⑰ 共享文件登记项不存在：src/nope-shared.ts');
      },
      expect: '共享文件登记项不存在',
    },
    {
      label: '⑱ 新设置页签未登记',
      mutate: (d) => {
        d.bundle.settingsTabIds.push('brand-new-tab');
      },
      expect: '未登记进 WEBVIEW_PANELS',
    },
    {
      label: '⑱ 注册表多出未声明面板',
      mutate: (d) => {
        d.bundle.webviewPanelIds.push('ghost-panel');
      },
      expect: '不在设置页签',
    },
    {
      label: '⑱ 页签集合抽取失败',
      mutate: (d) => {
        d.bundle.settingsTabIds = null;
      },
      expect: '抽取 SETTINGS_TABS',
    },
  ];
  let allOk = true;
  for (const c of cases) {
    // 深拷贝：每个变异体互不污染
    const data = structuredClone(base);
    c.mutate(data);
    // bundle 用例打 bundle 判据（auditBundle 入参与 auditNls 不同），其余打 package 判据
    const isBundleCase = c.label.includes('bundle') || /[⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑳]/.test(c.label);
    const issues = isBundleCase ? auditBundle(data.bundle) : auditNls(data);
    const hit = issues.some((s) => s.includes(c.expect));
    console.log(
      `  ${hit ? '✅' : '❌'} ${c.label}${hit ? ' 被捕获' : ` 未被捕获（实际：${issues[0] ?? '无问题'}）`}`,
    );
    if (!hit) allOk = false;
  }
  // 反例控制：真实文件必须绿（防过度拦截）
  const clean = [...auditNls(base), ...auditBundle(base.bundle)];
  const cleanOk = clean.length === 0;
  console.log(
    `  ${cleanOk ? '✅' : '❌'} 反例：真实文件${cleanOk ? '保持全绿' : `被误报：${clean.join(' / ')}`}`,
  );
  if (!cleanOk) allOk = false;

  // 不变量：**同一事实只表达一处**——共享文件不得同时出现在任何面板的登记清单里
  // （双向登记的坏处见 SHARED_CJK_FILES 注释：面板存亡会带走这个文件的判据）
  const panelFiles = new Set(Object.values(WEBVIEW_PANELS).flatMap((p) => p.files));
  const overlap = SHARED_CJK_FILES.filter((f) => panelFiles.has(f));
  console.log(
    `  ${overlap.length === 0 ? '✅' : '❌'} ⑰ 共享文件与面板登记不重叠（同一事实不两处表达）${
      overlap.length > 0 ? `（重复：${overlap.join('、')}）` : ''
    }`,
  );
  if (overlap.length > 0) allOk = false;

  // 不变量：判定不翻的条目必须**可复核**——kind / reason 齐全（空判据 = 未登记）
  const emptyDeferred = DEFERRED_CJK_FILES.filter(
    (d) => !d.kind || !d.reason || d.reason.length < 20,
  );
  console.log(
    `  ${emptyDeferred.length === 0 ? '✅' : '❌'} 判定不翻的条目均带 kind + reason${
      emptyDeferred.length > 0 ? `（缺判据：${emptyDeferred.map((d) => d.file).join('、')}）` : ''
    }`,
  );
  if (emptyDeferred.length > 0) allOk = false;

  // 不变量：判定不翻的条目**不得过期**——文件仍存在且仍含 CJK。
  // 清零后就该删条目（改登记 SHARED / 面板），留着会变成「僵尸豁免」：下次读的人以为
  // 这里还有中文要守，实际早就干净了。
  const staleDeferred = DEFERRED_CJK_FILES.filter((d) => {
    const abs = join(HOST_ROOT, 'src', d.file);
    if (!existsSync(abs)) return true;
    return collectPanelFileCjk(d.file, readFileSync(abs, 'utf8')).length === 0;
  });
  console.log(
    `  ${staleDeferred.length === 0 ? '✅' : '❌'} 判定不翻的条目未过期（文件在且仍有 CJK）${
      staleDeferred.length > 0 ? `（过期：${staleDeferred.map((d) => d.file).join('、')}）` : ''
    }`,
  );
  if (staleDeferred.length > 0) allOk = false;

  // 不变量：同一文件不得既「已清零登记」又「判定不翻」——那是两条互相矛盾的判据
  const deferredFiles = new Set(DEFERRED_CJK_FILES.map((d) => d.file));
  const deferredOverlap = [...deferredFiles].filter(
    (f) => panelFiles.has(f) || SHARED_CJK_FILES.includes(f),
  );
  console.log(
    `  ${deferredOverlap.length === 0 ? '✅' : '❌'} 判定不翻与已清零登记不重叠${
      deferredOverlap.length > 0 ? `（同时出现：${deferredOverlap.join('、')}）` : ''
    }`,
  );
  if (deferredOverlap.length > 0) allOk = false;

  // 不变量：`DEFERRED_CJK_FILES` 的三道准入（2026-11-10 · B10-F 第三刀）
  // 判据 = `auditDeferredEntries()` 纯函数；下面紧跟三组**伪造条目**变异证明它会红。
  const deferredIssues = auditDeferredEntries(DEFERRED_CJK_FILES);
  console.log(
    `  ${deferredIssues.length === 0 ? '✅' : '❌'} 判定不翻准入三条（kind 枚举 / 写后果 / 无延后语）${
      deferredIssues.length > 0 ? `（${deferredIssues.join('；')}）` : ''
    }`,
  );
  if (deferredIssues.length > 0) allOk = false;

  // 准入判据的变异：每条都必须被**自己那条**判据抓住（红在别处 = 判据没生效）
  const deferredMutations = [
    {
      label: '判定不翻准入：kind 写成自由文本',
      entries: [
        {
          file: 'mutated.ts',
          kind: '双面串（模型 + 用户）',
          reason: '翻了会让工具结果随 locale 漂移，模型输入不再可复现。',
        },
      ],
      expect: 'kind 非枚举',
    },
    {
      label: '判定不翻准入：理由写「待定」冒充已判定',
      entries: [
        {
          file: 'mutated.ts',
          kind: '双面串',
          reason: '暂时先不翻，这个问题待定，后续再看是否需要处理。',
        },
      ],
      expect: '延后语',
    },
    {
      label: '判定不翻准入：只说「不需要翻」没写后果',
      entries: [
        {
          file: 'mutated.ts',
          kind: '纯诊断',
          reason: '这些文案界面上看不到，所以不需要把它们翻译成键。',
        },
      ],
      expect: '没写后果句',
    },
  ];
  for (const m of deferredMutations) {
    const issues = auditDeferredEntries(m.entries);
    const hit = issues.some((s) => s.includes(m.expect));
    console.log(
      `  ${hit ? '✅' : '❌'} ${m.label}${hit ? ' 被捕获' : ` 未被捕获（实际：${issues[0] ?? '无问题'}）`}`,
    );
    if (!hit) allOk = false;
  }

  // 负向控制：白名单口径必须**不**误报（只测「能红」会放过「把所有中文都红」的过宽判据）
  const negativeCases = [
    [
      '⑰ 负向：console / logger 实参不判',
      collectVisibleCjkInText(`console.log('中文日志'); logger.warn('中文日志');`).length === 0,
    ],
    [
      '⑰ 负向：可选链日志实参不判（this.logger?.warn）',
      collectVisibleCjkInText(`this.logger?.warn('中文日志'); console?.error('中文日志');`)
        .length === 0,
    ],
    [
      '⑰ 负向：注释里的中文不判',
      collectVisibleCjkInText(`/** 中文说明 */\nconst a = 'ok';`).length === 0,
    ],
    [
      '⑰ 负向：字符串里的 HTML 注释不判',
      collectVisibleCjkInText('const h = `<!-- 中文标注 -->`;').length === 0,
    ],
    [
      // 模板串口径：只有插值、没有静态文字 ⇒ 没有文案可翻。
      // 误红会逼人给载荷加键（与 DEFERRED_CJK_FILES 的结论直接冲突）
      '⑰ 负向：纯插值模板不判',
      collectVisibleCjkInText('const s = `${a}${b}`;').length === 0,
    ],
    [
      // `${…}` 内部是代码：其中注释不是界面文案（旧实现会把注释文本并进模板片段 ⇒ 误红）
      '⑰ 负向：插值内的中文注释不判',
      collectVisibleCjkInText('const s = `${head({\n  // 中文说明\n  title,\n})}<b>ok</b>`;')
        .length === 0,
    ],
    [
      '⑰ 负向：CSS 注释中文不判',
      collectCssCjkContent(`/* 中文注释 */ .x { color: red; }`).length === 0,
    ],
    [
      // 协议标记（信封块头）不翻译 ⇒ 白名单命中不判；见 PANEL_CJK_ALLOWLIST
      '⑰ 负向：协议标记白名单命中不判',
      collectPanelFileCjk('shared/injectionSourceMeta.ts', `const a = '[工作区诊断]';`).length ===
        0,
    ],
    [
      // 白名单是「文件 + 精确值」双键：同一个值出现在别的文件里仍须判红（防外溢成通用后门）
      '⑰ 负向：白名单不外溢（同值换文件仍判红）',
      collectPanelFileCjk('webview/scripts/other.ts', `const a = '[工作区诊断]';`).length === 1,
    ],
  ];
  for (const [label, ok] of negativeCases) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ' 被误报'}`);
    if (!ok) allOk = false;
  }

  // 正向控制：`@nls-keys` 的键名会被 prettier 剥引号（quoteProps=as-needed），
  // 两种形态都必须收进键面——采集端只认带引号时，这批键静默脱管（见 collectDynamicKeySources）
  const dyn = collectDynamicKeySources(
    `// @nls-keys\nexport const T = { memory: 'Memory', 'no-workspace': 'No workspace' };\n`,
  );
  const dynOk = dyn.values.includes('Memory') && dyn.values.includes('No workspace');
  console.log(
    `  ${dynOk ? '✅' : '❌'} ⑨ 正向：裸标识符键名也进动态键面${dynOk ? '' : ' 漏采（键面脱管）'}`,
  );
  if (!dynOk) allOk = false;

  console.log(allOk ? '\n✅ 自检通过：本地化面各判据均可捕获变异' : '\n❌ 自检失败：存在失明判据');
  return allOk ? 0 : 1;
}

/**
 * `--report` 规模报告（判据⑲）：只量规模、出收据，**不判红**
 *
 * 输出三段：
 * 1. 已登记面板：逐面板的可见 CJK 计数（口径与⑰ 完全一致 ⇒ 该面板改 `migrated` 时
 *    这里的数字就是「还剩多少条要翻」）；
 * 2. 共享文件（`SHARED_CJK_FILES`）：无面板 state 的第二登记面，同样给计数；
 * 3. 未登记文件：注册表（面板 + 共享）之外的 `src` 文件按 CJK 计数降序（注册制盲区的唯一量化口径）。
 * 末尾附⑬ 窗口面锚点的全 src 命中数（与⑬ 同源，只看宿主 extension 面）。
 */
function report() {
  const registered = new Set();
  console.log('📊 [nls] webview 面板 CJK 规模报告（--report · 不判红）\n');
  console.log('已登记面板（计数口径 = 判据⑰ 的可见 CJK 采集）：');
  for (const [id, panel] of Object.entries(WEBVIEW_PANELS)) {
    const details = [];
    let count = 0;
    for (const rel of panel.files) {
      const abs = join(HOST_ROOT, 'src', rel);
      registered.add(`src/${rel}`);
      if (!existsSync(abs)) {
        details.push(`      src/${rel}：❌ 文件不存在`);
        continue;
      }
      const hits = collectPanelFileCjk(rel, readFileSync(abs, 'utf8'));
      count += hits.length;
      if (hits.length > 0) details.push(`      src/${rel}：${hits.length} 处`);
    }
    const scope =
      panel.files.length > 0 ? `${count} 处 / ${panel.files.length} 文件` : '—（未登记文件）';
    console.log(`  ${id.padEnd(9)} ${panel.state.padEnd(9)} ${scope}`);
    for (const d of details) console.log(d);
  }

  // 第二登记面：共享文件（无面板 state，登记即判）
  console.log('\n共享文件（`SHARED_CJK_FILES` · 无面板 state，登记即判）：');
  for (const rel of SHARED_CJK_FILES) {
    const abs = join(HOST_ROOT, 'src', rel);
    registered.add(`src/${rel}`);
    if (!existsSync(abs)) {
      console.log(`      src/${rel}：❌ 文件不存在`);
      continue;
    }
    const hits = collectPanelFileCjk(rel, readFileSync(abs, 'utf8'));
    console.log(`      src/${rel}：${hits.length} 处`);
  }

  const all = walkTs(join(HOST_ROOT, 'src'));
  // 第三面：已判定「不翻」——不是漏项，是结论；不计入下面的待翻清单
  const deferredSet = new Set(DEFERRED_CJK_FILES.map((d) => `src/${d.file}`));
  console.log(
    `\n已判定不翻（\`DEFERRED_CJK_FILES\` · ${DEFERRED_CJK_FILES.length} 个文件，不计入待翻清单）：`,
  );
  for (const d of DEFERRED_CJK_FILES) {
    const abs = join(HOST_ROOT, 'src', d.file);
    const hits = existsSync(abs) ? collectPanelFileCjk(d.file, readFileSync(abs, 'utf8')) : [];
    console.log(`      src/${d.file}：${hits.length} 处 · ${d.kind}`);
  }
  const unregistered = [];
  for (const abs of all) {
    const rel = abs.slice(HOST_ROOT.length + 1).replace(/\\/g, '/');
    if (registered.has(rel) || deferredSet.has(rel)) continue;
    const hits = collectPanelFileCjk(rel, readFileSync(abs, 'utf8'));
    if (hits.length > 0) unregistered.push([rel, hits.length]);
  }
  unregistered.sort((a, b) => b[1] - a[1]);
  console.log(
    `\n未登记进注册表（WEBVIEW_PANELS + SHARED_CJK_FILES + DEFERRED_CJK_FILES）的文件（注册制盲区，判据⑰ 扫不到）：${unregistered.length} 个含 CJK 字面量`,
  );
  // 全量列出（2026-11-10 去截断）：本段是「下一批选哪些文件」的唯一清单，
  // 只列前 20 + 「另有 N 个」会让剩下的文件**连坐标都没有**——盲区里的盲区。
  for (const [rel, n] of unregistered) console.log(`  ${String(n).padStart(5)}  ${rel}`);

  const windowHits = all.flatMap((abs) =>
    collectWindowApiCjkInText(
      readFileSync(abs, 'utf8'),
      abs.slice(HOST_ROOT.length + 1).replace(/\\/g, '/'),
    ),
  );
  console.log(`\n判据⑬ 窗口面锚点全 src 命中：${windowHits.length} 处（不判红）`);
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  if (process.argv.includes('--report')) {
    report();
    return 0;
  }
  const real = loadReal();
  const issues = [...auditNls(real), ...auditBundle(real.bundle)];
  if (issues.length === 0) {
    console.log(
      '✅ [nls] 本地化判据全绿（package 面：键面相等/引用闭合/无孤儿/默认英文/无中文残留；bundle 面：键面相等/源码键全覆盖/无孤儿/译文非空/t() 静态键/窗口无残留）',
    );
    return 0;
  }
  console.error(`❌ [nls] ${issues.length} 处命中：`);
  for (const s of issues.slice(0, 30)) console.error(`   ${s}`);
  if (issues.length > 30) console.error(`   … 另有 ${issues.length - 30} 处`);
  console.error(
    '   处置：键面不等 / 缺键 ⇒ 两份 nls 成对补齐；中文残留 ⇒ package.json 该字段改 %key%；\n' +
      '   孤儿键 ⇒ 删译文或补引用。本闸挂在打包前置与 full 档门禁——红了就修，不许绕过。',
  );
  return 1;
}

process.exit(main());
