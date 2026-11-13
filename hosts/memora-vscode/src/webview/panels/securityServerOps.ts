/**
 * 安全页宿主执行面（`security_toggle` / `allowed_paths_set` / `search_engine_set` /
 * `custom_search_engines_set` + 测试 / `reset_user_data` 的**唯一实现**）
 *
 * 为什么独立成文件（同 `mcpServerOps.ts` / `settingsMemoryOps.ts`）：
 *   ① `settingsPanel.ts` 是逼近 eslint max-lines 基线的 TARGET 文件（只降不升），安全域的
 *      消息处理是线性增长区（每加一个配置项就多一段「校验 + 写入 + 回推」）；
 *   ② 这五个 op 是**同一个语义面**（安全页的设置写入与一次性动作），放一处才能保证
 *      「写入路径只有一条」，且本地化判据按文件登记时它们各自成网。
 *
 * 三条纪律（SSOT / 不带伤）：
 *   1. **写入只走 `settingsWrite` / `globalState`**：不在本文件另造配置写入通道；
 *      写失败必须回执（静默吞输入 = 用户以为点中了）。
 *   2. **判据单点**：搜索引擎清单校验复用 `validateCustomEngines`、探针复用
 *      `probeSearchEngine`（extension/host/searchEngines.ts），本文件不重写规则。
 *   3. **回推收敛**：任何拒绝路径都回推一次**已持久化状态**，让界面收敛到真相，
 *      不留在假值上（旧缺陷：下拉停在被篡改的非法值）。
 *
 * 文案口径：键 = 英文源文案本身，插值一律 `{0}`；`vscode.l10n.t` 是宿主侧本地化唯一合法用法。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import type {
  CustomSearchEngineConfig,
  ExtensionToWebviewMessage,
  SearchEngineSetting,
  SearchEngineTestResult,
} from '../../shared/protocol.js';
import { PRESET_SEARCH_ENGINES } from '../../shared/protocol.js';
import { CONFIRM_SCRIPTS_KEY } from '../../shared/constants.js';
import { writeErrorText, writeSetting } from '../../extension/settingsWrite.js';
import { probeSearchEngine, validateCustomEngines } from '../../extension/host/searchEngines.js';
import { toNoticeText } from '../../extension/host/noticeText.js';
import { readCustomSearchEngines } from '../helpers/settingsStatusPush.js';

/**
 * 安全页执行面依赖（由 settingsPanel 注入：它持有视图、agent 与恢复处理器）
 */
export interface SecurityOpsDeps {
  /** 回推一条消息（隐藏期由面板自身决定是否可投，本模块不判可达性） */
  post(msg: ExtensionToWebviewMessage): void;
  /** 取当前装配的 Agent（热更新 `setConfirmScripts` / `setAllowedPaths`；`undefined` = 未就绪） */
  ensureAgent(): Promise<Agent | undefined>;
  /** 用户级全局状态（执行确认开关的持久值） */
  globalState: vscode.Memento | undefined;
  /** 「恢复初始状态」处理器（extension 注入：modal + 清理 + reload 的单一路径） */
  runReset(): Promise<{ ok: boolean; cancelled?: boolean; message?: string }>;
}

/**
 * 切换执行二次确认开关（`security_toggle`）
 *
 * 持久化到 globalState + 热更新 agent.security.setConfirmScripts()。无需重启 Agent
 * （SecurityGuard 支持运行时切换）。语义：开 = run_code / run_project_script / run_command
 * （普通命令）执行前询问。⚠️ git 写操作与 npm publish 属 ALWAYS_ASK 档，**不受本开关影响**
 * （恒询问且不可豁免，见内核 `pathGuard.classifyCommand`）——故关闭态文案必须带上这句，
 * 否则用户会误以为关掉开关就能跳过 git 提交审批。
 *
 * @param deps 依赖
 * @param enabled 目标开关值
 */
export async function toggleConfirmScriptsOp(
  deps: SecurityOpsDeps,
  enabled: boolean,
): Promise<void> {
  try {
    // 1. 持久化到 globalState（用户级偏好）
    deps.globalState?.update(CONFIRM_SCRIPTS_KEY, enabled);
    // 2. 热更新已装配的 Agent（SecurityGuard 运行时切换）
    const agent = await deps.ensureAgent();
    if (agent?.security) {
      agent.security.setConfirmScripts(enabled);
    }
    // 3. 推送最新状态给 webview（写入确认已退役，只剩执行确认这一项）
    deps.post({ type: 'security_status', confirmScripts: enabled });
    deps.post({
      type: 'notice',
      level: 'info',
      message: enabled
        ? vscode.l10n.t(
            'Execution confirmation enabled (an approval card appears before running scripts/code or ordinary commands)',
          )
        : vscode.l10n.t(
            'Execution confirmation disabled (scripts and ordinary commands run without approval; git write operations and publishing still always ask)',
          ),
    });
  } catch (err) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: vscode.l10n.t('Failed to toggle execution confirmation: {0}', toNoticeText(err)),
    });
  }
}

/**
 * 设置白名单额外允许路径（`allowed_paths_set`）
 *
 * 归类：目录白名单 = 这台机器信任的数据目录（机器级信任，跨项目通用），归
 * ConfigurationTarget.Global——个人绝对路径不进项目 .vscode/settings.json（避免随项目入库
 * 泄漏本机目录结构 + 跨项目重复配置）。热更新 agent.security.setAllowedPaths()。
 *
 * @param deps 依赖
 * @param paths 完整用户额外数组（不含 projectPath 基准根）
 */
export async function setAllowedPathsOp(deps: SecurityOpsDeps, paths: string[]): Promise<void> {
  // 1. 持久化到用户级设置（机器级信任；projectPath 基准根恒在，不在此数组内）。
  //    经统一写入通道（带 5s 上限）：写不进去就回执并中止，不热更一份没落盘的偏好。
  const written = await writeSetting('allowedPaths', paths);
  if (!written.ok) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: writeErrorText(vscode.l10n.t('Allowed path settings'), written),
    });
    return;
  }
  try {
    // 2. 热更新已装配的 Agent（SecurityGuard 运行时切换）
    const agent = await deps.ensureAgent();
    if (agent?.security) {
      agent.security.setAllowedPaths(paths);
    }
    // 3. 推送最新状态给 webview（含只读基准根 projectPath）
    const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    deps.post({ type: 'allowed_paths_status', projectPath, paths });
    deps.post({
      type: 'notice',
      level: 'info',
      message:
        paths.length > 0
          ? vscode.l10n.t('Updated the allowed path allow-list ({0} items)', paths.length)
          : vscode.l10n.t('Cleared extra allowed paths (only the project directory remains)'),
    });
  } catch (err) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: vscode.l10n.t('Failed to update allowed paths: {0}', toNoticeText(err)),
    });
  }
}

/**
 * 加载并推送白名单额外路径状态（settings 视图 ready / 隐藏转可见时调用）
 *
 * 从 workspace 设置读取持久化的额外路径数组，推送给 webview 渲染初始列表。
 *
 * @param deps 依赖
 */
export function loadAllowedPathsStatusOp(deps: SecurityOpsDeps): void {
  const paths = vscode.workspace.getConfiguration('memora').get<string[]>('allowedPaths', []);
  const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  deps.post({ type: 'allowed_paths_status', projectPath, paths });
}

/**
 * 设置内部网页搜索引擎（`search_engine_set`）
 *
 * 归类：搜索引擎是**用户级偏好**（跨项目一致，与模型/provider 同属用户设置），写入
 * ConfigurationTarget.Global——不进项目 .vscode/settings.json，避免个人偏好入库/跨仓漂移
 * （与 providerStore 的 providers 同 scope）。装配期一次性注入，修改后需重载窗口生效——
 * 此处仅持久化 + 回显，不做热装配。
 *
 * @param deps 依赖
 * @param engine 目标引擎（预设名或自定义引擎名）
 */
export async function setSearchEngineOp(
  deps: SecurityOpsDeps,
  engine: SearchEngineSetting,
): Promise<void> {
  const customs = readCustomSearchEngines();
  const valid =
    (PRESET_SEARCH_ENGINES as readonly string[]).includes(engine) ||
    customs.some((e) => e.name === engine);
  if (!valid) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: vscode.l10n.t('Invalid search engine: {0}', engine),
    });
    return;
  }
  // 经统一写入通道（带 5s 上限）：失败（含不 settle 超时）即回执，不回显未落盘的选择
  const written = await writeSetting('searchEngine', engine);
  if (!written.ok) {
    deps.post({
      type: 'notice',
      level: 'error',
      message: writeErrorText(vscode.l10n.t('Web search engine setting'), written),
    });
    return;
  }
  deps.post({ type: 'search_engine_status', engine });
  deps.post({
    type: 'notice',
    level: 'info',
    message: vscode.l10n.t(
      'Switched the web search engine: {0} (takes effect after reloading the window)',
      engine,
    ),
  });
}

/**
 * 拒绝一次自定义引擎保存：报出原因，并**回推当前已持久化状态**令 webview 收敛。
 *
 * 校验失败与探针未通过两条路径都走这里 ⇒ 回滚行为单点，不留第二份逻辑。
 *
 * @param deps 依赖
 * @param reason 拒绝原因（已本地化的整句）
 */
function rejectCustomEngines(deps: SecurityOpsDeps, reason: string): void {
  deps.post({ type: 'notice', level: 'error', message: reason });
  deps.post({ type: 'custom_search_engines_status', engines: readCustomSearchEngines() });
}

/**
 * 持久化用户自定义搜索引擎清单（`custom_search_engines_set`）
 *
 * 校验：每项需名称非空、URL 模板含 {query}、解析策略合法；任一不合规整体拒绝并提示，
 * 不写入（避免半合法状态）。合法则写入用户级设置 + 回推状态 + 提示。
 *
 * @param deps 依赖
 * @param engines 完整清单（整键覆盖）
 */
export async function setCustomSearchEnginesOp(
  deps: SecurityOpsDeps,
  engines: CustomSearchEngineConfig[],
): Promise<void> {
  const problem = validateCustomEngines(engines);
  if (problem) {
    rejectCustomEngines(deps, vscode.l10n.t('Custom search engine: {0}; not saved', problem));
    return;
  }
  // 保存前实测验证（host 权威门禁）：仅对相对已持久化清单发生变化的引擎探针（未变引擎跳过，
  // 避免重复网络探测）；任一变化引擎验证未通过（网络失败 / 接口无结构化结果）→ 整体拒绝保存，
  // webview 即便跳过「测试」也无法绕过。
  const persisted = readCustomSearchEngines();
  for (const e of engines) {
    const unchanged = persisted.some(
      (p) =>
        p.name === e.name && p.urlTemplate === e.urlTemplate && p.parseStrategy === e.parseStrategy,
    );
    if (unchanged) continue;
    const r = await probeSearchEngine(e);
    if (!r.ok) {
      rejectCustomEngines(
        deps,
        vscode.l10n.t(
          'Search engine "{0}" failed verification; not saved: {1}',
          e.name || vscode.l10n.t('(empty)'),
          r.error ?? vscode.l10n.t('the endpoint returned no parsable results ({0})', r.count),
        ),
      );
      return;
    }
  }
  // 经统一写入通道（带 5s 上限）：写不进去即回执 + 回推已持久化清单（回滚单点 = rejectCustomEngines）
  const written = await writeSetting('customSearchEngines', engines);
  if (!written.ok) {
    rejectCustomEngines(
      deps,
      writeErrorText(vscode.l10n.t('Custom search engine settings'), written),
    );
    return;
  }
  deps.post({ type: 'custom_search_engines_status', engines });
  deps.post({
    type: 'notice',
    level: 'info',
    message: vscode.l10n.t(
      'Saved {0} custom search engines (takes effect after reloading the window)',
      engines.length,
    ),
  });
}

/**
 * 自定义搜索引擎连通性验证（`custom_search_engine_test`，纯预览无持久化语义）
 *
 * 静态校验先用同一判据过一遍（非法配置不必发网络请求），合法才实测抓取 + 解析。
 *
 * @param deps 依赖
 * @param engine 表单草稿
 */
export async function testCustomSearchEngineOp(
  deps: SecurityOpsDeps,
  engine: CustomSearchEngineConfig,
): Promise<void> {
  const problem = validateCustomEngines([engine]);
  const result: SearchEngineTestResult = problem
    ? {
        engineName: engine?.name || vscode.l10n.t('(empty)'),
        ok: false,
        count: 0,
        error: problem,
      }
    : await probeSearchEngine(engine);
  deps.post({ type: 'custom_search_engine_test_result', result });
}

/**
 * 执行「恢复初始状态」并把结果回推 webview（`reset_user_data`）
 *
 * 处理器未注入（理论不可达——activate 恒注入）时返回失败回执，不静默吞掉
 * （否则按钮点了没反应，用户无从判断是没点到还是坏了）。
 *
 * @param deps 依赖
 */
export async function resetUserDataOp(deps: SecurityOpsDeps): Promise<void> {
  let result: { ok: boolean; cancelled?: boolean; message?: string };
  try {
    result = await deps.runReset();
  } catch (err) {
    result = { ok: false, message: toNoticeText(err) };
  }
  deps.post({
    type: 'reset_user_data_result',
    ok: result.ok,
    cancelled: result.cancelled,
    message: result.message,
  });
}
