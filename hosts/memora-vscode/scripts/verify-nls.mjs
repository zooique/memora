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
 *   ⑬ **窗口 API 中文残留**：`show*Message(<静态中文字面量>)` ⇒ 红（宿主运行时 UI 通知
 *      必须走 `l10n.t`）。只扫调用点直接字面量——「先存中文变量再传」的间接形态扫不到，
 *      属判据边界，靠 review 与台账登记兜。
 *
 * 插点：`package.json#scripts.package`（vsce 打包前）+ `scripts/local-ci.mjs` 的
 *   full 档步骤 `host:manifest`。「实现了」不等于「会跑」，两处都要挂。
 *
 * 用法：
 *   node scripts/verify-nls.mjs             # 主跑：对真实 manifest / nls / bundle / 源码断言
 *   node scripts/verify-nls.mjs --self-test # 自检：基于真实文件注入变异，确认判据能红
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  return raw.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_, g) => {
      if (g[0] === 'u' && g[1] === '{') return String.fromCodePoint(parseInt(g.slice(2, -1), 16));
      if (g[0] === 'u' || g[0] === 'x') return String.fromCodePoint(parseInt(g.slice(1), 16));
      if (g === 'n') return '\n';
      if (g === 't') return '\t';
      if (g === 'r') return '\r';
      if (g === '0') return '\0';
      if (g === '\n') return ''; // 行续接反斜杠（源码折行）
      return g; // \\ \' \" 等 identity 转义 → 还原为字符本身
    },
  );
}

function collectDynamicKeySources(text) {
  const anchor = /const REJECT_MESSAGES[^=]*=\s*\{/;
  const start = text.search(anchor);
  if (start < 0) return [];
  const end = text.indexOf('\n};', start);
  if (end < 0) return [];
  const block = text.slice(start, end);
  // 形态 `{ 'reason': '文案' }`：抽冒号后的字符串值（键是原因码，不进键面）
  const values = [];
  for (const re of [/:\s*'((?:[^'\\]|\\.)*)'/g, /:\s*"((?:[^"\\]|\\.)*)"/g]) {
    for (const m of block.matchAll(re)) values.push(unescapeSourceLiteral(m[1]));
  }
  return values;
}

/** 源码 l10n 键采集结果 */
function collectTKeyFacts(files) {
  const staticKeys = new Set();
  const dynamicKeys = new Set();
  const templateViolations = [];
  // 按开引号类型分支（键里合法含另一种引号字符，合一字符类会提前截断——同 collectDynamicKeySources）
  const callSingles = [/\bl10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g, /\bl10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of collectDynamicKeySources(text)) dynamicKeys.add(m);
    for (const re of callSingles) {
      for (const m of text.matchAll(re)) staticKeys.add(unescapeSourceLiteral(m[1]));
    }
    // 模板串第一参 = 违规（键面守卫拿不到键）
    if (/\bl10n\.t\(\s*`/.test(text)) templateViolations.push(f);
  }
  return { staticKeys, dynamicKeys, templateViolations };
}

/** 窗口 API 直接中文字面量（show*Message 第一参为静态字面量且含 CJK ⇒ 违规） */
function collectWindowApiCjk(files) {
  const violations = [];
  // 三种引号各一条分支（合一字符类会在串内的另一种引号处截断）
  const callRes = [
    /\b(showErrorMessage|showWarningMessage|showInformationMessage)\(\s*'((?:[^'\\]|\\.)*)'/g,
    /\b(showErrorMessage|showWarningMessage|showInformationMessage)\(\s*"((?:[^"\\]|\\.)*)"/g,
    /\b(showErrorMessage|showWarningMessage|showInformationMessage)\(\s*`([^`]*)`/g,
  ];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of callRes) {
      for (const m of text.matchAll(re)) {
        // 转义还原后再判 CJK（`'\u4e2d\u6587'` 形态在原文里不含 CJK 字符，不还原即漏检）
        const value = unescapeSourceLiteral(m[2]);
        if (CJK.test(value)) {
          violations.push(`${f}: ${m[1]}('${value.slice(0, 30)}…')`);
        }
      }
    }
  }
  return violations;
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
 */
export function auditBundle({ bundleEn, bundleZh, staticKeys, dynamicKeys, templateViolations, windowViolations }) {
  const issues = [];
  const allKeys = new Set([...staticKeys, ...dynamicKeys]);

  // ⑧ bundle 键面相等
  for (const key of Object.keys(bundleEn)) {
    if (!Object.hasOwn(bundleZh, key)) issues.push(`bundle 键面不等：仅在英文 bundle「${key.slice(0, 40)}」`);
  }
  for (const key of Object.keys(bundleZh)) {
    if (!Object.hasOwn(bundleEn, key)) issues.push(`bundle 键面不等：仅在中文 bundle「${key.slice(0, 40)}」`);
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
  for (const v of windowViolations) issues.push(`宿主窗口通知中文残留（应走 l10n.t）：${v}`);

  return issues;
}

function readJson(name) {
  return JSON.parse(readFileSync(join(HOST_ROOT, name), 'utf8'));
}

function loadReal() {
  const bundleEn = readJson(join('l10n', 'bundle.l10n.json'));
  const bundleZh = readJson(join('l10n', 'bundle.l10n.zh-cn.json'));
  const files = walkTs(join(HOST_ROOT, 'src'));
  const tKeys = collectTKeyFacts(files);
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
      windowViolations: collectWindowApiCjk(files),
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
  ];
  let allOk = true;
  for (const c of cases) {
    // 深拷贝：每个变异体互不污染
    const data = structuredClone(base);
    c.mutate(data);
    // bundle 用例打 bundle 判据（auditBundle 入参与 auditNls 不同），其余打 package 判据
    const isBundleCase = c.label.includes('bundle') || /[⑧⑨⑩⑪⑫⑬]/.test(c.label);
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
  console.log(allOk ? '\n✅ 自检通过：本地化面各判据均可捕获变异' : '\n❌ 自检失败：存在失明判据');
  return allOk ? 0 : 1;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
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
