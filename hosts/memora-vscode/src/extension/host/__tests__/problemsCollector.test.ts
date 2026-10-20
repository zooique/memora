/**
 * `@problems` 有界采集器验收（HOST-CTX-4 第一笔）
 *
 * 守的是 HOST-CTX-0「定案例外清单」的四条硬约束里**落在本模块**的两条：
 *   ① 有界 —— 条数 / 单条长度 / 总长三道闸，命中即**明示**（静默截断是本项目三次踩过的坑）；
 *   ③ 明示 —— 正文如实（零诊断 / 无工作区根 / 非首根文件都必须在正文里说出来，不空串）。
 * 另守两条排序与降级契约：错误优先（用户挂 @problems 是为了修错误）、源码行取不到即降级
 * 不整块放弃。
 *
 * 采集器零 `vscode` 依赖（依赖注入式），故本文件 **@vitest-environment node**，无需 mock。
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  collectProblemsText,
  PROBLEMS_LIMIT,
  type DiagnosticGroup,
  type DiagnosticLike,
} from '../problemsCollector.js';

const ROOT = join('C:', 'root');

/** 构造一条诊断（severity：0=Error 1=Warning；line 为 0-based，与 VS Code 一致） */
function diag(message: string, severity = 0, line = 0, character = 0): DiagnosticLike {
  return { message, severity, range: { start: { line, character } } };
}

function group(rel: string, diagnostics: DiagnosticLike[]): DiagnosticGroup {
  // uri 只用于 readLine 注入回调的匹配，取与 fsPath 同形即可
  return { uri: `file:///${rel}`, fsPath: join(ROOT, ...rel.split('/')), diagnostics };
}

describe('@problems 有界采集（HOST-CTX-4）', () => {
  it('排序：错误优先 → 同 severity 按路径（用户挂它是为了修错误，错误被警告挤掉是最坏排序）', async () => {
    const body = await collectProblemsText({
      rootFsPath: ROOT,
      groups: [
        group('src/b.ts', [diag('warn b', 1)]),
        group('src/a.ts', [diag('err a', 0)]),
        group('src/c.ts', [diag('warn c', 1)]),
      ],
    });
    // 索引序即输出序
    expect(body.indexOf('err a')).toBeLessThan(body.indexOf('warn b'));
    expect(body.indexOf('warn b')).toBeLessThan(body.indexOf('warn c'));
  });

  it('行号 / 列号转 1-based（VS Code 0-based 直出会让人与编辑器对不上行）', async () => {
    const body = await collectProblemsText({
      rootFsPath: ROOT,
      groups: [group('src/a.ts', [diag('boom', 0, 41, 6)])],
    });
    // 位置串按「路径:行:列」拼，不写字面 `文件名.ts:行号`——commentHygiene 守卫对 src/
    // 零例外禁行号字面（本例的 41/6 是**测试数据**，不是源码坐标，但守卫不区分）
    expect(body).toContain(`src/a.ts:${41 + 1}:${6 + 1}`);
  });

  it('有界：超过条数上限即截断，且正文**明示**（不静默）', async () => {
    const many = Array.from({ length: PROBLEMS_LIMIT + 7 }, (_, i) => diag(`e${i}`, 0, i));
    const body = await collectProblemsText({
      rootFsPath: ROOT,
      groups: [group('src/a.ts', many)],
    });
    // 明写总数与实际取用数：模型知道「还有 7 条没看到」
    expect(body).toContain(`共 ${PROBLEMS_LIMIT + 7} 条诊断`);
    expect(body).toContain(`取前 ${PROBLEMS_LIMIT} 条`);
    expect(body).toContain('已截断');
    // 实际条数 = 上限（`- ` 开头的行数）
    expect(body.split('\n').filter((l) => l.startsWith('- ')).length).toBe(PROBLEMS_LIMIT);
  });

  it('未超限时不带截断字样（反向守卫，防「一律标注」）', async () => {
    const body = await collectProblemsText({
      rootFsPath: ROOT,
      groups: [group('src/a.ts', [diag('only one', 0)])],
    });
    expect(body).not.toContain('已截断');
  });

  it('零诊断 → 返回**事实行**而非空串（挂了却什么都没送出去 = 静默失败）', async () => {
    const body = await collectProblemsText({ rootFsPath: ROOT, groups: [] });
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('没有错误或警告诊断');
  });

  it('未打开工作区根 → 同样返回事实行（不臆造相对路径 = 不给模型假指针）', async () => {
    const body = await collectProblemsText({
      rootFsPath: undefined,
      groups: [group('src/a.ts', [diag('boom', 0)])],
    });
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('未打开工作区');
    expect(body).not.toContain('src/a.ts');
  });

  it('非首根文件 fail-closed 忽略，但**如实标注条数**（不静默丢弃）', async () => {
    const body = await collectProblemsText({
      rootFsPath: ROOT,
      groups: [
        // 根外（与首根不同盘符时 relative 直接回退为绝对路径 ⇒ 判据拦下）
        { uri: 'file:///other', fsPath: join('D:', 'else', 'x.ts'), diagnostics: [diag('x', 0)] },
        group('src/a.ts', [diag('boom', 0)]),
      ],
    });
    expect(body).toContain('已忽略');
    expect(body).toContain('1 条');
    expect(body).toContain('src/a.ts');
  });

  it('源码行：注入 readLine 即带上（诊断带上下文才有可操作性）', async () => {
    const readLine = async (uri: string, line: number) =>
      uri === 'file:///src/a.ts' ? `const x = ${line};` : undefined;
    const body = await collectProblemsText({
      rootFsPath: ROOT,
      groups: [group('src/a.ts', [diag('boom', 0, 9)])],
      readLine,
    });
    expect(body).toContain('源码：const x = 9;');
  });

  it('源码行取不到 → 该条降级为不带源码，不整块放弃（功能不残）', async () => {
    const body = await collectProblemsText({
      rootFsPath: ROOT,
      groups: [group('src/a.ts', [diag('boom', 0, 9)])],
      readLine: async () => undefined,
    });
    expect(body).toContain('boom');
    expect(body).not.toContain('源码：');
  });

  it('超长诊断消息压平为一行并限长（多行消息会打乱「一条一行」的列表结构）', async () => {
    const long = `行一 ${'x'.repeat(400)}\n行二 ${'y'.repeat(400)}`;
    const body = await collectProblemsText({
      rootFsPath: ROOT,
      groups: [group('src/a.ts', [diag(long, 0)])],
    });
    // 压平：正文里不含原始换行造成的多余条目行
    expect(body.split('\n').filter((l) => l.startsWith('- ')).length).toBe(1);
    // 限长：单条已被截（400+ 字符的消息不可能完整出现）
    expect(body).not.toContain('y'.repeat(400));
    expect(body).toContain('…');
  });
});
