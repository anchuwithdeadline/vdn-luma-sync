const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/sync-luma-events.js`, 'utf8');
const lumaEvent = {
  api_id: 'evt-example', name: 'New event name', url: 'meetup-example', visibility: 'public',
  start_at: '2026-12-12T12:30:00Z', end_at: '2026-12-12T14:30:00Z',
  geo_address_info: { full_address: 'Public venue' }
};
const discordEvent = {
  id: 'existing-event', name: 'Old event name', status: 1, entity_type: 3,
  description: 'Đăng ký tại: https://lu.ma/meetup-example'
};

async function run({ events = [lumaEvent], existing = [discordEvent], listStatus = 200, updateStatus = 200, listBody } = {}) {
  const writes = [];
  const errors = [];
  const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => structuredClone(body), text: async () => JSON.stringify(body),
    headers: { get: () => 'image/png' }, arrayBuffer: async () => Buffer.from('image')
  });
  const context = {
    URL, Buffer,
    Date: class extends Date { static now() { return Date.parse('2026-11-06T00:00:00Z'); } },
    process: { env: { DISCORD_BOT_TOKEN: 'synthetic-test-token' }, exit: () => { throw new Error(errors.join('\n')); } },
    console: { log() {}, warn() {}, error: (...args) => errors.push(args.map(String).join(' ')) },
    fetch: async (url, options = {}) => {
      if (url.startsWith('https://api.lu.ma/')) return response({ entries: events.map(event => ({ event })) });
      if (url.startsWith('https://images.lumacdn.com/')) return response({});
      if (!url.startsWith('https://discord.com/api/v10/')) throw new Error(`Unexpected URL: ${url}`);
      if (!options.method) return response(listBody === undefined ? existing : listBody, listStatus);
      const body = JSON.parse(options.body);
      writes.push({ url, method: options.method, body });
      if (options.method === 'PATCH') return response({ ...discordEvent, ...body }, updateStatus);
      return response({ id: 'created-event', status: 1, ...body });
    }
  };
  await vm.runInNewContext(source, context, { filename: 'sync-luma-events.js' });
  return writes;
}

test('renamed event updates its existing ID, fields and image without an announcement', async () => {
  const writes = await run({ events: [{ ...lumaEvent, description: 'Updated details', cover_url: 'https://images.lumacdn.com/example.png' }] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.ok(writes[0].url.endsWith('/scheduled-events/existing-event'));
  assert.equal(writes[0].body.name, lumaEvent.name);
  assert.equal(writes[0].body.scheduled_start_time, '2026-12-12T12:30:00.000Z');
  assert.equal(writes[0].body.scheduled_end_time, '2026-12-12T14:30:00.000Z');
  assert.equal(writes[0].body.entity_metadata.location, 'Public venue');
  assert.ok(writes[0].body.description.startsWith('Updated details'));
  assert.ok(writes[0].body.image.startsWith('data:image/png;base64,'));
});

test('matches Markdown luma.com links with a query string and trailing slash', async () => {
  const writes = await run({ existing: [{ ...discordEvent, description: '[Register](https://luma.com/meetup-example/?utm_source=discord)' }] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
});

test('legacy name match gains registration link without creating a duplicate', async () => {
  const writes = await run({ existing: [{ ...discordEvent, name: lumaEvent.name, description: null }] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.ok(writes[0].body.description.includes('https://lu.ma/meetup-example'));
});

test('different Luma URL prevents same-name matching; new event is announced once', async () => {
  const writes = await run({ existing: [{ ...discordEvent, name: lumaEvent.name, description: 'https://lu.ma/different-meetup' }] });
  assert.deepEqual(writes.map(write => write.method), ['POST', 'POST']);
  assert.ok(writes[0].url.endsWith('/scheduled-events'));
  assert.equal(writes[1].body.content, '@everyone');
});

test('long description retains the registration URL for subsequent syncs', async () => {
  const writes = await run({ events: [{ ...lumaEvent, description: 'x'.repeat(2000) }] });
  const description = writes[0].body.description;
  assert.equal(description.length, 1000);
  assert.ok(description.endsWith('Đăng ký tại: https://lu.ma/meetup-example'));
  const second = await run({ existing: [{ ...discordEvent, description }] });
  assert.equal(second[0].method, 'PATCH');
});

test('failed or malformed Discord listing aborts before any write', async () => {
  await assert.rejects(run({ listStatus: 401 }), /Failed to fetch Discord events: 401/);
  await assert.rejects(run({ listBody: {} }), /Invalid Discord event list/);
});

test('ambiguous URL matches abort instead of modifying an arbitrary event', async () => {
  await assert.rejects(run({ existing: [discordEvent, { ...discordEvent, id: 'duplicate' }] }), /Multiple Discord events match/);
});

test('failed update fails the run instead of creating or announcing another event', async () => {
  await assert.rejects(run({ updateStatus: 403 }), /Failed to update Discord event existing-event: 403/);
});

test('active, completed and cancelled entries are not modified', async () => {
  for (const status of [2, 3, 4]) assert.deepEqual(await run({ existing: [{ ...discordEvent, status }] }), []);
});

test('repeated Luma entry creates once and then updates the same new event', async () => {
  const writes = await run({ events: [lumaEvent, lumaEvent], existing: [] });
  assert.deepEqual(writes.map(write => write.method), ['POST', 'POST', 'PATCH']);
  assert.ok(writes[2].url.endsWith('/scheduled-events/created-event'));
});

test('an event without a registration URL cannot create or update anything', async () => {
  await assert.rejects(run({ events: [{ ...lumaEvent, url: null }] }), /missing its registration URL/);
});

test('private, unlisted and unknown visibility events never create or update', async () => {
  for (const visibility of ['private', 'unlisted', undefined, null]) {
    const events = [{ ...lumaEvent, visibility }];
    assert.deepEqual(await run({ events }), []);
    assert.deepEqual(await run({ events, existing: [] }), []);
  }
});

test('past, already-starting and invalid-date events never create or update', async () => {
  for (const start_at of ['2026-11-05T23:59:59Z', '2026-11-06T00:00:00Z', 'invalid', null]) {
    const events = [{ ...lumaEvent, start_at }];
    assert.deepEqual(await run({ events }), []);
    assert.deepEqual(await run({ events, existing: [] }), []);
  }
});

test('mixed calendar syncs only future public entries', async () => {
  const writes = await run({ events: [
    { ...lumaEvent, visibility: 'private', url: 'private-event' },
    { ...lumaEvent, start_at: '2026-11-05T00:00:00Z', url: 'past-event' },
    lumaEvent
  ] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
});
