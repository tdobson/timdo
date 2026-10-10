import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('../index.js', import.meta.url));

/** Send JSON-RPC messages to the server over stdio and collect replies by id. */
function talk(messages, wantIds, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    // An empty HOME and no TimDo env: startup must not need any credentials.
    const env = { PATH: process.env.PATH, HOME: '/nonexistent' };
    const child = spawn(process.execPath, [INDEX], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map();
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out. stderr: ${stderr}`));
    }, timeoutMs);
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) replies.set(msg.id, msg);
        if (wantIds.every((id) => replies.has(id))) {
          clearTimeout(timer);
          child.kill();
          resolve(replies);
        }
      }
    });
    child.on('error', reject);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
}

test('node mcp/index.js answers initialize and lists the timdo tools', async () => {
  const replies = await talk(
    [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'not_a_timdo_tool', arguments: {} } },
    ],
    [1, 2, 3]
  );

  assert.equal(replies.get(1).result.serverInfo.name, 'timdo');
  const names = replies.get(2).result.tools.map((t) => t.name);
  for (const n of ['timdo_list_tasks', 'timdo_add_task', 'timdo_whoami', 'timdo_share_workspace', 'timdo_add_ref', 'timdo_find_by_ref']) {
    assert.ok(names.includes(n), `${n} is listed`);
  }
  assert.ok(names.every((n) => n.startsWith('timdo_')), 'only timdo tools are listed');

  const unknown = replies.get(3).result;
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown tool: not_a_timdo_tool/);
});
