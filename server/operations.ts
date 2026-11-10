import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Express, Request, Response } from 'express';
import type { DocumentSnapshot, Firestore, Transaction } from '@google-cloud/firestore';
import { AuthError, requireProfile, type createAuthService, type Profile } from './auth.ts';
import { hasModulePermission, MODULE_LABELS } from '../src/firebase/permissions.ts';
import type { AppModuleId, PermissionAction } from '../src/firebase/permissions.ts';
import { indexMaterialConsumption } from '../src/firebase/materialConsumption.ts';
import { barnActivities, findAdvanceActivity } from '../src/firebase/advanceActivity.ts';
import { canUserAuthorizePercentageCorrection, normalizeProgressMode, validatePercentageAdvanceRegistration } from '../src/firebase/offlineSyncEngine.ts';
import { invalidWorkerField, normalizeWorkerCode, workerAtLocation } from '../src/firebase/workerData.ts';
import { catalogCodeKey, getActiveMasterCatalog, providerIdFromName } from '../src/catalog/catalogSelectorEngine.ts';

const collections = {
  providers: 'catalogo', masterCatalog: 'catalogo', sectors: 'proyectos', materials: 'materiales',
  advances: 'avance_diario', workers: 'personal', attendance: 'asistencia', movements: 'movimientos'
} as const;
type Collection = keyof typeof collections;
type Data = Record<string, any>;
type RecordData = Data & { id: string };
type Sector = RecordData & { galpones?: RecordData[]; sheds?: RecordData[] };
type SectorEvent = { module: AppModuleId; targetCollection: string; targetId: string; label: string;
  type: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN'; galponId?: string };
type Write = { collection: Exclude<Collection, 'movements'>; id: string; requestId: string; mode: 'set' | 'merge' | 'delete';
  data?: Data; expectedRevision?: number; expectedRecords?: Record<string, string | null>; sourceRow?: number };

const syncFields = new Set(['operationId', 'deviceId', 'userId', 'userDisplayName', 'syncedBy', 'syncedByDisplayName',
  'syncedAt', 'syncState', 'createdAt', 'updatedAt', 'updatedBy', 'baseUpdatedAt', '_revision']);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const clean = (value: Data, ignored: string[] = []) => Object.fromEntries(
  Object.entries(value).filter(([key]) => !syncFields.has(key) && !ignored.includes(key))
);
const docId = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 240 && !value.includes('/') && value !== '.' && value !== '..' && !/^__.*__$/.test(value);
const object = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = isDeepStrictEqual;
function sectorContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sectorContent);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(clean(value)).map(([key, item]) => [key, sectorContent(item)]));
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const record = (doc: DocumentSnapshot): RecordData | null => doc.exists ? { ...doc.data(), id: doc.id } : null;
const barns = (sector: Sector): RecordData[] => sector.galpones ?? sector.sheds ?? [];
const attendanceStates = ['Asistió', 'Falta', 'Atención Médica', 'Permiso', 'Descanso Médico'];

function validDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function bad(message = 'La operación contiene datos inválidos.'): never {
  throw new AuthError(400, 'INVALID_OPERATION', message);
}

function forbidden(): never {
  throw new AuthError(403, 'OPERATION_FORBIDDEN', 'Su perfil no puede realizar esta operación sobre estos datos.');
}

function requirePermission(profile: Profile, module: AppModuleId, action: PermissionAction) {
  if (!hasModulePermission(profile, module, action)) forbidden();
}

function readCollection(value: unknown): Collection {
  if (typeof value !== 'string' || !own(collections, value)) bad('La colección no está disponible.');
  return value as Collection;
}

function readWrites(value: unknown, limit = 100, workerImport = false): Write[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) bad(`Envíe entre 1 y ${limit} operaciones.`);
  const targets = new Set<string>(), ids = new Set<string>();
  return value.map(input => {
    if (!object(input)) bad();
    const { id, requestId, mode, data, expectedRevision, expectedRecords, sourceRow } = input;
    const collection = readCollection(input.collection);
    if (collection === 'movements') forbidden();
    if (!docId(id) || !docId(requestId) || !['set', 'merge', 'delete'].includes(mode) ||
        (mode !== 'delete' && (!object(data) || (data.id !== undefined && data.id !== id))) ||
        (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) bad();
    if (collection === 'attendance' && mode !== 'delete' &&
        (!object(data.records) || Object.entries(data.records).some(([worker, state]) =>
          !docId(worker) || (state !== null && !attendanceStates.includes(state as string))))) bad();
    if (collection === 'advances' && mode !== 'delete' && data.workerIds !== undefined &&
      (!Array.isArray(data.workerIds) || data.workerIds.length > 200 || !data.workerIds.every(docId) ||
       new Set(data.workerIds).size !== data.workerIds.length)) bad('Revise los operarios vinculados al avance.');
    if (expectedRecords !== undefined &&
        (collection !== 'attendance' || mode === 'delete' || !object(expectedRecords) ||
         Object.keys(expectedRecords).length !== Object.keys(data.records).length ||
         Object.entries(expectedRecords).some(([worker, state]) =>
           !own(data.records, worker) || (state !== null && (typeof state !== 'string' || state.length > 100))))) bad();
    const path = collection + '/' + id;
    if (targets.has(path) || ids.has(requestId)) bad('Una operación por documento e identificador.');
    targets.add(path);
    ids.add(requestId);
    if (sourceRow !== undefined && (!workerImport || !Number.isSafeInteger(sourceRow) || sourceRow < 1)) bad('Fila de Personal inválida.');
    return { collection, id, requestId, mode, ...(mode !== 'delete' ? { data } : {}),
      ...(sourceRow !== undefined ? { sourceRow } : {}),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      ...(expectedRecords !== undefined ? { expectedRecords } : {}) };
  });
}

function mergeData(before: Data, after: Data): Data {
  return { ...before, ...Object.fromEntries(Object.entries(after).map(([key, value]) => [
    key, own(before, key) && object(before[key]) && object(value) ? mergeData(before[key], value) : value
  ])) };
}

function indexed(values: unknown, key: (value: Data) => unknown): Map<string, Data> {
  if (values === undefined) return new Map();
  if (!Array.isArray(values)) bad();
  const result = new Map<string, Data>();
  for (const value of values) {
    if (!object(value)) bad();
    const id = key(value);
    if (typeof id !== 'string' || !id.trim() || result.has(id)) bad('La jerarquía contiene identificadores inválidos o duplicados.');
    result.set(id, value);
  }
  return result;
}

// The application stores activities inside structures, with optional systems inside an area.
const hierarchy = { areas: ['sistemas', 'structures'], sistemas: ['structures'], structures: ['activities'], activities: [] } as const;
type Level = keyof typeof hierarchy;

function checkActivities(profile: Profile, before: Data, after: Data, level: Level, knownBarns: Set<string>,
  galponId: string, events: SectorEvent[]) {
  const key = (item: Data) => level === 'activities' ? item.id : (item.id ?? item.name);
  const old = indexed(before[level], key), next = indexed(after[level], key);
  for (const [id, item] of next) {
    const previous = old.get(id);
    if (!previous) {
      if (!hasModulePermission(profile, 'gantt', 'create')) requirePermission(profile, 'actividades', 'create');
      events.push({ module: 'actividades', targetCollection: level, targetId: id, label: item.name ?? id, type: 'REGISTRO', galponId });
    } else if (!same(clean(previous, [...hierarchy[level]]), clean(item, [...hierarchy[level]]))) {
      const scheduleOnly = level === 'activities' &&
        same(clean(previous, ['startDate', 'dueDate']), clean(item, ['startDate', 'dueDate']));
      if (!scheduleOnly || !hasModulePermission(profile, 'gantt', 'edit')) requirePermission(profile, 'actividades', 'edit');
      events.push({ module: scheduleOnly ? 'gantt' : 'actividades', targetCollection: level, targetId: id,
        label: item.name ?? id, type: 'MODIFICACIÓN', galponId });
    }
    if (level === 'activities' && (!previous || item.startDate !== previous.startDate || item.dueDate !== previous.dueDate)) {
      const { startDate, dueDate } = item;
      if ((startDate && !validDay(startDate)) || (dueDate && !validDay(dueDate)) || (startDate && dueDate && startDate > dueDate)) {
        bad('Revise las fechas. El inicio de la actividad debe ser anterior o igual al fin.');
      }
    }
    if (level === 'activities' && item.sharedWithGalponId && item.sharedWithGalponId !== previous?.sharedWithGalponId &&
        !knownBarns.has(item.sharedWithGalponId)) bad('El galpón vinculado no existe.');
    for (const child of hierarchy[level]) checkActivities(profile, previous ?? {}, item, child, knownBarns, galponId, events);
  }
  for (const [id, item] of old) {
    if (!next.has(id)) {
      requirePermission(profile, 'actividades', 'delete');
      events.push({ module: 'actividades', targetCollection: level, targetId: id, label: item.name ?? id, type: 'ELIMINACIÓN', galponId });
    }
  }
}

function writeSector(profile: Profile, previous: Sector | null, next: Sector | null, sectors: Sector[], events: SectorEvent[]): Sector | null {
  if (!['create', 'edit', 'delete'].some(action =>
    hasModulePermission(profile, 'proyectos', action as PermissionAction) ||
    hasModulePermission(profile, 'actividades', action as PermissionAction) ||
    hasModulePermission(profile, 'gantt', action as PermissionAction))) forbidden();
  if (!next) {
    requirePermission(profile, 'proyectos', 'delete');
    return null;
  }
  if (typeof next.name !== 'string' || !next.name.trim() || !Array.isArray(next.galpones) || own(next, 'sheds')) {
    bad('Se requiere un sector y su lista de galpones.');
  }
  if (!previous) {
    requirePermission(profile, 'proyectos', 'create');
    events.push({ module: 'proyectos', targetCollection: 'sectors', targetId: next.id, label: next.name, type: 'REGISTRO' });
  } else if (!same(clean(previous, ['galpones', 'sheds', 'deletedGalponTombstones']),
                   clean(next, ['galpones', 'sheds', 'deletedGalponTombstones']))) {
    requirePermission(profile, 'proyectos', 'edit');
    events.push({ module: 'proyectos', targetCollection: 'sectors', targetId: next.id, label: next.name, type: 'MODIFICACIÓN' });
  }
  const old = indexed(previous ? barns(previous) : [], barn => barn.id);
  const proposed = indexed(next.galpones, barn => barn.id);
  const codes = (entries: Map<string, Data>) => {
    const counts = new Map<string, number>();
    for (const barn of entries.values()) {
      const code = typeof barn.code === 'string' ? barn.code.trim().toUpperCase() : '';
      if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return counts;
  };
  const previousCodes = codes(old);
  if ([...codes(proposed)].some(([code, count]) => count > 1 && count > (previousCodes.get(code) ?? 0))) {
    throw new AuthError(409, 'BARN_CODE_CONFLICT', 'El código de galpón ya existe dentro del sector.');
  }
  const knownBarns = new Set([...sectors.filter(sector => sector.id !== next.id).flatMap(sector => barns(sector).map(barn => barn.id)),
    ...proposed.keys()]);
  const oldTombstones = previous?.deletedGalponTombstones ?? {};
  const tombstones = next.deletedGalponTombstones ?? {};
  if (!object(tombstones)) bad();
  for (const [id, tombstone] of Object.entries(tombstones)) {
    if (!same(tombstone, oldTombstones[id])) {
      requirePermission(profile, 'proyectos', 'delete');
      if (!old.has(id) || proposed.has(id)) forbidden();
    }
  }
  for (const [id, barn] of proposed) {
    if (!docId(id) || (barn.sectorId !== undefined && barn.sectorId !== next.id)) bad('Galpón inválido para el sector.');
    const original = old.get(id);
    const submittedExclusions = barn.ganttExcludedActivityIds;
    if (submittedExclusions !== undefined && (!Array.isArray(submittedExclusions) || !submittedExclusions.every(docId))) {
      bad('La lista de retiros del plan contiene identificadores inválidos.');
    }
    const existingExclusions = new Set<string>(original?.ganttExcludedActivityIds ?? []);
    if (submittedExclusions?.some((activityId: string) => !existingExclusions.has(activityId))) {
      throw new AuthError(403, 'GANTT_WITHDRAWAL_REQUIRED', 'El retiro del plan requiere su propia operación.');
    }
    if (existingExclusions.size) {
      const activeIds = new Set(barnActivities(barn as RecordData).map(activity => activity.id));
      const retained = [...existingExclusions].filter(activityId => activeIds.has(activityId)).sort();
      if (retained.length) barn.ganttExcludedActivityIds = retained;
      else delete barn.ganttExcludedActivityIds;
    } else delete barn.ganttExcludedActivityIds;
    if (!original || !same(original.areas, barn.areas)) {
      const countActivities = (item?: RecordData) => {
        const counts = new Map<string, number>();
        for (const activity of barnActivities(item)) counts.set(activity.id, (counts.get(activity.id) ?? 0) + 1);
        return counts;
      };
      const known = countActivities(original as RecordData | undefined);
      if ([...countActivities(barn as RecordData)].some(([activityId, count]) => count > 1 && count > (known.get(activityId) ?? 0))) {
        bad('Una actividad no puede tener el mismo identificador en dos estructuras del galpón.');
      }
    }
    if (!original) {
      requirePermission(profile, 'proyectos', 'create');
      if (own(oldTombstones, id)) forbidden();
      events.push({ module: 'proyectos', targetCollection: 'galpones', targetId: id, label: barn.name ?? barn.code ?? id,
        type: 'REGISTRO', galponId: id });
      checkActivities(profile, {}, barn, 'areas', knownBarns, id, events);
      continue;
    }
    if (same(clean(original), clean(barn))) continue;
    const activityFields = ['areas', 'deletedActivityTombstones', 'ganttExcludedActivityIds'];
    if (!same(clean(original, activityFields), clean(barn, activityFields))) {
      requirePermission(profile, 'proyectos', 'edit');
      events.push({ module: 'proyectos', targetCollection: 'galpones', targetId: id, label: barn.name ?? barn.code ?? id,
        type: 'MODIFICACIÓN', galponId: id });
    }
    const tombstonesChanged = !same(original.deletedActivityTombstones ?? {}, barn.deletedActivityTombstones ?? {});
    if (tombstonesChanged) requirePermission(profile, 'actividades', 'delete');
    const eventCount = events.length;
    checkActivities(profile, original, barn, 'areas', knownBarns, id, events);
    if (tombstonesChanged && events.length === eventCount) {
      events.push({ module: 'actividades', targetCollection: 'galpones', targetId: id,
        label: 'Registro de bajas de actividades · ' + id, type: 'MODIFICACIÓN', galponId: id });
    }
  }
  for (const id of old.keys()) {
    if (!proposed.has(id)) requirePermission(profile, 'proyectos', 'delete');
  }
  const order = new Set([...old.keys(), ...proposed.keys()]);
  return { ...next, galpones: [...order].flatMap(id => proposed.has(id) ? [proposed.get(id) as RecordData] : []),
    ...(Object.keys(oldTombstones).length || Object.keys(tombstones).length
      ? { deletedGalponTombstones: { ...oldTombstones, ...tombstones } } : {}) };
}

const archiveLocation = (db: Firestore, type: 'sector' | 'galpon', id: string) =>
  db.collection('_structuralLocations').doc(hash(type + '/' + id));

async function checkStructuralRemoval(tx: Transaction, db: Firestore, previous: Sector, next: Sector | null,
  sectors: Sector[], isolated: boolean) {
  const kept = new Set(next ? barns(next).map(barn => barn.id) : []);
  const removed = barns(previous).filter(barn => !kept.has(barn.id));
  if (next && !removed.length) return removed;
  const beforeRemainder = { ...previous, galpones: barns(previous).filter(barn => kept.has(barn.id)) };
  const structuralContent = (sector: Sector) => sectorContent(clean(sector, ['sheds', 'deletedGalponTombstones']));
  if (!isolated || (next && !same(structuralContent(beforeRemainder), structuralContent(next)))) {
    throw new AuthError(409, 'STRUCTURAL_DELETE_MUST_BE_SEPARATE', 'La baja de un sector o galpón debe enviarse por separado.');
  }
  const ids = new Set(removed.map(barn => barn.id));
  const references = (item: Data) => (!next && item.sectorId === previous.id) ||
    ids.has(item.galponId) || ids.has(item.sharedWithGalponId);
  if (sectors.some(sector => sector.id !== previous.id && barns(sector).some(barn => ids.has(barn.id)))) {
    throw new AuthError(409, 'STRUCTURAL_DEPENDENCIES', 'El identificador del galpón también existe en otro sector.');
  }
  const operational = await Promise.all(['advances', 'materials', 'workers', 'attendance'].map(name => tx.get(db.collection(name))));
  if (operational.some(snapshot => snapshot.docs.some(doc => references(doc.data()))) || sectors.some(sector =>
    barns(sector).some(barn => !ids.has(barn.id) && barnActivities(barn).some(references)))) {
    throw new AuthError(409, 'STRUCTURAL_DEPENDENCIES', 'La ubicación tiene registros operativos vinculados. Se conservó junto con su historial.');
  }
  // Historical movements keep a durable location reference even after an empty location is removed.
  return removed;
}

async function checkActivityRemoval(tx: Transaction, db: Firestore, previous: Sector, next: Sector, isolated: boolean) {
  const previousBarns = new Map(barns(previous).map(barn => [barn.id, barn]));
  const changes = barns(next).flatMap(barn => {
    const survivingIds = new Set(barnActivities(barn).map(activity => activity.id));
    const removed = barnActivities(previousBarns.get(barn.id)).filter(activity => !survivingIds.has(activity.id));
    return removed.length ? [{ galponId: barn.id, removed }] : [];
  });
  if (!changes.length) return;
  if (!isolated) throw new AuthError(409, 'ACTIVITY_DELETE_MUST_BE_SEPARATE', 'La baja de actividades requiere una solicitud separada.');
  for (const { galponId, removed } of changes) {
    const advances = await tx.get(db.collection('advances').where('galponId', '==', galponId));
    if (advances.docs.some(doc => {
      const advance = doc.data();
      return (!advance.sectorId || advance.sectorId === previous.id) && removed.some(activity =>
        advance.activityId ? advance.activityId === activity.id : advance.activityCode && advance.activityCode === activity.code);
    })) throw new AuthError(409, 'ACTIVITY_DEPENDENCIES', 'La actividad tiene avances registrados. Puede retirarla del plan sin perder su historial.');
  }
}

async function prepareWorkerCodes(tx: Transaction, db: Firestore, profile: Profile,
  writes: Write[], current: DocumentSnapshot[], seen: DocumentSnapshot[], importing: boolean) {
  const changes = new Map<string, { code: string; oldCode: string; row: number }>();
  const requested = new Map<string, string>();
  for (const [index, write] of writes.entries()) {
    if (write.collection !== 'workers' || seen[index].exists) continue;
    const previous = record(current[index]);
    const next = write.mode === 'delete' ? null : mergeData(write.mode === 'merge' ? previous ?? {} : {}, write.data!);
    requirePermission(profile, 'personal', next ? previous ? 'edit' : 'create' : 'delete');
    const row = write.sourceRow ?? index + 1;
    const invalid = next && invalidWorkerField(next, importing);
    if (invalid) bad(importing ? `Fila ${row}: campo ${invalid} inválido.` : `Campo de Personal inválido: ${invalid}.`);
    const code = normalizeWorkerCode(next?.workerCode), oldCode = normalizeWorkerCode(previous?.workerCode);
    if (code === oldCode) continue;
    if (code && requested.has(code)) {
      throw new AuthError(409, 'WORKER_CODE_CONFLICT', `Fila ${row}: el código de Personal está repetido.`);
    }
    if (code) requested.set(code, write.id);
    changes.set(write.id, { code, oldCode, row });
  }
  const codes = [...new Set([...changes.values()].flatMap(({ code, oldCode }) => [code, oldCode]).filter(Boolean))];
  const refs = codes.map(code => db.collection('_workerCodes').doc(hash(code)));
  const reservations = refs.length ? await tx.getAll(...refs) : [];
  const byCode = new Map(codes.map((code, index) => [code, reservations[index]]));
  // Compare the normalized form of legacy documents that predate code reservations.
  if (requested.size) {
    for (const doc of (await tx.get(db.collection('workers'))).docs) {
      const code = normalizeWorkerCode(doc.get('workerCode'));
      const target = requested.get(code);
      if (target && target !== doc.id) {
        throw new AuthError(409, 'WORKER_CODE_CONFLICT', `Fila ${changes.get(target)!.row}: el código de Personal ya existe.`);
      }
    }
    for (const [code, target] of requested) {
      const owner = byCode.get(code)!.get('workerId');
      if (owner && owner !== target) {
        throw new AuthError(409, 'WORKER_CODE_CONFLICT', `Fila ${changes.get(target)!.row}: el código de Personal ya está reservado.`);
      }
    }
  }
  return () => {
    for (const [workerId, { code, oldCode }] of changes) {
      const old = byCode.get(oldCode);
      if (old?.get('workerId') === workerId) tx.delete(old.ref);
      if (code) tx.set(byCode.get(code)!.ref, { workerId });
    }
  };
}

function assertData(collection: Write['collection'], data: Data) {
  const required: Partial<Record<Collection, string[]>> = {
    providers: ['name'], masterCatalog: ['code', 'name'], materials: ['name', 'unit'],
    advances: ['date', 'galponId', 'activityCode'], workers: ['name'], attendance: ['date']
  };
  if (required[collection]?.some(key => typeof data[key] !== 'string' || !data[key].trim())) bad();
  if (collection === 'attendance' && !object(data.records)) bad();
  if (collection === 'masterCatalog' && data.durationDays !== undefined &&
      (!Number.isSafeInteger(data.durationDays) || data.durationDays < 1 || data.durationDays > 3650)) bad('Duración de catálogo inválida.');
  if (collection === 'materials' && [data.initialUsedQty ?? 0, data.totalQty].some(value =>
    typeof value !== 'number' || !Number.isFinite(value) || value < 0)) bad();
}

async function readProfile(tx: Transaction, db: Firestore, identity: Awaited<ReturnType<ReturnType<typeof createAuthService>['authenticate']>>) {
  return requireProfile((await tx.get(db.collection('users').doc(identity.uid))).data() as Profile ?? null, identity.uid, identity);
}

function barnOwners(sectors: Sector[]) {
  const owners = new Map<string, Set<string>>();
  for (const sector of sectors) for (const barn of barns(sector)) {
    if (!owners.has(barn.id)) owners.set(barn.id, new Set());
    owners.get(barn.id)!.add(sector.id);
  }
  return owners;
}

function activityFor(sectors: Sector[], advance: Data) {
  const matches = sectors.filter(item => (!advance.sectorId || item.id === advance.sectorId) &&
    barns(item).some(barn => barn.id === advance.galponId));
  const sector = matches.length === 1 ? matches[0] : undefined;
  const matchingBarns = sector ? barns(sector).filter(item => item.id === advance.galponId) : [];
  const barn = matchingBarns.length === 1 ? matchingBarns[0] : undefined;
  const activities = barnActivities(barn);
  const activity = findAdvanceActivity(activities, advance.activityId, advance.activityCode);
  return activity && sector ? { activity: activity as Data, sector,
    legacyCodeIsUnique: findAdvanceActivity(activities, undefined, activity.code) !== undefined } : null;
}

async function readSectors(tx: Transaction, db: Firestore) {
  return (await tx.get(db.collection('sectors'))).docs.map(doc => record(doc) as Sector);
}

function publicRecord(profile: Profile, collection: Collection, item: RecordData): RecordData | null {
  if (collection === 'sectors') {
    const { sheds, ...data } = item;
    return { ...data, galpones: barns(item as Sector) };
  }
  if (collection === 'movements' && item.module === 'Administración de Usuarios' && profile.role !== 'Administrador') return null;
  return item;
}

export function registerOperationalRoutes(app: Express, db: Firestore, service: Pick<ReturnType<typeof createAuthService>, 'authenticate'>) {
  const route = (work: (req: Request, identity: Awaited<ReturnType<typeof service.authenticate>>) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const identity = await service.authenticate(req.headers.authorization);
        res.json(await work(req, identity));
      } catch (error) {
        if (error instanceof AuthError) res.status(error.status).json({ code: error.code, message: error.message });
        else res.status(503).json({ code: 'OPERATIONAL_UNAVAILABLE', message: 'No se pudo confirmar la operación. Intente nuevamente.' });
      }
    };

  app.get('/api/data/:collection{/:id}', route(async (req, identity) => {
    const collection = readCollection(req.params.collection);
    const id = req.params.id;
    if (id !== undefined && !docId(id)) bad();
    return db.runTransaction(async tx => {
      const profile = await readProfile(tx, db, identity);
      requirePermission(profile, collections[collection], 'view');
      const ref = db.collection(collection);
      if (typeof id === 'string') {
        const item = record(await tx.get(ref.doc(id)));
        const visible = item && publicRecord(profile, collection, item);
        if (item && !visible) forbidden();
        return { document: visible };
      }
      const items = (await tx.get(ref)).docs.flatMap(doc => {
        const item = publicRecord(profile, collection, record(doc)!);
        return item ? [item] : [];
      });
      return { documents: items };
    }, { readOnly: true });
  }));

  app.get('/api/operation-receipts/:id', route(async (req, identity) => {
    if (!docId(req.params.id)) bad();
    return db.runTransaction(async tx => {
      await readProfile(tx, db, identity);
      const receipt = await tx.get(db.collection('_operationalReceipts').doc(hash(identity.uid + ':' + req.params.id)));
      return { committed: receipt.exists };
    }, { readOnly: true });
  }));

  app.post('/api/data/snapshot', route(async (req, identity) => {
    const input = req.body?.collections;
    if (!Array.isArray(input) || input.length < 1 || input.length > Object.keys(collections).length) bad();
    const names = [...new Set(input.map(readCollection))];
    return db.runTransaction(async tx => {
      const profile = await readProfile(tx, db, identity);
      for (const name of names) requirePermission(profile, collections[name], 'view');
      const results = await Promise.all(names.map(async name => {
        const items = (await tx.get(db.collection(name))).docs.flatMap(doc => {
          const item = publicRecord(profile, name, record(doc)!);
          return item ? [item] : [];
        });
        return [name, items] as const;
      }));
      return { documents: Object.fromEntries(results) };
    }, { readOnly: true });
  }));

  app.post('/api/data/gantt/withdraw', route(async (req, identity) => {
    const input = req.body;
    if (!object(input) || Object.keys(input).some(key => !['sectorId', 'galponId', 'activityId', 'requestId', 'expectedRevision'].includes(key))) bad();
    const { sectorId, galponId, activityId, requestId, expectedRevision } = input;
    if (![sectorId, galponId, activityId, requestId].every(docId) ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) bad();
    const ref = db.collection('sectors').doc(sectorId);
    const receipt = db.collection('_operationalReceipts').doc(hash(identity.uid + ':' + requestId));
    const fingerprint = hash(canonical(['gantt.withdraw', sectorId, galponId, activityId]));
    return db.runTransaction(async tx => {
      const profile = await readProfile(tx, db, identity);
      requirePermission(profile, 'gantt', 'delete');
      const [stored, seen] = await tx.getAll(ref, receipt);
      if (seen.exists && seen.get('fingerprint') !== fingerprint) {
        throw new AuthError(409, 'OPERATION_ID_CONFLICT', 'El identificador corresponde a otra operación.');
      }
      const sector = record(stored) as Sector | null;
      const matches = sector ? barns(sector).filter(item => item.id === galponId) : [];
      if (!sector || matches.length !== 1) bad('El galpón no pertenece de forma inequívoca al sector.');
      const [barn] = matches;
      if (seen.exists) return { committed: true };
      const revision = sector._revision ?? 0;
      if (expectedRevision !== revision) {
        throw new AuthError(409, 'STALE_DATA_VERSION', 'El sector cambió. Revise el plan vigente antes de reenviar el retiro.');
      }
      if (!findAdvanceActivity(barnActivities(barn), activityId)) bad('La actividad no pertenece al galpón.');
      const excluded = barn.ganttExcludedActivityIds ?? [];
      const now = new Date();
      tx.create(receipt, { fingerprint, actorUid: identity.uid, collection: 'sectors', targetId: sectorId, createdAt: now.toISOString() });
      if (!excluded.includes(activityId)) {
        tx.update(ref, { [sector.galpones ? 'galpones' : 'sheds']: barns(sector).map(item => item.id === galponId
          ? { ...item, ganttExcludedActivityIds: [...excluded, activityId].sort() } : item),
          _revision: revision + 1, updatedAt: now.toISOString(), updatedBy: profile.uid });
        const id = 'ops-' + receipt.id;
        tx.create(db.collection('movements').doc(id), {
          id, timestamp: now.toLocaleString('es-PE', { timeZone: 'America/Lima' }), createdAt: now.toISOString(),
          user: profile.displayName, userId: profile.uid, userRole: profile.role, module: MODULE_LABELS.gantt,
          type: 'MODIFICACIÓN', detail: 'Retiro del plan Gantt · ' + activityId, targetId: activityId,
          targetCollection: 'activities', sectorId, galponId, requestId,
          projectCode: barn.projectCode ?? sector.projectName ?? sector.code ?? sector.name,
          ganttWithdrawals: [{ galponId, activityId }]
        });
      }
      return { committed: true };
    });
  }));

  async function commitWrites(writes: Write[], identity: Awaited<ReturnType<typeof service.authenticate>>, workerImportId?: string) {
    const importReceipt = workerImportId ? {
      ref: db.collection('_operationalReceipts').doc(hash(identity.uid + ':' + workerImportId)),
      fingerprint: hash(canonical(['workers.import', writes]))
    } : null;
    await db.runTransaction(async tx => {
      const profile = await readProfile(tx, db, identity);
      if (importReceipt) {
        requirePermission(profile, 'personal', 'import');
        const existing = await tx.get(importReceipt.ref);
        if (existing.exists) {
          if (existing.get('fingerprint') !== importReceipt.fingerprint) {
            throw new AuthError(409, 'OPERATION_ID_CONFLICT', 'El identificador corresponde a otra operación.');
          }
          return;
        }
      }
      for (const write of writes) requirePermission(profile, collections[write.collection], 'view');
      const touchesSectors = writes.some(write => write.collection === 'sectors');
      const rawSectors = touchesSectors || writes.some(write => write.collection === 'advances') ? await readSectors(tx, db) : undefined;
      const ownership = touchesSectors ? barnOwners(rawSectors!) : new Map<string, Set<string>>();
      const docs = writes.map(write => db.collection(write.collection).doc(write.id));
      const receipts = writes.map(write => db.collection('_operationalReceipts').doc(hash(identity.uid + ':' + write.requestId)));
      const tombstones = writes.map(write => db.collection('_operationalDeletions').doc(hash(write.collection + '/' + write.id)));
      const [current, seen, deleted] = await Promise.all([tx.getAll(...docs), tx.getAll(...receipts), tx.getAll(...tombstones)]);
      if (workerImportId) {
        if (current.some(doc => doc.exists) || seen.some(receipt => receipt.exists)) {
          throw new AuthError(409, 'WORKER_IMPORT_CONFLICT', 'El lote contiene una persona o solicitud que ya existe.');
        }
      } else if (writes.filter((write, index) => write.collection === 'workers' && write.mode !== 'delete' &&
        !current[index].exists && !seen[index].exists).length > 1) {
        requirePermission(profile, 'personal', 'import');
      }
      const reserveWorkerCodes = await prepareWorkerCodes(tx, db, profile, writes, current, seen, Boolean(workerImportId));
      const catalogKeys = new Map<string, string>();
      for (const [index, write] of writes.entries()) {
        if (write.collection !== 'masterCatalog' || write.mode === 'delete' || seen[index].exists) continue;
        const previous = record(current[index]);
        requirePermission(profile, 'catalogo', previous ? 'edit' : 'create');
        const next = mergeData(write.mode === 'merge' ? previous ?? {} : {}, write.data!);
        const activeKey = (item: Data | null) => item && item.active !== false && !item.deleted && !item.isDeleted && !item.deletedAt
          ? catalogCodeKey(item.technology, item.code) : '';
        const key = activeKey(next);
        if (!key || key === activeKey(previous)) continue;
        if (catalogKeys.has(key)) throw new AuthError(409, 'CATALOG_CODE_CONFLICT', 'El código de actividad está repetido en la plantilla.');
        catalogKeys.set(key, write.id);
      }
      if (catalogKeys.size) {
        const catalog = await tx.get(db.collection('masterCatalog'));
        for (const doc of catalog.docs) {
          const item = doc.data();
          if (item.active === false || item.deleted || item.isDeleted || item.deletedAt) continue;
          const conflictingId = catalogKeys.get(catalogCodeKey(item.technology, item.code));
          if (conflictingId && conflictingId !== doc.id) {
            throw new AuthError(409, 'CATALOG_CODE_CONFLICT', 'El código de actividad ya existe en la plantilla.');
          }
        }
      }
      const candidateBarnIds = [...new Set(writes.flatMap((write, index) => {
        if (write.collection !== 'sectors' || seen[index].exists || !Array.isArray(write.data?.galpones)) return [];
        const previous = record(current[index]) as Sector | null;
        const known = new Set(previous ? barns(previous).map(barn => barn.id) : []);
        return write.data.galpones.filter(object).map(barn => barn.id).filter(id => docId(id) && !known.has(id));
      }))];
      const archivedBarns = candidateBarnIds.length ? await tx.getAll(...candidateBarnIds.map(id => archiveLocation(db, 'galpon', id))) : [];
      if (archivedBarns.some(doc => doc.exists)) throw new AuthError(409, 'DATA_DELETED', 'El identificador de un galpón retirado no puede reutilizarse.');
      const workerIds = [...new Set(writes.flatMap((write, index) => {
        if (seen[index].exists || write.mode === 'delete') return [];
        if (write.collection === 'advances') return write.data?.workerIds ?? [];
        if (write.collection !== 'attendance') return [];
        const records = write.data?.records;
        return Object.keys(records ?? {}).filter(docId);
      }))];
      const workers = workerIds.length ? new Map((await tx.getAll(...workerIds.map(id => db.collection('workers').doc(id))))
        .map(doc => [doc.id, record(doc)])) : new Map<string, RecordData | null>();
      const locationSectorIds = [...new Set([
        ...writes.flatMap((write, index) => [write.data?.sectorId, current[index].get('sectorId')]),
        ...[...workers.values()].map(worker => worker?.sectorId)
      ].filter(docId))];
      const locationSectors = rawSectors ?? (locationSectorIds.length
        ? (await tx.getAll(...locationSectorIds.map(id => db.collection('sectors').doc(id))))
          .flatMap(doc => doc.exists ? [record(doc) as Sector] : [])
        : []);
      const stockChanges = writes.some(write => write.collection === 'advances' || write.collection === 'materials');
      const materialCollection = db.collection('materials');
      const advances = stockChanges ? new Map((await tx.get(db.collection('advances'))).docs.map(doc => [doc.id, record(doc)!])) : new Map<string, RecordData>();
      const materials = stockChanges ? new Map((await tx.get(materialCollection)).docs.map(doc => [doc.id, record(doc)!])) : new Map<string, RecordData>();
      const deletingWorkers = new Set(writes.filter((write, index) => write.collection === 'workers' && write.mode === 'delete' &&
        current[index].exists && !seen[index].exists).map(write => write.id));
      if (deletingWorkers.size) {
        const [attendance, logs] = await Promise.all([tx.get(db.collection('attendance')),
          stockChanges ? Promise.resolve([...advances.values()]) : tx.get(db.collection('advances')).then(result => result.docs.map(doc => doc.data()))]);
        if (attendance.docs.some(doc => Object.keys(doc.get('records') ?? {}).some(id => deletingWorkers.has(id))) ||
            logs.some(log => Array.isArray(log.workerIds) && log.workerIds.some(id => deletingWorkers.has(id))) ||
            workerIds.some(id => deletingWorkers.has(id))) {
          throw new AuthError(409, 'WORKER_DEPENDENCIES', 'El operario tiene historial de asistencia o avances. Puede marcarlo como inactivo.');
        }
      }
      const originalStock = new Map(materials);
      const stockToUpdate = new Set<string>();
      for (const [index, write] of writes.entries()) {
        const { collection, mode } = write;
        const module = collections[collection];
        const previous = record(current[index]);
        const base = mode === 'merge' && previous
          ? publicRecord(profile, collection, previous) ?? {} : {};
        let next: RecordData | null = mode === 'delete' ? null : { ...mergeData(base, write.data!), id: write.id };
        const fingerprint = hash(canonical(write));
        if (seen[index].exists) {
          if (seen[index].get('fingerprint') !== fingerprint) {
            throw new AuthError(409, 'OPERATION_ID_CONFLICT', 'El identificador corresponde a otra operación.');
          }
          continue;
        }
        const action = mode === 'delete' ? 'delete' : previous ? 'edit' : 'create';
        const revision = previous?._revision ?? 0;
        let removedBarns: RecordData[] = [];
        const sectorEvents: SectorEvent[] = [];
        if (collection === 'sectors') {
          next = writeSector(profile, previous as Sector | null, next as Sector | null, rawSectors!, sectorEvents);
          if (previous) removedBarns = await checkStructuralRemoval(tx, db, previous as Sector, next as Sector | null, rawSectors!, writes.length === 1);
          if (previous && next) await checkActivityRemoval(tx, db, previous as Sector, next as Sector, writes.length === 1);
          if (next) for (const barn of barns(next as Sector)) {
            const owners = ownership.get(barn.id);
            const wasHere = owners?.has(write.id);
            if (!wasHere && owners?.size) forbidden();
            if (!owners) ownership.set(barn.id, new Set([write.id]));
          }
        } else if (collection === 'attendance') {
          if (!next) {
            requirePermission(profile, 'asistencia', 'delete');
            if (previous && write.expectedRevision !== revision) {
              throw new AuthError(409, 'STALE_DATA_VERSION', 'La asistencia del día cambió. Actualice antes de eliminarla.');
            }
          } else {
            assertData(collection, next);
            if (next.date !== write.id || !validDay(next.date)) bad('La fecha de asistencia no coincide con el registro.');
            const patch = write.data?.records;
            if (!object(patch)) bad();
            const records = { ...(previous?.records ?? {}) };
            for (const [id, status] of Object.entries(patch)) {
              const worker = workers.get(id);
              if (!worker && status !== null) bad('El trabajador no existe.');
              const previousState = own(records, id) ? records[id] : null;
              if (status === previousState) continue;
              requirePermission(profile, 'asistencia', status === null ? 'delete' : previousState !== null ? 'edit' : 'create');
              if ((write.expectedRecords?.[id] ?? null) !== previousState) {
                throw new AuthError(409, 'ATTENDANCE_CONFLICT', 'La asistencia del trabajador cambió en otra sesión. Compare el registro vigente antes de corregirlo.');
              }
              if (status === null) delete records[id];
              else records[id] = status;
            }
            next.records = records;
          }
        } else {
          requirePermission(profile, module, action);
          if (next) assertData(collection, next);
        }
        if (collection === 'workers' && typeof next?.workerCode === 'string') next.workerCode = normalizeWorkerCode(next.workerCode);
        if (next && (collection === 'materials' || collection === 'workers' || collection === 'attendance') &&
            (!previous || next.sectorId !== previous.sectorId || next.galponId !== previous.galponId) &&
            (next.sectorId || next.galponId)) {
          const sector = locationSectors.find(item => item.id === next!.sectorId);
          if (!sector || (next.galponId && !barns(sector).some(barn => barn.id === next!.galponId))) {
            bad('El sector y galpón indicados no corresponden a una asignación existente.');
          }
        }
        if (collection !== 'attendance' && (write.expectedRevision ?? 0) !== revision) {
          throw new AuthError(409, 'STALE_DATA_VERSION', 'El registro cambió en otra sesión. Actualice y revise la operación.');
        }
        if (next && !previous && collection !== 'providers' && deleted[index].exists) {
          throw new AuthError(409, 'DATA_DELETED', 'El registro se eliminó en otra sesión.');
        }
        if (collection === 'advances') {
          if (next?.isAuthorizedCorrection && !same(previous?.isAuthorizedCorrection, next.isAuthorizedCorrection)) {
            if (!canUserAuthorizePercentageCorrection(profile.role)) forbidden();
          }
          if (next && !same(previous?.sharedWithGalponId, next.sharedWithGalponId) && next.sharedWithGalponId &&
              rawSectors!.flatMap(sector => barns(sector)).filter(barn => barn.id === next!.sharedWithGalponId).length !== 1) {
            bad('El galpón vinculado no existe o su identificador es ambiguo.');
          }
          if (next) {
            const location = activityFor(rawSectors!, next);
            if (!location && (!previous || previous.galponId !== next.galponId ||
                previous.activityId !== next.activityId || previous.activityCode !== next.activityCode)) bad('La actividad no pertenece al galpón.');
            if (location) {
              next.sectorId = location.sector.id;
              next.activityId = location.activity.id;
              next.activityCode = location.activity.code;
            }
            const sameLocation = previous?.sectorId === next.sectorId && previous?.galponId === next.galponId;
            if (Array.isArray(next.workerIds)) {
              const retained = sameLocation && Array.isArray(previous?.workerIds) ? new Set(previous.workerIds) : new Set();
              for (const id of next.workerIds) {
                if (retained.has(id)) continue;
                const worker = workers.get(id);
                if (!worker || !workerAtLocation(worker, next.sectorId, next.galponId)) {
                  bad('El avance contiene un operario inactivo o ajeno al galpón.');
                }
              }
            }
            const mode = normalizeProgressMode(location?.activity.progressMode ?? previous?.progressMode);
            const qty = Number(mode === 'percentage' ? next.percentageReached ?? next.quantityToday : next.quantityToday);
            if (!validDay(next.date) || !Number.isFinite(qty) || qty < 0) bad('Fecha o cantidad de avance inválida.');
            if (mode === 'percentage' && next.conflictStatus !== 'conflict') {
              const existing = [...advances.values()].filter(log => log.galponId === next!.galponId &&
                (log.activityId ? log.activityId === next!.activityId
                  : (location?.legacyCodeIsUnique ?? true) && log.activityCode === next!.activityCode));
              const check = validatePercentageAdvanceRegistration({ newPercentage: qty, existingLogsForActivity: existing,
                editingAdvanceId: write.id, isAuthorizedCorrection: next.isAuthorizedCorrection,
                correctionReason: next.correctionReason, userRole: profile.role });
              if (!check.valid) throw new AuthError(409, 'ADVANCE_CONFLICT', check.error!);
            }
            next.progressMode = mode;
          }
          const consumptionChanged = !previous || !same(previous.materialsUsedToday, next?.materialsUsedToday) ||
            previous.galponId !== next?.galponId || previous.sectorId !== next?.sectorId ||
            previous.isSecondarySharedCopy !== next?.isSecondarySharedCopy;
          for (const [advance, validate] of [[previous, false], [next, consumptionChanged]] as const) {
            if (!advance || advance.materialsUsedToday === undefined) continue;
            if (!Array.isArray(advance.materialsUsedToday)) {
              if (validate) bad();
              continue;
            }
            for (const usage of advance.materialsUsedToday) {
              if (!object(usage)) {
                if (validate) bad();
                continue;
              }
              const used = usage.materialId ? [materials.get(usage.materialId)].filter(Boolean) : [...materials.values()].filter(material =>
                typeof usage.code === 'string' && usage.code.trim().toUpperCase() === String(material.code ?? '').trim().toUpperCase() &&
                (!material.galponId || material.galponId === advance.galponId));
              if (validate && (!used.length || !Number.isFinite(Number(usage.qty)) || Number(usage.qty) < 0)) bad('Consumo de material inválido.');
              for (const material of used) {
                if (validate && material.galponId && material.galponId !== advance.galponId) forbidden();
                stockToUpdate.add(material.id);
              }
            }
          }
          if (next) advances.set(write.id, next);
          else advances.delete(write.id);
        } else if (collection === 'materials') {
          if (next) {
            materials.set(write.id, next);
            stockToUpdate.add(write.id);
            // Used quantity is derived from initial stock and confirmed advances.
            next.usedQty = previous?.usedQty ?? Number(next.initialUsedQty ?? 0);
          } else {
            const code = typeof previous?.code === 'string' ? previous.code.trim().toUpperCase() : '';
            if ([...advances.values()].some(log => Array.isArray(log.materialsUsedToday) && log.materialsUsedToday.some(usage =>
              object(usage) && (usage.materialId ? usage.materialId === write.id : code &&
                typeof usage.code === 'string' && usage.code.trim().toUpperCase() === code &&
                (!previous?.galponId || previous.galponId === log.galponId))))) {
              throw new AuthError(409, 'MATERIAL_DEPENDENCIES', 'El material tiene consumos registrados. Se conservó su historial.');
            }
            materials.delete(write.id);
          }
        }
        tx.create(receipts[index], { fingerprint, actorUid: identity.uid, collection, targetId: write.id, createdAt: new Date().toISOString() });
        if ((!previous && !next) || (previous && next && (collection === 'sectors'
          ? same(sectorContent(previous), sectorContent(next)) : same(clean(previous), clean(next))))) continue;
        const now = new Date();
        if (next) tx.set(docs[index], { ...next, _revision: revision + 1, syncState: 'synced', userId: previous?.userId ?? profile.uid,
          userDisplayName: previous?.userDisplayName ?? profile.displayName,
          createdAt: previous?.createdAt ?? (typeof next.createdAt === 'string' && Number.isFinite(Date.parse(next.createdAt))
            ? next.createdAt : now.toISOString()),
          updatedAt: now.toISOString(), updatedBy: profile.uid, syncedBy: profile.uid, syncedByDisplayName: profile.displayName });
        else {
          tx.delete(docs[index]);
          if (collection !== 'providers') tx.set(tombstones[index], { revision: revision + 1, deletedAt: now.toISOString(), actorUid: profile.uid });
        }
        const movementId = 'ops-' + receipts[index].id;
        const location = next ?? previous;
        const sector = collection === 'sectors' ? location as Sector | null
          : locationSectors.find(item => location?.sectorId ? item.id === location.sectorId
            : location?.galponId && barns(item).some(barn => barn.id === location.galponId));
        const barn = sector && barns(sector).find(item => item.id === location?.galponId);
        const projectCode = barn?.projectCode ?? sector?.projectName ?? sector?.code ?? sector?.name;
        const stockDelta = collection === 'materials' ? Number(next?.totalQty ?? 0) - Number(previous?.totalQty ?? 0) : 0;
        const consumption = collection === 'advances' && Array.isArray(next?.materialsUsedToday)
          ? next.materialsUsedToday.filter(object).filter(usage => Number.isFinite(Number(usage.qty))).map(({ materialId, code, qty }: Data) => ({
            materialId: typeof materialId === 'string' ? materialId : null, code: typeof code === 'string' ? code : null, qty: Number(qty)
          })) : [];
        if (collection === 'sectors' && previous && (!next || removedBarns.length)) {
          if (!next) tx.set(archiveLocation(db, 'sector', write.id), {
            sectorId: write.id, name: previous.name ?? write.id, projectCode: projectCode ?? null,
            sectorCode: previous.code ?? previous.name ?? null, deletedAt: now.toISOString(), actorUid: profile.uid
          });
          for (const removed of removedBarns) {
            const code = removed.projectCode ?? projectCode ?? null;
            tx.set(archiveLocation(db, 'galpon', removed.id), {
              sectorId: write.id, galponId: removed.id, name: removed.name ?? removed.code ?? removed.id,
              projectCode: code, sectorCode: previous.code ?? previous.name ?? null, deletedAt: now.toISOString(), actorUid: profile.uid
            });
            const id = movementId + '-' + hash(removed.id);
            tx.create(db.collection('movements').doc(id), {
              id, timestamp: now.toLocaleString('es-PE', { timeZone: 'America/Lima' }), createdAt: now.toISOString(),
              user: profile.displayName, userId: profile.uid, userRole: profile.role, module: MODULE_LABELS.proyectos,
              type: 'ELIMINACIÓN', detail: 'Baja de galpón · ' + (removed.code ?? removed.name ?? removed.id),
              targetId: removed.id, targetCollection: 'galpones', sectorId: write.id, galponId: removed.id,
              requestId: write.requestId, ...(code ? { projectCode: code } : {})
            });
          }
          if (next) continue;
        }
        if (collection === 'sectors' && next && sectorEvents.length) {
          for (const [ordinal, event] of sectorEvents.entries()) {
            const id = ordinal === 0 ? movementId : movementId + '-' + ordinal;
            const code = barns(next as Sector).find(item => item.id === event.galponId)?.projectCode ?? projectCode;
            tx.create(db.collection('movements').doc(id), {
              id, timestamp: now.toLocaleString('es-PE', { timeZone: 'America/Lima' }), createdAt: now.toISOString(),
              user: profile.displayName, userId: profile.uid, userRole: profile.role,
              module: MODULE_LABELS[event.module], type: event.type, detail: MODULE_LABELS[event.module] + ' · ' + event.label,
              targetId: event.targetId, targetCollection: event.targetCollection, sectorId: write.id, requestId: write.requestId,
              ...(event.galponId ? { galponId: event.galponId } : {}), ...(typeof code === 'string' ? { projectCode: code } : {})
            });
          }
          continue;
        }
        tx.create(db.collection('movements').doc(movementId), {
          id: movementId, timestamp: now.toLocaleString('es-PE', { timeZone: 'America/Lima' }), createdAt: now.toISOString(),
          user: profile.displayName, userId: profile.uid, userRole: profile.role, module: MODULE_LABELS[module],
          type: action === 'create' ? 'REGISTRO' : action === 'edit' ? 'MODIFICACIÓN' : 'ELIMINACIÓN',
          detail: MODULE_LABELS[module] + ' · ' + write.id,
          targetId: write.id, targetCollection: collection,
          requestId: write.requestId,
          ...(workerImportId ? { importOperationId: workerImportId } : {}),
          ...(typeof projectCode === 'string' ? { projectCode } : {}),
          ...(stockDelta ? { stockDelta, stockDirection: stockDelta > 0 ? 'ENTRADA' : 'SALIDA' } : {}),
          ...(consumption.length ? { consumption } : {}),
          ...(collection === 'sectors' ? { sectorId: write.id } : {}),
          ...(typeof location?.sectorId === 'string' ? { sectorId: location.sectorId } : {}),
          ...(typeof location?.galponId === 'string' ? { galponId: location.galponId } : {})
        });
      }
      const usedQuantity = indexMaterialConsumption([...advances.values()]);
      for (const id of stockToUpdate) {
        const material = materials.get(id);
        if (material) {
          const usedQty = usedQuantity(material);
          const before = originalStock.get(id);
          if (usedQty > Number(material.totalQty) &&
              (usedQty > Number(before?.usedQty ?? 0) || Number(material.totalQty) < Number(before?.totalQty ?? 0))) {
            throw new AuthError(409, 'STOCK_INSUFFICIENT', 'El material no tiene stock suficiente para confirmar el cambio.');
          }
          if (Number.isFinite(usedQty) && material.usedQty !== usedQty) tx.set(materialCollection.doc(id), { usedQty }, { merge: true });
        }
      }
      if (importReceipt) {
        tx.create(importReceipt.ref, {
          fingerprint: importReceipt.fingerprint, actorUid: identity.uid,
          collection: 'workers', targetId: workerImportId, createdAt: new Date().toISOString()
        });
      }
      reserveWorkerCodes();
    });
    return { committed: true };
  }

  app.post('/api/data/write', route((req, identity) => commitWrites(readWrites(req.body?.writes), identity)));

  app.post('/api/data/workers/import', route((req, identity) => {
    const operationId = req.body?.operationId;
    if (!docId(operationId)) bad('El identificador del lote de Personal es obligatorio.');
    const writes = readWrites(req.body?.writes, 1000, true);
    if (writes.some(write => write.collection !== 'workers' || write.mode !== 'set' || write.requestId === operationId ||
      (write.expectedRevision !== undefined && write.expectedRevision !== 0))) {
      bad('La importación de Personal solo permite altas con identificadores distintos.');
    }
    return commitWrites(writes, identity, operationId);
  }));

  app.post('/api/data/catalog/templates/duplicate', route(async (req, identity) => {
    const { source, name, requestId } = req.body ?? {};
    if (typeof source !== 'string' || typeof name !== 'string' || !source.trim() || !name.trim() ||
        source.trim().length > 150 || name.trim().length > 150 || !docId(requestId)) bad('Revise el nombre de la plantilla.');
    const original = source.trim(), destination = name.trim();
    const key = providerIdFromName(destination);
    if (key === providerIdFromName(original)) bad('Use un nombre distinto para la copia.');
    const receipt = db.collection('_operationalReceipts').doc(hash(identity.uid + ':' + requestId));
    const fingerprint = hash(canonical(['catalog.template.duplicate', original, destination]));
    return db.runTransaction(async tx => {
      const profile = await readProfile(tx, db, identity);
      requirePermission(profile, 'catalogo', 'view');
      requirePermission(profile, 'catalogo', 'create');
      const previous = await tx.get(receipt);
      if (previous.exists) {
        if (previous.get('fingerprint') !== fingerprint) throw new AuthError(409, 'OPERATION_ID_CONFLICT', 'El UUID pertenece a otra operación.');
        return { committed: true };
      }
      const [providers, catalog] = await Promise.all([tx.get(db.collection('providers')), tx.get(db.collection('masterCatalog'))]);
      const items = getActiveMasterCatalog(catalog.docs.map(doc => record(doc)));
      if (providers.docs.some(doc => doc.id === key || providerIdFromName(String(doc.get('name') ?? '')) === key) ||
          items.some(item => typeof item.technology === 'string' && providerIdFromName(item.technology) === key)) {
        throw new AuthError(409, 'TEMPLATE_EXISTS', 'El nombre de la copia ya existe.');
      }
      const rows = items.filter(item => typeof item.technology === 'string' && item.technology.trim() === original);
      if (!rows.length && !providers.docs.some(doc => doc.get('name') === original)) bad('La plantilla de origen ya no existe.');
      const now = new Date();
      const stamp = { createdAt: now.toISOString(), updatedAt: now.toISOString(), userId: profile.uid, userDisplayName: profile.displayName,
        updatedBy: profile.uid, syncedBy: profile.uid, syncedByDisplayName: profile.displayName, syncState: 'synced', _revision: 1 };
      tx.create(db.collection('providers').doc(key), { ...stamp, id: key, name: destination });
      const audit = (id: string, collection: string, targetId: string, detail: string) => tx.create(db.collection('movements').doc(id), {
        id, timestamp: now.toLocaleString('es-PE', { timeZone: 'America/Lima' }), createdAt: stamp.createdAt,
        user: profile.displayName, userId: profile.uid, userRole: profile.role, module: MODULE_LABELS.catalogo,
        type: 'REGISTRO', requestId, targetCollection: collection, targetId, detail
      });
      const movementId = 'ops-' + receipt.id;
      audit(movementId, 'providers', key, `Copia de plantilla ${original} → ${destination}`);
      for (const row of rows) {
        const id = 'copy-' + hash(canonical([key, row.id]));
        tx.create(db.collection('masterCatalog').doc(id), { ...clean(row), ...stamp, id, technology: destination });
        audit(movementId + '-' + id, 'masterCatalog', id, `Actividad copiada a ${destination} · ${row.code}`);
      }
      tx.create(receipt, { fingerprint, actorUid: profile.uid, collection: 'providers', targetId: key, createdAt: stamp.createdAt });
      return { committed: true };
    });
  }));

  app.post('/api/data/movements/import', route(async (req, identity) => {
    const entries = req.body?.entries;
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) bad('Envíe entre 1 y 100 movimientos históricos.');
    const prepared = entries.map(entry => {
      if (!object(entry) || !docId(entry.sourceId) || typeof entry.detail !== 'string' || !entry.detail.trim() || entry.detail.length > 5000 ||
          (entry.originalActor !== undefined && (typeof entry.originalActor !== 'string' || entry.originalActor.length > 160)) ||
          typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp)) ||
          !Object.values(MODULE_LABELS).includes(entry.module) || entry.module === MODULE_LABELS.movimientos ||
          !['REGISTRO', 'MODIFICACIÓN', 'ELIMINACIÓN'].includes(entry.type)) bad('Movimiento histórico inválido.');
      const { sourceId, timestamp, module, type, detail, originalActor } = entry;
      return { sourceId, timestamp, module, type, detail, ...(originalActor ? { originalActor } : {}) };
    });
    const refs = prepared.map(entry => db.collection('movements').doc('import-' + hash(entry.sourceId)));
    if (new Set(refs.map(ref => ref.id)).size !== refs.length) bad('Identificador de origen duplicado.');
    await db.runTransaction(async tx => {
      const profile = await readProfile(tx, db, identity);
      requirePermission(profile, 'movimientos', 'import');
      const sourceRefs = prepared.map(entry => db.collection('movements').doc(entry.sourceId));
      const [previous, source] = await Promise.all([tx.getAll(...refs), tx.getAll(...sourceRefs)]);
      for (const [index, entry] of prepared.entries()) {
        const fingerprint = hash(canonical(entry));
        if (previous[index].exists) {
          if (previous[index].get('importFingerprint') !== fingerprint) {
            throw new AuthError(409, 'OPERATION_ID_CONFLICT', 'El movimiento histórico ya existe con otro contenido.');
          }
          continue;
        }
        if (source[index].exists) {
          throw new AuthError(409, 'OPERATION_ID_CONFLICT', 'El identificador de origen ya pertenece a un movimiento existente.');
        }
        tx.create(refs[index], { ...entry, id: refs[index].id, user: profile.displayName, userId: profile.uid,
          userRole: profile.role, historicalImport: true, importFingerprint: fingerprint, createdAt: new Date().toISOString() });
      }
    });
    return { committed: true };
  }));
}
