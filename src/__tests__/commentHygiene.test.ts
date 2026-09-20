/**
 * 注释定位守卫（内核侧 · COMMENT-HYG-1 Step 2）——禁止注释里的「文件.扩展名:行号」形式引用
 *
 * **实证背景（Step 1 清零，2026-09-20）**：内核 src/ 原有 15 处跨文件行号引用，逐个复核后
 * **全部**存在漂移或语义错位——其中 3 处指向**物理不存在的位置**（所引行号超出被引文件总行数）、
 * 1 处**文件归属亦错**（真实落点在另一模块）、1 处引用的是**全仓零定义的幽灵符号**；
 * 裸行号形式的漂移幅度达数百行。
 * **根因**：行号**没有 SSOT**（项目纪律：数字与行号每修一次即过期），而增删代码是日常动作
 * → 失效是**必然**而非偶然。这类注释比「不写」更糟——它让读者**信任一个错误坐标**。
 *
 * **判据（三类形式，零例外）**：跨文件行号引用（路径 + 冒号 + 数字）、以空格分隔的文件名
 * 加行号（样式不同、性质相同）、裸行号（两位及以上数字）。
 * 定位一律改用**符号引用**（函数 / 常量 / 类型名）——符号有 SSOT：重命名会被 tsc 与全库 grep 暴露。
 *
 * **扫描面 = 注释位**（整行注释 / 行尾注释 / 块注释 / JSDoc 续行），**不覆盖代码位**。
 * 这是与宿主侧同名守卫的**关键差异**，源于内核独有的功能特性：项目搜索工具的输出格式断言
 * 本身就是「路径冒号行号」形态，那是**被测数据**而非定位引用。注释位判定 + 零豁免，
 * 比「全位置扫描 + 豁免名单」更可靠——豁免区会累积成盲区。
 *
 * **已知边界（诚实登记，勿默认为已覆盖）**：
 *   · 代码字符串 / 模板串内的行号引用**不在覆盖内**（与内核断言数据同形，机器不可区分）
 *   · 注释识别是**单行**字符串感知扫描，不跟踪跨行块注释与模板串状态；跨行模板串内形如
 *     注释的行若被报出，按「引用」处理（宁可响亮失败，不可静默放过）
 *
 * **本文件自身亦被扫描**——故其说明性文字不使用任何真实行号形态。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 扫描根：src/（内核全部生产与测试源码） */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 判据——三类行号引用形式（见文件头「判据」段）。
 * 裸行号取两位及以上数字：本项目 L0–L3 为记忆层级术语，单数字故不命中。
 */
const LINE_REF = /[\w./-]+\.ts:\d+|[\w./-]+\.ts\sL\d+|(?:^|[^A-Za-z0-9_])L\d{2,}(?![0-9A-Za-z])/;

/** 注释位的四种形态；`code` 表示该行不含注释（其文本不参与判定） */
type CommentKind = 'line' | 'block' | 'jsdoc' | 'trailing' | 'code';

/**
 * 定位行内注释起点（**字符串感知**）：跳过单引号 / 双引号 / 反引号包裹的片段，
 * 只把「字符串之外」的双斜杠视为注释起点。
 *
 * 无此步则 URL 里的双斜杠会被当成注释起点，导致该行注释位文本错位而误报
 * （实测假阳性来源：字符串内含「路径冒号行号」形态的 URL）。
 */
function indexOfCommentStart(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') return i;
  }
  return -1;
}

/** 取出该行「注释位」文本；非注释行返回空串（其内容不参与判定） */
function commentPart(raw: string): { text: string; kind: CommentKind } {
  const line = raw.replace(/\r$/, '');
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//')) return { text: trimmed.slice(2), kind: 'line' };
  if (trimmed.startsWith('/*')) return { text: trimmed, kind: 'block' };
  if (trimmed.startsWith('*')) return { text: trimmed, kind: 'jsdoc' };
  const idx = indexOfCommentStart(line);
  if (idx >= 0) return { text: line.slice(idx + 2), kind: 'trailing' };
  return { text: '', kind: 'code' };
}

/** 递归收集源码（跳过依赖与构建产物目录） */
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

/** 相对 SRC_ROOT 的路径，正斜杠归一（Windows 下 join 产反斜杠） */
const relPath = (f: string): string => f.slice(SRC_ROOT.length + 1).split('\\').join('/');

describe('注释定位守卫：禁止行号引用（行号无 SSOT）', () => {
  it('src/ 注释位无行号引用——定位一律用符号引用', () => {
    const offenders: string[] = [];
    let commentLines = 0;
    for (const file of collectSources(SRC_ROOT)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((raw, idx) => {
          const { text, kind } = commentPart(raw);
          if (!text) return;
          commentLines++;
          const hit = text.match(LINE_REF);
          if (hit) offenders.push(`${relPath(file)}:${idx + 1} [${kind}] → ${hit[0]}`);
        });
    }
    // 非空反向守卫：扫描面塌陷（路径错误 / 递归失效 / 注释识别全判 code）立即红，防「空集假绿」。
    // 阈值为单调安全下限（内核源码行数只增不减，实测注释行数量级远高于此）。
    expect(commentLines, '注释行数为 0——守卫的路径或注释识别已失效').toBeGreaterThan(1000);
    expect(
      offenders,
      `以下位置的注释引用了行号，应改为符号引用（函数 / 常量 / 类型名）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
