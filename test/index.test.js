/**
 * dsh-mc-event 的离线测试：用假 Context 和真实 localhost HTTP 验证
 * 订阅、过滤、合并、running 时的 steer 投递、冷启动投递、停止/过期/端口冲突。
 *
 *   node --test test/index.test.js
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, applyUi } from '../index.js';

/** 测试专用 DSH_HOME，避免读写真实用户的 mc-event.json。 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-mc-event-test-'));
process.env.DSH_HOME = TEST_HOME;

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

/**
 * 构造一个只提供本插件所需能力的假 Context。
 * @param {object} options - agent、resolveAgent 与 config。
 * @returns {object} 已注册的工具、投递记录与清理函数。
 */
function fakeContext(options = {}) {
  const tools = new Map();
  const followed = [];
  const steered = [];
  const flushed = [];
  const effects = [];
  const listeners = new Map();
  const agents = new Map();
  const routes = new Map();

  if (options.agent !== undefined) {
    const spec = options.agent;
    agents.set(spec.id, {
      id: spec.id,
      session: { id: spec.id },
      status: spec.status ?? 'idle',
      followup(message) {
        followed.push(message);
      },
      steer(message) {
        steered.push(message);
      },
    });
  }

  const webServer =
    options.webServer ??
    (options.withWebServer === true
      ? {
          register(route) {
            if (routes.has(route.path)) {
              throw new Error(`duplicate route: ${route.path}`);
            }
            routes.set(route.path, route.handler);
            return () => {
              routes.delete(route.path);
            };
          },
        }
      : undefined);

  const ctx = {
    webServer,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => {};
      },
    },
    agents: {
      get(id) {
        return agents.get(id);
      },
      list() {
        return [...agents.values()];
      },
    },
    sessionController: {
      async resolveAgent(sessionId) {
        if (options.resolveAgent !== undefined) return options.resolveAgent(sessionId);
        const agent = agents.get(sessionId);
        if (agent !== undefined) return { agent };
        return { error: { message: 'session is not resumable' } };
      },
    },
    sessions: {
      async flush(session) {
        flushed.push(session);
        return true;
      },
      get(sessionId) {
        if (options.sessions !== undefined) return options.sessions[sessionId];
        return agents.has(sessionId) ? { id: sessionId } : undefined;
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    effect(callback) {
      effects.push(callback());
    },
    inject(names, callback) {
      const available = names.every((name) => ctx.get(name) !== undefined);
      if (available) callback(ctx);
      return () => {};
    },
    get(name) {
      if (name === 'agents') return ctx.agents;
      if (name === 'sessions') return ctx.sessions;
      if (name === 'webServer') return ctx.webServer;
      if (name === 'sessionTitle') {
        if (options.sessionTitle === undefined) return undefined;
        return {
          get(session) {
            return options.sessionTitle(session);
          },
        };
      }
      return undefined;
    },
    logger: { info() {}, warn() {}, debug() {} },
  };

  apply(ctx, options.config ?? {});

  return {
    tool: tools.get('subscribe_mc_event'),
    catalogTool: tools.get('get_mc_event_types'),
    tools,
    followed,
    steered,
    flushed,
    listeners,
    agents,
    routes,
    webServer,
    dispose() {
      while (effects.length > 0) effects.pop()();
    },
  };
}

/**
 * 把假 webServer 注册的处理器挂到一个真实的 localhost HTTP 服务上。
 * @param {Map<string, Function>} routes - 路径 → 处理器。
 * @returns {Promise<{ base: string, close: () => Promise<void> }>} 服务地址与关闭函数。
 */
async function startRouteServer(routes) {
  const server = createHttpServer((request, response) => {
    const handler = routes.get('/api/dsh-mc-event/listener');
    if (handler === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 默认调用会话。 */
const exec = { agent: { id: 'session-1' }, signal: new AbortController().signal };

/**
 * 等待一个条件成立。
 * @param {() => boolean} predicate - 条件。
 * @param {number} timeoutMs - 最长等待毫秒数。
 * @returns {Promise<void>} 成立时 resolve。
 */
async function eventually(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 等待一个异步条件成立。
 * @param {() => Promise<boolean>} predicate - 条件。
 * @param {number} timeoutMs - 最长等待毫秒数。
 * @returns {Promise<void>} 成立时 resolve。
 */
async function eventuallyAsync(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * 向订阅端点 POST 一个 JSON 值。
 * @param {string} endpoint - 订阅返回的地址。
 * @param {unknown} value - 事件或原始字符串。
 * @returns {Promise<Response>} 响应。
 */
function post(endpoint, value) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
}

/**
 * 等待某个端口确认拒绝连接。
 * @param {string} endpoint - 目标地址。
 * @returns {Promise<void>} 端口已关闭时 resolve。
 */
async function expectRefused(endpoint) {
  await eventuallyAsync(async () => {
    try {
      await fetch(endpoint, { method: 'POST', body: '{"type":"chat"}' });
      return false;
    } catch {
      return true;
    }
  });
}

test('start 后单条事件作为新 user 消息投递，并调用 flush', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute({ action: 'start' }, exec);
    assert.equal(started.status, 'subscribed');
    assert.match(started.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(started.subscription_id.startsWith('mc-'));

    const response = await post(started.endpoint, {
      type: 'player_hurt',
      time: 206199,
      position: { x: 2.5, y: 134, z: 6.5 },
      data: { health_lost: 4 },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: 1 });

    await eventually(() => ctx.followed.length === 1);
    const message = ctx.followed[0];
    assert.equal(message.role, 'user');
    assert.deepEqual(message.source, { kind: 'mc-event' });
    const text = message.content[0].text;
    assert.match(text, /player_hurt/);
    assert.match(text, /"health_lost":4/);
    assert.match(text, /untrusted in-game data/);
    assert.ok(
      text.includes(
        `Subscription ${started.subscription_id} is still listening; stop it when you no longer need events.`,
      ),
    );
    assert.doesNotMatch(text, /127\.0\.0\.1:\d+/);
    assert.equal(ctx.flushed.length, 1);

    const status = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(status.status, 'active');
    assert.equal(status.delivered, 1);
    assert.equal(status.pending, 0);
  } finally {
    await ctx.tool.execute({ action: 'stop' }, exec).catch(() => {});
    ctx.dispose();
  }
});

test('event_types 过滤只投递匹配事件', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute(
      { action: 'start', event_types: ['player_hurt'] },
      exec,
    );
    assert.deepEqual(started.event_types, ['player_hurt']);

    const chat = await post(started.endpoint, { type: 'chat', data: { message: 'hello' } });
    assert.deepEqual(await chat.json(), { ok: true, accepted: 0 });
    await post(started.endpoint, { type: 'player_hurt', data: { health_lost: 1 } });

    await eventually(() => ctx.followed.length === 1);
    const text = ctx.followed[0].content[0].text;
    assert.match(text, /player_hurt/);
    assert.doesNotMatch(text, /hello/);
    const status = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(status.received, 1);
  } finally {
    await ctx.tool.execute({ action: 'stop' }, exec).catch(() => {});
    ctx.dispose();
  }
});

test('同一窗口内的事件合并成一条消息', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 40 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute({ action: 'start' }, exec);
    const responses = await Promise.all([
      post(started.endpoint, { type: 'item_pickup', data: { item: 'minecraft:stone', count: 7 } }),
      post(started.endpoint, { type: 'item_pickup', data: { item: 'minecraft:dirt', count: 2 } }),
      post(started.endpoint, { type: 'chat', data: { message: 'hi' } }),
    ]);
    for (const response of responses) assert.equal(response.status, 200);

    await eventually(() => ctx.followed.length === 1);
    assert.match(ctx.followed[0].content[0].text, /\(3 event\(s\)\)/);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(ctx.followed.length, 1);
  } finally {
    await ctx.tool.execute({ action: 'stop' }, exec).catch(() => {});
    ctx.dispose();
  }
});

test('Agent running 时用 steer 插到下一步，idle 时用 followup 新起回合', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'running' },
  });
  try {
    const started = await ctx.tool.execute({ action: 'start' }, exec);
    await post(started.endpoint, { type: 'chat', data: { message: 'while busy' } });

    await eventually(() => ctx.steered.length === 1);
    assert.equal(ctx.followed.length, 0);
    assert.match(ctx.steered[0].content[0].text, /while busy/);

    const agent = ctx.agents.get('session-1');
    agent.status = 'idle';
    await post(started.endpoint, { type: 'chat', data: { message: 'after idle' } });
    await eventually(() => ctx.followed.length === 1);
    assert.match(ctx.followed[0].content[0].text, /after idle/);
    assert.equal(ctx.steered.length, 1);
  } finally {
    await ctx.tool.execute({ action: 'stop' }, exec).catch(() => {});
    ctx.dispose();
  }
});

test('没有 live Agent 时通过 resolveAgent 冷启动投递', async () => {
  const delivered = [];
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    resolveAgent: async (sessionId) => ({
      agent: {
        id: sessionId,
        session: { id: sessionId },
        status: 'idle',
        followup(message) {
          delivered.push(message);
        },
      },
    }),
  });
  try {
    const started = await ctx.tool.execute({ action: 'start' }, exec);
    await post(started.endpoint, { type: 'player_death', data: { message: 'Steve died' } });
    await eventually(() => delivered.length === 1);
    assert.match(delivered[0].content[0].text, /player_death/);
  } finally {
    await ctx.tool.execute({ action: 'stop' }, exec).catch(() => {});
    ctx.dispose();
  }
});

test('stop 返回统计并关闭监听端口', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute({ action: 'start' }, exec);
    await post(started.endpoint, { type: 'item_pickup', data: { item: 'minecraft:stone', count: 1 } });
    await eventually(() => ctx.followed.length === 1);
    const stopped = await ctx.tool.execute({ action: 'stop' }, exec);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.delivered, 1);
    assert.equal(stopped.listening, false);

    await expectRefused(started.endpoint);
    const status = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(status.status, 'inactive');
    assert.equal(status.listening, false);
  } finally {
    ctx.dispose();
  }
});

test('重复 start 返回 already_subscribed 且配置不变', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const first = await ctx.tool.execute(
      { action: 'start', event_types: ['chat'] },
      exec,
    );
    const second = await ctx.tool.execute(
      { action: 'start', event_types: ['player_hurt'] },
      exec,
    );
    assert.equal(second.status, 'already_subscribed');
    assert.equal(second.subscription_id, first.subscription_id);
    assert.deepEqual(second.event_types, ['chat']);
  } finally {
    await ctx.tool.execute({ action: 'stop' }, exec).catch(() => {});
    ctx.dispose();
  }
});

test('非 JSON 请求体作为 raw 事件透传', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute({ action: 'start' }, exec);
    const response = await post(started.endpoint, 'not-json-at-all');
    assert.equal(response.status, 200);
    await eventually(() => ctx.followed.length === 1);
    assert.match(ctx.followed[0].content[0].text, /"type":"raw"/);
    assert.match(ctx.followed[0].content[0].text, /not-json-at-all/);
  } finally {
    await ctx.tool.execute({ action: 'stop' }, exec).catch(() => {});
    ctx.dispose();
  }
});

test('请求体超过 maxBodyBytes 时返回 413 且不投递', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10, maxBodyBytes: 1024 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute({ action: 'start' }, exec);
    const huge = 'x'.repeat(2048);
    const response = await post(started.endpoint, huge);
    assert.equal(response.status, 413);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(ctx.followed.length, 0);
  } finally {
    await ctx.tool.execute({ action: 'stop' }, exec).catch(() => {});
    ctx.dispose();
  }
});

test('max_events 达到上限后自动结束并通知', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute({ action: 'start', max_events: 2 }, exec);
    await post(started.endpoint, { type: 'chat', data: { message: 'one' } });
    await post(started.endpoint, { type: 'chat', data: { message: 'two' } });

    await eventually(
      () => ctx.followed.some((message) => /has ended \(max-events\)/.test(message.content[0].text)),
    );
    const status = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(status.status, 'inactive');
    assert.equal(status.listening, false);
    await expectRefused(started.endpoint);
  } finally {
    ctx.dispose();
  }
});

test('duration_seconds 到期后自动结束并通知', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute(
      { action: 'start', duration_seconds: 1 },
      exec,
    );
    assert.ok(started.expires_at);
    await eventually(
      () => ctx.followed.some((message) => /has ended \(expired\)/.test(message.content[0].text)),
      3_000,
    );
    const status = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(status.status, 'inactive');
    await expectRefused(started.endpoint);
  } finally {
    ctx.dispose();
  }
});

test('端口被占用时 start 报可读错误且不留订阅', async () => {
  const blocker = createNetServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const ctx = fakeContext({
    config: { port, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    await assert.rejects(
      ctx.tool.execute({ action: 'start' }, exec),
      /cannot listen|EADDRINUSE|address already in use/i,
    );
    const status = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(status.status, 'inactive');
    assert.equal(status.listening, false);
  } finally {
    ctx.dispose();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('agent/disposed 清理订阅并关闭监听', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute({ action: 'start' }, exec);
    for (const listener of ctx.listeners.get('agent/disposed') ?? []) {
      listener({ agent: { id: 'session-1' } });
    }
    const status = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(status.status, 'inactive');
    await expectRefused(started.endpoint);
  } finally {
    ctx.dispose();
  }
});

test('同一订阅可以分两次、在独立窗口内投递两条事件', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    const started = await ctx.tool.execute({ action: 'start' }, exec);

    await post(started.endpoint, { type: 'item_pickup', data: { item: 'minecraft:stone', count: 1 } });
    await eventually(() => ctx.followed.length === 1);

    await post(started.endpoint, { type: 'player_death', data: { message: 'Steve died' } });
    await eventually(() => ctx.followed.length === 2);

    assert.match(ctx.followed[0].content[0].text, /item_pickup/);
    assert.doesNotMatch(ctx.followed[0].content[0].text, /player_death/);
    assert.match(ctx.followed[1].content[0].text, /player_death/);
    assert.doesNotMatch(ctx.followed[1].content[0].text, /item_pickup/);

    const status = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(status.received, 2);
    assert.equal(status.delivered, 2);
    assert.equal(status.pending, 0);
  } finally {
    await ctx.tool.execute({ action: 'stop' }, exec).catch(() => {});
    ctx.dispose();
  }
});

test('两个 preset 实例共用同一个监听器', async () => {
  const mc = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-mc', status: 'idle' },
  });
  const mcPlus = fakeContext({
    config: { port: 0, batchWindowMs: 10 },
    agent: { id: 'session-mc-plus', status: 'idle' },
  });
  const execMc = { agent: { id: 'session-mc' }, signal: new AbortController().signal };
  const execMcPlus = { agent: { id: 'session-mc-plus' }, signal: new AbortController().signal };
  try {
    const startedMc = await mc.tool.execute({ action: 'start' }, execMc);
    const startedMcPlus = await mcPlus.tool.execute({ action: 'start' }, execMcPlus);
    assert.equal(startedMcPlus.endpoint, startedMc.endpoint);

    await post(startedMc.endpoint, { type: 'chat', data: { message: 'shared listener' } });
    await eventually(() => mc.followed.length === 1 && mcPlus.followed.length === 1);
    assert.match(mc.followed[0].content[0].text, /shared listener/);
    assert.match(mcPlus.followed[0].content[0].text, /shared listener/);

    const stoppedMc = await mc.tool.execute({ action: 'stop' }, execMc);
    assert.equal(stoppedMc.listening, true);
    const health = await fetch(new URL('health', startedMc.endpoint));
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.subscriptions, 1);
    assert.equal(healthBody.instances, 2);

    const stoppedMcPlus = await mcPlus.tool.execute({ action: 'stop' }, execMcPlus);
    assert.equal(stoppedMcPlus.listening, false);
    await expectRefused(startedMc.endpoint);
  } finally {
    mc.dispose();
    mcPlus.dispose();
  }
});

test('主包是普通 preset 依赖，UI 由独立裸包承载', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, '@local/dsh-mc-event');
  assert.equal(manifest.dsh, undefined);
  assert.equal(manifest.exports['./client'], undefined);
  assert.equal(manifest.exports['./ui'], undefined);
  assert.equal(manifest.peerDependencies, undefined);

  const uiManifest = JSON.parse(
    readFileSync(new URL('../ui/package.json', import.meta.url), 'utf8'),
  );
  assert.equal(uiManifest.name, '@local/dsh-mc-event-ui');
  assert.equal(uiManifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(uiManifest.dsh.client.platform, 'web');
  assert.equal(uiManifest.exports['./client'], './client.js');
  assert.ok(uiManifest.files.includes('client.js'));
  assert.ok(uiManifest.files.includes('cordis.patch.yml'));

  const client = readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
  const loadId = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/);
  assert.equal(loadId?.[1], uiManifest.name);
});

test('全局 UI 入口只注册状态路由，不注册模型工具', () => {
  const tools = [];
  const routes = new Map();
  const cleanups = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => {
          routes.delete(route.path);
        };
      },
    },
    tools: {
      register() {
        tools.push('registered');
        return () => {};
      },
    },
    effect(callback) {
      cleanups.push(callback());
    },
    inject(names, callback) {
      callback(ctx);
    },
    get(name) {
      return name === 'webServer' ? ctx.webServer : undefined;
    },
    logger: { info() {}, warn() {} },
  };
  applyUi(ctx);
  assert.deepEqual(tools, []);
  assert.equal(routes.size, 1);
  assert.ok(routes.has('/api/dsh-mc-event/listener'));
  while (cleanups.length > 0) cleanups.pop()();
  assert.equal(routes.size, 0);
});

test('非法配置在 apply 时抛错', () => {
  assert.throws(() => fakeContext({ config: { port: 70_000 } }), /port/);
  assert.throws(() => fakeContext({ config: { batchWindowMs: -1 } }), /batchWindowMs/);
  assert.throws(() => fakeContext({ config: { maxBodyBytes: 10 } }), /maxBodyBytes/);
});

test('工具描述包含已知事件类型与不可信提示', () => {
  const ctx = fakeContext({
    config: { port: 0 },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    assert.match(ctx.tool.description, /player_hurt/);
    assert.match(ctx.tool.description, /player_death/);
    assert.match(ctx.tool.description, /untrusted in-game text/);
    assert.match(ctx.tool.description, /action:"start"/);
    const blocks = ctx.tool.output.render(
      {},
      {
        status: 'subscribed',
        listening: true,
        endpoint: 'http://127.0.0.1:3422/',
        subscription_id: 'mc-12345678',
      },
    );
    assert.equal(blocks.length, 1);
    assert.match(blocks[0].text, /Subscribed to live Minecraft events/);
    assert.match(blocks[0].text, /Do not poll/);
  } finally {
    ctx.dispose();
  }
});

/** README 中记录的事件目录样例。 */
const CATALOG_TEXT = `player_hurt damage_type attacker_type attacker health_before health_after absorption_before absorption_after health_lost absorption_lost damage_taken max_health hits_same_tick
item_pickup item count
chat message
hunger_change from to threshold
baritone_task_end result goal
dimension_change from to
player_death message damage_type attacker attacker_type
player_respawn dimension
`;

test('get_mc_event_types 解析目录并渲染字段', async () => {
  const server = createHttpServer((request, response) => {
    assert.equal(request.url, '/evt/');
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(CATALOG_TEXT);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const catalogUrl = `http://127.0.0.1:${port}/evt/`;
  const ctx = fakeContext({
    config: { port: 0, catalogUrl },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    assert.ok(ctx.catalogTool);
    const result = await ctx.catalogTool.execute({}, exec);
    assert.equal(result.ok, true);
    assert.equal(result.endpoint, catalogUrl);
    assert.equal(result.count, 8);
    assert.deepEqual(
      result.events[0].fields,
      [
        'damage_type',
        'attacker_type',
        'attacker',
        'health_before',
        'health_after',
        'absorption_before',
        'absorption_after',
        'health_lost',
        'absorption_lost',
        'damage_taken',
        'max_health',
        'hits_same_tick',
      ],
    );
    assert.deepEqual(result.events[1], { type: 'item_pickup', fields: ['item', 'count'] });
    const blocks = ctx.catalogTool.output.render({}, result);
    assert.match(blocks[0].text, /Minecraft event types \(8\)/);
    assert.match(blocks[0].text, /player_hurt \(12 field\(s\)\): damage_type/);
    assert.match(blocks[0].text, /data/);
  } finally {
    ctx.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('get_mc_event_types 对非 2xx 给出可读错误', async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const ctx = fakeContext({
    config: { port: 0, catalogUrl: `http://127.0.0.1:${port}/evt/` },
    agent: { id: 'session-1', status: 'idle' },
  });
  try {
    await assert.rejects(ctx.catalogTool.execute({}, exec), /HTTP 500/);
  } finally {
    ctx.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('界面开关暂停投递但不结束订阅，重新开启后继续投递', async () => {
  const ctx = fakeContext({
    config: { port: 0, batchWindowMs: 500 },
    withWebServer: true,
    agent: { id: 'session-1', status: 'idle' },
    sessions: { 'session-1': { id: 'session-1' } },
    sessionTitle: () => ({ title: 'Mining session' }),
  });
  const route = await startRouteServer(ctx.routes);
  try {
    const initial = await fetch(route.base + '/api/dsh-mc-event/listener');
    assert.equal(initial.status, 200);
    const initialState = await initial.json();
    assert.equal(initialState.enabled, true);
    assert.equal(initialState.listening, false);
    assert.deepEqual(initialState.subscriptions, []);

    const started = await ctx.tool.execute({ action: 'start' }, exec);
    const listed = await (await fetch(route.base + '/api/dsh-mc-event/listener')).json();
    assert.equal(listed.subscriptions.length, 1);
    assert.equal(listed.subscriptions[0].session_id, 'session-1');
    assert.equal(listed.subscriptions[0].session_title, 'Mining session');
    assert.equal(listed.subscriptions[0].subscription_id, started.subscription_id);

    // 先进入批量窗口，再关闭开关：待投递缓冲应被丢弃。
    await post(started.endpoint, { type: 'chat', data: { message: 'pending before pause' } });
    const pausedResponse = await fetch(route.base + '/api/dsh-mc-event/listener', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(pausedResponse.status, 200);
    const paused = await pausedResponse.json();
    assert.equal(paused.enabled, false);
    assert.equal(paused.listening, true);
    assert.equal(paused.subscriptions.length, 1);
    assert.equal(JSON.parse(readFileSync(join(TEST_HOME, 'mc-event.json'), 'utf8')).listenerEnabled, false);

    const pausedStatus = await ctx.tool.execute({ action: 'status' }, exec);
    assert.equal(pausedStatus.status, 'active');
    assert.equal(pausedStatus.enabled, false);
    assert.match(pausedStatus.note, /paused/);

    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(ctx.followed.length, 0);

    const dropped = await post(started.endpoint, { type: 'chat', data: { message: 'while paused' } });
    assert.deepEqual(await dropped.json(), { ok: true, accepted: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ctx.followed.length, 0);

    const resumedResponse = await fetch(route.base + '/api/dsh-mc-event/listener', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const resumed = await resumedResponse.json();
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.subscriptions.length, 1);

    await post(started.endpoint, { type: 'chat', data: { message: 'after resume' } });
    await eventually(() => ctx.followed.length === 1);
    assert.match(ctx.followed[0].content[0].text, /after resume/);
    assert.doesNotMatch(ctx.followed[0].content[0].text, /pending before pause|while paused/);

    const clearedResponse = await fetch(
      route.base + '/api/dsh-mc-event/listener?session_id=session-1',
      { method: 'DELETE' },
    );
    assert.equal(clearedResponse.status, 200);
    const cleared = await clearedResponse.json();
    assert.equal(cleared.cleared, 1);
    assert.deepEqual(cleared.subscriptions, []);
    assert.equal(cleared.listening, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ctx.followed.length, 1);
  } finally {
    await fetch(route.base + '/api/dsh-mc-event/listener', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => {});
    await ctx.tool.execute({ action: 'stop' }, exec).catch(() => {});
    await route.close();
    ctx.dispose();
  }
});

test('两个 preset 实例只注册一条界面路由，全部卸载后才释放', () => {
  const routes = new Map();
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`);
      routes.set(route.path, route.handler);
      return () => {
        routes.delete(route.path);
      };
    },
  };
  const first = fakeContext({ config: { port: 0 }, webServer });
  const second = fakeContext({ config: { port: 0 }, webServer });
  assert.equal(routes.size, 1);
  first.dispose();
  assert.equal(routes.size, 1);
  second.dispose();
  assert.equal(routes.size, 0);
});

test('界面路由拒绝非回环请求与非法开关值', async () => {
  const ctx = fakeContext({ config: { port: 0 }, withWebServer: true });
  const route = await startRouteServer(ctx.routes);
  try {
    const invalid = await fetch(route.base + '/api/dsh-mc-event/listener', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'invalid-enabled' });

    const invalidDelete = await fetch(
      route.base + '/api/dsh-mc-event/listener?session_id=',
      { method: 'DELETE' },
    );
    assert.equal(invalidDelete.status, 400);
  } finally {
    await route.close();
    ctx.dispose();
  }
});
