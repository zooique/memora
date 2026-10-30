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
 * 插点：`package.json#scripts.package`（vsce 打包前）+ `scripts/local-ci.mjs` 的
 *   full 档步骤 `host:manifest`。「实现了」不等于「会跑」，两处都要挂。
 *
 * 用法：
 *   node scripts/verify-nls.mjs             # 主跑：对真实 manifest 与两份 nls 断言
 *   node scripts/verify-nls.mjs --self-test # 自检：基于真实文件注入变异，确认判据能红
 */
import { readFileSync } from 'node:fs';
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

function readJson(name) {
  return JSON.parse(readFileSync(join(HOST_ROOT, name), 'utf8'));
}

function loadReal() {
  return {
    pkg: readJson('package.json'),
    en: readJson('package.nls.json'),
    zh: readJson('package.nls.zh-cn.json'),
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
  ];
  let allOk = true;
  for (const c of cases) {
    // 深拷贝：每个变异体互不污染
    const data = structuredClone(base);
    c.mutate(data);
    const issues = auditNls(data);
    const hit = issues.some((s) => s.includes(c.expect));
    console.log(
      `  ${hit ? '✅' : '❌'} ${c.label}${hit ? ' 被捕获' : ` 未被捕获（实际：${issues[0] ?? '无问题'}）`}`,
    );
    if (!hit) allOk = false;
  }
  // 反例控制：真实文件必须绿（防过度拦截）
  const clean = auditNls(base);
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
  const issues = auditNls(loadReal());
  if (issues.length === 0) {
    console.log(
      '✅ [nls] package 面本地化判据全绿（键面相等 / 引用闭合 / 无孤儿 / 默认英文 / 全文无中文残留）',
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
