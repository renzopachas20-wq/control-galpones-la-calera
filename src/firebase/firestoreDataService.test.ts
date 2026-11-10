import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeForFirestore,
  providerIdFromName,
  computeCollectionDiff,
  normalizeMovementDocToAuditLog,
  buildMovementDocFromInput
} from './firestoreDataService';
import type { UserProfile } from './authService';

test('sanitizeForFirestore removes undefined fields recursively while preserving valid types', () => {
  const dirty = {
    id: 'adv_1',
    note: 'Avance normal',
    sharedWithGalponId: undefined,
    nested: {
      valid: 123,
      empty: null,
      missing: undefined
    },
    items: [{ a: 1, b: undefined }]
  };

  const clean = sanitizeForFirestore(dirty);
  assert.equal('sharedWithGalponId' in clean, false);
  assert.equal('missing' in clean.nested, false);
  assert.equal(clean.nested.valid, 123);
  assert.equal(clean.nested.empty, null);
  assert.equal('b' in clean.items[0], false);
  assert.equal(clean.items[0].a, 1);
});

test('providerIdFromName generates deterministic Firestore document IDs', () => {
  assert.equal(providerIdFromName('ZUCAMI'), 'prov_ZUCAMI');
  assert.equal(providerIdFromName(' Tecno Avícola 2026 '), 'prov_TECNO_AV_COLA_2026');
});

test('computeCollectionDiff accurately detects upserts and deletes without redundant writes', () => {
  const initialDocs = [
    { id: 'mat_1', name: 'Cemento', usedQty: 10 },
    { id: 'mat_2', name: 'Fierro', usedQty: 5 }
  ];

  const firstDiff = computeCollectionDiff(new Map(), initialDocs);
  assert.equal(firstDiff.upserts.length, 2);
  assert.equal(firstDiff.deletes.length, 0);

  // No changes -> 0 upserts, 0 deletes
  const secondDiff = computeCollectionDiff(firstDiff.nextMap, initialDocs);
  assert.equal(secondDiff.upserts.length, 0);
  assert.equal(secondDiff.deletes.length, 0);

  // Modify mat_1, delete mat_2, add mat_3
  const updatedDocs = [
    { id: 'mat_1', name: 'Cemento', usedQty: 25 },
    { id: 'mat_3', name: 'Arena Gruesa', usedQty: 0 }
  ];
  const thirdDiff = computeCollectionDiff(secondDiff.nextMap, updatedDocs);
  assert.equal(thirdDiff.upserts.length, 2);
  assert.deepEqual(
    thirdDiff.upserts.map((d) => d.id),
    ['mat_1', 'mat_3']
  );
  assert.deepEqual(thirdDiff.deletes, ['mat_2']);
});

test('buildMovementDocFromInput and normalizeMovementDocToAuditLog preserve full audit traceability', () => {
  const mockProfile: UserProfile = {
    uid: 'jcSCn1eJ7Yao4xYeV6J8eZpszLR2',
    email: 'renzopachas20@gmail.com',
    displayName: 'Renzo Pachas',
    dni: '45678912',
    authMethod: 'both',
    role: 'Administrador',
    active: true,
    createdAt: '2026-11-04T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-11-04T00:00:00.000Z',
    updatedBy: 'system'
  };

  const docObj = buildMovementDocFromInput({
    id: 'mov_100',
    timestamp: '2026-11-04 18:30:00',
    action: 'MODIFICACIÓN',
    module: 'Materiales',
    description: 'Actualizó stock de Cemento',
    profile: mockProfile,
    targetId: 'mat_1',
    previousValue: '{"totalQty":100}',
    newValue: '{"totalQty":150}'
  });

  assert.equal(docObj.userId, 'jcSCn1eJ7Yao4xYeV6J8eZpszLR2');
  assert.equal(docObj.userEmail, 'renzopachas20@gmail.com');
  assert.equal(docObj.userRole, 'Administrador');
  assert.equal(docObj.type, 'MODIFICACIÓN');
  assert.equal(docObj.action, 'MODIFICACIÓN');
  assert.equal(docObj.targetId, 'mat_1');

  const normalized = normalizeMovementDocToAuditLog(docObj);
  assert.equal(normalized.action, 'MODIFICACIÓN');
  assert.equal(normalized.description, 'Actualizó stock de Cemento');
  assert.equal(normalized.previousValue, '{"totalQty":100}');
  assert.equal(normalized.newValue, '{"totalQty":150}');
});
