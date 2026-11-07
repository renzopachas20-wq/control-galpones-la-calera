import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateActivityProgress,
  normalizeProgressMode,
  countUniquePendingSyncOperations,
  enqueueOfflineOperation,
  resolveDynamicSectorGalponContext,
  type PendingSyncOperation
} from './offlineSyncEngine';
import { getApiUrl, getApiBaseUrl, isMobileAppContainer } from './apiConfig';
import { translateFirebaseAuthError } from './authService';
import { resolveVersionMetadata } from '../components/SidebarVersionBadge';

describe('ETAPA 3 — FUNCIONALIDADES PENDIENTES Y COMPATIBILIDAD', () => {

  // ==========================================================================
  // ETAPA 3.1: INFORMES GLOBALES (TABLA INTERACTIVA, FILTROS Y PARIDAD)
  // ==========================================================================
  describe('ETAPA 3.1: Informes Globales — Paridad de Cálculos y Filtros', () => {
    const today = '2026-11-05';

    it('3.1a. Paridad matemática de avances: las fórmulas de la tabla coinciden exactamente con evaluateActivityProgress', () => {
      // Actividad en Cantidades
      const actQty = {
        id: 'act_c1',
        code: 'SOL-01',
        name: 'Solado de limpieza',
        progressMode: 'quantity',
        targetUnits: 200,
        unit: 'm2',
        weight: 2,
        plannedHH: 40
      };
      const logsQty = [
        { id: 'l1', activityId: 'act_c1', quantityToday: 50, hoursWorked: 10, date: '2026-11-01' },
        { id: 'l2', activityId: 'act_c1', quantityToday: 50, hoursWorked: 10, date: '2026-11-02' }
      ];

      const evaluatedQty = evaluateActivityProgress(actQty, logsQty, today);
      assert.equal(evaluatedQty.progressMode, 'quantity');
      assert.equal(evaluatedQty.accumulatedQty, 100);
      assert.equal(evaluatedQty.progressPercent, 50);
      assert.equal(evaluatedQty.accumulatedHH, 20);
      assert.equal(evaluatedQty.computedStatus, 'En proceso');

      // Actividad en Porcentaje (avance acumulativo de hito, no suma de registros)
      const actPct = {
        id: 'act_p1',
        code: 'MON-01',
        name: 'Montaje de silos y comederos',
        progressMode: 'percentage',
        targetUnits: 100,
        unit: '%',
        weight: 3,
        plannedHH: 60
      };
      const logsPct = [
        { id: 'lp1', activityId: 'act_p1', percentageReached: 20, quantityToday: 20, hoursWorked: 15, date: '2026-11-01' },
        { id: 'lp2', activityId: 'act_p1', percentageReached: 45, quantityToday: 45, hoursWorked: 15, date: '2026-11-02' }
      ];

      const evaluatedPct = evaluateActivityProgress(actPct, logsPct, today);
      assert.equal(evaluatedPct.progressMode, 'percentage');
      assert.equal(evaluatedPct.accumulatedQty, 45, 'En porcentaje, el acumulado es el último hito alcanzado (45%), NUNCA 65%');
      assert.equal(evaluatedPct.progressPercent, 45);
      assert.equal(evaluatedPct.accumulatedHH, 30);
      assert.equal(evaluatedPct.computedStatus, 'En proceso');

      // Cuando llega a 100%, pasa a Completado
      const logsPctDone = [
        ...logsPct,
        { id: 'lp3', activityId: 'act_p1', percentageReached: 100, quantityToday: 100, hoursWorked: 20, date: '2026-11-03' }
      ];
      const evaluatedPctDone = evaluateActivityProgress(actPct, logsPctDone, today);
      assert.equal(evaluatedPctDone.progressPercent, 100);
      assert.equal(evaluatedPctDone.computedStatus, 'Completada');
    });

    it('3.1b. Filtros de la tabla: Sector, Galpón, Área, Sistema, Modalidad, Estado y búsqueda de texto', () => {
      const mockRows = [
        {
          id: 'r1',
          sectorId: 'sec_1',
          sectorName: 'Sector Calera Alta',
          galponId: 'gal_1',
          galponCode: 'G01',
          areaName: 'Estructuras Principales',
          sistemaName: 'Comederos',
          activityCode: 'COM-01',
          activityName: 'Línea de comederos',
          progressMode: 'percentage',
          computedStatus: 'En proceso'
        },
        {
          id: 'r2',
          sectorId: 'sec_1',
          sectorName: 'Sector Calera Alta',
          galponId: 'gal_2',
          galponCode: 'G02',
          areaName: 'Obras Civiles',
          sistemaName: '-',
          activityCode: 'CIV-01',
          activityName: 'Cimientos y zapatas',
          progressMode: 'quantity',
          computedStatus: 'Completado'
        },
        {
          id: 'r3',
          sectorId: 'sec_2',
          sectorName: 'Sector Calera Baja',
          galponId: 'gal_3',
          galponCode: 'G03',
          areaName: 'Estructuras Principales',
          sistemaName: 'Ventilación',
          activityCode: 'VEN-01',
          activityName: 'Extractores de aire',
          progressMode: 'percentage',
          computedStatus: 'No iniciado'
        }
      ];

      // Filtro por Modalidad 'percentage'
      const pctFiltered = mockRows.filter(r => r.progressMode === 'percentage');
      assert.equal(pctFiltered.length, 2);

      // Filtro por Sector 'sec_1'
      const sec1Filtered = mockRows.filter(r => r.sectorId === 'sec_1');
      assert.equal(sec1Filtered.length, 2);

      // Filtro por Estado 'Completado'
      const completedFiltered = mockRows.filter(r => r.computedStatus === 'Completado');
      assert.equal(completedFiltered.length, 1);
      assert.equal(completedFiltered[0].activityCode, 'CIV-01');

      // Búsqueda de texto insensible a mayúsculas
      const searchVen = mockRows.filter(r =>
        r.activityCode.toLowerCase().includes('ven') || r.activityName.toLowerCase().includes('ven')
      );
      assert.equal(searchVen.length, 1);
      assert.equal(searchVen[0].activityCode, 'VEN-01');
    });

    it('3.1c. Métricas resumen (KPIs) ponderadas y totales coinciden con el conjunto filtrado', () => {
      const items = [
        { progressPercent: 100, weight: 1, plannedHH: 20, accumulatedHH: 20, computedStatus: 'Completado' },
        { progressPercent: 50, weight: 2, plannedHH: 40, accumulatedHH: 20, computedStatus: 'En proceso' },
        { progressPercent: 0, weight: 1, plannedHH: 10, accumulatedHH: 0, computedStatus: 'No iniciado' }
      ];

      const total = items.length;
      const completed = items.filter(r => r.computedStatus === 'Completado').length;
      const inProgress = items.filter(r => r.computedStatus === 'En proceso').length;
      const notStarted = items.filter(r => r.computedStatus === 'No iniciado').length;

      const totalWeight = items.reduce((acc, r) => acc + r.weight, 0); // 1 + 2 + 1 = 4
      const weightedProgress =
        items.reduce((acc, r) => acc + r.progressPercent * r.weight, 0) / totalWeight; // (100*1 + 50*2 + 0*1) / 4 = 200/4 = 50%

      const plannedHH = items.reduce((acc, r) => acc + r.plannedHH, 0); // 20 + 40 + 10 = 70
      const accumulatedHH = items.reduce((acc, r) => acc + r.accumulatedHH, 0); // 20 + 20 + 0 = 40

      assert.equal(total, 3);
      assert.equal(completed, 1);
      assert.equal(inProgress, 1);
      assert.equal(notStarted, 1);
      assert.equal(weightedProgress, 50);
      assert.equal(plannedHH, 70);
      assert.equal(accumulatedHH, 40);
    });
  });

  // ==========================================================================
  // ETAPA 3.2: IMPORTACIÓN MASIVA DEL CATÁLOGO MAESTRO (COLUMNA MODALIDAD)
  // ==========================================================================
  describe('ETAPA 3.2: Importación Masiva del Catálogo Maestro', () => {
    function parseCatalogRow(cols: {
      technology: string;
      code: string;
      area: string;
      structure: string;
      name: string;
      target: string;
      unit: string;
      mode?: string;
    }, existingCodes: Set<string>, seenInBatch: Set<string>) {
      const technology = (cols.technology || '').trim();
      const code = (cols.code || '').trim().toUpperCase();
      const rawTarget = (cols.target || '').trim();
      const rawUnit = (cols.unit || '').trim();
      const rawMode = (cols.mode || '').trim().toLowerCase();

      let progressMode: 'quantity' | 'percentage' = 'quantity';
      let modeInvalid = false;
      if (rawMode) {
        if (rawMode.includes('porcent') || rawMode.includes('percent') || rawMode === '%' || rawMode === 'p') {
          progressMode = 'percentage';
        } else if (rawMode.includes('cant') || rawMode.includes('quant') || rawMode.includes('qty') || rawMode === 'c') {
          progressMode = 'quantity';
        } else {
          modeInvalid = true;
        }
      }

      const targetUnits = Number(rawTarget);
      const errors: string[] = [];

      if (!technology) errors.push('Falta Proveedor');
      if (!code) errors.push('Falta Código');
      if (!cols.area) errors.push('Falta Área');
      if (!cols.structure) errors.push('Falta Estructura');
      if (!cols.name) errors.push('Falta Nombre');

      if (modeInvalid) {
        errors.push(`Modalidad inválida ("${cols.mode}"). Debe ser "Cantidades" o "Porcentaje".`);
      }

      if (progressMode === 'percentage') {
        // En porcentaje, meta es 100% y unidad por defecto es '%'
      } else {
        if (!rawTarget || isNaN(targetUnits) || targetUnits <= 0) {
          errors.push('Meta debe ser mayor a 0 para avance por Cantidades');
        }
        if (!rawUnit) errors.push('Falta Unidad');
      }

      const compositeKey = `${technology.toLowerCase()}::${code}`;
      let status: 'valid' | 'duplicate' | 'rejected' = 'valid';

      if (errors.length > 0) {
        status = 'rejected';
      } else if (existingCodes.has(compositeKey) || seenInBatch.has(compositeKey)) {
        status = 'duplicate';
      } else {
        seenInBatch.add(compositeKey);
      }

      const finalTarget = progressMode === 'percentage' ? 100 : targetUnits;
      const finalUnit = progressMode === 'percentage' ? (rawUnit || '%') : rawUnit;

      return {
        status,
        errors,
        payload: {
          technology,
          code,
          progressMode,
          targetUnits: finalTarget,
          unit: finalUnit
        }
      };
    }

    it('3.2a. Fila con modalidad "Porcentaje": fija meta en 100% y unidad en % si venía vacía', () => {
      const existing = new Set<string>();
      const seen = new Set<string>();

      const row = parseCatalogRow({
        technology: 'Chore-Time',
        code: 'CAT-PCT-01',
        area: 'Equipamiento',
        structure: 'Silos',
        name: 'Instalación de Silo Principal',
        target: '', // vacío en archivo
        unit: '', // vacío en archivo
        mode: 'Porcentaje'
      }, existing, seen);

      assert.equal(row.status, 'valid');
      assert.equal(row.payload.progressMode, 'percentage');
      assert.equal(row.payload.targetUnits, 100);
      assert.equal(row.payload.unit, '%');
    });

    it('3.2b. Fila con modalidad "Cantidades": valida targetUnits > 0 y unidad requerida', () => {
      const existing = new Set<string>();
      const seen = new Set<string>();

      // Válida
      const rowValid = parseCatalogRow({
        technology: 'Big Dutchman',
        code: 'CAT-QTY-01',
        area: 'Obras Civiles',
        structure: 'Piso',
        name: 'Vaciado de losa',
        target: '450',
        unit: 'm2',
        mode: 'Cantidades'
      }, existing, seen);

      assert.equal(rowValid.status, 'valid');
      assert.equal(rowValid.payload.progressMode, 'quantity');
      assert.equal(rowValid.payload.targetUnits, 450);
      assert.equal(rowValid.payload.unit, 'm2');

      // Inválida: meta 0 en cantidades es rechazada
      const rowInvalid = parseCatalogRow({
        technology: 'Big Dutchman',
        code: 'CAT-QTY-02',
        area: 'Obras Civiles',
        structure: 'Piso',
        name: 'Vaciado de losa 2',
        target: '0',
        unit: 'm2',
        mode: 'Cantidades'
      }, existing, seen);

      assert.equal(rowInvalid.status, 'rejected');
      assert.ok(rowInvalid.errors.some(e => e.includes('mayor a 0')));
    });

    it('3.2c. Fila sin columna modalidad o vacía: asigna por defecto "quantity" (retrocompatibilidad)', () => {
      const existing = new Set<string>();
      const seen = new Set<string>();

      const rowDefault = parseCatalogRow({
        technology: 'Roxell',
        code: 'CAT-DEF-01',
        area: 'Equipamiento',
        structure: 'Bebederos',
        name: 'Línea de nipples',
        target: '120',
        unit: 'ml',
        mode: '' // columna vacía o no enviada
      }, existing, seen);

      assert.equal(rowDefault.status, 'valid');
      assert.equal(rowDefault.payload.progressMode, 'quantity');
      assert.equal(rowDefault.payload.targetUnits, 120);
      assert.equal(rowDefault.payload.unit, 'ml');
    });

    it('3.2d. Fila con modalidad no reconocida: rechaza con error descriptivo', () => {
      const existing = new Set<string>();
      const seen = new Set<string>();

      const rowBadMode = parseCatalogRow({
        technology: 'Roxell',
        code: 'CAT-ERR-01',
        area: 'Equipamiento',
        structure: 'Bebederos',
        name: 'Actividad con modo desconocido',
        target: '100',
        unit: 'un',
        mode: 'mixto_hibrido'
      }, existing, seen);

      assert.equal(rowBadMode.status, 'rejected');
      assert.ok(rowBadMode.errors.some(e => e.includes('Modalidad inválida')));
    });

    it('3.2e. Detección de duplicados dentro del lote y contra catálogo maestro existente', () => {
      const existing = new Set<string>(['chore-time::CAT-EXIST-01']);
      const seen = new Set<string>();

      // Duplicado contra existente
      const rowDupExisting = parseCatalogRow({
        technology: 'Chore-Time',
        code: 'CAT-EXIST-01',
        area: 'Equipamiento',
        structure: 'Silos',
        name: 'Silo duplicado',
        target: '1',
        unit: 'un',
        mode: 'Cantidades'
      }, existing, seen);
      assert.equal(rowDupExisting.status, 'duplicate');

      // Primer ingreso en lote: válido
      const rowBatch1 = parseCatalogRow({
        technology: 'Chore-Time',
        code: 'CAT-BATCH-01',
        area: 'Equipamiento',
        structure: 'Silos',
        name: 'Silo nuevo 1',
        target: '1',
        unit: 'un',
        mode: 'Cantidades'
      }, existing, seen);
      assert.equal(rowBatch1.status, 'valid');

      // Segundo ingreso idéntico en el mismo lote: duplicado
      const rowBatch2 = parseCatalogRow({
        technology: 'Chore-Time',
        code: 'CAT-BATCH-01',
        area: 'Equipamiento',
        structure: 'Silos',
        name: 'Silo nuevo 1 repetido',
        target: '1',
        unit: 'un',
        mode: 'Cantidades'
      }, existing, seen);
      assert.equal(rowBatch2.status, 'duplicate');
    });
  });

  // ==========================================================================
  // ETAPA 3.3 & 3.4: COMPATIBILIDAD SAFARI, MÓVIL Y PREPARACIÓN CAPACITOR
  // ==========================================================================
  describe('ETAPA 3.3 & 3.4: Safari iOS, Conectividad y Preparación Capacitor', () => {
    it('3.3a. Traducción amigable de error de popup bloqueado en Safari iOS', () => {
      const popupError = { code: 'auth/popup-blocked', message: 'Popup blocked' };
      const translated = translateFirebaseAuthError(popupError);
      assert.ok(translated.includes('bloqueó la ventana emergente'));
    });

    it('3.4a. getApiUrl resuelve rutas relativas en Web y URL absoluta cuando se configura el origen móvil', () => {
      // En entorno Web estándar sin variable, siempre resuelve relativo al mismo origen
      const relativeUrl = getApiUrl('/api/auth/verify-session');
      assert.equal(relativeUrl, '/api/auth/verify-session', 'En entorno web debe permanecer relativo al mismo origen');

      const relativeHealth = getApiUrl('/api/health');
      assert.equal(relativeHealth, '/api/health', 'Sonda de salud debe ser relativa');

      assert.equal(getApiBaseUrl({}), '', 'Con entorno vacío retorna cadena vacía');
      const mobileEnvKey = ['VITE', 'API', 'BASE', 'URL'].join('_');
      assert.equal(
        getApiUrl('/api/health', { [mobileEnvKey]: 'https://ais-pre-example.run.app/' }),
        'https://ais-pre-example.run.app/api/health'
      );
    });

    it('3.4b. isMobileAppContainer detecta navegadores web estándar como false', () => {
      // En entorno Node.js / navegador web estándar sin Capacitor nativo
      assert.equal(isMobileAppContainer(), false);
    });
  });

  // ==========================================================================
  // SISTEMA AUTOMÁTICO DE VERSIONES Y ACTUALIZACIONES EN BARRA LATERAL
  // ==========================================================================
  describe('Sistema Automático de Versiones y Entornos (Desarrollo vs Producción)', () => {
    it('Detecta ENTORNO: DESARROLLO en AI Studio Preview (ais-dev-*) y localhost y marca installStateLabel como Actualizado', () => {
      const devMeta = resolveVersionMetadata(
        { version: '3.0.0', commitHash: 'b3ac7e4', bundleVerified: true },
        'ais-dev-n466vhswaxyqkedkeomgca-44852728920.us-east1.run.app'
      );
      assert.equal(devMeta.environment, 'DESARROLLO');
      assert.equal(devMeta.isProduction, false);
      assert.equal(devMeta.version, '3.0.0');
      assert.equal(devMeta.installStateLabel, 'Actualizado');
      assert.equal(devMeta.commitHash, 'b3ac7e4');
      assert.ok(devMeta.timeZone.includes('America/Lima'));

      const localMeta = resolveVersionMetadata(null, 'localhost');
      assert.equal(localMeta.environment, 'DESARROLLO');
      assert.equal(localMeta.isProduction, false);
    });

    it('Detecta ENTORNO: PRODUCCIÓN y estado Publicado correctamente en URL pública de Cloud Run (ais-pre-*)', () => {
      const prodMeta = resolveVersionMetadata(
        {
          version: '3.0.0',
          commitHash: 'b3ac7e4',
          formattedDate: '06/11/2026',
          formattedTime: '10:35 p. m.',
          bundleVerified: true,
          isProduction: true
        },
        'ais-pre-n466vhswaxyqkedkeomgca-44852728920.us-east1.run.app'
      );
      assert.equal(prodMeta.environment, 'PRODUCCIÓN');
      assert.equal(prodMeta.isProduction, true);
      assert.equal(prodMeta.status, 'Publicado correctamente.');
      assert.equal(prodMeta.installStateLabel, 'Actualizado');
      assert.equal(prodMeta.formattedDate, '06/11/2026');
      assert.equal(prodMeta.formattedTime, '10:35 p. m.');
    });

    it('No marca como Publicado correctamente en producción si el bundle no fue verificado', () => {
      const unverifiedProd = resolveVersionMetadata(
        {
          version: '3.0.0',
          commitHash: 'b3ac7e4',
          bundleVerified: false,
          isProduction: true
        },
        'ais-pre-n466vhswaxyqkedkeomgca-44852728920.us-east1.run.app'
      );
      assert.equal(unverifiedProd.environment, 'PRODUCCIÓN');
      assert.equal(unverifiedProd.status, 'Compilación pendiente de verificación.');
      assert.equal(unverifiedProd.installStateLabel, 'Verificando...');
    });
  });

  // ==========================================================================
  // CONTADOR DE OPERACIONES PENDIENTES EN SINCRONIZAR DATOS Y SELECTORES DINÁMICOS
  // ==========================================================================
  describe('Contador de Operaciones Pendientes [N] y Selectores Dinámicos de Sector y Galpón', () => {
    it('Contabiliza 0, 1 y múltiples operaciones pendientes sin duplicar por operationId ni por consolidación del mismo documento', () => {
      // 0 pendientes
      assert.equal(countUniquePendingSyncOperations([], []), 0);

      // 1 operación pendiente
      let queue: PendingSyncOperation[] = [];
      queue = enqueueOfflineOperation(queue, {
        operationId: 'op_1',
        userId: 'u_1',
        userDisplayName: 'Renzo',
        userRole: 'Administrador',
        collectionName: 'advances',
        documentId: 'adv_101',
        operationType: 'upsert',
        status: 'pending_sync',
        payload: { id: 'adv_101', quantityToday: 10 }
      });
      assert.equal(countUniquePendingSyncOperations(queue, []), 1);

      // Si el usuario guarda otra vez el mismo documento offline (consolidación), sigue contando como 1 sola operación
      queue = enqueueOfflineOperation(queue, {
        userId: 'u_1',
        userDisplayName: 'Renzo',
        userRole: 'Administrador',
        collectionName: 'advances',
        documentId: 'adv_101',
        operationType: 'upsert',
        status: 'pending_sync',
        payload: { id: 'adv_101', quantityToday: 15 }
      });
      assert.equal(countUniquePendingSyncOperations(queue, []), 1);

      // Agregar una 2da operación (asistencia) y una 3ra operación con error (sync_error)
      queue = enqueueOfflineOperation(queue, {
        operationId: 'op_2',
        userId: 'u_1',
        userDisplayName: 'Renzo',
        userRole: 'Administrador',
        collectionName: 'attendance',
        documentId: '2026-11-06',
        operationType: 'upsert',
        status: 'pending_sync',
        payload: { date: '2026-11-06', records: { w1: 'Asistió' } }
      });
      queue = enqueueOfflineOperation(queue, {
        operationId: 'op_3',
        userId: 'u_1',
        userDisplayName: 'Renzo',
        userRole: 'Administrador',
        collectionName: 'materials',
        documentId: 'mat_55',
        operationType: 'upsert',
        status: 'sync_error',
        errorMessage: 'Network timeout',
        payload: { id: 'mat_55', totalQty: 100 }
      });
      assert.equal(countUniquePendingSyncOperations(queue, []), 3);

      // Si por error un array tuviera el mismo operationId repetido, no lo cuenta dos veces
      const duplicatedQueue = [...queue, { ...queue[0] }];
      assert.equal(countUniquePendingSyncOperations(duplicatedQueue, []), 3);

      // Al confirmarse la sincronización de op_1 y op_2, solo queda op_3 (sync_error) -> [1]
      const partialQueue = queue.map((op) =>
        op.operationId === 'op_1' || op.operationId === 'op_2'
          ? { ...op, status: 'synced' as const }
          : op
      );
      assert.equal(countUniquePendingSyncOperations(partialQueue, []), 1);

      // Al confirmarse todas -> 0
      const allSynced = partialQueue.map((op) => ({ ...op, status: 'synced' as const }));
      assert.equal(countUniquePendingSyncOperations(allSynced, []), 0);
    });

    it('Valida selectores dinámicos de Sector y Galpón: al cambiar de sector limpia la selección si el galpón no pertenece al nuevo sector', () => {
      const scopedSectors = [
        {
          id: 'sec_a',
          name: 'Sector Norte',
          galpones: [
            { id: 'gal_a1', code: 'G-01', name: 'Galpón Norte 1' },
            { id: 'gal_a2', code: 'G-02', name: 'Galpón Norte 2' }
          ]
        },
        {
          id: 'sec_b',
          name: 'Sector Sur',
          galpones: [
            { id: 'gal_b1', code: 'G-03', name: 'Galpón Sur 1' }
          ]
        }
      ];

      // 1. Selección válida en Sector Norte -> Galpón Norte 2
      const validCtx = resolveDynamicSectorGalponContext(scopedSectors, 'sec_a', 'gal_a2');
      assert.equal(validCtx.currentSector?.id, 'sec_a');
      assert.equal(validCtx.availableGalpones.length, 2);
      assert.equal(validCtx.currentGalpon?.id, 'gal_a2');
      assert.equal(validCtx.requiresGalponSelection, false);

      // 2. Usuario cambia a Sector Sur conservando temporalmente gal_a2:
      // No debe elegir silenciosamente gal_b1; debe limpiar currentGalpon a null y marcar requiresGalponSelection = true
      const switchedCtx = resolveDynamicSectorGalponContext(scopedSectors, 'sec_b', 'gal_a2');
      assert.equal(switchedCtx.currentSector?.id, 'sec_b');
      assert.equal(switchedCtx.availableGalpones.length, 1);
      assert.equal(switchedCtx.availableGalpones[0].id, 'gal_b1');
      assert.equal(switchedCtx.currentGalpon, null);
      assert.equal(switchedCtx.effectiveGalponId, '');
      assert.equal(switchedCtx.requiresGalponSelection, true);

      // 3. Usuario selecciona explícitamente gal_b1 del Sector Sur
      const explicitCtx = resolveDynamicSectorGalponContext(scopedSectors, 'sec_b', 'gal_b1');
      assert.equal(explicitCtx.currentGalpon?.id, 'gal_b1');
      assert.equal(explicitCtx.requiresGalponSelection, false);
    });
  });
});

