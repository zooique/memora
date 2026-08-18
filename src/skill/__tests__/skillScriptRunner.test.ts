/**
 * skillScriptRunner.test.ts — 技能脚本执行器测试
 *
 * 覆盖范围：
 *   1. formatScriptResult — 结果格式化（超时/错误/成功分支）
 *   2. runSkillScript — 子进程执行（成功/超时/失败/边界场景）
 *   3. resolveCommand 行为 — runtime→command 映射（间接测试）
 *
 * 注：runSkillScript 测试使用真实子进程，脚本内容尽量简单。
 *     完整沙箱测试由宿主集成测试覆盖。
 *     跨平台兼容：Windows 与 POSIX 行为可能不同，测试做相应适配。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  runSkillScript,
  formatScriptResult,
  type ScriptExecutionResult,
} from '../skillScriptRunner.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 创建临时目录存放测试脚本
const TMP_DIR = join(tmpdir(), 'skill-script-test-');
if (!existsSync(TMP_DIR)) {
  mkdirSync(TMP_DIR, { recursive: true });
}

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

  // ── 超时分支 ──
  describe('超时分支', () => {
    it('标记 timedOut 时返回超时信息', () => {
      const result: ScriptExecutionResult = {
        stdout: 'partial output',
        stderr: '',
        exitCode: -1,
        timedOut: true,
      };
      const formatted = formatScriptResult(result);
      expect(formatted).toContain('[SCRIPT_TIMEOUT]');
      expect(formatted).toContain('120s'); // MAX_TIMEOUT_MS / 1000
      expect(formatted).toContain('partial output');
    });

    it('超时且有 stderr 时包含 stderr', () => {
      const result: ScriptExecutionResult = {
        stdout: 'partial',
        stderr: 'some error',
        exitCode: -1,
        timedOut: true,
      };
      const formatted = formatScriptResult(result);
      expect(formatted).toContain('partial');
      expect(formatted).toContain('some error');
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
    it('空结果处理', () => {
      const result: ScriptExecutionResult = {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
      const formatted = formatScriptResult(result);
      expect(formatted).toBe('(无输出)');
    });

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

// ══════════════════════════════════════════════════════════════
// 2. runSkillScript 子进程执行测试
// ══════════════════════════════════════════════════════════════

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
      // 在 Windows 上，child_process timeout 行为略有不同
      // 核心断言：脚本没有正常完成（timedOut=true 或 exitCode 非 0）
      expect(result.timedOut).toBe(true);
    });
  });

  // ── 环境变量隔离测试 ──
  describe('环境变量隔离', () => {
    it('脚本不能直接读取宿主环境变量', async () => {
      // 设置一个环境变量
      process.env.MEMORA_TEST_SECRET = 'secret-value-123';
      try {
        const leakScript = join(TMP_DIR, 'env-leak.js');
        // 脚本尝试读取 MEMORA_TEST_SECRET
        writeFileSync(leakScript, 'console.log(process.env.MEMORA_TEST_SECRET || "NOT_FOUND");');
        const result = await runSkillScript(leakScript, 'node');
        // 环境变量不应该泄漏到子进程
        expect(result.stdout.trim()).toBe('NOT_FOUND');
      } finally {
        delete process.env.MEMORA_TEST_SECRET;
      }
    });

    it('PATH 环境变量被保留（用于系统命令）', async () => {
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

  // ── 返回结构验证 ──
  describe('返回结构', () => {
    it('ScriptExecutionResult 包含所有必要字段', async () => {
      const result = await runSkillScript(SIMPLE_NODE_SCRIPT, 'node');
      expect(result).toHaveProperty('stdout');
      expect(result).toHaveProperty('stderr');
      expect(result).toHaveProperty('exitCode');
      expect(result).toHaveProperty('timedOut');
      expect(typeof result.stdout).toBe('string');
      expect(typeof result.stderr).toBe('string');
      expect(typeof result.exitCode).toBe('number');
      expect(typeof result.timedOut).toBe('boolean');
    });
  });
});