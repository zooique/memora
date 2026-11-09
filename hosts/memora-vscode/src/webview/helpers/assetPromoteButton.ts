/**
 * 设置页「添加到用户级」按钮工厂（角色包卡片用）
 *
 * 为什么单独成文件：`rolesView.ts` 贴 eslint max-lines 闸（只降不升），而按钮的
 * DOM 构造 + 文案 + 事件绑定是一段完整、可独立阅读的小逻辑；外置后卡片渲染只留一行挂载。
 *
 * 语义（改之前先读）：项目级资产 → 用户级目录是**拷贝，不是同步**（复制后两侧是两份
 * 独立资产）；同名由宿主先备份再覆盖、失败可回滚。按钮只发消息，不做本地乐观更新——
 * 是否成功、是否覆盖由宿主执行面裁决，成功后以列表重推为准。
 */

import * as l10n from '@vscode/l10n';
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';

/** 可升级到用户级的资产类型（与 `asset_copy_to_user` 的 assetKind 同源） */
export type PromoteAssetKind = 'skill' | 'rolePack';

/**
 * 往卡片动作区挂一个「添加到用户级」按钮
 *
 * @param container 卡片动作区容器（`card-actions`）
 * @param assetKind 资产类型（决定宿主走哪个来源断言）
 * @param name 资产标识（技能名 / 角色包 manifest name）
 * @param post webview → extension 投递器（由视图工厂注入，不依赖全局）
 */
export function appendPromoteToUserButton(
  container: HTMLElement,
  assetKind: PromoteAssetKind,
  name: string,
  post: (msg: WebviewToExtensionMessage) => void,
): void {
  const button = document.createElement('button');
  // 样式复用设置页既有次按钮基类，不新造视觉
  button.className = 'btn btn-secondary';
  button.textContent = l10n.t('Add to user level');
  button.title = l10n.t(
    'Copy into the user-level directory (a copy, not a sync; an existing item is backed up before being overwritten, and failure rolls back)',
  );
  button.addEventListener('click', () => post({ type: 'asset_copy_to_user', assetKind, name }));
  container.appendChild(button);
}
