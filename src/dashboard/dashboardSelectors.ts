/**
 * Capa de Cálculos, Selectores Puros y Filtros del Dashboard Ejecutivo
 * Control Galpones La Calera
 *
 * Esta capa está 100 % desacoplada de la presentación visual y de las escrituras en Firestore:
 * - Opera exclusivamente en modo de solo lectura (inmutable) sobre los datos reales sincronizados.
 * - Reutiliza y centraliza los cálculos operativos para evitar duplicidad entre módulos.
 * - Soporta criterios de filtrado por proyecto, sector, galpón, rango de fechas, área,
 *   ubicación, actividad y responsable/supervisor para cualquier reporte actual o futuro.
 */

export const ALL_CONSTRUCTIVE_AREAS = [
  'Obra Civil',
  'Edificio',
  'Sistema de Jaulas',
  'Sistema Eléctrico',
  'Gasfitería',
  'Soldadura'
] as const;

export const AREAS_WITH_SISTEMAS_LIST = [
  'Sistema de Jaulas',
  'Sistema Eléctrico',
  'Gasfitería',
  'Soldadura'
] as const;

export type SistemaLocationFilter = 'Todos' | 'Interno' | 'Externo';

export interface EvaluatedActivityItem {
  id: string;
  code: string;
  name: string;
  areaId?: string;
  areaName: string;
  hasSistema?: boolean;
  locationType?: string;
  sistemaId?: string;
  sistemaName?: string | null;
  structureId?: string;
  structureName: string;
  targetUnits: number;
  unit: string;
  weight?: number;
  plannedHH?: number;
  startDate?: string;
  dueDate?: string;
  status?: string;
  accumulatedQty: number;
  accumulatedHH: number;
  pendingQty: number;
  progressPercent: number;
  shouldHaveStarted: boolean;
  computedStatus: string;
  lastLog?: any;
  linkedMaterials?: any[];
}

export interface AreaProgressMetric {
  name: string;
  percent: number;
  total: number;
  completed: number;
}

export interface SistemaProgressMetric {
  sistemaName: string;
  areaName: string;
  locations: string[];
  percent: number;
  total: number;
  completed: number;
}

export interface AttendanceSummaryMetric {
  present: number;
  absent: number;
  medicalAttention: number;
  permission: number;
  medicalLeave: number;
  pending: number;
  total: number;
  rate: number;
  map: Record<string, string>;
}

export interface DashboardKpiSummary {
  weightedProgress: number;
  technology: string;
  attendanceRate: number;
  attendancePresent: number;
  attendanceTotal: number;
  attendanceDate: string;
  completedActivitiesCount: number;
  totalActivitiesCount: number;
  overdueStartActivitiesCount: number;
  accumulatedHH: number;
  plannedHH: number;
}

/**
 * Criterios universales de filtrado para reportes actuales o futuros del Dashboard
 * (Proyecto, Sector, Galpón, Rango de Fechas, Área, Ubicación, Actividad y Responsable/Supervisor).
 */
export interface DashboardFilterCriteria {
  project?: string;
  sectorId?: string;
  galponId?: string;
  dateFrom?: string;
  dateTo?: string;
  areaName?: string;
  locationType?: SistemaLocationFilter;
  activityCode?: string;
  supervisor?: string;
}

/**
 * Calcula el avance físico ponderado de cualquier conjunto de actividades evaluadas.
 * Función pura compartida entre la cabecera operativa y el Dashboard.
 */
export function computeWeightedProgress(
  activities: Pick<EvaluatedActivityItem, 'progressPercent' | 'weight'>[]
): number {
  if (!activities || activities.length === 0) return 0;
  const totalWeight = activities.reduce(
    (acc, a) => acc + (Number(a.weight) || 1),
    0
  );
  if (totalWeight <= 0) return 0;
  const weightedSum = activities.reduce(
    (acc, a) => acc + Number(a.progressPercent || 0) * (Number(a.weight) || 1),
    0
  );
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

/**
 * Calcula el avance ponderado para cada una de las 6 áreas constructivas oficiales.
 */
export function computeAreaProgressMetrics(
  evaluatedActivities: EvaluatedActivityItem[],
  areasList: readonly string[] = ALL_CONSTRUCTIVE_AREAS
): AreaProgressMetric[] {
  return areasList.map((areaName) => {
    const areaActs = (evaluatedActivities || []).filter((a) => a.areaName === areaName);
    if (!areaActs.length) {
      return { name: areaName, percent: 0, total: 0, completed: 0 };
    }
    const percent = computeWeightedProgress(areaActs);
    const completed = areaActs.filter((a) => a.progressPercent >= 100).length;
    return {
      name: areaName,
      percent,
      total: areaActs.length,
      completed
    };
  });
}

/**
 * Calcula el avance ponderado por Sistema General filtrable por ubicación (Todos / Interno / Externo).
 */
export function computeSistemaProgressMetrics(
  evaluatedActivities: EvaluatedActivityItem[],
  locationFilter: SistemaLocationFilter = 'Todos'
): SistemaProgressMetric[] {
  const actsWithSis = (evaluatedActivities || []).filter((a) => Boolean(a.sistemaName));
  const filteredByLoc =
    locationFilter === 'Todos'
      ? actsWithSis
      : actsWithSis.filter((a) => (a.locationType || 'Interno') === locationFilter);

  const sisNames = Array.from(
    new Set(actsWithSis.map((a) => String(a.sistemaName)))
  );

  return sisNames.map((sisName) => {
    const sisActs = filteredByLoc.filter((a) => a.sistemaName === sisName);
    const allLocsForSis = Array.from(
      new Set(
        actsWithSis
          .filter((a) => a.sistemaName === sisName)
          .map((a) => a.locationType || 'Interno')
      )
    );
    const areaName =
      actsWithSis.find((a) => a.sistemaName === sisName)?.areaName || '';

    if (!sisActs.length) {
      return {
        sistemaName: sisName,
        areaName,
        locations: allLocsForSis,
        percent: 0,
        total: 0,
        completed: 0
      };
    }

    const percent = computeWeightedProgress(sisActs);
    const completed = sisActs.filter((a) => a.progressPercent >= 100).length;
    return {
      sistemaName: sisName,
      areaName,
      locations: allLocsForSis,
      percent,
      total: sisActs.length,
      completed
    };
  });
}

/**
 * Obtiene la lista de actividades con alerta de cronograma o pendientes por área.
 */
export function computeScheduleAlerts(
  evaluatedActivities: EvaluatedActivityItem[],
  pendingAreaFilter = 'Todas'
): EvaluatedActivityItem[] {
  return (evaluatedActivities || []).filter(
    (a) =>
      a.progressPercent < 100 &&
      (pendingAreaFilter === 'Todas' || a.areaName === pendingAreaFilter)
  );
}

/**
 * Consolida los 4 indicadores ejecutivos (KPIs) principales del galpón activo.
 */
export function computeDashboardKpiSummary(params: {
  evaluatedActivities: EvaluatedActivityItem[];
  galponWeightedProgress: number;
  currentDayAttendance: AttendanceSummaryMetric;
  attendanceDate: string;
  technology?: string;
}): DashboardKpiSummary {
  const {
    evaluatedActivities,
    galponWeightedProgress,
    currentDayAttendance,
    attendanceDate,
    technology
  } = params;

  const acts = evaluatedActivities || [];
  const completedActivitiesCount = acts.filter((a) => a.progressPercent >= 100).length;
  const overdueStartActivitiesCount = acts.filter((a) => a.shouldHaveStarted).length;
  const accumulatedHH = acts.reduce(
    (sum, a) => sum + Number(a.accumulatedHH || 0),
    0
  );
  const plannedHH = acts.reduce((sum, a) => sum + Number(a.plannedHH || 0), 0);

  return {
    weightedProgress: galponWeightedProgress,
    technology: technology || 'Sin proveedor',
    attendanceRate: currentDayAttendance?.rate ?? 0,
    attendancePresent: currentDayAttendance?.present ?? 0,
    attendanceTotal: currentDayAttendance?.total ?? 0,
    attendanceDate: attendanceDate || '',
    completedActivitiesCount,
    totalActivitiesCount: acts.length,
    overdueStartActivitiesCount,
    accumulatedHH,
    plannedHH
  };
}

/**
 * Filtra de forma inmutable las actividades y partes diarios según los criterios solicitados
 * (proyecto, sector, galpón, fechas, área, ubicación, actividad y responsable/supervisor)
 * sin alterar ningún registro histórico ni operativo.
 */
export function filterDashboardActivities(
  evaluatedActivities: EvaluatedActivityItem[],
  dailyAdvances: any[],
  criteria: DashboardFilterCriteria
): EvaluatedActivityItem[] {
  if (!evaluatedActivities || evaluatedActivities.length === 0) return [];

  const hasDateOrSupervisorFilter = Boolean(
    criteria.dateFrom || criteria.dateTo || criteria.supervisor?.trim()
  );

  return evaluatedActivities
    .filter((act) => {
      if (
        criteria.areaName &&
        criteria.areaName !== 'Todas' &&
        act.areaName !== criteria.areaName
      ) {
        return false;
      }
      if (
        criteria.locationType &&
        criteria.locationType !== 'Todos' &&
        (act.locationType || 'Interno') !== criteria.locationType
      ) {
        return false;
      }
      if (
        criteria.activityCode &&
        criteria.activityCode !== 'Todas' &&
        act.code !== criteria.activityCode
      ) {
        return false;
      }
      return true;
    })
    .map((act) => {
      if (!hasDateOrSupervisorFilter) {
        return { ...act };
      }

      const matchingLogs = (dailyAdvances || []).filter((log) => {
        if (criteria.galponId && log.galponId !== criteria.galponId) return false;
        const matchesAct =
          (log.activityId && log.activityId === act.id) ||
          log.activityCode === act.code;
        if (!matchesAct) return false;
        if (criteria.dateFrom && log.date < criteria.dateFrom) return false;
        if (criteria.dateTo && log.date > criteria.dateTo) return false;
        if (criteria.supervisor?.trim()) {
          const supQuery = criteria.supervisor.trim().toLowerCase();
          if (!(log.supervisor || '').toLowerCase().includes(supQuery)) {
            return false;
          }
        }
        return true;
      });

      const accumulatedQty = matchingLogs.reduce(
        (s, l) => s + Number(l.quantityToday || 0),
        0
      );
      const accumulatedHH = matchingLogs.reduce(
        (s, l) => s + Number(l.hoursWorked || 0),
        0
      );
      const rawPct =
        act.targetUnits > 0 ? (accumulatedQty / act.targetUnits) * 100 : 0;
      const progressPercent = Math.min(100, Math.round(rawPct * 10) / 10);

      return {
        ...act,
        accumulatedQty,
        accumulatedHH,
        pendingQty: Math.max(0, Number(act.targetUnits || 0) - accumulatedQty),
        progressPercent
      };
    });
}
