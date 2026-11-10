import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import { CREDENTIAL_OPERATION_CLAIM, createAuthService, MutationRejected, MutationUncertain, PRIMARY_ADMIN_UID } from './auth.ts';
import type { IdentityProvider, Profile } from './auth.ts';
import { createFirebaseIdentityProvider, createFirestoreProfileStore, createNamedFirestore, registerAuthRoutes } from './firebaseAdmin.ts';
import { describeEmergencyStatus } from '../src/firebase/emergencyStatus.ts';
import type { Firestore } from '@google-cloud/firestore';
import { registerOperationalRoutes } from './operations.ts';
import { evaluateActivityProgress, mergeSectorDeepWithConflicts } from '../src/firebase/offlineSyncEngine.ts';
import { barnActivities, ganttPlannedActivities } from '../src/firebase/advanceActivity.ts';
import { indexActivityAdvances } from '../src/dashboard/advanceIndex.ts';
import { fieldReport } from '../src/dashboard/fieldReport.ts';

const project = 'demo-calera-phase11';
const database = 'calera-audit';
const firestoreHost = local(process.env.FIRESTORE_EMULATOR_HOST);
const authHost = local(process.env.FIREBASE_AUTH_EMULATOR_HOST);
const realAuth = authHost ? createFirebaseIdentityProvider(project) : undefined;

function local(value: string | undefined) {
  if (value && !/^127\.0\.0\.1:\d+$/.test(value)) throw new Error('Las pruebas solo permiten loopback.');
  return value;
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

function profile(uid: string, role: Profile['role'] = 'Administrador'): Profile {
  const now = new Date().toISOString();
  return {
    uid, email: uid + '@example.test', displayName: 'Perfil sintético', authMethod: 'password', role, active: true,
    createdAt: now, updatedAt: now, createdBy: uid, updatedBy: uid
  };
}

function mockToken(uid: string, authTime: number, provider = 'password') {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return encode({ alg: 'none', typ: 'JWT' }) + '.' + encode({
    sub: uid, user_id: uid, aud: project, iss: 'https://securetoken.google.com/' + project,
    auth_time: authTime, iat: now, exp: now + 600, firebase: { sign_in_provider: provider }
  }) + '.';
}

async function signInWithPassword(email: string, password: string) {
  const login = await fetch('http://' + authHost + '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const response = await login.json();
  assert.equal(login.status, 200, response.error?.message);
  return response.idToken as string;
}

async function startAdminApi(t: TestContext, service: ReturnType<typeof createAuthService>, db?: Firestore) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  registerAuthRoutes(app, service);
  if (db) registerOperationalRoutes(app, db, service);
  const listener = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())));
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  return async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, token: string, body?: object) => {
    const endpoint = path.startsWith('/api/') ? path : '/api/admin/' + path;
    const response = await fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  };
}

async function loadRules() {
  const root = 'http://' + firestoreHost;
  const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
  const loaded = await fetch(root + '/emulator/v1/projects/' + project + ':securityRules', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      database: `projects/${project}/databases/${database}`,
      rules: { files: [{ name: 'firestore.rules', content: rules }] }
    })
  });
  const report = await loaded.text();
  assert.equal(loaded.status, 200, report);
  assert.doesNotMatch(report, /"severity"\s*:\s*"ERROR"/);
}

test('Base nombrada: el corte y proveedor se comprueban en la API y las reglas deniegan acceso directo', {
  skip: !firestoreHost, timeout: 30_000
}, async t => {
  await loadRules();
  const root = 'http://' + firestoreHost;
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  assert.equal(db.databaseId, database);
  const uid = 'rules-' + randomUUID();
  const resource = 'providers/' + uid;
  const url = root + '/v1/projects/' + project + '/databases/' + database + '/documents/';
  const before = Math.floor(Date.now() / 1000) - 60;
  await db.doc('users/' + uid).set(profile(uid));
  await db.doc(resource).set({ id: uid, name: 'Proveedor sintético' });
  const call = await startAdminApi(t, createAuthService({
    ...realAuth,
    async verifyIdToken(token) {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      return { ...claims, uid: claims.sub };
    }
  }, createFirestoreProfileStore(db)), db);
  const request = (path: string, authTime: number, provider = 'password', method = 'GET') => fetch(url + path, {
    method,
    headers: { Authorization: 'Bearer ' + mockToken(uid, authTime, provider), 'Content-Type': 'application/json' },
    ...(method === 'PATCH' ? {
      body: JSON.stringify({ fields: { id: { stringValue: uid }, name: { stringValue: 'Actualizado' } } })
    } : {})
  });
  const read = (time: number, provider = 'password') => call('GET', '/api/data/' + resource, mockToken(uid, time, provider));
  const write = (time: number, expectedRevision = 0) => call('POST', '/api/data/write', mockToken(uid, time), { writes: [
    { collection: 'providers', id: uid, mode: 'set', requestId: randomUUID(), expectedRevision, data: { name: 'Actualizado' } }
  ] });
  assert.equal((await read(before)).status, 200);
  assert.equal((await read(before, 'google.com')).status, 403);
  assert.equal((await write(before)).status, 200);
  await db.doc('users/' + uid).update({ sessionValidAfter: before });
  assert.equal((await db.doc('users/' + uid).get()).get('active'), true);
  for (const authTime of [before - 1, before]) {
    assert.equal((await read(authTime)).status, 401);
    assert.equal((await write(authTime)).status, 401);
    assert.equal((await request(resource, authTime)).status, 403);
    assert.equal((await request(resource, authTime, 'password', 'PATCH')).status, 403);
    assert.equal((await request('users/' + uid, authTime)).status, 403);
  }
  assert.equal((await read(before + 1)).status, 200);
  assert.equal((await write(before + 1, 1)).status, 200);
  assert.equal((await request(resource, before + 1)).status, 403);
  assert.equal((await request(resource, before + 1, 'password', 'PATCH')).status, 403);
  assert.equal((await request('users/' + uid, before + 1, 'password', 'PATCH')).status, 403);
});

test('dos clientes Firestore reales serializan beta/gamma y la reserva de un mismo correo', {
  skip: !firestoreHost, timeout: 90_000
}, async t => {
  const db1 = createNamedFirestore(project, database);
  const db2 = createNamedFirestore(project, database);
  t.after(async () => { await Promise.all([db1.terminate(), db2.terminate()]); });
  const admin = profile('admin-' + randomUUID());
  const admin2 = profile('admin-' + randomUUID());
  const worker = profile('worker-' + randomUUID(), 'Supervisor');
  await Promise.all([admin, admin2, worker].map(value => db1.doc('users/' + value.uid).set(value)));

  const entered = barrier(), applyBeta = barrier(), applied = barrier(), reply = barrier();
  const beta = { email: randomUUID() + '@example.test', operationId: randomUUID(), expectedProfileVersion: 0 };
  const gamma = { email: randomUUID() + '@example.test', operationId: randomUUID() };
  let account: Awaited<ReturnType<IdentityProvider['getUser']>> = {
    uid: worker.uid, email: worker.email, disabled: false, emailVerified: true
  };
  const password = 'emulator-race-fixture';
  if (realAuth) {
    for (const user of [admin, admin2, worker]) {
      await realAuth.createUser({ uid: user.uid, email: user.email, password });
    }
  }
  const token = realAuth ? await signInWithPassword(admin.email, password) : admin.uid;
  const token2 = realAuth ? await signInWithPassword(admin2.email, password) : admin2.uid;
  const mutations: string[] = [];
  const simulated: IdentityProvider = {
    async verifyIdToken(token) {
      assert.ok(token === admin.uid || token === admin2.uid);
      return { uid: token, auth_time: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: 'password' } };
    },
    async getUser(uid) { assert.equal(uid, worker.uid); return structuredClone(account); },
    async getUserByEmail() { throw Object.assign(new Error('Cuenta inexistente'), { code: 'auth/user-not-found' }); },
    async createUser() { throw new Error('El alta Google no crea una cuenta en Auth'); },
    async updateCredential(_current, changes, id) {
      account = { ...account, ...changes, customClaims: { [CREDENTIAL_OPERATION_CLAIM]: id } };
    },
    async containAccount() { throw new Error('Esta prueba no utiliza desactivación'); }
  };
  const transport = realAuth || simulated;
  const identity: IdentityProvider = {
    ...transport,
    async updateCredential(current, changes, id) {
      if (id === beta.operationId) {
        entered.resolve();
        await applyBeta.promise;
      }
      mutations.push(id);
      await transport.updateCredential(current, changes, id);
      if (id === beta.operationId) {
        applied.resolve();
        await reply.promise;
      }
    }
  };
  const one = createAuthService(identity, createFirestoreProfileStore(db1));
  const two = createAuthService(identity, createFirestoreProfileStore(db2));
  const bearer = 'Bearer ' + token;
  const late = one.updateUser(bearer, worker.uid, beta);
  try {
    await Promise.race([entered.promise, late.then(() => { throw new Error('La operación no se suspendió.'); })]);
    assert.deepEqual((await two.listCredentialOperations(bearer, worker.uid)).map(item => item.id), [beta.operationId]);
    await assert.rejects(two.updateUser(bearer, worker.uid, { ...gamma, expectedProfileVersion: 0 }),
      { code: 'CREDENTIAL_OPERATION_PENDING' });
    applyBeta.resolve();
    await applied.promise;
    assert.equal((await two.reconcileOperation(bearer, beta.operationId)).operation.state, 'completed');
    const latest = await two.updateUser(bearer, worker.uid, { ...gamma, expectedProfileVersion: 1 });
    assert.equal(latest.operation?.version, 2);
    assert.equal(latest.user.profileVersion, 2);
    reply.resolve();
    const lateBeta = await late;
    assert.equal(lateBeta.operation?.version, 1);
    assert.equal(lateBeta.user.profileVersion, 2);
    assert.equal(lateBeta.user.email, gamma.email);
    assert.equal((await two.updateUser(bearer, worker.uid, beta)).operation?.version, 1);
    assert.deepEqual(mutations, [beta.operationId, gamma.operationId]);
    assert.equal((await db2.doc('users/' + worker.uid).get()).get('email'), gamma.email);
    assert.equal((await transport.getUser(worker.uid)).email, gamma.email);
  } finally {
    applyBeta.resolve();
    reply.resolve();
    await late.catch(() => {});
  }

  const input = { email: randomUUID() + '@example.test', displayName: 'Invitada', role: 'Supervisor', authMethod: 'google' };
  const results = await Promise.allSettled([
    one.createUser(bearer, input), two.createUser('Bearer ' + token2, input)
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((results.find(x => x.status === 'rejected') as PromiseRejectedResult).reason.code, 'DUPLICATE_EMAIL');
  assert.equal((await db1.collection('users').where('email', '==', input.email).get()).size, 1);

  if (realAuth) {
    const passwordResets = async () => {
      const response = await fetch('http://' + authHost + '/emulator/v1/projects/' + project + '/oobCodes');
      assert.equal(response.status, 200);
      const codes = (await response.json()).oobCodes ?? [];
      return codes.filter((entry: { email: string; requestType: string }) =>
        entry.requestType === 'PASSWORD_RESET' && [worker.email, gamma.email].includes(entry.email)).length;
    };
    const before = await passwordResets();
    await assert.rejects(one.resetPassword(bearer, worker.uid), { status: 410 });
    const reassigned = await realAuth.createUser({ uid: 'reassigned-' + randomUUID(), email: worker.email, password });
    assert.notEqual(reassigned.uid, worker.uid);
    await assert.rejects(two.resetPassword(bearer, worker.uid), { status: 410 });
    assert.equal(await passwordResets(), before);
    const autonomous = await fetch('http://' + authHost + '/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=demo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: gamma.email })
    });
    assert.equal(autonomous.status, 200);
    assert.equal(await passwordResets(), before + 1);
  }
});

test('un formulario abierto antes del cambio no restaura el correo original con un UUID nuevo', {
  skip: !firestoreHost || !authHost, timeout: 30_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const identity = realAuth!;
  const store = createFirestoreProfileStore(db);
  const service = createAuthService(identity, store);
  const firstAdmin = profile('stale-admin-' + randomUUID());
  const secondAdmin = profile('fresh-admin-' + randomUUID());
  const worker = profile('stale-target-' + randomUUID(), 'Supervisor');
  const password = 'emulator-stale-form-fixture';
  for (const user of [firstAdmin, secondAdmin, worker]) {
    await identity.createUser({ uid: user.uid, email: user.email, password });
    await db.doc('users/' + user.uid).set(user);
  }
  const firstToken = 'Bearer ' + await signInWithPassword(firstAdmin.email, password);
  const secondToken = 'Bearer ' + await signInWithPassword(secondAdmin.email, password);
  const opened = (await service.listUsers(firstToken)).find(user => user.uid === worker.uid)!;
  assert.equal(opened.profileVersion, 0);
  const confirmedEmail = randomUUID() + '@example.test';
  const confirmedId = randomUUID();
  const completed = await service.updateUser(secondToken, worker.uid, {
    email: confirmedEmail, expectedProfileVersion: 0, operationId: confirmedId
  });
  assert.equal(completed.operation?.state, 'completed');
  assert.equal(completed.user.profileVersion, 1);

  const staleId = randomUUID();
  await assert.rejects(service.updateUser(firstToken, worker.uid, {
    email: opened.email, displayName: opened.displayName, role: opened.role,
    expectedProfileVersion: opened.profileVersion, operationId: staleId
  }), { status: 409, code: 'STALE_PROFILE_VERSION' });
  assert.equal(await store.operation(staleId), null);
  assert.equal(await store.emailOwner(opened.email), null);
  const saved = await store.get(worker.uid);
  assert.equal(saved?.email, confirmedEmail);
  assert.equal(saved?.profileVersion, 1);
  assert.equal(saved?.credentialVersion, 1);
  const account = await identity.getUser(worker.uid);
  assert.equal(account.email, confirmedEmail);
  assert.equal(account.customClaims?.[CREDENTIAL_OPERATION_CLAIM], confirmedId);
  const original = { email: confirmedEmail, expectedProfileVersion: 0, operationId: confirmedId };
  for (const changes of [
    { email: opened.email }, { displayName: 'Otro nombre' }, { role: 'Solo lectura' }, { expectedProfileVersion: 1 }
  ]) {
    await assert.rejects(service.updateUser(secondToken, worker.uid, { ...original, ...changes }),
      { status: 409, code: 'OPERATION_ID_CONFLICT' });
  }
  assert.equal((await service.updateUser(secondToken, worker.uid, original)).operation?.state, 'completed');
  assert.equal((await identity.getUser(worker.uid)).customClaims?.[CREDENTIAL_OPERATION_CLAIM], confirmedId);
  assert.equal((await db.collection('movements').where('targetId', '==', worker.uid).get()).size, 1);
});

test('H3 desactivar y reactivar revoca sesiones anteriores, incluso las iniciadas mientras estaba inactivo', {
  skip: !firestoreHost || !authHost, timeout: 60_000
}, async t => {
  await loadRules();
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const identity = realAuth!;
  const store = createFirestoreProfileStore(db);
  const service = createAuthService(identity, store);
  const administrator = profile('state-admin-' + randomUUID());
  const target = profile('state-target-' + randomUUID());
  const primary = profile(PRIMARY_ADMIN_UID);
  const password = 'emulator-state-fixture';
  for (const user of [administrator, target]) await identity.createUser({ uid: user.uid, email: user.email, password });
  for (const user of [administrator, target, primary]) await db.doc('users/' + user.uid).set(user);
  const authorization = 'Bearer ' + await signInWithPassword(administrator.email, password);
  const oldToken = await signInWithPassword(target.email, password);
  const resource = 'providers/' + target.uid;
  await db.doc(resource).set({ id: target.uid, name: 'Proveedor de prueba' });
  const url = 'http://' + firestoreHost + '/v1/projects/' + project + '/databases/' + database + '/documents/' + resource;
  async function access(token: string) {
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const read = await fetch(url, { headers });
    const write = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({
      fields: { id: { stringValue: target.uid }, name: { stringValue: 'Actualizado' } }
    }) });
    return [read.status, write.status];
  }
  const authTime = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).auth_time as number;
  async function after(cutoff: number) {
    while (Math.floor(Date.now() / 1000) <= cutoff) await sleep(100);
  }
  assert.deepEqual(await access(oldToken), [403, 403]);
  await after(authTime(oldToken));
  const disable = { active: false, expectedProfileVersion: 0, operationId: randomUUID() };
  await assert.rejects(service.updateUser(authorization, primary.uid, disable), { status: 403, code: 'PROTECTED_ADMIN' });
  const entered = barrier(), proceed = barrier();
  const delayed = createAuthService({ ...identity, async containAccount(...args) {
    entered.resolve();
    await proceed.promise;
    return identity.containAccount(...args);
  } }, store);
  const transition = delayed.updateUser(authorization, target.uid, disable);
  let duringInactive: string;
  try {
    await Promise.race([entered.promise, transition.then(() => { throw Error('No se alcanzó el bloqueo local'); })]);
    assert.deepEqual(await access(oldToken), [403, 403]);
    await after((await store.get(target.uid))!.sessionValidAfter!);
    duringInactive = await signInWithPassword(target.email, password);
    assert.deepEqual(await access(duringInactive), [403, 403]);
  } finally { proceed.resolve(); }
  const down = await transition;
  assert.equal(down.operation?.authentication, 'applied');
  assert.equal(down.operation?.profileApplied, true);
  assert.equal(down.user?.active, false);
  const downCutoff = (await store.get(target.uid))!.sessionValidAfter!;
  assert.ok(Date.parse((await identity.getUser(target.uid)).tokensValidAfterTime!) / 1000 >= downCutoff);
  assert.deepEqual(await access(oldToken), [403, 403]);
  assert.equal((await identity.getUser(target.uid)).disabled, true);
  await assert.rejects(identity.verifyIdToken(oldToken, true), { code: 'auth/user-disabled' });
  assert.equal((await service.updateUser(authorization, target.uid, disable)).user?.profileVersion, 1);

  const enable = { active: true, expectedProfileVersion: 1, operationId: randomUUID() };
  await after(authTime(duringInactive));
  const up = await service.updateUser(authorization, target.uid, enable);
  assert.equal(up.operation?.authentication, 'applied');
  assert.equal(up.user?.active, true);
  assert.equal((await identity.getUser(target.uid)).disabled, false);
  assert.equal(up.user?.profileVersion, 2);
  const upCutoff = (await store.get(target.uid))!.sessionValidAfter!;
  assert.ok(upCutoff > downCutoff);
  assert.ok(Date.parse((await identity.getUser(target.uid)).tokensValidAfterTime!) / 1000 >= up.operation!.sessionCutoff!);
  for (const token of [oldToken, duringInactive, mockToken(target.uid, upCutoff)]) {
    assert.deepEqual(await access(token), [403, 403]);
  }
  await assert.rejects(identity.verifyIdToken(duringInactive, true), { code: 'auth/id-token-revoked' });
  await after(upCutoff);
  const fresh = await signInWithPassword(target.email, password);
  assert.deepEqual(await access(fresh), [403, 403]);
  assert.equal((await service.verifySession('Bearer ' + fresh)).uid, target.uid);
  assert.equal((await service.updateUser(authorization, target.uid, enable)).user?.profileVersion, 2);
  assert.equal((await service.updateUser(authorization, target.uid, disable)).user?.active, true);
  assert.equal((await db.collection('movements').where('targetId', '==', target.uid).get()).size, 2);
});

test('H3 reconcilia un fallo de Auth en desactivación y un fallo de Firestore después de revocar para reactivar', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const identity = realAuth!;
  const store = createFirestoreProfileStore(db);
  const service = createAuthService(identity, store);
  const admin = profile('partial-admin-' + randomUUID());
  const target = profile('partial-target-' + randomUUID(), 'Supervisor');
  const password = 'emulator-partial-state-fixture';
  for (const user of [admin, target]) {
    await identity.createUser({ uid: user.uid, email: user.email, password });
    await db.doc('users/' + user.uid).create(user);
  }
  const authorization = 'Bearer ' + await signInWithPassword(admin.email, password);
  const disable = { active: false, expectedProfileVersion: 0, operationId: randomUUID() };
  const unavailable = createAuthService({ ...identity, async containAccount() {
    throw new MutationRejected('AUTH_CREDENTIAL_UNAVAILABLE');
  } }, store);
  const pending = await unavailable.updateUser(authorization, target.uid, disable);
  assert.equal(pending.operation?.authentication, 'ready');
  assert.equal(pending.operation?.profileApplied, true);
  assert.equal((await store.get(target.uid))?.active, false);
  assert.equal((await identity.getUser(target.uid)).customClaims?.[CREDENTIAL_OPERATION_CLAIM], undefined);
  assert.equal((await service.reconcileOperation(authorization, disable.operationId)).operation.authentication, 'applied');
  const enable = { active: true, expectedProfileVersion: 1, operationId: randomUUID() };
  const interrupted = createAuthService(identity, {
    ...store, transaction: work => store.transaction(tx => work({
      ...tx, updateOperation(id, changes) {
        if (id === enable.operationId && changes.state === 'completed') throw Error('Confirmación interrumpida');
        tx.updateOperation(id, changes);
      }
    }))
  });
  const incomplete = await interrupted.updateUser(authorization, target.uid, enable);
  assert.equal(incomplete.operation?.authentication, 'uncertain');
  assert.equal(incomplete.operation?.profileApplied, false);
  assert.equal((await store.get(target.uid))?.active, false);
  assert.equal((await identity.getUser(target.uid)).customClaims?.[CREDENTIAL_OPERATION_CLAIM], enable.operationId);
  const completed = await service.reconcileOperation(authorization, enable.operationId);
  assert.equal(completed.operation.state, 'completed');
  assert.equal(completed.user?.active, true);
  assert.equal(completed.user?.profileVersion, 2);
  await service.reconcileOperation(authorization, enable.operationId);
  assert.equal((await db.collection('movements').where('targetId', '==', target.uid).get()).size, 2);
});

test('Fase 1.3 el bloqueo inmediato sobrevive una reserva incierta y la recuperación de Auth', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  await loadRules();
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const identity = realAuth!;
  const store = createFirestoreProfileStore(db);
  const admin = profile('contain-admin-' + randomUUID());
  const target = profile('contain-target-' + randomUUID());
  const password = 'Fixture#9-emergency-emulator';
  for (const user of [admin, target]) {
    await identity.createUser({ uid: user.uid, email: user.email, password });
    await db.doc('users/' + user.uid).create(user);
  }
  const authorization = 'Bearer ' + await signInWithPassword(admin.email, password);
  const targetToken = await signInWithPassword(target.email, password);
  const resource = 'providers/' + target.uid;
  await db.doc(resource).set({ id: target.uid, name: 'Proveedor de prueba' });
  const url = 'http://' + firestoreHost + '/v1/projects/' + project + '/databases/' + database + '/documents/' + resource;
  const headers = { Authorization: 'Bearer ' + targetToken, 'Content-Type': 'application/json' };
  async function access() {
    const read = await fetch(url, { headers });
    const write = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({
      fields: { id: { stringValue: target.uid }, name: { stringValue: 'Actualizado' } }
    }) });
    return [read.status, write.status];
  }
  assert.deepEqual(await access(), [403, 403]);
  // Shape of the Phase 1.2 combined edit that was left unresolved after dispatch.
  const legacy = randomUUID(), newEmail = randomUUID() + '@example.test';
  const legacyCutoff = Math.floor(Date.now() / 1000);
  await store.transaction(async tx => {
    tx.createOperation({
      id: legacy, uid: target.uid, actor: admin, version: 1, kind: 'active', state: 'pending',
      authentication: 'uncertain', audit: 'pending', oldEmail: target.email, newEmail,
      sessionCutoff: legacyCutoff, profileApplied: false, baseProfileVersion: 0, createdAt: new Date().toISOString()
    });
    tx.setEmailOwner(newEmail, target.uid);
    tx.update(target.uid, { sessionOperationId: legacy, pendingEmail: newEmail });
  });
  let sends = 0, credentialSends = 0;
  const unavailable = createAuthService({
    ...identity,
    async containAccount() { sends++; throw new MutationRejected('PERMISSION_DENIED'); },
    async updateCredential(...args) { credentialSends++; return identity.updateCredential(...args); }
  }, store);
  const request = { operationId: randomUUID() };
  const blocked = await unavailable.emergencyDisable(authorization, target.uid, request);
  assert.equal(blocked.operation.profileApplied, true);
  assert.equal(blocked.operation.authDisabled, false);
  assert.equal(blocked.operation.refreshRevoked, false);
  assert.equal(blocked.operation.failure, 'PERMISSION_DENIED');
  assert.equal((await identity.getUser(target.uid)).disabled, false);
  assert.equal(blocked.user?.active, false);
  assert.equal((await store.get(target.uid))?.securityVersion, 1);
  assert.deepEqual(await access(), [403, 403]);
  await assert.rejects(unavailable.verifySession('Bearer ' + targetToken), { status: 403, code: 'USER_INACTIVE' });
  assert.equal(await store.emailOwner(newEmail), target.uid);
  assert.equal((await store.operation(legacy))?.authentication, 'uncertain');
  assert.equal(sends, 1);
  assert.equal(credentialSends, 0);
  // The provider makes the earlier in-flight mutation observable without another service dispatch.
  await identity.updateCredential(await identity.getUser(target.uid),
    { email: newEmail, emailVerified: false, validSince: String(legacyCutoff) }, legacy);

  const restarted = createAuthService({
    ...identity,
    async containAccount(...args) { sends++; return identity.containAccount(...args); },
    async updateCredential(...args) { credentialSends++; return identity.updateCredential(...args); }
  }, createFirestoreProfileStore(db));
  const found = await restarted.listCredentialOperations(authorization, target.uid);
  assert.ok(found.some(operation => operation.id === request.operationId));
  assert.ok(found.some(operation => operation.id === legacy));
  const direct = createAuthService(identity, { ...store, outstandingOperations: async () => [] });
  assert.deepEqual(new Set((await direct.listCredentialOperations(authorization, target.uid)).map(item => item.id)),
    new Set([request.operationId, legacy]));
  const contained = await restarted.reconcileOperation(authorization, request.operationId);
  assert.equal(contained.operation.authDisabled, true);
  assert.equal(contained.operation.refreshRevoked, true);
  const cut = (await store.get(target.uid))!.sessionValidAfter!;
  const authAccount = await identity.getUser(target.uid);
  assert.equal(authAccount.disabled, true);
  assert.equal(authAccount.customClaims?.[CREDENTIAL_OPERATION_CLAIM], legacy);
  assert.ok(Date.parse(authAccount.tokensValidAfterTime!) / 1000 >= cut);
  assert.equal((await restarted.emergencyDisable(authorization, target.uid, request)).operation.state, 'completed');
  assert.equal(sends, 2);
  assert.equal(credentialSends, 0);
  const recovered = await restarted.reconcileOperation(authorization, legacy);
  assert.equal(recovered.operation.state, 'completed');
  assert.equal(recovered.user?.email, newEmail);
  assert.equal(recovered.user?.active, false);
  assert.ok((await store.get(target.uid))!.sessionValidAfter! >= cut);
  assert.equal((await identity.getUser(target.uid)).disabled, true);
  assert.equal(credentialSends, 0);
  assert.deepEqual(await access(), [403, 403]);
  assert.equal((await db.collection('movements').where('targetId', '==', target.uid).get()).size, 2);
});

test('Fase 1.3 separa la desactivación de un cambio simultáneo de correo con respuesta perdida', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const identity = realAuth!;
  const store = createFirestoreProfileStore(db);
  const admin = profile('combine-admin-' + randomUUID());
  const target = profile('combine-target-' + randomUUID(), 'Supervisor');
  const password = 'Fixture#9-combined-emulator';
  for (const user of [admin, target]) {
    await identity.createUser({ uid: user.uid, email: user.email, password });
    await db.doc('users/' + user.uid).create(user);
  }
  const authorization = 'Bearer ' + await signInWithPassword(admin.email, password);
  let emailSends = 0, hideProof = false;
  const lost = createAuthService({
    ...identity,
    async getUser(uid) {
      if (uid === target.uid && hideProof) throw Error('No se pudo leer Auth tras la mutación');
      return identity.getUser(uid);
    },
    async updateCredential(...args) {
      emailSends++;
      await identity.updateCredential(...args);
      hideProof = true;
      throw new MutationUncertain('AUTH_CONNECTION_INTERRUPTED');
    }
  }, store);
  const separatePassword = 'Fixture#9-password-separate';
  const body = {
    operationId: randomUUID(), expectedProfileVersion: 0, active: false,
    email: randomUUID() + '@example.test', tempPassword: separatePassword
  };
  const combined = await lost.updateUser(authorization, target.uid, body);
  assert.equal(combined.operation.kind, 'emergency');
  assert.equal(combined.operation.state, 'completed');
  assert.equal(combined.passwordRequiresSeparateRequest, true);
  assert.ok(!JSON.stringify(await store.operation(body.operationId)).includes(separatePassword));
  assert.equal(combined.profileEdit.state, 'pending');
  const emailOperation = combined.profileEdit.id;
  assert.equal((await store.operation(emailOperation))?.authentication, 'uncertain');
  assert.equal(await store.emailOwner(body.email), target.uid);
  assert.equal((await store.get(target.uid))?.active, false);
  assert.equal((await identity.getUser(target.uid)).disabled, true);
  const restarted = createAuthService(identity, store);
  const replay = await lost.updateUser(authorization, target.uid, body);
  assert.equal(replay.profileEdit.id, emailOperation);
  assert.equal(emailSends, 1);
  const confirmed = await restarted.reconcileOperation(authorization, emailOperation);
  assert.equal(confirmed.operation.state, 'completed');
  assert.equal(confirmed.user?.email, body.email);
  assert.equal(confirmed.user?.active, false);
  assert.equal((await store.get(target.uid))?.securityVersion, 1);
  assert.equal((await identity.getUser(target.uid)).disabled, true);
  const passwordChange = await restarted.setTemporaryPassword(authorization, target.uid, {
    operationId: randomUUID(), tempPassword: separatePassword
  });
  assert.equal(passwordChange.operation.state, 'completed');
  assert.equal((await identity.getUser(target.uid)).disabled, true);
  assert.equal((await store.get(target.uid))?.active, false);
});

test('Fase 1.4 la API deniega al administrador revocado aunque falle la consulta de revocación', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const identity = realAuth!;
  const store = createFirestoreProfileStore(db);
  const admin = profile('strict-admin-' + randomUUID());
  const inactive = { ...profile('strict-inactive-' + randomUUID()), active: false };
  const supervisor = profile('strict-supervisor-' + randomUUID(), 'Supervisor');
  const target = profile('strict-target-' + randomUUID(), 'Auxiliar');
  const password = 'Fixture#9-strict-emulator';
  for (const user of [admin, inactive, supervisor, target]) {
    await identity.createUser({ uid: user.uid, email: user.email, password });
    await db.doc('users/' + user.uid).create(user);
  }
  const token = await signInWithPassword(admin.email, password);
  const claims = await identity.verifyIdToken(token, true);
  const request = { operationId: randomUUID() };
  const targetPath = 'users/' + target.uid;
  const emergencyPath = targetPath + '/emergency-disable';
  const movementQuery = db.collection('movements').where('targetId', '==', target.uid);
  let verificationError: string | undefined, rejectContainment = false;
  const verificationChecks: boolean[] = [];
  const call = await startAdminApi(t, createAuthService({
    ...identity,
    async verifyIdToken(idToken, checkRevoked: boolean) {
      verificationChecks.push(checkRevoked);
      // Only inject the transport failure, leaving token checks and the real data stores in place.
      if (verificationError && checkRevoked) throw Object.assign(new Error('Fallo de transporte de prueba'), { code: verificationError });
      return identity.verifyIdToken(idToken, true);
    },
    async containAccount(...args) {
      if (rejectContainment) throw new MutationRejected('PERMISSION_DENIED');
      return identity.containAccount(...args);
    }
  }, store));
  for (const [user, code] of [[inactive, 'USER_INACTIVE'], [supervisor, 'FORBIDDEN_ROLE']] as const) {
    const response = await call('POST', emergencyPath, await signInWithPassword(user.email, password), request);
    assert.deepEqual([response.status, response.data.code], [403, code]);
  }
  await identity.updateCredential(await identity.getUser(admin.uid), { validSince: String(claims.auth_time + 1) }, randomUUID());
  const revoked = await call('POST', emergencyPath, token, request);
  assert.deepEqual([revoked.status, revoked.data.code], [401, 'TOKEN_REVOKED']);
  for (const failure of ['app/network-timeout', 'app/network-error', 'auth/internal-error']) {
    verificationError = failure;
    verificationChecks.length = 0;
    const unavailable = await call('POST', emergencyPath, token, request);
    assert.deepEqual([unavailable.status, unavailable.data.code], [503, 'AUTHORIZATION_UNAVAILABLE']);
    assert.deepEqual(verificationChecks, [true]);
  }
  const patch = await call('PATCH', targetPath, token, { ...request, active: false, expectedProfileVersion: 0 });
  assert.deepEqual([patch.status, patch.data.code], [503, 'AUTHORIZATION_UNAVAILABLE']);
  assert.deepEqual(await store.get(target.uid), target);
  assert.equal(await store.operation(request.operationId), null);
  assert.equal((await identity.getUser(target.uid)).disabled, false);
  assert.equal((await movementQuery.get()).size, 0);
  assert.deepEqual(await store.get(admin.uid), admin);

  verificationError = undefined;
  while (Math.floor(Date.now() / 1000) <= claims.auth_time + 1) await sleep(200);
  const freshToken = await signInWithPassword(admin.email, password);
  rejectContainment = true;
  const blocked = await call('POST', emergencyPath, freshToken, request);
  assert.equal(blocked.status, 202);
  assert.equal(blocked.data.operation.profileApplied, true);
  assert.equal(blocked.data.operation.authDisabled, false);
  assert.equal(blocked.data.operation.refreshRevoked, false);
  assert.equal(blocked.data.user.active, false);
  assert.equal(blocked.data.currentAuthentication.disabled, false);
  assert.equal((await store.get(target.uid))?.active, false);
  assert.equal((await identity.getUser(target.uid)).disabled, false);
  assert.equal((await movementQuery.get()).size, 1);

  rejectContainment = false;
  const completed = await call('POST', emergencyPath, freshToken, request);
  assert.equal(completed.status, 200);
  assert.equal(completed.data.operation.authDisabled, true);
  assert.equal(completed.data.operation.refreshRevoked, true);
  assert.equal((await identity.getUser(target.uid)).disabled, true);
  assert.equal((await movementQuery.get()).size, 1);
});

test('Fase 1.4 repetir o reconciliar una desactivación histórica informa el perfil reactivado', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const identity = realAuth!;
  const store = createFirestoreProfileStore(db);
  const admin = profile('history-admin-' + randomUUID());
  const target = profile('history-target-' + randomUUID(), 'Supervisor');
  const password = 'Fixture#9-history-emulator';
  for (const user of [admin, target]) {
    await identity.createUser({ uid: user.uid, email: user.email, password });
    await db.doc('users/' + user.uid).create(user);
  }
  const token = await signInWithPassword(admin.email, password);
  let holdAuthRead = false;
  const authRead = barrier(), releaseAuthRead = barrier();
  const call = await startAdminApi(t, createAuthService({
    ...identity,
    async getUser(uid) {
      const account = await identity.getUser(uid);
      if (uid === target.uid && holdAuthRead) {
        holdAuthRead = false;
        authRead.resolve();
        await releaseAuthRead.promise;
      }
      return account;
    }
  }, store));
  const targetPath = 'users/' + target.uid;
  const emergencyPath = targetPath + '/emergency-disable';
  const request = { operationId: randomUUID() };
  const original = await call('POST', emergencyPath, token, request);
  assert.equal(original.status, 200);
  assert.equal(original.data.user.active, false);
  assert.equal(original.data.currentAuthentication.disabled, true);
  assert.equal(original.data.operation.refreshRevoked, true);

  holdAuthRead = true;
  const delayed = call('POST', emergencyPath, token, request);
  let reactivated: Awaited<ReturnType<typeof call>>;
  try {
    await Promise.race([authRead.promise, delayed.then(() => { throw Error('No se alcanzó la consulta de Auth'); })]);
    reactivated = await call('PATCH', targetPath, token, {
      active: true, expectedProfileVersion: original.data.user.profileVersion, operationId: randomUUID()
    });
  } finally {
    releaseAuthRead.resolve();
  }
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.data.user.active, true);
  assert.ok(reactivated.data.user.profileVersion > original.data.user.profileVersion);
  const raced = await delayed;
  assert.equal(raced.status, 200);
  assert.deepEqual(raced.data.user, reactivated.data.user);
  assert.equal(raced.data.currentAuthentication, null);
  const beforeReplay = await store.get(target.uid);
  const authBeforeReplay = await identity.getUser(target.uid);
  assert.equal(authBeforeReplay.disabled, false);

  for (const response of [await call('POST', emergencyPath, token, request),
    await call('POST', 'credential-operations/' + request.operationId + '/reconcile', token, {})]) {
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.operation, original.data.operation);
    assert.deepEqual(response.data.user, reactivated.data.user);
    assert.deepEqual(response.data.currentAuthentication, { disabled: false, profileVersion: reactivated.data.user.profileVersion });
    assert.match(describeEmergencyStatus(response.data), /La operación de desactivación se completó anteriormente\. Estado actual de la cuenta: ACTIVA\./);
    assert.match(describeEmergencyStatus(response.data), /Firebase Authentication: habilitada\. Revocación de esta operación: confirmada\./);
  }
  const late = describeEmergencyStatus(original.data, reactivated.data.user);
  assert.match(late, /Estado actual de la cuenta: ACTIVA\./);
  assert.match(late, /Firebase Authentication: pendiente de consulta\./);
  assert.equal((await db.collection('movements').where('targetId', '==', target.uid).get()).size, 2);
  assert.deepEqual(await store.get(target.uid), beforeReplay);
  assert.deepEqual(await identity.getUser(target.uid), authBeforeReplay);
});

async function seedOperationalUser(db: Firestore, role: Profile['role'], overrides: Partial<Profile> & Record<string, unknown> = {}) {
  const user = { ...profile('phase15-' + randomUUID(), role), ...overrides };
  const password = 'Fixture#9-operational-emulator';
  await realAuth!.createUser({ uid: user.uid, email: user.email, password });
  await db.doc('users/' + user.uid).create(user);
  return { user, password, token: await signInWithPassword(user.email, password) };
}

function operationalWrite(collection: string, id: string, data?: object, requestId = randomUUID(), expectedRevision = 0) {
  return { writes: [{ collection, id, requestId, expectedRevision, ...(data ? { mode: 'set', data } : { mode: 'delete' }) }] };
}

async function directFirestore(token: string, path: string, method = 'GET', fields?: object) {
  const result = await fetch(`http://${firestoreHost}/v1/projects/${project}/databases/${database}/documents/${path}`, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(fields ? { body: JSON.stringify({ fields }) } : {})
  });
  await result.arrayBuffer();
  return result.status;
}

test('asistencia conserva cambios de operarios distintos y rechaza una edición obsoleta del mismo operario', {
  skip: !firestoreHost || !authHost, timeout: 60_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const sector = randomUUID(), workers = [randomUUID(), randomUUID()], day = '2031-06-01';
  await db.doc('sectors/' + sector).create({ name: 'Asistencia sintética', galpones: [] });
  await Promise.all(workers.map((id, index) => db.doc('workers/' + id).create({ name: 'Persona ' + index, sectorId: sector })));
  const [one, two, admin] = await Promise.all([
    seedOperationalUser(db, 'Supervisor'),
    seedOperationalUser(db, 'Supervisor'),
    seedOperationalUser(db, 'Administrador')
  ]);
  const request = (worker: string, status: string, expected: string | null) => ({ writes: [{
    collection: 'attendance', id: day, mode: 'merge', requestId: randomUUID(),
    data: { date: day, records: { [worker]: status } }, expectedRecords: { [worker]: expected }
  }] });
  const insert = await Promise.all([
    call('POST', '/api/data/write', one.token, request(workers[0], 'Asistió', null)),
    call('POST', '/api/data/write', two.token, request(workers[1], 'Falta', null))
  ]);
  assert.deepEqual(insert.map(reply => reply.status), [200, 200]);
  const first = request(workers[0], 'Permiso', 'Asistió');
  assert.equal((await call('POST', '/api/data/write', one.token, first)).status, 200);
  const stale = await call('POST', '/api/data/write', two.token, request(workers[0], 'Falta', 'Asistió'));
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'ATTENDANCE_CONFLICT');
  assert.equal((await call('POST', '/api/data/write', one.token, first)).status, 200);
  assert.equal((await call('POST', '/api/data/write', admin.token, request(randomUUID(), 'Asistió', null))).status, 400);
  const stored = await db.doc('attendance/' + day).get();
  assert.deepEqual(stored.get('records'), { [workers[0]]: 'Permiso', [workers[1]]: 'Falta' });
  assert.equal(stored.get('expectedRecords'), undefined);
});

test('la API confirma proyectos, jerarquías, catálogo, inventario y personal con trazabilidad y permisos distintos', {
  skip: !firestoreHost || !authHost, timeout: 75_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const sectorId = randomUUID(), barnId = randomUUID(), materialId = randomUUID(), workerId = randomUUID();
  const providerId = randomUUID(), catalogId = randomUUID(), unassignedId = randomUUID();
  const [admin, warehouse, supervisor, helper] = await Promise.all([
    seedOperationalUser(db, 'Administrador'), seedOperationalUser(db, 'Almacén'),
    seedOperationalUser(db, 'Supervisor'),
    seedOperationalUser(db, 'Auxiliar')
  ]);
  const write = (token: string, collection: string, id: string, data?: object, expected = 0) =>
    call('POST', '/api/data/write', token, operationalWrite(collection, id, data, randomUUID(), expected));
  const read = async (token: string, collection: string, id: string) => (await call('GET', '/api/data/' + collection + '/' + id, token)).data.document;
  assert.equal((await write(admin.token, 'providers', providerId, { name: 'Proveedor sintético' })).status, 200);
  const catalog = { code: 'ACEP-01', name: 'Actividad de catálogo', area: 'Obra Civil', structure: 'Pórtico',
    technology: 'Proveedor sintético', progressMode: 'quantity', unit: 'u', targetUnits: 5, active: true };
  assert.equal((await write(admin.token, 'masterCatalog', catalogId, catalog)).status, 200);
  assert.equal((await write(warehouse.token, 'masterCatalog', catalogId, { ...catalog, active: false }, 1)).status, 403);
  assert.equal((await write(admin.token, 'masterCatalog', catalogId, { ...catalog, active: false }, 1)).status, 200);
  assert.equal((await read(supervisor.token, 'masterCatalog', catalogId)).active, false);
  assert.equal((await call('GET', '/api/data/masterCatalog/' + catalogId, helper.token)).status, 403);

  assert.equal((await write(admin.token, 'sectors', sectorId, { name: 'Sector inicial', code: 'ACEP', galpones: [] })).status, 200);
  const area = { id: 'a', name: 'Obra Civil', structures: [{ id: 's', name: 'Pórtico', activities: [
    { id: 'assigned', code: catalog.code, name: catalog.name, catalogItemId: catalogId, unit: 'u', targetUnits: 5, progressMode: 'quantity' }
  ] }] };
  const sector = { name: 'Sector actualizado', code: 'ACEP', galpones: [{ id: barnId, sectorId, code: 'B1', name: 'Galpón', areas: [area] }] };
  assert.equal((await write(admin.token, 'sectors', sectorId, sector, 1)).status, 200);
  const schedule = structuredClone(sector);
  Object.assign(schedule.galpones[0].areas[0].structures[0].activities[0], { startDate: '2031-06-01', dueDate: '2031-06-05' });
  assert.equal((await write(supervisor.token, 'sectors', sectorId, schedule, 2)).status, 200);
  assert.equal((await read(supervisor.token, 'sectors', sectorId)).galpones[0].areas[0].structures[0].activities[0].dueDate, '2031-06-05');

  const material = { sectorId, galponId: barnId, code: 'STK-01', name: 'Perno', unit: 'u', totalQty: 10, initialUsedQty: 1 };
  assert.equal((await write(admin.token, 'materials', materialId, { ...material, galponId: randomUUID() })).status, 400);
  assert.equal((await write(admin.token, 'materials', materialId, material)).status, 200);
  assert.equal((await write(warehouse.token, 'materials', materialId, { ...material, totalQty: 15 }, 1)).status, 200);
  assert.equal((await write(warehouse.token, 'materials', materialId, { ...material, totalQty: 12 }, 2)).status, 200);
  assert.equal((await write(helper.token, 'materials', materialId, { ...material, totalQty: 20 }, 3)).status, 403);
  const ledger = (await db.collection('movements').where('targetId', '==', materialId).get()).docs.map(doc => doc.data());
  assert.equal(ledger.length, 3);
  assert.ok(ledger.every(event => event.projectCode === 'ACEP' && event.sectorId === sectorId && event.galponId === barnId && event.requestId));
  assert.ok(ledger.some(event => event.stockDirection === 'ENTRADA' && event.stockDelta === 5 && event.userId === warehouse.user.uid));
  assert.ok(ledger.some(event => event.stockDirection === 'SALIDA' && event.stockDelta === -3));
  assert.equal((await write(warehouse.token, 'materials', materialId, undefined, 3)).status, 200);

  const worker = { sectorId, galponId: barnId, name: 'Operario asignado', workerCode: 'W-SYN', active: true };
  assert.equal((await write(helper.token, 'workers', workerId, worker)).status, 200);
  assert.equal((await write(helper.token, 'workers', workerId, { ...worker, name: 'Edición no autorizada' }, 1)).status, 403);
  assert.equal((await write(supervisor.token, 'workers', workerId, { ...worker, name: 'Operario actualizado' }, 1)).status, 200);
  assert.equal((await read(supervisor.token, 'workers', workerId)).name, 'Operario actualizado');
  assert.equal((await write(admin.token, 'workers', unassignedId, { name: 'Pendiente de asignación' })).status, 200);
  assert.equal((await call('GET', '/api/data/workers/' + unassignedId, supervisor.token)).status, 200);
  assert.equal(await directFirestore(admin.token, 'workers/' + workerId, 'DELETE'), 403);
  assert.equal((await write(supervisor.token, 'workers', workerId, undefined, 2)).status, 200);

  assert.equal((await write(admin.token, 'sectors', sectorId, { ...sector, galpones: [] }, 3)).status, 200);
  assert.equal((await write(admin.token, 'sectors', sectorId, undefined, 4)).status, 200);
});

test('retirar del Gantt conserva la actividad compartida, el avance y la bitácora dentro de su alcance', {
  skip: !firestoreHost || !authHost, timeout: 60_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const sectorId = randomUUID(), galponId = randomUUID(), otherBarn = randomUUID(), advanceId = randomUUID();
  const activity = { id: 'activity', code: 'ACT', name: 'Actividad compartida', targetUnits: 10,
    startDate: '2032-01-01', dueDate: '2032-01-30', unit: 'u' };
  const barn = { id: galponId, sectorId, areas: [{ id: 'area', structures: [{ id: 'structure', activities: [activity] }] }] };
  await db.doc('sectors/' + sectorId).create({ name: 'Sector de planificación', galpones: [barn, { ...barn, id: otherBarn }] });
  const advance = { id: advanceId, sectorId, galponId, activityId: activity.id, activityCode: activity.code,
    date: '2032-01-02', quantityToday: 4, syncState: 'synced' };
  await db.doc('advances/' + advanceId).create(advance);
  const [supervisor, warehouse, other, admin] = await Promise.all([
    seedOperationalUser(db, 'Supervisor'),
    seedOperationalUser(db, 'Almacén'),
    seedOperationalUser(db, 'Supervisor'), seedOperationalUser(db, 'Administrador')
  ]);
  const read = (token: string) => call('GET', '/api/data/sectors/' + sectorId, token);
  const write = (token: string, data: object, requestId = randomUUID(), revision = 0) =>
    call('POST', '/api/data/write', token, operationalWrite('sectors', sectorId, data, requestId, revision));
  const base = (await read(supervisor.token)).data.document;
  assert.deepEqual(ganttPlannedActivities(barnActivities(base.galpones[0])), [activity]);
  const malicious = structuredClone(base);
  malicious.galpones[0].areas[0].structures[0].activities = [];
  assert.equal((await write(supervisor.token, malicious)).status, 403);
  const withdrawal = structuredClone(base);
  withdrawal.galpones[0].ganttExcludedActivityIds = [activity.id];
  const plan = { sectorId, galponId, activityId: activity.id, requestId: randomUUID(), expectedRevision: 0 };
  const retire = (token: string, data = plan) => call('POST', '/api/data/gantt/withdraw', token, data);
  assert.equal((await retire(warehouse.token)).status, 403);
  assert.equal((await retire(other.token, { ...plan, galponId: randomUUID() })).status, 400);
  assert.equal((await retire(supervisor.token, { ...plan, activityId: 'unknown' })).status, 400);
  const injected = { ...plan, writes: operationalWrite('sectors', sectorId).writes };
  assert.equal((await retire(supervisor.token, injected)).status, 400);
  const combined = structuredClone(withdrawal);
  const adminBase = (await read(admin.token)).data.document;
  const secondBarn = adminBase.galpones[1];
  secondBarn.ganttExcludedActivityIds = [activity.id];
  combined.galpones = [secondBarn];
  const bothBarnsSupervisor = await seedOperationalUser(db, 'Supervisor');
  assert.equal((await write(bothBarnsSupervisor.token, combined)).data.code, 'GANTT_WITHDRAWAL_REQUIRED');
  const removing = { ...combined, galpones: [{ ...secondBarn, ganttExcludedActivityIds: undefined }] };
  assert.equal((await write(bothBarnsSupervisor.token, removing)).data.code, 'STRUCTURAL_DEPENDENCIES');
  assert.equal((await call('POST', '/api/data/write', bothBarnsSupervisor.token, operationalWrite('sectors', sectorId))).data.code,
    'STRUCTURAL_DEPENDENCIES');
  assert.equal((await db.collection('movements').where('sectorId', '==', sectorId).get()).size, 0);
  assert.equal((await read(admin.token)).data.document.galpones.length, 2);
  const renamed = { ...(await read(admin.token)).data.document, name: 'Sector actualizado mientras el retiro estaba pendiente' };
  assert.equal((await write(admin.token, renamed)).status, 200);
  assert.equal((await retire(supervisor.token)).data.code, 'STALE_DATA_VERSION');
  assert.equal((await read(supervisor.token)).data.document.galpones[0].ganttExcludedActivityIds, undefined);
  const requestId = plan.requestId;
  assert.equal((await retire(supervisor.token, { ...plan, requestId, expectedRevision: 1 })).status, 200);
  assert.equal((await retire(supervisor.token, { ...plan, requestId, expectedRevision: 0 })).status, 200);
  assert.equal((await retire(supervisor.token, { ...plan, requestId, activityId: 'another' })).data.code, 'OPERATION_ID_CONFLICT');

  const response = await call('POST', '/api/data/snapshot', supervisor.token, { collections: ['sectors', 'advances'] });
  assert.equal(response.status, 200);
  const sector = response.data.documents.sectors.find(item => item.id === sectorId);
  const shared = barnActivities(sector.galpones[0]);
  assert.deepEqual(shared, [activity]);
  assert.deepEqual(ganttPlannedActivities(shared, sector.galpones[0].ganttExcludedActivityIds), []);
  assert.deepEqual(response.data.documents.advances.find(item => item.id === advanceId), advance);
  const advances = indexActivityAdvances(response.data.documents.advances)(galponId, activity.id, activity.code);
  assert.equal(evaluateActivityProgress(activity, advances, '2032-01-04').progressPercent, 40);
  assert.equal(fieldReport([sector], [{ galponId }], [], [], {},
    { project: 'ALL', sector: 'ALL', galpon: 'ALL', activityFiltered: true })[0].activities, 1);
  const ledger = await db.collection('movements').where('requestId', '==', requestId).get();
  assert.equal(ledger.size, 1);
  assert.equal(ledger.docs[0].get('userId'), supervisor.user.uid);
  assert.deepEqual(ledger.docs[0].get('ganttWithdrawals'), [{ galponId, activityId: activity.id }]);
  assert.equal((await call('GET', '/api/data/movements/' + ledger.docs[0].id, other.token)).status, 200);
  assert.deepEqual((await db.doc('advances/' + advanceId).get()).data(), advance);

  const dateChange = structuredClone(sector);
  delete dateChange.galpones[0].ganttExcludedActivityIds;
  dateChange.galpones[0].areas[0].structures[0].activities[0].dueDate = '2032-01-31';
  assert.equal((await write(supervisor.token, dateChange, randomUUID(), 2)).status, 200);
  assert.deepEqual((await read(supervisor.token)).data.document.galpones[0].ganttExcludedActivityIds, [activity.id]);
  const sharedDeletion = (await read(admin.token)).data.document;
  sharedDeletion.galpones[1].areas[0].structures[0].activities = [];
  assert.equal((await write(admin.token, sharedDeletion, randomUUID(), 3)).status, 200);
  const afterDeletion = (await read(admin.token)).data.document;
  assert.deepEqual(afterDeletion.galpones[0].ganttExcludedActivityIds, [activity.id]);
  assert.deepEqual(barnActivities(afterDeletion.galpones[1]), []);
  const emptyBarnRemoval = { ...afterDeletion, galpones: [afterDeletion.galpones[0]] };
  const deletionId = randomUUID();
  assert.equal((await write(admin.token, emptyBarnRemoval, deletionId, 4)).status, 200);
  const deletionLedger = await db.collection('movements').where('requestId', '==', deletionId).get();
  assert.equal(deletionLedger.size, 1);
  assert.equal(deletionLedger.docs[0].get('targetId'), otherBarn);
  assert.equal(deletionLedger.docs[0].get('type'), 'ELIMINACIÓN');
  assert.equal((await db.collection('_structuralLocations').where('galponId', '==', otherBarn).get()).size, 1);
  assert.equal((await call('GET', '/api/data/movements/' + deletionLedger.docs[0].id, other.token)).status, 200);
  assert.equal((await call('GET', '/api/data/movements/' + deletionLedger.docs[0].id, supervisor.token)).status, 200);
  assert.deepEqual((await db.doc('advances/' + advanceId).get()).data(), advance);
});

test('las bajas estructurales conservan inventario, personal, asistencia y sus referencias compartidas', {
  skip: !firestoreHost || !authHost, timeout: 60_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const admin = await seedOperationalUser(db, 'Administrador');
  const sectorId = randomUUID(), ids = Array.from({ length: 6 }, () => randomUUID());
  const [materials, workers, attendance, shared, empty, external] = ids;
  const sector = { name: 'Dependencias', galpones: ids.map(id => ({ id, name: id, sectorId })) };
  await db.doc('sectors/' + sectorId).create(sector);
  const data = [
    { path: 'materials/' + randomUUID(), value: { name: 'Insumo', galponId: materials } },
    { path: 'workers/' + randomUUID(), value: { name: 'Operario', sectorId, galponId: workers } },
    { path: 'attendance/' + randomUUID(), value: { galponId: attendance, records: {} } },
    { path: 'advances/' + randomUUID(), value: { sectorId, galponId: external, sharedWithGalponId: shared } }
  ];
  await Promise.all(data.map(({ path, value }) => db.doc(path).create(value)));
  for (const id of ids.slice(0, 4)) {
    const body = operationalWrite('sectors', sectorId, { ...sector, galpones: sector.galpones.filter(barn => barn.id !== id) });
    assert.equal((await call('POST', '/api/data/write', admin.token, body)).data.code, 'STRUCTURAL_DEPENDENCIES');
    assert.equal((await call('GET', '/api/operation-receipts/' + body.writes[0].requestId, admin.token)).data.committed, false);
  }
  const drop = operationalWrite('sectors', sectorId, { ...sector, galpones: sector.galpones.filter(barn => barn.id !== empty) });
  const unrelated = operationalWrite('workers', randomUUID(), { name: 'Operario sin asignación' });
  assert.equal((await call('POST', '/api/data/write', admin.token, { writes: [...drop.writes, ...unrelated.writes] })).data.code,
    'STRUCTURAL_DELETE_MUST_BE_SEPARATE');
  assert.equal((await db.collection('movements').where('sectorId', '==', sectorId).get()).size, 0);
  assert.deepEqual((await db.doc('sectors/' + sectorId).get()).data(), sector);
  for (const { path, value } of data) assert.deepEqual((await db.doc(path).get()).data(), value);
});

test('Personal distingue alta individual e importación atómica en los seis roles', {
  skip: !firestoreHost || !authHost, timeout: 60_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const sectorId = randomUUID(), otherSector = randomUUID(), galponId = randomUUID(), otherBarn = randomUUID(), wrongProjectBarn = randomUUID();
  await Promise.all([
    db.doc('sectors/' + sectorId).create({ name: 'Personal', code: 'PER-OK', galpones: [
      { id: galponId, projectCode: 'PER-OK' }, { id: otherBarn, projectCode: 'PER-OK' }, { id: wrongProjectBarn, projectCode: 'PER-NO' }
    ] }),
    db.doc('sectors/' + otherSector).create({ name: 'Personal externo', galpones: [] })
  ]);
  const roles = ['Administrador', 'Supervisor', 'Auxiliar', 'Jefe de proyecto', 'Almacén', 'Solo lectura'] as const;
  const people = await Promise.all(roles.map(role => seedOperationalUser(db, role)));
  const person = (location: object = {}) => ({ collection: 'workers', id: randomUUID(), mode: 'set',
    requestId: randomUUID(), expectedRevision: 0, data: { name: 'Persona de prueba', workerCode: randomUUID(),
      workArea: 'Montaje', role: 'Operario', sectorId, galponId, ...location }
  });
  const batch = (token: string, writes: ReturnType<typeof person>[]) => call('POST', '/api/data/write', token, { writes });
  const submit = (token: string, body: object) => call('POST', '/api/data/workers/import', token, body);
  const assertAbsent = async (writes: ReturnType<typeof person>[]) => {
    const documents = await db.getAll(...writes.map(write => db.doc('workers/' + write.id)));
    assert.ok(documents.every(document => !document.exists));
    for (const write of writes) assert.equal((await db.collection('movements').where('targetId', '==', write.id).get()).size, 0);
  };
  for (const [index, { token }] of people.entries()) {
    const role = roles[index];
    const individual = person();
    const canCreate = role !== 'Solo lectura' && role !== 'Jefe de proyecto';
    assert.equal((await batch(token, [individual])).status, canCreate ? 200 : 403, role);
    const read = await call('GET', '/api/data/workers', token);
    assert.equal(read.status, role === 'Solo lectura' ? 403 : 200, role);
    if (role === 'Administrador') continue;
    const writes = [person(), { ...person(), mode: 'merge' }];
    assert.equal((await batch(token, writes)).status, 403, role);
    assert.equal((await submit(token, { operationId: randomUUID(), writes: [writes[0]] })).status, 403, role);
    await assertAbsent(writes);
  }
  const [admin, , helper, manager, warehouse] = people;
  const otherProject = person({ galponId: wrongProjectBarn });
  assert.equal((await batch(helper.token, [otherProject])).status, 200);
  const mismatched = person({ sectorId: otherSector, galponId: otherBarn });
  assert.equal((await batch(helper.token, [mismatched])).status, 400);
  await assertAbsent([mismatched]);
  const existing = person();
  assert.equal((await batch(warehouse.token, [existing])).status, 200);
  const edit = { ...existing, requestId: randomUUID(), expectedRevision: 1, data: { ...existing.data, name: 'Edición de Almacén' } };
  assert.equal((await batch(manager.token, [edit])).status, 403);
  assert.equal((await batch(warehouse.token, [edit, person()])).status, 200);
  assert.equal((await call('POST', '/api/data/write', warehouse.token, operationalWrite('workers', existing.id, undefined, randomUUID(), 2))).status, 200);

  const operationId = randomUUID(), writes = [person(), person()];
  assert.equal((await submit(admin.token, { operationId, writes })).status, 200);
  assert.equal((await submit(admin.token, { operationId, writes })).status, 200);
  assert.equal((await submit(admin.token, { operationId, writes: writes.slice(0, 1) })).data.code, 'OPERATION_ID_CONFLICT');
  const ledger = await db.collection('movements').where('importOperationId', '==', operationId).get();
  assert.equal(ledger.size, 2);
  assert.ok(ledger.docs.every(doc => doc.get('userId') === admin.user.uid));
  const untouched = person();
  assert.equal((await submit(admin.token, { operationId: randomUUID(), writes: [untouched, writes[0]] })).status, 409);
  const invalid = person({ sectorId: otherSector });
  assert.equal((await submit(admin.token, { operationId: randomUUID(), writes: [untouched, invalid] })).status, 400);
  await assertAbsent([untouched, invalid]);
});

test('Personal valida tipos y reserva códigos normalizados frente a lotes simultáneos y datos heredados', {
  skip: !firestoreHost || !authHost, timeout: 60_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const sectorId = randomUUID();
  await db.doc('sectors/' + sectorId).create({ name: 'Sector de personal', galpones: [] });
  const [admin, helper] = await Promise.all([seedOperationalUser(db, 'Administrador'),
    seedOperationalUser(db, 'Auxiliar')]);
  const worker = { name: 'Personal sintético', workArea: 'Montaje', role: 'Operario', sectorId, workerCode: randomUUID() };
  const row = (overrides: object = {}) => ({ collection: 'workers', id: randomUUID(), mode: 'set', requestId: randomUUID(),
    data: { ...worker, ...overrides } });
  const submit = (token: string, writes: object[], operationId = randomUUID()) =>
    call('POST', '/api/data/workers/import', token, { operationId, writes });
  const write = (token: string, entry: object) => call('POST', '/api/data/write', token, { writes: [entry] });
  const assertMissing = async (entries: ReturnType<typeof row>[]) => {
    for (const entry of entries) {
      assert.equal((await db.doc('workers/' + entry.id).get()).exists, false);
      assert.equal((await db.collection('movements').where('requestId', '==', entry.requestId).get()).size, 0);
    }
  };
  const invalid = [{ workerCode: {} }, { dni: {} }, { workArea: [] }, { active: 'true' }, { role: null }].map(row);
  for (const entry of invalid) assert.equal((await write(helper.token, entry)).status, 400);
  await assertMissing(invalid);
  const individual = row();
  assert.equal((await write(helper.token, individual)).status, 200);
  const edited = { ...individual, mode: 'merge', expectedRevision: 1, requestId: randomUUID(), data: { dni: [] } };
  assert.equal((await write(admin.token, edited)).status, 400);
  assert.equal((await db.doc('workers/' + individual.id).get()).get('dni'), undefined);

  const invalidLot = [row({ workerCode: 'VALID-BEFORE-ERROR' }), { ...row({ dni: 'x'.repeat(65) }), sourceRow: 7 }];
  const invalidId = randomUUID();
  const rejected = await submit(admin.token, invalidLot, invalidId);
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.message, /Fila 7.*dni/);
  assert.equal((await call('GET', '/api/operation-receipts/' + invalidId, admin.token)).data.committed, false);
  await assertMissing(invalidLot);
  const duplicates = [row({ workerCode: 'DUP-01' }), row({ workerCode: ' dup-01 ' })];
  assert.equal((await submit(admin.token, duplicates)).data.code, 'WORKER_CODE_CONFLICT');
  await assertMissing(duplicates);
  await db.doc('workers/legacy-' + randomUUID()).create({ name: 'Legado', workerCode: '  LeGaCy-A  ' });
  const legacyDuplicate = row({ workerCode: 'legacy-a' });
  assert.equal((await submit(admin.token, [legacyDuplicate])).data.code, 'WORKER_CODE_CONFLICT');
  await assertMissing([legacyDuplicate]);

  const [first, second] = [row({ workerCode: 'RACE-01' }), row({ workerCode: 'race-01' })];
  const ids = [randomUUID(), randomUUID()];
  const results = await Promise.all([submit(admin.token, [first], ids[0]), submit(admin.token, [second], ids[1])]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? 0 : 1;
  const rows = [first, second];
  assert.equal((await submit(admin.token, [rows[winner]], ids[winner])).status, 200);
  assert.equal((await submit(admin.token, [row({ workerCode: 'NEW' })], ids[winner])).data.code, 'OPERATION_ID_CONFLICT');
  assert.equal((await db.collection('movements').where('importOperationId', '==', ids[winner]).get()).size, 1);
  await assertMissing([rows[1 - winner]]);
  assert.equal((await call('GET', '/api/operation-receipts/' + ids[1 - winner], admin.token)).data.committed, false);
  assert.equal((await submit(admin.token, [row({ workerCode: 'DISTINCT-A' }), row({ workerCode: 'DISTINCT-B' })])).status, 200);
});

test('Personal confirma las mil filas admitidas en un lote con un único recibo de importación', {
  skip: !firestoreHost || !authHost, timeout: 60_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const { token } = await seedOperationalUser(db, 'Administrador');
  const operationId = randomUUID();
  const writes = Array.from({ length: 1001 }, (_, index) => ({
    collection: 'workers', id: randomUUID(), requestId: randomUUID(), mode: 'set', data: {
      name: 'Fila sintética ' + index, workerCode: 'MILL-' + index, workArea: 'Montaje', role: 'Operario'
    }
  }));
  const endpoint = '/api/data/workers/import';
  assert.equal((await call('POST', endpoint, token, { operationId, writes })).status, 400);
  assert.equal((await db.collection('movements').where('importOperationId', '==', operationId).get()).size, 0);
  assert.equal((await call('POST', endpoint, token, { operationId, writes: writes.slice(0, 1000) })).status, 200);
  assert.equal((await db.collection('movements').where('importOperationId', '==', operationId).get()).size, 1000);
  assert.equal((await call('GET', '/api/operation-receipts/' + operationId, token)).data.committed, true);
  assert.equal((await db.doc('workers/' + writes[1000].id).get()).exists, false);
});

test('Fase 1.5 el token revocado externamente o mediante la aplicación no puede leer ni reanudar escrituras operativas', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  await loadRules();
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const store = createFirestoreProfileStore(db);
  const call = await startAdminApi(t, createAuthService(realAuth!, store), db);
  const [external, internal] = await Promise.all([seedOperationalUser(db, 'Administrador'), seedOperationalUser(db, 'Administrador')]);
  const id = randomUUID();
  await db.doc('providers/' + id).create({ id, name: 'Proveedor sintético' });
  const path = '/api/data/providers/' + id;
  const writes = operationalWrite('providers', id, { name: 'Cambio autorizado' });
  assert.equal((await call('GET', path, external.token)).status, 200);
  assert.equal((await call('POST', '/api/data/write', external.token, writes)).status, 200);
  const claims = await realAuth!.verifyIdToken(external.token, true);
  await realAuth!.updateCredential(await realAuth!.getUser(external.user.uid), { validSince: String(claims.auth_time + 1) }, randomUUID());
  assert.equal((await store.get(external.user.uid))?.sessionValidAfter, undefined);
  assert.equal((await store.get(external.user.uid))?.active, true);
  for (const method of ['GET', 'PATCH']) {
    assert.equal(await directFirestore(external.token, 'providers/' + id, method,
      method === 'PATCH' ? { name: { stringValue: 'Intento directo' } } : undefined), 403);
  }
  const queued = operationalWrite('providers', id, { name: 'Operación offline rechazada' }, randomUUID(), 1);
  for (const response of [await call('GET', path, external.token), await call('POST', '/api/data/write', external.token, queued)]) {
    assert.deepEqual([response.status, response.data.code], [401, 'TOKEN_REVOKED']);
  }
  const revoked = await call('POST', 'users/' + internal.user.uid + '/revoke-sessions', internal.token, { operationId: randomUUID() });
  assert.equal(revoked.status, 200);
  const cutoff = (await store.get(internal.user.uid))!.sessionValidAfter!;
  assert.ok(cutoff > 0);
  assert.equal((await call('GET', path, internal.token)).status, 401);
  assert.equal((await call('POST', '/api/data/write', internal.token, queued)).status, 401);
  assert.equal((await db.doc('providers/' + id).get()).get('name'), 'Cambio autorizado');
  const providerCutoff = Math.floor(Date.parse((await realAuth!.getUser(internal.user.uid)).tokensValidAfterTime!) / 1000);
  assert.ok(Number.isFinite(providerCutoff));
  while (Math.floor(Date.now() / 1000) <= Math.max(cutoff, providerCutoff)) await sleep(100);
  // The Auth emulator can report auth_time on a different second boundary from the test process.
  await sleep(1100);
  const fresh = await signInWithPassword(internal.user.email, internal.password);
  assert.ok((await realAuth!.verifyIdToken(fresh, true)).auth_time > cutoff);
  assert.equal((await call('GET', path, fresh)).status, 200);
  assert.equal((await call('POST', '/api/data/write', fresh, queued)).status, 200);
  assert.equal(await directFirestore(fresh, 'providers/' + id), 403);
});


test('alta administrativa usa el UID reservado aunque la consulta REST de perfiles se deniegue', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  await loadRules();
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const [admin, helper] = await Promise.all([seedOperationalUser(db, 'Administrador'), seedOperationalUser(db, 'Auxiliar')]);
  const rest = await fetch(`http://${firestoreHost}/v1/projects/${project}/databases/${database}/documents:runQuery`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'users' }], limit: 300 } })
  });
  assert.equal(rest.status, 403);
  const email = randomUUID() + '@example.test', password = 'Fixture#9-integration-password';
  const request = { email, password, displayName: 'Supervisor de prueba', role: 'Supervisor', authMethod: 'password' };
  assert.equal((await call('POST', 'users', helper.token, request)).status, 403);
  const created = await call('POST', 'users', admin.token, request);
  assert.equal(created.status, 201);
  const uid = created.data.user.uid;
  assert.equal((await realAuth!.getUserByEmail(email)).uid, uid);
  assert.equal((await db.doc('users/' + uid).get()).get('role'), 'Supervisor');
  assert.equal((await call('POST', 'users', admin.token, request)).status, 409);
  const token = await signInWithPassword(email, password);
  assert.equal((await call('GET', '/api/auth/profile', token)).data.profile.uid, uid);
  assert.equal((await call('GET', 'users', admin.token)).data.users.find(user => user.uid === uid).role, 'Supervisor');
});

test('duplicar plantilla copia actividades y duración, controla códigos y conserva el origen', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const [admin, supervisor] = await Promise.all([seedOperationalUser(db, 'Administrador'), seedOperationalUser(db, 'Supervisor')]);
  const source = 'PLANT-' + randomUUID(), name = source + '-COPIA';
  const catalog = { technology: source, name: 'Actividad', code: 'ACT-01', areaName: 'Obra Civil', structureName: 'Pórtico',
    targetUnits: 5, unit: 'u', weight: 1, plannedHH: 4, durationDays: 8, active: true };
  const original = randomUUID();
  assert.equal((await call('POST', '/api/data/write', admin.token, operationalWrite('masterCatalog', original, catalog))).status, 200);
  assert.equal((await call('POST', '/api/data/write', admin.token,
    operationalWrite('masterCatalog', randomUUID(), { ...catalog, code: ' act-01 ' }))).data.code, 'CATALOG_CODE_CONFLICT');
  const requestId = randomUUID(), endpoint = '/api/data/catalog/templates/duplicate';
  const request = { source, name, requestId };
  assert.equal((await call('POST', endpoint, supervisor.token, request)).status, 403);
  assert.equal((await call('POST', endpoint, admin.token, request)).status, 200);
  assert.equal((await call('POST', endpoint, admin.token, request)).status, 200);
  assert.equal((await call('POST', endpoint, admin.token, { ...request, name: name + '2' })).data.code, 'OPERATION_ID_CONFLICT');
  const copy = await db.collection('masterCatalog').where('technology', '==', name).get();
  assert.equal(copy.size, 1);
  assert.notEqual(copy.docs[0].id, original);
  assert.equal(copy.docs[0].get('durationDays'), 8);
  assert.equal((await db.doc('masterCatalog/' + original).get()).get('technology'), source);
  assert.equal((await db.collection('movements').where('requestId', '==', requestId).get()).size, 2);
});

test('los supervisores consultan todos los sectores y avances ajenos con perfiles nuevos y heredados', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  await loadRules();
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const ids = [randomUUID(), randomUUID()], barnIds = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    await db.doc('sectors/' + id).create({ name: 'Sector ' + index, code: 'P-' + index, galpones: [{
      id: barnIds[index], responsible: 'Responsable de texto libre',
      areas: [{ id: 'area', structures: [{ id: 'structure', activities: [{ id: 'act', code: 'ACT', name: 'Actividad' }] }] }]
    }] });
  }
  const [one, two, reader] = await Promise.all([
    seedOperationalUser(db, 'Supervisor', { assignedProject: 'LEGACY', assignedSectorIds: [ids[0]], assignedGalponIds: [barnIds[0]] }),
    seedOperationalUser(db, 'Supervisor'), seedOperationalUser(db, 'Solo lectura')
  ]);
  const [a, b] = ids;
  const advanceId = randomUUID();
  const data = { sectorId: b, galponId: barnIds[1], activityId: 'act', activityCode: 'ACT',
    date: '2031-02-03', quantityToday: 4, userId: one.user.uid };
  assert.equal((await call('POST', '/api/data/write', two.token, operationalWrite('advances', advanceId, data))).status, 200);
  for (const supervisor of [one, two]) {
    const snapshot = await call('POST', '/api/data/snapshot', supervisor.token, { collections: ['sectors', 'advances'] });
    assert.equal(snapshot.status, 200);
    assert.ok(ids.every(id => snapshot.data.documents.sectors.some(sector => sector.id === id)));
    assert.equal(snapshot.data.documents.advances.find(advance => advance.id === advanceId).userId, two.user.uid);
    assert.equal((await call('GET', '/api/data/sectors/' + b, supervisor.token)).status, 200);
  }
  assert.equal(await directFirestore(one.token, 'sectors/' + a), 403);
  assert.equal((await call('GET', '/api/data/advances/' + advanceId, reader.token)).status, 403);
  const worker = randomUUID(), invalidWorker = randomUUID();
  await db.doc('workers/' + worker).create({ name: 'Válido', sectorId: b, galponId: barnIds[1], active: true });
  await db.doc('workers/' + invalidWorker).create({ name: 'Otro galpón', sectorId: a, galponId: barnIds[0], active: true });
  assert.equal((await call('POST', '/api/data/write', one.token,
    operationalWrite('advances', randomUUID(), { ...data, workerIds: [invalidWorker] }))).status, 400);
  const linked = operationalWrite('advances', randomUUID(), { ...data, workerIds: [worker] });
  assert.equal((await call('POST', '/api/data/write', one.token, linked)).status, 200);
  assert.equal((await call('POST', '/api/data/write', one.token, linked)).status, 200);
  assert.deepEqual((await db.doc('advances/' + linked.writes[0].id).get()).get('workerIds'), [worker]);
  assert.equal((await call('POST', '/api/data/write', one.token, operationalWrite('workers', worker))).data.code, 'WORKER_DEPENDENCIES');
  const admin = await seedOperationalUser(db, 'Administrador');
  const removing = (await call('GET', '/api/data/sectors/' + b, admin.token)).data.document;
  removing.galpones[0].areas[0].structures[0].activities = [];
  assert.equal((await call('POST', '/api/data/write', admin.token, operationalWrite('sectors', b, removing))).data.code, 'ACTIVITY_DEPENDENCIES');
  const invalid = { ...data, sectorId: a };
  assert.equal((await call('POST', '/api/data/write', one.token, operationalWrite('advances', randomUUID(), invalid))).status, 400);
  const manager = await seedOperationalUser(db, 'Jefe de proyecto');
  const ownSector = (await call('GET', '/api/data/sectors/' + a, manager.token)).data.document;
  ownSector.galpones.push({ ...ownSector.galpones[0], id: barnIds[1] });
  assert.equal((await call('POST', '/api/data/write', manager.token, operationalWrite('sectors', a, ownSector))).status, 403);
});

test('Fase 1.5 los movimientos solo nacen de mutaciones autorizadas o importaciones administrativas identificadas', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  await loadRules();
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const sectorId = randomUUID(), galponId = randomUUID(), materialId = randomUUID(), advanceId = randomUUID();
  await db.doc('sectors/' + sectorId).create({ id: sectorId, name: 'Sector', galpones: [{ id: galponId,
    areas: [{ id: 'area', structures: [{ id: 'structure', activities: [{ id: 'act', code: 'ACT' }] }] }] }] });
  await db.doc('materials/' + materialId).create({ id: materialId, name: 'Material', unit: 'u', galponId, sectorId, totalQty: 10, usedQty: 1, initialUsedQty: 1 });
  const [reader, helper, admin] = await Promise.all([seedOperationalUser(db, 'Solo lectura'),
    seedOperationalUser(db, 'Auxiliar'), seedOperationalUser(db, 'Administrador')]);
  const fake = operationalWrite('movements', randomUUID(), { user: 'Otro actor', detail: 'Evento inventado' });
  const mutation = operationalWrite('advances', advanceId, { date: '2026-01-01', sectorId, galponId, activityCode: 'ACT', quantityToday: 1,
    materialsUsedToday: [{ materialId, qty: 2 }], userId: reader.user.uid });
  for (const user of [reader, helper, admin]) {
    assert.equal(await directFirestore(user.token, 'movements/' + randomUUID(), 'PATCH', { detail: { stringValue: 'Falso' } }), 403);
    assert.equal((await call('POST', '/api/data/write', user.token, fake)).status, 403);
  }
  assert.equal((await call('POST', '/api/data/write', reader.token, mutation)).status, 403);
  assert.equal((await call('POST', '/api/data/write', helper.token, operationalWrite('materials', materialId, { name: 'Intento directo' }))).status, 403);
  assert.equal((await call('POST', '/api/data/write', helper.token, mutation)).status, 200);
  assert.equal((await call('POST', '/api/data/write', helper.token, mutation)).status, 200);
  const moves = await db.collection('movements').where('targetId', '==', advanceId).get();
  assert.equal(moves.size, 1);
  assert.equal(moves.docs[0].get('userId'), helper.user.uid);
  const auditId = randomUUID();
  await db.doc('movements/' + auditId).create({ module: 'Administración de Usuarios', userId: admin.user.uid, detail: 'Control sintético' });
  assert.equal((await call('GET', '/api/data/movements/' + auditId, helper.token)).status, 403);
  assert.equal((await call('GET', '/api/data/movements/' + moves.docs[0].id, helper.token)).status, 200);
  assert.equal((await call('GET', '/api/data/movements/' + auditId, admin.token)).status, 200);
  assert.equal((await db.doc('materials/' + materialId).get()).get('usedQty'), 3);
  const day = '2026-01-01';
  const workers = [randomUUID(), randomUUID(), randomUUID()];
  await Promise.all(workers.map((id, index) => db.doc('workers/' + id).create({
    id, name: 'Operario sintético', sectorId: index < 2 ? sectorId : randomUUID()
  })));
  await db.doc('attendance/' + day).set({ date: day, records: { [workers[2]]: 'Falta' } });
  const attendance = (id: string) => ({ writes: [{ collection: 'attendance', id: day, mode: 'merge', requestId: randomUUID(),
    data: { date: day, records: { [id]: 'Asistió' } } }] });
  const writes = await Promise.all(workers.slice(0, 2).map(id => call('POST', '/api/data/write', helper.token, attendance(id))));
  assert.deepEqual(writes.map(response => response.status), [200, 200]);
  assert.equal((await call('POST', '/api/data/write', helper.token, attendance(workers[2]))).data.code, 'ATTENDANCE_CONFLICT');
  const attendanceView = await call('GET', '/api/data/attendance/' + day, helper.token);
  assert.deepEqual(Object.keys(attendanceView.data.document.records).sort(), [...workers].sort());
  assert.equal((await db.doc('attendance/' + day).get()).get('records')[workers[2]], 'Falta');
  assert.equal((await call('POST', '/api/data/write', admin.token, operationalWrite('movements', moves.docs[0].id))).status, 403);
  assert.equal(await directFirestore(admin.token, 'movements/' + moves.docs[0].id, 'DELETE'), 403);
  const history = { entries: [{ sourceId: randomUUID(), timestamp: '2026-01-01T12:00:00Z', module: 'Control de Materiales',
    type: 'REGISTRO', detail: 'Registro de archivo sintético', userId: reader.user.uid }] };
  assert.equal((await call('POST', '/api/data/movements/import', admin.token, {
    entries: [{ ...history.entries[0], sourceId: moves.docs[0].id }]
  })).status, 409);
  assert.equal((await call('POST', '/api/data/movements/import', reader.token, history)).status, 403);
  assert.equal((await call('POST', '/api/data/movements/import', helper.token, history)).status, 403);
  assert.equal((await call('POST', '/api/data/movements/import', admin.token, history)).status, 200);
  assert.equal((await call('POST', '/api/data/movements/import', admin.token, history)).status, 200);
  const imported = await db.collection('movements').where('sourceId', '==', history.entries[0].sourceId).get();
  assert.equal(imported.size, 1);
  assert.equal(imported.docs[0].get('userId'), admin.user.uid);
  assert.equal(imported.docs[0].get('historicalImport'), true);
  history.entries[0].detail = 'Intento de reemplazar la historia';
  assert.equal((await call('POST', '/api/data/movements/import', admin.token, history)).status, 409);
});

test('Fase 1.5 una desactivación combinada rechaza una colisión hija y valida los reintentos legítimos', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const store = createFirestoreProfileStore(db);
  const call = await startAdminApi(t, createAuthService(realAuth!, store));
  const [admin, target, unrelated] = await Promise.all([seedOperationalUser(db, 'Administrador'),
    seedOperationalUser(db, 'Supervisor'), seedOperationalUser(db, 'Supervisor')]);
  const root = randomUUID();
  const derived = createHash('sha256').update(JSON.stringify(['calera-emergency', root, 'profile'])).digest('hex')
    .replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, '$1-$2-8$3-8$4-$5');
  assert.equal((await call('PATCH', 'users/' + unrelated.user.uid, admin.token, {
    expectedProfileVersion: 0, operationId: derived, displayName: 'Operación ajena'
  })).status, 200);
  const path = 'users/' + target.user.uid;
  const combined = { expectedProfileVersion: 0, operationId: root, active: false, email: randomUUID() + '@example.test' };
  for (const attempt of [combined, combined]) {
    const response = await call('PATCH', path, admin.token, attempt);
    assert.deepEqual([response.status, response.data.code], [409, 'OPERATION_ID_CONFLICT']);
  }
  assert.equal(await store.operation(root), null);
  assert.equal((await store.get(target.user.uid))?.active, true);
  assert.equal((await realAuth!.getUser(target.user.uid)).email, target.user.email);
  const valid = { ...combined, operationId: randomUUID() };
  const completed = await call('PATCH', path, admin.token, valid);
  assert.equal(completed.status, 200);
  assert.equal(completed.data.profileEdit.state, 'completed');
  const child = (await store.operation(completed.data.profileEdit.id))!;
  assert.equal(child.parentOperationId, valid.operationId);
  assert.equal(child.uid, target.user.uid);
  assert.equal(child.actor.uid, admin.user.uid);
  assert.equal(child.baseProfileVersion, completed.data.operation.version);
  assert.ok(child.fingerprint);
  assert.deepEqual((await call('PATCH', path, admin.token, valid)).data.profileEdit, completed.data.profileEdit);
  assert.equal((await call('PATCH', path, admin.token, {
    expectedProfileVersion: child.baseProfileVersion, operationId: child.id, email: valid.email
  })).status, 409);
  assert.equal((await db.collection('movements').where('targetId', '==', target.user.uid).get()).size, 2);
});

test('dos supervisores conservan cambios distintos tras rebasar la revisión y detectan una edición de la misma actividad', {
  skip: !firestoreHost || !authHost, timeout: 60_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const id = randomUUID(), barn = randomUUID();
  const activities = [{ id: 'a', code: 'A', name: 'Actividad A', startDate: '2026-11-01' },
    { id: 'b', code: 'B', name: 'Actividad B', startDate: '2026-11-01' }];
  await db.doc('sectors/' + id).create({ id, name: 'Sector de concurrencia', code: 'P-MULTI',
    galpones: [{ id: barn, areas: [{ id: 'area', name: 'Área', structures: [{ id: 'struct', name: 'Estructura', activities }] }] }] });
  const [one, two] = await Promise.all([
    seedOperationalUser(db, 'Supervisor'),
    seedOperationalUser(db, 'Supervisor')
  ]);
  const endpoint = '/api/data/sectors/' + id;
  const base = (await call('GET', endpoint, one.token)).data.document;
  const branch = (index: number, date: string) => {
    const result = structuredClone(base);
    result.galpones[0].areas[0].structures[0].activities[index].startDate = date;
    return result;
  };
  const a = branch(0, '2026-11-02'), b = branch(1, '2026-11-03');
  const replies = await Promise.all([
    call('POST', '/api/data/write', one.token, operationalWrite('sectors', id, a)),
    call('POST', '/api/data/write', two.token, operationalWrite('sectors', id, b))
  ]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
  const loser = replies[0].status === 409 ? one : two;
  const rejected = replies[0].status === 409 ? a : b;
  const latest = (await call('GET', endpoint, loser.token)).data.document;
  const merged = mergeSectorDeepWithConflicts(rejected, latest, { baseSector: base });
  assert.equal(merged.conflicts.length, 0);
  assert.equal((await call('POST', '/api/data/write', loser.token,
    operationalWrite('sectors', id, merged.mergedSector, randomUUID(), latest._revision))).status, 200);
  const final = (await call('GET', endpoint, one.token)).data.document;
  assert.deepEqual(final.galpones[0].areas[0].structures[0].activities.map((item: { startDate: string }) => item.startDate),
    ['2026-11-02', '2026-11-03']);
  assert.equal(mergeSectorDeepWithConflicts(branch(0, '2026-11-04'), final, { baseSector: base }).conflicts.length, 1);
  const attemptedRename = structuredClone(final);
  attemptedRename.galpones[0].areas[0].structures[0].activities[0].name = 'Nombre de actividad no autorizado desde Gantt';
  assert.equal((await call('POST', '/api/data/write', two.token,
    operationalWrite('sectors', id, attemptedRename, randomUUID(), final._revision))).status, 403);
});

test('stock compartido, versión de inventario y baja de avance no duplican ni pierden consumo', {
  skip: !firestoreHost || !authHost, timeout: 60_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const call = await startAdminApi(t, createAuthService(realAuth!, createFirestoreProfileStore(db)), db);
  const [admin, helper, warehouse] = await Promise.all([seedOperationalUser(db, 'Administrador'),
    seedOperationalUser(db, 'Auxiliar'), seedOperationalUser(db, 'Almacén')]);
  const sector = randomUUID(), barns = [randomUUID(), randomUUID()], materials = [randomUUID(), randomUUID()];
  await db.doc('sectors/' + sector).create({ id: sector, name: 'Stock sintético', galpones: barns.map(id => ({
    id, areas: [{ structures: [{ activities: [{ id: 'act', code: 'ACT', progressMode: 'percentage' }] }] }]
  })) });
  const stock = (index: number, totalQty: number) => ({ name: 'Perno', unit: 'u', sectorId: sector, galponId: barns[index],
    totalQty, initialUsedQty: 1, usedQty: 1 });
  await Promise.all(materials.map((id, index) => db.doc('materials/' + id).create({ id, ...stock(index, 20) })));
  const race = await Promise.all([
    call('POST', '/api/data/write', admin.token, operationalWrite('materials', materials[0], stock(0, 30))),
    call('POST', '/api/data/write', warehouse.token, operationalWrite('materials', materials[0], stock(0, 25)))
  ]);
  assert.deepEqual(race.map(reply => reply.status).sort(), [200, 409]);
  const ids = [randomUUID(), randomUUID()];
  const shared = { writes: ids.map((id, index) => ({ collection: 'advances', id, requestId: randomUUID(), mode: 'set',
    data: { sectorId: sector, galponId: barns[index], activityCode: 'ACT', date: '2026-11-05', quantityToday: 60,
      isSecondarySharedCopy: index === 1, materialsUsedToday: [{ materialId: materials[index], qty: index + 2 }] } })) };
  const rejected = structuredClone(shared);
  rejected.writes[1].data.materialsUsedToday[0].qty = 50;
  assert.equal((await call('POST', '/api/data/write', helper.token, rejected)).data.code, 'STOCK_INSUFFICIENT');
  assert.deepEqual(await Promise.all(ids.map(async id => (await db.doc('advances/' + id).get()).exists)), [false, false]);
  assert.equal((await call('POST', '/api/data/write', helper.token, shared)).status, 200);
  assert.equal((await call('POST', '/api/data/write', helper.token, shared)).status, 200);
  const used = async () => Promise.all(materials.map(async id => (await db.doc('materials/' + id).get()).get('usedQty')));
  assert.deepEqual(await used(), [3, 4]);
  const down = operationalWrite('advances', randomUUID(), { ...shared.writes[0].data, quantityToday: 40 });
  assert.equal((await call('POST', '/api/data/write', helper.token, down)).data.code, 'ADVANCE_CONFLICT');
  assert.equal((await call('POST', '/api/data/write', helper.token,
    operationalWrite('advances', ids[1], undefined, randomUUID(), 1))).status, 200);
  assert.deepEqual(await used(), [3, 1]);
  const recreate = operationalWrite('advances', ids[1], shared.writes[1].data);
  assert.equal((await call('POST', '/api/data/write', helper.token, recreate)).data.code, 'DATA_DELETED');
  assert.deepEqual(await used(), [3, 1]);
});

test('Auth Emulator guarda la marca junto al correo y la contraseña en el UID original', {
  skip: !authHost, timeout: 30_000
}, async () => {
  const identity = realAuth!;
  const uid = 'credential-' + randomUUID();
  const initialEmail = uid + '@example.test';
  const account = await identity.createUser({ uid, email: initialEmail, password: 'emulator-initial-fixture' });
  const email = uid + '-changed@example.test';
  const first = randomUUID();
  await identity.updateCredential(account, { email, emailVerified: false }, first);
  const changed = await identity.getUser(uid);
  assert.equal(changed.email, email);
  assert.equal(changed.customClaims?.[CREDENTIAL_OPERATION_CLAIM], first);
  const second = randomUUID();
  const password = 'emulator-new-fixture';
  await identity.updateCredential(changed, { password }, second);
  const withPassword = await identity.getUser(uid);
  assert.equal(withPassword.customClaims?.[CREDENTIAL_OPERATION_CLAIM], second);
  assert.equal((await identity.verifyIdToken(await signInWithPassword(email, password), true)).uid, uid);
  const occupied = 'occupied-' + randomUUID() + '@example.test';
  await identity.createUser({ uid: 'collision-' + randomUUID(), email: occupied, password });
  await assert.rejects(identity.updateCredential(withPassword, { email: occupied }, randomUUID()), { code: 'EMAIL_EXISTS' });
  const unchanged = await identity.getUser(uid);
  assert.equal(unchanged.email, email);
  assert.equal(unchanged.customClaims?.[CREDENTIAL_OPERATION_CLAIM], second);
});

test('Auth Emulator acepta returnSecureToken true y false en accounts:update administrativo', {
  skip: !authHost, timeout: 30_000
}, async () => {
  const identity = realAuth!;
  const uid = 'return-token-' + randomUUID();
  await identity.createUser({ uid, email: uid + '@example.test', password: 'emulator-initial-fixture' });
  const url = 'http://' + authHost + '/identitytoolkit.googleapis.com/v1/projects/' + project + '/accounts:update';
  for (const returnSecureToken of [false, true]) {
    const email = uid + '-' + returnSecureToken + '@example.test';
    const operationId = randomUUID();
    const response = await fetch(url, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localId: uid, email, emailVerified: false, returnSecureToken,
        customAttributes: JSON.stringify({ [CREDENTIAL_OPERATION_CLAIM]: operationId })
      })
    });
    assert.equal(response.status, 200);
    const { localId, idToken, refreshToken } = await response.json();
    assert.equal(localId, uid);
    assert.equal(idToken, undefined);
    assert.equal(refreshToken, undefined);
    const account = await identity.getUser(uid);
    assert.equal(account.email, email);
    assert.equal(account.customClaims?.[CREDENTIAL_OPERATION_CLAIM], operationId);
  }
});

test('los emuladores recuperan un alta interrumpida y una bitácora fallida después de aplicar la clave', {
  skip: !firestoreHost || !authHost, timeout: 45_000
}, async t => {
  const db = createNamedFirestore(project, database);
  t.after(() => db.terminate());
  const identity = realAuth!;
  const administrator = profile('recovery-' + randomUUID());
  const password = 'Fixture#9-emulator-provision-fixture';
  await identity.createUser({ uid: administrator.uid, email: administrator.email, password });
  await db.doc('users/' + administrator.uid).set(administrator);
  const authorization = 'Bearer ' + await signInWithPassword(administrator.email, password);
  const store = createFirestoreProfileStore(db);
  let createdUid = '';
  let attempts = 0;
  let breakResponse = false;
  const interrupted = createAuthService({
    ...identity,
    async getUser(uid) {
      if (breakResponse && uid === createdUid) throw new Error('Lectura no disponible tras el alta');
      return identity.getUser(uid);
    },
    async createUser(input) {
      attempts++;
      createdUid = input.uid;
      await identity.createUser(input);
      breakResponse = true;
      throw new Error('Respuesta perdida');
    }
  }, store);
  const email = 'recovery-' + randomUUID() + '@example.test';
  await assert.rejects(interrupted.createUser(authorization, { email, password, displayName: 'Alta sintética', role: 'Supervisor' }),
    { status: 503, code: 'PROVISIONING_UNCERTAIN' });
  const restarted = createAuthService(identity, createFirestoreProfileStore(db));
  assert.ok((await restarted.listReservations(authorization)).some(item => item.uid === createdUid && item.state === 'uncertain'));
  const resumed = await restarted.manageReservation(authorization, createdUid, { action: 'resume' });
  assert.equal('user' in resumed && resumed.user.uid, createdUid);
  const replayed = await restarted.manageReservation(authorization, createdUid, { action: 'resume' });
  assert.equal('user' in replayed && replayed.user.uid, createdUid);
  assert.equal(attempts, 1);
  assert.equal((await identity.getUserByEmail(email)).uid, createdUid);

  const operationId = randomUUID();
  const conflictingMovement = db.doc('movements/auth-' + operationId);
  await conflictingMovement.create({ fixture: true });
  const newPassword = 'Fixture#9-emulator-audit-fixture';
  const change = await restarted.setTemporaryPassword(authorization, createdUid, { operationId, tempPassword: newPassword });
  assert.equal(change.operation.state, 'completed');
  assert.equal(change.operation.audit, 'pending');
  assert.equal((await identity.verifyIdToken(await signInWithPassword(email, newPassword), true)).uid, createdUid);
  assert.doesNotMatch(JSON.stringify(await store.operation(operationId)), /emulator-audit-fixture/);
  await conflictingMovement.delete();
  assert.equal((await restarted.reconcileOperation(authorization, operationId)).operation.audit, 'recorded');
  assert.equal((await conflictingMovement.get()).get('targetId'), createdUid);
});
