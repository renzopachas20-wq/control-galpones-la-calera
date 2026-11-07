import {
  evaluateActivityProgress,
  type ProgressModality
} from '../firebase/offlineSyncEngine';

export type GanttViewScale = 'day' | 'week' | 'month';

export type GanttExecutionColor =
  | 'gray'
  | 'blue'
  | 'green'
  | 'dark_green'
  | 'red';

export type GanttPhaseState = 'NO_INICIADO' | 'EN_PROGRESO' | 'COMPLETADO';

export type GanttScheduleCondition = 'ATRASADO' | 'ADELANTADO';

export type GanttStatusFilter =
  | 'ALL'
  | 'NO_INICIADO'
  | 'EN_PROGRESO'
  | 'COMPLETADO'
  | 'ATRASADO'
  | 'ADELANTADO';

export type GanttScheduleStatus =
  | 'completada'
  | 'atrasada'
  | 'anticipada'
  | 'en_plazo'
  | 'pendiente';

export interface GanttDayLogSummary {
  date: string;
  logsCount: number;
  totalQuantityToday: number;
  latestPercentageReached: number | null;
  totalHoursWorked: number;
  supervisors: string[];
  notes: string[];
}

export interface GanttDayCellState {
  date: string;
  isPlanned: boolean;
  isPlanStart: boolean;
  isPlanEnd: boolean;
  hasRealExecution: boolean;
  executionColor: Exclude<GanttExecutionColor, 'gray'> | null;
  cellColor: GanttExecutionColor | null;
  logSummary: GanttDayLogSummary | null;
}

export interface EvaluatedGanttActivity {
  id: string;
  originalIndex: number;
  code: string;
  name: string;
  areaId?: string;
  areaName: string;
  hasSistema?: boolean;
  sistemaId?: string;
  sistemaName?: string;
  locationType?: string;
  ubicacionSistemaLabel: string;
  structureId?: string;
  structureName: string;
  phaseLabel: string;
  phaseState: GanttPhaseState;
  phaseStateLabel: 'NO INICIADO' | 'EN PROGRESO' | 'COMPLETADO';
  isOverdue: boolean;
  isAhead: boolean;
  conditions: GanttScheduleCondition[];
  primaryCondition: GanttScheduleCondition | null;
  startDate: string;
  dueDate: string;
  progressMode: ProgressModality;
  targetUnits: number;
  unit: string;
  accumulatedQty: number;
  accumulatedHH: number;
  progressPercent: number;
  scheduleStatus: GanttScheduleStatus;
  scheduleStatusLabel: string;
  isOverdueWithoutLateLogs: boolean;
  executedDates: string[];
  logsByDate: Record<string, GanttDayLogSummary>;
}

export interface GanttHierarchyRow {
  rowKey: string;
  rowType: 'area' | 'sistema' | 'structure' | 'activity';
  level: number;
  indexLabel: string;
  title: string;
  phaseLabel: string;
  startDate: string;
  dueDate: string;
  progressPercent: number;
  scheduleStatus: GanttScheduleStatus;
  scheduleStatusLabel: string;
  activityCount: number;
  activity?: EvaluatedGanttActivity;
  groupKey?: string;
}

export interface GanttCalendarDay {
  date: string;
  dayNumber: string;
  dayShortName: string;
  isWeekend: boolean;
  isToday: boolean;
  monthKey: string;
  weekKey: string;
}

export interface GanttCalendarGroupHeader {
  key: string;
  label: string;
  span: number;
  startDate: string;
  endDate: string;
}

export interface GanttCalendarModel {
  fromDate: string;
  toDate: string;
  todayDate: string;
  days: GanttCalendarDay[];
  months: GanttCalendarGroupHeader[];
  weeks: GanttCalendarGroupHeader[];
  todayColumnIndex: number;
}

const MONTH_NAMES_ES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre'
];

const DAY_INITIALS_ES = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

export function isValidIsoDate(dateStr: string | undefined | null): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) return false;
  const [y, m, d] = dateStr.trim().split('-').map(Number);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function parseIsoDateUTC(dateStr: string): Date {
  const [y, m, d] = dateStr.trim().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatIsoDateUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIso(dateStr: string, daysToAdd: number): string {
  if (!isValidIsoDate(dateStr)) return dateStr;
  const dt = parseIsoDateUTC(dateStr);
  dt.setUTCDate(dt.getUTCDate() + daysToAdd);
  return formatIsoDateUTC(dt);
}

export function diffDaysIso(startIso: string, endIso: string): number {
  if (!isValidIsoDate(startIso) || !isValidIsoDate(endIso)) return 0;
  const a = parseIsoDateUTC(startIso).getTime();
  const b = parseIsoDateUTC(endIso).getTime();
  return Math.round((b - a) / 86400000);
}

export function formatShortDisplayDate(dateStr: string | undefined | null): string {
  if (!dateStr || !isValidIsoDate(dateStr)) return '—';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Formatea la columna "Ubicación / Sistema" exactamente como en Gestión de Actividades.
 * - Si tiene sistema y ubicación (Interno/Externo): "Sistema / Ubicación"
 * - Si solo tiene sistema: "Sistema"
 * - Si el área no utiliza sistema ni ubicación específica: "—"
 */
export function formatUbicacionSistema(activity: any): string {
  const rawSistema =
    typeof activity?.sistemaName === 'string' ? activity.sistemaName.trim() : '';
  const rawLocation =
    typeof activity?.locationType === 'string' ? activity.locationType.trim() : '';

  if (rawSistema) {
    if (
      rawLocation &&
      !rawSistema.toLowerCase().includes(rawLocation.toLowerCase())
    ) {
      return `${rawSistema} / ${rawLocation}`;
    }
    return rawSistema;
  }

  if (activity?.hasSistema && rawLocation) {
    return rawLocation;
  }

  return '—';
}

/**
 * Agrupa los registros diarios reales de una actividad por fecha (YYYY-MM-DD).
 * Consolida múltiples registros del mismo día sin duplicar segmentos y nunca inventa días sin registros.
 */
export function buildActivityLogsByDate(
  activity: any,
  rawLogs: any[]
): Record<string, GanttDayLogSummary> {
  const map: Record<string, GanttDayLogSummary> = {};
  const validLogs = (Array.isArray(rawLogs) ? rawLogs : []).filter(
    (l) => l && !l.deletedAt && l.syncState !== 'conflict' && isValidIsoDate(l.date)
  );

  for (const log of validLogs) {
    const dateKey = String(log.date).trim();
    const qty = Number(log.quantityToday || 0);
    const pctRaw =
      log.percentageReached !== undefined &&
      log.percentageReached !== null &&
      log.percentageReached !== ''
        ? Number(log.percentageReached)
        : Number(log.quantityToday);
    const isPctLog =
      log.progressMode === 'percentage' || activity?.progressMode === 'percentage';

    // Ignorar registros vacíos sin avance real
    if (!isPctLog && qty <= 0) continue;
    if (isPctLog && (!Number.isFinite(pctRaw) || pctRaw <= 0)) continue;

    if (!map[dateKey]) {
      map[dateKey] = {
        date: dateKey,
        logsCount: 0,
        totalQuantityToday: 0,
        latestPercentageReached: null,
        totalHoursWorked: 0,
        supervisors: [],
        notes: []
      };
    }

    const entry = map[dateKey];
    entry.logsCount += 1;
    entry.totalQuantityToday = Number(
      (entry.totalQuantityToday + Math.max(0, qty)).toFixed(2)
    );
    if (isPctLog && Number.isFinite(pctRaw)) {
      entry.latestPercentageReached = Math.min(
        100,
        Math.max(0, Number(pctRaw.toFixed(2)))
      );
    }
    entry.totalHoursWorked = Number(
      (entry.totalHoursWorked + Math.max(0, Number(log.hoursWorked || 0))).toFixed(2)
    );
    if (log.supervisor && !entry.supervisors.includes(log.supervisor)) {
      entry.supervisors.push(log.supervisor);
    }
    if (log.note && !entry.notes.includes(log.note)) {
      entry.notes.push(log.note);
    }
  }

  return map;
}

/**
 * Evalúa el estado de una celda diaria combinando:
 * - Capa 1 (Planificación): gris entre startDate y dueDate.
 * - Capa 2 (Ejecución real):
 *   - Azul: registros de avance anteriores a startDate.
 *   - Verde oscuro: actividad completada al 100% (en días con ejecución dentro o después del inicio).
 *   - Rojo: ejecución posterior a dueDate cuando el avance continúa por debajo del 100%.
 *   - Verde: registros dentro del plazo cuando el avance es < 100%.
 */
export function evaluateGanttDayCell(params: {
  date: string;
  startDate?: string;
  dueDate?: string;
  progressPercent: number;
  logsByDate: Record<string, GanttDayLogSummary>;
}): GanttDayCellState {
  const { date, startDate, dueDate, progressPercent, logsByDate } = params;
  const hasValidStart = isValidIsoDate(startDate);
  const hasValidDue = isValidIsoDate(dueDate);

  const isPlanned =
    hasValidStart &&
    hasValidDue &&
    startDate! <= dueDate! &&
    date >= startDate! &&
    date <= dueDate!;

  const isPlanStart = isPlanned && date === startDate!;
  const isPlanEnd = isPlanned && date === dueDate!;

  const logSummary = logsByDate[date] || null;
  const hasRealExecution = Boolean(logSummary && logSummary.logsCount > 0);

  let executionColor: Exclude<GanttExecutionColor, 'gray'> | null = null;
  if (hasRealExecution) {
    if (hasValidStart && date < startDate!) {
      // Registros anteriores a la fecha de inicio programada -> Azul
      executionColor = 'blue';
    } else if (progressPercent >= 100) {
      // Actividad completada al 100% -> Verde oscuro (deja de generar atrasos)
      executionColor = 'dark_green';
    } else if (hasValidDue && date > dueDate!) {
      // Ejecución posterior a la fecha de fin cuando el avance continúa < 100% -> Rojo
      executionColor = 'red';
    } else {
      // Ejecución dentro del plazo -> Verde
      executionColor = 'green';
    }
  }

  const cellColor: GanttExecutionColor | null = executionColor
    ? executionColor
    : isPlanned
    ? 'gray'
    : null;

  return {
    date,
    isPlanned,
    isPlanStart,
    isPlanEnd,
    hasRealExecution,
    executionColor,
    cellColor,
    logSummary
  };
}

/**
 * Evalúa una actividad para el Gantt utilizando exclusivamente `evaluateActivityProgress`
 * para garantizar 100% de consistencia con Dashboard, Avance e Informes Globales.
 */
export function evaluateGanttActivity(
  activity: any,
  logsForActivity: any[],
  todayStr: string,
  originalIndex: number = 0
): EvaluatedGanttActivity {
  const evalRes = evaluateActivityProgress(activity, logsForActivity, todayStr);
  const logsByDate = buildActivityLogsByDate(activity, logsForActivity);
  const executedDates = Object.keys(logsByDate).sort((a, b) => a.localeCompare(b));

  const startDate = isValidIsoDate(activity?.startDate)
    ? String(activity.startDate).trim()
    : '';
  const dueDate = isValidIsoDate(activity?.dueDate)
    ? String(activity.dueDate).trim()
    : '';
  const progressPercent = evalRes.progressPercent;

  // Estados principales de la columna Fase:
  // 1. NO INICIADO: 0% y sin registros
  // 2. EN PROGRESO: > 0% y < 100% (o con registros de avance y < 100%)
  // 3. COMPLETADO: 100%
  let phaseState: GanttPhaseState = 'NO_INICIADO';
  let phaseStateLabel: 'NO INICIADO' | 'EN PROGRESO' | 'COMPLETADO' = 'NO INICIADO';

  if (progressPercent >= 100) {
    phaseState = 'COMPLETADO';
    phaseStateLabel = 'COMPLETADO';
  } else if (progressPercent > 0 || executedDates.length > 0) {
    phaseState = 'EN_PROGRESO';
    phaseStateLabel = 'EN PROGRESO';
  } else {
    phaseState = 'NO_INICIADO';
    phaseStateLabel = 'NO INICIADO';
  }

  // Condiciones adicionales automáticas:
  // - ADELANTADO: Tiene avances registrados antes de la fecha de inicio programada.
  // - ATRASADO: Superó la fecha de fin (el día después de dueDate) y continúa por debajo del 100%.
  //   Una actividad COMPLETADA (100%) NUNCA se marca como ATRASADO.
  const hasEarlyLogs =
    Boolean(startDate) && executedDates.some((d) => d < startDate);
  const hasLateLogs =
    Boolean(dueDate) && executedDates.some((d) => d > dueDate);
  const isPastDueDate =
    Boolean(dueDate) && isValidIsoDate(todayStr) && todayStr > dueDate;

  const isOverdue = progressPercent < 100 && (isPastDueDate || hasLateLogs);
  const isAhead = hasEarlyLogs;

  const conditions: GanttScheduleCondition[] = [];
  if (isOverdue) conditions.push('ATRASADO');
  if (isAhead) conditions.push('ADELANTADO');

  const primaryCondition: GanttScheduleCondition | null = isOverdue
    ? 'ATRASADO'
    : isAhead
    ? 'ADELANTADO'
    : null;

  let scheduleStatus: GanttScheduleStatus = 'pendiente';
  let scheduleStatusLabel = 'No iniciado';

  if (progressPercent >= 100) {
    scheduleStatus = 'completada';
    scheduleStatusLabel = 'Completado';
  } else if (isOverdue) {
    scheduleStatus = 'atrasada';
    scheduleStatusLabel = 'Atrasado';
  } else if (isAhead) {
    scheduleStatus = 'anticipada';
    scheduleStatusLabel = 'Adelantado';
  } else if (phaseState === 'EN_PROGRESO') {
    scheduleStatus = 'en_plazo';
    scheduleStatusLabel = 'En progreso';
  } else {
    scheduleStatus = 'pendiente';
    scheduleStatusLabel = 'No iniciado';
  }

  const isOverdueWithoutLateLogs = isOverdue && !hasLateLogs;

  const rawAreaName =
    typeof activity?.areaName === 'string' && activity.areaName.trim()
      ? activity.areaName.trim()
      : '—';
  const rawStructureName =
    typeof activity?.structureName === 'string' && activity.structureName.trim()
      ? activity.structureName.trim()
      : '—';
  const ubicacionSistemaLabel = formatUbicacionSistema(activity);

  const phaseParts = [
    rawAreaName !== '—' ? rawAreaName : null,
    ubicacionSistemaLabel !== '—' ? ubicacionSistemaLabel : null,
    rawStructureName !== '—' ? rawStructureName : null
  ].filter(Boolean);

  return {
    id: String(activity?.id || activity?.code || ''),
    originalIndex,
    code:
      typeof activity?.code === 'string' && activity.code.trim()
        ? activity.code.trim()
        : '—',
    name:
      typeof activity?.name === 'string' && activity.name.trim()
        ? activity.name.trim()
        : '—',
    areaId: activity?.areaId,
    areaName: rawAreaName,
    hasSistema: Boolean(activity?.hasSistema || activity?.sistemaName),
    sistemaId: activity?.sistemaId,
    sistemaName:
      typeof activity?.sistemaName === 'string' && activity.sistemaName.trim()
        ? activity.sistemaName.trim()
        : undefined,
    locationType:
      typeof activity?.locationType === 'string' && activity.locationType.trim()
        ? activity.locationType.trim()
        : undefined,
    ubicacionSistemaLabel,
    structureId: activity?.structureId,
    structureName: rawStructureName,
    phaseLabel: phaseParts.join(' › ') || 'General',
    phaseState,
    phaseStateLabel,
    isOverdue,
    isAhead,
    conditions,
    primaryCondition,
    startDate,
    dueDate,
    progressMode: evalRes.progressMode,
    targetUnits:
      evalRes.progressMode === 'percentage'
        ? 100
        : Number(activity?.targetUnits || 0),
    unit:
      evalRes.progressMode === 'percentage'
        ? activity?.unit || '%'
        : activity?.unit || '',
    accumulatedQty: evalRes.accumulatedQty,
    accumulatedHH: evalRes.accumulatedHH,
    progressPercent,
    scheduleStatus,
    scheduleStatusLabel,
    isOverdueWithoutLateLogs,
    executedDates,
    logsByDate
  };
}

/**
 * Ordena automáticamente las actividades por fecha programada de Inicio (ascendente:
 * desde la más antigua hasta la más reciente).
 * - Si tienen la misma fecha de inicio, mantiene el orden original de Gestión de Actividades (`originalIndex`).
 * - Si una actividad no tiene fecha de inicio válida, la ubica al final respetando `originalIndex`.
 */
export function sortGanttActivitiesByStartDate(
  activities: EvaluatedGanttActivity[]
): EvaluatedGanttActivity[] {
  return [...(Array.isArray(activities) ? activities : [])].sort((a, b) => {
    const aHasStart = isValidIsoDate(a.startDate);
    const bHasStart = isValidIsoDate(b.startDate);

    if (aHasStart && bHasStart) {
      const cmp = a.startDate.localeCompare(b.startDate);
      if (cmp !== 0) return cmp;
      return a.originalIndex - b.originalIndex;
    }
    if (aHasStart && !bHasStart) return -1;
    if (!aHasStart && bHasStart) return 1;
    return a.originalIndex - b.originalIndex;
  });
}

/**
 * Extrae dinámicamente la lista de áreas reales disponibles para el filtro Área
 * a partir del galpón activo y de las actividades registradas, sin usar listas fijas.
 */
export function extractDynamicGanttAreas(
  currentGalpon: any,
  activities: EvaluatedGanttActivity[]
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  if (Array.isArray(currentGalpon?.areas)) {
    for (const area of currentGalpon.areas) {
      const name = typeof area?.name === 'string' ? area.name.trim() : '';
      if (name && name !== '—' && !seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }

  if (Array.isArray(activities)) {
    for (const act of activities) {
      const name = typeof act?.areaName === 'string' ? act.areaName.trim() : '';
      if (name && name !== '—' && !seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }

  return result;
}

/**
 * Verifica si una actividad cumple el criterio del filtro de Estado/Condición del Gantt.
 */
export function matchesGanttStatusFilter(
  activity: EvaluatedGanttActivity,
  statusFilter: GanttStatusFilter
): boolean {
  if (!statusFilter || statusFilter === 'ALL') return true;
  if (statusFilter === 'NO_INICIADO') return activity.phaseState === 'NO_INICIADO';
  if (statusFilter === 'EN_PROGRESO') return activity.phaseState === 'EN_PROGRESO';
  if (statusFilter === 'COMPLETADO') return activity.phaseState === 'COMPLETADO';
  if (statusFilter === 'ATRASADO') return activity.isOverdue;
  if (statusFilter === 'ADELANTADO') return activity.isAhead;
  return true;
}

/**
 * Aplica los filtros dinámicos de Área y Estado (de forma individual o combinada)
 * y mantiene siempre el ordenamiento automático por fecha de Inicio.
 */
export function filterAndSortGanttActivities(
  activities: EvaluatedGanttActivity[],
  filters: {
    areaFilter?: string;
    statusFilter?: GanttStatusFilter;
  }
): EvaluatedGanttActivity[] {
  const areaTarget =
    filters.areaFilter && filters.areaFilter.trim() !== ''
      ? filters.areaFilter.trim()
      : 'ALL';
  const statusTarget: GanttStatusFilter = filters.statusFilter || 'ALL';

  const filtered = (Array.isArray(activities) ? activities : []).filter((act) => {
    const matchesArea = areaTarget === 'ALL' || act.areaName === areaTarget;
    if (!matchesArea) return false;
    return matchesGanttStatusFilter(act, statusTarget);
  });

  return sortGanttActivitiesByStartDate(filtered);
}

/**
 * Desplaza el rango de fechas del cronograma hacia atrás o hacia adelante según la escala activa.
 */
export function shiftGanttDateRange(
  fromDate: string,
  toDate: string,
  direction: 'prev' | 'next',
  viewScale: GanttViewScale
): { fromDate: string; toDate: string } {
  const stepDays = viewScale === 'day' ? 7 : viewScale === 'week' ? 14 : 30;
  const delta = direction === 'prev' ? -stepDays : stepDays;
  return {
    fromDate: addDaysIso(fromDate, delta),
    toDate: addDaysIso(toDate, delta)
  };
}

/**
 * Calcula el rango automático del calendario a partir de las actividades y sus registros reales,
 * asegurando que la fecha actual y todos los hitos queden cubiertos con margen visual.
 */
export function computeDefaultGanttDateRange(
  activities: EvaluatedGanttActivity[],
  todayStr: string
): { fromDate: string; toDate: string } {
  const safeToday = isValidIsoDate(todayStr) ? todayStr : '2026-11-06';
  const candidateDates: string[] = [safeToday];

  for (const act of activities) {
    if (isValidIsoDate(act.startDate)) candidateDates.push(act.startDate);
    if (isValidIsoDate(act.dueDate)) candidateDates.push(act.dueDate);
    for (const d of act.executedDates) {
      if (isValidIsoDate(d)) candidateDates.push(d);
    }
  }

  candidateDates.sort((a, b) => a.localeCompare(b));
  const minDate = candidateDates[0] || safeToday;
  const maxDate = candidateDates[candidateDates.length - 1] || safeToday;

  const fromDate = addDaysIso(minDate, -3);
  const preliminaryTo = addDaysIso(maxDate, 7);
  const spanDays = diffDaysIso(fromDate, preliminaryTo);
  const toDate = spanDays < 21 ? addDaysIso(fromDate, 21) : preliminaryTo;

  return { fromDate, toDate };
}

/**
 * Construye el modelo completo del calendario (Meses, Semanas y Días individuales)
 * para el panel derecho sincronizado del Gantt.
 */
export function buildGanttCalendarModel(
  fromDate: string,
  toDate: string,
  todayDate: string
): GanttCalendarModel {
  const safeToday = isValidIsoDate(todayDate) ? todayDate : '2026-11-06';
  let start = isValidIsoDate(fromDate) ? fromDate : addDaysIso(safeToday, -5);
  let end = isValidIsoDate(toDate) ? toDate : addDaysIso(safeToday, 20);

  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }

  // Limitar a un máximo razonable (370 días) para mantener fluidez en DOM
  const totalDiff = diffDaysIso(start, end);
  if (totalDiff > 370) {
    end = addDaysIso(start, 370);
  }

  const days: GanttCalendarDay[] = [];
  const months: GanttCalendarGroupHeader[] = [];
  const weeks: GanttCalendarGroupHeader[] = [];

  let cursor = parseIsoDateUTC(start);
  const endDt = parseIsoDateUTC(end);

  let currentMonthHeader: GanttCalendarGroupHeader | null = null;
  let currentWeekHeader: GanttCalendarGroupHeader | null = null;
  let weekCounter = 1;

  while (cursor.getTime() <= endDt.getTime()) {
    const iso = formatIsoDateUTC(cursor);
    const year = cursor.getUTCFullYear();
    const monthIdx = cursor.getUTCMonth();
    const dayNum = String(cursor.getUTCDate()).padStart(2, '0');
    const dow = cursor.getUTCDay(); // 0=Dom .. 6=Sab

    const monthKey = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
    const monthLabel = `${MONTH_NAMES_ES[monthIdx]} ${year}`;

    if (!currentMonthHeader || currentMonthHeader.key !== monthKey) {
      currentMonthHeader = {
        key: monthKey,
        label: monthLabel,
        span: 1,
        startDate: iso,
        endDate: iso
      };
      months.push(currentMonthHeader);
    } else {
      currentMonthHeader.span += 1;
      currentMonthHeader.endDate = iso;
    }

    // Nueva semana cada lunes (dow === 1) o al iniciar el calendario
    if (!currentWeekHeader || dow === 1) {
      const weekKey = `W-${weekCounter}-${iso}`;
      currentWeekHeader = {
        key: weekKey,
        label: `Sem ${weekCounter}`,
        span: 1,
        startDate: iso,
        endDate: iso
      };
      weeks.push(currentWeekHeader);
      weekCounter += 1;
    } else {
      currentWeekHeader.span += 1;
      currentWeekHeader.endDate = iso;
    }

    days.push({
      date: iso,
      dayNumber: dayNum,
      dayShortName: DAY_INITIALS_ES[dow],
      isWeekend: dow === 0 || dow === 6,
      isToday: iso === safeToday,
      monthKey,
      weekKey: currentWeekHeader.key
    });

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const todayColumnIndex = days.findIndex((d) => d.date === safeToday);

  return {
    fromDate: start,
    toDate: end,
    todayDate: safeToday,
    days,
    months,
    weeks,
    todayColumnIndex
  };
}

function summarizeGroupSchedule(
  items: EvaluatedGanttActivity[],
  todayStr: string
): {
  startDate: string;
  dueDate: string;
  progressPercent: number;
  scheduleStatus: GanttScheduleStatus;
  scheduleStatusLabel: string;
} {
  const validStarts = items
    .map((a) => a.startDate)
    .filter(isValidIsoDate)
    .sort((a, b) => a.localeCompare(b));
  const validDues = items
    .map((a) => a.dueDate)
    .filter(isValidIsoDate)
    .sort((a, b) => a.localeCompare(b));

  const startDate = validStarts[0] || '';
  const dueDate = validDues[validDues.length - 1] || '';

  const progressPercent =
    items.length > 0
      ? Math.round(
          items.reduce((acc, item) => acc + item.progressPercent, 0) / items.length
        )
      : 0;

  let scheduleStatus: GanttScheduleStatus = 'pendiente';
  let scheduleStatusLabel = 'No iniciado';

  if (items.length > 0 && items.every((i) => i.progressPercent >= 100)) {
    scheduleStatus = 'completada';
    scheduleStatusLabel = 'Completado';
  } else if (items.some((i) => i.scheduleStatus === 'atrasada')) {
    scheduleStatus = 'atrasada';
    scheduleStatusLabel = 'Atrasado';
  } else if (
    items.some((i) => i.scheduleStatus === 'anticipada') &&
    (!startDate || todayStr < startDate)
  ) {
    scheduleStatus = 'anticipada';
    scheduleStatusLabel = 'Adelantado';
  } else if (progressPercent > 0) {
    scheduleStatus = 'en_plazo';
    scheduleStatusLabel = 'En progreso';
  }

  return {
    startDate,
    dueDate,
    progressPercent,
    scheduleStatus,
    scheduleStatusLabel
  };
}

/**
 * Construye las filas jerárquicas (Área -> Sistema -> Estructura -> Actividad)
 * respetando los grupos contraídos (`collapsedGroups`).
 */
export function buildGanttHierarchyRows(
  activities: EvaluatedGanttActivity[],
  collapsedGroups: Record<string, boolean>,
  todayStr: string
): GanttHierarchyRow[] {
  const rows: GanttHierarchyRow[] = [];
  if (!Array.isArray(activities) || activities.length === 0) return rows;

  const areaMap = new Map<string, EvaluatedGanttActivity[]>();
  for (const act of activities) {
    const areaKey = act.areaName || 'General';
    if (!areaMap.has(areaKey)) areaMap.set(areaKey, []);
    areaMap.get(areaKey)!.push(act);
  }

  let areaIdx = 0;
  let globalActivityNumber = 0;

  for (const [areaName, areaActs] of areaMap.entries()) {
    areaIdx += 1;
    const areaGroupKey = `area:${areaName}`;
    const areaSummary = summarizeGroupSchedule(areaActs, todayStr);

    rows.push({
      rowKey: areaGroupKey,
      rowType: 'area',
      level: 0,
      indexLabel: `${areaIdx}`,
      title: areaName,
      phaseLabel: 'Área',
      startDate: areaSummary.startDate,
      dueDate: areaSummary.dueDate,
      progressPercent: areaSummary.progressPercent,
      scheduleStatus: areaSummary.scheduleStatus,
      scheduleStatusLabel: areaSummary.scheduleStatusLabel,
      activityCount: areaActs.length,
      groupKey: areaGroupKey
    });

    if (collapsedGroups[areaGroupKey]) continue;

    const hasSistemas = areaActs.some((a) => Boolean(a.sistemaName));

    if (hasSistemas) {
      const sisMap = new Map<string, EvaluatedGanttActivity[]>();
      for (const act of areaActs) {
        const sisKey = act.sistemaName || 'General';
        if (!sisMap.has(sisKey)) sisMap.set(sisKey, []);
        sisMap.get(sisKey)!.push(act);
      }

      let sisIdx = 0;
      for (const [sisName, sisActs] of sisMap.entries()) {
        sisIdx += 1;
        const sisGroupKey = `sis:${areaName}:${sisName}`;
        const sisSummary = summarizeGroupSchedule(sisActs, todayStr);

        rows.push({
          rowKey: sisGroupKey,
          rowType: 'sistema',
          level: 1,
          indexLabel: `${areaIdx}.${sisIdx}`,
          title: sisName,
          phaseLabel: areaName,
          startDate: sisSummary.startDate,
          dueDate: sisSummary.dueDate,
          progressPercent: sisSummary.progressPercent,
          scheduleStatus: sisSummary.scheduleStatus,
          scheduleStatusLabel: sisSummary.scheduleStatusLabel,
          activityCount: sisActs.length,
          groupKey: sisGroupKey
        });

        if (collapsedGroups[sisGroupKey]) continue;

        const strMap = new Map<string, EvaluatedGanttActivity[]>();
        for (const act of sisActs) {
          const strKey = act.structureName || 'General';
          if (!strMap.has(strKey)) strMap.set(strKey, []);
          strMap.get(strKey)!.push(act);
        }

        let strIdx = 0;
        for (const [strName, strActs] of strMap.entries()) {
          strIdx += 1;
          const strGroupKey = `str:${areaName}:${sisName}:${strName}`;
          const strSummary = summarizeGroupSchedule(strActs, todayStr);

          rows.push({
            rowKey: strGroupKey,
            rowType: 'structure',
            level: 2,
            indexLabel: `${areaIdx}.${sisIdx}.${strIdx}`,
            title: strName,
            phaseLabel: sisName,
            startDate: strSummary.startDate,
            dueDate: strSummary.dueDate,
            progressPercent: strSummary.progressPercent,
            scheduleStatus: strSummary.scheduleStatus,
            scheduleStatusLabel: strSummary.scheduleStatusLabel,
            activityCount: strActs.length,
            groupKey: strGroupKey
          });

          if (collapsedGroups[strGroupKey]) continue;

          for (const act of strActs) {
            globalActivityNumber += 1;
            rows.push({
              rowKey: `act:${act.id}`,
              rowType: 'activity',
              level: 3,
              indexLabel: String(globalActivityNumber),
              title: act.name,
              phaseLabel: strName,
              startDate: act.startDate,
              dueDate: act.dueDate,
              progressPercent: act.progressPercent,
              scheduleStatus: act.scheduleStatus,
              scheduleStatusLabel: act.scheduleStatusLabel,
              activityCount: 1,
              activity: act
            });
          }
        }
      }
    } else {
      const strMap = new Map<string, EvaluatedGanttActivity[]>();
      for (const act of areaActs) {
        const strKey = act.structureName || 'General';
        if (!strMap.has(strKey)) strMap.set(strKey, []);
        strMap.get(strKey)!.push(act);
      }

      let strIdx = 0;
      for (const [strName, strActs] of strMap.entries()) {
        strIdx += 1;
        const strGroupKey = `str:${areaName}::${strName}`;
        const strSummary = summarizeGroupSchedule(strActs, todayStr);

        rows.push({
          rowKey: strGroupKey,
          rowType: 'structure',
          level: 1,
          indexLabel: `${areaIdx}.${strIdx}`,
          title: strName,
          phaseLabel: areaName,
          startDate: strSummary.startDate,
          dueDate: strSummary.dueDate,
          progressPercent: strSummary.progressPercent,
          scheduleStatus: strSummary.scheduleStatus,
          scheduleStatusLabel: strSummary.scheduleStatusLabel,
          activityCount: strActs.length,
          groupKey: strGroupKey
        });

        if (collapsedGroups[strGroupKey]) continue;

        for (const act of strActs) {
          globalActivityNumber += 1;
          rows.push({
            rowKey: `act:${act.id}`,
            rowType: 'activity',
            level: 2,
            indexLabel: String(globalActivityNumber),
            title: act.name,
            phaseLabel: strName,
            startDate: act.startDate,
            dueDate: act.dueDate,
            progressPercent: act.progressPercent,
            scheduleStatus: act.scheduleStatus,
            scheduleStatusLabel: act.scheduleStatusLabel,
            activityCount: 1,
            activity: act
          });
        }
      }
    }
  }

  return rows;
}
