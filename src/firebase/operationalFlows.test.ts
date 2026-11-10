import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexActivityAdvances } from '../dashboard/advanceIndex';
import { fieldReport } from '../dashboard/fieldReport';
import { escapeCsvCell } from '../dashboard/csvExport';
import { ambiguousActivityCodes, barnActivities, findAdvanceActivity, ganttPlannedActivities } from './advanceActivity';
import { computeMaterialUsedQty } from './materialConsumption';
import { parseMovementTable, readMovementFile } from './movementImport';
import { assertSafeSectorRebase, enqueueOfflineOperation, evaluateActivityProgress, mergeSectorDeepWithConflicts,
  reconstructAttendanceWithOfflineQueue, reconstructCollectionWithOfflineQueue, reconstructSectorsWithOfflineQueue,
  partitionQueueByUserIdentity, sameOperationalScope, type PendingSyncOperation } from './offlineSyncEngine';

test('la cola histórica conserva su UID y rol y pone en cuarentena los autores sin identidad', () => {
  const legacy = 'calera_scope_v1:' + JSON.stringify(['author', 'Supervisor', 'P1', [], ['A'], ['B']]);
  const current = 'calera_scope_v2:' + JSON.stringify(['author', 'Supervisor']);
  assert.equal(sameOperationalScope(legacy, current), true);
  assert.equal(sameOperationalScope(legacy, 'calera_scope_v2:' + JSON.stringify(['other', 'Supervisor'])), false);
  assert.equal(sameOperationalScope(legacy, 'calera_scope_v2:' + JSON.stringify(['author', 'Almacén'])), false);
  const queue = ['author', 'other', '', 'local_user', 'system', '   ', ' author'].map((userId, index) => ({
    userId, scopeKey: legacy, operationId: String(index), collectionName: 'advances', status: 'pending_sync'
  }) as PendingSyncOperation);
  assert.deepEqual(partitionQueueByUserIdentity(queue, 'author').ownPendingOps, [queue[0]]);
  assert.deepEqual(partitionQueueByUserIdentity(queue, 'local_user').ownPendingOps, []);
  assert.deepEqual(partitionQueueByUserIdentity(queue, 'system').ownPendingOps, []);
});
import { invalidWorkerField, normalizeWorkerCode, workerForDisplay } from './workerData';

test('recargar usa el sector confirmado frente a retiros nuevos y heredados rechazados', () => {
  const barn = { id: 'barn', areas: [{ id: 'area', structures: [{ id: 'structure', activities: [{ id: 'activity' }] }] }] };
  const remote = { id: 'sector', name: 'Nombre confirmado', _revision: 2, galpones: [barn] };
  const intent = { operationId: 'queued', collectionName: 'sectors', operationType: 'upsert', documentId: remote.id,
    galponId: barn.id, activityId: 'activity', status: 'sync_error', errorCode: 'STALE_DATA_VERSION', expectedRevision: 1 } as PendingSyncOperation;
  const legacy = { ...intent, payload: { ...remote, name: 'Nombre anterior', galpones: [{ ...barn, ganttExcludedActivityIds: ['activity'] }] } };
  for (const queued of [legacy, { ...intent, ganttWithdrawal: true as const }, { ...legacy, status: 'pending_sync' as const }]) {
    const [visible] = reconstructSectorsWithOfflineQueue([remote], [queued]);
    assert.equal(visible.name, remote.name);
    assert.equal(visible.galpones[0].ganttExcludedActivityIds, undefined);
  }
});

test('Personal comparte la normalización de códigos y degrada valores heredados a texto seguro', () => {
  const legacy = { id: 'worker', name: 'Legado', workerCode: { raw: true }, dni: ['1'], active: 'false' };
  assert.equal(invalidWorkerField(legacy), 'workerCode');
  assert.equal(invalidWorkerField({ name: 'Válido', dni: null }), 'dni');
  const view = workerForDisplay(legacy);
  assert.equal(view.workerCode, '');
  assert.equal(view.dni, '');
  assert.equal(view.active, true);
  assert.deepEqual(legacy.workerCode, { raw: true });
  assert.equal(normalizeWorkerCode('  Dup-01  '), 'DUP-01');
});

test('Personal muestra los lotes pendientes o rechazados en la cola sin publicarlos en la planilla', () => {
  const worker = { id: 'confirmed', name: 'Operario confirmado' };
  const queued = { collectionName: 'workers', operationType: 'upsert', documentId: 'imported', writeGroupId: 'batch',
    payload: { id: 'imported', name: 'Fila local' }, status: 'pending_sync' } as PendingSyncOperation;
  for (const status of ['pending_sync', 'sync_error'] as const) {
    assert.deepEqual(reconstructCollectionWithOfflineQueue([worker], [{ ...queued, status }], 'workers').map(row => row.id), ['confirmed']);
  }
});

test('el rebase conserva retiros simultáneos del plan y las actividades de ambos galpones', () => {
  const activities = [{ id: 'a' }, { id: 'b' }];
  const barn = { id: 'barn', areas: [{ id: 'area', structures: [{ id: 'structure', activities }] }] };
  const base = { id: 'sector', galpones: [barn, { ...barn, id: 'other' }] };
  const changed = (id: string) => ({ ...base, galpones: [{ ...barn, ganttExcludedActivityIds: [id] }, base.galpones[1]] });
  const remote = { ...changed('b'), _revision: 1 };
  assert.doesNotThrow(() => assertSafeSectorRebase(base, remote, 0));
  const { mergedSector, conflicts } = mergeSectorDeepWithConflicts(changed('a'), remote, { baseSector: base });
  assert.deepEqual(conflicts, []);
  const [mergedBarn, other] = mergedSector.galpones;
  assert.deepEqual(barnActivities(mergedBarn), activities);
  assert.deepEqual(ganttPlannedActivities(barnActivities(mergedBarn), mergedBarn.ganttExcludedActivityIds), []);
  assert.deepEqual(ganttPlannedActivities(barnActivities(other), other.ganttExcludedActivityIds), activities);
});

test('el progreso oficial usa el último porcentaje confirmado de la actividad y del galpón correctos', () => {
  const part = (id: string, date: string, percentageReached: number, extra: object = {}) => ({
    id, activityId: 'a', activityCode: 'COD', galponId: 'main', date, percentageReached, ...extra
  });
  const logs = indexActivityAdvances([
    part('one', '2026-11-01', 30), part('two', '2026-11-02', 50),
    part('pending', '2026-11-03', 80, { syncState: 'pending_sync' }),
    part('conflict', '2026-11-04', 90, { conflictStatus: 'conflict' }),
    part('other-activity', '2026-11-05', 100, { activityId: 'b' }),
    part('other-barn', '2026-11-06', 100, { galponId: 'other' }),
    part('legacy', '2026-10-30', 15, { activityId: undefined })
  ]);
  const official = evaluateActivityProgress({ progressMode: 'percentage' }, logs('main', 'a', 'COD'), '2026-11-08');
  assert.equal(official.progressPercent, 50);
  assert.equal(official.validLogsCount, 3);
  assert.equal(official.conflictedLogsCount, 1);
});

test('el informe cruza proyecto y actividad con asistencia, personal e inventario del mismo galpón', () => {
  const sectors = [{ id: 'S1', name: 'Sector 1', galpones: [
    { id: 'B1', code: '01', projectCode: 'P1' }, { id: 'B2', code: '02', projectCode: 'P2' }
  ] }];
  const rows = fieldReport(sectors, [{ galponId: 'B1' }], [
    { galponId: 'B1', usedQty: 10, totalQty: 10 },
    { galponId: 'B1', sectorId: 'S2', usedQty: 0, totalQty: 20 }
  ], [{ id: 'A', galponId: 'B1' }, { id: 'B', galponId: 'B2' }], { A: 'Asistió', B: 'Falta' },
  { project: 'P1', sector: 'S1', galpon: 'ALL', activityFiltered: true });
  assert.deepEqual(rows, [{
    id: 'B1', project: 'P1', sector: 'Sector 1', galpon: '01', activities: 1, personnel: 1,
    present: 1, registered: 1, materials: 1, outOfStock: 1
  }]);
});

test('el material del galpón secundario suma consumo válido y omite conflictos', () => {
  const material = { id: 'secondary', code: 'X', galponId: 'second', initialUsedQty: 1 };
  const records = [
    { galponId: 'first', materialsUsedToday: [{ code: 'X', qty: 12 }] },
    { galponId: 'second', materialsUsedToday: [{ materialId: 'secondary', qty: 4 }, { code: 'X', qty: 2 }] },
    { galponId: 'second', conflictStatus: 'conflict', materialsUsedToday: [{ materialId: 'secondary', qty: 15 }] }
  ];
  assert.equal(computeMaterialUsedQty(material, records), 7);
});

test('importación histórica genera ID estable y valida encabezados, fecha y duplicados', async () => {
  const header = ['Fecha y Hora', 'Módulo', 'Tipo de Movimiento', 'Detalle del Movimiento', 'Usuario'];
  const row = ['08/11/2026, 11:32:10', 'Control de Materiales', 'REGISTRO', 'Inventario inicial', 'Operario anterior'];
  const [entry] = await parseMovementTable([header, row]);
  assert.equal(entry.timestamp, '2026-11-08T16:32:10.000Z');
  assert.match(entry.sourceId, /^[a-f0-9]{64}$/);
  assert.equal((await parseMovementTable([header, [entry.timestamp, ...row.slice(1)]]))[0].sourceId, entry.sourceId);
  await assert.rejects(parseMovementTable([header, row, row]), /duplicados/);
  await assert.rejects(parseMovementTable([header, ['31\/02\/2026, 11:32:10', ...row.slice(1)]]), /fila 2/);
  await assert.rejects(parseMovementTable([['Módulo'], ['Control de Materiales']]), /encabezados/);
});

test('la bitácora importa CSV UTF-8 sin BOM preservando acentos y zona horaria', async () => {
  const source = [
    'ID,timestamp,module,type,detail',
    'original,2026-11-09T09:00:00-05:00,Control de Materiales,MODIFICACIÓN,Corrección de inventario'
  ].join('\n');
  const [item] = await readMovementFile(new File([source], 'historial.csv'));
  assert.deepEqual(item, { sourceId: 'original', timestamp: '2026-11-09T14:00:00.000Z',
    module: 'Control de Materiales', type: 'MODIFICACIÓN', detail: 'Corrección de inventario' });
});

test('la cola conserva un envío anterior ambiguo y una nueva edición del mismo documento', () => {
  const input = { collectionName: 'materials', documentId: 'mat-1', operationType: 'upsert',
    userId: 'author', userDisplayName: 'Operario', userRole: 'Almacén', status: 'sync_error',
    scopeKey: 'author:scope', requestId: 'previous', payload: { totalQty: 15 } } as const;
  const pending = enqueueOfflineOperation([], input);
  const edits = enqueueOfflineOperation(pending, { ...input, requestId: 'new', payload: { totalQty: 17 } });
  assert.deepEqual(edits.map(item => [item.requestId, item.payload.totalQty]), [['previous', 15], ['new', 17]]);
  assert.equal(enqueueOfflineOperation(edits, input).length, 2);
});

test('el rebase permite cambios de cronograma y retiene cambios simultáneos de estructura', () => {
  const base = { id: 's', name: 'Inicial', _revision: 1,
    galpones: [{ id: 'b', areas: [{ id: 'a', structures: [{ id: 'st', activities: [{ id: 'act', startDate: '2026-11-01' }] }] }] }] };
  const schedule = structuredClone(base);
  schedule._revision++;
  schedule.galpones[0].areas[0].structures[0].activities[0].startDate = '2026-11-02';
  assert.doesNotThrow(() => assertSafeSectorRebase(base, schedule, 1));
  const changed = { ...schedule, name: 'Renombrado' };
  assert.throws(() => assertSafeSectorRebase(base, changed, 1), /cambiaron en otra sesión/);
  assert.throws(() => assertSafeSectorRebase(undefined, changed, 1), /cambiaron en otra sesión/);
});

test('los códigos repetidos requieren UID y no duplican avances históricos sin identidad', () => {
  const activities = [{ id: 'a', code: 'SAME' }, { id: 'b', code: 'SAME' }];
  assert.equal(findAdvanceActivity(activities, undefined, 'SAME'), undefined);
  assert.equal(findAdvanceActivity(activities, 'b', 'SAME'), activities[1]);
  assert.equal(findAdvanceActivity(activities, 'missing', 'SAME'), undefined);
  const logs = indexActivityAdvances([
    { galponId: 'barn', activityCode: 'SAME', quantityToday: 14 },
    { galponId: 'barn', activityCode: 'SAME', activityId: 'b', quantityToday: 7 }
  ], new Map([['barn', ambiguousActivityCodes(activities)]]));
  assert.deepEqual(logs('barn', 'a', 'SAME'), []);
  assert.deepEqual(logs('barn', 'b', 'SAME').map(part => part.quantityToday), [7]);
});

test('una edición de asistencia rechazada conserva el registro vigente y permite comparar el intento', () => {
  const day = '2031-06-01';
  const queued = enqueueOfflineOperation([], {
    userId: 'actor', userDisplayName: 'Operario sintético', userRole: 'Supervisor',
    collectionName: 'attendance', documentId: day, operationType: 'upsert', requestId: 'same-worker',
    payload: { date: day, records: { worker: 'Falta' } }, expectedRecords: { worker: 'Asistió' },
    errorCode: 'ATTENDANCE_CONFLICT', status: 'sync_error'
  });
  assert.equal(reconstructAttendanceWithOfflineQueue({ [day]: { worker: 'Permiso' } }, queued)[day].worker, 'Permiso');
  assert.equal(queued[0].payload.records.worker, 'Falta');
});

test('los CSV escapan fórmulas como texto y mantienen los importes numéricos y las comillas', () => {
  assert.equal(escapeCsvCell(' =HYPERLINK("example.test")'), `"' =HYPERLINK(""example.test"")"`);
  assert.equal(escapeCsvCell('\t@SUM(1)'), `"'\t@SUM(1)"`);
  assert.equal(escapeCsvCell(-12.5), '"-12.5"');
  assert.equal(escapeCsvCell('texto, "lima"'), '"texto, ""lima"""');
});
