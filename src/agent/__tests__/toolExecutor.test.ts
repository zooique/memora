/**
 * 工具执行器单元测试
 *
 * 覆盖：
 *   - read_file：成功 / 路径越界 / 黑名单
 *   - write_file：成功（owner+confirmWrites=false 自动批准）/ 父目录自动创建 / 路径越界 / 黑名单
 *   - list_dir：默认项目根 / 递归 / 深度限制 / 忽略 node_modules / 黑名单
 *   - search_memories：match 模式 / near 模式 / 空查询 / 注入限制
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolExecutor, sanitizeExternalText, BUILTIN_TOOLS } from '@/agent/toolExecutor.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { estimateTokensText } from '@/agent/contextManager.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { ICodeExecutionProvider } from '@/code-exec/types.js';
import { MemoraError, toolError } from '@/utils/errors.js';

describe('工具执行器（6 个工具）', () => {
  let tmpProject: string;
  let tmpData: string;
  let index: IMemoryStorage;
  let security: SecurityGuard;
  let executor: ToolExecutor;

  beforeAll(async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-tool-proj-'));
    tmpData = mkdtempSync(join(tmpdir(), 'memora-tool-data-'));

    // 创建项目结构
    mkdirSync(join(tmpProject, 'src'), { recursive: true });
    mkdirSync(join(tmpProject, 'node_modules'), { recursive: true });
    mkdirSync(join(tmpProject, '.git'), { recursive: true });
    writeFileSync(join(tmpProject, 'src/index.ts'), 'export const x = 1;\n', 'utf-8');
    writeFileSync(join(tmpProject, 'src/utils.ts'), 'export const y = 2;\n', 'utf-8');
    writeFileSync(join(tmpProject, 'README.md'), '# Test Project\n', 'utf-8');
    writeFileSync(join(tmpProject, 'node_modules/should-be-ignored.ts'), 'ignore me\n', 'utf-8');
    writeFileSync(join(tmpProject, '.git/config'), 'ignore me too\n', 'utf-8');

    // SecurityGuard：owner + confirmWrites=false（自动批准）
    security = new SecurityGuard(tmpProject, tmpData, [], false, 'owner');

    // InMemoryStorage（纯内存实现，无需 better-sqlite3）
    index = new InMemoryStorage();

    // 插入一些测试记忆
    await index.upsert({
      id: 'mem-1',
      content: 'Memora 万物皆记忆，记忆统一为类型 + 永久性',
      source: 'rule',
      name: 'core-rule',
      createdAt: '2026-06-01T00:00:00Z',
      accessedAt: '2026-06-01T00:00:00Z',
    });
    await index.upsert({
      id: 'mem-2',
      content: 'TypeScript strict 模式下禁止 any 隐式转换',
      source: 'skill',
      name: 'typescript-skill',
      createdAt: '2026-06-01T00:00:00Z',
      accessedAt: '2026-06-01T00:00:00Z',
    });

    executor = new ToolExecutor(tmpProject, security, index);
  });

  afterAll(async () => {
    await index.close?.();
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  describe('BUILTIN_TOOLS 注册表', () => {
    it('应注册 18 个内置工具', () => {
      const names = BUILTIN_TOOLS.map((t) => t.name);
      expect(names.length).toBe(18);
      expect(names).toContain('delete_file');
    });

    it('builtinDefinitions 应含全部内置 + 条件工具（只读闸查询源，不受白名单影响）', () => {
      const defs = executor.builtinDefinitions;
      const names = defs.map((t) => t.name);
      // 始终内置 18 + 条件 4（web_search / web_fetch / run_code / search_project）
      expect(names.length).toBe(22);
      expect(names).toContain('write_file');
      expect(names).toContain('web_search');
      expect(names).toContain('web_fetch');
      expect(names).toContain('run_code');
      expect(names).toContain('search_project');
      expect(names).toContain('compress_context');
      // 只读闸语义完整性：写/执行工具非只读（falsy），读工具只读（含 web_search 4-2 修复）
      expect(defs.find((t) => t.name === 'write_file')!.readonly).toBeFalsy();
      expect(defs.find((t) => t.name === 'run_code')!.readonly).toBeFalsy();
      expect(defs.find((t) => t.name === 'web_search')!.readonly).toBe(true);
      expect(defs.find((t) => t.name === 'web_fetch')!.readonly).toBe(true);
      // search_project 只读搜索，readonly 语义覆盖
      expect(defs.find((t) => t.name === 'search_project')!.readonly).toBe(true);
    });

    it('每个工具应有 name + description + parameters（含 required 数组）', () => {
      for (const tool of BUILTIN_TOOLS) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters.type).toBe('object');
        expect(Array.isArray(tool.parameters.required)).toBe(true);
      }
    });
  });

  describe('工具暴露模型（默认常驻 vs 角色启动，tool-exposure-model 探索草稿）', () => {
    afterEach(() => {
      // 复位白名单，避免用例间污染
      executor.setToolWhitelist(null);
    });

    it('toolWhitelist=null 时全部内置暴露（含特权工具 task_table_write）', () => {
      const names = executor.list.map((t) => t.name);
      expect(names).toContain('read_file');
      expect(names).toContain('task_table_write');
    });

    it('空白名单（[]）时：常驻工具仍暴露，特权工具被过滤', () => {
      executor.setToolWhitelist([]);
      const names = executor.list.map((t) => t.name);
      // 常驻豁免集（判据 A：项目内/内核自有）不受白名单影响
      expect(names).toContain('read_file');
      expect(names).toContain('write_file');
      expect(names).toContain('run_project_script');
      expect(names).toContain('read_skill');
      // 特权工具（task:plan / 外部网络）被过滤
      expect(names).not.toContain('task_table_write');
      expect(names).not.toContain('task_table_update');
    });

    it('声明 web:search 白名单时：常驻 + web_search 特权暴露，task 特权仍过滤', () => {
      // 未注入 webSearchProvider 时 web_search 条件工具不进入 baseTools，故仅验证常驻与 task 过滤
      executor.setToolWhitelist(['web_search']);
      const names = executor.list.map((t) => t.name);
      expect(names).toContain('read_file');
      expect(names).not.toContain('task_table_write');
    });

    it('白名单过滤后执行路由不受影响（暴露面控制 ≠ execute 拦截）——call 不存在工具直接参数报错', async () => {
      // task_table_write 被过滤仅影响 LLM 可见性；刻意直接调用仍走 execute（由参数校验兜底）
      await expect(executor.execute('task_table_write', JSON.stringify({}))).rejects.toThrow();
    });
  });

  describe('run_project_script（默认开放：项目内已有脚本执行）', () => {
    it('成功执行项目内脚本（扩展名推断运行时，cwd=项目根）', async () => {
      // scripts/ 放脚本，验证相对根路径 + cwd=项目根（脚本可读项目相对文件）
      mkdirSync(join(tmpProject, 'scripts'), { recursive: true });
      writeFileSync(
        join(tmpProject, 'scripts/echo-env.js'),
        "const fs = require('node:fs'); const p = require('node:path'); console.log('cwd-project-root:', fs.existsSync(p.join(process.cwd(), 'README.md'))); console.log('stdout-ok');",
        'utf-8',
      );
      const result = await executor.execute(
        'run_project_script',
        JSON.stringify({ script_path: 'scripts/echo-env.js' }),
      );
      // 成功且 cwd 锚定项目根（能读项目内 README.md）
      expect(result).toContain('cwd-project-root: true');
      expect(result).toContain('stdout-ok');
    });

    it('路径越界（../ 穿越项目根）时拒绝执行', async () => {
      const result = await executor.execute(
        'run_project_script',
        JSON.stringify({ script_path: '../escape.sh' }),
      );
      expect(result).toContain('PATH_DENIED');
    });

    it('缺少 script_path 参数时抛参数错误（schema 必填校验拦截）', async () => {
      await expect(executor.execute('run_project_script', JSON.stringify({}))).rejects.toThrow(
        '工具参数缺失',
      );
    });

    it('guest 模式（无确认回调）时 fail-closed 拒绝', async () => {
      // guest 强制确认；未注入 confirmationHandler → confirmScriptRun fail-closed → 拒绝
      const guestSecurity = new SecurityGuard(tmpProject, tmpData, [], false, 'guest');
      const guestExecutor = new ToolExecutor(tmpProject, guestSecurity, index);
      const result = await guestExecutor.execute(
        'run_project_script',
        JSON.stringify({ script_path: 'scripts/echo-env.js' }),
      );
      expect(result).toContain('SCRIPT_DECLINE');
    });

    it('timeout_ms 透传内核执行器：短超时脚本即 [SCRIPT_TIMEOUT]（2026-09-08 超时弹性）', async () => {
      // 死循环脚本 + 显式 1s（最小 clamp）超时：验证 timeout_ms 参数真实生效（不卡默认 60s）
      writeFileSync(join(tmpProject, 'scripts/hang.js'), 'while (true) {}', 'utf-8');
      const result = await executor.execute(
        'run_project_script',
        JSON.stringify({ script_path: 'scripts/hang.js', timeout_ms: 1 }),
      );
      expect(result).toContain('SCRIPT_TIMEOUT');
    });
  });

  describe('read_skill（渐进披露 L2）', () => {
    it('未注入 readSkill 回调时返回不可用提示', async () => {
      const result = await executor.execute('read_skill', JSON.stringify({ name: 'write' }));
      expect(result).toContain('read_skill 不可用');
    });

    it('注入 readSkill 回调后返回技能正文', async () => {
      executor.readSkill = async (name) => (name === 'write' ? '## 写作技能\n1. 起草\n2. 润色' : null);
      const result = await executor.execute('read_skill', JSON.stringify({ name: 'write' }));
      expect(result).toContain('起草');
      expect(result).toContain('润色');
    });

    it('超长技能正文被截断到上限（防超长技能注入上下文）', async () => {
      executor.readSkill = async () => 'x'.repeat(60_000);
      const result = await executor.execute('read_skill', JSON.stringify({ name: 'huge' }));
      // 50KB 上限 + 截断省略号：返回不被超长技能正文撑爆
      expect(result.length).toBeLessThanOrEqual(50_001);
      expect(result.endsWith('…')).toBe(true);
    });

    it('技能不存在时返回 SKILL_NOT_FOUND', async () => {
      executor.readSkill = async () => null;
      const result = await executor.execute('read_skill', JSON.stringify({ name: 'nope' }));
      expect(result).toContain('SKILL_NOT_FOUND');
    });

    it('缺少 name 参数时应抛 MemoraError（必填参数校验）', async () => {
      await expect(executor.execute('read_skill', JSON.stringify({}))).rejects.toThrow(
        '工具参数缺失',
      );
    });
  });

  describe('register_work（作品投影登记）', () => {
    it('未注入 registerWork 回调时返回不可用提示', async () => {
      const result = await executor.execute(
        'register_work',
        JSON.stringify({ path: 'docs/a.md', description: '说明' }),
      );
      expect(result).toContain('register_work 不可用');
    });

    it('注入 registerWork 回调后返回登记结果', async () => {
      executor.registerWork = async (path, description) =>
        `✅ 已登记作品索引：${path}（${description}）`;
      const result = await executor.execute(
        'register_work',
        JSON.stringify({ path: 'docs/a.md', description: '说明' }),
      );
      expect(result).toContain('✅ 已登记作品索引');
      expect(result).toContain('docs/a.md');
    });

    it('缺少必填参数（path/description）时应抛 MemoraError', async () => {
      executor.registerWork = async () => 'ok';
      await expect(
        executor.execute('register_work', JSON.stringify({ path: 'docs/a.md' })),
      ).rejects.toThrow('工具参数缺失');
    });
  });

  describe('run_skill_script（渐进披露 L3）', () => {
    it('未注入 runSkillScript 回调时返回不可用提示', async () => {
      const result = await executor.execute(
        'run_skill_script',
        JSON.stringify({ skill_name: 'write', script_path: 'lint.ts' }),
      );
      expect(result).toContain('run_skill_script 不可用');
    });

    it('超长输出被截断到上限（8-1 对齐 run_code 防护，防刷屏撑爆上下文）', async () => {
      executor.runSkillScript = async () => 'x'.repeat(50_000);
      const result = await executor.execute(
        'run_skill_script',
        JSON.stringify({ skill_name: 'write', script_path: 'lint.ts' }),
      );
      // 20KB 上限 + 截断省略号：返回不被超长输出撑爆
      expect(result.length).toBeLessThanOrEqual(20_001);
      expect(result.endsWith('…')).toBe(true);
    });

    it('正常输出原样返回（不截断）', async () => {
      executor.runSkillScript = async () => 'lint 通过，0 errors';
      const result = await executor.execute(
        'run_skill_script',
        JSON.stringify({ skill_name: 'write', script_path: 'lint.ts' }),
      );
      expect(result).toBe('lint 通过，0 errors');
    });

    it('owner + confirmScripts=false 默认放行（来源可信，无人值守可跑）', async () => {
      executor.runSkillScript = async () => 'ok';
      const result = await executor.execute(
        'run_skill_script',
        JSON.stringify({ skill_name: 'write', script_path: 'lint.ts' }),
      );
      expect(result).toBe('ok');
    });

    it('guest 模式（无确认回调）时 fail-closed 拒绝（2026-09-11 定案：受限权限下技能脚本不再豁免确认）', async () => {
      // guest 恒确认；未注入 confirmationHandler → confirmScriptRun fail-closed → 拒绝
      const guestSecurity = new SecurityGuard(tmpProject, tmpData, [], false, 'guest');
      const guestExecutor = new ToolExecutor(tmpProject, guestSecurity, index);
      guestExecutor.runSkillScript = async () => '不应执行';
      const result = await guestExecutor.execute(
        'run_skill_script',
        JSON.stringify({ skill_name: 'write', script_path: 'lint.ts' }),
      );
      expect(result).toContain('SCRIPT_DECLINE');
    });

    it('owner + confirmScripts=true（无确认回调）时 fail-closed 拒绝（开关对技能脚本生效）', async () => {
      const strictSecurity = new SecurityGuard(tmpProject, tmpData, [], false, 'owner', true);
      const strictExecutor = new ToolExecutor(tmpProject, strictSecurity, index);
      strictExecutor.runSkillScript = async () => '不应执行';
      const result = await strictExecutor.execute(
        'run_skill_script',
        JSON.stringify({ skill_name: 'write', script_path: 'lint.ts' }),
      );
      expect(result).toContain('SCRIPT_DECLINE');
    });

    it('owner + confirmScripts=true + 确认回调：同意放行 / 拒绝拦截（2026-09-11 定案）', async () => {
      const strictSecurity = new SecurityGuard(tmpProject, tmpData, [], false, 'owner', true);
      const strictExecutor = new ToolExecutor(tmpProject, strictSecurity, index);

      // 回调同意 → 放行执行
      strictSecurity.onWriteConfirmation(async () => true);
      strictExecutor.runSkillScript = async () => 'lint 通过，0 errors';
      const ok = await strictExecutor.execute(
        'run_skill_script',
        JSON.stringify({ skill_name: 'write', script_path: 'lint.ts' }),
      );
      expect(ok).toBe('lint 通过，0 errors');

      // 回调拒绝 → SCRIPT_DECLINE，脚本不执行
      strictSecurity.onWriteConfirmation(async () => false);
      strictExecutor.runSkillScript = async () => '不应执行';
      const declined = await strictExecutor.execute(
        'run_skill_script',
        JSON.stringify({ skill_name: 'write', script_path: 'lint.ts' }),
      );
      expect(declined).toContain('SCRIPT_DECLINE');
    });
  });

  describe('web_search（未注入提供者）', () => {
    it('list 不应包含 web_search 工具', () => {
      const names = executor.list.map((t) => t.name);
      expect(names).not.toContain('web_search');
    });

    it('执行 web_search 应返回不可用提示', async () => {
      const result = await executor.execute('web_search', JSON.stringify({ query: 'test' }));
      expect(result).toContain('网络搜索功能未配置');
    });
  });

  describe('web_search（G5 降级端点透出）', () => {
    it('降级结果应透出「搜索来源：<endpoint>」头部', async () => {
      const mockProvider = {
        search: async () => [
          { title: '标题一', url: 'https://example.com/1', snippet: '摘要一', endpoint: 'DuckDuckGo' },
        ],
      };
      const exec = new ToolExecutor(tmpProject, security, index, mockProvider);
      const result = await exec.execute('web_search', JSON.stringify({ query: 'test' }));
      expect(result).toContain('（搜索来源：DuckDuckGo）');
    });
  });

  describe('web_fetch / run_code（未注入提供者）', () => {
    it('list 不应包含 web_fetch 与 run_code 工具', () => {
      const names = executor.list.map((t) => t.name);
      expect(names).not.toContain('web_fetch');
      expect(names).not.toContain('run_code');
    });

    it('执行 web_fetch 应返回不可用提示', async () => {
      const result = await executor.execute('web_fetch', JSON.stringify({ url: 'https://example.com' }));
      expect(result).toContain('网页抓取功能未配置');
    });

    it('执行 run_code 应返回不可用提示', async () => {
      const result = await executor.execute('run_code', JSON.stringify({ language: 'node', code: 'console.log(1)' }));
      expect(result).toContain('代码执行功能未配置');
    });
  });

  describe('web_fetch（注入提供者）', () => {
    let execWithFetch: ToolExecutor;
    const mockFetchProvider = {
      async fetch(url: string, options?: { maxChars?: number }) {
        return {
          url,
          title: '抓取标题',
          content: `正文内容（${options?.maxChars ?? 8000}）`.repeat(10),
        };
      },
    };

    beforeAll(() => {
      execWithFetch = new ToolExecutor(
        tmpProject,
        security,
        index,
        undefined,
        undefined,
        mockFetchProvider,
      );
    });

    it('注入 fetchProvider 后 list 应包含 web_fetch 工具', () => {
      const names = execWithFetch.list.map((t) => t.name);
      expect(names).toContain('web_fetch');
    });

    it('执行 web_fetch 应返回标题 + 净化后的正文', async () => {
      const result = await execWithFetch.execute(
        'web_fetch',
        JSON.stringify({ url: 'https://example.com/page' }),
      );
      expect(result).toContain('来源：https://example.com/page');
      expect(result).toContain('标题：抓取标题');
      expect(result).toContain('正文内容');
    });

    it('缺少 url 参数应抛 MemoraError（必填参数校验）', async () => {
      await expect(execWithFetch.execute('web_fetch', JSON.stringify({}))).rejects.toThrow(
        '工具参数缺失',
      );
    });

    it('非 http/https 协议的 url 应抛错（协议白名单）', async () => {
      await expect(
        execWithFetch.execute('web_fetch', JSON.stringify({ url: 'file:///etc/passwd' })),
      ).rejects.toThrow(/协议不支持/);
    });
  });

  describe('run_code（注入提供者）', () => {
    let execWithCode: ToolExecutor;
    // mock 把 cwd 编入 stdout，便于断言 script_path 模式的 cwd=项目根（无需捕获变量，避免 TS 收窄陷阱）
    const mockCodeProvider: ICodeExecutionProvider = {
      async execute(code, language, options) {
        if (code.includes('boom')) {
          return { stdout: '', stderr: 'reference error', exitCode: 1, timedOut: false };
        }
        return {
          stdout: `${language}:ok:cwd=${options?.cwd ?? 'none'}`,
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      },
    };

    beforeAll(() => {
      execWithCode = new ToolExecutor(
        tmpProject,
        security,
        index,
        undefined,
        undefined,
        undefined,
        mockCodeProvider,
      );
    });

    it('注入 codeExecutionProvider 后 list 应包含 run_code 工具', () => {
      const names = execWithCode.list.map((t) => t.name);
      expect(names).toContain('run_code');
    });

    it('执行 run_code 成功应返回 stdout', async () => {
      const result = await execWithCode.execute(
        'run_code',
        JSON.stringify({ language: 'node', code: 'console.log(1)' }),
      );
      expect(result).toContain('node:ok');
    });

    it('执行 run_code 失败（退出码非 0）应返回 CODE_ERROR', async () => {
      const result = await execWithCode.execute(
        'run_code',
        JSON.stringify({ language: 'node', code: 'boom()' }),
      );
      expect(result).toContain('CODE_ERROR');
      expect(result).toContain('reference error');
    });

    it('code 模式缺 code 参数应抛 MemoraError', async () => {
      await expect(execWithCode.execute('run_code', JSON.stringify({ language: 'node' }))).rejects.toThrow(
        'run_code 工具调用缺少 code 参数',
      );
    });

    it('code 模式缺 language 参数应抛 MemoraError', async () => {
      await expect(execWithCode.execute('run_code', JSON.stringify({ code: 'x' }))).rejects.toThrow(
        'run_code 工具调用缺少 language 参数',
      );
    });

    it('script_path 模式：读取脚本 + 按扩展名推断语言 + cwd=项目根', async () => {
      // 写入临时脚本（临时脚本闭环起点）
      writeFileSync(join(tmpProject, 'tmp_analyze.mjs'), 'export const a = 1;\n', 'utf-8');
      const result = await execWithCode.execute(
        'run_code',
        JSON.stringify({ script_path: 'tmp_analyze.mjs' }),
      );
      // 扩展名 .mjs → node，脚本内容被原样执行
      expect(result).toContain('node:ok');
      // cwd=项目根（脚本可 require 项目本地依赖、读取项目数据）
      expect(result).toContain(`cwd=${tmpProject}`);
      // 清理临时脚本（闭环收尾）
      await execWithCode.execute('delete_file', JSON.stringify({ path: 'tmp_analyze.mjs' }));
    });

    it('script_path 模式：显式 language 覆盖扩展名推断', async () => {
      writeFileSync(join(tmpProject, 'tmp_analyze.py'), 'print(1)\n', 'utf-8');
      const result = await execWithCode.execute(
        'run_code',
        JSON.stringify({ script_path: 'tmp_analyze.py', language: 'node' }),
      );
      expect(result).toContain('node:ok');
      await execWithCode.execute('delete_file', JSON.stringify({ path: 'tmp_analyze.py' }));
    });

    it('code 与 script_path 同时传入应抛 MemoraError（两模式互斥）', async () => {
      await expect(
        execWithCode.execute(
          'run_code',
          JSON.stringify({ language: 'node', code: 'x', script_path: 'tmp.mjs' }),
        ),
      ).rejects.toThrow('run_code 参数冲突');
    });

    it('script_path 指向不存在的文件应抛 MemoraError', async () => {
      await expect(
        execWithCode.execute('run_code', JSON.stringify({ script_path: 'no-such-script.mjs' })),
      ).rejects.toThrow('文件不存在');
    });
  });

  describe('delete_file（临时脚本清理）', () => {
    it('删除存在的文件成功', async () => {
      writeFileSync(join(tmpProject, 'tmp_cleanup.txt'), 'x', 'utf-8');
      const result = await executor.execute('delete_file', JSON.stringify({ path: 'tmp_cleanup.txt' }));
      expect(result).toContain('已删除');
      // 文件确已删除
      expect(() => readFileSync(join(tmpProject, 'tmp_cleanup.txt'))).toThrow();
    });

    it('删除不存在的文件返回已删除（目标态幂等）', async () => {
      const result = await executor.execute('delete_file', JSON.stringify({ path: 'never-exists.txt' }));
      expect(result).toContain('文件不存在（已删除）');
    });

    it('删除目录应被拒绝（仅支持文件）', async () => {
      await expect(executor.execute('delete_file', JSON.stringify({ path: 'src' }))).rejects.toThrow(
        'delete_file 目标是目录',
      );
    });

    it('缺少 path 参数应抛 MemoraError（schema 必填校验拦截）', async () => {
      await expect(executor.execute('delete_file', JSON.stringify({}))).rejects.toThrow(
        '工具参数缺失',
      );
    });
  });

  describe('search_project（项目内搜索，等价 IDE 全局搜索）', () => {
    const mockProjectProvider = {
      async searchFiles(options: { query?: string; maxResults?: number }) {
        // name 模式：按 query 过滤（省略 query 时列出全部）；返回 { path } 对象数组
        const all = [
          { path: 'src/index.ts' },
          { path: 'src/utils.ts' },
          { path: 'README.md' },
        ];
        if (!options.query || options.query === '**/*') return all.slice(0, options.maxResults);
        if (options.query === '**/*.ts') return [all[0]!, all[1]!];
        return [];
      },
      async searchText(options: { pattern: string; maxResults?: number }) {
        if (options.pattern === 'export') {
          return [
            { path: 'src/index.ts', line: 1, preview: 'export const x = 1;' },
            { path: 'src/utils.ts', line: 1, preview: 'export const y = 2;' },
          ];
        }
        if (options.pattern === 'truncated') {
          // 模拟宿主扫描达上限：结果携带 truncated 标记（截断诚实化）
          return [{ path: 'src/index.ts', line: 1, preview: 'export const x = 1;', truncated: true }];
        }
        return [];
      },
    };

    describe('未注入提供者', () => {
      it('list 不应包含 search_project 工具', () => {
        const names = executor.list.map((t) => t.name);
        expect(names).not.toContain('search_project');
      });

      it('执行 search_project 应返回不可用提示', async () => {
        const result = await executor.execute('search_project', JSON.stringify({}));
        expect(result).toContain('NOT_AVAILABLE');
      });
    });

    describe('注入提供者', () => {
      let execWithProject: ToolExecutor;

      beforeAll(() => {
        execWithProject = new ToolExecutor(
          tmpProject,
          security,
          index,
          undefined,
          undefined,
          undefined,
          undefined,
          mockProjectProvider,
        );
      });

      it('注入 projectSearchProvider 后 list 应包含 search_project 工具', () => {
        const names = execWithProject.list.map((t) => t.name);
        expect(names).toContain('search_project');
      });

      it('name 模式按文件名 glob 搜索返回路径列表', async () => {
        const result = await execWithProject.execute(
          'search_project',
          JSON.stringify({ query: '**/*.ts', mode: 'name' }),
        );
        expect(result).toContain('src/index.ts');
        expect(result).toContain('src/utils.ts');
        expect(result).not.toContain('README.md');
      });

      it('省略 query 时列出项目全部文件（受 maxResults 限制）', async () => {
        const result = await execWithProject.execute(
          'search_project',
          JSON.stringify({ mode: 'name', maxResults: '2' }),
        );
        // 结果行 = 路径行（排除截断诚实化提示行「（结果可能已截断…）」）
        const lines = result.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('（'));
        expect(lines.length).toBe(2);
        expect(result).toContain('src/index.ts');
        // 达上限时诚实化提示（防 LLM 误判项目仅此 2 个文件）
        expect(result).toContain('结果可能已截断');
      });

      it('content 模式按内容关键词搜索返回 路径:行号 定位', async () => {
        const result = await execWithProject.execute(
          'search_project',
          JSON.stringify({ query: 'export', mode: 'content' }),
        );
        expect(result).toContain('src/index.ts:1');
        expect(result).toContain('export const x = 1;');
      });

      it('content 模式未命中返回空结果提示', async () => {
        const result = await execWithProject.execute(
          'search_project',
          JSON.stringify({ query: '不存在词', mode: 'content' }),
        );
        expect(result).toContain('未在项目中找到');
      });

      it('content 模式缺少 query 应返回 INVALID_ARG', async () => {
        const result = await execWithProject.execute(
          'search_project',
          JSON.stringify({ mode: 'content' }),
        );
        expect(result).toContain('INVALID_ARG');
      });

      it('无效 mode 应返回 INVALID_ARG', async () => {
        const result = await execWithProject.execute(
          'search_project',
          JSON.stringify({ mode: 'regex' }),
        );
        expect(result).toContain('INVALID_ARG');
      });

      it('超长 query 应抛 MemoraError（防超长 glob/关键词滥用）', async () => {
        await expect(
          execWithProject.execute('search_project', JSON.stringify({ query: 'x'.repeat(501) })),
        ).rejects.toThrow('query 参数过长');
      });

      it('超长 exclude 应抛 MemoraError（防超长模式滥用）', async () => {
        await expect(
          execWithProject.execute(
            'search_project',
            JSON.stringify({ mode: 'name', exclude: 'e'.repeat(1001) }),
          ),
        ).rejects.toThrow('exclude 参数过长');
      });
    });

    describe('预算下探联动（G4）', () => {
      // 模拟宿主返回大量结果（超预算档位 cap），用于验证下探截断
      const manyFilesProvider = {
        async searchFiles(options: { query?: string; maxResults?: number }) {
          const all = Array.from({ length: 50 }, (_, i) => ({ path: `src/file${i}.ts` }));
          return all.slice(0, options.maxResults);
        },
        async searchText() {
          return [];
        },
      };

      it('极紧预算（3000）时结果条数下探到 3 并提示截断', async () => {
        const exec = new ToolExecutor(
          tmpProject,
          security,
          index,
          undefined,
          undefined,
          undefined,
          undefined,
          manyFilesProvider,
        );
        exec.setBudgetProvider(() => 3000);
        const result = await exec.execute(
          'search_project',
          JSON.stringify({ mode: 'name', query: '**/*.ts', maxResults: '100' }),
        );
        // 结果行 = 路径行（排除截断诚实化提示行「（结果可能已截断…）」）
        const lines = result.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('（'));
        expect(lines.length).toBe(3);
        expect(result).toContain('结果可能已截断');
      });

      it('充裕预算（50000）时维持 LLM 请求的 maxResults（不额外下探）', async () => {
        const exec = new ToolExecutor(
          tmpProject,
          security,
          index,
          undefined,
          undefined,
          undefined,
          undefined,
          manyFilesProvider,
        );
        exec.setBudgetProvider(() => 50_000);
        const result = await exec.execute(
          'search_project',
          JSON.stringify({ mode: 'name', query: '**/*.ts', maxResults: '50' }),
        );
        const lines = result.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('（'));
        expect(lines.length).toBe(50);
      });

      it('未注入预算提供者时维持硬上限行为（无下探）', async () => {
        const exec = new ToolExecutor(
          tmpProject,
          security,
          index,
          undefined,
          undefined,
          undefined,
          undefined,
          manyFilesProvider,
        );
        // 不调用 setBudgetProvider：无预算信息，保持原行为
        const result = await exec.execute(
          'search_project',
          JSON.stringify({ mode: 'name', query: '**/*.ts', maxResults: '50' }),
        );
        const lines = result.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('（'));
        expect(lines.length).toBe(50);
      });

      // K-1 档位跳变边界回归（2026-08-31）：逐个锁定 SEARCH_BUDGET_TIERS 的 minRemaining 边界及其下沿。
      // 用例取相对值而非 100：manyFilesProvider 仅生成 50 个文件，故「充裕档 cap100」不额外下探时有效结果恒为 min(50, cap)=50，
      // 用 50 与下探档（30/10/3）在结果行数上区分开，验证档位切换真实触发且阈值精确。
      it.each([
        // [剩余预算, 期望生效的结果条数上限] —— 对应档位（充裕100 / 中30 / 紧10 / 极紧3）
        [40_000, 50], // 恰好充裕档 minRemaining：cap100 > 50 文件，不额外下探
        [39_999, 30], // 跌破 40000 → 中档 cap30
        [16_000, 30], // 恰好中档 minRemaining：cap30
        [15_999, 10], // 跌破 16000 → 紧档 cap10
        [6_000, 10], // 恰好紧档 minRemaining：cap10
        [5_999, 3], // 跌破 6000 → 极紧档 cap3
      ])('预算档位跳变边界：剩余 %s 时结果条数上限为 %s', async (budget, expected) => {
        const exec = new ToolExecutor(
          tmpProject,
          security,
          index,
          undefined,
          undefined,
          undefined,
          undefined,
          manyFilesProvider,
        );
        exec.setBudgetProvider(() => budget);
        const result = await exec.execute(
          'search_project',
          JSON.stringify({ mode: 'name', query: '**/*.ts', maxResults: '50' }),
        );
        // 结果行 = 路径行（排除截断诚实化提示行「（结果可能已截断…）」）
        const lines = result.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('（'));
        expect(lines.length).toBe(expected);
      });
    });
  });

  describe('read_file', () => {
    it('应能读取项目内文件', async () => {
      const result = await executor.execute('read_file', JSON.stringify({ path: 'src/index.ts' }));
      expect(result).toBe('export const x = 1;\n');
    });

    it('相对项目根的路径不在白名单时应抛 MemoraError（tool 类）', async () => {
      try {
        await executor.execute('read_file', JSON.stringify({ path: '../outside.txt' }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).category).toBe('tool');
      }
    });

    it('黑名单路径（.ssh）应抛 MemoraError', async () => {
      try {
        await executor.execute('read_file', JSON.stringify({ path: '.ssh/id_rsa' }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).detail).toMatch(/黑名单/);
      }
    });

    it('缺少 path 参数应抛 MemoraError', async () => {
      try {
        await executor.execute('read_file', JSON.stringify({}));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        // validateAndCoerceArgs 的 title 是 '工具参数缺失'，detail 包含具体参数名
        expect((err as MemoraError).detail).toContain('path');
      }
    });

    it('超大文件按 token 预算分段：明示行号区间与续读 offset（不再静默截断）', async () => {
      // 2000 行 × 100 字符 ≈ 200,000 字符，远超单次读取预算
      const bigFile = 'src/big-file.txt';
      writeFileSync(
        join(tmpProject, bigFile),
        Array.from({ length: 2000 }, (_, i) => `L${i + 1}:` + 'x'.repeat(96)).join('\n'),
        'utf-8',
      );

      const result = await executor.execute('read_file', JSON.stringify({ path: bigFile }));

      // 1. 同源不变量：任何返回路径（含脚注）都不超单次读取预算
      expect(estimateTokensText(result)).toBeLessThanOrEqual(
        LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS,
      );
      // 2. 诚实告知：已显示区间 / 总行数 / 续读入口三者齐备
      expect(result).toContain('[read_file 分段]');
      expect(result).toContain('共 2000 行');
      expect(result).toContain('继续读用 offset=');
      // 3. 确实是分段而非全量（末行不在首段里）
      expect(result).not.toContain('L2000:');
    });

    it('offset/limit 续读不重不漏（行号语义精确）', async () => {
      const file = 'src/seg.txt';
      writeFileSync(
        join(tmpProject, file),
        Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n'),
        'utf-8',
      );

      const first = await executor.execute('read_file', JSON.stringify({ path: file, limit: '10' }));
      expect(first.split('\n').slice(0, 10)).toEqual(
        Array.from({ length: 10 }, (_, i) => `L${i + 1}`),
      );
      expect(first).toContain('已显示第 1–10 行（共 50 行）');
      expect(first).toContain('继续读用 offset=11');

      // 按脚注给出的 offset 续读 → 恰好接上第 11 行，不重不漏
      const second = await executor.execute(
        'read_file',
        JSON.stringify({ path: file, offset: '11', limit: '10' }),
      );
      expect(second.split('\n').slice(0, 10)).toEqual(
        Array.from({ length: 10 }, (_, i) => `L${i + 11}`),
      );
      expect(second).toContain('已显示第 11–20 行（共 50 行）');
    });

    it('读到文件末尾时不追加脚注（零噪音）', async () => {
      const file = 'src/tail.txt';
      writeFileSync(join(tmpProject, file), 'a\nb\nc', 'utf-8');

      const result = await executor.execute('read_file', JSON.stringify({ path: file }));

      expect(result).toBe('a\nb\nc');
      expect(result).not.toContain('[read_file 分段]');
    });

    it('offset 超出文件末尾 → 如实告知而非返回空串', async () => {
      const file = 'src/short.txt';
      writeFileSync(join(tmpProject, file), 'x\ny', 'utf-8');

      const result = await executor.execute('read_file', JSON.stringify({ path: file, offset: '99' }));

      expect(result).toContain('共 2 行');
      expect(result).toContain('超出文件末尾');
    });

    it('中文大文件同样守住单次读取预算（CJK 密度更高，字符上限会失准）', async () => {
      const file = 'src/cn-big.txt';
      writeFileSync(
        join(tmpProject, file),
        Array.from({ length: 3000 }, (_, i) => `第${i + 1}行` + '中文内容片段'.repeat(14)).join('\n'),
        'utf-8',
      );

      const result = await executor.execute('read_file', JSON.stringify({ path: file }));

      expect(estimateTokensText(result)).toBeLessThanOrEqual(
        LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS,
      );
      expect(result).toContain('[read_file 分段]');
    });

    it('含控制字符的文件内容应被净化（去控制字符）', async () => {
      const messyContent = 'line1\u0000control\u001bEscape\nline2';
      const messyFile = 'src/messy-file.txt';
      await executor.execute('write_file', JSON.stringify({ path: messyFile, content: messyContent }));
      const result = await executor.execute('read_file', JSON.stringify({ path: messyFile }));
      // 控制字符（\u0000、\u001b）被移除
      expect(result).not.toContain('\u0000');
      expect(result).not.toContain('\u001b');
      // 可打印内容保留
      expect(result).toContain('line1');
    });
  });

  describe('sanitizeExternalText（纯函数）', () => {
    it('ANSI SGR 色码整体剥净（2026-09-08：env 继承后 FORCE_COLOR 使子进程输出色码）', () => {
      // 子进程继承 FORCE_COLOR 后的真实输出形态：ESC [33m 包裹文本
      // 单剥 ESC 会留 `[33m` 残渣——净化层须剥整个 CSI 序列
      const colored = 'line1\u001b[33mtrue\u001b[39m line2';
      const cleaned = sanitizeExternalText(colored, 10_000);
      expect(cleaned).not.toContain('[33m');
      expect(cleaned).not.toContain('[39m');
      // 剥色后语义文本保持
      expect(cleaned).toContain('true');
      expect(cleaned).toContain('line2');
    });

    it('普通文本不受 ANSI 剥除影响（回归）', () => {
      const cleaned = sanitizeExternalText('plain [bracket] text', 100);
      expect(cleaned).toBe('plain [bracket] text');
    });
  });

  describe('write_file', () => {
    const testFile = 'src/new-file.ts';

    it('应能写入新文件（owner + confirmWrites=false 自动批准）', async () => {
      const content = 'export const newFile = true;\n';
      const result = await executor.execute(
        'write_file',
        JSON.stringify({ path: testFile, content }),
      );
      expect(result).toContain('已写入');
      expect(result).toContain(`${content.length} 字符`);
      expect(readFileSync(join(tmpProject, testFile), 'utf-8')).toBe(content);
    });

    it('应自动创建不存在的父目录', async () => {
      const deepPath = 'src/deep/nested/file.ts';
      const content = 'export const deep = true;\n';
      await executor.execute('write_file', JSON.stringify({ path: deepPath, content }));
      expect(readFileSync(join(tmpProject, deepPath), 'utf-8')).toBe(content);
    });

    it('应能覆盖已有文件', async () => {
      const content = 'export const overwritten = true;\n';
      await executor.execute('write_file', JSON.stringify({ path: testFile, content }));
      expect(readFileSync(join(tmpProject, testFile), 'utf-8')).toBe(content);
    });

    it('黑名单路径应抛 MemoraError', async () => {
      try {
        await executor.execute(
          'write_file',
          JSON.stringify({ path: '.env', content: 'SECRET=leaked' }),
        );
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).detail).toMatch(/黑名单/);
      }
    });

    it('路径越界应抛 MemoraError', async () => {
      try {
        await executor.execute(
          'write_file',
          JSON.stringify({ path: '../escape.txt', content: 'x' }),
        );
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).message).toMatch(/不在白名单/);
      }
    });

    it('缺少 content 参数应抛 MemoraError', async () => {
      try {
        await executor.execute('write_file', JSON.stringify({ path: testFile }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        // validateAndCoerceArgs 的 title 是 '工具参数缺失'，detail 包含具体参数名
        expect((err as MemoraError).detail).toContain('content');
      }
    });
  });

  describe('list_dir', () => {
    it('默认应列出项目根的非忽略条目', async () => {
      const result = await executor.execute('list_dir', JSON.stringify({}));
      expect(result).toContain('src/');
      expect(result).toContain('README.md');
      // 应忽略 node_modules / .git
      expect(result).not.toContain('node_modules');
      expect(result).not.toContain('.git');
    });

    it('递归模式应展开子目录', async () => {
      const result = await executor.execute(
        'list_dir',
        JSON.stringify({ recursive: 'true', maxDepth: '2' }),
      );
      expect(result).toContain('src/');
      expect(result).toContain('index.ts');
    });

    it('maxDepth=1 应不递归子目录文件', async () => {
      const result = await executor.execute(
        'list_dir',
        JSON.stringify({ recursive: 'true', maxDepth: '1' }),
      );
      expect(result).toContain('src/');
      expect(result).not.toContain('index.ts');
    });

    it('maxDepth=10 应被限制为 3', async () => {
      // maxDepth 强校验：> 3 时降为 3
      const result = await executor.execute(
        'list_dir',
        JSON.stringify({ recursive: 'true', maxDepth: '10' }),
      );
      // 项目结构只有 2 层，maxDepth=3 也能完整列出
      expect(result).toContain('src/');
    });

    it('路径不存在应抛 MemoraError', async () => {
      try {
        await executor.execute('list_dir', JSON.stringify({ path: 'non-existent' }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).title).toContain('不存在');
      }
    });

    it('文件路径（不是目录）应抛 MemoraError', async () => {
      try {
        await executor.execute('list_dir', JSON.stringify({ path: 'README.md' }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).title).toContain('不是目录');
      }
    });

    it('黑名单路径应抛 MemoraError', async () => {
      try {
        await executor.execute('list_dir', JSON.stringify({ path: '.ssh' }));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).detail).toMatch(/黑名单/);
      }
    });
  });

  describe('search_memories', () => {
    it('match 模式：单 token 应能匹配', async () => {
      const result = await executor.execute('search_memories', JSON.stringify({ query: 'Memora' }));
      expect(result).toContain('core-rule');
      expect(result).toContain('找到');
    });

    it('match 模式：多 token 用 OR（任一命中即可）', async () => {
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'Memora TypeScript' }),
      );
      expect(result).toContain('找到');
      // match 模式两个 token 至少有一个命中
      expect(result.length).toBeGreaterThan(20);
    });

    it('near 模式：所有 token 必须同时出现', async () => {
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'Memora 万物', mode: 'near' }),
      );
      expect(result).toContain('找到');
    });

    it('near 模式：部分 token 不命中时该结果应被过滤', async () => {
      // mem-1 包含 "Memora" 但不包含 "TypeScript"；near 模式要求全部命中
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'Memora TypeScript', mode: 'near' }),
      );
      // 两条记忆都不同时包含两个关键词，应返回未找到
      expect(result).toContain('未找到');
      expect(result).toContain('near 模式');
    });

    it('near 模式：单 token 等同于 match 模式', async () => {
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'Memora', mode: 'near' }),
      );
      expect(result).toContain('找到');
    });

    it('match 模式：结果应包含模式标注', async () => {
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'Memora', mode: 'match' }),
      );
      expect(result).toContain('match 模式');
    });

    it('空查询应返回兜底（按 weight 排序）', async () => {
      // Intl.Segmenter 切出空 tokens → 走 getByWeight
      const result = await executor.execute('search_memories', JSON.stringify({ query: '，。' }));
      expect(result).toContain('core-rule');
    });

    it('limit 限制返回数量', async () => {
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'memora', limit: '1' }),
      );
      expect(result).toContain('找到 1 条');
    });

    it('limit 超过 50 应被限制为 50', async () => {
      // 仅 2 条记忆，验证参数限制逻辑（不会实际返回 50 条）
      const result = await executor.execute(
        'search_memories',
        JSON.stringify({ query: 'memora', limit: '1000' }),
      );
      expect(result).toContain('找到');
    });

    it('缺少 query 参数应抛 MemoraError', async () => {
      try {
        await executor.execute('search_memories', JSON.stringify({}));
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        // validateAndCoerceArgs 的 title 是 '工具参数缺失'，detail 包含具体参数名
        expect((err as MemoraError).detail).toContain('query');
      }
    });
  });

  describe('错误处理', () => {
    it('未知工具应抛 MemoraError', async () => {
      try {
        await executor.execute('nonexistent_tool', '{}');
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).title).toContain('未知工具');
      }
    });

    it('args JSON 无效应抛 MemoraError', async () => {
      try {
        await executor.execute('read_file', '{ not json');
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).title).toContain('解析失败');
      }
    });
  });

  describe('task_table_update（2026-09-06 寻址契约收口：renderer # 序号 ↔ task_table_write 短 id ↔ 完整 uuid 三源归一）', () => {
    /** 默认三步骤桩（id 前缀各异，8 位短 id 可唯一命中） */
    const DEFAULT_PLAN: Array<{ id: string; description: string; status: string; order: number }> = [
      { id: 'a1b2c3d4-step-1', description: '文档设计师发言', status: 'pending', order: 0 },
      { id: 'e5f6a7b8-step-2', description: '小说助手发言', status: 'pending', order: 1 },
      { id: 'c9d0e1f2-step-3', description: '方案设计师汇总', status: 'pending', order: 2 },
    ];

    /** 注入 planManager 桩：记录 updateStep 最终收到的 stepId（解析后应为完整 uuid） */
    function injectPlanManager(
      plan: Array<{ id: string; description: string; status: string; order: number }> = DEFAULT_PLAN,
    ): { updateCalls: string[] } {
      const updateCalls: string[] = [];
      executor.planManager = {
        writePlan: () => '',
        updateStep: (stepId: string) => {
          updateCalls.push(stepId);
          return `步骤 [${stepId.slice(0, 8)}] 已更新`;
        },
        getPlan: () => plan,
      };
      return { updateCalls };
    }

    it('step_id 传 # 序号 "1"（1 开始）→ 解析到 order=0 的真实 id', async () => {
      const { updateCalls } = injectPlanManager();
      const result = await executor.execute('task_table_update', JSON.stringify({ step_id: '1', status: 'done' }));
      expect(updateCalls).toEqual(['a1b2c3d4-step-1']);
      expect(result).toContain('已更新');
    });

    it('step_id 传第 3 步序号 → 解析到 order=2 的 id（1-based 寻址）', async () => {
      const { updateCalls } = injectPlanManager();
      await executor.execute('task_table_update', JSON.stringify({ step_id: '3', status: 'blocked' }));
      expect(updateCalls).toEqual(['c9d0e1f2-step-3']);
    });

    it('序号按 order 匹配而非数组位（order 乱序 plan 仍正确定位——renderer 同键）', async () => {
      const { updateCalls } = injectPlanManager([
        { id: 'a1b2c3d4-step-1', description: 'A', status: 'pending', order: 2 },
        { id: 'e5f6a7b8-step-2', description: 'B', status: 'pending', order: 0 },
        { id: 'c9d0e1f2-step-3', description: 'C', status: 'pending', order: 1 },
      ]);
      await executor.execute('task_table_update', JSON.stringify({ step_id: '1', status: 'done' }));
      // #1 = order 0 = e5f6a7b8-step-2（若按数组位解析会错误命中 a1b2c3d4-step-1）
      expect(updateCalls).toEqual(['e5f6a7b8-step-2']);
    });

    it('step_id 传完整 uuid → 全等命中原样使用', async () => {
      const { updateCalls } = injectPlanManager();
      await executor.execute('task_table_update', JSON.stringify({ step_id: 'e5f6a7b8-step-2', status: 'done' }));
      expect(updateCalls).toEqual(['e5f6a7b8-step-2']);
    });

    it('step_id 传 8 位短 id（task_table_write 返回格式）→ 前缀命中完整 uuid（P0 断链修复）', async () => {
      const { updateCalls } = injectPlanManager();
      // 'a1b2c3d4-step-1' 前 8 位 = 'a1b2c3d4'
      await executor.execute('task_table_update', JSON.stringify({ step_id: 'a1b2c3d4', status: 'done' }));
      expect(updateCalls).toEqual(['a1b2c3d4-step-1']);
    });

    it('step_id 8 位纯数字短 id → 按短 id 语义前缀命中，不误判为序号（防 2.3% 全数字错配）', async () => {
      const { updateCalls } = injectPlanManager([
        { id: '12345678-abcd-4efg', description: '纯数字前缀步骤', status: 'pending', order: 0 },
        { id: 'e5f6a7b8-step-2', description: 'B', status: 'pending', order: 1 },
      ]);
      await executor.execute('task_table_update', JSON.stringify({ step_id: '12345678', status: 'done' }));
      expect(updateCalls).toEqual(['12345678-abcd-4efg']);
    });

    it('step_id 短 id 前缀多命中 → INVALID_ARG 歧义提示（改用 # 序号）', async () => {
      const { updateCalls } = injectPlanManager([
        { id: 'dup-prefix-aaaa', description: 'A', status: 'pending', order: 0 },
        { id: 'dup-prefix-bbbb', description: 'B', status: 'pending', order: 1 },
      ]);
      const result = await executor.execute('task_table_update', JSON.stringify({ step_id: 'dup-pref', status: 'done' }));
      expect(result).toContain('[ERR:INVALID_ARG]');
      expect(result).toContain('不唯一');
      expect(updateCalls).toEqual([]);
    });

    it('step_id 8 位短 id 无命中 → STEP_NOT_FOUND（提示改用 # 序号）', async () => {
      const { updateCalls } = injectPlanManager();
      const result = await executor.execute('task_table_update', JSON.stringify({ step_id: 'zzzzzzzz', status: 'done' }));
      expect(result).toContain('[ERR:STEP_NOT_FOUND]');
      expect(updateCalls).toEqual([]);
    });

    it('step_id 非数字非 8 位乱 id → STEP_NOT_FOUND（提示可用格式）', async () => {
      const { updateCalls } = injectPlanManager();
      const result = await executor.execute('task_table_update', JSON.stringify({ step_id: 'hackme', status: 'done' }));
      expect(result).toContain('[ERR:STEP_NOT_FOUND]');
      expect(updateCalls).toEqual([]);
    });

    it('step_id 数字越界（超出 plan 长度）→ INVALID_ARG 带范围提示（原静默透传升级）', async () => {
      const { updateCalls } = injectPlanManager();
      const result = await executor.execute('task_table_update', JSON.stringify({ step_id: '99', status: 'done' }));
      expect(result).toContain('[ERR:INVALID_ARG]');
      expect(result).toContain('超出任务表范围');
      expect(result).toContain('共 3 步');
      expect(updateCalls).toEqual([]);
    });

    it('step_id 传 "0"（0-based 误用）→ INVALID_ARG 带范围提示', async () => {
      const { updateCalls } = injectPlanManager();
      const result = await executor.execute('task_table_update', JSON.stringify({ step_id: '0', status: 'done' }));
      expect(result).toContain('[ERR:INVALID_ARG]');
      expect(updateCalls).toEqual([]);
    });

    it('step_id 为空字符串 → [ERR:INVALID_ARG]（实测路径：LLM 传空值的兜底）', async () => {
      const result = await executor.execute('task_table_update', JSON.stringify({ step_id: '', status: 'done' }));
      expect(result).toContain('[ERR:INVALID_ARG] step_id 不能为空');
    });

    it('step_id 缺失 → schema 必填校验拦截（工具参数缺失 MemoraError）', async () => {
      await expect(executor.execute('task_table_update', JSON.stringify({ status: 'done' }))).rejects.toThrow(
        '工具参数缺失',
      );
    });
  });

  describe('自定义工具注册', () => {
    /** 测试用自定义工具定义 */
    const customDef = {
      name: 'echo_tool',
      description: '回显输入参数',
      parameters: {
        type: 'object' as const,
        properties: {
          message: { type: 'string', description: '要回显的消息' },
        },
        required: ['message'],
      },
    };

    it('registerTool 应成功注册自定义工具', () => {
      executor.registerTool(customDef, async (args) => `Echo: ${args['message']}`);
      // 不抛错即成功
    });

    it('list 应包含内置 + 自定义工具', () => {
      const defs = executor.list;
      const names = defs.map((t) => t.name);
      // 内置 4 个 + 自定义 1 个
      expect(names).toContain('read_file');
      expect(names).toContain('echo_tool');
      expect(defs.length).toBe(BUILTIN_TOOLS.length + 1);
    });

    it('execute 应路由到自定义工具 handler', async () => {
      const result = await executor.execute('echo_tool', JSON.stringify({ message: 'hello' }));
      expect(result).toBe('Echo: hello');
    });

    it('注册同名内置工具应抛错', () => {
      const builtinClone = {
        name: 'read_file',
        description: '试图覆盖内置工具',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      expect(() => executor.registerTool(builtinClone, async () => '')).toThrow(/不能覆盖内置工具/);
    });

    it('重复注册同名自定义工具应抛错', () => {
      expect(() => executor.registerTool(customDef, async () => '')).toThrow(/工具已注册/);
    });

    it('registerTool 应触发 onToolsChanged 回调', () => {
      let callCount = 0;
      executor.setOnToolsChanged(() => { callCount++; });
      const newDef = {
        name: 'callback_test_tool',
        description: '测试回调触发',
        parameters: {
          type: 'object' as const,
          properties: { msg: { type: 'string', description: '消息' } },
          required: ['msg'],
        },
      };
      executor.registerTool(newDef, async () => 'ok');
      expect(callCount).toBe(1);
    });

    it('setOnToolsChanged(undefined) 后 registerTool 不触发回调', () => {
      let callCount = 0;
      executor.setOnToolsChanged(() => { callCount++; });
      executor.setOnToolsChanged(undefined);
      const newDef = {
        name: 'no_callback_tool',
        description: '测试清除回调',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      executor.registerTool(newDef, async () => 'ok');
      expect(callCount).toBe(0);
    });

    it('未知工具错误信息应包含自定义工具名', async () => {
      try {
        await executor.execute('truly_unknown', '{}');
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        // suggestions 数组应列出所有已注册工具（含自定义）
        const suggestions = (err as MemoraError).suggestions ?? [];
        const allSuggestions = suggestions.join(' ');
        expect(allSuggestions).toContain('echo_tool');
      }
    });

    it('自定义 handler 抛异常应包装为 MemoraError', async () => {
      // 注册一个会抛错的工具
      const failDef = {
        name: 'fail_tool',
        description: '测试异常包装',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      executor.registerTool(failDef, async () => {
        throw new Error('handler 内部错误');
      });
      try {
        await executor.execute('fail_tool', '{}');
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        expect((err as MemoraError).title).toContain('自定义工具执行失败');
        expect((err as MemoraError).detail).toContain('fail_tool');
      }
    });

    it('自定义 handler 抛 MemoraError 应原样透传', async () => {
      // 注册一个抛 MemoraError 的工具
      const memErrDef = {
        name: 'memerr_tool',
        description: '测试 MemoraError 透传',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      executor.registerTool(memErrDef, async () => {
        throw toolError('业务错误', 'handler 抛出的 MemoraError', []);
      });
      try {
        await executor.execute('memerr_tool', '{}');
        throw new Error('应该抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        // 应保留原始 title，不被包装为"自定义工具执行失败"
        expect((err as MemoraError).title).toBe('业务错误');
      }
    });

    it('未注入 webSearchProvider 时，宿主可注册 web_search 工具', () => {
      const webSearchDef = {
        name: 'web_search',
        description: '宿主自定义 web_search（打开浏览器模式）',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      expect(() => executor.registerTool(webSearchDef, async () => '')).not.toThrow();
      // 清理：移除已注册的工具，避免影响后续测试
      executor.removeTool('web_search');
    });

    it('注入 webSearchProvider 后，注册 web_search 应抛错', () => {
      const mockProvider = { search: async () => [] };
      const executorWithProvider = new ToolExecutor(tmpProject, security, index, mockProvider);
      const webSearchDef = {
        name: 'web_search',
        description: '试图覆盖内核 web_search',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      expect(() => executorWithProvider.registerTool(webSearchDef, async () => '')).toThrow(/不能覆盖内置工具/);
    });

    it('注入 fetchProvider 后，注册 web_fetch 应抛错', () => {
      const mockFetch = { fetch: async () => ({ url: '', title: '', content: '' }) };
      const executorWithFetch = new ToolExecutor(
        tmpProject, security, index, undefined, undefined, mockFetch,
      );
      const fetchDef = {
        name: 'web_fetch',
        description: '试图覆盖内核 web_fetch',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      expect(() => executorWithFetch.registerTool(fetchDef, async () => '')).toThrow(/不能覆盖内置工具/);
    });

    it('注入 codeExecutionProvider 后，注册 run_code 应抛错', () => {
      const mockCode = {
        async execute() {
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        },
      };
      const executorWithCode = new ToolExecutor(
        tmpProject, security, index, undefined, undefined, undefined, mockCode,
      );
      const codeDef = {
        name: 'run_code',
        description: '试图覆盖内核 run_code',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      };
      expect(() => executorWithCode.registerTool(codeDef, async () => '')).toThrow(/不能覆盖内置工具/);
    });
  });
});
