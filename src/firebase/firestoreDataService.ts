import type React from 'react';
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  deleteDoc,
  writeBatch,
  getDoc,
  getDocs,
  bindOperationalData,
  importWorkers,
  withdrawGanttActivity,
  operationCommitted,
  operationalScopeKey
} from './operationalData';
import { auth } from './config';
import type { UserProfile } from './authService';
import { hasModulePermission } from './permissions';
import { workerForDisplay } from './workerData';
import { providerIdFromName } from '../catalog/catalogSelectorEngine';
export { providerIdFromName } from '../catalog/catalogSelectorEngine';
import { parseMovementTimestamp } from './movementImport';
import { getApiUrl } from './apiConfig';
import {
  type PendingSyncOperation,
  type SyncConflictRecord,
  type ManualSyncSummary,
  type ConnectionIndicatorState,
  createOperationId,
  getOrCreateDeviceId,
  loadPendingSyncQueue,
  updatePendingSyncQueue,
  enqueueOfflineOperation,
  loadSyncConflicts,
  saveSyncConflicts,
  evaluateIdempotentAdvanceSync,
  isConfirmedAdvance,
  stampOperationSyncMetadata,
  partitionQueueByUserIdentity,
  mergeSectorGalponesIsolated,
  mergeSectorDeepWithConflicts,
  assertSafeSectorRebase,
  applyActivityConflictResolutionToSector,
  reconstructCollectionWithOfflineQueue,
  reconstructSectorsWithOfflineQueue,
  isGanttWithdrawal,
  sameOperationalScope,
  reconstructAttendanceWithOfflineQueue,
  reconstructProvidersWithOfflineQueue,
  normalizeProgressMode,
  countUniquePendingSyncOperations,
  OFFLINE_QUEUE_STORAGE_KEY,
  SYNC_CONFLICTS_STORAGE_KEY
} from './offlineSyncEngine';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write'
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): FirestoreErrorInfo {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo;
}

export function sanitizeForFirestore<T>(obj: T): T {
  if (obj === null || obj === undefined) return null as unknown as T;
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeForFirestore(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const out: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj as Record<string, any>)) {
      if (val !== undefined) {
        out[key] = sanitizeForFirestore(val);
      }
    }
    return out as T;
  }
  return obj;
}

type GroupedAdvanceWrite = Pick<PendingSyncOperation,
  'documentId' | 'operationType' | 'payload' | 'requestId' | 'expectedRevision'>;
type QueueInput = Omit<PendingSyncOperation, 'operationId' | 'deviceId' | 'createdAt' | 'retryCount' | 'userId' | 'userDisplayName' | 'userRole'> &
  Partial<Pick<PendingSyncOperation, 'operationId' | 'createdAt' | 'userId' | 'userDisplayName' | 'userRole'>>;

async function commitAdvanceGroup(session: ReturnType<typeof bindOperationalData>, operations: GroupedAdvanceWrite[]) {
  if (operations.length > 100) throw new Error('El grupo supera el límite de una transacción.');
  const batch = writeBatch(session);
  for (const operation of operations.filter(item => item.operationType === 'delete')) {
    batch.delete(doc(session, 'advances', operation.documentId), operation);
  }
  for (const operation of operations.filter(item => item.operationType === 'upsert')) {
    batch.set(doc(session, 'advances', operation.documentId),
      sanitizeForFirestore({ ...operation.payload, syncState: 'synced' }), operation);
  }
  await batch.commit();
}

export function computeCollectionDiff<T extends { id: string }>(
  prevMap: Map<string, string>,
  nextDocs: T[]
): { upserts: T[]; deletes: string[]; nextMap: Map<string, string> } {
  const nextMap = new Map<string, string>();
  const upserts: T[] = [];

  for (const docItem of nextDocs || []) {
    if (!docItem || !docItem.id) continue;
    const serialized = JSON.stringify(sanitizeForFirestore(docItem));
    nextMap.set(docItem.id, serialized);
    if (prevMap.get(docItem.id) !== serialized) {
      upserts.push(docItem);
    }
  }

  const deletes: string[] = [];
  for (const oldId of prevMap.keys()) {
    if (!nextMap.has(oldId)) {
      deletes.push(oldId);
    }
  }

  return { upserts, deletes, nextMap };
}

export function buildMovementDocFromInput(input: {
  id: string;
  timestamp: string;
  action: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN';
  module: string;
  description: string;
  profile: UserProfile | null;
  userOverride?: string;
  targetId?: string;
  previousValue?: string;
  newValue?: string;
}) {
  return sanitizeForFirestore({
    id: input.id,
    timestamp: input.timestamp,
    createdAt: new Date().toISOString(),
    action: input.action,
    type: input.action,
    module: input.module,
    description: input.description,
    detail: input.description,
    user:
      input.userOverride ||
      input.profile?.displayName ||
      input.profile?.email ||
      'Sistema',
    userId: input.profile?.uid || 'system',
    userEmail: input.profile?.email || '',
    userRole: input.profile?.role || '',
    targetId: input.targetId,
    previousValue: input.previousValue,
    newValue: input.newValue
  });
}

export function normalizeMovementDocToAuditLog(docData: any) {
  return {
    id: docData.id,
    timestamp: docData.timestamp || docData.createdAt || '',
    sortTimestamp: parseMovementTimestamp(docData.timestamp) ?? parseMovementTimestamp(docData.createdAt) ?? '',
    user: docData.user || docData.userEmail || 'Usuario',
    userId: docData.userId || '',
    userEmail: docData.userEmail || '',
    userRole: docData.userRole || '',
    action: (docData.action || docData.type || 'MODIFICACIÓN') as
      | 'REGISTRO'
      | 'MODIFICACIÓN'
      | 'ELIMINACIÓN',
    module: docData.module || 'General',
    description: docData.description || docData.detail || '',
    targetId: docData.targetId,
    projectCode: docData.projectCode,
    sectorId: docData.sectorId,
    galponId: docData.galponId,
    requestId: docData.requestId,
    previousValue: docData.previousValue,
    newValue: docData.newValue
  };
}

export function diffById<T extends { id: string }>(
  prevList: T[],
  nextList: T[]
): { upserted: T[]; deletedIds: string[] } {
  const prevMap = new Map<string, string>();
  for (const item of prevList || []) {
    if (item && item.id) {
      prevMap.set(item.id, JSON.stringify(sanitizeForFirestore(item)));
    }
  }

  const nextIds = new Set<string>();
  const upserted: T[] = [];

  for (const item of nextList || []) {
    if (!item || !item.id) continue;
    nextIds.add(item.id);
    const serialized = JSON.stringify(sanitizeForFirestore(item));
    if (prevMap.get(item.id) !== serialized) {
      upserted.push(item);
    }
  }

  const deletedIds: string[] = [];
  for (const oldId of prevMap.keys()) {
    if (!nextIds.has(oldId)) {
      deletedIds.push(oldId);
    }
  }

  return { upserted, deletedIds };
}

function isProfileAuthorizedActive(profile: UserProfile | null | undefined): boolean {
  if (!profile) return false;
  if (typeof profile.active === 'boolean') return profile.active;
  return profile.status === 'activo';
}

interface UseFirestoreSyncParams {
  profile: UserProfile | null;
  technologies: string[];
  setTechnologies: React.Dispatch<React.SetStateAction<string[]>>;
  masterCatalog: any[];
  setMasterCatalog: React.Dispatch<React.SetStateAction<any[]>>;
  sectors: any[];
  setSectors: React.Dispatch<React.SetStateAction<any[]>>;
  materials: any[];
  setMaterials: React.Dispatch<React.SetStateAction<any[]>>;
  dailyAdvances: any[];
  setDailyAdvances: React.Dispatch<React.SetStateAction<any[]>>;
  masterWorkforce: any[];
  setMasterWorkforce: React.Dispatch<React.SetStateAction<any[]>>;
  attendanceRecords: Record<string, Record<string, string>>;
  setAttendanceRecords: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, string>>>
  >;
  auditLogs: any[];
  setAuditLogs: React.Dispatch<React.SetStateAction<any[]>>;
}

export function useFirestoreOperationalSync({
  profile,
  technologies,
  setTechnologies,
  masterCatalog,
  setMasterCatalog,
  sectors,
  setSectors,
  materials,
  setMaterials,
  dailyAdvances,
  setDailyAdvances,
  masterWorkforce,
  setMasterWorkforce,
  attendanceRecords,
  setAttendanceRecords,
  setAuditLogs
}: UseFirestoreSyncParams) {
  const db = useMemo(() => bindOperationalData(profile), [profile]);
  const scopeKey = operationalScopeKey(profile);
  const readScopedQueue = useCallback(() => partitionQueueByUserIdentity(loadPendingSyncQueue(), profile?.uid).ownPendingOps
    .filter(operation => sameOperationalScope(operation.scopeKey, scopeKey)), [profile?.uid, scopeKey]);
  const [syncStatus, setSyncStatus] = useState<'connecting' | 'synced' | 'syncing' | 'error'>(
    'connecting'
  );
  const [confirmedAdvances, setConfirmedAdvances] = useState(() => dailyAdvances.filter(isConfirmedAdvance));
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [isNetworkOnline, setIsNetworkOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [pendingOperations, setPendingOperations] = useState<PendingSyncOperation[]>(() =>
    loadPendingSyncQueue()
  );
  const [syncConflicts, setSyncConflicts] = useState<SyncConflictRecord[]>(() =>
    loadSyncConflicts()
  );
  const [lastSyncSummary, setLastSyncSummary] = useState<ManualSyncSummary | null>(null);
  const [syncStorageError, setSyncStorageError] = useState(false);
  const [isManualSyncing, setIsManualSyncing] = useState<boolean>(false);

  const isHydratedRef = useRef<Record<string, boolean>>({
    providers: false,
    masterCatalog: false,
    sectors: false,
    materials: false,
    advances: false,
    workers: false,
    attendance: false,
    movements: false
  });

  const providerRevisions = useRef(new Map<string, number>());
  const syncInFlightRef = useRef<boolean>(false);
  const pendingInFlightDeletesRef = useRef<Record<string, Set<string>>>({
    masterCatalog: new Set<string>(),
    sectors: new Set<string>(),
    materials: new Set<string>(),
    advances: new Set<string>(),
    workers: new Set<string>()
  });

  const lastSyncedStateRef = useRef<{
    technologies: string[];
    masterCatalog: any[];
    sectors: any[];
    materials: any[];
    dailyAdvances: any[];
    masterWorkforce: any[];
    attendanceRecords: Record<string, Record<string, string>>;
  }>({
    technologies: [],
    masterCatalog: [],
    sectors: [],
    materials: [],
    dailyAdvances: [],
    masterWorkforce: [],
    attendanceRecords: {}
  });

  useEffect(() => {
    saveSyncConflicts(syncConflicts);
  }, [syncConflicts]);

  // Escuchar cambios externos o de otras pestañas sobre la cola persistente calera_offline_pending_queue_v1
  useEffect(() => {
    const syncFromStorage = (e?: StorageEvent) => {
      if (!e || !e.key || e.key === OFFLINE_QUEUE_STORAGE_KEY) {
        setPendingOperations(loadPendingSyncQueue());
      }
      if (!e || !e.key || e.key === SYNC_CONFLICTS_STORAGE_KEY) {
        setSyncConflicts(loadSyncConflicts());
      }
    };
    const handleCustomQueueUpdate = () => syncFromStorage();
    window.addEventListener('storage', syncFromStorage);
    window.addEventListener('calera-offline-queue-updated', handleCustomQueueUpdate);
    window.addEventListener('calera-offline-sync-updated', handleCustomQueueUpdate);
    return () => {
      window.removeEventListener('storage', syncFromStorage);
      window.removeEventListener('calera-offline-queue-updated', handleCustomQueueUpdate);
      window.removeEventListener('calera-offline-sync-updated', handleCustomQueueUpdate);
    };
  }, []);

  const markSyncedNow = useCallback(() => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    setLastSyncedAt(`${hh}:${mm}:${ss}`);
    setSyncStatus('synced');
  }, []);

  // Monitoreo activo de conectividad real (eventos online/offline + sondas a /api/health)
  const checkRealConnectivity = useCallback(async (): Promise<boolean> => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsNetworkOnline(false);
      return false;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(getApiUrl(`/api/health?t=${Date.now()}`), {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timeout);
      const online = res.ok;
      setIsNetworkOnline(online);
      return online;
    } catch {
      setIsNetworkOnline(false);
      return false;
    }
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setIsNetworkOnline(true);
      checkRealConnectivity();
    };
    const handleOffline = () => {
      setIsNetworkOnline(false);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [checkRealConnectivity]);

  // Helper para encolar una operación cuando estamos sin conexión o ante un fallo de red,
  // preservando siempre el operationId, userId y createdAt originales (C-3 y C-4).
  const queueOperationLocally = useCallback(
    async (input: QueueInput | QueueInput[]) => {
      if (!profile) return false;
      const operations = Array.isArray(input) ? input : [input];
      if (!operations.length) return false;
      return updatePendingSyncQueue(prev => operations.reduce((queue, op) => {
        const stableOpId = op.operationId || op.payload?.operationId || createOperationId('op');
        const stableCreatedAt = op.createdAt || op.payload?.createdAt || new Date().toISOString();
        const sectorId = op.sectorId ?? op.payload?.sectorId ?? (op.collectionName === 'sectors' ? op.documentId : undefined);
        const galponId = op.galponId ?? op.payload?.galponId;
        const sector = lastSyncedStateRef.current.sectors.find(item => sectorId ? item.id === sectorId
          : galponId && item.galpones?.some((barn: any) => barn.id === galponId)) ?? op.baseSector;
        const barn = sector?.galpones?.find((item: any) => item.id === galponId);

        return enqueueOfflineOperation(queue, {
          ...op,
          scopeKey,
          requestId: op.requestId ?? crypto.randomUUID(),
          operationId: stableOpId,
          createdAt: stableCreatedAt,
          sectorId: sectorId ?? sector?.id,
          galponId,
          projectCode: op.projectCode ?? barn?.projectCode ?? sector?.projectName ?? sector?.code ?? sector?.name,
          userId: profile.uid,
          userDisplayName: profile.displayName,
          userRole: profile.role
        });
      }, prev)).then(queue => {
        setPendingOperations(queue);
        return true;
      }).catch(() => {
        setSyncStorageError(true);
        return false;
      });
    },
    [profile, scopeKey]
  );

  // Rehidratación inmediata desde cola offline al iniciar o reabrir el navegador sin conexión (C-2)
  useEffect(() => {
    const initialQueue = readScopedQueue();
    if (initialQueue.length === 0) return;

    setTechnologies((prev) => reconstructProvidersWithOfflineQueue(prev || [], initialQueue));
    setMasterCatalog((prev) =>
      reconstructCollectionWithOfflineQueue(prev || [], initialQueue, 'masterCatalog')
    );
    setSectors((prev) => reconstructSectorsWithOfflineQueue(prev || [], initialQueue));
    setMaterials((prev) =>
      reconstructCollectionWithOfflineQueue(prev || [], initialQueue, 'materials')
    );
    setDailyAdvances((prev) =>
      reconstructCollectionWithOfflineQueue(prev || [], initialQueue, 'advances').sort(
        (a: any, b: any) => String(b.date || '').localeCompare(String(a.date || ''))
      )
    );
    setMasterWorkforce((prev) =>
      reconstructCollectionWithOfflineQueue(prev || [], initialQueue, 'workers').map(workerForDisplay)
    );
    setAttendanceRecords((prev) =>
      reconstructAttendanceWithOfflineQueue(prev || {}, initialQueue)
    );
  }, [
    readScopedQueue,
    setTechnologies,
    setMasterCatalog,
    setSectors,
    setMaterials,
    setDailyAdvances,
    setMasterWorkforce,
    setAttendanceRecords
  ]);

  const activeProfileUid = isProfileAuthorizedActive(profile) ? profile?.uid || null : null;
  const activeProfileRole = isProfileAuthorizedActive(profile) ? profile?.role || null : null;
  const canReadMovements = hasModulePermission(profile, 'movimientos', 'view');

  // 1. Suscripciones en tiempo real desde Firestore combinadas con cola local offline (C-2)
  useEffect(() => {
    if (!activeProfileUid || !activeProfileRole || !auth.currentUser) return;

    const unsubs: (() => void)[] = [];

    // 1.1 Providers (Plantillas / Tecnologías constructivas en colección /providers)
    unsubs.push(
      onSnapshot(
        collection(db, 'providers'),
        (snap) => {
          providerRevisions.current = new Map(snap.docs.map(doc => [doc.id, doc.data()._revision ?? 0]));
          const remoteTechs = snap.docs
            .map((d) => String(d.data()?.name || '').trim())
            .filter(Boolean);
          const currentQueue = readScopedQueue();
          const mergedTechs = reconstructProvidersWithOfflineQueue(remoteTechs, currentQueue);
          lastSyncedStateRef.current.technologies = mergedTechs;
          setTechnologies(mergedTechs);
          isHydratedRef.current.providers = true;
          markSyncedNow();
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'providers');
        }
      )
    );

    // 1.2 Master Catalog
    unsubs.push(
      onSnapshot(
        collection(db, 'masterCatalog'),
        (snap) => {
          const inFlightDeleted =
            pendingInFlightDeletesRef.current.masterCatalog || new Set<string>();
          const remoteItems = snap.docs
            .map((d) => ({ ...d.data(), id: d.id }))
            .filter((item) => !inFlightDeleted.has(item.id));
          const currentQueue = readScopedQueue();
          const mergedCatalog = reconstructCollectionWithOfflineQueue(
            remoteItems,
            currentQueue,
            'masterCatalog'
          );
          lastSyncedStateRef.current.masterCatalog = mergedCatalog;
          setMasterCatalog(mergedCatalog);
          isHydratedRef.current.masterCatalog = true;
          markSyncedNow();
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'masterCatalog');
        }
      )
    );

    // 1.3 Sectors y Galpones (fusión profunda sin pérdida entre Firestore, caché local y cola offline)
    unsubs.push(
      onSnapshot(
        collection(db, 'sectors'),
        (snap) => {
          const remoteItems = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          const currentQueue = readScopedQueue();
          const reconstructedFromQueue = reconstructSectorsWithOfflineQueue(
            remoteItems,
            currentQueue
          );
          const wasHydrated = isHydratedRef.current.sectors;

          setSectors((prevLocal) => {
            if (!wasHydrated && Array.isArray(prevLocal) && prevLocal.length > 0) {
              const remoteMap = new Map(reconstructedFromQueue.map((r: any) => [r.id, r]));
              const mergedList: any[] = [...reconstructedFromQueue];
              for (const localSec of prevLocal) {
                if (!localSec || !localSec.id) continue;
                if (currentQueue.some(op => op.collectionName === 'sectors' && op.documentId === localSec.id &&
                  (op.status === 'sync_error' || op.structuralDeletion || isGanttWithdrawal(op)))) continue;
                const remSec = remoteMap.get(localSec.id);
                if (!remSec) {
                  mergedList.push(localSec);
                } else {
                  const idx = mergedList.findIndex((m) => m.id === localSec.id);
                  if (idx >= 0) {
                    mergedList[idx] = mergeSectorGalponesIsolated(localSec, remSec);
                  }
                }
              }
              lastSyncedStateRef.current.sectors = mergedList;
              return mergedList;
            }
            lastSyncedStateRef.current.sectors = reconstructedFromQueue;
            return reconstructedFromQueue;
          });

          isHydratedRef.current.sectors = true;
          markSyncedNow();
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'sectors');
        }
      )
    );

    // 1.4 Materials
    unsubs.push(
      onSnapshot(
        collection(db, 'materials'),
        (snap) => {
          const remoteItems = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          const currentQueue = readScopedQueue();
          const mergedMaterials = reconstructCollectionWithOfflineQueue(
            remoteItems,
            currentQueue,
            'materials'
          );
          lastSyncedStateRef.current.materials = mergedMaterials;
          setMaterials(mergedMaterials);
          isHydratedRef.current.materials = true;
          markSyncedNow();
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'materials');
        }
      )
    );

    // 1.5 Advances (combinando partes remotos con partes creados/modificados/eliminados offline)
    unsubs.push(
      onSnapshot(
        collection(db, 'advances'),
        (snap) => {
          const remoteItems = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          setConfirmedAdvances(remoteItems.filter(isConfirmedAdvance));
          const currentQueue = readScopedQueue();
          const mergedAdvances = reconstructCollectionWithOfflineQueue(
            remoteItems,
            currentQueue,
            'advances'
          );
          mergedAdvances.sort((a: any, b: any) =>
            String(b.date || '').localeCompare(String(a.date || ''))
          );
          lastSyncedStateRef.current.dailyAdvances = mergedAdvances;
          setDailyAdvances(mergedAdvances);
          isHydratedRef.current.advances = true;
          markSyncedNow();
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'advances');
        }
      )
    );

    // 1.6 Workers (Planilla de Personal)
    unsubs.push(
      onSnapshot(
        collection(db, 'workers'),
        (snap) => {
          const remoteItems = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          const currentQueue = readScopedQueue();
          const mergedWorkers = reconstructCollectionWithOfflineQueue(
            remoteItems,
            currentQueue,
            'workers'
          ).map(workerForDisplay);
          lastSyncedStateRef.current.masterWorkforce = mergedWorkers;
          setMasterWorkforce(mergedWorkers);
          isHydratedRef.current.workers = true;
          markSyncedNow();
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'workers');
        }
      )
    );

    // 1.7 Attendance (Asistencia diaria)
    unsubs.push(
      onSnapshot(
        collection(db, 'attendance'),
        (snap) => {
          const map: Record<string, Record<string, string>> = {};
          snap.docs.forEach((d) => {
            const data = d.data();
            const dateKey = data.date || d.id;
            map[dateKey] = data.records || {};
          });
          const currentQueue = readScopedQueue();
          const mergedAttendance = reconstructAttendanceWithOfflineQueue(map, currentQueue);
          lastSyncedStateRef.current.attendanceRecords = mergedAttendance;
          setAttendanceRecords(mergedAttendance);
          isHydratedRef.current.attendance = true;
          markSyncedNow();
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'attendance');
        }
      )
    );

    // 1.8 Bitácora de auditoría
    if (canReadMovements) {
      unsubs.push(
        onSnapshot(
          collection(db, 'movements'),
          (snap) => {
            const remoteLogs = snap.docs.map((d) =>
              normalizeMovementDocToAuditLog({ ...d.data(), id: d.id })
            );
            const mergedLogs = remoteLogs.sort((a: any, b: any) =>
              b.sortTimestamp.localeCompare(a.sortTimestamp)
            );
            setAuditLogs(mergedLogs);
            isHydratedRef.current.movements = true;
            markSyncedNow();
          },
          (err) => {
            handleFirestoreError(err, OperationType.LIST, 'movements');
          }
        )
      );
    } else {
      isHydratedRef.current.movements = true;
    }

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [
    db,
    readScopedQueue,
    activeProfileUid,
    activeProfileRole,
    canReadMovements,
    markSyncedNow,
    setTechnologies,
    setMasterCatalog,
    setSectors,
    setMaterials,
    setDailyAdvances,
    setMasterWorkforce,
    setAttendanceRecords,
    setAuditLogs
  ]);

  // Helper genérico para sincronizar una colección con soporte Offline automático y fusión profunda C-1
  const syncCollectionDiff = useCallback(
    async <T extends { id: string }>(
      collectionName:
        | 'masterCatalog'
        | 'sectors'
        | 'materials'
        | 'advances'
        | 'workers',
      prevItems: T[],
      nextItems: T[]
    ) => {
      const { upserted: changed, deletedIds } = diffById(prevItems, nextItems);
      const upserted = collectionName === 'materials' ? changed.filter(item => {
        const previous = prevItems.find(value => value.id === item.id);
        const withoutUsage = ({ usedQty, ...rest }: T & { usedQty?: number }) => rest;
        return !previous || JSON.stringify(withoutUsage(item)) !== JSON.stringify(withoutUsage(previous));
      }) : changed;
      if (upserted.length === 0 && deletedIds.length === 0) return;
      const requestIds = new Map([...upserted.map(item => item.id), ...deletedIds].map(id => [id, crypto.randomUUID()]));
      const previousById = new Map(prevItems.map(item => [item.id, item as T & { _revision?: number }]));
      const revision = (id: string) => previousById.get(id)?._revision ?? 0;
      const groupedWrites = new Map<string, GroupedAdvanceWrite[]>();
      const groupByDocument = new Map<string, string>();
      if (collectionName === 'advances') {
        const groupIds = new Map<string, string>();
        const group = (id: string, previous: any, payload?: any) => {
          const sharedId = payload?.sharedGroupId ?? previous?.sharedGroupId;
          if (!sharedId) return;
          const writeGroupId = groupIds.get(sharedId) ?? crypto.randomUUID();
          groupIds.set(sharedId, writeGroupId);
          groupByDocument.set(id, writeGroupId);
          const writes = groupedWrites.get(writeGroupId) ?? [];
          writes.push({ documentId: id, operationType: payload ? 'upsert' : 'delete', payload,
            requestId: requestIds.get(id), expectedRevision: revision(id) });
          groupedWrites.set(writeGroupId, writes);
        };
        upserted.forEach(item => group(item.id, previousById.get(item.id), item));
        deletedIds.forEach(id => group(id, previousById.get(id)));
      }

      // Si el dispositivo está sin conexión a internet, encolamos todas las mutaciones en la cola persistente
      if (!isNetworkOnline || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        const pending: QueueInput[] = [];
        upserted.forEach((item: any) => {
          const stableOpId = item.operationId || createOperationId(`op_${collectionName}`);
          const stableCreatedAt = item.createdAt || new Date().toISOString();
          const authorUserId =
            item.userId || profile?.uid || auth.currentUser?.uid || 'local_user';
          const authorDisplayName =
            item.userDisplayName ||
            item.supervisor ||
            profile?.displayName ||
            auth.currentUser?.email ||
            'Usuario';
          pending.push({
            operationId: stableOpId,
            requestId: requestIds.get(item.id),
            writeGroupId: groupByDocument.get(item.id),
            expectedRevision: revision(item.id),
            baseExists: previousById.has(item.id),
            ...(collectionName === 'sectors' && previousById.has(item.id) ? { baseSector: previousById.get(item.id) } : {}),
            createdAt: stableCreatedAt,
            userId: authorUserId,
            userDisplayName: authorDisplayName,
            collectionName,
            documentId: item.id,
            operationType: 'upsert',
            sectorId: item.sectorId,
            galponId: item.galponId,
            activityId: item.activityId,
            activityCode: item.activityCode,
            progressMode: item.progressMode,
            basePercentage: item.basePercentage,
            baseTimestamp: item.baseTimestamp || stableCreatedAt,
            payload: sanitizeForFirestore({
              ...item,
              operationId: stableOpId,
              createdAt: stableCreatedAt,
              userId: authorUserId,
              userDisplayName: authorDisplayName
            }),
            status: 'pending_sync'
          });
        });
        deletedIds.forEach((delId) => {
          pending.push({
            collectionName,
            documentId: delId,
            requestId: requestIds.get(delId),
            writeGroupId: groupByDocument.get(delId),
            expectedRevision: revision(delId),
            operationType: 'delete',
            status: 'pending_sync'
          });
        });
        queueOperationLocally(pending);
        lastSyncedStateRef.current = {
          ...lastSyncedStateRef.current,
          ...(collectionName === 'masterCatalog' ? { masterCatalog: nextItems } : {}),
          ...(collectionName === 'sectors' ? { sectors: nextItems } : {}),
          ...(collectionName === 'materials' ? { materials: nextItems } : {}),
          ...(collectionName === 'advances' ? { dailyAdvances: nextItems } : {}),
          ...(collectionName === 'workers' ? { masterWorkforce: nextItems } : {})
        };
        return;
      }

      setSyncStatus('syncing');
      if (!pendingInFlightDeletesRef.current[collectionName]) {
        pendingInFlightDeletesRef.current[collectionName] = new Set<string>();
      }
      deletedIds.forEach((delId) =>
        pendingInFlightDeletesRef.current[collectionName].add(delId)
      );
      upserted.forEach((item) =>
        pendingInFlightDeletesRef.current[collectionName].delete(item.id)
      );

      lastSyncedStateRef.current = {
        ...lastSyncedStateRef.current,
        ...(collectionName === 'masterCatalog' ? { masterCatalog: nextItems } : {}),
        ...(collectionName === 'sectors' ? { sectors: nextItems } : {}),
        ...(collectionName === 'materials' ? { materials: nextItems } : {}),
        ...(collectionName === 'advances' ? { dailyAdvances: nextItems } : {}),
        ...(collectionName === 'workers' ? { masterWorkforce: nextItems } : {})
      };

      try {
        const nowIso = new Date().toISOString();
        const actorUid = profile?.uid || auth.currentUser?.uid || 'system';
        const actorDisplayName =
          profile?.displayName || profile?.email || auth.currentUser?.email || 'Usuario';

        // Para sectores: fusión profunda por Galpón -> Área -> Sistema -> Estructura -> Actividad con detección de conflictos (C-1)
        if (collectionName === 'sectors') {
          const detectedSectorConflicts: SyncConflictRecord[] = [];
          for (const secItem of upserted as any[]) {
            const prevSec = (prevItems as any[]).find((p) => p.id === secItem.id);
            const modifiedGalponIds: string[] = [];
            const prevGalMap = new Map(
              ((prevSec?.galpones as any[]) || []).map((g) => [
                g.id,
                JSON.stringify(sanitizeForFirestore(g))
              ])
            );
            const nextGalIds = new Set<string>();
            for (const g of secItem.galpones || []) {
              nextGalIds.add(g.id);
              if (
                prevGalMap.get(g.id) !== JSON.stringify(sanitizeForFirestore(g))
              ) {
                modifiedGalponIds.push(g.id);
              }
            }
            for (const oldGId of prevGalMap.keys()) {
              if (!nextGalIds.has(oldGId)) {
                modifiedGalponIds.push(oldGId);
              }
            }

            const remoteSnap = await getDoc(doc(db, 'sectors', secItem.id));
            const remoteSec = remoteSnap.exists() ? remoteSnap.data() : null;
            assertSafeSectorRebase(prevSec, remoteSec, revision(secItem.id));
            const secOpId = secItem.operationId || createOperationId('op_sec');
            const { mergedSector, conflicts } = mergeSectorDeepWithConflicts(
              secItem,
              remoteSec,
              {
                modifiedGalponIds,
                baseSector: prevSec,
                localUser: actorDisplayName,
                operationId: secOpId
              }
            );
            if (conflicts.length > 0) {
              detectedSectorConflicts.push(...conflicts);
            }
            await setDoc(
              doc(db, 'sectors', secItem.id),
              sanitizeForFirestore({
                ...mergedSector,
                operationId: secOpId,
                userId: secItem.userId || actorUid,
                createdAt: secItem.createdAt || remoteSec?.createdAt || nowIso,
                syncedBy: actorUid,
                syncedByDisplayName: actorDisplayName,
                syncedAt: nowIso,
                updatedAt: nowIso
              }), { requestId: requestIds.get(secItem.id), expectedRevision: remoteSec?._revision ?? 0 }
            );
          }
          for (const delId of deletedIds) {
            await deleteDoc(doc(db, 'sectors', delId), { requestId: requestIds.get(delId), expectedRevision: revision(delId) });
          }
          if (detectedSectorConflicts.length > 0) {
            setSyncConflicts((prev) => [...detectedSectorConflicts.map(conflict => ({ ...conflict, scopeKey })), ...prev]);
          }
        } else if (collectionName === 'advances') {
          // C-3 y C-4: Sincronización idempotente de avances comprobando getDoc antes de crear,
          // evitando sobrescrituras silenciosas y sin requerir permisos update generales para Auxiliar.
          const detectedAdvanceConflicts: SyncConflictRecord[] = [];
          for (const operations of groupedWrites.values()) await commitAdvanceGroup(db, operations);
          for (const advItem of upserted as any[]) {
            if (groupByDocument.has(advItem.id)) continue;
            const stableOpId = advItem.operationId || createOperationId('op_adv');
            const stableCreatedAt = advItem.createdAt || nowIso;
            const authorUserId = advItem.userId || actorUid;
            const authorDisplayName =
              advItem.userDisplayName || advItem.supervisor || actorDisplayName;

            const remoteSnap = await getDoc(doc(db, 'advances', advItem.id));
            const existingRemoteDoc = remoteSnap.exists() ? remoteSnap.data() : null;

            // Si es una edición explícita autorizada (Supervisor/Jefe de proyecto/Administrador) sobre un registro existente
            const isExplicitEditByAuthorizedRole =
              Boolean(existingRemoteDoc) &&
              hasModulePermission(profile, 'avance_diario', 'edit') &&
              (prevItems as any[]).some((p) => p.id === advItem.id);

            if (isExplicitEditByAuthorizedRole) {
              const updatedPayload = stampOperationSyncMetadata(
                {
                  ...advItem,
                  syncState: 'synced'
                },
                {
                  operationId: stableOpId,
                  deviceId: advItem.deviceId || getOrCreateDeviceId(),
                  userId: existingRemoteDoc?.userId || authorUserId,
                  userDisplayName:
                    existingRemoteDoc?.userDisplayName || authorDisplayName,
                  createdAt: existingRemoteDoc?.createdAt || stableCreatedAt
                },
                { uid: actorUid, displayName: actorDisplayName },
                nowIso
              );
              await setDoc(
                doc(db, 'advances', advItem.id),
                sanitizeForFirestore(updatedPayload), { requestId: requestIds.get(advItem.id), expectedRevision: revision(advItem.id) }
              );
              continue;
            }

            const remoteAdvancesForAct = (prevItems as any[]).filter(
              (r) =>
                r &&
                r.id !== advItem.id &&
                r.galponId === advItem.galponId &&
                (r.activityId ? r.activityId === advItem.activityId : r.activityCode === advItem.activityCode)
            );

            const decision = evaluateIdempotentAdvanceSync({
              operation: {
                operationId: stableOpId,
                deviceId: advItem.deviceId || getOrCreateDeviceId(),
                userId: authorUserId,
                userDisplayName: authorDisplayName,
                userRole: profile?.role || 'Auxiliar',
                createdAt: stableCreatedAt,
                collectionName: 'advances',
                documentId: advItem.id,
                operationType: 'upsert',
                sectorId: advItem.sectorId,
                galponId: advItem.galponId,
                activityId: advItem.activityId,
                activityCode: advItem.activityCode,
                progressMode: advItem.progressMode,
                basePercentage: advItem.basePercentage,
                baseTimestamp: advItem.baseTimestamp,
                payload: advItem,
                status: 'pending_sync',
                retryCount: 0
              },
              existingRemoteDoc,
              remoteAdvancesForActivity: remoteAdvancesForAct,
              syncingUserId: actorUid,
              syncingUserDisplayName: actorDisplayName,
              nowIso
            });

            if (decision.outcome === 'already_processed') {
              // El documento ya existe con la misma operación/datos: no volver a ejecutar setDoc
              continue;
            }
            if (decision.outcome === 'conflict' && decision.conflictRecord) {
              detectedAdvanceConflicts.push(decision.conflictRecord);
              if (decision.canWriteConflictedRecord && !existingRemoteDoc && decision.payloadToWrite) {
                await setDoc(
                  doc(db, 'advances', advItem.id),
                  sanitizeForFirestore(decision.payloadToWrite), { requestId: requestIds.get(advItem.id) }
                );
              }
              continue;
            }
            if (decision.outcome === 'create' && decision.payloadToWrite) {
              await setDoc(
                doc(db, 'advances', advItem.id),
                sanitizeForFirestore(decision.payloadToWrite), { requestId: requestIds.get(advItem.id) }
              );
            }
          }
          for (const delId of deletedIds) {
            if (groupByDocument.has(delId)) continue;
            await deleteDoc(doc(db, 'advances', delId), { requestId: requestIds.get(delId), expectedRevision: revision(delId) });
          }
          if (detectedAdvanceConflicts.length > 0) {
            setSyncConflicts((prev) => [...detectedAdvanceConflicts.map(conflict => ({ ...conflict, scopeKey })), ...prev]);
          }
        } else {
          const batch = writeBatch(db);
          for (const item of upserted as any[]) {
            const ref = doc(db, collectionName, item.id);
            const itemOpId = item.operationId || createOperationId(`op_${collectionName}`);
            const itemCreatedAt = item.createdAt || nowIso;
            const itemAuthorId = item.userId || actorUid;
            batch.set(
              ref,
              sanitizeForFirestore({
                ...item,
                operationId: itemOpId,
                userId: itemAuthorId,
                createdAt: itemCreatedAt,
                syncedBy: actorUid,
                syncedByDisplayName: actorDisplayName,
                syncedAt: nowIso,
                syncState: 'synced',
                updatedAt: nowIso
              }), { requestId: requestIds.get(item.id), expectedRevision: revision(item.id) }
            );
          }
          for (const delId of deletedIds) {
            const ref = doc(db, collectionName, delId);
            batch.delete(ref, { requestId: requestIds.get(delId), expectedRevision: revision(delId) });
          }
          await batch.commit();
        }

        deletedIds.forEach((delId) =>
          pendingInFlightDeletesRef.current[collectionName]?.delete(delId)
        );
        markSyncedNow();
      } catch (err) {
        // Si falla por red (incluso si se cortó después de que Firestore recibió la operación pero antes del ACK),
        // encolamos localmente conservando el MISMO operationId, userId y createdAt para reintento idempotente C-3.
        const pending: QueueInput[] = [];
        upserted.forEach((item: any) => {
          const stableOpId = item.operationId || createOperationId(`op_${collectionName}`);
          const stableCreatedAt = item.createdAt || new Date().toISOString();
          const authorUserId =
            item.userId || profile?.uid || auth.currentUser?.uid || 'local_user';
          const authorDisplayName =
            item.userDisplayName ||
            item.supervisor ||
            profile?.displayName ||
            auth.currentUser?.email ||
            'Usuario';
          pending.push({
            operationId: stableOpId,
            requestId: requestIds.get(item.id),
            writeGroupId: groupByDocument.get(item.id),
            expectedRevision: revision(item.id),
            baseExists: previousById.has(item.id),
            ...(collectionName === 'sectors' && previousById.has(item.id) ? { baseSector: previousById.get(item.id) } : {}),
            createdAt: stableCreatedAt,
            userId: authorUserId,
            userDisplayName: authorDisplayName,
            collectionName,
            documentId: item.id,
            operationType: 'upsert',
            sectorId: item.sectorId,
            galponId: item.galponId,
            activityId: item.activityId,
            activityCode: item.activityCode,
            progressMode: item.progressMode,
            basePercentage: item.basePercentage,
            baseTimestamp: item.baseTimestamp || stableCreatedAt,
            payload: sanitizeForFirestore({
              ...item,
              operationId: stableOpId,
              createdAt: stableCreatedAt,
              userId: authorUserId,
              userDisplayName: authorDisplayName
            }),
            status: collectionName === 'sectors' && (err as { code?: string })?.code === 'STALE_DATA_VERSION' ? 'pending_sync' : 'sync_error',
            errorMessage: err instanceof Error ? err.message : 'Error de red al sincronizar'
          });
        });
        deletedIds.forEach((delId) => {
          pending.push({
            collectionName,
            documentId: delId,
            requestId: requestIds.get(delId),
            writeGroupId: groupByDocument.get(delId),
            expectedRevision: revision(delId),
            operationType: 'delete',
            status: 'sync_error',
            errorMessage: err instanceof Error ? err.message : 'Error de red al sincronizar'
          });
          pendingInFlightDeletesRef.current[collectionName]?.delete(delId);
        });
        queueOperationLocally(pending);
        setSyncStatus('error');
        handleFirestoreError(err, OperationType.WRITE, collectionName);
      }
    },
    [db, scopeKey, isNetworkOnline, markSyncedNow, profile, queueOperationLocally]
  );

  // 2.1 Sincronizar Providers (Plantillas tecnológicas en /providers/{providerId})
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.providers) return;
    const prevTechs = lastSyncedStateRef.current.technologies || [];
    const nextTechs = technologies || [];
    if (JSON.stringify(prevTechs) === JSON.stringify(nextTechs)) return;

    const prevDocs = prevTechs.map((name) => ({
      id: providerIdFromName(name),
      name
    }));
    const nextDocs = nextTechs.map((name) => ({
      id: providerIdFromName(name),
      name
    }));
    const { upserted, deletedIds } = diffById(prevDocs, nextDocs);
    if (upserted.length === 0 && deletedIds.length === 0) return;
    const nowIso = new Date().toISOString();
    const creates = upserted.map(item => ({ item, requestId: crypto.randomUUID() }));
    const deletes = deletedIds.map(id => ({ id, requestId: crypto.randomUUID(), expectedRevision: providerRevisions.current.get(id) ?? 0 }));
    const queue = (status: 'pending_sync' | 'sync_error') => {
      for (const { item, requestId } of creates) {
        queueOperationLocally({
          collectionName: 'settings',
          documentId: item.id,
          requestId,
          operationType: 'upsert',
          payload: { ...item, updatedAt: nowIso },
          status
        });
      }
      for (const { id, requestId, expectedRevision } of deletes) {
        queueOperationLocally({ collectionName: 'settings', documentId: id, requestId, expectedRevision, operationType: 'delete', status });
      }
    };
    if (!isNetworkOnline) {
      queue('pending_sync');
      lastSyncedStateRef.current.technologies = nextTechs;
      return;
    }

    setSyncStatus('syncing');
    const batch = writeBatch(db);
    creates.forEach(({ item, requestId }) => {
      batch.set(doc(db, 'providers', item.id), {
        ...item,
        updatedAt: nowIso,
        updatedBy: profile?.uid || 'system'
      }, { requestId });
    });
    deletes.forEach(({ id, requestId, expectedRevision }) => {
      batch.delete(doc(db, 'providers', id), { requestId, expectedRevision });
    });
    batch
      .commit()
      .then(() => {
        lastSyncedStateRef.current.technologies = nextTechs;
        markSyncedNow();
      })
      .catch((err) => {
        queue('sync_error');
        lastSyncedStateRef.current.technologies = nextTechs;
        setSyncStatus('error');
        handleFirestoreError(err, OperationType.WRITE, 'providers');
      });
  }, [db, technologies, profile, isNetworkOnline, markSyncedNow, queueOperationLocally]);

  // 2.2 Sincronizar Master Catalog
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.masterCatalog) return;
    syncCollectionDiff(
      'masterCatalog',
      lastSyncedStateRef.current.masterCatalog,
      masterCatalog
    );
  }, [masterCatalog, profile, syncCollectionDiff]);

  // 2.3 Sincronizar Sectors y Galpones
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.sectors) return;
    syncCollectionDiff('sectors', lastSyncedStateRef.current.sectors, sectors);
  }, [sectors, profile, syncCollectionDiff]);

  // 2.4 Sincronizar Materials
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.materials) return;
    syncCollectionDiff('materials', lastSyncedStateRef.current.materials, materials);
  }, [materials, profile, syncCollectionDiff]);

  // 2.5 Sincronizar Daily Advances
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.advances) return;
    // Las lecturas fijan la base antes de publicar el estado. Un cambio local posterior conserva su diff.
    syncCollectionDiff(
      'advances',
      lastSyncedStateRef.current.dailyAdvances,
      dailyAdvances
    );
  }, [dailyAdvances, profile, syncCollectionDiff]);

  // 2.6 Sincronizar Workforce
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.workers) return;
    syncCollectionDiff(
      'workers',
      lastSyncedStateRef.current.masterWorkforce,
      masterWorkforce
    );
  }, [masterWorkforce, profile, syncCollectionDiff]);

  // 2.7 Sincronizar Attendance (fusión por operario individual para no sobrescribir otros galpones)
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.attendance) return;

    const prevMap = lastSyncedStateRef.current.attendanceRecords || {};
    const changes = Object.entries(attendanceRecords).flatMap(([date, records]) => {
      const previous = prevMap[date] ?? {};
      const changed = Object.entries(records).filter(([id, status]) => previous[id] !== status) as [string, string | null][];
      for (const id of Object.keys(previous)) if (!Object.prototype.hasOwnProperty.call(records, id)) changed.push([id, null]);
      return changed.length ? [{ requestId: crypto.randomUUID(), payload: { id: date, date, records: Object.fromEntries(changed) },
        expectedRecords: Object.fromEntries(changed.map(([id]) => [id, previous[id] ?? null])) }] : [];
    });
    if (!changes.length) return;
    lastSyncedStateRef.current.attendanceRecords = attendanceRecords;
    queueOperationLocally(changes.map(({ payload, requestId, expectedRecords }) => ({
      collectionName: 'attendance', documentId: payload.id, requestId, operationType: 'upsert',
      payload, expectedRecords, status: 'pending_sync'
    })));
  }, [attendanceRecords, profile, queueOperationLocally]);

  const pullRemoteCollectionsNow = useCallback(async () => {
    if (!isProfileAuthorizedActive(profile)) return;

    const [
      providersSnap,
      catalogSnap,
      sectorsSnap,
      materialsSnap,
      advancesSnap,
      workersSnap,
      attendanceSnap,
      movementsSnap
    ] = await Promise.all([
      getDocs(collection(db, 'providers')),
      getDocs(collection(db, 'masterCatalog')),
      getDocs(collection(db, 'sectors')),
      getDocs(collection(db, 'materials')),
      getDocs(collection(db, 'advances')),
      getDocs(collection(db, 'workers')),
      getDocs(collection(db, 'attendance')),
      getDocs(collection(db, 'movements'))
    ]);

    const currentQueue = readScopedQueue();

    providerRevisions.current = new Map(providersSnap.docs.map(doc => [doc.id, doc.data()._revision ?? 0]));
    const remoteTechs = providersSnap.docs
      .map((d) => String(d.data()?.name || '').trim())
      .filter(Boolean);
    const mergedTechs = reconstructProvidersWithOfflineQueue(remoteTechs, currentQueue);
    lastSyncedStateRef.current.technologies = mergedTechs;
    setTechnologies(mergedTechs);
    isHydratedRef.current.providers = true;

    const remoteCatalog = catalogSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const mergedCatalog = reconstructCollectionWithOfflineQueue(
      remoteCatalog,
      currentQueue,
      'masterCatalog'
    );
    lastSyncedStateRef.current.masterCatalog = mergedCatalog;
    setMasterCatalog(mergedCatalog);
    isHydratedRef.current.masterCatalog = true;

    const remoteSectors = sectorsSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const mergedSectors = reconstructSectorsWithOfflineQueue(remoteSectors, currentQueue);
    lastSyncedStateRef.current.sectors = mergedSectors;
    setSectors(mergedSectors);
    isHydratedRef.current.sectors = true;

    const remoteMaterials = materialsSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const mergedMaterials = reconstructCollectionWithOfflineQueue(
      remoteMaterials,
      currentQueue,
      'materials'
    );
    lastSyncedStateRef.current.materials = mergedMaterials;
    setMaterials(mergedMaterials);
    isHydratedRef.current.materials = true;

    const remoteAdvances = advancesSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    setConfirmedAdvances(remoteAdvances.filter(isConfirmedAdvance));
    const mergedAdvances = reconstructCollectionWithOfflineQueue(
      remoteAdvances,
      currentQueue,
      'advances'
    ).sort((a: any, b: any) => String(b.date || '').localeCompare(String(a.date || '')));
    lastSyncedStateRef.current.dailyAdvances = mergedAdvances;
    setDailyAdvances(mergedAdvances);
    isHydratedRef.current.advances = true;

    const remoteWorkers = workersSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const mergedWorkers = reconstructCollectionWithOfflineQueue(
      remoteWorkers,
      currentQueue,
      'workers'
    ).map(workerForDisplay);
    lastSyncedStateRef.current.masterWorkforce = mergedWorkers;
    setMasterWorkforce(mergedWorkers);
    isHydratedRef.current.workers = true;

    const attMap: Record<string, Record<string, string>> = {};
    attendanceSnap.docs.forEach((d) => {
      const data = d.data();
      const dateKey = data.date || d.id;
      attMap[dateKey] = data.records || {};
    });
    const mergedAttMap = reconstructAttendanceWithOfflineQueue(attMap, currentQueue);
    lastSyncedStateRef.current.attendanceRecords = mergedAttMap;
    setAttendanceRecords(mergedAttMap);
    isHydratedRef.current.attendance = true;

    if (hasModulePermission(profile, 'movimientos', 'view')) {
      const remoteLogs = movementsSnap.docs.map((d) =>
        normalizeMovementDocToAuditLog({ ...d.data(), id: d.id })
      );
      const mergedLogs = remoteLogs.sort((a: any, b: any) =>
        b.sortTimestamp.localeCompare(a.sortTimestamp)
      );
      setAuditLogs(mergedLogs);
      isHydratedRef.current.movements = true;
    }

  }, [
    db,
    readScopedQueue,
    profile,
    setTechnologies,
    setMasterCatalog,
    setSectors,
    setMaterials,
    setDailyAdvances,
    setMasterWorkforce,
    setAttendanceRecords,
    setAuditLogs
  ]);

  // 4. Botón Manual "SINCRONIZAR DATOS" y Reintento Automático al Reconectar
  const triggerManualSync = useCallback(
    async (
      triggeredBy: 'manual' | 'auto_reconnect' = 'manual'
    ): Promise<ManualSyncSummary> => {
      const executedAt = new Date().toLocaleTimeString('es-PE', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      if (syncInFlightRef.current) {
        return {
          executedAt,
          triggeredBy,
          totalProcessed: 0,
          syncedCount: 0,
          conflictCount: 0,
          errorCount: 0,
          remainingPendingCount: pendingOperations.length,
          message: 'Ya hay una sincronización en curso. Por favor espere unos segundos.'
        };
      }

      syncInFlightRef.current = true;
      setIsManualSyncing(true);
      setSyncStatus('syncing');

      try {
        // 4.1 Verificar conexión real a internet
        const online = await checkRealConnectivity();
        if (!online) {
          const summary: ManualSyncSummary = {
            executedAt,
            triggeredBy,
            totalProcessed: 0,
            syncedCount: 0,
            conflictCount: 0,
            errorCount: 0,
            remainingPendingCount: pendingOperations.filter((o) => o.status !== 'synced')
              .length,
            message:
              'Sin conexión a internet. Sus registros permanecen protegidos localmente en este dispositivo y se enviarán en cuanto vuelva la señal.'
          };
          setLastSyncSummary(summary);
          return summary;
        }

        // 4.2 Validar sesión y estado activo del usuario autenticado
        if (!isProfileAuthorizedActive(profile) || auth.currentUser?.uid !== profile?.uid) {
          const summary: ManualSyncSummary = {
            executedAt,
            triggeredBy,
            totalProcessed: 0,
            syncedCount: 0,
            conflictCount: 0,
            errorCount: 1,
            remainingPendingCount: pendingOperations.length,
            message:
              'No se pudo sincronizar: Su sesión ha expirado o el usuario no se encuentra activo.'
          };
          setLastSyncSummary(summary);
          setSyncStatus('error');
          return summary;
        }

        const queueSnapshot = loadPendingSyncQueue();

        const activeUid = profile.uid || auth.currentUser.uid;
        const activeDisplayName =
          profile.displayName || profile.email || auth.currentUser.email || 'Usuario';

        // C-4: Particionar cola según identidad del usuario autenticado (dispositivos compartidos)
        const { ownPendingOps: ownQueue, foreignPendingOps } =
          partitionQueueByUserIdentity(queueSnapshot, activeUid);
        const ownPendingOps = ownQueue.filter(op => op.errorCode !== 'ATTENDANCE_CONFLICT' &&
          !(isGanttWithdrawal(op) && op.errorCode === 'STALE_DATA_VERSION'));
        const retainedConflicts = ownQueue.length - ownPendingOps.length;

        if (ownPendingOps.length === 0) {
          await pullRemoteCollectionsNow();
          markSyncedNow();
          const summary: ManualSyncSummary = {
            executedAt,
            triggeredBy,
            totalProcessed: 0,
            syncedCount: 0,
            alreadyProcessedCount: 0,
            conflictCount: retainedConflicts,
            errorCount: 0,
            remainingPendingCount: foreignPendingOps.length + retainedConflicts,
            foreignBlockedCount: foreignPendingOps.length,
            message:
              retainedConflicts > 0 ? 'Revise los conflictos pendientes en el Centro de Sincronización.'
              : foreignPendingOps.length > 0
                ? `Hay ${foreignPendingOps.length} operación(es) pendientes de otra sesión. Solo su autor podrá enviarlas.`
                : 'Datos actualizados y sincronizados al 100% con Firestore (Sectores, Galpones, Catálogo, Materiales, Avances y Personal).'
          };
          setLastSyncSummary(summary);
          return summary;
        }

        let syncedCount = 0;
        let alreadyProcessedCount = 0;
        let conflictCount = 0;
        let errorCount = 0;
        // C-4: Conservar intactas y protegidas las operaciones pendientes pertenecientes a otros usuarios
        const remainingQueue: PendingSyncOperation[] = [];
        const newConflicts: SyncConflictRecord[] = [];
        const nowIso = new Date().toISOString();

        // Ordenar operaciones del usuario actual cronológicamente por fecha y hora de creación
        const orderedOps = [...ownPendingOps].sort((a, b) =>
          String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
        );
        const groupedOps = new Map<string, PendingSyncOperation[]>();
        for (const op of orderedOps) {
          if (!op.writeGroupId || (op.collectionName !== 'advances' && op.collectionName !== 'workers')) continue;
          const key = op.collectionName + ':' + op.writeGroupId;
          const group = groupedOps.get(key) ?? [];
          group.push(op);
          groupedOps.set(key, group);
        }

        for (const op of orderedOps) {
          const requestId = op.requestId ?? op.operationId;
          if (op.writeGroupId && (op.collectionName === 'advances' || op.collectionName === 'workers')) {
            const key = op.collectionName + ':' + op.writeGroupId;
            const group = groupedOps.get(key);
            if (!group) continue;
            groupedOps.delete(key);
            try {
              if (op.collectionName === 'workers') {
                await importWorkers(db, op.writeGroupId, group.map(item => ({
                  id: item.documentId, requestId: item.requestId ?? item.operationId, data: item.payload,
                  ...(item.sourceRow !== undefined ? { sourceRow: item.sourceRow } : {})
                })));
              } else {
                const completed = await Promise.all(group.map(item => operationCommitted(db, item.requestId ?? item.operationId)));
                if (completed.some(Boolean) && !completed.every(Boolean)) {
                  throw new Error('El grupo tiene confirmaciones parciales. Revise sus partes antes de reenviarlo.');
                }
                if (!completed[0]) await commitAdvanceGroup(db, group.map(item => ({ ...item, requestId: item.requestId ?? item.operationId })));
                else alreadyProcessedCount += group.length;
              }
              syncedCount += group.length;
            } catch (error) {
              errorCount += group.length;
              remainingQueue.push(...group.map(item => ({ ...item, status: 'sync_error' as const,
                retryCount: item.retryCount + 1, errorMessage: error instanceof Error ? error.message : 'No se pudo confirmar el grupo.' })));
            }
            continue;
          }
          try {
            if (await operationCommitted(db, requestId)) {
              syncedCount++;
              alreadyProcessedCount++;
              continue;
            }
            if (isGanttWithdrawal(op)) {
              await withdrawGanttActivity(db, { sectorId: op.documentId, galponId: op.galponId!, activityId: op.activityId!,
                requestId, expectedRevision: op.expectedRevision ?? 0 });
              syncedCount++;
              continue;
            }
            if (op.operationType === 'delete') {
              const targetCol =
                op.collectionName === 'settings' ? 'providers' : op.collectionName;
              await deleteDoc(doc(db, targetCol, op.documentId), { requestId, expectedRevision: op.expectedRevision });
              syncedCount++;
              continue;
            }

            if (op.collectionName === 'advances' && op.payload) {
              const advPayload = op.payload;
              // C-3: Antes de crear/escribir el documento de avance, comprobar si ya existe en Firestore
              const remoteAdvSnap = await getDoc(doc(db, 'advances', op.documentId));
              const existingRemoteAdv = remoteAdvSnap.exists()
                ? remoteAdvSnap.data()
                : null;

              if (op.baseExists) {
                if (!existingRemoteAdv || !hasModulePermission(profile, 'avance_diario', 'edit')) {
                  throw new Error('El avance original ya no está disponible para edición.');
                }
                const edited = stampOperationSyncMetadata({ ...advPayload, syncState: 'synced' }, op,
                  { uid: activeUid, displayName: activeDisplayName }, nowIso);
                await setDoc(doc(db, 'advances', op.documentId), sanitizeForFirestore(edited), { requestId,
                  expectedRevision: op.expectedRevision ?? 0 });
                syncedCount++;
                continue;
              }

              const remoteAdvancesForAct = (
                lastSyncedStateRef.current.dailyAdvances || []
              ).filter(
                (r) =>
                  r &&
                  r.id !== op.documentId &&
                  r.galponId === advPayload.galponId &&
                  (r.activityId ? r.activityId === advPayload.activityId : r.activityCode === advPayload.activityCode)
              );

              const decision = evaluateIdempotentAdvanceSync({
                operation: op,
                existingRemoteDoc: existingRemoteAdv,
                remoteAdvancesForActivity: remoteAdvancesForAct,
                syncingUserId: activeUid,
                syncingUserDisplayName: activeDisplayName,
                nowIso
              });

              if (decision.outcome === 'already_processed') {
                // C-3: El documento ya existe y corresponde a la misma operación; se marca como procesado sin re-ejecutar setDoc
                syncedCount++;
                alreadyProcessedCount++;
                continue;
              }

              if (decision.outcome === 'conflict' && decision.conflictRecord) {
                conflictCount++;
                newConflicts.push(decision.conflictRecord);

                // Solo escribir documento de conflicto si el documento NO existía aún en Firestore
                // (nunca sobrescribir un avance confirmado ni requerir permiso update para Auxiliar)
                if (
                  decision.canWriteConflictedRecord &&
                  !existingRemoteAdv &&
                  decision.payloadToWrite
                ) {
                  await setDoc(
                    doc(db, 'advances', op.documentId),
                    sanitizeForFirestore(decision.payloadToWrite), { requestId }
                  );
                }

                continue;
              }

              if (decision.outcome === 'create' && decision.payloadToWrite) {
                await setDoc(
                  doc(db, 'advances', op.documentId),
                  sanitizeForFirestore(decision.payloadToWrite), { requestId }
                );
                syncedCount++;
              }
            } else if (op.collectionName === 'sectors' && op.payload) {
              const remoteSnap = await getDoc(doc(db, 'sectors', op.documentId));
              const remoteSec = remoteSnap.exists() ? remoteSnap.data() : null;
              assertSafeSectorRebase(op.baseSector, remoteSec, op.expectedRevision ?? 0);
              const { mergedSector, conflicts } = mergeSectorDeepWithConflicts(
                op.payload,
                remoteSec,
                {
                  modifiedGalponIds: op.galponId ? [op.galponId] : undefined,
                  baseSector: op.baseSector,
                  localUser: op.userDisplayName || activeDisplayName,
                  operationId: op.operationId
                }
              );
              if (conflicts.length > 0) {
                conflictCount += conflicts.length;
                newConflicts.push(...conflicts);
              }
              const stampedSector = stampOperationSyncMetadata(
                mergedSector,
                op,
                { uid: activeUid, displayName: activeDisplayName },
                nowIso
              );
              await setDoc(
                doc(db, 'sectors', op.documentId),
                sanitizeForFirestore(stampedSector), { requestId, expectedRevision: remoteSec?._revision ?? 0 }
              );
              syncedCount++;
            } else if (op.collectionName === 'attendance' && op.payload) {
              const stampedAtt = stampOperationSyncMetadata(
                {
                  id: op.documentId,
                  date: op.documentId,
                  records: op.payload.records
                },
                op,
                { uid: activeUid, displayName: activeDisplayName },
                nowIso
              );
              await setDoc(
                doc(db, 'attendance', op.documentId),
                sanitizeForFirestore(stampedAtt),
                { merge: true, requestId, expectedRecords: op.expectedRecords }
              );
              syncedCount++;
            } else if (op.collectionName === 'settings' && op.payload) {
              const stampedProv = stampOperationSyncMetadata(
                op.payload,
                op,
                { uid: activeUid, displayName: activeDisplayName },
                nowIso
              );
              await setDoc(
                doc(db, 'providers', op.documentId),
                sanitizeForFirestore(stampedProv),
                { merge: true, requestId }
              );
              syncedCount++;
            } else if (op.collectionName === 'movements') {
              throw new Error('Este movimiento histórico requiere importación administrativa.');
            } else if (op.payload) {
              const stampedDoc = stampOperationSyncMetadata(
                {
                  ...op.payload,
                  syncState: 'synced'
                },
                op,
                { uid: activeUid, displayName: activeDisplayName },
                nowIso
              );
              await setDoc(
                doc(db, op.collectionName, op.documentId),
                sanitizeForFirestore(stampedDoc),
                { merge: true, requestId, expectedRevision: op.expectedRevision }
              );
              syncedCount++;
            }
          } catch (opErr) {
            errorCount++;
            const errorCode = (opErr as { code?: string } | null)?.code;
            if (errorCode === 'ATTENDANCE_CONFLICT' || (isGanttWithdrawal(op) && errorCode === 'STALE_DATA_VERSION')) conflictCount++;
            remainingQueue.push({
              ...op,
              status: 'sync_error',
              errorCode,
              retryCount: (op.retryCount || 0) + 1,
              errorMessage:
                opErr instanceof Error ? opErr.message : 'Error al escribir en Firestore'
            });
          }
        }

        // Persistir cola restante ANTES de pullRemoteCollectionsNow para que la reconstrucción use la cola actualizada
        const processedIds = new Set(orderedOps.map(op => op.requestId ?? op.operationId));
        const queueAfterSync = await updatePendingSyncQueue(current => [
          ...current.filter(op => op.userId !== activeUid || !processedIds.has(op.requestId ?? op.operationId)),
          ...remainingQueue
        ]).catch(error => { setSyncStorageError(true); throw error; });
        setPendingOperations(queueAfterSync);
        if (newConflicts.length > 0) {
          setSyncConflicts((prev) => [...newConflicts.map(conflict => ({ ...conflict, scopeKey })), ...prev]);
        }

        await pullRemoteCollectionsNow();

        if (errorCount === 0) {
          markSyncedNow();
        } else {
          setSyncStatus('error');
        }

        const foreignNotice =
          foreignPendingOps.length > 0
            ? ` (${foreignPendingOps.length} operación(es) esperan que su autor vuelva a iniciar sesión).`
            : '';

        const summary: ManualSyncSummary = {
          executedAt,
          triggeredBy,
          totalProcessed: orderedOps.length,
          syncedCount,
          alreadyProcessedCount,
          conflictCount,
          errorCount,
          remainingPendingCount: queueAfterSync.length,
          foreignBlockedCount: foreignPendingOps.length,
          message:
            conflictCount > 0
              ? `Sincronización completada: ${syncedCount} operación(es) sincronizada(s) y ${conflictCount} conflicto(s) detectado(s) sin pérdida de datos.${foreignNotice}`
              : errorCount > 0
                ? `Sincronización parcial: ${syncedCount} sincronizada(s), ${errorCount} con error pendiente(s) de reintento.${foreignNotice}`
                : alreadyProcessedCount > 0
                  ? `Sincronización idempotente exitosa: ${syncedCount} operación(es) confirmada(s) (${alreadyProcessedCount} reconocida(s) como ya procesada(s) en Firestore sin duplicar escritura).${foreignNotice}`
                  : `Sincronización exitosa: ${syncedCount} operación(es) enviada(s) y datos remotos actualizados desde Firestore.${foreignNotice}`
        };
        setLastSyncSummary(summary);
        return summary;
      } catch (error) {
        const status = (error as { status?: number } | null)?.status;
        const summary: ManualSyncSummary = {
          executedAt, triggeredBy, totalProcessed: 0, syncedCount: 0, conflictCount: 0, errorCount: 1,
          remainingPendingCount: loadPendingSyncQueue().length,
          message: status === 401 ? 'Su sesión expiró. Vuelva a iniciar sesión para sincronizar.'
            : status === 403 ? 'Su perfil ya no tiene acceso a estos datos.'
            : 'No se pudo comprobar la sincronización. Consulte la cola y vuelva a intentar.'
        };
        setSyncStatus('error');
        setLastSyncSummary(summary);
        return summary;
      } finally {
        syncInFlightRef.current = false;
        setIsManualSyncing(false);
      }
    },
    [
      checkRealConnectivity,
      markSyncedNow,
      pendingOperations,
      db,
      scopeKey,
      profile,
      pullRemoteCollectionsNow
    ]
  );

  // Auto-sincronizar cuando el navegador recupera conexión SOLO para operaciones pertenecientes al usuario autenticado actual (C-4)
  useEffect(() => {
    if (!isNetworkOnline || !isProfileAuthorizedActive(profile) || !auth.currentUser) return;
    const { ownPendingOps } = partitionQueueByUserIdentity(
      pendingOperations,
      profile?.uid
    );
    if (ownPendingOps.some((op) => op.status === 'pending_sync')) {
      triggerManualSync('auto_reconnect');
    }
  }, [isNetworkOnline, profile, pendingOperations, triggerManualSync]);

  const dismissAttendanceConflict = useCallback(async (requestId: string) => {
    const queue = await updatePendingSyncQueue(current => current.filter(op =>
      !(op.userId === profile?.uid && sameOperationalScope(op.scopeKey, scopeKey) && op.errorCode === 'ATTENDANCE_CONFLICT' &&
        (op.requestId ?? op.operationId) === requestId)));
    setPendingOperations(queue);
  }, [profile?.uid, scopeKey]);

  const retryGanttWithdrawal = useCallback(async (requestId: string) => {
    const matches = (op: PendingSyncOperation) => op.userId === profile?.uid && sameOperationalScope(op.scopeKey, scopeKey) &&
      (op.requestId ?? op.operationId) === requestId && isGanttWithdrawal(op) && op.errorCode === 'STALE_DATA_VERSION';
    const op = loadPendingSyncQueue().find(matches);
    if (!op) return;
    const latest = (await getDoc(doc(db, 'sectors', op.documentId))).data();
    if (!latest) throw new Error('El sector ya no está disponible.');
    const queue = await updatePendingSyncQueue(current => current.map(item => matches(item) ? {
      ...item, ganttWithdrawal: true, baseSector: undefined, payload: undefined, expectedRevision: latest._revision ?? 0,
      status: 'pending_sync', errorCode: undefined, errorMessage: undefined
    } : item));
    setPendingOperations(queue);
  }, [db, profile?.uid, scopeKey]);

  // 5. Resolución autorizada de conflictos multiusuario (tanto de avances como de edición de actividades en sectores) con auditoría en /movements
  const resolveSyncConflict = useCallback(
    async (params: {
      conflictId: string;
      resolutionType: 'keep_remote' | 'apply_local' | 'custom_value';
      customValue?: number;
      resolutionNote: string;
    }) => {
      const { conflictId, resolutionType, customValue, resolutionNote } = params;
      if (!profile) return;

      const targetConflict = syncConflicts.find((conflict) => conflict.id === conflictId && sameOperationalScope(conflict.scopeKey, scopeKey));
      if (!targetConflict) return;

      const nowIso = new Date().toISOString();
      const resolvedBy = `${profile.displayName} (${profile.role})`;

      if (targetConflict.collectionName === 'sectors') {
        // Resolución de conflicto de edición simultánea sobre la misma actividad de un galpón (C-1)
        const secId = targetConflict.sectorId || targetConflict.remotePayload?.sectorId;
        if (secId) {
          const remoteSnap = await getDoc(doc(db, 'sectors', secId));
          if (remoteSnap.exists()) {
            const currentSec = remoteSnap.data();
            const resolvedSec = applyActivityConflictResolutionToSector(
              currentSec,
              targetConflict,
              resolutionType,
              customValue
            );
            await setDoc(
              doc(db, 'sectors', secId),
              sanitizeForFirestore({
                ...resolvedSec,
                syncedBy: profile.uid,
                syncedByDisplayName: profile.displayName || profile.email || 'Usuario',
                syncedAt: nowIso,
                updatedAt: nowIso
              })
            );
          }
        }
      } else if (resolutionType === 'keep_remote') {
        // Mantener el valor remoto (ej. 40%); si el documento local es distinto al remoto y existe, marcarlo como resuelto sin alterar el remoto
        const localDoc = targetConflict.localPayload;
        const remoteDoc = targetConflict.remotePayload;
        if (localDoc?.id && localDoc.id !== remoteDoc?.id) {
          await setDoc(
            doc(db, 'advances', localDoc.id),
            sanitizeForFirestore({
              ...localDoc,
              userId: localDoc.userId || profile.uid,
              createdAt: localDoc.createdAt || nowIso,
              syncedBy: profile.uid,
              syncedByDisplayName: profile.displayName || profile.email || 'Usuario',
              syncedAt: nowIso,
              conflictStatus: 'conflict',
              conflictResolved: true,
              resolutionType: 'keep_remote',
              resolvedBy,
              resolvedAt: nowIso,
              resolutionNote
            }),
            { merge: true }
          );
        }
      } else {
        // Aplicar el valor local o un porcentaje personalizado autorizado como nuevo estado válido, preservando el userId original del autor
        const chosenValue =
          resolutionType === 'custom_value' && customValue !== undefined
            ? Math.max(0, Math.min(100, Number(customValue)))
            : targetConflict.localValue;

        const localDoc = targetConflict.localPayload || {};
        const resolutionAdvanceId = localDoc.id || createOperationId('adv_res');
        const mode = normalizeProgressMode(targetConflict.progressMode);

        const resolvedAdvance = sanitizeForFirestore({
          ...localDoc,
          id: resolutionAdvanceId,
          userId: localDoc.userId || profile.uid,
          createdAt: localDoc.createdAt || nowIso,
          updatedAt: nowIso,
          syncedBy: profile.uid,
          syncedByDisplayName: profile.displayName || profile.email || 'Usuario',
          syncedAt: nowIso,
          progressMode: mode,
          quantityToday: chosenValue,
          percentageReached: mode === 'percentage' ? chosenValue : undefined,
          isAuthorizedCorrection: true,
          correctionReason: resolutionNote || 'Resolución autorizada de conflicto multiusuario',
          conflictStatus: 'resolved',
          syncState: 'synced',
          resolvedBy,
          resolvedAt: nowIso
        });

        await setDoc(doc(db, 'advances', resolutionAdvanceId), resolvedAdvance);
      }

      setSyncConflicts((prev) =>
        prev.map((c) =>
          c.id === conflictId
            ? {
                ...c,
                resolved: true,
                resolutionType,
                resolvedValue:
                  resolutionType === 'keep_remote'
                    ? c.remoteValue
                    : resolutionType === 'custom_value'
                      ? customValue
                      : c.localValue,
                resolvedBy,
                resolvedAt: nowIso,
                resolutionNote
              }
            : c
        )
      );

    },
    [db, profile, scopeKey, syncConflicts]
  );

  // Estado consolidado del Indicador Permanente de Conexión y Sincronización (con partición por identidad C-4)
  const {
    ownPendingOps: ownPendingOperations,
    foreignPendingOps: foreignPendingOperations,
    foreignAuthors: foreignPendingAuthors
  } = partitionQueueByUserIdentity(pendingOperations, profile?.uid);

  const activePendingCount = countUniquePendingSyncOperations(
    pendingOperations,
    syncConflicts
  );
  const unresolvedConflictCount = syncConflicts.filter((c) => sameOperationalScope(c.scopeKey, scopeKey) && !c.resolved).length;
  const hasSyncErrors = pendingOperations.some(
    (op) => (op.status || (op as any).syncStatus) === 'sync_error'
  );

  let connectionIndicatorState: ConnectionIndicatorState = 'online';
  if (!isNetworkOnline) {
    connectionIndicatorState = 'offline';
  } else if (syncStatus === 'syncing' || isManualSyncing) {
    connectionIndicatorState = 'syncing';
  } else if (hasSyncErrors || syncStatus === 'error' || unresolvedConflictCount > 0) {
    connectionIndicatorState = 'error';
  } else if (activePendingCount > 0) {
    connectionIndicatorState = 'pending';
  } else {
    connectionIndicatorState = 'online';
  }

  return {
    syncStatus,
    syncStorageError,
    confirmedAdvances,
    lastSyncedAt,
    isNetworkOnline,
    connectionIndicatorState,
    pendingOperations,
    ownPendingOperations: ownPendingOperations.filter(operation => sameOperationalScope(operation.scopeKey, scopeKey)),
    foreignPendingOperations,
    foreignPendingAuthors,
    activePendingCount,
    syncConflicts: syncConflicts.filter(conflict => sameOperationalScope(conflict.scopeKey, scopeKey)),
    unresolvedConflictCount,
    lastSyncSummary,
    isManualSyncing,
    triggerManualSync,
    refreshOperationalData: pullRemoteCollectionsNow,
    dismissAttendanceConflict,
    retryGanttWithdrawal,
    resolveSyncConflict,
    queueOperationLocally
  };
}
