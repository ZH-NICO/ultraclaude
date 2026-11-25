// Token usage read from Claude Code's transcripts: counting, de-duplication, prices, ranges and blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `uc-${name}-`));
process.env.CLAUDE_CONFIG_DIR = tmp('claude');
const { usageReport, costOf, priceFor, blocksOf } = await import('../src/usage.js');

const NOW = Date.parse('2026-11-20T15:00:00');
const H = 3600e3;
const reply = (id, model, minutesAgo, u, extra = {}) => `${JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - minutesAgo * 60e3).toISOString(), cwd: 'C:\\work\\shop', message: { id, model, role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...u } }, ...extra })}\n`;
const write = (rel, ...lines) => {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join(''));
};

test('prices: the models of the price list, cache discounts, and no guessing for unknown models', () => {
  assert.deepEqual(priceFor('claude-opus-5-5'), [4, 20]);
  assert.deepEqual(priceFor('claude-fable-5-2'), [8, 40]);
  assert.deepEqual(priceFor('claude-sonnet-5-5'), [2, 10]);
  assert.deepEqual(priceFor('claude-haiku-5-5'), [0.1, 0.5]);
  assert.deepEqual(priceFor('claude-opus-4-1-20250805'), [15, 75]);
  assert.deepEqual(priceFor('claude-sonnet-4-6'), [3, 15]);
  assert.equal(priceFor('some-other-model'), null);
  const r = { i: 1e6, o: 1e6, cw: 1e6, cw1: 0, cr: 1e6 };
  assert.equal(costOf('claude-opus-5-5', r).toFixed(4), (4 + 20 + 5 + 0.4).toFixed(4), 'cache write 1.25x, cache read 0.1x of the input price');
  assert.equal(costOf('claude-opus-5-5', { ...r, cw1: 1e6 }).toFixed(4), (4 + 20 + 8 + 0.4).toFixed(4), 'the one-hour cache costs 2x');
  assert.equal(costOf('some-other-model', r), null);
});

test('a reply written several times while streaming counts once, subagents count for their chat', async () => {
  const sid = '11111111-aaaa-4aaa-8aaa-111111111111';
  write(`C--work-shop/${sid}.jsonl`,
    JSON.stringify({ type: 'user', cwd: 'C:\\work\\shop', message: { role: 'user', content: 'hi' } }) + '\n',
    reply('msg_1', 'claude-opus-5-5', 50, { input_tokens: 100, output_tokens: 10 }),
    reply('msg_1', 'claude-opus-5-5', 50, { input_tokens: 100, output_tokens: 400, cache_read_input_tokens: 2000 }), // the final copy
    reply('msg_2', 'claude-sonnet-5-5', 30, { input_tokens: 50, output_tokens: 50 }),
    reply('msg_3', '<synthetic>', 20, { output_tokens: 99 }),
    reply('msg_4', 'claude-opus-5-5', 10, {}), // nothing to count
    '{"type":"assistant","truncated');
  write(`C--work-shop/${sid}/subagents/agent-a1.jsonl`, reply('msg_5', 'claude-haiku-5-5', 25, { input_tokens: 1000, output_tokens: 1000 }, { isSidechain: true }));
  write('C--work-other/22222222-bbbb-4bbb-8bbb-222222222222.jsonl',
    reply('msg_1', 'claude-opus-5-5', 50, { input_tokens: 100, output_tokens: 400, cache_read_input_tokens: 2000 }), // the same reply, copied into a forked chat
    reply('msg_6', 'made-up-model-9', 5, { input_tokens: 7, output_tokens: 3 }));

  const u = await usageReport({ range: 'all', now: NOW, fresh: true });
  assert.equal(u.totals.msgs, 4, 'msg_1, msg_2, msg_5 and msg_6, and no synthetic or empty replies');
  assert.equal(u.totals.i, 100 + 50 + 1000 + 7);
  assert.equal(u.totals.o, 400 + 50 + 1000 + 3);
  assert.equal(u.totals.cr, 2000);
  assert.equal(u.totals.tokens, u.totals.i + u.totals.o + u.totals.cw + u.totals.cr);
  assert.equal(u.totals.sessions, 2);
  const byModel = Object.fromEntries(u.models.map((m) => [m.model, m]));
  assert.equal(byModel['claude-opus-5-5'].o, 400);
  assert.equal(byModel['claude-opus-5-5'].cost.toFixed(6), ((100 * 4 + 400 * 20 + 2000 * 0.4) / 1e6).toFixed(6));
  assert.equal(byModel['made-up-model-9'].priced, false);
  assert.equal(u.totals.unpriced, 10, 'tokens of unknown models are not turned into made-up costs');
  const shop = u.projects.find((p) => p.key === 'C--work-shop');
  assert.equal(shop.name, 'shop');
  assert.equal(shop.sessions, 1, 'the helper agent belongs to the chat that started it');
  assert.equal(u.sessions.find((s) => s.id === sid).msgs, 2, 'the copied reply counts for the chat whose file is read first, not twice');
});

test('ranges, days and the five-hour block', async () => {
  const sid = '33333333-cccc-4ccc-8ccc-333333333333';
  write(`C--work-ranges/${sid}.jsonl`,
    reply('r_old', 'claude-opus-5-5', 60 * 24 * 40, { input_tokens: 1000 }),
    reply('r_week', 'claude-opus-5-5', 60 * 24 * 3, { input_tokens: 200 }),
    reply('r_a', 'claude-opus-5-5', 90, { input_tokens: 30 }),
    reply('r_b', 'claude-opus-5-5', 20, { output_tokens: 10 }));
  const range = async (r) => (await usageReport({ range: r, now: NOW, fresh: true })).projects.find((p) => p.key === 'C--work-ranges')?.tokens ?? 0;
  assert.equal(await range('all'), 1240);
  assert.equal(await range('30d'), 240);
  assert.equal(await range('7d'), 240);
  assert.equal(await range('today'), 40);

  const u = await usageReport({ range: '30d', now: NOW, fresh: true });
  assert.equal(u.daily.length >= 182, true);
  assert.equal(u.today.date, '2026-11-20');
  assert.ok(u.streak >= 1);
  assert.equal(u.block.tokens >= 40, true, 'the current block holds the recent replies');
  assert.equal(u.block.end - u.block.start, 5 * H);
  assert.equal(u.limitIsAuto, true);
  const limited = await usageReport({ range: '30d', now: NOW, fresh: true, blockLimit: 123456 });
  assert.equal(limited.limit, 123456);
  assert.equal(limited.limitIsAuto, false);
});

test('blocks start with the first message of a window and end five hours later', () => {
  const rec = (t, n) => ({ t: NOW - t * H, model: 'claude-opus-5-5', i: n, o: 0, cw: 0, cw1: 0, cr: 0 });
  const { blocks, active } = blocksOf([rec(12, 5), rec(11.5, 5), rec(6, 7), rec(1, 1), rec(0.5, 2)], NOW);
  assert.deepEqual(blocks.map((b) => b.tokens), [10, 7, 3]);
  assert.equal(active, blocks[2]);
  assert.equal(blocksOf([rec(9, 5)], NOW).active, null, 'a block that has run out is not active');
  assert.equal(blocksOf([], NOW).active, null);
});
