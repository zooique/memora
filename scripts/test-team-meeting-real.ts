/**
 * run_team_meeting 真机验证（工具内调 LLM，正式实现链路）
 *
 * 验证对象：内置工具 run_team_meeting 的实际实现 runTeamMeetingAssessment ——
 * 经 RolePackManager.getTeam 解析组名 → buildSystemPrompt 取各角色 persona 全文 →
 * 拼多角色 system prompt → **一次** provider.chat() 完成各视角评估 + 组长汇总。
 *
 * 真机实证结论：三视角（白话方案设计师 / 共鸣小说家 / memora 助手）
 * 各自观点真实体现角色设定差异（小说家用"人物/内核/风格记忆·设定圣经"、设计师用
 * "种子/最小单元/白话总览/可开发性"、助手讲"跨会话连续性/偏好/隐私噪音成本"）。
 * 详细结论见 docs/run_team_meeting-探索方案.md。
 *
 * 用例：
 *   npx tsx scripts/test-team-meeting-real.ts
 *
 * 环境：三元组 MEMORA_MODEL / MEMORA_BASE_URL / MEMORA_API_KEY
 *       （或用 .memora/config.json 占位展开；本脚本直接读环境变量）
 */
import { createProviderFromConfig } from '../src/llm/factory.js';
import { RolePackManager } from '../src/role-pack/rolePackManager.js';
import { runTeamMeetingAssessment } from '../src/agent/builtinToolHandlers.js';

/** 真机主体：真实装载角色包 + 真实 LLM 走 run_team_meeting 实现链 */
async function probeTeamMeeting(): Promise<void> {
  console.log('━'.repeat(70));
  console.log('run_team_meeting 真机：getTeam 解析组 + 多角色 persona 注入 + 各视角评估');
  console.log('━'.repeat(70));

  // 用真实角色包源目录装载 rolePackManager（configDir = 项目根，role-packs 为其子目录）
  const manager = new RolePackManager(process.cwd());
  await manager.load('memora助手');
  // 组：组长=设计师，组员=小说家、助手（视角差异鲜明，便于判定「各视角体现角色设定」）
  manager.setRolePackTeams([{ leader: '白话方案设计师', members: ['共鸣小说家', 'memora助手'] }]);

  const team = manager.getTeam('白话方案设计师');
  console.log(`  组解析：组长=${team?.leader ?? '?'}，组员=${team?.members.join(' / ') ?? '?'}\n`);

  // 真实 LLM 单次调用（run_team_meeting 实现链：一次 chat() 注入全部角色 persona）
  const provider = createProviderFromConfig('real', {
    model: process.env['MEMORA_MODEL'] ?? 'mimo-v2.5',
    baseUrl: process.env['MEMORA_BASE_URL'] ?? 'https://api.xiaomimimo.com/v1',
    apiKey: process.env['MEMORA_API_KEY'] ?? '',
  });
  const topic = '「该不该给一个创意写作工具加记忆功能？」';
  console.log(
    '  📤 调用 run_team_meeting，一次 LLM 调用注入 3 个角色 persona，请 LLM 各视角评估 + 组长汇总\n',
  );
  const start = Date.now();
  const response = await runTeamMeetingAssessment({
    resolveTeam: (g) => manager.getTeam(g),
    buildPersona: (n) => manager.buildSystemPrompt(n),
    provider,
    group: '白话方案设计师',
    topic,
  });
  const duration = Date.now() - start;
  console.log(`  ⏱️ 单次调用耗时：${duration}ms\n`);

  // 判定：响应是否出现各角色视角 marks，且内容体现角色设定差异
  console.log('  ── LLM 产出 ──');
  console.log('  ' + response.replace(/\n/g, '\n  '));

  const hasDesigner = /白话方案设计师|方案设计师/.test(response) || /种子|最小单元/.test(response);
  const hasNovelist = /共鸣小说家|小说家/.test(response) || /共鸣|人心|人性|冲突/.test(response);
  const hasAssistant = /memora 助手|助手/.test(response) || /通用|协助/.test(response);
  const hasSummary = /汇总|结论/.test(response);
  const ok = hasDesigner && hasNovelist && response.length > 200;
  console.log('\n' + '━'.repeat(70));
  console.log(
    `  判定：设计师视角=${hasDesigner ? '✓' : '✗'} · 小说家视角=${hasNovelist ? '✓' : '✗'} · 助手视角=${hasAssistant ? '✓' : '✗'} · 组长汇总=${hasSummary ? '✓' : '✗'}`,
  );
  console.log(
    `  产出长度=${response.length} ${ok ? '→ ✅ 多角色视角真实注入，各视角差异可辨' : '→ ❌ 未达预期判断'}`,
  );
  console.log('━'.repeat(70));
}

// ─── 退出清理（Node 24 + Windows fetch stream 关闭顺序问题） ───
process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(`💥 未捕获异常：${msg}\n`);
  process.exit(1);
});

probeTeamMeeting()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`💥 真机验证失败：${msg}\n`);
    process.exit(1);
  });
