/**
 * dsh-mc-event — 浏览器端。
 *
 * 在输入框下方的 `conversation.composer.dock` 中放一个紧凑的「MC 事件监听」
 * 开关：关闭只暂停向 Agent 投递事件，不结束订阅、不释放 3422；重新开启后
 * 已订阅会话会继续收到新事件。同一个 dock 还显示当前会话的订阅，并列出
 * 当前进程内有订阅的会话，允许静默清除当前会话的订阅。
 *
 * 状态由 Host 持久化；页面打开、聚焦与每 5 秒都会重新读取一次，以便展示
 * Agent 新建立的订阅。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-mc-event',
  factory(require) {
    'use strict';

    var React = require('react');
    var h = React.createElement;

    /** 与 Host 路由保持一致。 */
    var STATE_URL = '/api/dsh-mc-event/listener';
    /** 本插件自己的 locale 命名空间。 */
    var NS = 'mcEvent';
    /** 订阅列表刷新间隔。 */
    var POLL_INTERVAL_MS = 5_000;

    var ZH = {
      label: 'MC 事件监听',
      loading: '读取中',
      statusPaused: '已暂停 · 订阅保留',
      statusWaiting: '已开启 · 等待订阅',
      statusActive: '{count} 个会话订阅中',
      clearCurrent: '清除本会话',
      clearing: '清除中…',
      current: '当前',
      sessionsCount: '有订阅的会话（{count}）',
      switchOffLabel: '开启事件投递',
      switchOnLabel: '关闭事件投递',
      hintOn: '关闭只暂停投递：不结束订阅、不释放 3422；已订阅会话在重新开启后继续收到新事件。',
      hintOff: '已暂停投递；订阅状态与 3422 监听都保留。重新开启后，已订阅会话无需重新订阅。',
      clearHint: '静默清除当前会话的订阅，不会通知 Agent。',
      saveFailed: '保存失败',
      clearFailed: '清除失败',
      invalidResponse: '服务器返回了无法识别的状态',
      retry: '重试',
    };

    var EN = {
      label: 'MC event listener',
      loading: 'Loading',
      statusPaused: 'Paused · subscriptions kept',
      statusWaiting: 'On · waiting for subscriptions',
      statusActive: '{count} subscribed conversation(s)',
      clearCurrent: 'Clear this chat',
      clearing: 'Clearing…',
      current: 'Current',
      sessionsCount: 'Subscribed conversations ({count})',
      switchOffLabel: 'Enable event delivery',
      switchOnLabel: 'Pause event delivery',
      hintOn: 'Turning it off only pauses delivery: subscriptions stay and port 3422 stays open. Subscribed chats resume when you turn it back on.',
      hintOff: 'Delivery is paused; subscriptions and the 3422 listener are kept. Subscribed chats resume without subscribing again.',
      clearHint: 'Silently remove this conversation\'s subscription without notifying the agent.',
      saveFailed: 'Could not save',
      clearFailed: 'Could not clear',
      invalidResponse: 'The server returned an unrecognized state',
      retry: 'Retry',
    };

    var CSS = [
      '.dsh-mc-event-root{display:inline-flex;flex-direction:column;align-items:flex-start;gap:6px;box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-mc-event-row{display:flex;align-items:center;gap:6px;box-sizing:border-box;min-height:26px;padding:1px 6px 1px 9px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);white-space:nowrap;transition:background-color .12s ease,border-color .12s ease}',
      '.dsh-mc-event-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-mc-event-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.dsh-mc-event-root[data-enabled="true"] .dsh-mc-event-dot{background:var(--dsw-alias-brand-primary)}',
      '.dsh-mc-event-label{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.dsh-mc-event-switch{position:relative;flex:none;box-sizing:border-box;width:28px;height:16px;margin:0;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l1);cursor:pointer;transition:background-color .12s ease}',
      '.dsh-mc-event-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dsh-mc-event-switch:disabled{opacity:.55;cursor:default}',
      '.dsh-mc-event-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-mc-event-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .12s ease}',
      '.dsh-mc-event-switch[aria-checked="true"] .dsh-mc-event-knob{transform:translateX(12px)}',
      '.dsh-mc-event-status{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;overflow:hidden}',
      '.dsh-mc-event-action{flex:none;box-sizing:border-box;margin:0;padding:2px 7px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}',
      '.dsh-mc-event-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-mc-event-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-mc-event-action:disabled{opacity:.55;cursor:default}',
      '.dsh-mc-event-error{flex:none;display:grid;place-items:center;box-sizing:border-box;width:16px;height:16px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-weight:700;line-height:16px;cursor:pointer}',
      '.dsh-mc-event-error:hover{background:var(--dsw-alias-bg-base)}',
      '.dsh-mc-event-error:focus-visible{outline:2px solid var(--dsw-alias-state-error-primary);outline-offset:1px}',
      '.dsh-mc-event-list{box-sizing:border-box;width:100%;padding:4px 9px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-mc-event-session{display:flex;align-items:center;gap:6px;min-width:0;padding:2px 0}',
      '.dsh-mc-event-session+.dsh-mc-event-session{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}',
      '.dsh-mc-event-sessionTitle{min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.dsh-mc-event-current{flex:none;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dsh-mc-event-subId{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}',
    ].join('');

    var snapshot = {
      phase: 'loading',
      enabled: true,
      listening: false,
      endpoint: undefined,
      subscriptions: [],
      saving: false,
      clearing: false,
      error: null,
    };
    var listeners = new Set();
    var requestSeq = 0;

    function getSnapshot() {
      return snapshot;
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    }

    function publish(patch) {
      snapshot = Object.assign({}, snapshot, patch);
      listeners.forEach(function (listener) {
        try {
          listener();
        } catch (error) {
          console.error('[mc-event] listener failed:', error);
        }
      });
    }

    function failure(error) {
      return error && error.message ? error.message : String(error);
    }

    function normalizeState(data) {
      if (data === null || typeof data !== 'object' || typeof data.enabled !== 'boolean') {
        throw new Error('invalid server response');
      }
      return {
        enabled: data.enabled,
        listening: data.listening === true,
        endpoint: typeof data.endpoint === 'string' ? data.endpoint : undefined,
        subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [],
        phase: 'ready',
        error: null,
      };
    }

    /** 从 Host 读取当前状态。 */
    function refresh() {
      if (snapshot.saving || snapshot.clearing) return;
      var seq = ++requestSeq;
      fetch(STATE_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (data) {
          if (seq !== requestSeq) return;
          publish(normalizeState(data));
        })
        .catch(function (error) {
          if (seq !== requestSeq) return;
          publish({ phase: 'error', error: failure(error) });
        });
    }

    /** 切换投递开关；乐观更新，失败回滚。 */
    function updateEnabled(next) {
      if (snapshot.saving || snapshot.clearing) return;
      var previous = snapshot.enabled;
      var seq = ++requestSeq;
      publish({ enabled: next, saving: true, error: null });
      fetch(STATE_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (body) {
              if (!response.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + response.status);
              return body;
            });
        })
        .then(function (body) {
          if (seq !== requestSeq) return;
          publish(Object.assign(normalizeState(body), { saving: false }));
        })
        .catch(function (error) {
          if (seq !== requestSeq) return;
          publish({ enabled: previous, saving: false, error: failure(error) });
        });
    }

    /** 静默清除当前会话的订阅。 */
    function clearCurrent(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      if (snapshot.clearing || snapshot.saving) return;
      var seq = ++requestSeq;
      publish({ clearing: true, error: null });
      fetch(STATE_URL + '?session_id=' + encodeURIComponent(sessionId), {
        method: 'DELETE',
        headers: { accept: 'application/json' },
      })
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (body) {
              if (!response.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + response.status);
              return body;
            });
        })
        .then(function (body) {
          if (seq !== requestSeq) return;
          publish(Object.assign(normalizeState(body), { clearing: false }));
        })
        .catch(function (error) {
          if (seq !== requestSeq) return;
          publish({ clearing: false, error: failure(error) });
        });
    }

    function shortSessionId(sessionId) {
      return typeof sessionId === 'string' && sessionId.length > 12
        ? sessionId.slice(0, 8)
        : String(sessionId ?? '');
    }

    function statusText(t, state) {
      if (state.phase === 'loading') return t('loading');
      if (!state.enabled) return t('statusPaused');
      if (state.subscriptions.length === 0) return t('statusWaiting');
      return t('statusActive', { count: state.subscriptions.length });
    }

    function ListenerControl(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var pair = React.useState(getSnapshot());
      var state = pair[0];
      var setState = pair[1];
      var expandedPair = React.useState(false);
      var expanded = expandedPair[0];
      var setExpanded = expandedPair[1];

      React.useEffect(function () {
        return subscribe(function () {
          setState(getSnapshot());
        });
      }, []);

      var subscriptions = state.subscriptions;
      var current = undefined;
      for (var index = 0; index < subscriptions.length; index += 1) {
        if (subscriptions[index] && subscriptions[index].session_id === sessionId) {
          current = subscriptions[index];
          break;
        }
      }
      var busy = state.phase === 'loading' || state.saving || state.clearing;
      var hint = state.enabled ? t('hintOn') : t('hintOff');
      var errorTitle =
        state.error === null
          ? ''
          : (current === undefined ? t('saveFailed') : t('clearFailed')) + ': ' + state.error;

      return h(
        'div',
        {
          className: 'dsh-mc-event-root',
          'data-enabled': state.enabled ? 'true' : 'false',
          'data-phase': state.phase,
        },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsh-mc-event-row', title: hint },
          h('span', { className: 'dsh-mc-event-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'dsh-mc-event-label' }, t('label')),
          h('button', {
            type: 'button',
            role: 'switch',
            className: 'dsh-mc-event-switch',
            'aria-checked': state.enabled,
            'aria-label': state.enabled ? t('switchOnLabel') : t('switchOffLabel'),
            title: hint,
            disabled: busy,
            onClick: function () {
              updateEnabled(!snapshot.enabled);
            },
          }, h('span', { className: 'dsh-mc-event-knob', 'aria-hidden': 'true' })),
          h('span', { className: 'dsh-mc-event-status' }, statusText(t, state)),
          current === undefined
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-mc-event-action',
                  title: t('clearHint'),
                  disabled: state.clearing,
                  onClick: function () {
                    clearCurrent(sessionId);
                  },
                },
                state.clearing ? t('clearing') : t('clearCurrent'),
              ),
          subscriptions.length === 0
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-mc-event-action',
                  'aria-expanded': expanded,
                  onClick: function () {
                    setExpanded(!expanded);
                  },
                },
                (expanded ? '▾ ' : '▸ ') + t('sessionsCount', { count: subscriptions.length }),
              ),
          state.error === null
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-mc-event-error',
                  title: errorTitle,
                  'aria-label': t('retry'),
                  onClick: function () {
                    if (current === undefined) updateEnabled(snapshot.enabled);
                    else clearCurrent(sessionId);
                  },
                },
                '!',
              ),
        ),
        expanded && subscriptions.length > 0
          ? h(
              'div',
              { className: 'dsh-mc-event-list' },
              subscriptions.map(function (row) {
                var title =
                  typeof row.session_title === 'string' && row.session_title.length > 0
                    ? row.session_title
                    : shortSessionId(row.session_id);
                return h(
                  'div',
                  { className: 'dsh-mc-event-session', key: row.subscription_id || row.session_id },
                  h('span', { className: 'dsh-mc-event-sessionTitle', title: row.session_id }, title),
                  row.session_id === sessionId
                    ? h('span', { className: 'dsh-mc-event-current' }, t('current'))
                    : null,
                  h('span', { className: 'dsh-mc-event-subId' }, row.subscription_id || ''),
                );
              }),
            )
          : null,
      );
    }

    return {
      name: 'mc-event',
      inject: ['slots', 'locale'],
      apply: function (ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: ZH, en: EN });
        }, 'mc-event: dictionaries');

        ctx.effect(function () {
          function tick() {
            if (typeof document !== 'undefined' && document.hidden) return;
            refresh();
          }
          function onFocus() {
            refresh();
          }
          if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
          refresh();
          var timer = setInterval(tick, POLL_INTERVAL_MS);
          return function () {
            clearInterval(timer);
            if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
          };
        }, 'mc-event: state polling');

        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'mc-event-listener',
              order: 30,
              locale: NS,
              inject: function (sessionId) {
                return { sessionId: sessionId };
              },
            },
            ListenerControl,
          );
        });
      },
    };
  },
});
