import type React from 'react';
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  writeBatch,
  setDoc,
  type Unsubscribe
} from 'firebase/firestore';
import { db } from './config';
import type { UserProfile } from './authService';
import { hasModulePermission } from './permissions';

// ============================================================================
// 1. Funciones Puras de Serialización y Diferencial (Unit-Testable)
// ============================================================================

/**
 * Elimina recursivamente cualquier propiedad con valor `undefined` para cumplir
 * con las restricciones estrictas del SDK de Cloud Firestore.
 */
export function sanitizeForFirestore<T>(value: T): T {
  if (value === undefined) {
    return null as unknown as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFirestore(item)) as unknown as T;
  }
  const cleanObj: Record<string, any> = {};
  for (const [k, v] of Object.entries(value as Record<string, any>)) {
    if (v !== undefined) {
      cleanObj[k] = sanitizeForFirestore(v);
    }
  }
  return cleanObj as T;
}

/**
 * Genera un ID de documento determinístico para un proveedor/tecnología en `/providers/{providerId}`.
 */
export function providerIdFromName(name: string): string {
  const clean = String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '_');
  return `prov_${clean || 'DEFAULT'}`;
}

export interface DiffResult<T extends { id: string }> {
  upserts: T[];
  deletes: string[];
  nextMap: Map<string, string>;
}

/**
 * Calcula el diferencial exacto entre el último estado sincronizado de una colección
 * y el nuevo estado en memoria para ejecutar únicamente las escrituras y eliminaciones necesarias.
 */
export function computeCollectionDiff<T extends { id: string }>(
  prevMap: Map<string, string>,
  nextDocs: T[]
): DiffResult<T> {
  const upserts: T[] = [];
  const deletes: string[] = [];
  const nextMap = new Map<string, string>();

  for (const rawDoc of nextDocs) {
    if (!rawDoc || !rawDoc.id) continue;
    const cleanDoc = sanitizeForFirestore(rawDoc);
    const serialized = JSON.stringify(cleanDoc);
    nextMap.set(cleanDoc.id, serialized);

    const prevSerialized = prevMap.get(cleanDoc.id);
    if (prevSerialized !== serialized) {
      upserts.push(cleanDoc);
    }
  }

  for (const oldId of prevMap.keys()) {
    if (!nextMap.has(oldId)) {
      deletes.push(oldId);
    }
  }

  return { upserts, deletes, nextMap };
}

export interface AuditMovementRecord {
  id: string;
  timestamp: string;
  createdAt: string;
  user: string;
  userId: string;
  userEmail: string;
  userRole: string;
  type: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN';
  action: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN';
  module: string;
  targetId: string;
  detail: string;
  description: string;
  previousValue?: string;
  newValue?: string;
}

/**
 * Normaliza un documento de `/movements/{movementId}` (creado por cliente o servidor)
 * para que la tabla de Historial de Movimientos lo muestre con todos sus campos.
 */
export function normalizeMovementDocToAuditLog(raw: any): AuditMovementRecord {
  const actionType: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN' =
    raw?.type === 'ELIMINACIÓN' || raw?.action === 'ELIMINACIÓN'
      ? 'ELIMINACIÓN'
      : raw?.type === 'MODIFICACIÓN' || raw?.action === 'MODIFICACIÓN'
      ? 'MODIFICACIÓN'
      : 'REGISTRO';

  const desc = String(raw?.detail || raw?.description || '');
  const timestamp = String(raw?.timestamp || '');
  const createdAt = String(raw?.createdAt || new Date().toISOString());

  return {
    id: String(raw?.id || `mov_${Date.now()}`),
    timestamp,
    createdAt,
    user: String(raw?.user || 'Usuario'),
    userId: String(raw?.userId || ''),
    userEmail: String(raw?.userEmail || ''),
    userRole: String(raw?.userRole || ''),
    type: actionType,
    action: actionType,
    module: String(raw?.module || 'General'),
    targetId: String(raw?.targetId || ''),
    detail: desc,
    description: desc,
    ...(raw?.previousValue ? { previousValue: String(raw.previousValue) } : {}),
    ...(raw?.newValue ? { newValue: String(raw.newValue) } : {})
  };
}

export function buildMovementDocFromInput(params: {
  id: string;
  timestamp: string;
  action: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN';
  module: string;
  description: string;
  profile: UserProfile;
  targetId?: string;
  previousValue?: string;
  newValue?: string;
}): AuditMovementRecord {
  const {
    id,
    timestamp,
    action,
    module,
    description,
    profile,
    targetId,
    previousValue,
    newValue
  } = params;

  const cleanDesc = String(description || '').slice(0, 4900);
  return sanitizeForFirestore({
    id,
    timestamp,
    createdAt: new Date().toISOString(),
    user: `${profile.displayName} (${profile.role})`,
    userId: profile.uid,
    userEmail: profile.email,
    userRole: profile.role,
    type: action,
    action,
    module,
    targetId: targetId || id,
    detail: cleanDesc,
    description: cleanDesc,
    ...(previousValue ? { previousValue: String(previousValue).slice(0, 2000) } : {}),
    ...(newValue ? { newValue: String(newValue).slice(0, 2000) } : {})
  });
}

// ============================================================================
// 2. Ejecución de Batches Atómicos en Firestore (Chunked <= 400 operaciones)
// ============================================================================

async function commitCollectionDiffToFirestore<T extends { id: string }>(
  collectionName: string,
  upserts: T[],
  deletes: string[],
  allowDeletes: boolean
): Promise<void> {
  const effectiveDeletes = allowDeletes ? deletes : [];
  if (upserts.length === 0 && effectiveDeletes.length === 0) return;

  const operations: Array<{ kind: 'set'; item: T } | { kind: 'del'; id: string }> = [
    ...upserts.map((item) => ({ kind: 'set' as const, item })),
    ...effectiveDeletes.map((id) => ({ kind: 'del' as const, id }))
  ];

  const CHUNK_SIZE = 400;
  for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
    const chunk = operations.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const op of chunk) {
      if (op.kind === 'set') {
        const ref = doc(db, collectionName, String(op.item.id));
        batch.set(ref, sanitizeForFirestore(op.item));
      } else {
        const ref = doc(db, collectionName, String(op.id));
        batch.delete(ref);
      }
    }
    await batch.commit();
  }
}

export async function persistAuditMovementToFirestore(
  record: AuditMovementRecord
): Promise<void> {
  if (!record.userId) return;
  const ref = doc(db, 'movements', record.id);
  await setDoc(ref, sanitizeForFirestore(record));
}

// ============================================================================
// 3. Hook de Sincronización Multiusuario en Tiempo Real (FASE 4.4, 4.5, 4.6)
// ============================================================================

export type FirestoreSyncStatus = 'connecting' | 'synced' | 'syncing' | 'offline' | 'error';

interface UseFirestoreOperationalSyncProps {
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
  setAttendanceRecords: React.Dispatch<React.SetStateAction<Record<string, Record<string, string>>>>;
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
}: UseFirestoreOperationalSyncProps) {
  const [syncStatus, setSyncStatus] = useState<FirestoreSyncStatus>('connecting');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  // Mapas de referencia del estado remoto actual en Firestore para evitar ciclos infinitos
  const remoteProvidersMap = useRef<Map<string, string>>(new Map());
  const remoteCatalogMap = useRef<Map<string, string>>(new Map());
  const remoteSectorsMap = useRef<Map<string, string>>(new Map());
  const remoteMaterialsMap = useRef<Map<string, string>>(new Map());
  const remoteAdvancesMap = useRef<Map<string, string>>(new Map());
  const remoteWorkersMap = useRef<Map<string, string>>(new Map());
  const remoteAttendanceMap = useRef<Map<string, string>>(new Map());

  // Banderas de hidratación inicial por colección
  const hydratedRef = useRef<Record<string, boolean>>({
    providers: false,
    masterCatalog: false,
    sectors: false,
    materials: false,
    advances: false,
    workers: false,
    attendance: false
  });

  // Bandera para indicar que un cambio de estado proviene de un snapshot remoto
  const applyingRemoteRef = useRef<Record<string, boolean>>({
    providers: false,
    masterCatalog: false,
    sectors: false,
    materials: false,
    advances: false,
    workers: false,
    attendance: false
  });

  // Monitoreo de conexión de red del navegador
  useEffect(() => {
    const handleOnline = () => {
      setSyncStatus((prev) => (prev === 'offline' ? 'synced' : prev));
    };
    const handleOffline = () => {
      setSyncStatus('offline');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    if (!navigator.onLine) {
      setSyncStatus('offline');
    }
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // --------------------------------------------------------------------------
  // Suscripciones en Tiempo Real (onSnapshot) para las 8 colecciones operativas
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!profile || !profile.active) return;

    const unsubscribers: Unsubscribe[] = [];
    setSyncStatus(navigator.onLine ? 'connecting' : 'offline');

    const markSynced = () => {
      setSyncStatus(navigator.onLine ? 'synced' : 'offline');
      setLastSyncedAt(
        new Date().toLocaleTimeString('es-PE', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      );
    };

    // 1. /providers <-> technologies
    unsubscribers.push(
      onSnapshot(
        collection(db, 'providers'),
        (snap) => {
          const nextMap = new Map<string, string>();
          const items: Array<{ id: string; name: string; order?: number }> = [];
          snap.forEach((docSnap) => {
            const data = sanitizeForFirestore(docSnap.data() as any);
            const id = String(data.id || docSnap.id);
            const item = { id, name: String(data.name || ''), order: Number(data.order ?? 0) };
            nextMap.set(id, JSON.stringify(item));
            items.push(item);
          });
          items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));

          remoteProvidersMap.current = nextMap;
          hydratedRef.current.providers = true;
          applyingRemoteRef.current.providers = true;
          setTechnologies(items.map((i) => i.name));
          markSynced();
        },
        (err) => {
          console.error('[FirestoreSync] Error en /providers:', err);
        }
      )
    );

    // 2. /masterCatalog <-> masterCatalog
    unsubscribers.push(
      onSnapshot(
        collection(db, 'masterCatalog'),
        (snap) => {
          const nextMap = new Map<string, string>();
          const items: any[] = [];
          snap.forEach((docSnap) => {
            const data = sanitizeForFirestore(docSnap.data() as any);
            const id = String(data.id || docSnap.id);
            const item = { ...data, id };
            nextMap.set(id, JSON.stringify(item));
            items.push(item);
          });

          remoteCatalogMap.current = nextMap;
          hydratedRef.current.masterCatalog = true;
          applyingRemoteRef.current.masterCatalog = true;
          setMasterCatalog(items);
          markSynced();
        },
        (err) => {
          console.error('[FirestoreSync] Error en /masterCatalog:', err);
        }
      )
    );

    // 3. /sectors <-> sectors
    unsubscribers.push(
      onSnapshot(
        collection(db, 'sectors'),
        (snap) => {
          const nextMap = new Map<string, string>();
          const items: any[] = [];
          snap.forEach((docSnap) => {
            const data = sanitizeForFirestore(docSnap.data() as any);
            const id = String(data.id || docSnap.id);
            const item = {
              ...data,
              id,
              galpones: Array.isArray(data.galpones) ? data.galpones : []
            };
            nextMap.set(id, JSON.stringify(item));
            items.push(item);
          });

          remoteSectorsMap.current = nextMap;
          hydratedRef.current.sectors = true;
          applyingRemoteRef.current.sectors = true;
          setSectors(items);
          markSynced();
        },
        (err) => {
          console.error('[FirestoreSync] Error en /sectors:', err);
        }
      )
    );

    // 4. /materials <-> materials
    unsubscribers.push(
      onSnapshot(
        collection(db, 'materials'),
        (snap) => {
          const nextMap = new Map<string, string>();
          const items: any[] = [];
          snap.forEach((docSnap) => {
            const data = sanitizeForFirestore(docSnap.data() as any);
            const id = String(data.id || docSnap.id);
            const item = { ...data, id };
            nextMap.set(id, JSON.stringify(item));
            items.push(item);
          });

          remoteMaterialsMap.current = nextMap;
          hydratedRef.current.materials = true;
          applyingRemoteRef.current.materials = true;
          setMaterials(items);
          markSynced();
        },
        (err) => {
          console.error('[FirestoreSync] Error en /materials:', err);
        }
      )
    );

    // 5. /advances <-> dailyAdvances
    unsubscribers.push(
      onSnapshot(
        collection(db, 'advances'),
        (snap) => {
          const nextMap = new Map<string, string>();
          const items: any[] = [];
          snap.forEach((docSnap) => {
            const data = sanitizeForFirestore(docSnap.data() as any);
            const id = String(data.id || docSnap.id);
            const item = { ...data, id };
            nextMap.set(id, JSON.stringify(item));
            items.push(item);
          });
          items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

          remoteAdvancesMap.current = nextMap;
          hydratedRef.current.advances = true;
          applyingRemoteRef.current.advances = true;
          setDailyAdvances(items);
          markSynced();
        },
        (err) => {
          console.error('[FirestoreSync] Error en /advances:', err);
        }
      )
    );

    // 6. /workers <-> masterWorkforce
    unsubscribers.push(
      onSnapshot(
        collection(db, 'workers'),
        (snap) => {
          const nextMap = new Map<string, string>();
          const items: any[] = [];
          snap.forEach((docSnap) => {
            const data = sanitizeForFirestore(docSnap.data() as any);
            const id = String(data.id || docSnap.id);
            const item = { ...data, id };
            nextMap.set(id, JSON.stringify(item));
            items.push(item);
          });

          remoteWorkersMap.current = nextMap;
          hydratedRef.current.workers = true;
          applyingRemoteRef.current.workers = true;
          setMasterWorkforce(items);
          markSynced();
        },
        (err) => {
          console.error('[FirestoreSync] Error en /workers:', err);
        }
      )
    );

    // 7. /attendance <-> attendanceRecords
    unsubscribers.push(
      onSnapshot(
        collection(db, 'attendance'),
        (snap) => {
          const nextMap = new Map<string, string>();
          const recordObj: Record<string, Record<string, string>> = {};
          snap.forEach((docSnap) => {
            const data = sanitizeForFirestore(docSnap.data() as any);
            const dateKey = String(data.date || data.id || docSnap.id);
            const dayRecords =
              data.records && typeof data.records === 'object' ? data.records : {};
            const docPayload = { id: dateKey, date: dateKey, records: dayRecords };
            nextMap.set(dateKey, JSON.stringify(docPayload));
            recordObj[dateKey] = dayRecords;
          });

          remoteAttendanceMap.current = nextMap;
          hydratedRef.current.attendance = true;
          applyingRemoteRef.current.attendance = true;
          setAttendanceRecords(recordObj);
          markSynced();
        },
        (err) => {
          console.error('[FirestoreSync] Error en /attendance:', err);
        }
      )
    );

    // 8. /movements <-> auditLogs (Solo para roles con permiso de consulta en Historial de Movimientos)
    if (hasModulePermission(profile, 'movimientos', 'view')) {
      unsubscribers.push(
        onSnapshot(
          collection(db, 'movements'),
          (snap) => {
            const logs: AuditMovementRecord[] = [];
            snap.forEach((docSnap) => {
              logs.push(normalizeMovementDocToAuditLog(docSnap.data()));
            });
            logs.sort((a, b) => {
              const cmpIso = (b.createdAt || '').localeCompare(a.createdAt || '');
              if (cmpIso !== 0) return cmpIso;
              return (b.timestamp || '').localeCompare(a.timestamp || '');
            });
            setAuditLogs(logs);
          },
          (err) => {
            console.error('[FirestoreSync] Error en /movements:', err);
          }
        )
      );
    }

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [profile?.uid, profile?.role, profile?.active]);

  // --------------------------------------------------------------------------
  // Efectos de Escritura Diferencial (Estado Local -> Firestore)
  // --------------------------------------------------------------------------

  // 1. Sincronizar technologies -> /providers
  useEffect(() => {
    if (!profile || !profile.active || !hydratedRef.current.providers) return;
    if (applyingRemoteRef.current.providers) {
      applyingRemoteRef.current.providers = false;
      return;
    }
    const providerDocs = technologies.map((name, idx) => ({
      id: providerIdFromName(name),
      name: String(name).trim(),
      order: idx
    }));
    const { upserts, deletes, nextMap } = computeCollectionDiff(
      remoteProvidersMap.current,
      providerDocs
    );
    if (upserts.length === 0 && deletes.length === 0) return;

    remoteProvidersMap.current = nextMap;
    setSyncStatus('syncing');
    commitCollectionDiffToFirestore(
      'providers',
      upserts,
      deletes,
      profile.role === 'Administrador'
    )
      .then(() => setSyncStatus(navigator.onLine ? 'synced' : 'offline'))
      .catch((err) => console.error('[FirestoreSync] Error guardando /providers:', err));
  }, [technologies, profile]);

  // 2. Sincronizar masterCatalog -> /masterCatalog
  useEffect(() => {
    if (!profile || !profile.active || !hydratedRef.current.masterCatalog) return;
    if (applyingRemoteRef.current.masterCatalog) {
      applyingRemoteRef.current.masterCatalog = false;
      return;
    }
    const { upserts, deletes, nextMap } = computeCollectionDiff(
      remoteCatalogMap.current,
      masterCatalog
    );
    if (upserts.length === 0 && deletes.length === 0) return;

    remoteCatalogMap.current = nextMap;
    setSyncStatus('syncing');
    commitCollectionDiffToFirestore(
      'masterCatalog',
      upserts,
      deletes,
      profile.role === 'Administrador'
    )
      .then(() => setSyncStatus(navigator.onLine ? 'synced' : 'offline'))
      .catch((err) => console.error('[FirestoreSync] Error guardando /masterCatalog:', err));
  }, [masterCatalog, profile]);

  // 3. Sincronizar sectors -> /sectors
  useEffect(() => {
    if (!profile || !profile.active || !hydratedRef.current.sectors) return;
    if (applyingRemoteRef.current.sectors) {
      applyingRemoteRef.current.sectors = false;
      return;
    }
    const { upserts, deletes, nextMap } = computeCollectionDiff(
      remoteSectorsMap.current,
      sectors
    );
    if (upserts.length === 0 && deletes.length === 0) return;

    remoteSectorsMap.current = nextMap;
    setSyncStatus('syncing');
    commitCollectionDiffToFirestore(
      'sectors',
      upserts,
      deletes,
      profile.role === 'Administrador'
    )
      .then(() => setSyncStatus(navigator.onLine ? 'synced' : 'offline'))
      .catch((err) => console.error('[FirestoreSync] Error guardando /sectors:', err));
  }, [sectors, profile]);

  // 4. Sincronizar materials -> /materials
  useEffect(() => {
    if (!profile || !profile.active || !hydratedRef.current.materials) return;
    if (applyingRemoteRef.current.materials) {
      applyingRemoteRef.current.materials = false;
      return;
    }
    const { upserts, deletes, nextMap } = computeCollectionDiff(
      remoteMaterialsMap.current,
      materials
    );
    if (upserts.length === 0 && deletes.length === 0) return;

    remoteMaterialsMap.current = nextMap;
    setSyncStatus('syncing');
    commitCollectionDiffToFirestore(
      'materials',
      upserts,
      deletes,
      profile.role === 'Administrador' || profile.role === 'Almacén'
    )
      .then(() => setSyncStatus(navigator.onLine ? 'synced' : 'offline'))
      .catch((err) => console.error('[FirestoreSync] Error guardando /materials:', err));
  }, [materials, profile]);

  // 5. Sincronizar dailyAdvances -> /advances
  useEffect(() => {
    if (!profile || !profile.active || !hydratedRef.current.advances) return;
    if (applyingRemoteRef.current.advances) {
      applyingRemoteRef.current.advances = false;
      return;
    }
    const { upserts, deletes, nextMap } = computeCollectionDiff(
      remoteAdvancesMap.current,
      dailyAdvances
    );
    if (upserts.length === 0 && deletes.length === 0) return;

    remoteAdvancesMap.current = nextMap;
    setSyncStatus('syncing');
    commitCollectionDiffToFirestore(
      'advances',
      upserts,
      deletes,
      profile.role === 'Administrador' || profile.role === 'Jefe de proyecto'
    )
      .then(() => setSyncStatus(navigator.onLine ? 'synced' : 'offline'))
      .catch((err) => console.error('[FirestoreSync] Error guardando /advances:', err));
  }, [dailyAdvances, profile]);

  // 6. Sincronizar masterWorkforce -> /workers
  useEffect(() => {
    if (!profile || !profile.active || !hydratedRef.current.workers) return;
    if (applyingRemoteRef.current.workers) {
      applyingRemoteRef.current.workers = false;
      return;
    }
    const { upserts, deletes, nextMap } = computeCollectionDiff(
      remoteWorkersMap.current,
      masterWorkforce
    );
    if (upserts.length === 0 && deletes.length === 0) return;

    remoteWorkersMap.current = nextMap;
    setSyncStatus('syncing');
    commitCollectionDiffToFirestore(
      'workers',
      upserts,
      deletes,
      profile.role === 'Administrador'
    )
      .then(() => setSyncStatus(navigator.onLine ? 'synced' : 'offline'))
      .catch((err) => console.error('[FirestoreSync] Error guardando /workers:', err));
  }, [masterWorkforce, profile]);

  // 7. Sincronizar attendanceRecords -> /attendance
  useEffect(() => {
    if (!profile || !profile.active || !hydratedRef.current.attendance) return;
    if (applyingRemoteRef.current.attendance) {
      applyingRemoteRef.current.attendance = false;
      return;
    }
    const attendanceDocs = Object.entries(attendanceRecords).map(([dateKey, dayMap]) => ({
      id: dateKey,
      date: dateKey,
      records: dayMap || {}
    }));
    const { upserts, deletes, nextMap } = computeCollectionDiff(
      remoteAttendanceMap.current,
      attendanceDocs
    );
    if (upserts.length === 0 && deletes.length === 0) return;

    remoteAttendanceMap.current = nextMap;
    setSyncStatus('syncing');
    commitCollectionDiffToFirestore(
      'attendance',
      upserts,
      deletes,
      profile.role === 'Administrador' || profile.role === 'Jefe de proyecto'
    )
      .then(() => setSyncStatus(navigator.onLine ? 'synced' : 'offline'))
      .catch((err) => console.error('[FirestoreSync] Error guardando /attendance:', err));
  }, [attendanceRecords, profile]);

  const recordAuditMovement = useCallback(
    (
      action: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN',
      module: string,
      description: string,
      options?: {
        targetId?: string;
        previousValue?: any;
        newValue?: any;
      }
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
      const id = `mov_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;

      const prevStr =
        options?.previousValue !== undefined
          ? typeof options.previousValue === 'string'
            ? options.previousValue
            : JSON.stringify(options.previousValue)
          : undefined;
      const newStr =
        options?.newValue !== undefined
          ? typeof options.newValue === 'string'
            ? options.newValue
            : JSON.stringify(options.newValue)
          : undefined;

      const movementDoc = buildMovementDocFromInput({
        id,
        timestamp,
        action,
        module,
        description,
        profile,
        targetId: options?.targetId,
        previousValue: prevStr,
        newValue: newStr
      });

      setAuditLogs((prev) => [movementDoc, ...prev.filter((item) => item.id !== id)]);
      persistAuditMovementToFirestore(movementDoc).catch((err) =>
        console.error('[FirestoreSync] Error registrando auditoría en /movements:', err)
      );
    },
    [profile, setAuditLogs]
  );

  return {
    syncStatus,
    lastSyncedAt,
    recordAuditMovement
  };
}
