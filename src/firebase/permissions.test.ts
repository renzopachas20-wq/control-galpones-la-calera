import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasModulePermission,
  resolveModule,
  type AppModuleId
} from './permissions';
import type { OfficialRole } from './authService';

const ALL_MODULES: AppModuleId[] = [
  'dashboard',
  'gantt',
  'avance_diario',
  'asistencia',
  'proyectos',
  'catalogo',
  'actividades',
  'materiales',
  'personal',
  'informes',
  'movimientos'
];

const ALL_ROLES: OfficialRole[] = [
  'Administrador',
  'Jefe de proyecto',
  'Supervisor',
  'Auxiliar',
  'Almacén',
  'Solo lectura'
];

test('las 396 combinaciones coinciden con el encargo maestro', () => {
  const expected = [
    'VCEDIX VCEDIX VCEDIX VCEDIX VCEDIX VCEDIX VCEDIX VCEDIX VCEDIX VCEDIX VCIX',
    'VX VCDEX VCDEX VCDEX VCDEX V V V V VCDEX V',
    'V VCED VCED VCEX VCDEX V V V VCDEX VCDEX V',
    '- - VCED VCDEX VCE - V V VC VCDEX V',
    'V V V VCDEX V V V VCEDIX VCDEX VCDEX V',
    '- - - - - - - - - - -'
  ];
  const actions = { view: 'V', create: 'C', edit: 'E', delete: 'D', import: 'I', export: 'X' } as const;
  let combinations = 0;
  ALL_ROLES.forEach((role, index) => ALL_MODULES.forEach((module, column) => {
    const flags = expected[index].split(' ')[column];
    for (const action of Object.keys(actions) as (keyof typeof actions)[]) {
      assert.equal(hasModulePermission({ role, active: true }, module, action), flags.includes(actions[action]),
        [role, module, action].join(' / '));
      combinations++;
    }
  }));
  assert.equal(combinations, 396);
});

test('las rutas requieren un perfil vinculado y con permisos vigentes', () => {
  const admin = { uid: 'principal', role: 'Administrador' as const, active: true };
  for (const profile of [null, { ...admin, active: false }, { ...admin, uid: 'preauth_example' },
    { ...admin, provisioning: { state: 'ready' } }, { ...admin, linkedUid: 'other' }, { ...admin, role: 'constructor' as OfficialRole }]) {
    assert.equal(resolveModule(profile, 'dashboard'), null);
    assert.equal(hasModulePermission(profile, 'movimientos', 'import'), false);
  }
  assert.equal(resolveModule(admin, 'movimientos'), 'movimientos');
  assert.equal(resolveModule({ role: 'Auxiliar', active: true }, 'gantt'), 'avance_diario');
  assert.equal(resolveModule({ role: 'Solo lectura', active: true }, 'materiales'), null);
});

test('el perfil Supervisor obtiene los permisos de su rol sin depender de datos de asignación', () => {
  const legacy = { role: 'Supervisor' as const, active: true, assignedSectorIds: ['antiguo'], assignedGalponIds: [] };
  assert.equal(hasModulePermission(legacy, 'proyectos', 'view'), true);
  assert.equal(hasModulePermission(legacy, 'avance_diario', 'create'), true);
  assert.equal(hasModulePermission(legacy, 'actividades', 'delete'), false);
});
