/**
 * dsh-mc-event-ui — 浏览器端。
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
  id: '@local/dsh-mc-event-ui',
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
      sessionActive: '本会话订阅中',
      sectionLabel: 'MC 事件订阅',
      sessionsTitle: '有订阅的会话',
      emptySessions: '暂无会话订阅',
      stats: '收到 {received} · 已投递 {delivered}',
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
      sessionActive: 'This conversation is subscribed',
      sectionLabel: 'MC event subscriptions',
      sessionsTitle: 'Subscribed conversations',
      emptySessions: 'No conversations are subscribed',
      stats: '{received} received · {delivered} delivered',
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

    /** 当前界面语言；apply 时按宿主 locale 与浏览器语言确定。 */
    var lang = 'zh';

    /** 取文案；{name} 形式做参数替换。 */
    function translate(key, params) {
      var table = lang === 'en' ? EN : ZH;
      var text = table[key];
      if (text === undefined) text = ZH[key];
      if (text === undefined) return key;
      if (params === undefined) return text;
      return text.replace(/\{(\w+)\}/g, function (whole, name) {
        return params[name] === undefined ? whole : String(params[name]);
      });
    }

    /** 从 locale 服务 / 浏览器语言推断界面语言。 */
    function detectLang(ctx) {
      var candidate = '';
      try {
        var state = ctx.locale && ctx.locale.getSnapshot ? ctx.locale.getSnapshot() : null;
        if (state && typeof state.active === 'string') candidate = state.active;
      } catch (error) {
        /* locale 服务读取失败按浏览器语言处理 */
      }
      if (candidate === '') {
        try {
          candidate =
            (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) ||
            '';
        } catch (error) {
          candidate = '';
        }
      }
      return String(candidate).toLowerCase().indexOf('en') === 0 ? 'en' : 'zh';
    }

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
      '.dsh-mc-event-settings{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;width:100%;max-width:720px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dsh-mc-event-settingsHeader{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dsh-mc-event-settingsTitle{flex:none;color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsh-mc-event-settingsHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-mc-event-settingsHeading{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}',
      '.dsh-mc-event-settingsList{display:flex;flex-direction:column;box-sizing:border-box;padding:6px 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-mc-event-empty{padding:4px 0;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dsh-mc-event-settings[data-enabled="true"] .dsh-mc-event-dot{background:var(--dsw-alias-brand-primary)}',
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

    /** 订阅模块级快照，组件卸载时自动取消。 */
    function useSnapshot() {
      var pair = React.useState(getSnapshot());
      React.useEffect(function () {
        return subscribe(function () {
          pair[1](getSnapshot());
        });
      }, []);
      return pair[0];
    }

    /** 找当前会话的订阅。 */
    function currentSubscription(state, sessionId) {
      for (var index = 0; index < state.subscriptions.length; index += 1) {
        var row = state.subscriptions[index];
        if (row && row.session_id === sessionId) return row;
      }
      return undefined;
    }

    /** 投递开关按钮。 */
    function switchButton(t, state, disabled) {
      var hint = state.enabled ? t('hintOn') : t('hintOff');
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: 'dsh-mc-event-switch',
          'aria-checked': state.enabled,
          'aria-label': state.enabled ? t('switchOnLabel') : t('switchOffLabel'),
          title: hint,
          disabled: disabled,
          onClick: function () {
            updateEnabled(!snapshot.enabled);
          },
        },
        h('span', { className: 'dsh-mc-event-knob', 'aria-hidden': 'true' }),
      );
    }

    /** 错误重试按钮。 */
    function errorButton(t, error) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-mc-event-error',
          title: error,
          'aria-label': t('retry'),
          onClick: refresh,
        },
        '!',
      );
    }

    /**
     * 输入框下方：仅在当前会话有订阅时显示。没有订阅的会话不显示任何东西；
     * 全局开关和所有有订阅的会话列表在设置页。
     */
    function SessionDock(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var state = useSnapshot();
      var current = currentSubscription(state, sessionId);
      if (current === undefined) return null;

      var busy = state.phase === 'loading' || state.saving || state.clearing;
      var hint = state.enabled ? t('hintOn') : t('hintOff');
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
          switchButton(t, state, busy),
          h(
            'span',
            {
              className: 'dsh-mc-event-status',
              title: current.subscription_id || '',
            },
            t('sessionActive'),
          ),
          h(
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
          state.error === null ? null : errorButton(t, state.error),
        ),
      );
    }

    /**
     * 设置页「MC 事件订阅」：始终显示全局开关和所有有订阅的会话，
     * 即使一个订阅都没有也显示空状态。
     */
    function SettingsSection(props) {
      var t = props.t;
      var state = useSnapshot();
      var busy = state.phase === 'loading' || state.saving;
      var hint = state.enabled ? t('hintOn') : t('hintOff');
      return h(
        'div',
        {
          className: 'dsh-mc-event-settings',
          'data-enabled': state.enabled ? 'true' : 'false',
          'data-phase': state.phase,
        },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsh-mc-event-settingsHeader' },
          h('span', { className: 'dsh-mc-event-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'dsh-mc-event-settingsTitle' }, t('label')),
          switchButton(t, state, busy),
          h('span', { className: 'dsh-mc-event-status' }, statusText(t, state)),
          state.error === null ? null : errorButton(t, state.error),
        ),
        h('p', { className: 'dsh-mc-event-settingsHint' }, hint),
        h('div', { className: 'dsh-mc-event-settingsHeading' }, t('sessionsTitle')),
        h(
          'div',
          { className: 'dsh-mc-event-settingsList' },
          state.subscriptions.length === 0
            ? h('div', { className: 'dsh-mc-event-empty' }, t('emptySessions'))
            : state.subscriptions.map(function (row) {
                var title =
                  typeof row.session_title === 'string' && row.session_title.length > 0
                    ? row.session_title
                    : shortSessionId(row.session_id);
                return h(
                  'div',
                  { className: 'dsh-mc-event-session', key: row.subscription_id || row.session_id },
                  h('span', { className: 'dsh-mc-event-sessionTitle', title: row.session_id }, title),
                  h(
                    'span',
                    { className: 'dsh-mc-event-subId' },
                    [
                      row.subscription_id || '',
                      t('stats', {
                        received: row.received ?? 0,
                        delivered: row.delivered ?? 0,
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  ),
                );
              }),
        ),
      );
    }

    return {
      name: 'mc-event',
      inject: ['slots', 'locale'],
      apply: function (ctx) {
        lang = detectLang(ctx);
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
            SessionDock,
          );
        });

        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'mc-event',
              order: 95,
              label: function () {
                return translate('sectionLabel');
              },
              locale: NS,
            },
            SettingsSection,
          );
        });
      },
    };
  },
});
