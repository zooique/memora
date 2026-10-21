/**
 * gitExec — git 只读命令的生产 spawn wrapper（HOST-CTX-4 第 3.1 笔接线）
 *
 * 落实 `gitCollector` 模块头钉下的五条 wrapper 契约（`GIT_COMMAND_WHITELIST` 是
 * 「memora 允许对 git 做什么」的**唯一真源**）：
 *   ① spawn 前校验 args **逐项命中**白名单，不命中即拒绝——采集器只构造三组只读
 *      args，但 wrapper 不信任上游：纵深防御让写操作从结构上进不来；
 *   ② env 带 `NO_COLOR=1`（**辅助**：实测挡不住显式 `color.diff=always`，主力是白名单
 *      args 里的 `--no-color`，见 `gitCollector.GIT_COMMANDS` 注释）；
 *   ③ `windowsHide:true`（`environmentProvider.probeRuntime` 先例，禁弹控制台窗口）；
 *   ④ 超时强杀并按失败处置（大仓库 status/diff 可能慢，勿照搬 --version 量级 5s）；
 *   ⑤ cwd 透传（生产 = 首个工作区根，与 `read_file` cwd 同根，模型按清单路径才读得到）。
 *
 * 与 `environmentProvider` 的分层：`probeRuntime` 是「探测单个运行时、失败即不可用」的
 * 启动期特化；本文件是注入式 `GitExec` 的**生产装配**（gitCollector 零 vscode、可纯
 * node 单测）。stdout 另设 exec 层字节上限——三道闸是采集器的**语义**截断，防不了
 * 「百 MB diff 先全量累进内存」的**进程级**风险，两层各管一段。
 *
 * 失败路径恒 resolve 不 reject：`code=null + error` 即失败事实，由
 * `collectGitChangesText` 收成事实行——抛错会把整条发送挂掉（静默失败族）。
 */
import { spawn } from 'node:child_process';
import { GIT_COMMAND_WHITELIST, type GitExec, type GitExecResult } from './gitCollector.js';

/** 单命令超时（毫秒）：大仓库 status/diff 可能慢，10s 仍不完即按失败处置（事实行进信封） */
const GIT_EXEC_TIMEOUT_MS = 10_000;

/** stdout 字节上限（exec 层进程级防护）：超出即强杀——语义截断是采集器三道闸的事 */
const GIT_STDOUT_MAX_BYTES = 8_000_000;

/** args 逐项命中白名单某组才放行（长度相等 + 逐项相等；三组只读命令外一律拒绝） */
function isWhitelisted(args: readonly string[]): boolean {
  return GIT_COMMAND_WHITELIST.some(
    (allowed) => allowed.length === args.length && allowed.every((a, i) => a === args[i]),
  );
}

/** 生产 GitExec（无状态、可共享）：跑白名单内只读 git 命令，只收集进程级事实、不做解释 */
export const gitExec: GitExec = (args, cwd) =>
  new Promise<GitExecResult>((resolve) => {
    if (!isWhitelisted(args)) {
      // 结构上拒绝：白名单外的 args 连 spawn 都不发生（写操作 / 意外多参在此断掉）
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        error: `拒绝执行：git 命令不在只读白名单（${args.join(' ')}）`,
      });
      return;
    }
    let settled = false;
    let stdout = '';
    let stdoutBytes = 0;
    let overflow = false;
    /** 一次结算：超时 / 错误 / 退出 / 输出超限四路竞争下单点守卫（probeRuntime 同款） */
    const finish = (result: GitExecResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn('git', [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
      cwd,
    });
    // UTF-8 解码口径（实测：359KB 中文输出跨管道块时 `String(d)` 逐块解码产生 7~12 个
    // U+FFFD）——`setEncoding` 由 StringDecoder 兜住被切断的多字节序列，块间不断字。
    // ⚠️ 与本处配套的另一半：开了 encoding 后 `d` 变 string，`d.length` 是**字符数**
    // 不再是字节数 ⇒ 上限计数必须走 `Buffer.byteLength`（对 Buffer / string 同口径），
    // 否则 8MB 阈值在中文场景被放宽约 3 倍。两者成对改，拆一个即留伤。
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: Buffer | string) => {
      stdoutBytes += Buffer.byteLength(d);
      if (stdoutBytes > GIT_STDOUT_MAX_BYTES) {
        // 超限即杀：语义截断（三道闸）管不了「先全量累进内存」的进程级风险
        overflow = true;
        if (child.exitCode === null && !child.killed) child.kill();
        return;
      }
      stdout += String(d);
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer | string) => {
      stderr += String(d);
    });
    child.on('error', (err: Error) => {
      // ENOENT = 未安装 git（code=null 与 error 同现，collector 依此给「git 缺失」事实行）
      finish({ code: null, stdout: '', stderr: '', error: err.message });
    });
    child.on('close', (code) => {
      if (overflow) {
        finish({
          code,
          stdout: '',
          stderr: '',
          error: `git 输出超出 exec 层上限（${GIT_STDOUT_MAX_BYTES} 字节），已中断`,
        });
        return;
      }
      finish({ code, stdout, stderr });
    });
    const killer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill();
      finish({
        code: null,
        stdout: '',
        stderr: '',
        error: `git 命令超时（> ${GIT_EXEC_TIMEOUT_MS}ms），已中断`,
      });
    }, GIT_EXEC_TIMEOUT_MS);
    if (typeof killer.unref === 'function') killer.unref();
  });
