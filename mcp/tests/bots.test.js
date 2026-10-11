import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMDO_TOOLS, TIMDO_ARG_BUILDERS, handleTimdoTool } from '../src/timdo-tools.js';
import { DEFAULT_TIMDO_BIN, runTimdoCli } from '../src/timdo-cli.js';

const BOT_TOOLS = [
  'timdo_list_bots', 'timdo_create_bot', 'timdo_rename_bot', 'timdo_set_bot_role',
  'timdo_issue_bot_token', 'timdo_revoke_bot_token', 'timdo_disable_bot',
];
const byName = Object.fromEntries(TIMDO_TOOLS.map((item) => [item.name, item]));

test('all seven bot-management tools are registered with a builder', () => {
  for (const name of BOT_TOOLS) {
    assert.ok(byName[name], `${name} is registered`);
    assert.ok(TIMDO_ARG_BUILDERS[name], `${name} has a CLI argument builder`);
  }
});

test('bot-management schemas opt in to the configured owner secret without accepting a secret value', () => {
  for (const name of BOT_TOOLS) {
    const schema = byName[name].inputSchema;
    assert.equal(schema.properties.ownerSecret.type, 'boolean', `${name} uses a boolean opt-in`);
    assert.match(schema.properties.ownerSecret.description, /configured owner secret/i);
    assert.ok(schema.properties.asUser, `${name} keeps asUser`);
    assert.ok(!Object.keys(schema.properties).some((key) => /secret.*value|rawsecret/i.test(key)));
  }
  for (const name of ['timdo_create_bot', 'timdo_issue_bot_token']) {
    assert.match(byName[name].description, /one-time/i);
    assert.match(byName[name].description, /cannot be recovered/i);
    assert.match(byName[name].description, /confirm with the user first/i);
  }
  for (const name of ['timdo_rename_bot', 'timdo_set_bot_role', 'timdo_revoke_bot_token', 'timdo_disable_bot']) {
    assert.match(byName[name].description, /confirm with the user first/i);
  }
  for (const name of ['timdo_revoke_bot_token', 'timdo_disable_bot']) {
    assert.match(byName[name].description, /acts immediately/i);
  }
});

test('bot argument builders preserve exact positions, options and dash-leading data', () => {
  const b = TIMDO_ARG_BUILDERS;
  assert.deepEqual(b.timdo_list_bots({ workspace: '--json' }), ['bot', 'list', '--', '--json']);
  assert.deepEqual(b.timdo_create_bot({ workspace: '--workspace', name: '--owner-secret', role: 'viewer', tokenName: '--token-name' }), [
    'bot', 'create', '--role', 'viewer', '--token-name', '--token-name', '--', '--workspace', '--owner-secret',
  ]);
  assert.deepEqual(b.timdo_rename_bot({ workspace: 'Northstar Workshop', bot: 'bot|1234', name: '--json' }), [
    'bot', 'rename', '--', 'Northstar Workshop', 'bot|1234', '--json',
  ]);
  assert.deepEqual(b.timdo_set_bot_role({ workspace: 'Northstar Workshop', bot: 'Forum watcher', role: 'member' }), [
    'bot', 'role', '--', 'Northstar Workshop', 'Forum watcher', 'member',
  ]);
  assert.deepEqual(b.timdo_issue_bot_token({ workspace: 'Northstar Workshop', bot: '--bot', name: '--owner-secret' }), [
    'bot', 'token', '--name', '--owner-secret', '--', 'Northstar Workshop', '--bot',
  ]);
  assert.deepEqual(b.timdo_revoke_bot_token({ workspace: 'Northstar Workshop', bot: 'bot|1234', token: 'tok-123' }), [
    'bot', 'revoke-token', '--yes', '--', 'Northstar Workshop', 'bot|1234', 'tok-123',
  ]);
  assert.deepEqual(b.timdo_disable_bot({ workspace: 'Northstar Workshop', bot: 'bot|1234' }), [
    'bot', 'disable', '--yes', '--', 'Northstar Workshop', 'bot|1234',
  ]);
  assert.throws(() => b.timdo_set_bot_role({ workspace: 'W', bot: 'B', role: 'admin' }), /member or viewer/);
});

test('bot tools forward ownerSecret only after explicit opt-in', async () => {
  const calls = [];
  const fakeRun = async (args, _bin, options) => { calls.push({ args, options }); return []; };
  await handleTimdoTool('timdo_list_bots', { workspace: 'Northstar Workshop' }, fakeRun);
  assert.deepEqual(calls[0].options, {});
  await handleTimdoTool('timdo_list_bots', { workspace: 'Northstar Workshop', ownerSecret: true, asUser: 'robin@example.com' }, fakeRun);
  assert.deepEqual(calls[1].options, { asUser: 'robin@example.com', ownerSecret: true });
  await handleTimdoTool('timdo_list_tasks', { ownerSecret: true, status: 'do' }, fakeRun);
  assert.deepEqual(calls[2].options, {}, 'other tools cannot use the bot-only elevation switch');
});

test('runTimdoCli inserts the explicit switch inside bot management and keeps argv boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timdo-bots-cli-'));
  const fake = join(dir, 'timdo');
  writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n');
  chmodSync(fake, 0o755);
  try {
    const result = await runTimdoCli(['bot', 'create', '--', '--workspace', '--owner-secret'], fake, { ownerSecret: true });
    assert.deepEqual(result.argv, ['--json', '--', 'bot', '--owner-secret', 'create', '--', '--workspace', '--owner-secret']);
    assert.ok(!result.argv.includes('fictional-owner-secret'));
    await assert.rejects(() => runTimdoCli(['whoami'], fake, { ownerSecret: true }), /bot-management commands only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real MCP stdio registration lists bot tools and the owner-secret opt-in', async () => {
  const indexPath = fileURLToPath(new URL('../index.js', import.meta.url));
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent' };
  const child = spawn(process.execPath, [indexPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let buffer = '';
  let stderr = '';
  try {
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP schema response timed out: ${stderr}`)), 10000);
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.id !== undefined) replies.set(message.id, message);
          if (replies.has(1) && replies.has(2)) { clearTimeout(timer); resolve(); }
        }
      });
      child.on('error', reject);
    });
    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bot-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]) child.stdin.write(`${JSON.stringify(message)}\n`);
    await received;
    const tools = new Map(replies.get(2).result.tools.map((item) => [item.name, item]));
    for (const name of BOT_TOOLS) {
      assert.ok(tools.has(name), `${name} appears over MCP stdio`);
      assert.equal(tools.get(name).inputSchema.properties.ownerSecret.type, 'boolean');
    }
  } finally {
    child.kill();
  }
});

test('the default CLI is the repository binary', () => {
  assert.ok(DEFAULT_TIMDO_BIN.endsWith('/bin/timdo'));
});
