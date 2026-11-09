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
 *   ⑱ **面板清单 = 设置页签 + chat**：`WEBVIEW_PANELS` 的 panel id 集合必须等于
 *      `shared/settingsTabs.ts` 的 `SETTINGS_TABS`（文本抽取）加 `chat`。新增页签未登记 ⇒ 红，
 *      防「新面板天然无判据」。
 *   ⑲ **`--report` 规模报告**（不判红）：对全 `src` 跑⑬ 的窗口面锚点，并按面板打印 CJK 计数。
 *      只用于量规模与出收据，**不参与退出码**。
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
 */
function collectDynamicKeySources(text) {
  const values = [];
  let markers = 0;
  // 键：单引号 / 双引号 / 裸标识符（三选一）；值：单引号或双引号字符串字面量
  const ENTRY_RE =
    /(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*))\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  for (const m of text.matchAll(/@nls-keys/g)) {
    markers++;
    const open = text.indexOf('{', m.index);
    if (open < 0) continue;
    const block = sliceBalanced(text, open, '{', '}');
    for (const mm of block.matchAll(ENTRY_RE)) {
      // mm[4] / mm[5] = 值的正文（单引号 / 双引号），按开引号类型分支避免截断
      values.push(unescapeSourceLiteral(mm[4] !== undefined ? mm[4] : mm[5]));
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

/** 源码 l10n 键采集结果 */
function collectTKeyFacts(files) {
  const staticKeys = new Set();
  const dynamicKeys = new Set();
  const templateViolations = [];
  let dynamicKeyMarkers = 0;
  // 按开引号类型分支（键里合法含另一种引号字符，合一字符类会提前截断——同 collectDynamicKeySources）
  const callSingles = [/\bl10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g, /\bl10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g];
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
 * - `pending`：尚未迁移。`files` 为空是**如实**表达「尚未登记文件清单」，不是「没有中文」；
 *   该面板的规模只能看 `--report` 的「未登记文件」段。
 *
 * 盲区见文件头「注册制盲区」三条：漏登记不红、state 可改回 pending、日志白名单是启发式。
 * 新增面板 = 本表加一项（⑱ 会挡漏登记）+ 迁移批次把 state 改 `migrated` 并列出文件。
 */
const WEBVIEW_PANELS = {
  chat: { state: 'pending', files: [] },
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
  // 登记会连带判别的页（登记口径是文件，不是「页面」——见文件头注册制盲区）。同理 `settingsView.ts`
  // 仍含安全页中文，待 B7 外置后另行登记。
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
    ],
  },
  mcp: { state: 'pending', files: [] },
  security: { state: 'pending', files: [] },
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
 * 逐字符扫描源码，产出字符串字面量（含模板串）清单
 *
 * 为什么手写扫描而非正则先剥注释：`//` 会出现在字符串里（URL / 路径），按行剥注释会误伤；
 * 逐字符走一遍能同时拿到「字面量边界」与「是否在注释里」两个事实，且不引入 AST 依赖。
 *
 * @param {string} text 源码全文
 * @returns {{start:number, value:string, quote:string}[]} 字面量清单（value 已还原转义）
 */
function scanStringLiterals(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    // 行注释：跳到行尾
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
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      i++;
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
        // 单/双引号串未闭合时止于行尾，防止一处笔误把整份文件吞成一个字面量
        if (quote !== '`' && text[i] === '\n') break;
        raw += text[i];
        i++;
      }
      out.push({ start, value: unescapeSourceLiteral(raw), quote });
      continue;
    }
    i++;
  }
  return out;
}

/** 日志白名单：字面量是否为 `console.*` / `logger.*` 的**直接实参**（启发式，见注册表盲区 3；只放内部事实，不放模型可见 / 双面，见盲区 4） */
function isLogArgument(textBefore) {
  return /(?:^|[^\w$])(?:console|logger)\s*\.\s*\w+\s*\([^()]*$/.test(textBefore);
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
    // 只看字面量前 200 字符：足够覆盖「console.log(a, '…')」这类调用前缀
    if (isLogArgument(text.slice(Math.max(0, lit.start - 200), lit.start))) continue;
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

/** 按文件类型分派可见 CJK 采集（`styles/` 走 CSS 口径，其余走 TS 口径） */
function collectPanelFileCjk(rel, text) {
  return /(^|\/)styles\//.test(rel) ? collectCssCjkContent(text) : collectVisibleCjkInText(text);
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
    const isBundleCase = c.label.includes('bundle') || /[⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱]/.test(c.label);
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

  // 负向控制：白名单口径必须**不**误报（只测「能红」会放过「把所有中文都红」的过宽判据）
  const negativeCases = [
    [
      '⑰ 负向：console / logger 实参不判',
      collectVisibleCjkInText(`console.log('中文日志'); logger.warn('中文日志');`).length === 0,
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
      '⑰ 负向：CSS 注释中文不判',
      collectCssCjkContent(`/* 中文注释 */ .x { color: red; }`).length === 0,
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
 * 输出两段：
 * 1. 已登记面板：逐面板的可见 CJK 计数（口径与⑰ 完全一致 ⇒ 该面板改 `migrated` 时
 *    这里的数字就是「还剩多少条要翻」）；
 * 2. 未登记文件：`WEBVIEW_PANELS` 之外的 `src` 文件按 CJK 计数降序（注册制盲区的唯一量化口径）。
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

  const all = walkTs(join(HOST_ROOT, 'src'));
  const unregistered = [];
  for (const abs of all) {
    const rel = abs.slice(HOST_ROOT.length + 1).replace(/\\/g, '/');
    if (registered.has(rel)) continue;
    const hits = collectPanelFileCjk(rel, readFileSync(abs, 'utf8'));
    if (hits.length > 0) unregistered.push([rel, hits.length]);
  }
  unregistered.sort((a, b) => b[1] - a[1]);
  console.log(
    `\n未登记进 WEBVIEW_PANELS 的文件（注册制盲区，判据⑰ 扫不到）：${unregistered.length} 个含 CJK 字面量`,
  );
  for (const [rel, n] of unregistered.slice(0, 20))
    console.log(`  ${String(n).padStart(5)}  ${rel}`);
  if (unregistered.length > 20) console.log(`  … 另有 ${unregistered.length - 20} 个文件`);

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
