/**
 * settingsStatusPush — 设置页三条「读配置 → 推一条消息」的公共实现
 *
 * 为什么外置（不是为过闸压行）：这三条动作只读 `globalState` / `getConfiguration`
 * 并 post 一条状态，零面板状态依赖，本就不该长在 `settingsPanel.ts` 的类体里。
 * `settingsPanel.ts` 贴 eslint `max-lines` 只降不升，接入「作品和规则」页前先把这块
 * 职责归位，腾出等量行——**先腾行后加功能**，不靠抬阈值。
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

/** 消息投递口（面板注入，隐藏期由面板自身决定是否可投） */
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
