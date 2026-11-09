/**
 * 提交前 lint（staged 限定）——只服务**内核源码**的快速反馈
 *
 * 为什么需要这层包装：`lefthook.yml` 里这条命令在**仓库根**运行，而根 ESLint 配置
 * `ignores: ['hosts/**']` ⇒ 宿主 .ts 文件被静默忽略、`eslint` 以 exit 0 无输出收场，
 * lefthook 照样打 ✔️，读起来像「已经判过」。实测（2026-11-10）：对一支 1005 行
 * （越 `max-lines` 1000）的宿主文件从根跑 `npx eslint <file>` = exit 0 无任何输出。
 *
 * 职责分工（勿折叠成「两边都 lint」）：
 *   - 本脚本 = 内核文件的提交前快反馈（staged 限定，省一次全量）；
 *   - 宿主文件的 lint 判据归 `gate-fast` 的 `host:lint`（cwd 在 `hosts/memora-vscode`，
 *     用宿主自己的 `eslint.config.mjs`）。**覆盖本来没缺**，缺的是「不判就别报通过」。
 *
 * 判据来源单一：不复制 `hosts/**` 字面量，直接问 ESLint 本体 `isPathIgnored`。
 * 用法：node scripts/lint-staged-guard.mjs <staged files...>（由 lefthook 传 `{staged_files}`）
 */
import { ESLint } from 'eslint';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：本脚本位于 <root>/scripts/，故取上一层 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 把 lefthook 传来的路径归一成「相对仓库根、正斜杠」形态
 * （lefthook 传的是相对路径，但手工调试时常传绝对路径，两种都收）
 * @param file 原始路径
 * @returns 相对仓库根的 POSIX 路径
 */
function toRelative(file) {
  const abs = isAbsolute(file) ? file : resolve(ROOT, file);
  return relative(ROOT, abs).split('\\').join('/');
}

/**
 * 主流程：先分流「被根配置忽略的文件」，再只对未被忽略的文件跑一次 lint
 * （刻意**不**为被忽略的文件起第二轮 eslint——那是在用时间买一句「我忽略了它」）
 * @returns 进程退出码：0 = 无问题/全被忽略，1 = 有 error 或 warning
 */
async function main() {
  /** 归一后的 staged 文件清单 */
  const files = process.argv.slice(2).map(toRelative);
  if (files.length === 0) {
    console.log('[lint-staged] skipped (no staged .ts files)');
    return 0;
  }

  /** 以仓库根为 cwd 的 ESLint 实例（配置即根 eslint.config.mjs，不另立判据） */
  const eslint = new ESLint({ cwd: ROOT });
  /** 逐文件问「根配置是否忽略它」——与 lint 判定同源自 ESLint 本体 */
  const ignoredFlags = await Promise.all(files.map((file) => eslint.isPathIgnored(file)));
  /** 真正要判的文件（忽略面之外的） */
  const targets = files.filter((_, index) => !ignoredFlags[index]);

  if (targets.length === 0) {
    // 全部落在根配置 ignores 内 ⇒ 显式说明「没判」，不再让 ✔️ 冒充判过
    console.log(
      '[lint-staged] skipped (ignored by root config; host files are linted by gate-fast)',
    );
    return 0;
  }

  /** ESLint 结果集（targets 均已确认未被忽略） */
  const results = await eslint.lintFiles(targets);
  /** error 计数（与 `--max-warnings 0` 同口径：warning 也算失败） */
  const errorCount = results.reduce((sum, item) => sum + item.errorCount, 0);
  /** warning 计数 */
  const warningCount = results.reduce((sum, item) => sum + item.warningCount, 0);

  if (errorCount + warningCount > 0) {
    /** 人类可读的格式化输出（与 eslint CLI 的 stylish 同形） */
    const formatter = await eslint.loadFormatter('stylish');
    console.log(await formatter.format(results));
    console.error(
      `[lint-staged] ${errorCount} error(s), ${warningCount} warning(s) in ${targets.length} file(s)`,
    );
    return 1;
  }

  console.log(`[lint-staged] ${targets.length} file(s) linted clean`);
  return 0;
}

process.exitCode = await main();
