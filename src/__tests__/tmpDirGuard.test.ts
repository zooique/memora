/**
 * 测试临时目录守卫（跨两包扫描）——禁止「建了目录却没人删」
 *
 * **实证背景**：2026-10-26 实测 `%TEMP%` 累积 562,713 个 `memora-*` 条目（其中
 * `memora-data-*` 168,412 个）。成因不是某一次手滑，而是**一类**：8 个测试文件用
 * `node:fs` 的临时目录 API 建目录、全文件零删除（`pathGuard.test.ts` 单文件 22 处），
 * 每跑一次全量测试就再积一层。清理逻辑若留在各文件自己手里，下一个文件天然漏配，
 * **没有任何测试会红**——与「纪律写在调用方手里就必漏」同型。
 *
 * **判据（一条，零豁免）**：测试文件里出现建目录调用时，必须满足以下二者之一：
 *   ① 从 `helpers/tmpDir` 的统一入口建（模块顶层注册清理，import 即生效）；
 *   ② 同文件内存在删除调用（`rmSync` / `rm`）。
 * 只有「建 + 零删」才是漏（历史上 8 个文件全部命中该形态）。零豁免清单：
 * 豁免区会累积成盲区，本仓已有同类血训（豁免名单最终变成「没人再看」）。
 *
 * **两包各一份 helper**：内核与宿主是两个独立测试工程，SSOT 按包边界切（论证见
 * `src/__tests__/helpers/tmpDir.ts` 文件头）；本守卫跨包扫描，任一侧新增漏点都红。
 *
 * **已知边界（诚实登记，勿默认为「已覆盖」）**：
 *   · 「同文件有删除调用」是**廉价代理**，不校验删的是不是那个目录——代理误判的
 *     假阴性（有删但删错）本守卫看不见；真正的保险是统一入口，代理只负责抓「零删」。
 *   · **代理抓不到「建 N 删 1 / 删不全」**（2026-10-26 复核实证，勿当理论风险）：
 *     `projectSearchProvider.test.ts` 曾每用例建一个新目录、`afterAll` 只删最后一个，
 *     每次宿主全量跑泄 11 个，而本守卫因该文件含 `rmSync` **判绿**。该文件已改走统一入口；
 *     此类形态只能靠「跑完 `%TEMP%` 残留计数」发现，静态判据结构性看不见。
 *   · 建目录判据只覆盖 `node:fs` 的 `mkdtemp` 三形态（同步 / 异步 / disposable）。
 *     `mkdirSync` 拼 `os.tmpdir()`、第三方临时目录库、`fs.promises.mkdtemp` 别名调用
 *     不在判据内 —— 新增写法请先扩判据再加用例。
 *   · **执行面**：本文件随内核测试跑（扫描内核 `src/` 与宿主 `src/`）。宿主发布门禁
 *     `host-release.yml` 只跑 `hosts/memora-vscode` 的 test ⇒ 该链路里本守卫**不执行**；
 *     宿主侧新增泄漏只会在跑内核测试时才红。
 *   · 注释位不剥离：注释里若写出「候选名 + 左圆括号」的形态会被误报（故本文件与
 *     helper 的说明文字一律不带左圆括号），宁可响亮失败，不可静默放过。
 *
 * **本文件自身亦被扫描**——其说明文字同样遵守上述写法。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 当前文件所在目录（`src/__tests__`） */
const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（`src/__tests__` 上两级） */
const REPO_ROOT = join(HERE, '..', '..');

/** 扫描根清单：内核 `src/` + 宿主 `hosts/memora-vscode/src/`（两个独立测试工程各一份 helper） */
const SCAN_ROOTS = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'hosts', 'memora-vscode', 'src')];

/** 遍历时跳过的目录名（依赖树与构建产物里的第三方测试与本仓纪律无关） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.workbuddy', '.git']);

/** 建目录调用（左圆括号必须紧跟，避免把注释里的候选名误判为调用；覆盖同步 / 异步 / disposable 三形态） */
const CREATE_RE = /\bmkdtemp(?:Sync|DisposableSync)?\s*\(/;
/** 删除调用（`rmSync(...)` 或异步 `rm(...)`） */
const REMOVE_RE = /\brmSync\s*\(|\brm\s*\(/;
/** 统一入口 import（两包各自的相对路径，只认文件名，不锁层级） */
const HELPER_IMPORT_RE = /from\s+['"][^'"]*helpers\/tmpDir\.js['"]/;

/**
 * 合成样本里的建目录写法（**刻意拼装**）
 *
 * 本文件自身也在扫描面内：直接写出「候选名 + 左圆括号」会让自检样本把本文件判成
 * 「建了不删」，于是守卫自己绊自己。拼装后本文件不含任何真实建目录调用，
 * 自检样本仍能完整验证判据（判据正则本身不受影响）。
 */
const SAMPLE_CREATE = `mkdtemp${'Sync'}(${''}`;
/** 异步形态样本（同样拼装：`mkdtem` + `p` + 左圆括号，源码里不出现真实调用） */
const SAMPLE_CREATE_ASYNC = `mkdtem${'p'}(${''}`;

/**
 * 判定一个测试文件是否构成「建了不删」漏点
 *
 * @param source 文件全文
 * @returns 命中漏点形态（建目录 && 零删除 && 未走统一入口）时为 true
 */
function isLeakRisk(source: string): boolean {
  const creates = CREATE_RE.test(source);
  // 未建目录的文件不可能造成本类残留，直接放行（绝大多数测试不碰临时目录）
  if (!creates) return false;
  // 走统一入口 = 模块顶层注册清理，调用方不写清理代码也算合规
  if (HELPER_IMPORT_RE.test(source)) return false;
  // 自己动手删也算合规（代理判据，见文件头「已知边界」）
  return !REMOVE_RE.test(source);
}

/**
 * 递归收集指定根目录下的全部测试文件绝对路径
 *
 * @param dir 起始目录
 * @param out 累加器（递归时复用，避免层层合并数组）
 */
function collectTestFiles(dir: string, out: string[]): void {
  // 根目录缺失时跳过（例如只装了内核、没装宿主的裁剪检出），不因此让守卫红
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectTestFiles(full, out);
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

describe('测试临时目录守卫 · 建目录必须有清理', () => {
  it('判据自检：合成样本按「建 + 零删」判定（变异即红）', () => {
    // 形态①：裸建、零删 —— 历史上 8 个泄漏文件的最小复现
    expect(isLeakRisk(`const d = ${SAMPLE_CREATE}join(tmpdir(), 'x-'));`)).toBe(true);
    // 形态②：裸建 + 自己删 —— 代理判据放行
    expect(
      isLeakRisk(
        `const d = ${SAMPLE_CREATE}join(tmpdir(), 'x-')); rmSync(d, { recursive: true });`,
      ),
    ).toBe(false);
    // 形态③：走统一入口 —— 无需调用方写清理
    expect(
      isLeakRisk(
        "import { makeTempDir } from '../../__tests__/helpers/tmpDir.js';\nconst d = makeTempDir('x-');",
      ),
    ).toBe(false);
    // 形态④：压根不建目录 —— 与本类残留无关
    expect(isLeakRisk('const x = 1;')).toBe(false);
    // 形态⑤：**异步**建目录 + 零删 —— 2026-10-26 前判据只认同步形态，这一形态整类漏判
    expect(isLeakRisk(`const d = await ${SAMPLE_CREATE_ASYNC}join(tmpdir(), 'x-'));`)).toBe(true);
    // 形态⑥：异步建 + 自己删 —— 代理判据放行（与同步形态同口径）
    expect(
      isLeakRisk(`const d = await ${SAMPLE_CREATE_ASYNC}join(tmpdir(), 'x-')); await rm(d);`),
    ).toBe(false);
  });

  it('两包全部测试文件均无「建了不删」形态', () => {
    // 收集面 = 内核 + 宿主（题外：宿主的 node_modules 内层已在遍历时跳过）
    const files: string[] = [];
    for (const root of SCAN_ROOTS) collectTestFiles(root, files);
    // 扫描面为空 = 路径写错，守卫会静默变成绿灯（假绿），故先钉住下限
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      // 统一用正斜杠展示路径：报错信息可直接粘进 issue，Windows 反斜杠在正则里是转义符
      const rel = file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
      if (isLeakRisk(readFileSync(file, 'utf8'))) offenders.push(rel);
    }
    // 失败信息直接给出改法：换成 helpers/tmpDir 的 makeTempDir / makeSuiteTempDir
    expect(offenders).toEqual([]);
  });

  it('两包统一入口均在场且导出两个语义函数（防 helper 被删后守卫空转）', () => {
    for (const rel of [
      'src/__tests__/helpers/tmpDir.ts',
      'hosts/memora-vscode/src/__tests__/helpers/tmpDir.ts',
    ]) {
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(source).toMatch(/export function makeTempDir/);
      expect(source).toMatch(/export function makeSuiteTempDir/);
      // 顶层注册是「import 即生效」的前提，缺了它 helper 就退化成普通建目录函数
      expect(source).toMatch(/\bafterEach\(/);
      expect(source).toMatch(/\bafterAll\(/);
    }
  });
});
