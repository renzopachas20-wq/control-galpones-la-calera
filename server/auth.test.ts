import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { CREDENTIAL_OPERATION_CLAIM, createAuthService, MutationRejected, MutationUncertain, PRIMARY_ADMIN_UID } from './auth.ts';
import type { CredentialOperation, IdentityProvider, Profile, ProfileStore, ProfileTransaction } from './auth.ts';
import { preferCurrentProfile } from '../src/firebase/profileVersion.ts';
import { classifyIdentityFailure } from './firebaseAdmin.ts';

const adminToken = 'Bearer admin';
const time = '2026-01-01T00:00:00.000Z';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

function profile(uid: string, fields: Partial<Profile> = {}): Profile {
  return {
    uid, email: `${uid}@example.test`, displayName: 'Usuario de prueba',
    active: true, role: 'Supervisor', authMethod: 'password',
    createdAt: time, updatedAt: time,
    createdBy: 'admin', updatedBy: 'admin', ...fields
  };
}

function legacyInvitation(email: string, fields: Partial<Profile> & Record<string, unknown> = {}) {
  const id = 'preauth_' + createHash('sha1').update(email).digest('hex').slice(0, 24);
  return profile(id, { email, authMethod: 'google', ...fields });
}

type Account = Awaited<ReturnType<IdentityProvider['getUser']>>;
type Token = Awaited<ReturnType<IdentityProvider['verifyIdToken']>>;

function fixture(...initial: Profile[]) {
  let records = new Map(initial.map(value => [value.uid, value]));
  let owners = new Map<string, string | null>();
  let operations = new Map<string, CredentialOperation>();
  let transactionTail = Promise.resolve();
  const accounts = new Map<string, Account>();
  const tokens = new Map<string, Token>();
  const tokenErrors = new Map<string, string>();
  const audits: string[] = [];
  const faults = { audit: false, confirmation: false, list: false };
  const authUpdates: { uid: string; fields: Parameters<IdentityProvider['updateCredential']>[1] }[] = [];
  const notFound = () => Object.assign(new Error('account missing'), { code: 'auth/user-not-found' });

  const get = (uid: string) => Promise.resolve(structuredClone(records.get(uid) ?? null));
  const all = () => [...records].map(([id, value]) => ({ id, profile: structuredClone(value) }));
  const list = async () => {
    if (faults.list) throw new Error('La búsqueda no debe recorrer usuarios');
    return all();
  };
  const emailOwner = async email => owners.get(email) ?? null;
  const operation = async id => structuredClone(operations.get(id) ?? null);
  const profiles: ProfileStore = {
    get, list, emailOwner, operation,
    outstandingOperations: async uid => [...operations.values()].filter(op => op.uid === uid && op.audit === 'pending'),
    transaction(work) {
      const running = transactionTail.then(async () => {
        const updated = new Map(records);
        const nextOwners = new Map(owners);
        const nextOperations = new Map(operations);
        const changes: string[] = [];
        const tx: ProfileTransaction = {
          get, list, emailOwner, operation,
          create(value) {
            assert.equal(updated.has(value.uid), false, 'create must not overwrite');
            updated.set(value.uid, structuredClone(value));
          },
          update(uid, patch) {
            assert.ok(updated.has(uid), 'update must have a profile');
            updated.set(uid, { ...updated.get(uid)!, ...structuredClone(patch) });
          },
          setEmailOwner(email, uid) { nextOwners.set(email, uid); },
          createOperation(value) {
            assert.equal(nextOperations.has(value.id), false);
            nextOperations.set(value.id, structuredClone(value));
          },
          updateOperation(id, patch) {
            if (faults.confirmation && patch.state === 'completed') throw new Error('Caída al confirmar Firestore');
            nextOperations.set(id, { ...nextOperations.get(id)!, ...structuredClone(patch) });
          },
          audit(actor, target) {
            if (faults.audit) throw new Error('Bitácora no disponible');
            changes.push(`${actor.uid}:${target.uid}`);
          }
        };
        const result = await work(tx);
        records = updated;
        owners = nextOwners;
        operations = nextOperations;
        audits.push(...changes);
        return result;
      });
      transactionTail = running.then(() => {}, () => {});
      return running;
    }
  };
  const identity: IdentityProvider = {
    async verifyIdToken(value) {
      const token = tokens.get(value);
      if (!token) throw Object.assign(new Error('token rejected'), { code: tokenErrors.get(value) || 'auth/argument-error' });
      return token;
    },
    async getUser(uid) {
      const account = accounts.get(uid);
      if (!account) throw notFound();
      return account;
    },
    async getUserByEmail(email) {
      const account = [...accounts.values()].find(account => account.email?.toLowerCase() === email);
      if (!account) throw notFound();
      return account;
    },
    async createUser({ uid, email }) {
      assert.ok(uid && email);
      assert.equal(accounts.has(uid), false);
      const account = { uid, email, emailVerified: false, disabled: false, providerData: [{ providerId: 'password' }] };
      accounts.set(uid, account);
      return account;
    },
    async updateCredential(account, fields, id) {
      authUpdates.push({ uid: account.uid, fields });
      const latest = await identity.getUser(account.uid);
      const { validSince, password, disableUser, ...changes } = fields;
      accounts.set(account.uid, {
        ...latest, ...changes, customClaims: { ...latest.customClaims, [CREDENTIAL_OPERATION_CLAIM]: id },
        ...(disableUser !== undefined ? { disabled: disableUser } : {}),
        ...(validSince ? { tokensValidAfterTime: new Date(Number(validSince) * 1000).toISOString() } : {})
      });
    },
    async containAccount(uid, validSince) {
      const latest = await identity.getUser(uid);
      authUpdates.push({ uid, fields: { disableUser: true, validSince } });
      accounts.set(uid, { ...latest, disabled: true, tokensValidAfterTime: new Date(Number(validSince) * 1000).toISOString() });
    }
  };
  const service = createAuthService(identity, profiles);

  function signIn(token: string, uid: string, email: string, verified = false, provider = 'password',
    auth_time = Math.floor(Date.now() / 1000) + 5) {
    tokens.set(token, { uid, email, auth_time, email_verified: verified, firebase: { sign_in_provider: provider } });
    return `Bearer ${token}`;
  }
  signIn('admin', 'admin', 'admin@example.test');
  return { service, profiles, identity, accounts, signIn, tokenErrors, audits, authUpdates, faults };
}

function error(status: number, code: string) {
  return { status, code };
}

test('un correo sin verificar no hereda el perfil administrador ni consume la invitación', async () => {
  const email = 'invited@example.test';
  const invitation = legacyInvitation(email, { role: 'Administrador' });
  const f = fixture(profile('admin', { role: 'Administrador' }), invitation);
  await f.service.updateUser(adminToken, invitation.uid, { expectedProfileVersion: 0 });
  const pending = await f.profiles.get(invitation.uid);
  const token = f.signIn('unverified', 'unknown', email, false, 'google.com');
  await assert.rejects(f.service.verifySession(token), error(403, 'PROFILE_NOT_FOUND'));
  assert.deepEqual(await f.profiles.get(invitation.uid), pending);
  assert.equal(await f.profiles.get('unknown'), null);
});

test('un UID diferente no hereda un perfil establecido aunque coincida el correo verificado', async () => {
  const existing = profile('existing', { role: 'Administrador', email: 'Owner@example.test' });
  const f = fixture(existing);
  const token = f.signIn('other', 'other', 'owner@example.test', true, 'google.com');
  f.accounts.set('other', { uid: 'other', email: 'owner@example.test', emailVerified: true, disabled: false });
  await assert.rejects(f.service.verifySession(token), error(403, 'PROFILE_NOT_FOUND'));
  assert.deepEqual(await f.profiles.get(existing.uid), existing);
});

test('una invitación legítima se consume una sola vez, conserva el original y permite reintentos', async () => {
  const email = 'invited@example.test';
  const invitation = legacyInvitation(email, { assignedGalponIds: ['g1'] });
  const f = fixture(profile('admin', { role: 'Administrador' }), invitation);
  await f.service.updateUser(adminToken, invitation.uid, { expectedProfileVersion: 0 });
  const token = f.signIn('google', 'verified-user', email, true, 'google.com');
  f.accounts.set('verified-user', { uid: 'verified-user', email, emailVerified: true, disabled: false });
  const results = await Promise.all([f.service.verifySession(token), f.service.verifySession(token)]);
  assert.deepEqual(results.map(value => value.uid), ['verified-user', 'verified-user']);
  assert.equal('assignedGalponIds' in results[0], false);
  assert.equal((await f.profiles.get(invitation.uid))?.linkedUid, 'verified-user');
  assert.equal((await f.profiles.get(invitation.uid))?.uid, invitation.uid);
  assert.equal((await f.profiles.list()).length, 3);
});

test('un administrador activo puede crear una invitación Google sin crear una cuenta Firebase', async () => {
  const f = fixture(profile('admin', { role: 'Administrador' }));
  const invitation = await f.service.createUser(adminToken, {
    email: ' Invite@example.test ', displayName: 'Invitada', authMethod: 'google', role: 'Supervisor'
  });
  assert.match(invitation.uid, /^preauth_/);
  assert.equal(f.accounts.size, 0);
  const token = f.signIn('google', 'verified-user', 'invite@example.test', true, 'google.com');
  f.accounts.set('verified-user', { uid: 'verified-user', email: 'invite@example.test', emailVerified: true, disabled: false });
  assert.equal((await f.service.verifySession(token)).uid, 'verified-user');
  assert.deepEqual((await f.service.listUsers(adminToken)).map(p => p.uid).sort(), ['admin', 'verified-user']);
});

test('la vinculación rechaza un token cuyo correo corresponde en Firebase a otro UID', async () => {
  const email = 'invited@example.test';
  const invitation = legacyInvitation(email);
  const f = fixture(invitation);
  f.accounts.set('owner', { uid: 'owner', email, emailVerified: true, disabled: false });
  const token = f.signIn('other-token', 'other-uid', email, true, 'google.com');
  await assert.rejects(f.service.verifySession(token), error(403, 'IDENTITY_MISMATCH'));
  assert.deepEqual(await f.profiles.get(invitation.uid), invitation);
});

test('la vinculación rechaza un proveedor no autorizado y un correo con dos perfiles', async () => {
  const email = 'invited@example.test';
  const invitation = legacyInvitation(email);
  for (const duplicated of [false, true]) {
    const f = fixture(profile('admin', { role: 'Administrador' }), invitation,
      ...(duplicated ? [profile('existing', { email: 'Invited@example.test' })] : []));
    if (duplicated) {
      await assert.rejects(f.service.updateUser(adminToken, invitation.uid, { expectedProfileVersion: 0 }), error(409, 'DUPLICATE_EMAIL'));
    } else {
      await f.service.updateUser(adminToken, invitation.uid, { expectedProfileVersion: 0 });
    }
    const pending = await f.profiles.get(invitation.uid);
    const token = f.signIn('token', 'owner', email, true, duplicated ? 'google.com' : 'password');
    f.accounts.set('owner', { uid: 'owner', email, emailVerified: true, disabled: false });
    await assert.rejects(f.service.verifySession(token), error(403, 'PROFILE_NOT_FOUND'));
    assert.deepEqual(await f.profiles.get(invitation.uid), pending);
  }
});

test('se rechaza un perfil cuyo UID interno no coincide con el documento', async () => {
  const f = fixture(profile('admin', { role: 'Administrador' }));
  await f.profiles.transaction(async tx => { tx.update('admin', { uid: 'otro-uid' }); });
  await assert.rejects(f.service.verifySession(adminToken), error(403, 'PROFILE_UID_MISMATCH'));
  await assert.rejects(f.service.listUsers(adminToken), error(403, 'PROFILE_UID_MISMATCH'));
});

test('un administrador desactivado, incluido el principal, pierde acceso aunque su token sea válido', async () => {
  const f = fixture(profile('admin', { role: 'Administrador', active: false }),
    profile(PRIMARY_ADMIN_UID, { role: 'Administrador', active: false }));
  const primaryToken = f.signIn('primary', PRIMARY_ADMIN_UID, 'principal@example.test');
  for (const token of [adminToken, primaryToken]) {
    await assert.rejects(f.service.verifySession(token), error(403, 'USER_INACTIVE'));
    await assert.rejects(f.service.listUsers(token), error(403, 'USER_INACTIVE'));
  }
});

test('se rechazan tokens ausentes, inválidos, vencidos, revocados y de cuentas deshabilitadas', async () => {
  const f = fixture();
  await assert.rejects(f.service.verifySession(), error(401, 'MISSING_TOKEN'));
  for (const code of ['auth/argument-error', 'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled']) {
    f.tokenErrors.set('invalid', code);
    const expected = code === 'auth/id-token-revoked' ? 'TOKEN_REVOKED' : 'INVALID_TOKEN';
    await assert.rejects(f.service.verifySession('Bearer invalid'), error(401, expected));
    await assert.rejects(f.service.listUsers('Bearer invalid'), error(401, expected));
  }
});

test('un perfil inexistente o un usuario activo sin rol administrativo no accede a administración', async () => {
  const f = fixture(profile('reader', { role: 'Solo lectura' }));
  const reader = f.signIn('reader', 'reader', 'reader@example.test');
  await assert.rejects(f.service.verifySession(adminToken), error(403, 'PROFILE_NOT_FOUND'));
  await assert.rejects(f.service.listUsers(adminToken), error(403, 'PROFILE_NOT_FOUND'));
  assert.equal((await f.service.verifySession(reader)).role, 'Solo lectura');
  await assert.rejects(f.service.listUsers(reader), error(403, 'FORBIDDEN_ROLE'));
  await assert.rejects(f.service.setTemporaryPassword(reader, 'admin', {}), error(403, 'FORBIDDEN_ROLE'));
});

test('un administrador activo conserva sesión por UID y puede gestionar cuentas de contraseña', async () => {
  const f = fixture(profile('admin', { role: 'Administrador' }));
  assert.equal((await f.service.verifySession(adminToken)).uid, 'admin');
  const user = await f.service.createUser(adminToken, {
    email: ' worker@example.test ', displayName: 'Trabajadora', password: 'Fixture#9-creation-password', role: 'Auxiliar'
  });
  assert.equal((await f.identity.getUser(user.uid)).email, user.email);
  assert.equal((await f.profiles.get(user.uid))?.provisioning, false);
  assert.equal('password' in (await f.profiles.get(user.uid))!, false);
  const change = await f.service.updateUser(adminToken, user.uid, {
    uid: 'ignored', email: 'new@example.test', expectedProfileVersion: 0, operationId: randomUUID()
  });
  assert.equal(change.user.uid, user.uid);
  assert.deepEqual(f.authUpdates[0], { uid: user.uid, fields: { email: 'new@example.test', emailVerified: false } });
  const temporary = await f.service.setTemporaryPassword(adminToken, user.uid, {});
  assert.equal(temporary.mode, 'direct_update');
  assert.ok(temporary.tempPassword.length >= 16);
  await assert.rejects(f.service.resetPassword(adminToken, user.uid), error(410, 'ADMIN_RESET_DISABLED'));
  assert.equal((await f.service.listUsers(adminToken)).length, 2);
});

test('el alta por contraseña no adopta cuentas Firebase preexistentes ni duplica correos', async () => {
  const f = fixture(profile('admin', { role: 'Administrador' }), profile('existing', { email: 'Used@example.test' }));
  const input = { email: 'used@example.test', displayName: 'Otra persona', password: 'Fixture#9-creation-password', role: 'Auxiliar' };
  await assert.rejects(f.service.createUser(adminToken, input), error(409, 'DUPLICATE_EMAIL'));
  f.accounts.set('stranger', { uid: 'stranger', email: 'other@example.test', emailVerified: true, disabled: false });
  await assert.rejects(f.service.createUser(adminToken, { ...input, email: 'other@example.test' }), error(409, 'AUTH_EMAIL_EXISTS'));
  assert.equal((await f.profiles.list()).length, 2);
});

test('un alta interrumpida se reintenta con el UID reservado y la cuenta permanece bloqueada hasta finalizar', async () => {
  const f = fixture(profile('admin', { role: 'Administrador' }));
  const create = f.identity.createUser;
  const lookup = f.identity.getUser;
  f.identity.createUser = async input => {
    await create(input);
    f.identity.getUser = async () => { throw new Error('Auth no disponible durante la caída'); };
    throw new Error('se perdió la respuesta de Auth');
  };
  const input = { email: 'retry@example.test', displayName: 'Reintento', password: 'Fixture#9-creation-password', role: 'Auxiliar' };
  await assert.rejects(f.service.createUser(adminToken, input), error(503, 'PROVISIONING_UNCERTAIN'));
  f.identity.getUser = lookup;
  const reserved = (await f.profiles.list()).find(({ profile }) => profile.email === input.email)!;
  assert.equal(reserved.profile.active, false);
  const token = f.signIn('new', reserved.id, input.email);
  await assert.rejects(f.service.verifySession(token), error(403, 'PROFILE_UID_MISMATCH'));
  assert.equal((await f.service.createUser(adminToken, input)).uid, reserved.id);
  assert.equal((await f.service.verifySession(token)).uid, reserved.id);
  assert.equal(f.accounts.size, 1);
});

test('el cambio de correo se puede completar tras perder la respuesta de Auth', async () => {
  const existing = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), existing);
  f.accounts.set('worker', { uid: 'worker', email: existing.email, emailVerified: true, disabled: false });
  const update = f.identity.updateCredential;
  f.identity.updateCredential = async (account, fields, id) => {
    await update(account, fields, id);
    throw new Error('se perdió la respuesta de Auth');
  };
  const email = 'new@example.test';
  const operationId = randomUUID();
  f.faults.confirmation = true;
  const pending = await f.service.updateUser(adminToken, 'worker', { email, operationId, expectedProfileVersion: 0 });
  assert.equal(pending.operation?.state, 'pending');
  assert.equal((await f.profiles.get('worker'))?.pendingEmail, email);
  f.faults.confirmation = false;
  const completed = await createAuthService(f.identity, f.profiles).reconcileOperation(adminToken, operationId);
  assert.equal(completed.user.uid, 'worker');
  assert.equal(completed.user.email, email);
  assert.equal(f.authUpdates.length, 1);
  assert.equal((await f.profiles.get('worker'))?.pendingEmail, null);
});

test('otro administrador no cambia credenciales, degrada ni desactiva al administrador principal', async () => {
  const f = fixture(profile('admin', { role: 'Administrador' }), profile(PRIMARY_ADMIN_UID, { role: 'Administrador' }));
  for (const fields of [{ active: false }, { role: 'Solo lectura' }, { email: 'new@example.test' }]) {
    await assert.rejects(f.service.updateUser(adminToken, PRIMARY_ADMIN_UID, { ...fields, expectedProfileVersion: 0 }),
      error(403, 'PROTECTED_ADMIN'));
  }
  await assert.rejects(f.service.setTemporaryPassword(adminToken, PRIMARY_ADMIN_UID, {}), error(403, 'PROTECTED_ADMIN'));
  assert.deepEqual(f.authUpdates, []);
});

test('los duplicados heredados no impiden desactivar un perfil', async () => {
  const f = fixture(profile('admin', { role: 'Administrador' }),
    profile('worker', { email: 'duplicated@example.test' }),
    profile('another', { email: 'Duplicated@example.test' }));
  const change = await f.service.updateUser(adminToken, 'worker', { active: false, expectedProfileVersion: 0, operationId: randomUUID() });
  assert.equal(change.user.active, false);
  assert.equal(change.operation?.profileApplied, true);
  assert.equal((await f.profiles.get('another'))?.active, true);
});

test('un cambio de correo pendiente conserva la desactivación efectuada durante el cambio', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  let signalStarted!: () => void;
  let allowUpdate!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const finish = new Promise<void>(resolve => { allowUpdate = resolve; });
  const update = f.identity.updateCredential;
  f.identity.updateCredential = async (account, fields, id) => {
    signalStarted();
    await finish;
    return update(account, fields, id);
  };
  const email = 'new@example.test';
  const pending = f.service.updateUser(adminToken, worker.uid, { email, expectedProfileVersion: 0, operationId: randomUUID() });
  await started;
  const deactivation = { active: false, expectedProfileVersion: 0, operationId: randomUUID() };
  const inactive = await f.service.updateUser(adminToken, worker.uid, deactivation);
  assert.equal(inactive.user.active, false);
  assert.equal(inactive.operation?.authentication, 'applied');
  assert.equal(inactive.operation?.profileApplied, true);
  assert.equal(f.authUpdates.length, 1);
  await assert.rejects(f.service.updateUser(adminToken, worker.uid, {
    active: true, expectedProfileVersion: 1, operationId: randomUUID()
  }), error(409, 'CREDENTIAL_OPERATION_PENDING'));
  allowUpdate();
  const result = await pending;
  assert.equal(result.user.email, email);
  assert.equal(result.user.active, false);
  assert.equal(result.user.profileVersion, 2);
  assert.equal((await f.profiles.get(worker.uid))?.pendingEmail, null);
  const revoked = await f.service.reconcileOperation(adminToken, deactivation.operationId);
  assert.equal(revoked.operation.authentication, 'applied');
  assert.equal(revoked.user.active, false);
  assert.equal(revoked.user.profileVersion, 2);
  assert.equal(f.authUpdates.length, 2);
});

test('la recuperación no usa un correo desfasado ni modifica una cuenta con otro UID', async () => {
  const f = fixture(profile('admin', { role: 'Administrador' }), profile('worker'));
  f.accounts.set('worker', { uid: 'other', email: 'worker@example.test', emailVerified: true, disabled: false });
  await assert.rejects(f.service.setTemporaryPassword(adminToken, 'worker', {}), error(409, 'AUTH_IDENTITY_CONFLICT'));
  f.accounts.set('worker', { uid: 'worker', email: 'different@example.test', emailVerified: true, disabled: false });
  await assert.rejects(f.service.resetPassword(adminToken, 'worker'), error(410, 'ADMIN_RESET_DISABLED'));
  assert.deepEqual(f.authUpdates, []);
});

test('beta y gamma entre instancias conservan gamma aunque beta responda tarde y se reintente', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  const second = createAuthService(f.identity, f.profiles);
  const entered = barrier();
  const applyBeta = barrier();
  const betaApplied = barrier();
  const respondBeta = barrier();
  const transport = f.identity.updateCredential;
  const beta = { email: 'beta@example.test', operationId: randomUUID(), expectedProfileVersion: 0 };
  const gamma = { email: 'gamma@example.test', operationId: randomUUID() };
  f.identity.updateCredential = async (account, fields, id) => {
    if (id !== beta.operationId) return transport(account, fields, id);
    entered.resolve();
    await applyBeta.promise;
    await transport(account, fields, id);
    betaApplied.resolve();
    await respondBeta.promise;
  };
  const late = f.service.updateUser(adminToken, worker.uid, beta);
  await entered.promise;
  await assert.rejects(second.updateUser(adminToken, worker.uid, { ...gamma, expectedProfileVersion: 0 }),
    error(409, 'CREDENTIAL_OPERATION_PENDING'));
  assert.equal((await second.updateUser(adminToken, worker.uid, beta)).operation?.state, 'pending');
  applyBeta.resolve();
  await betaApplied.promise;
  const confirmedBeta = await second.updateUser(adminToken, worker.uid, beta);
  assert.equal(confirmedBeta.operation?.version, 1);
  assert.equal(confirmedBeta.operation?.state, 'completed');
  const confirmedGamma = await second.updateUser(adminToken, worker.uid, { ...gamma, expectedProfileVersion: 1 });
  assert.equal(confirmedGamma.operation?.version, 2);
  assert.equal(confirmedGamma.user.email, gamma.email);
  assert.equal(confirmedGamma.user.profileVersion, 2);
  respondBeta.resolve();
  const lateBeta = await late;
  assert.equal(lateBeta.operation?.state, 'completed');
  assert.equal(lateBeta.user.email, gamma.email);
  assert.equal(lateBeta.user.profileVersion, 2);
  const retriedBeta = await second.updateUser(adminToken, worker.uid, beta);
  assert.equal(retriedBeta.operation?.version, 1);
  assert.equal(retriedBeta.user.profileVersion, 2);
  assert.equal((await f.profiles.get(worker.uid))?.email, gamma.email);
  assert.equal((await f.identity.getUser(worker.uid)).email, gamma.email);
  assert.equal(f.authUpdates.length, 2);
});

test('H1-A el UUID liga todo el formulario y su autor en ready, dispatching, uncertain y completed', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), profile('second', { role: 'Administrador' }),
    worker, profile('different-target'));
  const second = f.signIn('second', 'second', 'second@example.test');
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  const request = {
    email: 'new@example.test', expectedProfileVersion: 0, operationId: randomUUID(),
    displayName: 'Nombre original', role: 'Supervisor', active: true, authMethod: 'password', dni: '123',
    assignedProject: 'A', assignedSectorIds: ['a'], assignedGalponIds: ['b']
  };
  async function rejectChanges(state: CredentialOperation['authentication']) {
    const before = await f.profiles.operation(request.operationId);
    assert.equal(before?.authentication, state);
    const profileBefore = await f.profiles.get(worker.uid);
    const writes = f.authUpdates.length;
    const audits = f.audits.length;
    for (const delta of [
      { email: 'other@example.test' }, { displayName: 'Otro nombre' }, { role: 'Solo lectura' },
      { expectedProfileVersion: 1 }, { active: false }, { authMethod: 'both' }, { dni: '234' },
      { assignedProject: 'B' }, { assignedSectorIds: ['c'] }, { assignedGalponIds: ['d'] }
    ]) {
      await assert.rejects(f.service.updateUser(adminToken, worker.uid, { ...request, ...delta }),
        error(409, 'OPERATION_ID_CONFLICT'));
    }
    await assert.rejects(f.service.updateUser(second, worker.uid, request), error(409, 'OPERATION_ID_CONFLICT'));
    await assert.rejects(f.service.updateUser(adminToken, 'different-target', request), error(409, 'OPERATION_ID_CONFLICT'));
    assert.deepEqual(await f.profiles.operation(request.operationId), before);
    assert.deepEqual(await f.profiles.get(worker.uid), profileBefore);
    assert.equal(await f.profiles.emailOwner('other@example.test'), null);
    assert.equal(f.authUpdates.length, writes);
    assert.equal(f.audits.length, audits);
  }
  const get = f.identity.getUser;
  f.identity.getUser = async () => { throw Error('Auth no disponible antes del envío'); };
  assert.equal((await f.service.updateUser(adminToken, worker.uid, request)).operation?.authentication, 'ready');
  await rejectChanges('ready');
  f.identity.getUser = get;
  const entered = barrier(), send = barrier();
  const update = f.identity.updateCredential;
  f.identity.updateCredential = async (...args) => {
    entered.resolve();
    await send.promise;
    await update(...args);
    throw Error('Respuesta de Auth perdida');
  };
  f.faults.confirmation = true;
  const resume = f.service.updateUser(adminToken, worker.uid, request);
  try {
    await Promise.race([entered.promise, resume.then(() => { throw Error('El envío no quedó retenido'); })]);
    await rejectChanges('dispatching');
  } finally { send.resolve(); }
  assert.equal((await resume).operation?.authentication, 'uncertain');
  await rejectChanges('uncertain');
  f.faults.confirmation = false;
  assert.equal((await f.service.updateUser(adminToken, worker.uid, request)).operation?.state, 'completed');
  await rejectChanges('applied');
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  assert.equal((await f.service.updateUser(adminToken, worker.uid, reordered)).operation?.state, 'completed');
  assert.equal(f.authUpdates.length, 1);
  assert.deepEqual(f.audits, ['admin:worker']);
});

test('H1-B la respuesta tardía sin lectura vigente conserva completed y solicita recargar el perfil', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), profile('second', { role: 'Administrador' }), worker);
  const second = f.signIn('second', 'second', 'second@example.test');
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  const beta = { email: 'beta@example.test', operationId: randomUUID(), expectedProfileVersion: 0 };
  const gamma = { email: 'gamma@example.test', operationId: randomUUID(), expectedProfileVersion: 1 };
  const sent = barrier(), reply = barrier();
  const update = f.identity.updateCredential;
  f.identity.updateCredential = async (...args) => {
    await update(...args);
    if (args[2] === beta.operationId) { sent.resolve(); await reply.promise; }
  };
  let failRead = false;
  const lateService = createAuthService(f.identity, { ...f.profiles, async get(uid) {
    if (uid === worker.uid && failRead) throw Error('Lectura final indisponible');
    return f.profiles.get(uid);
  } });
  const late = lateService.updateUser(adminToken, worker.uid, beta);
  try {
    await Promise.race([sent.promise, late.then(() => { throw Error('La respuesta no quedó retenida'); })]);
    const version1 = await f.service.reconcileOperation(adminToken, beta.operationId);
    const version2 = await f.service.updateUser(second, worker.uid, gamma);
    assert.equal(version2.user.profileVersion, 2);
    assert.equal(preferCurrentProfile(version2.user, version1.user).email, gamma.email);
    failRead = true;
    reply.resolve();
    const result = await late;
    assert.equal(result.operation?.state, 'completed');
    assert.equal(result.user, null);
    assert.equal(result.profileRefreshRequired, true);
    const repeat = await lateService.updateUser(adminToken, worker.uid, beta);
    assert.equal(repeat.operation?.state, 'completed');
    assert.equal(repeat.user, null);
    assert.equal(repeat.profileRefreshRequired, true);
    assert.equal((await f.profiles.get(worker.uid))?.email, gamma.email);
    assert.equal(f.authUpdates.length, 2);
    assert.equal(f.audits.length, 2);
  } finally { reply.resolve(); await late.catch(() => {}); }
});

test('H1-A una edición directa con UUID también liga su contenido y registra un solo movimiento', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  const request = { expectedProfileVersion: 0, operationId: randomUUID(), displayName: 'Nombre original' };
  const first = await f.service.updateUser(adminToken, worker.uid, request);
  assert.equal(first.operation?.kind, 'profile');
  assert.equal(first.operation?.authentication, 'not_required');
  assert.equal(first.user?.profileVersion, 1);
  assert.equal((await f.service.updateUser(adminToken, worker.uid, request)).user?.profileVersion, 1);
  await assert.rejects(f.service.updateUser(adminToken, worker.uid, { ...request, displayName: 'Nombre distinto' }),
    error(409, 'OPERATION_ID_CONFLICT'));
  assert.equal((await f.profiles.get(worker.uid))?.displayName, request.displayName);
  assert.equal(f.authUpdates.length, 0);
  assert.deepEqual(f.audits, ['admin:worker']);
});

test('H1-A una contraseña ready solo admite el secreto original y se puede cancelar antes del envío', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  const request = { operationId: randomUUID(), tempPassword: 'Fixture#9-secreto-sintetico-original' };
  const get = f.identity.getUser;
  f.identity.getUser = async () => { throw Error('Auth no disponible'); };
  const reserved = await f.service.setTemporaryPassword(adminToken, worker.uid, request);
  assert.equal(reserved.operation.authentication, 'ready');
  assert.doesNotMatch(JSON.stringify(await f.profiles.operation(request.operationId)), /secreto-sintetico-original/);
  assert.doesNotMatch(JSON.stringify(reserved), /secretVerifier|secreto-sintetico-original/);
  f.identity.getUser = get;
  await assert.rejects(f.service.setTemporaryPassword(adminToken, worker.uid, { ...request, tempPassword: 'Fixture#9-otra-clave-sintetica' }),
    error(409, 'OPERATION_ID_CONFLICT'));
  assert.equal(f.authUpdates.length, 0);
  assert.deepEqual(await f.service.cancelReadyPassword(adminToken, request.operationId), { cancelled: true });
  assert.deepEqual(await f.service.cancelReadyPassword(adminToken, request.operationId), { cancelled: true });
  const newRequest = { ...request, operationId: randomUUID() };
  f.identity.getUser = async () => { throw Error('Auth no disponible'); };
  assert.equal((await f.service.setTemporaryPassword(adminToken, worker.uid, newRequest)).operation.authentication, 'ready');
  f.identity.getUser = get;
  const next = await f.service.setTemporaryPassword(adminToken, worker.uid, newRequest);
  assert.equal(next.operation.state, 'completed');
  assert.equal(f.authUpdates.length, 1);
  assert.equal(f.audits.length, 1);
});

test('una mutación sin marca y con resultado incierto nunca se reenvía ni libera por tiempo', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  let writes = 0;
  f.identity.updateCredential = async () => { writes++; throw new Error('conexión interrumpida'); };
  const beta = { email: 'beta@example.test', operationId: randomUUID(), expectedProfileVersion: 0 };
  assert.equal((await f.service.updateUser(adminToken, worker.uid, beta)).operation?.authentication, 'uncertain');
  assert.equal((await f.service.reconcileOperation(adminToken, beta.operationId)).operation.state, 'pending');
  await assert.rejects(f.service.updateUser(adminToken, worker.uid, {
    email: 'gamma@example.test', operationId: randomUUID(), expectedProfileVersion: 0
  }),
    error(409, 'CREDENTIAL_OPERATION_PENDING'));
  assert.equal(writes, 1);
});

test('un rechazo definitivo queda fallido, libera la reserva y se reintenta sin otra escritura', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  let writes = 0;
  f.identity.updateCredential = async () => { writes++; throw new MutationRejected('EMAIL_EXISTS'); };
  const beta = { email: 'beta@example.test', operationId: randomUUID(), expectedProfileVersion: 0 };
  const result = await f.service.updateUser(adminToken, worker.uid, beta);
  assert.equal(result.operation?.state, 'failed');
  assert.equal(result.operation?.failure, 'EMAIL_EXISTS');
  assert.equal((await f.profiles.get(worker.uid))?.credentialOperationId, null);
  assert.equal(await f.profiles.emailOwner(beta.email), null);
  assert.equal((await f.service.updateUser(adminToken, worker.uid, beta)).operation?.state, 'failed');
  assert.equal(writes, 1);
});

test('H2 el endpoint administrativo no despacha incluso si se reasigna el correo validable', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  const getUser = f.identity.getUser;
  f.identity.getUser = async uid => {
    if (uid === worker.uid) throw new Error('La recuperación administrativa no debe consultar ni despachar');
    return getUser(uid);
  };
  await assert.rejects(f.service.resetPassword(adminToken, worker.uid), error(410, 'ADMIN_RESET_DISABLED'));
  f.accounts.set(worker.uid, { uid: worker.uid, email: 'new@example.test', emailVerified: true, disabled: false });
  f.accounts.set('other', { uid: 'other', email: worker.email, emailVerified: true, disabled: false });
  await assert.rejects(f.service.resetPassword(adminToken, worker.uid), error(410, 'ADMIN_RESET_DISABLED'));
  assert.equal(f.authUpdates.length, 0);
});

test('un fallo de bitácora conserva el éxito y permite registrar una sola vez sin guardar la clave', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  const id = randomUUID();
  f.faults.audit = true;
  const result = await f.service.setTemporaryPassword(adminToken, worker.uid, {
    operationId: id, tempPassword: 'Fixture#9-fixture-secret-unique'
  });
  assert.equal(result.operation.state, 'completed');
  assert.equal(result.operation.audit, 'pending');
  assert.equal(result.tempPassword, 'Fixture#9-fixture-secret-unique');
  assert.doesNotMatch(JSON.stringify(await f.profiles.operation(id)), /fixture-secret-unique/);
  f.faults.audit = false;
  const replay = await f.service.reconcileOperation(adminToken, id);
  assert.equal(replay.operation.audit, 'recorded');
  const repeated = await f.service.setTemporaryPassword(adminToken, worker.uid, {
    operationId: id, tempPassword: 'Fixture#9-fixture-secret-unique'
  });
  assert.equal(repeated.tempPassword, undefined);
  await assert.rejects(f.service.setTemporaryPassword(adminToken, worker.uid, {
    operationId: id, tempPassword: 'Fixture#9-different-retry-password'
  }), error(409, 'OPERATION_ID_CONFLICT'));
  await f.service.reconcileOperation(adminToken, id);
  assert.deepEqual(f.audits, ['admin:worker']);
  assert.equal(f.authUpdates.length, 1);
});

test('dos administradores no pueden reservar el mismo correo normalizado', async () => {
  const f = fixture(profile('admin', { role: 'Administrador' }), profile('second', { role: 'Administrador' }));
  const second = f.signIn('second', 'second', 'second@example.test');
  const input = { email: ' Shared@example.test ', displayName: 'Invitada', role: 'Auxiliar', authMethod: 'google' };
  const result = await Promise.allSettled([
    f.service.createUser(adminToken, input), createAuthService(f.identity, f.profiles).createUser(second, input)
  ]);
  assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = result.find(value => value.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'DUPLICATE_EMAIL');
  assert.ok(await f.profiles.emailOwner('shared@example.test'));
});

test('una invitación nueva y una heredada reautorizada se consultan sin listar perfiles', async () => {
  for (const legacy of [true, false]) {
    const email = 'invite@example.test';
    const f = fixture(profile('admin', { role: 'Administrador' }), ...(legacy ? [legacyInvitation(email)] : []));
    if (!legacy) await f.service.createUser(adminToken, { email, displayName: 'Invitada', role: 'Auxiliar', authMethod: 'google' });
    f.accounts.set('invitee', { uid: 'invitee', email, emailVerified: true, disabled: false });
    const token = f.signIn('invited', 'invitee', email, true, 'google.com');
    if (legacy) {
      await assert.rejects(f.service.verifySession(token), error(403, 'PROFILE_NOT_FOUND'));
      await f.service.updateUser(adminToken, legacyInvitation(email).uid, { expectedProfileVersion: 0 });
    }
    f.faults.list = true;
    assert.equal((await f.service.verifySession(token)).uid, 'invitee');
  }
});

test('el método exclusivo bloquea al otro proveedor y ambos permite cuentas autorizadas', async () => {
  const worker = profile('worker', { authMethod: 'google' });
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, {
    uid: worker.uid, email: worker.email, emailVerified: true, disabled: false, providerData: [{ providerId: 'google.com' }]
  });
  const password = f.signIn('password', worker.uid, worker.email);
  const google = f.signIn('google', worker.uid, worker.email, true, 'google.com');
  await assert.rejects(f.service.verifySession(password), error(403, 'PROVIDER_NOT_ALLOWED'));
  assert.equal((await f.service.verifySession(google)).uid, worker.uid);
  await assert.rejects(f.service.updateUser(adminToken, worker.uid, { authMethod: 'password', expectedProfileVersion: 0 }),
    error(409, 'AUTH_METHOD_UNAVAILABLE'));
  await f.service.updateUser(adminToken, worker.uid, { authMethod: 'both', expectedProfileVersion: 0 });
  assert.equal((await f.service.verifySession(password)).uid, worker.uid);
  assert.equal((await f.service.verifySession(google)).uid, worker.uid);
});

test('revocar mantiene el perfil activo y rechaza el auth_time anterior o igual al corte', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  const { cutoff, firebaseRevoked } = await f.service.revokeSessions(adminToken, worker.uid);
  assert.equal(firebaseRevoked, true);
  assert.equal((await f.profiles.get(worker.uid))?.active, true);
  for (const authTime of [cutoff - 1, cutoff]) {
    const old = f.signIn('old', worker.uid, worker.email, false, 'password', authTime);
    await assert.rejects(f.service.verifySession(old), error(401, 'SESSION_REVOKED'));
  }
  const fresh = f.signIn('fresh', worker.uid, worker.email, false, 'password', cutoff + 1);
  assert.equal((await f.service.verifySession(fresh)).uid, worker.uid);
});

test('H3 un fallo confirmado de Auth y otro de Firestore se reconcilian sin reactivar sesiones antiguas', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  const disable = { active: false, expectedProfileVersion: 0, operationId: randomUUID() };
  const contain = f.identity.containAccount;
  f.identity.containAccount = async () => { throw new MutationRejected('AUTH_CREDENTIAL_UNAVAILABLE'); };
  const partial = await f.service.updateUser(adminToken, worker.uid, disable);
  assert.equal(partial.user.active, false);
  assert.equal(partial.operation?.profileApplied, true);
  assert.equal(partial.operation?.authentication, 'ready');
  assert.equal(partial.operation?.failure, 'AUTH_CREDENTIAL_UNAVAILABLE');
  assert.equal(f.authUpdates.length, 0);
  const firstCutoff = (await f.profiles.get(worker.uid))!.sessionValidAfter!;
  const original = f.signIn('before', worker.uid, worker.email, false, 'password', firstCutoff - 1);
  await assert.rejects(f.service.verifySession(original), error(403, 'USER_INACTIVE'));
  const enable = { active: true, expectedProfileVersion: 1, operationId: randomUUID() };
  await assert.rejects(f.service.updateUser(adminToken, worker.uid, enable), error(409, 'EMERGENCY_PENDING'));
  f.identity.containAccount = contain;
  assert.equal((await f.service.updateUser(adminToken, worker.uid, disable)).operation?.state, 'completed');
  assert.equal((await f.service.updateUser(adminToken, worker.uid, disable)).operation?.state, 'completed');
  f.faults.confirmation = true;
  const authOnly = await f.service.updateUser(adminToken, worker.uid, enable);
  assert.equal(authOnly.operation?.authentication, 'uncertain');
  assert.equal(authOnly.operation?.profileApplied, false);
  assert.equal(authOnly.user.active, false);
  assert.equal(f.authUpdates.length, 2);
  f.faults.confirmation = false;
  const completed = await f.service.reconcileOperation(adminToken, enable.operationId);
  assert.equal(completed.user.active, true);
  assert.equal(completed.user.profileVersion, 2);
  const cutoff = (await f.profiles.get(worker.uid))!.sessionValidAfter!;
  assert.ok(cutoff > firstCutoff);
  await assert.rejects(f.service.verifySession(original), error(401, 'SESSION_REVOKED'));
  const boundary = f.signIn('boundary', worker.uid, worker.email, false, 'password', cutoff);
  await assert.rejects(f.service.verifySession(boundary), error(401, 'SESSION_REVOKED'));
  const fresh = f.signIn('fresh', worker.uid, worker.email, false, 'password', cutoff + 1);
  assert.equal((await f.service.verifySession(fresh)).uid, worker.uid);
  assert.equal((await f.service.updateUser(adminToken, worker.uid, enable)).operation?.state, 'completed');
  assert.equal(f.authUpdates.length, 2);
  assert.equal(f.audits.length, 2);
});

test('H3 mantiene la protección del principal y le permite revocar sus propias sesiones', async () => {
  const primary = profile(PRIMARY_ADMIN_UID, { role: 'Administrador' });
  const f = fixture(profile('admin', { role: 'Administrador' }), primary);
  f.accounts.set(primary.uid, { uid: primary.uid, email: primary.email, emailVerified: true, disabled: false });
  const principalToken = f.signIn('primary', primary.uid, primary.email, false, 'password', Math.floor(Date.now() / 1000));
  for (const bearer of [adminToken, principalToken]) {
    await assert.rejects(f.service.updateUser(bearer, primary.uid, {
      active: false, expectedProfileVersion: 0, operationId: randomUUID()
    }), error(403, 'PROTECTED_ADMIN'));
  }
  await assert.rejects(f.service.revokeSessions(adminToken, primary.uid), error(403, 'PROTECTED_ADMIN'));
  assert.equal(f.authUpdates.length, 0);
  assert.equal((await f.service.revokeSessions(principalToken, primary.uid)).firebaseRevoked, true);
  assert.equal((await f.profiles.get(primary.uid))?.active, true);
  await assert.rejects(f.service.verifySession(principalToken), error(401, 'SESSION_REVOKED'));
});

test('Fase 1.3 distingue rechazos verificables de respuestas sin evidencia', () => {
  for (const [status, provider, expected] of [
    [403, { status: 'PERMISSION_DENIED' }, 'PERMISSION_DENIED'],
    [400, { message: 'EMAIL_EXISTS' }, 'EMAIL_EXISTS'],
    [400, { message: 'INVALID_ID_TOKEN' }, 'INVALID_ID_TOKEN'],
    [401, { message: 'ID_TOKEN_REVOKED' }, 'ID_TOKEN_REVOKED']
  ] as const) {
    const error = classifyIdentityFailure(status, { error: provider });
    assert.ok(error instanceof MutationRejected);
    assert.equal(error.code, expected);
  }
  for (const [status, expected] of [[403, 'AUTH_RESPONSE_AMBIGUOUS'], [503, 'AUTH_PROVIDER_ERROR'], [504, 'AUTH_TIMEOUT']] as const) {
    const error = classifyIdentityFailure(status, {});
    assert.ok(error instanceof MutationUncertain);
    assert.equal(error.code, expected);
  }
});

test('Fase 1.3 una reactivación ya enviada no reabre el perfil tras una nueva emergencia', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  assert.equal((await f.service.emergencyDisable(adminToken, worker.uid, { operationId: randomUUID() })).operation.state, 'completed');
  const entered = barrier(), reply = barrier();
  const update = f.identity.updateCredential;
  f.identity.updateCredential = async (...args) => {
    entered.resolve();
    await reply.promise;
    return update(...args);
  };
  const activation = { active: true, expectedProfileVersion: 1, operationId: randomUUID() };
  const inFlight = f.service.updateUser(adminToken, worker.uid, activation);
  const emergency = { operationId: randomUUID() };
  try {
    await Promise.race([entered.promise, inFlight.then(() => { throw Error('No se alcanzó la reactivación'); })]);
    const local = await f.service.emergencyDisable(adminToken, worker.uid, emergency);
    assert.equal(local.operation.profileApplied, true);
    assert.equal(local.operation.state, 'pending');
    assert.equal(local.user?.active, false);
    assert.equal(f.authUpdates.length, 1);
  } finally { reply.resolve(); }
  const late = await inFlight;
  assert.equal(late.operation.failure, 'SECURITY_STATE_CHANGED');
  assert.equal(late.user?.active, false);
  const recovered = await f.service.reconcileOperation(adminToken, emergency.operationId);
  assert.equal(recovered.operation.authDisabled, true);
  assert.equal(recovered.operation.refreshRevoked, true);
  assert.equal(recovered.user?.active, false);
  assert.equal((await f.profiles.get(worker.uid))?.securityVersion, 2);
});

test('Fase 1.4 la desactivación y la edición deniegan una autorización de revocación desconocida', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  const normalVerify = f.identity.verifyIdToken;
  const checks: boolean[] = [];
  f.identity.verifyIdToken = async (token, revoked: boolean) => {
    checks.push(revoked);
    if (revoked) throw Object.assign(Error('Timeout'), { code: 'app/network-timeout' });
    return normalVerify(token, true);
  };
  const request = { operationId: randomUUID() };
  await assert.rejects(f.service.emergencyDisable(adminToken, worker.uid, request), error(503, 'AUTHORIZATION_UNAVAILABLE'));
  await assert.rejects(f.service.updateUser(adminToken, worker.uid, { ...request, active: false, expectedProfileVersion: 0 }),
    error(503, 'AUTHORIZATION_UNAVAILABLE'));
  assert.deepEqual(checks, [true, true]);
  assert.deepEqual(await f.profiles.get(worker.uid), worker);
  assert.equal(await f.profiles.operation(request.operationId), null);
  assert.equal(f.authUpdates.length, 0);
  assert.equal(f.audits.length, 0);
  f.identity.verifyIdToken = async () => { throw Object.assign(Error('Revocado'), { code: 'auth/id-token-revoked' }); };
  await assert.rejects(f.service.emergencyDisable(adminToken, worker.uid, { operationId: randomUUID() }),
    error(401, 'TOKEN_REVOKED'));
});

test('Fase 1.3 la contraseña débil se rechaza antes de reservar y la generada cumple la política', async () => {
  const worker = profile('worker');
  const f = fixture(profile('admin', { role: 'Administrador' }), worker);
  f.accounts.set(worker.uid, { uid: worker.uid, email: worker.email, emailVerified: true, disabled: false });
  const id = randomUUID();
  await assert.rejects(f.service.setTemporaryPassword(adminToken, worker.uid, { operationId: id, tempPassword: 'abc123' }),
    error(400, 'INVALID_PASSWORD'));
  assert.equal(await f.profiles.operation(id), null);
  const issued = await f.service.setTemporaryPassword(adminToken, worker.uid, { operationId: id });
  assert.match(issued.tempPassword!, /^Calera#9[0-9a-f]{36}$/);
  assert.ok(!JSON.stringify(await f.profiles.operation(id)).includes(issued.tempPassword!));
});

test('solo el creador puede cancelar una reserva segura vencida y queda trazabilidad', async () => {
  const email = 'reserved@example.test';
  const f = fixture(profile('admin', { role: 'Administrador' }), profile('other', { role: 'Administrador' }),
    profile('reserved', { email, active: false, provisioning: { active: true, state: 'ready', expiresAt: time } }));
  await f.profiles.transaction(async tx => tx.setEmailOwner(email, 'reserved'));
  const other = f.signIn('other', 'other', 'other@example.test');
  await assert.rejects(f.service.manageReservation(other, 'reserved', { action: 'cancel' }),
    error(403, 'RESERVATION_OWNER_REQUIRED'));
  assert.deepEqual(await f.service.manageReservation(adminToken, 'reserved', { action: 'cancel' }), { cancelled: true });
  assert.equal(await f.profiles.emailOwner(email), null);
  const profileAfter = await f.profiles.get('reserved');
  assert.equal(profileAfter?.provisioning && profileAfter.provisioning.state, 'cancelled');
  assert.deepEqual(f.audits, ['admin:reserved']);
});
