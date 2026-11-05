import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWeightedProgress,
  computeAreaProgressMetrics,
  computeSistemaProgressMetrics,
  computeScheduleAlerts,
  computeDashboardKpiSummary,
  filterDashboardActivities,
  type EvaluatedActivityItem
} from './dashboardSelectors';

const sampleActivities: EvaluatedActivityItem[] = [
  {
    id: 'act_1',
    code: 'OC-01',
    name: 'Excavación de zanjas',
    areaName: 'Obra Civil',
    locationType: 'Interno',
    sistemaName: null,
    structureName: 'Cimentación',
    targetUnits: 100,
    unit: 'm3',
    weight: 2,
    plannedHH: 40,
    startDate: '2026-10-01',
    dueDate: '2026-10-10',
    accumulatedQty: 100,
    accumulatedHH: 38,
    pendingQty: 0,
    progressPercent: 100,
    shouldHaveStarted: false,
    computedStatus: 'Completada'
  },
  {
    id: 'act_2',
    code: 'SJ-01',
    name: 'Montaje de parantes',
    areaName: 'Sistema de Jaulas',
    locationType: 'Interno',
    sistemaName: 'Batería Principal',
    structureName: 'Fila 1',
    targetUnits: 50,
    unit: 'und',
    weight: 1,
    plannedHH: 60,
    startDate: '2026-10-05',
    dueDate: '2026-10-20',
    accumulatedQty: 0,
    accumulatedHH: 0,
    pendingQty: 50,
    progressPercent: 0,
    shouldHaveStarted: true,
    computedStatus: 'No iniciada (Alerta)'
  },
  {
    id: 'act_3',
    code: 'SJ-02',
    name: 'Conexión de comedero externo',
    areaName: 'Sistema de Jaulas',
    locationType: 'Externo',
    sistemaName: 'Batería Principal',
    structureName: 'Silo Exterior',
    targetUnits: 20,
    unit: 'm',
    weight: 1,
    plannedHH: 20,
    startDate: '2026-10-12',
    dueDate: '2026-10-25',
    accumulatedQty: 10,
    accumulatedHH: 12,
    pendingQty: 10,
    progressPercent: 50,
    shouldHaveStarted: false,
    computedStatus: 'En proceso'
  }
];

test('computeWeightedProgress calculates accurate weighted average', () => {
  // Weights: 2*100 + 1*0 + 1*50 = 250 / 4 = 62.5%
  const progress = computeWeightedProgress(sampleActivities);
  assert.equal(progress, 62.5);
  assert.equal(computeWeightedProgress([]), 0);
});

test('computeAreaProgressMetrics calculates metrics across all 6 official areas', () => {
  const areas = computeAreaProgressMetrics(sampleActivities);
  assert.equal(areas.length, 6);

  const obraCivil = areas.find((a) => a.name === 'Obra Civil');
  assert.deepEqual(obraCivil, {
    name: 'Obra Civil',
    percent: 100,
    total: 1,
    completed: 1
  });

  const jaulas = areas.find((a) => a.name === 'Sistema de Jaulas');
  assert.deepEqual(jaulas, {
    name: 'Sistema de Jaulas',
    percent: 25,
    total: 2,
    completed: 0
  });
});

test('computeSistemaProgressMetrics filters by Todos, Interno, and Externo', () => {
  const allSis = computeSistemaProgressMetrics(sampleActivities, 'Todos');
  assert.equal(allSis.length, 1);
  assert.equal(allSis[0].sistemaName, 'Batería Principal');
  assert.equal(allSis[0].percent, 25);

  const internoSis = computeSistemaProgressMetrics(sampleActivities, 'Interno');
  assert.equal(internoSis[0].percent, 0);
  assert.equal(internoSis[0].total, 1);

  const externoSis = computeSistemaProgressMetrics(sampleActivities, 'Externo');
  assert.equal(externoSis[0].percent, 50);
  assert.equal(externoSis[0].total, 1);
});

test('computeScheduleAlerts and computeDashboardKpiSummary return read-only executive metrics', () => {
  const alertsAll = computeScheduleAlerts(sampleActivities, 'Todas');
  assert.equal(alertsAll.length, 2); // act_2 (0%) and act_3 (50%)

  const alertsJaulas = computeScheduleAlerts(sampleActivities, 'Sistema de Jaulas');
  assert.equal(alertsJaulas.length, 2);

  const kpi = computeDashboardKpiSummary({
    evaluatedActivities: sampleActivities,
    galponWeightedProgress: 62.5,
    currentDayAttendance: {
      present: 18,
      absent: 2,
      medicalAttention: 0,
      permission: 0,
      medicalLeave: 0,
      pending: 0,
      total: 20,
      rate: 90,
      map: {}
    },
    attendanceDate: '2026-11-05',
    technology: ' Big Dutchman '
  });

  assert.equal(kpi.weightedProgress, 62.5);
  assert.equal(kpi.attendanceRate, 90);
  assert.equal(kpi.completedActivitiesCount, 1);
  assert.equal(kpi.totalActivitiesCount, 3);
  assert.equal(kpi.overdueStartActivitiesCount, 1);
  assert.equal(kpi.accumulatedHH, 50);
  assert.equal(kpi.plannedHH, 120);
});

test('filterDashboardActivities supports filtering by area, date range, and supervisor without mutating source data', () => {
  const advances = [
    {
      id: 'adv_1',
      galponId: 'gal_1',
      activityId: 'act_3',
      activityCode: 'SJ-02',
      date: '2026-10-15',
      quantityToday: 6,
      hoursWorked: 7,
      supervisor: 'Carlos Ruiz'
    },
    {
      id: 'adv_2',
      galponId: 'gal_1',
      activityId: 'act_3',
      activityCode: 'SJ-02',
      date: '2026-10-20',
      quantityToday: 4,
      hoursWorked: 5,
      supervisor: 'Pedro Gómez'
    }
  ];

  const filtered = filterDashboardActivities(sampleActivities, advances, {
    galponId: 'gal_1',
    areaName: 'Sistema de Jaulas',
    supervisor: 'Carlos'
  });

  assert.equal(filtered.length, 2);
  const sj02 = filtered.find((a) => a.code === 'SJ-02');
  assert.equal(sj02?.accumulatedQty, 6);
  assert.equal(sj02?.accumulatedHH, 7);
  assert.equal(sj02?.progressPercent, 30);

  // Verify original array was not mutated
  assert.equal(sampleActivities[2].accumulatedQty, 10);
  assert.equal(sampleActivities[2].progressPercent, 50);
});
