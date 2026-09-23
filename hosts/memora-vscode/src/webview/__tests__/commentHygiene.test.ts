/**
 * 注释定位守卫——禁止「文件.扩展名:行号」形式的引用
 *
 * **实证依据**：穷举核验 UI 层 5 处跨文件行号引用，**5/5 失效**——被引行号
 * 已漂移到毫不相关的内容：
 *   · 宿主注释引「内核 interject 实现」的行号 → 该行实为 `@param span 可选 tracer span…`
 *   · 测试注释引「宿主播发 done」的行号 → 该行实为 Round 落盘归属注释
 *   · 测试注释引「console.error 唯一来源」的行号 → 该行实为「队伍快照赋值」
 *   · 测试注释引「其余 console.warn 出口」的行号 → 该行实为「可选描述副标题」
 * **根因**：行号**没有 SSOT**（项目纪律：数字与行号每修一次即过期），而增删代码是日常动作
 * → 失效是**必然**而非偶然；这类注释比「不写」更糟——它让读者**信任一个错误坐标**。
 *
 * **判据**：`src/` 下任意位置出现 `<path>.ts:<数字>` 即红。**零例外**——「示例」同样会漂移；
 * 定位一律改用**符号引用**（函数 / 常量 / 类型名。符号有 SSOT：重命名会被 tsc 与全库 grep 暴露）。
 *
 * **边界**：本守卫只覆盖 `src/` 代码；`tasks/` 台账中的行号属**带日期的历史快照**，不在覆盖内
 * （引用前须同批复核，见项目纪律）。本文件自身亦被扫描——故其说明性文字不使用真实行号。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 扫描根：src/（webview · extension · shared 三层同属宿主代码） */
const SRC_ROOT = join(__dirname, '..', '..');

/** 「文件.扩展名:行号」判据——不限注释，字符串与模板串中的同类引用同样会失效，一并拦下 */
const LINE_REF = /[\w./-]+\.ts:\d+/;

/** 相对 SRC_ROOT 的路径，正斜杠归一（Windows 下 join 产反斜杠） */
const relPath = (f: string): string => f.slice(SRC_ROOT.length + 1).split('\\').join('/');

/** 递归收集源码（跳过依赖目录） */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      collectSources(full, out);
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('注释定位守卫：禁止行号引用（行号无 SSOT）', () => {
  it('src/ 下无「文件.扩展名:行号」引用——定位一律用符号引用', () => {
    const offenders: string[] = [];
    let scannedLines = 0;
    for (const file of collectSources(SRC_ROOT)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((raw, idx) => {
          scannedLines++;
          const hit = raw.match(LINE_REF);
          if (hit) offenders.push(`${relPath(file)}:${idx + 1} → ${hit[0]}`);
        });
    }
    // 非空反向守卫：扫描面塌陷（路径错误 / 目录改名）立即红，防「空集假绿」。
    // 阈值为单调安全下限（源码行数只增不减，实测量级远高于此）。
    expect(scannedLines, '扫描行数为 0——守卫的路径或提取逻辑已失效').toBeGreaterThan(1000);
    expect(
      offenders,
      `以下位置引用了行号，应改为符号引用（函数 / 常量 / 类型名）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
