import type { User } from 'firebase/auth';
import type { UserProfile } from './authService';
import { auth } from './config';
import { getApiUrl } from './apiConfig';
import { hasModulePermission } from './permissions';
import type { AppModuleId } from './permissions';
import type { HistoricalMovement } from './movementImport';

type Data = Record<string, any>;
type Session = { user: User | null; profile: UserProfile | null };
type Collection = { session: Session; name: string };
type Ref = Collection & { id: string };
type Write = { collection: string; id: string; mode: 'set' | 'merge' | 'delete'; requestId: string; data?: Data;
  expectedRevision?: number; expectedRecords?: Record<string, string | null> };
type Options = { merge?: boolean; requestId?: string; expectedRevision?: number; expectedRecords?: Record<string, string | null> };

const modules: Record<string, AppModuleId> = {
  providers: 'catalogo', masterCatalog: 'catalogo', sectors: 'proyectos', materials: 'materiales',
  advances: 'avance_diario', workers: 'personal', attendance: 'asistencia', movements: 'movimientos'
};

export function operationalScopeKey(profile: UserProfile | null) {
  return 'calera_scope_v2:' + JSON.stringify([profile?.uid, profile?.role]);
}

export function bindOperationalData(profile: UserProfile | null): Session {
  return { user: auth.currentUser?.uid === profile?.uid ? auth.currentUser : null, profile };
}

export const collection = (session: Session, name: string): Collection => ({ session, name });
export const doc = (session: Session, name: string, id: string): Ref => ({ session, name, id });

async function request(session: Session, path: string, body?: object) {
  const { user } = session;
  const assertSession = () => {
    if (!user || auth.currentUser !== user) throw new Error('La sesión cambió. Inicie sesión nuevamente.');
  };
  assertSession();
  const token = await user.getIdToken();
  assertSession();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(getApiUrl(path), {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    });
    assertSession();
    const data = await response.json();
    assertSession();
    if (!response.ok) throw Object.assign(new Error(data.message || 'No se pudo consultar la operación.'), {
      code: data.code, status: response.status
    });
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getDoc(ref: Ref) {
  const { document } = await request(ref.session, '/api/data/' + encodeURIComponent(ref.name) + '/' + encodeURIComponent(ref.id));
  return { id: ref.id, exists: () => document !== null, data: () => document ?? undefined };
}

export async function getDocs(ref: Collection): Promise<{ docs: { id: string; data: () => Data }[] }> {
  if (!hasModulePermission(ref.session.profile, modules[ref.name], 'view')) return { docs: [] };
  const documents = await batchRead(ref.session, ref.name);
  return { docs: documents.map(item => ({ id: item.id, data: () => item })) };
}

type WaitingRead = { name: string; resolve: (documents: Data[]) => void; reject: (error: unknown) => void };
const waiting = new WeakMap<Session, WaitingRead[]>();

function batchRead(session: Session, name: string): Promise<Data[]> {
  return new Promise((resolve, reject) => {
    const group = waiting.get(session);
    if (group) {
      group.push({ name, resolve, reject });
      return;
    }
    const batch = [{ name, resolve, reject }];
    waiting.set(session, batch);
    queueMicrotask(async () => {
      waiting.delete(session);
      try {
        const { documents } = await request(session, '/api/data/snapshot', {
          collections: [...new Set(batch.map(item => item.name))]
        });
        for (const item of batch) item.resolve(documents[item.name]);
      } catch (error) {
        for (const item of batch) item.reject(error);
      }
    });
  });
}

export async function operationCommitted(session: Session, requestId: string): Promise<boolean> {
  return (await request(session, '/api/operation-receipts/' + encodeURIComponent(requestId))).committed === true;
}

export async function importHistoricalMovements(session: Session, entries: HistoricalMovement[]) {
  await request(session, '/api/data/movements/import', { entries });
}

export async function importWorkers(session: Session, operationId: string, entries: { id: string; requestId: string; data: Data; sourceRow?: number }[]) {
  await request(session, '/api/data/workers/import', {
    operationId, writes: entries.map(entry => ({ ...entry, collection: 'workers', mode: 'set' }))
  });
}

export async function withdrawGanttActivity(session: Session, operation: {
  sectorId: string; galponId: string; activityId: string; requestId: string; expectedRevision: number;
}) {
  await request(session, '/api/data/gantt/withdraw', operation);
}

export async function duplicateCatalogTemplate(session: Session, source: string, name: string, requestId: string) {
  await request(session, '/api/data/catalog/templates/duplicate', { source, name, requestId });
}

export function onSnapshot(ref: Collection, onData: (value: Awaited<ReturnType<typeof getDocs>>) => void, onError: (error: unknown) => void) {
  let stopped = false, last: string | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const refresh = async () => {
    try {
      const snapshot = await getDocs(ref);
      if (stopped) return;
      const current = JSON.stringify(snapshot.docs.map(item => item.data()));
      if (current !== last) {
        last = current;
        onData(snapshot);
      }
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      if (!stopped) timer = setTimeout(refresh, 15_000);
    }
  };
  void refresh();
  return () => { stopped = true; clearTimeout(timer); };
}

function write(ref: Ref, mode: Write['mode'], data?: Data, options?: Options): Write {
  const expectedRevision = options?.expectedRevision ?? data?._revision;
  return { collection: ref.name, id: ref.id, mode, requestId: options?.requestId ?? crypto.randomUUID(), ...(data ? { data } : {}),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    ...(options?.expectedRecords ? { expectedRecords: options.expectedRecords } : {}) };
}

async function commit(session: Session, writes: Write[]) {
  for (let offset = 0; offset < writes.length; offset += 100) {
    await request(session, '/api/data/write', { writes: writes.slice(offset, offset + 100) });
  }
}

export const setDoc = (ref: Ref, data: Data, options?: Options) =>
  commit(ref.session, [write(ref, options?.merge ? 'merge' : 'set', data, options)]);

export const deleteDoc = (ref: Ref, options?: Options) =>
  commit(ref.session, [write(ref, 'delete', undefined, options)]);

export function writeBatch(session: Session) {
  const writes: Write[] = [];
  return {
    set: (ref: Ref, data: Data, options?: Options) =>
      writes.push(write(ref, options?.merge ? 'merge' : 'set', data, options)),
    delete: (ref: Ref, options?: Options) => writes.push(write(ref, 'delete', undefined, options)),
    commit: () => commit(session, writes)
  };
}
