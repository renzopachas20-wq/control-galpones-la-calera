import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasModulePermission,
  hasGlobalScope,
  canAccessSector,
  canAccessGalpon,
  filterSectorsByScope,
  ROLE_PERMISSION_MATRIX,
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

test('6 Official Roles and 11 Modules are completely defined in ROLE_PERMISSION_MATRIX', () => {
  for (const role of ALL_ROLES) {
    assert.ok(ROLE_PERMISSION_MATRIX[role], `Role ${role} should exist`);
    for (const mod of ALL_MODULES) {
      const perms = ROLE_PERMISSION_MATRIX[role][mod];
      assert.ok(perms, `Permissions for role ${role} on module ${mod} should exist`);
      assert.equal(typeof perms.view, 'boolean');
      assert.equal(typeof perms.create, 'boolean');
      assert.equal(typeof perms.edit, 'boolean');
      assert.equal(typeof perms.delete, 'boolean');
      assert.equal(typeof perms.import, 'boolean');
      assert.equal(typeof perms.export, 'boolean');
    }
  }
});

test('Inactive or null profiles are denied all module actions', () => {
  assert.equal(hasModulePermission(null, 'dashboard', 'view'), false);
  assert.equal(
    hasModulePermission({ role: 'Administrador', active: false }, 'dashboard', 'view'),
    false
  );
  assert.equal(
    hasModulePermission({ role: 'Administrador', active: false }, 'materiales', 'create'),
    false
  );
});

test('Administrador has full permissions across operational modules and immutable audit log protection', () => {
  const admin = { role: 'Administrador' as const, active: true };
  assert.equal(hasModulePermission(admin, 'proyectos', 'delete'), true);
  assert.equal(hasModulePermission(admin, 'materiales', 'import'), true);
  assert.equal(hasModulePermission(admin, 'avance_diario', 'create'), true);
  // Movimientos is immutable (no edit/delete)
  assert.equal(hasModulePermission(admin, 'movimientos', 'view'), true);
  assert.equal(hasModulePermission(admin, 'movimientos', 'edit'), false);
  assert.equal(hasModulePermission(admin, 'movimientos', 'delete'), false);
});

test('Role differentiation: Almacén, Auxiliar, Supervisor, Jefe de proyecto, Solo lectura', () => {
  const almacen = { role: 'Almacén' as const, active: true };
  assert.equal(hasModulePermission(almacen, 'materiales', 'create'), true);
  assert.equal(hasModulePermission(almacen, 'materiales', 'edit'), true);
  assert.equal(hasModulePermission(almacen, 'materiales', 'delete'), true);
  assert.equal(hasModulePermission(almacen, 'personal', 'view'), false);
  assert.equal(hasModulePermission(almacen, 'avance_diario', 'create'), false);

  const auxiliar = { role: 'Auxiliar' as const, active: true };
  assert.equal(hasModulePermission(auxiliar, 'avance_diario', 'create'), true);
  assert.equal(hasModulePermission(auxiliar, 'avance_diario', 'delete'), false);
  assert.equal(hasModulePermission(auxiliar, 'asistencia', 'create'), true);
  assert.equal(hasModulePermission(auxiliar, 'materiales', 'edit'), false);
  assert.equal(hasModulePermission(auxiliar, 'movimientos', 'view'), false);

  const soloLectura = { role: 'Solo lectura' as const, active: true };
  for (const mod of ALL_MODULES) {
    assert.equal(hasModulePermission(soloLectura, mod, 'view'), true);
    assert.equal(hasModulePermission(soloLectura, mod, 'create'), false);
    assert.equal(hasModulePermission(soloLectura, mod, 'edit'), false);
    assert.equal(hasModulePermission(soloLectura, mod, 'delete'), false);
    assert.equal(hasModulePermission(soloLectura, mod, 'import'), false);
  }
});

test('Scope filtering restricts non-admin users to assigned sectors and galpones', () => {
  const sampleSectors = [
    {
      id: 'sec-1',
      name: 'Sector Norte',
      sheds: [
        { id: 'gal-101', projectCode: 'P-NORTE' },
        { id: 'gal-102', projectCode: 'P-NORTE' }
      ]
    },
    {
      id: 'sec-2',
      name: 'Sector Sur',
      sheds: [
        { id: 'gal-201', projectCode: 'P-SUR' }
      ]
    }
  ];

  const supervisorScoped = {
    role: 'Supervisor' as const,
    active: true,
    assignedProject: '',
    assignedSectorIds: ['sec-1'],
    assignedGalponIds: ['gal-102']
  };

  assert.equal(hasGlobalScope(supervisorScoped), false);
  assert.equal(canAccessSector(supervisorScoped, sampleSectors[0]), true);
  assert.equal(canAccessSector(supervisorScoped, sampleSectors[1]), false);
  assert.equal(canAccessGalpon(supervisorScoped, sampleSectors[0].sheds[0], 'sec-1'), false);
  assert.equal(canAccessGalpon(supervisorScoped, sampleSectors[0].sheds[1], 'sec-1'), true);

  const filtered = filterSectorsByScope(sampleSectors, supervisorScoped);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'sec-1');
  assert.equal(filtered[0].sheds.length, 1);
  assert.equal(filtered[0].sheds[0].id, 'gal-102');
});

test('ETAPA 2 (C-5): Los 6 roles oficiales tienen permisos exactos en Sectores / Galpones (módulo proyectos)', () => {
  const admin = { role: 'Administrador' as const, active: true };
  const jefe = { role: 'Jefe de proyecto' as const, active: true };
  const supervisor = { role: 'Supervisor' as const, active: true };
  const auxiliar = { role: 'Auxiliar' as const, active: true };
  const almacen = { role: 'Almacén' as const, active: true };
  const soloLectura = { role: 'Solo lectura' as const, active: true };

  // Administrador: view, create, edit, delete
  assert.equal(hasModulePermission(admin, 'proyectos', 'view'), true);
  assert.equal(hasModulePermission(admin, 'proyectos', 'create'), true);
  assert.equal(hasModulePermission(admin, 'proyectos', 'edit'), true);
  assert.equal(hasModulePermission(admin, 'proyectos', 'delete'), true);

  // Jefe de proyecto: view, create, edit, pero NO delete
  assert.equal(hasModulePermission(jefe, 'proyectos', 'view'), true);
  assert.equal(hasModulePermission(jefe, 'proyectos', 'create'), true);
  assert.equal(hasModulePermission(jefe, 'proyectos', 'edit'), true);
  assert.equal(hasModulePermission(jefe, 'proyectos', 'delete'), false);

  // Supervisor: view en proyectos (edición operativa se realiza en actividades/gantt/avance_diario/asistencia/personal)
  assert.equal(hasModulePermission(supervisor, 'proyectos', 'view'), true);
  assert.equal(hasModulePermission(supervisor, 'proyectos', 'create'), false);
  assert.equal(hasModulePermission(supervisor, 'proyectos', 'edit'), false);
  assert.equal(hasModulePermission(supervisor, 'proyectos', 'delete'), false);

  // Auxiliar: solo view en proyectos (no puede crear, editar ni eliminar sectores/galpones)
  assert.equal(hasModulePermission(auxiliar, 'proyectos', 'view'), true);
  assert.equal(hasModulePermission(auxiliar, 'proyectos', 'create'), false);
  assert.equal(hasModulePermission(auxiliar, 'proyectos', 'edit'), false);
  assert.equal(hasModulePermission(auxiliar, 'proyectos', 'delete'), false);

  // Almacén: solo view en proyectos
  assert.equal(hasModulePermission(almacen, 'proyectos', 'view'), true);
  assert.equal(hasModulePermission(almacen, 'proyectos', 'create'), false);
  assert.equal(hasModulePermission(almacen, 'proyectos', 'edit'), false);
  assert.equal(hasModulePermission(almacen, 'proyectos', 'delete'), false);

  // Solo lectura: solo view en proyectos
  assert.equal(hasModulePermission(soloLectura, 'proyectos', 'view'), true);
  assert.equal(hasModulePermission(soloLectura, 'proyectos', 'create'), false);
  assert.equal(hasModulePermission(soloLectura, 'proyectos', 'edit'), false);
  assert.equal(hasModulePermission(soloLectura, 'proyectos', 'delete'), false);
});

test('ETAPA 2 (C-5): Usuarios con distintos sectores y galpones asignados ven y operan únicamente sobre su alcance (scopedSectors con propiedad galpones)', () => {
  const realFormattedSectors = [
    {
      id: 'sec_norte',
      code: 'SEC-01',
      name: 'SECTOR NORTE LA CALERA',
      galpones: [
        { id: 'gal_n1', code: 'G-N1', name: 'Galpón Norte 1', technology: 'ZUCAMI' },
        { id: 'gal_n2', code: 'G-N2', name: 'Galpón Norte 2', technology: 'BIG DUTCHMAN' }
      ]
    },
    {
      id: 'sec_sur',
      code: 'SEC-02',
      name: 'SECTOR SUR LA CALERA',
      galpones: [
        { id: 'gal_s1', code: 'G-S1', name: 'Galpón Sur 1', technology: 'ZUCAMI' },
        { id: 'gal_s2', code: 'G-S2', name: 'Galpón Sur 2', technology: 'TECNOPOULTRY' }
      ]
    }
  ];

  const supNorteGalpon2 = {
    role: 'Supervisor' as const,
    active: true,
    assignedSectorIds: ['sec_norte'],
    assignedGalponIds: ['gal_n2']
  };

  const auxSurCompleto = {
    role: 'Auxiliar' as const,
    active: true,
    assignedSectorIds: ['sec_sur'],
    assignedGalponIds: []
  };

  const jefeGlobal = {
    role: 'Jefe de proyecto' as const,
    active: true,
    assignedSectorIds: [],
    assignedGalponIds: []
  };

  const scopedNorte = filterSectorsByScope(realFormattedSectors, supNorteGalpon2);
  assert.equal(scopedNorte.length, 1);
  assert.equal(scopedNorte[0].id, 'sec_norte');
  assert.equal(scopedNorte[0].galpones.length, 1);
  assert.equal(scopedNorte[0].galpones[0].id, 'gal_n2');
  assert.equal(
    canAccessGalpon(supNorteGalpon2, realFormattedSectors[0].galpones[0], 'sec_norte'),
    false
  );
  assert.equal(
    canAccessGalpon(supNorteGalpon2, realFormattedSectors[0].galpones[1], 'sec_norte'),
    true
  );

  const scopedSur = filterSectorsByScope(realFormattedSectors, auxSurCompleto);
  assert.equal(scopedSur.length, 1);
  assert.equal(scopedSur[0].id, 'sec_sur');
  assert.equal(scopedSur[0].galpones.length, 2);

  const scopedJefe = filterSectorsByScope(realFormattedSectors, jefeGlobal);
  assert.equal(scopedJefe.length, 2);
});

