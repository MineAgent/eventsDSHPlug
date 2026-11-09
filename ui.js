/**
 * dsh-mc-event — 全局 UI 入口。
 *
 * 只负责注册界面开关与会话订阅路由，不注册模型工具。真正的
 * `subscribe_mc_event` / `get_mc_event_types` 由 preset 里的 `index.js` 提供。
 *
 * 为什么需要这个入口：DSH 只扫描主 Loader 条目的 `dsh.client`，而 preset
 * 子插件挂在独立的 EntryTree 里，扫描不到；所以客户端 UI 必须由一个全局
 * 条目承载。
 */

import { applyUi } from './index.js';

/** Cordis 插件名。 */
export const name = 'mc-event-ui';

/**
 * 全局入口：注册状态路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  applyUi(ctx);
}
