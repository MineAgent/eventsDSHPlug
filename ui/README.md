# dsh-mc-event-ui

`dsh-mc-event` 的 Web 界面独立包。

DSH 只扫描主 Loader 条目的 `dsh.client`，且只接受**裸包名**条目；preset
子插件和 `pkg/subpath` 条目都扫描不到。因此界面不能挂在 preset 里的
`@local/dsh-mc-event` 上，必须由这个独立的全局 bundle 提供：

- 安装为普通 link 依赖并加入 profile 的 `dsh.profile.bundles`；
- `cordis.patch.yml` 在宿主全局插入 `mc-event-ui`；
- `index.js` 调用主包的 `applyUi()`，只注册
  `/api/dsh-mc-event/listener` 路由；
- `client.js` 注册输入框下方的「MC 事件监听」开关、当前会话订阅清除和
  有订阅会话列表。

主包仍负责 `subscribe_mc_event` / `get_mc_event_types` 和按会话订阅。
