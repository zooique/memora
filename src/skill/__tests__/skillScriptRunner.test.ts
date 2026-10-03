/**
 * skillScriptRunner.test.ts — 技能脚本执行器测试
 *
 * 覆盖范围：
 *   1. formatScriptResult — 结果格式化（超时/错误/成功分支）+ 超时文案按实际超时（钳制后）生成
 *   2. runSkillScript — 子进程执行（成功/超时/失败/边界场景）
 *   3. resolveCommand 行为 — runtime→command 映射（间接测试）
 *   4. 进程治理缺口清偿（§13.6-A/B）— 超时强杀**进程树**（孙进程不再变孤儿）
 *      + 收集侧**内存护栏**（字节量纲，truncated/discardedBytes 诚实化上报）
 *
 * 注：runSkillScript 测试使用真实子进程，脚本内容尽量简单。
 *     完整沙箱测试由宿主集成测试覆盖。
 *     跨平台兼容：Windows 与 POSIX 行为可能不同，测试做相应适配。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  runSkillScript,
  runShellCommand,
  resolveShellCommand,
  formatScriptResult,
  formatExecutionResult,
  guardWindowsShellScript,
  shouldFallbackPythonToPy,
  isPythonUnavailable,
  type ScriptExecutionResult,
} from '../skillScriptRunner.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 唯一定名的临时目录：mkdtempSync 保证并发 vitest 进程各用各的目录，
// afterAll 只删自己这一个（固定路径 + 递归删除曾误删他进程的脚本文件，实测 ENOENT）
const TMP_DIR = mkdtempSync(join(tmpdir(), 'skill-script-'));

/** 平台标识符 */
const IS_WINDOWS = process.platform === 'win32';

/** 简易 Node 脚本：输出到 stdout */
const SIMPLE_NODE_SCRIPT = join(TMP_DIR, 'simple.js');
/** 简易 Node 脚本：输出到 stderr */
const STDERR_NODE_SCRIPT = join(TMP_DIR, 'stderr.js');
/** 简易 Node 脚本：退出码非零 */
const ERROR_NODE_SCRIPT = join(TMP_DIR, 'error.js');
/** 跨平台 Shell 脚本（Windows 用 .cmd，POSIX 用 .sh） */
const SHELL_SCRIPT = join(TMP_DIR, IS_WINDOWS ? 'simple.cmd' : 'simple.sh');

beforeAll(() => {
  writeFileSync(SIMPLE_NODE_SCRIPT, 'console.log("Hello from script");');
  writeFileSync(STDERR_NODE_SCRIPT, 'console.error("Error output");');
  writeFileSync(ERROR_NODE_SCRIPT, 'process.exit(1);');
  // 跨平台 shell 脚本
  if (IS_WINDOWS) {
    writeFileSync(SHELL_SCRIPT, '@echo off\r\necho Hello from shell');
  } else {
    writeFileSync(SHELL_SCRIPT, '#!/bin/sh\necho "Hello from shell"');
  }
});

afterAll(() => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
});

// ══════════════════════════════════════════════════════════════
// 1. formatScriptResult 纯函数测试
// ══════════════════════════════════════════════════════════════

describe('skillScriptRunner — formatScriptResult', () => {
  /** 超时态样本：stdout/stderr 可由用例覆盖（超时分支不看 exitCode） */
  const timedOut = (stdout = 'partial output', stderr = ''): ScriptExecutionResult => ({
    stdout,
    stderr,
    exitCode: -1,
    timedOut: true,
  });

  // ── 超时分支 ──
  describe('超时分支', () => {
    it('标记 timedOut 时返回超时信息', () => {
      const formatted = formatScriptResult(timedOut());
      expect(formatted).toContain('[SCRIPT_TIMEOUT]');
      // 默认 60s（DEFAULT_TIMEOUT_MS）；600s 只在 timeoutMs 被钳制到上限时出现
      expect(formatted).toContain('脚本执行超时（超过 60s）');
      expect(formatted).toContain('partial output');
    });

    it('超时且有 stderr 时包含 stderr', () => {
      const formatted = formatScriptResult(timedOut('partial', 'some error'));
      expect(formatted).toContain('partial');
      expect(formatted).toContain('some error');
    });
  });

  // ── 超时文案按实际超时（钳制后）生成，不恒写上 ──
  describe('超时文案随 timeoutMs 钳制', () => {
    it('timeoutMs=120_000 → 文案 120s', () => {
      expect(formatScriptResult(timedOut(), 120_000)).toContain('脚本执行超时（超过 120s）');
    });

    it('timeoutMs=999（低于下限 1s）→ 钳制为 1s', () => {
      expect(formatScriptResult(timedOut(), 999)).toContain('脚本执行超时（超过 1s）');
    });

    it('timeoutMs=10_000_000（高于上限）→ 钳制为 600s', () => {
      expect(formatScriptResult(timedOut(), 10_000_000)).toContain('脚本执行超时（超过 600s）');
    });
  });

  // ── 错误分支 ──
  describe('错误分支', () => {
    it('非零退出码返回错误信息', () => {
      const result: ScriptExecutionResult = {
        stdout: '',
        stderr: 'module not found',
        exitCode: 2,
        timedOut: false,
      };
      const formatted = formatScriptResult(result);
      expect(formatted).toContain('[SCRIPT_ERROR]');
      expect(formatted).toContain('退出码: 2');
      expect(formatted).toContain('module not found');
    });

    it('非零退出码且 stdout 有内容时包含 stdout', () => {
      const result: ScriptExecutionResult = {
        stdout: 'some output before error',
        stderr: 'error details',
        exitCode: 1,
        timedOut: false,
      };
      const formatted = formatScriptResult(result);
      expect(formatted).toContain('some output before error');
      expect(formatted).toContain('error details');
    });
  });

  // ── 成功分支 ──
  describe('成功分支', () => {
    it('成功且只有 stdout 时返回 stdout', () => {
      const result: ScriptExecutionResult = {
        stdout: 'Hello World',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
      const formatted = formatScriptResult(result);
      expect(formatted).toBe('Hello World');
    });

    it('成功且 stdout 为空时返回"(无输出)"', () => {
      const result: ScriptExecutionResult = {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
      const formatted = formatScriptResult(result);
      expect(formatted).toBe('(无输出)');
    });

    it('成功且有 stderr 时附加 stderr', () => {
      const result: ScriptExecutionResult = {
        stdout: 'main output',
        stderr: 'warning: deprecated API',
        exitCode: 0,
        timedOut: false,
      };
      const formatted = formatScriptResult(result);
      expect(formatted).toContain('main output');
      expect(formatted).toContain('[stderr]');
      expect(formatted).toContain('warning: deprecated API');
    });
  });

  // ── 边界场景 ──
  describe('边界场景', () => {
    it('stdout 含特殊字符正常返回', () => {
      const result: ScriptExecutionResult = {
        stdout: '🌍 café résumé\nline2\tword',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
      const formatted = formatScriptResult(result);
      expect(formatted).toBe('🌍 café résumé\nline2\tword');
    });
  });
});

// ── formatExecutionResult 共享格式化（SSOT：run_skill_script 与 run_code 同一真理源）──
describe('skillScriptRunner — formatExecutionResult（CODE 变体）', () => {
  // CODE 标签：run_code 工具链路使用（前缀/文案由调用方定制）
  const codeLabels = {
    kind: 'CODE',
    timeoutDetail: '代码执行超时',
    errorDetail: '代码执行失败',
  } as const;

  it('timedOut 时输出 [CODE_TIMEOUT] + 自定义超时文案', () => {
    const formatted = formatExecutionResult(
      { stdout: 'partial', stderr: 'err', exitCode: -1, timedOut: true },
      codeLabels,
    );
    expect(formatted).toContain('[CODE_TIMEOUT]');
    expect(formatted).toContain('代码执行超时');
    expect(formatted).toContain('partial');
    expect(formatted).toContain('err');
  });

  it('非零退出码时输出 [CODE_ERROR] + 退出码', () => {
    const formatted = formatExecutionResult(
      { stdout: '', stderr: 'boom', exitCode: 1, timedOut: false },
      codeLabels,
    );
    expect(formatted).toContain('[CODE_ERROR]');
    expect(formatted).toContain('代码执行失败');
    expect(formatted).toContain('退出码: 1');
    expect(formatted).toContain('boom');
  });

  it('成功分支与 formatScriptResult 同构（无输出兜底 + stderr 附加）', () => {
    expect(
      formatExecutionResult({ stdout: '', stderr: '', exitCode: 0, timedOut: false }, codeLabels),
    ).toBe('(无输出)');
    const withStderr = formatExecutionResult(
      { stdout: 'out', stderr: 'warn', exitCode: 0, timedOut: false },
      codeLabels,
    );
    expect(withStderr).toBe('out\n[stderr] warn');
  });

  it('formatScriptResult 薄封装等价（SCRIPT 变体回归锁定）', () => {
    // 必须喂超时态：labels（kind/timeoutDetail）只在超时分支参与拼接，
    // 成功态下把 labels 改坏它仍绿——锁不住薄封装的标签配置。
    const timeoutResult: ScriptExecutionResult = {
      stdout: 'x',
      stderr: '',
      exitCode: 0,
      timedOut: true,
    };
    const viaShared = formatExecutionResult(timeoutResult, {
      kind: 'SCRIPT',
      timeoutDetail: '脚本执行超时（超过 60s）',
      errorDetail: '脚本执行失败',
    });
    const viaWrapper = formatScriptResult(timeoutResult);
    expect(viaWrapper).toBe('[SCRIPT_TIMEOUT] 脚本执行超时（超过 60s）\nstdout: x\nstderr: ');
    expect(viaShared).toBe(viaWrapper);
  });
});

// ══════════════════════════════════════════════════════════════
// 2. runSkillScript 子进程执行测试
// ══════════════════════════════════════════════════════════════
// 容器超时放宽至 30s：这些用例真实 spawn 子进程，全量并发
// （fileParallelism=true）时 5s 默认超时被挤爆（历史 pre-push full 档 flake：
// kernel:test/kernel:coverage 命中 5 例超时）。子进程执行本身受机器负载影响，
// 非逻辑缺陷——放宽容器超时不改断言、只消除并发挤占假红。
describe('skillScriptRunner — runSkillScript', () => {
  // ── Node runtime 测试 ──
  describe('Node runtime', () => {
    it('成功执行脚本', async () => {
      const result = await runSkillScript(SIMPLE_NODE_SCRIPT, 'node');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.stdout).toContain('Hello from script');
      expect(result.stderr).toBe('');
    });

    it('捕获 stderr 输出', async () => {
      const result = await runSkillScript(STDERR_NODE_SCRIPT, 'node');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toContain('Error output');
    });

    it('非零退出码', async () => {
      const result = await runSkillScript(ERROR_NODE_SCRIPT, 'node');
      expect(result.exitCode).toBe(1);
      expect(result.timedOut).toBe(false);
    });

    it('传递 args 参数', async () => {
      // 创建接收参数的脚本
      const argsScript = join(TMP_DIR, 'args.js');
      writeFileSync(argsScript, 'console.log(process.argv.slice(2).join(","));');
      const result = await runSkillScript(argsScript, 'node', ['foo', 'bar', 'baz']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('foo,bar,baz');
    });
  });

  // ── Shell runtime 测试 ──
  describe('Shell runtime', () => {
    it('成功执行 shell 脚本', async () => {
      const result = await runSkillScript(SHELL_SCRIPT, 'shell');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.stdout).toContain('Hello from shell');
    });
  });

  // ── 超时测试 ──
  describe('超时行为', () => {
    it('超时被正确触发（1s 最小超时限制）', async () => {
      // 创建一个需要 > 1s 执行的脚本
      const slowScript = join(TMP_DIR, 'slow.js');
      writeFileSync(slowScript, 'setTimeout(() => console.log("done"), 3000);');
      const result = await runSkillScript(slowScript, 'node', [], 1000);
      // 2026-10-03 语义变更（§13.6-A）：超时不再经 spawn `timeout` 选项 kill，故**不再有
      // close(null,'SIGTERM') 那条路径**——由手动计时器直接收场，退出码取 -1（对齐宿主
      // codeExecutor killer 的 `exitCode: -1 + timedOut: true` 同构形态）。旧断言 `toBe(0)`
      // 锁的是「`code ?? 0` 兜底」，该兜底仍存在于**正常 close 路径**（未被超时截断时），
      // 不适用于超时路径。
      // 语义上也只有 -1 是诚实的：0 = 成功，把「被强杀」报成 0 是对判据的污染。
      expect(result.exitCode).toBe(-1);
      expect(result.timedOut).toBe(true);
      // 脚本未正常完成：3s 后才打印的 "done" 不应出现在收集到的 stdout 里
      expect(result.stdout).not.toContain('done');
    });
  });

  // ── 裸命令执行（后台能力的同步侧地基，§13.1）──
  describe('裸命令执行（runShellCommand / resolveShellCommand）', () => {
    it('resolveShellCommand：Windows → cmd /c，其余 → sh -c（纯函数，平台参数化）', () => {
      expect(resolveShellCommand('npm test', 'win32')).toEqual({
        command: 'cmd',
        args: ['/c', 'npm test'],
      });
      expect(resolveShellCommand('npm test', 'linux')).toEqual({
        command: 'sh',
        args: ['-c', 'npm test'],
      });
    });

    it('runShellCommand：同步执行并返回 stdout / 退出码', async () => {
      const result = await runShellCommand('echo memora-shell-ok');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.stdout).toContain('memora-shell-ok');
    });

    // 命令构造纪律（跨平台）：避开 shell 元字符——`>` 会被 cmd 当重定向、
    // 嵌套引号会被 cmd 吞掉。故用无空格、无元字符的 `node -e <code>` 形态。
    it('runShellCommand：非零退出码如实回传（不把失败粉饰为成功）', async () => {
      const result = await runShellCommand('node -e process.exit(3)');
      expect(result.exitCode).toBe(3);
    });

    it('runShellCommand：超时走杀树原语并置 timedOut（与脚本路径同一治理）', async () => {
      const result = await runShellCommand(
        'node -e setTimeout(function(){},30000)',
        undefined,
        1_000,
      );
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(-1);
    }, 20_000);
  });

  // ── §13.6-A 进程树强杀 + §13.6-B 收集侧内存护栏（2026-10-03 清偿）──
  describe('进程治理缺口清偿（§13.6-A/B）', () => {
    // ⚠️ 「孙进程是否真被收割」的**结果级**断言不放在本文件：本机（Windows）实测
    // `child.kill()` 单杀时孙进程**同样停止心跳**（共享控制台被销毁连带终止），
    // 故结果级探活在本环境无法区分「杀树」与「单杀」——断言会**因错误的原因通过**。
    // 该行为改由 skillScriptRunner-exec.test.ts 的**机制级**分平台断言锁定
    // （Windows `taskkill /T /F` 调用 / POSIX `process.kill(-pgid)`），
    // 真机层面的「孙进程确实不再存活」列为阶段 1 手工验证项（方案文档 §13.6 未决三）。

    it('收集侧内存护栏：超量输出停止拼接并置 truncated + 丢弃字节数', async () => {
      // 48 × 64KB = 3MB > MAX_COLLECTED_OUTPUT_BYTES(2MB) → 护栏生效
      const floodScript = join(TMP_DIR, 'flood.js');
      writeFileSync(
        floodScript,
        "const chunk = 'x'.repeat(64 * 1024); for (let i = 0; i < 48; i++) process.stdout.write(chunk);",
      );

      const result = await runSkillScript(floodScript, 'node', [], 30_000);
      expect(result.timedOut).toBe(false);
      expect(result.truncated).toBe(true);
      expect(result.discardedBytes ?? 0).toBeGreaterThan(0);
      // 收集量被护栏约束（≤ 2MB）——内存防线，与下游 20_000 字符的上下文防线不同层
      expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(2 * 1024 * 1024);
      // 截断诚实化：格式化文案须显式告知（静默截断 = 假阴性，与 read_file 分段脚注同纪律）
      expect(formatScriptResult(result)).toContain('[OUTPUT_TRUNCATED]');
    }, 60_000);
  });

  // ── 环境继承（不走 PATH/HOME 最小白名单）──
  describe('环境继承', () => {
    it('脚本能读取宿主环境变量（项目脚本读用户环境是合理需求；owner 信任模型下视同用户本地 shell）', async () => {
      // 设置一个环境变量
      process.env.MEMORA_TEST_SECRET = 'secret-value-123';
      try {
        const envScript = join(TMP_DIR, 'env-read.js');
        writeFileSync(envScript, 'console.log(process.env.MEMORA_TEST_SECRET || "NOT_FOUND");');
        const result = await runSkillScript(envScript, 'node');
        // 继承用户环境 → 脚本应能读到（对齐 Claude Code bash 持久会话环境语义）
        expect(result.stdout.trim()).toBe('secret-value-123');
      } finally {
        delete process.env.MEMORA_TEST_SECRET;
      }
    });

    it('PATH 环境变量被继承（用于系统命令）', async () => {
      const pathScript = join(TMP_DIR, 'check-path.js');
      writeFileSync(pathScript, 'console.log(process.env.PATH || "NO_PATH");');
      const result = await runSkillScript(pathScript, 'node');
      expect(result.stdout.trim()).not.toBe('NO_PATH');
      expect(result.stdout.length).toBeGreaterThan(0);
    });
  });

  // ── 启动失败处理 ──
  describe('启动失败处理', () => {
    it('启动不存在的命令时返回错误', async () => {
      // 使用一个系统中不存在的 runtime 命令
      const result = await runSkillScript('/tmp/test.js', 'python');
      // 如果 python 不存在，spawn 会触发 error 事件
      // 如果 python 存在但文件不存在，会以非零退出码退出
      expect(result.timedOut).toBe(false);
      // 非零退出码或 stderr 含错误信息
      expect(result.exitCode).not.toBe(0);
    });
  });
}, 30000);

// ══════════════════════════════════════════════════════════════
// 3. L2 兜底判定纯函数（spawn 行为锁定见 skillScriptRunner-exec.test.ts）
// ══════════════════════════════════════════════════════════════

describe('skillScriptRunner — guardWindowsShellScript', () => {
  // win32 + shell 档：非 .bat/.cmd 扩展名一律拦截（.sh 静默空跑 / .ps1 不起 PowerShell）
  describe('win32 + shell → 拦截非批处理扩展名', () => {
    it('.sh → 显式错误', () => {
      expect(guardWindowsShellScript('scripts/run.sh', 'shell', 'win32')).toContain('静默空跑');
    });

    it('.bash / .zsh → 显式错误', () => {
      expect(guardWindowsShellScript('run.bash', 'shell', 'win32')).toContain('静默空跑');
      expect(guardWindowsShellScript('run.zsh', 'shell', 'win32')).toContain('静默空跑');
    });

    it('.ps1 → 显式错误（cmd /c 不起 PowerShell，S7）', () => {
      const err = guardWindowsShellScript('script.ps1', 'shell', 'win32');
      expect(err).not.toBeNull();
      expect(err).toContain('PowerShell');
    });

    it('无扩展名 → 显式错误（同属非批处理）', () => {
      expect(guardWindowsShellScript('script', 'shell', 'win32')).not.toBeNull();
    });

    it('.bat / .cmd → 放行（cmd 原生可执行类型）', () => {
      expect(guardWindowsShellScript('run.bat', 'shell', 'win32')).toBeNull();
      expect(guardWindowsShellScript('run.cmd', 'shell', 'win32')).toBeNull();
    });
  });

  // 平台/运行时豁免：只有 win32 + shell 双命中才拦截，其余全放行
  describe('豁免（非拦截面）', () => {
    it('linux + shell + .sh → 放行（POSIX 有 sh 解释器，正常执行）', () => {
      expect(guardWindowsShellScript('run.sh', 'shell', 'linux')).toBeNull();
    });

    it('win32 + node + .js → 放行', () => {
      expect(guardWindowsShellScript('run.js', 'node', 'win32')).toBeNull();
    });

    it('win32 + python + .py → 放行', () => {
      expect(guardWindowsShellScript('run.py', 'python', 'win32')).toBeNull();
    });
  });

  // 变异锁：移除守卫实现中任一拦截条件应导致本组红（三条不变量各自独立被锁）
  it('拦截文案含替代方案指引（断言完整性，防守卫退化成空串）', () => {
    const err = guardWindowsShellScript('run.sh', 'shell', 'win32');
    expect(err).toContain('.mjs/.js/.py');
  });
});

describe('skillScriptRunner — shouldFallbackPythonToPy 判定', () => {
  // Windows python 9009 兜底判定：win32 + python runtime 才换 py -3 重试一次
  it('win32 + python → 兜底', () => {
    expect(shouldFallbackPythonToPy('python', 'win32')).toBe(true);
  });

  it('win32 + node → 不兜底（仅 python 命令解析问题）', () => {
    expect(shouldFallbackPythonToPy('node', 'win32')).toBe(false);
  });

  it('linux + python → 不兜底（POSIX 无 py 启动器语义）', () => {
    expect(shouldFallbackPythonToPy('python', 'linux')).toBe(false);
  });
});

describe('skillScriptRunner — isPythonUnavailable 判定', () => {
  // Windows python 空壳启动器 9009：spawn 成功但进程以 9009（命令未找到）退出，
  // 非 ENOENT——必须靠退出码识别「不可用」，否则误判「执行失败」永不兜底。
  it('win32 + 退出码 9009 → 不可用（Store 空壳启动器场景）', () => {
    expect(isPythonUnavailable({ enoent: false, exitCode: 9009 } as never, 'win32')).toBe(true);
  });

  it('win32 + ENOENT → 不可用（无 python 命令场景）', () => {
    expect(isPythonUnavailable({ enoent: true, exitCode: -1 } as never, 'win32')).toBe(true);
  });

  it('win32 + 其他非零退出码 → 可用（真 Python 执行报错，非命令缺失）', () => {
    expect(isPythonUnavailable({ enoent: false, exitCode: 2 } as never, 'win32')).toBe(false);
  });

  it('linux + 9009 → 不可用 仅看 enoent（非 Windows「命令未找到」语义）', () => {
    expect(isPythonUnavailable({ enoent: false, exitCode: 9009 } as never, 'linux')).toBe(false);
    expect(isPythonUnavailable({ enoent: true, exitCode: 9009 } as never, 'linux')).toBe(true);
  });

  it('win32 + 成功(0) → 可用', () => {
    expect(isPythonUnavailable({ enoent: false, exitCode: 0 } as never, 'win32')).toBe(false);
  });
});
