/**
 * settingsStatusPush — 设置页「读配置 → 推一条消息」的公共实现（四条推送 + 一个清单共读口）
 *
 * 为什么外置（不是为过闸压行）：这些动作只读 `globalState` / `getConfiguration`
 * 并 post 一条状态，零面板状态依赖，本就不该长在 `settingsPanel.ts` 的类体里。
 * `settingsPanel.ts` 逼近 eslint `max-lines` 基线（只降不升），故按「读配置 → 推送」
 * 职责归位到本模块，不靠抬阈值。
 *
 * 🔴 判据不变：读的仍是用户级持久值（偏好），不是运行时真相；调用方只注入
 * `post`，本模块不碰 webview 实例、不缓存状态。
 */
import * as vscode from 'vscode';
import type { ArchiveMode } from '@zooique/memora';
import type {
  CustomSearchEngineConfig,
  ExtensionToWebviewMessage,
  SearchEngineSetting,
} from '../../shared/protocol.js';
import { CONFIRM_SCRIPTS_KEY } from '../../shared/constants.js';
import { isAnswerLanguageAuto } from '../../extension/host/responseLanguage.js';

/** 消息投递口（面板注入；**尽力投递、不判断可达性**——丢了下一轮推送会补当前态） */
type Post = (msg: ExtensionToWebviewMessage) => void;

/** 执行二次确认开关的持久值 */
export function pushSecurityStatus(post: Post, globalState: vscode.Memento | undefined): void {
  const scripts = globalState?.get<boolean>(CONFIRM_SCRIPTS_KEY) ?? false;
  post({ type: 'security_status', confirmScripts: scripts });
}

/** 网页搜索引擎选择 */
export function pushSearchEngineStatus(post: Post): void {
  const engine = vscode.workspace
    .getConfiguration('memora')
    .get<SearchEngineSetting>('searchEngine', 'auto');
  post({ type: 'search_engine_status', engine });
}

/** 会话归档模式偏好（命名不说「状态」：UI 回显的是偏好，不是内核运行时真相） */
export function pushArchiveModePreference(post: Post): void {
  const mode = vscode.workspace.getConfiguration('memora').get<ArchiveMode>('archiveMode', 'full');
  post({ type: 'archive_mode_status', mode });
}

/**
 * 常规页三项持久偏好（回答语言模式 / 提示音 / 活动指标）
 *
 * `mode` 判定复用宿主 `isAnswerLanguageAuto`（与 system prompt 指令同一函数），
 * 不在本处另写 `auto` 字面量比对——那会让 UI 回显与真实行为漂移。
 * 活动指标只读 `memora.showMetrics`：消费面（panelSnapshots）实时 get，无热更路径。
 */
export function pushGeneralStatus(post: Post): void {
  const cfg = vscode.workspace.getConfiguration('memora');
  const raw = cfg.get<string>('answerLanguage', '');
  post({
    type: 'general_setting',
    kind: 'answerLanguage',
    mode: isAnswerLanguageAuto(raw) ? 'auto' : 'manual',
    value: raw,
  });
  post({
    type: 'general_setting',
    kind: 'attentionSound',
    value: cfg.get<boolean>('attentionSound', true),
  });
  post({
    type: 'general_setting',
    kind: 'showMetrics',
    value: cfg.get<boolean>('showMetrics', false),
  });
}

/** 读取用户自定义搜索引擎清单（写入侧与推送侧共用同一配置键） */
export function readCustomSearchEngines(): CustomSearchEngineConfig[] {
  return vscode.workspace
    .getConfiguration('memora')
    .get<CustomSearchEngineConfig[]>('customSearchEngines', []);
}

/** 推送自定义搜索引擎清单 */
export function pushCustomSearchEnginesStatus(post: Post): void {
  post({ type: 'custom_search_engines_status', engines: readCustomSearchEngines() });
}
