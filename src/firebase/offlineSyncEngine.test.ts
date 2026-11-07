import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProgressMode,
  evaluateActivityProgress,
  validatePercentageAdvanceRegistration,
  detectMultiUserAdvanceConflict,
  mergeSectorGalponesIsolated,
  mergeSectorDeepWithConflicts,
  recordActivityDeletionTombstone,
  recordGalponDeletionTombstone,
  applyActivityConflictResolutionToSector,
  reconstructCollectionWithOfflineQueue,
  reconstructSectorsWithOfflineQueue,
  reconstructAttendanceWithOfflineQueue,
  reconstructProvidersWithOfflineQueue,
  mergeAttendanceDayIsolated,
  enqueueOfflineOperation,
  evaluateIdempotentAdvanceSync,
  stampOperationSyncMetadata,
  partitionQueueByUserIdentity,
  type PendingSyncOperation
} from './offlineSyncEngine';

describe('ETAPA 3 – Pruebas Obligatorias: Modalidades de Avance, Offline y Multiusuario', () => {
  it('1. Actividad con Avance por Cantidades (comportamiento clásico y por defecto para actividades existentes)', () => {
    const existingActivityWithoutMode = {
      id: 'act_1',
      code: 'CIV-001',
      name: 'Vaciado de Losa',
      targetUnits: 200,
      unit: 'm3',
      startDate: '2026-11-01'
    };

    assert.equal(
      normalizeProgressMode((existingActivityWithoutMode as any).progressMode),
      'quantity'
    );

    const logs = [
      { id: 'adv_1', date: '2026-11-01', quantityToday: 50, hoursWorked: 16 },
      { id: 'adv_2', date: '2026-11-02', quantityToday: 70, hoursWorked: 24 }
    ];

    const evalRes = evaluateActivityProgress(existingActivityWithoutMode, logs, '2026-11-05');
    assert.equal(evalRes.progressMode, 'quantity');
    assert.equal(evalRes.accumulatedQty, 120);
    assert.equal(evalRes.pendingQty, 80);
    assert.equal(evalRes.progressPercent, 60);
    assert.equal(evalRes.accumulatedHH, 40);
    assert.equal(evalRes.computedStatus, 'En proceso');
  });

  it('2. Actividad con Avance por Porcentaje (10% -> 20% -> 30% resulta en 30% total, NUNCA 60%)', () => {
    const pctActivity = {
      id: 'act_pct_1',
      code: 'ELE-010',
      name: 'Cableado e Instalación de Tablero General',
      progressMode: 'percentage',
      targetUnits: 100,
      unit: '%',
      startDate: '2026-11-01'
    };

    const logs = [
      {
        id: 'adv_d1',
        date: '2026-11-01',
        createdAt: '2026-11-01T10:00:00.000Z',
        quantityToday: 10,
        percentageReached: 10,
        hoursWorked: 8
      },
      {
        id: 'adv_d2',
        date: '2026-11-02',
        createdAt: '2026-11-02T14:00:00.000Z',
        quantityToday: 20,
        percentageReached: 20,
        hoursWorked: 10
      },
      {
        id: 'adv_d3',
        date: '2026-11-03',
        createdAt: '2026-11-03T17:30:00.000Z',
        quantityToday: 30,
        percentageReached: 30,
        hoursWorked: 12
      }
    ];

    const evalRes = evaluateActivityProgress(pctActivity, logs, '2026-11-05');
    assert.equal(evalRes.progressMode, 'percentage');
    assert.equal(evalRes.progressPercent, 30);
    assert.equal(evalRes.lastValidPercentage, 30);
    assert.equal(evalRes.accumulatedHH, 30);
    assert.equal(evalRes.computedStatus, 'En proceso');

    // Si en el mismo día 2026-11-03 se registra otro avance más tarde a las 19:00 con 55%, toma 55% por fecha y hora
    const logsSameDay = [
      ...logs,
      {
        id: 'adv_d3_late',
        date: '2026-11-03',
        createdAt: '2026-11-03T19:00:00.000Z',
        quantityToday: 55,
        percentageReached: 55,
        hoursWorked: 4
      }
    ];
    const evalSameDay = evaluateActivityProgress(pctActivity, logsSameDay, '2026-11-05');
    assert.equal(evalSameDay.progressPercent, 55);

    // Al llegar a 100%, el estado pasa automáticamente a Completada
    const logsCompleted = [
      ...logsSameDay,
      {
        id: 'adv_d4_done',
        date: '2026-11-04',
        createdAt: '2026-11-04T18:00:00.000Z',
        quantityToday: 100,
        percentageReached: 100,
        hoursWorked: 8
      }
    ];
    const evalDone = evaluateActivityProgress(pctActivity, logsCompleted, '2026-11-05');
    assert.equal(evalDone.progressPercent, 100);
    assert.equal(evalDone.computedStatus, 'Completada');
  });

  it('3 y 4. Validación de Porcentaje: bloquea retrocesos no autorizados y permite corrección histórica autorizada con motivo', () => {
    const existingLogs = [
      {
        id: 'adv_1',
        date: '2026-11-02',
        createdAt: '2026-11-02T15:00:00.000Z',
        quantityToday: 40,
        percentageReached: 40
      }
    ];

    // Intento de registrar 120% (fuera de rango)
    const outOfBounds = validatePercentageAdvanceRegistration({
      newPercentage: 120,
      existingLogsForActivity: existingLogs,
      userRole: 'Supervisor'
    });
    assert.equal(outOfBounds.valid, false);

    // Intento de registrar 25% (< 40%) sin marcar corrección histórica
    const unauthorizedDrop = validatePercentageAdvanceRegistration({
      newPercentage: 25,
      existingLogsForActivity: existingLogs,
      userRole: 'Supervisor',
      isAuthorizedCorrection: false
    });
    assert.equal(unauthorizedDrop.valid, false);
    assert.equal(unauthorizedDrop.requiresAuthorizedCorrection, true);

    // Intento de corrección histórica por un Operador sin rol autorizado
    const operatorDrop = validatePercentageAdvanceRegistration({
      newPercentage: 25,
      existingLogsForActivity: existingLogs,
      userRole: 'Operador de campo',
      isAuthorizedCorrection: true,
      correctionReason: 'Error de digitación en campo'
    });
    assert.equal(operatorDrop.valid, false);

    // Corrección histórica autorizada por Supervisor con motivo válido
    const authorizedCorrection = validatePercentageAdvanceRegistration({
      newPercentage: 25,
      existingLogsForActivity: existingLogs,
      userRole: 'Supervisor',
      isAuthorizedCorrection: true,
      correctionReason: 'Corrección de medición verificada por jefatura'
    });
    assert.equal(authorizedCorrection.valid, true);
  });

  it('5 y 6. Cola Offline e Idempotencia en Sincronización Manual (no duplica operaciones al presionar varias veces)', () => {
    let queue: PendingSyncOperation[] = [];

    queue = enqueueOfflineOperation(queue, {
      operationId: 'op_test_1',
      userId: 'u_sup_1',
      userDisplayName: 'Carlos Supervisor',
      userRole: 'Supervisor',
      collectionName: 'advances',
      documentId: 'adv_offline_101',
      operationType: 'upsert',
      galponId: 'gal_1',
      activityCode: 'JAU-01',
      progressMode: 'percentage',
      basePercentage: 20,
      payload: { id: 'adv_offline_101', quantityToday: 35, percentageReached: 35 },
      status: 'pending_sync'
    });

    assert.equal(queue.length, 1);

    // Si el usuario edita el mismo parte diario estando aún offline, se actualiza la misma entrada sin duplicar
    queue = enqueueOfflineOperation(queue, {
      operationId: 'op_test_2',
      userId: 'u_sup_1',
      userDisplayName: 'Carlos Supervisor',
      userRole: 'Supervisor',
      collectionName: 'advances',
      documentId: 'adv_offline_101',
      operationType: 'upsert',
      galponId: 'gal_1',
      activityCode: 'JAU-01',
      progressMode: 'percentage',
      basePercentage: 20,
      payload: { id: 'adv_offline_101', quantityToday: 40, percentageReached: 40 },
      status: 'pending_sync'
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].payload.percentageReached, 40);
  });

  it('7. Dos usuarios trabajando simultáneamente en diferentes galpones y en asistencia no se sobrescriben', () => {
    // Escenario: Usuario 1 modificó Galpón 1 localmente; Usuario 2 en el servidor ya modificó Galpón 2 y agregó Galpón 3
    const remoteSector = {
      id: 'sec_1',
      name: 'SECTOR NORTE',
      galpones: [
        { id: 'gal_1', code: 'G-01', name: 'Galpón 1 (Versión Antigua)' },
        { id: 'gal_2', code: 'G-02', name: 'Galpón 2 (Actualizado por Usuario 2)' },
        { id: 'gal_3', code: 'G-03', name: 'Galpón 3 (Creado por Usuario 2)' }
      ]
    };

    const localSectorFromUser1 = {
      id: 'sec_1',
      name: 'SECTOR NORTE',
      galpones: [
        { id: 'gal_1', code: 'G-01', name: 'Galpón 1 (Actualizado por Usuario 1)' },
        { id: 'gal_2', code: 'G-02', name: 'Galpón 2 (Versión Antigua en caché de Usuario 1)' }
      ]
    };

    // Usuario 1 solo modificó 'gal_1'
    const mergedSector = mergeSectorGalponesIsolated(
      localSectorFromUser1,
      remoteSector,
      ['gal_1']
    );

    assert.equal(mergedSector.galpones.length, 3);
    const g1 = mergedSector.galpones.find((g: any) => g.id === 'gal_1');
    const g2 = mergedSector.galpones.find((g: any) => g.id === 'gal_2');
    const g3 = mergedSector.galpones.find((g: any) => g.id === 'gal_3');

    assert.equal(g1.name, 'Galpón 1 (Actualizado por Usuario 1)');
    assert.equal(g2.name, 'Galpón 2 (Actualizado por Usuario 2)');
    assert.equal(g3.name, 'Galpón 3 (Creado por Usuario 2)');

    // Asistencia simultánea por operario
    const remoteAttendance = { w_gal1_a: 'Asistió', w_gal2_b: 'Falta' };
    const localAttendanceUser1 = { w_gal1_a: 'Permiso', w_gal1_c: 'Asistió' };
    const mergedAtt = mergeAttendanceDayIsolated(remoteAttendance, localAttendanceUser1);
    assert.deepEqual(mergedAtt, {
      w_gal1_a: 'Permiso',
      w_gal2_b: 'Falta',
      w_gal1_c: 'Asistió'
    });
  });

  it('8. Conflicto Multiusuario sobre la misma actividad en Porcentaje (Usuario A offline 30% vs Usuario B online 40%)', () => {
    const offlineOperationUserA: PendingSyncOperation = {
      operationId: 'op_userA_offline',
      deviceId: 'dev_tablet_A',
      userId: 'uid_user_A',
      userDisplayName: 'Supervisor A (Sin conexión)',
      userRole: 'Supervisor',
      createdAt: '2026-11-05T11:00:00.000Z',
      collectionName: 'advances',
      documentId: 'adv_userA_30',
      operationType: 'upsert',
      sectorId: 'sec_1',
      galponId: 'gal_1',
      activityId: 'act_pct_1',
      activityCode: 'ELE-010',
      progressMode: 'percentage',
      basePercentage: 20,
      baseTimestamp: '2026-11-05T08:00:00.000Z',
      payload: {
        id: 'adv_userA_30',
        galponId: 'gal_1',
        activityId: 'act_pct_1',
        activityCode: 'ELE-010',
        date: '2026-11-05',
        createdAt: '2026-11-05T11:00:00.000Z',
        progressMode: 'percentage',
        quantityToday: 30,
        percentageReached: 30,
        supervisor: 'Supervisor A'
      },
      status: 'pending_sync',
      retryCount: 0
    };

    const remoteAdvancesInFirestore = [
      {
        id: 'adv_initial_20',
        galponId: 'gal_1',
        activityId: 'act_pct_1',
        activityCode: 'ELE-010',
        date: '2026-11-04',
        createdAt: '2026-11-04T16:00:00.000Z',
        progressMode: 'percentage',
        quantityToday: 20,
        percentageReached: 20,
        supervisor: 'Supervisor A'
      },
      {
        id: 'adv_userB_40',
        galponId: 'gal_1',
        activityId: 'act_pct_1',
        activityCode: 'ELE-010',
        date: '2026-11-05',
        createdAt: '2026-11-05T10:30:00.000Z',
        progressMode: 'percentage',
        quantityToday: 40,
        percentageReached: 40,
        supervisor: 'Supervisor B (En línea)'
      }
    ];

    const conflict = detectMultiUserAdvanceConflict({
      operation: offlineOperationUserA,
      remoteAdvancesForActivity: remoteAdvancesInFirestore,
      activityName: 'Cableado General',
      galponCode: 'G-01'
    });

    assert.ok(conflict, 'Debe detectar el conflicto entre el 30% offline y el 40% online');
    assert.equal(conflict?.localValue, 30);
    assert.equal(conflict?.remoteValue, 40);
    assert.equal(conflict?.resolved, false);

    // Verificar que al guardar el registro de Usuario A con conflictStatus: 'conflict', el avance oficial sigue siendo 40% (no se sobrescribe con 30%)
    const combinedLogs = [
      ...remoteAdvancesInFirestore,
      { ...offlineOperationUserA.payload, conflictStatus: 'conflict' }
    ];
    const evalAfterConflict = evaluateActivityProgress(
      { id: 'act_pct_1', code: 'ELE-010', progressMode: 'percentage' },
      combinedLogs,
      '2026-11-05'
    );
    assert.equal(evalAfterConflict.progressPercent, 40);
    assert.equal(evalAfterConflict.conflictedLogsCount, 1);
  });
});

describe('ETAPA 1 — CORRECCIONES C-1 (Fusión Profunda por Actividad) y C-2 (Preservación Offline)', () => {
  const createBaseSector = () => ({
    id: 'sec_calera_1',
    name: 'SECTOR SUR',
    galpones: [
      {
        id: 'gal_101',
        code: 'GAL-101',
        name: 'Galpón 101',
        areas: [
          {
            id: 'area_jaula',
            name: 'Jaula',
            hasSistemas: true,
            sistemas: [
              {
                id: 'sis_alim',
                name: 'Alimentación',
                locationType: 'Interno',
                structures: [
                  {
                    id: 'str_tolva',
                    name: 'Tolvas',
                    activities: [
                      {
                        id: 'act_1',
                        code: 'JAU-001',
                        name: 'Montaje de Tolva Principal',
                        progressMode: 'quantity',
                        targetUnits: 100,
                        unit: 'und',
                        startDate: '2026-11-01',
                        dueDate: '2026-11-10',
                        updatedAt: '2026-11-01T08:00:00.000Z',
                        updatedBy: 'Admin'
                      },
                      {
                        id: 'act_2',
                        code: 'JAU-002',
                        name: 'Instalación de Comederos',
                        progressMode: 'percentage',
                        targetUnits: 100,
                        unit: '%',
                        startDate: '2026-11-02',
                        dueDate: '2026-11-12',
                        updatedAt: '2026-11-01T08:00:00.000Z',
                        updatedBy: 'Admin'
                      }
                    ]
                  }
                ]
              }
            ],
            structures: []
          }
        ]
      }
    ]
  });

  it('C-1a. Dos usuarios agregan actividades distintas en el mismo Galpón -> Área -> Sistema -> Estructura y se conservan ambas', () => {
    const baseSector = createBaseSector();

    // Usuario B (ya en servidor) agregó act_user_b en la misma estructura 'str_tolva'
    const remoteSector = JSON.parse(JSON.stringify(baseSector));
    remoteSector.galpones[0].areas[0].sistemas[0].structures[0].activities.push({
      id: 'act_user_b',
      code: 'JAU-003',
      name: 'Sensores de Nivel (Agregada por Usuario B)',
      progressMode: 'quantity',
      targetUnits: 20,
      unit: 'pto',
      startDate: '2026-11-05',
      dueDate: '2026-11-15',
      updatedAt: '2026-11-05T10:00:00.000Z',
      updatedBy: 'Supervisor B'
    });

    // Usuario A (local) tenía la versión base y agregó act_user_a en la misma estructura 'str_tolva'
    const localSector = JSON.parse(JSON.stringify(baseSector));
    localSector.galpones[0].areas[0].sistemas[0].structures[0].activities.push({
      id: 'act_user_a',
      code: 'JAU-004',
      name: 'Motorreductor de Línea (Agregada por Usuario A)',
      progressMode: 'quantity',
      targetUnits: 10,
      unit: 'und',
      startDate: '2026-11-06',
      dueDate: '2026-11-16',
      updatedAt: '2026-11-05T10:05:00.000Z',
      updatedBy: 'Supervisor A'
    });

    const { mergedSector, conflicts } = mergeSectorDeepWithConflicts(
      localSector,
      remoteSector,
      {
        modifiedGalponIds: ['gal_101'],
        baseSector
      }
    );

    assert.equal(conflicts.length, 0);
    const mergedActivities =
      mergedSector.galpones[0].areas[0].sistemas[0].structures[0].activities;
    assert.equal(mergedActivities.length, 4);
    assert.ok(mergedActivities.some((a: any) => a.id === 'act_1'));
    assert.ok(mergedActivities.some((a: any) => a.id === 'act_2'));
    assert.ok(mergedActivities.some((a: any) => a.id === 'act_user_b'));
    assert.ok(mergedActivities.some((a: any) => a.id === 'act_user_a'));
  });

  it('C-1b. Dos usuarios modifican actividades diferentes (act_1 y act_2) del mismo Galpón y se conservan ambas modificaciones (incluso si cambia el código visible)', () => {
    const baseSector = createBaseSector();

    // Usuario B en servidor modificó act_2 (cambió meta y código visible JAU-002 -> JAU-002B)
    const remoteSector = JSON.parse(JSON.stringify(baseSector));
    const remAct2 =
      remoteSector.galpones[0].areas[0].sistemas[0].structures[0].activities[1];
    remAct2.code = 'JAU-002B';
    remAct2.name = 'Instalación de Comederos Automáticos';
    remAct2.dueDate = '2026-11-18';
    remAct2.baseUpdatedAt = '2026-11-01T08:00:00.000Z';
    remAct2.updatedAt = '2026-11-05T11:00:00.000Z';
    remAct2.updatedBy = 'Supervisor B';

    // Usuario A localmente modificó act_1 (cambió targetUnits 100 -> 150 y código JAU-001 -> JAU-001A)
    const localSector = JSON.parse(JSON.stringify(baseSector));
    const locAct1 =
      localSector.galpones[0].areas[0].sistemas[0].structures[0].activities[0];
    locAct1.code = 'JAU-001A';
    locAct1.targetUnits = 150;
    locAct1.baseUpdatedAt = '2026-11-01T08:00:00.000Z';
    locAct1.updatedAt = '2026-11-05T11:05:00.000Z';
    locAct1.updatedBy = 'Supervisor A';

    const { mergedSector, conflicts } = mergeSectorDeepWithConflicts(
      localSector,
      remoteSector,
      {
        modifiedGalponIds: ['gal_101'],
        baseSector
      }
    );

    assert.equal(conflicts.length, 0);
    const mergedActivities =
      mergedSector.galpones[0].areas[0].sistemas[0].structures[0].activities;
    const mAct1 = mergedActivities.find((a: any) => a.id === 'act_1');
    const mAct2 = mergedActivities.find((a: any) => a.id === 'act_2');

    assert.equal(mAct1.code, 'JAU-001A');
    assert.equal(mAct1.targetUnits, 150);
    assert.equal(mAct2.code, 'JAU-002B');
    assert.equal(mAct2.name, 'Instalación de Comederos Automáticos');
    assert.equal(mAct2.dueDate, '2026-11-18');
  });

  it('C-1c. Dos usuarios modifican la MISMA actividad simultáneamente con valores distintos: detecta conflicto sin last-write-wins ciego y permite resolución autorizada', () => {
    const baseSector = createBaseSector();

    // Usuario B en servidor cambió act_1 targetUnits a 180
    const remoteSector = JSON.parse(JSON.stringify(baseSector));
    const remAct1 =
      remoteSector.galpones[0].areas[0].sistemas[0].structures[0].activities[0];
    remAct1.targetUnits = 180;
    remAct1.baseUpdatedAt = '2026-11-01T08:00:00.000Z';
    remAct1.updatedAt = '2026-11-05T12:00:00.000Z';
    remAct1.updatedBy = 'Supervisor B';

    // Usuario A offline cambió la misma act_1 targetUnits a 140 partiendo de la misma base (2026-11-01T08:00:00.000Z)
    const localSector = JSON.parse(JSON.stringify(baseSector));
    const locAct1 =
      localSector.galpones[0].areas[0].sistemas[0].structures[0].activities[0];
    locAct1.targetUnits = 140;
    locAct1.baseUpdatedAt = '2026-11-01T08:00:00.000Z';
    locAct1.updatedAt = '2026-11-05T12:10:00.000Z';
    locAct1.updatedBy = 'Supervisor A';

    // Incluso sin pasar baseSector explícito (p. ej. tras recargar navegador y procesar cola offline), baseUpdatedAt detecta la edición concurrente
    const { mergedSector, conflicts } = mergeSectorDeepWithConflicts(
      localSector,
      remoteSector,
      {
        modifiedGalponIds: ['gal_101'],
        localUser: 'Supervisor A',
        operationId: 'op_sec_conflict_1'
      }
    );

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].collectionName, 'sectors');
    assert.equal(conflicts[0].activityId, 'act_1');
    assert.equal(conflicts[0].remoteValue, 180);
    assert.equal(conflicts[0].localValue, 140);

    // Verifica que NO hubo last-write-wins ciego: en el sector fusionado se conserva 180 (servidor) hasta resolución autorizada
    const protectedAct1 =
      mergedSector.galpones[0].areas[0].sistemas[0].structures[0].activities.find(
        (a: any) => a.id === 'act_1'
      );
    assert.equal(protectedAct1.targetUnits, 180);

    // Ahora un Supervisor/Administrador autoriza aplicar la edición local (apply_local -> 140)
    const resolvedSectorLocal = applyActivityConflictResolutionToSector(
      mergedSector,
      conflicts[0],
      'apply_local'
    );
    const resolvedAct1 =
      resolvedSectorLocal.galpones[0].areas[0].sistemas[0].structures[0].activities.find(
        (a: any) => a.id === 'act_1'
      );
    assert.equal(resolvedAct1.targetUnits, 140);
  });

  it('C-1d. Eliminaciones preservadas por Tombstones: una actividad o galpón eliminado no reaparece al fusionar', () => {
    const baseSector = createBaseSector();
    const remoteSector = JSON.parse(JSON.stringify(baseSector));

    // Usuario A elimina la actividad 'act_2' y registra tombstone en el galpón
    const localSector = JSON.parse(JSON.stringify(baseSector));
    localSector.galpones[0].areas[0].sistemas[0].structures[0].activities =
      localSector.galpones[0].areas[0].sistemas[0].structures[0].activities.filter(
        (a: any) => a.id !== 'act_2'
      );
    localSector.galpones[0] = recordActivityDeletionTombstone(
      localSector.galpones[0],
      'act_2',
      'Admin Renzo'
    );

    const { mergedSector } = mergeSectorDeepWithConflicts(localSector, remoteSector, {
      modifiedGalponIds: ['gal_101'],
      baseSector
    });

    const remainingActivities =
      mergedSector.galpones[0].areas[0].sistemas[0].structures[0].activities;
    assert.equal(remainingActivities.length, 1);
    assert.equal(remainingActivities[0].id, 'act_1');
    assert.ok(mergedSector.galpones[0].deletedActivityTombstones['act_2']);

    // Igualmente, si se elimina un galpón con tombstone, no reaparece desde el servidor
    const sectorWithDeletedGalpon = recordGalponDeletionTombstone(
      { ...mergedSector, galpones: [] },
      'gal_101',
      'Admin Renzo'
    );
    const { mergedSector: afterGalponDelete } = mergeSectorDeepWithConflicts(
      sectorWithDeletedGalpon,
      remoteSector
    );
    assert.equal(afterGalponDelete.galpones.length, 0);
    assert.ok(afterGalponDelete.deletedGalponTombstones['gal_101']);
  });

  it('C-2. Reconstrucción de estado combinando Firestore + Cola Offline (altas, modificaciones, eliminaciones y fallos pendientes tras cerrar y reabrir navegador)', () => {
    const remoteMaterials = [
      { id: 'mat_1', code: 'MAT-01', name: 'Cemento Portland', totalQty: 100 },
      { id: 'mat_2', code: 'MAT-02', name: 'Fierro Corrugado 1/2"', totalQty: 250 }
    ];
    const remoteWorkers = [
      { id: 'wrk_1', dni: '10000001', name: 'Juan Pérez', role: 'Operario' }
    ];
    const remoteCatalog = [
      { id: 'cat_1', code: 'CAT-01', name: 'Trazado y Replanteo', progressMode: 'quantity' }
    ];
    const remoteAttendance = {
      '2026-11-05': { wrk_1: 'Asistió' }
    };

    const offlineQueue: PendingSyncOperation[] = [
      // Modificación offline de mat_1 (totalQty 100 -> 140)
      {
        operationId: 'op_m1',
        deviceId: 'dev_1',
        userId: 'u_1',
        userDisplayName: 'Admin',
        userRole: 'Administrador',
        createdAt: '2026-11-05T13:00:00.000Z',
        collectionName: 'materials',
        documentId: 'mat_1',
        operationType: 'upsert',
        payload: { id: 'mat_1', code: 'MAT-01', name: 'Cemento Portland', totalQty: 140 },
        status: 'pending_sync',
        retryCount: 0
      },
      // Eliminación offline de mat_2
      {
        operationId: 'op_m2_del',
        deviceId: 'dev_1',
        userId: 'u_1',
        userDisplayName: 'Admin',
        userRole: 'Administrador',
        createdAt: '2026-11-05T13:02:00.000Z',
        collectionName: 'materials',
        documentId: 'mat_2',
        operationType: 'delete',
        status: 'pending_sync',
        retryCount: 0
      },
      // Alta offline de mat_3 con estado sync_error (falló el primer intento y sigue en cola para reintento)
      {
        operationId: 'op_m3_create',
        deviceId: 'dev_1',
        userId: 'u_1',
        userDisplayName: 'Admin',
        userRole: 'Administrador',
        createdAt: '2026-11-05T13:05:00.000Z',
        collectionName: 'materials',
        documentId: 'mat_3',
        operationType: 'upsert',
        payload: { id: 'mat_3', code: 'MAT-03', name: 'Alambre Recocido #16', totalQty: 80 },
        status: 'sync_error',
        retryCount: 1,
        errorMessage: 'Network timeout'
      },
      // Alta offline de operario wrk_2
      {
        operationId: 'op_w2',
        deviceId: 'dev_1',
        userId: 'u_1',
        userDisplayName: 'Admin',
        userRole: 'Administrador',
        createdAt: '2026-11-05T13:06:00.000Z',
        collectionName: 'workers',
        documentId: 'wrk_2',
        operationType: 'upsert',
        payload: { id: 'wrk_2', dni: '20000002', name: 'Pedro Gómez', role: 'Oficial' },
        status: 'pending_sync',
        retryCount: 0
      },
      // Alta offline en catálogo maestro cat_2
      {
        operationId: 'op_c2',
        deviceId: 'dev_1',
        userId: 'u_1',
        userDisplayName: 'Admin',
        userRole: 'Administrador',
        createdAt: '2026-11-05T13:07:00.000Z',
        collectionName: 'masterCatalog',
        documentId: 'cat_2',
        operationType: 'upsert',
        payload: { id: 'cat_2', code: 'CAT-02', name: 'Montaje Eléctrico', progressMode: 'percentage' },
        status: 'pending_sync',
        retryCount: 0
      },
      // Asistencia offline para wrk_2 en el mismo día 2026-11-05
      {
        operationId: 'op_att_1',
        deviceId: 'dev_1',
        userId: 'u_1',
        userDisplayName: 'Admin',
        userRole: 'Administrador',
        createdAt: '2026-11-05T13:08:00.000Z',
        collectionName: 'attendance',
        documentId: '2026-11-05',
        operationType: 'upsert',
        payload: { id: '2026-11-05', date: '2026-11-05', records: { wrk_2: 'Asistió' } },
        status: 'pending_sync',
        retryCount: 0
      },
      // Proveedor offline en settings
      {
        operationId: 'op_prov_1',
        deviceId: 'dev_1',
        userId: 'u_1',
        userDisplayName: 'Admin',
        userRole: 'Administrador',
        createdAt: '2026-11-05T13:09:00.000Z',
        collectionName: 'settings',
        documentId: 'prov_TECHNO_AVICOLA',
        operationType: 'upsert',
        payload: { id: 'prov_TECHNO_AVICOLA', name: 'TECHNO AVICOLA' },
        status: 'pending_sync',
        retryCount: 0
      }
    ];

    const mergedMaterials = reconstructCollectionWithOfflineQueue(
      remoteMaterials,
      offlineQueue,
      'materials'
    );
    assert.equal(mergedMaterials.length, 2); // mat_1 actualizado, mat_2 eliminado, mat_3 creado
    const m1 = mergedMaterials.find((m) => m.id === 'mat_1');
    const m2 = mergedMaterials.find((m) => m.id === 'mat_2');
    const m3 = mergedMaterials.find((m) => m.id === 'mat_3');
    assert.equal(m1?.totalQty, 140);
    assert.equal(m1?.syncState, 'pending_sync');
    assert.equal(m2, undefined);
    assert.equal(m3?.totalQty, 80);
    assert.equal(m3?.syncState, 'sync_error');

    const mergedWorkers = reconstructCollectionWithOfflineQueue(
      remoteWorkers,
      offlineQueue,
      'workers'
    );
    assert.equal(mergedWorkers.length, 2);

    const mergedCatalog = reconstructCollectionWithOfflineQueue(
      remoteCatalog,
      offlineQueue,
      'masterCatalog'
    );
    assert.equal(mergedCatalog.length, 2);

    const mergedAtt = reconstructAttendanceWithOfflineQueue(
      remoteAttendance,
      offlineQueue
    );
    assert.deepEqual(mergedAtt['2026-11-05'], {
      wrk_1: 'Asistió',
      wrk_2: 'Asistió'
    });

    const mergedProviders = reconstructProvidersWithOfflineQueue(
      ['ZUCAMI'],
      offlineQueue
    );
    assert.deepEqual(mergedProviders, ['ZUCAMI', 'TECHNO AVICOLA']);
  });
});

describe('ETAPA 2 — SEGURIDAD Y SINCRONIZACIÓN: C-3 (Reintentos Idempotentes Auxiliar) y C-4 (Identidad en Dispositivos Compartidos)', () => {
  it('C-3a. Creación inicial de avance (Auxiliar): cuando el documento no existe en Firestore, genera outcome=create con operationId, userId, createdAt, syncedBy y syncedAt', () => {
    const opAuxiliar: PendingSyncOperation = {
      operationId: 'op_aux_create_01',
      deviceId: 'dev_tablet_01',
      userId: 'uid_aux_mario',
      userDisplayName: 'Mario Auxiliar',
      userRole: 'Auxiliar',
      createdAt: '2026-11-05T14:00:00.000Z',
      collectionName: 'advances',
      documentId: 'adv_aux_501',
      operationType: 'upsert',
      sectorId: 'sec_1',
      galponId: 'gal_1',
      activityId: 'act_1',
      activityCode: 'CIV-001',
      progressMode: 'quantity',
      payload: {
        id: 'adv_aux_501',
        galponId: 'gal_1',
        activityId: 'act_1',
        activityCode: 'CIV-001',
        date: '2026-11-05',
        createdAt: '2026-11-05T14:00:00.000Z',
        progressMode: 'quantity',
        quantityToday: 25,
        hoursWorked: 8,
        supervisor: 'Mario Auxiliar',
        userId: 'uid_aux_mario',
        operationId: 'op_aux_create_01'
      },
      status: 'pending_sync',
      retryCount: 0
    };

    const decision = evaluateIdempotentAdvanceSync({
      operation: opAuxiliar,
      existingRemoteDoc: null,
      remoteAdvancesForActivity: [],
      syncingUserId: 'uid_aux_mario',
      syncingUserDisplayName: 'Mario Auxiliar',
      nowIso: '2026-11-05T14:05:00.000Z'
    });

    assert.equal(decision.outcome, 'create');
    assert.ok(decision.payloadToWrite);
    assert.equal(decision.payloadToWrite.operationId, 'op_aux_create_01');
    assert.equal(decision.payloadToWrite.userId, 'uid_aux_mario');
    assert.equal(decision.payloadToWrite.createdAt, '2026-11-05T14:00:00.000Z');
    assert.equal(decision.payloadToWrite.syncedBy, 'uid_aux_mario');
    assert.equal(decision.payloadToWrite.syncedAt, '2026-11-05T14:05:00.000Z');
  });

  it('C-3b. Reintento de operación ya procesada (corte de red después de que Firestore recibió el documento pero antes del ACK al cliente): reconoce already_processed sin volver a llamar setDoc (evita permission-denied en Auxiliar)', () => {
    const opRetryAuxiliar: PendingSyncOperation = {
      operationId: 'op_aux_retry_99',
      deviceId: 'dev_tablet_01',
      userId: 'uid_aux_mario',
      userDisplayName: 'Mario Auxiliar',
      userRole: 'Auxiliar',
      createdAt: '2026-11-05T14:10:00.000Z',
      collectionName: 'advances',
      documentId: 'adv_aux_502',
      operationType: 'upsert',
      sectorId: 'sec_1',
      galponId: 'gal_1',
      activityId: 'act_1',
      activityCode: 'CIV-001',
      progressMode: 'quantity',
      payload: {
        id: 'adv_aux_502',
        galponId: 'gal_1',
        activityId: 'act_1',
        activityCode: 'CIV-001',
        date: '2026-11-05',
        createdAt: '2026-11-05T14:10:00.000Z',
        progressMode: 'quantity',
        quantityToday: 40,
        hoursWorked: 12,
        supervisor: 'Mario Auxiliar',
        userId: 'uid_aux_mario',
        operationId: 'op_aux_retry_99'
      },
      status: 'sync_error',
      retryCount: 1,
      errorMessage: 'Network disconnected before client ACK'
    };

    // En Firestore el documento YA fue escrito en el primer intento con el mismo operationId
    const existingDocInFirestore = {
      id: 'adv_aux_502',
      galponId: 'gal_1',
      activityId: 'act_1',
      activityCode: 'CIV-001',
      date: '2026-11-05',
      createdAt: '2026-11-05T14:10:00.000Z',
      progressMode: 'quantity',
      quantityToday: 40,
      hoursWorked: 12,
      supervisor: 'Mario Auxiliar',
      userId: 'uid_aux_mario',
      operationId: 'op_aux_retry_99',
      syncState: 'synced'
    };

    const decisionByOpId = evaluateIdempotentAdvanceSync({
      operation: opRetryAuxiliar,
      existingRemoteDoc: existingDocInFirestore,
      remoteAdvancesForActivity: [],
      syncingUserId: 'uid_aux_mario',
      syncingUserDisplayName: 'Mario Auxiliar'
    });

    assert.equal(decisionByOpId.outcome, 'already_processed');
    assert.equal(decisionByOpId.payloadToWrite, undefined);

    // También si el documento remoto existía sin operationId pero con idéntico contenido esencial
    const existingLegacyDocSameContent = {
      ...existingDocInFirestore,
      operationId: undefined
    };
    const decisionByContent = evaluateIdempotentAdvanceSync({
      operation: opRetryAuxiliar,
      existingRemoteDoc: existingLegacyDocSameContent,
      remoteAdvancesForActivity: [],
      syncingUserId: 'uid_aux_mario',
      syncingUserDisplayName: 'Mario Auxiliar'
    });

    assert.equal(decisionByContent.outcome, 'already_processed');
  });

  it('C-3c. Reintento con contenido diferente sobre documento existente en Firestore: genera conflicto sin sobrescribir el avance confirmado en el servidor', () => {
    const opDifferentContent: PendingSyncOperation = {
      operationId: 'op_aux_diff_77',
      deviceId: 'dev_tablet_01',
      userId: 'uid_aux_mario',
      userDisplayName: 'Mario Auxiliar',
      userRole: 'Auxiliar',
      createdAt: '2026-11-05T14:20:00.000Z',
      collectionName: 'advances',
      documentId: 'adv_shared_id_900',
      operationType: 'upsert',
      sectorId: 'sec_1',
      galponId: 'gal_1',
      activityId: 'act_1',
      activityCode: 'CIV-001',
      progressMode: 'quantity',
      payload: {
        id: 'adv_shared_id_900',
        galponId: 'gal_1',
        activityId: 'act_1',
        activityCode: 'CIV-001',
        date: '2026-11-05',
        createdAt: '2026-11-05T14:20:00.000Z',
        progressMode: 'quantity',
        quantityToday: 15,
        hoursWorked: 6,
        supervisor: 'Mario Auxiliar',
        userId: 'uid_aux_mario',
        operationId: 'op_aux_diff_77'
      },
      status: 'pending_sync',
      retryCount: 1
    };

    // En el servidor el documento adv_shared_id_900 ya existe confirmado con quantityToday = 50 y otro operationId
    const confirmedServerDoc = {
      id: 'adv_shared_id_900',
      galponId: 'gal_1',
      activityId: 'act_1',
      activityCode: 'CIV-001',
      date: '2026-11-05',
      createdAt: '2026-11-05T14:15:00.000Z',
      progressMode: 'quantity',
      quantityToday: 50,
      hoursWorked: 16,
      supervisor: 'Supervisor Carlos',
      userId: 'uid_sup_carlos',
      operationId: 'op_sup_original_10'
    };

    const decision = evaluateIdempotentAdvanceSync({
      operation: opDifferentContent,
      existingRemoteDoc: confirmedServerDoc,
      remoteAdvancesForActivity: [],
      syncingUserId: 'uid_aux_mario',
      syncingUserDisplayName: 'Mario Auxiliar'
    });

    assert.equal(decision.outcome, 'conflict');
    assert.equal(decision.canWriteConflictedRecord, false);
    assert.ok(decision.conflictRecord);
    assert.equal(decision.conflictRecord?.localValue, 15);
    assert.equal(decision.conflictRecord?.remoteValue, 50);
    assert.equal(decision.conflictRecord?.resolved, false);
  });

  it('C-4. Dispositivo compartido: Usuario A registra operaciones offline y cierra sesión -> Usuario B inicia sesión (se detecta y bloquea auto-sync de cola de A) -> Usuario A vuelve a iniciar sesión y recupera su cola intacta', () => {
    let sharedDeviceQueue: PendingSyncOperation[] = [];

    // Paso 1: Usuario A (uid_user_A) registra dos operaciones offline en la tablet compartida
    sharedDeviceQueue = enqueueOfflineOperation(sharedDeviceQueue, {
      operationId: 'op_userA_adv_1',
      createdAt: '2026-11-05T09:00:00.000Z',
      userId: 'uid_user_A',
      userDisplayName: 'Ana Supervisora (Usuario A)',
      userRole: 'Supervisor',
      collectionName: 'advances',
      documentId: 'adv_shared_doc_1',
      operationType: 'upsert',
      galponId: 'gal_1',
      activityCode: 'JAU-01',
      payload: {
        id: 'adv_shared_doc_1',
        galponId: 'gal_1',
        activityCode: 'JAU-01',
        date: '2026-11-05',
        quantityToday: 30,
        userId: 'uid_user_A',
        createdAt: '2026-11-05T09:00:00.000Z'
      },
      status: 'pending_sync'
    });

    // Paso 2: Usuario A cierra sesión (activeUserId = null). Las operaciones NO se borran.
    const whileLoggedOut = partitionQueueByUserIdentity(sharedDeviceQueue, null);
    assert.equal(whileLoggedOut.ownPendingOps.length, 0);
    assert.equal(whileLoggedOut.foreignPendingOps.length, 1);
    assert.deepEqual(whileLoggedOut.foreignAuthors, ['Ana Supervisora (Usuario A)']);

    // Paso 3: Usuario B (uid_user_B) inicia sesión en el mismo dispositivo compartido
    const whenUserBLogsIn = partitionQueueByUserIdentity(
      sharedDeviceQueue,
      'uid_user_B'
    );
    assert.equal(
      whenUserBLogsIn.ownPendingOps.length,
      0,
      'Usuario B no debe sincronizar automáticamente las operaciones de Usuario A'
    );
    assert.equal(whenUserBLogsIn.foreignPendingOps.length, 1);
    assert.equal(whenUserBLogsIn.foreignPendingOps[0].userId, 'uid_user_A');
    assert.deepEqual(whenUserBLogsIn.foreignAuthors, ['Ana Supervisora (Usuario A)']);

    // Incluso si Usuario B registra una operación offline en el mismo dispositivo (incluso sobre el mismo documentId),
    // NO sobrescribe ni altera el userId de la operación pendiente de Usuario A
    sharedDeviceQueue = enqueueOfflineOperation(sharedDeviceQueue, {
      operationId: 'op_userB_adv_1',
      createdAt: '2026-11-05T10:00:00.000Z',
      userId: 'uid_user_B',
      userDisplayName: 'Bruno Auxiliar (Usuario B)',
      userRole: 'Auxiliar',
      collectionName: 'advances',
      documentId: 'adv_shared_doc_1',
      operationType: 'upsert',
      galponId: 'gal_1',
      activityCode: 'JAU-01',
      payload: {
        id: 'adv_shared_doc_1',
        galponId: 'gal_1',
        activityCode: 'JAU-01',
        date: '2026-11-05',
        quantityToday: 45,
        userId: 'uid_user_B',
        createdAt: '2026-11-05T10:00:00.000Z'
      },
      status: 'pending_sync'
    });

    assert.equal(sharedDeviceQueue.length, 2);
    const partForUserB = partitionQueueByUserIdentity(sharedDeviceQueue, 'uid_user_B');
    assert.equal(partForUserB.ownPendingOps.length, 1);
    assert.equal(partForUserB.ownPendingOps[0].userId, 'uid_user_B');
    assert.equal(partForUserB.foreignPendingOps.length, 1);
    assert.equal(partForUserB.foreignPendingOps[0].userId, 'uid_user_A');

    // Simular que Usuario B sincroniza únicamente su propia operación y conserva intacta la cola de Usuario A
    const queueAfterUserBSync = [...partForUserB.foreignPendingOps];

    // Paso 4: Usuario A vuelve a iniciar sesión en el dispositivo y recupera su operación pendiente
    const whenUserAReturns = partitionQueueByUserIdentity(
      queueAfterUserBSync,
      'uid_user_A'
    );
    assert.equal(whenUserAReturns.ownPendingOps.length, 1);
    assert.equal(whenUserAReturns.foreignPendingOps.length, 0);
    assert.equal(whenUserAReturns.ownPendingOps[0].operationId, 'op_userA_adv_1');
    assert.equal(whenUserAReturns.ownPendingOps[0].userId, 'uid_user_A');

    // Verificar que al estampar los metadatos de sincronización NUNCA se altera el userId ni createdAt original
    const stampedDoc = stampOperationSyncMetadata(
      whenUserAReturns.ownPendingOps[0].payload,
      whenUserAReturns.ownPendingOps[0],
      { uid: 'uid_user_A', displayName: 'Ana Supervisora (Usuario A)' },
      '2026-11-05T11:30:00.000Z'
    );
    assert.equal(stampedDoc.userId, 'uid_user_A');
    assert.equal(stampedDoc.createdAt, '2026-11-05T09:00:00.000Z');
    assert.equal(stampedDoc.operationId, 'op_userA_adv_1');
    assert.equal(stampedDoc.syncedBy, 'uid_user_A');
    assert.equal(stampedDoc.syncedAt, '2026-11-05T11:30:00.000Z');
  });
});


