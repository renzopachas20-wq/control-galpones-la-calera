import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGanttActivity,
  evaluateGanttDayCell,
  buildGanttCalendarModel,
  buildGanttHierarchyRows,
  formatUbicacionSistema,
  sortGanttActivitiesByStartDate,
  extractDynamicGanttAreas,
  filterAndSortGanttActivities,
  shiftGanttDateRange
} from './ganttEngine';

test('Gantt Estructura y Jerarquía — Código, Área, Ubicación / Sistema, Estructura y Actividad coinciden con Gestión de Actividades', () => {
  // Caso 1: Área con Sistema + Ubicación (Interno/Externo)
  const actConSistema = evaluateGanttActivity(
    {
      id: 'firestore-internal-id-123',
      code: 'ACT-01',
      name: 'Montaje de Estructura Principal',
      areaName: 'Equipamiento Avícola',
      hasSistema: true,
      sistemaName: 'Sistema de Jaulas',
      locationType: 'Interno',
      structureName: 'Módulo Central',
      progressMode: 'quantity',
      targetUnits: 100,
      unit: 'm2',
      startDate: '2026-08-07',
      dueDate: '2026-08-12'
    },
    [],
    '2026-08-05',
    0
  );

  // Nunca muestra el ID interno en la columna Código
  assert.equal(actConSistema.code, 'ACT-01');
  assert.notEqual(actConSistema.code, 'firestore-internal-id-123');
  assert.equal(actConSistema.areaName, 'Equipamiento Avícola');
  assert.equal(actConSistema.ubicacionSistemaLabel, 'Sistema de Jaulas / Interno');
  assert.equal(actConSistema.structureName, 'Módulo Central');
  assert.equal(actConSistema.name, 'Montaje de Estructura Principal');

  // Caso 2: Área sin Sistema (Obra Civil) -> Ubicación / Sistema muestra "—" sin desplazar columnas
  const actSinSistema = evaluateGanttActivity(
    {
      id: 'firestore-internal-id-456',
      code: 'ACT-02',
      name: 'Vaciado de Losa',
      areaName: 'Obra Civil',
      hasSistema: false,
      sistemaName: null,
      locationType: 'Interno',
      structureName: 'Piso Nave 1',
      progressMode: 'quantity',
      targetUnits: 50,
      unit: 'm3',
      startDate: '2026-08-01',
      dueDate: '2026-08-06'
    },
    [],
    '2026-08-05',
    1
  );

  assert.equal(actSinSistema.code, 'ACT-02');
  assert.equal(actSinSistema.areaName, 'Obra Civil');
  assert.equal(actSinSistema.ubicacionSistemaLabel, '—');
  assert.equal(actSinSistema.structureName, 'Piso Nave 1');
  assert.equal(actSinSistema.name, 'Vaciado de Losa');
  assert.equal(formatUbicacionSistema({ hasSistema: false, locationType: 'Externo' }), '—');
});

test('Gantt Ordenamiento Automático — fechas pasadas, fecha actual, fechas futuras, misma fecha de inicio y sin fecha de inicio', () => {
  const rawList = [
    {
      id: '1',
      code: 'A-SIN-FECHA',
      name: 'Actividad sin fecha',
      areaName: 'Obra Civil',
      structureName: 'S1',
      startDate: '',
      dueDate: ''
    },
    {
      id: '2',
      code: 'A-FUTURA',
      name: 'Actividad futura',
      areaName: 'Obra Civil',
      structureName: 'S1',
      startDate: '2026-08-20',
      dueDate: '2026-08-25'
    },
    {
      id: '3',
      code: 'A-EMPATE-1',
      name: 'Actividad empate primero en Gestión',
      areaName: 'Obra Civil',
      structureName: 'S1',
      startDate: '2026-08-10',
      dueDate: '2026-08-15'
    },
    {
      id: '4',
      code: 'A-PASADA',
      name: 'Actividad pasada',
      areaName: 'Obra Civil',
      structureName: 'S1',
      startDate: '2026-08-01',
      dueDate: '2026-08-05'
    },
    {
      id: '5',
      code: 'A-EMPATE-2',
      name: 'Actividad empate segundo en Gestión',
      areaName: 'Obra Civil',
      structureName: 'S1',
      startDate: '2026-08-10',
      dueDate: '2026-08-18'
    },
    {
      id: '6',
      code: 'A-HOY',
      name: 'Actividad hoy',
      areaName: 'Obra Civil',
      structureName: 'S1',
      startDate: '2026-08-07',
      dueDate: '2026-08-12'
    }
  ];

  const evaluated = rawList.map((a, idx) =>
    evaluateGanttActivity(a, [], '2026-08-07', idx)
  );
  const sorted = sortGanttActivitiesByStartDate(evaluated);

  assert.deepEqual(
    sorted.map((a) => a.code),
    [
      'A-PASADA', // 2026-08-01
      'A-HOY', // 2026-08-07
      'A-EMPATE-1', // 2026-08-10 (originalIndex 2)
      'A-EMPATE-2', // 2026-08-10 (originalIndex 4)
      'A-FUTURA', // 2026-08-20
      'A-SIN-FECHA' // sin fecha al final
    ]
  );

  // Si cambia la fecha de inicio de A-FUTURA a 2026-07-28, se reordena automáticamente al inicio
  const updatedList = rawList.map((a) =>
    a.code === 'A-FUTURA' ? { ...a, startDate: '2026-07-28' } : a
  );
  const reSorted = sortGanttActivitiesByStartDate(
    updatedList.map((a, idx) => evaluateGanttActivity(a, [], '2026-08-07', idx))
  );
  assert.equal(reSorted[0].code, 'A-FUTURA');
});

test('Gantt Columna Fase — Estados automáticos (NO INICIADO, EN PROGRESO, COMPLETADO) y condiciones (ATRASADO, ADELANTADO)', () => {
  // 1. NO INICIADO (en plazo)
  const noIniciado = evaluateGanttActivity(
    {
      id: 's1',
      code: 'S1',
      name: 'Act 1',
      areaName: 'Área A',
      structureName: 'Est 1',
      progressMode: 'quantity',
      targetUnits: 100,
      startDate: '2026-08-07',
      dueDate: '2026-08-12'
    },
    [],
    '2026-08-12', // El mismo día de vencimiento sigue vigente todo el día
    0
  );
  assert.equal(noIniciado.phaseState, 'NO_INICIADO');
  assert.equal(noIniciado.phaseStateLabel, 'NO INICIADO');
  assert.equal(noIniciado.isOverdue, false);
  assert.equal(noIniciado.isAhead, false);

  // 2. NO INICIADO + ATRASADO (día posterior al vencimiento con 0%)
  const noIniciadoAtrasado = evaluateGanttActivity(
    {
      id: 's2',
      code: 'S2',
      name: 'Act 2',
      areaName: 'Área A',
      structureName: 'Est 1',
      progressMode: 'quantity',
      targetUnits: 100,
      startDate: '2026-08-07',
      dueDate: '2026-08-12'
    },
    [],
    '2026-08-13',
    1
  );
  assert.equal(noIniciadoAtrasado.phaseState, 'NO_INICIADO');
  assert.equal(noIniciadoAtrasado.isOverdue, true);
  assert.equal(noIniciadoAtrasado.primaryCondition, 'ATRASADO');

  // 3. EN PROGRESO + ADELANTADO (registro antes de startDate)
  const enProgresoAdelantado = evaluateGanttActivity(
    {
      id: 's3',
      code: 'S3',
      name: 'Act 3',
      areaName: 'Área A',
      structureName: 'Est 1',
      progressMode: 'quantity',
      targetUnits: 100,
      startDate: '2026-08-07',
      dueDate: '2026-08-12'
    },
    [{ id: 'l1', date: '2026-08-05', quantityToday: 25 }],
    '2026-08-06',
    2
  );
  assert.equal(enProgresoAdelantado.phaseState, 'EN_PROGRESO');
  assert.equal(enProgresoAdelantado.phaseStateLabel, 'EN PROGRESO');
  assert.equal(enProgresoAdelantado.isAhead, true);
  assert.equal(enProgresoAdelantado.isOverdue, false);
  assert.equal(enProgresoAdelantado.primaryCondition, 'ADELANTADO');

  // 4. COMPLETADO (100%) NUNCA se marca como ATRASADO aunque hoy sea posterior a dueDate
  const completado = evaluateGanttActivity(
    {
      id: 's4',
      code: 'S4',
      name: 'Act 4',
      areaName: 'Área B',
      structureName: 'Est 2',
      progressMode: 'percentage',
      targetUnits: 100,
      startDate: '2026-08-07',
      dueDate: '2026-08-12'
    },
    [
      {
        id: 'l2',
        date: '2026-08-14',
        progressMode: 'percentage',
        percentageReached: 100,
        quantityToday: 100
      }
    ],
    '2026-08-25',
    3
  );
  assert.equal(completado.phaseState, 'COMPLETADO');
  assert.equal(completado.phaseStateLabel, 'COMPLETADO');
  assert.equal(completado.progressPercent, 100);
  assert.equal(completado.isOverdue, false);
  assert.equal(completado.primaryCondition, null);
});

test('Gantt Filtros Dinámicos — Área individual, Todos los estados, cada estado/condición, filtro combinado y limpieza', () => {
  const act1 = evaluateGanttActivity(
    {
      id: 'f1',
      code: 'F-01',
      name: 'Cimentación',
      areaName: 'Obra Civil',
      structureName: 'Nave',
      progressMode: 'quantity',
      targetUnits: 100,
      startDate: '2026-08-02',
      dueDate: '2026-08-10'
    },
    [],
    '2026-08-05',
    0
  ); // NO_INICIADO

  const act2 = evaluateGanttActivity(
    {
      id: 'f2',
      code: 'F-02',
      name: 'Jaulas Nivel 1',
      areaName: 'Sistema de Jaulas',
      sistemaName: 'Batería A',
      locationType: 'Interno',
      structureName: 'Módulo 1',
      progressMode: 'quantity',
      targetUnits: 100,
      startDate: '2026-08-08',
      dueDate: '2026-08-15'
    },
    [{ id: 'lf2', date: '2026-08-05', quantityToday: 30 }],
    '2026-08-05',
    1
  ); // EN_PROGRESO + ADELANTADO

  const act3 = evaluateGanttActivity(
    {
      id: 'f3',
      code: 'F-03',
      name: 'Comederos Automáticos',
      areaName: 'Sistema de Jaulas',
      sistemaName: 'Batería B',
      locationType: 'Interno',
      structureName: 'Módulo 2',
      progressMode: 'quantity',
      targetUnits: 100,
      startDate: '2026-08-01',
      dueDate: '2026-08-03'
    },
    [{ id: 'lf3', date: '2026-08-02', quantityToday: 40 }],
    '2026-08-05',
    2
  ); // EN_PROGRESO + ATRASADO

  const act4 = evaluateGanttActivity(
    {
      id: 'f4',
      code: 'F-04',
      name: 'Tablero General',
      areaName: 'Sistema Eléctrico',
      structureName: 'Sala Eléctrica',
      progressMode: 'percentage',
      targetUnits: 100,
      startDate: '2026-08-01',
      dueDate: '2026-08-04'
    },
    [{ id: 'lf4', date: '2026-08-03', progressMode: 'percentage', percentageReached: 100 }],
    '2026-08-05',
    3
  ); // COMPLETADO

  const allActs = [act1, act2, act3, act4];
  const dynamicAreas = extractDynamicGanttAreas(
    { areas: [{ name: 'Obra Civil' }, { name: 'Sistema de Jaulas' }] },
    allActs
  );
  assert.deepEqual(dynamicAreas, [
    'Obra Civil',
    'Sistema de Jaulas',
    'Sistema Eléctrico'
  ]);

  // Todas las áreas + Todos los estados (ordenados por startDate)
  const allFiltered = filterAndSortGanttActivities(allActs, {
    areaFilter: 'ALL',
    statusFilter: 'ALL'
  });
  assert.deepEqual(
    allFiltered.map((a) => a.code),
    ['F-03', 'F-04', 'F-01', 'F-02']
  );

  // Filtro por área individual
  const jaulasOnly = filterAndSortGanttActivities(allActs, {
    areaFilter: 'Sistema de Jaulas',
    statusFilter: 'ALL'
  });
  assert.deepEqual(
    jaulasOnly.map((a) => a.code),
    ['F-03', 'F-02']
  );

  // Filtro por cada estado / condición
  assert.deepEqual(
    filterAndSortGanttActivities(allActs, { statusFilter: 'NO_INICIADO' }).map(
      (a) => a.code
    ),
    ['F-01']
  );
  assert.deepEqual(
    filterAndSortGanttActivities(allActs, { statusFilter: 'EN_PROGRESO' }).map(
      (a) => a.code
    ),
    ['F-03', 'F-02']
  );
  assert.deepEqual(
    filterAndSortGanttActivities(allActs, { statusFilter: 'COMPLETADO' }).map(
      (a) => a.code
    ),
    ['F-04']
  );
  assert.deepEqual(
    filterAndSortGanttActivities(allActs, { statusFilter: 'ATRASADO' }).map(
      (a) => a.code
    ),
    ['F-03']
  );
  assert.deepEqual(
    filterAndSortGanttActivities(allActs, { statusFilter: 'ADELANTADO' }).map(
      (a) => a.code
    ),
    ['F-02']
  );

  // Filtro combinado Área + Estado
  assert.deepEqual(
    filterAndSortGanttActivities(allActs, {
      areaFilter: 'Sistema de Jaulas',
      statusFilter: 'ADELANTADO'
    }).map((a) => a.code),
    ['F-02']
  );

  // Navegación del cronograma (anterior / siguiente)
  const shiftedPrev = shiftGanttDateRange('2026-08-10', '2026-08-30', 'prev', 'day');
  assert.equal(shiftedPrev.fromDate, '2026-08-03');
  assert.equal(shiftedPrev.toDate, '2026-08-23');
});

test('Gantt Opción C — Ejemplo oficial (Inicio 07/08/2026, Fin 12/08/2026): planificación gris, registros anticipados en azul y múltiples registros el mismo día consolidados', () => {
  const activity = {
    id: 'act-ejemplo-1',
    code: 'ACT-01',
    name: 'Montaje de Estructura Principal',
    areaName: 'Sistema de Jaulas',
    sistemaName: 'Jaulas Nivel 1',
    structureName: 'Estructura A',
    progressMode: 'quantity',
    targetUnits: 100,
    unit: 'm2',
    startDate: '2026-08-07',
    dueDate: '2026-08-12'
  };

  // Registros: uno anticipado el 05/08 (20 m2) y dos registros el mismo día 08/08 (18 m2 + 12 m2 = 30 m2)
  const logs = [
    {
      id: 'log-1',
      activityId: 'act-ejemplo-1',
      activityCode: 'ACT-01',
      date: '2026-08-05',
      quantityToday: 20,
      hoursWorked: 8
    },
    {
      id: 'log-2a',
      activityId: 'act-ejemplo-1',
      activityCode: 'ACT-01',
      date: '2026-08-08',
      quantityToday: 18,
      hoursWorked: 5
    },
    {
      id: 'log-2b',
      activityId: 'act-ejemplo-1',
      activityCode: 'ACT-01',
      date: '2026-08-08',
      quantityToday: 12,
      hoursWorked: 5
    }
  ];

  const evaluated = evaluateGanttActivity(activity, logs, '2026-08-05');
  assert.equal(evaluated.progressPercent, 50);
  assert.deepEqual(evaluated.executedDates, ['2026-08-05', '2026-08-08']);
  assert.equal(evaluated.logsByDate['2026-08-08'].logsCount, 2);
  assert.equal(evaluated.logsByDate['2026-08-08'].totalQuantityToday, 30);

  // Día 05/08 (anterior al inicio 07/08 con registro real) -> Azul
  const cell05 = evaluateGanttDayCell({
    date: '2026-08-05',
    startDate: evaluated.startDate,
    dueDate: evaluated.dueDate,
    progressPercent: evaluated.progressPercent,
    logsByDate: evaluated.logsByDate
  });
  assert.equal(cell05.isPlanned, false);
  assert.equal(cell05.hasRealExecution, true);
  assert.equal(cell05.executionColor, 'blue');
  assert.equal(cell05.cellColor, 'blue');

  // Día 07/08 (dentro del plazo sin registro ese día) -> Gris (Capa 1 Planificación)
  const cell07 = evaluateGanttDayCell({
    date: '2026-08-07',
    startDate: evaluated.startDate,
    dueDate: evaluated.dueDate,
    progressPercent: evaluated.progressPercent,
    logsByDate: evaluated.logsByDate
  });
  assert.equal(cell07.isPlanned, true);
  assert.equal(cell07.hasRealExecution, false);
  assert.equal(cell07.cellColor, 'gray');

  // Día 08/08 (dentro del plazo con registro real consolidado) -> Verde (Capa 2 Ejecución en plazo)
  const cell08 = evaluateGanttDayCell({
    date: '2026-08-08',
    startDate: evaluated.startDate,
    dueDate: evaluated.dueDate,
    progressPercent: evaluated.progressPercent,
    logsByDate: evaluated.logsByDate
  });
  assert.equal(cell08.isPlanned, true);
  assert.equal(cell08.hasRealExecution, true);
  assert.equal(cell08.executionColor, 'green');
  assert.equal(cell08.cellColor, 'green');
});

test('Gantt Opción C — Modalidad Porcentaje (10% -> 20% -> 30% = 30%, nunca 60%), vencimientos en rojo y completado 100% en verde oscuro', () => {
  const activity = {
    id: 'act-pct',
    code: 'ACT-02',
    name: 'Instalación de Comederos',
    areaName: 'Sistema de Jaulas',
    structureName: 'Línea 1',
    progressMode: 'percentage',
    targetUnits: 100,
    unit: '%',
    startDate: '2026-08-07',
    dueDate: '2026-08-12'
  };

  // Registros: 10% -> 20% -> 30% (el último el 14/08 después del vencimiento)
  const logs = [
    {
      id: 'p1',
      activityId: 'act-pct',
      activityCode: 'ACT-02',
      date: '2026-08-08',
      progressMode: 'percentage',
      percentageReached: 10,
      quantityToday: 10
    },
    {
      id: 'p2',
      activityId: 'act-pct',
      activityCode: 'ACT-02',
      date: '2026-08-10',
      progressMode: 'percentage',
      percentageReached: 20,
      quantityToday: 20
    },
    {
      id: 'p3',
      activityId: 'act-pct',
      activityCode: 'ACT-02',
      date: '2026-08-14',
      progressMode: 'percentage',
      percentageReached: 30,
      quantityToday: 30
    }
  ];

  const evaluated = evaluateGanttActivity(activity, logs, '2026-08-15');
  // Último porcentaje válido = 30%, nunca 60%
  assert.equal(evaluated.progressPercent, 30);
  assert.equal(evaluated.phaseState, 'EN_PROGRESO');
  assert.equal(evaluated.isOverdue, true);

  // Día 13/08 (vencido pero SIN registro ese día): NO inventa barra roja
  const cell13 = evaluateGanttDayCell({
    date: '2026-08-13',
    startDate: evaluated.startDate,
    dueDate: evaluated.dueDate,
    progressPercent: evaluated.progressPercent,
    logsByDate: evaluated.logsByDate
  });
  assert.equal(cell13.hasRealExecution, false);
  assert.equal(cell13.executionColor, null);
  assert.equal(cell13.cellColor, null);

  // Día 14/08 (posterior a fecha fin con registro real y avance < 100%) -> Rojo
  const cell14 = evaluateGanttDayCell({
    date: '2026-08-14',
    startDate: evaluated.startDate,
    dueDate: evaluated.dueDate,
    progressPercent: evaluated.progressPercent,
    logsByDate: evaluated.logsByDate
  });
  assert.equal(cell14.hasRealExecution, true);
  assert.equal(cell14.executionColor, 'red');
  assert.equal(cell14.cellColor, 'red');

  // Al llegar al 100%, pasa a COMPLETADO y verde oscuro
  const evaluated100 = evaluateGanttActivity(
    activity,
    [
      ...logs,
      {
        id: 'p4',
        activityId: 'act-pct',
        activityCode: 'ACT-02',
        date: '2026-08-15',
        progressMode: 'percentage',
        percentageReached: 100,
        quantityToday: 100
      }
    ],
    '2026-08-20'
  );
  assert.equal(evaluated100.progressPercent, 100);
  assert.equal(evaluated100.phaseState, 'COMPLETADO');
  assert.equal(evaluated100.isOverdue, false);

  const cell15 = evaluateGanttDayCell({
    date: '2026-08-15',
    startDate: evaluated100.startDate,
    dueDate: evaluated100.dueDate,
    progressPercent: evaluated100.progressPercent,
    logsByDate: evaluated100.logsByDate
  });
  assert.equal(cell15.executionColor, 'dark_green');
});

test('Calendario del Gantt mantiene alineación de días, semanas y meses', () => {
  const act1 = evaluateGanttActivity(
    {
      id: 'a1',
      code: 'A1',
      name: 'Cimentación',
      areaName: 'Obra Civil',
      structureName: 'Losa Principal',
      progressMode: 'quantity',
      targetUnits: 50,
      unit: 'm3',
      startDate: '2026-08-01',
      dueDate: '2026-08-10'
    },
    [],
    '2026-08-05'
  );

  const expandedRows = buildGanttHierarchyRows([act1], {}, '2026-08-05');
  assert.equal(expandedRows.length, 3);

  const cal = buildGanttCalendarModel('2026-08-01', '2026-08-15', '2026-08-05');
  assert.equal(cal.days.length, 15);
  assert.equal(cal.todayColumnIndex, 4);
  assert.ok(cal.months.length >= 1);
  assert.ok(cal.weeks.length >= 2);
});
