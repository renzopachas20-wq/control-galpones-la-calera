import type React from 'react';
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  deleteDoc,
  writeBatch,
  getDoc,
  getDocs
} from 'firebase/firestore';
import { db, auth } from './config';
import type { UserProfile } from './authService';
import { getApiUrl } from './apiConfig';
import {
  type PendingSyncOperation,
  type SyncConflictRecord,
  type ManualSyncSummary,
  type ConnectionIndicatorState,
  createOperationId,
  getOrCreateDeviceId,
  loadPendingSyncQueue,
  savePendingSyncQueue,
  enqueueOfflineOperation,
  loadSyncConflicts,
  saveSyncConflicts,
  detectMultiUserAdvanceConflict,
  evaluateIdempotentAdvanceSync,
  stampOperationSyncMetadata,
  partitionQueueByUserIdentity,
  mergeSectorGalponesIsolated,
  mergeSectorDeepWithConflicts,
  applyActivityConflictResolutionToSector,
  reconstructCollectionWithOfflineQueue,
  reconstructSectorsWithOfflineQueue,
  reconstructAttendanceWithOfflineQueue,
  reconstructProvidersWithOfflineQueue,
  mergeAttendanceDayIsolated,
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

export function providerIdFromName(name: string): string {
  const clean = String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `prov_${clean || 'DEFAULT'}`;
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
  const [syncStatus, setSyncStatus] = useState<'connecting' | 'synced' | 'syncing' | 'error'>(
    'connecting'
  );
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

  const applyingRemoteRef = useRef<Record<string, boolean>>({});
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

  // Mantener copia sincronizada de cola offline y conflictos en localStorage
  useEffect(() => {
    savePendingSyncQueue(pendingOperations);
  }, [pendingOperations]);

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
    (
      op: Omit<
        PendingSyncOperation,
        'operationId' | 'deviceId' | 'createdAt' | 'retryCount' | 'userId' | 'userDisplayName' | 'userRole'
      > & {
        operationId?: string;
        createdAt?: string;
        userId?: string;
        userDisplayName?: string;
        userRole?: string;
      }
    ) => {
      const payloadAuthorId =
        op.userId ||
        (op.payload?.userId && String(op.payload.userId).trim()) ||
        profile?.uid ||
        auth.currentUser?.uid ||
        'local_user';
      const payloadDisplayName =
        op.userDisplayName ||
        op.payload?.userDisplayName ||
        op.payload?.supervisor ||
        profile?.displayName ||
        auth.currentUser?.email ||
        'Usuario';
      const userRole = op.userRole || profile?.role || 'Auxiliar';
      const stableOpId =
        op.operationId || op.payload?.operationId || createOperationId('op');
      const stableCreatedAt =
        op.createdAt || op.payload?.createdAt || new Date().toISOString();

      setPendingOperations((prev) =>
        enqueueOfflineOperation(prev, {
          ...op,
          operationId: stableOpId,
          createdAt: stableCreatedAt,
          userId: payloadAuthorId,
          userDisplayName: payloadDisplayName,
          userRole
        })
      );
    },
    [profile]
  );

  // Rehidratación inmediata desde cola offline al iniciar o reabrir el navegador sin conexión (C-2)
  useEffect(() => {
    const initialQueue = loadPendingSyncQueue().filter((op) => op.status !== 'synced');
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
      reconstructCollectionWithOfflineQueue(prev || [], initialQueue, 'workers')
    );
    setAttendanceRecords((prev) =>
      reconstructAttendanceWithOfflineQueue(prev || {}, initialQueue)
    );
  }, [
    setTechnologies,
    setMasterCatalog,
    setSectors,
    setMaterials,
    setDailyAdvances,
    setMasterWorkforce,
    setAttendanceRecords
  ]);

  // 1. Suscripciones en tiempo real desde Firestore combinadas con cola local offline (C-2)
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile) || !auth.currentUser) return;

    const unsubs: (() => void)[] = [];

    // 1.1 Providers (Plantillas / Tecnologías constructivas en colección /providers)
    unsubs.push(
      onSnapshot(
        collection(db, 'providers'),
        (snap) => {
          applyingRemoteRef.current.providers = true;
          const remoteTechs = snap.docs
            .map((d) => String(d.data()?.name || '').trim())
            .filter(Boolean);
          const currentQueue = loadPendingSyncQueue();
          const mergedTechs = reconstructProvidersWithOfflineQueue(remoteTechs, currentQueue);
          lastSyncedStateRef.current.technologies = mergedTechs;
          setTechnologies(mergedTechs);
          isHydratedRef.current.providers = true;
          markSyncedNow();
          setTimeout(() => {
            applyingRemoteRef.current.providers = false;
          }, 50);
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
          applyingRemoteRef.current.masterCatalog = true;
          const inFlightDeleted =
            pendingInFlightDeletesRef.current.masterCatalog || new Set<string>();
          const remoteItems = snap.docs
            .map((d) => ({ ...d.data(), id: d.id }))
            .filter((item) => !inFlightDeleted.has(item.id));
          const currentQueue = loadPendingSyncQueue();
          const mergedCatalog = reconstructCollectionWithOfflineQueue(
            remoteItems,
            currentQueue,
            'masterCatalog'
          );
          lastSyncedStateRef.current.masterCatalog = mergedCatalog;
          setMasterCatalog(mergedCatalog);
          isHydratedRef.current.masterCatalog = true;
          markSyncedNow();
          setTimeout(() => {
            applyingRemoteRef.current.masterCatalog = false;
          }, 50);
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
          applyingRemoteRef.current.sectors = true;
          const remoteItems = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          const currentQueue = loadPendingSyncQueue();
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
          setTimeout(() => {
            applyingRemoteRef.current.sectors = false;
          }, 50);
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
          applyingRemoteRef.current.materials = true;
          const remoteItems = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          const currentQueue = loadPendingSyncQueue();
          const mergedMaterials = reconstructCollectionWithOfflineQueue(
            remoteItems,
            currentQueue,
            'materials'
          );
          lastSyncedStateRef.current.materials = mergedMaterials;
          setMaterials(mergedMaterials);
          isHydratedRef.current.materials = true;
          markSyncedNow();
          setTimeout(() => {
            applyingRemoteRef.current.materials = false;
          }, 50);
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
          applyingRemoteRef.current.advances = true;
          const remoteItems = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          const currentQueue = loadPendingSyncQueue();
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
          setTimeout(() => {
            applyingRemoteRef.current.advances = false;
          }, 50);
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
          applyingRemoteRef.current.workers = true;
          const remoteItems = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          const currentQueue = loadPendingSyncQueue();
          const mergedWorkers = reconstructCollectionWithOfflineQueue(
            remoteItems,
            currentQueue,
            'workers'
          );
          lastSyncedStateRef.current.masterWorkforce = mergedWorkers;
          setMasterWorkforce(mergedWorkers);
          isHydratedRef.current.workers = true;
          markSyncedNow();
          setTimeout(() => {
            applyingRemoteRef.current.workers = false;
          }, 50);
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
          applyingRemoteRef.current.attendance = true;
          const map: Record<string, Record<string, string>> = {};
          snap.docs.forEach((d) => {
            const data = d.data();
            const dateKey = data.date || d.id;
            map[dateKey] = data.records || {};
          });
          const currentQueue = loadPendingSyncQueue();
          const mergedAttendance = reconstructAttendanceWithOfflineQueue(map, currentQueue);
          lastSyncedStateRef.current.attendanceRecords = mergedAttendance;
          setAttendanceRecords(mergedAttendance);
          isHydratedRef.current.attendance = true;
          markSyncedNow();
          setTimeout(() => {
            applyingRemoteRef.current.attendance = false;
          }, 50);
        },
        (err) => {
          handleFirestoreError(err, OperationType.LIST, 'attendance');
        }
      )
    );

    // 1.8 Movements (Bitácora de Auditoría — en firestore.rules solo roles distintos de Auxiliar tienen lectura)
    if (profile.role !== 'Auxiliar') {
      unsubs.push(
        onSnapshot(
          collection(db, 'movements'),
          (snap) => {
            applyingRemoteRef.current.movements = true;
            const remoteLogs = snap.docs.map((d) =>
              normalizeMovementDocToAuditLog({ ...d.data(), id: d.id })
            );
            const currentQueue = loadPendingSyncQueue();
            const mergedLogs = reconstructCollectionWithOfflineQueue(
              remoteLogs,
              currentQueue,
              'movements'
            ).sort((a: any, b: any) =>
              String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
            );
            setAuditLogs(mergedLogs);
            isHydratedRef.current.movements = true;
            markSyncedNow();
            setTimeout(() => {
              applyingRemoteRef.current.movements = false;
            }, 50);
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
    profile,
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
      const { upserted, deletedIds } = diffById(prevItems, nextItems);
      if (upserted.length === 0 && deletedIds.length === 0) return;

      // Si el dispositivo está sin conexión a internet, encolamos todas las mutaciones en la cola persistente
      if (!isNetworkOnline || (typeof navigator !== 'undefined' && !navigator.onLine)) {
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
          queueOperationLocally({
            operationId: stableOpId,
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
          queueOperationLocally({
            collectionName,
            documentId: delId,
            operationType: 'delete',
            status: 'pending_sync'
          });
        });
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
              })
            );
          }
          for (const delId of deletedIds) {
            await deleteDoc(doc(db, 'sectors', delId));
          }
          if (detectedSectorConflicts.length > 0) {
            setSyncConflicts((prev) => [...detectedSectorConflicts, ...prev]);
          }
        } else if (collectionName === 'advances') {
          // C-3 y C-4: Sincronización idempotente de avances comprobando getDoc antes de crear,
          // evitando sobrescrituras silenciosas y sin requerir permisos update generales para Auxiliar.
          const detectedAdvanceConflicts: SyncConflictRecord[] = [];
          for (const advItem of upserted as any[]) {
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
              profile?.role !== 'Auxiliar' &&
              profile?.role !== 'Almacén' &&
              profile?.role !== 'Solo lectura' &&
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
                sanitizeForFirestore(updatedPayload)
              );
              continue;
            }

            const remoteAdvancesForAct = (prevItems as any[]).filter(
              (r) =>
                r &&
                r.id !== advItem.id &&
                r.galponId === advItem.galponId &&
                ((r.activityId && r.activityId === advItem.activityId) ||
                  r.activityCode === advItem.activityCode)
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
                  sanitizeForFirestore(decision.payloadToWrite)
                );
              }
              continue;
            }
            if (decision.outcome === 'create' && decision.payloadToWrite) {
              await setDoc(
                doc(db, 'advances', advItem.id),
                sanitizeForFirestore(decision.payloadToWrite)
              );
            }
          }
          for (const delId of deletedIds) {
            await deleteDoc(doc(db, 'advances', delId));
          }
          if (detectedAdvanceConflicts.length > 0) {
            setSyncConflicts((prev) => [...detectedAdvanceConflicts, ...prev]);
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
              })
            );
          }
          for (const delId of deletedIds) {
            const ref = doc(db, collectionName, delId);
            batch.delete(ref);
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
          queueOperationLocally({
            operationId: stableOpId,
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
            status: 'sync_error',
            errorMessage: err instanceof Error ? err.message : 'Error de red al sincronizar'
          });
        });
        deletedIds.forEach((delId) => {
          queueOperationLocally({
            collectionName,
            documentId: delId,
            operationType: 'delete',
            status: 'sync_error',
            errorMessage: err instanceof Error ? err.message : 'Error de red al sincronizar'
          });
          pendingInFlightDeletesRef.current[collectionName]?.delete(delId);
        });
        setSyncStatus('error');
        handleFirestoreError(err, OperationType.WRITE, collectionName);
      }
    },
    [isNetworkOnline, markSyncedNow, profile, queueOperationLocally]
  );

  // 2.1 Sincronizar Providers (Plantillas tecnológicas en /providers/{providerId})
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.providers || applyingRemoteRef.current.providers) return;
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

    if (!isNetworkOnline) {
      upserted.forEach((docItem) => {
        queueOperationLocally({
          collectionName: 'settings',
          documentId: docItem.id,
          operationType: 'upsert',
          payload: {
            id: docItem.id,
            name: docItem.name,
            updatedAt: new Date().toISOString(),
            updatedBy: profile?.uid || 'system'
          },
          status: 'pending_sync'
        });
      });
      lastSyncedStateRef.current.technologies = nextTechs;
      return;
    }

    setSyncStatus('syncing');
    const batch = writeBatch(db);
    const nowIso = new Date().toISOString();
    upserted.forEach((docItem) => {
      batch.set(doc(db, 'providers', docItem.id), {
        id: docItem.id,
        name: docItem.name,
        updatedAt: nowIso,
        updatedBy: profile?.uid || 'system'
      });
    });
    deletedIds.forEach((delId) => {
      batch.delete(doc(db, 'providers', delId));
    });
    batch
      .commit()
      .then(() => {
        lastSyncedStateRef.current.technologies = nextTechs;
        markSyncedNow();
      })
      .catch((err) => {
        setSyncStatus('error');
        handleFirestoreError(err, OperationType.WRITE, 'providers');
      });
  }, [technologies, profile, isNetworkOnline, markSyncedNow, queueOperationLocally]);

  // 2.2 Sincronizar Master Catalog
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.masterCatalog || applyingRemoteRef.current.masterCatalog)
      return;
    syncCollectionDiff(
      'masterCatalog',
      lastSyncedStateRef.current.masterCatalog,
      masterCatalog
    );
  }, [masterCatalog, profile, syncCollectionDiff]);

  // 2.3 Sincronizar Sectors y Galpones
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.sectors || applyingRemoteRef.current.sectors) return;
    syncCollectionDiff('sectors', lastSyncedStateRef.current.sectors, sectors);
  }, [sectors, profile, syncCollectionDiff]);

  // 2.4 Sincronizar Materials
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.materials || applyingRemoteRef.current.materials) return;
    syncCollectionDiff('materials', lastSyncedStateRef.current.materials, materials);
  }, [materials, profile, syncCollectionDiff]);

  // 2.5 Sincronizar Daily Advances
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.advances || applyingRemoteRef.current.advances) return;
    syncCollectionDiff(
      'advances',
      lastSyncedStateRef.current.dailyAdvances,
      dailyAdvances
    );
  }, [dailyAdvances, profile, syncCollectionDiff]);

  // 2.6 Sincronizar Workforce
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.workers || applyingRemoteRef.current.workers) return;
    syncCollectionDiff(
      'workers',
      lastSyncedStateRef.current.masterWorkforce,
      masterWorkforce
    );
  }, [masterWorkforce, profile, syncCollectionDiff]);

  // 2.7 Sincronizar Attendance (fusión por operario individual para no sobrescribir otros galpones)
  useEffect(() => {
    if (!isProfileAuthorizedActive(profile)) return;
    if (!isHydratedRef.current.attendance || applyingRemoteRef.current.attendance) return;

    const prevMap = lastSyncedStateRef.current.attendanceRecords || {};
    const changedDates: string[] = [];

    for (const [dateKey, records] of Object.entries(attendanceRecords || {})) {
      if (JSON.stringify(prevMap[dateKey] || {}) !== JSON.stringify(records || {})) {
        changedDates.push(dateKey);
      }
    }

    if (changedDates.length === 0) return;

    if (!isNetworkOnline) {
      changedDates.forEach((dateKey) => {
        queueOperationLocally({
          collectionName: 'attendance',
          documentId: dateKey,
          operationType: 'upsert',
          payload: {
            id: dateKey,
            date: dateKey,
            records: sanitizeForFirestore(attendanceRecords[dateKey] || {})
          },
          status: 'pending_sync'
        });
      });
      lastSyncedStateRef.current.attendanceRecords = attendanceRecords;
      return;
    }

    setSyncStatus('syncing');
    Promise.all(
      changedDates.map((dateKey) => {
        const ref = doc(db, 'attendance', dateKey);
        return setDoc(
          ref,
          {
            id: dateKey,
            date: dateKey,
            records: sanitizeForFirestore(attendanceRecords[dateKey] || {}),
            updatedAt: new Date().toISOString()
          },
          { merge: true }
        );
      })
    )
      .then(() => {
        lastSyncedStateRef.current.attendanceRecords = attendanceRecords;
        markSyncedNow();
      })
      .catch((err) => {
        setSyncStatus('error');
        handleFirestoreError(err, OperationType.WRITE, 'attendance');
      });
  }, [attendanceRecords, profile, isNetworkOnline, markSyncedNow, queueOperationLocally]);

  // 3. Registrar movimiento inmutable en /movements (cumpliendo firestore.rules con type + detail)
  const recordAuditMovement = useCallback(
    async (
      action: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN',
      module: string,
      description: string
    ) => {
      if (!profile) return;
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const timestamp = `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
      const id = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const firestoreEntry = buildMovementDocFromInput({
        id,
        timestamp,
        action,
        module,
        description,
        profile,
        userOverride: `${profile.displayName} (${profile.role})`
      });

      const uiEntry = normalizeMovementDocToAuditLog(firestoreEntry);
      setAuditLogs((prev) => [uiEntry, ...prev]);

      if (!isNetworkOnline || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        queueOperationLocally({
          collectionName: 'movements',
          documentId: id,
          operationType: 'upsert',
          payload: sanitizeForFirestore(firestoreEntry),
          status: 'pending_sync'
        });
        return;
      }

      try {
        await setDoc(doc(db, 'movements', id), sanitizeForFirestore(firestoreEntry));
      } catch (err) {
        queueOperationLocally({
          collectionName: 'movements',
          documentId: id,
          operationType: 'upsert',
          payload: sanitizeForFirestore(firestoreEntry),
          status: 'pending_sync'
        });
        handleFirestoreError(err, OperationType.CREATE, `movements/${id}`);
      }
    },
    [profile, isNetworkOnline, queueOperationLocally, setAuditLogs]
  );

  // Función auxiliar para refrescar activamente todas las colecciones desde Firestore preservando operaciones offline pendientes (C-2)
  const pullRemoteCollectionsNow = useCallback(async () => {
    if (!isProfileAuthorizedActive(profile)) return;

    const [
      providersSnap,
      catalogSnap,
      sectorsSnap,
      materialsSnap,
      advancesSnap,
      workersSnap,
      attendanceSnap
    ] = await Promise.all([
      getDocs(collection(db, 'providers')),
      getDocs(collection(db, 'masterCatalog')),
      getDocs(collection(db, 'sectors')),
      getDocs(collection(db, 'materials')),
      getDocs(collection(db, 'advances')),
      getDocs(collection(db, 'workers')),
      getDocs(collection(db, 'attendance'))
    ]);

    const currentQueue = loadPendingSyncQueue();

    applyingRemoteRef.current.providers = true;
    const remoteTechs = providersSnap.docs
      .map((d) => String(d.data()?.name || '').trim())
      .filter(Boolean);
    const mergedTechs = reconstructProvidersWithOfflineQueue(remoteTechs, currentQueue);
    lastSyncedStateRef.current.technologies = mergedTechs;
    setTechnologies(mergedTechs);
    isHydratedRef.current.providers = true;

    applyingRemoteRef.current.masterCatalog = true;
    const remoteCatalog = catalogSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const mergedCatalog = reconstructCollectionWithOfflineQueue(
      remoteCatalog,
      currentQueue,
      'masterCatalog'
    );
    lastSyncedStateRef.current.masterCatalog = mergedCatalog;
    setMasterCatalog(mergedCatalog);
    isHydratedRef.current.masterCatalog = true;

    applyingRemoteRef.current.sectors = true;
    const remoteSectors = sectorsSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const mergedSectors = reconstructSectorsWithOfflineQueue(remoteSectors, currentQueue);
    lastSyncedStateRef.current.sectors = mergedSectors;
    setSectors(mergedSectors);
    isHydratedRef.current.sectors = true;

    applyingRemoteRef.current.materials = true;
    const remoteMaterials = materialsSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const mergedMaterials = reconstructCollectionWithOfflineQueue(
      remoteMaterials,
      currentQueue,
      'materials'
    );
    lastSyncedStateRef.current.materials = mergedMaterials;
    setMaterials(mergedMaterials);
    isHydratedRef.current.materials = true;

    applyingRemoteRef.current.advances = true;
    const remoteAdvances = advancesSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const mergedAdvances = reconstructCollectionWithOfflineQueue(
      remoteAdvances,
      currentQueue,
      'advances'
    ).sort((a: any, b: any) => String(b.date || '').localeCompare(String(a.date || '')));
    lastSyncedStateRef.current.dailyAdvances = mergedAdvances;
    setDailyAdvances(mergedAdvances);
    isHydratedRef.current.advances = true;

    applyingRemoteRef.current.workers = true;
    const remoteWorkers = workersSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const mergedWorkers = reconstructCollectionWithOfflineQueue(
      remoteWorkers,
      currentQueue,
      'workers'
    );
    lastSyncedStateRef.current.masterWorkforce = mergedWorkers;
    setMasterWorkforce(mergedWorkers);
    isHydratedRef.current.workers = true;

    applyingRemoteRef.current.attendance = true;
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

    if (profile?.role !== 'Auxiliar') {
      const movementsSnap = await getDocs(collection(db, 'movements'));
      applyingRemoteRef.current.movements = true;
      const remoteLogs = movementsSnap.docs.map((d) =>
        normalizeMovementDocToAuditLog({ ...d.data(), id: d.id })
      );
      const mergedLogs = reconstructCollectionWithOfflineQueue(
        remoteLogs,
        currentQueue,
        'movements'
      ).sort((a: any, b: any) =>
        String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
      );
      setAuditLogs(mergedLogs);
      isHydratedRef.current.movements = true;
    }

    setTimeout(() => {
      applyingRemoteRef.current = {};
    }, 80);
  }, [
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
        if (!isProfileAuthorizedActive(profile) || !auth.currentUser) {
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

        const queueSnapshot = loadPendingSyncQueue().filter(
          (op) => op.status !== 'synced' && op.status !== 'conflict'
        );

        const activeUid = profile.uid || auth.currentUser.uid;
        const activeDisplayName =
          profile.displayName || profile.email || auth.currentUser.email || 'Usuario';

        // C-4: Particionar cola según identidad del usuario autenticado (dispositivos compartidos)
        const { ownPendingOps, foreignPendingOps, foreignAuthors } =
          partitionQueueByUserIdentity(queueSnapshot, activeUid);

        if (ownPendingOps.length === 0) {
          await pullRemoteCollectionsNow();
          markSyncedNow();
          const summary: ManualSyncSummary = {
            executedAt,
            triggeredBy,
            totalProcessed: 0,
            syncedCount: 0,
            alreadyProcessedCount: 0,
            conflictCount: 0,
            errorCount: 0,
            remainingPendingCount: foreignPendingOps.length,
            foreignBlockedCount: foreignPendingOps.length,
            foreignAuthors,
            message:
              foreignPendingOps.length > 0
                ? `Dispositivo compartido: Existen ${foreignPendingOps.length} operación(es) pendiente(s) registrada(s) por otro usuario (${foreignAuthors.join(', ')}). Se bloqueó su sincronización automática para preservar la autoría original hasta que dicho usuario inicie sesión.`
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
        const remainingQueue: PendingSyncOperation[] = [...foreignPendingOps];
        const newConflicts: SyncConflictRecord[] = [];
        const nowIso = new Date().toISOString();

        // Ordenar operaciones del usuario actual cronológicamente por fecha y hora de creación
        const orderedOps = [...ownPendingOps].sort((a, b) =>
          String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
        );

        for (const op of orderedOps) {
          try {
            if (op.operationType === 'delete') {
              const targetCol =
                op.collectionName === 'settings' ? 'providers' : op.collectionName;
              await deleteDoc(doc(db, targetCol, op.documentId));
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

              const remoteAdvancesForAct = (
                lastSyncedStateRef.current.dailyAdvances || []
              ).filter(
                (r) =>
                  r &&
                  r.id !== op.documentId &&
                  r.galponId === advPayload.galponId &&
                  ((r.activityId && r.activityId === advPayload.activityId) ||
                    r.activityCode === advPayload.activityCode)
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
                    sanitizeForFirestore(decision.payloadToWrite)
                  );
                }

                await recordAuditMovement(
                  'REGISTRO',
                  'Sincronización Multiusuario',
                  `Conflicto detectado y protegido en [${advPayload.activityCode || op.documentId}]: valor local (${decision.conflictRecord.localValue}) vs. valor en servidor (${decision.conflictRecord.remoteValue}). Autor original: ${op.userDisplayName} (${op.userId}) | Sincronizado por: ${activeDisplayName} (${activeUid}).`
                );
                continue;
              }

              if (decision.outcome === 'create' && decision.payloadToWrite) {
                await setDoc(
                  doc(db, 'advances', op.documentId),
                  sanitizeForFirestore(decision.payloadToWrite)
                );
                syncedCount++;
              }
            } else if (op.collectionName === 'sectors' && op.payload) {
              const remoteSnap = await getDoc(doc(db, 'sectors', op.documentId));
              const remoteSec = remoteSnap.exists() ? remoteSnap.data() : null;
              const { mergedSector, conflicts } = mergeSectorDeepWithConflicts(
                op.payload,
                remoteSec,
                {
                  modifiedGalponIds: op.galponId ? [op.galponId] : undefined,
                  localUser: op.userDisplayName || activeDisplayName,
                  operationId: op.operationId
                }
              );
              if (conflicts.length > 0) {
                conflictCount += conflicts.length;
                newConflicts.push(...conflicts);
                for (const c of conflicts) {
                  await recordAuditMovement(
                    'REGISTRO',
                    'Sincronización Multiusuario',
                    `Conflicto de edición concurrente detectado en actividad [${c.activityCode}] (${c.galponCode || c.galponId}): se conservó la versión del servidor (${c.remoteUser}) y se registró el cambio de ${c.localUser} para resolución autorizada.`
                  );
                }
              }
              const stampedSector = stampOperationSyncMetadata(
                mergedSector,
                op,
                { uid: activeUid, displayName: activeDisplayName },
                nowIso
              );
              await setDoc(
                doc(db, 'sectors', op.documentId),
                sanitizeForFirestore(stampedSector)
              );
              syncedCount++;
            } else if (op.collectionName === 'attendance' && op.payload) {
              const remoteSnap = await getDoc(doc(db, 'attendance', op.documentId));
              const remoteRecs = remoteSnap.exists()
                ? remoteSnap.data()?.records
                : {};
              const mergedRecs = mergeAttendanceDayIsolated(
                remoteRecs,
                op.payload.records
              );
              const stampedAtt = stampOperationSyncMetadata(
                {
                  id: op.documentId,
                  date: op.documentId,
                  records: mergedRecs
                },
                op,
                { uid: activeUid, displayName: activeDisplayName },
                nowIso
              );
              await setDoc(
                doc(db, 'attendance', op.documentId),
                sanitizeForFirestore(stampedAtt),
                { merge: true }
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
                { merge: true }
              );
              syncedCount++;
            } else if (op.collectionName === 'movements' && op.payload) {
              // En /movements/{movementId}, firestore.rules exige request.resource.data.userId == request.auth.uid
              const movementPayload = sanitizeForFirestore({
                ...op.payload,
                userId: activeUid,
                originalAuthorUserId: op.userId || op.payload.userId || activeUid,
                operationId: op.operationId,
                createdAt: op.payload.createdAt || op.createdAt || nowIso,
                syncedBy: activeUid,
                syncedByDisplayName: activeDisplayName,
                syncedAt: nowIso
              });
              await setDoc(doc(db, 'movements', op.documentId), movementPayload);
              syncedCount++;
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
                { merge: true }
              );
              syncedCount++;
            }
          } catch (opErr) {
            errorCount++;
            remainingQueue.push({
              ...op,
              status: 'sync_error',
              retryCount: (op.retryCount || 0) + 1,
              errorMessage:
                opErr instanceof Error ? opErr.message : 'Error al escribir en Firestore'
            });
          }
        }

        // Persistir cola restante ANTES de pullRemoteCollectionsNow para que la reconstrucción use la cola actualizada
        savePendingSyncQueue(remainingQueue);
        setPendingOperations(remainingQueue);
        if (newConflicts.length > 0) {
          setSyncConflicts((prev) => [...newConflicts, ...prev]);
        }

        await pullRemoteCollectionsNow();

        if (errorCount === 0) {
          markSyncedNow();
        } else {
          setSyncStatus('error');
        }

        const foreignNotice =
          foreignPendingOps.length > 0
            ? ` (${foreignPendingOps.length} operación(es) de ${foreignAuthors.join(', ')} permanecen protegidas en espera de su autor).`
            : '';

        const summary: ManualSyncSummary = {
          executedAt,
          triggeredBy,
          totalProcessed: orderedOps.length,
          syncedCount,
          alreadyProcessedCount,
          conflictCount,
          errorCount,
          remainingPendingCount: remainingQueue.length,
          foreignBlockedCount: foreignPendingOps.length,
          foreignAuthors,
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
      } finally {
        syncInFlightRef.current = false;
        setIsManualSyncing(false);
      }
    },
    [
      checkRealConnectivity,
      markSyncedNow,
      pendingOperations,
      profile,
      pullRemoteCollectionsNow,
      recordAuditMovement
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

      const targetConflict = syncConflicts.find((c) => c.id === conflictId);
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

      await recordAuditMovement(
        'MODIFICACIÓN',
        'Resolución de Conflicto Multiusuario',
        `Resolvió conflicto en [${targetConflict.activityCode}] (${targetConflict.galponCode || targetConflict.galponId}): Decisión = ${
          resolutionType === 'keep_remote'
            ? `Conservar versión en servidor (${targetConflict.remoteValue})`
            : resolutionType === 'apply_local'
              ? `Aplicar versión offline (${targetConflict.localValue})`
              : `Establecer valor conciliado (${customValue})`
        }. Motivo: ${resolutionNote || 'Sin observación adicional'}`
      );
    },
    [profile, recordAuditMovement, syncConflicts]
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
  const unresolvedConflictCount = syncConflicts.filter((c) => !c.resolved).length;
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
    lastSyncedAt,
    isNetworkOnline,
    connectionIndicatorState,
    pendingOperations,
    ownPendingOperations,
    foreignPendingOperations,
    foreignPendingAuthors,
    activePendingCount,
    syncConflicts,
    unresolvedConflictCount,
    lastSyncSummary,
    isManualSyncing,
    triggerManualSync,
    resolveSyncConflict,
    recordAuditMovement,
    queueOperationLocally
  };
}
