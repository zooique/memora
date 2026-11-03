#!/usr/bin/env node
/**
 * 模态确认框闸：窄闸（禁自拼取消项）+ 严闸（modal: true 只许出现在 helper 内）
 * （`MODAL-DUP-CANCEL-1`：第一段窄闸 + 第二段严闸）
 *
 * ## 判据（窄）
 * 生产代码（`hosts/<宿主>/src`，排除 `__tests__`）中任何 `showWarningMessage` /
 * `showInformationMessage` / `showErrorMessage` 调用，**只要带 `modal: true`**，
 * 则 options 对象之后的 item 区域**不得**出现 `'取消'` / `"取消"` / `'Cancel'` 字面量。
 *
 * ## 为什么是这条
 * VS Code 在 `{ modal: true }` 时自动追加一个系统级 Cancel（Esc / 关 X 同源，解析为
 * `undefined`）。调用点再自己传一个「取消」，屏幕就变成 `[确认] [取消] [取消]`
 * （2026-11-03 用户真机截图实锤）。此闸拦「新增 / 改动引入的双取消」。
 *
 * ## 判据（严）
 * 生产代码（同上射程）中 `modal: true` **只许出现在** `host/ui/confirmModal.ts` 内部。
 * 任何其它文件出现该字面量即违规——这是「唯一入口」的机器化判据：新增模态确认必须
 * 改调 helper，不允许再自开一个 `showWarningMessage(..., { modal: true }, ...)`。
 *
 * 为什么窄闸单独不够：窄闸按字面量 grep 找「取消」项，`const CANCEL = '取消'` 再传变量、
 * 或把取消项拼进模板串都能绕过；严闸不看取消项写法，只看「是否绕开 helper」，从结构上
 * 堵住这类绕过。
 *
 * ## 退出码
 * 0 = 全过；1 = 发现违规（逐条打印 `文件:行` 与命中片段）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本脚本位于 <root>/scripts/） */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 扫描根（宿主生产代码；新增宿主时在此追加） */
const SCAN_ROOTS = ['hosts/memora-vscode/src'];

/** 不扫的目录名（测试、依赖、产物） */
const SKIP_DIR_NAMES = new Set(['__tests__', 'node_modules', 'dist']);

/** modal 调用 + item 区域的判据 */
const CALL_PATTERN = /show(?:Warning|Information|Error)Message\s*\(/g;
const MODAL_PATTERN = /modal\s*:\s*true/;
const CANCEL_ITEM_PATTERN = /['"`](?:取消|Cancel)['"`]/i;

/** 严闸唯一允许出现 `modal: true` 的文件（相对仓库根，正斜杠） */
const CONFIRM_MODAL_REL = 'hosts/memora-vscode/src/extension/host/ui/confirmModal.ts';

/**
 * 去掉行注释与块注释（严闸只看代码，避免把注释里的示例当成真实调用）
 *
 * @param text 源文本
 * @returns 去掉注释后的文本
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')) // 保留换行，行号不漂
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * 递归收集待扫描的 `.ts` 文件（只收生产代码）
 *
 * @param dir 绝对目录
 * @param acc 结果收集器
 */
function collectTsFiles(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      collectTsFiles(join(dir, entry.name), acc);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) acc.push(join(dir, entry.name));
  }
}

/**
 * 从 `(` 的位置向后找配对的 `)`（跳过字符串 / 模板串里的括号）
 *
 * @param text 源文本
 * @param openIndex `(` 的下标
 * @returns 配对 `)` 的下标；未配对返回 -1
 */
function findCallEnd(text, openIndex) {
  let depth = 1;
  /** 当前是否处于字符串内（记录引号类型） */
  let quote = null;
  for (let i = openIndex + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1; // 跳过转义字符
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 违规清单（元素 = { kind, file, line, snippet, item? }） */
const violations = [];

/** helper 内 `modal: true` 的代码出现次数（严闸正向计数） */
let helperModalCount = 0;

/** helper 内 `modal: true` 所在行号（去重后打印，证明命中是代码而非注释） */
const helperModalLines = new Set();

/** 扫描到的文件数（打印用） */
let scannedFileCount = 0;

for (const rootRel of SCAN_ROOTS) {
  const files = [];
  collectTsFiles(join(ROOT, rootRel), files);
  scannedFileCount += files.length;

  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    const rel = relative(ROOT, file).replace(/\\/g, '/');

    // 严闸：modal: true 只许出现在 confirmModal.ts 内部（注释里的示例不算调用）
    const codeText = stripComments(text);
    const modalHits = [...codeText.matchAll(/modal\s*:\s*true/g)];
    if (rel === CONFIRM_MODAL_REL) {
      helperModalCount += modalHits.length;
      for (const hit of modalHits) {
        const index = hit.index ?? 0;
        helperModalLines.add(codeText.slice(0, index).split('\n').length);
      }
    } else if (modalHits.length > 0) {
      // 逐处登记（同一文件多处调用要能一次看全，便于按清单收口）
      for (const hit of modalHits) {
        const index = hit.index ?? 0;
        const line = codeText.slice(0, index).split('\n').length;
        violations.push({
          kind: 'strict',
          file: rel,
          line,
          snippet: text.split('\n')[line - 1]?.trim() ?? '',
        });
      }
    }

    CALL_PATTERN.lastIndex = 0;
    for (let match = CALL_PATTERN.exec(text); match; match = CALL_PATTERN.exec(text)) {
      const openIndex = match.index + match[0].length - 1;
      const endIndex = findCallEnd(text, openIndex);
      if (endIndex === -1) continue;
      const callText = text.slice(match.index, endIndex + 1);
      if (!MODAL_PATTERN.test(callText)) continue; // 非 modal，不在本闸射程

      // item 区域 = options 对象结束 `}` 之后（避开 message 正文里可能出现的「取消」字样）
      const modalIndex = callText.search(MODAL_PATTERN);
      const braceEnd = callText.indexOf('}', modalIndex);
      const itemsRegion = braceEnd === -1 ? callText : callText.slice(braceEnd + 1);
      const hit = CANCEL_ITEM_PATTERN.exec(itemsRegion);
      if (!hit) continue;

      const line = text.slice(0, match.index).split('\n').length;
      const snippet = callText.split('\n')[0].trim();
      violations.push({
        kind: 'narrow',
        file: rel,
        line,
        snippet,
        item: itemsRegion.slice(hit.index, hit.index + 8).trim(),
      });
    }
  }
}

if (violations.length > 0) {
  const narrow = violations.filter((v) => v.kind === 'narrow');
  const strict = violations.filter((v) => v.kind === 'strict');
  if (narrow.length > 0) {
    console.error(
      `[modal-cancel] ❌ 窄闸：发现 ${narrow.length} 处 modal 调用自拼取消项（modal 自带 Cancel，再传必现双取消）：`,
    );
    for (const v of narrow) {
      console.error(`  - ${v.file}:${v.line}  ${v.snippet}  → 命中 ${v.item}`);
    }
  }
  if (strict.length > 0) {
    console.error(
      `[modal-cancel] ❌ 严闸：发现 ${strict.length} 处绕过 helper 的 modal: true（唯一入口 = ${CONFIRM_MODAL_REL}）：`,
    );
    for (const v of strict) {
      console.error(`  - ${v.file}:${v.line}  ${v.snippet}`);
    }
  }
  console.error(
    '[modal-cancel] 修法：改调 host/ui/confirmModal.js（只传确认项，取消交给系统 Cancel）。',
  );
  process.exit(1);
}

if (helperModalCount === 0) {
  console.error(
    `[modal-cancel] ❌ 严闸：未在 ${CONFIRM_MODAL_REL} 内找到 modal: true —— helper 被移除或射程文件改名，本闸已失去判据，先修闸再放行。`,
  );
  process.exit(1);
}

console.log(
  `[modal-cancel] ✅ 扫描 ${scannedFileCount} 个生产文件；严闸：代码级 modal: true 仅 ` +
    `${CONFIRM_MODAL_REL}:${[...helperModalLines].join(',')}（${helperModalCount} 个字面量 / 同一行三元分支）；` +
    `窄闸：0 处自拼取消项`,
);
