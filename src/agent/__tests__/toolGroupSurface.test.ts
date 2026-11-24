/**
 * 工具面分组（组面）验收测试 — tasks/01 §7.6 锚点 1 / 3 / 4 / 5 / 6 / 9（内核半边）
 *
 * 本文件锁的是**判据**，不是实现细节：
 * - 锚点 1：每个内核工具都标了 `group`（漏标 = 分组真源缺口，且 fail-closed 会静默归 act）；
 * - 锚点 3：`isKnownTool` 能区分「已注册」与「拼错」——拼错的 `disableTools` 条目若查不出来，
 *   就是「用户以为关了、实际开着」（禁用方向 fail-open）；
 * - 锚点 4：未声明 `kind` 且无禁用表 ⇒ **不设任何工具面**，暴露面与改动前逐项相等；
 * - 锚点 5：`assistant` 的正向组 = `orchestrate` ⇒ 内核技术工具（readonly / act）一律不可见；
 * - 锚点 6：同一会话只启用一条**正向**轴，落地形态是「组谓词只挡不放行」——组面与
 *   `allowOnlyTools` / 能力位白名单取交集，谁都不清除谁（清除会留出 fail-open 窗口）；减法可叠加；
 * - 锚点 9：内核零 `orchestrate` 内置工具 ⇒ 宿主名单退役后「派生集 == 旧名单」才可能成立。
 *
 * 锚点 2（`kind` / 组名写错 ⇒ error）落 validator 测试；
 * 锚点 7（禁集并集）落 strategyResolver 测试；锚点 8（键面非 number）落 strategyKeys 测试。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolExecutor, type ToolGroupSurface } from '@/agent/toolExecutor.js';
import { ALL_BUILTIN_TOOL_DEFS } from '@/agent/builtinTools.js';
import { ToolRunner, type ToolCall } from '@/agent/toolRunner.js';
import { NOOP_TRACER } from '@/agent/tracer.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { ToolGroup } from '@/role-pack/strategyKeys.js';
import { DEFAULT_L2_STRATEGY } from '@/role-pack/strategyResolver.js';
import type { L2RuntimeStrategy } from '@/role-pack/types.js';

/** 组面快捷构造：未指明的成员一律取「不生效」缺省（与 applyRolePackToolExposure 的存量分支同义） */
function surface(partial: Partial<ToolGroupSurface>): ToolGroupSurface {
  return {
    allowedGroups: null,
    disabledGroups: new Set<ToolGroup>(),
    disabledTools: new Set<string>(),
    ...partial,
  };
}

describe('工具面分组（组面）· §7.6 验收锚点', () => {
  let tmpProject: string;
  let tmpData: string;
  let index: IMemoryStorage;
  let executor: ToolExecutor;

  beforeAll(async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-group-proj-'));
    tmpData = mkdtempSync(join(tmpdir(), 'memora-group-data-'));
    // confirmWrites=false：自动批准，避免组面测试被写确认对话框拦住
    const security = new SecurityGuard(tmpProject, tmpData, [], false, 'owner');
    index = new InMemoryStorage();
    executor = new ToolExecutor(tmpProject, security, index);
  });

  afterAll(async () => {
    await index.close?.();
    // Windows 下 Temp 常被系统服务握持，清理属 best-effort（同 toolExecutor.test.ts 口径）
    for (const p of [tmpProject, tmpData]) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* EPERM/EBUSY：留路径供追查，不把整份用例标红 */
      }
    }
  });

  it('锚点 1：每个内核工具定义都标了 group（漏标 ⇒ 红，同 diskWrite 的 fail-closed 范式）', () => {
    const missing = ALL_BUILTIN_TOOL_DEFS.filter((d) => d.group === undefined).map((d) => d.name);
    expect(
      missing,
      `以下工具漏标 group——漏标会被 fail-closed 归到 act，但那只是「兜底正确」，` +
        `分组真源（ToolDefinition.group）本身必须逐项在册：[${missing.join(', ')}]`,
    ).toEqual([]);
    // 顺带守住分组语义的完整性：三组都得有代表，否则「按组禁用」对某一组永远是空操作
    const groups = new Set(ALL_BUILTIN_TOOL_DEFS.map((d) => d.group));
    expect(groups.has('readonly')).toBe(true);
    expect(groups.has('act')).toBe(true);
  });

  it('锚点 9（内核半边）：内核零 orchestrate 内置工具——该组只由宿主工具承载', () => {
    const orchestrateBuiltins = ALL_BUILTIN_TOOL_DEFS.filter((d) => d.group === 'orchestrate').map(
      (d) => d.name,
    );
    expect(
      orchestrateBuiltins,
      'orchestrate 组语义 = 会话管理（宿主注册）。内核一旦出现该组内置工具，' +
        '「assistant 派生集 == 旧 ORCHESTRATOR_ALLOWED_TOOLS」就不再成立（多出来的那条不在旧名单里），' +
        '此时应改分组表而不是改宿主名单',
    ).toEqual([]);
  });

  it('锚点 3：isKnownTool 区分已注册与拼错的名字（装配期核对 disableTools 的判据）', () => {
    expect(executor.isKnownTool('read_file')).toBe(true);
    expect(executor.isKnownTool('write_file')).toBe(true);
    // 拼错的名字必须查不出来——查得出来（或恒 true）等于锚点 3 的报错永远不触发
    expect(executor.isKnownTool('reda_file')).toBe(false);
    expect(executor.isKnownTool('readfile')).toBe(false);
    expect(executor.isKnownTool('')).toBe(false);
  });

  it('锚点 4：未声明 kind 且无禁用表 ⇒ 不设任何工具面，暴露面与改动前逐项相等', () => {
    const baseline = executor.list.map((t) => t.name).sort();
    // 模拟 applyRolePackToolExposure 的存量分支（allowedGroups=null 且无禁用表 → setToolGroupSurface(null)）
    executor.setToolGroupSurface(null);
    expect(executor.list.map((t) => t.name).sort()).toEqual(baseline);

    // 与 allow-only 轴的既有语义逐字一致（null 组面绝不干扰宿主封闭面）
    executor.setToolAllowOnly(['read_file', 'write_file']);
    executor.setToolGroupSurface(null);
    expect(executor.list.map((t) => t.name).sort()).toEqual(['read_file', 'write_file']);
    executor.setToolAllowOnly(null);
  });

  it('锚点 5：正向组 = orchestrate ⇒ 内核 readonly / act 工具一律不可见（守定案 S1）', () => {
    executor.setToolGroupSurface(surface({ allowedGroups: new Set(['orchestrate']) }));
    const names = executor.list.map((t) => t.name);
    // 内核无 orchestrate 工具（锚点 9），故此处应为空——助手包看不到任何技术工具
    expect(names).toEqual([]);
    expect(names).not.toContain('read_file'); // readonly 组
    expect(names).not.toContain('write_file'); // act 组
    expect(names).not.toContain('ask_user'); // act 组（易分错工具定死在 §7.3）
    executor.setToolGroupSurface(null);
  });

  it('锚点 5（正向）：正向组 = readonly ⇒ readonly 可见、act 不可见', () => {
    executor.setToolGroupSurface(surface({ allowedGroups: new Set(['readonly']) }));
    const names = executor.list.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('search_memories');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('ask_user'); // act 组（易分错工具定死在 §7.3）
    expect(names).not.toContain('task_table_write'); // act 组
    executor.setToolGroupSurface(null);
  });

  it('锚点 6：work 未声明 disable ⇒ 不设工具面；声明 disableGroups ⇒ 只摘该组、不改其他轴', () => {
    // ① 无禁用表：不设面（上面锚点 4 已断言，此处断言「摘表存在时不误伤」）
    // ② 纯减法：摘 act 组，readonly 原样可见
    executor.setToolGroupSurface(surface({ disabledGroups: new Set(['act']) }));
    const names = executor.list.map((t) => t.name);
    expect(names).toContain('read_file'); // readonly 未被误伤
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('ask_user');
    expect(names).not.toContain('task_table_write');
    executor.setToolGroupSurface(null);

    // ③ 减法可与 allow-only 叠加（交集只会收紧，故不纳入互斥）
    executor.setToolAllowOnly(['read_file', 'write_file']);
    executor.setToolGroupSurface(surface({ disabledGroups: new Set(['act']) }));
    expect(executor.list.map((t) => t.name).sort()).toEqual(['read_file']);
    executor.setToolGroupSurface(null);
    executor.setToolAllowOnly(null);
  });

  it('锚点 6：组面与 allow-only 取交集（不互斥、不互相清除）', () => {
    // 组面只做收紧：组内工具仍须过 allow-only，组外工具一律挡掉 ⇒ 交集
    executor.setToolAllowOnly(['read_file', 'write_file']);
    executor.setToolGroupSurface(surface({ allowedGroups: new Set(['readonly']) }));
    expect(executor.list.map((t) => t.name)).toEqual(['read_file']);
    executor.setToolGroupSurface(null);
    // 退出组面后 allow-only 原样生效（不需要「恢复」——它从未被清除）
    expect(executor.list.map((t) => t.name).sort()).toEqual(['read_file', 'write_file']);
    executor.setToolAllowOnly(null);

    // 反向：先开组面再开 allow-only 同样不抛错（两轴并存 = 交集）
    executor.setToolGroupSurface(surface({ allowedGroups: new Set(['orchestrate']) }));
    expect(() => executor.setToolAllowOnly(['read_file'])).not.toThrow();
    // orchestrate ∩ {read_file} = ∅（内核无 orchestrate 工具）
    expect(executor.list.map((t) => t.name)).toEqual([]);
    executor.setToolGroupSurface(null);
    executor.setToolAllowOnly(null);
  });

  it('锚点 6（回归）：组内命中不得绕过 deny 减法（只挡不放行）', () => {
    // 旧实现「命中即 return true」会让组内工具跳过 deny —— deny 是减法，任何时候都该生效，
    // 放行方向被组面短路 = fail-open（宿主 deny 失效且没有别的测试会红）。
    executor.setDenyTools(['list_sessions']);
    executor.setToolGroupSurface(surface({ allowedGroups: new Set(['readonly']) }));
    const names = executor.list.map((t) => t.name);
    expect(names).toContain('read_file'); // 组内、未 deny ⇒ 可见
    expect(names).not.toContain('list_sessions'); // 组内但被 deny ⇒ 仍须挡掉
    executor.setToolGroupSurface(null);
    executor.setDenyTools([]);
  });

  it('锚点 3（拼错条目不生效的形状）：disableTools 里的未知名不会误伤任何工具', () => {
    executor.setToolGroupSurface(surface({ disabledTools: new Set(['reda_file']) }));
    const names = executor.list.map((t) => t.name);
    // 拼错的名字匹配不上任何工具 ⇒ 原有工具一个不少（这正是它 fail-open 的地方，
    // 所以 reportUnknownDisableTools 必须把它报出来，见锚点 3 的装配期核对）
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    executor.setToolGroupSurface(null);
  });
});

describe('包内工具注册（registerRolePackTools / clearRolePackTools）· §8.7 锚点 1 / 12', () => {
  let tmpProject: string;
  let tmpData: string;
  let index: IMemoryStorage;
  let executor: ToolExecutor;

  beforeAll(async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-packtool-proj-'));
    tmpData = mkdtempSync(join(tmpdir(), 'memora-packtool-data-'));
    const security = new SecurityGuard(tmpProject, tmpData, [], false, 'owner');
    index = new InMemoryStorage();
    executor = new ToolExecutor(tmpProject, security, index);
  });

  afterAll(async () => {
    await index.close?.();
    for (const p of [tmpProject, tmpData]) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* EPERM/EBUSY：best-effort 清理 */
      }
    }
  });

  /**
   * 构造一条包内工具注册项（最小可用定义）
   *
   * @param name 工具名
   * @returns registerRolePackTools 的入参项
   */
  const entry = (name: string) => ({
    definition: {
      name,
      description: `包内工具 ${name}`,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      group: 'readonly' as const,
      readonly: true,
      confirmPolicy: 'audit' as const,
    },
    handler: async () => JSON.stringify({ ok: true }),
  });

  /**
   * 构造工具调用元素（OpenAI 协议结构，只读闸测试用）
   *
   * @param name 工具名
   * @returns ToolCall 元素（空参）
   */
  const tc = (name: string): ToolCall => ({
    id: `t-${name}`,
    type: 'function',
    function: { name, arguments: '{}' },
  });

  it('注册后可见；clearRolePackTools 后消失（切包不残留的数据面）', () => {
    const registered = executor.registerRolePackTools([entry('pack_echo')]);
    expect(registered).toEqual(['pack_echo']);
    expect(executor.list.map((t) => t.name)).toContain('pack_echo');

    executor.clearRolePackTools();
    expect(executor.list.map((t) => t.name)).not.toContain('pack_echo');
  });

  it('空数组 → 不报错、不注册', () => {
    expect(executor.registerRolePackTools([])).toEqual([]);
  });

  it('锚点 12：批内任一与内置同名 ⇒ 全量放弃（同批的非冲突工具也不注册）', () => {
    const registered = executor.registerRolePackTools([
      entry('pack_ok'),
      entry('read_file'), // 与内置同名
    ]);
    // 全量放弃：一个都不注册，避免「注册了一半」的半残状态
    expect(registered).toEqual([]);
    expect(executor.list.map((t) => t.name)).not.toContain('pack_ok');
    // 内置工具本身不受影响（仍是内核原定义）
    expect(executor.list.map((t) => t.name)).toContain('read_file');
  });

  it('与已注册的自定义工具同名 ⇒ 全量放弃', () => {
    // 先注册一个普通自定义工具
    executor.registerTool(
      {
        name: 'ext_conflict',
        description: '宿主自定义工具',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      async () => 'ok',
    );

    const registered = executor.registerRolePackTools([entry('ext_conflict'), entry('pack_other')]);
    expect(registered).toEqual([]);
    expect(executor.list.map((t) => t.name)).not.toContain('pack_other');

    executor.removeTool('ext_conflict');
  });

  it('§8.7 锚点 3：包内工具 readonly:true 在 toolReadonly=readonly 下可调，readonly:false 被拒', async () => {
    // 注册一批两个包内工具：只读探针（entry 缺省 readonly:true）与写探针（显式 readonly:false）。
    // 断言链 = manifest 声明的 readonly 标志 → registerRolePackTools 写进 definition → ToolRunner 只读闸消费，
    // 任一环丢标志（变异点）都会让下面的断言转红。
    const readOnlyProbe = entry('pack_ro_gate');
    const writeProbe = {
      ...entry('pack_rw_gate'),
      definition: { ...entry('pack_rw_gate').definition, readonly: false },
    };
    expect(executor.registerRolePackTools([readOnlyProbe, writeProbe])).toEqual([
      'pack_ro_gate',
      'pack_rw_gate',
    ]);

    const execute = vi.fn(async () => 'OK');
    const runner = new ToolRunner({
      execute,
      // 只读闸查「全部工具定义」（内置 + 自定义），与生产装配形态（allToolDefinitions）同源
      allTools: () => executor.allToolDefinitions,
      getStrategy: () =>
        ({ ...DEFAULT_L2_STRATEGY, toolReadonly: 'readonly' }) as L2RuntimeStrategy,
      tracer: NOOP_TRACER,
    });

    // readonly:true ⇒ 放行进执行面（包内只读工具在只读模式下可用）
    const ok = await runner.runOne(tc('pack_ro_gate'));
    expect(ok.status, 'readonly:true 的包内工具被误拦').toBe('ok');

    // readonly:false ⇒ 只读闸拒绝（包内工具不因「来自角色包」豁免执行面闸门）
    const denied = await runner.runOne(tc('pack_rw_gate'));
    expect(denied.status, 'readonly:false 的包内工具未被只读闸拦下').toBe('blocked');
    expect(denied.blockedReason).toBe('readonly_denied');
    // 前缀形态锁死（denied 通道文本须带 [ERR:TOOL:READONLY_DENIED]）
    expect(denied.text).toContain('[ERR:TOOL:READONLY_DENIED]');

    // 执行面只进了只读工具（写工具没进 execute）
    expect(execute).toHaveBeenCalledTimes(1);

    executor.clearRolePackTools();
  });
});
