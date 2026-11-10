import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Express, Request, Response } from 'express';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Firestore } from '@google-cloud/firestore';
import type { DocumentSnapshot, QuerySnapshot } from '@google-cloud/firestore';
import { AuthError, CREDENTIAL_OPERATION_CLAIM, createAuthService, MutationRejected, MutationUncertain } from './auth.ts';
import type { CredentialOperation, IdentityProvider, Profile, ProfileStore } from './auth.ts';
import { registerOperationalRoutes } from './operations.ts';

function readProfile(snapshot: DocumentSnapshot): Profile | null {
  return snapshot.exists ? snapshot.data() as Profile : null;
}

function readProfiles(snapshot: QuerySnapshot) {
  return snapshot.docs.map(doc => ({ id: doc.id, profile: doc.data() as Profile }));
}

function auditProfile(profile: Profile) {
  return JSON.stringify({
    uid: profile.uid, email: profile.email, displayName: profile.displayName, dni: profile.dni,
    role: profile.role, authMethod: profile.authMethod, active: profile.active
  });
}

export function createFirestoreProfileStore(db: Firestore): ProfileStore {
  const users = db.collection('users');
  const movements = db.collection('movements');
  const operations = db.collection('_authCredentialOperations');
  const emailOwners = db.collection('_authEmailOwners');
  const emailRef = (email: string) => emailOwners.doc(createHash('sha256').update(email).digest('hex'));
  const readOwner = (snapshot: DocumentSnapshot): string | null => snapshot.get('uid') ?? null;
  const readOperation = (snapshot: DocumentSnapshot) => (snapshot.data() as CredentialOperation | undefined) ?? null;
  return {
    get: async uid => readProfile(await users.doc(uid).get()),
    list: async () => readProfiles(await users.get()),
    emailOwner: async email => readOwner(await emailRef(email).get()),
    operation: async id => readOperation(await operations.doc(id).get()),
    outstandingOperations: async uid => (await operations.where('uid', '==', uid)
      .where('audit', '==', 'pending').limit(25).get()).docs.map(doc => doc.data() as CredentialOperation),
    transaction: work => db.runTransaction(transaction => work({
      get: async uid => readProfile(await transaction.get(users.doc(uid))),
      list: async () => readProfiles(await transaction.get(users)),
      emailOwner: async email => readOwner(await transaction.get(emailRef(email))),
      operation: async id => readOperation(await transaction.get(operations.doc(id))),
      create: profile => { transaction.create(users.doc(profile.uid), profile); },
      update: (uid, changes) => { transaction.update(users.doc(uid), changes); },
      setEmailOwner: (email, uid) => { transaction.set(emailRef(email), { uid }); },
      createOperation: operation => { transaction.create(operations.doc(operation.id), operation); },
      updateOperation: (id, changes) => { transaction.update(operations.doc(id), changes); },
      audit: (actor, target, type, detail, previous, eventId) => {
        const doc = eventId ? movements.doc('auth-' + eventId) : movements.doc();
        const now = new Date();
        transaction.create(doc, {
          id: doc.id, timestamp: now.toLocaleString('es-PE', { timeZone: 'America/Lima' }),
          createdAt: now.toISOString(), user: `${actor.displayName} (${actor.role})`,
          userId: actor.uid, userEmail: actor.email, userRole: actor.role, type,
          module: 'Administración de Usuarios', targetId: target.uid, detail,
          ...(previous ? { previousValue: auditProfile(previous) } : {}),
          ...(previous || type === 'REGISTRO' ? { newValue: auditProfile(target) } : {})
        });
      }
    }))
  };
}

const DEFINITIVE_REJECTIONS = new Set([
  'EMAIL_EXISTS', 'INVALID_EMAIL', 'WEAK_PASSWORD', 'PASSWORD_DOES_NOT_MEET_REQUIREMENTS',
  'USER_NOT_FOUND', 'LOCAL_ID_EXISTS', 'DUPLICATE_LOCAL_ID', 'INVALID_CUSTOM_ATTRIBUTES',
  'CLAIMS_TOO_LARGE', 'OPERATION_NOT_ALLOWED', 'MISSING_PASSWORD', 'INVALID_ID_TOKEN',
  'TOKEN_EXPIRED', 'ID_TOKEN_REVOKED', 'TOKEN_REVOKED'
]);

export function classifyIdentityFailure(status: number | undefined, response: { error?: { message?: string; status?: string } }) {
  const code = String(response?.error?.message ?? '').split(/[\s:]/, 1)[0];
  const providerStatus = response?.error?.status;
  if (status === 403 && (providerStatus === 'PERMISSION_DENIED' || code === 'PERMISSION_DENIED')) {
    return new MutationRejected('PERMISSION_DENIED');
  }
  if ((status === 400 || status === 401) && DEFINITIVE_REJECTIONS.has(code)) return new MutationRejected(code);
  if (status === 401 && providerStatus === 'UNAUTHENTICATED') return new MutationRejected('UNAUTHENTICATED');
  if (status === 408 || status === 504 || providerStatus === 'DEADLINE_EXCEEDED') return new MutationUncertain('AUTH_TIMEOUT');
  return new MutationUncertain(status && status >= 500 ? 'AUTH_PROVIDER_ERROR' : 'AUTH_RESPONSE_AMBIGUOUS');
}

// Se usa una sola solicitud HTTP, sin reintentos ni redirecciones automáticas.
function writeIdentityAccount(url: URL, token: string, input: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const signal = AbortSignal.timeout(15_000);
    const interrupted = () => reject(new MutationUncertain(signal.aborted ? 'AUTH_TIMEOUT' : 'AUTH_CONNECTION_INTERRUPTED'));
    const request = (url.protocol === 'http:' ? httpRequest : httpsRequest)(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      signal
    }, response => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        content += chunk;
        if (content.length > 65_536) {
          reject(new MutationUncertain('AUTH_RESPONSE_AMBIGUOUS'));
          response.destroy();
        }
      });
      response.on('error', interrupted);
      response.on('end', () => {
        try {
          const data = JSON.parse(content);
          if (response.statusCode === 200 && typeof data.localId === 'string') {
            resolve(data.localId);
            return;
          }
          reject(classifyIdentityFailure(response.statusCode, data));
        } catch {
          // Una respuesta ilegible no confirma que el efecto remoto se haya rechazado.
          reject(classifyIdentityFailure(response.statusCode, {}));
        }
      });
    });
    request.on('error', interrupted);
    request.end(body);
  });
}

export function createFirebaseIdentityProvider(projectId: string): IdentityProvider {
  const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if ((process.env.K_SERVICE || process.env.NODE_ENV === 'production') &&
      emulator) {
    throw new Error('Los emuladores de Firebase se permiten únicamente en desarrollo.');
  }
  if (!projectId) throw new Error('Se requiere el proyecto de Firebase Auth explícito.');
  if (emulator && (!/^127\.0\.0\.1:\d+$/.test(emulator) || !projectId.startsWith('demo-'))) {
    throw new Error('El emulador de Auth requiere loopback y un proyecto demo.');
  }
  const credential = applicationDefault();
  const firebase = initializeApp({ credential, projectId }, 'calera-server');
  const auth = getAuth(firebase);
  const baseUrl = emulator
    ? 'http://' + emulator + '/identitytoolkit.googleapis.com/v1/projects/'
    : 'https://identitytoolkit.googleapis.com/v1/projects/';
  const mutate = async (suffix: string, input: Record<string, unknown>) => {
    const token = emulator ? 'owner' : await credential.getAccessToken()
      .then(value => value.access_token)
      .catch(() => { throw new MutationRejected('AUTH_CREDENTIAL_UNAVAILABLE'); });
    return writeIdentityAccount(new URL(baseUrl + encodeURIComponent(projectId) + suffix), token, input);
  };
  return {
    verifyIdToken: (token, revoked) => auth.verifyIdToken(token, revoked),
    getUser: uid => auth.getUser(uid),
    getUserByEmail: email => auth.getUserByEmail(email),
    createUser: async ({ uid, ...fields }) => {
      const result = await mutate('/accounts', { ...fields, localId: uid });
      if (result !== uid) throw new Error('Firebase devolvió un UID inesperado.');
      return auth.getUser(uid);
    },
    updateCredential: async (account, input, operationId) => {
      const uid = await mutate('/accounts:update', {
        ...input, localId: account.uid, returnSecureToken: true,
        customAttributes: JSON.stringify({ ...account.customClaims, [CREDENTIAL_OPERATION_CLAIM]: operationId })
      });
      if (uid !== account.uid) throw new Error('Firebase devolvió un UID inesperado.');
    },
    containAccount: async (uid, validSince) => {
      // Preserve customAttributes so a previously applied credential mutation remains provable.
      const changed = await mutate('/accounts:update', { localId: uid, disableUser: true, validSince, returnSecureToken: true });
      if (changed !== uid) throw new MutationUncertain('AUTH_RESPONSE_AMBIGUOUS');
    }
  };
}

export function createNamedFirestore(projectId: string, databaseId: string) {
  if (!projectId || !databaseId || databaseId === '(default)') {
    throw new Error('Se requiere el proyecto y la base nombrada explícita de Firestore.');
  }
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  if (emulator && (process.env.K_SERVICE || process.env.NODE_ENV === 'production' ||
      !/^127\.0\.0\.1:\d+$/.test(emulator) || !projectId.startsWith('demo-'))) {
    throw new Error('El emulador de Firestore requiere desarrollo, loopback y un proyecto demo.');
  }
  return new Firestore({ projectId, databaseId });
}

export function registerFirebaseAuthRoutes(app: Express, projectId: string, databaseId: string) {
  if (Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST) !== Boolean(process.env.FIRESTORE_EMULATOR_HOST)) {
    throw new Error('Configure juntos los emuladores de Auth y Firestore.');
  }
  const db = createNamedFirestore(projectId, databaseId);
  const service = createAuthService(createFirebaseIdentityProvider(projectId), createFirestoreProfileStore(db));
  registerAuthRoutes(app, service);
  registerOperationalRoutes(app, db, service);
}

export function registerAuthRoutes(app: Express, service: ReturnType<typeof createAuthService>) {
  function route(status: number, handler: (req: Request) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const payload = await handler(req) as { operation?: { state: string } };
        const operationState = payload?.operation?.state;
        res.status(operationState === 'pending' ? 202 : operationState === 'failed' ? 409 : status).json(payload);
      } catch (error) {
        if (error instanceof AuthError) {
          res.status(error.status).json({ code: error.code, message: error.message });
          return;
        }
        const code = (error as { code?: string | number } | null)?.code;
        console.error('[Auth] Operación Firebase fallida', req.method, req.route?.path, code);
        res.status(503).json({
          code: 'AUTH_SERVICE_UNAVAILABLE',
          message: 'El servicio de autenticación no está disponible. Intente nuevamente.'
        });
      }
    };
  }

  const target = (req: Request) => String(req.params.uid ?? '');
  app.post('/api/auth/verify-session', route(200, async req => ({
    profile: await service.verifySession(req.headers.authorization)
  })));
  app.get('/api/auth/profile', route(200, async req => ({
    profile: await service.currentProfile(req.headers.authorization)
  })));
  app.get('/api/admin/users', route(200, async req => ({
    users: await service.listUsers(req.headers.authorization)
  })));
  app.post('/api/admin/users', route(201, async req => ({
    user: await service.createUser(req.headers.authorization, req.body ?? {})
  })));
  app.patch('/api/admin/users/:uid', route(200, req =>
    service.updateUser(req.headers.authorization, target(req), req.body ?? {})
  ));
  app.post('/api/admin/users/:uid/emergency-disable', route(200, req =>
    service.emergencyDisable(req.headers.authorization, target(req), req.body ?? {})
  ));
  app.post('/api/admin/users/:uid/temp-password', route(200, req =>
    service.setTemporaryPassword(req.headers.authorization, target(req), req.body ?? {})
  ));
  app.post('/api/admin/users/:uid/reset-password', route(200, req =>
    service.resetPassword(req.headers.authorization, target(req))
  ));
  app.get('/api/admin/provisioning', route(200, async req => ({
    reservations: await service.listReservations(req.headers.authorization)
  })));
  app.post('/api/admin/provisioning/:uid', route(200, req =>
    service.manageReservation(req.headers.authorization, target(req), req.body ?? {})
  ));
  app.post('/api/admin/credential-operations/:id/reconcile', route(200, req =>
    req.body?.action === 'cancel-ready-password'
      ? service.cancelReadyPassword(req.headers.authorization, String(req.params.id ?? ''))
      : service.reconcileOperation(req.headers.authorization, String(req.params.id ?? ''))
  ));
  app.get('/api/admin/users/:uid/credential-operations', route(200, async req => ({
    operations: await service.listCredentialOperations(req.headers.authorization, target(req))
  })));
  app.get('/api/admin/users/:uid/auth-methods', route(200, async req => ({
    methods: await service.listAuthMethods(req.headers.authorization, target(req))
  })));
  app.post('/api/admin/users/:uid/revoke-sessions', route(200, req =>
    service.revokeSessions(req.headers.authorization, target(req), req.body ?? {})
  ));
}
