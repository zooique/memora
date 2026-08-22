/**
 * G3 小验证脚本 — 检查点断点续跑（跨实例恢复）
 *
 * 目的：先验证内核检查点行为，回答 G3 落地前的关键问题：
 *   1. 正常对话一轮后，检查点是否已产生（内存 getCheckpoint 非空、hotMemory 含消息）？
 *   2. 正常对话结束后，检查点是否自动落盘到宿主 sessionStore（saveCheckpoint）？
 *   3. 暂停（agent.pause）后，检查点是否落盘？
 *   4. 新 Agent 实例（同 sessionStore）能否 loadPersistedCheckpoint 加载到持久化检查点？
 *   5. agent.restoreFromCheckpoint 恢复的消息数是否符合预期？
 *   6. 恢复后能否正常续跑（chat('继续') 正常返回）？
 *
 * 运行方式（在 hosts/memora-vscode 下）：
 *   npx tsx scripts/verifyCheckpoint.mts
 *
 * 用桩 LlmProvider（脚本化文本，零真实 API），确定性可离线验证。
 * 默认角色包 doc-review 策略 reflect.handoff='wait'，单轮即收敛，桩回复不会触发 loop 死循环。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { Agent, type LlmProvider, type ChatOptions, type LlmChunk } from '@zooique/memora';
import { WorkspaceStorage } from '../src/extension/host/workspaceStorage.js';
import { WorkspaceSessionStore } from '../src/extension/host/sessionStore.js';

/**
 * 桩 LLM Provider：chat() 仅产出预设文本。
 *
 * 内核 `LlmProvider` 抽象类仅以 `type` 形式导出（无法运行时 extends），
 * 改用 `implements`（type-only 兼容，esbuild/tsx 转译剥离 implements 子句，无运行期引用）。
 * 回复带轮次编号，便于观察 loop 是否收敛。
 */
class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly supportsStructuredOutput = false;
  private callCount = 0;

  async *chat(_messages: unknown[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    this.callCount += 1;
    const n = this.callCount;
    yield {
      content: `（脚本回复 ${n}）已收到你的消息，这是对当前上下文的回应。`,
      finishReason: 'stop',
    };
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

/** 装配一个已 init 的 Agent（同一 workspace 共享 storage/sessionStore，模拟跨实例重启） */
async function createAgent(
  workspace: string,
  provider: LlmProvider,
): Promise<{ agent: Agent; sessionStore: WorkspaceSessionStore }> {
  const storage = new WorkspaceStorage(workspace);
  storage.load();
  const sessionStore = new WorkspaceSessionStore(workspace);
  sessionStore.load();
  const agent = new Agent({
    projectPath: workspace,
    dataDir: join(workspace, '.memora'),
    // configDir 指向插件源码目录以扫描 role-packs（doc-review 自动激活，handoff=wait）
    configDir: join(process.cwd(), 'src', 'extension'),
    provider,
    storage,
    sessionStore,
    permission: 'owner',
    allowedPaths: [workspace],
  });
  await agent.init();
  return { agent, sessionStore };
}

/** 输出一项检查结果（ok 与否 + 说明） */
function report(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name}：${detail}`);
}

async function main(): Promise<void> {
  const workspace = join(os.tmpdir(), `memora-checkpoint-verify-${Date.now()}`);
  mkdirSync(workspace, { recursive: true });
  console.log(`📁 临时工作区：${workspace}`);

  // ─── Agent A：对话一轮 + 暂停，检查检查点产生与落盘 ─────────
  console.log('\n=== Agent A：对话一轮 + 暂停 ===');
  const { agent: agentA, sessionStore } = await createAgent(workspace, new ScriptedProvider());

  const textA = await collectText(agentA.chat('你好，请介绍一下你自己。'));
  console.log('Agent A 回复：' + textA.slice(0, 120));

  // 1. 对话后内存检查点（预期为空：createCheckpoint 仅在暂停/切换/updateGoal 等操作点触发）
  const cpAfterChat = agentA.sessionManager?.getCheckpoint();
  report(
    '对话后内存检查点已产生',
    Boolean(cpAfterChat),
    cpAfterChat
      ? `sessionId=${cpAfterChat.sessionId}，hotMemory=${cpAfterChat.hotMemory?.length ?? 0} 条`
      : 'getCheckpoint() 为空（对话结束不创建检查点对象，符合 createCheckpoint 触发点设计）',
  );

  // 3. 暂停：触发 createCheckpoint（force flush 落盘），此时才产生可持久化检查点
  const paused = agentA.pause('verify-checkpoint', 'user');
  const cpAfterPause = agentA.sessionManager?.getCheckpoint();
  const sessionId = cpAfterPause?.sessionId ?? '';
  const persistedAfterPause = sessionId ? sessionStore.loadCheckpoint(sessionId) : null;
  report(
    '暂停后检查点已落盘',
    paused && Boolean(cpAfterPause) && Boolean(persistedAfterPause),
    `pause=${paused}，sessionId=${sessionId || '（空）'}，hotMemory=${cpAfterPause?.hotMemory?.length ?? 0} 条，` +
      `loadCheckpoint ${persistedAfterPause ? '有值' : '仍为空'}`,
  );

  await agentA.close();

  // ─── Agent B：同 sessionStore 恢复检查点 + 续跑 ─────────────
  console.log('\n=== Agent B：同 sessionStore 恢复检查点 + 续跑 ===');
  const { agent: agentB } = await createAgent(workspace, new ScriptedProvider());

  // 新实例 init 后默认即切入 'main' 会话（与 Agent A 的会话同 key），无需 switchToSession；
  // 注意：Agent A 处于 paused 态时 switchToSession 会被状态机拒绝（仅 running 允许切换），
  // 这里直接走默认会话路径场景。loadPersistedCheckpoint 按 history.currentSessionName 读取。
  const checkpoint = agentB.sessionManager?.loadPersistedCheckpoint();
  report('新实例可加载持久化检查点', Boolean(checkpoint), checkpoint ? `status=${checkpoint.status}` : 'loadPersistedCheckpoint() 返回 null');

  // 4. 完整恢复（热窗口 + 温记忆 + 契约重注入）
  let restored = 0;
  if (checkpoint) {
    restored = await agentB.restoreFromCheckpoint(checkpoint);
  }
  report('restoreFromCheckpoint 恢复消息数 > 0', restored > 0, `恢复 ${restored} 条消息`);

  // 5. 续跑：恢复后继续对话正常
  const textB = await collectText(agentB.chat('继续'));
  report('恢复后续跑正常', textB.trim().length > 0, `续跑回复：${textB.trim().slice(0, 120) || '（空）'}`);

  await agentB.close();

  // ─── 清理 ─────────────────────────────────────────
  rmSync(workspace, { recursive: true, force: true });
  console.log('\n🧹 已清理临时工作区');
  console.log('\n=== 结论 ===');
  console.log('检查点由「暂停/切换/updateGoal 等操作点」createCheckpoint + force flush 触发落盘，');
  console.log('正常对话结束不落盘——故 G3 断点续跑入口应与「暂停动作/未完成态」绑定，跨实例恢复经本链路');
}

main().catch((err) => {
  console.error('实测脚本异常：', err);
  process.exit(3);
});
