/**
 * Motor de Cálculo Dual de Avance (Cantidades vs. Porcentaje),
 * Cola Persistente Offline e Idempotencia Multiusuario por Galpón
 * Control Galpones La Calera
 */

export type ProgressModality = 'quantity' | 'percentage';

export type ConnectionIndicatorState =
  | 'online'
  | 'offline'
  | 'syncing'
  | 'pending'
  | 'error';

export type LocalOperationSyncStatus =
  | 'saved_locally'
  | 'pending_sync'
  | 'syncing'
  | 'synced'
  | 'sync_error'
  | 'conflict';

export interface PendingSyncOperation {
  operationId: string;
  deviceId: string;
  userId: string;
  userDisplayName: string;
  userRole: string;
  createdAt: string;
  syncedBy?: string;
  syncedByDisplayName?: string;
  syncedAt?: string;
  collectionName:
    | 'advances'
    | 'sectors'
    | 'materials'
    | 'workers'
    | 'attendance'
    | 'masterCatalog'
    | 'settings'
    | 'movements';
  documentId: string;
  operationType: 'upsert' | 'delete';
  sectorId?: string;
  galponId?: string;
  activityId?: string;
  activityCode?: string;
  progressMode?: ProgressModality;
  basePercentage?: number;
  baseTimestamp?: string;
  payload?: any;
  status: LocalOperationSyncStatus;
  errorMessage?: string;
  retryCount: number;
}

export interface SyncConflictRecord {
  id: string;
  operationId: string;
  detectedAt: string;
  collectionName: 'advances' | 'sectors';
  documentId: string;
  sectorId?: string;
  galponId: string;
  galponCode?: string;
  activityId?: string;
  activityCode: string;
  activityName?: string;
  progressMode: ProgressModality;
  localValue: number;
  remoteValue: number;
  localUser: string;
  remoteUser: string;
  localTimestamp: string;
  remoteTimestamp: string;
  localPayload: any;
  remotePayload: any;
  reason: string;
  resolved: boolean;
  resolutionType?: 'keep_remote' | 'apply_local' | 'custom_value';
  resolvedValue?: number;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface ManualSyncSummary {
  executedAt: string;
  triggeredBy: 'manual' | 'auto_reconnect';
  totalProcessed: number;
  syncedCount: number;
  alreadyProcessedCount?: number;
  conflictCount: number;
  errorCount: number;
  remainingPendingCount: number;
  foreignBlockedCount?: number;
  foreignAuthors?: string[];
  message: string;
}

export const OFFLINE_QUEUE_STORAGE_KEY = 'calera_offline_pending_queue_v1';
export const SYNC_CONFLICTS_STORAGE_KEY = 'calera_sync_conflicts_v1';
export const DEVICE_ID_STORAGE_KEY = 'calera_device_id_v1';
export const APP_BUILD_VERSION = '2026.11.05-v2.4-offline-multiuser';

/**
 * Obtiene o genera un identificador único persistente por dispositivo/navegador.
 */
export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return 'srv_device';
  try {
    const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && existing.trim().length > 0) return existing;
    const created = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return `dev_mem_${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * Genera un identificador único de operación idempotente.
 */
export function createOperationId(prefix = 'op'): string {
  const devId = getOrCreateDeviceId().slice(-6);
  return `${prefix}_${Date.now()}_${devId}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Normaliza la modalidad de registro de avance de una actividad.
 * Por defecto todas las actividades existentes sin este campo usan 'quantity' (Avance por Cantidades),
 * garantizando 100 % de compatibilidad retroactiva sin alterar datos históricos.
 */
export function normalizeProgressMode(mode?: string | null): ProgressModality {
  if (!mode) return 'quantity';
  const clean = String(mode).trim().toLowerCase();
  if (
    clean === 'percentage' ||
    clean === 'porcentaje' ||
    clean === 'avance por porcentaje' ||
    clean === '%'
  ) {
    return 'percentage';
  }
  return 'quantity';
}

export function getProgressModeLabel(mode?: string | null): string {
  return normalizeProgressMode(mode) === 'percentage'
    ? 'Avance por Porcentaje'
    : 'Avance por Cantidades';
}

/**
 * Ordena partes diarios de forma determinística del más reciente al más antiguo.
 * Si existen varios registros en la misma fecha, utiliza createdAt / timestamp (fecha y hora)
 * para determinar cuál es el último registro válido.
 */
export function sortAdvanceLogsDescending(logs: any[]): any[] {
  return [...(logs || [])].sort((a, b) => {
    const dateA = String(a?.date || '');
    const dateB = String(b?.date || '');
    if (dateA !== dateB) {
      return dateB.localeCompare(dateA);
    }
    const tsA = String(a?.createdAt || a?.updatedAt || a?.timestamp || '');
    const tsB = String(b?.createdAt || b?.updatedAt || b?.timestamp || '');
    if (tsA !== tsB) {
      return tsB.localeCompare(tsA);
    }
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  });
}

/**
 * Extrae el valor porcentual total alcanzado de un registro de parte diario en modalidad porcentaje.
 */
export function extractLogPercentageValue(log: any): number {
  if (!log) return 0;
  const raw =
    log.percentageReached !== undefined && log.percentageReached !== null
      ? Number(log.percentageReached)
      : Number(log.quantityToday || 0);
  if (isNaN(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

export interface EvaluatedProgressResult {
  progressMode: ProgressModality;
  accumulatedQty: number;
  accumulatedHH: number;
  pendingQty: number;
  progressPercent: number;
  lastValidPercentage: number;
  lastLog: any | null;
  validLogsCount: number;
  conflictedLogsCount: number;
  shouldHaveStarted: boolean;
  computedStatus: string;
}

/**
 * Función pura unificada para evaluar el avance físico de una actividad según su modalidad:
 * - 'quantity' (Avance por Cantidades): suma las cantidades ejecutadas (quantityToday) y calcula (acumulado / meta) * 100.
 * - 'percentage' (Avance por Porcentaje): NO suma porcentajes entre días; toma el último porcentaje total válido alcanzado (0% a 100%)
 *   según fecha y hora (createdAt/timestamp).
 * Ignora registros marcados en estado de conflicto no resuelto ('conflict') para proteger el avance oficial.
 */
export function evaluateActivityProgress(
  activity: any,
  logsForActivity: any[],
  todayStr: string
): EvaluatedProgressResult {
  const progressMode = normalizeProgressMode(activity?.progressMode);
  const allLogs = Array.isArray(logsForActivity) ? logsForActivity : [];
  const validLogs = allLogs.filter((l) => l && l.conflictStatus !== 'conflict');
  const conflictedLogsCount = allLogs.filter(
    (l) => l && l.conflictStatus === 'conflict'
  ).length;

  const sortedValidLogs = sortAdvanceLogsDescending(validLogs);
  const lastLog = sortedValidLogs[0] || null;

  const accumulatedHH = validLogs.reduce(
    (sum, item) => sum + Number(item?.hoursWorked || 0),
    0
  );

  let accumulatedQty = 0;
  let pendingQty = 0;
  let progressPercent = 0;
  let lastValidPercentage = 0;

  if (progressMode === 'percentage') {
    lastValidPercentage = lastLog ? extractLogPercentageValue(lastLog) : 0;
    progressPercent = lastValidPercentage;
    // En modalidad por porcentaje, la meta efectiva representa el 100% total de la actividad
    accumulatedQty = progressPercent;
    pendingQty = Math.max(0, Math.round((100 - progressPercent) * 10) / 10);
  } else {
    accumulatedQty =
      Math.round(
        validLogs.reduce((sum, item) => sum + Number(item?.quantityToday || 0), 0) *
          100
      ) / 100;
    const targetUnits = Number(activity?.targetUnits || 0);
    const rawPct = targetUnits > 0 ? (accumulatedQty / targetUnits) * 100 : 0;
    progressPercent = Math.max(0, Math.min(100, Math.round(rawPct * 10) / 10));
    lastValidPercentage = progressPercent;
    pendingQty = Math.max(
      0,
      Math.round((targetUnits - accumulatedQty) * 100) / 100
    );
  }

  const shouldHaveStarted =
    Boolean(activity?.startDate) &&
    String(activity.startDate) <= todayStr &&
    progressPercent === 0;

  let computedStatus = activity?.status || 'Pendiente';
  if (progressPercent >= 100) computedStatus = 'Completada';
  else if (progressPercent > 0) computedStatus = 'En proceso';
  else if (shouldHaveStarted) computedStatus = 'No iniciada (Alerta)';
  else computedStatus = 'Pendiente';

  return {
    progressMode,
    accumulatedQty,
    accumulatedHH: Math.round(accumulatedHH * 100) / 100,
    pendingQty,
    progressPercent,
    lastValidPercentage,
    lastLog,
    validLogsCount: validLogs.length,
    conflictedLogsCount,
    shouldHaveStarted,
    computedStatus
  };
}

export interface PercentageValidationParams {
  newPercentage: number;
  existingLogsForActivity: any[];
  editingAdvanceId?: string | null;
  isAuthorizedCorrection?: boolean;
  correctionReason?: string;
  userRole?: string;
}

export interface PercentageValidationResult {
  valid: boolean;
  error?: string;
  lastValidPercentage: number;
  requiresAuthorizedCorrection: boolean;
}

const AUTHORIZED_CORRECTION_ROLES = new Set([
  'Administrador',
  'Jefe de proyecto',
  'Supervisor'
]);

export function canUserAuthorizePercentageCorrection(role?: string | null): boolean {
  if (!role) return false;
  return AUTHORIZED_CORRECTION_ROLES.has(role);
}

/**
 * Valida un registro de Avance por Porcentaje según las reglas de negocio:
 * 1. El valor debe estar entre 0% y 100%.
 * 2. El nuevo porcentaje debe ser mayor o igual al último porcentaje válido registrado.
 * 3. No se permite registrar un porcentaje menor salvo que sea una corrección histórica
 *    autorizada por Supervisor / Jefe de proyecto / Administrador con motivo obligatorio.
 */
export function validatePercentageAdvanceRegistration(
  params: PercentageValidationParams
): PercentageValidationResult {
  const {
    newPercentage,
    existingLogsForActivity,
    editingAdvanceId,
    isAuthorizedCorrection,
    correctionReason,
    userRole
  } = params;

  if (isNaN(newPercentage) || newPercentage < 0 || newPercentage > 100) {
    return {
      valid: false,
      error: 'El porcentaje de avance debe estar estrictamente entre 0% y 100%.',
      lastValidPercentage: 0,
      requiresAuthorizedCorrection: false
    };
  }

  const otherValidLogs = (existingLogsForActivity || []).filter(
    (l) =>
      l &&
      l.conflictStatus !== 'conflict' &&
      (!editingAdvanceId || l.id !== editingAdvanceId)
  );
  const sorted = sortAdvanceLogsDescending(otherValidLogs);
  const latestLog = sorted[0] || null;
  const lastValidPercentage = latestLog ? extractLogPercentageValue(latestLog) : 0;

  if (newPercentage < lastValidPercentage) {
    const canAuthorize = canUserAuthorizePercentageCorrection(userRole);
    if (!canAuthorize) {
      return {
        valid: false,
        error: `No se permite registrar un porcentaje menor al último avance válido (${lastValidPercentage}%). Solicite una corrección histórica a un Supervisor, Jefe de proyecto o Administrador.`,
        lastValidPercentage,
        requiresAuthorizedCorrection: true
      };
    }
    if (!isAuthorizedCorrection) {
      return {
        valid: false,
        error: `El porcentaje ingresado (${newPercentage}%) es menor al último porcentaje válido registrado (${lastValidPercentage}%). Si desea realizar una corrección histórica, active la casilla "Autorizar corrección histórica de porcentaje" e indique el motivo.`,
        lastValidPercentage,
        requiresAuthorizedCorrection: true
      };
    }
    if (!correctionReason || correctionReason.trim().length < 4) {
      return {
        valid: false,
        error:
          'Debe ingresar el motivo detallado de la corrección histórica (mínimo 4 caracteres) para registrar un porcentaje menor al anterior.',
        lastValidPercentage,
        requiresAuthorizedCorrection: true
      };
    }
  }

  return {
    valid: true,
    lastValidPercentage,
    requiresAuthorizedCorrection: newPercentage < lastValidPercentage
  };
}

/**
 * Detecta si una operación offline de avance entra en conflicto con los registros ya sincronizados
 * en Firestore por otros usuarios.
 *
 * - En modalidad 'percentage':
 *   Si el usuario A (offline) registró 30% partiendo de una base menor, mientras el usuario B (online)
 *   ya registró 40% en el servidor, NO se sobrescribe silenciosamente el 40% con 30%.
 *   Se detecta el conflicto, se conserva el 40% como avance activo y se registra el conflicto para resolución.
 * - En modalidad 'quantity':
 *   Si dos usuarios registran avances distintos (diferente id/operationId), AMBOS se conservan y suman sin conflicto.
 *   Solo hay conflicto si dos usuarios editaron simultáneamente el MISMO id de parte diario con valores distintos.
 */
export function detectMultiUserAdvanceConflict(params: {
  operation: PendingSyncOperation;
  remoteAdvancesForActivity: any[];
  activityName?: string;
  galponCode?: string;
}): SyncConflictRecord | null {
  const { operation, remoteAdvancesForActivity, activityName, galponCode } = params;
  const localAdv = operation.payload;
  if (!localAdv || operation.operationType !== 'upsert') return null;

  const mode = normalizeProgressMode(
    operation.progressMode || localAdv.progressMode
  );
  const validRemoteLogs = (remoteAdvancesForActivity || []).filter(
    (r) => r && r.conflictStatus !== 'conflict' && r.id !== localAdv.id
  );
  const sortedRemote = sortAdvanceLogsDescending(validRemoteLogs);
  const latestRemote = sortedRemote[0] || null;

  // 1. Verificar edición simultánea del mismo documento de avance
  const sameDocRemote = (remoteAdvancesForActivity || []).find(
    (r) => r && r.id === localAdv.id
  );
  if (
    sameDocRemote &&
    sameDocRemote.operationId &&
    sameDocRemote.operationId !== operation.operationId &&
    operation.baseTimestamp &&
    sameDocRemote.updatedAt &&
    String(sameDocRemote.updatedAt) > String(operation.baseTimestamp)
  ) {
    const localVal =
      mode === 'percentage'
        ? extractLogPercentageValue(localAdv)
        : Number(localAdv.quantityToday || 0);
    const remoteVal =
      mode === 'percentage'
        ? extractLogPercentageValue(sameDocRemote)
        : Number(sameDocRemote.quantityToday || 0);

    if (localVal !== remoteVal) {
      return {
        id: createOperationId('conf'),
        operationId: operation.operationId,
        detectedAt: new Date().toISOString(),
        collectionName: 'advances',
        documentId: localAdv.id,
        sectorId: operation.sectorId,
        galponId: localAdv.galponId,
        galponCode,
        activityId: localAdv.activityId,
        activityCode: localAdv.activityCode,
        activityName,
        progressMode: mode,
        localValue: localVal,
        remoteValue: remoteVal,
        localUser: localAdv.supervisor || operation.userDisplayName,
        remoteUser: sameDocRemote.supervisor || 'Otro usuario en línea',
        localTimestamp: localAdv.createdAt || operation.createdAt,
        remoteTimestamp:
          sameDocRemote.updatedAt || sameDocRemote.createdAt || sameDocRemote.date,
        localPayload: localAdv,
        remotePayload: sameDocRemote,
        reason: `Edición simultánea detectada sobre el mismo parte diario [${localAdv.activityCode}]: valor local (${localVal}) vs. valor en servidor (${remoteVal}).`,
        resolved: false
      };
    }
  }

  // 2. Verificar conflicto de porcentaje cuando otro usuario registró un porcentaje mayor o más reciente
  if (mode === 'percentage' && latestRemote && !localAdv.isAuthorizedCorrection) {
    const localPct = extractLogPercentageValue(localAdv);
    const remotePct = extractLogPercentageValue(latestRemote);
    const basePct =
      operation.basePercentage !== undefined ? Number(operation.basePercentage) : null;

    // Si en el servidor ya existe un porcentaje superior (ej. 40%) al que el usuario registró offline (ej. 30%),
    // o si el porcentaje remoto cambió respecto a la base que tenía el dispositivo offline
    const isLowerThanRemote = localPct < remotePct;
    const remoteAdvancedBeyondBase =
      basePct !== null && remotePct !== basePct && remotePct >= localPct;

    if (isLowerThanRemote || remoteAdvancedBeyondBase) {
      return {
        id: createOperationId('conf'),
        operationId: operation.operationId,
        detectedAt: new Date().toISOString(),
        collectionName: 'advances',
        documentId: localAdv.id,
        sectorId: operation.sectorId,
        galponId: localAdv.galponId,
        galponCode,
        activityId: localAdv.activityId,
        activityCode: localAdv.activityCode,
        activityName,
        progressMode: 'percentage',
        localValue: localPct,
        remoteValue: remotePct,
        localUser: localAdv.supervisor || operation.userDisplayName,
        remoteUser: latestRemote.supervisor || 'Usuario en línea',
        localTimestamp: localAdv.createdAt || operation.createdAt,
        remoteTimestamp:
          latestRemote.createdAt || latestRemote.updatedAt || latestRemote.date,
        localPayload: localAdv,
        remotePayload: latestRemote,
        reason: `Conflicto de Avance por Porcentaje en [${localAdv.activityCode}]: Se intentó sincronizar ${localPct}% registrado offline, pero en el servidor ya consta un avance de ${remotePct}% registrado por ${latestRemote.supervisor || 'otro usuario'}. Se protegió el ${remotePct}% actual sin sobrescribirlo.`,
        resolved: false
      };
    }
  }

  return null;
}

export interface TombstoneEntry {
  deletedAt: string;
  deletedBy?: string;
  operationId?: string;
}

export interface SectorMergeOptions {
  modifiedGalponIds?: string[];
  baseSector?: any | null;
  localUser?: string;
  remoteUser?: string;
  operationId?: string;
}

export interface SectorMergeResult {
  mergedSector: any;
  conflicts: SyncConflictRecord[];
}

function serializeActivityCoreFields(act: any): string {
  if (!act) return '';
  return JSON.stringify({
    code: String(act.code || '').trim().toUpperCase(),
    name: String(act.name || '').trim(),
    progressMode: normalizeProgressMode(act.progressMode),
    locationType: String(act.locationType || 'Interno'),
    sistemaName: act.sistemaName || null,
    structureName: String(act.structureName || '').trim(),
    targetUnits: Number(act.targetUnits || 0),
    unit: String(act.unit || '').trim(),
    weight: Number(act.weight ?? 1),
    plannedHH: Number(act.plannedHH || 0),
    startDate: String(act.startDate || ''),
    dueDate: String(act.dueDate || '')
  });
}

function indexGalponActivitiesById(galpon: any): Map<string, any> {
  const map = new Map<string, any>();
  if (!galpon || !Array.isArray(galpon.areas)) return map;
  for (const area of galpon.areas) {
    if (area?.hasSistemas && Array.isArray(area.sistemas)) {
      for (const sis of area.sistemas) {
        for (const str of sis?.structures || []) {
          for (const act of str?.activities || []) {
            if (act?.id) map.set(act.id, act);
          }
        }
      }
    } else if (Array.isArray(area?.structures)) {
      for (const str of area.structures) {
        for (const act of str?.activities || []) {
          if (act?.id) map.set(act.id, act);
        }
      }
    }
  }
  return map;
}

function mergeTombstoneMaps(
  mapA?: Record<string, TombstoneEntry>,
  mapB?: Record<string, TombstoneEntry>
): Record<string, TombstoneEntry> {
  const out: Record<string, TombstoneEntry> = { ...(mapA || {}) };
  for (const [id, entry] of Object.entries(mapB || {})) {
    const existing = out[id];
    if (!existing || String(entry?.deletedAt || '') >= String(existing.deletedAt || '')) {
      out[id] = entry;
    }
  }
  return out;
}

function isDeletedByTombstone(
  itemId: string,
  itemUpdatedAt: string | undefined,
  tombstones: Record<string, TombstoneEntry>
): boolean {
  const tomb = tombstones[itemId];
  if (!tomb) return false;
  if (!itemUpdatedAt) return true;
  return String(tomb.deletedAt || '') >= String(itemUpdatedAt);
}

/**
 * Registra explícitamente un tombstone de actividad eliminada en el galpón correspondiente.
 */
export function recordActivityDeletionTombstone(
  galpon: any,
  activityId: string,
  deletedBy?: string,
  deletedAt = new Date().toISOString()
): any {
  if (!galpon || !activityId) return galpon;
  const existingTombstones: Record<string, TombstoneEntry> = {
    ...(galpon.deletedActivityTombstones || {})
  };
  existingTombstones[activityId] = {
    deletedAt,
    deletedBy: deletedBy || 'usuario'
  };
  return {
    ...galpon,
    deletedActivityTombstones: existingTombstones
  };
}

/**
 * Registra explícitamente un tombstone de galpón eliminado en el sector correspondiente.
 */
export function recordGalponDeletionTombstone(
  sector: any,
  galponId: string,
  deletedBy?: string,
  deletedAt = new Date().toISOString()
): any {
  if (!sector || !galponId) return sector;
  const existingTombstones: Record<string, TombstoneEntry> = {
    ...(sector.deletedGalponTombstones || {})
  };
  existingTombstones[galponId] = {
    deletedAt,
    deletedBy: deletedBy || 'usuario'
  };
  return {
    ...sector,
    deletedGalponTombstones: existingTombstones
  };
}

function mergeActivitiesListDeep(params: {
  localActivities: any[];
  remoteActivities: any[];
  baseActivitiesMap: Map<string, any>;
  hasBaseReference: boolean;
  activityTombstones: Record<string, TombstoneEntry>;
  sectorId: string;
  galponId: string;
  galponCode?: string;
  localUser?: string;
  remoteUser?: string;
  operationId?: string;
  conflicts: SyncConflictRecord[];
}): any[] {
  const {
    localActivities,
    remoteActivities,
    baseActivitiesMap,
    hasBaseReference,
    activityTombstones,
    sectorId,
    galponId,
    galponCode,
    localUser,
    remoteUser,
    operationId,
    conflicts
  } = params;

  const localMap = new Map<string, any>();
  for (const act of localActivities || []) {
    if (act?.id) localMap.set(act.id, act);
  }
  const remoteMap = new Map<string, any>();
  for (const act of remoteActivities || []) {
    if (act?.id) remoteMap.set(act.id, act);
  }

  // Preservar el orden: primero las actividades remotas/existentes y luego las nuevas locales
  const allActIds = Array.from(
    new Set([...remoteMap.keys(), ...localMap.keys()])
  );

  const mergedActivities: any[] = [];

  for (const actId of allActIds) {
    const localAct = localMap.get(actId);
    const remoteAct = remoteMap.get(actId);
    const baseAct = baseActivitiesMap.get(actId);

    const candidateUpdatedAt =
      localAct?.updatedAt || remoteAct?.updatedAt || undefined;

    if (isDeletedByTombstone(actId, candidateUpdatedAt, activityTombstones)) {
      continue;
    }

    // Si estaba en baseAct pero ya no está en localAct, fue eliminada localmente
    if (hasBaseReference && baseAct && !localAct) {
      continue;
    }
    // Si estaba en baseAct pero ya no está en remoteAct, fue eliminada remotamente
    if (hasBaseReference && baseAct && !remoteAct) {
      continue;
    }

    // Caso 1: Actividad agregada solo localmente
    if (localAct && !remoteAct) {
      mergedActivities.push(localAct);
      continue;
    }

    // Caso 2: Actividad agregada solo remotamente
    if (!localAct && remoteAct) {
      mergedActivities.push(remoteAct);
      continue;
    }

    // Caso 3: Actividad existe en ambos (localAct y remoteAct)
    if (localAct && remoteAct) {
      const localSerialized = serializeActivityCoreFields(localAct);
      const remoteSerialized = serializeActivityCoreFields(remoteAct);

      if (localSerialized === remoteSerialized) {
        // Sin diferencias de contenido: conservar versión más reciente de metadatos
        const pickLocal =
          String(localAct.updatedAt || '') > String(remoteAct.updatedAt || '');
        mergedActivities.push(pickLocal ? localAct : remoteAct);
        continue;
      }

      if (hasBaseReference && baseAct) {
        const baseSerialized = serializeActivityCoreFields(baseAct);
        const localChanged = localSerialized !== baseSerialized;
        const remoteChanged = remoteSerialized !== baseSerialized;

        if (localChanged && !remoteChanged) {
          mergedActivities.push(localAct);
          continue;
        }
        if (!localChanged && remoteChanged) {
          mergedActivities.push(remoteAct);
          continue;
        }
        // Si ambos cambiaron respecto a la misma base con valores distintos -> Conflicto
      } else {
        // Sin objeto base completo: verificar marcas de tiempo baseUpdatedAt / updatedAt
        const localUpdated = localAct.updatedAt ? String(localAct.updatedAt) : '';
        const remoteUpdated = remoteAct.updatedAt ? String(remoteAct.updatedAt) : '';
        const localBaseUpdated = localAct.baseUpdatedAt
          ? String(localAct.baseUpdatedAt)
          : '';

        // Si local no tiene marca de edición posterior y remoto sí, prevalece remoto
        if (!localUpdated && remoteUpdated) {
          mergedActivities.push(remoteAct);
          continue;
        }
        // Si local fue editado partiendo exactamente de la versión remota actual, prevalece local
        if (
          localUpdated &&
          (!remoteUpdated ||
            (localBaseUpdated && localBaseUpdated === remoteUpdated))
        ) {
          mergedActivities.push(localAct);
          continue;
        }
      }

      // Conflicto real: Dos usuarios modificaron simultáneamente la misma actividad con valores distintos
      conflicts.push({
        id: createOperationId('conf_act'),
        operationId: operationId || localAct.operationId || createOperationId('op_act'),
        detectedAt: new Date().toISOString(),
        collectionName: 'sectors',
        documentId: sectorId,
        sectorId,
        galponId,
        galponCode: galponCode || galponId,
        activityId: actId,
        activityCode: localAct.code || remoteAct.code || actId,
        activityName: localAct.name || remoteAct.name || 'Actividad',
        progressMode: normalizeProgressMode(
          localAct.progressMode || remoteAct.progressMode
        ),
        localValue: Number(localAct.targetUnits || 0),
        remoteValue: Number(remoteAct.targetUnits || 0),
        localUser:
          localAct.updatedBy || localUser || 'Usuario en este dispositivo',
        remoteUser: remoteAct.updatedBy || remoteUser || 'Otro usuario en servidor',
        localTimestamp: localAct.updatedAt || new Date().toISOString(),
        remoteTimestamp: remoteAct.updatedAt || new Date().toISOString(),
        localPayload: localAct,
        remotePayload: remoteAct,
        reason: `Conflicto de edición simultánea en la actividad [${localAct.code || remoteAct.code}] (ID: ${actId}): el usuario local modificó "${localAct.name}" (Meta: ${localAct.targetUnits} ${localAct.unit || ''}, Peso: ${localAct.weight ?? 1}) mientras otro usuario guardó "${remoteAct.name}" (Meta: ${remoteAct.targetUnits} ${remoteAct.unit || ''}, Peso: ${remoteAct.weight ?? 1}). Se conservó la versión en servidor pendiente de resolución autorizada.`,
        resolved: false
      });

      // No se aplica last-write-wins ciego: se protege la versión del servidor hasta resolución autorizada
      mergedActivities.push(remoteAct);
    }
  }

  return mergedActivities;
}

function mergeStructuresListDeep(params: {
  localStructures: any[];
  remoteStructures: any[];
  baseActivitiesMap: Map<string, any>;
  hasBaseReference: boolean;
  activityTombstones: Record<string, TombstoneEntry>;
  sectorId: string;
  galponId: string;
  galponCode?: string;
  localUser?: string;
  remoteUser?: string;
  operationId?: string;
  conflicts: SyncConflictRecord[];
}): any[] {
  const { localStructures, remoteStructures } = params;
  const mergedList: any[] = [];
  const consumedLocalIndices = new Set<number>();

  // 1. Emparejar estructuras remotas con locales por ID estable (o por nombre canónico si se crearon en paralelo)
  for (const remStr of remoteStructures || []) {
    if (!remStr) continue;
    let matchIdx = (localStructures || []).findIndex(
      (locStr, idx) =>
        !consumedLocalIndices.has(idx) &&
        locStr &&
        remStr.id &&
        locStr.id === remStr.id
    );
    if (matchIdx < 0 && remStr.name) {
      const cleanName = String(remStr.name).trim().toLowerCase();
      matchIdx = (localStructures || []).findIndex(
        (locStr, idx) =>
          !consumedLocalIndices.has(idx) &&
          locStr &&
          String(locStr.name || '').trim().toLowerCase() === cleanName
      );
    }

    if (matchIdx >= 0) {
      consumedLocalIndices.add(matchIdx);
      const locStr = localStructures[matchIdx];
      const mergedActivities = mergeActivitiesListDeep({
        ...params,
        localActivities: locStr.activities || [],
        remoteActivities: remStr.activities || []
      });
      mergedList.push({
        ...remStr,
        ...locStr,
        id: remStr.id || locStr.id,
        name: locStr.name || remStr.name,
        activities: mergedActivities
      });
    } else {
      const filteredRemoteActs = mergeActivitiesListDeep({
        ...params,
        localActivities: [],
        remoteActivities: remStr.activities || []
      });
      mergedList.push({
        ...remStr,
        activities: filteredRemoteActs
      });
    }
  }

  // 2. Agregar estructuras creadas únicamente de forma local
  (localStructures || []).forEach((locStr, idx) => {
    if (consumedLocalIndices.has(idx) || !locStr) return;
    const filteredLocalActs = mergeActivitiesListDeep({
      ...params,
      localActivities: locStr.activities || [],
      remoteActivities: []
    });
    mergedList.push({
      ...locStr,
      activities: filteredLocalActs
    });
  });

  return mergedList;
}

function mergeSistemasListDeep(params: {
  localSistemas: any[];
  remoteSistemas: any[];
  baseActivitiesMap: Map<string, any>;
  hasBaseReference: boolean;
  activityTombstones: Record<string, TombstoneEntry>;
  sectorId: string;
  galponId: string;
  galponCode?: string;
  localUser?: string;
  remoteUser?: string;
  operationId?: string;
  conflicts: SyncConflictRecord[];
}): any[] {
  const { localSistemas, remoteSistemas } = params;
  const mergedList: any[] = [];
  const consumedLocalIndices = new Set<number>();

  for (const remSis of remoteSistemas || []) {
    if (!remSis) continue;
    let matchIdx = (localSistemas || []).findIndex(
      (locSis, idx) =>
        !consumedLocalIndices.has(idx) &&
        locSis &&
        remSis.id &&
        locSis.id === remSis.id
    );
    if (matchIdx < 0 && remSis.name) {
      const remName = String(remSis.name).trim().toLowerCase();
      const remLoc = String(remSis.locationType || 'Interno');
      matchIdx = (localSistemas || []).findIndex(
        (locSis, idx) =>
          !consumedLocalIndices.has(idx) &&
          locSis &&
          String(locSis.name || '').trim().toLowerCase() === remName &&
          String(locSis.locationType || 'Interno') === remLoc
      );
    }

    if (matchIdx >= 0) {
      consumedLocalIndices.add(matchIdx);
      const locSis = localSistemas[matchIdx];
      const mergedStructures = mergeStructuresListDeep({
        ...params,
        localStructures: locSis.structures || [],
        remoteStructures: remSis.structures || []
      });
      mergedList.push({
        ...remSis,
        ...locSis,
        id: remSis.id || locSis.id,
        name: locSis.name || remSis.name,
        locationType: locSis.locationType || remSis.locationType || 'Interno',
        structures: mergedStructures
      });
    } else {
      const mergedStructures = mergeStructuresListDeep({
        ...params,
        localStructures: [],
        remoteStructures: remSis.structures || []
      });
      mergedList.push({
        ...remSis,
        structures: mergedStructures
      });
    }
  }

  (localSistemas || []).forEach((locSis, idx) => {
    if (consumedLocalIndices.has(idx) || !locSis) return;
    const mergedStructures = mergeStructuresListDeep({
      ...params,
      localStructures: locSis.structures || [],
      remoteStructures: []
    });
    mergedList.push({
      ...locSis,
      structures: mergedStructures
    });
  });

  return mergedList;
}

function mergeGalponAreasDeep(params: {
  localGalpon: any;
  remoteGalpon: any;
  baseGalpon?: any | null;
  sectorId: string;
  localUser?: string;
  remoteUser?: string;
  operationId?: string;
  conflicts: SyncConflictRecord[];
}): any {
  const {
    localGalpon,
    remoteGalpon,
    baseGalpon,
    sectorId,
    localUser,
    remoteUser,
    operationId,
    conflicts
  } = params;

  const baseActivitiesMap = indexGalponActivitiesById(baseGalpon);
  const localActivitiesMap = indexGalponActivitiesById(localGalpon);
  const hasBaseReference = Boolean(baseGalpon);

  // Construir mapa combinado de tombstones de actividades (explícitos + inferidos respecto a baseGalpon)
  const inferredTombstones: Record<string, TombstoneEntry> = {};
  if (hasBaseReference) {
    for (const baseActId of baseActivitiesMap.keys()) {
      if (!localActivitiesMap.has(baseActId)) {
        inferredTombstones[baseActId] = {
          deletedAt: new Date().toISOString(),
          deletedBy: localUser || 'local'
        };
      }
    }
  }

  const activityTombstones = mergeTombstoneMaps(
    mergeTombstoneMaps(
      remoteGalpon?.deletedActivityTombstones,
      localGalpon?.deletedActivityTombstones
    ),
    inferredTombstones
  );

  const localAreas: any[] = Array.isArray(localGalpon?.areas)
    ? localGalpon.areas
    : [];
  const remoteAreas: any[] = Array.isArray(remoteGalpon?.areas)
    ? remoteGalpon.areas
    : [];

  const mergedAreas: any[] = [];
  const consumedLocalIndices = new Set<number>();

  for (const remArea of remoteAreas) {
    if (!remArea) continue;
    let matchIdx = localAreas.findIndex(
      (locArea, idx) =>
        !consumedLocalIndices.has(idx) &&
        locArea &&
        remArea.id &&
        locArea.id === remArea.id
    );
    if (matchIdx < 0 && remArea.name) {
      const remAreaName = String(remArea.name).trim().toLowerCase();
      matchIdx = localAreas.findIndex(
        (locArea, idx) =>
          !consumedLocalIndices.has(idx) &&
          locArea &&
          String(locArea.name || '').trim().toLowerCase() === remAreaName
      );
    }

    if (matchIdx >= 0) {
      consumedLocalIndices.add(matchIdx);
      const locArea = localAreas[matchIdx];
      const hasSistemas = Boolean(locArea.hasSistemas ?? remArea.hasSistemas);

      if (hasSistemas) {
        const mergedSistemas = mergeSistemasListDeep({
          localSistemas: locArea.sistemas || [],
          remoteSistemas: remArea.sistemas || [],
          baseActivitiesMap,
          hasBaseReference,
          activityTombstones,
          sectorId,
          galponId: remoteGalpon.id || localGalpon.id,
          galponCode: localGalpon.code || remoteGalpon.code,
          localUser,
          remoteUser,
          operationId,
          conflicts
        });
        mergedAreas.push({
          ...remArea,
          ...locArea,
          id: remArea.id || locArea.id,
          name: locArea.name || remArea.name,
          hasSistemas: true,
          sistemas: mergedSistemas
        });
      } else {
        const mergedStructures = mergeStructuresListDeep({
          localStructures: locArea.structures || [],
          remoteStructures: remArea.structures || [],
          baseActivitiesMap,
          hasBaseReference,
          activityTombstones,
          sectorId,
          galponId: remoteGalpon.id || localGalpon.id,
          galponCode: localGalpon.code || remoteGalpon.code,
          localUser,
          remoteUser,
          operationId,
          conflicts
        });
        mergedAreas.push({
          ...remArea,
          ...locArea,
          id: remArea.id || locArea.id,
          name: locArea.name || remArea.name,
          hasSistemas: false,
          structures: mergedStructures
        });
      }
    } else {
      const hasSistemas = Boolean(remArea.hasSistemas);
      if (hasSistemas) {
        mergedAreas.push({
          ...remArea,
          sistemas: mergeSistemasListDeep({
            localSistemas: [],
            remoteSistemas: remArea.sistemas || [],
            baseActivitiesMap,
            hasBaseReference,
            activityTombstones,
            sectorId,
            galponId: remoteGalpon.id || localGalpon.id,
            galponCode: localGalpon?.code || remoteGalpon?.code,
            localUser,
            remoteUser,
            operationId,
            conflicts
          })
        });
      } else {
        mergedAreas.push({
          ...remArea,
          structures: mergeStructuresListDeep({
            localStructures: [],
            remoteStructures: remArea.structures || [],
            baseActivitiesMap,
            hasBaseReference,
            activityTombstones,
            sectorId,
            galponId: remoteGalpon.id || localGalpon.id,
            galponCode: localGalpon?.code || remoteGalpon?.code,
            localUser,
            remoteUser,
            operationId,
            conflicts
          })
        });
      }
    }
  }

  localAreas.forEach((locArea, idx) => {
    if (consumedLocalIndices.has(idx) || !locArea) return;
    const hasSistemas = Boolean(locArea.hasSistemas);
    if (hasSistemas) {
      mergedAreas.push({
        ...locArea,
        sistemas: mergeSistemasListDeep({
          localSistemas: locArea.sistemas || [],
          remoteSistemas: [],
          baseActivitiesMap,
          hasBaseReference,
          activityTombstones,
          sectorId,
          galponId: localGalpon.id || remoteGalpon?.id,
          galponCode: localGalpon.code || remoteGalpon?.code,
          localUser,
          remoteUser,
          operationId,
          conflicts
        })
      });
    } else {
      mergedAreas.push({
        ...locArea,
        structures: mergeStructuresListDeep({
          localStructures: locArea.structures || [],
          remoteStructures: [],
          baseActivitiesMap,
          hasBaseReference,
          activityTombstones,
          sectorId,
          galponId: localGalpon.id || remoteGalpon?.id,
          galponCode: localGalpon.code || remoteGalpon?.code,
          localUser,
          remoteUser,
          operationId,
          conflicts
        })
      });
    }
  });

  return {
    ...remoteGalpon,
    ...localGalpon,
    id: remoteGalpon?.id || localGalpon?.id,
    areas: mergedAreas,
    ...(Object.keys(activityTombstones).length > 0
      ? { deletedActivityTombstones: activityTombstones }
      : {})
  };
}

/**
 * C-1: Fusión profunda multinivel (Sector -> Galpón -> Área -> Sistema -> Estructura -> Actividad)
 * con soporte de Tombstones para eliminaciones y detección de conflictos de edición simultánea
 * sobre la misma actividad.
 */
export function mergeSectorDeepWithConflicts(
  localSector: any,
  remoteSector: any | null,
  options: SectorMergeOptions = {}
): SectorMergeResult {
  const conflicts: SyncConflictRecord[] = [];
  if (!remoteSector) {
    return { mergedSector: localSector, conflicts };
  }
  if (!localSector) {
    return { mergedSector: remoteSector, conflicts };
  }

  const {
    modifiedGalponIds,
    baseSector,
    localUser,
    remoteUser,
    operationId
  } = options;

  const remoteGalpones: any[] = Array.isArray(remoteSector.galpones)
    ? remoteSector.galpones
    : [];
  const localGalpones: any[] = Array.isArray(localSector.galpones)
    ? localSector.galpones
    : [];
  const baseGalpones: any[] = Array.isArray(baseSector?.galpones)
    ? baseSector.galpones
    : [];

  const remoteMap = new Map(remoteGalpones.map((g) => [g.id, g]));
  const localMap = new Map(localGalpones.map((g) => [g.id, g]));
  const baseMap = new Map(baseGalpones.map((g) => [g.id, g]));

  // Inferir tombstones de galpones eliminados respecto a baseSector o modifiedGalponIds
  const inferredGalponTombstones: Record<string, TombstoneEntry> = {};
  if (baseSector) {
    for (const baseGId of baseMap.keys()) {
      if (!localMap.has(baseGId)) {
        inferredGalponTombstones[baseGId] = {
          deletedAt: new Date().toISOString(),
          deletedBy: localUser || 'local'
        };
      }
    }
  }
  if (modifiedGalponIds && modifiedGalponIds.length > 0) {
    for (const modGId of modifiedGalponIds) {
      if (!localMap.has(modGId) && remoteMap.has(modGId)) {
        inferredGalponTombstones[modGId] = {
          deletedAt: new Date().toISOString(),
          deletedBy: localUser || 'local'
        };
      }
    }
  }

  const galponTombstones = mergeTombstoneMaps(
    mergeTombstoneMaps(
      remoteSector.deletedGalponTombstones,
      localSector.deletedGalponTombstones
    ),
    inferredGalponTombstones
  );

  const modSet =
    modifiedGalponIds && modifiedGalponIds.length > 0
      ? new Set(modifiedGalponIds)
      : null;

  const allGalponIds = Array.from(
    new Set([
      ...remoteGalpones.map((g) => g.id),
      ...localGalpones.map((g) => g.id)
    ])
  );

  const mergedGalpones: any[] = [];

  for (const gId of allGalponIds) {
    const localG = localMap.get(gId);
    const remoteG = remoteMap.get(gId);
    const baseG = baseMap.get(gId);

    const gUpdatedAt = localG?.updatedAt || remoteG?.updatedAt || undefined;
    if (isDeletedByTombstone(gId, gUpdatedAt, galponTombstones)) {
      continue;
    }

    // Si estaba en baseSector pero fue eliminado en remoteSector
    if (baseSector && baseG && !remoteG) {
      continue;
    }

    // Si se especificaron galpones modificados y este galpón NO fue tocado localmente, conservar remoto intacto
    if (modSet && !modSet.has(gId)) {
      if (remoteG) {
        mergedGalpones.push(remoteG);
      } else if (localG && !baseSector) {
        mergedGalpones.push(localG);
      }
      continue;
    }

    if (localG && !remoteG) {
      mergedGalpones.push(localG);
    } else if (!localG && remoteG) {
      mergedGalpones.push(remoteG);
    } else if (localG && remoteG) {
      // Ambos usuarios tienen el mismo Galpón: ejecutar fusión profunda por Área -> Sistema -> Estructura -> Actividad
      const mergedG = mergeGalponAreasDeep({
        localGalpon: localG,
        remoteGalpon: remoteG,
        baseGalpon: baseG,
        sectorId: localSector.id || remoteSector.id,
        localUser,
        remoteUser,
        operationId,
        conflicts
      });
      mergedGalpones.push(mergedG);
    }
  }

  const mergedSector = {
    ...remoteSector,
    ...localSector,
    id: remoteSector.id || localSector.id,
    galpones: mergedGalpones,
    ...(Object.keys(galponTombstones).length > 0
      ? { deletedGalponTombstones: galponTombstones }
      : {})
  };

  return { mergedSector, conflicts };
}

/**
 * Wrapper compatible hacia atrás que retorna el sector fusionado profundamente por Galpón y Actividad.
 */
export function mergeSectorGalponesIsolated(
  localSector: any,
  remoteSector: any | null,
  modifiedGalponIds?: string[],
  baseSector?: any | null
): any {
  return mergeSectorDeepWithConflicts(localSector, remoteSector, {
    modifiedGalponIds,
    baseSector
  }).mergedSector;
}

/**
 * Aplica la resolución autorizada de un conflicto de actividad directamente sobre la lista de sectores.
 */
export function applyActivityConflictResolutionToSector(
  sector: any,
  conflict: SyncConflictRecord,
  resolutionType: 'keep_remote' | 'apply_local' | 'custom_value',
  customValue?: number
): any {
  if (!sector || sector.id !== conflict.documentId) return sector;
  if (resolutionType === 'keep_remote') return sector;

  const targetActId = conflict.activityId;
  const replacementBase = conflict.localPayload || conflict.remotePayload;
  if (!targetActId || !replacementBase) return sector;

  const nowIso = new Date().toISOString();
  const resolvedAct = {
    ...replacementBase,
    ...(resolutionType === 'custom_value' && customValue !== undefined
      ? { targetUnits: Number(customValue) }
      : {}),
    updatedAt: nowIso
  };

  return {
    ...sector,
    updatedAt: nowIso,
    galpones: (sector.galpones || []).map((g: any) => {
      if (g.id !== conflict.galponId) return g;
      return {
        ...g,
        updatedAt: nowIso,
        areas: (g.areas || []).map((area: any) => {
          if (area.hasSistemas && Array.isArray(area.sistemas)) {
            return {
              ...area,
              sistemas: area.sistemas.map((sis: any) => ({
                ...sis,
                structures: (sis.structures || []).map((str: any) => ({
                  ...str,
                  activities: (str.activities || []).map((act: any) =>
                    act.id === targetActId ? resolvedAct : act
                  )
                }))
              }))
            };
          }
          return {
            ...area,
            structures: (area.structures || []).map((str: any) => ({
              ...str,
              activities: (str.activities || []).map((act: any) =>
                act.id === targetActId ? resolvedAct : act
              )
            }))
          };
        })
      };
    })
  };
}

/**
 * Fusiona los registros de asistencia de un día por operario individual (workerId),
 * evitando que el control de asistencia del Galpón 1 sobrescriba la asistencia del Galpón 2.
 */
export function mergeAttendanceDayIsolated(
  remoteRecords: Record<string, string> | undefined,
  localRecords: Record<string, string> | undefined
): Record<string, string> {
  return {
    ...(remoteRecords || {}),
    ...(localRecords || {})
  };
}

/**
 * C-2: Reconstruye de forma determinística cualquier colección documental estándar
 * ('materials' | 'workers' | 'masterCatalog' | 'advances' | 'movements') combinando
 * los datos remotos de Firestore con las operaciones pendientes o con error en la cola offline,
 * respetando estrictamente el orden cronológico (createdAt), altas, modificaciones y eliminaciones,
 * sin duplicar registros y manteniendo separados los estados 'synced', 'pending_sync' y 'sync_error'.
 */
export function isRecordSoftDeleted(
  item: any,
  collectionName?: PendingSyncOperation['collectionName']
): boolean {
  if (!item || typeof item !== 'object') return true;
  if (item.deleted === true || item.isDeleted === true) return true;
  if (
    item.deletedAt !== undefined &&
    item.deletedAt !== null &&
    String(item.deletedAt).trim() !== ''
  ) {
    return true;
  }
  if (collectionName === 'masterCatalog' && item.active === false) {
    return true;
  }
  return false;
}

export function reconstructCollectionWithOfflineQueue<T extends { id: string }>(
  remoteItems: T[],
  queue: PendingSyncOperation[],
  collectionName: PendingSyncOperation['collectionName']
): Array<T & { syncState?: string; pendingOperationId?: string }> {
  const map = new Map<string, T>();
  for (const item of remoteItems || []) {
    if (item && item.id && !isRecordSoftDeleted(item, collectionName)) {
      map.set(item.id, {
        ...item,
        syncState: (item as any).syncState || 'synced'
      });
    }
  }

  const relevantOps = (queue || [])
    .filter(
      (op) =>
        op &&
        op.collectionName === collectionName &&
        op.status !== 'synced' &&
        op.status !== 'conflict'
    )
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  for (const op of relevantOps) {
    if (op.operationType === 'delete') {
      map.delete(op.documentId);
    } else if (op.operationType === 'upsert' && op.payload) {
      if (isRecordSoftDeleted(op.payload, collectionName)) {
        map.delete(op.documentId);
        continue;
      }
      const existing = map.get(op.documentId);
      const syncState =
        op.status === 'sync_error' ? 'sync_error' : 'pending_sync';
      map.set(op.documentId, {
        ...(existing || {}),
        ...op.payload,
        id: op.documentId,
        syncState,
        pendingOperationId: op.operationId
      } as T);
    }
  }

  return Array.from(map.values());
}

/**
 * C-2: Reconstruye la colección de Sectores y Galpones aplicando en orden cronológico
 * todas las operaciones pendientes de la cola offline sobre los sectores remotos usando
 * la fusión profunda por actividad y respetando eliminaciones (tombstones y deletes).
 */
export function reconstructSectorsWithOfflineQueue(
  remoteSectors: any[],
  queue: PendingSyncOperation[]
): any[] {
  const map = new Map<string, any>();
  for (const sec of remoteSectors || []) {
    if (sec && sec.id) {
      map.set(sec.id, {
        ...sec,
        syncState: sec.syncState || 'synced'
      });
    }
  }

  const sectorOps = (queue || [])
    .filter(
      (op) =>
        op &&
        op.collectionName === 'sectors' &&
        op.status !== 'synced' &&
        op.status !== 'conflict'
    )
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  for (const op of sectorOps) {
    if (op.operationType === 'delete') {
      map.delete(op.documentId);
    } else if (op.operationType === 'upsert' && op.payload) {
      const existingRemote = map.get(op.documentId) || null;
      const merged = mergeSectorGalponesIsolated(
        op.payload,
        existingRemote,
        op.galponId ? [op.galponId] : undefined
      );
      map.set(op.documentId, {
        ...merged,
        id: op.documentId,
        syncState: op.status === 'sync_error' ? 'sync_error' : 'pending_sync',
        pendingOperationId: op.operationId
      });
    }
  }

  return Array.from(map.values());
}

/**
 * C-2: Reconstruye el mapa de Asistencia Diaria aplicando en orden cronológico
 * las operaciones pendientes en la cola offline por operario individual.
 */
export function reconstructAttendanceWithOfflineQueue(
  remoteAttendance: Record<string, Record<string, string>>,
  queue: PendingSyncOperation[]
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [dateKey, records] of Object.entries(remoteAttendance || {})) {
    result[dateKey] = { ...(records || {}) };
  }

  const attOps = (queue || [])
    .filter(
      (op) =>
        op &&
        op.collectionName === 'attendance' &&
        op.status !== 'synced' &&
        op.status !== 'conflict'
    )
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  for (const op of attOps) {
    if (op.operationType === 'delete') {
      delete result[op.documentId];
    } else if (op.operationType === 'upsert' && op.payload) {
      const dateKey = op.payload.date || op.documentId;
      result[dateKey] = mergeAttendanceDayIsolated(
        result[dateKey],
        op.payload.records || {}
      );
    }
  }

  return result;
}

/**
 * C-2: Reconstruye la lista de proveedores/plantillas aplicando la cola offline.
 */
export function reconstructProvidersWithOfflineQueue(
  remoteTechnologies: string[],
  queue: PendingSyncOperation[]
): string[] {
  const set = new Set<string>(
    (remoteTechnologies || []).map((t) => String(t || '').trim()).filter(Boolean)
  );

  const provOps = (queue || [])
    .filter(
      (op) =>
        op &&
        op.collectionName === 'settings' &&
        op.status !== 'synced' &&
        op.status !== 'conflict'
    )
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  for (const op of provOps) {
    if (op.operationType === 'delete') {
      // Buscar por nombre en payload o coincidencia de ID
      if (op.payload?.name) {
        set.delete(String(op.payload.name).trim());
      }
    } else if (op.operationType === 'upsert' && op.payload) {
      if (typeof op.payload.name === 'string' && op.payload.name.trim()) {
        set.add(op.payload.name.trim());
      } else if (Array.isArray(op.payload.technologies)) {
        op.payload.technologies.forEach((t: string) => {
          if (t && String(t).trim()) set.add(String(t).trim());
        });
      }
    }
  }

  return Array.from(set);
}

/**
 * Persistencia segura de la cola de operaciones pendientes en localStorage.
 */
export function loadPendingSyncQueue(): PendingSyncOperation[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePendingSyncQueue(queue: PendingSyncOperation[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch (err) {
    console.error('[OfflineQueue] Error guardando cola local:', err);
  }
}

/**
 * Agrega o actualiza una operación en la cola offline de manera idempotente:
 * Si ya existe una operación pendiente del MISMO usuario (userId) para la misma colección y documentId,
 * actualiza su payload conservando la trazabilidad para no duplicar envíos.
 * Si pertenece a otro usuario en un dispositivo compartido (C-4), se conserva intacta sin mezclarla.
 */
export function enqueueOfflineOperation(
  queue: PendingSyncOperation[],
  newOp: Omit<PendingSyncOperation, 'operationId' | 'deviceId' | 'createdAt' | 'retryCount'> & {
    operationId?: string;
    createdAt?: string;
  }
): PendingSyncOperation[] {
  const deviceId = getOrCreateDeviceId();
  const createdAt = newOp.createdAt || new Date().toISOString();
  const existingIdx = queue.findIndex(
    (item) =>
      item.collectionName === newOp.collectionName &&
      item.documentId === newOp.documentId &&
      item.userId === newOp.userId &&
      item.status !== 'conflict' &&
      item.status !== 'synced'
  );

  // Preservar el operationId original cuando es un reintento o actualización de la misma operación pendiente
  const operationId =
    newOp.operationId ||
    (existingIdx >= 0 ? queue[existingIdx].operationId : createOperationId('op'));

  const fullOp: PendingSyncOperation = {
    ...newOp,
    operationId,
    deviceId,
    createdAt: existingIdx >= 0 ? queue[existingIdx].createdAt || createdAt : createdAt,
    retryCount: existingIdx >= 0 ? queue[existingIdx].retryCount : 0
  };

  if (existingIdx >= 0) {
    const next = [...queue];
    next[existingIdx] = fullOp;
    return next;
  }
  return [...queue, fullOp];
}

export interface IdempotentAdvanceSyncDecision {
  outcome: 'create' | 'already_processed' | 'conflict';
  payloadToWrite?: any;
  conflictRecord?: SyncConflictRecord;
  canWriteConflictedRecord?: boolean;
}

/**
 * C-4: Estampa metadatos de sincronización preservando SIEMPRE la identidad original del autor (`userId`, `createdAt`, `operationId`)
 * y registrando por separado quién ejecutó la sincronización (`syncedBy`, `syncedByDisplayName`, `syncedAt`).
 */
export function stampOperationSyncMetadata(
  payload: any,
  operation: Pick<
    PendingSyncOperation,
    'operationId' | 'deviceId' | 'userId' | 'userDisplayName' | 'createdAt'
  >,
  syncingUser: { uid: string; displayName: string },
  nowIso = new Date().toISOString()
): any {
  const originalUserId =
    operation.userId && operation.userId !== 'local_user'
      ? operation.userId
      : payload?.userId || syncingUser.uid;
  const originalDisplayName =
    operation.userDisplayName ||
    payload?.userDisplayName ||
    payload?.supervisor ||
    syncingUser.displayName;
  const originalCreatedAt = payload?.createdAt || operation.createdAt || nowIso;

  return {
    ...(payload || {}),
    userId: originalUserId,
    userDisplayName: originalDisplayName,
    operationId: operation.operationId || payload?.operationId || createOperationId('op'),
    deviceId: operation.deviceId || payload?.deviceId || getOrCreateDeviceId(),
    createdAt: originalCreatedAt,
    syncedBy: syncingUser.uid,
    syncedByDisplayName: syncingUser.displayName,
    syncedAt: nowIso,
    updatedAt: nowIso
  };
}

/**
 * C-3: Evalúa de forma idempotente la sincronización de un documento de avance (`/advances/{advanceId}`):
 * 1. Antes de crear el documento, comprueba si ya existe en Firestore (`existingRemoteDoc`).
 * 2. Si el documento existe y corresponde a la misma operación (`operationId` idéntico o mismo contenido esencial),
 *    reconoce que ya fue procesado (`outcome: 'already_processed'`) sin volver a ejecutar `setDoc` (evitando requerir
 *    permiso `update` para el rol Auxiliar cuando la red se cortó tras recibir Firestore la escritura pero antes del ACK).
 * 3. Si el documento existe con datos diferentes a la operación original, genera un conflicto (`outcome: 'conflict'`)
 *    sin sobrescribir silenciosamente el avance confirmado en el servidor.
 * 4. Si no existe y no hay conflicto de porcentaje con otros avances remotos, prepara la creación (`outcome: 'create'`)
 *    preservando `userId`, `operationId`, `createdAt`, `syncedBy` y `syncedAt`.
 */
export function evaluateIdempotentAdvanceSync(params: {
  operation: PendingSyncOperation;
  existingRemoteDoc: any | null;
  remoteAdvancesForActivity?: any[];
  syncingUserId: string;
  syncingUserDisplayName: string;
  activityName?: string;
  galponCode?: string;
  nowIso?: string;
}): IdempotentAdvanceSyncDecision {
  const {
    operation,
    existingRemoteDoc,
    remoteAdvancesForActivity = [],
    syncingUserId,
    syncingUserDisplayName,
    activityName,
    galponCode,
    nowIso = new Date().toISOString()
  } = params;

  const localAdv = operation.payload || {};
  const mode = normalizeProgressMode(operation.progressMode || localAdv.progressMode);

  // 1. Si el documento ya existe en Firestore, verificar si corresponde a la misma operación (reintento idempotente)
  if (existingRemoteDoc) {
    const sameOperationId =
      Boolean(operation.operationId) &&
      Boolean(existingRemoteDoc.operationId) &&
      String(existingRemoteDoc.operationId) === String(operation.operationId);

    const localVal =
      mode === 'percentage'
        ? extractLogPercentageValue(localAdv)
        : Number(localAdv.quantityToday || 0);
    const remoteVal =
      mode === 'percentage'
        ? extractLogPercentageValue(existingRemoteDoc)
        : Number(existingRemoteDoc.quantityToday || 0);

    const sameCoreContent =
      String(existingRemoteDoc.galponId || '') === String(localAdv.galponId || '') &&
      String(existingRemoteDoc.activityCode || '') ===
        String(localAdv.activityCode || '') &&
      String(existingRemoteDoc.date || '') === String(localAdv.date || '') &&
      localVal === remoteVal &&
      Number(existingRemoteDoc.hoursWorked || 0) ===
        Number(localAdv.hoursWorked || 0) &&
      (!existingRemoteDoc.userId ||
        !localAdv.userId ||
        String(existingRemoteDoc.userId) === String(localAdv.userId));

    if (sameOperationId || sameCoreContent) {
      return {
        outcome: 'already_processed'
      };
    }

    // El documento ya existe en el servidor pero sus datos NO corresponden a la operación original -> Conflicto sin sobrescribir
    const conflictRecord: SyncConflictRecord = {
      id: createOperationId('conf_adv'),
      operationId: operation.operationId,
      detectedAt: nowIso,
      collectionName: 'advances',
      documentId: operation.documentId || localAdv.id,
      sectorId: operation.sectorId || localAdv.sectorId,
      galponId: localAdv.galponId || existingRemoteDoc.galponId || operation.galponId || '',
      galponCode: galponCode || localAdv.galponCode,
      activityId: localAdv.activityId || existingRemoteDoc.activityId || operation.activityId,
      activityCode:
        localAdv.activityCode ||
        existingRemoteDoc.activityCode ||
        operation.activityCode ||
        '',
      activityName,
      progressMode: mode,
      localValue: localVal,
      remoteValue: remoteVal,
      localUser:
        localAdv.supervisor ||
        operation.userDisplayName ||
        operation.userId ||
        'Usuario local',
      remoteUser:
        existingRemoteDoc.supervisor ||
        existingRemoteDoc.userDisplayName ||
        existingRemoteDoc.userId ||
        'Usuario en servidor',
      localTimestamp: localAdv.createdAt || operation.createdAt || nowIso,
      remoteTimestamp:
        existingRemoteDoc.updatedAt ||
        existingRemoteDoc.createdAt ||
        existingRemoteDoc.date ||
        nowIso,
      localPayload: localAdv,
      remotePayload: existingRemoteDoc,
      reason: `El documento de avance [${localAdv.activityCode || operation.documentId}] ya existe en Firestore con datos distintos (valor local: ${localVal} vs. valor confirmado en servidor: ${remoteVal}). Se protegió el registro confirmado sin sobrescribirlo.`,
      resolved: false
    };

    return {
      outcome: 'conflict',
      conflictRecord,
      canWriteConflictedRecord: false
    };
  }

  // 2. El documento aún no existe en Firestore: verificar conflicto multiusuario con otros partes de la misma actividad
  const multiUserConflict = detectMultiUserAdvanceConflict({
    operation,
    remoteAdvancesForActivity,
    activityName,
    galponCode
  });

  if (multiUserConflict) {
    const conflictedPayload = stampOperationSyncMetadata(
      {
        ...localAdv,
        conflictStatus: 'conflict',
        conflictId: multiUserConflict.id,
        conflictReason: multiUserConflict.reason,
        syncState: 'conflict'
      },
      operation,
      { uid: syncingUserId, displayName: syncingUserDisplayName },
      nowIso
    );

    return {
      outcome: 'conflict',
      conflictRecord: multiUserConflict,
      canWriteConflictedRecord: true,
      payloadToWrite: conflictedPayload
    };
  }

  // 3. Creación limpia e idempotente preservando userId original y registrando syncedBy / syncedAt
  const cleanPayload = stampOperationSyncMetadata(
    {
      ...localAdv,
      syncState: 'synced',
      conflictStatus: 'none'
    },
    operation,
    { uid: syncingUserId, displayName: syncingUserDisplayName },
    nowIso
  );

  return {
    outcome: 'create',
    payloadToWrite: cleanPayload
  };
}

export interface PartitionedUserQueue {
  ownPendingOps: PendingSyncOperation[];
  foreignPendingOps: PendingSyncOperation[];
  foreignAuthors: string[];
}

/**
 * C-4: Particiona la cola offline en dispositivos compartidos según la identidad del usuario autenticado (`activeUserId`).
 * - `ownPendingOps`: operaciones generadas por el usuario actual (`op.userId === activeUserId` o `'local_user'`).
 * - `foreignPendingOps`: operaciones pendientes que pertenecen a otro usuario que trabajó previamente en el mismo dispositivo.
 * - Las operaciones de otro usuario se mantienen intactas y protegidas en la cola (bloqueando su sincronización automática
 *   bajo una sesión distinta) hasta que su autor original vuelva a iniciar sesión.
 */
export function partitionQueueByUserIdentity(
  queue: PendingSyncOperation[],
  activeUserId: string | null | undefined
): PartitionedUserQueue {
  const activeOps = (queue || []).filter(
    (op) => op && op.status !== 'synced' && op.status !== 'conflict'
  );

  if (!activeUserId) {
    return {
      ownPendingOps: [],
      foreignPendingOps: activeOps,
      foreignAuthors: Array.from(
        new Set(activeOps.map((o) => o.userDisplayName || o.userId).filter(Boolean))
      )
    };
  }

  const ownPendingOps: PendingSyncOperation[] = [];
  const foreignPendingOps: PendingSyncOperation[] = [];
  const foreignAuthorsSet = new Set<string>();

  for (const op of activeOps) {
    const opAuthorId = String(op.userId || '').trim();
    if (!opAuthorId || opAuthorId === 'local_user' || opAuthorId === activeUserId) {
      ownPendingOps.push(op);
    } else {
      foreignPendingOps.push(op);
      foreignAuthorsSet.add(op.userDisplayName || opAuthorId);
    }
  }

  return {
    ownPendingOps,
    foreignPendingOps,
    foreignAuthors: Array.from(foreignAuthorsSet)
  };
}

export function loadSyncConflicts(): SyncConflictRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(SYNC_CONFLICTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSyncConflicts(conflicts: SyncConflictRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SYNC_CONFLICTS_STORAGE_KEY, JSON.stringify(conflicts));
  } catch (err) {
    console.error('[OfflineQueue] Error guardando conflictos:', err);
  }
}

/**
 * Calcula el número exacto de operaciones no confirmadas en Firestore
 * a partir de la cola persistente `calera_offline_pending_queue_v1` (incluyendo `pending_sync`,
 * `sync_error`, `saved_locally`, `syncing` y `conflict`), deduplicando estrictamente por `operationId`
 * y por clave documental consolidada para nunca contar dos veces una misma operación.
 */
export function countUniquePendingSyncOperations(
  queue: PendingSyncOperation[],
  conflicts: SyncConflictRecord[] = []
): number {
  const uniqueOpIds = new Set<string>();
  const consolidatedDocKeys = new Set<string>();

  for (const op of queue || []) {
    if (!op) continue;
    const rawStatus = op.status || (op as any).syncStatus;
    if (rawStatus === 'synced') continue;
    const isUnconfirmed =
      rawStatus === 'pending_sync' ||
      rawStatus === 'sync_error' ||
      rawStatus === 'saved_locally' ||
      rawStatus === 'syncing' ||
      rawStatus === 'conflict';
    if (!isUnconfirmed) continue;

    const colName = op.collectionName || (op as any).collection || 'unknown';
    const opKey =
      (op.operationId && String(op.operationId).trim()) ||
      `${colName}:${op.documentId}:${op.userId || 'local'}`;
    uniqueOpIds.add(opKey);
    if (colName && op.documentId) {
      consolidatedDocKeys.add(
        `${colName}:${op.documentId}:${op.userId || 'local'}`
      );
    }
  }

  for (const conf of conflicts || []) {
    if (!conf || conf.resolved) continue;
    const opKey =
      (conf.operationId && String(conf.operationId).trim()) ||
      (conf.id && String(conf.id).trim());
    const docKey = `${conf.collectionName}:${conf.documentId}:${conf.localUser || 'local'}`;
    if (opKey && !uniqueOpIds.has(opKey) && !consolidatedDocKeys.has(docKey)) {
      uniqueOpIds.add(opKey);
    }
  }

  return uniqueOpIds.size;
}

export interface DynamicSectorGalponContext {
  currentSector: any | null;
  availableGalpones: any[];
  currentGalpon: any | null;
  effectiveSectorId: string;
  effectiveGalponId: string;
  requiresGalponSelection: boolean;
}

/**
 * Valida y resuelve dinámicamente el Sector y Galpón seleccionados:
 * - Solo permite sectores presentes en `scopedSectors` (ya filtrados por permisos del usuario).
 * - Solo permite galpones pertenecientes exclusivamente al sector seleccionado (`currentSector.galpones`).
 * - Al cambiar de sector o si el galpón seleccionado deja de ser válido en el sector actual,
 *   NO elige silenciosamente otro galpón: limpia la selección (`effectiveGalponId: ''`, `currentGalpon: null`)
 *   y marca `requiresGalponSelection: true`.
 */
export function resolveDynamicSectorGalponContext(
  scopedSectors: any[],
  selectedSectorId: string,
  selectedGalponId: string
): DynamicSectorGalponContext {
  const validSectors = Array.isArray(scopedSectors) ? scopedSectors : [];
  if (validSectors.length === 0) {
    return {
      currentSector: null,
      availableGalpones: [],
      currentGalpon: null,
      effectiveSectorId: '',
      effectiveGalponId: '',
      requiresGalponSelection: false
    };
  }

  const currentSector =
    validSectors.find((s) => s && s.id === selectedSectorId) || null;

  if (!currentSector) {
    return {
      currentSector: null,
      availableGalpones: [],
      currentGalpon: null,
      effectiveSectorId: '',
      effectiveGalponId: '',
      requiresGalponSelection: false
    };
  }

  const availableGalpones = Array.isArray(currentSector.galpones)
    ? currentSector.galpones
    : [];

  const currentGalpon = selectedGalponId
    ? availableGalpones.find((g: any) => g && g.id === selectedGalponId) || null
    : null;

  const effectiveGalponId = currentGalpon ? currentGalpon.id : '';
  const requiresGalponSelection =
    availableGalpones.length > 0 && !currentGalpon;

  return {
    currentSector,
    availableGalpones,
    currentGalpon,
    effectiveSectorId: currentSector.id,
    effectiveGalponId,
    requiresGalponSelection
  };
}

