/**
 * 测试临时目录统一入口（宿主包 · **唯一建目录点**）
 *
 * 与内核包 `src/__tests__/helpers/tmpDir.ts` **语义同构**（建目录 / 顶层注册清理 / 两个语义函数
 * 的判据一致；注释措辞与行数不同，**不是逐字同构**，勿按机械 diff 校验）。改判据须两处同批改。
 * 不合并成跨包 helper 的理由见内核侧文件头：内核与宿主是两个独立测试工程，
 * 共享要引入 workspace 包 = 过度设计；SSOT 在此按**包边界**切。
 *
 * 用法与语义（两种，按原测试目录的生命周期二选一）：
 * - `makeTempDir`：用例级（写在 `beforeEach`，本用例结束即删）；
 * - `makeSuiteTempDir`：套级（写在 `beforeAll`，本文件全部用例跑完才删）。
 *
 * 清理由本模块**顶层注册** `afterEach` / `afterAll` 完成——import 即生效，
 * 调用方不得再各写一份 `rmSync`（散点判据：第二个消费面天然漏配且无测试报警）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';

/** 用例级目录登记表（afterEach 清空；每个测试 worker 各持一份） */
const caseDirs: string[] = [];
/** 套级目录登记表（afterAll 清空；与用例级分开，避免被提前删掉） */
const suiteDirs: string[] = [];

/**
 * 删除登记表里的全部目录（清理失败不抛错，只告警）
 *
 * @param dirs  待删目录清单（函数返回后会被清空）
 * @param scope 作用域标签（仅用于告警文案）
 */
function disposeRegistered(dirs: string[], scope: string): void {
  const pending = dirs.splice(0, dirs.length);
  for (const dir of pending) {
    try {
      // maxRetries：宿主测试会真的落盘会话/记忆文件，Windows 上偶有短暂占用
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (err) {
      console.warn(`[tmpDir] ${scope} 临时目录清理失败，已跳过：${dir}`, err);
    }
  }
}

afterEach(() => disposeRegistered(caseDirs, 'case'));
afterAll(() => disposeRegistered(suiteDirs, 'suite'));

/**
 * 建一个**用例级**临时目录（本用例结束自动删除）
 *
 * @param prefix 目录名前缀（沿用各测试原有前缀）
 * @returns 新建目录的绝对路径
 */
export function makeTempDir(prefix = 'memora-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  caseDirs.push(dir);
  return dir;
}

/**
 * 建一个**套级**临时目录（本文件全部用例跑完自动删除）
 *
 * @param prefix 目录名前缀
 * @returns 新建目录的绝对路径
 */
export function makeSuiteTempDir(prefix = 'memora-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  suiteDirs.push(dir);
  return dir;
}
