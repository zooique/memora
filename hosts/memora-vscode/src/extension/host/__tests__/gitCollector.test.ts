/**
 * `@git-changes` 有界采集器验收（HOST-CTX-4 第二笔）
 *
 * 守的是 HOST-CTX-0「定案例外清单」四条硬约束里**落在本模块**的部分：
 *   ① 有界 —— 文件数 / 单文件 diff 行数 / 正文总长三道闸，命中即**明示**（静默截断是
 *      本项目三次踩过的坑，故每道闸都配「省略数 / 截断标记」断言）；
 *   ③ 明示 —— 零改动 / 非 git 仓库 / git 缺失 / 段执行失败都必须在正文里说实话，不空串；
 *   信任类 —— 只跑白名单三口、fail-fast（status 失败不碰 diff）。
 * 排序 / 分组契约：已暂存段在未暂存段前（提交候选优先）。
 *
 * 采集器零 `vscode` 依赖（exec 注入式），故本文件 **@vitest-environment node**，无需 mock：
 * 全部用假执行器应答，不真跑 git（宿主侧 spawn 真机属第 3 笔接线 + 真机四态）。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  collectGitChangesText,
  GIT_COMMANDS,
  GIT_DIFF_OUTPUT_ARGS,
  GIT_GLOBAL_ARGS,
  GIT_COMMAND_WHITELIST,
  GIT_FILES_LIMIT,
  GIT_FILE_DIFF_MAX_LINES,
  GIT_BODY_MAX_CHARS,
  type GitExec,
  type GitExecResult,
} from '../gitCollector.js';

/** 记录调用 + 按「命令串 → 应答」脚本应答的假执行器（未命中命令返回空成功） */
function fakeExec(script: Record<string, GitExecResult>): {
  exec: GitExec;
  calls: string[][];
  cwds: (string | undefined)[];
} {
  const calls: string[][] = [];
  const cwds: (string | undefined)[] = [];
  const exec: GitExec = async (args, cwd) => {
    calls.push([...args]);
    cwds.push(cwd);
    // 应答按**子命令**路由（剥掉两组固定开关，故脚本 key 仍写 `status --porcelain` 形态）；
    // 真实 args（含开关）由各用例的 `calls` 断言与「固定开关前缀」用例另行锁定。
    const route = args
      .filter((a) => !GIT_GLOBAL_ARGS.includes(a) && !GIT_DIFF_OUTPUT_ARGS.includes(a))
      .join(' ');
    return script[route] ?? { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls, cwds };
}

const ok = (stdout: string): GitExecResult => ({ code: 0, stdout, stderr: '' });

/** 构造 N 个文件、每文件 L 行的假 `git diff` 输出（保持 unified diff 真实结构） */
function diffOf(files: number, linesPerFile: number): string {
  return Array.from({ length: files }, (_, f) =>
    [
      `diff --git a/src/f${f}.ts b/src/f${f}.ts`,
      'index 0000000..1111111 100644',
      `--- a/src/f${f}.ts`,
      `+++ b/src/f${f}.ts`,
      `@@ -1,${linesPerFile} +1,${linesPerFile} @@`,
      ...Array.from({ length: linesPerFile }, (_, l) => `+line ${f}-${l}`),
    ].join('\n'),
  ).join('\n');
}

describe('@git-changes 有界采集（HOST-CTX-4 第二笔）', () => {
  it('白名单三口拼装：status --porcelain → diff --cached → diff，且 cwd 转发', async () => {
    const { exec, calls, cwds } = fakeExec({
      'status --porcelain': ok(' M src/a.ts'),
      'diff --cached': ok(diffOf(1, 1)),
      diff: ok(diffOf(1, 1)),
    });
    await collectGitChangesText({ exec, cwd: '/repo' });

    // 真实 args = 固定开关 + 子命令（逐字形态由「固定开关前缀」用例锁定，此处派生免重复）
    expect(calls).toEqual([
      [...GIT_GLOBAL_ARGS, 'status', '--porcelain'],
      [...GIT_GLOBAL_ARGS, 'diff', '--cached', ...GIT_DIFF_OUTPUT_ARGS],
      [...GIT_GLOBAL_ARGS, 'diff', ...GIT_DIFF_OUTPUT_ARGS],
    ]);
    // cwd 逐字转发（生产 = 首个工作区根；模型按清单路径 read_file 才读得到）
    expect(cwds.every((c) => c === '/repo')).toBe(true);
    // 每次调用都命中白名单（防未来加命令时静默越权）
    const hits = (args: string[]): boolean =>
      GIT_COMMAND_WHITELIST.some(
        (w) => w.length === args.length && w.every((v, i) => v === args[i]),
      );
    expect(calls.every(hits)).toBe(true);
    expect(GIT_COMMAND_WHITELIST).toEqual([
      GIT_COMMANDS.status,
      GIT_COMMANDS.diffUnstaged,
      GIT_COMMANDS.diffStaged,
    ]);
  });

  it('固定开关前缀：三组共享同一前缀（只写一处）+ diff 两口带输出形态开关，逐字锁定', () => {
    // ① `core.quotePath=false` = 中文路径不转义（否则模型 read_file 必失败）；
    //    ② `core.fsmonitor=false` = status 不执行仓库 config 指定的外部程序。
    // 逐字断言：改一个字符即红，防「顺手换个配置名」把只读采集变成执行任意程序。
    expect(GIT_GLOBAL_ARGS).toEqual(['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false']);
    expect(GIT_COMMAND_WHITELIST).toHaveLength(3);
    for (const args of GIT_COMMAND_WHITELIST) {
      expect(args.slice(0, GIT_GLOBAL_ARGS.length)).toEqual([...GIT_GLOBAL_ARGS]);
    }
    // 输出形态开关（缺一即出真伤）：--no-color 防 ANSI 让 `\n(?=diff --git )` 切点失效
    // （实测 3 文件 → 1 段）；--no-ext-diff / --no-textconv 防 diff 执行外部驱动 / textconv。
    expect(GIT_DIFF_OUTPUT_ARGS).toEqual(['--no-color', '--no-ext-diff', '--no-textconv']);
    expect(GIT_COMMANDS.diffUnstaged.slice(GIT_GLOBAL_ARGS.length)).toEqual([
      'diff',
      ...GIT_DIFF_OUTPUT_ARGS,
    ]);
    expect(GIT_COMMANDS.diffStaged.slice(GIT_GLOBAL_ARGS.length)).toEqual([
      'diff',
      '--cached',
      ...GIT_DIFF_OUTPUT_ARGS,
    ]);
    // status 走 porcelain 机器格式（实测不受 color 影响），无需颜色开关
    expect(GIT_COMMANDS.status.slice(GIT_GLOBAL_ARGS.length)).toEqual(['status', '--porcelain']);
  });

  it('fail-closed：非 git 仓库（128 + fatal）→ 事实行进正文，且不跑 diff（fail-fast）', async () => {
    const { exec, calls } = fakeExec({
      'status --porcelain': {
        code: 128,
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      },
    });
    const body = await collectGitChangesText({ exec });
    expect(body).toContain('not a git repository');
    expect(body).toContain('无法采集未提交改动');
    // 清单都没拿到，两口 diff 没有运行意义——fail-fast 兼省两次无用执行
    expect(calls).toHaveLength(1);
  });

  it('fail-closed：git 未安装（ENOENT）→ 事实行，不跑 diff', async () => {
    const { exec, calls } = fakeExec({
      'status --porcelain': { code: null, stdout: '', stderr: '', error: 'spawn git ENOENT' },
    });
    const body = await collectGitChangesText({ exec });
    expect(body).toContain('未能启动 git');
    expect(body).toContain('ENOENT');
    expect(calls).toHaveLength(1);
  });

  it('fail-closed：单个 diff 段失败 → 清单照给 + 该段事实行，另一段照常', async () => {
    const { exec, calls } = fakeExec({
      'status --porcelain': ok('M  src/a.ts'),
      'diff --cached': { code: 1, stdout: '', stderr: 'fatal: ambiguous argument\n' },
      diff: ok(diffOf(1, 2)),
    });
    const body = await collectGitChangesText({ exec });
    // 段失败不得拖垮整轮：清单与另一段仍在（局部失败 ≠ 整体沉默）
    expect(body).toContain('M  src/a.ts');
    expect(body).toContain('已暂存改动（git diff --cached）：执行失败');
    expect(body).toContain('ambiguous argument');
    expect(body).toContain('未暂存改动（git diff）');
    expect(calls).toHaveLength(3);
  });

  it('零改动：porcelain 为空 → 干净事实行，不跑 diff', async () => {
    const { exec, calls } = fakeExec({ 'status --porcelain': ok('') });
    const body = await collectGitChangesText({ exec });
    expect(body).toContain('没有未提交的改动');
    expect(calls).toHaveLength(1);
  });

  it('第一道闸（文件数）：status 超限 → 清单截断 + 明示；每个 diff 段各自截断 + 明示', async () => {
    const total = GIT_FILES_LIMIT + 5;
    const { exec } = fakeExec({
      'status --porcelain': ok(
        Array.from({ length: total }, (_, i) => ` M src/f${i}.ts`).join('\n'),
      ),
      'diff --cached': ok(diffOf(total, 2)),
      diff: ok(diffOf(total, 2)),
    });
    const body = await collectGitChangesText({ exec });

    // 清单：第 20 个在、第 21 个不在（f20 只可能来自未列出的 src/f20.ts）
    expect(body).toContain('src/f19.ts');
    expect(body).not.toContain('f20');
    expect(body).toContain(`（清单仅列前 ${GIT_FILES_LIMIT} 个，共 ${total} 个）`);
    // 每个 diff 段同样只保留前 20 个文件，且两段都明示省略数
    const note = `省略 ${total - GIT_FILES_LIMIT} 个文件（超出每段 ${GIT_FILES_LIMIT} 个文件上限）`;
    expect(body).toContain(note);
    expect(body.match(new RegExp(`超出每段 ${GIT_FILES_LIMIT} 个文件上限`, 'g'))).toHaveLength(2);
  });

  it('第二道闸（单文件行数）：超 200 行的段整行截断 + 明示，尾部行不出现', async () => {
    const { exec } = fakeExec({
      'status --porcelain': ok(' M src/f0.ts'),
      'diff --cached': ok(diffOf(1, GIT_FILE_DIFF_MAX_LINES + 50)),
      diff: ok(''),
    });
    const body = await collectGitChangesText({ exec });
    expect(body).toContain(`…（该文件 diff 超过 ${GIT_FILE_DIFF_MAX_LINES} 行已截断）`);
    // 保留段首、丢弃段尾（+line 0-0 在、最后一行不在）
    expect(body).toContain('+line 0-0');
    expect(body).not.toContain(`+line 0-${GIT_FILE_DIFF_MAX_LINES + 49}`);
  });

  it('第三道闸（正文总长）：超 12K → 严格尾部丢块 + 明示；清单恒不被丢', async () => {
    // 20 个文件 × 60 行 ≈ 17K > 12K，必然触发总闸
    const { exec } = fakeExec({
      'status --porcelain': ok(Array.from({ length: 5 }, (_, i) => ` M src/s${i}.ts`).join('\n')),
      'diff --cached': ok(diffOf(20, 60)),
      diff: ok(diffOf(20, 60)),
    });
    const body = await collectGitChangesText({ exec });

    // 清单（不可丢）与已暂存首块在；末块不在（严格尾部丢）
    expect(body).toContain('src/s0.ts');
    expect(body).toContain('src/f0.ts');
    expect(body).not.toContain('src/f19.ts');
    // 两段都出现省略注记（未暂存段整段被丢也要交代）
    expect(body).toContain('省略');
    expect(body).toContain('未暂存改动（git diff）省略');
    expect(body).toContain(`正文总长超出 ${GIT_BODY_MAX_CHARS} 字符上限`);
    // 内容部分不超总闸（注记属额外交代，允许小幅超出）
    expect(body.length).toBeLessThan(GIT_BODY_MAX_CHARS + 300);
  });

  it('分组与顺序：已暂存段在未暂存段前（提交候选优先），各自标签正确', async () => {
    const { exec } = fakeExec({
      'status --porcelain': ok('M  src/staged.ts\n M src/unstaged.ts'),
      'diff --cached': ok(diffOf(1, 1).replace(/f0/g, 'staged')),
      diff: ok(diffOf(1, 1).replace(/f0/g, 'unstaged')),
    });
    const body = await collectGitChangesText({ exec });
    expect(body.indexOf('已暂存改动（git diff --cached）')).toBeLessThan(
      body.indexOf('未暂存改动（git diff）'),
    );
    // 段内容归位：staged 文件只在已暂存段，unstaged 文件只在未暂存段
    const stagedPart = body.slice(body.indexOf('已暂存改动'), body.indexOf('未暂存改动'));
    expect(stagedPart).toContain('src/staged.ts');
    expect(stagedPart).not.toContain('src/unstaged.ts');
  });

  it('未跟踪项：?? 项计入头部说明（git diff 不含未跟踪内容，模型有权知道）', async () => {
    const { exec } = fakeExec({
      'status --porcelain': ok('?? a.txt\n M b.ts'),
      'diff --cached': ok(''),
      diff: ok(diffOf(1, 1).replace(/f0/g, 'b')),
    });
    const body = await collectGitChangesText({ exec });
    expect(body).toContain('共 2 个文件有未提交改动（含 1 个未跟踪项，git diff 不含未跟踪内容）');
  });

  it('CRLF 兼容：git 在 Windows 可能输出 \\r\\n，清单行不得残留 \\r', async () => {
    const { exec } = fakeExec({
      'status --porcelain': ok(' M a.ts\r\n M b.ts\r\n'),
      'diff --cached': ok(''),
      diff: ok(''),
    });
    const body = await collectGitChangesText({ exec });
    expect(body).not.toContain('\r');
    expect(body).toContain(' M a.ts');
  });

  it('空 diff 段省略：改动全是未跟踪项时不出空段标签（空输出 = 确实没有，不是失败）', async () => {
    const { exec } = fakeExec({
      'status --porcelain': ok('?? new.txt'),
      'diff --cached': ok(''),
      diff: ok(''),
    });
    const body = await collectGitChangesText({ exec });
    expect(body).toContain('?? new.txt');
    expect(body).not.toContain('已暂存改动');
    expect(body).not.toContain('未暂存改动');
  });
});
