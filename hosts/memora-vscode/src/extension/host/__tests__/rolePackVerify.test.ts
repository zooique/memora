/**
 * 角色包校验闸回归测试（verify-pack.mjs）
 *
 * 守三件事：
 *   1. `formatVersion` / `strategy` 的结构与取值只由内核 validator 判定（单真源，包侧不再复制）；
 *   2. 内核不可加载时显式 SKIP 且打印原因，不静默放行、也不启用第二套本地产判据；
 *   3. 内核期望值漂移时本组用例会转红（配合 `strategyKeys.ts#isTemperature` 变异验证）。
 */
import { describe, it, expect } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 仓库根（本测试位于 hosts/memora-vscode/src/extension/host/__tests__/，向上六级） */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');

/** 源侧校验脚本（宿主构建期会整目录复制进 dist） */
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const VERIFY_PACK = join(SKILLS_DIR, 'role-pack-creator', 'scripts', 'verify-pack.mjs');

/** 一份最小合法 manifest（策略只声明温度，其余走内核默认） */
function manifestText(overrides: { formatVersion?: string; temperature?: number } = {}): string {
  return JSON.stringify(
    {
      name: 'verify-demo',
      displayName: '校验演示包',
      description: '仅用于 verify-pack 回归测试',
      formatVersion: overrides.formatVersion ?? '1.0.0',
      strategy: {
        act: { temperature: overrides.temperature ?? 0.7 },
      },
    },
    null,
    2,
  );
}

/** 建一个临时角色包目录，写入 manifest */
function createPack(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'memora-verify-pack-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), manifest, 'utf8');
  return dir;
}

/** 运行校验脚本（显式指定内核根，避免用例结果依赖模块解析路径） */
function runVerifyPack(packDir: string, scriptPath = VERIFY_PACK) {
  return spawnSync(process.execPath, [scriptPath, packDir, '--kernel-root', REPO_ROOT], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('verify-pack 的内核单真源契约', () => {
  it('合法 manifest → 内核 validator 通过，退出码 0', () => {
    const packDir = createPack(manifestText());
    const result = runVerifyPack(packDir);
    rmSync(packDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('内核 validator 通过');
  });

  it('strategy 取值越界 → 由内核报错（包侧无区间副本）', () => {
    // 2.5 超出内核 isTemperature 的 0~2 边界；包侧若自己维护区间，这里就会变成双真源
    const packDir = createPack(manifestText({ temperature: 2.5 }));
    const result = runVerifyPack(packDir);
    rmSync(packDir, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[manifest-kernel]');
    expect(result.stdout).toContain('temperature');
  });

  it('formatVersion 非 semver → 由内核报错（包侧不再自判）', () => {
    const packDir = createPack(manifestText({ formatVersion: '1.0' }));
    const result = runVerifyPack(packDir);
    rmSync(packDir, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[manifest-kernel]');
    expect(result.stdout).toContain('formatVersion');
  });

  it('内核不可加载 → 显式 SKIP 并说明原因；不启用第二套本地判据', () => {
    // 把脚本连同 _lib 复制到临时目录：模块解析链上找不到 @zooique/memora，
    // 且 findKernelRoot 也向上走不到内核仓库 —— 模拟「宿主未安装内核 dist」的真实环境。
    const sandbox = mkdtempSync(join(tmpdir(), 'memora-verify-pack-nokernel-'));
    const sandboxSkills = join(sandbox, 'skills');
    cpSync(join(SKILLS_DIR, '_lib'), join(sandboxSkills, '_lib'), { recursive: true });
    cpSync(
      join(SKILLS_DIR, 'role-pack-creator', 'scripts'),
      join(sandboxSkills, 'role-pack-creator', 'scripts'),
      { recursive: true },
    );
    // 故意写坏 formatVersion 与温度：内核判不了时脚本必须 SKIP，而不是自己判红/判绿
    const packDir = createPack(manifestText({ formatVersion: '1.0', temperature: 2.5 }));
    const result = spawnSync(
      process.execPath,
      [join(sandboxSkills, 'role-pack-creator', 'scripts', 'verify-pack.mjs'), packDir],
      { encoding: 'utf8', timeout: 60_000 },
    );
    rmSync(packDir, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[manifest-kernel]');
    expect(result.stdout).toContain('未能加载内核');
  });
});
