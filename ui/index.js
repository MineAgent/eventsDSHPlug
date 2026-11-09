/**
 * dsh-mc-event-ui — 全局 Host 入口。
 *
 * 只注册 `/api/dsh-mc-event/listener` 状态路由，不注册模型工具。状态与订阅
 * 数据来自主包的共享模块；主包在 preset 里负责工具与订阅，本包在宿主全局
 * 负责浏览器端 UI。
 *
 * 独立成包的原因：DSH 只扫描主 Loader 条目的 `dsh.client`，而 preset
 * 子插件挂在独立 EntryTree 里；同时扫描器只接受**裸包名**条目，不接受
 * `pkg/subpath` 形式的 Loader 名，所以 UI 必须是一个独立包。
 */

import { applyUi } from '../index.js';

/** Cordis 插件名。 */
export const name = 'mc-event-ui';

/**
 * 全局入口：注册状态路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  applyUi(ctx);
}
