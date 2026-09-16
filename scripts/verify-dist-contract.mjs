#!/usr/bin/env node
/**
 * dist 契约校验 — 「用户实际运行的东西」是否与内核源码同代
 *
 * 为什么存在（缺口，2026-09-16 审查确认为实锤）：
 *   门禁的 8 步里没有 `host:build` —— 宿主 `dist/extension/extension.js`（内联内核
 *   `dist/` 的单文件 bundle）**从不被构建**，而它才是用户在 VS Code 里真正运行的产物。
 *   于是 `npm run ci:local` 全绿可以与「宿主 bundle 陈旧」并存：内核改了 API，
 *   宿主源码没动，门禁照样绿，用户跑起来的却是旧内核。这正是项目自己记录过的
 *   「未改宿主 TS ≠ 未影响宿主 dist」，此前**零覆盖**。
 *
 * 两条断言（分工不同，缺一不可）：
 *
 *   ① **同代性（强判据）**：宿主构建期写入的 `kernelDistHash` == 当前内核 dist 哈希。
 *      哈希口径见 `scripts/lib/dist-hash.mjs`（**单一实现**，宿主构建侧共用同一函数）。
 *
 *   ② **符号面（补 ① 的盲区）**：① 比的是 `dist/` 的哈希，但**不保证宿主构建时
 *      `@zooique/memora` 解析到的就是这份 dist**（junction / node_modules 缓存可能指向
 *      另一份旧拷贝——此时戳与当前 dist 一致、bundle 里却仍是旧内核）。
 *      故再断言：宿主源码里 import 自内核**且被用到**的导出，其实现必须出现在 bundle 中。
 *
 *   ②的三处必要修正（均由 2026-09-16 的变异验证实测暴露，不是预防性放宽）：
 *     - **别名解析**：内核 barrel 做别名导出时（实测 `src/index.ts:247` 唯一的
 *       `export { defaultTitle as defaultSessionTitle }`），esbuild 内联后用的是**模块内本地名**
 *       `defaultTitle`，别名只活在 barrel 边界 → 直接搜导入名会**假红**。
 *       故从 `dist/index.js` 解析 `export { A as B }` 建 B→A 映射，搜 A。
 *     - **类型导出过滤**：类型在编译期被抹除（`CodeExecutionResult` 等），不可能出现在 bundle
 *       里 → 用**运行时 `import()` 内核 barrel** 取真实导出键做白名单，而非解析 `.d.ts`。
 *     - **只查「被用到」的**：esbuild 会 tree-shake 未使用的 import，查未使用的会假红。
 *
 * ⚠️ 转义感知（Tessa 正本清源，2026-09-16 实测复现）：
 *   esbuild `charset: 'ascii'` **只转义字符串字面量，注释保留 UTF-8**。故裸
 *   `includes(中文)` **双向失真**——注释命中=假绿，仅存于字面量=假红。
 *   本脚本对所有 token 一律走 `containsToken()`（原样 + `\uXXXX` 转义两种形态）。
 *   **禁在任何校验脚本里写裸 `includes(中文)`**。
 *
 * 用法：
 *   node scripts/verify-dist-contract.mjs              # 校验，失败 exit 1
 *   node scripts/verify-dist-contract.mjs --allow-absent  # dist 缺失时出声跳过（全新 clone 不误红）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashKernelDist } from './lib/dist-hash.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOST = join(ROOT, 'hosts', 'memora-vscode');
const STAMP_PATH = join(HOST, 'dist', '.build-stamp.json');
const BUNDLE_PATH = join(HOST, 'dist', 'extension', 'extension.js');
const KERNEL_ENTRY = join(ROOT, 'dist', 'index.js');
const KERNEL_PACKAGE = '@zooique/memora';

const allowAbsent = process.argv.includes('--allow-absent');

const TAG = '[dist-contract]';
const fail = (msg) => {
  console.error(`❌ ${TAG} ${msg}`);
  process.exit(1);
};

/** 非 ASCII 字符 → esbuild(ascii) 的 `\uXXXX` 大写十六进制转义形态 */
const escapeNonAscii = (text) =>
  text.replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);

/** 转义感知的 token 命中判定（禁裸 includes，理由见文件头） */
function containsToken(text, token) {
  if (text.includes(token)) return true;
  const escaped = escapeNonAscii(token);
  return escaped !== token && text.includes(escaped);
}

/** 递归收集宿主源码（全部 .ts，排除 __tests__） */
function collectHostSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectHostSources(full, out);
      continue;
    }
    if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * 宿主源码里从内核 import 的**值侧**符号名。
 * 规则：`import type {...}` 整句与内联 `type X` 说明符都跳过（编译期抹除）；
 * `as` 别名取**左侧原导出名**（bundle 里是内核导出的名字，不是宿主的别名）。
 */
function collectKernelImportNames(files) {
  const importRe = new RegExp(
    String.raw`import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+['"]${KERNEL_PACKAGE.replace('/', '\\/')}['"]`,
    'g',
  );
  const names = new Set();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(importRe)) {
      if (/^\s*import\s+type\s/.test(match[0])) continue;
      for (const raw of match[1].split(',')) {
        const trimmed = raw.trim();
        if (trimmed === '' || /^type\s/.test(trimmed)) continue;
        const original = trimmed.split(/\s+as\s+/)[0].trim();
        if (/^[\w$]+$/.test(original)) names.add(original);
      }
    }
  }
  return names;
}

/** 解析内核 barrel 的 `export { A as B }` → Map(B → A)：bundle 里出现的是本地名 A */
function buildExportAliasMap() {
  const map = new Map();
  if (!existsSync(KERNEL_ENTRY)) return map;
  const re = /export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
  for (const match of readFileSync(KERNEL_ENTRY, 'utf8').matchAll(re)) {
    for (const raw of match[1].split(',')) {
      const alias = raw.trim().match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (alias) map.set(alias[2], alias[1]);
    }
  }
  return map;
}

/** 内核 barrel 的**运行时**导出键（类型导出不在其中，正好用来过滤） */
async function loadKernelRuntimeExports() {
  try {
    const mod = await import(pathToFileURL(KERNEL_ENTRY).href);
    return new Set(Object.keys(mod));
  } catch (err) {
    console.log(`⚠️  ${TAG} 运行时导入内核 barrel 失败（${err.message}）→ 本轮不过滤类型导出，符号面断言可能偏严`);
    return null;
  }
}

async function main() {
  const missingPaths = [BUNDLE_PATH, STAMP_PATH].filter((p) => !existsSync(p)).map((p) => relative(ROOT, p).split(sep).join('/'));
  if (missingPaths.length > 0) {
    if (allowAbsent) {
      console.log(`⚠️  ${TAG} 缺失：${missingPaths.join(' , ')} —— --allow-absent 出声跳过（未校验，不代表通过）`);
      return;
    }
    fail(`缺失：${missingPaths.join(' , ')}\n   → 先构建宿主：cd hosts/memora-vscode && npm run compile`);
  }

  const currentHash = hashKernelDist(ROOT);
  if (currentHash === null) {
    if (allowAbsent) {
      console.log(`⚠️  ${TAG} 内核 dist 不存在（未构建内核）—— --allow-absent 出声跳过`);
      return;
    }
    fail('内核 dist 不存在：先 `npm run build`');
  }

  // ── 断言 ①：同代性 ──────────────────────────────────────────────
  const stamp = JSON.parse(readFileSync(STAMP_PATH, 'utf8'));
  if (stamp.kernelDistHash !== currentHash) {
    fail(
      `宿主 bundle 陈旧（与内核 dist 不同代）\n` +
        `   构建时内核 dist 哈希 = ${String(stamp.kernelDistHash).slice(0, 12)}\n` +
        `   当前内核 dist 哈希   = ${currentHash.slice(0, 12)}\n` +
        `   → 重跑宿主构建：cd hosts/memora-vscode && npm run compile`,
    );
  }

  // ── 断言 ②：符号面 ─────────────────────────────────────────────
  const sources = collectHostSources(join(HOST, 'src'));
  const allText = sources.map((f) => readFileSync(f, 'utf8')).join('\n');
  const bundleText = readFileSync(BUNDLE_PATH, 'utf8');
  const importNames = collectKernelImportNames(sources);
  const aliasMap = buildExportAliasMap();
  const runtimeExports = await loadKernelRuntimeExports();

  const missing = [];
  const checked = [];
  let skippedType = 0;
  let skippedUnused = 0;
  for (const name of importNames) {
    const occurrences = allText.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
    if (occurrences <= 1) {
      skippedUnused += 1; // 只 import 未使用 → esbuild 会 tree-shake，查它必假红
      continue;
    }
    if (runtimeExports !== null && !runtimeExports.has(name)) {
      skippedType += 1; // 纯类型导出，编译期已抹除
      continue;
    }
    checked.push(name);
    const localName = aliasMap.get(name) ?? name; // barrel 别名 → 搜模块内本地名
    if (!containsToken(bundleText, localName)) missing.push(`${name}${localName === name ? '' : `（本地名 ${localName}）`}`);
  }

  if (missing.length > 0) {
    fail(
      `宿主 bundle 缺内核导出符号（bundle 未内联当前内核）\n   ${missing.join(', ')}\n` +
        `   → 重跑宿主构建：cd hosts/memora-vscode && npm run compile`,
    );
  }

  console.log(
    `✅ ${TAG} 宿主 bundle 与内核 dist 同代（hash=${currentHash.slice(0, 12)}）· ` +
      `已核 ${checked.length} 个内核导出符号（跳过纯类型 ${skippedType} 个、未使用 ${skippedUnused} 个，` +
      `别名解析 ${aliasMap.size} 条）`,
  );
}

main().catch((err) => {
  console.error(`❌ ${TAG} 脚本自身异常：${err.stack ?? err}`);
  process.exit(2);
});
