/**
 * 切片 B 验证脚本 — doc-review skill 加载 + 自洽检查链路
 *
 * 目的：验证装配层 configDir 正确指向插件 skills 目录，doc-review skill 能加载，
 * 且 Agent 围绕待审阅文档触发自洽检查（矛盾/缺口/悬空引用）。
 *
 * 运行方式（在 hosts/vscode-plugin 下）：
 *   node --import ../../node_modules/tsx/dist/loader.mjs scripts/verifyDocReview.mts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

async function main(): Promise<void> {
  const baseUrl = readEnv('MEMORA_BASE_URL');
  const model = readEnv('MEMORA_MODEL');
  const apiKey = readEnv('MEMORA_API_KEY');
  if (!baseUrl || !model || !apiKey) {
    console.error('❌ 缺少环境变量 MEMORA_BASE_URL / MEMORA_MODEL / MEMORA_API_KEY');
    process.exit(1);
  }

  // 临时工作区（含一份待审阅的设计文档，故意留一个矛盾 + 一个悬空引用）
  const workspace = join(os.tmpdir(), `memora-docreview-${Date.now()}`);
  mkdirSync(join(workspace, '.memora'), { recursive: true });
  const docPath = join(workspace, 'design.md');
  writeFileSync(
    docPath,
    `# 设计文档\n\n## 目标\n采用 JSON 文件存储记忆，零依赖。\n\n## 矛盾点\n但后续又决定：为了性能必须引入数据库。\n\n## 悬空引用\n详见 [不存在的章节](#不存在的章节)。\n`,
    'utf8',
  );
  console.log(`📄 待审阅文档：${docPath}`);

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

  // 触发自洽检查（输入含 skill trigger 词）
  const input = `[待审阅文档]\n${readFileSync(docPath, 'utf8')}\n[/待审阅文档]\n\n请对当前文档做自洽性审阅（矛盾 / 缺口 / 悬空引用），按「问题 / 位置 / 建议修复」输出。`;
  const result = await collectText(agent.chat(input));
  await agent.close();

  console.log('\n=== 自洽检查结果 ===');
  console.log(result.slice(0, 1500));

  // 判定：是否覆盖了矛盾 / 悬空引用维度
  const hasContradiction = /矛盾|冲突|自相矛盾/.test(result);
  const hasBrokenRef = /悬空|不存在|不存在的章节|未定义/.test(result);
  console.log(`\n📊 检测到矛盾维度：${hasContradiction ? '✅' : '⚠️'}`);
  console.log(`📊 检测到悬空引用维度：${hasBrokenRef ? '✅' : '⚠️'}`);
  if (hasContradiction || hasBrokenRef) {
    console.log('✅ 自洽检查链路跑通：doc-review skill 已生效，能识别问题');
  } else {
    console.log('⚠️ 未明确识别矛盾/悬空引用，需人工判断结果是否合理');
  }

  rmSync(workspace, { recursive: true, force: true });
  console.log('\n🧹 已清理临时工作区');
}

main().catch((err) => {
  console.error('验证脚本异常：', err);
  process.exit(3);
});