import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_SISTEMA_VALUE,
  getActiveMasterCatalog,
  getCatalogAreas,
  getCatalogSystemsByArea,
  getCatalogStructuresByAreaAndSystem,
  getCatalogActivitiesByHierarchy,
  getMasterCatalogStructuresForEditor,
  deleteStructureFromMasterCatalog,
  applyCatalogStepAreaChange,
  applyCatalogStepSistemaChange,
  applyCatalogStepEstructuraChange,
  applyCatalogStepActivityToggle,
  applyCatalogStepSelectAllActivities,
  assignCatalogActivitiesToSectors,
  type CatalogAssignmentFormState,
  type MasterCatalogRecord
} from './catalogSelectorEngine';
import { hasModulePermission } from '../firebase/permissions';
import type { UserProfile } from '../firebase/authService';
import {
  reconstructCollectionWithOfflineQueue,
  type PendingSyncOperation
} from '../firebase/offlineSyncEngine';

const ALL_AREAS = [
  'Obra Civil',
  'Jaulas',
  'Comederos',
  'Bebederos',
  'Climatización',
  'Electricidad e Iluminación'
];

const AREAS_WITH_SISTEMAS = [
  'Jaulas',
  'Comederos',
  'Bebederos',
  'Climatización',
  'Electricidad e Iluminación'
];

function createInitialFormState(): CatalogAssignmentFormState {
  return {
    useCatalog: true,
    targetGalponId: 'gal_1',
    sharedWithGalponId: '',
    catalogItemId: '',
    selectedCatalogItemIds: [],
    code: '',
    name: '',
    progressMode: 'quantity',
    areaName: '',
    locationType: '',
    sistemaName: '',
    customSistemaName: '',
    structureName: '',
    customStructureName: '',
    targetUnits: '',
    unit: '',
    weight: '',
    plannedHH: '',
    startDate: '2026-11-10',
    dueDate: '2026-11-15'
  };
}

function createSampleCatalog(): MasterCatalogRecord[] {
  return [
    {
      id: 'cat_jau_1',
      technology: 'Big Dutchman',
      code: 'JAU-001',
      name: 'Actividad 1',
      areaName: 'Jaulas',
      locationType: 'Interno',
      sistemaName: 'Sistema de Jaulas',
      structureName: 'Estructura A',
      progressMode: 'quantity',
      targetUnits: 120,
      unit: 'm',
      weight: 1.5,
      plannedHH: 40,
      durationDays: 5
    },
    {
      id: 'cat_jau_2',
      technology: 'Big Dutchman',
      code: 'JAU-002',
      name: 'Actividad 2',
      areaName: 'Jaulas',
      locationType: 'Interno',
      sistemaName: 'Sistema de Jaulas',
      structureName: 'Estructura A',
      progressMode: 'percentage',
      targetUnits: 100,
      unit: '%',
      weight: 2.0,
      plannedHH: 60,
      durationDays: 6
    },
    {
      id: 'cat_jau_3',
      technology: 'Big Dutchman',
      code: 'JAU-003',
      name: 'Actividad 3',
      areaName: 'Jaulas',
      locationType: 'Interno',
      sistemaName: 'Sistema de Jaulas',
      structureName: 'Estructura A',
      progressMode: 'quantity',
      targetUnits: 80,
      unit: 'und',
      weight: 1.0,
      plannedHH: 30,
      durationDays: 4
    },
    {
      id: 'cat_jau_b1',
      technology: 'Big Dutchman',
      code: 'JAU-010',
      name: 'Montaje Pasarela Lateral',
      areaName: 'Jaulas',
      locationType: 'Interno',
      sistemaName: 'Sistema de Jaulas',
      structureName: 'Estructura B',
      progressMode: 'quantity',
      targetUnits: 50,
      unit: 'm',
      weight: 1.2,
      plannedHH: 25,
      durationDays: 3
    },
    {
      id: 'cat_jau_rec1',
      technology: 'Big Dutchman',
      code: 'JAU-020',
      name: 'Instalación Cinta Recolectora',
      areaName: 'Jaulas',
      locationType: 'Externo',
      sistemaName: 'Sistema Recolección Huevos',
      structureName: 'Torre Elevadora',
      progressMode: 'percentage',
      targetUnits: 100,
      unit: '%',
      weight: 2.5,
      plannedHH: 50,
      durationDays: 5
    },
    {
      id: 'cat_com_1',
      technology: 'Big Dutchman',
      code: 'COM-001',
      name: 'Tendido de Cadena Alimentadora',
      areaName: 'Comederos',
      locationType: 'Interno',
      sistemaName: 'Sistema de Alimentación',
      structureName: 'Línea Comedero Norte',
      progressMode: 'quantity',
      targetUnits: 200,
      unit: 'm',
      weight: 1.5,
      plannedHH: 35,
      durationDays: 4
    },
    {
      id: 'cat_civ_1',
      technology: 'Big Dutchman',
      code: 'CIV-001',
      name: 'Vaciado de Losa Principal',
      areaName: 'Obra Civil',
      locationType: 'Interno',
      sistemaName: null,
      structureName: 'Cimentación Base',
      progressMode: 'quantity',
      targetUnits: 350,
      unit: 'm2',
      weight: 3.0,
      plannedHH: 120,
      durationDays: 10
    }
  ];
}

test('Escenario 1: Seleccionar una estructura con actividades maestras muestra todas sus actividades activas', () => {
  const catalog = createSampleCatalog();
  const acts = getCatalogActivitiesByHierarchy(
    catalog,
    'Jaulas',
    'Sistema de Jaulas',
    'Estructura A'
  );
  assert.equal(acts.length, 3);
  assert.deepEqual(
    acts.map((a) => a.name),
    ['Actividad 1', 'Actividad 2', 'Actividad 3']
  );
});

test('Escenario 2: Eliminar una actividad maestra (baja física o lógica) y volver a seleccionar la estructura no muestra la eliminada', () => {
  const catalog = createSampleCatalog();

  // Caso A: Baja física (filtrada del arreglo de catálogo)
  const afterPhysicalDelete = catalog.filter((c) => c.id !== 'cat_jau_2');
  const actsPhysical = getCatalogActivitiesByHierarchy(
    afterPhysicalDelete,
    'Jaulas',
    'Sistema de Jaulas',
    'Estructura A'
  );
  assert.equal(actsPhysical.length, 2);
  assert.deepEqual(
    actsPhysical.map((a) => a.name),
    ['Actividad 1', 'Actividad 3']
  );

  // Caso B: Baja lógica (deletedAt / active: false / deleted: true)
  const afterLogicalDelete = catalog.map((c) =>
    c.id === 'cat_jau_2'
      ? { ...c, deletedAt: '2026-11-06T20:00:00Z', active: false, deleted: true }
      : c
  );
  const actsLogical = getCatalogActivitiesByHierarchy(
    afterLogicalDelete,
    'Jaulas',
    'Sistema de Jaulas',
    'Estructura A'
  );
  assert.equal(actsLogical.length, 2);
  assert.deepEqual(
    actsLogical.map((a) => a.name),
    ['Actividad 1', 'Actividad 3']
  );
});

test('Escenario 3: Eliminar una estructura del catálogo y volver a crearla con Actividad 4 no reaparece Actividad 1, 2 ni 3', () => {
  const catalog = createSampleCatalog();

  // Eliminar "Estructura A" completa del Catálogo Maestro
  const { remainingCatalog, removedItems } = deleteStructureFromMasterCatalog(catalog, {
    areaName: 'Jaulas',
    sistemaName: 'Sistema de Jaulas',
    structureName: 'Estructura A'
  });
  assert.equal(removedItems.length, 3);

  // Verificar que "Estructura A" ya no aparece como estructura disponible en el sistema
  const structuresAfterDelete = getCatalogStructuresByAreaAndSystem(
    remainingCatalog,
    'Jaulas',
    'Sistema de Jaulas'
  );
  assert.deepEqual(structuresAfterDelete, ['Estructura B']);

  // Crear nuevamente "Estructura A" únicamente con "Actividad 4"
  const recreatedCatalog: MasterCatalogRecord[] = [
    ...remainingCatalog,
    {
      id: 'cat_jau_4_new',
      technology: 'Big Dutchman',
      code: 'JAU-004',
      name: 'Actividad 4',
      areaName: 'Jaulas',
      locationType: 'Interno',
      sistemaName: 'Sistema de Jaulas',
      structureName: 'Estructura A',
      progressMode: 'quantity',
      targetUnits: 90,
      unit: 'm',
      weight: 1.0,
      plannedHH: 20,
      durationDays: 3
    }
  ];

  const structuresAfterRecreate = getCatalogStructuresByAreaAndSystem(
    recreatedCatalog,
    'Jaulas',
    'Sistema de Jaulas'
  );
  assert.deepEqual(structuresAfterRecreate, ['Estructura B', 'Estructura A']);

  const actsInRecreatedStructure = getCatalogActivitiesByHierarchy(
    recreatedCatalog,
    'Jaulas',
    'Sistema de Jaulas',
    'Estructura A'
  );
  assert.equal(actsInRecreatedStructure.length, 1);
  assert.equal(actsInRecreatedStructure[0].name, 'Actividad 4');
  assert.equal(actsInRecreatedStructure[0].code, 'JAU-004');
});

test('Escenario 4: Seleccionar un área muestra únicamente los sistemas activos de esa área en el Catálogo Maestro', () => {
  const catalog = createSampleCatalog();
  const areas = getCatalogAreas(catalog, ALL_AREAS);
  assert.deepEqual(areas, ['Obra Civil', 'Jaulas', 'Comederos']);

  const jaulasSystems = getCatalogSystemsByArea(catalog, 'Jaulas');
  assert.deepEqual(
    jaulasSystems.map((s) => s.value),
    ['Sistema de Jaulas', 'Sistema Recolección Huevos']
  );

  const comederosSystems = getCatalogSystemsByArea(catalog, 'Comederos');
  assert.deepEqual(
    comederosSystems.map((s) => s.value),
    ['Sistema de Alimentación']
  );

  const obraCivilSystems = getCatalogSystemsByArea(catalog, 'Obra Civil');
  assert.deepEqual(
    obraCivilSystems.map((s) => s.value),
    [NO_SISTEMA_VALUE]
  );
});

test('Escenario 5: Seleccionar un sistema muestra únicamente las estructuras activas de ese sistema y área', () => {
  const catalog = createSampleCatalog();
  const jaulasStructures = getCatalogStructuresByAreaAndSystem(
    catalog,
    'Jaulas',
    'Sistema de Jaulas'
  );
  assert.deepEqual(jaulasStructures, ['Estructura A', 'Estructura B']);

  const recoleccionStructures = getCatalogStructuresByAreaAndSystem(
    catalog,
    'Jaulas',
    'Sistema Recolección Huevos'
  );
  assert.deepEqual(recoleccionStructures, ['Torre Elevadora']);

  // Verificar que el editor del Catálogo Maestro tampoco mezcle estructuras de otras áreas
  const editorStructuresComederos = getMasterCatalogStructuresForEditor(
    catalog,
    'Comederos',
    'Sistema de Alimentación'
  );
  assert.deepEqual(editorStructuresComederos, ['Línea Comedero Norte']);
});

test('Escenario 6: Seleccionar una estructura muestra únicamente las actividades activas de esa estructura', () => {
  const catalog = createSampleCatalog();
  const actsB = getCatalogActivitiesByHierarchy(
    catalog,
    'Jaulas',
    'Sistema de Jaulas',
    'Estructura B'
  );
  assert.equal(actsB.length, 1);
  assert.equal(actsB[0].code, 'JAU-010');
  assert.equal(actsB[0].name, 'Montaje Pasarela Lateral');
});

test('Escenario 7: Cambiar de Área, Sistema o Estructura limpia automáticamente las selecciones dependientes', () => {
  const catalog = createSampleCatalog();
  let state = createInitialFormState();

  // Paso 1: Área Jaulas
  state = applyCatalogStepAreaChange(state, 'Jaulas', catalog);
  assert.equal(state.areaName, 'Jaulas');
  assert.equal(state.sistemaName, '');
  assert.equal(state.structureName, '');
  assert.deepEqual(state.selectedCatalogItemIds, []);

  // Paso 2: Sistema de Jaulas
  state = applyCatalogStepSistemaChange(state, 'Sistema de Jaulas', catalog);
  assert.equal(state.sistemaName, 'Sistema de Jaulas');
  assert.equal(state.structureName, '');

  // Paso 3: Estructura A
  state = applyCatalogStepEstructuraChange(state, 'Estructura A');
  assert.equal(state.structureName, 'Estructura A');

  // Paso 4: Seleccionar Actividad 1 y Actividad 2
  const availableActs = getCatalogActivitiesByHierarchy(
    catalog,
    state.areaName,
    state.sistemaName,
    state.structureName
  );
  state = applyCatalogStepActivityToggle(state, 'cat_jau_1', availableActs);
  state = applyCatalogStepActivityToggle(state, 'cat_jau_2', availableActs);
  assert.deepEqual(state.selectedCatalogItemIds, ['cat_jau_1', 'cat_jau_2']);
  assert.equal(state.code, 'JAU-001');
  assert.equal(state.name, 'Actividad 1');

  // Cambiar Estructura -> limpia actividades seleccionadas pero conserva Área y Sistema
  const afterStructureChange = applyCatalogStepEstructuraChange(state, 'Estructura B');
  assert.equal(afterStructureChange.areaName, 'Jaulas');
  assert.equal(afterStructureChange.sistemaName, 'Sistema de Jaulas');
  assert.equal(afterStructureChange.structureName, 'Estructura B');
  assert.deepEqual(afterStructureChange.selectedCatalogItemIds, []);
  assert.equal(afterStructureChange.code, '');
  assert.equal(afterStructureChange.name, '');

  // Cambiar Sistema -> limpia Estructura y Actividades
  const afterSistemaChange = applyCatalogStepSistemaChange(
    state,
    'Sistema Recolección Huevos',
    catalog
  );
  assert.equal(afterSistemaChange.areaName, 'Jaulas');
  assert.equal(afterSistemaChange.sistemaName, 'Sistema Recolección Huevos');
  assert.equal(afterSistemaChange.structureName, '');
  assert.deepEqual(afterSistemaChange.selectedCatalogItemIds, []);
  assert.equal(afterSistemaChange.code, '');

  // Cambiar Área -> limpia Sistema, Estructura y Actividades
  const afterAreaChange = applyCatalogStepAreaChange(state, 'Comederos', catalog);
  assert.equal(afterAreaChange.areaName, 'Comederos');
  assert.equal(afterAreaChange.sistemaName, '');
  assert.equal(afterAreaChange.structureName, '');
  assert.deepEqual(afterAreaChange.selectedCatalogItemIds, []);
  assert.equal(afterAreaChange.code, '');
  assert.equal(afterAreaChange.name, '');
});

test('Escenarios 8, 9 y 10: Asignar varias actividades a un galpón, asignar a otro sin modificar el anterior y evitar duplicados', () => {
  const catalog = createSampleCatalog();
  let seq = 1;
  const genId = (prefix: string) => `${prefix}_${seq++}`;

  const initialSectors = [
    {
      id: 'sec_1',
      code: 'SEC-01',
      name: 'SECTOR NORTE',
      galpones: [
        {
          id: 'gal_1',
          code: 'GAL-01',
          name: 'GALPÓN 1',
          areas: []
        },
        {
          id: 'gal_2',
          code: 'GAL-02',
          name: 'GALPÓN 2',
          areas: []
        }
      ]
    }
  ];

  // Escenario 8: Seleccionar todas las actividades de Estructura A (3 actividades) y agregarlas a GAL-01
  let formState = createInitialFormState();
  formState = applyCatalogStepAreaChange(formState, 'Jaulas', catalog);
  formState = applyCatalogStepSistemaChange(formState, 'Sistema de Jaulas', catalog);
  formState = applyCatalogStepEstructuraChange(formState, 'Estructura A');
  const availableActsA = getCatalogActivitiesByHierarchy(
    catalog,
    formState.areaName,
    formState.sistemaName,
    formState.structureName
  );
  formState = applyCatalogStepSelectAllActivities(formState, availableActsA, true);
  assert.equal(formState.selectedCatalogItemIds.length, 3);

  const selectedItemsA = availableActsA.filter((a) =>
    formState.selectedCatalogItemIds.includes(a.id)
  );

  const resGal1 = assignCatalogActivitiesToSectors({
    sectors: initialSectors,
    catalogItemsToAssign: selectedItemsA,
    targetGalponIds: ['gal_1'],
    startDate: '2026-11-10',
    dueDate: '2026-11-15',
    updatedBy: 'Admin Test',
    nowIso: '2026-11-06T21:00:00Z',
    allAreas: ALL_AREAS,
    areasWithSistemas: AREAS_WITH_SISTEMAS,
    generateIdFn: genId
  });

  assert.equal(resGal1.addedCount, 3);
  assert.equal(resGal1.skippedDuplicatesCount, 0);

  const gal1After = resGal1.updatedSectors[0].galpones[0];
  const gal2AfterFirst = resGal1.updatedSectors[0].galpones[1];
  const gal1Jaulas = gal1After.areas.find((a: any) => a.name === 'Jaulas');
  assert.equal(gal1Jaulas.sistemas.length, 1);
  assert.equal(gal1Jaulas.sistemas[0].structures.length, 1);
  assert.equal(gal1Jaulas.sistemas[0].structures[0].activities.length, 3);
  assert.equal(gal2AfterFirst.areas.length, 0);

  // Escenario 9: Agregar una actividad de Comederos a GAL-02 sin modificar GAL-01
  const snapshotGal1Json = JSON.stringify(gal1After);
  const comederosActs = getCatalogActivitiesByHierarchy(
    catalog,
    'Comederos',
    'Sistema de Alimentación',
    'Línea Comedero Norte'
  );
  const resGal2 = assignCatalogActivitiesToSectors({
    sectors: resGal1.updatedSectors,
    catalogItemsToAssign: comederosActs,
    targetGalponIds: ['gal_2'],
    startDate: '2026-11-12',
    dueDate: '2026-11-18',
    updatedBy: 'Admin Test',
    nowIso: '2026-11-06T21:05:00Z',
    allAreas: ALL_AREAS,
    areasWithSistemas: AREAS_WITH_SISTEMAS,
    generateIdFn: genId
  });

  assert.equal(resGal2.addedCount, 1);
  assert.equal(
    JSON.stringify(resGal2.updatedSectors[0].galpones[0]),
    snapshotGal1Json,
    'GAL-01 no debe modificarse cuando se asignan actividades a GAL-02'
  );
  const gal2Comederos = resGal2.updatedSectors[0].galpones[1].areas.find(
    (a: any) => a.name === 'Comederos'
  );
  assert.equal(gal2Comederos.sistemas[0].structures[0].activities.length, 1);

  // Escenario 10: Intentar agregar nuevamente las mismas 3 actividades a GAL-01 no genera duplicados
  const resDuplicateAttempt = assignCatalogActivitiesToSectors({
    sectors: resGal2.updatedSectors,
    catalogItemsToAssign: selectedItemsA,
    targetGalponIds: ['gal_1'],
    startDate: '2026-11-10',
    dueDate: '2026-11-15',
    updatedBy: 'Admin Test',
    nowIso: '2026-11-06T21:10:00Z',
    allAreas: ALL_AREAS,
    areasWithSistemas: AREAS_WITH_SISTEMAS,
    generateIdFn: genId
  });
  assert.equal(resDuplicateAttempt.addedCount, 0);
  assert.equal(resDuplicateAttempt.skippedDuplicatesCount, 3);
  const gal1JaulasAfterDup = resDuplicateAttempt.updatedSectors[0].galpones[0].areas.find(
    (a: any) => a.name === 'Jaulas'
  );
  assert.equal(gal1JaulasAfterDup.sistemas[0].structures[0].activities.length, 3);
});

test('Escenario 11: Permisos por rol para Catálogo Maestro y Gestión de Actividades se mantienen intactos', () => {
  const adminProfile: UserProfile = {
    uid: 'u_admin',
    email: 'admin@calera.pe',
    displayName: 'Admin',
    role: 'Administrador',
    active: true,
    assignedSectorIds: ['ALL'],
    assignedGalponIds: ['ALL'],
    createdAt: '2026-11-01',
    createdBy: 'system',
    updatedAt: '2026-11-01',
    updatedBy: 'system'
  };
  const jefeProfile: UserProfile = {
    ...adminProfile,
    uid: 'u_jefe',
    role: 'Jefe de proyecto'
  };
  const supervisorProfile: UserProfile = {
    ...adminProfile,
    uid: 'u_sup',
    role: 'Supervisor'
  };
  const auxiliarProfile: UserProfile = {
    ...adminProfile,
    uid: 'u_aux',
    role: 'Auxiliar'
  };
  const lecturaProfile: UserProfile = {
    ...adminProfile,
    uid: 'u_lec',
    role: 'Solo lectura'
  };

  assert.equal(hasModulePermission(adminProfile, 'catalogo', 'delete'), true);
  assert.equal(hasModulePermission(adminProfile, 'actividades', 'create'), true);
  assert.equal(hasModulePermission(jefeProfile, 'catalogo', 'create'), true);
  assert.equal(hasModulePermission(jefeProfile, 'catalogo', 'edit'), true);
  assert.equal(hasModulePermission(jefeProfile, 'catalogo', 'delete'), false);
  assert.equal(hasModulePermission(jefeProfile, 'actividades', 'create'), true);
  assert.equal(hasModulePermission(jefeProfile, 'actividades', 'delete'), true);
  assert.equal(hasModulePermission(supervisorProfile, 'actividades', 'create'), true);
  assert.equal(hasModulePermission(supervisorProfile, 'catalogo', 'delete'), false);
  assert.equal(hasModulePermission(auxiliarProfile, 'actividades', 'create'), false);
  assert.equal(hasModulePermission(lecturaProfile, 'actividades', 'create'), false);
});

test('Escenario 12: Reconstrucción online y offline del Catálogo Maestro respeta altas, eliminaciones en cola y bajas lógicas', () => {
  const remoteCatalog = createSampleCatalog();
  const offlineQueue: PendingSyncOperation[] = [
    {
      operationId: 'op_del_1',
      deviceId: 'dev_1',
      userId: 'u_admin',
      userDisplayName: 'Admin',
      userRole: 'Administrador',
      createdAt: '2026-11-06T21:00:00Z',
      collectionName: 'masterCatalog',
      documentId: 'cat_jau_2',
      operationType: 'delete',
      status: 'pending_sync',
      retryCount: 0
    },
    {
      operationId: 'op_add_4',
      deviceId: 'dev_1',
      userId: 'u_admin',
      userDisplayName: 'Admin',
      userRole: 'Administrador',
      createdAt: '2026-11-06T21:01:00Z',
      collectionName: 'masterCatalog',
      documentId: 'cat_jau_4',
      operationType: 'upsert',
      payload: {
        id: 'cat_jau_4',
        technology: 'Big Dutchman',
        code: 'JAU-004',
        name: 'Actividad 4 Offline',
        areaName: 'Jaulas',
        locationType: 'Interno',
        sistemaName: 'Sistema de Jaulas',
        structureName: 'Estructura A',
        progressMode: 'quantity',
        targetUnits: 60,
        unit: 'm',
        weight: 1.0,
        plannedHH: 15,
        durationDays: 2
      },
      status: 'pending_sync',
      retryCount: 0
    }
  ];

  const reconstructed = reconstructCollectionWithOfflineQueue(
    remoteCatalog,
    offlineQueue,
    'masterCatalog'
  );
  const active = getActiveMasterCatalog(reconstructed);
  const actsEstructuraA = getCatalogActivitiesByHierarchy(
    active,
    'Jaulas',
    'Sistema de Jaulas',
    'Estructura A'
  );

  assert.deepEqual(
    actsEstructuraA.map((a) => a.name),
    ['Actividad 1', 'Actividad 3', 'Actividad 4 Offline']
  );
});
