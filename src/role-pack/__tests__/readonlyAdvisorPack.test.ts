/**
 * 内置只读角色包「只读项目顾问」验收测试
 *
 * 验证两层只读边界同时生效，缺一不可：
 * 1) 角色包声明 `strategy.act.toolReadonly = 'readonly'` —— 执行面只读闸（`ToolRunner.applyPrechecks`）；
 * 2) `capabilities` 收窄为在线只读能力白名单 —— 特权工具暴露面（web_search / web_fetch）。
 *
 * 背景：能力白名单只控制暴露面、不改变 execute 路由（`execute()` 不查白名单），而只读策略
 * 只挡执行面、不隐藏特权工具。只配白名单等于没锁门，只配策略则特权工具仍可见——
 * 两层都配才是完整只读边界（ADR-045）。
 *
 * 断言清单：
 * - 写类/执行类（write_file / delete_file / run_command / run_code）逐条 readonly_denied；
 * - 读类（read_file / list_dir / search_project）不被拒，正常进入 execute。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RolePackManager } from '@/role-pack/rolePackManager.js';
import { validateManifestText } from '@/role-pack/validator.js';
import { resolveCapabilityTools } from '@/role-pack/capabilityMap.js';
import { resolveL2Strategy } from '@/role-pack/strategyResolver.js';
import { ALL_BUILTIN_TOOL_DEFS } from '@/agent/builtinTools.js';
import { ToolRunner, type ToolCall } from '@/agent/toolRunner.js';
import { NOOP_TRACER } from '@/agent/tracer.js';
import type { RolePackAssembly } from '@/role-pack/types.js';

/** 仓库根 role-packs/（内置角色包唯一内容源） */
const ROLE_PACKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'role-packs',
);

/** 被测角色包目录与唯一标识 */
const PACK_DIR = join(ROLE_PACKS_DIR, 'readonly-advisor');
const PACK_NAME = '只读项目顾问';

/** 构造工具调用元素（OpenAI 协议结构） */
function tc(name: string, args = '{}'): ToolCall {
  return { id: `t-${name}`, type: 'function', function: { name, arguments: args } };
}

/** 加载被测角色包并返回装配结果（未激活即抛错，防「空装配 → 断言全假绿」） */
async function loadReadonlyPack(): Promise<RolePackAssembly> {
  // configDir = 仓库根（角色包位于 <configDir>/role-packs/）
  const rpm = new RolePackManager(join(ROLE_PACKS_DIR, '..'));
  await rpm.load(PACK_NAME);
  const active = rpm.getActive();
  if (!active) throw new Error(`角色包「${PACK_NAME}」未激活，验收测试无法继续`);
  return active;
}

describe('内置只读角色包「只读项目顾问」', () => {
  it('manifest 校验无 error，且只读策略与能力白名单同时生效', async () => {
    // manifest 合法性（schema 必填/枚举/长度）
    const validation = validateManifestText(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'));
    expect(validation.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const active = await loadReadonlyPack();

    // 第一层：执行面只读闸的开关
    expect(active.meta.name).toBe(PACK_NAME);
    expect(active.strategy.act?.toolReadonly).toBe('readonly');
    // 第二层：特权工具暴露面收窄为在线只读能力，run_code 等特权不进白名单
    expect(resolveCapabilityTools(active.capabilities)).toEqual(['web_search', 'web_fetch']);
  });

  it('写类与执行类工具逐条被只读闸拒绝（不入 execute）', async () => {
    const active = await loadReadonlyPack();
    // execute 是 Mock：被调用即证明工具越过了只读闸
    const execute = vi.fn(async () => 'OK');
    const runner = new ToolRunner({
      execute,
      allTools: () => ALL_BUILTIN_TOOL_DEFS,
      getStrategy: () => resolveL2Strategy(active.strategy),
      tracer: NOOP_TRACER,
    });

    for (const name of ['write_file', 'delete_file', 'run_command', 'run_code']) {
      const result = await runner.runOne(tc(name));
      expect(result.status, `${name} 未被只读闸拦下`).toBe('blocked');
      expect(result.blockedReason, `${name} 拒绝原因应为 readonly_denied`).toBe('readonly_denied');
      // 前缀形态锁死（denied 通道文本须带 [ERR:TOOL:READONLY_DENIED]）
      expect(result.text).toContain('[ERR:TOOL:READONLY_DENIED]');
    }
    // 写类与执行类没有任何一个进入执行面
    expect(execute).not.toHaveBeenCalled();
  });

  it('读类工具不被拒（read_file / list_dir / search_project 正常执行）', async () => {
    const active = await loadReadonlyPack();
    const execute = vi.fn(async () => 'OK');
    const runner = new ToolRunner({
      execute,
      allTools: () => ALL_BUILTIN_TOOL_DEFS,
      getStrategy: () => resolveL2Strategy(active.strategy),
      tracer: NOOP_TRACER,
    });

    for (const name of ['read_file', 'list_dir', 'search_project']) {
      const result = await runner.runOne(tc(name));
      expect(result.status, `${name} 在只读模式被误拦`).toBe('ok');
    }
    // 三个读类工具均进入执行面
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
