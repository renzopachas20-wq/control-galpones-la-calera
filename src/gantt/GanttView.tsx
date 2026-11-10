import React, { useState, useMemo, useRef, useEffect } from 'react';
import { indexActivityAdvances } from '../dashboard/advanceIndex';
import { ambiguousActivityCodes, ganttPlannedActivities } from '../firebase/advanceActivity';
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Download,
  Maximize2,
  Minimize2,
  Plus,
  Filter,
  RotateCcw
} from 'lucide-react';
import {
  type GanttViewScale,
  type GanttStatusFilter,
  type EvaluatedGanttActivity,
  evaluateGanttActivity,
  evaluateGanttDayCell,
  computeDefaultGanttDateRange,
  buildGanttCalendarModel,
  extractDynamicGanttAreas,
  filterAndSortGanttActivities,
  shiftGanttDateRange,
  formatShortDisplayDate
} from './ganttEngine';

interface GanttViewProps {
  currentSector: any;
  currentGalpon: any;
  rawActivities: any[];
  dailyAdvances: any[];
  todayStr: string;
  canCreateActivity: boolean;
  canEditGantt: boolean;
  canExportGantt: boolean;
  canDeleteGantt: boolean;
  onWithdrawActivity: (id: string) => void;
  onOpenNewActivity: () => void;
  onDateChange: (
    activityId: string,
    field: 'startDate' | 'dueDate',
    value: string
  ) => void;
}

export const GanttView: React.FC<GanttViewProps> = ({
  currentSector,
  currentGalpon,
  rawActivities,
  dailyAdvances,
  todayStr,
  canCreateActivity,
  canEditGantt,
  canExportGantt,
  canDeleteGantt,
  onWithdrawActivity,
  onOpenNewActivity,
  onDateChange
}) => {
  const [viewScale, setViewScale] = useState<GanttViewScale>('day');
  const [customFromDate, setCustomFromDate] = useState<string>('');
  const [customToDate, setCustomToDate] = useState<string>('');
  const [areaFilter, setAreaFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<GanttStatusFilter>('ALL');
  const [isExpandedView, setIsExpandedView] = useState<boolean>(false);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Evaluar todas las actividades del galpón activo con el motor único evaluateActivityProgress
  // preservando el índice original de Gestión de Actividades para desempates de fecha.
  const ganttActivities: EvaluatedGanttActivity[] = useMemo(() => {
    if (!currentGalpon || !Array.isArray(rawActivities)) return [];
    const byActivity = indexActivityAdvances(dailyAdvances ?? [], new Map([[currentGalpon.id, ambiguousActivityCodes(rawActivities)]]));
    return ganttPlannedActivities(rawActivities, currentGalpon.ganttExcludedActivityIds).map((act, originalIndex) => {
      const logsForAct = byActivity(currentGalpon.id, act.id, act.code);
      return evaluateGanttActivity(act, logsForAct, todayStr, originalIndex);
    });
  }, [currentGalpon, rawActivities, dailyAdvances, todayStr]);

  // Áreas dinámicas disponibles en el galpón activo y sus actividades reales
  const availableAreas: string[] = useMemo(
    () => extractDynamicGanttAreas(currentGalpon, ganttActivities),
    [currentGalpon, ganttActivities]
  );

  // Si cambia el galpón o se elimina un área seleccionada, restablecer filtro de área a ALL
  useEffect(() => {
    if (areaFilter !== 'ALL' && !availableAreas.includes(areaFilter)) {
      setAreaFilter('ALL');
    }
  }, [areaFilter, availableAreas]);

  // Actividades filtradas (Área + Estado) y ordenadas automáticamente por Fecha de Inicio ascendente
  const visibleActivities: EvaluatedGanttActivity[] = useMemo(
    () =>
      filterAndSortGanttActivities(ganttActivities, {
        areaFilter,
        statusFilter
      }),
    [ganttActivities, areaFilter, statusFilter]
  );

  const hasActiveFilters = areaFilter !== 'ALL' || statusFilter !== 'ALL';

  const handleClearFilters = () => {
    setAreaFilter('ALL');
    setStatusFilter('ALL');
  };

  // Rango automático por defecto al cambiar de galpón
  const defaultRange = useMemo(
    () => computeDefaultGanttDateRange(ganttActivities, todayStr),
    [ganttActivities, todayStr]
  );

  useEffect(() => {
    setCustomFromDate(defaultRange.fromDate);
    setCustomToDate(defaultRange.toDate);
  }, [currentGalpon?.id, defaultRange.fromDate, defaultRange.toDate]);

  const effectiveFromDate = customFromDate || defaultRange.fromDate;
  const effectiveToDate = customToDate || defaultRange.toDate;

  const calendarModel = useMemo(
    () => buildGanttCalendarModel(effectiveFromDate, effectiveToDate, todayStr),
    [effectiveFromDate, effectiveToDate, todayStr]
  );

  // Ancho de columna por día según la vista seleccionada (sin comprimir el calendario)
  const dayColWidthPx = useMemo(() => {
    if (viewScale === 'day') return 34;
    if (viewScale === 'week') return 26;
    return 18;
  }, [viewScale]);

  // Navegar a fechas anteriores o siguientes en el cronograma
  const handleShiftRange = (direction: 'prev' | 'next') => {
    const shifted = shiftGanttDateRange(
      effectiveFromDate,
      effectiveToDate,
      direction,
      viewScale
    );
    setCustomFromDate(shifted.fromDate);
    setCustomToDate(shifted.toDate);
  };

  // Centrar calendario en la fecha actual ("Ir a hoy")
  const handleGoToToday = () => {
    let targetFrom = effectiveFromDate;
    let targetTo = effectiveToDate;

    if (todayStr < targetFrom || todayStr > targetTo) {
      targetFrom = defaultRange.fromDate;
      targetTo = defaultRange.toDate;
      setCustomFromDate(targetFrom);
      setCustomToDate(targetTo);
    }

    requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const todayEl = container.querySelector(
        '[data-testid="gantt-today-header-cell"]'
      ) as HTMLElement | null;
      if (todayEl) {
        const offsetLeft = todayEl.offsetLeft;
        container.scrollTo({
          left: Math.max(0, offsetLeft - container.clientWidth * 0.65),
          behavior: 'smooth'
        });
      }
    });
  };

  // Exportar cronograma a Excel (.xlsx) respetando las columnas oficiales y el ordenamiento
  const handleExportExcel = async () => {
    if (!canExportGantt) return;
    if (!currentGalpon) return;
    const rowsData = visibleActivities.map((act) => ({
      Código: act.code,
      Área: act.areaName,
      'Ubicación / Sistema': act.ubicacionSistemaLabel,
      Estructura: act.structureName,
      Actividad: act.name,
      Fase: act.primaryCondition
        ? `${act.phaseStateLabel} (${act.primaryCondition})`
        : act.phaseStateLabel,
      Inicio: act.startDate || '—',
      Fin: act.dueDate || '—',
      Avance: `${act.progressPercent}%`,
      Modalidad: act.progressMode === 'percentage' ? 'Porcentaje (%)' : 'Cantidades',
      Meta: `${act.targetUnits} ${act.unit}`,
      Ejecutado:
        act.progressMode === 'percentage'
          ? `${act.progressPercent}%`
          : `${act.accumulatedQty} ${act.unit}`,
      'Fechas con Ejecución Real': act.executedDates.join(', ') || 'Sin registros'
    }));

    const XLSX = await import('xlsx');
    const ws = XLSX.utils.json_to_sheet(rowsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Cronograma Gantt');
    XLSX.writeFile(
      wb,
      `Cronograma_Gantt_${currentGalpon.code || 'Galpon'}_${todayStr}.xlsx`
    );
  };

  const getProgressBarColorClass = (act: EvaluatedGanttActivity): string => {
    if (act.progressPercent >= 100) return 'bg-emerald-800';
    if (act.isOverdue) return 'bg-rose-600';
    if (act.isAhead) return 'bg-blue-600';
    return 'bg-emerald-500';
  };

  const getProgressTextColorClass = (act: EvaluatedGanttActivity): string => {
    if (act.progressPercent >= 100) return 'text-emerald-900';
    if (act.isOverdue) return 'text-rose-700';
    if (act.isAhead) return 'text-blue-700';
    return 'text-slate-800';
  };

  return (
    <div
      data-testid="gantt-module-view"
      className={
        isExpandedView
          ? 'fixed inset-0 z-40 bg-slate-100 p-2 sm:p-4 pb-20 flex flex-col overflow-hidden'
          : 'space-y-2'
      }
    >
      {/* ================================================================== */}
      {/* BARRA SUPERIOR: FILTROS DINÁMICOS Y CONTROLES DEL CRONOGRAMA       */}
      {/* ================================================================== */}
      <div
        data-testid="gantt-top-controls"
        className="bg-white px-2.5 sm:px-3.5 py-2 rounded-xl border border-slate-200 shadow-2xs flex flex-col gap-1.5 sm:gap-2"
      >
        {/* Fila 1 de controles: Filtros dinámicos (Área + Estado + Limpiar) y Acciones derechas */}
        <div className="flex flex-wrap items-center justify-between gap-1.5 sm:gap-2">
          {/* Bloque de Filtros Dinámicos */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 w-full sm:w-auto">
            <div className="hidden sm:inline-flex items-center gap-1.5 text-slate-600 text-xs font-bold mr-0.5">
              <Filter className="w-3.5 h-3.5 text-[#0f6b38]" />
              <span>Filtros:</span>
            </div>

            {/* Filtro 1 — Área (dinámico) */}
            <div className="flex-1 sm:flex-initial flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200 min-w-[130px]">
              <label
                htmlFor="gantt-select-area"
                className="text-[10px] sm:text-[11px] font-bold text-slate-500 whitespace-nowrap"
              >
                Área:
              </label>
              <select
                id="gantt-select-area"
                data-testid="gantt-filter-area"
                value={areaFilter}
                onChange={(e) => setAreaFilter(e.target.value)}
                className="w-full text-[11px] sm:text-xs font-semibold text-slate-800 bg-transparent focus:outline-none cursor-pointer truncate"
              >
                <option value="ALL">Todas las áreas</option>
                {availableAreas.map((areaName) => (
                  <option key={areaName} value={areaName}>
                    {areaName}
                  </option>
                ))}
              </select>
            </div>

            {/* Filtro 2 — Estado / Condición */}
            <div className="flex-1 sm:flex-initial flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200 min-w-[130px]">
              <label
                htmlFor="gantt-select-status"
                className="text-[10px] sm:text-[11px] font-bold text-slate-500 whitespace-nowrap"
              >
                Estado:
              </label>
              <select
                id="gantt-select-status"
                data-testid="gantt-filter-status"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as GanttStatusFilter)
                }
                className="w-full text-[11px] sm:text-xs font-semibold text-slate-800 bg-transparent focus:outline-none cursor-pointer truncate"
              >
                <option value="ALL">Todos los estados</option>
                <option value="NO_INICIADO">No iniciado</option>
                <option value="EN_PROGRESO">En progreso</option>
                <option value="COMPLETADO">Completado</option>
                <option value="ATRASADO">Atrasado</option>
                <option value="ADELANTADO">Adelantado</option>
              </select>
            </div>

            {/* Botón Limpiar Filtros */}
            <button
              type="button"
              data-testid="gantt-btn-clear-filters"
              onClick={handleClearFilters}
              disabled={!hasActiveFilters}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] sm:text-xs font-bold border transition cursor-pointer ${
                hasActiveFilters
                  ? 'bg-amber-50 hover:bg-amber-100 text-amber-900 border-amber-300'
                  : 'bg-slate-50 text-slate-400 border-slate-200 opacity-60 cursor-not-allowed'
              }`}
              title="Restablecer filtros de Área y Estado"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Limpiar filtros</span>
            </button>

            <span
              data-testid="gantt-visible-count"
              className="text-[10px] sm:text-[11px] font-semibold text-slate-500"
            >
              ({visibleActivities.length}/{ganttActivities.length})
            </span>
          </div>

          {/* Bloque derecho: Exportar, Ampliar vista y Nueva Actividad */}
          <div className="flex flex-wrap items-center gap-1.5">
            {canExportGantt && <button
              type="button"
              data-testid="gantt-btn-export"
              disabled={!currentGalpon || visibleActivities.length === 0}
              onClick={handleExportExcel}
              className="inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-slate-800 font-bold text-[11px] sm:text-xs border border-slate-200 transition cursor-pointer"
              title="Exportar cronograma Gantt a Excel"
            >
              <Download className="w-3.5 h-3.5 text-[#0f6b38]" />
              <span>Exportar</span>
            </button>}

            <button
              type="button"
              data-testid="gantt-btn-expand-view"
              onClick={() => setIsExpandedView((prev) => !prev)}
              className={`inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg font-bold text-[11px] sm:text-xs border transition cursor-pointer ${
                isExpandedView
                  ? 'bg-emerald-50 text-[#0f6b38] border-emerald-300'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-200'
              }`}
              title={isExpandedView ? 'Restaurar vista normal' : 'Ampliar vista del Gantt'}
            >
              {isExpandedView ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
              <span>{isExpandedView ? 'Reducir vista' : 'Ampliar vista'}</span>
            </button>

            {canCreateActivity && (
              <button
                type="button"
                data-testid="gantt-btn-new-activity"
                disabled={!currentGalpon}
                onClick={onOpenNewActivity}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white font-bold text-[11px] sm:text-xs transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Nueva Actividad</span>
              </button>
            )}
          </div>
        </div>

        {/* Fila 2 de controles: Escala (Diaria/Semanal/Mensual), Navegación (Anterior/Ir a hoy/Siguiente) y Rango de Fechas */}
        <div className="flex flex-wrap items-center justify-between gap-1.5 sm:gap-2 pt-1.5 border-t border-slate-100">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            {/* Selector Diaria / Semanal / Mensual */}
            <div
              role="group"
              aria-label="Selector de escala del Gantt"
              className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200"
            >
              <button
                type="button"
                data-testid="gantt-scale-day"
                onClick={() => setViewScale('day')}
                className={`px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md text-[11px] sm:text-xs font-bold transition cursor-pointer ${
                  viewScale === 'day'
                    ? 'bg-[#0f6b38] text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Diaria
              </button>
              <button
                type="button"
                data-testid="gantt-scale-week"
                onClick={() => setViewScale('week')}
                className={`px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md text-[11px] sm:text-xs font-bold transition cursor-pointer ${
                  viewScale === 'week'
                    ? 'bg-[#0f6b38] text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Semanal
              </button>
              <button
                type="button"
                data-testid="gantt-scale-month"
                onClick={() => setViewScale('month')}
                className={`px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md text-[11px] sm:text-xs font-bold transition cursor-pointer ${
                  viewScale === 'month'
                    ? 'bg-[#0f6b38] text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Mensual
              </button>
            </div>

            {/* Navegación del cronograma: Anterior / Ir a hoy / Siguiente */}
            <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
              <button
                type="button"
                data-testid="gantt-btn-prev-range"
                onClick={() => handleShiftRange('prev')}
                className="inline-flex items-center gap-0.5 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-md text-[11px] sm:text-xs font-bold text-slate-700 hover:bg-white hover:text-slate-900 transition cursor-pointer"
                title="Desplazar cronograma a fechas anteriores"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Anterior</span>
              </button>

              <button
                type="button"
                data-testid="gantt-btn-today"
                onClick={handleGoToToday}
                className="inline-flex items-center gap-1 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md bg-white text-slate-900 font-bold text-[11px] sm:text-xs shadow-2xs hover:bg-emerald-50 transition cursor-pointer mx-0.5"
                title={`Ir a hoy (${formatShortDisplayDate(todayStr)})`}
              >
                <Calendar className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#0f6b38]" />
                <span>Ir a hoy</span>
              </button>

              <button
                type="button"
                data-testid="gantt-btn-next-range"
                onClick={() => handleShiftRange('next')}
                className="inline-flex items-center gap-0.5 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-md text-[11px] sm:text-xs font-bold text-slate-700 hover:bg-white hover:text-slate-900 transition cursor-pointer"
                title="Desplazar cronograma a fechas siguientes"
              >
                <span className="hidden sm:inline">Siguiente</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Selector de rango de fechas (Desde / Hasta) */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <div className="flex items-center gap-1 bg-slate-50 px-2 py-0.5 sm:py-1 rounded-lg border border-slate-200">
              <label
                htmlFor="gantt-from-date"
                className="text-[10px] sm:text-[11px] font-semibold text-slate-500 whitespace-nowrap"
              >
                Desde:
              </label>
              <input
                id="gantt-from-date"
                type="date"
                data-testid="gantt-filter-from-date"
                value={effectiveFromDate}
                onChange={(e) => setCustomFromDate(e.target.value)}
                className="text-[11px] sm:text-xs font-mono font-semibold text-slate-800 bg-transparent focus:outline-none cursor-pointer"
              />
            </div>

            <div className="flex items-center gap-1 bg-slate-50 px-2 py-0.5 sm:py-1 rounded-lg border border-slate-200">
              <label
                htmlFor="gantt-to-date"
                className="text-[10px] sm:text-[11px] font-semibold text-slate-500 whitespace-nowrap"
              >
                Hasta:
              </label>
              <input
                id="gantt-to-date"
                type="date"
                data-testid="gantt-filter-to-date"
                value={effectiveToDate}
                onChange={(e) => setCustomToDate(e.target.value)}
                className="text-[11px] sm:text-xs font-mono font-semibold text-slate-800 bg-transparent focus:outline-none cursor-pointer"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ================================================================== */}
      {/* TABLA SINCRONIZADA DE 10 COLUMNAS (9 IZQUIERDAS + 10 CRONOGRAMA)   */}
      {/* ================================================================== */}
      <div
        data-testid="gantt-split-container"
        className={`bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden flex flex-col ${
          isExpandedView ? 'flex-1 min-h-0' : ''
        }`}
      >
        <div
          ref={scrollContainerRef}
          data-testid="gantt-scroll-viewport"
          className={`overflow-x-auto overflow-y-auto ${
            isExpandedView ? 'flex-1' : 'max-h-[calc(100vh-230px)]'
          }`}
        >
          <table
            data-testid="gantt-synchronized-table"
            className="w-max min-w-full border-separate border-spacing-0 text-left text-xs select-none"
          >
            <thead className="sticky top-0 z-30 bg-slate-900 text-white">
              {/* FILA 1 DE ENCABEZADO: 9 Columnas de Información (rowSpan=3) + Columna 10 Cronograma (Mes y Año) */}
              <tr className="h-7">
                {/* 1. Código */}
                <th
                  rowSpan={3}
                  data-testid="gantt-col-header-codigo"
                  className="sticky left-0 z-40 w-[68px] min-w-[68px] max-w-[68px] bg-[#0f6b38] px-1.5 text-center font-bold text-[11px] border-r border-b border-emerald-800/80 shadow-[2px_0_6px_rgba(0,0,0,0.12)] xl:shadow-none"
                >
                  Código
                </th>

                {/* 2. Área */}
                <th
                  rowSpan={3}
                  data-testid="gantt-col-header-area"
                  className="xl:sticky xl:left-[68px] xl:z-40 w-[104px] min-w-[104px] max-w-[104px] bg-[#0f6b38] px-2 font-bold text-[11px] border-r border-b border-emerald-800/80"
                >
                  Área
                </th>

                {/* 3. Ubicación / Sistema */}
                <th
                  rowSpan={3}
                  data-testid="gantt-col-header-ubicacion-sistema"
                  className="xl:sticky xl:left-[172px] xl:z-40 w-[130px] min-w-[130px] max-w-[130px] bg-[#0f6b38] px-2 font-bold text-[11px] border-r border-b border-emerald-800/80"
                >
                  Ubicación / Sistema
                </th>

                {/* 4. Estructura */}
                <th
                  rowSpan={3}
                  data-testid="gantt-col-header-estructura"
                  className="xl:sticky xl:left-[302px] xl:z-40 w-[104px] min-w-[104px] max-w-[104px] bg-[#0f6b38] px-2 font-bold text-[11px] border-r border-b border-emerald-800/80"
                >
                  Estructura
                </th>

                {/* 5. Actividad */}
                <th
                  rowSpan={3}
                  data-testid="gantt-col-header-actividad"
                  className="xl:sticky xl:left-[406px] xl:z-40 w-[158px] min-w-[158px] max-w-[158px] bg-[#0f6b38] px-2 font-bold text-[11px] border-r border-b border-emerald-800/80"
                >
                  Actividad
                </th>

                {/* 6. Fase */}
                <th
                  rowSpan={3}
                  data-testid="gantt-col-header-fase"
                  className="xl:sticky xl:left-[564px] xl:z-40 w-[106px] min-w-[106px] max-w-[106px] bg-[#0f6b38] px-1.5 text-center font-bold text-[11px] border-r border-b border-emerald-800/80"
                >
                  Fase
                </th>

                {/* 7. Inicio */}
                <th
                  rowSpan={3}
                  data-testid="gantt-col-header-inicio"
                  className="xl:sticky xl:left-[670px] xl:z-40 w-[114px] min-w-[114px] max-w-[114px] bg-[#0f6b38] px-1 text-center font-bold text-[11px] border-r border-b border-emerald-800/80"
                >
                  Inicio
                </th>

                {/* 8. Fin */}
                <th
                  rowSpan={3}
                  data-testid="gantt-col-header-fin"
                  className="xl:sticky xl:left-[784px] xl:z-40 w-[114px] min-w-[114px] max-w-[114px] bg-[#0f6b38] px-1 text-center font-bold text-[11px] border-r border-b border-emerald-800/80"
                >
                  Fin
                </th>

                {/* 9. Avance */}
                <th
                  rowSpan={3}
                  data-testid="gantt-col-header-avance"
                  className="xl:sticky xl:left-[898px] xl:z-40 w-[86px] min-w-[86px] max-w-[86px] bg-[#0f6b38] px-2 text-right font-bold text-[11px] border-r-2 border-b border-emerald-950 xl:shadow-[3px_0_8px_rgba(0,0,0,0.15)]"
                >
                  Avance
                </th>

                {/* 10. Cronograma (Encabezado derecho Fila 1: MES Y AÑO) */}
                {calendarModel.months.map((m, idx) => (
                  <th
                    key={m.key}
                    data-testid={idx === 0 ? 'gantt-col-header-cronograma' : undefined}
                    colSpan={m.span}
                    className="bg-slate-900 text-slate-100 px-2 text-center font-bold text-[11px] tracking-tight border-r border-b border-slate-700 whitespace-nowrap"
                  >
                    {idx === 0 ? `Cronograma • ${m.label}` : m.label}
                  </th>
                ))}
              </tr>

              {/* FILA 2 DE ENCABEZADO: SEMANAS */}
              <tr className="h-6 bg-slate-800 text-slate-200">
                {calendarModel.weeks.map((w) => (
                  <th
                    key={w.key}
                    colSpan={w.span}
                    className="px-1 text-center font-semibold text-[10px] border-r border-b border-slate-700 whitespace-nowrap"
                  >
                    {w.label}
                  </th>
                ))}
              </tr>

              {/* FILA 3 DE ENCABEZADO: DÍAS INDIVIDUALES */}
              <tr className="h-8 bg-slate-800 text-slate-200">
                {calendarModel.days.map((d) => (
                  <th
                    key={d.date}
                    data-testid={d.isToday ? 'gantt-today-header-cell' : undefined}
                    style={{
                      width: `${dayColWidthPx}px`,
                      minWidth: `${dayColWidthPx}px`,
                      maxWidth: `${dayColWidthPx}px`
                    }}
                    className={`p-0 text-center border-r border-b border-slate-700/70 relative ${
                      d.isToday
                        ? 'bg-amber-400 text-slate-950 font-black'
                        : d.isWeekend
                        ? 'bg-slate-900 text-slate-400 font-medium'
                        : 'text-slate-200 font-semibold'
                    }`}
                    title={
                      d.isToday
                        ? `Hoy: ${formatShortDisplayDate(d.date)}`
                        : formatShortDisplayDate(d.date)
                    }
                  >
                    <div className="flex flex-col items-center justify-center leading-none py-0.5">
                      <span className="text-[9px] opacity-80">{d.dayShortName}</span>
                      <span className="text-[10px] font-mono tabular-nums mt-0.5">
                        {d.dayNumber}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {visibleActivities.length === 0 ? (
                <tr>
                  <td
                    colSpan={9 + calendarModel.days.length}
                    className="py-12 px-6 text-center text-slate-500 font-medium bg-white"
                  >
                    {hasActiveFilters
                      ? 'No hay actividades que coincidan con los filtros seleccionados.'
                      : 'No hay actividades registradas en este galpón.'}
                  </td>
                </tr>
              ) : (
                visibleActivities.map((act) => {
                  const rowBgLeft = 'bg-white group-hover:bg-slate-50 text-slate-800';

                  const phaseBadgeClass =
                    act.phaseState === 'COMPLETADO'
                      ? 'bg-emerald-800 text-white'
                      : act.phaseState === 'EN_PROGRESO'
                      ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                      : 'bg-slate-100 text-slate-700 border border-slate-300';

                  return (
                    <tr
                      key={act.id}
                      data-testid={`gantt-activity-row-${act.code || act.id}`}
                      className={`group h-10 transition-colors ${rowBgLeft}`}
                    >
                      {/* COLUMNA 1: Código visible (nunca ID interno) */}
                      <td
                        data-testid={`gantt-cell-codigo-${act.code || act.id}`}
                        className={`sticky left-0 z-20 w-[68px] min-w-[68px] max-w-[68px] px-1 text-center font-mono text-[11px] font-bold text-[#0f6b38] tabular-nums border-r border-b border-slate-200 shadow-[2px_0_6px_rgba(0,0,0,0.06)] xl:shadow-none truncate ${rowBgLeft}`}
                        title={act.code}
                      >
                        {act.code}
                      </td>

                      {/* COLUMNA 2: Área */}
                      <td
                        data-testid={`gantt-cell-area-${act.code || act.id}`}
                        className={`xl:sticky xl:left-[68px] xl:z-20 w-[104px] min-w-[104px] max-w-[104px] px-2 truncate text-[11px] font-semibold text-slate-800 border-r border-b border-slate-200 ${rowBgLeft}`}
                        title={act.areaName}
                      >
                        {act.areaName}
                      </td>

                      {/* COLUMNA 3: Ubicación / Sistema */}
                      <td
                        data-testid={`gantt-cell-ubicacion-sistema-${act.code || act.id}`}
                        className={`xl:sticky xl:left-[172px] xl:z-20 w-[130px] min-w-[130px] max-w-[130px] px-2 truncate text-[11px] text-slate-600 border-r border-b border-slate-200 ${rowBgLeft}`}
                        title={act.ubicacionSistemaLabel}
                      >
                        {act.ubicacionSistemaLabel}
                      </td>

                      {/* COLUMNA 4: Estructura */}
                      <td
                        data-testid={`gantt-cell-estructura-${act.code || act.id}`}
                        className={`xl:sticky xl:left-[302px] xl:z-20 w-[104px] min-w-[104px] max-w-[104px] px-2 truncate text-[11px] text-slate-700 border-r border-b border-slate-200 ${rowBgLeft}`}
                        title={act.structureName}
                      >
                        {act.structureName}
                      </td>

                      {/* COLUMNA 5: Actividad */}
                      <td
                        data-testid={`gantt-cell-actividad-${act.code || act.id}`}
                        className={`xl:sticky xl:left-[406px] xl:z-20 w-[158px] min-w-[158px] max-w-[158px] px-2 truncate text-[11px] font-medium text-slate-900 border-r border-b border-slate-200 ${rowBgLeft}`}
                        title={act.name}
                      >
                        {act.name}
                      </td>

                      {/* COLUMNA 6: Fase (Estado principal automático + Condición adicional) */}
                      <td
                        data-testid={`gantt-cell-fase-${act.code || act.id}`}
                        className={`xl:sticky xl:left-[564px] xl:z-20 w-[106px] min-w-[106px] max-w-[106px] px-1 text-center border-r border-b border-slate-200 ${rowBgLeft}`}
                        title={
                          act.conditions.length > 0
                            ? `${act.phaseStateLabel} • ${act.conditions.join(' / ')}`
                            : act.phaseStateLabel
                        }
                      >
                        <div className="flex flex-col items-center justify-center gap-0.5 leading-none py-0.5">
                          <span
                            className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-extrabold tracking-tight whitespace-nowrap ${phaseBadgeClass}`}
                          >
                            {act.phaseStateLabel}
                          </span>
                          {act.isOverdue && (
                            <span className="inline-block px-1 py-0.2 rounded bg-rose-100 text-rose-800 border border-rose-300 text-[8px] font-black tracking-tight whitespace-nowrap">
                              ATRASADO
                            </span>
                          )}
                          {!act.isOverdue && act.isAhead && (
                            <span className="inline-block px-1 py-0.2 rounded bg-blue-100 text-blue-800 border border-blue-300 text-[8px] font-black tracking-tight whitespace-nowrap">
                              ADELANTADO
                            </span>
                          )}
                        </div>
                      </td>

                      {/* COLUMNA 7: Inicio */}
                      <td
                        data-testid={`gantt-cell-inicio-${act.code || act.id}`}
                        className={`xl:sticky xl:left-[670px] xl:z-20 w-[114px] min-w-[114px] max-w-[114px] px-1 text-center border-r border-b border-slate-200 ${rowBgLeft}`}
                      >
                        <input
                          type="date"
                          aria-label={`Fecha inicio ${act.code || act.name}`}
                          disabled={!canEditGantt}
                          value={act.startDate || ''}
                          onChange={(e) =>
                            onDateChange(act.id, 'startDate', e.target.value)
                          }
                          className="w-full px-1 py-0.5 rounded border border-slate-200 bg-slate-50 hover:border-slate-300 text-[10px] font-mono tabular-nums text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#0f6b38]"
                        />
                        {canDeleteGantt && (
                          <button type="button" className="mt-1 text-[10px] text-red-700 underline"
                            onClick={() => onWithdrawActivity(act.id)}>Retirar del plan</button>
                        )}
                      </td>

                      {/* COLUMNA 8: Fin */}
                      <td
                        data-testid={`gantt-cell-fin-${act.code || act.id}`}
                        className={`xl:sticky xl:left-[784px] xl:z-20 w-[114px] min-w-[114px] max-w-[114px] px-1 text-center border-r border-b border-slate-200 ${rowBgLeft}`}
                      >
                        <input
                          type="date"
                          aria-label={`Fecha fin ${act.code || act.name}`}
                          disabled={!canEditGantt}
                          value={act.dueDate || ''}
                          onChange={(e) =>
                            onDateChange(act.id, 'dueDate', e.target.value)
                          }
                          className="w-full px-1 py-0.5 rounded border border-slate-200 bg-slate-50 hover:border-slate-300 text-[10px] font-mono tabular-nums text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#0f6b38]"
                        />
                      </td>

                      {/* COLUMNA 9: Avance (Porcentaje real + barra visual proporcional) */}
                      <td
                        data-testid={`gantt-cell-avance-${act.code || act.id}`}
                        className={`xl:sticky xl:left-[898px] xl:z-20 w-[86px] min-w-[86px] max-w-[86px] px-1.5 border-r-2 border-b border-slate-300 xl:shadow-[3px_0_8px_rgba(0,0,0,0.06)] ${rowBgLeft}`}
                      >
                        <div className="flex flex-col justify-center gap-0.5">
                          <div className="flex items-center justify-between gap-1 leading-none">
                            <span className="text-[9px] font-semibold text-slate-400 truncate">
                              {act.progressMode === 'percentage'
                                ? '%'
                                : `${act.accumulatedQty}/${act.targetUnits}`}
                            </span>
                            <span
                              data-testid={`gantt-progress-pct-${act.code || act.id}`}
                              className={`font-mono font-black text-[11px] tabular-nums ${getProgressTextColorClass(
                                act
                              )}`}
                            >
                              {act.progressPercent}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${getProgressBarColorClass(
                                act
                              )}`}
                              style={{
                                width: `${Math.min(
                                  100,
                                  Math.max(0, act.progressPercent)
                                )}%`
                              }}
                            />
                          </div>
                        </div>
                      </td>

                      {/* ====================================================== */}
                      {/* COLUMNA 10: CRONOGRAMA (CAPAS 1 PLAN Y 2 EJECUCIÓN)    */}
                      {/* ====================================================== */}
                      {calendarModel.days.map((d) => {
                        const cellState = evaluateGanttDayCell({
                          date: d.date,
                          startDate: act.startDate,
                          dueDate: act.dueDate,
                          progressPercent: act.progressPercent,
                          logsByDate: act.logsByDate
                        });

                        const executionColorClass =
                          cellState.executionColor === 'blue'
                            ? 'bg-blue-600'
                            : cellState.executionColor === 'dark_green'
                            ? 'bg-emerald-800'
                            : cellState.executionColor === 'red'
                            ? 'bg-rose-600'
                            : cellState.executionColor === 'green'
                            ? 'bg-emerald-500'
                            : '';

                        const cellTooltip = cellState.logSummary
                          ? `${act.code} - ${act.name} (${formatShortDisplayDate(
                              d.date
                            )}): ${
                              act.progressMode === 'percentage'
                                ? `${
                                    cellState.logSummary.latestPercentageReached ?? 0
                                  }% alcanzado`
                                : `+${cellState.logSummary.totalQuantityToday} ${act.unit}`
                            }${
                              cellState.logSummary.totalHoursWorked > 0
                                ? ` • ${cellState.logSummary.totalHoursWorked} HH`
                                : ''
                            }`
                          : cellState.isPlanned
                          ? `${act.code} - ${act.name}: Planificado (${formatShortDisplayDate(
                              act.startDate
                            )} al ${formatShortDisplayDate(act.dueDate)})`
                          : undefined;

                        return (
                          <td
                            key={d.date}
                            data-testid={
                              cellState.cellColor
                                ? `gantt-cell-${act.code || act.id}-${d.date}`
                                : undefined
                            }
                            data-cell-color={cellState.cellColor || 'empty'}
                            style={{
                              width: `${dayColWidthPx}px`,
                              minWidth: `${dayColWidthPx}px`,
                              maxWidth: `${dayColWidthPx}px`
                            }}
                            title={cellTooltip}
                            className={`p-0 relative border-r border-b border-slate-100 ${
                              d.isWeekend ? 'bg-slate-50/80' : 'bg-white'
                            }`}
                          >
                            {/* Línea vertical indicadora de Fecha Actual (Hoy) */}
                            {d.isToday && (
                              <div
                                data-testid="gantt-today-indicator"
                                className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-amber-500/90 z-10 pointer-events-none"
                              />
                            )}

                            <div className="w-full h-10 flex items-center justify-center relative">
                              {/* CAPA 1: PLANIFICACIÓN (Barra gris continua entre Inicio y Fin) */}
                              {cellState.isPlanned && (
                                <div
                                  data-layer="planning"
                                  className={`w-full h-4 ${
                                    act.progressPercent >= 100
                                      ? 'bg-emerald-800/25'
                                      : 'bg-slate-300/90'
                                  } ${
                                    cellState.isPlanStart ? 'rounded-l-md ml-0.5' : ''
                                  } ${
                                    cellState.isPlanEnd ? 'rounded-r-md mr-0.5' : ''
                                  }`}
                                />
                              )}

                              {/* CAPA 2: EJECUCIÓN REAL (Azul / Verde / Verde oscuro / Rojo según registros reales) */}
                              {cellState.hasRealExecution &&
                                cellState.executionColor && (
                                  <div
                                    data-layer="execution"
                                    data-execution-color={cellState.executionColor}
                                    className={`absolute inset-x-0.5 h-5 rounded-sm shadow-2xs flex items-center justify-center text-[9px] font-mono font-bold text-white ${executionColorClass}`}
                                  >
                                    {dayColWidthPx >= 26 && cellState.logSummary && (
                                      <span className="truncate px-0.5 leading-none">
                                        {act.progressMode === 'percentage' &&
                                        cellState.logSummary
                                          .latestPercentageReached !== null
                                          ? `${Math.round(
                                              cellState.logSummary
                                                .latestPercentageReached
                                            )}%`
                                          : `+${cellState.logSummary.totalQuantityToday}`}
                                      </span>
                                    )}
                                  </div>
                                )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
