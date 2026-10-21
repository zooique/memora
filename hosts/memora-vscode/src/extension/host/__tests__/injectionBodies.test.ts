/**
 * injectionBodies.test.ts — 发送时刻注入正文的装配层（git-changes 源）
 *
 * 只测本模块新增的 `collectGitChangesBody`（problems 的 body 采集自第 3.0 笔迁入前
 * 已由 chatPanel 级测试覆盖，vscode 事实（getDiagnostics）不在此重复）。假执行器
 * 应答（gitExec 注入先例）——不真跑 git，真机四态属验收项。
 *
 * 锁三件事：① root 透传为 git cwd（首根 SSOT）；② 采集器 fail-closed 事实行原样
 * 透传（永不空串）；③ 装配自身抛错也被兜成事实行（不得挂掉整条发送）。
 */
import { describe, it, expect, vi } from 'vitest';

// 本测试只驱动 git-changes 路径（不读 vscode API）；problems 路径的 vscode 依赖由
// chatPanel 级测试覆盖——空对象 mock 足够（collectProblemsBody 不被调用）。
vi.mock('vscode', () => ({}));

import { collectGitChangesBody } from '../injectionBodies.js';
import {
  GIT_DIFF_OUTPUT_ARGS,
  GIT_GLOBAL_ARGS,
  type GitExec,
  type GitExecResult,
} from '../gitCollector.js';

/** 假执行器：记录调用 + 按序应答（status 之后才跑 diff 的顺序也由此可观测） */
function fakeExec(answers: GitExecResult[]): GitExec & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const exec = ((args: readonly string[]) => {
    calls.push(args);
    return Promise.resolve(answers[calls.length - 1] ?? { code: 0, stdout: '', stderr: '' });
  }) as GitExec & { calls: (readonly string[])[] };
  exec.calls = calls;
  return exec;
}

const ok = (stdout: string): GitExecResult => ({ code: 0, stdout, stderr: '' });

describe('collectGitChangesBody — git-changes 源正文装配', () => {
  it('root 透传为 git cwd（首根 SSOT：与 read_file cwd / 引用解析同根）', async () => {
    // status 必须非空（有改动）才会继续跑 diff 两口——零改动时采集器正确地短路
    const exec = fakeExec([
      ok(' M src/a.ts\n'),
      ok('diff --git a/staged\n'),
      ok('diff --git a/f\n'),
    ]);
    await collectGitChangesBody('/repo/root', exec);

    // 顺序 = 采集器契约（M7 变异锁定）：status → diff --cached（提交候选，展示优先）→ diff。
    // args 逐字形态由 gitCollector.test.ts「固定开关前缀」用例单点锁定（此处派生免重复）
    expect(exec.calls).toEqual([
      [...GIT_GLOBAL_ARGS, 'status', '--porcelain'],
      [...GIT_GLOBAL_ARGS, 'diff', '--cached', ...GIT_DIFF_OUTPUT_ARGS],
      [...GIT_GLOBAL_ARGS, 'diff', ...GIT_DIFF_OUTPUT_ARGS],
    ]);
    // cwd 由 collectGitChangesText 经 GitCollectInput.cwd 透传给 exec（真执行器的 cwd
    // 锁定在 gitExec.test.ts 的 spawn 选项断言）
    expect(exec.calls.length).toBe(3);
  });

  it('零改动：采集器事实行原样透传（用户挂了标签就有权知道「确实没有」）', async () => {
    const exec = fakeExec([ok('')]);
    const body = await collectGitChangesBody('/repo/root', exec);

    expect(body).toBe('当前没有未提交的改动（git status --porcelain 为空）。');
    expect(exec.calls).toHaveLength(1); // 零改动不跑 diff（无必要开销）
  });

  it('ENOENT（未安装 git）：采集器「未能启动 git」事实行透传，不抛错', async () => {
    const exec = fakeExec([{ code: null, stdout: '', stderr: '', error: 'spawn git ENOENT' }]);
    const body = await collectGitChangesBody('/repo/root', exec);

    expect(body).toContain('未能启动 git');
    expect(body).toContain('ENOENT');
  });

  it('status 非 0：fail-fast 不跑 diff + 「无法采集」事实行', async () => {
    const exec = fakeExec([
      { code: 128, stdout: '', stderr: 'fatal: not a git repository' },
      ok('不应被跑到'),
    ]);
    const body = await collectGitChangesBody('/repo/root', exec);

    expect(body).toContain('无法采集未提交改动');
    expect(exec.calls).toHaveLength(1);
  });

  it('装配自身抛错（假执行器 reject）也兜成事实行——发送不得挂掉', async () => {
    const exec = (() => Promise.reject(new Error('boom'))) as GitExec;
    const body = await collectGitChangesBody('/repo/root', exec);

    expect(body).toBe('git 未提交改动采集失败（本轮未能取到改动清单）。');
  });

  it('无工作区（root=undefined）不炸：git 自寻 .git 或给事实行', async () => {
    const exec = fakeExec([{ code: 128, stdout: '', stderr: 'fatal: not a git repository' }]);
    const body = await collectGitChangesBody(undefined, exec);

    expect(body).toContain('无法采集未提交改动');
  });
});
