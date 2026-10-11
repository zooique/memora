/**
 * 文件改动命令 id 守卫（真源对拍：代码常量 ↔ `package.json#contributes`）
 *
 * 守卫对象：`registerCommand` 与 `contributes` 的漂移——代码里 `registerCommand`、
 * 却在 `contributes.commands` 漏声明时，webview 与状态栏都能用，唯独命令面板看不到，
 * 且无任何报错（漂移静默发生）。
 *
 * 命令 id 物理上必然存在两处（TS 常量 + package.json 的 JSON，后者无法 import），
 * 所以无法靠「单一真理源」消灭，只能靠**守卫**钉死二者一致。本用例即那道守卫。
 *
 * 对拍面有三（缺一即半守卫）：
 *   - `commands`：对外命令（状态栏 / 对话区常驻条 / 命令面板 / **编辑器标题栏**）**必须**已贡献；
 *     块级命令（需「路径 + 块指纹」两个参数）**必须不**贡献——暴露到命令面板会得到
 *     无参调用而静默失败（见 `fileChangeView` 中两个 HUNK 常量的注释）。
 *   - `menus`：标题栏按钮必须挂菜单且带 `when`（见下方「标题栏菜单守卫」）。
 *   - `keybindings`：绑定命令必须已贡献（未贡献命令按键静默无效）；块级 hunk 命令
 *     **禁配键**（同「必须不贡献」，无参调用必然静默失败）；`memora.open` 默认键
 *     锁值（HOST-KB-1，改键位 = 显式契约变更，须同步改此断言）。
 *
 * ⚠️ 分类随形态走：文件级按钮放**标题栏**即属「对外命令」——菜单依赖声明才渲染；
 * 放正文 CodeLens 则属「内部命令」。分类不是写死的标签，
 * 是「有没有需要参数的外部入口」的推导结果。
 *
 * 无需模拟 VS Code 运行时：`fileChangeView` 模块顶层已无 `vscode.<成员>` 取值
 * （惰性化见 memora-host-ui-consistency 技能规则 6 ⑤），空 mock 即可安全 import。
 *
 * @module __tests__/fileChangeCommands.test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  REVIEW_FILE_CHANGES_COMMAND,
  CONFIRM_ALL_FILE_CHANGES_COMMAND,
  REVERT_ALL_FILE_CHANGES_COMMAND,
  CONFIRM_FILE_COMMAND,
  RESTORE_FILE_COMMAND,
  CONFIRM_HUNK_COMMAND,
  REJECT_HUNK_COMMAND,
  PENDING_CONTEXT_KEY,
} from '../fileChangeView.js';

/** 本文件位于 `<pkg>/src/extension/host/__tests__/` ⇒ 上溯四层即包根 */
const PACKAGE_JSON = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../package.json',
);

interface MenuEntry {
  command: string;
  when?: string;
}

interface Contributes {
  contributes?: {
    commands?: { command: string }[];
    menus?: Record<string, MenuEntry[]>;
    keybindings?: { command: string; key?: string }[];
  };
}

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as Contributes;
const contributed = new Set((pkg.contributes?.commands ?? []).map((entry) => entry.command));
const editorTitle = pkg.contributes?.menus?.['editor/title'] ?? [];

describe('fileChangeView 命令 id ↔ package.json#contributes.commands', () => {
  it('五个对外命令均已在 package.json 贡献（命令面板 / 标题栏可见）', () => {
    expect(contributed.has(REVIEW_FILE_CHANGES_COMMAND)).toBe(true);
    expect(contributed.has(CONFIRM_ALL_FILE_CHANGES_COMMAND)).toBe(true);
    expect(contributed.has(REVERT_ALL_FILE_CHANGES_COMMAND)).toBe(true);
    expect(contributed.has(CONFIRM_FILE_COMMAND)).toBe(true);
    expect(contributed.has(RESTORE_FILE_COMMAND)).toBe(true);
  });

  it('两个块级命令不贡献（需「路径 + 指纹」参数，无参调用会静默失败）', () => {
    expect(contributed.has(CONFIRM_HUNK_COMMAND)).toBe(false);
    expect(contributed.has(REJECT_HUNK_COMMAND)).toBe(false);
  });
});

/**
 * 标题栏菜单守卫
 *
 * 两条都是**漏声明型**漂移（不报错、只是按钮不出现 / 满屏都是按钮），只能靠对拍发现：
 *   ① 声明了命令但没挂菜单 ⇒ 标题栏没有按钮（用户又回到「找不到按钮」）；
 *   ② 挂了菜单但没写 `when` ⇒ **每个文件**都挂两颗 Memora 按钮（噪音 + 误导）。
 */
describe('文件级按钮 ↔ package.json#menus.editor/title', () => {
  it('两颗文件级按钮都已挂到编辑器标题栏（否则按钮不出现）', () => {
    const ids = editorTitle.map((entry) => entry.command);
    expect(ids).toContain(CONFIRM_FILE_COMMAND);
    expect(ids).toContain(RESTORE_FILE_COMMAND);
  });

  it('两颗按钮都带 `when`（不带 = 每个文件都挂按钮），且用的是同一个上下文键', () => {
    for (const id of [CONFIRM_FILE_COMMAND, RESTORE_FILE_COMMAND]) {
      const entry = editorTitle.find((item) => item.command === id);
      expect(entry).toBeDefined();
      expect(entry?.when).toBe(PENDING_CONTEXT_KEY);
    }
  });
});

/**
 * keybindings 声明面守卫（HOST-KB-1 随批新增）
 *
 * 键位是用户可见契约，两条漏声明型漂移同样静默：绑定到未贡献/未注册的命令
 * = 按键无任何反应且无报错；给块级命令配键 = 无参调用静默失败（同 commands 面红线）。
 */
describe('keybindings ↔ package.json#contributes', () => {
  const bindings = pkg.contributes?.keybindings ?? [];
  const bound = new Set(bindings.map((binding) => binding.command));

  it('每条键位绑定的命令均已贡献（未贡献命令按键静默无效）', () => {
    expect(bindings.length).toBeGreaterThan(0); // 空表会让下句空转，先钉非空
    for (const binding of bindings) {
      expect(contributed.has(binding.command)).toBe(true);
    }
  });

  it('memora.open 默认键锁值 ctrl+alt+m（改键位 = 显式契约变更，须同步改此断言）', () => {
    const open = bindings.find((binding) => binding.command === 'memora.open');
    expect(open?.key).toBe('ctrl+alt+m');
  });

  it('两个块级 hunk 命令禁配键（需「路径 + 指纹」参数，无参调用静默失败）', () => {
    expect(bound.has(CONFIRM_HUNK_COMMAND)).toBe(false);
    expect(bound.has(REJECT_HUNK_COMMAND)).toBe(false);
  });
});
