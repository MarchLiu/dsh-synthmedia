/**
 * Volatile routing regression (phase one): a providerOrder save arrives via
 * `loader/volatile-update`; the already-registered synthmedia_capabilities
 * tool must expose the fresh priority / effectiveDefault on its NEXT call
 * without a plugin remount or re-registration. Uses a mock plugin context
 * (no DSH host, no network).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply } = await import('../lib/index.js');

function harness(order) {
  const defs = [];
  let onVolatile;
  const ctx = {
    tools: {
      register: (d) => {
        defs.push(d);
        return () => {};
      },
    },
    on: (ev, cb) => {
      if (ev === 'loader/volatile-update') onVolatile = cb;
    },
    get: () => undefined,
    inject: () => {},
  };
  const state = { order };
  apply(ctx, {
    providerOrder: { get: () => state.order },
    dataDir: join(tmpdir(), 'dsh-synthmedia-volatile-test'),
  });
  assert.equal(typeof onVolatile, 'function', 'apply must subscribe to loader/volatile-update');
  const caps = defs.find((d) => d.name === 'synthmedia_capabilities');
  assert.ok(caps, 'capabilities tool must be registered');
  return {
    caps,
    setOrder(value) {
      state.order = value;
      onVolatile([['providerOrder']]);
    },
  };
}

test('volatile providerOrder: the NEXT capabilities result carries fresh priority + effectiveDefault', async () => {
  const h = harness('[]');
  const before = await h.caps.execute({});
  assert.equal(
    before.backends.some((b) => b.priority !== undefined),
    false,
    'empty providerOrder = no ranks (back-compat)',
  );

  h.setOrder('["bza-seedance","zgci-h3"]');
  const after = await h.caps.execute({});
  const priority = Object.fromEntries(
    after.backends.filter((b) => b.priority !== undefined).map((b) => [b.id, b.priority]),
  );
  assert.equal(priority['bza-seedance'], 1);
  assert.equal(priority['zgci-h3'], 2);

  const eff = after.backends.filter((b) => b.effectiveDefault);
  assert.ok(eff.some((b) => b.id === 'bza-seedance'), 'reordered video default follows providerOrder');
  assert.ok(
    eff.every((b) => b.supported === true),
    'effectiveDefault must only ever be a supported ecosystem',
  );
});
