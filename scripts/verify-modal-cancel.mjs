#!/usr/bin/env node
/**
 * 窄闸：模态调用点禁止自拼「取消」项（`MODAL-DUP-CANCEL-1` 第一段）
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
 * ## 为什么不上严闸
 * 「生产代码 `modal: true` 只许出现在 `confirmModal.ts`」是第二段的严闸：一上就会把
 * 剩余 12 处既存调用点（不传取消项、行为正确）全部判红。严闸待第二段 14 处收口时再上，
 * 见台账 `MODAL-DUP-CANCEL-1`。
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

/** 违规清单（元素 = { file, line, snippet }） */
const violations = [];

/** 扫描到的 modal 调用点数（打印用） */
let modalCallCount = 0;

/** 扫描到的文件数（打印用） */
let scannedFileCount = 0;

for (const rootRel of SCAN_ROOTS) {
  const files = [];
  collectTsFiles(join(ROOT, rootRel), files);
  scannedFileCount += files.length;

  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    CALL_PATTERN.lastIndex = 0;
    for (let match = CALL_PATTERN.exec(text); match; match = CALL_PATTERN.exec(text)) {
      const openIndex = match.index + match[0].length - 1;
      const endIndex = findCallEnd(text, openIndex);
      if (endIndex === -1) continue;
      const callText = text.slice(match.index, endIndex + 1);
      if (!MODAL_PATTERN.test(callText)) continue; // 非 modal，不在本闸射程
      modalCallCount += 1;

      // item 区域 = options 对象结束 `}` 之后（避开 message 正文里可能出现的「取消」字样）
      const modalIndex = callText.search(MODAL_PATTERN);
      const braceEnd = callText.indexOf('}', modalIndex);
      const itemsRegion = braceEnd === -1 ? callText : callText.slice(braceEnd + 1);
      const hit = CANCEL_ITEM_PATTERN.exec(itemsRegion);
      if (!hit) continue;

      const line = text.slice(0, match.index).split('\n').length;
      const snippet = callText.split('\n')[0].trim();
      violations.push({
        file: relative(ROOT, file),
        line,
        snippet,
        item: itemsRegion.slice(hit.index, hit.index + 8).trim(),
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    `[modal-cancel] ❌ 发现 ${violations.length} 处 modal 调用自拼取消项（modal 自带 Cancel，再传必现双取消）：`,
  );
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line}  ${v.snippet}  → 命中 ${v.item}`);
  }
  console.error(
    '[modal-cancel] 修法：改调 host/ui/confirmModal.js（只传确认项，取消交给系统 Cancel）。',
  );
  process.exit(1);
}

console.log(
  `[modal-cancel] ✅ 扫描 ${scannedFileCount} 个生产文件 / ${modalCallCount} 处 modal 调用，未发现自拼取消项`,
);
