/**
 * package.json#contributes ↔ 源码守卫（真源对拍：声明面 / 注册面）
 *
 * 守卫对象：命令 id 的三处物理存在（package.json 声明 / `registerCommand` 注册 / 代码常量）
 * 之间的漂移——三者无法靠单一真理源消灭（JSON 无法 import），只能靠**守卫**钉死一致。
 * 每一类漂移都**静默**：漏贡献 = 命令面板看不见；漏注册 = 按键无反应无报错；
 * 漏键位 = 高频命令只能靠鼠标。无任何类型系统能拦，全靠本文件。
 *
 * 对拍面有四（缺一即半守卫）：
 *   - `commands`：对外命令（状态栏 / 对话区常驻条 / 命令面板 / **编辑器标题栏**）**必须**已贡献；
 *     块级命令（需「路径 + 块指纹」两个参数）**必须不**贡献——暴露到命令面板会得到
 *     无参调用而静默失败（见 `fileChangeView` 中两个 HUNK 常量的注释）。
 *   - `menus`：标题栏按钮必须挂菜单且带 `when`（见下方「标题栏菜单守卫」）。
 *   - `keybindings`：绑定命令必须已贡献（未贡献命令按键静默无效）；块级 hunk 命令
 *     **禁配键**（同「必须不贡献」，无参调用必然静默失败）；`memora.open` 默认键
 *     锁值（HOST-KB-1，改键位 = 显式契约变更，须同步改此断言）。
 *   - `registerCommand` 注册面：贡献的必须已注册、注册的必须已贡献（两个 hunk 命令
 *     显式豁免）——改名 / 漏注册时前三面全绿、按键静默失效，只有这面能红
 *     （见下方「注册面守卫」）。
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

import { readFileSync, readdirSync } from 'node:fs';
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
 * explorer/context 菜单 `when` 守卫（随 addToChat / registerWork 收口新增，2026-10-19）
 *
 * 两个根因错位（均无类型系统可拦，只能靠对拍钉死）：
 *   ① `memora.registerWork` 是文件专用命令（`readFile` 对目录抛 EISDIR，被 try/catch 吞成
 *      含糊「登记失败：<errno>」）——其 `when` **必须**含 `!explorerResourceIsFolder`，否则
 *      文件夹右键会暴露该入口、运行时才失败（契约错位型 latent bug，已实锤并修）。
 *   ② `memora.addToChat` 设计面**同时支持**文件与目录（仅挂引用、不注入内容），
 *      其 `when` **不得**含 `!explorerResourceIsFolder`——否则目录引用入口被误删。
 *  两条断言互为镜像：任一命令 `when` 写反都会红，把「准入判据 ↔ 命令契约」钉死。
 */
describe('explorer/context 菜单 when ↔ 命令契约（文件/目录准入）', () => {
  const explorerContext = pkg.contributes?.menus?.['explorer/context'] ?? [];

  const findWhen = (command: string): string | undefined =>
    explorerContext.find((entry) => entry.command === command)?.when;

  it('memora.registerWork 仅对文件出现，when 必须排除文件夹（否则目录右键暴露入口→运行时失败）', () => {
    const when = findWhen('memora.registerWork');
    expect(when).toBeDefined();
    expect(when).toContain('!explorerResourceIsFolder');
  });

  it('memora.addToChat 同时支持文件与目录，when 不得排除文件夹（否则目录引用入口被误删）', () => {
    const when = findWhen('memora.addToChat');
    expect(when).toBeDefined();
    expect(when).not.toContain('!explorerResourceIsFolder');
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

/** 包根目录（本文件位于 `<pkg>/src/extension/host/__tests__/` ⇒ 上溯四层） */
const PKG_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../');

/** `registerCommand` 调用点已登记的源文件（全库第三处出现 = 扫描盲区，须先登记再断言） */
const REGISTER_SOURCES = [
  resolve(PKG_ROOT, 'src/extension/extension.ts'),
  resolve(PKG_ROOT, 'src/extension/host/fileChangeView.ts'),
];

/** 注册豁免：两个块级 hunk 命令刻意不贡献（CodeLens 带参调用，暴露即静默失败） */
const INTERNAL_ONLY_COMMANDS = new Set([CONFIRM_HUNK_COMMAND, REJECT_HUNK_COMMAND]);

/**
 * 递归收集 `src/` 下全部 `.ts` 源文件（排除测试目录——mock 里的 `registerCommand`
 * 是对象属性不是调用点，计入即误报）
 */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') collectSourceFiles(fullPath, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
  return out;
}

/**
 * 注册面守卫（第四对拍面）
 *
 * 前三面全钉在 `package.json` 声明侧，**看不见 `registerCommand` 注册侧**：改名 /
 * 漏注册时贡献面、键位面照样全绿，按命令面板条目或快捷键却无任何反应、无报错
 * （漂移静默发生，且恰好在真机点验时才暴露）。本面补上注册侧对拍：
 *   ① 调用点文件范围先钉死——提取逻辑只认登记过的两个文件，第三处出现即红，
 *      防「新文件里注册的新命令」绕过下面全部断言（扫描盲区型假阴性）；
 *   ② 声明了未注册 ⇒ 命令面板可见但按了没反应；
 *   ③ 注册了未声明 ⇒ 代码能跑但用户永远够不着（豁免 = 两个 hunk 内部命令）。
 */
describe('registerCommand 注册面 ↔ package.json#contributes', () => {
  // 注册点一：extension.ts 直接用字面量注册
  const extensionSrc = readFileSync(REGISTER_SOURCES[0], 'utf-8');
  const literalIds = [...extensionSrc.matchAll(/registerCommand\(\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );

  // 注册点二：fileChangeView.ts 用常量注册（常量值另取自同文件 const 定义，非常量形态即解析失败）
  const viewSrc = readFileSync(REGISTER_SOURCES[1], 'utf-8');
  /** 常量名 → 命令 id 映射（`const XXX_COMMAND = 'memora.…'` 形态） */
  const constantTable = new Map(
    [...viewSrc.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  /** 调用点引用的常量名（形如 `registerCommand(\n  REVIEW_…`，允许跨行） */
  const constantRefs = [...viewSrc.matchAll(/registerCommand\(\s*([A-Za-z_$][\w$]*)/g)].map(
    (match) => match[1],
  );
  /** 解析失败的调用点（用了非常量标识符 ⇒ 提取对它失明，必须红） */
  const unresolvedRefs = constantRefs.filter((name) => !constantTable.has(name));

  /** 注册面全集 = 字面量注册 ∪ 常量注册 */
  const registered = new Set([...literalIds, ...constantRefs.map((n) => constantTable.get(n)!)]);
  /** 声明有、注册无（命令面板条目按了没反应） */
  const declaredButNotRegistered = [...contributed].filter((id) => !registered.has(id));
  /** 注册有、声明无、且不在豁免表（用户永远够不着的孤儿命令） */
  const registeredButNotDeclared = [...registered].filter(
    (id) => !contributed.has(id) && !INTERNAL_ONLY_COMMANDS.has(id),
  );

  it('调用点只出现在已登记文件（第三处出现 = 扫描盲区，红灯强制先登记）', () => {
    // 含 registerCommand( 调用的源文件集合，必须恰好等于登记表——
    // 多一个 = 新文件绕过提取（盲区）；少一个 = 登记表腐烂（僵尸条目）
    const callSites = collectSourceFiles(resolve(PKG_ROOT, 'src')).filter((file) =>
      /registerCommand\s*\(/.test(readFileSync(file, 'utf-8')),
    );
    expect([...callSites].sort()).toEqual([...REGISTER_SOURCES].sort());
  });

  it('提取零漏（字面量与常量两条提取路径都有产出，无解析失败的调用点）', () => {
    expect(literalIds.length).toBeGreaterThan(0);
    expect(constantRefs.length).toBeGreaterThan(0);
    expect(unresolvedRefs).toEqual([]);
  });

  it('贡献的每条命令均已注册（声明未注册 = 命令面板/键位静默无效）', () => {
    expect(declaredButNotRegistered).toEqual([]);
  });

  it('注册的每条命令均已贡献（豁免仅两个 hunk 内部命令）', () => {
    expect(registeredButNotDeclared).toEqual([]);
  });
});
