/**
 * Priority parsing + routing (phase one): parseOrder / parseEnabledResources /
 * parseEnabledTools degradation, stable ordering, default-profile resolution.
 * Pure node:test against the compiled lib (same style as page.test.mjs).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { parseOrder, parseEnabledResources, parseEnabledTools, orderProfiles, resolveDefaultProfile } =
  await import('../lib/page/priority.js');

const profiles = [
  { id: 'a', modalities: ['video'], blockRealSubmit: false },
  { id: 'b', modalities: ['video', 'image'], blockRealSubmit: false },
  { id: 'c', modalities: ['video'], blockRealSubmit: true },
  { id: 'd', modalities: ['image'], blockRealSubmit: false },
];

test('parseOrder: good JSON array parses; duplicates dedupe; empty/absent is empty without warnings', () => {
  assert.deepEqual(parseOrder('["b","a","b"]'), { order: ['b', 'a'], warnings: [] });
  assert.deepEqual(parseOrder('[]'), { order: [], warnings: [] });
  assert.deepEqual(parseOrder(''), { order: [], warnings: [] });
  assert.deepEqual(parseOrder(undefined), { order: [], warnings: [] });
});

test('parseOrder: corrupt JSON / non-array / non-string elements degrade to empty WITH warnings', () => {
  const bad = parseOrder('{not json');
  assert.deepEqual(bad.order, []);
  assert.ok(bad.warnings.length > 0 && bad.warnings[0].includes('providerOrder'));
  const nonArray = parseOrder('"just a string"');
  assert.deepEqual(nonArray.order, []);
  assert.ok(nonArray.warnings.length > 0);
  const mixed = parseOrder('["a", 3, null, "b"]');
  assert.deepEqual(mixed.order, ['a', 'b']);
  assert.equal(mixed.warnings.length, 2);
});

test('parseEnabledResources: providerId::modelId shape enforced; malformed dropped with warning', () => {
  const ok = parseEnabledResources('["prov1::model-x","prov2::model-y"]');
  assert.deepEqual(ok.resources, ['prov1::model-x', 'prov2::model-y']);
  const bad = parseEnabledResources('["noseparator", "::leading", "trailing::"]');
  assert.deepEqual(bad.resources, []);
  assert.equal(bad.warnings.length, 3);
});

test('parseEnabledTools: unknown tool names dropped, known kept, corrupt degrades', () => {
  const ok = parseEnabledTools('["ffmpeg","blender","notatool"]');
  assert.deepEqual(ok.tools, ['ffmpeg', 'blender']);
  assert.equal(ok.warnings.length, 1);
  assert.deepEqual(parseEnabledTools('oops').tools, []);
  assert.deepEqual(parseEnabledTools('["ffmpeg","ffmpeg"]').tools, ['ffmpeg']);
});

test('orderProfiles: stable sort — listed first in order sequence, unlisted keep existing order', () => {
  const ordered = orderProfiles(profiles, ['d', 'c']);
  assert.deepEqual(ordered.map((p) => p.id), ['d', 'c', 'a', 'b']);
  // Empty order = input order unchanged (back-compat).
  assert.deepEqual(orderProfiles(profiles, []).map((p) => p.id), ['a', 'b', 'c', 'd']);
  // Unknown order ids are ignored.
  assert.deepEqual(orderProfiles(profiles, ['zzz']).map((p) => p.id), ['a', 'b', 'c', 'd']);
});

test('resolveDefaultProfile: order wins, blockRealSubmit skipped, modality filtered', () => {
  // 'c' ranks first for video but is blocked → 'a' wins.
  assert.equal(resolveDefaultProfile(profiles, 'video', ['c', 'a'])?.id, 'a');
  assert.equal(resolveDefaultProfile(profiles, 'video', ['b', 'a'])?.id, 'b');
  assert.equal(resolveDefaultProfile(profiles, 'image', ['d', 'b'])?.id, 'd');
  // No order → first non-blocked profile serving the modality.
  assert.equal(resolveDefaultProfile(profiles, 'video', [])?.id, 'a');
  assert.equal(resolveDefaultProfile(profiles, 'audio', [])?.id, undefined);
});

test('resolveDefaultProfile: ecosystem eligibility gate excludes unsupported profiles', () => {
  const gated = [
    { id: 'gem', modalities: ['image'], blockRealSubmit: false },
    { id: 'bza', modalities: ['image'], blockRealSubmit: false },
  ];
  const eligible = (p) => p.id === 'bza'; // gem is 'other' ecosystem
  // gem ranks first but is gated out → bza is the default.
  assert.equal(resolveDefaultProfile(gated, 'image', ['gem', 'bza'], eligible)?.id, 'bza');
  // Without the gate the old behaviour (first ranked) is preserved.
  assert.equal(resolveDefaultProfile(gated, 'image', ['gem', 'bza'])?.id, 'gem');
});
