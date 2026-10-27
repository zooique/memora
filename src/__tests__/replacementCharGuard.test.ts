/**
 * 替换字符（U+FFFD）守卫——全仓文本文件禁含 Unicode 替换字符（乱码）
 *
 * **实证背景**（2026-10-27）：随包文档与源码脱钩一批的核查中发现 4 处存量 U+FFFD
 * 乱码（src/agent/textSanitize.ts 生产注释、宿主 chatView.ts 注释、tasks/archive/4.0.0-kernel.md、
 * docs/方案-后台任务跨轮存活-20261004.md）。git 溯源证实均 born corrupt（文件入仓即带），
 * 原文不可从 VCS 恢复，只能语义重构。其中生产注释处会随编译进 dist .js 出货
 * （tsconfig 无 removeComments）⇒ 乱码直接进发布物。
 *
 * **为什么值得单独立门**：乱码是「没有任何测试会红」的伤（读者肉眼可见、机器不报错），
 * 与措辞折叠同族——只能靠扫描门拦。U+FFFD 是解码器对非法字节的**替换占位符**，
 * 出现在源文件里即意味着该处文本在某次转码中损坏过。
 *
 * **判据**：文本文件（SCAN_EXTS 后缀）以 UTF-8 解码后含 U+FFFD 即违例，零豁免。
 *
 * **排除集同源**：SKIP_DIRS / SCAN_EXTS 与 `scripts/scan-phrase-class.ts` 保持同一集合，
 * 并由本文件的「同源契约测试」机器校验——防双写漂移（同一事实两处登记必漂移）。
 *
 * **防恒绿三件套**：① 判据自检（注入探针必须被检出、干净文本不得误抓）；
 * ② 扫描面下限断言（文件/行数塌陷即红，防空集假绿）；③ 隔离变异验证见台账收据
 * （临时注入含 U+FFFD 的文件 → 守卫报红 → 删除恢复）。
 *
 * **自污染防线**：本文件内的替换字符一律写 ASCII 转义 `\uFFFD`，不落字面字符
 * （落了则守卫文件自身即违例）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件位于 src/__tests__ 下，向上两级） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 扫描真源文件：排除集/后缀集的同源契约对象（读其源码字面量做比对） */
const SCAN_PHRASE_SRC = join(ROOT, 'scripts', 'scan-phrase-class.ts');

/**
 * 排除目录：依赖 / 版本库 / 构建产物 / 覆盖率 / 工具内部状态 / 宿主持久化。
 * 与 `scan-phrase-class.ts` 的 SKIP_DIRS 同源（契约测试锁定）。
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.workbuddy', '.memora']);

/**
 * 参与扫描的文本后缀：短语/乱码可落在代码、文档、配置、样式里。
 * 与 `scan-phrase-class.ts` 的 SCAN_EXTS 同源（契约测试锁定）。
 */
const SCAN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.cjs',
  '.mjs',
  '.json',
  '.md',
  '.html',
  '.css',
  '.vue',
  '.yml',
  '.yaml',
]);

/**
 * 判据字符：U+FFFD REPLACEMENT CHARACTER。
 * 源文件内一律用 ASCII 转义序列书写——字面字符若写进本文件，守卫自身即成违例。
 */
const REPLACEMENT_CHAR = '\uFFFD';

/** 扫描面下限（2026-10-27 实测 843 文件 / 254,051 行；取单调安全下限，正常增删不会跌破） */
const MIN_FILES = 400;
/** 扫描行数下限（同上实测；与 MIN_FILES 双指标防「文件在但读空」式塌陷） */
const MIN_LINES = 50_000;

/**
 * 递归收集待扫文本文件（跳过 SKIP_DIRS；按 SCAN_EXTS 过滤后缀）
 * @param dir 当前目录（绝对路径）
 * @param out 累积结果数组
 * @returns 全部待扫文件的绝对路径列表
 */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collect(full, out);
    } else if (SCAN_EXTS.has(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 判据：文本是否含替换字符（探针自检与主扫描**共用同一函数**，
 * 杜绝「自检走 A 判据、主扫描走 B 判据」的脱钩假绿）
 * @param text 待检文本（UTF-8 解码后）
 * @returns true = 含 U+FFFD
 */
function hasReplacementChar(text: string): boolean {
  return text.includes(REPLACEMENT_CHAR);
}

describe('U+FFFD 乱码守卫', () => {
  it('判据自检：注入探针必须被检出、干净文本与转义写法不得误抓（防恒绿）', () => {
    // 正向：注入真实替换字符（运行时由转义生成，不落字面字符进源码）
    expect(
      hasReplacementChar(`乱码探针${REPLACEMENT_CHAR}尾`),
      '判据失明：注入的 U+FFFD 探针未被检出，主扫描的「0 命中」不可信',
    ).toBe(true);
    // 反向：正常中文文本不得误抓
    expect(
      hasReplacementChar('这是一行与乱码无关的干净文本'),
      '判据过宽：干净文本被误判为含替换字符',
    ).toBe(false);
    // 反向：源码里的 ASCII 转义写法（六个字符 \uFFFD）不是乱码，不得命中
    expect(
      hasReplacementChar('源码中书写 \\uFFFD 转义序列不构成乱码'),
      '判据误把 ASCII 转义序列当字面替换字符',
    ).toBe(false);
  });

  it('同源契约：SKIP_DIRS / SCAN_EXTS 与 scan-phrase-class.ts 字面量一致（防双写漂移）', () => {
    const src = readFileSync(SCAN_PHRASE_SRC, 'utf8');
    // 从真源提取两个 Set 字面量的元素（提取失败即响亮报红，不静默放行）
    const extractSet = (name: string): string[] => {
      const m = src.match(new RegExp(`${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
      expect(
        m,
        `scripts/scan-phrase-class.ts 中未找到 ${name} 的 Set 字面量——` +
          '同源契约无法核对，须同步更新本守卫的对应集合',
      ).toBeTruthy();
      // noUncheckedIndexedAccess：捕获组取出的内容可能为 undefined，必须显式守卫（空字面量即契约失明）
      const body = (m as RegExpMatchArray)[1];
      if (!body) {
        throw new Error(
          `scripts/scan-phrase-class.ts 中 ${name} 的 Set 字面量为空——同源契约无法核对，须同步更新本守卫`,
        );
      }
      return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
    };
    expect(
      [...SKIP_DIRS].sort(),
      'SKIP_DIRS 已与 scan-phrase-class.ts 漂移——两处排除集必须同源（改一处必须同步另一处）',
    ).toEqual(extractSet('SKIP_DIRS').sort());
    expect(
      [...SCAN_EXTS].sort(),
      'SCAN_EXTS 已与 scan-phrase-class.ts 漂移——两处后缀集必须同源（改一处必须同步另一处）',
    ).toEqual(extractSet('SCAN_EXTS').sort());
  });

  it('全仓文本文件零 U+FFFD（扫描面下限 + 零违例）', () => {
    const files = collect(ROOT);
    const offenders: string[] = [];
    let lines = 0;
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue; // 读不动（权限等）就跳过，不因单文件中断整轮（同 scan-phrase 口径）
      }
      const rel = relative(ROOT, file).split('\\').join('/');
      const ls = text.split(/\r?\n/);
      lines += ls.length;
      ls.forEach((line, i) => {
        if (hasReplacementChar(line)) {
          // 只报位置与字符计数，不回显原文行（乱码原文无信息量，且避免报告本身携带违例字符）
          const count = [...line].filter((c) => c === REPLACEMENT_CHAR).length;
          offenders.push(`${rel}:${i + 1}（${count} 个 U+FFFD）`);
        }
      });
    }
    // 扫描面下限：路径漂移 / 递归失效导致空集假绿时立即红
    expect(
      files.length,
      `扫描文件数 ${files.length} 低于下限 ${MIN_FILES}——守卫的路径或排除集已塌陷`,
    ).toBeGreaterThan(MIN_FILES);
    expect(lines, `扫描行数 ${lines} 低于下限 ${MIN_LINES}——守卫的收集器已读空`).toBeGreaterThan(
      MIN_LINES,
    );
    expect(
      offenders,
      `以下位置含 U+FFFD 替换字符（乱码，多为转码损坏残留；生产注释会随编译进 dist）：\n` +
        `${offenders.join('\n')}\n` +
        '修法：按语义重构恢复上下文（born corrupt 原文不可从 VCS 恢复），并在台账登记原词不可考。',
    ).toEqual([]);
  });
});
