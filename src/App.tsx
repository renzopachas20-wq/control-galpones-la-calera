import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Building2,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Plus,
  Trash2,
  Search,
  FileSpreadsheet,
  Download,
  BarChart3,
  TrendingUp,
  Users,
  Check,
  X,
  Layers,
  ClipboardList,
  Edit2,
  UserCheck,
  Menu,
  Settings,
  RefreshCw,
  FolderPlus,
  Table,
  UploadCloud,
  Package,
  BookOpen,
  Filter,
  ChevronLeft,
  ChevronRight,
  LogOut,
  ShieldCheck
} from 'lucide-react';
import { useAuthProfile } from './components/AuthGate';
import { bindOperationalData, duplicateCatalogTemplate, importHistoricalMovements, operationalScopeKey } from './firebase/operationalData';
import { readMovementFile } from './firebase/movementImport';
import { indexMaterialConsumption } from './firebase/materialConsumption';
import { ambiguousActivityCodes, barnActivities, barnResponsible, findAdvanceActivity } from './firebase/advanceActivity';
import { invalidWorkerField, normalizeWorkerCode, workerAtLocation, workerForDisplay } from './firebase/workerData';
import { useFirestoreOperationalSync } from './firebase/firestoreDataService';
import {
  hasModulePermission,
  resolveModule,
  MODULE_LABELS,
  ACTION_LABELS,
  type AppModuleId,
  type PermissionAction
} from './firebase/permissions';
import { DashboardView } from './dashboard/DashboardView';
import { PortfolioOverview } from './dashboard/PortfolioOverview';
import { indexActivityAdvances } from './dashboard/advanceIndex';
import { fieldReport } from './dashboard/fieldReport';
import { escapeCsvCell } from './dashboard/csvExport';
import {
  computeWeightedProgress,
  computeAreaProgressMetrics,
  computeSistemaProgressMetrics,
  type EvaluatedActivityItem
} from './dashboard/dashboardSelectors';
import {
  evaluateActivityProgress,
  normalizeProgressMode,
  getProgressModeLabel,
  validatePercentageAdvanceRegistration,
  canUserAuthorizePercentageCorrection,
  createOperationId,
  getOrCreateDeviceId,
  recordActivityDeletionTombstone,
  isGanttWithdrawal,
  sameOperationalScope,
  resolveDynamicSectorGalponContext,
  type ProgressModality
} from './firebase/offlineSyncEngine';
import {
  OfflineSyncStatusBar,
  OfflineSyncCenterModal
} from './components/OfflineSyncCenterModal';
import { SidebarVersionFooter } from './components/SidebarVersionBadge';
import { GalponLogoIcon } from './components/GalponLogoIcon';
import {
  NO_SISTEMA_VALUE,
  getActiveMasterCatalog,
  catalogCodeKey,
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
  type CatalogAssignmentFormState
} from './catalog/catalogSelectorEngine';

// ============================================================================
// UTILIDADES Y CONSTANTES BASE (SIN DATOS DE DEMOSTRACIÓN)
// ============================================================================

const GanttView = React.lazy(() => import('./gantt/GanttView').then(module => ({ default: module.GanttView })));
const MAX_IMPORT_BYTES = 2_000_000;
const MAX_BULK_ROWS = 1000;
const MOVEMENTS_PAGE_SIZE = 50;
const BULK_COLUMNS = {
  catalogo: ['Proveedor', 'Codigo', 'Area', 'Ubicacion', 'Sistema', 'Estructura', 'Actividad', 'Meta', 'Unidad', 'Peso', 'HH', 'Modalidad', 'DuracionDias'],
  materiales: ['Proveedor', 'Codigo', 'Material', 'Area', 'Sistema', 'Estructura', 'CantidadTotal', 'Unidad', 'Galpon'],
  personal: ['Codigo', 'DNI', 'Nombre', 'Especialidad', 'Cargo', 'Galpon']
};

const generateId = (prefix = 'id'): string => {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const getSystemToday = (): string => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const ALL_AREAS = [
  'Obra Civil',
  'Edificio',
  'Sistema de Jaulas',
  'Sistema Eléctrico',
  'Gasfitería',
  'Soldadura'
];

const AREAS_WITH_SISTEMAS = [
  'Sistema de Jaulas',
  'Jaulas',
  'Comederos',
  'Bebederos',
  'Climatización',
  'Sistema Eléctrico',
  'Electricidad e Iluminación',
  'Gasfitería',
  'Soldadura'
];

const WORK_SPECIALTIES = [
  'Jaulas',
  'Soldadura',
  'Gasfitería',
  'Electricidad',
  'Obra Civil'
];

const ATTENDANCE_STATUSES = [
  'Asistió',
  'Falta',
  'Atención Médica',
  'Permiso',
  'Descanso Médico'
];

const DEFAULT_TECHNOLOGIES: string[] = [];

// Limpieza única de producción autorizada (elimina cualquier registro de prueba previo y conserva nuevos registros reales)
if (typeof window !== 'undefined') {
  try {
    const alreadyResetForProduction = localStorage.getItem('calera_production_reset_v1');
    if (!alreadyResetForProduction) {
      const keysToClear = [
        'calera_technologies_clean',
        'calera_master_catalog_clean',
        'calera_sectors_clean',
        'calera_advances_clean',
        'calera_workforce_clean',
        'calera_materials_clean',
        'calera_attendance_clean',
        'calera_audit_logs_clean',
        'calera_active_user_clean',
        'calera_clean_slate_initialized_v1',
        'calera_sectors_v4',
        'calera_advances_v4',
        'calera_master_workforce_v4',
        'calera_attendance_v4',
        'calera_sectors_v6',
        'calera_advances_v6',
        'calera_master_workforce_v6',
        'calera_attendance_v6',
        'calera_materials_v6',
        'calera_master_catalog_v6'
      ];
      keysToClear.forEach((k) => localStorage.removeItem(k));
      localStorage.setItem('calera_production_reset_v1', 'true');
    }
  } catch {}
}

// Construye las 6 áreas de un galpón filtrando el Catálogo Maestro por la plantilla/proveedor elegido
// Construye las 6 áreas de un galpón filtrando el Catálogo Maestro por la plantilla/proveedor elegido (sin inventar sistemas ni estructuras predeterminadas C-7)
function buildAreasFromCatalog(
  catalog: any[],
  technology: string,
  startDateStr: string
) {
  const cleanTech = (technology || '').trim();
  const baseDate = startDateStr ? new Date(startDateStr) : new Date();
  const techItems = cleanTech
    ? catalog.filter((item) => item.technology === cleanTech)
    : [];

  return ALL_AREAS.map((areaName, aIdx) => {
    const hasSistemas = AREAS_WITH_SISTEMAS.includes(areaName);
    const itemsInArea = techItems.filter((i) => i.areaName === areaName);

    if (hasSistemas) {
      const sisMap = new Map<string, any>();
      itemsInArea.forEach((item, idx) => {
        const sisName = String(item.sistemaName || '').trim();
        const strName = String(item.structureName || '').trim();
        if (!sisName || !strName) return;
        const locType = item.locationType || 'Interno';
        const sisKey = `${locType}__${sisName.toLowerCase()}`;
        if (!sisMap.has(sisKey)) {
          sisMap.set(sisKey, {
            id: generateId('sis'),
            name: sisName,
            locationType: locType,
            structures: []
          });
        }
        const sisObj = sisMap.get(sisKey);
        let strObj = sisObj.structures.find(
          (s: any) => String(s.name || '').trim().toLowerCase() === strName.toLowerCase()
        );
        if (!strObj) {
          strObj = {
            id: generateId('str'),
            name: strName,
            activities: []
          };
          sisObj.structures.push(strObj);
        }

        const actStart = new Date(baseDate);
        actStart.setDate(actStart.getDate() + idx * 2);
        const actEnd = new Date(actStart);
        actEnd.setDate(actEnd.getDate() + (Number(item.durationDays) || 1));
        const mode = normalizeProgressMode(item.progressMode);

        strObj.activities.push({
          id: generateId('act'),
          code: item.code,
          name: item.name,
          progressMode: mode,
          locationType: locType,
          sistemaName: sisName,
          structureName: strObj.name,
          targetUnits: mode === 'percentage' ? 100 : Number(item.targetUnits) || 0,
          unit: mode === 'percentage' ? item.unit || '%' : item.unit || '',
          weight: Number(item.weight) || 1.0,
          plannedHH: Number(item.plannedHH) || 0,
          startDate: actStart.toISOString().split('T')[0],
          dueDate: actEnd.toISOString().split('T')[0],
          status: 'Pendiente'
        });
      });

      return {
        id: generateId(`area_${aIdx}`),
        name: areaName,
        hasSistemas: true,
        sistemas: Array.from(sisMap.values())
      };
    } else {
      const strMap = new Map<string, any>();
      itemsInArea.forEach((item, idx) => {
        const strName = String(item.structureName || '').trim();
        if (!strName) return;
        const strKey = strName.toLowerCase();
        if (!strMap.has(strKey)) {
          strMap.set(strKey, {
            id: generateId('str'),
            name: strName,
            activities: []
          });
        }
        const strObj = strMap.get(strKey);
        const actStart = new Date(baseDate);
        actStart.setDate(actStart.getDate() + idx * 2);
        const actEnd = new Date(actStart);
        actEnd.setDate(actEnd.getDate() + (Number(item.durationDays) || 1));
        const mode = normalizeProgressMode(item.progressMode);

        strObj.activities.push({
          id: generateId('act'),
          code: item.code,
          name: item.name,
          progressMode: mode,
          locationType: 'Interno',
          sistemaName: null,
          structureName: strName,
          targetUnits: mode === 'percentage' ? 100 : Number(item.targetUnits) || 0,
          unit: mode === 'percentage' ? item.unit || '%' : item.unit || '',
          weight: Number(item.weight) || 1.0,
          plannedHH: Number(item.plannedHH) || 0,
          startDate: actStart.toISOString().split('T')[0],
          dueDate: actEnd.toISOString().split('T')[0],
          status: 'Pendiente'
        });
      });

      return {
        id: generateId(`area_${aIdx}`),
        name: areaName,
        hasSistemas: false,
        structures: Array.from(strMap.values())
      };
    }
  });
}

// Sincroniza de forma aditiva y no destructiva las áreas de un galpón con el Catálogo Maestro (C-3 y C-7)
function mergeAreasWithCatalog(
  existingAreas: any[],
  catalog: any[],
  technology: string,
  startDateStr: string
) {
  const cleanTech = (technology || '').trim();
  const baseDate = startDateStr ? new Date(startDateStr) : new Date();
  const techItems = cleanTech
    ? catalog.filter((item) => item.technology === cleanTech)
    : [];

  // Recopilar todos los códigos de actividades que ya existen en el galpón para no duplicarlas ni regenerar IDs
  const existingActivityCodes = new Set<string>();
  (existingAreas || []).forEach((area: any) => {
    if (area.hasSistemas && area.sistemas) {
      area.sistemas.forEach((sis: any) => {
        (sis.structures || []).forEach((str: any) => {
          (str.activities || []).forEach((act: any) => {
            if (act.code) {
              existingActivityCodes.add(String(act.code).trim().toUpperCase());
            }
          });
        });
      });
    } else {
      (area.structures || []).forEach((str: any) => {
        (str.activities || []).forEach((act: any) => {
          if (act.code) {
            existingActivityCodes.add(String(act.code).trim().toUpperCase());
          }
        });
      });
    }
  });

  return ALL_AREAS.map((areaName, aIdx) => {
    const hasSistemas = AREAS_WITH_SISTEMAS.includes(areaName);
    const existingArea = (existingAreas || []).find((a: any) => a.name === areaName);
    const areaId = existingArea?.id || generateId(`area_${aIdx}`);
    const itemsInArea = techItems.filter((i) => i.areaName === areaName);

    if (hasSistemas) {
      const sistemasCopy: any[] = (existingArea?.sistemas || []).map((sis: any) => ({
        ...sis,
        id: sis.id || generateId('sis'),
        structures: (sis.structures || []).map((str: any) => ({
          ...str,
          id: str.id || generateId('str'),
          activities: [...(str.activities || [])]
        }))
      }));

      itemsInArea.forEach((item, idx) => {
        const cleanItemCode = String(item.code || '').trim().toUpperCase();
        if (!cleanItemCode || existingActivityCodes.has(cleanItemCode)) {
          return;
        }

        const sisName = String(item.sistemaName || '').trim();
        const locType = item.locationType || 'Interno';
        const strName = String(item.structureName || '').trim();
        if (!sisName || !strName) return;

        let sisObj = sistemasCopy.find(
          (s: any) =>
            String(s.name || '').trim().toLowerCase() === sisName.toLowerCase() &&
            (s.locationType || 'Interno') === locType
        );
        if (!sisObj) {
          sisObj = {
            id: generateId('sis'),
            name: sisName,
            locationType: locType,
            structures: []
          };
          sistemasCopy.push(sisObj);
        }

        let strObj = (sisObj.structures || []).find(
          (st: any) => String(st.name || '').trim().toLowerCase() === strName.toLowerCase()
        );
        if (!strObj) {
          strObj = {
            id: generateId('str'),
            name: strName,
            activities: []
          };
          sisObj.structures.push(strObj);
        }

        const actStart = new Date(baseDate);
        actStart.setDate(actStart.getDate() + idx * 2);
        const actEnd = new Date(actStart);
        actEnd.setDate(actEnd.getDate() + (Number(item.durationDays) || 1));
        const mode = normalizeProgressMode(item.progressMode);

        strObj.activities.push({
          id: generateId('act'),
          code: cleanItemCode,
          name: item.name,
          progressMode: mode,
          locationType: locType,
          sistemaName: sisObj.name,
          structureName: strObj.name,
          targetUnits: mode === 'percentage' ? 100 : Number(item.targetUnits) || 0,
          unit: mode === 'percentage' ? item.unit || '%' : item.unit || '',
          weight: Number(item.weight) || 1.0,
          plannedHH: Number(item.plannedHH) || 0,
          startDate: actStart.toISOString().split('T')[0],
          dueDate: actEnd.toISOString().split('T')[0],
          status: 'Pendiente'
        });

        existingActivityCodes.add(cleanItemCode);
      });

      return {
        ...existingArea,
        id: areaId,
        name: areaName,
        hasSistemas: true,
        sistemas: sistemasCopy
      };
    } else {
      const structuresCopy: any[] = (existingArea?.structures || []).map((str: any) => ({
        ...str,
        id: str.id || generateId('str'),
        activities: [...(str.activities || [])]
      }));

      itemsInArea.forEach((item, idx) => {
        const cleanItemCode = String(item.code || '').trim().toUpperCase();
        if (!cleanItemCode || existingActivityCodes.has(cleanItemCode)) {
          return;
        }

        const strName = String(item.structureName || '').trim();
        if (!strName) return;

        let strObj = structuresCopy.find(
          (st: any) => String(st.name || '').trim().toLowerCase() === strName.toLowerCase()
        );
        if (!strObj) {
          strObj = {
            id: generateId('str'),
            name: strName,
            activities: []
          };
          structuresCopy.push(strObj);
        }

        const actStart = new Date(baseDate);
        actStart.setDate(actStart.getDate() + idx * 2);
        const actEnd = new Date(actStart);
        actEnd.setDate(actEnd.getDate() + (Number(item.durationDays) || 1));
        const mode = normalizeProgressMode(item.progressMode);

        strObj.activities.push({
          id: generateId('act'),
          code: cleanItemCode,
          name: item.name,
          progressMode: mode,
          locationType: 'Interno',
          sistemaName: null,
          structureName: strObj.name,
          targetUnits: mode === 'percentage' ? 100 : Number(item.targetUnits) || 0,
          unit: mode === 'percentage' ? item.unit || '%' : item.unit || '',
          weight: Number(item.weight) || 1.0,
          plannedHH: Number(item.plannedHH) || 0,
          startDate: actStart.toISOString().split('T')[0],
          dueDate: actEnd.toISOString().split('T')[0],
          status: 'Pendiente'
        });

        existingActivityCodes.add(cleanItemCode);
      });

      return {
        ...existingArea,
        id: areaId,
        name: areaName,
        hasSistemas: false,
        structures: structuresCopy
      };
    }
  });
}

function recalculateMaterialsFromAdvances(materialsList: any[], advancesList: any[]): any[] {
  const usedQuantity = indexMaterialConsumption(advancesList);
  return (materialsList || []).map((mat) => ({
    ...mat,
    usedQty: usedQuantity(mat)
  }));
}

function downloadCsvFile(
  filename: string,
  headers: string[],
  rows: any[][],
  titleLine?: string
) {
  const lines: string[] = [];
  if (titleLine) {
    lines.push(escapeCsvCell(titleLine));
  }
  lines.push(headers.map(escapeCsvCell).join(','));
  rows.forEach((row) => {
    lines.push(row.map(escapeCsvCell).join(','));
  });
  const csvContent = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Parsea texto pegado desde Excel (TSV) o CSV respetando comillas
function parsePastedTabularText(text: string): string[][] {
  if (!text || !text.trim()) return [];
  const rawLines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0);

  return rawLines.map((line) => {
    if (line.includes('\t')) {
      return line.split('\t').map((c) => c.trim());
    }
    const separator = line.includes(';') && !line.includes(',') ? ';' : ',';
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === separator && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  });
}

function normalizeHeaderKey(str: string): string {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export default function App() {
  const { profile, openUserAdminModal, canManageUsers, logout } = useAuthProfile();
  const scopeKey = operationalScopeKey(profile);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [requestedTab, setRequestedTab] = useState(() => window.location.hash.replace(/^#\/?/, ''));
  const currentTab = resolveModule(profile, requestedTab);
  const setCurrentTab = (module: string) => {
    const allowed = resolveModule(profile, module);
    if (allowed !== module) return;
    window.location.hash = '/' + allowed;
    setRequestedTab(allowed);
  };
  useEffect(() => {
    const readRoute = () => setRequestedTab(window.location.hash.replace(/^#\/?/, ''));
    window.addEventListener('hashchange', readRoute);
    return () => window.removeEventListener('hashchange', readRoute);
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [currentTab]);

  // Plantillas / Proveedores (Inician vacíos)
  const [technologies, setTechnologies] = useState<string[]>(() => {
    try {
      const s = localStorage.getItem(scopeKey + ':calera_technologies_clean');
      return s ? JSON.parse(s) : DEFAULT_TECHNOLOGIES;
    } catch {
      return DEFAULT_TECHNOLOGIES;
    }
  });

  // Catálogo Maestro de Actividades (Inicia vacío y filtra únicamente registros activos)
  const [masterCatalog, setMasterCatalog] = useState<any[]>(() => {
    try {
      const s = localStorage.getItem(scopeKey + ':calera_master_catalog_clean');
      return s ? getActiveMasterCatalog(JSON.parse(s)) : [];
    } catch {
      return [];
    }
  });

  const activeMasterCatalog = useMemo(
    () => getActiveMasterCatalog(masterCatalog),
    [masterCatalog]
  );

  // Sectores y Galpones (Inician vacíos)
  const [sectors, setSectors] = useState<any[]>(() => {
    try {
      const s = localStorage.getItem(scopeKey + ':calera_sectors_clean');
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  const [selectedSectorId, setSelectedSectorId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(scopeKey + ':calera_active_selection_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        return typeof parsed?.sectorId === 'string' ? parsed.sectorId : '';
      }
    } catch {
      // ignore
    }
    return '';
  });
  const [selectedGalponId, setSelectedGalponId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(scopeKey + ':calera_active_selection_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        return typeof parsed?.galponId === 'string' ? parsed.galponId : '';
      }
    } catch {
      // ignore
    }
    return '';
  });
  const hasInitializedSelectionRef = React.useRef<boolean>(false);

  // Avances Diarios (Inician vacíos)
  const [dailyAdvances, setDailyAdvances] = useState<any[]>(() => {
    try {
      const s = localStorage.getItem(scopeKey + ':calera_advances_clean');
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  // Planilla de Personal (Inicia vacía)
  const [masterWorkforce, setMasterWorkforce] = useState<any[]>(() => {
    try {
      const s = localStorage.getItem(scopeKey + ':calera_workforce_clean');
      const saved = s ? JSON.parse(s) : [];
      return Array.isArray(saved) ? saved.filter(worker => worker && typeof worker.id === 'string').map(workerForDisplay) : [];
    } catch {
      return [];
    }
  });

  // Materiales por Estructura (Inician vacíos)
  const [materials, setMaterials] = useState<any[]>(() => {
    try {
      const s = localStorage.getItem(scopeKey + ':calera_materials_clean');
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  // Asistencia (Inicia vacía)
  const [attendanceRecords, setAttendanceRecords] = useState<
    Record<string, Record<string, string>>
  >(() => {
    try {
      const s = localStorage.getItem(scopeKey + ':calera_attendance_clean');
      return s ? JSON.parse(s) : {};
    } catch {
      return {};
    }
  });

  const [attendanceDate, setAttendanceDate] = useState<string>(() => getSystemToday());
  const [attendanceScope, setAttendanceScope] = useState<'galpon' | 'sector' | 'global'>(
    'galpon'
  );
  const [attendanceSpecialtyFilter, setAttendanceSpecialtyFilter] =
    useState<string>('Todas');

  // Historial de Movimientos de Usuarios (Bitácora de Registros, Modificaciones y Eliminaciones)
  const [auditLogs, setAuditLogs] = useState<
    {
      id: string;
      timestamp: string;
      user: string;
      action: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN';
      module: string;
      description: string;
      targetId?: string;
      projectCode?: string;
      sectorId?: string;
      galponId?: string;
      requestId?: string;
    }[]
  >(() => {
    try {
      const s = localStorage.getItem(scopeKey + ':calera_audit_logs_clean');
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  const [activeUserName, setActiveUserName] = useState<string>(() => {
    try {
      return localStorage.getItem(scopeKey + ':calera_active_user_clean') || '';
    } catch {
      return '';
    }
  });

  const [filterLogAction, setFilterLogAction] = useState<string>('Todas');
  const [filterLogModule, setFilterLogModule] = useState<string>('Todos');
  const [searchLogText, setSearchLogText] = useState<string>('');
  const [movementPage, setMovementPage] = useState(1);
  const movementModules = useMemo(() => [...new Set(auditLogs.map(log => log.module))].sort(), [auditLogs]);
  const visibleMovements = useMemo(() => {
    const search = searchLogText.trim().toLowerCase();
    return auditLogs.filter(log => (filterLogAction === 'Todas' || log.action === filterLogAction) &&
      (filterLogModule === 'Todos' || log.module === filterLogModule) &&
      (!search || [log.description, log.user, log.module, log.action, log.projectCode, log.sectorId, log.galponId, log.targetId, log.requestId]
        .some(value => String(value ?? '').toLowerCase().includes(search))));
  }, [auditLogs, filterLogAction, filterLogModule, searchLogText]);
  const movementPageCount = Math.max(1, Math.ceil(visibleMovements.length / MOVEMENTS_PAGE_SIZE));
  const visibleMovementPage = Math.min(movementPage, movementPageCount);
  const movementPageStart = (visibleMovementPage - 1) * MOVEMENTS_PAGE_SIZE;

  // Filtros
  const [dashSistemaLocFilter, setDashSistemaLocFilter] = useState<
    'Todos' | 'Interno' | 'Externo'
  >('Todos');
  const [dashPendingAreaFilter, setDashPendingAreaFilter] = useState<string>('Todas');
  const [filterActArea, setFilterActArea] = useState<string>('Todas');
  const [filterActLocation, setFilterActLocation] = useState<
    'Todos' | 'Interno' | 'Externo'
  >('Todos');
  const [searchActText, setSearchActText] = useState<string>('');
  const [searchWorkerText, setSearchWorkerText] = useState<string>('');
  const [selectedCatalogTech, setSelectedCatalogTech] = useState<string>('Todas');
  const [filterMaterialGalpon, setFilterMaterialGalpon] = useState<string>('Todos');
  const [filterMaterialTech, setFilterMaterialTech] = useState<string>('Todas');
  const [filterMaterialArea, setFilterMaterialArea] = useState<string>('Todas');
  const [searchMaterialText, setSearchMaterialText] = useState<string>('');

  // Modales
  const [modalNewProject, setModalNewProject] = useState(false);
  const [modalEditProject, setModalEditProject] = useState(false);
  const [modalNewGalpon, setModalNewGalpon] = useState(false);
  const [modalEditGalpon, setModalEditGalpon] = useState(false);
  const [modalNewAdvance, setModalNewAdvance] = useState(false);
  const [editingAdvanceId, setEditingAdvanceId] = useState<string | null>(null);
  const [modalNewWorker, setModalNewWorker] = useState(false);
  const [modalNewActivity, setModalNewActivity] = useState(false);
  const [modalEditGalponActivity, setModalEditGalponActivity] = useState<any | null>(
    null
  );
  const [modalNewCatalogItem, setModalNewCatalogItem] = useState(false);
  const [editingCatalogId, setEditingCatalogId] = useState<string | null>(null);
  const [modalManageTemplates, setModalManageTemplates] = useState(false);
  const [modalNewMaterial, setModalNewMaterial] = useState(false);
  const [materialError, setMaterialError] = useState('');
  const [editingMaterialId, setEditingMaterialId] = useState<string | null>(null);
  const [modalBulkUpload, setModalBulkUpload] = useState<
    'catalogo' | 'materiales' | 'personal' | null
  >(null);
  const [bulkCsvText, setBulkCsvText] = useState<string>('');
  const [bulkRawRows, setBulkRawRows] = useState<string[][]>([]);
  const [bulkFileName, setBulkFileName] = useState<string>('');
  const [bulkFileError, setBulkFileError] = useState('');
  const [queuingPersonalImport, setQueuingPersonalImport] = useState(false);
  const bulkReadId = useRef(0);
  const [bulkTargetGalponId, setBulkTargetGalponId] = useState<string>('');

  // Estados de Filtros y Paginación para Informes Globales (Etapa 3.1)
  const [filterInformesSectorId, setFilterInformesSectorId] = useState<string>('ALL');
  const [filterInformesGalponId, setFilterInformesGalponId] = useState<string>('ALL');
  const [filterInformesAreaName, setFilterInformesAreaName] = useState<string>('ALL');
  const [filterInformesSistemaName, setFilterInformesSistemaName] = useState<string>('ALL');
  const [filterInformesMode, setFilterInformesMode] = useState<string>('ALL');
  const [filterInformesStatus, setFilterInformesStatus] = useState<string>('ALL');
  const [searchInformesText, setSearchInformesText] = useState<string>('');
  const [informesPage, setInformesPage] = useState<number>(1);
  const [informesPageSize, setInformesPageSize] = useState<number>(50);
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{
    type:
      | 'sector'
      | 'galpon'
      | 'activity'
      | 'gantt_withdrawal'
      | 'material'
      | 'worker'
      | 'advance'
      | 'catalog_item'
      | 'catalog_structure'
      | 'template_provider';
    entityId?: string;
    sectorId?: string;
    galponId?: string;
    targetId?: string;
    areaName?: string;
    sistemaName?: string | null;
    structureName?: string;
    code: string;
    name: string;
    subtitle?: string;
    extraDetails?: string;
    stats?: {
      galpones?: number;
      activities?: number;
      advances?: number;
      materials?: number;
      workers?: number;
      attendanceDays?: number;
      catalogItems?: number;
      extraInfo?: string;
    };
    deleteLinkedSharedAdvance?: boolean;
  } | null>(null);
  const [queuingGanttWithdrawal, setQueuingGanttWithdrawal] = useState(false);

  // Estados de Formularios (Sin valores predeterminados forzados)
  const [formProject, setFormProject] = useState({
    id: '',
    code: '',
    name: '',
    location: '',
    client: ''
  });

  const [formGalpon, setFormGalpon] = useState({
    id: '',
    sectorId: '',
    code: '',
    name: '',
    description: '',
    responsible: '',
    startDate: '',
    endDate: '',
    technology: ''
  });

  const [modalSyncCenterOpen, setModalSyncCenterOpen] = useState(false);
  const [advanceValidationError, setAdvanceValidationError] = useState<string | null>(
    null
  );

  const [formAdvance, setFormAdvance] = useState({
    areaName: '',
    locationType: 'Todos',
    sistemaName: '',
    structureName: '',
    activityId: '',
    date: '',
    quantityToday: '',
    hoursWorked: '',
    supervisor: '',
    note: '',
    isAuthorizedCorrection: false,
    correctionReason: '',
    sharedAcrossTwoGalpones: false,
    secondGalponId: '',
    splitMode: '100_both' as '100_both' | '50_50',
    workerIds: [] as string[],
    manualMaterialInputs: {} as Record<string, string>
  });

  const [formActivity, setFormActivity] = useState<CatalogAssignmentFormState>({
    useCatalog: true,
    targetGalponId: '',
    catalogItemId: '',
    selectedCatalogItemIds: [],
    code: '',
    name: '',
    progressMode: 'quantity' as ProgressModality,
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
    startDate: '',
    dueDate: '',
    sharedWithGalponId: ''
  });

  const [formCatalogItem, setFormCatalogItem] = useState({
    technology: '',
    code: '',
    progressMode: 'quantity' as ProgressModality,
    areaName: '',
    locationType: '',
    sistemaName: '',
    customSistemaName: '',
    structureName: '',
    customStructureName: '',
    name: '',
    targetUnits: '',
    unit: '',
    weight: '',
    plannedHH: '',
    durationDays: ''
  });

  const [formMaterial, setFormMaterial] = useState({
    sectorId: '',
    galponId: '',
    technology: '',
    code: '',
    name: '',
    areaId: '',
    areaName: '',
    locationType: '',
    sistemaId: '',
    sistemaName: '',
    customSistemaName: '',
    structureId: '',
    structureName: '',
    customStructureName: '',
    totalQty: '',
    usedQty: 0,
    unit: ''
  });

  const [formWorker, setFormWorker] = useState({
    id: '',
    workerCode: '',
    dni: '',
    name: '',
    workArea: '',
    role: '',
    sectorId: '',
    galponId: ''
  });

  const [newTemplateName, setNewTemplateName] = useState('');
  const [templateCopyBusy, setTemplateCopyBusy] = useState(false);
  const [templateCopyError, setTemplateCopyError] = useState('');
  const templateCopyRequest = useRef<{ source: string; name: string; id: string }>();
  const [editingTemplateIndex, setEditingTemplateIndex] = useState<number | null>(null);
  const [editingTemplateValue, setEditingTemplateValue] = useState('');

  // Contexto de Autenticación, Matriz de Roles y Sincronización Firestore en Tiempo Real
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);

  const {
    syncStatus,
    syncStorageError,
    confirmedAdvances,
    lastSyncedAt,
    isNetworkOnline,
    connectionIndicatorState,
    pendingOperations,
    activePendingCount,
    syncConflicts,
    unresolvedConflictCount,
    lastSyncSummary,
    isManualSyncing,
    triggerManualSync,
    refreshOperationalData,
    queueOperationLocally,
    dismissAttendanceConflict,
    retryGanttWithdrawal,
    resolveSyncConflict
  } = useFirestoreOperationalSync({
    profile,
    technologies,
    setTechnologies,
    masterCatalog,
    setMasterCatalog,
    sectors,
    setSectors,
    materials,
    setMaterials,
    dailyAdvances,
    setDailyAdvances,
    masterWorkforce,
    setMasterWorkforce,
    attendanceRecords,
    setAttendanceRecords,
    auditLogs,
    setAuditLogs
  });

  // Mantener activeUserName sincronizado con el usuario autenticado real
  useEffect(() => {
    if (profile) {
      setActiveUserName(`${profile.displayName} (${profile.role})`);
    }
  }, [profile]);

  const canDo = (moduleId: AppModuleId, action: PermissionAction): boolean =>
    hasModulePermission(profile, moduleId, action);

  const requirePermission = (moduleId: AppModuleId, action: PermissionAction): boolean => {
    if (hasModulePermission(profile, moduleId, action)) {
      setPermissionNotice(null);
      return true;
    }
    const msg = `Acceso restringido: Su rol (${profile?.role || 'Sin rol'}) no tiene permiso para "${ACTION_LABELS[action]}" en el módulo "${MODULE_LABELS[moduleId]}".`;
    setPermissionNotice(msg);
    setTimeout(() => {
      setPermissionNotice((prev) => (prev === msg ? null : prev));
    }, 5000);
    return false;
  };

  // Caché local de respaldo (Firestore es la fuente principal de verdad)
  useEffect(() => {
    localStorage.setItem(scopeKey + ':calera_technologies_clean', JSON.stringify(technologies));
  }, [technologies]);

  useEffect(() => {
    localStorage.setItem(scopeKey + ':calera_master_catalog_clean', JSON.stringify(masterCatalog));
  }, [masterCatalog]);

  useEffect(() => {
    localStorage.setItem(scopeKey + ':calera_sectors_clean', JSON.stringify(sectors));
    if (sectors.length === 0) {
      if (selectedSectorId !== '') setSelectedSectorId('');
      if (selectedGalponId !== '') setSelectedGalponId('');
      return;
    }

    const existingSector = sectors.find((s) => s.id === selectedSectorId);
    if (!existingSector) {
      if (!hasInitializedSelectionRef.current) {
        hasInitializedSelectionRef.current = true;
        const firstSec = sectors[0];
        setSelectedSectorId(firstSec.id);
        const galStillValid = firstSec.galpones?.some(
          (g: any) => g.id === selectedGalponId
        );
        setSelectedGalponId(
          galStillValid
            ? selectedGalponId
            : firstSec.galpones?.[0]?.id || ''
        );
      } else {
        // Si el sector seleccionado fue eliminado o dejó de estar autorizado, seleccionar el primero válido pero limpiar galpón inválido
        const fallbackSec = sectors[0];
        setSelectedSectorId(fallbackSec.id);
        const galValidInFallback = fallbackSec.galpones?.some(
          (g: any) => g.id === selectedGalponId
        );
        if (!galValidInFallback) {
          setSelectedGalponId('');
        }
      }
      return;
    }

    hasInitializedSelectionRef.current = true;
    if (
      selectedGalponId &&
      !existingSector.galpones?.some((g: any) => g.id === selectedGalponId)
    ) {
      // El galpón seleccionado ya no pertenece al sector actual: limpiar sin elegir otro silenciosamente
      setSelectedGalponId('');
    }
  }, [sectors, selectedSectorId, selectedGalponId]);

  useEffect(() => {
    try {
      localStorage.setItem(
        scopeKey + ':calera_active_selection_v1',
        JSON.stringify({
          sectorId: selectedSectorId,
          galponId: selectedGalponId
        })
      );
    } catch {
      // ignore
    }
  }, [selectedSectorId, selectedGalponId]);

  useEffect(() => {
    localStorage.setItem(scopeKey + ':calera_advances_clean', JSON.stringify(dailyAdvances));
  }, [dailyAdvances]);

  useEffect(() => {
    localStorage.setItem(scopeKey + ':calera_workforce_clean', JSON.stringify(masterWorkforce));
  }, [masterWorkforce]);

  useEffect(() => {
    localStorage.setItem(scopeKey + ':calera_materials_clean', JSON.stringify(materials));
  }, [materials]);

  useEffect(() => {
    localStorage.setItem(scopeKey + ':calera_attendance_clean', JSON.stringify(attendanceRecords));
  }, [attendanceRecords]);

  useEffect(() => {
    localStorage.setItem(scopeKey + ':calera_audit_logs_clean', JSON.stringify(auditLogs));
  }, [auditLogs]);

  useEffect(() => {
    localStorage.setItem(scopeKey + ':calera_active_user_clean', activeUserName);
  }, [activeUserName]);

  // ==========================================================================
  // SELECTORES Y CÁLCULOS PRINCIPALES (RESPETANDO ALCANCE POR SECTOR Y GALPÓN)
  // ==========================================================================
  const dynamicContext = useMemo(
    () =>
      resolveDynamicSectorGalponContext(
        sectors,
        selectedSectorId,
        selectedGalponId
      ),
    [sectors, selectedSectorId, selectedGalponId]
  );

  const currentSector = dynamicContext.currentSector;
  const currentGalpon = dynamicContext.currentGalpon;
  const requiresGalponSelection = dynamicContext.requiresGalponSelection;

  const handleSelectSector = (secId: string) => {
    hasInitializedSelectionRef.current = true;
    setSelectedSectorId(secId);
    const sec = sectors.find((s) => s.id === secId);
    const isStillValid = Boolean(
      sec &&
        selectedGalponId &&
        Array.isArray(sec.galpones) &&
        sec.galpones.some((g: any) => g.id === selectedGalponId)
    );
    if (!isStillValid) {
      // Limpiar selección y solicitar al usuario elegir un galpón válido del nuevo sector
      setSelectedGalponId('');
    }
  };

  // Lista plana de todos los galpones autorizados en el alcance del usuario con referencia a su sector
  const allGalponesList = useMemo(() => {
    const list: {
      id: string;
      code: string;
      name: string;
      technology: string;
      sectorId: string;
      sectorCode: string;
      sectorName: string;
      areas: any[];
    }[] = [];
    sectors.forEach((sec) => {
      (sec.galpones || []).forEach((g: any) => {
        list.push({
          id: g.id,
          code: g.code,
          name: g.name,
          technology: g.technology || '',
          sectorId: sec.id,
          sectorCode: sec.code || '',
          sectorName: sec.name || '',
          areas: g.areas || []
        });
      });
    });
    return list;
  }, [sectors]);

  // Estructuras activas en el Catálogo Maestro según el Área y Sistema del editor del catálogo
  const availableCatalogEditorStructures = useMemo(() => {
    return getMasterCatalogStructuresForEditor(
      activeMasterCatalog,
      formCatalogItem.areaName,
      formCatalogItem.sistemaName
    );
  }, [activeMasterCatalog, formCatalogItem.areaName, formCatalogItem.sistemaName]);

  // Selectores progresivos en cascada para el flujo "Agregar Actividad a Galpón" (Paso 1 -> Paso 4)
  const availableAssignCatalogAreas = useMemo(() => {
    return getCatalogAreas(activeMasterCatalog, ALL_AREAS);
  }, [activeMasterCatalog]);

  const availableAssignCatalogSystems = useMemo(() => {
    return getCatalogSystemsByArea(activeMasterCatalog, formActivity.areaName);
  }, [activeMasterCatalog, formActivity.areaName]);

  const availableAssignCatalogStructures = useMemo(() => {
    return getCatalogStructuresByAreaAndSystem(
      activeMasterCatalog,
      formActivity.areaName,
      formActivity.sistemaName
    );
  }, [activeMasterCatalog, formActivity.areaName, formActivity.sistemaName]);

  const availableAssignCatalogActivities = useMemo(() => {
    return getCatalogActivitiesByHierarchy(
      activeMasterCatalog,
      formActivity.areaName,
      formActivity.sistemaName,
      formActivity.structureName
    );
  }, [
    activeMasterCatalog,
    formActivity.areaName,
    formActivity.sistemaName,
    formActivity.structureName
  ]);

  // Sistemas disponibles para el formulario de Materiales (según Galpón y Área elegidos + Catálogo activo)
  const availableMaterialSystems = useMemo(() => {
    const mapSis = new Map<string, { id: string; name: string; locationType: string }>();
    const targetGalpon = allGalponesList.find((g) => g.id === formMaterial.galponId);

    if (targetGalpon && formMaterial.areaName) {
      const areaObj = targetGalpon.areas?.find((a: any) => a.name === formMaterial.areaName);
      if (areaObj?.hasSistemas && areaObj.sistemas) {
        areaObj.sistemas.forEach((sis: any) => {
          if (!sis.name) return;
          if (
            formMaterial.locationType &&
            (sis.locationType || 'Interno') !== formMaterial.locationType
          ) {
            return;
          }
          const key = `${sis.locationType || 'Interno'}__${sis.name.toLowerCase()}`;
          if (!mapSis.has(key)) {
            mapSis.set(key, {
              id: sis.id || '',
              name: sis.name,
              locationType: sis.locationType || 'Interno'
            });
          }
        });
      }
    }

    activeMasterCatalog.forEach((item) => {
      if (formMaterial.areaName && item.areaName !== formMaterial.areaName) return;
      if (
        formMaterial.technology &&
        item.technology &&
        item.technology !== formMaterial.technology
      )
        return;
      if (
        formMaterial.locationType &&
        item.locationType &&
        item.locationType !== formMaterial.locationType
      )
        return;
      if (item.sistemaName) {
        const key = `${item.locationType || 'Interno'}__${item.sistemaName.toLowerCase()}`;
        if (!mapSis.has(key)) {
          mapSis.set(key, {
            id: '',
            name: item.sistemaName,
            locationType: item.locationType || 'Interno'
          });
        }
      }
    });

    materials.forEach((m) => {
      if (formMaterial.areaName && m.areaName !== formMaterial.areaName) return;
      if (m.sistemaName) {
        const key = `${m.locationType || 'Interno'}__${m.sistemaName.toLowerCase()}`;
        if (!mapSis.has(key)) {
          mapSis.set(key, {
            id: m.sistemaId || '',
            name: m.sistemaName,
            locationType: m.locationType || 'Interno'
          });
        }
      }
    });

    return Array.from(mapSis.values());
  }, [
    allGalponesList,
    formMaterial.galponId,
    formMaterial.areaName,
    formMaterial.technology,
    formMaterial.locationType,
    activeMasterCatalog,
    materials
  ]);

  // Estructuras disponibles para el formulario de Materiales (según Galpón, Área y Sistema + Catálogo activo)
  const availableMaterialStructures = useMemo(() => {
    const mapStr = new Map<string, { id: string; name: string }>();
    const targetGalpon = allGalponesList.find((g) => g.id === formMaterial.galponId);

    if (targetGalpon && formMaterial.areaName) {
      const areaObj = targetGalpon.areas?.find((a: any) => a.name === formMaterial.areaName);
      if (areaObj) {
        if (areaObj.hasSistemas && areaObj.sistemas) {
          areaObj.sistemas.forEach((sis: any) => {
            if (
              formMaterial.sistemaName &&
              formMaterial.sistemaName !== '__NEW__' &&
              sis.name.toLowerCase() !== formMaterial.sistemaName.toLowerCase()
            ) {
              return;
            }
            (sis.structures || []).forEach((st: any) => {
              if (st.name && !mapStr.has(st.name.toLowerCase())) {
                mapStr.set(st.name.toLowerCase(), { id: st.id || '', name: st.name });
              }
            });
          });
        } else if (areaObj.structures) {
          areaObj.structures.forEach((st: any) => {
            if (st.name && !mapStr.has(st.name.toLowerCase())) {
              mapStr.set(st.name.toLowerCase(), { id: st.id || '', name: st.name });
            }
          });
        }
      }
    }

    activeMasterCatalog.forEach((item) => {
      if (formMaterial.areaName && item.areaName !== formMaterial.areaName) return;
      if (
        formMaterial.technology &&
        item.technology &&
        item.technology !== formMaterial.technology
      )
        return;
      if (
        formMaterial.sistemaName &&
        formMaterial.sistemaName !== '__NEW__' &&
        item.sistemaName &&
        item.sistemaName.toLowerCase() !== formMaterial.sistemaName.toLowerCase()
      )
        return;
      if (item.structureName && !mapStr.has(item.structureName.toLowerCase())) {
        mapStr.set(item.structureName.toLowerCase(), {
          id: '',
          name: item.structureName
        });
      }
    });

    return Array.from(mapStr.values());
  }, [
    allGalponesList,
    formMaterial.galponId,
    formMaterial.areaName,
    formMaterial.technology,
    formMaterial.sistemaName,
    activeMasterCatalog
  ]);

  // Actividades evaluadas del galpón activo (Unificando modalidad por Cantidades y por Porcentaje)
  const ambiguousCodesByBarn = useMemo(() => new Map(allGalponesList.map(barn =>
    [barn.id, ambiguousActivityCodes(barnActivities(barn))])), [allGalponesList]);
  const activityAdvances = useMemo(() => indexActivityAdvances(confirmedAdvances, ambiguousCodesByBarn),
    [confirmedAdvances, ambiguousCodesByBarn]);
  const usedMaterialQuantity = useMemo(() => indexMaterialConsumption(dailyAdvances), [dailyAdvances]);
  const evaluatedActivities: EvaluatedActivityItem[] = useMemo(() => {
    if (!currentGalpon || !currentGalpon.areas) return [];
    const list: any[] = [];
    const todayStr = getSystemToday();

    currentGalpon.areas.forEach((area: any) => {
      if (area.hasSistemas && area.sistemas) {
        area.sistemas.forEach((sis: any) => {
          sis.structures?.forEach((str: any) => {
            str.activities?.forEach((act: any) => {
              const logsForAct = activityAdvances(currentGalpon.id, act.id, act.code);
              const evalRes = evaluateActivityProgress(act, logsForAct, todayStr);

              // Asociación inequívoca: Galpón + Área + Sistema + Estructura (por ID único cuando está disponible)
              const linkedMaterials = materials
                .filter((m) => {
                  if (!m.galponId || m.galponId !== currentGalpon.id) return false;
                  if (m.structureId && str.id) {
                    if (m.structureId !== str.id) return false;
                    if (m.sistemaId && sis.id && m.sistemaId !== sis.id) return false;
                    if (m.areaId && area.id && m.areaId !== area.id) return false;
                    return true;
                  }
                  const sameArea =
                    Boolean(m.areaName) &&
                    Boolean(area.name) &&
                    m.areaName.toLowerCase() === area.name.toLowerCase();
                  const sameSistema =
                    Boolean(m.sistemaName) &&
                    Boolean(sis.name) &&
                    m.sistemaName.toLowerCase() === sis.name.toLowerCase();
                  const sameStructure =
                    Boolean(m.structureName) &&
                    Boolean(str.name) &&
                    m.structureName.toLowerCase() === str.name.toLowerCase();
                  return sameArea && sameSistema && sameStructure;
                })
                .map((m) => ({
                  ...m,
                  usedQty: usedMaterialQuantity(m)
                }));

              list.push({
                ...act,
                progressMode: evalRes.progressMode,
                targetUnits:
                  evalRes.progressMode === 'percentage'
                    ? 100
                    : Number(act.targetUnits || 0),
                unit:
                  evalRes.progressMode === 'percentage'
                    ? act.unit || '%'
                    : act.unit || '',
                areaId: area.id,
                areaName: area.name,
                hasSistema: true,
                locationType: act.locationType || sis.locationType || 'Interno',
                sistemaId: sis.id,
                sistemaName: act.sistemaName || sis.name,
                structureId: str.id,
                structureName: str.name,
                accumulatedQty: evalRes.accumulatedQty,
                accumulatedHH: evalRes.accumulatedHH,
                pendingQty: evalRes.pendingQty,
                progressPercent: evalRes.progressPercent,
                lastValidPercentage: evalRes.lastValidPercentage,
                conflictedLogsCount: evalRes.conflictedLogsCount,
                shouldHaveStarted: evalRes.shouldHaveStarted,
                computedStatus: evalRes.computedStatus,
                lastLog: evalRes.lastLog,
                linkedMaterials
              });
            });
          });
        });
      } else if (area.structures) {
        area.structures.forEach((str: any) => {
          str.activities?.forEach((act: any) => {
            const logsForAct = activityAdvances(currentGalpon.id, act.id, act.code);
            const evalRes = evaluateActivityProgress(act, logsForAct, todayStr);

            // Asociación inequívoca: Galpón + Área + Estructura (por ID único cuando está disponible)
            const linkedMaterials = materials
              .filter((m) => {
                if (!m.galponId || m.galponId !== currentGalpon.id) return false;
                if (m.structureId && str.id) {
                  if (m.structureId !== str.id) return false;
                  if (m.areaId && area.id && m.areaId !== area.id) return false;
                  return true;
                }
                const sameArea =
                  Boolean(m.areaName) &&
                  Boolean(area.name) &&
                  m.areaName.toLowerCase() === area.name.toLowerCase();
                const sameStructure =
                  Boolean(m.structureName) &&
                  Boolean(str.name) &&
                  m.structureName.toLowerCase() === str.name.toLowerCase();
                return sameArea && sameStructure;
              })
              .map((m) => ({
                ...m,
                usedQty: usedMaterialQuantity(m)
              }));

            list.push({
              ...act,
              progressMode: evalRes.progressMode,
              targetUnits:
                evalRes.progressMode === 'percentage'
                  ? 100
                  : Number(act.targetUnits || 0),
              unit:
                evalRes.progressMode === 'percentage'
                  ? act.unit || '%'
                  : act.unit || '',
              areaId: area.id,
              areaName: area.name,
              hasSistema: false,
              locationType: act.locationType || 'Interno',
              sistemaName: null,
              structureId: str.id,
              structureName: str.name,
              accumulatedQty: evalRes.accumulatedQty,
              accumulatedHH: evalRes.accumulatedHH,
              pendingQty: evalRes.pendingQty,
              progressPercent: evalRes.progressPercent,
              lastValidPercentage: evalRes.lastValidPercentage,
              conflictedLogsCount: evalRes.conflictedLogsCount,
              shouldHaveStarted: evalRes.shouldHaveStarted,
              computedStatus: evalRes.computedStatus,
              lastLog: evalRes.lastLog,
              linkedMaterials
            });
          });
        });
      }
    });

    return list;
  }, [currentGalpon, activityAdvances, materials, usedMaterialQuantity]);

  // Avance Ponderado General del Galpón (reutilizando selector puro compartido con el Dashboard)
  const galponWeightedProgress = useMemo(() => {
    return computeWeightedProgress(evaluatedActivities);
  }, [evaluatedActivities]);

  // Avance Ponderado por Área (6 Áreas Constructivas)
  const areaProgressMetrics = useMemo(() => {
    return computeAreaProgressMetrics(evaluatedActivities, ALL_AREAS);
  }, [evaluatedActivities]);

  // Avance Ponderado por Sistema General (filtrable por Todos / Interno / Externo)
  const sistemaProgressMetrics = useMemo(() => {
    return computeSistemaProgressMetrics(evaluatedActivities, dashSistemaLocFilter);
  }, [evaluatedActivities, dashSistemaLocFilter]);

  // Trabajadores filtrados para Asistencia (Por Galpón, Por Sector o Global + Especialidad)
  const filteredAttendanceWorkers = useMemo(() => {
    return masterWorkforce.filter((w) => {
      if (!w.active) return false;
      if (
        attendanceScope === 'galpon' &&
        currentGalpon &&
        w.galponId !== currentGalpon.id
      ) {
        return false;
      }
      if (
        attendanceScope === 'sector' &&
        currentSector &&
        w.sectorId !== currentSector.id
      ) {
        return false;
      }
      if (
        attendanceSpecialtyFilter !== 'Todas' &&
        w.workArea !== attendanceSpecialtyFilter
      ) {
        return false;
      }
      return true;
    });
  }, [
    masterWorkforce,
    attendanceScope,
    attendanceSpecialtyFilter,
    currentGalpon,
    currentSector
  ]);

  // Conteo Completo de Asistencia (Con Atención Médica y sin Tardanza)
  const currentDayAttendance = useMemo(() => {
    const dayMap = attendanceRecords[attendanceDate] || {};
    let present = 0;
    let absent = 0;
    let medicalAttention = 0;
    let permission = 0;
    let medicalLeave = 0;
    let pending = 0;

    filteredAttendanceWorkers.forEach((w) => {
      const status = dayMap[w.id] || 'Pendiente';
      if (status === 'Asistió') present++;
      else if (status === 'Falta') absent++;
      else if (status === 'Atención Médica') medicalAttention++;
      else if (status === 'Permiso') permission++;
      else if (status === 'Descanso Médico') medicalLeave++;
      else pending++;
    });

    const total = filteredAttendanceWorkers.length;
    const rate = total > 0 ? Math.round((present / total) * 100) : 0;
    return {
      present,
      absent,
      medicalAttention,
      permission,
      medicalLeave,
      pending,
      total,
      rate,
      map: dayMap
    };
  }, [attendanceRecords, attendanceDate, filteredAttendanceWorkers]);

  // ==========================================================================
  // HANDLERS: PLANTILLAS / PROVEEDORES Y CATÁLOGO MAESTRO
  // ==========================================================================
  const handleAddTemplateProvider = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('catalogo', 'create')) return;
    const clean = newTemplateName.trim();
    if (!clean || technologies.includes(clean)) return;
    setTechnologies((prev) => [...prev, clean]);
    setNewTemplateName('');
  };

  const handleDuplicateTemplate = async (source: string) => {
    if (!requirePermission('catalogo', 'create') || templateCopyBusy) return;
    const name = newTemplateName.trim();
    if (!name) { setTemplateCopyError('Ingrese el nombre de la copia.'); return; }
    let operation = templateCopyRequest.current;
    if (!operation || operation.source !== source || operation.name !== name) {
      operation = { source, name, id: crypto.randomUUID() };
      templateCopyRequest.current = operation;
    }
    setTemplateCopyBusy(true);
    setTemplateCopyError('');
    try {
      await duplicateCatalogTemplate(bindOperationalData(profile), source, name, operation.id);
      await refreshOperationalData();
      templateCopyRequest.current = undefined;
      setNewTemplateName('');
    } catch (error) {
      setTemplateCopyError(error instanceof Error ? error.message : 'No se pudo confirmar la copia.');
    } finally {
      setTemplateCopyBusy(false);
    }
  };

  const handleSaveRenameTemplate = (idx: number) => {
    if (!requirePermission('catalogo', 'edit')) return;
    const oldName = technologies[idx];
    const newName = editingTemplateValue.trim();
    if (!newName || !oldName) return;

    setTechnologies((prev) => prev.map((t, i) => (i === idx ? newName : t)));
    setMasterCatalog((prev) =>
      prev.map((item) =>
        item.technology === oldName ? { ...item, technology: newName } : item
      )
    );
    setMaterials((prev) =>
      prev.map((m) => (m.technology === oldName ? { ...m, technology: newName } : m))
    );
    setSectors((prev) =>
      prev.map((sec) => ({
        ...sec,
        galpones: (sec.galpones || []).map((g: any) =>
          g.technology === oldName ? { ...g, technology: newName } : g
        )
      }))
    );
    setEditingTemplateIndex(null);
    setEditingTemplateValue('');
  };

  const requestDeleteTemplateProvider = (techName: string) => {
    if (!requirePermission('catalogo', 'delete')) return;
    const catalogCount = masterCatalog.filter((c) => c.technology === techName).length;
    const galponesCount = allGalponesList.filter((g) => g.technology === techName).length;
    const materialsCount = materials.filter((m) => m.technology === techName).length;
    setDeleteConfirmModal({
      type: 'template_provider',
      code: techName,
      name: techName,
      stats: {
        catalogItems: catalogCount,
        galpones: galponesCount,
        materials: materialsCount
      }
    });
  };

  const openNewCatalogModal = () => {
    if (!requirePermission('catalogo', 'create')) return;
    setEditingCatalogId(null);
    setFormCatalogItem({
      technology: '',
      code: '',
      progressMode: 'quantity',
      areaName: '',
      locationType: '',
      sistemaName: '',
      customSistemaName: '',
      structureName: '',
      customStructureName: '',
      name: '',
      targetUnits: '',
      unit: '',
      weight: '',
      plannedHH: '',
      durationDays: ''
    });
    setModalNewCatalogItem(true);
  };

  const openEditCatalogModal = (item: any, duplicate = false) => {
    if (!requirePermission('catalogo', duplicate ? 'create' : 'edit')) return;
    setEditingCatalogId(duplicate ? null : item.id);
    const mode = normalizeProgressMode(item.progressMode);
    setFormCatalogItem({
      technology: item.technology || '',
      code: duplicate ? '' : item.code || '',
      progressMode: mode,
      areaName: item.areaName || '',
      locationType: item.locationType || '',
      sistemaName: item.sistemaName || '',
      customSistemaName: '',
      structureName: item.structureName || '',
      customStructureName: '',
      name: item.name || '',
      targetUnits: String(mode === 'percentage' ? 100 : item.targetUnits ?? ''),
      unit: mode === 'percentage' ? item.unit || '%' : item.unit || '',
      weight: String(item.weight ?? ''),
      plannedHH: String(item.plannedHH ?? ''),
      durationDays: String(item.durationDays ?? '')
    });
    setModalNewCatalogItem(true);
  };

  const handleSaveCatalogItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('catalogo', editingCatalogId ? 'edit' : 'create')) return;
    if (
      !formCatalogItem.technology ||
      !formCatalogItem.code ||
      !formCatalogItem.areaName ||
      !formCatalogItem.name
    )
      return;

    const finalSistema =
      formCatalogItem.sistemaName === '__NEW__'
        ? formCatalogItem.customSistemaName.trim()
        : formCatalogItem.sistemaName.trim();

    const finalStructure =
      formCatalogItem.structureName === '__NEW__'
        ? formCatalogItem.customStructureName.trim()
        : formCatalogItem.structureName.trim();

    if (!finalStructure) return;

    const mode = normalizeProgressMode(formCatalogItem.progressMode);

    const payload = {
      id: editingCatalogId || generateId('cat'),
      technology: formCatalogItem.technology.trim(),
      code: formCatalogItem.code.trim().toUpperCase(),
      progressMode: mode,
      areaName: formCatalogItem.areaName,
      locationType: AREAS_WITH_SISTEMAS.includes(formCatalogItem.areaName)
        ? formCatalogItem.locationType || 'Interno'
        : 'Interno',
      sistemaName: AREAS_WITH_SISTEMAS.includes(formCatalogItem.areaName)
        ? finalSistema || null
        : null,
      structureName: finalStructure,
      name: formCatalogItem.name.trim(),
      targetUnits: mode === 'percentage' ? 100 : Number(formCatalogItem.targetUnits) || 0,
      unit: mode === 'percentage' ? formCatalogItem.unit.trim() || '%' : formCatalogItem.unit.trim(),
      weight: Number(formCatalogItem.weight) || 1.0,
      plannedHH: Number(formCatalogItem.plannedHH) || 0,
      durationDays: Number(formCatalogItem.durationDays) || 1
    };
    const catalogKey = catalogCodeKey(payload.technology, payload.code);
    if (activeMasterCatalog.some(item => item.id !== editingCatalogId && catalogCodeKey(item.technology, item.code) === catalogKey)) {
      setPermissionNotice('Ese código ya existe en la plantilla.');
      return;
    }

    if (editingCatalogId) {
      setMasterCatalog((prev) =>
        prev.map((c) => (c.id === editingCatalogId ? payload : c))
      );
    } else {
      setMasterCatalog((prev) => [...prev, payload]);
    }

    setModalNewCatalogItem(false);
    setEditingCatalogId(null);
  };

  const requestDeleteCatalogItem = (id: string) => {
    if (!requirePermission('catalogo', 'delete')) return;
    const targetItem = activeMasterCatalog.find((c) => c.id === id);
    if (!targetItem) return;
    setDeleteConfirmModal({
      type: 'catalog_item',
      entityId: id,
      code: targetItem.code,
      name: targetItem.name,
      extraDetails: `Proveedor: ${targetItem.technology || 'Sin proveedor'} • Área: ${targetItem.areaName} • Estructura: ${targetItem.structureName}`
    });
  };

  const requestDeleteCatalogStructure = (
    areaName: string,
    sistemaName: string | null | undefined,
    structureName: string
  ) => {
    if (!requirePermission('catalogo', 'delete')) return;
    const { removedItems } = deleteStructureFromMasterCatalog(activeMasterCatalog, {
      areaName,
      sistemaName,
      structureName
    });
    if (removedItems.length === 0) return;
    setDeleteConfirmModal({
      type: 'catalog_structure',
      areaName,
      sistemaName: sistemaName || null,
      structureName,
      code: areaName.toUpperCase(),
      name: structureName,
      extraDetails: `Se eliminará la estructura "${structureName}" (${areaName}${sistemaName ? ` • ${sistemaName}` : ''}) y todas sus actividades maestras vinculadas (${removedItems.length}) del Catálogo Maestro.`,
      stats: {
        catalogItems: removedItems.length
      }
    });
  };

  // ==========================================================================
  // HANDLERS: SECTORES Y GALPONES (CREAR, EDITAR, ELIMINAR, PLANTILLA PROVEEDOR)
  // ==========================================================================
  const handleSaveNewProject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('proyectos', 'create')) return;
    if (!formProject.name || !formProject.code) return;

    const newSecObj = {
      id: generateId('sec'),
      code: formProject.code.trim().toUpperCase(),
      name: formProject.name.trim().toUpperCase(),
      location: formProject.location.trim(),
      client: formProject.client.trim(),
      galpones: []
    };

    setSectors((prev) => [...prev, newSecObj]);
    setSelectedSectorId(newSecObj.id);
    setSelectedGalponId('');
    setModalNewProject(false);
    setFormProject({ id: '', code: '', name: '', location: '', client: '' });
  };

  const handleSaveEditProject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('proyectos', 'edit')) return;
    if (!formProject.id || !formProject.name) return;
    const targetSec = sectors.find((s) => s.id === formProject.id);
    if (!targetSec) return;

    const updatedCode = formProject.code.trim().toUpperCase();
    const updatedName = formProject.name.trim().toUpperCase();

    setSectors((prev) =>
      prev.map((s) =>
        s.id === formProject.id
          ? {
              ...s,
              code: updatedCode,
              name: updatedName,
              location: formProject.location.trim(),
              client: formProject.client.trim()
            }
          : s
      )
    );
    setModalEditProject(false);
  };

  const requestDeleteSector = (secId: string) => {
    if (!requirePermission('proyectos', 'delete')) return;
    const targetSec = sectors.find((s) => s.id === secId);
    if (!targetSec) return;

    const galponIds = new Set<string>(
      (targetSec.galpones || []).map((g: any) => g.id)
    );
    let activitiesCount = 0;
    (targetSec.galpones || []).forEach((g: any) => {
      (g.areas || []).forEach((area: any) => {
        if (area.hasSistemas && area.sistemas) {
          area.sistemas.forEach((sis: any) => {
            (sis.structures || []).forEach((str: any) => {
              activitiesCount += (str.activities || []).length;
            });
          });
        } else {
          (area.structures || []).forEach((str: any) => {
            activitiesCount += (str.activities || []).length;
          });
        }
      });
    });

    const advancesCount = dailyAdvances.filter(
      (a) => a.sectorId === secId || galponIds.has(a.galponId)
    ).length;
    const materialsCount = materials.filter(
      (m) => m.sectorId === secId || (m.galponId && galponIds.has(m.galponId))
    ).length;
    const workersCount = masterWorkforce.filter(
      (w) => w.sectorId === secId || (w.galponId && galponIds.has(w.galponId))
    ).length;

    setDeleteConfirmModal({
      type: 'sector',
      sectorId: secId,
      code: targetSec.code,
      name: targetSec.name,
      stats: {
        galpones: (targetSec.galpones || []).length,
        activities: activitiesCount,
        advances: advancesCount,
        materials: materialsCount,
        workers: workersCount
      },
    });
  };

  const handleSaveNewGalpon = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('proyectos', 'create')) return;
    const targetSecId = formGalpon.sectorId || currentSector?.id;
    if (!formGalpon.code || !formGalpon.name || !targetSecId || !formGalpon.technology)
      return;
    const targetSecObj = sectors.find((s) => s.id === targetSecId);
    if (!targetSecObj) return;

    const chosenTech = formGalpon.technology.trim();
    const generatedAreas = buildAreasFromCatalog(
      activeMasterCatalog,
      chosenTech,
      formGalpon.startDate
    );


    const newGalponObj = {
      id: generateId('gal'),
      sectorId: targetSecId,
      code: formGalpon.code.trim().toUpperCase(),
      name: formGalpon.name.trim().toUpperCase(),
      technology: chosenTech,
      description: formGalpon.description.trim(),
      responsible: formGalpon.responsible.trim(),
      startDate: formGalpon.startDate,
      endDate: formGalpon.endDate,
      status: 'En ejecución',
      areas: generatedAreas
    };

    setSectors((prev) =>
      prev.map((s) =>
        s.id === targetSecId
          ? { ...s, galpones: [...(s.galpones || []), newGalponObj] }
          : s
      )
    );
    setSelectedSectorId(targetSecId);
    setSelectedGalponId(newGalponObj.id);
    setModalNewGalpon(false);
  };

  const handleSaveEditGalpon = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('proyectos', 'edit')) return;
    if (!formGalpon.id) return;
    const parentSec = sectors.find((s) =>
      (s.galpones || []).some((g: any) => g.id === formGalpon.id)
    );
    const targetGalObj = parentSec?.galpones?.find((g: any) => g.id === formGalpon.id);
    if (!parentSec || !targetGalObj)
      return;


    const updatedCode = formGalpon.code.trim().toUpperCase();
    const updatedName = formGalpon.name.trim().toUpperCase();
    const cleanTech = formGalpon.technology.trim();

    setSectors((prev) =>
      prev.map((s) => ({
        ...s,
        galpones: (s.galpones || []).map((g: any) => {
          if (g.id !== formGalpon.id) return g;
          const techChanged = g.technology !== cleanTech;

          return {
            ...g,
            code: updatedCode,
            name: updatedName,
            technology: cleanTech,
            description: formGalpon.description.trim(),
            responsible: formGalpon.responsible.trim(),
            startDate: formGalpon.startDate,
            endDate: formGalpon.endDate,
            // Sincronización aditiva cuando cambia la plantilla, conservando actividades personalizadas e IDs de estructuras (C-3)
            areas:
              techChanged && cleanTech
                ? mergeAreasWithCatalog(
                    g.areas || [],
                    activeMasterCatalog,
                    cleanTech,
                    formGalpon.startDate
                  )
                : g.areas
          };
        })
      }))
    );

    setModalEditGalpon(false);
  };

  const requestDeleteGalpon = (secId: string, galId: string) => {
    if (!requirePermission('proyectos', 'delete')) return;
    const sec = sectors.find((s) => s.id === secId);
    const targetGal = sec?.galpones?.find((g: any) => g.id === galId);
    if (!sec || !targetGal) return;

    let activitiesCount = 0;
    (targetGal.areas || []).forEach((area: any) => {
      if (area.hasSistemas && area.sistemas) {
        area.sistemas.forEach((sis: any) => {
          (sis.structures || []).forEach((str: any) => {
            activitiesCount += (str.activities || []).length;
          });
        });
      } else {
        (area.structures || []).forEach((str: any) => {
          activitiesCount += (str.activities || []).length;
        });
      }
    });

    const advancesCount = dailyAdvances.filter((a) => a.galponId === galId).length;
    const materialsCount = materials.filter((m) => m.galponId === galId).length;
    const workersCount = masterWorkforce.filter((w) => w.galponId === galId).length;

    setDeleteConfirmModal({
      type: 'galpon',
      sectorId: secId,
      galponId: galId,
      code: targetGal.code,
      name: targetGal.name,
      stats: {
        galpones: 1,
        activities: activitiesCount,
        advances: advancesCount,
        materials: materialsCount,
        workers: workersCount
      },
    });
  };

  const handleConfirmDeleteEntity = async () => {
    if (!deleteConfirmModal || queuingGanttWithdrawal) return;
    const { type, entityId, sectorId, galponId, code, name } = deleteConfirmModal;
    const module: AppModuleId = type === 'gantt_withdrawal' ? 'gantt' : type === 'activity' ? 'actividades' :
      type === 'sector' || type === 'galpon' ? 'proyectos' : type === 'advance' ? 'avance_diario' :
      type === 'material' ? 'materiales' : type === 'worker' ? 'personal' : 'catalogo';
    if (!requirePermission(module, 'delete')) return;

    if ((type === 'sector' || type === 'galpon' || type === 'gantt_withdrawal') && sectorId) {
      const sector = sectors.find(item => item.id === sectorId);
      if (!sector || (type !== 'sector' && !sector.galpones.some((barn: any) => barn.id === galponId))) return;
      const revision = sector._revision ?? 0;
      const queuedOperation = type === 'gantt_withdrawal' ? {
        ganttWithdrawal: true as const, galponId, activityId: entityId, operationType: 'upsert' as const
      } : type === 'sector' ? { structuralDeletion: true as const, operationType: 'delete' as const } : {
        structuralDeletion: true as const, galponId, operationType: 'upsert' as const,
        baseSector: sector, payload: { ...sector, galpones: sector.galpones.filter((barn: any) => barn.id !== galponId) }
      };
      setQueuingGanttWithdrawal(true);
      const queued = await queueOperationLocally({
        ...queuedOperation, collectionName: 'sectors', documentId: sectorId, expectedRevision: revision, status: 'pending_sync'
      });
      setQueuingGanttWithdrawal(false);
      if (!queued) {
        setDeleteConfirmModal(current => current ? { ...current, extraDetails: 'No se pudo guardar la operación en la cola. Vuelva a intentar.' } : null);
        return;
      }
    } else if (type === 'activity' && entityId && sectorId && galponId) {
      setSectors((prev) =>
        prev.map((s) => {
          if (s.id !== sectorId) return s;
          return {
            ...s,
            galpones: s.galpones.map((g: any) => {
              if (g.id !== galponId) return g;
              return recordActivityDeletionTombstone(
                {
                  ...g,
                  areas: (g.areas || []).map((area: any) => {
                    if (area.hasSistemas && area.sistemas) {
                      return {
                        ...area,
                        sistemas: area.sistemas.map((sis: any) => ({
                          ...sis,
                          structures: (sis.structures || []).map((str: any) => ({
                            ...str,
                            activities: (str.activities || []).filter(
                              (a: any) => a.id !== entityId
                            )
                          }))
                        }))
                      };
                    }
                    return {
                      ...area,
                      structures: (area.structures || []).map((str: any) => ({
                        ...str,
                        activities: (str.activities || []).filter(
                          (a: any) => a.id !== entityId
                        )
                      }))
                    };
                  })
                },
                entityId,
                activeUserName
              );
            })
          };
        })
      );

    } else if (type === 'material' && entityId) {
      setMaterials((prev) => prev.filter((m) => m.id !== entityId));
    } else if (type === 'worker' && entityId) {
      setMasterWorkforce((prev) => prev.filter((w) => w.id !== entityId));
    } else if (type === 'advance' && entityId) {
      const targetAdv = dailyAdvances.find((a) => a.id === entityId);
      if (targetAdv) {
        const nextAdvances = targetAdv.sharedGroupId
          ? dailyAdvances.filter((a) => a.sharedGroupId !== targetAdv.sharedGroupId)
          : dailyAdvances.filter((a) => a.id !== entityId);

        setDailyAdvances(nextAdvances);
        setMaterials((prevMats) =>
          recalculateMaterialsFromAdvances(prevMats, nextAdvances)
        );


      }
    } else if (type === 'catalog_item' && entityId) {
      setMasterCatalog((prev) => getActiveMasterCatalog(prev).filter((c) => c.id !== entityId));
    } else if (
      type === 'catalog_structure' &&
      deleteConfirmModal.areaName &&
      deleteConfirmModal.structureName
    ) {
      const { remainingCatalog, removedItems } = deleteStructureFromMasterCatalog(
        masterCatalog,
        {
          areaName: deleteConfirmModal.areaName,
          sistemaName: deleteConfirmModal.sistemaName,
          structureName: deleteConfirmModal.structureName
        }
      );
      setMasterCatalog(remainingCatalog);
    } else if (type === 'template_provider' && code) {
      setTechnologies((prev) => prev.filter((t) => t !== code));
      setMasterCatalog((prev) =>
        getActiveMasterCatalog(prev).filter((item) => item.technology !== code)
      );
    }

    setDeleteConfirmModal(null);
  };

  const handleReloadGalponFromCatalog = (secId: string, galponObj: any) => {
    if (!requirePermission('proyectos', 'edit')) return;
    const sector = sectors.find(item => item.id === secId);
    if (!sector) return;
    const cleanTech = (galponObj.technology || '').trim();
    setSectors((prev) =>
      prev.map((s) =>
        s.id === secId
          ? {
              ...s,
              galpones: s.galpones.map((g: any) =>
                g.id === galponObj.id
                  ? {
                      ...g,
                      areas: mergeAreasWithCatalog(
                        g.areas || [],
                        activeMasterCatalog,
                        cleanTech,
                        galponObj.startDate || getSystemToday()
                      )
                    }
                  : g
              )
            }
          : s
      )
    );
  };

  // ==========================================================================
  // HANDLERS: GESTIÓN DE ACTIVIDADES EN EL GALPÓN (SELECCIÓN PROGRESIVA DESDE CATÁLOGO)
  // ==========================================================================
  const [activityEditorModule, setActivityEditorModule] = useState<'gantt' | 'actividades'>('actividades');
  const openNewActivity = (module: 'gantt' | 'actividades') => {
    if (!requirePermission(module, 'create')) return;
    setActivityEditorModule(module);
    const today = getSystemToday();
    setFormActivity({
      useCatalog: true,
      targetGalponId: currentGalpon?.id || '',
      catalogItemId: '',
      selectedCatalogItemIds: [],
      code: '',
      name: '',
      areaName: '',
      locationType: '',
      sistemaName: '',
      customSistemaName: '',
      structureName: '',
      customStructureName: '',
      progressMode: 'quantity',
      targetUnits: '',
      unit: '',
      weight: '',
      plannedHH: '',
      startDate: today,
      dueDate: today,
      sharedWithGalponId: ''
    });
    setModalNewActivity(true);
  };

  const openNewActivityModal = () => openNewActivity('actividades');

  const handleSaveNewActivity = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission(activityEditorModule, 'create')) return;
    const primaryGalponId = formActivity.targetGalponId || currentGalpon?.id || '';
    if (!primaryGalponId) return;
    if (!formActivity.areaName || !formActivity.sistemaName || !formActivity.structureName) {
      return;
    }

    const selectedCatalogItems = availableAssignCatalogActivities.filter((a) =>
      (formActivity.selectedCatalogItemIds || []).includes(a.id)
    );
    if (selectedCatalogItems.length === 0) return;

    const targetGalponIds = [primaryGalponId];
    if (
      formActivity.sharedWithGalponId &&
      !targetGalponIds.includes(formActivity.sharedWithGalponId)
    ) {
      targetGalponIds.push(formActivity.sharedWithGalponId);
    }

    const nowIso = new Date().toISOString();
    const today = getSystemToday();
    const startDate = formActivity.startDate || today;
    const dueDate = formActivity.dueDate || startDate;

    const assignmentResult = assignCatalogActivitiesToSectors({
      sectors,
      catalogItemsToAssign: selectedCatalogItems,
      targetGalponIds,
      startDate,
      dueDate,
      updatedBy: activeUserName,
      nowIso,
      allAreas: ALL_AREAS,
      areasWithSistemas: AREAS_WITH_SISTEMAS,
      generateIdFn: generateId,
      singleItemOverrides:
        selectedCatalogItems.length === 1
          ? {
              code: formActivity.code,
              name: formActivity.name,
              progressMode: formActivity.progressMode,
              targetUnits: formActivity.targetUnits,
              unit: formActivity.unit,
              weight: formActivity.weight,
              plannedHH: formActivity.plannedHH,
              locationType: formActivity.locationType
            }
          : undefined
    });

    setSectors(assignmentResult.updatedSectors);

    // Si el usuario eligió otro galpón destino en el modal, cambiamos a ese galpón y sector para que vea su actividad de inmediato
    const targetGalInfo = allGalponesList.find((g) => g.id === primaryGalponId);
    if (targetGalInfo) {
      setSelectedSectorId(targetGalInfo.sectorId);
      setSelectedGalponId(targetGalInfo.id);
    }




    // Sincronizar filtros de la tabla de actividades para que siempre sea visible inmediatamente
    if (filterActArea !== 'Todas' && filterActArea !== formActivity.areaName) {
      setFilterActArea('Todas');
    }
    if (filterActLocation !== 'Todos') {
      setFilterActLocation('Todos');
    }
    if (searchActText.trim()) {
      setSearchActText('');
    }

    setModalNewActivity(false);
  };

  const handleSaveEditedGalponActivity = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('actividades', 'edit')) return;
    if (!modalEditGalponActivity || !currentGalpon || !currentSector) return;

    const existingAct = evaluatedActivities.find(
      (a) => a.id === modalEditGalponActivity.id
    );
    const oldCode = existingAct?.code || '';
    const newCode = modalEditGalponActivity.code.trim().toUpperCase();
    const newName = modalEditGalponActivity.name.trim();
    const mode = normalizeProgressMode(modalEditGalponActivity.progressMode);
    const editNowIso = new Date().toISOString();

    setSectors((prev) =>
      prev.map((s) => {
        if (s.id !== currentSector.id) return s;
        return {
          ...s,
          galpones: s.galpones.map((g: any) => {
            if (g.id !== currentGalpon.id) return g;
            return {
              ...g,
              updatedAt: editNowIso,
              areas: (g.areas || []).map((area: any) => {
                if (area.hasSistemas && area.sistemas) {
                  return {
                    ...area,
                    sistemas: area.sistemas.map((sis: any) => ({
                      ...sis,
                      structures: (sis.structures || []).map((str: any) => ({
                        ...str,
                        activities: (str.activities || []).map((act: any) =>
                          act.id === modalEditGalponActivity.id
                            ? {
                                ...act,
                                code: newCode,
                                name: newName,
                                progressMode: mode,
                                targetUnits:
                                  mode === 'percentage'
                                    ? 100
                                    : Number(modalEditGalponActivity.targetUnits) || 0,
                                unit:
                                  mode === 'percentage'
                                    ? (modalEditGalponActivity.unit || '').trim() || '%'
                                    : (modalEditGalponActivity.unit || '').trim(),
                                weight: Number(modalEditGalponActivity.weight) || 1.0,
                                plannedHH:
                                  Number(modalEditGalponActivity.plannedHH) || 0,
                                startDate: modalEditGalponActivity.startDate,
                                dueDate: modalEditGalponActivity.dueDate,
                                baseUpdatedAt: act.updatedAt || act.createdAt,
                                updatedAt: editNowIso,
                                updatedBy: activeUserName
                              }
                            : act
                        )
                      }))
                    }))
                  };
                }
                return {
                  ...area,
                  structures: (area.structures || []).map((str: any) => ({
                    ...str,
                    activities: (str.activities || []).map((act: any) =>
                      act.id === modalEditGalponActivity.id
                        ? {
                            ...act,
                            code: newCode,
                            name: newName,
                            progressMode: mode,
                            targetUnits:
                              mode === 'percentage'
                                ? 100
                                : Number(modalEditGalponActivity.targetUnits) || 0,
                            unit:
                              mode === 'percentage'
                                ? (modalEditGalponActivity.unit || '').trim() || '%'
                                : (modalEditGalponActivity.unit || '').trim(),
                            weight: Number(modalEditGalponActivity.weight) || 1.0,
                            plannedHH: Number(modalEditGalponActivity.plannedHH) || 0,
                            startDate: modalEditGalponActivity.startDate,
                            dueDate: modalEditGalponActivity.dueDate,
                            baseUpdatedAt: act.updatedAt || act.createdAt,
                            updatedAt: editNowIso,
                            updatedBy: activeUserName
                          }
                        : act
                    )
                  }))
                };
              })
            };
          })
        };
      })
    );

    // Actualizar referencias en los avances diarios para conservar historial, progreso y consumo intactos (C-4)
    setDailyAdvances((prevAdvances) =>
      prevAdvances.map((adv) => {
        if (
          adv.galponId === currentGalpon.id &&
          (adv.activityId ? adv.activityId === modalEditGalponActivity.id
            : oldCode && !ambiguousCodesByBarn.get(currentGalpon.id)?.has(oldCode) && adv.activityCode === oldCode)
        ) {
          return {
            ...adv,
            activityId: modalEditGalponActivity.id,
            activityCode: newCode
          };
        }
        return adv;
      })
    );

    setModalEditGalponActivity(null);
  };

  const requestWithdrawGanttActivity = (actId: string) => {
    if (!requirePermission('gantt', 'delete') || !currentGalpon || !currentSector) return;
    if (pendingOperations.some(op => op.userId === profile?.uid && sameOperationalScope(op.scopeKey, scopeKey) && isGanttWithdrawal(op) &&
      op.documentId === currentSector.id && op.galponId === currentGalpon.id && op.activityId === actId)) {
      setPermissionNotice('Ya hay un retiro en la cola. Revise el Centro de Sincronización.');
      return;
    }
    const activity = evaluatedActivities.find(item => item.id === actId);
    if (!activity) return;
    setDeleteConfirmModal({ type: 'gantt_withdrawal', entityId: actId, sectorId: currentSector.id,
      galponId: currentGalpon.id, code: activity.code, name: activity.name });
  };

  const requestDeleteGalponActivity = (actId: string) => {
    if (!requirePermission('actividades', 'delete')) return;
    if (!currentGalpon || !currentSector) return;
    const targetAct = evaluatedActivities.find((a) => a.id === actId);
    if (!targetAct) return;
    const relatedAdvancesCount = dailyAdvances.filter(
      (a) =>
        a.galponId === currentGalpon.id &&
        (a.activityId ? a.activityId === actId
          : !ambiguousCodesByBarn.get(currentGalpon.id)?.has(targetAct.code) && a.activityCode === targetAct.code)
    ).length;

    setDeleteConfirmModal({
      type: 'activity',
      entityId: actId,
      sectorId: currentSector.id,
      galponId: currentGalpon.id,
      code: targetAct.code,
      name: targetAct.name,
      stats: {
        advances: relatedAdvancesCount,
        materials: targetAct.linkedMaterials?.length || 0
      },
      extraDetails: `Galpón: ${currentGalpon.code} • Área: ${targetAct.areaName} • Estructura: ${targetAct.structureName}`
    });
  };

  const handleGanttDateChange = (
    actId: string,
    field: 'startDate' | 'dueDate',
    value: string
  ) => {
    if (!requirePermission('gantt', 'edit')) return;
    if (!currentGalpon || !currentSector) return;
    const activity = evaluatedActivities.find(item => item.id === actId);
    const startDate = field === 'startDate' ? value : activity?.startDate;
    const dueDate = field === 'dueDate' ? value : activity?.dueDate;
    if (startDate && dueDate && startDate > dueDate) {
      setPermissionNotice('La fecha de inicio no puede ser posterior al fin de la actividad.');
      return;
    }
    const ganttNowIso = new Date().toISOString();
    setSectors((prev) =>
      prev.map((s) => {
        if (s.id !== currentSector.id) return s;
        return {
          ...s,
          galpones: s.galpones.map((g: any) => {
            if (g.id !== currentGalpon.id) return g;
            return {
              ...g,
              updatedAt: ganttNowIso,
              areas: (g.areas || []).map((area: any) => {
                if (area.hasSistemas && area.sistemas) {
                  return {
                    ...area,
                    sistemas: area.sistemas.map((sis: any) => ({
                      ...sis,
                      structures: (sis.structures || []).map((str: any) => ({
                        ...str,
                        activities: (str.activities || []).map((a: any) =>
                          a.id === actId
                            ? {
                                ...a,
                                [field]: value,
                                baseUpdatedAt: a.updatedAt || a.createdAt,
                                updatedAt: ganttNowIso,
                                updatedBy: activeUserName
                              }
                            : a
                        )
                      }))
                    }))
                  };
                }
                return {
                  ...area,
                  structures: (area.structures || []).map((str: any) => ({
                    ...str,
                    activities: (str.activities || []).map((a: any) =>
                      a.id === actId
                        ? {
                            ...a,
                            [field]: value,
                            baseUpdatedAt: a.updatedAt || a.createdAt,
                            updatedAt: ganttNowIso,
                            updatedBy: activeUserName
                          }
                        : a
                    )
                  }))
                };
              })
            };
          })
        };
      })
    );
  };

  // ==========================================================================
  // HANDLERS: MATERIALES (ASIGNAR A GALPÓN / ÁREA / SISTEMA / ESTRUCTURA)
  // ==========================================================================
  const openNewMaterialModal = () => {
    if (!requirePermission('materiales', 'create')) return;
    setEditingMaterialId(null);
    setFormMaterial({
      sectorId: '',
      galponId: '',
      technology: '',
      code: '',
      name: '',
      areaId: '',
      areaName: '',
      locationType: '',
      sistemaId: '',
      sistemaName: '',
      customSistemaName: '',
      structureId: '',
      structureName: '',
      customStructureName: '',
      totalQty: '',
      usedQty: 0,
      unit: ''
    });
    setMaterialError('');
    setModalNewMaterial(true);
  };

  const openEditMaterialModal = (mat: any) => {
    if (!requirePermission('materiales', 'edit')) return;
    setEditingMaterialId(mat.id);
    setFormMaterial({
      sectorId: mat.sectorId || '',
      galponId: mat.galponId || '',
      technology: mat.technology || '',
      code: mat.code || '',
      name: mat.name || '',
      areaId: mat.areaId || '',
      areaName: mat.areaName || '',
      locationType: mat.locationType || '',
      sistemaId: mat.sistemaId || '',
      sistemaName: mat.sistemaName || '',
      customSistemaName: '',
      structureId: mat.structureId || '',
      structureName: mat.structureName || '',
      customStructureName: '',
      totalQty: String(mat.totalQty ?? ''),
      usedQty: Number(mat.usedQty || 0),
      unit: mat.unit || ''
    });
    setMaterialError('');
    setModalNewMaterial(true);
  };

  const handleSaveMaterial = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('materiales', editingMaterialId ? 'edit' : 'create')) return;
    setMaterialError('');
    const cleanCode = formMaterial.code.trim().toUpperCase();
    const cleanName = formMaterial.name.trim();
    const cleanTech = formMaterial.technology.trim();
    const cleanArea = formMaterial.areaName.trim();
    const cleanUnit = formMaterial.unit.trim();

    const hasSistemas = AREAS_WITH_SISTEMAS.includes(cleanArea);
    const finalSistema = hasSistemas
      ? formMaterial.sistemaName === '__NEW__'
        ? formMaterial.customSistemaName.trim()
        : formMaterial.sistemaName.trim()
      : '';

    const finalStructure =
      formMaterial.structureName === '__NEW__'
        ? formMaterial.customStructureName.trim()
        : formMaterial.structureName.trim();

    if (!cleanCode || !cleanName || !cleanTech || !cleanArea || !finalStructure || !cleanUnit) {
      setMaterialError('Complete el código, nombre, proveedor, área, estructura y unidad.');
      return;
    }
    if (hasSistemas && !finalSistema) {
      setMaterialError('Seleccione el sistema correspondiente a esta área.');
      return;
    }

    let resolvedSectorId = formMaterial.sectorId || '';
    const resolvedGalponId = formMaterial.galponId || '';
    let resolvedAreaId = formMaterial.areaId || '';
    let resolvedSistemaId = hasSistemas ? formMaterial.sistemaId || '' : '';
    let resolvedStructureId = formMaterial.structureId || '';
    const resolvedLocType = hasSistemas ? formMaterial.locationType || 'Interno' : '';

    if (resolvedGalponId) {
      let structureExists = false;
      const galInfo = allGalponesList.find((g) => g.id === resolvedGalponId);
      if (!galInfo) {
        setMaterialError('El galpón seleccionado ya no está disponible.');
        return;
      }
      if (galInfo) {
        resolvedSectorId = galInfo.sectorId;
        const areaObj = galInfo.areas?.find((a: any) => a.name === cleanArea);
        if (areaObj) {
          resolvedAreaId = areaObj.id || resolvedAreaId;
          if (hasSistemas) {
            const sisObj = (areaObj.sistemas || []).find(
              (s: any) =>
                (s.name || '').toLowerCase() === finalSistema.toLowerCase() &&
                (!formMaterial.locationType ||
                  (s.locationType || 'Interno') === formMaterial.locationType)
            );
            if (sisObj) {
              resolvedSistemaId = sisObj.id || resolvedSistemaId;
              const strObj = (sisObj.structures || []).find(
                (st: any) =>
                  (st.name || '').toLowerCase() === finalStructure.toLowerCase()
              );
              if (strObj) {
                structureExists = true;
                resolvedStructureId = strObj.id || resolvedStructureId;
              }
            }
          } else {
            const strObj = (areaObj.structures || []).find(
              (st: any) =>
                (st.name || '').toLowerCase() === finalStructure.toLowerCase()
            );
            if (strObj) {
              structureExists = true;
              resolvedStructureId = strObj.id || resolvedStructureId;
            }
          }
        }
      }
      if (!structureExists && !canDo('actividades', 'create') && !canDo('gantt', 'create')) {
        setMaterialError('Seleccione una estructura existente en el galpón. Su rol puede registrar materiales en la estructura vigente.');
        return;
      }

      // Si el área/sistema/estructura aún no tenía nodo en el galpón, lo garantizamos con IDs únicos
      if (!resolvedAreaId) resolvedAreaId = generateId('area');
      if (hasSistemas && !resolvedSistemaId) resolvedSistemaId = generateId('sis');
      if (!resolvedStructureId) resolvedStructureId = generateId('str');

      if (!structureExists) setSectors((prev) =>
        prev.map((sec) => {
          if (sec.id !== resolvedSectorId) return sec;
          return {
            ...sec,
            galpones: (sec.galpones || []).map((g: any) => {
              if (g.id !== resolvedGalponId) return g;
              const baseAreas =
                g.areas && g.areas.length > 0
                  ? g.areas
                  : ALL_AREAS.map((aName, idx) => ({
                      id: aName === cleanArea ? resolvedAreaId : generateId(`area_${idx}`),
                      name: aName,
                      hasSistemas: AREAS_WITH_SISTEMAS.includes(aName),
                      sistemas: [],
                      structures: []
                    }));

              const updatedAreas = baseAreas.map((area: any) => {
                if (area.name !== cleanArea) return area;
                const finalAreaObjId = area.id || resolvedAreaId;
                if (hasSistemas) {
                  const sisList = [...(area.sistemas || [])];
                  let sisObj = sisList.find(
                    (s: any) =>
                      s.id === resolvedSistemaId ||
                      ((s.name || '').toLowerCase() === finalSistema.toLowerCase() &&
                        (s.locationType || 'Interno') === resolvedLocType)
                  );
                  if (!sisObj) {
                    sisObj = {
                      id: resolvedSistemaId,
                      name: finalSistema,
                      locationType: resolvedLocType,
                      structures: []
                    };
                    sisList.push(sisObj);
                  } else {
                    resolvedSistemaId = sisObj.id;
                  }
                  const strList = [...(sisObj.structures || [])];
                  let strObj = strList.find(
                    (st: any) =>
                      st.id === resolvedStructureId ||
                      (st.name || '').toLowerCase() === finalStructure.toLowerCase()
                  );
                  if (!strObj) {
                    strObj = {
                      id: resolvedStructureId,
                      name: finalStructure,
                      activities: []
                    };
                    strList.push(strObj);
                  } else {
                    resolvedStructureId = strObj.id;
                  }
                  sisObj.structures = strList;
                  return {
                    ...area,
                    id: finalAreaObjId,
                    hasSistemas: true,
                    sistemas: sisList
                  };
                } else {
                  const strList = [...(area.structures || [])];
                  let strObj = strList.find(
                    (st: any) =>
                      st.id === resolvedStructureId ||
                      (st.name || '').toLowerCase() === finalStructure.toLowerCase()
                  );
                  if (!strObj) {
                    strObj = {
                      id: resolvedStructureId,
                      name: finalStructure,
                      activities: []
                    };
                    strList.push(strObj);
                  } else {
                    resolvedStructureId = strObj.id;
                  }
                  return {
                    ...area,
                    id: finalAreaObjId,
                    hasSistemas: false,
                    structures: strList
                  };
                }
              });

              return { ...g, areas: updatedAreas };
            })
          };
        })
      );
    }

    const existingMat = editingMaterialId
      ? materials.find((m) => m.id === editingMaterialId)
      : null;

    const baseMatPayload = {
      id: editingMaterialId || generateId('mat'),
      sectorId: resolvedSectorId,
      galponId: resolvedGalponId,
      technology: cleanTech,
      code: cleanCode,
      name: cleanName,
      areaId: resolvedAreaId,
      areaName: cleanArea,
      locationType: hasSistemas ? resolvedLocType : '',
      sistemaId: hasSistemas ? resolvedSistemaId : '',
      sistemaName: hasSistemas ? finalSistema : null,
      structureId: resolvedStructureId,
      structureName: finalStructure,
      totalQty: Number(formMaterial.totalQty) || 0,
      initialUsedQty: existingMat ? Number(existingMat.initialUsedQty || 0) : 0,
      usedQty: 0,
      unit: cleanUnit
    };
    const newMatPayload = {
      ...baseMatPayload,
      usedQty: usedMaterialQuantity(baseMatPayload)
    };

    const assignedGalForLog = allGalponesList.find(
      (g) => g.id === newMatPayload.galponId
    );

    if (editingMaterialId) {
      setMaterials((prev) =>
        prev.map((m) => (m.id === editingMaterialId ? newMatPayload : m))
      );
    } else {
      setMaterials((prev) => [...prev, newMatPayload]);
    }

    // Sincronizar filtros para que el material recién guardado siempre quede visible inmediatamente
    if (filterMaterialGalpon !== 'Todos') {
      const matchesGalponFilter =
        (filterMaterialGalpon === '__UNASSIGNED__' && !newMatPayload.galponId) ||
        filterMaterialGalpon === newMatPayload.galponId;
      if (!matchesGalponFilter) {
        setFilterMaterialGalpon('Todos');
      }
    }
    if (filterMaterialTech !== 'Todas' && filterMaterialTech !== newMatPayload.technology) {
      setFilterMaterialTech('Todas');
    }
    if (filterMaterialArea !== 'Todas' && filterMaterialArea !== newMatPayload.areaName) {
      setFilterMaterialArea('Todas');
    }
    if (searchMaterialText.trim()) {
      const q = searchMaterialText.toLowerCase().trim();
      const matchesSearch =
        newMatPayload.code.toLowerCase().includes(q) ||
        newMatPayload.name.toLowerCase().includes(q) ||
        (newMatPayload.structureName || '').toLowerCase().includes(q) ||
        (newMatPayload.sistemaName || '').toLowerCase().includes(q);
      if (!matchesSearch) {
        setSearchMaterialText('');
      }
    }

    setModalNewMaterial(false);
    setEditingMaterialId(null);
  };

  const requestDeleteMaterial = (id: string) => {
    if (!requirePermission('materiales', 'delete')) return;
    const targetMat = materials.find((m) => m.id === id);
    if (!targetMat) return;
    const relatedAdvancesCount = dailyAdvances.filter((adv) =>
      (adv.materialsUsedToday || []).some(
        (u: any) =>
          u.materialId === id ||
          (!u.materialId &&
            u.code === targetMat.code &&
            (!targetMat.galponId || targetMat.galponId === adv.galponId))
      )
    ).length;
    const galInfo = targetMat.galponId
      ? allGalponesList.find((g) => g.id === targetMat.galponId)
      : null;

    setDeleteConfirmModal({
      type: 'material',
      entityId: id,
      code: targetMat.code,
      name: targetMat.name,
      stats: {
        advances: relatedAdvancesCount
      },
      extraDetails: `${galInfo ? `${galInfo.sectorName} • ${galInfo.code}` : 'Sin galpón asignado'} • Consumido: ${targetMat.usedQty || 0} / ${targetMat.totalQty || 0} ${targetMat.unit || ''}`
    });
  };

  // ==========================================================================
  // HANDLERS: AVANCE DIARIO EN CASCADA + TRABAJO BIPROYECTO (C-2) + CONSUMO POR ID (C-1)
  // ==========================================================================
  const openNewAdvanceModal = (prefill?: Partial<typeof formAdvance>) => {
    if (!requirePermission('avance_diario', 'create')) return;
    setEditingAdvanceId(null);
    setAdvanceValidationError(null);
    setFormAdvance({
      areaName: prefill?.areaName || '',
      locationType: prefill?.locationType || 'Todos',
      sistemaName: prefill?.sistemaName || '',
      structureName: prefill?.structureName || '',
      activityId: prefill?.activityId || '',
      date: '',
      quantityToday: '',
      hoursWorked: '',
      supervisor: '',
      note: '',
      sharedAcrossTwoGalpones: false,
      secondGalponId: '',
      splitMode: '100_both',
      workerIds: [],
      manualMaterialInputs: {},
      isAuthorizedCorrection: false,
      correctionReason: ''
    });
    setModalNewAdvance(true);
  };

  const openEditAdvanceModal = (adv: any) => {
    if (!requirePermission('avance_diario', 'edit')) return;
    setEditingAdvanceId(adv.id);
    setAdvanceValidationError(null);
    const act = findAdvanceActivity(evaluatedActivities, adv.activityId, adv.activityCode);
    const manualInputs: Record<string, string> = {};

    // Si es un avance compartido (Trabajo Biproyecto), reconstruir los insumos totales del grupo compartido
    const groupLogs = adv.sharedGroupId
      ? dailyAdvances.filter((a) => a.sharedGroupId === adv.sharedGroupId)
      : [adv];
    const primarySharedLog =
      groupLogs.find((a) => !a.isSecondarySharedCopy) || adv;
    const secondarySharedLog = groupLogs.find(
      (a) => a.id !== primarySharedLog.id
    );

    const sourceMaterialsList =
      adv.sharedGroupId && primarySharedLog.sharedTotalMaterialsUsed
        ? primarySharedLog.sharedTotalMaterialsUsed
        : primarySharedLog.materialsUsedToday || adv.materialsUsedToday || [];

    if (sourceMaterialsList.length > 0) {
      sourceMaterialsList.forEach((u: any) => {
        if (u.materialId) {
          manualInputs[u.materialId] = String(u.qty ?? '');
        } else {
          const matchedMat =
            act?.linkedMaterials?.find((m: any) => m.code === u.code) ||
            materials.find(
              (m) =>
                m.code === u.code &&
                (!m.galponId || m.galponId === adv.galponId)
            );
          if (matchedMat) {
            manualInputs[matchedMat.id] = String(u.qty ?? '');
          }
        }
      });
    }

    const savedSplitMode: '50_50' | '100_both' =
      adv.splitMode === '50_50' || primarySharedLog.splitMode === '50_50'
        ? '50_50'
        : '100_both';

    const rawTotalQty =
      adv.sharedGroupId && primarySharedLog.rawInputQty !== undefined
        ? primarySharedLog.rawInputQty
        : adv.sharedGroupId && savedSplitMode === '50_50'
          ? Math.round(Number(adv.quantityToday || 0) * 2 * 100) / 100
          : adv.percentageReached !== undefined
            ? adv.percentageReached
            : adv.quantityToday;

    const rawTotalHH =
      adv.sharedGroupId && primarySharedLog.rawInputHH !== undefined
        ? primarySharedLog.rawInputHH
        : adv.sharedGroupId && savedSplitMode === '50_50'
          ? Math.round(Number(adv.hoursWorked || 0) * 2 * 100) / 100
          : adv.hoursWorked;

    const cleanNote = (adv.note || '').replace(
      /^\[Trabajo Biproyecto[^\]]*\]\s*/i,
      ''
    );

    setFormAdvance({
      areaName: act?.areaName || '',
      locationType: act?.locationType || 'Todos',
      sistemaName: act?.sistemaName || '',
      structureName: act?.structureName || '',
      activityId: act?.id || '',
      date: adv.date || '',
      quantityToday: String(rawTotalQty ?? ''),
      hoursWorked: String(rawTotalHH ?? ''),
      supervisor: adv.supervisor || '',
      note: cleanNote,
      sharedAcrossTwoGalpones: Boolean(adv.sharedGroupId && secondarySharedLog),
      secondGalponId: secondarySharedLog
        ? secondarySharedLog.galponId === currentGalpon?.id
          ? primarySharedLog.galponId
          : secondarySharedLog.galponId
        : '',
      splitMode: savedSplitMode,
      workerIds: [...new Set<string>((groupLogs.length ? groupLogs : [adv])
        .flatMap(item => Array.isArray(item.workerIds) ? item.workerIds.filter((id: unknown) => typeof id === 'string') : []))],
      manualMaterialInputs: manualInputs,
      isAuthorizedCorrection: Boolean(adv.isAuthorizedCorrection),
      correctionReason: adv.correctionReason || ''
    });
    setModalNewAdvance(true);
  };

  const handleSaveAdvance = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('avance_diario', editingAdvanceId ? 'edit' : 'create')) return;
    if (!formAdvance.activityId || formAdvance.quantityToday === '' || !currentGalpon)
      return;

    const rawQty = Number(formAdvance.quantityToday);
    if (!Number.isFinite(rawQty)) {
      setAdvanceValidationError('Ingresa un valor numérico válido.');
      return;
    }

    const selectedAct = findAdvanceActivity(evaluatedActivities, formAdvance.activityId);
    if (!selectedAct) {
      setAdvanceValidationError('La actividad ya no está disponible en este galpón.');
      return;
    }
    const actMode = normalizeProgressMode(selectedAct.progressMode);
    const activityCode = selectedAct.code;
    const legacyCodeIsUnique = Boolean(findAdvanceActivity(evaluatedActivities, undefined, activityCode));

    // Si es modalidad Porcentaje, validar rango 0% - 100% y que no disminuya salvo corrección histórica autorizada
    if (actMode === 'percentage') {
      // Calcular el último porcentaje válido excluyendo el registro que se está editando (si aplica)
      const logsForValidation = dailyAdvances.filter(
        (l) =>
          l.galponId === currentGalpon.id &&
          (l.activityId ? l.activityId === selectedAct.id : legacyCodeIsUnique && l.activityCode === activityCode)
      );

      const validation = validatePercentageAdvanceRegistration({
        newPercentage: rawQty,
        existingLogsForActivity: logsForValidation,
        editingAdvanceId,
        isAuthorizedCorrection: formAdvance.isAuthorizedCorrection,
        correctionReason: formAdvance.correctionReason,
        userRole: profile?.role
      });

      if (!validation.valid) {
        setAdvanceValidationError(
          validation.error || 'Porcentaje inválido para esta actividad.'
        );
        return;
      }
    } else if (rawQty < 0) {
      setAdvanceValidationError('La cantidad ejecutada no puede ser negativa.');
      return;
    }

    setAdvanceValidationError(null);

    const rawHH = Number(formAdvance.hoursWorked) || 0;
    const isShared =
      formAdvance.sharedAcrossTwoGalpones &&
      Boolean(formAdvance.secondGalponId) &&
      formAdvance.secondGalponId !== currentGalpon.id;
    const factor =
      actMode === 'percentage'
        ? 1
        : isShared && formAdvance.splitMode === '50_50'
          ? 0.5
          : 1;

    const qtyPerGalpon = Math.round(rawQty * factor * 100) / 100;
    const hhPerGalpon = Math.round(
      rawHH * (isShared && formAdvance.splitMode === '50_50' ? 0.5 : 1) * 100
    ) / 100;

    const secondGalponObj = isShared
      ? allGalponesList.find((g) => g.id === formAdvance.secondGalponId)
      : null;

    const existingGroup = dailyAdvances.find(advance => advance.id === editingAdvanceId)?.sharedGroupId;
    const previousCounterpart = existingGroup && dailyAdvances.find(advance =>
      advance.sharedGroupId === existingGroup && advance.galponId === secondGalponObj?.id && advance.activityCode === activityCode);
    const secondGalponActId = findAdvanceActivity(barnActivities(secondGalponObj),
      previousCounterpart?.activityId, activityCode)?.id;

    if (isShared && !secondGalponActId) {
      setAdvanceValidationError('El segundo galpón necesita una única actividad equivalente para registrar el avance compartido.');
      return;
    }

    const totalUsedMatsList: {
      materialId: string;
      code: string;
      name: string;
      qty: number;
      unit: string;
    }[] = [];
    const primaryGalponMatsList: {
      materialId: string;
      code: string;
      name: string;
      qty: number;
      unit: string;
    }[] = [];
    const secondaryGalponMatsList: {
      materialId: string;
      code: string;
      name: string;
      qty: number;
      unit: string;
    }[] = [];

    if (selectedAct && selectedAct.linkedMaterials?.length > 0) {
      selectedAct.linkedMaterials.forEach((mat: any) => {
        const manualVal = formAdvance.manualMaterialInputs[mat.id];
        const qtyUsed =
          manualVal !== undefined && manualVal !== '' ? Number(manualVal) : 0;
        if (qtyUsed > 0) {
          totalUsedMatsList.push({
            materialId: mat.id,
            code: mat.code,
            name: mat.name,
            qty: qtyUsed,
            unit: mat.unit
          });

          if (isShared && secondGalponObj) {
            const counterpartMat = materials.find(
              (m) =>
                m.id !== mat.id &&
                m.galponId === secondGalponObj.id &&
                m.code.toLowerCase() === mat.code.toLowerCase()
            );
            if (counterpartMat) {
              const halfQty = Math.round(qtyUsed * 0.5 * 100) / 100;
              primaryGalponMatsList.push({
                materialId: mat.id,
                code: mat.code,
                name: mat.name,
                qty: halfQty,
                unit: mat.unit
              });
              secondaryGalponMatsList.push({
                materialId: counterpartMat.id,
                code: counterpartMat.code,
                name: counterpartMat.name,
                qty: Math.round((qtyUsed - halfQty) * 100) / 100,
                unit: counterpartMat.unit
              });
            } else {
              primaryGalponMatsList.push({
                materialId: mat.id,
                code: mat.code,
                name: mat.name,
                qty: qtyUsed,
                unit: mat.unit
              });
            }
          } else {
            primaryGalponMatsList.push({
              materialId: mat.id,
              code: mat.code,
              name: mat.name,
              qty: qtyUsed,
              unit: mat.unit
            });
          }
        }
      });
    }

    const previousPart = dailyAdvances.find(item => item.id === editingAdvanceId);
    const previousGroup = previousPart?.sharedGroupId
      ? dailyAdvances.filter(item => item.sharedGroupId === previousPart.sharedGroupId)
      : previousPart ? [previousPart] : [];
    const previousWorkerLocations = new Map<string, string>();
    for (const part of previousGroup) for (const id of Array.isArray(part.workerIds) ? part.workerIds : []) {
      previousWorkerLocations.set(id, part.galponId);
    }
    const workerIdsFor = (galponId: string, sectorId: string) => formAdvance.workerIds.filter(id => {
      const previousLocation = previousWorkerLocations.get(id);
      if (previousLocation) return previousLocation === galponId;
      const worker = masterWorkforce.find(item => item.id === id);
      return worker && workerAtLocation(worker, sectorId, galponId) &&
        (galponId === currentGalpon.id || !workerAtLocation(worker, currentSector?.id, currentGalpon.id));
    });
    const primaryWorkerIds = workerIdsFor(currentGalpon.id, currentSector?.id);
    const secondaryWorkerIds = isShared && secondGalponObj ? workerIdsFor(secondGalponObj.id, secondGalponObj.sectorId) : [];

    const finalSupervisor =
      formAdvance.supervisor.trim() ||
      barnResponsible(currentGalpon) ||
      activeUserName ||
      '';

    const cleanUserNote = formAdvance.note
      .replace(/^\[Trabajo Biproyecto[^\]]*\]\s*/i, '')
      .trim();

    const nowIso = new Date().toISOString();
    const deviceId = getOrCreateDeviceId();
    const opId = createOperationId('op_adv');

    if (editingAdvanceId) {
      const oldAdv = dailyAdvances.find((a) => a.id === editingAdvanceId);
      const oldGroupId = oldAdv?.sharedGroupId;

      const baseAdvances = oldGroupId
        ? dailyAdvances.filter((a) => a.sharedGroupId !== oldGroupId)
        : dailyAdvances.filter((a) => a.id !== editingAdvanceId);

      const sharedGroupId = isShared
        ? oldGroupId || generateId('shared_grp')
        : undefined;

      const updatedPrimaryLog: any = {
        ...(oldAdv || {}),
        id: editingAdvanceId,
        sharedGroupId,
        isSecondarySharedCopy: false,
        sharedWithGalponId: isShared ? formAdvance.secondGalponId : undefined,
        sharedWithGalponCode: isShared ? secondGalponObj?.code : undefined,
        splitMode: isShared ? formAdvance.splitMode : undefined,
        rawInputQty: rawQty,
        rawInputHH: rawHH,
        sharedTotalMaterialsUsed: totalUsedMatsList,
        sectorId: currentSector?.id,
        galponId: currentGalpon.id,
        activityId: selectedAct?.id || oldAdv?.activityId,
        activityCode,
        date: formAdvance.date || getSystemToday(),
        progressMode: actMode,
        percentageReached: actMode === 'percentage' ? qtyPerGalpon : undefined,
        quantityToday: qtyPerGalpon,
        hoursWorked: hhPerGalpon,
        supervisor: finalSupervisor,
        note: isShared
          ? `[Trabajo Biproyecto ${formAdvance.splitMode === '50_50' ? '50/50' : '100% Ambos'} con ${secondGalponObj?.code || formAdvance.secondGalponId}]${cleanUserNote ? ` ${cleanUserNote}` : ''}`
          : cleanUserNote,
        workerIds: primaryWorkerIds,
        materialsUsedToday: primaryGalponMatsList,
        isAuthorizedCorrection: formAdvance.isAuthorizedCorrection || undefined,
        correctionReason: formAdvance.correctionReason?.trim() || undefined,
        createdAt: oldAdv?.createdAt || nowIso,
        updatedAt: nowIso,
        baseTimestamp: oldAdv?.updatedAt || oldAdv?.createdAt || nowIso,
        basePercentage: selectedAct?.lastValidPercentage ?? 0,
        operationId: opId,
        deviceId,
        userId: oldAdv?.userId || profile?.uid || 'local_user',
        userDisplayName:
          oldAdv?.userDisplayName ||
          oldAdv?.supervisor ||
          profile?.displayName ||
          activeUserName,
        lastEditedBy: profile?.uid || 'local_user',
        syncState: 'pending_sync'
      };

      const replacementLogs: any[] = [updatedPrimaryLog];

      if (isShared && secondGalponObj) {
        const oldSecondary = previousGroup.find(item => item.id !== editingAdvanceId && item.galponId === secondGalponObj.id);
        replacementLogs.push({
          ...(oldSecondary ?? {}),
          id: oldSecondary?.id ?? generateId('adv'),
          sharedGroupId,
          isSecondarySharedCopy: true,
          sharedWithGalponId: currentGalpon.id,
          sharedWithGalponCode: currentGalpon.code,
          splitMode: formAdvance.splitMode,
          rawInputQty: rawQty,
          rawInputHH: rawHH,
          sectorId: secondGalponObj.sectorId,
          galponId: secondGalponObj.id,
          activityId: secondGalponActId,
          activityCode,
          date: formAdvance.date || getSystemToday(),
          progressMode: actMode,
          percentageReached: actMode === 'percentage' ? qtyPerGalpon : undefined,
          quantityToday: qtyPerGalpon,
          hoursWorked: hhPerGalpon,
          supervisor: finalSupervisor,
          note: `[Trabajo Biproyecto ${formAdvance.splitMode === '50_50' ? '50/50' : '100% Ambos'} con ${currentGalpon.code}]${cleanUserNote ? ` ${cleanUserNote}` : ''}`,
          workerIds: secondaryWorkerIds,
          materialsUsedToday: secondaryGalponMatsList,
          isAuthorizedCorrection: formAdvance.isAuthorizedCorrection || undefined,
          correctionReason: formAdvance.correctionReason?.trim() || undefined,
          createdAt: oldSecondary?.createdAt ?? nowIso,
          updatedAt: nowIso,
          baseTimestamp: nowIso,
          basePercentage: 0,
          operationId: createOperationId('op_adv_sec'),
          deviceId,
          userId: oldSecondary?.userId || profile?.uid || 'local_user',
          userDisplayName: oldSecondary?.userDisplayName || profile?.displayName || activeUserName,
          syncState: 'pending_sync'
        });
      }

      const nextAdvances = [...replacementLogs, ...baseAdvances];
      setDailyAdvances(nextAdvances);
      setMaterials((prevMats) =>
        recalculateMaterialsFromAdvances(prevMats, nextAdvances)
      );


    } else {
      const sharedGroupId = isShared ? generateId('shared_grp') : undefined;
      const newLogs: any[] = [
        {
          id: generateId('adv'),
          sharedGroupId,
          isSecondarySharedCopy: false,
          sharedWithGalponId: isShared ? formAdvance.secondGalponId : undefined,
          sharedWithGalponCode: isShared ? secondGalponObj?.code : undefined,
          splitMode: isShared ? formAdvance.splitMode : undefined,
          rawInputQty: rawQty,
          rawInputHH: rawHH,
          sharedTotalMaterialsUsed: totalUsedMatsList,
          sectorId: currentSector?.id,
          galponId: currentGalpon.id,
          activityId: selectedAct?.id,
          activityCode,
          date: formAdvance.date || getSystemToday(),
          progressMode: actMode,
          percentageReached: actMode === 'percentage' ? qtyPerGalpon : undefined,
          quantityToday: qtyPerGalpon,
          hoursWorked: hhPerGalpon,
          supervisor: finalSupervisor,
          note: isShared
            ? `[Trabajo Biproyecto ${formAdvance.splitMode === '50_50' ? '50/50' : '100% Ambos'} con ${secondGalponObj?.code || formAdvance.secondGalponId}]${cleanUserNote ? ` ${cleanUserNote}` : ''}`
            : cleanUserNote,
          workerIds: primaryWorkerIds,
          materialsUsedToday: primaryGalponMatsList,
          isAuthorizedCorrection: formAdvance.isAuthorizedCorrection || undefined,
          correctionReason: formAdvance.correctionReason?.trim() || undefined,
          createdAt: nowIso,
          updatedAt: nowIso,
          baseTimestamp: nowIso,
          basePercentage: selectedAct?.lastValidPercentage ?? 0,
          operationId: opId,
          deviceId,
          userId: profile?.uid || 'local_user',
          userDisplayName: profile?.displayName || activeUserName,
          syncState: 'pending_sync'
        }
      ];

      if (isShared && secondGalponObj) {
        newLogs.push({
          id: generateId('adv'),
          sharedGroupId,
          isSecondarySharedCopy: true,
          sharedWithGalponId: currentGalpon.id,
          sharedWithGalponCode: currentGalpon.code,
          splitMode: formAdvance.splitMode,
          rawInputQty: rawQty,
          rawInputHH: rawHH,
          sectorId: secondGalponObj.sectorId,
          galponId: secondGalponObj.id,
          activityId: secondGalponActId,
          activityCode,
          date: formAdvance.date || getSystemToday(),
          progressMode: actMode,
          percentageReached: actMode === 'percentage' ? qtyPerGalpon : undefined,
          quantityToday: qtyPerGalpon,
          hoursWorked: hhPerGalpon,
          supervisor: finalSupervisor,
          note: `[Trabajo Biproyecto ${formAdvance.splitMode === '50_50' ? '50/50' : '100% Ambos'} con ${currentGalpon.code}]${cleanUserNote ? ` ${cleanUserNote}` : ''}`,
          workerIds: secondaryWorkerIds,
          materialsUsedToday: secondaryGalponMatsList,
          isAuthorizedCorrection: formAdvance.isAuthorizedCorrection || undefined,
          correctionReason: formAdvance.correctionReason?.trim() || undefined,
          createdAt: nowIso,
          updatedAt: nowIso,
          baseTimestamp: nowIso,
          basePercentage: 0,
          operationId: createOperationId('op_adv_sec'),
          deviceId,
          userId: profile?.uid || 'local_user',
          userDisplayName: profile?.displayName || activeUserName,
          syncState: 'pending_sync'
        });
      }

      const nextAdvances = [...newLogs, ...dailyAdvances];
      setDailyAdvances(nextAdvances);
      setMaterials((prevMats) =>
        recalculateMaterialsFromAdvances(prevMats, nextAdvances)
      );


    }

    setModalNewAdvance(false);
    setEditingAdvanceId(null);
    setAdvanceValidationError(null);
    setFormAdvance({
      areaName: '',
      locationType: 'Todos',
      sistemaName: '',
      structureName: '',
      activityId: '',
      date: '',
      quantityToday: '',
      hoursWorked: '',
      supervisor: '',
      note: '',
      sharedAcrossTwoGalpones: false,
      secondGalponId: '',
      splitMode: '100_both',
      workerIds: [],
      manualMaterialInputs: {},
      isAuthorizedCorrection: false,
      correctionReason: ''
    });
  };

  const requestDeleteAdvance = (advId: string) => {
    if (!requirePermission('avance_diario', 'delete')) return;
    const targetAdv = dailyAdvances.find((a) => a.id === advId);
    if (!targetAdv) return;
    const actObj = evaluatedActivities.find(
      (a) =>
        (targetAdv.activityId && a.id === targetAdv.activityId) ||
        a.code === targetAdv.activityCode
    );
    const matsUsedCount = (targetAdv.materialsUsedToday || []).length;

    setDeleteConfirmModal({
      type: 'advance',
      entityId: advId,
      code: targetAdv.activityCode,
      name: actObj?.name || targetAdv.activityCode,
      stats: {
        materials: matsUsedCount
      },
      extraDetails: `Fecha: ${targetAdv.date} • Avance: +${targetAdv.quantityToday} ${actObj?.unit || ''} • ${targetAdv.hoursWorked || 0} HH${targetAdv.sharedGroupId ? ` • Trabajo Biproyecto compartido (${targetAdv.sharedWithGalponCode || '2 galpones'})` : ''}`
    });
  };

  // ==========================================================================
  // HANDLERS: PERSONAL Y ASISTENCIA (SIN VALORES PREDETERMINADOS FIJOS - C-7)
  // ==========================================================================
  const handleSaveWorker = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('personal', formWorker.id ? 'edit' : 'create')) return;
    if (
      !formWorker.name ||
      !formWorker.workerCode ||
      !formWorker.workArea ||
      !formWorker.role
    )
      return;

    const payload = {
      id: formWorker.id || generateId('w'),
      workerCode: normalizeWorkerCode(formWorker.workerCode),
      dni: formWorker.dni.trim(),
      name: formWorker.name.trim(),
      workArea: formWorker.workArea.trim(),
      role: formWorker.role.trim(),
      sectorId: formWorker.sectorId || '',
      galponId: formWorker.galponId || '',
      active: true
    };
    const invalid = invalidWorkerField(payload);
    if (invalid) {
      setPermissionNotice(`Campo de Personal inválido: ${invalid}.`);
      return;
    }

    if (formWorker.id) {
      setMasterWorkforce((prev) =>
        prev.map((w) => (w.id === formWorker.id ? payload : w))
      );
    } else {
      setMasterWorkforce((prev) => [...prev, payload]);
    }

    setModalNewWorker(false);
  };

  const handleWorkerFieldChange = (workerId: string, field: string, value: any) => {
    if (!requirePermission('personal', 'edit')) return;
    setMasterWorkforce((prev) =>
      prev.map((w) => (w.id === workerId ? { ...w, [field]: value } : w))
    );
  };

  const handleWorkerSectorChange = (workerId: string, newSectorId: string) => {
    if (!requirePermission('personal', 'edit')) return;

    setMasterWorkforce((prev) =>
      prev.map((w) =>
        w.id === workerId
          ? { ...w, sectorId: newSectorId, galponId: '' }
          : w
      )
    );
  };

  const requestDeleteWorker = (workerId: string) => {
    if (!requirePermission('personal', 'delete')) return;
    const targetW = masterWorkforce.find((w) => w.id === workerId);
    if (!targetW) return;
    const attendanceDaysCount = Object.values(attendanceRecords).filter(
      (dayMap: any) => dayMap && dayMap[workerId]
    ).length;

    setDeleteConfirmModal({
      type: 'worker',
      entityId: workerId,
      code: targetW.workerCode,
      name: targetW.name,
      stats: {
        attendanceDays: attendanceDaysCount
      },
      extraDetails: `Especialidad: ${targetW.workArea || 'Sin asignar'} • Cargo: ${targetW.role || 'Sin asignar'}`
    });
  };

  const handleSetWorkerAttendance = (workerId: string, status: string) => {
    if (!requirePermission('asistencia', attendanceRecords[attendanceDate]?.[workerId] ? 'edit' : 'create')) return;
    setAttendanceRecords((prev) => {
      const dayMap = prev[attendanceDate] || {};
      return {
        ...prev,
        [attendanceDate]: {
          ...dayMap,
          [workerId]: status
        }
      };
    });
  };

  const handleClearAttendance = (workerId: string) => {
    if (!requirePermission('asistencia', 'delete')) return;
    setAttendanceRecords(previous => {
      const day = { ...previous[attendanceDate] };
      delete day[workerId];
      return { ...previous, [attendanceDate]: day };
    });
  };

  const handleMarkAllAttended = () => {
    if (!requirePermission('asistencia', 'edit')) return;
    setAttendanceRecords((prev) => {
      const dayMap = { ...(prev[attendanceDate] || {}) };
      filteredAttendanceWorkers.forEach((w) => {
        dayMap[w.id] = 'Asistió';
      });
      return { ...prev, [attendanceDate]: dayMap };
    });
  };

  // ==========================================================================
  // CARGA MASIVA EXCEL (.XLSX / .CSV / PEGADO DIRECTO) CON VISTA PREVIA (C-6)
  // ==========================================================================
  const resetBulkUploadState = () => {
    bulkReadId.current++;
    setBulkFileError('');
    setBulkCsvText('');
    setBulkRawRows([]);
    setBulkFileName('');
    setBulkTargetGalponId('');
    setModalBulkUpload(null);
  };

  const handleBulkFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const readId = ++bulkReadId.current;
    setBulkFileName('');
    setBulkRawRows([]);
    setBulkCsvText('');
    setBulkFileError('');
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('El archivo supera el límite de 2 MB.');
      const ext = file.name.split('.').pop()?.toLowerCase();
      let rows: string[][];
      if (ext === 'csv' || ext === 'txt') {
        rows = parsePastedTabularText(await file.text());
      } else {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', sheetRows: MAX_BULK_ROWS + 2 });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        if (!sheet?.['!ref']) throw new Error('La primera hoja está vacía.');
        const range = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref']);
        if (range.e.r - range.s.r > MAX_BULK_ROWS) throw new Error('Importe hasta 1000 filas de datos por archivo.');
        if (range.e.c - range.s.c >= 64) throw new Error('El archivo supera el límite de 64 columnas.');
        rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false, blankrows: false })
          .map(row => row.map(cell => String(cell ?? '').trim()));
      }
      if (rows.length < 2) throw new Error('Incluya los encabezados y al menos una fila de datos.');
      if (rows.length > MAX_BULK_ROWS + 1) throw new Error('Importe hasta 1000 filas de datos por archivo.');
      if (readId !== bulkReadId.current) return;
      setBulkFileName(file.name);
      setBulkRawRows(rows);
    } catch (err) {
      if (readId === bulkReadId.current) setBulkFileError(err instanceof Error && [
        'El archivo supera el límite de 2 MB.', 'La primera hoja está vacía.', 'El archivo supera el límite de 64 columnas.',
        'Importe hasta 1000 filas de datos por archivo.', 'Incluya los encabezados y al menos una fila de datos.'
      ].includes(err.message) ? err.message : 'No se pudo leer el archivo. Revise su formato.');
    }
  };

  const downloadBulkTemplate = async () => {
    if (!modalBulkUpload || !requirePermission(modalBulkUpload, 'import')) return;
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([BULK_COLUMNS[modalBulkUpload]]), 'Plantilla');
    XLSX.writeFile(book, 'Plantilla_' + modalBulkUpload + '.xlsx');
  };

  const exportCatalogWorkbook = async () => {
    if (!requirePermission('catalogo', 'export')) return;
    const rows = activeMasterCatalog.filter(item => selectedCatalogTech === 'Todas' || item.technology === selectedCatalogTech)
      .map(item => [item.technology ?? '', item.code, item.areaName, item.locationType ?? '', item.sistemaName ?? '',
        item.structureName, item.name, item.targetUnits ?? '', item.unit ?? '', item.weight ?? '', item.plannedHH ?? '',
        item.progressMode === 'percentage' ? 'Porcentaje' : 'Cantidades', item.durationDays ?? '']);
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([BULK_COLUMNS.catalogo, ...rows]), 'Actividades');
    XLSX.writeFile(book, 'Catalogo_actividades.xlsx');
  };

  const bulkImportAnalysis = useMemo(() => {
    if (!modalBulkUpload) {
      return {
        allRows: [] as any[],
        validRows: [] as any[],
        duplicateRows: [] as any[],
        rejectedRows: [] as any[]
      };
    }

    const rawMatrix =
      bulkRawRows.length > 0
        ? bulkRawRows
        : parsePastedTabularText(bulkCsvText);

    if (rawMatrix.length > MAX_BULK_ROWS + 1) {
      return { allRows: [], validRows: [], duplicateRows: [], rejectedRows: [],
        error: 'Pegue hasta 1000 filas de datos por lote.' };
    }
    if (rawMatrix.length === 0) {
      return {
        allRows: [] as any[],
        validRows: [] as any[],
        duplicateRows: [] as any[],
        rejectedRows: [] as any[]
      };
    }

    const firstRowNorm = rawMatrix[0].map(normalizeHeaderKey);
    const headerKeywords = [
      'proveedor',
      'plantilla',
      'tecnologia',
      'codigo',
      'code',
      'area',
      'ubicacion',
      'sistema',
      'estructura',
      'actividad',
      'material',
      'descripcion',
      'nombre',
      'meta',
      'cantidad',
      'total',
      'unidad',
      'peso',
      'hh',
      'galpon',
      'dni',
      'especialidad',
      'cargo',
      'rol'
    ];
    const hasHeader = firstRowNorm.some((h) =>
      headerKeywords.some((kw) => h === kw || h.includes(kw))
    );
    const dataRows = hasHeader ? rawMatrix.slice(1) : rawMatrix;

    const findColIndex = (aliases: string[], fallbackIdx: number) => {
      if (!hasHeader) return fallbackIdx;
      const found = firstRowNorm.findIndex((h) =>
        aliases.some((al) => h === al || h.includes(al))
      );
      return found >= 0 ? found : fallbackIdx;
    };

    const allRows: any[] = [];
    const seenCodesInBatch = new Set<string>();

    if (modalBulkUpload === 'catalogo') {
      const idxTech = findColIndex(['proveedor', 'plantilla', 'tecnologia'], 0);
      const idxCode = findColIndex(['codigo', 'code', 'cod'], 1);
      const idxArea = findColIndex(['area'], 2);
      const idxLoc = findColIndex(['ubicacion', 'locacion', 'tipo'], 3);
      const idxSis = findColIndex(['sistema'], 4);
      const idxStr = findColIndex(['estructura'], 5);
      const idxName = findColIndex(['actividad', 'nombre', 'descripcion'], 6);
      const idxTarget = findColIndex(['meta', 'cantidad', 'objetivo'], 7);
      const idxUnit = findColIndex(['unidad', 'und', 'medida'], 8);
      const idxWeight = findColIndex(['peso', 'ponderacion'], 9);
      const idxHH = findColIndex(['hh', 'horas'], 10);
      const idxMode = findColIndex(['modalidad', 'mode', 'tipo_avance', 'tipoavance', 'metodo_avance', 'metodo'], -1);
      const idxDuration = findColIndex(['duraciondias', 'duracion', 'dias'], -1);

      const existingCodes = new Set(
        getActiveMasterCatalog(masterCatalog).map(c => catalogCodeKey(c.technology, c.code))
      );

      dataRows.forEach((cols, i) => {
        const rowNumber = hasHeader ? i + 2 : i + 1;
        const technology = (cols[idxTech] || '').trim();
        const code = (cols[idxCode] || '').trim().toUpperCase();
        const rawArea = (cols[idxArea] || '').trim();
        const rawLoc = (cols[idxLoc] || '').trim();
        const sistemaName = (cols[idxSis] || '').trim();
        const structureName = (cols[idxStr] || '').trim();
        const name = (cols[idxName] || '').trim();
        const rawTarget = (cols[idxTarget] || '').trim();
        const rawUnit = (cols[idxUnit] || '').trim();
        const rawWeight = (cols[idxWeight] || '').trim();
        const rawHH = (cols[idxHH] || '').trim();
        const rawMode = idxMode >= 0 ? (cols[idxMode] || '').trim().toLowerCase() : '';
        const rawDuration = idxDuration >= 0 ? (cols[idxDuration] || '').trim() : '';
        const durationDays = rawDuration ? Number(rawDuration) : 5;

        // Parsing y normalización de Modalidad (Cantidades vs Porcentaje)
        let progressMode: 'quantity' | 'percentage' = 'quantity';
        let modeInvalid = false;
        if (rawMode) {
          if (
            rawMode.includes('porcent') ||
            rawMode.includes('percent') ||
            rawMode === '%' ||
            rawMode === 'p'
          ) {
            progressMode = 'percentage';
          } else if (
            rawMode.includes('cant') ||
            rawMode.includes('quant') ||
            rawMode.includes('qty') ||
            rawMode === 'c'
          ) {
            progressMode = 'quantity';
          } else {
            modeInvalid = true;
          }
        }

        const matchedArea = ALL_AREAS.find(
          (a) => normalizeHeaderKey(a) === normalizeHeaderKey(rawArea)
        );
        const areaRequiresSistema = matchedArea
          ? AREAS_WITH_SISTEMAS.includes(matchedArea)
          : false;

        const targetUnits = Number(rawTarget);
        const weight = rawWeight !== '' ? Number(rawWeight) : 1.0;
        const plannedHH = rawHH !== '' ? Number(rawHH) : 0;

        const errors: string[] = [];
        if (!technology) errors.push('Falta Proveedor');
        if (!code) errors.push('Falta Código');
        if (!rawArea) {
          errors.push('Falta Área');
        } else if (!matchedArea) {
          errors.push(`Área inválida ("${rawArea}")`);
        }
        if (areaRequiresSistema && !sistemaName) {
          errors.push('Falta Sistema (obligatorio en esta área)');
        }
        if (!structureName) errors.push('Falta Estructura');
        if (!name) errors.push('Falta Nombre de Actividad');
        if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 3650) errors.push('Duración inválida');

        if (modeInvalid) {
          errors.push(`Modalidad inválida ("${cols[idxMode]}"). Debe ser "Cantidades" o "Porcentaje".`);
        }

        if (progressMode === 'percentage') {
          // Modalidad Porcentaje: Meta de referencia es 100% y unidad por defecto es '%'
        } else {
          // Modalidad Cantidades: Requiere meta numérica positiva > 0 y unidad de medida
          if (!rawTarget || isNaN(targetUnits) || targetUnits <= 0) {
            errors.push('Meta debe ser mayor a 0 para avance por Cantidades');
          }
          if (!rawUnit) errors.push('Falta Unidad');
        }

        let status: 'valid' | 'duplicate' | 'rejected' = 'valid';
        let statusReason = progressMode === 'percentage'
          ? 'Fila válida lista para importar (Modalidad: Porcentaje 100%)'
          : 'Fila válida lista para importar (Modalidad: Cantidades)';

        const compositeKey = catalogCodeKey(technology, code);
        if (errors.length > 0) {
          status = 'rejected';
          statusReason = errors.join(' • ');
        } else if (existingCodes.has(compositeKey)) {
          status = 'duplicate';
          statusReason = `Código [${code}] ya existe en el Catálogo Maestro para "${technology}"`;
        } else if (seenCodesInBatch.has(compositeKey)) {
          status = 'duplicate';
          statusReason = `Código [${code}] duplicado dentro del mismo archivo`;
        } else {
          seenCodesInBatch.add(compositeKey);
        }

        const cleanLoc =
          rawLoc.toLowerCase() === 'externo' ? 'Externo' : 'Interno';

        const finalTargetUnits = progressMode === 'percentage' ? 100 : (isNaN(targetUnits) ? 0 : targetUnits);
        const finalUnit = progressMode === 'percentage' ? (rawUnit || '%') : rawUnit;

        allRows.push({
          rowNumber,
          status,
          statusReason,
          payload: {
            id: generateId('cat'),
            technology,
            code,
            areaName: matchedArea || rawArea,
            locationType: areaRequiresSistema ? cleanLoc : 'Interno',
            sistemaName: areaRequiresSistema ? sistemaName : null,
            structureName,
            name,
            progressMode,
            targetUnits: finalTargetUnits,
            unit: finalUnit,
            weight: isNaN(weight) || weight <= 0 ? 1.0 : weight,
            plannedHH: isNaN(plannedHH) || plannedHH < 0 ? 0 : plannedHH,
            durationDays
          }
        });
      });
    } else if (modalBulkUpload === 'materiales') {
      const idxTech = findColIndex(['proveedor', 'plantilla', 'tecnologia'], 0);
      const idxCode = findColIndex(['codigo', 'code', 'cod'], 1);
      const idxName = findColIndex(['material', 'descripcion', 'nombre'], 2);
      const idxArea = findColIndex(['area'], 3);
      const idxSis = findColIndex(['sistema'], 4);
      const idxStr = findColIndex(['estructura'], 5);
      const idxQty = findColIndex(['cantidad', 'total', 'stock', 'meta'], 6);
      const idxUnit = findColIndex(['unidad', 'und', 'medida'], 7);
      const idxGalpon = findColIndex(['galpon', 'destino'], 8);

      dataRows.forEach((cols, i) => {
        const rowNumber = hasHeader ? i + 2 : i + 1;
        const technology = (cols[idxTech] || '').trim();
        const code = (cols[idxCode] || '').trim().toUpperCase();
        const name = (cols[idxName] || '').trim();
        const rawArea = (cols[idxArea] || '').trim();
        const sistemaName = (cols[idxSis] || '').trim();
        const structureName = (cols[idxStr] || '').trim();
        const rawQty = (cols[idxQty] || '').trim();
        const unit = (cols[idxUnit] || '').trim();
        const rawGalponCol = (cols[idxGalpon] || '').trim();

        const matchedArea = ALL_AREAS.find(
          (a) => normalizeHeaderKey(a) === normalizeHeaderKey(rawArea)
        );
        const areaRequiresSistema = matchedArea
          ? AREAS_WITH_SISTEMAS.includes(matchedArea)
          : false;
        const totalQty = Number(rawQty);

        // Identificar Galpón destino (por columna del archivo o por selector explícito en el modal)
        let targetGalObj: any = null;
        const errors: string[] = [];

        if (rawGalponCol) {
          targetGalObj = allGalponesList.find(
            (g) =>
              g.id === rawGalponCol ||
              g.code.toLowerCase() === rawGalponCol.toLowerCase() ||
              g.name.toLowerCase() === rawGalponCol.toLowerCase()
          );
          if (!targetGalObj) {
            errors.push(`Galpón destino "${rawGalponCol}" no existe`);
          }
        } else if (bulkTargetGalponId) {
          targetGalObj = allGalponesList.find((g) => g.id === bulkTargetGalponId);
          if (!targetGalObj) {
            errors.push('Galpón destino seleccionado no válido');
          }
        } else {
          errors.push('Falta Galpón destino (indíquelo en columna o selecciónelo arriba)');
        }

        if (!technology) errors.push('Falta Proveedor');
        if (!code) errors.push('Falta Código de Material');
        if (!name) errors.push('Falta Nombre de Material');
        if (!rawArea) {
          errors.push('Falta Área');
        } else if (!matchedArea) {
          errors.push(`Área inválida ("${rawArea}")`);
        }
        if (areaRequiresSistema && !sistemaName) {
          errors.push('Falta Sistema (obligatorio en esta área)');
        }
        if (!structureName) errors.push('Falta Estructura');
        if (!rawQty || isNaN(totalQty) || totalQty <= 0) {
          errors.push('Cantidad Total debe ser mayor a 0');
        }
        if (!unit) errors.push('Falta Unidad');

        // Verificar que la relación Área -> Sistema -> Estructura exista realmente en el galpón destino o en el Catálogo Maestro (sin inventar estructuras)
        let resolvedAreaId = '';
        let resolvedSistemaId = '';
        let resolvedStructureId = '';
        let resolvedLocType = 'Interno';

        if (targetGalObj && matchedArea && structureName) {
          const areaObj = (targetGalObj.areas || []).find(
            (a: any) => a.name === matchedArea
          );
          if (areaObj) {
            resolvedAreaId = areaObj.id || '';
            if (areaRequiresSistema) {
              const sisObj = (areaObj.sistemas || []).find(
                (s: any) =>
                  normalizeHeaderKey(s.name || '') ===
                  normalizeHeaderKey(sistemaName)
              );
              if (sisObj) {
                resolvedSistemaId = sisObj.id || '';
                resolvedLocType = sisObj.locationType || 'Interno';
                const strObj = (sisObj.structures || []).find(
                  (st: any) =>
                    normalizeHeaderKey(st.name || '') ===
                    normalizeHeaderKey(structureName)
                );
                if (strObj) {
                  resolvedStructureId = strObj.id || '';
                } else {
                  errors.push(
                    `La estructura "${structureName}" no existe en el sistema "${sistemaName}" del galpón ${targetGalObj.code}`
                  );
                }
              } else {
                errors.push(
                  `El sistema "${sistemaName}" no existe en el área "${matchedArea}" del galpón ${targetGalObj.code}`
                );
              }
            } else {
              const strObj = (areaObj.structures || []).find(
                (st: any) =>
                  normalizeHeaderKey(st.name || '') ===
                  normalizeHeaderKey(structureName)
              );
              if (strObj) {
                resolvedStructureId = strObj.id || '';
              } else {
                errors.push(
                  `La estructura "${structureName}" no existe en el área "${matchedArea}" del galpón ${targetGalObj.code}`
                );
              }
            }
          } else {
            errors.push(
              `El área "${matchedArea}" no existe en el galpón ${targetGalObj.code}`
            );
          }
        }

        const existingMatKey = `${targetGalObj?.id || ''}::${code}`;
        const alreadyExistsInGalpon = materials.some(
          (m) =>
            (m.galponId || '') === (targetGalObj?.id || '') &&
            (m.code || '').toUpperCase() === code
        );

        let status: 'valid' | 'duplicate' | 'rejected' = 'valid';
        let statusReason = `Válido → ${targetGalObj?.sectorName || ''} • ${targetGalObj?.code || ''}`;

        if (errors.length > 0) {
          status = 'rejected';
          statusReason = errors.join(' • ');
        } else if (alreadyExistsInGalpon) {
          status = 'duplicate';
          statusReason = `Código [${code}] ya está registrado en el galpón ${targetGalObj?.code || ''}`;
        } else if (seenCodesInBatch.has(existingMatKey)) {
          status = 'duplicate';
          statusReason = `Código [${code}] duplicado dentro del archivo para el mismo galpón`;
        } else {
          seenCodesInBatch.add(existingMatKey);
        }

        allRows.push({
          rowNumber,
          status,
          statusReason,
          galponLabel: targetGalObj
            ? `${targetGalObj.sectorName} • ${targetGalObj.code}`
            : 'Sin identificar',
          payload: {
            id: generateId('mat'),
            sectorId: targetGalObj?.sectorId || '',
            galponId: targetGalObj?.id || '',
            technology,
            code,
            name,
            areaId: resolvedAreaId,
            areaName: matchedArea || rawArea,
            locationType: resolvedLocType,
            sistemaId: resolvedSistemaId,
            sistemaName: areaRequiresSistema ? sistemaName : null,
            structureId: resolvedStructureId,
            structureName,
            totalQty: isNaN(totalQty) ? 0 : totalQty,
            usedQty: 0,
            unit
          }
        });
      });
    } else if (modalBulkUpload === 'personal') {
      const idxCode = findColIndex(['codigo', 'code', 'cod'], 0);
      const idxDni = findColIndex(['dni', 'documento', 'cedula'], 1);
      const idxName = findColIndex(['nombre', 'operario', 'trabajador'], 2);
      const idxArea = findColIndex(['especialidad', 'area'], 3);
      const idxRole = findColIndex(['cargo', 'rol', 'puesto'], 4);
      const idxGalpon = findColIndex(['galpon', 'destino'], 5);

      const existingWorkerCodes = new Set(
        masterWorkforce.map((w) => normalizeWorkerCode(w.workerCode))
      );

      dataRows.forEach((cols, i) => {
        const rowNumber = hasHeader ? i + 2 : i + 1;
        const workerCode = normalizeWorkerCode(cols[idxCode]);
        const dni = (cols[idxDni] || '').trim();
        const name = (cols[idxName] || '').trim();
        const workArea = (cols[idxArea] || '').trim();
        const role = (cols[idxRole] || '').trim();
        const rawGalponCol = (cols[idxGalpon] || '').trim();

        let targetGalObj: any = null;
        if (rawGalponCol) {
          targetGalObj = allGalponesList.find(
            (g) =>
              g.id === rawGalponCol ||
              g.code.toLowerCase() === rawGalponCol.toLowerCase()
          );
        } else if (bulkTargetGalponId) {
          targetGalObj = allGalponesList.find((g) => g.id === bulkTargetGalponId);
        }

        const errors: string[] = [];
        if (!workerCode) errors.push('Falta Código de Operario');
        if (!name) errors.push('Falta Nombre Completo');
        if (!workArea) errors.push('Falta Especialidad');
        if (!role) errors.push('Falta Cargo');
        const invalid = invalidWorkerField({ workerCode, dni, name, workArea, role }, true);
        if (invalid && errors.length === 0) errors.push(`Campo ${invalid} inválido`);
        if (rawGalponCol && !targetGalObj) {
          errors.push(`Galpón "${rawGalponCol}" no existe`);
        }

        let status: 'valid' | 'duplicate' | 'rejected' = 'valid';
        let statusReason = targetGalObj
          ? `Válido → ${targetGalObj.sectorName} • ${targetGalObj.code}`
          : 'Válido (Sin galpón asignado)';

        if (errors.length > 0) {
          status = 'rejected';
          statusReason = errors.join(' • ');
        } else if (existingWorkerCodes.has(workerCode)) {
          status = 'duplicate';
          statusReason = `Código [${workerCode}] ya existe en la Planilla de Personal`;
        } else if (seenCodesInBatch.has(workerCode)) {
          status = 'duplicate';
          statusReason = `Código [${workerCode}] duplicado dentro del archivo`;
        } else {
          seenCodesInBatch.add(workerCode);
        }

        allRows.push({
          rowNumber,
          status,
          statusReason,
          payload: {
            id: generateId('w'),
            workerCode,
            dni,
            name,
            workArea,
            role,
            sectorId: targetGalObj?.sectorId || '',
            galponId: targetGalObj?.id || '',
            active: true
          }
        });
      });
    }

    return {
      allRows,
      validRows: allRows.filter((r) => r.status === 'valid'),
      duplicateRows: allRows.filter((r) => r.status === 'duplicate'),
      rejectedRows: allRows.filter((r) => r.status === 'rejected')
    };
  }, [
    modalBulkUpload,
    bulkRawRows,
    bulkCsvText,
    bulkTargetGalponId,
    masterCatalog,
    materials,
    masterWorkforce,
    allGalponesList
  ]);

  const handleConfirmBulkUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalBulkUpload || queuingPersonalImport) return;
    if (!requirePermission(modalBulkUpload, 'import')) return;
    const validPayloads = bulkImportAnalysis.validRows.map((r) => r.payload);
    if (validPayloads.length === 0) return;

    if (modalBulkUpload === 'catalogo') {
      const newTechs = new Set(technologies);
      validPayloads.forEach((item) => {
        if (item.technology) newTechs.add(item.technology);
      });
      if (canDo('catalogo', 'create')) setTechnologies(Array.from(newTechs));
      setMasterCatalog((prev) => [...prev, ...validPayloads]);
    } else if (modalBulkUpload === 'materiales') {
      const newTechs = new Set(technologies);
      validPayloads.forEach((mat) => {
        if (mat.technology) newTechs.add(mat.technology);
      });
      if (canDo('catalogo', 'create')) setTechnologies(Array.from(newTechs));
      setMaterials((prev) => [...prev, ...validPayloads]);
    } else if (modalBulkUpload === 'personal') {
      setQueuingPersonalImport(true);
      const writeGroupId = crypto.randomUUID();
      const queued = await queueOperationLocally(bulkImportAnalysis.validRows.map(({ payload, rowNumber }) => ({
        collectionName: 'workers', documentId: payload.id, operationType: 'upsert',
        writeGroupId, payload, sourceRow: rowNumber, status: 'pending_sync'
      })));
      setQueuingPersonalImport(false);
      if (!queued) {
        setBulkFileError('No se pudo guardar el lote en la cola. Vuelva a intentar.');
        return;
      }
      setPermissionNotice('Importación de Personal guardada en la cola. Consulte su confirmación en el Centro de Sincronización.');
    }

    resetBulkUploadState();
  };

  // ==========================================================================
  // EXPORTACIONES CSV COMPATIBLES CON EXCEL (UTF-8 BOM + BLOB - C-8)
  // ==========================================================================
  // ==========================================================================
  // INFORMES GLOBALES: SELECTOR UNIFICADO, FILTROS Y EXPORTACIÓN COMPATIBLE
  // Utiliza el mismo evaluador oficial de avances (evaluateActivityProgress)
  // que el Dashboard y el Gantt, garantizando paridad matemática exacta.
  // ==========================================================================

  interface GlobalReportRowItem {
    id: string;
    projectName: string;
    sectorId: string;
    sectorName: string;
    galponId: string;
    galponCode: string;
    galponName: string;
    technology: string;
    areaName: string;
    locationType: string;
    sistemaName: string;
    structureName: string;
    activityId: string;
    activityCode: string;
    activityName: string;
    progressMode: 'quantity' | 'percentage';
    progressModeLabel: string;
    targetUnits: number;
    unit: string;
    weight: number;
    accumulatedQty: number;
    progressPercent: number;
    plannedHH: number;
    accumulatedHH: number;
    computedStatus: 'Completado' | 'En proceso' | 'No iniciado' | 'Atrasado';
  }

  const allGlobalReportRows = useMemo<GlobalReportRowItem[]>(() => {
    const list: GlobalReportRowItem[] = [];
    const today = getSystemToday();

    sectors.forEach((sec) => {
      (sec.galpones || []).forEach((gal: any) => {
        (gal.areas || []).forEach((area: any) => {
          const pushRow = (
            sisName: string,
            locType: string,
            strName: string,
            act: any
          ) => {
            const logs = activityAdvances(gal.id, act.id, act.code);
            const evaluated = evaluateActivityProgress(act, logs, today);
            const isPct = evaluated.progressMode === 'percentage';
            const computedStatus = evaluated.progressPercent >= 100 ? 'Completado'
              : act.dueDate && act.dueDate < today ? 'Atrasado'
              : evaluated.progressPercent > 0 ? 'En proceso' : 'No iniciado';
            list.push({
              id: `${gal.id}_${act.id || act.code}_${list.length}`,
              projectName: gal.projectCode || sec.projectName || sec.code || sec.name || 'Proyecto La Calera',
              sectorId: sec.id,
              sectorName: sec.name || '',
              galponId: gal.id,
              galponCode: gal.code || '',
              galponName: gal.name || '',
              technology: gal.technology || 'Sin proveedor',
              areaName: area.name || '',
              locationType: locType || 'Interno',
              sistemaName: sisName || '-',
              structureName: strName || '',
              activityId: act.id,
              activityCode: act.code || '',
              activityName: act.name || '',
              progressMode: evaluated.progressMode,
              progressModeLabel: isPct ? 'Porcentaje' : 'Cantidades',
              targetUnits: isPct ? 100 : (act.targetUnits ?? 0),
              unit: isPct ? '%' : (act.unit || ''),
              weight: act.weight ?? 1,
              accumulatedQty: evaluated.accumulatedQty,
              progressPercent: evaluated.progressPercent,
              plannedHH: act.plannedHH || 0,
              accumulatedHH: evaluated.accumulatedHH,
              computedStatus
            });
          };

          if (area.hasSistemas && area.sistemas) {
            area.sistemas.forEach((sis: any) => {
              (sis.structures || []).forEach((str: any) => {
                (str.activities || []).forEach((act: any) =>
                  pushRow(
                    sis.name,
                    act.locationType || sis.locationType || 'Interno',
                    str.name,
                    act
                  )
                );
              });
            });
          } else {
            (area.structures || []).forEach((str: any) => {
              (str.activities || []).forEach((act: any) =>
                pushRow('-', 'Interno', str.name, act)
              );
            });
          }
        });
      });
    });

    return list;
  }, [sectors, activityAdvances]);

  const uniqueInformesAreas = useMemo(() => {
    const set = new Set<string>();
    allGlobalReportRows.forEach((r) => {
      if (r.areaName) set.add(r.areaName);
    });
    return Array.from(set).sort();
  }, [allGlobalReportRows]);

  const uniqueInformesSistemas = useMemo(() => {
    const set = new Set<string>();
    allGlobalReportRows.forEach((r) => {
      if (r.sistemaName && r.sistemaName !== '-') set.add(r.sistemaName);
    });
    return Array.from(set).sort();
  }, [allGlobalReportRows]);

  const informesGalponesOptions = useMemo(() => {
    if (filterInformesSectorId === 'ALL') {
      const list: any[] = [];
      sectors.forEach((s) => {
        (s.galpones || []).forEach((g: any) => {
          list.push({ ...g, sectorName: s.name });
        });
      });
      return list;
    }
    const sec = sectors.find((s) => s.id === filterInformesSectorId);
    return sec ? (sec.galpones || []).map((g: any) => ({ ...g, sectorName: sec.name })) : [];
  }, [sectors, filterInformesSectorId]);

  const [filterInformesProject, setFilterInformesProject] = useState('ALL');
  const filteredGlobalReportRows = useMemo(() => {
    return allGlobalReportRows.filter((row) => {
      if (filterInformesProject !== 'ALL' && row.projectName !== filterInformesProject) return false;
      if (filterInformesSectorId !== 'ALL' && row.sectorId !== filterInformesSectorId) {
        return false;
      }
      if (filterInformesGalponId !== 'ALL' && row.galponId !== filterInformesGalponId) {
        return false;
      }
      if (filterInformesAreaName !== 'ALL' && row.areaName !== filterInformesAreaName) {
        return false;
      }
      if (filterInformesSistemaName !== 'ALL' && row.sistemaName !== filterInformesSistemaName) {
        return false;
      }
      if (filterInformesMode !== 'ALL' && row.progressMode !== filterInformesMode) {
        return false;
      }
      if (filterInformesStatus !== 'ALL') {
        const statusNorm = row.computedStatus.toLowerCase();
        const filterNorm = filterInformesStatus.toLowerCase();
        if (filterNorm === 'completado' || filterNorm === 'completada') {
          if (!statusNorm.includes('completa')) return false;
        } else if (filterNorm === 'en proceso') {
          if (!statusNorm.includes('proceso')) return false;
        } else if (filterNorm === 'no iniciado' || filterNorm === 'pendiente') {
          if (!statusNorm.includes('pendiente') && !statusNorm.includes('no iniciad')) return false;
        } else if (filterNorm === 'atrasado' || filterNorm === 'alerta') {
          if (!statusNorm.includes('alerta') && !statusNorm.includes('atrasad')) return false;
        } else if (row.computedStatus !== filterInformesStatus) {
          return false;
        }
      }
      if (searchInformesText.trim()) {
        const query = searchInformesText.trim().toLowerCase();
        const matches =
          row.activityCode.toLowerCase().includes(query) ||
          row.activityName.toLowerCase().includes(query) ||
          row.sectorName.toLowerCase().includes(query) ||
          row.galponCode.toLowerCase().includes(query) ||
          row.structureName.toLowerCase().includes(query) ||
          row.sistemaName.toLowerCase().includes(query) ||
          row.technology.toLowerCase().includes(query);
        if (!matches) return false;
      }
      return true;
    });
  }, [
    allGlobalReportRows,
    filterInformesProject,
    filterInformesSectorId,
    filterInformesGalponId,
    filterInformesAreaName,
    filterInformesSistemaName,
    filterInformesMode,
    filterInformesStatus,
    searchInformesText
  ]);

  const fieldRows = useMemo(() => fieldReport(sectors, filteredGlobalReportRows, materials, masterWorkforce,
    attendanceRecords[attendanceDate] ?? {}, {
      project: filterInformesProject, sector: filterInformesSectorId, galpon: filterInformesGalponId,
      activityFiltered: filterInformesAreaName !== 'ALL' || filterInformesSistemaName !== 'ALL' ||
        filterInformesMode !== 'ALL' || filterInformesStatus !== 'ALL' || Boolean(searchInformesText.trim())
    }), [sectors, filteredGlobalReportRows, materials, masterWorkforce, attendanceRecords, attendanceDate,
    filterInformesProject, filterInformesSectorId, filterInformesGalponId, filterInformesAreaName, filterInformesSistemaName,
    filterInformesMode, filterInformesStatus, searchInformesText]);
  const fieldHeaders = ['Proyecto', 'Sector', 'Galpón', 'Actividades', 'Personal', 'Asistieron', 'Registrados', 'Materiales', 'Sin stock'];
  const fieldValues = (row: typeof fieldRows[number]) => [row.project, row.sector, row.galpon, row.activities, row.personnel,
    row.present, row.registered, row.materials, row.outOfStock];

  const informesMetrics = useMemo(() => {
    const total = filteredGlobalReportRows.length;
    const completed = filteredGlobalReportRows.filter((r) =>
      r.computedStatus.toLowerCase().includes('completa')
    ).length;
    const inProgress = filteredGlobalReportRows.filter((r) =>
      r.computedStatus.toLowerCase().includes('proceso')
    ).length;
    const notStarted = filteredGlobalReportRows.filter(
      (r) =>
        r.computedStatus.toLowerCase().includes('pendiente') ||
        (r.computedStatus.toLowerCase().includes('no iniciad') && !r.computedStatus.includes('Alerta'))
    ).length;
    const delayed = filteredGlobalReportRows.filter(
      (r) =>
        r.computedStatus.toLowerCase().includes('alerta') ||
        r.computedStatus.toLowerCase().includes('atrasad')
    ).length;
    const totalWeight = filteredGlobalReportRows.reduce((acc, r) => acc + (r.weight || 1), 0);
    const weightedProgress =
      totalWeight > 0
        ? filteredGlobalReportRows.reduce((acc, r) => acc + r.progressPercent * (r.weight || 1), 0) /
          totalWeight
        : 0;
    const plannedHH = filteredGlobalReportRows.reduce((acc, r) => acc + (r.plannedHH || 0), 0);
    const accumulatedHH = filteredGlobalReportRows.reduce((acc, r) => acc + (r.accumulatedHH || 0), 0);

    return {
      total,
      completed,
      inProgress,
      notStarted,
      delayed,
      weightedProgress: Number(weightedProgress.toFixed(1)),
      plannedHH: Number(plannedHH.toFixed(1)),
      accumulatedHH: Number(accumulatedHH.toFixed(1))
    };
  }, [filteredGlobalReportRows]);

  const paginatedInformesRows = useMemo(() => {
    if (informesPageSize <= 0) return filteredGlobalReportRows;
    const start = (informesPage - 1) * informesPageSize;
    return filteredGlobalReportRows.slice(start, start + informesPageSize);
  }, [filteredGlobalReportRows, informesPage, informesPageSize]);

  const totalInformesPages = useMemo(() => {
    if (informesPageSize <= 0 || filteredGlobalReportRows.length === 0) return 1;
    return Math.ceil(filteredGlobalReportRows.length / informesPageSize);
  }, [filteredGlobalReportRows.length, informesPageSize]);

  const handleExportGlobalCSV = (exportFiltered: boolean = false) => {
    if (!requirePermission('informes', 'export')) return;
    const headers = [
      'Proyecto',
      'Sector',
      'Galpón',
      'Proveedor',
      'Área',
      'Ubicación',
      'Sistema',
      'Estructura',
      'Código',
      'Actividad',
      'Modalidad',
      'Meta',
      'Unidad',
      'Peso',
      'Ejecutado',
      'Avance %',
      'HH Plan',
      'HH Ejec',
      'Estado'
    ];
    const sourceRows = exportFiltered ? filteredGlobalReportRows : allGlobalReportRows;
    const rows: (string | number)[][] = sourceRows.map((r) => [
      r.projectName,
      r.sectorName,
      r.galponCode,
      r.technology,
      r.areaName,
      r.locationType,
      r.sistemaName,
      r.structureName,
      r.activityCode,
      r.activityName,
      r.progressMode === 'percentage' ? 'Porcentaje (0%-100%)' : 'Cantidades',
      r.targetUnits,
      r.unit,
      r.weight,
      r.accumulatedQty,
      `${r.progressPercent}%`,
      r.plannedHH,
      r.accumulatedHH,
      r.computedStatus
    ]);

    const prefix = exportFiltered ? 'Reporte_Global_Filtrado' : 'Reporte_Global_Galpones';
    downloadCsvFile(
      `${prefix}_${getSystemToday()}.csv`,
      headers,
      rows
    );
  };

  const handleExportGlobalXLSX = async (exportFiltered: boolean = false) => {
    if (!requirePermission('informes', 'export')) return;
    const headers = [
      'Proyecto',
      'Sector',
      'Galpón',
      'Proveedor',
      'Área',
      'Ubicación',
      'Sistema',
      'Estructura',
      'Código',
      'Actividad',
      'Modalidad',
      'Meta',
      'Unidad',
      'Peso',
      'Ejecutado',
      'Avance %',
      'HH Plan',
      'HH Ejec',
      'Estado'
    ];
    const sourceRows = exportFiltered ? filteredGlobalReportRows : allGlobalReportRows;
    const rows: (string | number)[][] = sourceRows.map((r) => [
      r.projectName,
      r.sectorName,
      r.galponCode,
      r.technology,
      r.areaName,
      r.locationType,
      r.sistemaName,
      r.structureName,
      r.activityCode,
      r.activityName,
      r.progressMode === 'percentage' ? 'Porcentaje (0%-100%)' : 'Cantidades',
      r.targetUnits,
      r.unit,
      r.weight,
      r.accumulatedQty,
      r.progressPercent,
      r.plannedHH,
      r.accumulatedHH,
      r.computedStatus
    ]);

    const XLSX = await import('xlsx');
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Informe Global');
    const prefix = exportFiltered ? 'Reporte_Global_Filtrado' : 'Reporte_Global_Galpones';
    XLSX.writeFile(workbook, `${prefix}_${getSystemToday()}.xlsx`);
  };

  const handleExportMaterialsCSV = () => {
    if (!requirePermission('materiales', 'export')) return;
    const headers = [
      'Sector',
      'Galpón',
      'Proveedor',
      'Código',
      'Material',
      'Área',
      'Sistema',
      'Estructura',
      'Stock Inicial',
      'Consumido',
      'Disponible',
      'Unidad',
      'Estado'
    ];
    const visibleMaterials = materials.filter((m) => {
      if (filterMaterialGalpon !== 'Todos') {
        if (filterMaterialGalpon === '__UNASSIGNED__') {
          if (m.galponId) return false;
        } else if (m.galponId !== filterMaterialGalpon) {
          return false;
        }
      }
      if (filterMaterialTech !== 'Todas' && m.technology !== filterMaterialTech) {
        return false;
      }
      if (filterMaterialArea !== 'Todas' && m.areaName !== filterMaterialArea) {
        return false;
      }
      if (searchMaterialText.trim()) {
        const q = searchMaterialText.toLowerCase().trim();
        const galObj = allGalponesList.find((g) => g.id === m.galponId);
        const galLabel = galObj
          ? `${galObj.code} ${galObj.name} ${galObj.sectorName}`.toLowerCase()
          : 'sin galpón asignado';
        const matches =
          (m.code || '').toLowerCase().includes(q) ||
          (m.name || '').toLowerCase().includes(q) ||
          (m.structureName || '').toLowerCase().includes(q) ||
          (m.sistemaName || '').toLowerCase().includes(q) ||
          (m.areaName || '').toLowerCase().includes(q) ||
          (m.technology || '').toLowerCase().includes(q) ||
          galLabel.includes(q);
        if (!matches) return false;
      }
      return true;
    });

    const rows = visibleMaterials.map((m: any) => {
      const galInfo = m.galponId
        ? allGalponesList.find((g) => g.id === m.galponId)
        : null;
      const total = Number(m.totalQty) || 0;
      const used = usedMaterialQuantity(m);
      const avail = Math.max(0, Math.round((total - used) * 100) / 100);
      const status =
        total > 0 && avail / total <= 0.15
          ? 'Stock Crítico'
          : avail === 0 && total > 0
            ? 'Agotado'
            : 'Disponible';
      return [
        galInfo?.sectorName || 'Sin sector asignado',
        galInfo ? `${galInfo.code} - ${galInfo.name}` : 'Sin galpón asignado',
        m.technology || 'Sin proveedor',
        m.code || '',
        m.name || '',
        m.areaName || 'Sin área',
        m.sistemaName || '-',
        m.structureName || 'Sin estructura',
        total,
        used,
        avail,
        m.unit || '',
        status
      ];
    });

    downloadCsvFile(
      `Inventario_Materiales_${getSystemToday()}.csv`,
      headers,
      rows
    );
  };

  const handleExportAttendanceCSV = () => {
    if (!requirePermission('asistencia', 'export')) return;
    const headers = [
      'Fecha',
      'Código Operario',
      'DNI',
      'Nombre Completo',
      'Especialidad',
      'Cargo',
      'Sector Asignado',
      'Galpón Asignado',
      'Estado Asistencia'
    ];
    const dayMap = attendanceRecords[attendanceDate] || {};
    const rows = filteredAttendanceWorkers.map((w: any) => {
      const secObj = sectors.find((s) => s.id === w.sectorId);
      const galObj = allGalponesList.find((g) => g.id === w.galponId);
      const status = dayMap[w.id] || 'Sin marcar';
      return [
        attendanceDate,
        w.workerCode || '',
        w.dni || '',
        w.name || '',
        w.workArea || 'Sin asignar',
        w.role || 'Sin asignar',
        secObj?.name || 'Sin sector asignado',
        galObj ? `${galObj.code} - ${galObj.name}` : 'Sin galpón asignado',
        status
      ];
    });

    downloadCsvFile(
      `Control_Asistencia_${attendanceDate || getSystemToday()}.csv`,
      headers,
      rows
    );
  };

  const [movementImport, setMovementImport] = useState({ busy: false, message: '' });
  const handleImportMovements = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !requirePermission('movimientos', 'import')) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setMovementImport({ busy: false, message: 'El archivo supera el límite de 2 MB.' });
      return;
    }
    const session = bindOperationalData(profile);
    setMovementImport({ busy: true, message: '' });
    try {
      const entries = await readMovementFile(file);
      await importHistoricalMovements(session, entries);
      setMovementImport({ busy: false, message: 'Archivo confirmado. La bitácora se actualizará automáticamente.' });
    } catch (error) {
      setMovementImport({ busy: false, message: error instanceof Error ? error.message : 'No se pudo confirmar la importación.' });
    }
  };

  const handleExportMovementsCSV = () => {
    if (!requirePermission('movimientos', 'export')) return;
    const headers = [
      'ID',
      'Fecha y Hora',
      'Usuario',
      'Tipo de Movimiento',
      'Módulo',
      'Detalle del Movimiento',
      'Proyecto', 'Sector', 'Galpón', 'Recurso', 'Operación'
    ];
    const rows = visibleMovements.map(log => [
      log.id,
      log.timestamp || '',
      log.user || '',
      log.action || '',
      log.module || '',
      log.description || '',
      log.projectCode, log.sectorId, log.galponId, log.targetId, log.requestId
    ]);

    downloadCsvFile(
      `Historial_Movimientos_${getSystemToday()}.csv`,
      headers,
      rows
    );
  };

  // Listas dinámicas en cascada para el Modal de Avance Diario
  const cascadeAdvancesList = useMemo(() => {
    return evaluatedActivities.filter((a) => {
      if (formAdvance.areaName && a.areaName !== formAdvance.areaName) return false;
      if (
        formAdvance.locationType !== 'Todos' &&
        a.locationType !== formAdvance.locationType
      )
        return false;
      if (formAdvance.sistemaName && a.sistemaName !== formAdvance.sistemaName)
        return false;
      if (formAdvance.structureName && a.structureName !== formAdvance.structureName)
        return false;
      return true;
    });
  }, [evaluatedActivities, formAdvance]);

  const selectedAdvanceActivityObj = useMemo(() => {
    return findAdvanceActivity(evaluatedActivities, formAdvance.activityId) ?? null;
  }, [evaluatedActivities, formAdvance.activityId]);

  const adminSidebarModules: Array<{
    id: AppModuleId;
    tab: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'proyectos', tab: 'proyectos', label: 'Proyectos y Galpones', icon: Building2 },
    { id: 'catalogo', tab: 'catalogo', label: 'Catálogo Maestro y Plantillas', icon: BookOpen },
    { id: 'actividades', tab: 'actividades', label: 'Gestión de Actividades', icon: Table },
    { id: 'materiales', tab: 'materiales', label: 'Control de Materiales', icon: Package },
    { id: 'personal', tab: 'personal', label: 'Planilla de Personal', icon: Users },
    { id: 'informes', tab: 'informes', label: 'Informes Globales', icon: FileSpreadsheet },
    { id: 'movimientos', tab: 'movimientos', label: 'Historial de Movimientos', icon: ClipboardList }
  ];

  const renderGalponHorizontalTabs = (testIdPrefix: string) => {
    if (!currentSector) {
      return (
        <span className="text-xs text-emerald-200 italic py-1">
          Seleccione un sector para ver sus galpones
        </span>
      );
    }

    const sectorGalpones = Array.isArray(currentSector.galpones)
      ? currentSector.galpones
      : [];

    return (
      <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 min-w-0 max-w-full">
        {sectorGalpones.length === 0 ? (
          <span className="text-xs text-emerald-200 italic whitespace-nowrap">
            Sin galpones en este sector
          </span>
        ) : (
          sectorGalpones.map((gal: any) => {
            const isSelected = currentGalpon?.id === gal.id;
            return (
              <button
                key={gal.id}
                type="button"
                data-testid={`${testIdPrefix}-${gal.code || gal.id}`}
                onClick={() => setSelectedGalponId(gal.id)}
                title={`${gal.code} - ${gal.name}${gal.technology ? ` (${gal.technology})` : ''}`}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition whitespace-nowrap shrink-0 cursor-pointer border ${
                  isSelected
                    ? 'bg-white text-[#0f6b38] border-white shadow-xs ring-2 ring-white/40'
                    : 'bg-emerald-900/75 hover:bg-emerald-800 text-emerald-50 border-emerald-600/50'
                }`}
              >
                {gal.code || gal.name}
              </button>
            );
          })
        )}

        {canDo('proyectos', 'create') && (
          <button
            type="button"
            data-testid={`${testIdPrefix}-add-galpon`}
            onClick={() => {
              if (!currentSector) return;
              setFormGalpon({
                id: '',
                sectorId: currentSector.id,
                code: '',
                name: '',
                description: '',
                responsible: '',
                startDate: '',
                endDate: '',
                technology: ''
              });
              setModalNewGalpon(true);
            }}
            title="Agregar Galpón"
            aria-label="Agregar Galpón"
            className="px-2 py-1 rounded-lg bg-emerald-800/90 hover:bg-amber-400 hover:text-slate-950 text-emerald-100 border border-emerald-500/50 text-xs font-bold transition shrink-0 cursor-pointer flex items-center justify-center"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 font-sans flex flex-col antialiased selection:bg-emerald-100 selection:text-emerald-900">
      {/* ==================================================================== */}
      {/* 1. BARRA LATERAL DESPLEGABLE (DRAWER OVERLAY EN PC Y MÓVIL)          */}
      {/*    Oculta por defecto; contiene únicamente los 7 módulos admin       */}
      {/* ==================================================================== */}
      <div
        data-testid="sidebar-backdrop-overlay"
        aria-hidden={!sidebarOpen}
        onClick={() => setSidebarOpen(false)}
        className={`fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs transition-opacity duration-300 ${
          sidebarOpen
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none'
        }`}
      />

      <aside
        data-testid="app-sidebar"
        aria-hidden={!sidebarOpen}
        className={`fixed top-0 bottom-0 left-0 z-50 w-72 bg-white border-r border-slate-200 shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Encabezado de Barra Lateral */}
        <div className="px-4 py-3.5 bg-white border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-[#0f6b38] flex items-center justify-center shrink-0">
              <GalponLogoIcon variant="inline" size="sm" className="text-white" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs font-extrabold text-slate-900 tracking-tight truncate">
                Control Galpones La Calera
              </h2>
              <p className="text-[10px] font-medium text-slate-500 truncate">
                Administración
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Cerrar menú lateral"
            data-testid="btn-close-sidebar"
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition cursor-pointer shrink-0"
            title="Cerrar menú"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Lista de los 7 Módulos Administrativos (Sin Dashboard, Gantt, Avance ni Asistencia) */}
        <nav
          data-testid="sidebar-admin-nav"
          className="flex-1 overflow-y-auto px-3 py-3 space-y-1 text-xs"
        >
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-2.5 pb-1.5">
            Módulos Administrativos
          </div>

          {adminSidebarModules
            .filter((mod) => canDo(mod.id, 'view'))
            .map((mod) => {
              const IconComp = mod.icon;
              const isActive = currentTab === mod.tab;
              return (
                <button
                  key={mod.id}
                  type="button"
                  data-testid={`sidebar-link-${mod.tab}`}
                  onClick={() => {
                    setCurrentTab(mod.tab as any);
                    setSidebarOpen(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition cursor-pointer ${
                    isActive
                      ? 'bg-emerald-50 text-[#0f6b38] font-bold border border-emerald-200/80 shadow-2xs'
                      : 'text-slate-700 hover:bg-slate-100 font-medium'
                  }`}
                >
                  <IconComp
                    className={`w-4 h-4 shrink-0 ${
                      isActive ? 'text-[#0f6b38]' : 'text-slate-500'
                    }`}
                  />
                  <span className="truncate leading-snug">{mod.label}</span>
                </button>
              );
            })}
        </nav>

        {/* Bloque Inferior de Usuario, Rol y Controles de Sesión */}
        {profile && (
          <div
            data-testid="sidebar-user-card"
            className="px-3.5 py-3 bg-slate-50/80 border-t border-slate-200 text-xs space-y-2"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-emerald-100 text-[#0f6b38] flex items-center justify-center shrink-0 font-bold text-xs">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  data-testid="sidebar-user-name"
                  className="font-bold text-slate-900 truncate leading-tight"
                >
                  {profile.displayName}
                </div>
                <div
                  data-testid="sidebar-user-role"
                  className="text-[11px] font-medium text-[#0f6b38] truncate"
                >
                  {profile.role}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 pt-0.5">
              {canManageUsers && (
                <button
                  type="button"
                  onClick={() => {
                    setSidebarOpen(false);
                    openUserAdminModal();
                  }}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 font-semibold text-[11px] border border-slate-200 transition cursor-pointer"
                >
                  <Users className="w-3.5 h-3.5 text-[#0f6b38]" />
                  <span>Usuarios</span>
                </button>
              )}
              <button
                type="button"
                data-testid="sidebar-btn-logout"
                onClick={logout}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white hover:bg-rose-50 text-slate-700 hover:text-rose-700 font-semibold text-[11px] border border-slate-200 hover:border-rose-200 transition cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Cerrar sesión</span>
              </button>
            </div>
          </div>
        )}

        {/* Pie de Barra Lateral: Versión 3.0.0 y Estado: Actualizado */}
        <SidebarVersionFooter />
      </aside>

      {/* ==================================================================== */}
      {/* 2. BARRA SUPERIOR (DISTRIBUCIÓN DIFERENCIADA PARA PC Y MÓVIL)        */}
      {/* ==================================================================== */}
      <header
        data-testid="app-top-header"
        className="bg-[#0f6b38] text-white shadow-sm sticky top-0 z-30 border-b border-[#0a4e28]"
      >
        {/* Selector oculto sincronizado para compatibilidad de pruebas automatizadas */}
        {currentSector && Array.isArray(currentSector.galpones) && currentSector.galpones.length > 0 && (
          <select
            data-testid="selector-galpon"
            aria-label="Selector técnico de Galpón"
            value={currentGalpon?.id || ''}
            onChange={(e) => setSelectedGalponId(e.target.value)}
            className="sr-only"
          >
            <option value="">Seleccione un galpón...</option>
            {currentSector.galpones.map((gal: any) => (
              <option key={gal.id} value={gal.id}>
                {gal.code} - {gal.name}
              </option>
            ))}
          </select>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* A. VERSIÓN WEB PARA PC (lg:flex en DOS FILAS)                      */}
        {/* ------------------------------------------------------------------ */}
        <div
          data-testid="header-pc-layout"
          className="hidden lg:flex lg:flex-col max-w-[1600px] mx-auto px-5 py-2.5 gap-2"
        >
          {/* PRIMERA FILA (PC): Izquierda (Hamburguesa + Logo + Nombre + Sector) | Derecha (Conexión + Sincronizar [N] + Usuario + Cerrar sesión) */}
          <div className="flex items-center justify-between gap-4">
            {/* Lado izquierdo */}
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Abrir menú administrativo"
                data-testid="btn-open-sidebar-pc"
                className="p-1.5 rounded-lg bg-emerald-800/90 hover:bg-emerald-700 text-white transition border border-emerald-600/50 cursor-pointer shrink-0"
                title="Abrir menú administrativo"
              >
                <Menu className="w-4 h-4" />
              </button>
              <GalponLogoIcon variant="header" size="sm" />
              <h1 className="text-base font-bold tracking-tight whitespace-nowrap">
                Control Galpones La Calera
              </h1>

              <div className="h-4 w-px bg-white/20 mx-0.5" />

              {/* Selector de Sector junto al nombre de la aplicación */}
              <div className="flex items-center gap-1.5">
                <label
                  htmlFor="header-sector-select"
                  className="text-xs font-semibold text-emerald-100 whitespace-nowrap"
                >
                  Sector:
                </label>
                {sectors.length === 0 ? (
                  canDo('proyectos', 'create') ? (
                    <button
                      type="button"
                      onClick={() => {
                        setFormProject({
                          id: '',
                          code: '',
                          name: '',
                          location: '',
                          client: ''
                        });
                        setModalNewProject(true);
                      }}
                      className="px-2.5 py-1 rounded-lg bg-amber-400 text-slate-950 font-bold text-xs cursor-pointer whitespace-nowrap"
                    >
                      + Crear Sector
                    </button>
                  ) : (
                    <span className="text-xs text-emerald-200 italic">Sin sectores</span>
                  )
                ) : (
                  <div className="flex items-center gap-1">
                    <select
                      id="header-sector-select"
                      data-testid="selector-sector"
                      aria-label="Selector de Sector"
                      value={currentSector?.id || ''}
                      onChange={(e) => handleSelectSector(e.target.value)}
                      className="bg-emerald-900/90 hover:bg-emerald-900 text-white text-xs font-semibold rounded-lg px-2.5 py-1.5 border border-emerald-600/60 focus:outline-none focus:ring-1 focus:ring-white cursor-pointer max-w-[200px] truncate"
                    >
                      {!currentSector && (
                        <option value="">Seleccione sector...</option>
                      )}
                      {sectors.map((sec) => (
                        <option key={sec.id} value={sec.id} className="bg-slate-900 text-white">
                          {sec.name}
                        </option>
                      ))}
                    </select>
                    {canDo('proyectos', 'create') && (
                      <button
                        type="button"
                        onClick={() => {
                          setFormProject({
                            id: '',
                            code: '',
                            name: '',
                            location: '',
                            client: ''
                          });
                          setModalNewProject(true);
                        }}
                        title="Nuevo Sector"
                        aria-label="Nuevo Sector"
                        className="p-1.5 rounded-lg bg-emerald-800/80 hover:bg-emerald-700 text-emerald-100 border border-emerald-600/40 transition cursor-pointer shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Lado derecho: Indicador de conexión + Botón SINCRONIZAR DATOS [N] + Menú de usuario + Cerrar sesión */}
            <div className="flex items-center gap-2 shrink-0">
              <OfflineSyncStatusBar
                connectionIndicatorState={connectionIndicatorState}
                isNetworkOnline={isNetworkOnline}
                activePendingCount={activePendingCount}
                unresolvedConflictCount={unresolvedConflictCount}
                pendingOperations={pendingOperations}
                syncConflicts={syncConflicts}
                isManualSyncing={isManualSyncing}
                onTriggerManualSync={async () => {
                  const res = await triggerManualSync();
                  if (res.conflictCount > 0 || res.errorCount > 0 || !isNetworkOnline) {
                    setModalSyncCenterOpen(true);
                  }
                  return res;
                }}
                onOpenSyncModal={() => setModalSyncCenterOpen(true)}
              />

              {profile && (
                <div className="flex items-center gap-1.5 border-l border-white/20 pl-2">
                  {canManageUsers ? (
                    <button
                      type="button"
                      data-testid="header-btn-user-menu"
                      onClick={openUserAdminModal}
                      title={`Gestión de Usuarios (${profile.displayName} · ${profile.role})`}
                      aria-label="Menú de usuario y roles"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-800/90 hover:bg-emerald-700 text-white text-xs font-semibold border border-emerald-600/50 transition cursor-pointer whitespace-nowrap"
                    >
                      <Users className="w-3.5 h-3.5 text-emerald-200" />
                      <span>Usuarios</span>
                    </button>
                  ) : (
                    <div
                      data-testid="header-btn-user-menu"
                      title={`${profile.displayName} (${profile.role})`}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-900/70 text-emerald-50 text-xs font-semibold border border-emerald-700/50 whitespace-nowrap"
                    >
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-300" />
                      <span>{profile.role}</span>
                    </div>
                  )}

                  <button
                    type="button"
                    data-testid="header-btn-logout"
                    onClick={logout}
                    title="Cerrar sesión"
                    aria-label="Cerrar sesión"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-950/70 hover:bg-rose-700 text-emerald-100 hover:text-white text-xs font-semibold border border-emerald-700/50 transition cursor-pointer whitespace-nowrap"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Cerrar sesión</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* SEGUNDA FILA (PC): Pestañas/Botones Horizontales de Galpones del Sector Seleccionado */}
          <div
            data-testid="header-pc-galpones-row"
            className="flex items-center gap-2 pt-1.5 border-t border-white/15 min-w-0"
          >
            <span className="text-xs font-bold text-emerald-100 whitespace-nowrap shrink-0">
              Galpones:
            </span>
            {renderGalponHorizontalTabs('pc-galpon-tab')}
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* B. VERSIÓN WEB MÓVIL (< lg: CUATRO FILAS ORDENADAS)                */}
        {/* ------------------------------------------------------------------ */}
        <div
          data-testid="header-mobile-layout"
          className="flex lg:hidden flex-col px-3 py-2.5 gap-2"
        >
          {/* Fila 1 Móvil: Menú Hamburguesa + Logotipo Industrial + Nombre Compacto */}
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Abrir menú lateral"
              data-testid="btn-open-sidebar"
              className="p-1.5 rounded-lg bg-emerald-800/90 hover:bg-emerald-700 text-white transition border border-emerald-600/50 cursor-pointer shrink-0"
              title="Abrir menú"
            >
              <Menu className="w-4 h-4" />
            </button>
            <GalponLogoIcon variant="header" size="sm" />
            <h1 className="text-sm font-bold tracking-tight truncate">
              Control Galpones La Calera
            </h1>
          </div>

          {/* Fila 2 Móvil: Selector de Sector + Botón [+] */}
          <div className="flex items-center gap-2 min-w-0">
            <label
              htmlFor="mobile-sector-select"
              className="text-xs font-bold text-emerald-100 whitespace-nowrap shrink-0"
            >
              Sector:
            </label>
            <select
              id="mobile-sector-select"
              data-testid="selector-sector-mobile"
              aria-label="Selector de Sector Móvil"
              value={currentSector?.id || ''}
              onChange={(e) => handleSelectSector(e.target.value)}
              className="flex-1 min-w-0 bg-emerald-900/90 text-white text-xs font-semibold rounded-lg px-2.5 py-1.5 border border-emerald-600/60 focus:outline-none focus:ring-1 focus:ring-white"
            >
              {!currentSector && <option value="">Seleccione sector...</option>}
              {sectors.map((sec) => (
                <option key={sec.id} value={sec.id} className="bg-slate-900 text-white">
                  {sec.name}
                </option>
              ))}
            </select>
            {canDo('proyectos', 'create') && (
              <button
                type="button"
                onClick={() => {
                  setFormProject({
                    id: '',
                    code: '',
                    name: '',
                    location: '',
                    client: ''
                  });
                  setModalNewProject(true);
                }}
                title="Nuevo Sector"
                aria-label="Nuevo Sector"
                className="p-1.5 rounded-lg bg-emerald-800/90 hover:bg-emerald-700 text-emerald-100 border border-emerald-600/50 transition cursor-pointer shrink-0"
              >
                <Plus className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Fila 3 Móvil: Etiqueta Galpones + Botones Horizontales Desplazables + Botón [+] */}
          <div
            data-testid="header-mobile-galpones-row"
            className="flex items-center gap-2 min-w-0 pt-0.5"
          >
            <span className="text-xs font-bold text-emerald-100 whitespace-nowrap shrink-0">
              Galpones:
            </span>
            {renderGalponHorizontalTabs('mobile-galpon-tab')}
          </div>

          {/* Fila 4 Móvil: Indicador de Conexión + Botón SINCRONIZAR DATOS con contador */}
          <div
            data-testid="header-mobile-sync-row"
            className="flex items-center justify-between gap-2 pt-1 border-t border-white/15"
          >
            <OfflineSyncStatusBar
              connectionIndicatorState={connectionIndicatorState}
              isNetworkOnline={isNetworkOnline}
              activePendingCount={activePendingCount}
              unresolvedConflictCount={unresolvedConflictCount}
              pendingOperations={pendingOperations}
              syncConflicts={syncConflicts}
              isManualSyncing={isManualSyncing}
              onTriggerManualSync={async () => {
                const res = await triggerManualSync();
                if (res.conflictCount > 0 || res.errorCount > 0 || !isNetworkOnline) {
                  setModalSyncCenterOpen(true);
                }
                return res;
              }}
              onOpenSyncModal={() => setModalSyncCenterOpen(true)}
            />
          </div>
        </div>
      </header>

      {/* ==================================================================== */}
      {/* 3. SUB-BARRA CONTEXTUAL                                              */}
      {/* ==================================================================== */}
      <div className="bg-white border-b border-slate-200 py-2.5 px-4 sm:px-6 shadow-xs">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-extrabold text-slate-900 text-sm">
              {currentGalpon
                ? `${currentGalpon.code} • ${currentGalpon.name}`
                : 'Sin Galpón Seleccionado'}
            </span>
            {currentGalpon && (
              <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-[#0f6b38] border border-emerald-200 font-bold text-[11px]">
                Proveedor: {currentGalpon.technology || 'Sin proveedor'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-slate-500 font-semibold">Avance Ponderado:</span>
              <span className="font-black text-sm text-[#0f6b38] font-mono">
                {galponWeightedProgress}%
              </span>
            </div>
            <div className="w-20 sm:w-28 bg-slate-200 rounded-full h-2 overflow-hidden">
              <div
                className="bg-[#0f6b38] h-full transition-all duration-500 rounded-full"
                style={{ width: `${galponWeightedProgress}%` }}
              />
            </div>

            {canDo('avance_diario', 'create') && (
              <button
                disabled={!currentGalpon}
                onClick={() => openNewAdvanceModal()}
                className="px-3 py-1.5 rounded-lg bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>+ Registrar Avance</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* 4. CONTENIDO PRINCIPAL                                               */}
      {/* ==================================================================== */}
      <main
        className={`flex-1 w-full mx-auto p-3 sm:p-5 pb-28 ${
          currentTab === 'gantt' ? 'max-w-[1600px]' : 'max-w-7xl'
        }`}
      >
        {syncStorageError && (
          <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            El navegador rechazó guardar una operación en este dispositivo. Conserve la pestaña abierta y revise el almacenamiento antes de continuar.
          </p>
        )}
        {permissionNotice && (
          <div className="mb-4 bg-amber-50 border border-amber-300 text-amber-900 px-4 py-3 rounded-xl text-xs font-bold flex items-center justify-between shadow-xs">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>{permissionNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => setPermissionNotice(null)}
              className="text-amber-700 hover:text-amber-950 font-black px-2"
            >
              ✕
            </button>
          </div>
        )}
        {/* ================================================================== */}
        {/* VISTA 1: DASHBOARD MODULAR                                         */}
        {/* ================================================================== */}
        {currentTab === 'dashboard' && (
          <div className="space-y-4">
            <PortfolioOverview rows={allGlobalReportRows} onExport={canDo('dashboard', 'export') ? rows => {
              if (!requirePermission('dashboard', 'export')) return;
              downloadCsvFile('Avance_proyectos_' + getSystemToday() + '.csv',
                ['Proyecto', 'Sector', 'Galpón', 'Área', 'Sistema', 'Actividad', 'Avance %', 'Estado'],
                rows.map(row => [row.projectName, row.sectorName, row.galponCode || row.galponName, row.areaName, row.sistemaName,
                  row.activityName, row.progressPercent, row.computedStatus]));
            } : undefined} />
          <DashboardView
            currentSector={currentSector}
            currentGalpon={currentGalpon}
            galponWeightedProgress={galponWeightedProgress}
            evaluatedActivities={evaluatedActivities}
            areaProgressMetrics={areaProgressMetrics}
            sistemaProgressMetrics={sistemaProgressMetrics}
            currentDayAttendance={currentDayAttendance}
            attendanceDate={attendanceDate}
            dashSistemaLocFilter={dashSistemaLocFilter}
            setDashSistemaLocFilter={setDashSistemaLocFilter}
            dashPendingAreaFilter={dashPendingAreaFilter}
            setDashPendingAreaFilter={setDashPendingAreaFilter}
            canCreateAdvance={canDo('avance_diario', 'create')}
            onNavigateTab={(tab) => setCurrentTab(tab as any)}
            onOpenNewAdvanceModal={(prefill) => openNewAdvanceModal(prefill)}
          />
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 2: CRONOGRAMA GANTT DINÁMICO (OPCIÓN C: PLANIFICACIÓN + REAL) */}
        {/* ================================================================== */}
        {currentTab === 'gantt' && (
          <React.Suspense fallback={<p role="status" className="p-4 text-sm text-slate-600">Cargando cronograma…</p>}>
          <GanttView
            currentSector={currentSector}
            currentGalpon={currentGalpon}
            rawActivities={evaluatedActivities}
            dailyAdvances={confirmedAdvances}
            todayStr={getSystemToday()}
            canCreateActivity={canDo('gantt', 'create')}
            canEditGantt={canDo('gantt', 'edit')}
            canExportGantt={canDo('gantt', 'export')}
            canDeleteGantt={canDo('gantt', 'delete')}
            onWithdrawActivity={requestWithdrawGanttActivity}
            onOpenNewActivity={() => openNewActivity('gantt')}
            onDateChange={handleGanttDateChange}
          />
          </React.Suspense>
        )}

        {/* ================================================================== */}
        {/* VISTA 3: AVANCE DIARIO                                             */}
        {/* ================================================================== */}
        {currentTab === 'avance_diario' && (
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Control de Avance Diario de Obra
                </h2>
                <p className="text-xs text-slate-500">
                  Registro guiado en cascada por Cantidades o Porcentaje Total Alcanzado (0%-100%),
                  con soporte Offline, sincronización multiusuario y recálculo automático de stock
                </p>
              </div>
              {canDo('avance_diario', 'create') && (<button
                disabled={!currentGalpon}
                onClick={() => openNewAdvanceModal()}
                className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white font-bold text-xs flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>+ Registrar Parte de Hoy</span>
              </button>)}
            </div>

            <div className="space-y-3">
              {dailyAdvances.filter((a) => a.galponId === currentGalpon?.id).length ===
              0 ? (
                <div className="p-8 text-center bg-white rounded-2xl border border-slate-200">
                  <ClipboardList className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                  <p className="text-sm font-bold text-slate-600">
                    No hay partes diarios registrados para este galpón
                  </p>
                </div>
              ) : (
                dailyAdvances
                  .filter((a) => a.galponId === currentGalpon?.id)
                  .map((adv) => {
                    const act = evaluatedActivities.find(
                      (a) => a.code === adv.activityCode
                    );
                    const isPctMode =
                      adv.progressMode === 'percentage' ||
                      act?.progressMode === 'percentage';
                    const isPendingLocal = adv.syncState === 'pending_sync' || !isNetworkOnline;
                    const isConflict = adv.syncState === 'conflict';

                    return (
                      <div
                        key={adv.id}
                        className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                      >
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="px-2 py-0.5 rounded bg-[#0f6b38] text-white font-mono font-bold text-[10px]">
                              {adv.activityCode}
                            </span>
                            <span className="text-xs font-extrabold text-slate-900">
                              {act?.name || 'Actividad'}
                            </span>
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded font-bold border ${
                                isPctMode
                                  ? 'bg-blue-50 text-blue-800 border-blue-200'
                                  : 'bg-emerald-50 text-[#0f6b38] border-emerald-200'
                              }`}
                            >
                              {isPctMode ? 'Modalidad: Porcentaje (%)' : 'Modalidad: Cantidades'}
                            </span>
                            <span className="text-xs font-mono font-black text-[#0f6b38]">
                              {isPctMode
                                ? `Total alcanzado: ${adv.percentageReached ?? adv.quantityToday}%`
                                : `+${adv.quantityToday} ${act?.unit || ''}`}
                            </span>
                            {adv.hoursWorked > 0 && (
                              <span className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-bold">
                                {adv.hoursWorked} HH
                              </span>
                            )}
                            {adv.isAuthorizedCorrection && (
                              <span className="text-[10px] px-2 py-0.5 rounded bg-purple-100 text-purple-800 border border-purple-300 font-bold">
                                Corrección histórica autorizada
                              </span>
                            )}
                            {isConflict ? (
                              <span className="text-[10px] px-2 py-0.5 rounded bg-rose-100 text-rose-800 border border-rose-300 font-bold">
                                En conflicto multiusuario
                              </span>
                            ) : adv.syncState === 'pending_sync' ? (
                              <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 font-bold">
                                Pendiente de sincronización
                              </span>
                            ) : (
                              <span className="text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-bold">
                                {isPendingLocal ? 'Guardado localmente' : 'Sincronizado'}
                              </span>
                            )}
                            {adv.sharedGroupId && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 font-bold">
                                Biproyecto ({adv.splitMode === '50_50' ? '50/50' : '100% Ambos'}
                                {adv.sharedWithGalponCode
                                  ? ` • ${adv.sharedWithGalponCode}`
                                  : ''})
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 mt-1">
                            Fecha: <strong>{adv.date}</strong> • Supervisor:{' '}
                            <strong>{adv.supervisor || 'Sin especificar'}</strong>
                            {adv.note ? ` • Nota: ${adv.note}` : ''}
                            {adv.correctionReason
                              ? ` • Motivo corrección: ${adv.correctionReason}`
                              : ''}
                          </p>
                          {adv.materialsUsedToday?.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {adv.materialsUsedToday.map((m: any, idx: number) => (
                                <span
                                  key={idx}
                                  className="text-[10px] px-2 py-0.5 rounded bg-emerald-50 text-[#0f6b38] border border-emerald-200 font-bold"
                                >
                                  Material: {m.name} (-{m.qty} {m.unit})
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0">
                          <div className="text-right">
                            <span className="text-xs text-slate-500 block">
                              {isPctMode
                                ? `Último % válido: ${act?.progressPercent || 0}% / 100%`
                                : `Acumulado: ${act?.accumulatedQty || 0} / ${act?.targetUnits || 0}`}
                            </span>
                            <span className="text-sm font-black text-[#0f6b38] font-mono">
                              {act?.progressPercent || 0}%
                            </span>
                          </div>
                          <div className="flex items-center gap-1 border-l border-slate-200 pl-3">
                            {canDo('avance_diario', 'edit') && (<button
                              type="button"
                              onClick={() => openEditAdvanceModal(adv)}
                              className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition"
                              title="Modificar Avance Diario"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>)}
                            {canDo('avance_diario', 'delete') && (<button
                              type="button"
                              onClick={() => requestDeleteAdvance(adv.id)}
                              className="p-2 rounded-lg text-rose-600 hover:bg-rose-50 transition"
                              title="Eliminar Avance Diario (Revierte consumo de materiales)"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>)}
                          </div>
                        </div>
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 4: ASISTENCIA (CONTEO DE TODO + ATENCIÓN MÉDICA)             */}
        {/* ================================================================== */}
        {currentTab === 'asistencia' && (
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Control Diario de Asistencia
                </h2>
                <p className="text-xs text-slate-500">
                  Filtra por Galpón, Sector o Global y por especialidad de trabajo
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <div className="flex items-center bg-slate-100 p-1 rounded-xl">
                  {(
                    [
                      { id: 'galpon', label: 'Por Galpón' },
                      { id: 'sector', label: 'Por Sector' },
                      { id: 'global', label: 'Global' }
                    ] as const
                  ).map((sc) => (
                    <button
                      key={sc.id}
                      onClick={() => setAttendanceScope(sc.id)}
                      className={`px-2.5 py-1 rounded-lg font-bold transition ${
                        attendanceScope === sc.id
                          ? 'bg-[#0f6b38] text-white'
                          : 'text-slate-600'
                      }`}
                    >
                      {sc.label}
                    </button>
                  ))}
                </div>

                <select
                  value={attendanceSpecialtyFilter}
                  onChange={(e) => setAttendanceSpecialtyFilter(e.target.value)}
                  className="px-3 py-1.5 border border-slate-300 rounded-xl font-bold bg-slate-50"
                >
                  <option value="Todas">Todas las Especialidades</option>
                  {WORK_SPECIALTIES.map((sp) => (
                    <option key={sp} value={sp}>
                      {sp}
                    </option>
                  ))}
                </select>

                <input
                  type="date"
                  value={attendanceDate}
                  onChange={(e) => setAttendanceDate(e.target.value)}
                  className="px-3 py-1.5 border border-slate-300 rounded-xl font-bold bg-slate-50"
                />

                {canDo('asistencia', 'edit') && (<button
                  onClick={handleMarkAllAttended}
                  className="px-3 py-1.5 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] text-white font-bold flex items-center gap-1"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Marcar Todos Asistió</span>
                </button>)}

                {canDo('asistencia', 'export') && (<button
                  type="button"
                  onClick={handleExportAttendanceCSV}
                  className="px-3 py-1.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-bold flex items-center gap-1"
                >
                  <Download className="w-3.5 h-3.5 text-[#0f6b38]" />
                  <span>Exportar Asistencia (.CSV)</span>
                </button>)}
              </div>
            </div>

            {/* 7 TARJETAS DE CONTEO COMPLETO DE ASISTENCIA */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 bg-white p-4 rounded-2xl border border-slate-200">
              <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-center">
                <span className="text-[10px] text-slate-500 uppercase font-bold block">
                  Total Personal
                </span>
                <p className="text-xl font-black text-slate-900 font-mono">
                  {currentDayAttendance.total}
                </p>
              </div>
              <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-center">
                <span className="text-[10px] text-[#0f6b38] uppercase font-bold block">
                  Asistió
                </span>
                <p className="text-xl font-black text-[#0f6b38] font-mono">
                  {currentDayAttendance.present}
                </p>
              </div>
              <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-center">
                <span className="text-[10px] text-rose-600 uppercase font-bold block">
                  Falta
                </span>
                <p className="text-xl font-black text-rose-600 font-mono">
                  {currentDayAttendance.absent}
                </p>
              </div>
              <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-center">
                <span className="text-[10px] text-amber-700 uppercase font-bold block">
                  Atención Médica
                </span>
                <p className="text-xl font-black text-amber-700 font-mono">
                  {currentDayAttendance.medicalAttention}
                </p>
              </div>
              <div className="p-2.5 rounded-xl bg-blue-50 border border-blue-200 text-center">
                <span className="text-[10px] text-blue-700 uppercase font-bold block">
                  Permiso
                </span>
                <p className="text-xl font-black text-blue-700 font-mono">
                  {currentDayAttendance.permission}
                </p>
              </div>
              <div className="p-2.5 rounded-xl bg-purple-50 border border-purple-200 text-center">
                <span className="text-[10px] text-purple-700 uppercase font-bold block">
                  Descanso Médico
                </span>
                <p className="text-xl font-black text-purple-700 font-mono">
                  {currentDayAttendance.medicalLeave}
                </p>
              </div>
              <div className="p-2.5 rounded-xl bg-emerald-50/60 border border-emerald-300 text-center">
                <span className="text-[10px] text-[#0f6b38] uppercase font-bold block">
                  % Asistencia
                </span>
                <p className="text-xl font-black text-[#0f6b38] font-mono">
                  {currentDayAttendance.rate}%
                </p>
              </div>
            </div>

            <div className="space-y-2">
              {filteredAttendanceWorkers.length === 0 ? (
                <div className="p-8 text-center bg-white rounded-2xl border border-slate-200">
                  <Users className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                  <p className="text-sm font-bold text-slate-600">
                    No hay trabajadores registrados para este filtro
                  </p>
                  <button
                    onClick={() => setCurrentTab('personal')}
                    className="mt-3 px-4 py-2 bg-[#0f6b38] text-white text-xs font-bold rounded-xl"
                  >
                    Ir a Planilla de Personal
                  </button>
                </div>
              ) : (
                filteredAttendanceWorkers.map((w) => {
                  const currentStatus = currentDayAttendance.map[w.id] || 'Pendiente';
                  return (
                    <div
                      key={w.id}
                      className="bg-white p-3 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-emerald-50 text-[#0f6b38] font-mono font-bold text-[10px] border border-emerald-200">
                            {w.workerCode}
                          </span>
                          <h4 className="text-xs font-bold text-slate-900">{w.name || 'Dato inválido'}</h4>
                          <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-bold">
                            {w.workArea}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          DNI: {w.dni || '-'} • Cargo: {w.role}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 flex-wrap">
                        {ATTENDANCE_STATUSES.map((stKey) => {
                          const isSel = currentStatus === stKey;
                          const activeStyles: Record<string, string> = {
                            Asistió: 'bg-[#0f6b38] text-white border-[#0f6b38]',
                            Falta: 'bg-rose-600 text-white border-rose-600',
                            'Atención Médica':
                              'bg-amber-500 text-slate-950 font-black border-amber-500',
                            Permiso: 'bg-blue-600 text-white border-blue-600',
                            'Descanso Médico': 'bg-purple-600 text-white border-purple-600'
                          };

                          return (
                            <button
                              key={stKey}
                              disabled={!canDo('asistencia', currentStatus ? 'edit' : 'create')}
                              onClick={() => handleSetWorkerAttendance(w.id, stKey)}
                              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${
                                isSel
                                  ? activeStyles[stKey]
                                  : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                              }`}
                            >
                              {stKey}
                            </button>
                          );
                        })}
                        {currentStatus && canDo('asistencia', 'delete') && (
                          <button type="button" className="text-xs text-red-700 underline" onClick={() => handleClearAttendance(w.id)}>
                            Quitar registro
                          </button>
                        )}

                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 5: PROYECTOS / SECTORES Y GALPONES (C-5: Alcance y Permisos) */}
        {/* ================================================================== */}
        {currentTab === 'proyectos' && (
          <div className="space-y-6">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Gestión de Sectores y Galpones
                </h2>
                <p className="text-xs text-slate-500">
                  Crea, modifica o elimina sectores y asigna a cada galpón su plantilla de
                  proveedor
                </p>
              </div>
              {canDo('proyectos', 'create') && (
                <div className="flex items-center gap-2">
                  {canDo('proyectos', 'create') && (<button
                    onClick={() => {
                      setFormProject({
                        id: '',
                        code: '',
                        name: '',
                        location: '',
                        client: ''
                      });
                      setModalNewProject(true);
                    }}
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1.5"
                  >
                    <FolderPlus className="w-4 h-4" />
                    <span>+ Nuevo Proyecto / Sector</span>
                  </button>)}
                  {canDo('proyectos', 'create') && (<button
                    disabled={sectors.length === 0}
                    onClick={() => {
                      setFormGalpon({
                        id: '',
                        sectorId: '',
                        code: '',
                        name: '',
                        description: '',
                        responsible: '',
                        startDate: '',
                        endDate: '',
                        technology: ''
                      });
                      setModalNewGalpon(true);
                    }}
                    className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>+ Crear Galpón</span>
                  </button>)}
                </div>
              )}
            </div>

            {sectors.length === 0 ? (
              <div className="bg-white rounded-2xl p-8 text-center border border-slate-200">
                <p className="text-sm font-bold text-slate-700">
                  No existen Sectores / Galpones asignados a su alcance actual.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {sectors.map((sec) => (
                  <div
                    key={sec.id}
                    className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-200 gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#0f6b38] text-white">
                            {sec.code}
                          </span>
                          <h3 className="text-base font-black text-slate-900">
                            {sec.name}
                          </h3>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          Ubicación: <strong>{sec.location || '-'}</strong> • Cliente:{' '}
                          <strong>{sec.client || '-'}</strong>
                        </p>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        {canDo('proyectos', 'edit') && (
                          <button
                            onClick={() => {
                              setFormProject({
                                id: sec.id,
                                code: sec.code,
                                name: sec.name,
                                location: sec.location || '',
                                client: sec.client || ''
                              });
                              setModalEditProject(true);
                            }}
                            className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center gap-1"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                            <span>Editar Sector</span>
                          </button>
                        )}

                        {canDo('proyectos', 'delete') && (
                          <button
                            onClick={() => requestDeleteSector(sec.id)}
                            className="px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold flex items-center gap-1"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Eliminar Sector</span>
                          </button>
                        )}

                        {canDo('proyectos', 'create') && (
                          <button
                            onClick={() => {
                              setFormGalpon({
                                id: '',
                                sectorId: sec.id,
                                code: '',
                                name: '',
                                description: '',
                                responsible: '',
                                startDate: '',
                                endDate: '',
                                technology: ''
                              });
                              setModalNewGalpon(true);
                            }}
                            className="px-3 py-1.5 rounded-lg bg-[#0f6b38] hover:bg-[#0a4e28] text-white text-xs font-bold flex items-center gap-1"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>+ Agregar Galpón aquí</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                      {(sec.galpones || []).map((gal: any) => (
                        <div
                          key={gal.id}
                          className="p-4 rounded-xl border border-slate-200 bg-slate-50 flex flex-col justify-between gap-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-extrabold text-slate-900 text-sm">
                                  {gal.code} - {gal.name}
                                </span>
                                <span className="px-2 py-0.5 rounded bg-emerald-100 text-[#0f6b38] font-bold text-[10px]">
                                  Plantilla: {gal.technology || 'Sin proveedor'}
                                </span>
                              </div>
                              <p className="text-xs text-slate-500 mt-1">
                                {gal.description || 'Sin descripción'}
                              </p>
                              <p className="text-[11px] text-slate-500 mt-1">
                                Supervisores:{' '}
                                <strong>
                                  {barnResponsible(gal) || 'Sin asignar'}
                                </strong>
                              </p>
                            </div>

                            <div className="flex items-center gap-1">
                              {canDo('proyectos', 'edit') && (
                                <button
                                  onClick={() => {
                                    setFormGalpon({
                                      id: gal.id,
                                      sectorId: sec.id,
                                      code: gal.code,
                                      name: gal.name,
                                      description: gal.description || '',
                                      responsible: barnResponsible(gal),
                                      startDate: gal.startDate || getSystemToday(),
                                      endDate: gal.endDate || getSystemToday(),
                                      technology: gal.technology || ''
                                    });
                                    setModalEditGalpon(true);
                                  }}
                                  className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-200"
                                  title="Editar Galpón y Plantilla"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {canDo('proyectos', 'delete') && (
                                <button
                                  onClick={() => requestDeleteGalpon(sec.id, gal.id)}
                                  className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100"
                                  title="Eliminar Galpón"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center justify-between pt-2 border-t border-slate-200 gap-2">
                            {canDo('proyectos', 'edit') ? (
                              <button
                                onClick={() => handleReloadGalponFromCatalog(sec.id, gal)}
                                className="text-[11px] font-bold text-[#0f6b38] hover:underline flex items-center gap-1"
                              >
                                <RefreshCw className="w-3 h-3" />
                                <span>Sincronizar con Plantilla ({gal.technology || 'Sin proveedor'})</span>
                              </button>
                            ) : (
                              <span className="text-[11px] text-slate-400">
                                Plantilla: {gal.technology || 'Sin proveedor'}
                              </span>
                            )}
                            <button
                              onClick={() => {
                                setSelectedSectorId(sec.id);
                                setSelectedGalponId(gal.id);
                                setCurrentTab('dashboard');
                              }}
                              className="px-3 py-1 rounded-lg bg-[#0f6b38] text-white text-[11px] font-bold"
                            >
                              Abrir Galpón
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 6: CATÁLOGO MAESTRO Y PLANTILLAS                             */}
        {/* ================================================================== */}
        {currentTab === 'catalogo' && (
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Catálogo Maestro de Actividades y Plantillas por Proveedor
                </h2>
                <p className="text-xs text-slate-500">
                  Crea, edita o elimina plantillas de proveedores y sus actividades
                  maestras
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canDo('catalogo', 'create') && (<button
                  onClick={() => setModalManageTemplates(true)}
                  className="px-3 py-2 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center gap-1.5"
                >
                  <Settings className="w-4 h-4 text-[#0f6b38]" />
                  <span>Gestionar Plantillas / Proveedores</span>
                </button>)}
                {canDo('catalogo', 'import') && (<button
                  onClick={() => {
                    setBulkCsvText('');
                    setBulkRawRows([]);
                    setBulkFileName('');
                    setBulkTargetGalponId('');
                    if (requirePermission('catalogo', 'import')) setModalBulkUpload('catalogo');
                  }}
                  className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4 text-[#0f6b38]" />
                  <span>Carga Masiva Excel/CSV</span>
                </button>)}
                {canDo('catalogo', 'create') && (<button
                  onClick={openNewCatalogModal}
                  className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] text-white text-xs font-bold flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  <span>+ Nueva Actividad Maestra</span>
                </button>)}
                {canDo('catalogo', 'export') && <button type="button" className="rounded-xl border px-3 py-2 text-xs font-bold"
                  onClick={() => void exportCatalogWorkbook().catch(() => setPermissionNotice('No se pudo exportar el catálogo.'))}>
                  Exportar catálogo XLSX
                </button>}
              </div>
            </div>

            <div className="bg-white p-3 rounded-2xl border border-slate-200 flex items-center gap-2 overflow-x-auto">
              <span className="text-xs font-bold text-slate-500">
                Plantilla / Proveedor:
              </span>
              {['Todas', ...technologies].map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedCatalogTech(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                    selectedCatalogTech === t
                      ? 'bg-[#0f6b38] text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#0f6b38] text-white font-bold uppercase text-[11px]">
                    <tr>
                      <th className="py-3 px-3">Proveedor</th>
                      <th className="py-3 px-3">Código</th>
                      <th className="py-3 px-3">Área</th>
                      <th className="py-3 px-3">Ubicación / Sistema</th>
                      <th className="py-3 px-3">Estructura</th>
                      <th className="py-3 px-3">Actividad</th>
                      <th className="py-3 px-2 text-center">Modalidad</th>
                      <th className="py-3 px-2 text-right">Meta</th>
                      <th className="py-3 px-2 text-right">Peso</th>
                      <th className="py-3 px-3 text-center">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium">
                    {activeMasterCatalog.filter(
                      (c) =>
                        selectedCatalogTech === 'Todas' ||
                        c.technology === selectedCatalogTech
                    ).length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-8 text-center text-slate-400">
                          No hay actividades en el Catálogo Maestro para este filtro.
                        </td>
                      </tr>
                    ) : (
                      activeMasterCatalog
                        .filter(
                          (c) =>
                            selectedCatalogTech === 'Todas' ||
                            c.technology === selectedCatalogTech
                        )
                        .map((item) => {
                          const isPct = normalizeProgressMode(item.progressMode) === 'percentage';
                          return (
                            <tr key={item.id} className="hover:bg-slate-50">
                              <td className="py-2.5 px-3 font-bold text-[#0f6b38]">
                                {item.technology}
                              </td>
                              <td className="py-2.5 px-3 font-mono font-bold">
                                {item.code}
                              </td>
                              <td className="py-2.5 px-3">{item.areaName}</td>
                              <td className="py-2.5 px-3">
                                {item.sistemaName
                                  ? `${item.locationType} • ${item.sistemaName}`
                                  : '-'}
                              </td>
                              <td className="py-2.5 px-3 font-bold text-slate-700">
                                <div className="flex items-center justify-between gap-1.5">
                                  <span>{item.structureName}</span>
                                  {canDo('catalogo', 'delete') && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        requestDeleteCatalogStructure(
                                          item.areaName,
                                          item.sistemaName,
                                          item.structureName
                                        )
                                      }
                                      className="px-1.5 py-0.5 rounded text-[10px] font-bold text-rose-600 hover:bg-rose-50 border border-rose-200 transition shrink-0"
                                      title={`Eliminar estructura "${item.structureName}" y sus actividades maestras`}
                                    >
                                      Eliminar estructura
                                    </button>
                                  )}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 font-bold text-slate-900">
                                {item.name}
                              </td>
                              <td className="py-2.5 px-2 text-center">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                    isPct
                                      ? 'bg-blue-50 text-blue-800 border-blue-200'
                                      : 'bg-emerald-50 text-[#0f6b38] border-emerald-200'
                                  }`}
                                >
                                  {isPct ? 'Porcentaje (%)' : 'Cantidades'}
                                </span>
                              </td>
                              <td className="py-2.5 px-2 text-right font-mono">
                                {isPct ? '100 %' : `${item.targetUnits} ${item.unit}`}
                              </td>
                              <td className="py-2.5 px-2 text-right font-mono">
                                {item.weight}x
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  {canDo('catalogo', 'edit') && (<button
                                    onClick={() => openEditCatalogModal(item)}
                                    className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-200"
                                    title="Editar actividad maestra"
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>)}
                                  {canDo('catalogo', 'create') && (<button
                                    type="button"
                                    onClick={() => openEditCatalogModal(item, true)}
                                    className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-200"
                                    title="Duplicar actividad maestra"
                                    aria-label="Duplicar actividad maestra"
                                  >
                                    Duplicar
                                  </button>)}
                                  {canDo('catalogo', 'delete') && (<button
                                    onClick={() => requestDeleteCatalogItem(item.id)}
                                    className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100"
                                    title="Eliminar actividad maestra"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>)}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 7: GESTIÓN DE ACTIVIDADES EN EL GALPÓN                       */}
        {/* ================================================================== */}
        {currentTab === 'actividades' && (
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Gestión de Actividades del Galpón{' '}
                  {currentGalpon ? `(${currentGalpon.code})` : ''}
                </h2>
                <p className="text-xs text-slate-500">
                  6 áreas con clasificación Interno/Externo, sistema, estructura, modalidad de
                  avance (Cantidades o Porcentaje), edición y eliminación
                </p>
              </div>
              {canDo('actividades', 'create') && (<button
                disabled={allGalponesList.length === 0}
                onClick={openNewActivityModal}
                className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>+ Agregar Actividad al Galpón</span>
              </button>)}
            </div>

            <div className="bg-white p-3 rounded-2xl border border-slate-200 space-y-2.5">
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <div className="relative flex-1 w-full">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    placeholder="Buscar código, estructura o actividad..."
                    value={searchActText}
                    onChange={(e) => setSearchActText(e.target.value)}
                    className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded-xl text-xs bg-slate-50"
                  />
                </div>
                <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto">
                  {['Todas', ...ALL_AREAS].map((areaKey) => (
                    <button
                      key={areaKey}
                      onClick={() => setFilterActArea(areaKey)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold shrink-0 transition ${
                        filterActArea === areaKey
                          ? 'bg-[#0f6b38] text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {areaKey}
                    </button>
                  ))}
                </div>
              </div>

              {(filterActArea === 'Todas' ||
                AREAS_WITH_SISTEMAS.includes(filterActArea)) && (
                <div className="flex items-center gap-2 pt-1 border-t border-slate-100 text-xs">
                  <span className="font-bold text-slate-500">Ubicación:</span>
                  {(['Todos', 'Interno', 'Externo'] as const).map((loc) => (
                    <button
                      key={loc}
                      onClick={() => setFilterActLocation(loc)}
                      className={`px-2.5 py-1 rounded-lg font-bold ${
                        filterActLocation === loc
                          ? 'bg-emerald-100 text-[#0f6b38]'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {loc}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#0f6b38] text-white font-bold uppercase text-[11px]">
                    <tr>
                      <th className="py-3 px-3">Código</th>
                      <th className="py-3 px-3">Ubicación / Sistema</th>
                      <th className="py-3 px-3">Estructura</th>
                      <th className="py-3 px-3">Actividad</th>
                      <th className="py-3 px-2 text-center">Modalidad</th>
                      <th className="py-3 px-2 text-right">Meta</th>
                      <th className="py-3 px-2 text-right">Avance %</th>
                      <th className="py-3 px-3 text-center">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium">
                    {evaluatedActivities
                      .filter((a) => {
                        if (filterActArea !== 'Todas' && a.areaName !== filterActArea)
                          return false;
                        if (
                          filterActLocation !== 'Todos' &&
                          a.locationType !== filterActLocation
                        )
                          return false;
                        if (
                          searchActText &&
                          !a.name.toLowerCase().includes(searchActText.toLowerCase()) &&
                          !a.code.toLowerCase().includes(searchActText.toLowerCase()) &&
                          !(a.structureName || '')
                            .toLowerCase()
                            .includes(searchActText.toLowerCase())
                        )
                          return false;
                        return true;
                      })
                      .map((act) => {
                        const isPct = act.progressMode === 'percentage';
                        return (
                          <tr key={act.id} className="hover:bg-slate-50">
                            <td className="py-2.5 px-3 font-mono font-bold">
                              {act.code}
                            </td>
                            <td className="py-2.5 px-3">
                              {act.sistemaName
                                ? `${act.locationType} • ${act.sistemaName}`
                                : '-'}
                            </td>
                            <td className="py-2.5 px-3 font-bold text-slate-700">
                              {act.structureName}
                            </td>
                            <td className="py-2.5 px-3 font-bold text-slate-900">
                              {act.name}
                            </td>
                            <td className="py-2.5 px-2 text-center">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                  isPct
                                    ? 'bg-blue-50 text-blue-800 border-blue-200'
                                    : 'bg-emerald-50 text-[#0f6b38] border-emerald-200'
                                }`}
                              >
                                {isPct ? 'Porcentaje (%)' : 'Cantidades'}
                              </span>
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono">
                              {isPct ? '100 %' : `${act.targetUnits} ${act.unit}`}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono font-black text-[#0f6b38]">
                              {act.progressPercent}%
                            </td>
                          <td className="py-2.5 px-3 text-center">
                            <div className="flex items-center justify-center gap-1">
                              {canDo('actividades', 'edit') && (<button
                                onClick={() => setModalEditGalponActivity(act)}
                                className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-200"
                                title="Editar actividad"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>)}
                              {canDo('actividades', 'delete') && (<button
                                onClick={() => requestDeleteGalponActivity(act.id)}
                                className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100"
                                title="Eliminar actividad"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>)}
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 8: CONTROL DE MATERIALES (VINCULADO A GALPÓN Y ESTRUCTURA)   */}
        {/* ================================================================== */}
        {currentTab === 'materiales' && (
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Catálogo y Control de Materiales por Galpón y Estructura
                </h2>
                <p className="text-xs text-slate-500">
                  Cada material queda vinculado a su Galpón, Proveedor, Área, Sistema y
                  Estructura correspondientes
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canDo('materiales', 'export') && (<button
                  type="button"
                  onClick={handleExportMaterialsCSV}
                  className="px-3 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center gap-1.5"
                >
                  <Download className="w-4 h-4 text-[#0f6b38]" />
                  <span>Exportar Materiales (.CSV)</span>
                </button>)}
                {canDo('materiales', 'import') && (<button
                  onClick={() => {
                    setBulkCsvText('');
                    setBulkRawRows([]);
                    setBulkFileName('');
                    setBulkTargetGalponId(currentGalpon?.id || '');
                    if (requirePermission('materiales', 'import')) setModalBulkUpload('materiales');
                  }}
                  className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4 text-[#0f6b38]" />
                  <span>Carga Masiva Excel/CSV</span>
                </button>)}
                {canDo('materiales', 'create') && (<button
                  onClick={openNewMaterialModal}
                  className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] text-white text-xs font-bold flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  <span>+ Asignar / Agregar Material</span>
                </button>)}
              </div>
            </div>

            <div className="bg-white p-3 rounded-2xl border border-slate-200 flex flex-wrap items-center gap-3 text-xs">
              <input
                type="text"
                placeholder="Buscar por código, material, sistema o estructura..."
                value={searchMaterialText}
                onChange={(e) => setSearchMaterialText(e.target.value)}
                className="flex-1 min-w-[200px] px-3 py-1.5 border border-slate-300 rounded-xl bg-slate-50"
              />
              <select
                value={filterMaterialGalpon}
                onChange={(e) => setFilterMaterialGalpon(e.target.value)}
                className="px-3 py-1.5 border border-slate-300 rounded-xl font-bold bg-slate-50"
              >
                <option value="Todos">Todos los Galpones</option>
                <option value="__UNASSIGNED__">Sin galpón asignado</option>
                {allGalponesList.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.sectorName} • {g.code} - {g.name}
                  </option>
                ))}
              </select>
              <select
                value={filterMaterialTech}
                onChange={(e) => setFilterMaterialTech(e.target.value)}
                className="px-3 py-1.5 border border-slate-300 rounded-xl font-bold bg-slate-50"
              >
                <option value="Todas">Todos los Proveedores</option>
                {Array.from(
                  new Set([
                    ...technologies,
                    ...materials.map((m) => m.technology).filter(Boolean)
                  ])
                ).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                value={filterMaterialArea}
                onChange={(e) => setFilterMaterialArea(e.target.value)}
                className="px-3 py-1.5 border border-slate-300 rounded-xl font-bold bg-slate-50"
              >
                <option value="Todas">Todas las Áreas</option>
                {ALL_AREAS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              {(filterMaterialGalpon !== 'Todos' ||
                filterMaterialTech !== 'Todas' ||
                filterMaterialArea !== 'Todas' ||
                searchMaterialText.trim() !== '') && (
                <button
                  type="button"
                  onClick={() => {
                    setFilterMaterialGalpon('Todos');
                    setFilterMaterialTech('Todas');
                    setFilterMaterialArea('Todas');
                    setSearchMaterialText('');
                  }}
                  className="px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold"
                >
                  Mostrar Todos ({materials.length})
                </button>
              )}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#0f6b38] text-white font-bold uppercase text-[11px]">
                    <tr>
                      <th className="py-3 px-3">Galpón</th>
                      <th className="py-3 px-3">Proveedor</th>
                      <th className="py-3 px-3">Código</th>
                      <th className="py-3 px-3">Material</th>
                      <th className="py-3 px-3">Área</th>
                      <th className="py-3 px-3">Sistema</th>
                      <th className="py-3 px-3">Estructura Vinculada</th>
                      <th className="py-3 px-2 text-right">Total Presup.</th>
                      <th className="py-3 px-2 text-right">Consumido</th>
                      <th className="py-3 px-2 text-right">Saldo</th>
                      <th className="py-3 px-3 text-center">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium">
                    {materials.filter((m) => {
                      if (filterMaterialGalpon !== 'Todos') {
                        if (filterMaterialGalpon === '__UNASSIGNED__') {
                          if (m.galponId) return false;
                        } else if (m.galponId !== filterMaterialGalpon) {
                          return false;
                        }
                      }
                      if (
                        filterMaterialTech !== 'Todas' &&
                        m.technology !== filterMaterialTech
                      )
                        return false;
                      if (
                        filterMaterialArea !== 'Todas' &&
                        m.areaName !== filterMaterialArea
                      )
                        return false;
                      if (searchMaterialText.trim()) {
                        const q = searchMaterialText.toLowerCase().trim();
                        const galObj = allGalponesList.find((g) => g.id === m.galponId);
                        const galLabel = galObj
                          ? `${galObj.code} ${galObj.name} ${galObj.sectorName}`.toLowerCase()
                          : 'sin galpón asignado';
                        const matches =
                          (m.code || '').toLowerCase().includes(q) ||
                          (m.name || '').toLowerCase().includes(q) ||
                          (m.structureName || '').toLowerCase().includes(q) ||
                          (m.sistemaName || '').toLowerCase().includes(q) ||
                          (m.areaName || '').toLowerCase().includes(q) ||
                          (m.technology || '').toLowerCase().includes(q) ||
                          galLabel.includes(q);
                        if (!matches) return false;
                      }
                      return true;
                    }).length === 0 ? (
                      <tr>
                        <td colSpan={11} className="py-8 text-center text-slate-400">
                          No hay materiales registrados para este filtro. Usa el botón "+
                          Asignar / Agregar Material" para vincular materiales a tus
                          galpones y estructuras.
                        </td>
                      </tr>
                    ) : (
                      materials
                        .filter((m) => {
                          if (filterMaterialGalpon !== 'Todos') {
                            if (filterMaterialGalpon === '__UNASSIGNED__') {
                              if (m.galponId) return false;
                            } else if (m.galponId !== filterMaterialGalpon) {
                              return false;
                            }
                          }
                          if (
                            filterMaterialTech !== 'Todas' &&
                            m.technology !== filterMaterialTech
                          )
                            return false;
                          if (
                            filterMaterialArea !== 'Todas' &&
                            m.areaName !== filterMaterialArea
                          )
                            return false;
                          if (searchMaterialText.trim()) {
                            const q = searchMaterialText.toLowerCase().trim();
                            const galObj = allGalponesList.find(
                              (g) => g.id === m.galponId
                            );
                            const galLabel = galObj
                              ? `${galObj.code} ${galObj.name} ${galObj.sectorName}`.toLowerCase()
                              : 'sin galpón asignado';
                            const matches =
                              (m.code || '').toLowerCase().includes(q) ||
                              (m.name || '').toLowerCase().includes(q) ||
                              (m.structureName || '').toLowerCase().includes(q) ||
                              (m.sistemaName || '').toLowerCase().includes(q) ||
                              (m.areaName || '').toLowerCase().includes(q) ||
                              (m.technology || '').toLowerCase().includes(q) ||
                              galLabel.includes(q);
                            if (!matches) return false;
                          }
                          return true;
                        })
                        .map((mat) => {
                          const computedUsed = usedMaterialQuantity(mat);
                          const balance =
                            Number(mat.totalQty || 0) - computedUsed;
                          const assignedGalpon = mat.galponId
                            ? allGalponesList.find((g) => g.id === mat.galponId)
                            : null;
                          return (
                            <tr key={mat.id} className="hover:bg-slate-50">
                              <td className="py-2.5 px-3">
                                {assignedGalpon ? (
                                  <div>
                                    <span className="font-bold text-slate-900 block">
                                      {assignedGalpon.code} - {assignedGalpon.name}
                                    </span>
                                    <span className="text-[10px] text-slate-500">
                                      {assignedGalpon.sectorName}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-bold">
                                    Sin galpón asignado
                                  </span>
                                )}
                              </td>
                              <td className="py-2.5 px-3 font-bold text-[#0f6b38]">
                                {mat.technology || '-'}
                              </td>
                              <td className="py-2.5 px-3 font-mono font-bold">
                                {mat.code}
                              </td>
                              <td className="py-2.5 px-3 font-bold text-slate-900">
                                {mat.name}
                              </td>
                              <td className="py-2.5 px-3">{mat.areaName || '-'}</td>
                              <td className="py-2.5 px-3">
                                {mat.sistemaName
                                  ? `${mat.locationType ? `${mat.locationType} • ` : ''}${mat.sistemaName}`
                                  : '-'}
                              </td>
                              <td className="py-2.5 px-3 font-bold text-slate-700">
                                {mat.structureName || '-'}
                              </td>
                              <td className="py-2.5 px-2 text-right font-mono font-bold">
                                {mat.totalQty} {mat.unit}
                              </td>
                              <td className="py-2.5 px-2 text-right font-mono text-amber-700 font-bold">
                                {computedUsed} {mat.unit}
                              </td>
                              <td className="py-2.5 px-2 text-right font-mono font-black text-[#0f6b38]">
                                {balance} {mat.unit}
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  {canDo('materiales', 'edit') && (<button
                                    onClick={() => openEditMaterialModal(mat)}
                                    className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-200"
                                    title="Editar material"
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>)}
                                  {canDo('materiales', 'delete') && (<button
                                    onClick={() => requestDeleteMaterial(mat.id)}
                                    className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100"
                                    title="Eliminar material"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>)}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 9: PLANILLA DE PERSONAL                                      */}
        {/* ================================================================== */}
        {currentTab === 'personal' && (
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Planilla Maestra de Personal
                </h2>
                <p className="text-xs text-slate-500">
                  Ingresa el código manual de empresa, especialidad y asigna el Sector y
                  Galpón
                </p>
              </div>
              <div className="flex items-center gap-2">
                {canDo('personal', 'import') && (<button
                  onClick={() => {
                    setBulkCsvText('');
                    setBulkRawRows([]);
                    setBulkFileName('');
                    setBulkTargetGalponId('');
                    if (requirePermission('personal', 'import')) setModalBulkUpload('personal');
                  }}
                  className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4 text-[#0f6b38]" />
                  <span>Carga Masiva Excel/CSV</span>
                </button>)}
                {canDo('personal', 'create') && (<button
                  onClick={() => {
                    setFormWorker({
                      id: '',
                      workerCode: '',
                      dni: '',
                      name: '',
                      workArea: '',
                      role: '',
                      sectorId: '',
                      galponId: ''
                    });
                    setModalNewWorker(true);
                  }}
                  className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] text-white text-xs font-bold flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  <span>+ Agregar Operario</span>
                </button>)}
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#0f6b38] text-white font-bold uppercase text-[11px]">
                    <tr>
                      <th className="py-3 px-3">Código Empresa</th>
                      <th className="py-3 px-3">DNI</th>
                      <th className="py-3 px-3">Nombre</th>
                      <th className="py-3 px-3">Equipo / Área</th>
                      <th className="py-3 px-3">Cargo</th>
                      <th className="py-3 px-3">Sector</th>
                      <th className="py-3 px-3">Galpón</th>
                      <th className="py-3 px-3">Estado</th>
                      <th className="py-3 px-3 text-center">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium">
                    {masterWorkforce.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-8 text-center text-slate-400">
                          No hay personal registrado en la planilla.
                        </td>
                      </tr>
                    ) : (
                      masterWorkforce
                        .filter(
                          (w) =>
                            !searchWorkerText ||
                            w.name
                              .toLowerCase()
                              .includes(searchWorkerText.toLowerCase()) ||
                            w.workerCode
                              .toLowerCase()
                              .includes(searchWorkerText.toLowerCase())
                        )
                        .map((worker) => {
                          const assignedSector = sectors.find(
                            (s) => s.id === worker.sectorId
                          );
                          const availableGalpones = assignedSector
                            ? assignedSector.galpones || []
                            : [];
                          return (
                            <tr key={worker.id} className="hover:bg-slate-50">
                              <td className="py-2.5 px-3">
                                <input
                                  type="text"
                                  value={worker.workerCode}
                                  onChange={(e) =>
                                    handleWorkerFieldChange(
                                      worker.id,
                                      'workerCode',
                                      e.target.value.toUpperCase()
                                    )
                                  }
                                  className="w-24 px-2 py-1 border border-slate-300 rounded font-mono font-bold text-[#0f6b38] bg-slate-50"
                                />
                              </td>
                              <td className="py-2.5 px-3 font-mono">{worker.dni}</td>
                              <td className="py-2.5 px-3 font-bold text-slate-900">
                                {worker.name || 'Dato inválido'}
                              </td>
                              <td className="py-2.5 px-3">
                                <select
                                  value={worker.workArea || ''}
                                  onChange={(e) =>
                                    handleWorkerFieldChange(
                                      worker.id,
                                      'workArea',
                                      e.target.value
                                    )
                                  }
                                  className="px-2 py-1 border border-slate-300 rounded font-bold bg-slate-50"
                                >
                                  <option value="">Sin especialidad</option>
                                  {WORK_SPECIALTIES.map((sp) => (
                                    <option key={sp} value={sp}>
                                      {sp}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="py-2.5 px-3">{worker.role || 'Sin cargo'}</td>
                              <td className="py-2.5 px-3">
                                <select
                                  value={worker.sectorId || ''}
                                  onChange={(e) =>
                                    handleWorkerSectorChange(worker.id, e.target.value)
                                  }
                                  className="px-2 py-1 border border-slate-300 rounded bg-slate-50"
                                >
                                  <option value="">Sin Sector</option>
                                  {sectors.map((sec) => (
                                    <option key={sec.id} value={sec.id}>
                                      {sec.name}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="py-2.5 px-3">
                                <select
                                  value={worker.galponId || ''}
                                  onChange={(e) =>
                                    handleWorkerFieldChange(
                                      worker.id,
                                      'galponId',
                                      e.target.value
                                    )
                                  }
                                  className="px-2 py-1 border border-slate-300 rounded bg-emerald-50 text-[#0f6b38] font-bold"
                                >
                                  <option value="">Sin Galpón</option>
                                  {availableGalpones.map((gal: any) => (
                                    <option key={gal.id} value={gal.id}>
                                      {gal.code}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="py-2.5 px-3">
                                <label className="inline-flex items-center gap-2">
                                  <input type="checkbox" checked={worker.active} disabled={!canDo('personal', 'edit')}
                                    aria-label={'Operario activo ' + worker.name}
                                    onChange={event => handleWorkerFieldChange(worker.id, 'active', event.target.checked)} />
                                  {worker.active ? 'Activo' : 'Inactivo'}
                                </label>
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                {canDo('personal', 'delete') && (<button
                                  onClick={() => requestDeleteWorker(worker.id)}
                                  className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100"
                                  title="Eliminar operario"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>)}
                              </td>
                            </tr>
                          );
                        })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 10: INFORMES GLOBALES (INTERACTIVO MULTIPROYECTO)            */}
        {/* ================================================================== */}
        {currentTab === 'informes' && (
          <div className="space-y-4">
            <label className="block text-xs font-semibold text-slate-700">
              Proyecto
              <select className="ml-2 rounded border border-slate-300 p-1" value={filterInformesProject}
                onChange={event => { setFilterInformesProject(event.target.value); setInformesPage(1); }}>
                <option value="ALL">Todos</option>
                {[...new Set(allGlobalReportRows.map(row => row.projectName))].sort().map(project =>
                  <option key={project}>{project}</option>)}
              </select>
            </label>
            <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="Resumen operativo">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold">Personal, asistencia e inventario por galpón</h3>
                <label className="text-xs">Asistencia del día <input type="date" value={attendanceDate}
                  onChange={event => setAttendanceDate(event.target.value)} className="rounded border p-1" /></label>
                {canDo('informes', 'export') && <button type="button" className="rounded-lg bg-slate-100 p-2 text-xs font-bold"
                  onClick={() => { if (requirePermission('informes', 'export')) downloadCsvFile(
                    'Resumen_operativo_' + attendanceDate + '.csv', fieldHeaders, fieldRows.map(fieldValues)); }}>
                  Exportar resumen CSV
                </button>}
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead><tr>{fieldHeaders.map(header => <th key={header} className="p-2">{header}</th>)}</tr></thead>
                  <tbody>{fieldRows.map(row => <tr key={row.id} className="border-t">
                    {fieldValues(row).map((value, index) => <td key={index} className="p-2">{value}</td>)}
                  </tr>)}</tbody>
                </table>
                {!fieldRows.length && <p className="p-2 text-xs text-slate-500">No hay galpones para estos filtros.</p>}
              </div>
            </section>


            {/* Cabecera Principal y Botones de Exportación */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4 shadow-xs">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-black text-slate-900">
                    Informes Globales Multiproyecto
                  </h2>
                  <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-[#0f6b38] text-[11px] font-black uppercase">
                    Tabla Interactiva
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Visualización consolidada y exportación con paridad matemática total con Dashboard y Carta Gantt
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {canDo('informes', 'export') && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleExportGlobalCSV(true)}
                      className="px-3 py-2 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-bold rounded-xl flex items-center gap-1.5 shadow-xs transition"
                      title="Exportar en formato CSV los registros filtrados"
                    >
                      <Download className="w-4 h-4 text-[#0f6b38]" />
                      <span>CSV Filtrados ({filteredGlobalReportRows.length})</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportGlobalXLSX(true)}
                      className="px-3 py-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-[#0f6b38] text-xs font-bold rounded-xl flex items-center gap-1.5 shadow-xs transition"
                      title="Exportar en formato Excel (.xlsx) los registros filtrados"
                    >
                      <FileSpreadsheet className="w-4 h-4 text-[#0f6b38]" />
                      <span>Excel Filtrados (.XLSX)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportGlobalCSV(false)}
                      className="px-3.5 py-2 bg-[#0f6b38] hover:bg-[#0a4e28] text-white text-xs font-bold rounded-xl flex items-center gap-1.5 shadow-xs transition"
                      title="Exportar todos los registros en CSV"
                    >
                      <Download className="w-4 h-4" />
                      <span>Sábana Completa (.CSV)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportGlobalXLSX(false)}
                      className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl flex items-center gap-1.5 shadow-xs transition"
                      title="Exportar todos los registros en libro Excel (.xlsx)"
                    >
                      <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                      <span>Sábana Excel (.XLSX)</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Tarjetas de Métricas Resumen (KPIs Dinámicos) */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              <div className="bg-white p-3.5 rounded-xl border border-slate-200">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                  Actividades
                </span>
                <span className="text-xl font-black text-slate-900 font-mono">
                  {informesMetrics.total}
                </span>
                <span className="text-[10px] text-slate-400 block mt-0.5">
                  en vista actual
                </span>
              </div>

              <div className="bg-white p-3.5 rounded-xl border border-emerald-200 bg-emerald-50/30">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#0f6b38] block">
                  Completadas
                </span>
                <span className="text-xl font-black text-[#0f6b38] font-mono">
                  {informesMetrics.completed}
                </span>
                <span className="text-[10px] font-semibold text-emerald-700 block mt-0.5">
                  {informesMetrics.total > 0
                    ? `${((informesMetrics.completed / informesMetrics.total) * 100).toFixed(0)}% del total`
                    : '0%'}
                </span>
              </div>

              <div className="bg-white p-3.5 rounded-xl border border-blue-200 bg-blue-50/30">
                <span className="text-[10px] font-bold uppercase tracking-wider text-blue-700 block">
                  En Proceso
                </span>
                <span className="text-xl font-black text-blue-700 font-mono">
                  {informesMetrics.inProgress}
                </span>
                <span className="text-[10px] font-semibold text-blue-600 block mt-0.5">
                  en ejecución
                </span>
              </div>

              <div className="bg-white p-3.5 rounded-xl border border-amber-200 bg-amber-50/30">
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 block">
                  No Iniciadas
                </span>
                <span className="text-xl font-black text-amber-700 font-mono">
                  {informesMetrics.notStarted}
                </span>
                <span className="text-[10px] font-semibold text-amber-600 block mt-0.5">
                  pendientes
                </span>
              </div>

              <div className="bg-white p-3.5 rounded-xl border border-rose-200 bg-rose-50/30">
                <span className="text-[10px] font-bold uppercase tracking-wider text-rose-700 block">
                  Atrasadas
                </span>
                <span className="text-xl font-black text-rose-700 font-mono">
                  {informesMetrics.delayed}
                </span>
                <span className="text-[10px] font-semibold text-rose-600 block mt-0.5">
                  requieren atención
                </span>
              </div>

              <div className="bg-white p-3.5 rounded-xl border border-slate-200">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                  Avance Ponderado
                </span>
                <span className="text-xl font-black text-slate-900 font-mono">
                  {informesMetrics.weightedProgress}%
                </span>
                <span className="text-[10px] text-slate-500 block mt-0.5">
                  según ponderación
                </span>
              </div>

              <div className="bg-white p-3.5 rounded-xl border border-slate-200 col-span-2 sm:col-span-2 lg:col-span-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                  Horas Hombre
                </span>
                <div className="flex items-baseline gap-1">
                  <span className="text-lg font-black text-slate-900 font-mono">
                    {informesMetrics.accumulatedHH.toLocaleString()}
                  </span>
                  <span className="text-xs text-slate-400 font-bold">
                    / {informesMetrics.plannedHH.toLocaleString()}
                  </span>
                </div>
                <span className="text-[10px] text-slate-500 block mt-0.5">
                  HH Ejec / Plan
                </span>
              </div>
            </div>

            {/* Barra de Filtros Interactivos */}
            <div className="bg-white p-4 rounded-2xl border border-slate-200 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-2">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-slate-500" />
                  <span className="text-xs font-bold text-slate-700">Filtros de Búsqueda y Segmentación</span>
                </div>
                {(filterInformesSectorId !== 'ALL' ||
                  filterInformesGalponId !== 'ALL' ||
                  filterInformesAreaName !== 'ALL' ||
                  filterInformesSistemaName !== 'ALL' ||
                  filterInformesMode !== 'ALL' ||
                  filterInformesStatus !== 'ALL' ||
                  searchInformesText.trim() !== '') && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilterInformesSectorId('ALL');
                      setFilterInformesGalponId('ALL');
                      setFilterInformesAreaName('ALL');
                      setFilterInformesSistemaName('ALL');
                      setFilterInformesMode('ALL');
                      setFilterInformesStatus('ALL');
                      setSearchInformesText('');
                      setInformesPage(1);
                    }}
                    className="text-xs font-bold text-[#0f6b38] hover:underline flex items-center gap-1"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Restablecer Filtros</span>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 text-xs">
                {/* Búsqueda de Texto */}
                <div className="lg:col-span-2 relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-400" />
                  <input
                    type="text"
                    value={searchInformesText}
                    onChange={(e) => {
                      setSearchInformesText(e.target.value);
                      setInformesPage(1);
                    }}
                    placeholder="Buscar código, actividad, estructura..."
                    className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-300 rounded-xl focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-[#0f6b38] text-xs font-medium"
                  />
                </div>

                {/* Filtro: Sector */}
                <div>
                  <select
                    value={filterInformesSectorId}
                    onChange={(e) => {
                      setFilterInformesSectorId(e.target.value);
                      setFilterInformesGalponId('ALL');
                      setInformesPage(1);
                    }}
                    className="w-full px-2.5 py-2 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:bg-white text-xs"
                  >
                    <option value="ALL">Sector: Todos</option>
                    {sectors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Filtro: Galpón */}
                <div>
                  <select
                    value={filterInformesGalponId}
                    onChange={(e) => {
                      setFilterInformesGalponId(e.target.value);
                      setInformesPage(1);
                    }}
                    className="w-full px-2.5 py-2 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:bg-white text-xs"
                  >
                    <option value="ALL">Galpón: Todos</option>
                    {informesGalponesOptions.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.code} ({g.sectorName})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Filtro: Área */}
                <div>
                  <select
                    value={filterInformesAreaName}
                    onChange={(e) => {
                      setFilterInformesAreaName(e.target.value);
                      setInformesPage(1);
                    }}
                    className="w-full px-2.5 py-2 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:bg-white text-xs"
                  >
                    <option value="ALL">Área: Todas</option>
                    {uniqueInformesAreas.map((area) => (
                      <option key={area} value={area}>
                        {area}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Filtro: Sistema */}
                <div>
                  <select
                    value={filterInformesSistemaName}
                    onChange={(e) => {
                      setFilterInformesSistemaName(e.target.value);
                      setInformesPage(1);
                    }}
                    className="w-full px-2.5 py-2 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:bg-white text-xs"
                  >
                    <option value="ALL">Sistema: Todos</option>
                    {uniqueInformesSistemas.map((sis) => (
                      <option key={sis} value={sis}>
                        {sis}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Filtro: Modalidad */}
                <div>
                  <select
                    value={filterInformesMode}
                    onChange={(e) => {
                      setFilterInformesMode(e.target.value);
                      setInformesPage(1);
                    }}
                    className="w-full px-2.5 py-2 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:bg-white text-xs"
                  >
                    <option value="ALL">Modalidad: Todas</option>
                    <option value="quantity">Cantidades</option>
                    <option value="percentage">Porcentaje</option>
                  </select>
                </div>

                {/* Filtro: Estado */}
                <div>
                  <select
                    value={filterInformesStatus}
                    onChange={(e) => {
                      setFilterInformesStatus(e.target.value);
                      setInformesPage(1);
                    }}
                    className="w-full px-2.5 py-2 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:bg-white text-xs"
                  >
                    <option value="ALL">Estado: Todos</option>
                    <option value="Completado">Completada</option>
                    <option value="En proceso">En proceso</option>
                    <option value="No iniciado">Pendiente / No iniciada</option>
                    <option value="Atrasado">Atrasada / Alerta</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Tabla Resumen Interactiva */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-50 text-slate-600 uppercase text-[11px] font-extrabold border-b border-slate-200">
                    <tr>
                      <th className="py-3 px-3">Proyecto</th>
                      <th className="py-3 px-3">Sector</th>
                      <th className="py-3 px-3">Galpón</th>
                      <th className="py-3 px-3">Área</th>
                      <th className="py-3 px-3">Sistema</th>
                      <th className="py-3 px-3">Estructura</th>
                      <th className="py-3 px-3">Actividad</th>
                      <th className="py-3 px-3">Modalidad</th>
                      <th className="py-3 px-3 text-right">Meta</th>
                      <th className="py-3 px-3 text-right">Ejecutado</th>
                      <th className="py-3 px-3 text-center min-w-[120px]">Avance %</th>
                      <th className="py-3 px-3 text-center">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginatedInformesRows.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="py-12 text-center text-slate-400">
                          <Table className="w-8 h-8 mx-auto mb-2 opacity-40" />
                          <p className="font-bold text-sm">No se encontraron actividades</p>
                          <p className="text-xs mt-0.5">
                            Modifica los criterios de filtro o la búsqueda para ver resultados
                          </p>
                        </td>
                      </tr>
                    ) : (
                      paginatedInformesRows.map((row) => (
                        <tr key={row.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-2.5 px-3 text-slate-500 font-medium whitespace-nowrap">
                            {row.projectName}
                          </td>
                          <td className="py-2.5 px-3 font-semibold text-slate-800 whitespace-nowrap">
                            {row.sectorName}
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <span className="font-mono font-bold text-slate-900 bg-slate-100 px-2 py-0.5 rounded-md">
                              {row.galponCode}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-slate-700 font-medium whitespace-nowrap">
                            {row.areaName}
                          </td>
                          <td className="py-2.5 px-3 text-slate-500 whitespace-nowrap">
                            {row.sistemaName}
                          </td>
                          <td className="py-2.5 px-3 text-slate-700 font-semibold whitespace-nowrap">
                            {row.structureName || '-'}
                          </td>
                          <td className="py-2.5 px-3 max-w-[260px]">
                            <div className="flex flex-col">
                              <span className="font-mono font-bold text-[#0f6b38] text-[11px]">
                                {row.activityCode}
                              </span>
                              <span className="font-semibold text-slate-900 truncate" title={row.activityName}>
                                {row.activityName}
                              </span>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                                row.progressMode === 'percentage'
                                  ? 'bg-indigo-100 text-indigo-700'
                                  : 'bg-emerald-100 text-[#0f6b38]'
                              }`}
                            >
                              {row.progressModeLabel}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-700 whitespace-nowrap">
                            {row.targetUnits.toLocaleString()} {row.unit}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900 whitespace-nowrap">
                            {row.accumulatedQty.toLocaleString()} {row.unit}
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 bg-slate-100 h-2 rounded-full overflow-hidden min-w-[60px]">
                                <div
                                  className={`h-full transition-all ${
                                    row.progressPercent >= 100
                                      ? 'bg-emerald-500'
                                      : row.progressPercent > 0
                                        ? 'bg-blue-500'
                                        : 'bg-slate-300'
                                  }`}
                                  style={{ width: `${Math.min(row.progressPercent, 100)}%` }}
                                />
                              </div>
                              <span className="font-mono font-bold text-xs text-slate-800 w-11 text-right">
                                {row.progressPercent}%
                              </span>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-center whitespace-nowrap">
                            <span
                              className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${
                                row.computedStatus === 'Completado'
                                  ? 'bg-emerald-100 text-[#0f6b38]'
                                  : row.computedStatus === 'En proceso'
                                    ? 'bg-blue-100 text-blue-700'
                                    : row.computedStatus === 'Atrasado'
                                      ? 'bg-rose-100 text-rose-700'
                                      : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {row.computedStatus}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Barra de Paginación y Resumen de Filas */}
              {filteredGlobalReportRows.length > 0 && (
                <div className="p-3 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
                  <div className="flex items-center gap-2">
                    <span>Filas por página:</span>
                    <select
                      value={informesPageSize}
                      onChange={(e) => {
                        setInformesPageSize(Number(e.target.value));
                        setInformesPage(1);
                      }}
                      className="px-2 py-1 bg-white border border-slate-300 rounded-lg font-bold text-xs"
                    >
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={0}>Todas ({filteredGlobalReportRows.length})</option>
                    </select>
                    <span className="text-slate-400">|</span>
                    <span>
                      Mostrando {informesPageSize > 0 ? (informesPage - 1) * informesPageSize + 1 : 1} a{' '}
                      {informesPageSize > 0
                        ? Math.min(informesPage * informesPageSize, filteredGlobalReportRows.length)
                        : filteredGlobalReportRows.length}{' '}
                      de {filteredGlobalReportRows.length} actividades
                    </span>
                  </div>

                  {informesPageSize > 0 && totalInformesPages > 1 && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={informesPage <= 1}
                        onClick={() => setInformesPage((p) => Math.max(1, p - 1))}
                        className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 font-bold text-xs"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                        <span>Anterior</span>
                      </button>
                      <span className="px-2 font-mono font-bold">
                        {informesPage} / {totalInformesPages}
                      </span>
                      <button
                        type="button"
                        disabled={informesPage >= totalInformesPages}
                        onClick={() => setInformesPage((p) => Math.min(totalInformesPages, p + 1))}
                        className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 font-bold text-xs"
                      >
                        <span>Siguiente</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 11: HISTORIAL DE MOVIMIENTOS DE USUARIOS (BITÁCORA)          */}
        {/* ================================================================== */}
        {currentTab === 'movimientos' && (
          <div className="space-y-4">
            <div className="bg-white p-5 rounded-2xl border border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Historial de Movimientos de Usuarios (Bitácora de Auditoría)
                </h2>
                <p className="text-xs text-slate-500">
                  Registro automático de todos los registros (altas), modificaciones y
                  eliminaciones realizados en el sistema
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs">
                <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-300">
                  <span className="font-bold text-slate-600">Usuario Autenticado:</span>
                  <span className="bg-white px-2.5 py-1 rounded-lg border border-slate-200 font-bold text-[#0f6b38]">
                    {profile?.displayName || activeUserName} ({profile?.role || 'Autenticado'})
                  </span>
                </div>
                {canDo('movimientos', 'import') && (
                  <label className="rounded-lg border border-slate-300 px-3 py-2 font-bold">
                    Importar historial (CSV o Excel)
                    <input type="file" accept=".csv,.xlsx" className="block max-w-[220px] text-xs"
                      disabled={movementImport.busy || !isNetworkOnline} onChange={handleImportMovements} />
                    {movementImport.message && <span role="status" className="block mt-1 max-w-xs">{movementImport.message}</span>}
                  </label>
                )}
                {canDo('movimientos', 'export') && (
                  <button
                    type="button"
                    onClick={handleExportMovementsCSV}
                    className="px-3.5 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] text-white font-bold flex items-center gap-1.5"
                  >
                    <Download className="w-4 h-4" />
                    <span>Exportar Bitácora (.CSV)</span>
                  </button>
                )}
              </div>
            </div>

            {/* Resumen de Contadores de Movimientos */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-white p-4 rounded-2xl border border-slate-200">
                <span className="text-[11px] font-bold uppercase text-slate-400 block">
                  Total Movimientos
                </span>
                <span className="text-2xl font-black text-slate-900 font-mono">
                  {auditLogs.length}
                </span>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-emerald-200 bg-emerald-50/40">
                <span className="text-[11px] font-bold uppercase text-[#0f6b38] block">
                  Registros (Altas)
                </span>
                <span className="text-2xl font-black text-[#0f6b38] font-mono">
                  {auditLogs.filter((l) => l.action === 'REGISTRO').length}
                </span>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-amber-200 bg-amber-50/40">
                <span className="text-[11px] font-bold uppercase text-amber-700 block">
                  Modificaciones
                </span>
                <span className="text-2xl font-black text-amber-700 font-mono">
                  {auditLogs.filter((l) => l.action === 'MODIFICACIÓN').length}
                </span>
              </div>
              <div className="bg-white p-4 rounded-2xl border border-rose-200 bg-rose-50/40">
                <span className="text-[11px] font-bold uppercase text-rose-700 block">
                  Eliminaciones
                </span>
                <span className="text-2xl font-black text-rose-700 font-mono">
                  {auditLogs.filter((l) => l.action === 'ELIMINACIÓN').length}
                </span>
              </div>
            </div>

            {/* Filtros de Movimientos */}
            <div className="bg-white p-4 rounded-2xl border border-slate-200 flex flex-wrap items-center gap-3 text-xs">
              <select
                value={filterLogAction}
                onChange={(e) => { setFilterLogAction(e.target.value); setMovementPage(1); }}
                className="px-3 py-2 border border-slate-300 rounded-xl font-bold bg-slate-50"
              >
                <option value="Todas">Todas las Acciones</option>
                <option value="REGISTRO">Solo REGISTROS</option>
                <option value="MODIFICACIÓN">Solo MODIFICACIONES</option>
                <option value="ELIMINACIÓN">Solo ELIMINACIONES</option>
              </select>

              <select
                value={filterLogModule}
                onChange={(e) => { setFilterLogModule(e.target.value); setMovementPage(1); }}
                className="px-3 py-2 border border-slate-300 rounded-xl font-bold bg-slate-50"
              >
                <option value="Todos">Todos los Módulos</option>
                {movementModules.map(module => <option key={module} value={module}>{module}</option>)}
              </select>

              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Buscar por detalle, código, galpón o usuario..."
                  value={searchLogText}
                  onChange={(e) => { setSearchLogText(e.target.value); setMovementPage(1); }}
                  className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-xl bg-slate-50"
                />
              </div>
            </div>

            {/* Tabla de Bitácora */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#0f6b38] text-white font-bold uppercase text-[11px]">
                    <tr>
                      <th className="py-3 px-3">Fecha y Hora</th>
                      <th className="py-3 px-3">Usuario</th>
                      <th className="py-3 px-3">Tipo de Movimiento</th>
                      <th className="py-3 px-3">Módulo</th>
                      <th className="py-3 px-3">Detalle del Movimiento</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium">
                    {visibleMovements.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-400">
                          No hay movimientos registrados que coincidan con el filtro.
                        </td>
                      </tr>
                    ) : (
                      visibleMovements.slice(movementPageStart, movementPageStart + MOVEMENTS_PAGE_SIZE)
                        .map((log) => (
                          <tr key={log.id} className="hover:bg-slate-50">
                            <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                              {log.timestamp}
                            </td>
                            <td className="py-2.5 px-3 font-bold text-slate-800 whitespace-nowrap">
                              {log.user}
                            </td>
                            <td className="py-2.5 px-3 whitespace-nowrap">
                              <span
                                className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase ${
                                  log.action === 'REGISTRO'
                                    ? 'bg-emerald-100 text-[#0f6b38] border border-emerald-300'
                                    : log.action === 'MODIFICACIÓN'
                                      ? 'bg-amber-100 text-amber-800 border border-amber-300'
                                      : 'bg-rose-100 text-rose-700 border border-rose-300'
                                }`}
                              >
                                {log.action}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 font-bold text-slate-700 whitespace-nowrap">
                              {log.module}
                            </td>
                            <td className="py-2.5 px-3 text-slate-800">
                              {log.description}
                              {[log.projectCode, log.sectorId, log.galponId].some(Boolean) && (
                                <p className="mt-0.5 break-all text-[11px] text-slate-600">
                                  {[log.projectCode, log.sectorId, log.galponId].filter(Boolean).join(' · ')}
                                </p>
                              )}
                              {log.requestId && <p className="break-all font-mono text-[11px] text-slate-600">{log.requestId}</p>}
                            </td>
                          </tr>
                        ))
                    )}
                  </tbody>
                </table>
              </div>
              {movementPageCount > 1 && <div className="flex items-center justify-between gap-2 p-3 text-xs">
                <button type="button" disabled={visibleMovementPage <= 1} className="rounded border px-2 py-1"
                  onClick={() => setMovementPage(visibleMovementPage - 1)}>Anterior</button>
                <span>Página {visibleMovementPage} de {movementPageCount}</span>
                <button type="button" disabled={visibleMovementPage >= movementPageCount} className="rounded border px-2 py-1"
                  onClick={() => setMovementPage(visibleMovementPage + 1)}>Siguiente</button>
              </div>}
            </div>
          </div>
        )}
      </main>

      {/* ==================================================================== */}
      {/* 5. BARRA DE NAVEGACIÓN INFERIOR FIJA — PC, TABLET Y CELULAR          */}
      {/*    Única navegación para Dashboard, Gantt, Avance y Asistencia       */}
      {/* ==================================================================== */}
      <nav
        data-testid="bottom-navigation-bar"
        className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-slate-200 shadow-[0_-2px_10px_rgba(15,23,42,0.05)]"
      >
        <div className="max-w-5xl mx-auto grid grid-cols-4 px-2 sm:px-6 py-1.5 gap-1">
          {canDo('dashboard', 'view') && (<button
            type="button"
            data-testid="bottom-nav-dashboard"
            onClick={() => {
              setSidebarOpen(false);
              setCurrentTab('dashboard');
            }}
            className={`relative flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2 px-2 rounded-xl text-[11px] sm:text-xs font-bold transition cursor-pointer ${
              currentTab === 'dashboard'
                ? 'bg-emerald-50/90 text-[#0f6b38]'
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            {currentTab === 'dashboard' && (
              <span className="absolute top-0 left-4 right-4 h-0.5 rounded-full bg-[#0f6b38]" />
            )}
            <BarChart3 className="w-5 h-5 shrink-0" />
            <span>Dashboard</span>
          </button>)}

          {canDo('gantt', 'view') && (<button
            type="button"
            data-testid="bottom-nav-gantt"
            onClick={() => {
              setSidebarOpen(false);
              setCurrentTab('gantt');
            }}
            className={`relative flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2 px-2 rounded-xl text-[11px] sm:text-xs font-bold transition cursor-pointer ${
              currentTab === 'gantt'
                ? 'bg-emerald-50/90 text-[#0f6b38]'
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            {currentTab === 'gantt' && (
              <span className="absolute top-0 left-4 right-4 h-0.5 rounded-full bg-[#0f6b38]" />
            )}
            <Layers className="w-5 h-5 shrink-0" />
            <span>Gantt</span>
          </button>)}

          {canDo('avance_diario', 'view') && (<button
            type="button"
            data-testid="bottom-nav-avance"
            onClick={() => {
              setSidebarOpen(false);
              setCurrentTab('avance_diario');
            }}
            className={`relative flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2 px-2 rounded-xl text-[11px] sm:text-xs font-bold transition cursor-pointer ${
              currentTab === 'avance_diario'
                ? 'bg-emerald-50/90 text-[#0f6b38]'
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            {currentTab === 'avance_diario' && (
              <span className="absolute top-0 left-4 right-4 h-0.5 rounded-full bg-[#0f6b38]" />
            )}
            <TrendingUp className="w-5 h-5 shrink-0" />
            <span>Avance</span>
          </button>)}

          {canDo('asistencia', 'view') && (<button
            type="button"
            data-testid="bottom-nav-asistencia"
            onClick={() => {
              setSidebarOpen(false);
              setCurrentTab('asistencia');
            }}
            className={`relative flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2 px-2 rounded-xl text-[11px] sm:text-xs font-bold transition cursor-pointer ${
              currentTab === 'asistencia'
                ? 'bg-emerald-50/90 text-[#0f6b38]'
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
            }`}
          >
            {currentTab === 'asistencia' && (
              <span className="absolute top-0 left-4 right-4 h-0.5 rounded-full bg-[#0f6b38]" />
            )}
            <Users className="w-5 h-5 shrink-0" />
            <span>Asistencia</span>
          </button>)}
        </div>
      </nav>

      {/* ==================================================================== */}
      {/* 6. MODALES COMPLETOS                                                 */}
      {/* ==================================================================== */}

      {/* MODAL: GESTIONAR PLANTILLAS / PROVEEDORES */}
      {modalManageTemplates && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md border border-slate-200 shadow-2xl">
            <h3 className="text-base font-black text-slate-900 mb-1">
              Gestionar Plantillas / Proveedores
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              Escribe un nombre para agregar una plantilla o duplicar una existente.
            </p>

            <form onSubmit={handleAddTemplateProvider} className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="Nombre de nueva plantilla / proveedor..."
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
                className="flex-1 px-3 py-2 border border-slate-300 rounded-xl text-xs"
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-[#0f6b38] text-white text-xs font-bold"
              >
                + Agregar
              </button>
            </form>
            {templateCopyError && <p role="alert" className="mb-3 text-xs text-rose-700">{templateCopyError}</p>}

            <div className="space-y-2 max-h-60 overflow-y-auto mb-4">
              {technologies.map((tech, idx) => (
                <div
                  key={tech}
                  className="p-2.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-2 text-xs"
                >
                  {editingTemplateIndex === idx ? (
                    <div className="flex items-center gap-2 flex-1">
                      <input
                        type="text"
                        value={editingTemplateValue}
                        onChange={(e) => setEditingTemplateValue(e.target.value)}
                        className="flex-1 px-2 py-1 border border-slate-300 rounded font-bold bg-white"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveRenameTemplate(idx)}
                        className="px-2.5 py-1 rounded bg-[#0f6b38] text-white font-bold"
                      >
                        Guardar
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="font-bold text-slate-800">{tech}</span>
                      <div className="flex items-center gap-1">
                        {canDo('catalogo', 'create') && <button type="button" title={'Duplicar plantilla ' + tech}
                          disabled={templateCopyBusy} onClick={() => void handleDuplicateTemplate(tech)}
                          className="rounded p-1.5 font-semibold text-slate-700 hover:bg-slate-200">Duplicar</button>}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingTemplateIndex(idx);
                            setEditingTemplateValue(tech);
                          }}
                          className="p-1.5 rounded hover:bg-slate-200 text-slate-600"
                          title="Renombrar plantilla"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        {canDo('catalogo', 'delete') && (<button
                          type="button"
                          onClick={() => requestDeleteTemplateProvider(tech)}
                          className="p-1.5 rounded hover:bg-rose-100 text-rose-600"
                          title="Eliminar plantilla"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>)}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setModalManageTemplates(false)}
                className="px-4 py-2 rounded-xl bg-slate-200 text-slate-800 text-xs font-bold"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: CREAR / EDITAR ITEM DEL CATÁLOGO MAESTRO */}
      {modalNewCatalogItem && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg border border-slate-200 shadow-2xl my-8">
            <h3 className="text-base font-black text-slate-900 mb-1">
              {editingCatalogId
                ? 'Editar Actividad del Catálogo Maestro'
                : 'Nueva Actividad en el Catálogo Maestro'}
            </h3>
            <form onSubmit={handleSaveCatalogItem} className="space-y-3 text-xs mt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Plantilla / Proveedor: *
                  </label>
                  <select
                    required
                    value={formCatalogItem.technology}
                    onChange={(e) =>
                      setFormCatalogItem({
                        ...formCatalogItem,
                        technology: e.target.value
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold text-[#0f6b38]"
                  >
                    <option value="">-- Seleccionar Proveedor --</option>
                    {technologies.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Código: *</label>
                  <input
                    type="text"
                    required
                    placeholder="Ej. JAU-001"
                    value={formCatalogItem.code}
                    onChange={(e) =>
                      setFormCatalogItem({ ...formCatalogItem, code: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Área: *</label>
                  <select
                    required
                    value={formCatalogItem.areaName}
                    onChange={(e) =>
                      setFormCatalogItem({
                        ...formCatalogItem,
                        areaName: e.target.value,
                        sistemaName: '',
                        structureName: ''
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  >
                    <option value="">-- Seleccionar Área --</option>
                    {Array.from(new Set([...ALL_AREAS, ...availableAssignCatalogAreas])).map(
                      (a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      )
                    )}
                  </select>
                </div>
                {AREAS_WITH_SISTEMAS.includes(formCatalogItem.areaName) && (
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">
                      Ubicación: *
                    </label>
                    <select
                      required
                      value={formCatalogItem.locationType}
                      onChange={(e) =>
                        setFormCatalogItem({
                          ...formCatalogItem,
                          locationType: e.target.value
                        })
                      }
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                    >
                      <option value="">-- Seleccionar Ubicación --</option>
                      <option value="Interno">Interno</option>
                      <option value="Externo">Externo</option>
                    </select>
                  </div>
                )}
              </div>

              {AREAS_WITH_SISTEMAS.includes(formCatalogItem.areaName) && (
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Sistema:</label>
                  <select
                    value={formCatalogItem.sistemaName}
                    onChange={(e) =>
                      setFormCatalogItem({
                        ...formCatalogItem,
                        sistemaName: e.target.value,
                        customSistemaName: '',
                        structureName: '',
                        customStructureName: ''
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold mb-1.5"
                  >
                    <option value="">-- Seleccionar Sistema --</option>
                    {Array.from(
                      new Set(
                        activeMasterCatalog
                          .filter((c) => c.areaName === formCatalogItem.areaName)
                          .map((c) => c.sistemaName)
                          .filter(Boolean)
                      )
                    ).map((sName: any) => (
                      <option key={sName} value={sName}>
                        {sName}
                      </option>
                    ))}
                    <option value="__NEW__">+ Crear Nuevo Sistema...</option>
                  </select>
                  {formCatalogItem.sistemaName === '__NEW__' && (
                    <input
                      type="text"
                      placeholder="Escribe el nombre del nuevo sistema..."
                      value={formCatalogItem.customSistemaName}
                      onChange={(e) =>
                        setFormCatalogItem({
                          ...formCatalogItem,
                          customSistemaName: e.target.value
                        })
                      }
                      className="w-full px-3 py-2 rounded-xl border border-emerald-400 bg-emerald-50/40 font-bold"
                    />
                  )}
                </div>
              )}

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Estructura: *
                </label>
                <select
                  required
                  value={formCatalogItem.structureName}
                  onChange={(e) =>
                    setFormCatalogItem({
                      ...formCatalogItem,
                      structureName: e.target.value
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold mb-1.5"
                >
                  <option value="">-- Seleccionar Estructura --</option>
                  {availableCatalogEditorStructures.map((stName) => (
                    <option key={stName} value={stName}>
                      {stName}
                    </option>
                  ))}
                  <option value="__NEW__">+ Crear Nueva Estructura...</option>
                </select>
                {formCatalogItem.structureName === '__NEW__' && (
                  <input
                    type="text"
                    placeholder="Escribe el nombre de la nueva estructura..."
                    value={formCatalogItem.customStructureName}
                    onChange={(e) =>
                      setFormCatalogItem({
                        ...formCatalogItem,
                        customStructureName: e.target.value
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-emerald-400 bg-emerald-50/40 font-bold"
                  />
                )}
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Nombre de la Actividad: *
                </label>
                <input
                  type="text"
                  required
                  value={formCatalogItem.name}
                  onChange={(e) =>
                    setFormCatalogItem({ ...formCatalogItem, name: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                />
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <label className="block font-bold text-slate-800 mb-1">
                  Modalidad de Registro del Avance: *
                </label>
                <select
                  value={formCatalogItem.progressMode}
                  onChange={(e) => {
                    const nextMode = e.target.value as ProgressModality;
                    setFormCatalogItem({
                      ...formCatalogItem,
                      progressMode: nextMode,
                      targetUnits:
                        nextMode === 'percentage' ? '100' : formCatalogItem.targetUnits,
                      unit: nextMode === 'percentage' ? '%' : formCatalogItem.unit
                    });
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white font-bold text-[#0f6b38]"
                >
                  <option value="quantity">
                    Avance por Cantidades (Predeterminado: Meta numérica + Unidad)
                  </option>
                  <option value="percentage">
                    Avance por Porcentaje (0% a 100% — Registra % total alcanzado, no suma)
                  </option>
                </select>
              </div>

              <div className="grid grid-cols-4 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Meta: *</label>
                  <input
                    type="number"
                    step="any"
                    required
                    disabled={formCatalogItem.progressMode === 'percentage'}
                    value={
                      formCatalogItem.progressMode === 'percentage'
                        ? '100'
                        : formCatalogItem.targetUnits
                    }
                    onChange={(e) =>
                      setFormCatalogItem({
                        ...formCatalogItem,
                        targetUnits: e.target.value
                      })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Unidad:</label>
                  <input
                    type="text"
                    disabled={formCatalogItem.progressMode === 'percentage'}
                    value={
                      formCatalogItem.progressMode === 'percentage'
                        ? '%'
                        : formCatalogItem.unit
                    }
                    onChange={(e) =>
                      setFormCatalogItem({ ...formCatalogItem, unit: e.target.value })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Peso:</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formCatalogItem.weight}
                    onChange={(e) =>
                      setFormCatalogItem({ ...formCatalogItem, weight: e.target.value })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">HH Plan:</label>
                  <input
                    type="number"
                    value={formCatalogItem.plannedHH}
                    onChange={(e) =>
                      setFormCatalogItem({
                        ...formCatalogItem,
                        plannedHH: e.target.value
                      })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Duración planificada (días)</label>
                  <input type="number" min={1} max={3650} step={1} value={formCatalogItem.durationDays}
                    onChange={event => setFormCatalogItem({ ...formCatalogItem, durationDays: event.target.value })}
                    className="w-full rounded-xl border border-slate-300 bg-slate-50 px-2.5 py-2" />
                </div>
              </div>

              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalNewCatalogItem(false)}
                  className="px-4 py-2 font-bold text-slate-500"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] text-white font-bold"
                >
                  Guardar en Catálogo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ASIGNAR / EDITAR MATERIAL POR GALPÓN, ÁREA, SISTEMA Y ESTRUCTURA */}
      {modalNewMaterial && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg border border-slate-200 shadow-2xl my-8">
            <h3 className="text-base font-black text-slate-900 mb-1">
              {editingMaterialId
                ? 'Editar Material'
                : 'Asignar Material a Galpón y Estructura'}
            </h3>
            <p className="text-xs text-slate-500 mb-3">
              Selecciona el Galpón, Proveedor, Área, Sistema y Estructura a los que
              pertenece este material
            </p>
            <form onSubmit={handleSaveMaterial} className="space-y-3 text-xs">
              {materialError && <p role="alert" className="text-xs text-rose-700">{materialError}</p>}
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Galpón Destino: {allGalponesList.length > 0 && !editingMaterialId ? '*' : ''}
                </label>
                <select
                  required={allGalponesList.length > 0 && !editingMaterialId}
                  value={formMaterial.galponId}
                  onChange={(e) => {
                    const gId = e.target.value;
                    const galObj = allGalponesList.find((g) => g.id === gId);
                    setFormMaterial({
                      ...formMaterial,
                      galponId: gId,
                      sectorId: galObj ? galObj.sectorId : '',
                      areaId: '',
                      sistemaId: '',
                      structureId: ''
                    });
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                >
                  <option value="">
                    {editingMaterialId && !formMaterial.galponId
                      ? '-- Sin galpón asignado (Seleccionar para asignar) --'
                      : '-- Seleccionar Galpón --'}
                  </option>
                  {allGalponesList.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.sectorName} • {g.code} - {g.name} ({g.technology || 'Sin proveedor'})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Proveedor / Plantilla: *
                  </label>
                  <select
                    required
                    value={formMaterial.technology}
                    onChange={(e) =>
                      setFormMaterial({ ...formMaterial, technology: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold text-[#0f6b38]"
                  >
                    <option value="">-- Seleccionar Proveedor --</option>
                    {Array.from(
                      new Set(
                        [
                          ...technologies,
                          formMaterial.technology
                        ].filter(Boolean)
                      )
                    ).map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Área: *</label>
                  <select
                    required
                    value={formMaterial.areaName}
                    onChange={(e) => {
                      const nextArea = e.target.value;
                      const galObj = allGalponesList.find(
                        (g) => g.id === formMaterial.galponId
                      );
                      const matchedArea = galObj?.areas?.find(
                        (a: any) => a.name === nextArea
                      );
                      setFormMaterial({
                        ...formMaterial,
                        areaId: matchedArea?.id || '',
                        areaName: nextArea,
                        locationType: '',
                        sistemaId: '',
                        sistemaName: '',
                        customSistemaName: '',
                        structureId: '',
                        structureName: '',
                        customStructureName: ''
                      });
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  >
                    <option value="">-- Seleccionar Área --</option>
                    {ALL_AREAS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {AREAS_WITH_SISTEMAS.includes(formMaterial.areaName) && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">
                      Ubicación: *
                    </label>
                    <select
                      required
                      value={formMaterial.locationType}
                      onChange={(e) =>
                        setFormMaterial({
                          ...formMaterial,
                          locationType: e.target.value
                        })
                      }
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                    >
                      <option value="">-- Seleccionar Ubicación --</option>
                      <option value="Interno">Interno</option>
                      <option value="Externo">Externo</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 mb-1">
                      Sistema: *
                    </label>
                    <select
                      required
                      value={formMaterial.sistemaName}
                      onChange={(e) => {
                        const val = e.target.value;
                        const foundSis = availableMaterialSystems.find(
                          (s) => s.name === val
                        );
                        setFormMaterial({
                          ...formMaterial,
                          sistemaId: foundSis?.id || '',
                          sistemaName: val,
                          structureId: '',
                          structureName: ''
                        });
                      }}
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                    >
                      <option value="">-- Seleccionar Sistema --</option>
                      {availableMaterialSystems.map((sis) => (
                        <option key={`${sis.locationType}__${sis.name}`} value={sis.name}>
                          {sis.name} ({sis.locationType})
                        </option>
                      ))}
                      <option value="__NEW__">+ Escribir nuevo sistema...</option>
                    </select>
                  </div>
                </div>
              )}

              {AREAS_WITH_SISTEMAS.includes(formMaterial.areaName) &&
                formMaterial.sistemaName === '__NEW__' && (
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">
                      Nombre del Nuevo Sistema: *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="Nombre del sistema..."
                      value={formMaterial.customSistemaName}
                      onChange={(e) =>
                        setFormMaterial({
                          ...formMaterial,
                          customSistemaName: e.target.value
                        })
                      }
                      className="w-full px-3 py-2 rounded-xl border border-emerald-400 bg-emerald-50/40 font-bold"
                    />
                  </div>
                )}

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Estructura Vinculada: *
                </label>
                <select
                  required
                  value={formMaterial.structureName}
                  onChange={(e) => {
                    const val = e.target.value;
                    const foundStr = availableMaterialStructures.find(
                      (st) => st.name === val
                    );
                    setFormMaterial({
                      ...formMaterial,
                      structureId: foundStr?.id || '',
                      structureName: val
                    });
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold mb-1.5"
                >
                  <option value="">-- Seleccionar Estructura existente --</option>
                  {availableMaterialStructures.map((st) => (
                    <option key={st.name} value={st.name}>
                      {st.name}
                    </option>
                  ))}
                  <option value="__NEW__">+ Escribir nueva estructura...</option>
                </select>
                {formMaterial.structureName === '__NEW__' && (
                  <input
                    type="text"
                    required
                    placeholder="Nombre de la estructura..."
                    value={formMaterial.customStructureName}
                    onChange={(e) =>
                      setFormMaterial({
                        ...formMaterial,
                        customStructureName: e.target.value
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-emerald-400 bg-emerald-50/40 font-bold"
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Código Material: *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="MAT-01"
                    value={formMaterial.code}
                    onChange={(e) =>
                      setFormMaterial({ ...formMaterial, code: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Unidad: *</label>
                  <select
                    required
                    value={formMaterial.unit}
                    onChange={(e) =>
                      setFormMaterial({ ...formMaterial, unit: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  >
                    <option value="">-- Seleccionar Unidad --</option>
                    <option value="Und">Und</option>
                    <option value="Bolsas">Bolsas</option>
                    <option value="Metros">Metros</option>
                    <option value="Kilos">Kilos</option>
                    <option value="Rollos">Rollos</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Nombre del Material: *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Pernos M8 Galvanizados"
                  value={formMaterial.name}
                  onChange={(e) =>
                    setFormMaterial({ ...formMaterial, name: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Cantidad Total Presupuestada para la Estructura: *
                </label>
                <input
                  type="number"
                  step="any"
                  required
                  value={formMaterial.totalQty}
                  onChange={(e) =>
                    setFormMaterial({ ...formMaterial, totalQty: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono font-bold text-sm text-[#0f6b38]"
                />
              </div>

              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalNewMaterial(false)}
                  className="px-4 py-2 font-bold text-slate-500"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] text-white font-bold"
                >
                  Guardar Material
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NUEVO PROYECTO / SECTOR */}
      {modalNewProject && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md border border-slate-200 shadow-2xl">
            <h3 className="text-base font-black text-slate-900 mb-1">
              Crear Nuevo Proyecto / Sector
            </h3>
            <form onSubmit={handleSaveNewProject} className="space-y-3 text-xs mt-3">
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Nombre del Sector / Proyecto: *
                </label>
                <input
                  type="text"
                  required
                  value={formProject.name}
                  onChange={(e) =>
                    setFormProject({ ...formProject, name: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Código: *</label>
                  <input
                    type="text"
                    required
                    value={formProject.code}
                    onChange={(e) =>
                      setFormProject({ ...formProject, code: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Ubicación:
                  </label>
                  <input
                    type="text"
                    value={formProject.location}
                    onChange={(e) =>
                      setFormProject({ ...formProject, location: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                  />
                </div>
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">Cliente:</label>
                <input
                  type="text"
                  value={formProject.client}
                  onChange={(e) =>
                    setFormProject({ ...formProject, client: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                />
              </div>
              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalNewProject(false)}
                  className="px-4 py-2 font-bold text-slate-500"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] text-white font-bold"
                >
                  Crear Sector
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: EDITAR PROYECTO / SECTOR */}
      {modalEditProject && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md border border-slate-200 shadow-2xl">
            <h3 className="text-base font-black text-slate-900 mb-1">Editar Sector</h3>
            <form onSubmit={handleSaveEditProject} className="space-y-3 text-xs mt-3">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Nombre: *</label>
                <input
                  type="text"
                  required
                  value={formProject.name}
                  onChange={(e) =>
                    setFormProject({ ...formProject, name: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Código: *</label>
                  <input
                    type="text"
                    required
                    value={formProject.code}
                    onChange={(e) =>
                      setFormProject({ ...formProject, code: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Ubicación:
                  </label>
                  <input
                    type="text"
                    value={formProject.location}
                    onChange={(e) =>
                      setFormProject({ ...formProject, location: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                  />
                </div>
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">Cliente:</label>
                <input
                  type="text"
                  value={formProject.client}
                  onChange={(e) =>
                    setFormProject({ ...formProject, client: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                />
              </div>
              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalEditProject(false)}
                  className="px-4 py-2 font-bold text-slate-500"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] text-white font-bold"
                >
                  Guardar Cambios
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NUEVO GALPÓN */}
      {modalNewGalpon && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg border border-slate-200 shadow-2xl">
            <h3 className="text-base font-black text-slate-900 mb-1">
              Crear Nuevo Galpón
            </h3>
            <form onSubmit={handleSaveNewGalpon} className="space-y-3 text-xs mt-3">
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Sector / Proyecto Destino: *
                </label>
                <select
                  required
                  value={formGalpon.sectorId}
                  onChange={(e) =>
                    setFormGalpon({ ...formGalpon, sectorId: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                >
                  <option value="">-- Seleccionar Sector --</option>
                  {sectors.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Código: *</label>
                  <input
                    type="text"
                    required
                    value={formGalpon.code}
                    onChange={(e) =>
                      setFormGalpon({ ...formGalpon, code: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Nombre: *</label>
                  <input
                    type="text"
                    required
                    value={formGalpon.name}
                    onChange={(e) =>
                      setFormGalpon({ ...formGalpon, name: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Plantilla de Proveedor / Tecnología: *
                </label>
                <select
                  required
                  value={formGalpon.technology}
                  onChange={(e) =>
                    setFormGalpon({ ...formGalpon, technology: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-emerald-400 bg-emerald-50 font-bold text-[#0f6b38]"
                >
                  <option value="">-- Seleccionar Proveedor --</option>
                  {technologies.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Responsable (texto libre)
                </label>
                <input
                  type="text"
                  value={formGalpon.responsible}
                  onChange={(e) =>
                    setFormGalpon({ ...formGalpon, responsible: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Fecha Inicio:
                  </label>
                  <input
                    type="date"
                    value={formGalpon.startDate}
                    onChange={(e) =>
                      setFormGalpon({ ...formGalpon, startDate: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Fecha Fin:
                  </label>
                  <input
                    type="date"
                    value={formGalpon.endDate}
                    onChange={(e) =>
                      setFormGalpon({ ...formGalpon, endDate: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                  />
                </div>
              </div>

              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalNewGalpon(false)}
                  className="px-4 py-2 font-bold text-slate-500"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] text-white font-bold"
                >
                  Crear Galpón
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: EDITAR GALPÓN (CON CAMBIO DE PLANTILLA DE PROVEEDOR) */}
      {modalEditGalpon && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg border border-slate-200 shadow-2xl">
            <h3 className="text-base font-black text-slate-900 mb-1">
              Editar Galpón y Plantilla de Proveedor
            </h3>
            <form onSubmit={handleSaveEditGalpon} className="space-y-3 text-xs mt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Código: *</label>
                  <input
                    type="text"
                    required
                    value={formGalpon.code}
                    onChange={(e) =>
                      setFormGalpon({ ...formGalpon, code: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Nombre: *</label>
                  <input
                    type="text"
                    required
                    value={formGalpon.name}
                    onChange={(e) =>
                      setFormGalpon({ ...formGalpon, name: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Plantilla de Proveedor / Tecnología: *
                </label>
                <select
                  required
                  value={formGalpon.technology}
                  onChange={(e) =>
                    setFormGalpon({ ...formGalpon, technology: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-emerald-400 bg-emerald-50 font-bold text-[#0f6b38]"
                >
                  <option value="">-- Seleccionar Proveedor --</option>
                  {technologies.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Responsable (texto libre)
                </label>
                <input
                  type="text"
                  value={formGalpon.responsible}
                  onChange={(e) =>
                    setFormGalpon({ ...formGalpon, responsible: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Fecha Inicio:
                  </label>
                  <input
                    type="date"
                    value={formGalpon.startDate}
                    onChange={(e) =>
                      setFormGalpon({ ...formGalpon, startDate: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Fecha Fin:
                  </label>
                  <input
                    type="date"
                    value={formGalpon.endDate}
                    onChange={(e) =>
                      setFormGalpon({ ...formGalpon, endDate: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                  />
                </div>
              </div>

              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalEditGalpon(false)}
                  className="px-4 py-2 font-bold text-slate-500"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] text-white font-bold"
                >
                  Guardar Cambios
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: AGREGAR ACTIVIDAD AL GALPÓN (SELECCIÓN PROGRESIVA DESDE CATÁLOGO MAESTRO) */}
      {modalNewActivity && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-xl border border-slate-200 shadow-2xl my-8">
            <h3 className="text-base font-black text-slate-900 mb-1">
              Agregar Actividad a Galpón
            </h3>
            <p className="text-xs text-slate-500">
              Selecciona progresivamente Área, Sistema, Estructura y Actividad(es) activas
              del Catálogo Maestro para asignarlas al galpón destino
            </p>
            <form onSubmit={handleSaveNewActivity} className="space-y-3.5 text-xs mt-3">
              {/* Selección de Galpón Destino y Galpón Compartido Opcional */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Galpón Destino (Sector • Galpón): *
                  </label>
                  <select
                    required
                    data-testid="assign-target-galpon"
                    aria-label="Galpón Destino"
                    value={formActivity.targetGalponId}
                    onChange={(e) =>
                      setFormActivity({
                        ...formActivity,
                        targetGalponId: e.target.value
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold text-[#0f6b38]"
                  >
                    <option value="">-- Seleccionar Galpón --</option>
                    {allGalponesList.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.sectorName} • {g.code} - {g.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Agregar también a otro Galpón (Opcional):
                  </label>
                  <select
                    data-testid="assign-secondary-galpon"
                    aria-label="Agregar también a otro Galpón"
                    value={formActivity.sharedWithGalponId}
                    onChange={(e) =>
                      setFormActivity({
                        ...formActivity,
                        sharedWithGalponId: e.target.value
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  >
                    <option value="">-- Ninguno (Solo al galpón destino) --</option>
                    {allGalponesList
                      .filter((g) => g.id !== formActivity.targetGalponId)
                      .map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.sectorName} • {g.code} - {g.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              {/* FLUJO PROGRESIVO DE 4 PASOS DESDE EL CATÁLOGO MAESTRO ACTIVO */}
              <div className="p-3.5 rounded-xl bg-emerald-50/60 border border-emerald-200 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-[#0f6b38] uppercase tracking-wide text-[11px]">
                    Selección Progresiva desde Catálogo Maestro
                  </span>
                  <span className="text-[11px] font-semibold text-slate-500">
                    {activeMasterCatalog.length} actividad(es) activa(s) en catálogo
                  </span>
                </div>

                {activeMasterCatalog.length === 0 ? (
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 font-semibold">
                    No existen actividades activas en el Catálogo Maestro. Registra primero
                    las actividades maestras en el módulo «Catálogo Maestro».
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      {/* PASO 1: ÁREA */}
                      <div>
                        <label
                          htmlFor="assign-step-area"
                          className="block font-bold text-slate-800 mb-1"
                        >
                          1. Área: *
                        </label>
                        <select
                          id="assign-step-area"
                          data-testid="assign-step-area"
                          aria-label="Paso 1. Seleccionar Área"
                          required
                          value={formActivity.areaName}
                          onChange={(e) =>
                            setFormActivity((prev) =>
                              applyCatalogStepAreaChange(
                                prev,
                                e.target.value,
                                activeMasterCatalog
                              )
                            )
                          }
                          className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-white font-bold text-slate-900"
                        >
                          <option value="">-- Seleccionar Área --</option>
                          {availableAssignCatalogAreas.map((areaName) => (
                            <option key={areaName} value={areaName}>
                              {areaName}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* PASO 2: SISTEMA */}
                      <div>
                        <label
                          htmlFor="assign-step-sistema"
                          className="block font-bold text-slate-800 mb-1"
                        >
                          2. Sistema: *
                        </label>
                        <select
                          id="assign-step-sistema"
                          data-testid="assign-step-sistema"
                          aria-label="Paso 2. Seleccionar Sistema"
                          required
                          disabled={!formActivity.areaName}
                          value={formActivity.sistemaName}
                          onChange={(e) =>
                            setFormActivity((prev) =>
                              applyCatalogStepSistemaChange(
                                prev,
                                e.target.value,
                                activeMasterCatalog
                              )
                            )
                          }
                          className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-white font-bold text-slate-900 disabled:bg-slate-100 disabled:text-slate-400"
                        >
                          <option value="">
                            {!formActivity.areaName
                              ? '-- Primero elija Área --'
                              : '-- Seleccionar Sistema --'}
                          </option>
                          {availableAssignCatalogSystems.map((sys) => (
                            <option key={sys.value} value={sys.value}>
                              {sys.value === NO_SISTEMA_VALUE
                                ? sys.label
                                : `${sys.label} (${sys.locationType})`}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* PASO 3: ESTRUCTURA */}
                      <div>
                        <label
                          htmlFor="assign-step-estructura"
                          className="block font-bold text-slate-800 mb-1"
                        >
                          3. Estructura: *
                        </label>
                        <select
                          id="assign-step-estructura"
                          data-testid="assign-step-estructura"
                          aria-label="Paso 3. Seleccionar Estructura"
                          required
                          disabled={!formActivity.areaName || !formActivity.sistemaName}
                          value={formActivity.structureName}
                          onChange={(e) =>
                            setFormActivity((prev) =>
                              applyCatalogStepEstructuraChange(prev, e.target.value)
                            )
                          }
                          className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-white font-bold text-slate-900 disabled:bg-slate-100 disabled:text-slate-400"
                        >
                          <option value="">
                            {!formActivity.sistemaName
                              ? '-- Primero elija Sistema --'
                              : '-- Seleccionar Estructura --'}
                          </option>
                          {availableAssignCatalogStructures.map((stName) => (
                            <option key={stName} value={stName}>
                              {stName}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* PASO 4: ACTIVIDAD(ES) DE LA ESTRUCTURA SELECCIONADA */}
                    <div data-testid="assign-step-actividad">
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="font-bold text-slate-800">
                          4. Actividad(es) de la Estructura: *
                        </label>
                        {formActivity.structureName &&
                          availableAssignCatalogActivities.length > 0 && (
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-bold text-[#0f6b38]">
                                {formActivity.selectedCatalogItemIds.length} de{' '}
                                {availableAssignCatalogActivities.length} seleccionada(s)
                              </span>
                              <button
                                type="button"
                                data-testid="assign-btn-toggle-all-activities"
                                onClick={() => {
                                  const allSelected =
                                    formActivity.selectedCatalogItemIds.length ===
                                    availableAssignCatalogActivities.length;
                                  setFormActivity((prev) =>
                                    applyCatalogStepSelectAllActivities(
                                      prev,
                                      availableAssignCatalogActivities,
                                      !allSelected
                                    )
                                  );
                                }}
                                className="px-2 py-0.5 rounded-lg bg-white hover:bg-emerald-100 text-[#0f6b38] border border-emerald-300 font-bold text-[11px] transition cursor-pointer"
                              >
                                {formActivity.selectedCatalogItemIds.length ===
                                availableAssignCatalogActivities.length
                                  ? 'Desmarcar todas'
                                  : 'Seleccionar todas'}
                              </button>
                            </div>
                          )}
                      </div>

                      {!formActivity.structureName ? (
                        <div className="px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-100 text-slate-400 font-semibold">
                          Seleccione primero Área, Sistema y Estructura para visualizar sus
                          actividades maestras activas.
                        </div>
                      ) : availableAssignCatalogActivities.length === 0 ? (
                        <div className="px-3 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 font-semibold">
                          No hay actividades activas registradas para esta estructura en el
                          Catálogo Maestro.
                        </div>
                      ) : (
                        <div className="max-h-44 overflow-y-auto rounded-xl border border-emerald-300 bg-white divide-y divide-slate-100">
                          {availableAssignCatalogActivities.map((actItem) => {
                            const isChecked =
                              formActivity.selectedCatalogItemIds.includes(actItem.id);
                            const isPct =
                              normalizeProgressMode(actItem.progressMode) === 'percentage';
                            return (
                              <label
                                key={actItem.id}
                                data-testid={`assign-activity-option-${actItem.code}`}
                                className={`flex items-center justify-between gap-2.5 px-3 py-2 cursor-pointer transition ${
                                  isChecked ? 'bg-emerald-50/90' : 'hover:bg-slate-50'
                                }`}
                              >
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() =>
                                      setFormActivity((prev) =>
                                        applyCatalogStepActivityToggle(
                                          prev,
                                          actItem.id,
                                          availableAssignCatalogActivities
                                        )
                                      )
                                    }
                                    className="w-4 h-4 accent-[#0f6b38] rounded shrink-0"
                                  />
                                  <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-800 font-mono font-bold text-[10px] shrink-0">
                                    {actItem.code}
                                  </span>
                                  <span className="font-bold text-slate-900 truncate">
                                    {actItem.name}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                                      isPct
                                        ? 'bg-blue-50 text-blue-800 border-blue-200'
                                        : 'bg-emerald-50 text-[#0f6b38] border-emerald-200'
                                    }`}
                                  >
                                    {isPct
                                      ? '100 %'
                                      : `${actItem.targetUnits || 0} ${actItem.unit || ''}`}
                                  </span>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Fechas programadas de inicio y término */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Fecha Inicio Planificada:
                  </label>
                  <input
                    type="date"
                    value={formActivity.startDate}
                    onChange={(e) =>
                      setFormActivity({ ...formActivity, startDate: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Fecha Fin Planificada:
                  </label>
                  <input
                    type="date"
                    value={formActivity.dueDate}
                    onChange={(e) =>
                      setFormActivity({ ...formActivity, dueDate: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  />
                </div>
              </div>

              {/* Configuración detallada cuando se selecciona 1 actividad */}
              {formActivity.selectedCatalogItemIds.length === 1 && (
                <div className="space-y-3 pt-1 border-t border-slate-200">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-bold text-slate-700 mb-1">
                        Código: *
                      </label>
                      <input
                        type="text"
                        required
                        value={formActivity.code}
                        onChange={(e) =>
                          setFormActivity({ ...formActivity, code: e.target.value })
                        }
                        className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono font-bold"
                      />
                    </div>
                    <div>
                      <label className="block font-bold text-slate-700 mb-1">
                        Actividad: *
                      </label>
                      <input
                        type="text"
                        required
                        value={formActivity.name}
                        onChange={(e) =>
                          setFormActivity({ ...formActivity, name: e.target.value })
                        }
                        className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                      />
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                    <label className="block font-bold text-slate-800 mb-1">
                      Modalidad de Registro del Avance: *
                    </label>
                    <select
                      value={formActivity.progressMode}
                      onChange={(e) => {
                        const nextMode = e.target.value as ProgressModality;
                        setFormActivity({
                          ...formActivity,
                          progressMode: nextMode,
                          targetUnits:
                            nextMode === 'percentage' ? '100' : formActivity.targetUnits,
                          unit: nextMode === 'percentage' ? '%' : formActivity.unit
                        });
                      }}
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white font-bold text-[#0f6b38]"
                    >
                      <option value="quantity">
                        Avance por Cantidades (Predeterminado: Meta numérica + Unidad)
                      </option>
                      <option value="percentage">
                        Avance por Porcentaje (0% a 100% — Registra % total alcanzado, no suma)
                      </option>
                    </select>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block font-bold text-slate-700 mb-1">
                        Meta: *
                      </label>
                      <input
                        type="number"
                        step="any"
                        required
                        disabled={formActivity.progressMode === 'percentage'}
                        value={
                          formActivity.progressMode === 'percentage'
                            ? '100'
                            : formActivity.targetUnits
                        }
                        onChange={(e) =>
                          setFormActivity({
                            ...formActivity,
                            targetUnits: e.target.value
                          })
                        }
                        className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="block font-bold text-slate-700 mb-1">
                        Unidad:
                      </label>
                      <input
                        type="text"
                        disabled={formActivity.progressMode === 'percentage'}
                        value={
                          formActivity.progressMode === 'percentage'
                            ? '%'
                            : formActivity.unit
                        }
                        onChange={(e) =>
                          setFormActivity({ ...formActivity, unit: e.target.value })
                        }
                        className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="block font-bold text-slate-700 mb-1">Peso:</label>
                      <input
                        type="number"
                        step="0.1"
                        value={formActivity.weight}
                        onChange={(e) =>
                          setFormActivity({ ...formActivity, weight: e.target.value })
                        }
                        className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalNewActivity(false)}
                  className="px-4 py-2 font-bold text-slate-500 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  data-testid="assign-btn-submit"
                  disabled={
                    !formActivity.targetGalponId ||
                    !formActivity.areaName ||
                    !formActivity.sistemaName ||
                    !formActivity.structureName ||
                    formActivity.selectedCatalogItemIds.length === 0
                  }
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white font-bold cursor-pointer"
                >
                  {formActivity.selectedCatalogItemIds.length > 1
                    ? `Guardar Actividades (${formActivity.selectedCatalogItemIds.length})`
                    : 'Guardar Actividad'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: EDITAR ACTIVIDAD DEL GALPÓN */}
      {modalEditGalponActivity && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md border border-slate-200 shadow-2xl">
            <h3 className="text-base font-black text-slate-900 mb-1">
              Editar Actividad del Galpón
            </h3>
            <form
              onSubmit={handleSaveEditedGalponActivity}
              className="space-y-3 text-xs mt-3"
            >
              <div>
                <label className="block font-bold text-slate-700 mb-1">Código:</label>
                <input
                  type="text"
                  required
                  value={modalEditGalponActivity.code}
                  onChange={(e) =>
                    setModalEditGalponActivity({
                      ...modalEditGalponActivity,
                      code: e.target.value
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono font-bold"
                />
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">Nombre:</label>
                <input
                  type="text"
                  required
                  value={modalEditGalponActivity.name}
                  onChange={(e) =>
                    setModalEditGalponActivity({
                      ...modalEditGalponActivity,
                      name: e.target.value
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                />
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                <label className="block font-bold text-slate-800 mb-1">
                  Modalidad de Registro del Avance:
                </label>
                <select
                  value={normalizeProgressMode(modalEditGalponActivity.progressMode)}
                  onChange={(e) => {
                    const nextMode = e.target.value as ProgressModality;
                    setModalEditGalponActivity({
                      ...modalEditGalponActivity,
                      progressMode: nextMode,
                      targetUnits:
                        nextMode === 'percentage'
                          ? 100
                          : modalEditGalponActivity.targetUnits,
                      unit:
                        nextMode === 'percentage' ? '%' : modalEditGalponActivity.unit
                    });
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white font-bold text-[#0f6b38]"
                >
                  <option value="quantity">
                    Avance por Cantidades (Predeterminado)
                  </option>
                  <option value="percentage">
                    Avance por Porcentaje (0% a 100% — No suma entre días)
                  </option>
                </select>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Meta:</label>
                  <input
                    type="number"
                    step="any"
                    required
                    disabled={
                      normalizeProgressMode(modalEditGalponActivity.progressMode) ===
                      'percentage'
                    }
                    value={
                      normalizeProgressMode(modalEditGalponActivity.progressMode) ===
                      'percentage'
                        ? 100
                        : modalEditGalponActivity.targetUnits
                    }
                    onChange={(e) =>
                      setModalEditGalponActivity({
                        ...modalEditGalponActivity,
                        targetUnits: e.target.value
                      })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Unidad:</label>
                  <input
                    type="text"
                    disabled={
                      normalizeProgressMode(modalEditGalponActivity.progressMode) ===
                      'percentage'
                    }
                    value={
                      normalizeProgressMode(modalEditGalponActivity.progressMode) ===
                      'percentage'
                        ? '%'
                        : modalEditGalponActivity.unit
                    }
                    onChange={(e) =>
                      setModalEditGalponActivity({
                        ...modalEditGalponActivity,
                        unit: e.target.value
                      })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Peso:</label>
                  <input
                    type="number"
                    step="0.1"
                    value={modalEditGalponActivity.weight}
                    onChange={(e) =>
                      setModalEditGalponActivity({
                        ...modalEditGalponActivity,
                        weight: e.target.value
                      })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono"
                  />
                </div>
              </div>
              <div className="pt-3 flex justify-end gap-2">
                {canDo('actividades', 'edit') && (<button
                  type="button"
                  onClick={() => setModalEditGalponActivity(null)}
                  className="px-4 py-2 font-bold text-slate-500"
                >
                  Cancelar
                </button>)}
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] text-white font-bold"
                >
                  Guardar Cambios
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: REGISTRAR / MODIFICAR AVANCE DIARIO EN CASCADA + CONSUMO MANUAL DE MATERIALES POR ID */}
      {modalNewAdvance && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg border border-slate-200 shadow-2xl my-8">
            <h3 className="text-base font-black text-slate-900 mb-1">
              {editingAdvanceId
                ? `Modificar Avance Diario (${currentGalpon?.code})`
                : `Registrar Avance Diario (${currentGalpon?.code})`}
            </h3>
            {!isNetworkOnline && (
              <div className="mt-2 p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-[11px] text-amber-900 font-bold">
                Modo sin conexión (Offline) activo: Este registro se guardará localmente en tu
                dispositivo y podrás enviarlo cuando regrese internet con el botón «SINCRONIZAR DATOS».
              </div>
            )}
            {advanceValidationError && (
              <div className="mt-2 p-3 rounded-xl bg-rose-50 border border-rose-300 text-xs text-rose-800 font-bold flex items-start justify-between gap-2">
                <span>{advanceValidationError}</span>
                <button
                  type="button"
                  onClick={() => setAdvanceValidationError(null)}
                  className="text-rose-700 font-black px-1"
                >
                  ✕
                </button>
              </div>
            )}
            <form onSubmit={handleSaveAdvance} className="space-y-3 text-xs mt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    1. Filtrar Área:
                  </label>
                  <select
                    value={formAdvance.areaName}
                    onChange={(e) =>
                      setFormAdvance({
                        ...formAdvance,
                        areaName: e.target.value,
                        sistemaName: '',
                        structureName: '',
                        activityId: ''
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  >
                    <option value="">Todas las Áreas</option>
                    {ALL_AREAS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    2. Estructura:
                  </label>
                  <select
                    value={formAdvance.structureName}
                    onChange={(e) =>
                      setFormAdvance({
                        ...formAdvance,
                        structureName: e.target.value,
                        activityId: ''
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  >
                    <option value="">Todas las Estructuras</option>
                    {Array.from(
                      new Set(
                        evaluatedActivities
                          .filter(
                            (a) =>
                              !formAdvance.areaName ||
                              a.areaName === formAdvance.areaName
                          )
                          .map((a) => a.structureName)
                      )
                    ).map((st: any) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  3. Seleccionar Actividad: *
                </label>
                <select
                  required
                  value={formAdvance.activityId}
                  onChange={(e) => {
                    setAdvanceValidationError(null);
                    setFormAdvance({
                      ...formAdvance,
                      activityId: e.target.value,
                      isAuthorizedCorrection: false,
                      correctionReason: ''
                    });
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold text-[#0f6b38]"
                >
                  <option value="">-- Seleccionar Actividad --</option>
                  {cascadeAdvancesList.map((a) => {
                    const isPct = a.progressMode === 'percentage';
                    return (
                      <option key={a.id} value={a.id}>
                        [{a.code}] {a.structureName} → {a.name} (
                        {isPct
                          ? `Modalidad Porcentaje: Actual ${a.progressPercent}% / 100%`
                          : `Meta: ${a.targetUnits} ${a.unit} | Acum: ${a.accumulatedQty}`}
                        )
                      </option>
                    );
                  })}
                </select>
              </div>

              {selectedAdvanceActivityObj && (
                <div
                  className={`p-3 rounded-xl border ${
                    selectedAdvanceActivityObj.progressMode === 'percentage'
                      ? 'bg-blue-50 border-blue-200 text-blue-950'
                      : 'bg-emerald-50/70 border-emerald-200 text-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-extrabold">
                      {selectedAdvanceActivityObj.progressMode === 'percentage'
                        ? 'Modalidad: Avance por Porcentaje Total Alcanzado (0% a 100%)'
                        : 'Modalidad: Avance por Cantidades Acumuladas'}
                    </span>
                    <span className="font-mono font-black px-2 py-0.5 rounded bg-white border border-slate-200 text-[#0f6b38]">
                      {selectedAdvanceActivityObj.progressMode === 'percentage'
                        ? `Último % válido: ${selectedAdvanceActivityObj.lastValidPercentage ?? 0}%`
                        : `Acumulado: ${selectedAdvanceActivityObj.accumulatedQty} / ${selectedAdvanceActivityObj.targetUnits} ${selectedAdvanceActivityObj.unit}`}
                    </span>
                  </div>
                  {selectedAdvanceActivityObj.progressMode === 'percentage' && (
                    <p className="text-[11px] text-blue-800 mt-1">
                      Ingresa el <strong>porcentaje total alcanzado hasta hoy (0% a 100%)</strong>.
                      El sistema toma el último porcentaje válido registrado y{' '}
                      <strong>NO suma porcentajes entre días</strong> (ej. Día 1: 10%, Día 2: 20% →
                      Avance real = 20%). Al llegar a 100%, la actividad queda Completada.
                    </p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Fecha: *</label>
                  <input
                    type="date"
                    required
                    value={formAdvance.date}
                    onChange={(e) =>
                      setFormAdvance({ ...formAdvance, date: e.target.value })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    {selectedAdvanceActivityObj?.progressMode === 'percentage'
                      ? '% Total Hoy (0-100): *'
                      : 'Cantidad Hoy: *'}
                  </label>
                  <input
                    type="number"
                    step="any"
                    min={0}
                    max={
                      selectedAdvanceActivityObj?.progressMode === 'percentage'
                        ? 100
                        : undefined
                    }
                    required
                    placeholder={
                      selectedAdvanceActivityObj?.progressMode === 'percentage'
                        ? `Ej. ${Math.min(100, (selectedAdvanceActivityObj?.lastValidPercentage || 0) + 10)}`
                        : ''
                    }
                    value={formAdvance.quantityToday}
                    onChange={(e) => {
                      setAdvanceValidationError(null);
                      setFormAdvance({ ...formAdvance, quantityToday: e.target.value });
                    }}
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono font-bold text-[#0f6b38]"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Horas Hombre (HH):
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={formAdvance.hoursWorked}
                    onChange={(e) =>
                      setFormAdvance({ ...formAdvance, hoursWorked: e.target.value })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono"
                  />
                </div>
              </div>

              {/* Autorización de Corrección Histórica cuando el nuevo porcentaje es menor al último porcentaje válido */}
              {selectedAdvanceActivityObj?.progressMode === 'percentage' &&
                formAdvance.quantityToday !== '' &&
                Number(formAdvance.quantityToday) <
                  (selectedAdvanceActivityObj.lastValidPercentage ?? 0) && (
                  <div className="p-3 rounded-xl bg-purple-50 border border-purple-300 space-y-2">
                    <p className="text-[11px] font-extrabold text-purple-950">
                      Atención: El porcentaje ingresado ({formAdvance.quantityToday}%) es menor al
                      último porcentaje válido registrado (
                      {selectedAdvanceActivityObj.lastValidPercentage ?? 0}%).
                    </p>
                    {canUserAuthorizePercentageCorrection(profile?.role) ? (
                      <>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formAdvance.isAuthorizedCorrection}
                            onChange={(e) =>
                              setFormAdvance({
                                ...formAdvance,
                                isAuthorizedCorrection: e.target.checked
                              })
                            }
                            className="accent-purple-700 w-4 h-4 rounded"
                          />
                          <span className="font-bold text-purple-900">
                            Autorizar corrección histórica de porcentaje ({profile?.role})
                          </span>
                        </label>
                        {formAdvance.isAuthorizedCorrection && (
                          <div>
                            <label className="block font-bold text-purple-900 mb-1">
                              Motivo obligatorio de la corrección histórica: *
                            </label>
                            <input
                              type="text"
                              required={formAdvance.isAuthorizedCorrection}
                              placeholder="Ej. Corrección de medición en campo verificada por supervisión..."
                              value={formAdvance.correctionReason}
                              onChange={(e) =>
                                setFormAdvance({
                                  ...formAdvance,
                                  correctionReason: e.target.value
                                })
                              }
                              className="w-full px-2.5 py-1.5 rounded-lg border border-purple-300 bg-white font-bold text-slate-800"
                            />
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-[11px] text-rose-700 font-bold">
                        Solo un Supervisor, Jefe de proyecto o Administrador puede autorizar una
                        corrección histórica que disminuya el porcentaje.
                      </p>
                    )}
                  </div>
                )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Responsable del parte (informativo)
                  </label>
                  <input
                    type="text"
                    placeholder={barnResponsible(currentGalpon) || activeUserName}
                    value={formAdvance.supervisor}
                    onChange={(e) =>
                      setFormAdvance({ ...formAdvance, supervisor: e.target.value })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Nota / Observación:
                  </label>
                  <input
                    type="text"
                    placeholder="Observación opcional..."
                    value={formAdvance.note}
                    onChange={(e) =>
                      setFormAdvance({ ...formAdvance, note: e.target.value })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50"
                  />
                </div>
              </div>

              {/* Trabajo Biproyecto (C-2): Compartir avance entre dos galpones */}
              {allGalponesList.filter((g) => g.id !== currentGalpon?.id).length > 0 && (
                <div className="p-3.5 rounded-xl border border-amber-200 bg-amber-50/60 space-y-2.5">
                  <label className="flex items-center justify-between gap-2 cursor-pointer">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={formAdvance.sharedAcrossTwoGalpones}
                        onChange={(e) =>
                          setFormAdvance({
                            ...formAdvance,
                            sharedAcrossTwoGalpones: e.target.checked,
                            secondGalponId: e.target.checked
                              ? formAdvance.secondGalponId
                              : ''
                          })
                        }
                        className="accent-[#0f6b38] w-4 h-4 rounded"
                      />
                      <span className="font-extrabold text-slate-900">
                        Trabajo Biproyecto (Compartir este avance entre dos galpones)
                      </span>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-200 text-amber-900">
                      C-2
                    </span>
                  </label>

                  {formAdvance.sharedAcrossTwoGalpones && (
                    <div className="space-y-2.5 pt-1 border-t border-amber-200/80">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div>
                          <label className="block font-bold text-slate-700 mb-1">
                            Segundo Galpón Compartido: *
                          </label>
                          <select
                            required={formAdvance.sharedAcrossTwoGalpones}
                            value={formAdvance.secondGalponId}
                            onChange={(e) =>
                              setFormAdvance({
                                ...formAdvance,
                                secondGalponId: e.target.value
                              })
                            }
                            className="w-full px-2.5 py-2 rounded-xl border border-amber-300 bg-white font-bold text-slate-800"
                          >
                            <option value="">-- Seleccionar 2do Galpón --</option>
                            {allGalponesList
                              .filter((g) => g.id !== currentGalpon?.id)
                              .map((g) => (
                                <option key={g.id} value={g.id}>
                                  {g.sectorName} • {g.code} - {g.name}
                                </option>
                              ))}
                          </select>
                        </div>

                        <div>
                          <label className="block font-bold text-slate-700 mb-1">
                            Modo de Reparto del Avance y HH: *
                          </label>
                          <select
                            value={formAdvance.splitMode}
                            onChange={(e) =>
                              setFormAdvance({
                                ...formAdvance,
                                splitMode: e.target.value as '50_50' | '100_both'
                              })
                            }
                            className="w-full px-2.5 py-2 rounded-xl border border-amber-300 bg-white font-bold text-slate-800"
                          >
                            <option value="50_50">
                              50% / 50% (Dividir cantidad y HH entre ambos)
                            </option>
                            <option value="100_both">
                              100% en Ambos (Aplicar total a cada galpón)
                            </option>
                          </select>
                        </div>
                      </div>

                      {formAdvance.secondGalponId && (
                        <div className="p-2.5 rounded-lg bg-white border border-amber-200 text-[11px] space-y-1">
                          <p className="font-extrabold text-amber-900">
                            Vista previa de distribución por galpón:
                          </p>
                          {(() => {
                            const rawQ = Number(formAdvance.quantityToday) || 0;
                            const rawH = Number(formAdvance.hoursWorked) || 0;
                            const f = formAdvance.splitMode === '50_50' ? 0.5 : 1;
                            const perGalQ = Math.round(rawQ * f * 100) / 100;
                            const perGalH = Math.round(rawH * f * 100) / 100;
                            const secGal = allGalponesList.find(
                              (g) => g.id === formAdvance.secondGalponId
                            );
                            const unitStr = selectedAdvanceActivityObj?.unit || '';
                            return (
                              <div className="grid grid-cols-2 gap-2 pt-0.5">
                                <div className="p-1.5 rounded bg-emerald-50 border border-emerald-200">
                                  <span className="font-bold text-[#0f6b38] block">
                                    1. {currentGalpon?.code}:
                                  </span>
                                  <span className="font-mono font-bold text-slate-800">
                                    +{perGalQ} {unitStr} • {perGalH} HH
                                  </span>
                                </div>
                                <div className="p-1.5 rounded bg-amber-50 border border-amber-200">
                                  <span className="font-bold text-amber-900 block">
                                    2. {secGal?.code || '2do Galpón'}:
                                  </span>
                                  <span className="font-mono font-bold text-slate-800">
                                    +{perGalQ} {unitStr} • {perGalH} HH
                                  </span>
                                </div>
                              </div>
                            );
                          })()}
                          <p className="text-[10px] text-slate-500">
                            El consumo de materiales se registra con trazabilidad por ID único
                            sin duplicar descuentos en el inventario.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Consumo Manual Guiado de Materiales Vinculados por ID Único */}

              <fieldset className="space-y-1 rounded-xl border border-slate-200 p-2.5">
                <legend className="px-1 font-bold text-slate-700">Personal relacionado</legend>
                {(() => {
                  const second = formAdvance.sharedAcrossTwoGalpones
                    ? allGalponesList.find(item => item.id === formAdvance.secondGalponId) : undefined;
                  const visible = masterWorkforce.filter(worker => formAdvance.workerIds.includes(worker.id) ||
                    (currentGalpon && workerAtLocation(worker, currentSector?.id, currentGalpon.id)) ||
                    (second && workerAtLocation(worker, second.sectorId, second.id)));
                  const ids = new Set(visible.map(worker => worker.id));
                  const options = [...visible, ...formAdvance.workerIds.filter(id => !ids.has(id)).map(id => ({ id, name: 'Operario histórico' }))];
                  return options.length ? (
                    <div className="grid max-h-28 gap-1 overflow-auto sm:grid-cols-2">
                      {options.map(worker => <label key={worker.id} className="flex items-center gap-2">
                        <input type="checkbox" checked={formAdvance.workerIds.includes(worker.id)}
                          onChange={event => {
                            const checked = event.target.checked;
                            setFormAdvance(previous => ({ ...previous, workerIds: checked
                              ? [...previous.workerIds, worker.id] : previous.workerIds.filter(id => id !== worker.id) }));
                          }} />
                        {worker.name}{worker.workerCode ? ' · ' + worker.workerCode : ''}
                      </label>)}
                    </div>
                  ) : <p className="text-slate-500">Sin personal activo asignado al galpón.</p>;
                })()}
              </fieldset>
              {selectedAdvanceActivityObj &&
                selectedAdvanceActivityObj.linkedMaterials?.length > 0 && (
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2">
                    <span className="font-bold text-[#0f6b38] block">
                      Consumo Manual Guiado de Materiales (Estructura:{' '}
                      {selectedAdvanceActivityObj.structureName}):
                    </span>
                    {selectedAdvanceActivityObj.linkedMaterials.map((mat: any) => {
                      const isPct =
                        selectedAdvanceActivityObj.progressMode === 'percentage';
                      const pctToday = isPct
                        ? Math.max(
                            0,
                            Number(formAdvance.quantityToday || 0) -
                              Number(selectedAdvanceActivityObj.lastValidPercentage || 0)
                          ) / 100
                        : selectedAdvanceActivityObj.targetUnits > 0
                          ? Number(formAdvance.quantityToday || 0) /
                            selectedAdvanceActivityObj.targetUnits
                          : 0;
                      const suggested =
                        Math.round(Number(mat.totalQty || 0) * pctToday * 10) / 10;

                      return (
                        <div
                          key={mat.id}
                          className="flex items-center justify-between gap-2 bg-white p-2 rounded-lg border border-emerald-200"
                        >
                          <div>
                            <span className="font-bold text-slate-800 block">
                              [{mat.code}] {mat.name} ({mat.unit})
                            </span>
                            <span className="text-[10px] text-slate-500">
                              Sugerido según avance hoy: ~{suggested} {mat.unit}
                            </span>
                          </div>
                          <input
                            type="number"
                            step="any"
                            placeholder={`Ej. ${suggested}`}
                            value={formAdvance.manualMaterialInputs[mat.id] || ''}
                            onChange={(e) =>
                              setFormAdvance({
                                ...formAdvance,
                                manualMaterialInputs: {
                                  ...formAdvance.manualMaterialInputs,
                                  [mat.id]: e.target.value
                                }
                              })
                            }
                            className="w-24 px-2 py-1 border border-slate-300 rounded font-mono font-bold text-right"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}

              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setModalNewAdvance(false);
                    setEditingAdvanceId(null);
                    setAdvanceValidationError(null);
                  }}
                  className="px-4 py-2 font-bold text-slate-500"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] text-white font-bold"
                >
                  {editingAdvanceId ? 'Guardar Cambios' : 'Guardar Avance'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NUEVO OPERARIO (SIN VALORES PREDETERMINADOS FIJOS - C-7) */}
      {modalNewWorker && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md border border-slate-200 shadow-2xl">
            <h3 className="text-base font-black text-slate-900 mb-1">
              Agregar Operario a la Planilla
            </h3>
            <form onSubmit={handleSaveWorker} className="space-y-3 text-xs mt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Código Manual Empresa: *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="CAL-101"
                    value={formWorker.workerCode}
                    onChange={(e) =>
                      setFormWorker({ ...formWorker, workerCode: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">DNI:</label>
                  <input
                    type="text"
                    value={formWorker.dni}
                    onChange={(e) =>
                      setFormWorker({ ...formWorker, dni: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Nombre Completo: *
                </label>
                <input
                  type="text"
                  required
                  value={formWorker.name}
                  onChange={(e) =>
                    setFormWorker({ ...formWorker, name: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Especialidad / Área: *
                  </label>
                  <select
                    required
                    value={formWorker.workArea}
                    onChange={(e) =>
                      setFormWorker({ ...formWorker, workArea: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  >
                    <option value="">-- Seleccionar Especialidad --</option>
                    {WORK_SPECIALTIES.map((sp) => (
                      <option key={sp} value={sp}>
                        {sp}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Cargo: *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ej. Operario Montajista"
                    value={formWorker.role}
                    onChange={(e) =>
                      setFormWorker({ ...formWorker, role: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Sector (Opcional):
                  </label>
                  <select
                    value={formWorker.sectorId}
                    onChange={(e) =>
                      setFormWorker({
                        ...formWorker,
                        sectorId: e.target.value,
                        galponId: ''
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                  >
                    <option value="">-- Sin sector asignado --</option>
                    {sectors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Galpón (Opcional):
                  </label>
                  <select
                    value={formWorker.galponId}
                    onChange={(e) =>
                      setFormWorker({ ...formWorker, galponId: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50"
                  >
                    <option value="">-- Sin galpón asignado --</option>
                    {(
                      sectors.find((s) => s.id === formWorker.sectorId)?.galpones || []
                    ).map((g: any) => (
                      <option key={g.id} value={g.id}>
                        {g.code} - {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalNewWorker(false)}
                  className="px-4 py-2 font-bold text-slate-500"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] text-white font-bold"
                >
                  Registrar Operario
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: CARGA MASIVA EXCEL (.XLSX / .CSV / PEGADO) CON VALIDACIÓN Y VISTA PREVIA (C-6) */}
      {modalBulkUpload && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-4xl border border-slate-200 shadow-2xl my-8 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-black text-slate-900">
                  Importación Masiva desde Archivo Excel (.XLSX), CSV o Pegado Directo (
                  {modalBulkUpload === 'catalogo'
                    ? 'CATÁLOGO MAESTRO'
                    : modalBulkUpload === 'materiales'
                      ? 'CONTROL DE MATERIALES'
                      : 'PLANILLA DE PERSONAL'}
                  )
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {modalBulkUpload === 'catalogo' &&
                    'Columnas requeridas: Proveedor, Codigo, Area, Ubicacion, Sistema (si aplica), Estructura, Actividad, Meta, Unidad, Peso, HH. Opcional: Modalidad (Cantidades / Porcentaje)'}
                  {modalBulkUpload === 'materiales' &&
                    'Columnas requeridas: Proveedor, Codigo, Material, Area, Sistema (si aplica), Estructura, CantidadTotal, Unidad, Galpon (o elegir galpón destino abajo)'}
                  {modalBulkUpload === 'personal' &&
                    'Columnas requeridas: Codigo, DNI, Nombre, Especialidad, Cargo, Galpon (opcional)'}
                </p>
              </div>
              <button
                type="button"
                onClick={resetBulkUploadState}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleConfirmBulkUpload} className="space-y-4 text-xs">
              <button type="button" onClick={() => void downloadBulkTemplate().catch(() => setBulkFileError('No se pudo generar la plantilla.'))}
                className="rounded border px-3 py-2 font-bold">Descargar plantilla Excel</button>
              {(bulkFileError || bulkImportAnalysis.error) && <p role="alert" className="text-xs text-rose-700">
                {bulkFileError || bulkImportAnalysis.error}
              </p>}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Selección directa de archivo .xlsx / .xls / .csv */}
                <div className="p-3.5 rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 flex flex-col justify-between gap-2">
                  <div>
                    <label className="font-extrabold text-[#0f6b38] block mb-1">
                      1. Seleccionar Archivo Excel (.xlsx, .xls) o CSV (.csv):
                    </label>
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      onChange={handleBulkFileSelect}
                      className="block w-full text-xs text-slate-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-[#0f6b38] file:text-white hover:file:bg-[#0a4e28] cursor-pointer"
                    />
                  </div>
                  {bulkFileName && (
                    <div className="flex items-center justify-between bg-white px-2.5 py-1.5 rounded-lg border border-emerald-200">
                      <span className="font-bold text-slate-700 truncate">
                        Archivo cargado: {bulkFileName} ({bulkRawRows.length} filas)
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setBulkRawRows([]);
                          setBulkFileName('');
                        }}
                        className="text-rose-600 font-bold hover:underline ml-2"
                      >
                        Quitar archivo
                      </button>
                    </div>
                  )}
                </div>

                {/* Selector de Galpón Destino para Materiales o Personal cuando el archivo no trae columna Galpón */}
                {(modalBulkUpload === 'materiales' ||
                  modalBulkUpload === 'personal') && (
                  <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex flex-col justify-between">
                    <div>
                      <label className="font-bold text-slate-800 block mb-1">
                        Galpón Destino por Defecto para el Lote{' '}
                        {modalBulkUpload === 'materiales' ? '*' : '(Opcional)'}:
                      </label>
                      <select
                        value={bulkTargetGalponId}
                        onChange={(e) => setBulkTargetGalponId(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white font-bold text-[#0f6b38]"
                      >
                        <option value="">
                          -- Identificar por columna «Galpon» del archivo o seleccionar aquí --
                        </option>
                        {allGalponesList.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.sectorName} • {g.code} - {g.name} ({g.technology || 'Sin proveedor'})
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1.5">
                      {modalBulkUpload === 'materiales'
                        ? 'Para materiales, se valida que el Área, Sistema y Estructura existan realmente en el galpón destino.'
                        : 'Si no se indica galpón, el operario quedará registrado como Sin galpón asignado.'}
                    </p>
                  </div>
                )}
              </div>

              {/* Opción alternativa: pegar celdas directamente desde Excel o CSV */}
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  2. O pega aquí directamente las filas copiadas desde Excel / CSV:
                </label>
                <textarea
                  rows={4}
                  placeholder="Pega aquí las filas copiadas desde tu hoja de cálculo Excel o CSV..."
                  value={bulkCsvText}
                  onChange={(e) => {
                    bulkReadId.current++;
                    setBulkFileError('');
                    if (e.target.value.length > MAX_IMPORT_BYTES) {
                      setBulkFileError('El texto supera el límite de 2 MB.');
                      setBulkCsvText('');
                      setBulkRawRows([]);
                      setBulkFileName('');
                      return;
                    }
                    setBulkCsvText(e.target.value);
                    if (e.target.value.trim()) {
                      setBulkRawRows([]);
                      setBulkFileName('');
                    }
                  }}
                  className="w-full p-3 border border-slate-300 rounded-xl font-mono text-xs bg-slate-50"
                />
              </div>

              {/* Resumen de validación: Válidas, Duplicadas y Rechazadas */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-center">
                  <span className="text-[10px] font-bold uppercase text-slate-500 block">
                    Filas Detectadas
                  </span>
                  <span className="text-lg font-black text-slate-900 font-mono">
                    {bulkImportAnalysis.allRows.length}
                  </span>
                </div>
                <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-center">
                  <span className="text-[10px] font-bold uppercase text-[#0f6b38] block">
                    Filas Válidas
                  </span>
                  <span className="text-lg font-black text-[#0f6b38] font-mono">
                    {bulkImportAnalysis.validRows.length}
                  </span>
                </div>
                <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-center">
                  <span className="text-[10px] font-bold uppercase text-amber-800 block">
                    Duplicadas (Omitidas)
                  </span>
                  <span className="text-lg font-black text-amber-800 font-mono">
                    {bulkImportAnalysis.duplicateRows.length}
                  </span>
                </div>
                <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-center">
                  <span className="text-[10px] font-bold uppercase text-rose-700 block">
                    Rechazadas (Con Error)
                  </span>
                  <span className="text-lg font-black text-rose-700 font-mono">
                    {bulkImportAnalysis.rejectedRows.length}
                  </span>
                </div>
              </div>

              {/* Tabla de Vista Previa antes de importar */}
              {bulkImportAnalysis.allRows.length > 0 && (
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="bg-slate-100 px-3 py-2 border-b border-slate-200 font-extrabold text-slate-700 flex items-center justify-between">
                    <span>Vista Previa de Validación Antes de Importar</span>
                    <span className="text-[11px] text-slate-500 font-normal">
                      Solo se guardarán las filas marcadas como VÁLIDA
                    </span>
                  </div>
                  <div className="max-h-56 overflow-y-auto overflow-x-auto">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-slate-50 text-slate-600 uppercase border-b border-slate-200">
                        <tr>
                          <th className="py-2 px-2.5">Fila</th>
                          <th className="py-2 px-2.5">Estado</th>
                          <th className="py-2 px-2.5">Código</th>
                          {modalBulkUpload === 'catalogo' && (
                            <th className="py-2 px-2.5">Modalidad</th>
                          )}
                          <th className="py-2 px-2.5">Descripción / Nombre</th>
                          <th className="py-2 px-2.5">Relación / Destino</th>
                          <th className="py-2 px-2.5">Detalle de Validación</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {bulkImportAnalysis.allRows.map((row) => (
                          <tr key={row.rowNumber} className="hover:bg-slate-50">
                            <td className="py-1.5 px-2.5 font-mono text-slate-500">
                              #{row.rowNumber}
                            </td>
                            <td className="py-1.5 px-2.5">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                                  row.status === 'valid'
                                    ? 'bg-emerald-100 text-[#0f6b38]'
                                    : row.status === 'duplicate'
                                      ? 'bg-amber-100 text-amber-800'
                                      : 'bg-rose-100 text-rose-700'
                                }`}
                              >
                                {row.status === 'valid'
                                  ? 'VÁLIDA'
                                  : row.status === 'duplicate'
                                    ? 'DUPLICADA'
                                    : 'RECHAZADA'}
                              </span>
                            </td>
                            <td className="py-1.5 px-2.5 font-mono font-bold">
                              {row.payload.code || row.payload.workerCode || '-'}
                            </td>
                            {modalBulkUpload === 'catalogo' && (
                              <td className="py-1.5 px-2.5">
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                                    row.payload?.progressMode === 'percentage'
                                      ? 'bg-indigo-100 text-indigo-700'
                                      : 'bg-emerald-100 text-[#0f6b38]'
                                  }`}
                                >
                                  {row.payload?.progressMode === 'percentage'
                                    ? 'Porcentaje (100%)'
                                    : `Cantidades (${row.payload?.targetUnits || 0} ${row.payload?.unit || ''})`}
                                </span>
                              </td>
                            )}
                            <td className="py-1.5 px-2.5 font-bold text-slate-900">
                              {row.payload.name || '-'}
                            </td>
                            <td className="py-1.5 px-2.5 text-slate-600">
                              {modalBulkUpload === 'catalogo' &&
                                `${row.payload.technology || '-'} • ${row.payload.areaName || '-'} • ${row.payload.structureName || '-'}`}
                              {modalBulkUpload === 'materiales' &&
                                `${row.galponLabel || '-'} • ${row.payload.areaName || '-'} • ${row.payload.structureName || '-'}`}
                              {modalBulkUpload === 'personal' &&
                                `${row.payload.workArea || '-'} • ${row.payload.role || '-'}`}
                            </td>
                            <td className="py-1.5 px-2.5 text-slate-600">
                              {row.statusReason}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={resetBulkUploadState}
                  className="px-4 py-2 rounded-xl border border-slate-300 font-bold text-slate-600 hover:bg-slate-100"
                >
                  Cancelar Importación
                </button>
                <button
                  type="submit"
                  disabled={bulkImportAnalysis.validRows.length === 0 || queuingPersonalImport}
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white font-bold"
                >
                  Importar {bulkImportAnalysis.validRows.length} Fila(s) Válida(s)
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: CONFIRMACIÓN SEGURA DE ELIMINACIÓN (SECTORES, GALPONES, ACTIVIDADES, MATERIALES, OPERARIOS, AVANCES, CATÁLOGO) */}
      {deleteConfirmModal && (
        <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg border border-slate-200 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-rose-100 text-rose-700 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-black text-slate-900">
                  {deleteConfirmModal.type === 'gantt_withdrawal' ? 'Retirar del plan' : 'Confirmar eliminación de'}{' '}
                  {deleteConfirmModal.type === 'gantt_withdrawal' ? '' : deleteConfirmModal.type === 'sector'
                    ? 'Sector'
                    : deleteConfirmModal.type === 'galpon'
                      ? 'Galpón'
                      : deleteConfirmModal.type === 'activity'
                        ? 'Actividad'
                        : deleteConfirmModal.type === 'material'
                          ? 'Material'
                          : deleteConfirmModal.type === 'worker'
                            ? 'Operario'
                            : deleteConfirmModal.type === 'advance'
                              ? 'Avance Diario'
                              : deleteConfirmModal.type === 'catalog_item'
                                ? 'Actividad Maestra'
                                : deleteConfirmModal.type === 'catalog_structure'
                                  ? 'Estructura Maestra'
                                  : 'Plantilla / Proveedor'}
                  : [{deleteConfirmModal.code}] {deleteConfirmModal.name}
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {deleteConfirmModal.type === 'gantt_withdrawal'
                    ? 'La actividad y sus avances seguirán disponibles en los demás módulos.'
                    : 'Verifica el impacto de esta acción antes de eliminar definitivamente el registro.'}
                </p>
              </div>
            </div>

            {deleteConfirmModal.extraDetails && (
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700 font-medium">
                {deleteConfirmModal.extraDetails}
              </div>
            )}

            {deleteConfirmModal.stats && (
              <div className="bg-slate-50 rounded-xl p-3.5 border border-slate-200 text-xs space-y-1.5">
                <p className="font-extrabold text-slate-700 uppercase text-[11px]">
                  Resumen de registros relacionados:
                </p>
                {deleteConfirmModal.stats.galpones !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Galpones relacionados:</span>
                    <span className="font-mono font-bold text-slate-900">
                      {deleteConfirmModal.stats.galpones}
                    </span>
                  </div>
                )}
                {deleteConfirmModal.stats.activities !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Actividades registradas:</span>
                    <span className="font-mono font-bold text-slate-900">
                      {deleteConfirmModal.stats.activities}
                    </span>
                  </div>
                )}
                {deleteConfirmModal.stats.advances !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Partes de avance diario:</span>
                    <span className="font-mono font-bold text-slate-900">
                      {deleteConfirmModal.stats.advances}
                    </span>
                  </div>
                )}
                {deleteConfirmModal.stats.materials !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Materiales vinculados:</span>
                    <span className="font-mono font-bold text-slate-900">
                      {deleteConfirmModal.stats.materials}
                    </span>
                  </div>
                )}
                {deleteConfirmModal.stats.workers !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Operarios asignados:</span>
                    <span className="font-mono font-bold text-slate-900">
                      {deleteConfirmModal.stats.workers}
                    </span>
                  </div>
                )}
                {deleteConfirmModal.stats.attendanceDays !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Días de asistencia registrados:</span>
                    <span className="font-mono font-bold text-slate-900">
                      {deleteConfirmModal.stats.attendanceDays}
                    </span>
                  </div>
                )}
                {deleteConfirmModal.stats.catalogItems !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">
                      Actividades en el Catálogo Maestro:
                    </span>
                    <span className="font-mono font-bold text-slate-900">
                      {deleteConfirmModal.stats.catalogItems}
                    </span>
                  </div>
                )}
              </div>
            )}

            {(deleteConfirmModal.type === 'sector' || deleteConfirmModal.type === 'galpon') && (
              <p className="text-xs text-slate-600">
                La baja se confirmará si la ubicación carece de registros operativos vinculados.
                Consulte el resultado en el Centro de Sincronización.
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmModal(null)}
                className="px-4 py-2 rounded-xl border border-slate-300 font-bold text-xs text-slate-600 hover:bg-slate-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteEntity}
                disabled={queuingGanttWithdrawal}
                className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs"
              >
                {deleteConfirmModal.type === 'gantt_withdrawal' ? 'Confirmar retiro del plan' : 'Confirmar Eliminación'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: CENTRO DE SINCRONIZACIÓN OFFLINE Y RESOLUCIÓN DE CONFLICTOS MULTIUSUARIO */}
      <OfflineSyncCenterModal
        isOpen={modalSyncCenterOpen}
        onClose={() => setModalSyncCenterOpen(false)}
        connectionIndicatorState={connectionIndicatorState}
        isNetworkOnline={isNetworkOnline}
        pendingOperations={pendingOperations}
        syncConflicts={syncConflicts}
        lastSyncSummary={lastSyncSummary}
        isManualSyncing={isManualSyncing}
        userRole={profile?.role}
        activeUserId={profile?.uid}
        activeScopeKey={scopeKey}
        onTriggerManualSync={triggerManualSync}
        onDismissAttendanceConflict={dismissAttendanceConflict}
        onRetryGanttWithdrawal={retryGanttWithdrawal}
        onResolveConflict={resolveSyncConflict}
      />
    </div>
  );
}
