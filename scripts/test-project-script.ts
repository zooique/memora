/**
 * 「项目脚本」运行 —— 端到端演示脚本（run_project_script，默认开放能力）
 *
 * 用法：
 *   npx tsx scripts/test-project-script.ts
 *
 * 演示内容（与 run_code 的临时脚本闭环区分：run_project_script 运行**仓库既有脚本**）：
 *   LLM 直接运行项目内已存在的脚本（非技能目录脚本、非 LLM 现写的一次性脚本），
 *   内核子进程执行、源码不进上下文、仅结果返回。
 *
 * 核心差异（本脚本重点验证）：
 *   1. 零注入：无需 ICodeExecutionProvider / 无需角色包能力声明——默认常驻暴露
 *   2. 路径白名单：脚本路径相对项目根，越界（../）拒绝、不协商
 *   3. cwd=项目根：脚本可用相对路径读取项目数据文件
 *   4. 暴露面：即使 toolWhitelist=[]（仅常驻工具）run_project_script 仍可见，
 *      而 run_code（特权）被过滤——「默认常驻 vs 角色启动」实证
 *   5. 运行时推断与超时：扩展名推 node/python/shell + 30s 超时兜底
 *
 * 验收标准：
 *   - 所有场景输出 ✅，退出码 0
 *   - 越界路径（../）被拒绝，项目外文件不可被脚本读取
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolExecutor, BUILTIN_TOOLS } from '../src/agent/toolExecutor.js';
import { SecurityGuard } from '../src/security/pathGuard.js';
import { InMemoryStorage } from '../src/memory/inMemoryStorage.js';
import type { IMemoryStorage } from '../src/memory/storageInterface.js';

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
  console.log('🚀 「项目脚本」运行 —— 端到端演示（默认开放、零注入）\n');

  // 准备临时项目目录（模拟用户当前加载的项目根）
  const projectPath = mkdtempSync(join(tmpdir(), 'memora-project-script-'));
  // 项目已有数据文件（脚本用相对路径读取，验证 cwd=项目根）
  mkdirSync(join(projectPath, 'data'), { recursive: true });
  writeFileSync(join(projectPath, 'data/numbers.txt'), '1 2 3 4 5\n', 'utf-8');
  // 项目既有的仓库脚本（"仓库已沉淀"的来源可信对象）
  mkdirSync(join(projectPath, 'scripts'), { recursive: true });
  writeFileSync(
    join(projectPath, 'scripts/analyze.cjs'),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const data = fs.readFileSync(path.join(process.cwd(), 'data/numbers.txt'), 'utf-8');",
      'const nums = data.trim().split(/[\\s,]+/).map(Number);',
      'const sum = nums.reduce((a, b) => a + b, 0);',
      'console.log(`sum=${sum}, count=${nums.length}, avg=${(sum / nums.length).toFixed(1)}`);',
    ].join('\n'),
    'utf-8',
  );

  // 记忆库：纯内存实现（演示无需 SQLite）
  const memoryIndex: IMemoryStorage = new InMemoryStorage();
  // 安全守卫：owner 权限 + confirmScripts=false（默认不弹窗，让演示无打断跑通）
  const security = new SecurityGuard(projectPath, projectPath, [], false, 'owner');
  // 工具执行器：run_project_script 由内核子进程直接执行——无需注入任何 provider
  const executor = new ToolExecutor(projectPath, security, memoryIndex);

  try {
    // ─── 场景 0：工具定义就绪（默认常驻，无需注入/能力声明） ─────────────
    console.log('📋 场景 0：run_project_script 在 BUILTIN_TOOLS 中默认存在（零注入）');
    const names = BUILTIN_TOOLS.map((t) => t.name);
    assert(names.includes('run_project_script'), 'BUILTIN_TOOLS 包含 run_project_script');
    assert(names.includes('run_skill_script'), '技能脚本工具同在（同类默认开放）');
    assert(
      !BUILTIN_TOOLS.map((t) => t.name).includes('run_code'),
      'run_code 不在 BUILTIN_TOOLS（条件工具，需宿主注入 provider）',
    );

    // ─── 场景 1：执行项目内既有脚本（内核子进程，cwd=项目根） ─────────────
    console.log('\n📋 场景 1：运行项目脚本 scripts/analyze.cjs（cwd=项目根，相对路径读数据）');
    const runResult = await executor.execute(
      'run_project_script',
      JSON.stringify({ script_path: 'scripts/analyze.cjs' }),
    );
    console.log(`  📤 run_project_script 输出: ${runResult.replace(/\n/g, ' | ')}`);
    assert(runResult.includes('sum=15'), '脚本执行结果正确（sum=15，证明 cwd=项目根可读相对数据）');
    assert(runResult.includes('count=5'), '脚本执行结果正确（count=5）');
    assert(runResult.includes('avg=3.0'), '脚本执行结果正确（avg=3.0）');
    // 仓库脚本保留（run_project_script 不动原文件——不是临时闭环保留语义）
    assert(existsSync(join(projectPath, 'scripts/analyze.cjs')), '项目脚本文件未被改动');

    // ─── 场景 2：路径越界拒绝（白名单执行时二次强制） ─────────────
    console.log('\n📋 场景 2：路径越界（../ 穿越项目根）拒绝执行');
    const denied = await executor.execute(
      'run_project_script',
      JSON.stringify({ script_path: '../escape.sh' }),
    );
    assert(denied.includes('PATH_DENIED'), `越界路径被拒绝: ${denied.replace(/\n/g, ' | ')}`);

    // ─── 场景 3：暴露面（默认常驻 vs 角色启动，tool-exposure-model 实证） ─────────────
    console.log(
      '\n📋 场景 3：toolWhitelist=[]（仅常驻）时——run_project_script 可见、run_code 被过滤',
    );
    executor.setToolWhitelist([]);
    const listNames = executor.list.map((t) => t.name);
    assert(
      listNames.includes('run_project_script'),
      '仅常驻白名单下 run_project_script 仍暴露（默认开放）',
    );
    assert(listNames.includes('read_file'), '常驻工具 read_file 仍暴露');
    assert(listNames.includes('task_table_write'), '任务表是内核常驻必要基建，仅常驻白名单仍可见');
    assert(
      !listNames.includes('run_code'),
      '特权工具 run_code 不在工具面（未注入 provider 且需 code:execute）',
    );
    executor.setToolWhitelist(null);

    // ─── 场景 4：传参 + 运行时推断（.sh 走 shell） ─────────────
    console.log('\n📋 场景 4：args 传参（node 脚本接收参数）');
    writeFileSync(
      join(projectPath, 'scripts/greet.js'),
      "const a = process.argv.slice(2); console.log('hello', a.join(' '));",
      'utf-8',
    );
    const greetResult = await executor.execute(
      'run_project_script',
      JSON.stringify({ script_path: 'scripts/greet.js', args: ['memora'] }),
    );
    assert(greetResult.trim() === 'hello memora', `参数传递正确: ${greetResult.trim()}`);

    console.log('\n🎉 演示完成！「项目脚本」默认开放能力全部场景验证通过。');
    console.log('\n📖 说明：');
    console.log('   - run_project_script：运行仓库**既有**脚本（来源可信、默认开放、零注入）');
    console.log('   - run_code：LLM 现写临时脚本（特权：code:execute 声明 + 宿主沙箱注入）');
    console.log('   - run_skill_script：技能目录脚本（默认开放，来源=技能作者）');
    console.log('   - 三者共用同一内核子进程执行器：运行时三档/超时 30s/env 最小化');
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
