/**
 * 执行面确认入口登记表守卫（CMD-1-BYPASS · 2026-10-03）
 *
 * 钉死两件事（当前**没有任何测试**覆盖，改动默认不会被红）：
 *   1. 登记表键集与 `diskWrite === 'opaque'` 派生集**双向相等** ⇒ 新增执行面漏登记即红；
 *   2. 每个执行面**真的走它登记的确认入口**且**不走其它入口** ⇒ 换线/隐式改判即红。
 *
 * 背景（实锤）：`classifyCommand`（deny / always-ask）唯一调用点 = `confirmCommandRun`，
 * 唯一消费面 = `toolExecutor` 的 `run_command` 分支 ⇒ 命令内容裁决只锁一个执行面。
 * 本文件把「三面走 confirmScriptRun / 单面走 confirmCommandRun」从口头结论变成机器判据。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolExecutor } from '@/agent/toolExecutor.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { CONFIRM_ENTRY_BY_TOOL, requireConfirmEntry, requireConfirmingEntry } from '@/security/confirmEntries.js';
import { OPAQUE_WRITE_TOOL_NAMES } from '@/agent/builtinTools.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';

describe('执行面确认入口登记表（CMD-1-BYPASS · 守卫）', () => {
  let tmpProject: string;
  let tmpData: string;
  let index: InMemoryStorage;
  let security: SecurityGuard;
  let executor: ToolExecutor;

  // 夹具成本纪律：本机沙箱删除 ~100ms/文件 ⇒ 每用例建/删两个临时目录会把 afterEach 钩子拖到
  // 10s 超时（本仓已知环境限制，非产品缺陷）。故整文件只建一次、只删一次；用例间只换 spy。
  beforeAll(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-confirm-entry-'));
    tmpData = mkdtempSync(join(tmpdir(), 'memora-confirm-entry-data-'));
    mkdirSync(join(tmpProject, 'scripts'), { recursive: true });
    writeFileSync(join(tmpProject, 'scripts/probe.js'), 'console.log("probe");\n', 'utf-8');
    index = new InMemoryStorage();
    security = new SecurityGuard(tmpProject, tmpData, [], false, 'owner');
    // run_code / run_skill_script 走宿主注入能力；不注入则 handler 在确认之前就 NOT_AVAILABLE，测不到确认入口
    executor = new ToolExecutor(tmpProject, security, index, undefined, undefined, undefined, {
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    });
    executor.runSkillScript = async () => null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await index.close?.();
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  it('登记表键集必须与 opaque 派生集双向相等（新增执行面漏登记即红）', () => {
    const declared = Object.keys(CONFIRM_ENTRY_BY_TOOL).sort();
    const derived = [...OPAQUE_WRITE_TOOL_NAMES].sort();
    expect(declared).toEqual(derived);
  });

  it('requireConfirmEntry 对未登记工具抛错（fail-closed：漏登记比登记错更危险）', () => {
    expect(() => requireConfirmEntry('some_future_exec_tool')).toThrow(/未登记确认入口/);
  });

  /** 每个执行面：走登记入口 → 其它入口零调用（确认返回 false ⇒ handler 拒收） */
  const surfaces: ReadonlyArray<{
    tool: string;
    args: Record<string, unknown>;
    entry: 'command' | 'script';
  }> = [
    { tool: 'run_command', args: { command: 'echo probe' }, entry: 'command' },
    { tool: 'run_code', args: { language: 'js', code: 'console.log(1)' }, entry: 'script' },
    { tool: 'run_project_script', args: { script_path: 'scripts/probe.js' }, entry: 'script' },
    { tool: 'run_skill_script', args: { skill_name: 'demo', script_path: 'x.js' }, entry: 'script' },
  ];

  for (const surface of surfaces) {
    it(`${surface.tool} 必须走登记入口 [${surface.entry}]，且不经另一个入口`, async () => {
      const commandSpy = vi.spyOn(security, 'confirmCommandRun').mockResolvedValue(false);
      const scriptSpy = vi.spyOn(security, 'confirmScriptRun').mockResolvedValue(false);

      const result = await executor.execute(
        surface.tool,
        JSON.stringify(surface.args),
      );

      // 确认被拒 ⇒ handler 不执行，返回拒收串
      expect(result).toContain('DECLINE');
      if (surface.entry === 'command') {
        expect(commandSpy).toHaveBeenCalledTimes(1);
        expect(commandSpy.mock.calls[0]![1]).toBe(surface.tool);
        expect(scriptSpy).not.toHaveBeenCalled();
      } else {
        expect(scriptSpy).toHaveBeenCalledTimes(1);
        expect(scriptSpy.mock.calls[0]![1]).toBe(surface.tool);
        expect(commandSpy).not.toHaveBeenCalled();
      }
    });
  }

  it('register_work 登记为 none（非确认入口）⇒ 内核侧不经任何确认方法', async () => {
    expect(requireConfirmEntry('register_work')).toBe('none');
    // 实锤行为：注入回调后直接执行，三个确认方法零调用
    executor.registerWork = async () => 'ok';
    const commandSpy = vi.spyOn(security, 'confirmCommandRun');
    const scriptSpy = vi.spyOn(security, 'confirmScriptRun');
    const writeSpy = vi.spyOn(security, 'requestWriteConfirmation');
    const result = await executor.execute(
      'register_work',
      JSON.stringify({ path: 'src/index.ts', description: '入口' }),
    );
    expect(result).toBe('ok');
    expect(commandSpy).not.toHaveBeenCalled();
    expect(scriptSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('requireConfirmingEntry 对 none 档抛错（禁把非执行面塞进确认闸）', () => {
    expect(() => requireConfirmingEntry('register_work')).toThrow(/登记为 none/);
  });
});
