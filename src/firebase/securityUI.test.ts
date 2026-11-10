import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { preferCurrentProfile } from './profileVersion.ts';
import { resolveModule } from './permissions.ts';

type Element = { type: string; props: Record<string, any>; children: unknown[] };
const createElement = (type: string, props: Element['props'], ...children: unknown[]) => ({ type, props: props ?? {}, children });

function elements(node: unknown): Element[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const item = node as Element;
  return [item, ...item.children.flatMap(elements)];
}

function plainText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(plainText).join(' ');
  if (typeof node === 'object') return plainText((node as Element).children);
  return String(node);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(ready => { resolve = ready; });
  return { promise, resolve };
}

function loadSource(file: string, modules: Record<string, unknown>, globals: object = {}) {
  let index = 0, initial = true;
  const hooks: any[] = [], effects: (() => unknown)[] = [];
  const react = {
    createElement,
    createContext: () => ({ Provider: 'ProfileProvider' }),
    useState(value: any) {
      const at = index++;
      if (!(at in hooks)) hooks[at] = typeof value === 'function' ? value() : value;
      return [hooks[at], (next: any) => { hooks[at] = typeof next === 'function' ? next(hooks[at]) : next; }];
    },
    useRef(current: any) {
      const at = index++;
      return hooks[at] ?? (hooks[at] = { current });
    },
    useMemo: (compute: () => unknown) => compute(),
    useEffect: (effect: () => unknown) => { if (initial) effects.push(effect); }
  };
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  });
  const exports: Record<string, any> = {};
  runInNewContext(outputText, {
    exports, console, crypto: webcrypto, process: { env: { NODE_ENV: 'production' } },
    setTimeout: () => 1, clearTimeout: () => {},
    require(id: string) {
      if (id === 'react') return react;
      if (id === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
      if (id in modules) return modules[id];
      throw Error('Importación inesperada: ' + id);
    },
    ...globals
  }, { filename: file });
  return {
    exports,
    render(component: (props: any) => Element, props: object) {
      index = 0;
      const element = component(props);
      initial = false;
      return element;
    },
    mount: () => effects.forEach(effect => effect())
  };
}

const older = { uid: 'user-test', profileVersion: 1, credentialVersion: 1, email: 'old@example.test', displayName: 'Anterior',
  role: 'Administrador', authMethod: 'password', active: true, assignedSectorIds: [], assignedGalponIds: [] };
const newer = { ...older, profileVersion: 2, credentialVersion: 2, email: 'new@example.test', displayName: 'Actual', role: 'Solo lectura' };

test('AuthGate ignora login y suscripciones anteriores a la revisión o generación vigente', async () => {
  const emailResult = deferred<unknown>(), googleResult = deferred<unknown>();
  const auth: { currentUser: { uid: string } | null } = { currentUser: null };
  const listeners = new Map<string, (event: unknown) => void>();
  const subscriptions: { publish: (value: typeof older) => void; reject: (error: unknown) => void }[] = [];
  let authObserver!: (user: { uid: string } | null) => Promise<void>;
  const component = loadSource('../components/AuthGate.tsx', {
    '../firebase/config': { auth }, './UserAdminModal': {}, './GalponLogoIcon': {},
    '../firebase/profileVersion': { preferCurrentProfile }, '../firebase/operationalData': { operationalScopeKey: () => 'test' },
    '../firebase/permissions': { resolveModule }, '../firebase/offlineAuthorization': { offlineAuthorizationMs: 900_000 },
    '../firebase/authService': {
      handleGoogleRedirectResult: async () => {},
      onAuthStateChanged: (_: unknown, callback: typeof authObserver) => { authObserver = callback; return () => {}; },
      loginWithEmail: () => emailResult.promise, loginWithGoogle: () => googleResult.promise,
      fetchOrBootstrapProfile: async () => older,
      subscribeToUserProfile: (_: unknown, publish: (value: typeof older) => void, reject: (error: unknown) => void) => {
        subscriptions.push({ publish, reject }); return () => {};
      },
      translateFirebaseAuthError: (error: Error) => error.message,
      logoutSession: async () => {}
    }
  }, { window: { location: { hostname: 'localhost' }, addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn) } });
  const render = () => component.render(component.exports.AuthGate, { children: 'Área protegida' });
  render();
  component.mount();
  await authObserver(null);
  listeners.get('calera-e2e-preview')?.({ detail: older });
  assert.ok(!plainText(render()).includes('Área protegida'));
  const input = (id: string) => elements(render()).find(el => el.props.id === id)!;
  input('login-email').props.onChange({ target: { value: older.email } });
  input('login-password').props.onChange({ target: { value: 'synthetic' } });
  const pending = elements(render()).find(el => el.type === 'form')!.props.onSubmit({ preventDefault() {} });
  auth.currentUser = { uid: older.uid };
  await authObserver(auth.currentUser);
  subscriptions[0].publish(newer);
  subscriptions[0].publish(older);
  emailResult.resolve({ profile: older });
  await pending;
  assert.equal(render().props.value.profile.role, newer.role);
  assert.ok(plainText(render()).includes('Acceso restringido'));
  assert.ok(!plainText(render()).includes('Área protegida'));
  await render().props.value.logout();
  subscriptions[0].publish(newer);
  assert.ok(!plainText(render()).includes('Área protegida'));

  auth.currentUser = null;
  await authObserver(null);
  const googleButton = elements(render()).find(el => el.type === 'button' && plainText(el).includes('Google'))!;
  const googlePending = googleButton.props.onClick();
  auth.currentUser = { uid: older.uid };
  await authObserver(auth.currentUser);
  subscriptions[1].publish({ ...newer, profileVersion: 3 });
  subscriptions[0].reject({ status: 403 });
  googleResult.resolve({ profile: older });
  await googlePending;
  assert.equal(render().props.value.profile.profileVersion, 3);
  subscriptions[1].reject({ status: 403, message: 'Cuenta desactivada' });
  subscriptions[1].publish(newer);
  assert.ok(!plainText(render()).includes('Área protegida'));
});

test('AuthGate limita la autorización offline al dispositivo abierto y cierra la administración al desconectar', async () => {
  const auth = { currentUser: { uid: older.uid } };
  const listeners = new Map<string, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const navigator = { onLine: true };
  let counter = 0;
  let bootstrapCalls = 0;
  let authObserver!: (user: typeof auth.currentUser) => Promise<void>;
  const component = loadSource('../components/AuthGate.tsx', {
    '../firebase/config': { auth }, './UserAdminModal': { UserAdminModal: 'AdminDialog' }, './GalponLogoIcon': {},
    '../firebase/profileVersion': { preferCurrentProfile }, '../firebase/operationalData': { operationalScopeKey: () => 'test' },
    '../firebase/permissions': { resolveModule }, '../firebase/offlineAuthorization': { offlineAuthorizationMs: 900_000 },
    '../firebase/authService': {
      handleGoogleRedirectResult: async () => {},
      onAuthStateChanged: (_: unknown, callback: typeof authObserver) => { authObserver = callback; return () => {}; },
      fetchOrBootstrapProfile: async () => {
        bootstrapCalls++;
        if (!navigator.onLine) throw Error('sin conexión');
        return older;
      },
      subscribeToUserProfile: () => () => {}
    }
  }, {
    navigator,
    window: { addEventListener: (type: string, callback: () => void) => listeners.set(type, callback),
      removeEventListener: (type: string) => listeners.delete(type) },
    setTimeout: (callback: () => void, delay: number) => { timers.set(++counter, { callback, delay }); return counter; },
    clearTimeout: (id: number) => timers.delete(id)
  });
  const render = () => component.render(component.exports.AuthGate, { children: 'Área protegida' });
  render();
  component.mount();
  await authObserver(auth.currentUser);
  assert.equal(render().props.value.canManageUsers, true);
  render().props.value.openUserAdminModal();
  assert.ok(elements(render()).some(item => item.type === 'AdminDialog'));
  navigator.onLine = false;
  listeners.get('offline')!();
  assert.equal(render().props.value.canManageUsers, false);
  assert.ok(!elements(render()).some(item => item.type === 'AdminDialog'));
  assert.ok(plainText(render()).includes('Área protegida'));
  [...timers.values()].find(timer => timer.delay === 900_000)!.callback();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(!plainText(render()).includes('Área protegida'));
  assert.match(plainText(render()), /operaciones pendientes/);
  navigator.onLine = true;
  listeners.get('online')!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(render().props.value.canManageUsers, true);
  assert.equal(bootstrapCalls, 3);
});

test('el modal descarta credenciales tardías y retira las visibles al cambiar la revisión', async () => {
  let list = [older];
  let passwordResult = deferred<unknown>();
  let operationId = '';
  const component = loadSource('../components/UserAdminModal.tsx', {
    '../firebase/operationalData': { collection: () => null, bindOperationalData: () => null, getDocs: async () => ({ docs: [] }) },
    '../firebase/authService': {
      OFFICIAL_ROLES: [], PRIMARY_ADMIN_UID: 'primary-test', adminListUsers: async () => list, adminListReservations: async () => [],
      adminGenerateTempPassword: (_uid: string, _password: string, id: string) => {
        operationId = id;
        return passwordResult.promise;
      }
    },
    '../firebase/profileVersion': { preferCurrentProfile }, '../firebase/emergencyStatus': {},
    '../firebase/permissions': { MODULE_LABELS: {}, ROLE_PERMISSION_MATRIX: {}, ACTION_LABELS: {} }
  });
  const render = () => component.render(component.exports.UserAdminModal, {
    currentUserProfile: { uid: 'admin-test', role: 'Administrador', active: true }, onClose() {}
  });
  render();
  component.mount();
  await new Promise(resolve => setImmediate(resolve));
  const button = (value: string) => elements(render()).find(el =>
    el.type === 'button' && (el.props.title === value || plainText(el).trim() === value))!;
  const response = (user: typeof older, password: string) => ({ user, tempPassword: password, profileRefreshRequired: false,
    providerAcknowledged: true, message: 'Operación confirmada', operation: {
      id: operationId, uid: user.uid, version: user.credentialVersion, state: 'completed', audit: 'recorded'
    } });
  const pending = button('Generar nueva contraseña temporal').props.onClick();
  list = [newer];
  passwordResult.resolve(response(older, 'synthetic-old-secret'));
  await pending;
  assert.ok(!plainText(render()).includes('synthetic-old-secret'));
  assert.ok(plainText(render()).includes(newer.email));
  passwordResult = deferred<unknown>();
  const next = button('Generar nueva contraseña temporal').props.onClick();
  passwordResult.resolve(response(newer, 'synthetic-current-secret'));
  await next;
  assert.ok(plainText(render()).includes('synthetic-current-secret'));
  list = [{ ...newer, credentialVersion: 3 }];
  await button('Actualizar').props.onClick();
  assert.ok(!plainText(render()).includes('synthetic-current-secret'));
});

test('los errores OAuth registran solo categorías conocidas', async () => {
  const output: unknown[][] = [];
  let code = 'auth/account-exists-with-different-credential';
  const component = loadSource('./authService.ts', {
    './config': { auth: {} }, './apiConfig': {}, 'firebase/auth': {
      getRedirectResult: async () => { throw { code, message: 'synthetic-message', customData: { oauthAccessToken: 'synthetic-token' } }; }
    }
  }, { console: { warn: (...args: unknown[]) => output.push(args) } });
  await assert.rejects(component.exports.handleGoogleRedirectResult(), { code });
  code = 'auth/synthetic-token';
  await assert.rejects(component.exports.handleGoogleRedirectResult(), { code: 'auth/google-unknown' });
  assert.equal(output.length, 2);
  assert.ok(!JSON.stringify(output).includes('synthetic'));
});
