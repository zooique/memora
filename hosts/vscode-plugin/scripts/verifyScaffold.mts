/**
 * 切片 C 验证脚本 — scaffold skill 加载 + 骨架生成链路
 *
 * 目的：验证装配层 configDir 正确指向插件 skills 目录（scaffold skill 能加载），
 * 且 Agent 围绕设计文档用 write_file 工具在工作区真实落盘骨架文件。
 *
 * 运行方式（在 hosts/vscode-plugin 下）：
 *   node --import ../../node_modules/tsx/dist/loader.mjs scripts/verifyScaffold.mts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { Agent } from '@zooique/memora';
import { WorkspaceStorage } from '../src/extension/host/workspaceStorage.js';
import { WorkspaceSessionStore } from '../src/extension/host/sessionStore.js';
import { createDocReviewProvider } from '../src/extension/host/llmConfig.js';

/** 读取环境变量，优先进程级，回退系统级（Machine） */
function readEnv(name: string): string | undefined {
  return process.env[name] ?? getMachineEnv(name);
}

/** 读取 Windows 系统级（Machine）环境变量 */
function getMachineEnv(name: string): string | undefined {
  try {
    const buf = execSync(
      `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${name}','Machine')"`,
      { encoding: 'utf8' },
    );
    return buf.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 收集 Agent 流式输出为完整文本 */
async function collectText(gen: AsyncIterable<{ type: string; content?: string }>): Promise<string> {
  let out = '';
  for await (const chunk of gen) {
    if (chunk.type === 'text' && chunk.content) out += chunk.content;
  }
  return out;
}

/** 递归列出工作区内骨架生成的文件（排除 .memora 数据目录） */
function listGeneratedFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readFileSystem(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        if (entry.name === '.memora') continue;
        walk(full);
      } else {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** 轻量目录读取（避免脚本依赖额外依赖） */
function readFileSystem(dir: string): { name: string; isDirectory: boolean }[] {
  return readdirSync(dir, { withFileTypes: true }).map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory(),
  }));
}

async function main(): Promise<void> {
  const baseUrl = readEnv('MEMORA_BASE_URL');
  const model = readEnv('MEMORA_MODEL');
  const apiKey = readEnv('MEMORA_API_KEY');
  if (!baseUrl || !model || !apiKey) {
    console.error('❌ 缺少环境变量 MEMORA_BASE_URL / MEMORA_MODEL / MEMORA_API_KEY');
    process.exit(1);
  }

  // 临时工作区（含一份待生成骨架的简单设计文档）
  const workspace = join(os.tmpdir(), `memora-scaffold-${Date.now()}`);
  mkdirSync(join(workspace, '.memora'), { recursive: true });
  const docPath = join(workspace, 'design.md');
  writeFileSync(
    docPath,
    `# 设计文档\n\n## 目标\n一个极简的问候服务，输入名字返回欢迎语。\n\n## 模块\n- src/greet.ts：主入口，导出 greet(name) 函数\n- src/__tests__/greet.test.ts：单元测试占位\n- package.json：node 项目清单\n- tsconfig.json：TS 编译配置\n`,
    'utf8',
  );
  console.log(`📄 设计文档：${docPath}`);

  // 装配 Agent（configDir 指向插件 skills 目录——与 assemble.ts 相同逻辑）
  const storage = new WorkspaceStorage(workspace);
  storage.load();
  const sessionStore = new WorkspaceSessionStore(workspace);
  sessionStore.load();
  const agent = new Agent({
    projectPath: workspace,
    dataDir: join(workspace, '.memora'),
    configDir: join(process.cwd(), 'src', 'extension', 'skills'),
    provider: createDocReviewProvider(undefined, { MEMORA_BASE_URL: baseUrl, MEMORA_MODEL: model, MEMORA_API_KEY: apiKey }),
    storage,
    sessionStore,
    permission: 'owner',
    allowedPaths: [workspace],
  });
  await agent.init();

  // 触发骨架生成（输入含 skill trigger 词）
  const input = `[设计文档]\n${readFileSync(docPath, 'utf8')}\n[/设计文档]\n\n请基于上述设计文档，在工作区生成项目代码骨架（目录结构 + 占位实现），完成后列出生成的文件清单。`;
  const result = await collectText(agent.chat(input));
  await agent.close();

  console.log('\n=== 骨架生成结果 ===');
  console.log(result.slice(0, 1500));

  // 判定：是否在工作区真实落盘了骨架文件（排除 .memora 与 design.md 本身）
  const generated = listGeneratedFiles(workspace).filter((f) => f !== docPath);
  console.log(`\n📊 生成的骨架文件数：${generated.length}`);
  for (const f of generated) console.log(`  - ${f.replace(workspace, '.')}`);
  if (generated.length > 0) {
    console.log('✅ 骨架生成链路跑通：scaffold skill 已生效，工作区落盘了文件');
  } else {
    console.log('⚠️ 工作区未落盘骨架文件，需人工判断 Agent 是否只输出了清单而未写文件');
  }

  rmSync(workspace, { recursive: true, force: true });
  console.log('\n🧹 已清理临时工作区');
}

main().catch((err) => {
  console.error('验证脚本异常：', err);
  process.exit(3);
});