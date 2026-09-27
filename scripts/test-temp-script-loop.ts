/**
 * 「临时脚本」闭环 —— 端到端演示脚本（对齐主流 AI IDE 的一次性数据处理行为）
 *
 * 用法：
 *   npx tsx scripts/test-temp-script-loop.ts
 *
 * 演示内容（TRAE 同款闭环，memora 内核自然生长实现）：
 *   LLM 按需在项目根写脚本 → 执行拿数据 → 清理脚本，不留痕。
 *   完整链路：write_file 写脚本 → run_code(script_path) 执行（cwd=项目根，
 *   脚本可读项目数据）→ delete_file 清理脚本。
 *
 * 覆盖场景：
 *   1. 闭环主链路：写脚本 → 执行 → 删除，全程可验证、留痕可查
 *   2. cwd=项目根：脚本用相对路径读取项目数据文件并计算
 *   3. 脚本语言推断：.cjs → node（按扩展名，无需显式传 language）
 *   4. delete_file 幂等：删除不存在的文件不报错（视为已删除）
 *   5. 参数防护：code 与 script_path 不能同时传（二选一）
 *   6. 传统 code 模式仍可用（不影响既有能力）
 *   7. delete_file 拒绝删除目录（防误删）
 *
 * 验收标准：
 *   - 脚本运行后输出全部 ✅，退出码 0
 *   - 临时脚本文件在闭环结束后已从磁盘删除（不留痕）
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { ToolExecutor, BUILTIN_TOOLS } from '../src/agent/toolExecutor.js';
import { RUN_CODE_TOOL } from '../src/agent/builtinTools.js';
import { SecurityGuard } from '../src/security/pathGuard.js';
import { InMemoryStorage } from '../src/memory/inMemoryStorage.js';
import type { IMemoryStorage } from '../src/memory/storageInterface.js';
import type { ICodeExecutionProvider, CodeExecutionResult } from '../src/code-exec/types.js';

// ─── 演示用本地 Node 执行器 ──────────────────────────────

/** 支持的语言集合（小写归一；node 为内核 script_path 推断出的规范名） */
const SUPPORTED_LANGS = new Set(['node', 'js', 'javascript', 'nodejs']);

/**
 * 演示用本地 Node 执行器：子进程隔离 + 超时强杀（对齐 vscode 宿主实现，仅支持 JavaScript）
 *
 * 内核零依赖不内置执行器，宿主注入；演示脚本自行实现一个最小可用的
 * ICodeExecutionProvider，让闭环可真实跑通（非 mock 返回值）。
 *
 * @returns 实现 ICodeExecutionProvider 的执行器
 */
function createLocalNodeExecutor(): ICodeExecutionProvider {
  return {
    /**
     * 在独立 Node 子进程内执行代码
     *
     * @param code 要执行的代码（-e 直接传入，CJS 上下文）
     * @param language 代码语言（仅支持 node/js/javascript/nodejs）
     * @param options 执行选项（读取 timeoutMs；cwd 传递为子进程工作目录）
     * @returns 执行结果（stdout/stderr/exitCode/timedOut）
     */
    async execute(
      code: string,
      language: string,
      options?: { timeoutMs?: number; cwd?: string },
    ): Promise<CodeExecutionResult> {
      const lang = (language ?? '').toLowerCase();
      if (!SUPPORTED_LANGS.has(lang)) {
        return {
          stdout: '',
          stderr: `暂不支持语言「${language || '(空)'}」；演示执行器仅支持 JavaScript（node / js / nodejs）`,
          exitCode: -1,
          timedOut: false,
        };
      }
      // 超时：居中限制到 [100, 120_000] 毫秒
      const timeoutMs = Math.min(Math.max(options?.timeoutMs ?? 10_000, 100), 120_000);

      return new Promise<CodeExecutionResult>((resolve) => {
        let settled = false;
        /** 一次结算：保证只 resolve/落定时器一次 */
        const finish = (result: CodeExecutionResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(killer);
          resolve(result);
        };

        // 子进程执行（-e 直接传代码，不经 shell，避免命令注入；windowsHide 防弹窗）
        const child = spawn(process.execPath, ['-e', code, '--no-warnings'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: options?.cwd,
          windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        // 输出流收集
        child.stdout.on('data', (d) => {
          stdout += String(d);
        });
        child.stderr.on('data', (d) => {
          stderr += String(d);
        });
        // 子进程启动失败
        child.on('error', (err) => {
          finish({
            stdout,
            stderr: stderr || `执行失败：${err.message}`,
            exitCode: -1,
            timedOut: false,
          });
        });
        // 子进程正常退出
        child.on('close', (code) => {
          finish({ stdout, stderr, exitCode: code ?? -1, timedOut: false });
        });
        // 硬超时：到点强杀子进程
        const killer = setTimeout(() => {
          if (child.exitCode !== null || child.killed) {
            finish({ stdout, stderr, exitCode: child.exitCode ?? -1, timedOut: false });
            return;
          }
          child.kill();
          finish({ stdout, stderr, exitCode: -1, timedOut: true });
        }, timeoutMs);
        if (typeof killer.unref === 'function') killer.unref();
      });
    },
  };
}

// ─── 辅助函数 ──────────────────────────────

/** 断言工具函数：失败置退出码并打印，成功打印 ✅ */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  ❌ 断言失败: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✅ ${message}`);
  }
}

// ─── 主函数 ──────────────────────────────

async function main(): Promise<void> {
  console.log('🔁 「临时脚本」闭环 —— 端到端演示\n');

  // 准备临时项目目录（模拟用户当前加载的项目根）
  const projectPath = mkdtempSync(join(tmpdir(), 'memora-temp-script-'));
  // 模拟项目已有数据文件（脚本执行时用相对路径读取，验证 cwd=项目根）
  mkdirSync(join(projectPath, 'data'), { recursive: true });
  writeFileSync(join(projectPath, 'data/numbers.txt'), '1 2 3 4 5\n', 'utf-8');

  // 记忆库：纯内存实现（演示无需 SQLite）
  const memoryIndex: IMemoryStorage = new InMemoryStorage();
  // 安全守卫：owner 权限 + confirmWrites=false（自动批准，让闭环无打断跑通）
  const security = new SecurityGuard(projectPath, projectPath, [], false, 'owner');
  // 工具执行器：注入本地 Node 执行器以启用 run_code 工具
  const executor = new ToolExecutor(
    projectPath,
    security,
    memoryIndex,
    undefined,
    undefined,
    undefined,
    createLocalNodeExecutor(),
  );

  try {
    // ─── 场景 0：工具定义就绪 ──────────────────────────
    console.log('📋 场景 0：工具定义就绪（delete_file + run_code.script_path）');
    const names = BUILTIN_TOOLS.map((t) => t.name);
    assert(names.includes('delete_file'), 'BUILTIN_TOOLS 包含 delete_file');
    // run_code 是条件工具（注入执行器后才暴露），定义以 RUN_CODE_TOOL 常量检查
    assert(
      RUN_CODE_TOOL.parameters.properties.script_path !== undefined,
      'run_code 定义包含 script_path 参数（脚本文件执行模式）',
    );

    // ─── 场景 1：闭环主链路 ──────────────────────────
    console.log('\n📋 场景 1：闭环主链路 —— write_file 写脚本 → run_code 执行 → delete_file 清理');

    // ① 写临时脚本（CJS 风格，node -e 默认 CJS 上下文可运行）
    // 脚本读取项目数据文件求和/平均/计数，验证 cwd=项目根 + 相对路径可读
    const scriptPath = 'tmp_analyze.cjs';
    const scriptCode = [
      "const fs = require('node:fs');",
      "const data = fs.readFileSync('data/numbers.txt', 'utf-8');",
      'const nums = data.trim().split(/[\\s,]+/).map(Number);',
      'const sum = nums.reduce((a, b) => a + b, 0);',
      'console.log(`sum=${sum}, count=${nums.length}, avg=${(sum / nums.length).toFixed(1)}`);',
    ].join('\n');

    const writeResult = await executor.execute(
      'write_file',
      JSON.stringify({ path: scriptPath, content: scriptCode }),
    );
    assert(
      writeResult.includes('写入') || writeResult.includes('成功'),
      'write_file 写入临时脚本成功',
    );
    assert(existsSync(join(projectPath, scriptPath)), '临时脚本已落盘到项目根');

    // ② 执行脚本（不传 language，按扩展名 .cjs 推断为 node；cwd=项目根）
    const runResult = await executor.execute(
      'run_code',
      JSON.stringify({ script_path: scriptPath }),
    );
    console.log(`  📤 run_code 输出: ${runResult.replace(/\n/g, ' | ')}`);
    assert(runResult.includes('sum=15'), '脚本执行结果正确（sum=15，证明读到了项目数据）');
    assert(runResult.includes('count=5'), '脚本执行结果正确（count=5）');
    assert(runResult.includes('avg=3.0'), '脚本执行结果正确（avg=3.0）');

    // ③ 清理脚本（闭环收尾）
    const deleteResult = await executor.execute(
      'delete_file',
      JSON.stringify({ path: scriptPath }),
    );
    assert(deleteResult.includes('已删除'), `delete_file 清理脚本成功: ${deleteResult}`);
    assert(!existsSync(join(projectPath, scriptPath)), '临时脚本已从磁盘删除（不留痕）');
    assert(existsSync(join(projectPath, 'data/numbers.txt')), '项目原始数据文件不受影响');

    // ─── 场景 2：delete_file 幂等 ──────────────────────────
    console.log('\n📋 场景 2：delete_file 幂等（删除不存在的文件不报错）');
    const idempotentResult = await executor.execute(
      'delete_file',
      JSON.stringify({ path: 'tmp_analyze.cjs' }),
    );
    assert(idempotentResult.includes('文件不存在'), '重复删除视为已删除（幂等）');

    // ─── 场景 3：参数防护 ──────────────────────────
    console.log('\n📋 场景 3：参数防护（code 与 script_path 二选一）');
    let conflictThrown = false;
    try {
      await executor.execute(
        'run_code',
        JSON.stringify({ code: 'console.log(1)', script_path: 'tmp_analyze.cjs' }),
      );
    } catch {
      conflictThrown = true;
    }
    assert(conflictThrown, 'code 与 script_path 同时传入 → 参数冲突报错');

    // ─── 场景 4：传统 code 模式不受影响 ──────────────────────────
    console.log('\n📋 场景 4：传统 code 模式（字符串执行）仍可用');
    const codeResult = await executor.execute(
      'run_code',
      JSON.stringify({ language: 'node', code: 'console.log(1 + 1)' }),
    );
    assert(codeResult.trim() === '2', `code 模式执行成功（输出 2）: ${codeResult.trim()}`);

    // ─── 场景 5：delete_file 拒绝删除目录 ──────────────────────────
    console.log('\n📋 场景 5：delete_file 拒绝删除目录（防误删）');
    let dirRejected = false;
    try {
      await executor.execute('delete_file', JSON.stringify({ path: 'data' }));
    } catch {
      dirRejected = true;
    }
    assert(dirRejected, 'delete_file 对目录路径报错（拒绝删除目录）');
    assert(existsSync(join(projectPath, 'data')), '目录未被误删');

    console.log('\n🎉 演示完成！「临时脚本」闭环全部场景验证通过。');
    console.log('\n📖 闭环说明：');
    console.log('   - write_file   → LLM 按需在项目根写一次性脚本');
    console.log('   - run_code(script_path) → 执行脚本拿数据（cwd=项目根，可读项目依赖与数据）');
    console.log('   - delete_file  → 清理脚本，不留痕（幂等，重复删安全）');
    console.log('   - 与传统 code 字符串模式互不干扰，二选一防护已内置');
  } finally {
    // 收尾：关闭内存存储 + 清理临时目录
    await memoryIndex.close?.();
    rmSync(projectPath, { recursive: true, force: true });
  }
}

// 执行主函数（错误时置退出码并打印）
main().catch((err) => {
  console.error('演示脚本异常:', err);
  process.exit(1);
});
