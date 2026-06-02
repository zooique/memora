/**
 * CLI E2E 测试
 *
 * 覆盖：
 *   - CLI 启动到欢迎语出现
 *   - /exit 优雅退出
 *   - /help 显示帮助
 *   - /memories 显示已加载记忆
 *
 * 策略：通过 child_process spawn `tsx src/index.ts`，
 * 把 stdin 指向一个可读流，自动喂入命令 + EOF
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// 测试文件在 src/**/__tests__/，回退到项目根
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

describe('CLI E2E', () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeAll(() => {
    // 临时 HOME 让 ~/.memora 落到 tmp
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-e2e-home-'));
    mkdirSync(join(tmpHome, '.memora'), { recursive: true });
    // 临时项目目录
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-e2e-proj-'));
    mkdirSync(join(tmpProject, '.memora'), { recursive: true });
    mkdirSync(join(tmpProject, '.memora/personality'), { recursive: true });
    mkdirSync(join(tmpProject, '.memora/rules'), { recursive: true });

    // 写一个 personality 文件让 loader 至少能扫到
    writeFileSync(
      join(tmpProject, '.memora/personality/default.md'),
      `---
type: personality
permanence: always
name: default
---
# 默认人格
简洁、友好。`,
      'utf-8',
    );

    // 写一个 user-level config 用 mock provider
    writeFileSync(
      join(tmpHome, '.memora/config.json'),
      JSON.stringify({
        llm: { provider: 'mock' },
        memory: { dataDir: join(tmpHome, '.memora') },
        security: { permission: 'owner', confirmWrites: false },
        allowedPaths: [],
      }),
      'utf-8',
    );
  });

  afterAll(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  /**
   * 启动 CLI，喂入 commands，收集 stdout，等待退出
   */
  function runCli(commands: string[]): Promise<{ stdout: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const proc: ChildProcess = spawn(
        process.execPath, // node binary
        [join(PROJECT_ROOT, 'node_modules/tsx/dist/cli.mjs'), 'src/index.ts'],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`CLI 启动超时。stdout: ${stdout}\nstderr: ${stderr}`));
      }, 15000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, exitCode: code });
      });

      // 串行喂入命令（每条间留 200ms 让 REPL 处理）
      let i = 0;
      const feed = () => {
        if (i < commands.length) {
          proc.stdin?.write(`${commands[i]}\n`);
          i++;
          setTimeout(feed, 200);
        } else {
          // 等待 CLI 自然退出
        }
      };
      feed();
    });
  }

  it('应该能启动并显示欢迎语', async () => {
    const { stdout, exitCode } = await runCli(['/exit']);
    expect(stdout).toContain('Memora Agent v0.1.0');
    expect(exitCode).toBe(0);
  }, 20000);

  it('应该响应 /help 指令', async () => {
    const { stdout, exitCode } = await runCli(['/help', '/exit']);
    expect(stdout).toContain('命令：');
    expect(stdout).toContain('/exit');
    expect(stdout).toContain('/help');
    expect(stdout).toContain('/topic');
    expect(stdout).toContain('/topics');
    expect(exitCode).toBe(0);
  }, 20000);

  it('应该响应 /memories 指令', async () => {
    const { stdout, exitCode } = await runCli(['/memories', '/exit']);
    // Loader 扫不到（HOME 改了，但 project 内的 .memora 在 cwd 默认 loadConfig 不读）
    // 启动时 loader 走的是 memoraDir（来自 config.memory.dataDir = tmpHome/.memora）
    // tmpHome/.memora 没有 personality 文件，所以 memories 为空
    expect(stdout).toContain('已加载 0 条必召记忆');
    expect(exitCode).toBe(0);
  }, 20000);

  it('应该响应 /tools 指令', async () => {
    const { stdout, exitCode } = await runCli(['/tools', '/exit']);
    expect(stdout).toContain('可用工具：');
    expect(exitCode).toBe(0);
  }, 20000);

  it('应该响应 /topics 指令（初始空）', async () => {
    const { stdout, exitCode } = await runCli(['/topics', '/exit']);
    expect(stdout).toContain('（暂无话题）');
    expect(exitCode).toBe(0);
  }, 20000);
});
