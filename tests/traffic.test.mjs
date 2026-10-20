import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DISPLAY_INTERVAL_MS, formatTraffic, LIVE_STALE_MS, regionFlag, trafficSnapshot } from '../ui/nodectl/traffic.mjs';

const nodes = [{ uuid: 'one', name: 'HK-WA', region: 'LV', traffic_up: 1024, traffic_down: 2048 }, { uuid: 'two', name: 'US', region: 'US', traffic_up: 256, traffic_down: 512 }];

test('traffic display uses a half-second cadence and correct binary units', () => {
  assert.equal(DISPLAY_INTERVAL_MS, 500);
  assert.equal(formatTraffic(1024), '1 KiB');
  assert.equal(formatTraffic(1024 ** 4), '1 TiB');
  assert.equal(formatTraffic(1024, true), '1 KiB/s');
  assert.equal(formatTraffic(null, true), '—');
  for (const invalid of [-1, NaN, Infinity]) assert.equal(formatTraffic(invalid), '0 B');
});

test('traffic aggregates and sorts real totals without changing original nodes', () => {
  const original = structuredClone(nodes);
  const result = trafficSnapshot(nodes);
  assert.equal(result.up, 1280);
  assert.equal(result.down, 2560);
  assert.equal(result.total, 3840);
  assert.equal(result.rows[0].uuid, 'one');
  assert.equal(result.rows[0].ratio, '2.00');
  assert.equal(result.rows[0].status, 'pending');
  assert.deepEqual(nodes, original);
});

test('live transmit is upload, receive is download and counter resets are not accumulated', () => {
  const samples = new Map([['one', { receivedAt: 1000, offline: false, total_tx_bytes: 10, total_rx_bytes: 20, tx_rate_bps: 12, rx_rate_bps: 34 }]]);
  const row = trafficSnapshot(nodes, samples, null, 1100).rows.find(item => item.uuid === 'one');
  assert.equal(row.up, 10); assert.equal(row.down, 20);
  assert.equal(row.upRate, 12); assert.equal(row.downRate, 34); assert.equal(row.status, 'online');
});

test('offline and stale samples never display an invented live rate', () => {
  for (const sample of [{ receivedAt: 1000, offline: true, tx_rate_bps: 100 }, { receivedAt: 0, offline: false, tx_rate_bps: 100 }]) {
    const row = trafficSnapshot(nodes, new Map([['one', sample]]), null, LIVE_STALE_MS + 1).rows.find(item => item.uuid === 'one');
    assert.equal(row.upRate, null); assert.equal(row.downRate, null);
  }
});

test('daily history stays separate from current cumulative live totals', () => {
  const samples = new Map([['one', { receivedAt: 1000, total_tx_bytes: 100000, total_rx_bytes: 200000, tx_rate_bps: 1, rx_rate_bps: 2 }]]);
  const history = { items: [{ uuid: 'one', traffic_up: 10, traffic_down: 20 }] };
  const result = trafficSnapshot(nodes, samples, history, 1100);
  assert.equal(result.total, 30); assert.equal(result.rows[0].upRate, 1);
  assert.equal(trafficSnapshot(nodes, samples, { items: [] }, 1100).total, 0);
});

test('empty traffic, zero upload and missing or malformed regions stay safe', () => {
  assert.deepEqual(trafficSnapshot([]), { rows: [], up: 0, down: 0, total: 0, maximum: 1 });
  assert.equal(trafficSnapshot([{ uuid: 'empty', traffic_up: 0, traffic_down: 1 }]).rows[0].ratio, '—');
  assert.equal(regionFlag('jp'), '🇯🇵'); assert.equal(regionFlag('LV'), '🇱🇻');
  assert.equal(regionFlag('<img>'), ''); assert.equal(regionFlag(null), '');
});
