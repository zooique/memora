#!/usr/bin/env node
/**
 * 出包负向断言闸 —— 安装包「不该有什么」（`PKG-NEGATIVE-1`，2026-10-27 拍板）
 *
 * 存在的理由：`.vscodeignore` 是**黑名单**——它只管「记得排除的」，管不住「没想到的」。
 *   2026-10-26 实测曾发生过 `.workbuddy/**` 调试日志与 `.tmp-vsce.log` 混入 vsix
 *   （`.gitignore` 忽略的文件 vsce 不看，靠人工验收才发现）⇒ 每一类新泄漏都要先踩一遍
 *   再补一条 ignore。本闸把方向反过来：**清单里每个路径必须落在显式白名单内**，
 *   白名单外一律红——新泄漏不再依赖「有人想到」，而是默认拦下。
 *
 * 判据（对 `vsce ls --no-dependencies` 的输出逐条断言）：
 *   ① **白名单外路径**：只允许 `README.md` / `package.json` / `LICENSE`（vsce 恒定文件）
 *      与 `resources/`（图标 + 市场页截图）、`dist/`（编译产物）两个前缀。⚠️ 白名单是契约：
 *      将来新增合法顶层目录 = 显式改这里，不是闸误报。
 *   ② **负向模式**（白名单内的双保险，报错给出精确理由）：`node_modules`（依赖已 esbuild
 *      内联）/ `__tests__`、`.test.`、`.spec.`（测试产物）/ `.ts`、`.tsx`（源码）/ `.map`
 *      （source map）/ 含 `..` 路径段（**宿主根以外**）/ 隐藏路径段（`.build-stamp.json`
 *      等构建戳——`.vscodeignore` 已排除，此处兜底）。
 *   ③ **射程下限**（防空转假绿）：清单非空、文件数 ≥ 100（0.3.0 实测 175）、
 *      必含 `README.md` / `package.json` / `dist/extension/extension.js`（`main` 入口——
 *      缺它 = 包必坏；dist 不在 = compile 没跑，本闸挂在 compile 之后，缺即配置错误）。
 *   ④ **空集 fail-closed**：清单解析为 0 ⇒ 红（判据失明比假绿更危险）。
 *
 * 插点：`package.json#package` 脚本 —— `compile && node scripts/verify-package-manifest.mjs
 *   && vsce package`。`vsce ls` 与 `vsce package` 必须同参 `--no-dependencies`
 *   （裸 `vsce ls` 会被 monorepo 依赖树 `npm list` 的 ELSPROBLEMS 绊倒，2026-10-27 实测）。
 *
 * 用法：
 *   node scripts/verify-package-manifest.mjs             # 主跑：对真实 vsce 清单断言
 *   node scripts/verify-package-manifest.mjs --self-test # 自检：注入变异确认判据能红
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = join(HERE, '..');
const VSCE_BIN = join(HOST_ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');

/** 白名单契约（判据①）：新增合法顶层目录/文件 = 显式改这里，改动必须过 review */
const ALLOWED_EXACT = new Set(['README.md', 'package.json', 'LICENSE']);
const ALLOWED_PREFIXES = ['resources/', 'dist/'];

/** 判据③ 的射程下限：0.3.0 实测 175 个文件；下限只防「清单大面积消失」，不追精确相等 */
const MIN_FILES = 100;
/** `main` 指向的入口——缺它 = 包必坏 */
const REQUIRED_ENTRIES = ['README.md', 'package.json', 'dist/extension/extension.js'];

/** 判据② 的负向模式（与白名单正交的双保险；每条只报第一命中，理由精确到类） */
const FORBIDDEN_PATTERNS = [
  [/(^|\/)node_modules(\/|$)/, '依赖目录混入（esbuild 已内联，包内不该有 node_modules）'],
  [/(^|\/)__tests__(\/|$)|\.test\.|\.spec\./, '测试产物混入'],
  [/\.tsx?$/, 'TypeScript 源码混入（包内只该有编译产物 .js）'],
  [/\.map$/, 'source map 混入'],
  [/(^|\/)\.\.(\/|$)/, '宿主根以外的路径'],
  [/(^|\/)\.[^./]/, '隐藏文件/构建戳混入'],
];

/**
 * 判据本体（纯函数，便于自检注入）：entries = vsce 清单路径数组。
 * 返回问题列表；空数组 = 绿。
 */
export function auditManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return ['清单解析为 0 个文件（判据失明比假绿更危险）'];
  }
  const issues = [];
  if (entries.length < MIN_FILES) {
    issues.push(
      `清单仅 ${entries.length} 个文件 < 下限 ${MIN_FILES}（compile 未跑或打包配置损坏）`,
    );
  }
  for (const need of REQUIRED_ENTRIES) {
    if (!entries.includes(need)) issues.push(`清单缺必需文件：${need}`);
  }
  for (const raw of entries) {
    const e = raw.replaceAll('\\', '/');
    if (!ALLOWED_EXACT.has(e) && !ALLOWED_PREFIXES.some((p) => e.startsWith(p))) {
      issues.push(`白名单外路径：${e}`);
    }
    for (const [re, why] of FORBIDDEN_PATTERNS) {
      if (re.test(e)) {
        issues.push(`${why}：${e}`);
        break;
      }
    }
  }
  return issues;
}

/** 真实清单采集：与 `vsce package` 同参（--no-dependencies），见文件头「插点」说明 */
function collectManifest() {
  if (!existsSync(VSCE_BIN)) {
    throw new Error(`vsce 本地入口不存在：${VSCE_BIN}（先在宿主目录 npm install）`);
  }
  const out = execFileSync(process.execPath, [VSCE_BIN, 'ls', '--no-dependencies'], {
    cwd: HOST_ROOT,
    encoding: 'utf8',
  });
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 自检：向判据本体注入变异，确认每类判据**确实能红**（不跑 vsce，纯函数级） */
function selfTest() {
  // 0.3.0 实测形态的最小合法样例（绿基准）：足量越过射程下限（首版 5 文件样例被下限判据
  // 正确打红——自检抓到的设计缺陷，修正为足量样例，反例不经任何参数豁免、走生产判据）
  const legal = [
    'README.md',
    'package.json',
    'LICENSE',
    'resources/icon.png',
    ...Array.from({ length: 99 }, (_, i) => `dist/mod${i}.js`),
    'dist/extension/extension.js',
  ];
  const cases = [
    { label: '①白名单外', entry: 'zz-leak.js' },
    { label: '②测试产物', entry: 'dist/__tests__/x.js' },
    { label: '②node_modules', entry: 'node_modules/foo/index.js' },
    { label: '②源码 .ts', entry: 'src/agent.ts' },
    { label: '②source map', entry: 'dist/extension/extension.js.map' },
    { label: '②宿主根外', entry: '../kernel/dist/x.js' },
    { label: '②隐藏段', entry: 'dist/.build-stamp.json' },
  ];
  let allOk = true;
  for (const c of cases) {
    const issues = auditManifest([...legal, c.entry]);
    const hit = issues.some((s) => s.includes(c.entry));
    console.log(`  ${hit ? '✅' : '❌'} ${c.label}（${c.entry}）${hit ? '被捕获' : '未被捕获'}`);
    if (!hit) allOk = false;
  }
  // 反例控制：合法样例必须绿（防过度拦截）
  const clean = auditManifest(legal);
  const cleanOk = clean.length === 0;
  console.log(
    `  ${cleanOk ? '✅' : '❌'} 反例：合法清单${cleanOk ? '保持全绿' : `被误报：${clean.join(' / ')}`}`,
  );
  if (!cleanOk) allOk = false;
  // 空清单 fail-closed
  const empty = auditManifest([]);
  const emptyOk = empty.length > 0;
  console.log(`  ${emptyOk ? '✅' : '❌'} 空清单${emptyOk ? '判红' : '竟判绿'}`);
  if (!emptyOk) allOk = false;
  // 射程下限：缺入口
  const noEntry = auditManifest(legal.filter((x) => x !== 'dist/extension/extension.js'));
  const noEntryOk = noEntry.some((s) => s.includes('dist/extension/extension.js'));
  console.log(
    `  ${noEntryOk ? '✅' : '❌'} 缺入口 dist/extension/extension.js${noEntryOk ? '被捕获' : '未被捕获'}`,
  );
  if (!noEntryOk) allOk = false;
  console.log(allOk ? '\n✅ 自检通过：负向断言各判据均可捕获变异' : '\n❌ 自检失败：存在失明判据');
  return allOk ? 0 : 1;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  const entries = collectManifest();
  const issues = auditManifest(entries);
  console.log(`[package-manifest] vsce 清单共 ${entries.length} 个文件`);
  if (issues.length === 0) {
    console.log(
      '✅ [package-manifest] 负向断言全部通过（白名单内 / 无源码测试依赖 map 泄漏 / 入口在位）',
    );
    return 0;
  }
  console.error(`❌ [package-manifest] ${issues.length} 处负向命中：`);
  for (const s of issues.slice(0, 30)) console.error(`   ${s}`);
  if (issues.length > 30) console.error(`   … 另有 ${issues.length - 30} 处`);
  console.error(
    '   处置：合法的新目录/文件 → 显式扩充本脚本 ALLOWED_*（白名单是契约）；其余从包里排除\n' +
      '   （补 `.vscodeignore` 或修构建产物）。本闸挂在 package 前置——红了就修，不许绕过。',
  );
  return 1;
}

process.exit(main());
