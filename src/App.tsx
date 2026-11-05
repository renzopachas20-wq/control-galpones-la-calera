import React, { useState, useMemo, useEffect } from 'react';
import * as XLSX from 'xlsx';
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
  BookOpen
} from 'lucide-react';
import { useAuthProfile } from './components/AuthGate';
import { useFirestoreOperationalSync } from './firebase/firestoreDataService';
import {
  hasModulePermission,
  filterSectorsByScope,
  MODULE_LABELS,
  ACTION_LABELS,
  type AppModuleId,
  type PermissionAction
} from './firebase/permissions';

// ============================================================================
// UTILIDADES Y CONSTANTES BASE (SIN DATOS DE DEMOSTRACIÓN)
// ============================================================================

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
  'Sistema Eléctrico',
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

        strObj.activities.push({
          id: generateId('act'),
          code: item.code,
          name: item.name,
          locationType: locType,
          sistemaName: sisName,
          structureName: strObj.name,
          targetUnits: Number(item.targetUnits) || 0,
          unit: item.unit || '',
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

        strObj.activities.push({
          id: generateId('act'),
          code: item.code,
          name: item.name,
          locationType: 'Interno',
          sistemaName: null,
          structureName: strName,
          targetUnits: Number(item.targetUnits) || 0,
          unit: item.unit || '',
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

        strObj.activities.push({
          id: generateId('act'),
          code: cleanItemCode,
          name: item.name,
          locationType: locType,
          sistemaName: sisObj.name,
          structureName: strObj.name,
          targetUnits: Number(item.targetUnits) || 0,
          unit: item.unit || '',
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

        strObj.activities.push({
          id: generateId('act'),
          code: cleanItemCode,
          name: item.name,
          locationType: 'Interno',
          sistemaName: null,
          structureName: strObj.name,
          targetUnits: Number(item.targetUnits) || 0,
          unit: item.unit || '',
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

// Calcula el consumo acumulado de un material de forma determinística a partir de todos los partes diarios (C-1)
function computeMaterialUsedQty(mat: any, advances: any[]): number {
  const baseInitial = Number(mat.initialUsedQty || 0);
  const consumedFromAdvances = (advances || []).reduce((acc: number, adv: any) => {
    if (!adv || adv.isSecondarySharedCopy || !Array.isArray(adv.materialsUsedToday)) {
      return acc;
    }
    const matSumInAdvance = adv.materialsUsedToday.reduce((subAcc: number, u: any) => {
      if (!u) return subAcc;
      if (u.materialId) {
        return u.materialId === mat.id ? subAcc + Number(u.qty || 0) : subAcc;
      }
      // Soporte retrocompatible para registros antiguos sin materialId verificando el galpón
      const sameCode =
        String(u.code || '').trim().toUpperCase() ===
        String(mat.code || '').trim().toUpperCase();
      const sameGalpon = !mat.galponId || adv.galponId === mat.galponId;
      return sameCode && sameGalpon ? subAcc + Number(u.qty || 0) : subAcc;
    }, 0);
    return acc + matSumInAdvance;
  }, 0);
  return Math.max(0, Math.round((baseInitial + consumedFromAdvances) * 100) / 100);
}

function recalculateMaterialsFromAdvances(materialsList: any[], advancesList: any[]): any[] {
  return (materialsList || []).map((mat) => ({
    ...mat,
    usedQty: computeMaterialUsedQty(mat, advancesList)
  }));
}

// Exportación CSV compatible con Excel con BOM UTF-8 y escape completo de comillas, comas, punto y coma y saltos de línea (C-8)
function escapeCsvCell(value: any): string {
  if (value === null || value === undefined) return '""';
  const str = String(value).replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentTab, setCurrentTab] = useState('dashboard');

  // Plantillas / Proveedores (Inician vacíos)
  const [technologies, setTechnologies] = useState<string[]>(() => {
    try {
      const s = localStorage.getItem('calera_technologies_clean');
      return s ? JSON.parse(s) : DEFAULT_TECHNOLOGIES;
    } catch {
      return DEFAULT_TECHNOLOGIES;
    }
  });

  // Catálogo Maestro de Actividades (Inicia vacío)
  const [masterCatalog, setMasterCatalog] = useState<any[]>(() => {
    try {
      const s = localStorage.getItem('calera_master_catalog_clean');
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  // Sectores y Galpones (Inician vacíos)
  const [sectors, setSectors] = useState<any[]>(() => {
    try {
      const s = localStorage.getItem('calera_sectors_clean');
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  const [selectedSectorId, setSelectedSectorId] = useState<string>('');
  const [selectedGalponId, setSelectedGalponId] = useState<string>('');

  // Avances Diarios (Inician vacíos)
  const [dailyAdvances, setDailyAdvances] = useState<any[]>(() => {
    try {
      const s = localStorage.getItem('calera_advances_clean');
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  // Planilla de Personal (Inicia vacía)
  const [masterWorkforce, setMasterWorkforce] = useState<any[]>(() => {
    try {
      const s = localStorage.getItem('calera_workforce_clean');
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  // Materiales por Estructura (Inician vacíos)
  const [materials, setMaterials] = useState<any[]>(() => {
    try {
      const s = localStorage.getItem('calera_materials_clean');
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
      const s = localStorage.getItem('calera_attendance_clean');
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
    }[]
  >(() => {
    try {
      const s = localStorage.getItem('calera_audit_logs_clean');
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  const [activeUserName, setActiveUserName] = useState<string>(() => {
    try {
      return localStorage.getItem('calera_active_user_clean') || '';
    } catch {
      return '';
    }
  });

  const [filterLogAction, setFilterLogAction] = useState<string>('Todas');
  const [filterLogModule, setFilterLogModule] = useState<string>('Todos');
  const [searchLogText, setSearchLogText] = useState<string>('');

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
  const [editingMaterialId, setEditingMaterialId] = useState<string | null>(null);
  const [modalBulkUpload, setModalBulkUpload] = useState<
    'catalogo' | 'materiales' | 'personal' | null
  >(null);
  const [bulkCsvText, setBulkCsvText] = useState<string>('');
  const [bulkRawRows, setBulkRawRows] = useState<string[][]>([]);
  const [bulkFileName, setBulkFileName] = useState<string>('');
  const [bulkTargetGalponId, setBulkTargetGalponId] = useState<string>('');
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{
    type:
      | 'sector'
      | 'galpon'
      | 'activity'
      | 'material'
      | 'worker'
      | 'advance'
      | 'catalog_item'
      | 'template_provider';
    sectorId?: string;
    galponId?: string;
    targetId?: string;
    code: string;
    name: string;
    subtitle?: string;
    stats: {
      galpones: number;
      activities: number;
      advances: number;
      materials: number;
      workers: number;
      extraInfo?: string;
    };
    mode: 'preserve_unassign' | 'cascade_delete';
    deleteLinkedSharedAdvance?: boolean;
  } | null>(null);

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
    supervisorsStr: '',
    startDate: '',
    endDate: '',
    technology: ''
  });

  const [formAdvance, setFormAdvance] = useState({
    areaName: '',
    locationType: 'Todos',
    sistemaName: '',
    structureName: '',
    activityCode: '',
    date: '',
    quantityToday: '',
    hoursWorked: '',
    supervisor: '',
    note: '',
    sharedAcrossTwoGalpones: false,
    secondGalponId: '',
    splitMode: '100_both' as '100_both' | '50_50',
    manualMaterialInputs: {} as Record<string, string>
  });

  const [formActivity, setFormActivity] = useState({
    useCatalog: true,
    targetGalponId: '',
    catalogItemId: '',
    code: '',
    name: '',
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
  const [editingTemplateIndex, setEditingTemplateIndex] = useState<number | null>(null);
  const [editingTemplateValue, setEditingTemplateValue] = useState('');

  // Contexto de Autenticación, Matriz de Roles y Sincronización Firestore en Tiempo Real
  const { profile } = useAuthProfile();
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);

  const { syncStatus, lastSyncedAt, recordAuditMovement } = useFirestoreOperationalSync({
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

  // Filtrado de Sectores y Galpones según el alcance asignado al usuario (Sector / Galpón / Proyecto)
  const scopedSectors = useMemo(() => {
    return filterSectorsByScope(sectors, profile);
  }, [sectors, profile]);

  // Caché local de respaldo (Firestore es la fuente principal de verdad)
  useEffect(() => {
    localStorage.setItem('calera_technologies_clean', JSON.stringify(technologies));
  }, [technologies]);

  useEffect(() => {
    localStorage.setItem('calera_master_catalog_clean', JSON.stringify(masterCatalog));
  }, [masterCatalog]);

  useEffect(() => {
    localStorage.setItem('calera_sectors_clean', JSON.stringify(sectors));
    if (scopedSectors.length > 0 && !scopedSectors.some((s) => s.id === selectedSectorId)) {
      setSelectedSectorId(scopedSectors[0].id);
      setSelectedGalponId(scopedSectors[0].galpones?.[0]?.id || '');
    } else if (scopedSectors.length === 0) {
      setSelectedSectorId('');
      setSelectedGalponId('');
    }
  }, [sectors, scopedSectors, selectedSectorId]);

  useEffect(() => {
    localStorage.setItem('calera_advances_clean', JSON.stringify(dailyAdvances));
  }, [dailyAdvances]);

  useEffect(() => {
    localStorage.setItem('calera_workforce_clean', JSON.stringify(masterWorkforce));
  }, [masterWorkforce]);

  useEffect(() => {
    localStorage.setItem('calera_materials_clean', JSON.stringify(materials));
  }, [materials]);

  useEffect(() => {
    localStorage.setItem('calera_attendance_clean', JSON.stringify(attendanceRecords));
  }, [attendanceRecords]);

  useEffect(() => {
    localStorage.setItem('calera_audit_logs_clean', JSON.stringify(auditLogs));
  }, [auditLogs]);

  useEffect(() => {
    localStorage.setItem('calera_active_user_clean', activeUserName);
  }, [activeUserName]);

  const recordUserMovement = (
    action: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN',
    module: string,
    description: string,
    _customUser?: string
  ) => {
    if (profile) {
      recordAuditMovement(action, module, description);
      return;
    }
    const now = new Date();
    const timestamp = `${getSystemToday()} ${String(now.getHours()).padStart(
      2,
      '0'
    )}:${String(now.getMinutes()).padStart(2, '0')}:${String(
      now.getSeconds()
    ).padStart(2, '0')}`;
    const entry = {
      id: generateId('log'),
      timestamp,
      user: (activeUserName || 'Administrador').trim(),
      action,
      module,
      description
    };
    setAuditLogs((prev) => [entry, ...prev]);
  };

  // ==========================================================================
  // SELECTORES Y CÁLCULOS PRINCIPALES (RESPETANDO ALCANCE POR SECTOR Y GALPÓN)
  // ==========================================================================
  const currentSector = useMemo(() => {
    if (!scopedSectors.length) return null;
    return scopedSectors.find((s) => s.id === selectedSectorId) || scopedSectors[0] || null;
  }, [scopedSectors, selectedSectorId]);

  const currentGalpon = useMemo(() => {
    if (!currentSector || !currentSector.galpones?.length) return null;
    return (
      currentSector.galpones.find((g: any) => g.id === selectedGalponId) ||
      currentSector.galpones[0] ||
      null
    );
  }, [currentSector, selectedGalponId]);

  const handleSelectSector = (secId: string) => {
    setSelectedSectorId(secId);
    const sec = scopedSectors.find((s) => s.id === secId);
    if (sec && sec.galpones?.length > 0) {
      setSelectedGalponId(sec.galpones[0].id);
    } else {
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
    scopedSectors.forEach((sec) => {
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
  }, [scopedSectors]);

  // Estructuras disponibles (del Catálogo Maestro + Galpones + Materiales)
  const allKnownStructures = useMemo(() => {
    const setStr = new Set<string>();
    masterCatalog.forEach((item) => {
      if (item.structureName) setStr.add(item.structureName);
    });
    sectors.forEach((sec) => {
      sec.galpones?.forEach((g: any) => {
        g.areas?.forEach((a: any) => {
          if (a.hasSistemas && a.sistemas) {
            a.sistemas.forEach((sis: any) => {
              sis.structures?.forEach((st: any) => {
                if (st.name) setStr.add(st.name);
              });
            });
          } else {
            a.structures?.forEach((st: any) => {
              if (st.name) setStr.add(st.name);
            });
          }
        });
      });
    });
    materials.forEach((m) => {
      if (m.structureName) setStr.add(m.structureName);
    });
    return Array.from(setStr);
  }, [masterCatalog, sectors, materials]);

  // Sistemas disponibles para el formulario de Materiales (según Galpón y Área elegidos + Catálogo)
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

    masterCatalog.forEach((item) => {
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
    masterCatalog,
    materials
  ]);

  // Estructuras disponibles para el formulario de Materiales (según Galpón, Área y Sistema + Catálogo)
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

    masterCatalog.forEach((item) => {
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

    allKnownStructures.forEach((stName) => {
      if (stName && !mapStr.has(stName.toLowerCase())) {
        mapStr.set(stName.toLowerCase(), { id: '', name: stName });
      }
    });

    return Array.from(mapStr.values());
  }, [
    allGalponesList,
    formMaterial.galponId,
    formMaterial.areaName,
    formMaterial.technology,
    formMaterial.sistemaName,
    masterCatalog,
    allKnownStructures
  ]);

  // Actividades evaluadas del galpón activo
  const evaluatedActivities = useMemo(() => {
    if (!currentGalpon || !currentGalpon.areas) return [];
    const list: any[] = [];
    const todayStr = getSystemToday();

    currentGalpon.areas.forEach((area: any) => {
      if (area.hasSistemas && area.sistemas) {
        area.sistemas.forEach((sis: any) => {
          sis.structures?.forEach((str: any) => {
            str.activities?.forEach((act: any) => {
              const logsForAct = dailyAdvances.filter(
                (l) =>
                  l.galponId === currentGalpon.id &&
                  ((l.activityId && l.activityId === act.id) ||
                    l.activityCode === act.code)
              );
              const accumulatedQty = logsForAct.reduce(
                (sum, item) => sum + Number(item.quantityToday || 0),
                0
              );
              const accumulatedHH = logsForAct.reduce(
                (sum, item) => sum + Number(item.hoursWorked || 0),
                0
              );
              const rawPct =
                act.targetUnits > 0 ? (accumulatedQty / act.targetUnits) * 100 : 0;
              const progressPercent = Math.min(100, Math.round(rawPct * 10) / 10);
              const lastLog =
                [...logsForAct].sort(
                  (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
                )[0] || null;

              const shouldHaveStarted =
                Boolean(act.startDate) &&
                act.startDate <= todayStr &&
                progressPercent === 0;

              let computedStatus = act.status || 'Pendiente';
              if (progressPercent >= 100) computedStatus = 'Completada';
              else if (progressPercent > 0) computedStatus = 'En proceso';
              else if (shouldHaveStarted) computedStatus = 'No iniciada (Alerta)';

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
                  usedQty: computeMaterialUsedQty(m, dailyAdvances)
                }));

              list.push({
                ...act,
                areaId: area.id,
                areaName: area.name,
                hasSistema: true,
                locationType: act.locationType || sis.locationType || 'Interno',
                sistemaId: sis.id,
                sistemaName: act.sistemaName || sis.name,
                structureId: str.id,
                structureName: str.name,
                accumulatedQty,
                accumulatedHH,
                pendingQty: Math.max(0, Number(act.targetUnits || 0) - accumulatedQty),
                progressPercent,
                shouldHaveStarted,
                computedStatus,
                lastLog,
                linkedMaterials
              });
            });
          });
        });
      } else if (area.structures) {
        area.structures.forEach((str: any) => {
          str.activities?.forEach((act: any) => {
            const logsForAct = dailyAdvances.filter(
              (l) =>
                l.galponId === currentGalpon.id &&
                ((l.activityId && l.activityId === act.id) ||
                  l.activityCode === act.code)
            );
            const accumulatedQty = logsForAct.reduce(
              (sum, item) => sum + Number(item.quantityToday || 0),
              0
            );
            const accumulatedHH = logsForAct.reduce(
              (sum, item) => sum + Number(item.hoursWorked || 0),
              0
            );
            const rawPct =
              act.targetUnits > 0 ? (accumulatedQty / act.targetUnits) * 100 : 0;
            const progressPercent = Math.min(100, Math.round(rawPct * 10) / 10);
            const lastLog =
              [...logsForAct].sort(
                (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
              )[0] || null;

            const shouldHaveStarted =
              Boolean(act.startDate) &&
              act.startDate <= todayStr &&
              progressPercent === 0;

            let computedStatus = act.status || 'Pendiente';
            if (progressPercent >= 100) computedStatus = 'Completada';
            else if (progressPercent > 0) computedStatus = 'En proceso';
            else if (shouldHaveStarted) computedStatus = 'No iniciada (Alerta)';

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
                usedQty: computeMaterialUsedQty(m, dailyAdvances)
              }));

            list.push({
              ...act,
              areaId: area.id,
              areaName: area.name,
              hasSistema: false,
              locationType: act.locationType || 'Interno',
              sistemaName: null,
              structureId: str.id,
              structureName: str.name,
              accumulatedQty,
              accumulatedHH,
              pendingQty: Math.max(0, Number(act.targetUnits || 0) - accumulatedQty),
              progressPercent,
              shouldHaveStarted,
              computedStatus,
              lastLog,
              linkedMaterials
            });
          });
        });
      }
    });

    return list;
  }, [currentGalpon, dailyAdvances, materials]);

  // Avance Ponderado General del Galpón
  const galponWeightedProgress = useMemo(() => {
    if (!evaluatedActivities.length) return 0;
    const totalWeight = evaluatedActivities.reduce(
      (acc, a) => acc + (Number(a.weight) || 1),
      0
    );
    if (totalWeight <= 0) return 0;
    const weightedSum = evaluatedActivities.reduce(
      (acc, a) => acc + a.progressPercent * (Number(a.weight) || 1),
      0
    );
    return Math.round((weightedSum / totalWeight) * 10) / 10;
  }, [evaluatedActivities]);

  // Avance Ponderado por Área (6 Áreas)
  const areaProgressMetrics = useMemo(() => {
    return ALL_AREAS.map((areaName) => {
      const areaActs = evaluatedActivities.filter((a) => a.areaName === areaName);
      if (!areaActs.length) {
        return { name: areaName, percent: 0, total: 0, completed: 0 };
      }
      const totalWeight = areaActs.reduce((acc, a) => acc + (Number(a.weight) || 1), 0);
      const weightedSum = areaActs.reduce(
        (acc, a) => acc + a.progressPercent * (Number(a.weight) || 1),
        0
      );
      const pct = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;
      const completed = areaActs.filter((a) => a.progressPercent >= 100).length;
      return { name: areaName, percent: pct, total: areaActs.length, completed };
    });
  }, [evaluatedActivities]);

  // Avance Ponderado por Sistema General (filtrable por Todos / Interno / Externo)
  const sistemaProgressMetrics = useMemo(() => {
    const actsWithSis = evaluatedActivities.filter((a) => Boolean(a.sistemaName));
    const filteredByLoc =
      dashSistemaLocFilter === 'Todos'
        ? actsWithSis
        : actsWithSis.filter((a) => a.locationType === dashSistemaLocFilter);

    const sisNames = Array.from(new Set(actsWithSis.map((a) => a.sistemaName)));
    return sisNames.map((sisName) => {
      const sisActs = filteredByLoc.filter((a) => a.sistemaName === sisName);
      const allLocsForSis = Array.from(
        new Set(
          actsWithSis.filter((a) => a.sistemaName === sisName).map((a) => a.locationType)
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
      const totalWeight = sisActs.reduce((acc, a) => acc + (Number(a.weight) || 1), 0);
      const weightedSum = sisActs.reduce(
        (acc, a) => acc + a.progressPercent * (Number(a.weight) || 1),
        0
      );
      const percent =
        totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;
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
    recordUserMovement(
      'REGISTRO',
      'Catálogo Maestro',
      `Registró plantilla/proveedor "${clean}"`
    );
    setNewTemplateName('');
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
    recordUserMovement(
      'MODIFICACIÓN',
      'Catálogo Maestro',
      `Renombró plantilla/proveedor de "${oldName}" a "${newName}"`
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

  const openEditCatalogModal = (item: any) => {
    if (!requirePermission('catalogo', 'edit')) return;
    setEditingCatalogId(item.id);
    setFormCatalogItem({
      technology: item.technology || '',
      code: item.code || '',
      areaName: item.areaName || '',
      locationType: item.locationType || '',
      sistemaName: item.sistemaName || '',
      customSistemaName: '',
      structureName: item.structureName || '',
      customStructureName: '',
      name: item.name || '',
      targetUnits: String(item.targetUnits ?? ''),
      unit: item.unit || '',
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

    const payload = {
      id: editingCatalogId || generateId('cat'),
      technology: formCatalogItem.technology.trim(),
      code: formCatalogItem.code.trim().toUpperCase(),
      areaName: formCatalogItem.areaName,
      locationType: AREAS_WITH_SISTEMAS.includes(formCatalogItem.areaName)
        ? formCatalogItem.locationType || 'Interno'
        : 'Interno',
      sistemaName: AREAS_WITH_SISTEMAS.includes(formCatalogItem.areaName)
        ? finalSistema || null
        : null,
      structureName: finalStructure,
      name: formCatalogItem.name.trim(),
      targetUnits: Number(formCatalogItem.targetUnits) || 0,
      unit: formCatalogItem.unit.trim(),
      weight: Number(formCatalogItem.weight) || 1.0,
      plannedHH: Number(formCatalogItem.plannedHH) || 0,
      durationDays: Number(formCatalogItem.durationDays) || 1
    };

    if (editingCatalogId) {
      setMasterCatalog((prev) =>
        prev.map((c) => (c.id === editingCatalogId ? payload : c))
      );
      recordUserMovement(
        'MODIFICACIÓN',
        'Catálogo Maestro',
        `Modificó actividad maestra [${payload.code}] ${payload.name} (${payload.technology} • ${payload.areaName} • ${payload.structureName})`
      );
    } else {
      setMasterCatalog((prev) => [...prev, payload]);
      recordUserMovement(
        'REGISTRO',
        'Catálogo Maestro',
        `Registró actividad maestra [${payload.code}] ${payload.name} (${payload.technology} • ${payload.areaName} • ${payload.structureName})`
      );
    }

    setModalNewCatalogItem(false);
    setEditingCatalogId(null);
  };

  const requestDeleteCatalogItem = (id: string) => {
    if (!requirePermission('catalogo', 'delete')) return;
    const targetItem = masterCatalog.find((c) => c.id === id);
    if (!targetItem) return;
    setDeleteConfirmModal({
      type: 'catalog_item',
      entityId: id,
      code: targetItem.code,
      name: targetItem.name,
      extraDetails: `Proveedor: ${targetItem.technology || 'Sin proveedor'} • Área: ${targetItem.areaName} • Estructura: ${targetItem.structureName}`
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
    recordUserMovement(
      'REGISTRO',
      'Sectores y Galpones',
      `Registró nuevo sector [${newSecObj.code}] ${newSecObj.name}`
    );
    setSelectedSectorId(newSecObj.id);
    setSelectedGalponId('');
    setModalNewProject(false);
    setFormProject({ id: '', code: '', name: '', location: '', client: '' });
  };

  const handleSaveEditProject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('proyectos', 'edit')) return;
    if (!formProject.id || !formProject.name) return;

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
    recordUserMovement(
      'MODIFICACIÓN',
      'Sectores y Galpones',
      `Modificó sector [${updatedCode}] ${updatedName}`
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
      mode: 'preserve_unassign'
    });
  };

  const handleSaveNewGalpon = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('proyectos', 'create')) return;
    const targetSecId = formGalpon.sectorId || currentSector?.id;
    if (!formGalpon.code || !formGalpon.name || !targetSecId || !formGalpon.technology)
      return;

    const chosenTech = formGalpon.technology.trim();
    const generatedAreas = buildAreasFromCatalog(
      masterCatalog,
      chosenTech,
      formGalpon.startDate
    );

    const supList = formGalpon.supervisorsStr
      ? formGalpon.supervisorsStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const newGalponObj = {
      id: generateId('gal'),
      sectorId: targetSecId,
      code: formGalpon.code.trim().toUpperCase(),
      name: formGalpon.name.trim().toUpperCase(),
      technology: chosenTech,
      description: formGalpon.description.trim(),
      supervisors: supList,
      startDate: formGalpon.startDate,
      endDate: formGalpon.endDate,
      status: 'En ejecución',
      areas: generatedAreas
    };

    const targetSecObj = sectors.find((s) => s.id === targetSecId);
    setSectors((prev) =>
      prev.map((s) =>
        s.id === targetSecId
          ? { ...s, galpones: [...(s.galpones || []), newGalponObj] }
          : s
      )
    );
    recordUserMovement(
      'REGISTRO',
      'Sectores y Galpones',
      `Registró nuevo galpón [${newGalponObj.code}] ${newGalponObj.name} en sector ${targetSecObj?.name || ''} (Proveedor: ${chosenTech})`
    );
    setSelectedSectorId(targetSecId);
    setSelectedGalponId(newGalponObj.id);
    setModalNewGalpon(false);
  };

  const handleSaveEditGalpon = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('proyectos', 'edit')) return;
    if (!formGalpon.id) return;

    const supList = formGalpon.supervisorsStr
      ? formGalpon.supervisorsStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

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
            supervisors: supList,
            startDate: formGalpon.startDate,
            endDate: formGalpon.endDate,
            // Sincronización aditiva cuando cambia la plantilla, conservando actividades personalizadas e IDs de estructuras (C-3)
            areas:
              techChanged && cleanTech
                ? mergeAreasWithCatalog(
                    g.areas || [],
                    masterCatalog,
                    cleanTech,
                    formGalpon.startDate
                  )
                : g.areas
          };
        })
      }))
    );

    recordUserMovement(
      'MODIFICACIÓN',
      'Sectores y Galpones',
      `Modificó galpón [${updatedCode}] ${updatedName} (Proveedor: ${cleanTech})`
    );
    setModalEditGalpon(false);
  };

  const requestDeleteGalpon = (secId: string, galId: string) => {
    if (!requirePermission('proyectos', 'delete')) return;
    const sec = sectors.find((s) => s.id === secId);
    const targetGal = sec?.galpones?.find((g: any) => g.id === galId);
    if (!targetGal) return;

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
      mode: 'preserve_unassign'
    });
  };

  const handleConfirmDeleteEntity = () => {
    if (!deleteConfirmModal) return;
    const { type, entityId, sectorId, galponId, code, name, mode } = deleteConfirmModal;

    if (type === 'sector') {
      const targetSec = sectors.find((s) => s.id === sectorId);
      const galponIds = new Set<string>(
        (targetSec?.galpones || []).map((g: any) => g.id)
      );

      const nextAdvances = dailyAdvances.filter(
        (a) => a.sectorId !== sectorId && !galponIds.has(a.galponId)
      );
      setDailyAdvances(nextAdvances);

      setMaterials((prevMats) => {
        const updatedMats =
          mode === 'cascade_delete'
            ? prevMats.filter(
                (m) =>
                  m.sectorId !== sectorId &&
                  (!m.galponId || !galponIds.has(m.galponId))
              )
            : prevMats.map((m) => {
                if (
                  m.sectorId === sectorId ||
                  (m.galponId && galponIds.has(m.galponId))
                ) {
                  return {
                    ...m,
                    sectorId: '',
                    galponId: '',
                    areaId: '',
                    sistemaId: '',
                    structureId: ''
                  };
                }
                return m;
              });
        return recalculateMaterialsFromAdvances(updatedMats, nextAdvances);
      });

      setMasterWorkforce((prevWorkers) =>
        prevWorkers.map((w) => {
          if (
            w.sectorId === sectorId ||
            (w.galponId && galponIds.has(w.galponId))
          ) {
            return { ...w, sectorId: '', galponId: '' };
          }
          return w;
        })
      );

      setSectors((prev) => {
        const next = prev.filter((s) => s.id !== sectorId);
        if (selectedSectorId === sectorId) {
          setSelectedSectorId(next[0]?.id || '');
          setSelectedGalponId(next[0]?.galpones?.[0]?.id || '');
        }
        return next;
      });

      recordUserMovement(
        'ELIMINACIÓN',
        'Sectores y Galpones',
        `Eliminó sector [${code}] ${name} (${mode === 'preserve_unassign' ? 'materiales y operarios conservados como Sin galpón asignado' : 'eliminación en cascada de registros asociados'})`
      );
    } else if (type === 'galpon' && galponId) {
      const nextAdvances = dailyAdvances.filter((a) => a.galponId !== galponId);
      setDailyAdvances(nextAdvances);

      setMaterials((prevMats) => {
        const updatedMats =
          mode === 'cascade_delete'
            ? prevMats.filter((m) => m.galponId !== galponId)
            : prevMats.map((m) => {
                if (m.galponId === galponId) {
                  return {
                    ...m,
                    sectorId: '',
                    galponId: '',
                    areaId: '',
                    sistemaId: '',
                    structureId: ''
                  };
                }
                return m;
              });
        return recalculateMaterialsFromAdvances(updatedMats, nextAdvances);
      });

      setMasterWorkforce((prevWorkers) =>
        prevWorkers.map((w) =>
          w.galponId === galponId ? { ...w, galponId: '' } : w
        )
      );

      const targetGal = allGalponesList.find((g) => g.id === galponId);
      setSectors((prev) =>
        prev.map((s) => {
          if (s.id !== sectorId) return s;
          const nextGals = (s.galpones || []).filter((g: any) => g.id !== galponId);
          if (selectedGalponId === galponId) {
            setSelectedGalponId(nextGals[0]?.id || '');
          }
          return { ...s, galpones: nextGals };
        })
      );

      recordUserMovement(
        'ELIMINACIÓN',
        'Sectores y Galpones',
        `Eliminó galpón [${code}] ${name} del sector ${targetGal?.sectorName || ''} (${mode === 'preserve_unassign' ? 'materiales y operarios conservados como Sin galpón asignado' : 'eliminación en cascada de registros asociados'})`
      );
    } else if (type === 'activity' && entityId && sectorId && galponId) {
      const targetAct = evaluatedActivities.find((a) => a.id === entityId);
      setSectors((prev) =>
        prev.map((s) => {
          if (s.id !== sectorId) return s;
          return {
            ...s,
            galpones: s.galpones.map((g: any) => {
              if (g.id !== galponId) return g;
              return {
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
              };
            })
          };
        })
      );

      // Si el usuario confirma eliminar la actividad, también limpiamos sus avances diarios en este galpón y recalculamos materiales
      const nextAdvances = dailyAdvances.filter(
        (a) =>
          !(
            a.galponId === galponId &&
            (a.activityId === entityId ||
              (targetAct?.code && a.activityCode === targetAct.code))
          )
      );
      setDailyAdvances(nextAdvances);
      setMaterials((prevMats) =>
        recalculateMaterialsFromAdvances(prevMats, nextAdvances)
      );

      const targetGal = allGalponesList.find((g) => g.id === galponId);
      recordUserMovement(
        'ELIMINACIÓN',
        'Actividades',
        `Eliminó actividad [${code}] ${name} del galpón ${targetGal?.code || galponId}`
      );
    } else if (type === 'material' && entityId) {
      setMaterials((prev) => prev.filter((m) => m.id !== entityId));
      recordUserMovement(
        'ELIMINACIÓN',
        'Materiales',
        `Eliminó material [${code}] ${name}`
      );
    } else if (type === 'worker' && entityId) {
      setMasterWorkforce((prev) => prev.filter((w) => w.id !== entityId));
      recordUserMovement(
        'ELIMINACIÓN',
        'Personal y Asistencia',
        `Eliminó operario [${code}] ${name}`
      );
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

        const revertedMatsText =
          targetAdv.materialsUsedToday?.length > 0
            ? ` (Stock revertido: ${targetAdv.materialsUsedToday
                .map((u: any) => `${u.name} +${u.qty} ${u.unit}`)
                .join(', ')})`
            : '';

        recordUserMovement(
          'ELIMINACIÓN',
          'Avance Diario',
          `Eliminó parte diario de [${targetAdv.activityCode}] ${name} (${targetAdv.date} • Cantidad: ${targetAdv.quantityToday})${targetAdv.sharedGroupId ? ' [Trabajo Biproyecto sincronizado en ambos galpones]' : ''}${revertedMatsText}`
        );
      }
    } else if (type === 'catalog_item' && entityId) {
      setMasterCatalog((prev) => prev.filter((c) => c.id !== entityId));
      recordUserMovement(
        'ELIMINACIÓN',
        'Catálogo Maestro',
        `Eliminó actividad maestra [${code}] ${name}`
      );
    } else if (type === 'template_provider' && code) {
      setTechnologies((prev) => prev.filter((t) => t !== code));
      setMasterCatalog((prev) => prev.filter((item) => item.technology !== code));
      recordUserMovement(
        'ELIMINACIÓN',
        'Catálogo Maestro',
        `Eliminó plantilla/proveedor "${code}"`
      );
    }

    setDeleteConfirmModal(null);
  };

  const handleReloadGalponFromCatalog = (secId: string, galponObj: any) => {
    if (!requirePermission('proyectos', 'edit')) return;
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
                        masterCatalog,
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
    recordUserMovement(
      'MODIFICACIÓN',
      'Sectores y Galpones',
      `Sincronizó actividades del galpón [${galponObj.code}] desde el Catálogo Maestro (${cleanTech || 'Sin proveedor'}) conservando estructuras y actividades personalizadas`
    );
  };

  // ==========================================================================
  // HANDLERS: GESTIÓN DE ACTIVIDADES EN EL GALPÓN (CUALQUIER SECTOR Y GALPÓN)
  // ==========================================================================
  const handleSaveNewActivity = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('actividades', 'create')) return;
    const primaryGalponId = formActivity.targetGalponId || currentGalpon?.id || '';
    if (!primaryGalponId) return;
    if (!formActivity.code || !formActivity.name || !formActivity.areaName) return;

    const finalSistema =
      formActivity.sistemaName === '__NEW__'
        ? formActivity.customSistemaName.trim()
        : formActivity.sistemaName.trim();

    const finalStructure =
      formActivity.structureName === '__NEW__'
        ? formActivity.customStructureName.trim()
        : formActivity.structureName.trim();

    if (!finalStructure) return;

    if (AREAS_WITH_SISTEMAS.includes(formActivity.areaName) && !finalSistema) return;

    const newActObj = {
      id: generateId('act'),
      code: formActivity.code.trim().toUpperCase(),
      name: formActivity.name.trim(),
      locationType: AREAS_WITH_SISTEMAS.includes(formActivity.areaName)
        ? formActivity.locationType || 'Interno'
        : 'Interno',
      sistemaName: AREAS_WITH_SISTEMAS.includes(formActivity.areaName)
        ? finalSistema
        : null,
      structureName: finalStructure,
      targetUnits: Number(formActivity.targetUnits) || 0,
      unit: formActivity.unit.trim(),
      weight: Number(formActivity.weight) || 1.0,
      plannedHH: Number(formActivity.plannedHH) || 0,
      startDate: formActivity.startDate || getSystemToday(),
      dueDate: formActivity.dueDate || getSystemToday(),
      status: 'Pendiente'
    };

    const targetGalponIds = [primaryGalponId];
    if (
      formActivity.sharedWithGalponId &&
      !targetGalponIds.includes(formActivity.sharedWithGalponId)
    ) {
      targetGalponIds.push(formActivity.sharedWithGalponId);
    }

    // Actualizar galpones en TODOS los sectores donde se encuentre cualquiera de los galpones destino
    setSectors((prev) =>
      prev.map((s) => {
        const hasTargetInSector = (s.galpones || []).some((g: any) =>
          targetGalponIds.includes(g.id)
        );
        if (!hasTargetInSector) return s;

        return {
          ...s,
          galpones: (s.galpones || []).map((g: any) => {
            if (!targetGalponIds.includes(g.id)) return g;
            const currentAreas =
              g.areas && g.areas.length > 0
                ? g.areas
                : ALL_AREAS.map((aName, idx) => ({
                    id: generateId(`area_${idx}`),
                    name: aName,
                    hasSistemas: AREAS_WITH_SISTEMAS.includes(aName),
                    sistemas: [],
                    structures: []
                  }));

            const updatedAreas = currentAreas.map((area: any) => {
              if (area.name !== formActivity.areaName) return area;

              if (AREAS_WITH_SISTEMAS.includes(area.name)) {
                const sisList = [...(area.sistemas || [])];
                const targetSisName = newActObj.sistemaName || '';
                if (!targetSisName) return area;
                let sisIdx = sisList.findIndex(
                  (sis) =>
                    (sis.name || '').toLowerCase() === targetSisName.toLowerCase() &&
                    (sis.locationType || 'Interno') === newActObj.locationType
                );
                let sisObj =
                  sisIdx >= 0
                    ? { ...sisList[sisIdx] }
                    : {
                        id: generateId('sis'),
                        name: targetSisName,
                        locationType: newActObj.locationType,
                        structures: []
                      };
                const strList = [...(sisObj.structures || [])];
                let strObj = strList.find(
                  (st: any) =>
                    (st.name || '').toLowerCase() ===
                    newActObj.structureName.toLowerCase()
                );
                if (!strObj) {
                  strObj = {
                    id: generateId('str'),
                    name: newActObj.structureName,
                    activities: [
                      { ...newActObj, id: generateId('act'), sistemaName: targetSisName }
                    ]
                  };
                  strList.push(strObj);
                } else {
                  const alreadyExists = (strObj.activities || []).some(
                    (ex: any) => ex.code === newActObj.code
                  );
                  strObj = {
                    ...strObj,
                    activities: alreadyExists
                      ? strObj.activities
                      : [
                          ...(strObj.activities || []),
                          { ...newActObj, id: generateId('act'), sistemaName: targetSisName }
                        ]
                  };
                  const strIdx = strList.findIndex((st: any) => st.id === strObj.id);
                  if (strIdx >= 0) strList[strIdx] = strObj;
                }
                sisObj = { ...sisObj, structures: strList };
                if (sisIdx >= 0) {
                  sisList[sisIdx] = sisObj;
                } else {
                  sisList.push(sisObj);
                }
                return { ...area, hasSistemas: true, sistemas: sisList };
              } else {
                const strList = [...(area.structures || [])];
                let strObj = strList.find(
                  (st: any) =>
                    (st.name || '').toLowerCase() ===
                    newActObj.structureName.toLowerCase()
                );
                if (!strObj) {
                  strObj = {
                    id: generateId('str'),
                    name: newActObj.structureName,
                    activities: [{ ...newActObj, id: generateId('act') }]
                  };
                  strList.push(strObj);
                } else {
                  const alreadyExists = (strObj.activities || []).some(
                    (ex: any) => ex.code === newActObj.code
                  );
                  strObj = {
                    ...strObj,
                    activities: alreadyExists
                      ? strObj.activities
                      : [
                          ...(strObj.activities || []),
                          { ...newActObj, id: generateId('act') }
                        ]
                  };
                  const strIdx = strList.findIndex((st: any) => st.id === strObj.id);
                  if (strIdx >= 0) strList[strIdx] = strObj;
                }
                return { ...area, hasSistemas: false, structures: strList };
              }
            });

            return { ...g, areas: updatedAreas };
          })
        };
      })
    );

    // Si el usuario eligió otro galpón destino en el modal, cambiamos a ese galpón y sector para que vea su actividad de inmediato
    const targetGalInfo = allGalponesList.find((g) => g.id === primaryGalponId);
    if (targetGalInfo) {
      setSelectedSectorId(targetGalInfo.sectorId);
      setSelectedGalponId(targetGalInfo.id);
    }

    const targetGalLabels = targetGalponIds
      .map((gid) => {
        const gObj = allGalponesList.find((g) => g.id === gid);
        return gObj ? `${gObj.sectorName} • ${gObj.code}` : gid;
      })
      .join(', ');

    recordUserMovement(
      'REGISTRO',
      'Actividades',
      `Registró actividad [${newActObj.code}] ${newActObj.name} (${formActivity.areaName} • ${newActObj.structureName}) en ${targetGalLabels}`
    );

    // Sincronizar filtros de la tabla de actividades para que siempre sea visible inmediatamente
    if (filterActArea !== 'Todas' && filterActArea !== formActivity.areaName) {
      setFilterActArea('Todas');
    }
    if (filterActLocation !== 'Todos' && filterActLocation !== newActObj.locationType) {
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

    setSectors((prev) =>
      prev.map((s) => {
        if (s.id !== currentSector.id) return s;
        return {
          ...s,
          galpones: s.galpones.map((g: any) => {
            if (g.id !== currentGalpon.id) return g;
            return {
              ...g,
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
                                targetUnits:
                                  Number(modalEditGalponActivity.targetUnits) || 0,
                                unit: (modalEditGalponActivity.unit || '').trim(),
                                weight: Number(modalEditGalponActivity.weight) || 1.0,
                                plannedHH:
                                  Number(modalEditGalponActivity.plannedHH) || 0,
                                startDate: modalEditGalponActivity.startDate,
                                dueDate: modalEditGalponActivity.dueDate
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
                            targetUnits:
                              Number(modalEditGalponActivity.targetUnits) || 0,
                            unit: (modalEditGalponActivity.unit || '').trim(),
                            weight: Number(modalEditGalponActivity.weight) || 1.0,
                            plannedHH: Number(modalEditGalponActivity.plannedHH) || 0,
                            startDate: modalEditGalponActivity.startDate,
                            dueDate: modalEditGalponActivity.dueDate
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
          (adv.activityId === modalEditGalponActivity.id ||
            (oldCode && adv.activityCode === oldCode))
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

    recordUserMovement(
      'MODIFICACIÓN',
      'Actividades',
      `Modificó actividad [${oldCode && oldCode !== newCode ? `${oldCode} → ${newCode}` : newCode}] ${newName} en galpón ${currentGalpon.code}`
    );
    setModalEditGalponActivity(null);
  };

  const requestDeleteGalponActivity = (actId: string) => {
    if (!requirePermission('actividades', 'delete')) return;
    if (!currentGalpon || !currentSector) return;
    const targetAct = evaluatedActivities.find((a) => a.id === actId);
    if (!targetAct) return;
    const relatedAdvancesCount = dailyAdvances.filter(
      (a) =>
        a.galponId === currentGalpon.id &&
        (a.activityId === actId || a.activityCode === targetAct.code)
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
    const targetAct = evaluatedActivities.find((a) => a.id === actId);
    setSectors((prev) =>
      prev.map((s) => {
        if (s.id !== currentSector.id) return s;
        return {
          ...s,
          galpones: s.galpones.map((g: any) => {
            if (g.id !== currentGalpon.id) return g;
            return {
              ...g,
              areas: (g.areas || []).map((area: any) => {
                if (area.hasSistemas && area.sistemas) {
                  return {
                    ...area,
                    sistemas: area.sistemas.map((sis: any) => ({
                      ...sis,
                      structures: (sis.structures || []).map((str: any) => ({
                        ...str,
                        activities: (str.activities || []).map((a: any) =>
                          a.id === actId ? { ...a, [field]: value } : a
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
                      a.id === actId ? { ...a, [field]: value } : a
                    )
                  }))
                };
              })
            };
          })
        };
      })
    );
    recordUserMovement(
      'MODIFICACIÓN',
      'Actividades',
      `Actualizó fecha de ${field === 'startDate' ? 'Inicio' : 'Fin'} (${value}) en actividad [${targetAct?.code || actId}] del galpón ${currentGalpon.code}`
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
    setModalNewMaterial(true);
  };

  const handleSaveMaterial = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('materiales', editingMaterialId ? 'edit' : 'create')) return;
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
      return;
    }
    if (hasSistemas && !finalSistema) {
      return;
    }

    let resolvedSectorId = formMaterial.sectorId || '';
    const resolvedGalponId = formMaterial.galponId || '';
    let resolvedAreaId = formMaterial.areaId || '';
    let resolvedSistemaId = hasSistemas ? formMaterial.sistemaId || '' : '';
    let resolvedStructureId = formMaterial.structureId || '';
    const resolvedLocType = hasSistemas ? formMaterial.locationType || 'Interno' : '';

    if (resolvedGalponId) {
      const galInfo = allGalponesList.find((g) => g.id === resolvedGalponId);
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
                resolvedStructureId = strObj.id || resolvedStructureId;
              }
            }
          } else {
            const strObj = (areaObj.structures || []).find(
              (st: any) =>
                (st.name || '').toLowerCase() === finalStructure.toLowerCase()
            );
            if (strObj) {
              resolvedStructureId = strObj.id || resolvedStructureId;
            }
          }
        }
      }

      // Si el área/sistema/estructura aún no tenía nodo en el galpón, lo garantizamos con IDs únicos
      if (!resolvedAreaId) resolvedAreaId = generateId('area');
      if (hasSistemas && !resolvedSistemaId) resolvedSistemaId = generateId('sis');
      if (!resolvedStructureId) resolvedStructureId = generateId('str');

      setSectors((prev) =>
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
      usedQty: computeMaterialUsedQty(baseMatPayload, dailyAdvances)
    };

    const assignedGalForLog = allGalponesList.find(
      (g) => g.id === newMatPayload.galponId
    );
    const galLabelForLog = assignedGalForLog
      ? `${assignedGalForLog.sectorName} • ${assignedGalForLog.code}`
      : 'Sin galpón asignado';

    if (editingMaterialId) {
      setMaterials((prev) =>
        prev.map((m) => (m.id === editingMaterialId ? newMatPayload : m))
      );
      recordUserMovement(
        'MODIFICACIÓN',
        'Materiales',
        `Modificó material [${newMatPayload.code}] ${newMatPayload.name} (${newMatPayload.totalQty} ${newMatPayload.unit} • Proveedor: ${newMatPayload.technology}) en ${galLabelForLog} / ${newMatPayload.structureName}`
      );
    } else {
      setMaterials((prev) => [...prev, newMatPayload]);
      recordUserMovement(
        'REGISTRO',
        'Materiales',
        `Registró material [${newMatPayload.code}] ${newMatPayload.name} (${newMatPayload.totalQty} ${newMatPayload.unit} • Proveedor: ${newMatPayload.technology}) en ${galLabelForLog} / ${newMatPayload.structureName}`
      );
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
    setFormAdvance({
      areaName: prefill?.areaName || '',
      locationType: prefill?.locationType || 'Todos',
      sistemaName: prefill?.sistemaName || '',
      structureName: prefill?.structureName || '',
      activityCode: prefill?.activityCode || '',
      date: '',
      quantityToday: '',
      hoursWorked: '',
      supervisor: '',
      note: '',
      sharedAcrossTwoGalpones: false,
      secondGalponId: '',
      splitMode: '100_both',
      manualMaterialInputs: {}
    });
    setModalNewAdvance(true);
  };

  const openEditAdvanceModal = (adv: any) => {
    if (!requirePermission('avance_diario', 'edit')) return;
    setEditingAdvanceId(adv.id);
    const act = evaluatedActivities.find(
      (a) => (adv.activityId && a.id === adv.activityId) || a.code === adv.activityCode
    );
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
      activityCode: adv.activityCode || '',
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
      manualMaterialInputs: manualInputs
    });
    setModalNewAdvance(true);
  };

  const handleSaveAdvance = (e: React.FormEvent) => {
    e.preventDefault();
    if (!requirePermission('avance_diario', editingAdvanceId ? 'edit' : 'create')) return;
    if (!formAdvance.activityCode || !formAdvance.quantityToday || !currentGalpon)
      return;

    const rawQty = Number(formAdvance.quantityToday) || 0;
    const rawHH = Number(formAdvance.hoursWorked) || 0;
    const isShared =
      formAdvance.sharedAcrossTwoGalpones &&
      Boolean(formAdvance.secondGalponId) &&
      formAdvance.secondGalponId !== currentGalpon.id;
    const factor = isShared && formAdvance.splitMode === '50_50' ? 0.5 : 1;

    const qtyPerGalpon = Math.round(rawQty * factor * 100) / 100;
    const hhPerGalpon = Math.round(rawHH * factor * 100) / 100;

    const selectedAct = evaluatedActivities.find(
      (a) => a.code === formAdvance.activityCode
    );
    const secondGalponObj = isShared
      ? allGalponesList.find((g) => g.id === formAdvance.secondGalponId)
      : null;

    // Encontrar actividad equivalente en el segundo galpón (si existe) para vincular su activityId
    let secondGalponActId: string | undefined = undefined;
    if (secondGalponObj) {
      (secondGalponObj.areas || []).forEach((area: any) => {
        if (area.hasSistemas && area.sistemas) {
          area.sistemas.forEach((sis: any) => {
            (sis.structures || []).forEach((str: any) => {
              (str.activities || []).forEach((act: any) => {
                if (act.code === formAdvance.activityCode) {
                  secondGalponActId = act.id;
                }
              });
            });
          });
        } else {
          (area.structures || []).forEach((str: any) => {
            (str.activities || []).forEach((act: any) => {
              if (act.code === formAdvance.activityCode) {
                secondGalponActId = act.id;
              }
            });
          });
        }
      });
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
            // Si existe un material homólogo asignado específicamente al segundo galpón, repartimos 50/50 entre ambos inventarios;
            // si el material pertenece solo al galpón actual o es global, descontamos una única vez sobre su materialId sin duplicar descuento.
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

    const finalSupervisor =
      formAdvance.supervisor.trim() ||
      currentGalpon.supervisors?.[0] ||
      activeUserName ||
      '';

    const cleanUserNote = formAdvance.note
      .replace(/^\[Trabajo Biproyecto[^\]]*\]\s*/i, '')
      .trim();

    if (editingAdvanceId) {
      const oldAdv = dailyAdvances.find((a) => a.id === editingAdvanceId);
      const oldGroupId = oldAdv?.sharedGroupId;

      // Removemos el avance anterior (y su par biproyecto si pertenecía a un grupo compartido) para reemplazarlo limpiamente
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
        galponId: currentGalpon.id,
        activityId: selectedAct?.id || oldAdv?.activityId,
        activityCode: formAdvance.activityCode,
        date: formAdvance.date || getSystemToday(),
        quantityToday: qtyPerGalpon,
        hoursWorked: hhPerGalpon,
        supervisor: finalSupervisor,
        note: isShared
          ? `[Trabajo Biproyecto ${formAdvance.splitMode === '50_50' ? '50/50' : '100% Ambos'} con ${secondGalponObj?.code || formAdvance.secondGalponId}]${cleanUserNote ? ` ${cleanUserNote}` : ''}`
          : cleanUserNote,
        materialsUsedToday: primaryGalponMatsList
      };

      const replacementLogs: any[] = [updatedPrimaryLog];

      if (isShared && secondGalponObj) {
        replacementLogs.push({
          id: generateId('adv'),
          sharedGroupId,
          isSecondarySharedCopy: true,
          sharedWithGalponId: currentGalpon.id,
          sharedWithGalponCode: currentGalpon.code,
          splitMode: formAdvance.splitMode,
          rawInputQty: rawQty,
          rawInputHH: rawHH,
          galponId: secondGalponObj.id,
          activityId: secondGalponActId,
          activityCode: formAdvance.activityCode,
          date: formAdvance.date || getSystemToday(),
          quantityToday: qtyPerGalpon,
          hoursWorked: hhPerGalpon,
          supervisor: finalSupervisor,
          note: `[Trabajo Biproyecto ${formAdvance.splitMode === '50_50' ? '50/50' : '100% Ambos'} con ${currentGalpon.code}]${cleanUserNote ? ` ${cleanUserNote}` : ''}`,
          materialsUsedToday: secondaryGalponMatsList
        });
      }

      const nextAdvances = [...replacementLogs, ...baseAdvances];
      setDailyAdvances(nextAdvances);
      setMaterials((prevMats) =>
        recalculateMaterialsFromAdvances(prevMats, nextAdvances)
      );

      const matsSummary =
        totalUsedMatsList.length > 0
          ? ` | Materiales: ${totalUsedMatsList.map((u) => `${u.name} (-${u.qty} ${u.unit})`).join(', ')}`
          : '';

      recordUserMovement(
        'MODIFICACIÓN',
        'Avance Diario',
        `Modificó parte diario${isShared ? ` Biproyecto (${currentGalpon.code} + ${secondGalponObj?.code || ''})` : ''} de [${formAdvance.activityCode}] ${selectedAct?.name || ''}: +${qtyPerGalpon} ${selectedAct?.unit || ''} c/u, ${hhPerGalpon} HH c/u (Fecha: ${updatedPrimaryLog.date})${matsSummary}`,
        finalSupervisor || activeUserName
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
          galponId: currentGalpon.id,
          activityId: selectedAct?.id,
          activityCode: formAdvance.activityCode,
          date: formAdvance.date || getSystemToday(),
          quantityToday: qtyPerGalpon,
          hoursWorked: hhPerGalpon,
          supervisor: finalSupervisor,
          note: isShared
            ? `[Trabajo Biproyecto ${formAdvance.splitMode === '50_50' ? '50/50' : '100% Ambos'} con ${secondGalponObj?.code || formAdvance.secondGalponId}]${cleanUserNote ? ` ${cleanUserNote}` : ''}`
            : cleanUserNote,
          materialsUsedToday: primaryGalponMatsList
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
          galponId: secondGalponObj.id,
          activityId: secondGalponActId,
          activityCode: formAdvance.activityCode,
          date: formAdvance.date || getSystemToday(),
          quantityToday: qtyPerGalpon,
          hoursWorked: hhPerGalpon,
          supervisor: finalSupervisor,
          note: `[Trabajo Biproyecto ${formAdvance.splitMode === '50_50' ? '50/50' : '100% Ambos'} con ${currentGalpon.code}]${cleanUserNote ? ` ${cleanUserNote}` : ''}`,
          materialsUsedToday: secondaryGalponMatsList
        });
      }

      const nextAdvances = [...newLogs, ...dailyAdvances];
      setDailyAdvances(nextAdvances);
      setMaterials((prevMats) =>
        recalculateMaterialsFromAdvances(prevMats, nextAdvances)
      );

      const matsSummary =
        totalUsedMatsList.length > 0
          ? ` | Materiales: ${totalUsedMatsList.map((u) => `${u.name} (-${u.qty} ${u.unit})`).join(', ')}`
          : '';

      recordUserMovement(
        'REGISTRO',
        'Avance Diario',
        `Registró parte diario${isShared ? ` Biproyecto (${currentGalpon.code} + ${secondGalponObj?.code || ''})` : ''} de [${formAdvance.activityCode}] ${selectedAct?.name || ''}: +${qtyPerGalpon} ${selectedAct?.unit || ''} c/u, ${hhPerGalpon} HH c/u (Fecha: ${newLogs[0].date})${matsSummary}`,
        finalSupervisor || activeUserName
      );
    }

    setModalNewAdvance(false);
    setEditingAdvanceId(null);
    setFormAdvance({
      areaName: '',
      locationType: 'Todos',
      sistemaName: '',
      structureName: '',
      activityCode: '',
      date: '',
      quantityToday: '',
      hoursWorked: '',
      supervisor: '',
      note: '',
      sharedAcrossTwoGalpones: false,
      secondGalponId: '',
      splitMode: '100_both',
      manualMaterialInputs: {}
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
      workerCode: formWorker.workerCode.trim().toUpperCase(),
      dni: formWorker.dni.trim(),
      name: formWorker.name.trim(),
      workArea: formWorker.workArea.trim(),
      role: formWorker.role.trim(),
      sectorId: formWorker.sectorId || '',
      galponId: formWorker.galponId || '',
      active: true
    };

    if (formWorker.id) {
      setMasterWorkforce((prev) =>
        prev.map((w) => (w.id === formWorker.id ? payload : w))
      );
      recordUserMovement(
        'MODIFICACIÓN',
        'Personal y Asistencia',
        `Modificó operario [${payload.workerCode}] ${payload.name} (${payload.workArea})`
      );
    } else {
      setMasterWorkforce((prev) => [...prev, payload]);
      recordUserMovement(
        'REGISTRO',
        'Personal y Asistencia',
        `Registró operario [${payload.workerCode}] ${payload.name} (${payload.workArea} • ${payload.role})`
      );
    }

    setModalNewWorker(false);
  };

  const handleWorkerFieldChange = (workerId: string, field: string, value: any) => {
    if (!requirePermission('personal', 'edit')) return;
    const targetW = masterWorkforce.find((w) => w.id === workerId);
    setMasterWorkforce((prev) =>
      prev.map((w) => (w.id === workerId ? { ...w, [field]: value } : w))
    );
    recordUserMovement(
      'MODIFICACIÓN',
      'Personal y Asistencia',
      `Actualizó ${field} de operario [${targetW?.workerCode || workerId}] ${targetW?.name || ''}`
    );
  };

  const handleWorkerSectorChange = (workerId: string, newSectorId: string) => {
    if (!requirePermission('personal', 'edit')) return;
    const targetW = masterWorkforce.find((w) => w.id === workerId);
    const targetSector = sectors.find((s) => s.id === newSectorId);

    setMasterWorkforce((prev) =>
      prev.map((w) =>
        w.id === workerId
          ? { ...w, sectorId: newSectorId, galponId: '' }
          : w
      )
    );
    recordUserMovement(
      'MODIFICACIÓN',
      'Personal y Asistencia',
      `Reasignó sector de operario [${targetW?.workerCode || workerId}] ${targetW?.name || ''} a ${targetSector?.name || 'Sin sector asignado'}`
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
    if (!requirePermission('asistencia', 'edit')) return;
    const targetW = masterWorkforce.find((w) => w.id === workerId);
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
    recordUserMovement(
      'MODIFICACIÓN',
      'Personal y Asistencia',
      `Marcó asistencia "${status}" para [${targetW?.workerCode || workerId}] ${targetW?.name || ''} (${attendanceDate})`
    );
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
    recordUserMovement(
      'MODIFICACIÓN',
      'Personal y Asistencia',
      `Marcó "Asistió" a ${filteredAttendanceWorkers.length} operarios en fecha ${attendanceDate}`
    );
  };

  // ==========================================================================
  // CARGA MASIVA EXCEL (.XLSX / .CSV / PEGADO DIRECTO) CON VISTA PREVIA (C-6)
  // ==========================================================================
  const resetBulkUploadState = () => {
    setBulkCsvText('');
    setBulkRawRows([]);
    setBulkFileName('');
    setBulkTargetGalponId('');
    setModalBulkUpload(null);
  };

  const handleBulkFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBulkFileName(file.name);

    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'csv' || ext === 'txt') {
        const text = await file.text();
        const rows = parsePastedTabularText(text);
        setBulkRawRows(rows);
      } else {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) {
          setBulkRawRows([]);
          return;
        }
        const sheet = workbook.Sheets[firstSheetName];
        const jsonMatrix = XLSX.utils.sheet_to_json<any[]>(sheet, {
          header: 1,
          defval: '',
          raw: false
        });
        const cleanRows = (jsonMatrix || [])
          .map((row) =>
            (Array.isArray(row) ? row : []).map((cell) => String(cell ?? '').trim())
          )
          .filter((row) => row.some((c) => c !== ''));
        setBulkRawRows(cleanRows);
      }
    } catch (err) {
      console.error('Error al leer archivo de importación:', err);
      setBulkRawRows([]);
    } finally {
      e.target.value = '';
    }
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

      const existingCodes = new Set(
        masterCatalog.map((c) => `${(c.technology || '').toLowerCase()}::${(c.code || '').toUpperCase()}`)
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
        const unit = (cols[idxUnit] || '').trim();
        const rawWeight = (cols[idxWeight] || '').trim();
        const rawHH = (cols[idxHH] || '').trim();

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
        if (!rawTarget || isNaN(targetUnits) || targetUnits <= 0) {
          errors.push('Meta debe ser mayor a 0');
        }
        if (!unit) errors.push('Falta Unidad');

        let status: 'valid' | 'duplicate' | 'rejected' = 'valid';
        let statusReason = 'Fila válida lista para importar';

        const compositeKey = `${technology.toLowerCase()}::${code}`;
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
            targetUnits: isNaN(targetUnits) ? 0 : targetUnits,
            unit,
            weight: isNaN(weight) || weight <= 0 ? 1.0 : weight,
            plannedHH: isNaN(plannedHH) || plannedHH < 0 ? 0 : plannedHH,
            durationDays: 5
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
        masterWorkforce.map((w) => (w.workerCode || '').toUpperCase())
      );

      dataRows.forEach((cols, i) => {
        const rowNumber = hasHeader ? i + 2 : i + 1;
        const workerCode = (cols[idxCode] || '').trim().toUpperCase();
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

  const handleConfirmBulkUpload = (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalBulkUpload) return;
    if (!requirePermission(modalBulkUpload, 'import')) return;
    const validPayloads = bulkImportAnalysis.validRows.map((r) => r.payload);
    if (validPayloads.length === 0) return;

    if (modalBulkUpload === 'catalogo') {
      const newTechs = new Set(technologies);
      validPayloads.forEach((item) => {
        if (item.technology) newTechs.add(item.technology);
      });
      setTechnologies(Array.from(newTechs));
      setMasterCatalog((prev) => [...prev, ...validPayloads]);
      recordUserMovement(
        'REGISTRO',
        'Carga Masiva',
        `Importó ${validPayloads.length} actividades válidas al Catálogo Maestro (${bulkImportAnalysis.duplicateRows.length} duplicadas omitidas, ${bulkImportAnalysis.rejectedRows.length} rechazadas)`
      );
    } else if (modalBulkUpload === 'materiales') {
      const newTechs = new Set(technologies);
      validPayloads.forEach((mat) => {
        if (mat.technology) newTechs.add(mat.technology);
      });
      setTechnologies(Array.from(newTechs));
      setMaterials((prev) => [...prev, ...validPayloads]);
      recordUserMovement(
        'REGISTRO',
        'Carga Masiva',
        `Importó ${validPayloads.length} materiales válidos en Control de Materiales (${bulkImportAnalysis.duplicateRows.length} duplicados omitidos, ${bulkImportAnalysis.rejectedRows.length} rechazados)`
      );
    } else if (modalBulkUpload === 'personal') {
      setMasterWorkforce((prev) => [...prev, ...validPayloads]);
      recordUserMovement(
        'REGISTRO',
        'Carga Masiva',
        `Importó ${validPayloads.length} operarios válidos a la Planilla de Personal (${bulkImportAnalysis.duplicateRows.length} duplicados omitidos, ${bulkImportAnalysis.rejectedRows.length} rechazados)`
      );
    }

    resetBulkUploadState();
  };

  // ==========================================================================
  // EXPORTACIONES CSV COMPATIBLES CON EXCEL (UTF-8 BOM + BLOB - C-8)
  // ==========================================================================
  const handleExportGlobalCSV = () => {
    if (!requirePermission('informes', 'export')) return;
    const headers = [
      'Sector',
      'Galpón',
      'Proveedor',
      'Área',
      'Ubicación',
      'Sistema',
      'Estructura',
      'Código',
      'Actividad',
      'Meta',
      'Unidad',
      'Peso',
      'Ejecutado',
      'Avance %',
      'HH Plan',
      'HH Ejec',
      'Estado'
    ];
    const rows: (string | number)[][] = [];

    scopedSectors.forEach((sec) => {
      (sec.galpones || []).forEach((gal: any) => {
        (gal.areas || []).forEach((area: any) => {
          const pushRow = (
            sisName: string,
            locType: string,
            strName: string,
            act: any
          ) => {
            const logs = dailyAdvances.filter(
              (l) =>
                l.galponId === gal.id &&
                ((l.activityId && l.activityId === act.id) ||
                  l.activityCode === act.code)
            );
            const execQty = logs.reduce(
              (s, i) => s + Number(i.quantityToday || 0),
              0
            );
            const execHH = logs.reduce(
              (s, i) => s + Number(i.hoursWorked || 0),
              0
            );
            const pct =
              act.targetUnits > 0
                ? Math.min(100, Math.round((execQty / act.targetUnits) * 1000) / 10)
                : 0;
            rows.push([
              sec.name || '',
              gal.code || '',
              gal.technology || 'Sin proveedor',
              area.name || '',
              locType || 'Interno',
              sisName || '-',
              strName || '',
              act.code || '',
              act.name || '',
              act.targetUnits ?? 0,
              act.unit || '',
              act.weight ?? 1,
              execQty,
              `${pct}%`,
              act.plannedHH || 0,
              execHH,
              pct >= 100 ? 'Completada' : pct > 0 ? 'En proceso' : 'Pendiente'
            ]);
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

    downloadCsvFile(
      `Reporte_Global_Galpones_${getSystemToday()}.csv`,
      headers,
      rows
    );
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
      const used = computeMaterialUsedQty(m, dailyAdvances);
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

  const handleExportMovementsCSV = () => {
    if (!requirePermission('movimientos', 'export')) return;
    const headers = [
      'Fecha y Hora',
      'Usuario',
      'Tipo de Movimiento',
      'Módulo',
      'Detalle del Movimiento'
    ];
    const visibleLogs = auditLogs.filter((log) => {
      if (filterLogAction !== 'Todas' && log.action !== filterLogAction) return false;
      if (filterLogModule !== 'Todos' && log.module !== filterLogModule) return false;
      if (searchLogText.trim()) {
        const q = searchLogText.toLowerCase().trim();
        const match =
          (log.description || '').toLowerCase().includes(q) ||
          (log.user || '').toLowerCase().includes(q) ||
          (log.module || '').toLowerCase().includes(q) ||
          (log.action || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });

    const rows = visibleLogs.map((log: any) => [
      log.timestamp || '',
      log.user || '',
      log.action || '',
      log.module || '',
      log.description || ''
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
    return evaluatedActivities.find((a) => a.code === formAdvance.activityCode) || null;
  }, [evaluatedActivities, formAdvance.activityCode]);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 font-sans flex flex-col antialiased selection:bg-emerald-100 selection:text-emerald-900">
      {/* ==================================================================== */}
      {/* 1. BARRA LATERAL (SIDEBAR)                                           */}
      {/* ==================================================================== */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed top-0 bottom-0 left-0 z-50 w-72 sm:w-80 bg-white border-r border-slate-200 shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="p-4 bg-[#0f6b38] text-white flex items-center justify-between border-b border-[#0a4e28]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-white text-[#0f6b38] flex items-center justify-center font-black text-sm shadow-sm">
              PA
            </div>
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-tight">
                Proyectos Automatizados
              </h2>
              <p className="text-[11px] text-emerald-100">Menú de control</p>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1.5 rounded-lg text-emerald-100 hover:bg-emerald-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-3 bg-slate-50 border-b border-slate-200 text-xs">
          <span className="text-[10px] uppercase font-bold text-slate-400 block mb-0.5">
            Contexto Activo:
          </span>
          <div className="font-bold text-[#0f6b38] truncate">
            {currentSector ? currentSector.name : 'Sin Sector creado'}
          </div>
          <div className="font-extrabold text-slate-800 flex items-center gap-1.5 mt-0.5">
            <Building2 className="w-3.5 h-3.5 text-[#0f6b38]" />
            <span>
              {currentGalpon
                ? `${currentGalpon.code} - ${currentGalpon.name} (${currentGalpon.technology || 'Sin proveedor'})`
                : 'Sin Galpón seleccionado'}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1 text-xs font-semibold">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-3 py-1">
            Módulos de Administración
          </div>

          <button
            onClick={() => {
              setCurrentTab('proyectos');
              setSidebarOpen(false);
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition ${
              currentTab === 'proyectos'
                ? 'bg-emerald-50 text-[#0f6b38] font-bold border border-emerald-200'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Building2 className="w-4 h-4 text-[#0f6b38]" />
            <div className="text-left">
              <span className="block font-bold">Proyectos y Galpones</span>
              <span className="text-[10px] text-slate-500 font-normal">
                Crear, editar y eliminar sectores y galpones
              </span>
            </div>
          </button>

          <button
            onClick={() => {
              setCurrentTab('catalogo');
              setSidebarOpen(false);
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition ${
              currentTab === 'catalogo'
                ? 'bg-emerald-50 text-[#0f6b38] font-bold border border-emerald-200'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <BookOpen className="w-4 h-4 text-[#0f6b38]" />
            <div className="text-left">
              <span className="block font-bold">Catálogo Maestro y Plantillas</span>
              <span className="text-[10px] text-slate-500 font-normal">
                Proveedores, estructuras y actividades base
              </span>
            </div>
          </button>

          <button
            onClick={() => {
              setCurrentTab('actividades');
              setSidebarOpen(false);
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition ${
              currentTab === 'actividades'
                ? 'bg-emerald-50 text-[#0f6b38] font-bold border border-emerald-200'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Table className="w-4 h-4 text-[#0f6b38]" />
            <div className="text-left">
              <span className="block font-bold">Gestión de Actividades</span>
              <span className="text-[10px] text-slate-500 font-normal">
                Actividades del galpón (6 áreas)
              </span>
            </div>
          </button>

          <button
            onClick={() => {
              setCurrentTab('materiales');
              setSidebarOpen(false);
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition ${
              currentTab === 'materiales'
                ? 'bg-emerald-50 text-[#0f6b38] font-bold border border-emerald-200'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Package className="w-4 h-4 text-[#0f6b38]" />
            <div className="text-left">
              <span className="block font-bold">Control de Materiales</span>
              <span className="text-[10px] text-slate-500 font-normal">
                Materiales vinculados por estructura
              </span>
            </div>
          </button>

          <button
            onClick={() => {
              setCurrentTab('personal');
              setSidebarOpen(false);
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition ${
              currentTab === 'personal'
                ? 'bg-emerald-50 text-[#0f6b38] font-bold border border-emerald-200'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Users className="w-4 h-4 text-[#0f6b38]" />
            <div className="text-left">
              <span className="block font-bold">Planilla de Personal</span>
              <span className="text-[10px] text-slate-500 font-normal">
                Código manual, área y asignación
              </span>
            </div>
          </button>

          <button
            onClick={() => {
              setCurrentTab('informes');
              setSidebarOpen(false);
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition ${
              currentTab === 'informes'
                ? 'bg-emerald-50 text-[#0f6b38] font-bold border border-emerald-200'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4 text-[#0f6b38]" />
            <div className="text-left">
              <span className="block font-bold">Informes Globales</span>
              <span className="text-[10px] text-slate-500 font-normal">
                Sábana multiproyecto y exportación CSV
              </span>
            </div>
          </button>

          <button
            onClick={() => {
              setCurrentTab('movimientos');
              setSidebarOpen(false);
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition ${
              currentTab === 'movimientos'
                ? 'bg-emerald-50 text-[#0f6b38] font-bold border border-emerald-200'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <ClipboardList className="w-4 h-4 text-[#0f6b38]" />
            <div className="text-left">
              <span className="block font-bold">Historial de Movimientos</span>
              <span className="text-[10px] text-slate-500 font-normal">
                Registros, modificaciones y eliminaciones ({auditLogs.length})
              </span>
            </div>
          </button>
        </div>

        <div className="p-3 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-500 flex items-center justify-between">
          <span>Firestore Realtime</span>
          <span className="text-[#0f6b38] font-bold">
            {syncStatus === 'synced'
              ? 'Sincronizado'
              : syncStatus === 'syncing'
                ? 'Sincronizando...'
                : 'Modo local'}
          </span>
        </div>
      </aside>

      {/* ==================================================================== */}
      {/* 2. CABECERA SUPERIOR                                                 */}
      {/* ==================================================================== */}
      <header className="bg-[#0f6b38] text-white shadow-md sticky top-0 z-40 border-b border-[#0a4e28]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between py-2.5 border-b border-white/10 gap-2">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-2 rounded-xl bg-emerald-800/80 hover:bg-emerald-700 text-white transition ring-1 ring-emerald-500/40"
                title="Abrir Menú de Control"
              >
                <Menu className="w-5 h-5" />
              </button>

              <div>
                <h1 className="text-sm sm:text-base font-extrabold tracking-tight uppercase">
                  Proyectos Galpones Automatizados
                </h1>
                <p className="text-[11px] text-emerald-100 hidden sm:block">
                  Actividades, materiales, asistencia e indicadores •{' '}
                  <span className="font-bold text-white">
                    {syncStatus === 'synced'
                      ? `Firestore en vivo${lastSyncedAt ? ` (${lastSyncedAt})` : ''}`
                      : syncStatus === 'syncing'
                        ? 'Sincronizando Firestore...'
                        : 'Caché local'}
                  </span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end">
              {canDo('proyectos', 'view') && (
                <button
                  onClick={() => setCurrentTab('proyectos')}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-bold bg-emerald-800/80 text-white hover:bg-emerald-700 transition border border-emerald-600/40"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">Sectores / Galpones</span>
                </button>
              )}

              {canDo('catalogo', 'view') && (
                <button
                  onClick={() => setCurrentTab('catalogo')}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-bold bg-white text-[#0f6b38] shadow-xs hover:bg-slate-50 transition"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Catálogo Maestro</span>
                </button>
              )}

              {canDo('materiales', 'view') && (
                <button
                  onClick={() => setCurrentTab('materiales')}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-bold bg-white text-[#0f6b38] shadow-xs hover:bg-slate-50 transition"
                >
                  <Package className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Materiales</span>
                </button>
              )}

              {canDo('movimientos', 'view') && (
                <button
                  onClick={() => setCurrentTab('movimientos')}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-bold bg-emerald-800/80 text-white hover:bg-emerald-700 transition border border-emerald-600/40"
                >
                  <ClipboardList className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Movimientos</span>
                </button>
              )}
            </div>
          </div>

          {/* Fila 2: Selectores de Sector y Galpón */}
          <div className="py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 overflow-x-auto">
              <span className="text-[11px] uppercase tracking-wider text-emerald-200 font-bold shrink-0">
                Sector:
              </span>
              {scopedSectors.length === 0 ? (
                canDo('proyectos', 'create') ? (
                  <button
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
                    className="px-2.5 py-1 rounded-lg bg-amber-400 text-slate-950 font-black text-xs"
                  >
                    + Crear Primer Sector
                  </button>
                ) : (
                  <span className="text-emerald-200 italic">Sin sectores asignados</span>
                )
              ) : (
                scopedSectors.map((sec) => {
                  const isSel = currentSector?.id === sec.id;
                  return (
                    <button
                      key={sec.id}
                      onClick={() => handleSelectSector(sec.id)}
                      className={`px-3 py-1 rounded-lg text-xs font-bold shrink-0 transition flex items-center gap-1 ${
                        isSel
                          ? 'bg-white text-[#0f6b38] shadow-sm'
                          : 'bg-emerald-800/80 text-emerald-100 hover:bg-emerald-700 border border-emerald-700'
                      }`}
                    >
                      {isSel && <Check className="w-3 h-3 text-[#0f6b38]" />}
                      <span className="truncate max-w-[160px]">{sec.name}</span>
                    </button>
                  );
                })
              )}
              {canDo('proyectos', 'create') && (
                <button
                  onClick={() => {
                    setFormProject({ id: '', code: '', name: '', location: '', client: '' });
                    setModalNewProject(true);
                  }}
                  className="px-2 py-1 rounded-lg bg-emerald-800/90 hover:bg-emerald-700 text-emerald-100 text-[11px] font-bold shrink-0"
                >
                  + Nuevo Sector
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 overflow-x-auto">
              <span className="text-[11px] uppercase tracking-wider text-emerald-200 font-bold shrink-0">
                Galpón:
              </span>
              {!currentSector || !currentSector.galpones?.length ? (
                canDo('proyectos', 'create') ? (
                  <button
                    disabled={!currentSector}
                    onClick={() => {
                      if (!currentSector) return;
                      setFormGalpon({
                        id: '',
                        sectorId: currentSector.id,
                        code: '',
                        name: '',
                        description: '',
                        supervisorsStr: '',
                        startDate: '',
                        endDate: '',
                        technology: ''
                      });
                      setModalNewGalpon(true);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-amber-400 disabled:opacity-40 text-slate-950 font-black text-xs"
                  >
                    + Crear Galpón
                  </button>
                ) : (
                  <span className="text-emerald-200 italic">Sin galpones asignados</span>
                )
              ) : (
                currentSector.galpones.map((gal: any) => {
                  const isSel = currentGalpon?.id === gal.id;
                  return (
                    <button
                      key={gal.id}
                      onClick={() => setSelectedGalponId(gal.id)}
                      className={`px-2.5 py-1 rounded-md text-xs font-bold shrink-0 transition flex items-center gap-1 ${
                        isSel
                          ? 'bg-amber-400 text-slate-950 font-black shadow-sm ring-1 ring-amber-300'
                          : 'bg-emerald-900/60 text-emerald-100 hover:bg-emerald-800 border border-emerald-700/50'
                      }`}
                    >
                      <Building2 className="w-3 h-3" />
                      <span>{gal.code}</span>
                      <span className="text-[10px] opacity-75">({gal.technology})</span>
                    </button>
                  );
                })
              )}
            </div>
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
                className="px-3 py-1.5 rounded-lg bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5"
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
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 pb-24">
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
        {/* VISTA 1: DASHBOARD                                                 */}
        {/* ================================================================== */}
        {currentTab === 'dashboard' && (
          <div className="space-y-6">
            {!currentGalpon ? (
              <div className="bg-white rounded-2xl p-8 text-center border border-slate-200 shadow-xs">
                <Building2 className="w-10 h-10 text-[#0f6b38] mx-auto mb-2" />
                <h2 className="text-base font-extrabold text-slate-900">
                  La aplicación está lista y limpia para empezar desde cero
                </h2>
                <p className="text-xs text-slate-500 mt-1 max-w-lg mx-auto">
                  Primero configura tus actividades y materiales en el{' '}
                  <strong>Catálogo Maestro</strong> o crea directamente tu primer{' '}
                  <strong>Sector y Galpón</strong>.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-3">
                  <button
                    onClick={() => setCurrentTab('catalogo')}
                    className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold"
                  >
                    1. Ir a Catálogo Maestro y Plantillas
                  </button>
                  <button
                    onClick={() => setCurrentTab('proyectos')}
                    className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] text-white text-xs font-bold"
                  >
                    2. Crear Sector y Galpón
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* KPI Cards */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                  <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-500 uppercase mb-1">
                      <span>Avance Ponderado</span>
                      <TrendingUp className="w-4 h-4 text-[#0f6b38]" />
                    </div>
                    <span className="text-3xl font-black text-[#0f6b38] font-mono">
                      {galponWeightedProgress}%
                    </span>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Plantilla: {currentGalpon.technology}
                    </p>
                  </div>

                  <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-500 uppercase mb-1">
                      <span>Asistencia Hoy</span>
                      <UserCheck className="w-4 h-4 text-[#0f6b38]" />
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-black text-slate-900 font-mono">
                        {currentDayAttendance.rate}%
                      </span>
                      <span className="text-xs text-slate-500">
                        ({currentDayAttendance.present}/{currentDayAttendance.total})
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Fecha: {attendanceDate}
                    </p>
                  </div>

                  <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-500 uppercase mb-1">
                      <span>Actividades</span>
                      <CheckCircle2 className="w-4 h-4 text-[#0f6b38]" />
                    </div>
                    <span className="text-3xl font-black text-slate-900 font-mono">
                      {evaluatedActivities.filter((a) => a.progressPercent >= 100).length}/
                      {evaluatedActivities.length}
                    </span>
                    <p className="text-[11px] text-rose-600 font-bold mt-1">
                      {evaluatedActivities.filter((a) => a.shouldHaveStarted).length} sin
                      iniciar en fecha
                    </p>
                  </div>

                  <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-500 uppercase mb-1">
                      <span>Horas Hombre (HH)</span>
                      <Clock className="w-4 h-4 text-[#0f6b38]" />
                    </div>
                    <span className="text-3xl font-black text-slate-900 font-mono">
                      {evaluatedActivities.reduce(
                        (s, a) => s + Number(a.accumulatedHH || 0),
                        0
                      )}
                    </span>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Planificadas:{' '}
                      {evaluatedActivities.reduce(
                        (s, a) => s + Number(a.plannedHH || 0),
                        0
                      )}{' '}
                      HH
                    </p>
                  </div>
                </div>

                {/* Avance por las 6 Áreas */}
                <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
                    <div>
                      <h3 className="text-sm sm:text-base font-extrabold text-slate-900">
                        Avance Ponderado por Área ({currentGalpon.code})
                      </h3>
                      <p className="text-xs text-slate-500">
                        Obra Civil, Edificio, Sistema de Jaulas, Sistema Eléctrico,
                        Gasfitería y Soldadura
                      </p>
                    </div>
                    <button
                      onClick={() => setCurrentTab('actividades')}
                      className="text-xs font-bold text-[#0f6b38] hover:underline"
                    >
                      Gestionar Actividades →
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {areaProgressMetrics.map((area, idx) => (
                      <div
                        key={idx}
                        className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/70"
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-extrabold text-slate-800">
                            {area.name}
                          </span>
                          <span className="text-xs font-mono font-black text-[#0f6b38]">
                            {area.percent}%
                          </span>
                        </div>
                        <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden mb-1.5">
                          <div
                            className="bg-[#0f6b38] h-full rounded-full transition-all duration-500"
                            style={{ width: `${area.percent}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[11px] text-slate-500">
                          <span>Actividades: {area.total}</span>
                          <span>Completadas: {area.completed}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Avance Ponderado por Sistema General (Todos / Interno / Externo) */}
                <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-100 gap-2 mb-4">
                    <div>
                      <h3 className="text-sm sm:text-base font-extrabold text-slate-900">
                        Avance Ponderado por Sistema General
                      </h3>
                      <p className="text-xs text-slate-500">
                        Filtra el avance de los sistemas entre actividades Internas y
                        Externas del galpón
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {(['Todos', 'Interno', 'Externo'] as const).map((loc) => (
                        <button
                          key={loc}
                          onClick={() => setDashSistemaLocFilter(loc)}
                          className={`px-3 py-1 rounded-lg text-xs font-bold transition ${
                            dashSistemaLocFilter === loc
                              ? 'bg-[#0f6b38] text-white'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                        >
                          {loc}
                        </button>
                      ))}
                    </div>
                  </div>

                  {sistemaProgressMetrics.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-4">
                      Aún no hay sistemas registrados en este galpón.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {sistemaProgressMetrics.map((sis, idx) => (
                        <div
                          key={idx}
                          className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/70"
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-xs font-extrabold text-slate-900 truncate">
                              {sis.sistemaName}
                            </span>
                            <span className="text-xs font-mono font-black text-[#0f6b38]">
                              {sis.percent}%
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 mb-2">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-[#0f6b38] font-bold">
                              {sis.areaName}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-semibold">
                              {sis.locations.join(' / ')}
                            </span>
                          </div>
                          <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden mb-1.5">
                            <div
                              className="bg-[#0f6b38] h-full rounded-full"
                              style={{ width: `${sis.percent}%` }}
                            />
                          </div>
                          <div className="flex justify-between text-[11px] text-slate-500">
                            <span>
                              Tareas ({dashSistemaLocFilter}): {sis.total}
                            </span>
                            <span>Listas: {sis.completed}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Alertas de Cronograma */}
                <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-100 gap-2 mb-3">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-5 h-5 text-rose-600" />
                      <div>
                        <h3 className="text-sm font-extrabold text-slate-900">
                          Alertas de Cronograma y Pendientes por Área
                        </h3>
                        <p className="text-xs text-slate-500">
                          Actividades cuya fecha de inicio ya llegó y continúan en 0%, o
                          pendientes por completar
                        </p>
                      </div>
                    </div>
                    <select
                      value={dashPendingAreaFilter}
                      onChange={(e) => setDashPendingAreaFilter(e.target.value)}
                      className="px-3 py-1.5 rounded-xl border border-slate-300 text-xs font-bold bg-slate-50"
                    >
                      <option value="Todas">Todas las Áreas</option>
                      {ALL_AREAS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {evaluatedActivities
                      .filter(
                        (a) =>
                          a.progressPercent < 100 &&
                          (dashPendingAreaFilter === 'Todas' ||
                            a.areaName === dashPendingAreaFilter)
                      )
                      .map((act) => (
                        <div
                          key={act.id}
                          className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs ${
                            act.shouldHaveStarted
                              ? 'bg-rose-50/70 border-rose-200'
                              : 'bg-slate-50 border-slate-200'
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-800 text-[10px]">
                                {act.code}
                              </span>
                              <span className="font-bold text-slate-900">{act.name}</span>
                              {act.shouldHaveStarted && (
                                <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white text-[10px] font-bold">
                                  Debió iniciar: {act.startDate}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500 mt-0.5">
                              {act.areaName} • {act.structureName} • Meta:{' '}
                              {act.targetUnits} {act.unit} (Pendiente: {act.pendingQty}{' '}
                              {act.unit})
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-mono font-black text-[#0f6b38]">
                              {act.progressPercent}%
                            </span>
                            <button
                              onClick={() =>
                                openNewAdvanceModal({
                                  areaName: act.areaName,
                                  locationType: act.locationType || 'Todos',
                                  sistemaName: act.sistemaName || '',
                                  structureName: act.structureName || '',
                                  activityCode: act.code
                                })
                              }
                              className="px-2.5 py-1 rounded-lg bg-[#0f6b38] text-white font-bold text-[11px]"
                            >
                              + Avance
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 2: CRONOGRAMA GANTT                                          */}
        {/* ================================================================== */}
        {currentTab === 'gantt' && (
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Cronograma Gantt por Estructura y Actividad
                </h2>
                <p className="text-xs text-slate-500">
                  Puedes editar las fechas de inicio y fin directamente en cada fila
                </p>
              </div>
              <button
                disabled={!currentGalpon}
                onClick={() => setModalNewActivity(true)}
                className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white text-xs font-bold"
              >
                + Nueva Actividad
              </button>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#0f6b38] text-white font-bold uppercase text-[11px]">
                      <th className="py-3 px-3">Código</th>
                      <th className="py-3 px-3">Área / Sistema</th>
                      <th className="py-3 px-3">Estructura / Actividad</th>
                      <th className="py-3 px-2 text-right">Meta</th>
                      <th className="py-3 px-2 text-right">Ejecutado</th>
                      <th className="py-3 px-2 text-right">% Real</th>
                      <th className="py-3 px-2 text-center">Inicio</th>
                      <th className="py-3 px-2 text-center">Fin</th>
                      <th className="py-3 px-3 min-w-[140px]">Progreso</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium">
                    {evaluatedActivities.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-8 text-center text-slate-400">
                          No hay actividades registradas en este galpón.
                        </td>
                      </tr>
                    ) : (
                      evaluatedActivities.map((act) => (
                        <tr key={act.id} className="hover:bg-slate-50">
                          <td className="py-2 px-3 font-mono font-bold text-slate-700">
                            {act.code}
                          </td>
                          <td className="py-2 px-3">
                            <span className="font-bold text-[#0f6b38] block">
                              {act.areaName}
                            </span>
                            {act.sistemaName && (
                              <span className="text-[10px] text-slate-500">
                                {act.locationType} • {act.sistemaName}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <span className="text-[11px] font-bold text-slate-600 block">
                              Estructura: {act.structureName}
                            </span>
                            <span className="font-bold text-slate-900">{act.name}</span>
                          </td>
                          <td className="py-2 px-2 text-right font-mono">
                            {act.targetUnits} {act.unit}
                          </td>
                          <td className="py-2 px-2 text-right font-mono font-bold text-[#0f6b38]">
                            {act.accumulatedQty}
                          </td>
                          <td className="py-2 px-2 text-right font-mono font-black">
                            {act.progressPercent}%
                          </td>
                          <td className="py-2 px-2 text-center">
                            <input
                              type="date"
                              value={act.startDate || ''}
                              onChange={(e) =>
                                handleGanttDateChange(act.id, 'startDate', e.target.value)
                              }
                              className="px-2 py-1 border border-slate-300 rounded text-[11px] font-mono bg-slate-50"
                            />
                          </td>
                          <td className="py-2 px-2 text-center">
                            <input
                              type="date"
                              value={act.dueDate || ''}
                              onChange={(e) =>
                                handleGanttDateChange(act.id, 'dueDate', e.target.value)
                              }
                              className="px-2 py-1 border border-slate-300 rounded text-[11px] font-mono bg-slate-50"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                              <div
                                className="bg-[#0f6b38] h-full rounded-full"
                                style={{ width: `${act.progressPercent}%` }}
                              />
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
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
                  Registro guiado en cascada con horas hombre, consumo manual de
                  materiales, edición y eliminación con recálculo automático de stock
                </p>
              </div>
              <button
                disabled={!currentGalpon}
                onClick={() => openNewAdvanceModal()}
                className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white font-bold text-xs flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>+ Registrar Parte de Hoy</span>
              </button>
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
                            <span className="text-xs font-mono font-black text-[#0f6b38]">
                              +{adv.quantityToday} {act?.unit || ''}
                            </span>
                            {adv.hoursWorked > 0 && (
                              <span className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-bold">
                                {adv.hoursWorked} HH
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
                              Acumulado: {act?.accumulatedQty || 0} /{' '}
                              {act?.targetUnits || 0}
                            </span>
                            <span className="text-sm font-black text-[#0f6b38] font-mono">
                              {act?.progressPercent || 0}%
                            </span>
                          </div>
                          <div className="flex items-center gap-1 border-l border-slate-200 pl-3">
                            <button
                              type="button"
                              onClick={() => openEditAdvanceModal(adv)}
                              className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition"
                              title="Modificar Avance Diario"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => requestDeleteAdvance(adv.id)}
                              className="p-2 rounded-lg text-rose-600 hover:bg-rose-50 transition"
                              title="Eliminar Avance Diario (Revierte consumo de materiales)"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
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

                <button
                  onClick={handleMarkAllAttended}
                  className="px-3 py-1.5 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] text-white font-bold flex items-center gap-1"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Marcar Todos Asistió</span>
                </button>

                <button
                  type="button"
                  onClick={handleExportAttendanceCSV}
                  className="px-3 py-1.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-bold flex items-center gap-1"
                >
                  <Download className="w-3.5 h-3.5 text-[#0f6b38]" />
                  <span>Exportar Asistencia (.CSV)</span>
                </button>
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
                          <h4 className="text-xs font-bold text-slate-900">{w.name}</h4>
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
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ================================================================== */}
        {/* VISTA 5: PROYECTOS / SECTORES Y GALPONES                           */}
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
              <div className="flex items-center gap-2">
                <button
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
                </button>
                <button
                  disabled={sectors.length === 0}
                  onClick={() => {
                    setFormGalpon({
                      id: '',
                      sectorId: '',
                      code: '',
                      name: '',
                      description: '',
                      supervisorsStr: '',
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
                </button>
              </div>
            </div>

            {sectors.length === 0 ? (
              <div className="bg-white rounded-2xl p-8 text-center border border-slate-200">
                <p className="text-sm font-bold text-slate-700">
                  Aún no has creado ningún Sector / Proyecto.
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

                        <button
                          onClick={() => requestDeleteSector(sec.id)}
                          className="px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold flex items-center gap-1"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Eliminar Sector</span>
                        </button>

                        <button
                          onClick={() => {
                            setFormGalpon({
                              id: '',
                              sectorId: sec.id,
                              code: '',
                              name: '',
                              description: '',
                              supervisorsStr: '',
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
                                  {gal.supervisors?.length
                                    ? gal.supervisors.join(', ')
                                    : 'Sin asignar'}
                                </strong>
                              </p>
                            </div>

                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => {
                                  setFormGalpon({
                                    id: gal.id,
                                    sectorId: sec.id,
                                    code: gal.code,
                                    name: gal.name,
                                    description: gal.description || '',
                                    supervisorsStr: gal.supervisors
                                      ? gal.supervisors.join(', ')
                                      : '',
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
                              <button
                                onClick={() => requestDeleteGalpon(sec.id, gal.id)}
                                className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100"
                                title="Eliminar Galpón"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          <div className="flex items-center justify-between pt-2 border-t border-slate-200 gap-2">
                            <button
                              onClick={() => handleReloadGalponFromCatalog(sec.id, gal)}
                              className="text-[11px] font-bold text-[#0f6b38] hover:underline flex items-center gap-1"
                            >
                              <RefreshCw className="w-3 h-3" />
                              <span>Sincronizar con Plantilla ({gal.technology || 'Sin proveedor'})</span>
                            </button>
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
                <button
                  onClick={() => setModalManageTemplates(true)}
                  className="px-3 py-2 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center gap-1.5"
                >
                  <Settings className="w-4 h-4 text-[#0f6b38]" />
                  <span>Gestionar Plantillas / Proveedores</span>
                </button>
                <button
                  onClick={() => {
                    setBulkCsvText('');
                    setBulkRawRows([]);
                    setBulkFileName('');
                    setBulkTargetGalponId('');
                    setModalBulkUpload('catalogo');
                  }}
                  className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4 text-[#0f6b38]" />
                  <span>Carga Masiva Excel/CSV</span>
                </button>
                <button
                  onClick={openNewCatalogModal}
                  className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] text-white text-xs font-bold flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  <span>+ Nueva Actividad Maestra</span>
                </button>
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
                      <th className="py-3 px-2 text-right">Meta</th>
                      <th className="py-3 px-2 text-right">Peso</th>
                      <th className="py-3 px-3 text-center">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium">
                    {masterCatalog.filter(
                      (c) =>
                        selectedCatalogTech === 'Todas' ||
                        c.technology === selectedCatalogTech
                    ).length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-8 text-center text-slate-400">
                          No hay actividades en el Catálogo Maestro para este filtro.
                        </td>
                      </tr>
                    ) : (
                      masterCatalog
                        .filter(
                          (c) =>
                            selectedCatalogTech === 'Todas' ||
                            c.technology === selectedCatalogTech
                        )
                        .map((item) => (
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
                              {item.structureName}
                            </td>
                            <td className="py-2.5 px-3 font-bold text-slate-900">
                              {item.name}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono">
                              {item.targetUnits} {item.unit}
                            </td>
                            <td className="py-2.5 px-2 text-right font-mono">
                              {item.weight}x
                            </td>
                            <td className="py-2.5 px-3 text-center">
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  onClick={() => openEditCatalogModal(item)}
                                  className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-200"
                                  title="Editar actividad maestra"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => requestDeleteCatalogItem(item.id)}
                                  className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100"
                                  title="Eliminar actividad maestra"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
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
                  6 áreas con clasificación Interno/Externo, sistema, estructura, edición
                  y eliminación
                </p>
              </div>
              <button
                disabled={allGalponesList.length === 0}
                onClick={() => {
                  setFormActivity({
                    useCatalog: true,
                    targetGalponId: currentGalpon?.id || '',
                    catalogItemId: '',
                    code: '',
                    name: '',
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
                  setModalNewActivity(true);
                }}
                className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>+ Agregar Actividad al Galpón</span>
              </button>
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
                      <th className="py-3 px-3">Área</th>
                      <th className="py-3 px-3">Ubicación / Sistema</th>
                      <th className="py-3 px-3">Estructura</th>
                      <th className="py-3 px-3">Actividad</th>
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
                      .map((act) => (
                        <tr key={act.id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-3 font-mono font-bold">
                            {act.code}
                          </td>
                          <td className="py-2.5 px-3 font-bold text-[#0f6b38]">
                            {act.areaName}
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
                          <td className="py-2.5 px-2 text-right font-mono">
                            {act.targetUnits} {act.unit}
                          </td>
                          <td className="py-2.5 px-2 text-right font-mono font-black text-[#0f6b38]">
                            {act.progressPercent}%
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                onClick={() => setModalEditGalponActivity(act)}
                                className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-200"
                                title="Editar actividad"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => requestDeleteGalponActivity(act.id)}
                                className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100"
                                title="Eliminar actividad"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
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
                <button
                  type="button"
                  onClick={handleExportMaterialsCSV}
                  className="px-3 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center gap-1.5"
                >
                  <Download className="w-4 h-4 text-[#0f6b38]" />
                  <span>Exportar Materiales (.CSV)</span>
                </button>
                <button
                  onClick={() => {
                    setBulkCsvText('');
                    setBulkRawRows([]);
                    setBulkFileName('');
                    setBulkTargetGalponId(currentGalpon?.id || '');
                    setModalBulkUpload('materiales');
                  }}
                  className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4 text-[#0f6b38]" />
                  <span>Carga Masiva Excel/CSV</span>
                </button>
                <button
                  onClick={openNewMaterialModal}
                  className="px-4 py-2 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] text-white text-xs font-bold flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  <span>+ Asignar / Agregar Material</span>
                </button>
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
                          const computedUsed = computeMaterialUsedQty(
                            mat,
                            dailyAdvances
                          );
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
                                  <button
                                    onClick={() => openEditMaterialModal(mat)}
                                    className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-200"
                                    title="Editar material"
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => requestDeleteMaterial(mat.id)}
                                    className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100"
                                    title="Eliminar material"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
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
                <button
                  onClick={() => {
                    setBulkCsvText('');
                    setBulkRawRows([]);
                    setBulkFileName('');
                    setBulkTargetGalponId('');
                    setModalBulkUpload('personal');
                  }}
                  className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4 text-[#0f6b38]" />
                  <span>Carga Masiva Excel/CSV</span>
                </button>
                <button
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
                </button>
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
                      <th className="py-3 px-3 text-center">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium">
                    {masterWorkforce.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-slate-400">
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
                                {worker.name}
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
                              <td className="py-2.5 px-3 text-center">
                                <button
                                  onClick={() => requestDeleteWorker(worker.id)}
                                  className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-100"
                                  title="Eliminar operario"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
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
        {/* VISTA 10: INFORMES GLOBALES                                        */}
        {/* ================================================================== */}
        {currentTab === 'informes' && (
          <div className="space-y-4">
            <div className="bg-white p-5 rounded-2xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Informes Globales Multiproyecto
                </h2>
                <p className="text-xs text-slate-500">
                  Exporta la sábana completa de todos los sectores, galpones, sistemas,
                  estructuras y actividades
                </p>
              </div>
              <button
                onClick={handleExportGlobalCSV}
                className="px-4 py-2.5 bg-[#0f6b38] hover:bg-[#0a4e28] text-white text-xs font-bold rounded-xl flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                <span>Exportar Sábana Global (.CSV / Excel)</span>
              </button>
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
                onChange={(e) => setFilterLogAction(e.target.value)}
                className="px-3 py-2 border border-slate-300 rounded-xl font-bold bg-slate-50"
              >
                <option value="Todas">Todas las Acciones</option>
                <option value="REGISTRO">Solo REGISTROS</option>
                <option value="MODIFICACIÓN">Solo MODIFICACIONES</option>
                <option value="ELIMINACIÓN">Solo ELIMINACIONES</option>
              </select>

              <select
                value={filterLogModule}
                onChange={(e) => setFilterLogModule(e.target.value)}
                className="px-3 py-2 border border-slate-300 rounded-xl font-bold bg-slate-50"
              >
                <option value="Todos">Todos los Módulos</option>
                <option value="Sectores y Galpones">Sectores y Galpones</option>
                <option value="Catálogo Maestro">Catálogo Maestro</option>
                <option value="Actividades">Actividades</option>
                <option value="Materiales">Materiales</option>
                <option value="Avance Diario">Avance Diario</option>
                <option value="Personal y Asistencia">Personal y Asistencia</option>
                <option value="Carga Masiva">Carga Masiva</option>
              </select>

              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Buscar por detalle, código, galpón o usuario..."
                  value={searchLogText}
                  onChange={(e) => setSearchLogText(e.target.value)}
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
                    {auditLogs.filter((log) => {
                      if (filterLogAction !== 'Todas' && log.action !== filterLogAction)
                        return false;
                      if (filterLogModule !== 'Todos' && log.module !== filterLogModule)
                        return false;
                      if (searchLogText.trim()) {
                        const q = searchLogText.toLowerCase().trim();
                        const match =
                          log.description.toLowerCase().includes(q) ||
                          log.user.toLowerCase().includes(q) ||
                          log.module.toLowerCase().includes(q) ||
                          log.action.toLowerCase().includes(q);
                        if (!match) return false;
                      }
                      return true;
                    }).length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-400">
                          No hay movimientos registrados que coincidan con el filtro.
                        </td>
                      </tr>
                    ) : (
                      auditLogs
                        .filter((log) => {
                          if (
                            filterLogAction !== 'Todas' &&
                            log.action !== filterLogAction
                          )
                            return false;
                          if (
                            filterLogModule !== 'Todos' &&
                            log.module !== filterLogModule
                          )
                            return false;
                          if (searchLogText.trim()) {
                            const q = searchLogText.toLowerCase().trim();
                            const match =
                              log.description.toLowerCase().includes(q) ||
                              log.user.toLowerCase().includes(q) ||
                              log.module.toLowerCase().includes(q) ||
                              log.action.toLowerCase().includes(q);
                            if (!match) return false;
                          }
                          return true;
                        })
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
                            </td>
                          </tr>
                        ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ==================================================================== */}
      {/* 5. BARRA DE NAVEGACIÓN INFERIOR (4 VISTAS RÁPIDAS)                   */}
      {/* ==================================================================== */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-slate-200 shadow-lg">
        <div className="max-w-md mx-auto grid grid-cols-4 py-1.5 px-2">
          <button
            onClick={() => setCurrentTab('dashboard')}
            className={`flex flex-col items-center py-1 text-[11px] font-bold transition ${
              currentTab === 'dashboard' ? 'text-[#0f6b38]' : 'text-slate-400'
            }`}
          >
            <BarChart3 className="w-5 h-5 mb-0.5" />
            <span>Dashboard</span>
          </button>

          <button
            onClick={() => setCurrentTab('gantt')}
            className={`flex flex-col items-center py-1 text-[11px] font-bold transition ${
              currentTab === 'gantt' ? 'text-[#0f6b38]' : 'text-slate-400'
            }`}
          >
            <Layers className="w-5 h-5 mb-0.5" />
            <span>Gantt</span>
          </button>

          <button
            onClick={() => setCurrentTab('avance_diario')}
            className={`flex flex-col items-center py-1 text-[11px] font-bold transition ${
              currentTab === 'avance_diario' ? 'text-[#0f6b38]' : 'text-slate-400'
            }`}
          >
            <TrendingUp className="w-5 h-5 mb-0.5" />
            <span>Avance</span>
          </button>

          <button
            onClick={() => setCurrentTab('asistencia')}
            className={`flex flex-col items-center py-1 text-[11px] font-bold transition ${
              currentTab === 'asistencia' ? 'text-[#0f6b38]' : 'text-slate-400'
            }`}
          >
            <UserCheck className="w-5 h-5 mb-0.5" />
            <span>Asistencia</span>
          </button>
        </div>
      </nav>

      {/* ==================================================================== */}
      {/* 6. MODALES COMPLETOS                                                 */}
      {/* ==================================================================== */}

      {/* MODAL: GESTIONAR PLANTILLAS / PROVEEDORES */}
      {modalManageTemplates && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md border border-slate-200 shadow-2xl">
            <h3 className="text-base font-black text-slate-900 mb-1">
              Gestionar Plantillas / Proveedores
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              Agrega, renombra o elimina plantillas de proveedores (ej. Big Dutchman, Big
              Herdsman, Vidulma)
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
                        <button
                          type="button"
                          onClick={() => requestDeleteTemplateProvider(tech)}
                          className="p-1.5 rounded hover:bg-rose-100 text-rose-600"
                          title="Eliminar plantilla"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
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
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
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
                    {ALL_AREAS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
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
                        sistemaName: e.target.value
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold mb-1.5"
                  >
                    <option value="">-- Seleccionar Sistema --</option>
                    {Array.from(
                      new Set(
                        masterCatalog
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
                  {allKnownStructures.map((stName) => (
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

              <div className="grid grid-cols-4 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Meta: *</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={formCatalogItem.targetUnits}
                    onChange={(e) =>
                      setFormCatalogItem({
                        ...formCatalogItem,
                        targetUnits: e.target.value
                      })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Unidad:</label>
                  <input
                    type="text"
                    value={formCatalogItem.unit}
                    onChange={(e) =>
                      setFormCatalogItem({ ...formCatalogItem, unit: e.target.value })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50"
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
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
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
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
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
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
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
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
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
                  Supervisores Responsables (separados por coma):
                </label>
                <input
                  type="text"
                  value={formGalpon.supervisorsStr}
                  onChange={(e) =>
                    setFormGalpon({ ...formGalpon, supervisorsStr: e.target.value })
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
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
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
                  Supervisores Responsables:
                </label>
                <input
                  type="text"
                  value={formGalpon.supervisorsStr}
                  onChange={(e) =>
                    setFormGalpon({ ...formGalpon, supervisorsStr: e.target.value })
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

      {/* MODAL: AGREGAR ACTIVIDAD AL GALPÓN (CUALQUIER SECTOR Y GALPÓN) */}
      {modalNewActivity && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg border border-slate-200 shadow-2xl my-8">
            <h3 className="text-base font-black text-slate-900 mb-1">
              Agregar Actividad a Galpón
            </h3>
            <p className="text-xs text-slate-500">
              Selecciona cualquier actividad del Catálogo Maestro y asígnala al galpón y
              sector que desees
            </p>
            <form onSubmit={handleSaveNewActivity} className="space-y-3 text-xs mt-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Galpón Destino (Sector • Galpón): *
                  </label>
                  <select
                    required
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

              {masterCatalog.length > 0 && (
                <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200">
                  <label className="block font-bold text-[#0f6b38] mb-1">
                    Cargar desde Catálogo Maestro (Todas las Actividades Maestras):
                  </label>
                  <select
                    value={formActivity.catalogItemId}
                    onChange={(e) => {
                      const catId = e.target.value;
                      const found = masterCatalog.find((c) => c.id === catId);
                      if (found) {
                        setFormActivity({
                          ...formActivity,
                          catalogItemId: catId,
                          code: found.code,
                          name: found.name,
                          areaName: found.areaName,
                          locationType: found.locationType || 'Interno',
                          sistemaName: found.sistemaName || '',
                          structureName: found.structureName || '',
                          targetUnits: String(found.targetUnits ?? ''),
                          unit: found.unit || '',
                          weight: String(found.weight ?? ''),
                          plannedHH: String(found.plannedHH ?? '')
                        });
                      } else {
                        setFormActivity({ ...formActivity, catalogItemId: '' });
                      }
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-emerald-300 bg-white font-bold"
                  >
                    <option value="">
                      -- Seleccionar del catálogo o llenar manualmente --
                    </option>
                    {masterCatalog.map((c) => (
                      <option key={c.id} value={c.id}>
                        [{c.code}] {c.name} ({c.technology ? `${c.technology} • ` : ''}
                        {c.areaName} • {c.structureName})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Código: *</label>
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
                  <label className="block font-bold text-slate-700 mb-1">Área: *</label>
                  <select
                    required
                    value={formActivity.areaName}
                    onChange={(e) =>
                      setFormActivity({ ...formActivity, areaName: e.target.value })
                    }
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

              {AREAS_WITH_SISTEMAS.includes(formActivity.areaName) && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-bold text-slate-700 mb-1">
                      Ubicación:
                    </label>
                    <select
                      value={formActivity.locationType}
                      onChange={(e) =>
                        setFormActivity({
                          ...formActivity,
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
                    <label className="block font-bold text-slate-700 mb-1">Sistema:</label>
                    <input
                      type="text"
                      placeholder="Nombre del sistema"
                      value={formActivity.sistemaName}
                      onChange={(e) =>
                        setFormActivity({
                          ...formActivity,
                          sistemaName: e.target.value
                        })
                      }
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Estructura: *
                </label>
                <input
                  type="text"
                  required
                  value={formActivity.structureName}
                  onChange={(e) =>
                    setFormActivity({ ...formActivity, structureName: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold"
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

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Meta: *</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={formActivity.targetUnits}
                    onChange={(e) =>
                      setFormActivity({ ...formActivity, targetUnits: e.target.value })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Unidad:</label>
                  <input
                    type="text"
                    value={formActivity.unit}
                    onChange={(e) =>
                      setFormActivity({ ...formActivity, unit: e.target.value })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50"
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

              <div className="pt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setModalNewActivity(false)}
                  className="px-4 py-2 font-bold text-slate-500"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#0f6b38] text-white font-bold"
                >
                  Guardar Actividad
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: EDITAR ACTIVIDAD DEL GALPÓN */}
      {modalEditGalponActivity && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
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
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Meta:</label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={modalEditGalponActivity.targetUnits}
                    onChange={(e) =>
                      setModalEditGalponActivity({
                        ...modalEditGalponActivity,
                        targetUnits: e.target.value
                      })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Unidad:</label>
                  <input
                    type="text"
                    value={modalEditGalponActivity.unit}
                    onChange={(e) =>
                      setModalEditGalponActivity({
                        ...modalEditGalponActivity,
                        unit: e.target.value
                      })
                    }
                    className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-slate-50"
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
                <button
                  type="button"
                  onClick={() => setModalEditGalponActivity(null)}
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

      {/* MODAL: REGISTRAR / MODIFICAR AVANCE DIARIO EN CASCADA + CONSUMO MANUAL DE MATERIALES POR ID */}
      {modalNewAdvance && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg border border-slate-200 shadow-2xl my-8">
            <h3 className="text-base font-black text-slate-900 mb-1">
              {editingAdvanceId
                ? `Modificar Avance Diario (${currentGalpon?.code})`
                : `Registrar Avance Diario (${currentGalpon?.code})`}
            </h3>
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
                        activityCode: ''
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
                        activityCode: ''
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
                  value={formAdvance.activityCode}
                  onChange={(e) =>
                    setFormAdvance({ ...formAdvance, activityCode: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 font-bold text-[#0f6b38]"
                >
                  <option value="">-- Seleccionar Actividad --</option>
                  {cascadeAdvancesList.map((a) => (
                    <option key={a.id} value={a.code}>
                      [{a.code}] {a.structureName} → {a.name} (Meta: {a.targetUnits}{' '}
                      {a.unit} | Actual: {a.accumulatedQty})
                    </option>
                  ))}
                </select>
              </div>

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
                    Cantidad Hoy: *
                  </label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={formAdvance.quantityToday}
                    onChange={(e) =>
                      setFormAdvance({ ...formAdvance, quantityToday: e.target.value })
                    }
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

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    Supervisor Responsable:
                  </label>
                  <input
                    type="text"
                    placeholder={currentGalpon?.supervisors?.[0] || activeUserName}
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
              {selectedAdvanceActivityObj &&
                selectedAdvanceActivityObj.linkedMaterials?.length > 0 && (
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2">
                    <span className="font-bold text-[#0f6b38] block">
                      Consumo Manual Guiado de Materiales (Estructura:{' '}
                      {selectedAdvanceActivityObj.structureName}):
                    </span>
                    {selectedAdvanceActivityObj.linkedMaterials.map((mat: any) => {
                      const pctToday =
                        selectedAdvanceActivityObj.targetUnits > 0
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
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
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
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
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
                    'Columnas requeridas: Proveedor, Codigo, Area, Ubicacion, Sistema (si aplica), Estructura, Actividad, Meta, Unidad, Peso, HH'}
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
                  disabled={bulkImportAnalysis.validRows.length === 0}
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
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg border border-slate-200 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-rose-100 text-rose-700 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-black text-slate-900">
                  Confirmar eliminación de{' '}
                  {deleteConfirmModal.type === 'sector'
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
                                : 'Plantilla / Proveedor'}
                  : [{deleteConfirmModal.code}] {deleteConfirmModal.name}
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Verifica el impacto de esta acción antes de eliminar definitivamente el
                  registro.
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

            {(deleteConfirmModal.type === 'sector' ||
              deleteConfirmModal.type === 'galpon') &&
              ((deleteConfirmModal.stats?.materials || 0) > 0 ||
                (deleteConfirmModal.stats?.workers || 0) > 0 ||
                (deleteConfirmModal.stats?.advances || 0) > 0) && (
                <div className="space-y-2 text-xs">
                  <p className="font-bold text-slate-700">
                    ¿Cómo deseas manejar los materiales y registros vinculados?
                  </p>
                  <label className="flex items-start gap-2.5 p-3 rounded-xl border border-slate-200 bg-slate-50 cursor-pointer">
                    <input
                      type="radio"
                      name="deleteStrategyMode"
                      checked={deleteConfirmModal.mode === 'preserve_unassign'}
                      onChange={() =>
                        setDeleteConfirmModal({
                          ...deleteConfirmModal,
                          mode: 'preserve_unassign'
                        })
                      }
                      className="mt-0.5 accent-[#0f6b38]"
                    />
                    <div>
                      <span className="font-bold text-slate-900 block">
                        Conservar materiales y operarios como «Sin galpón asignado» (Recomendado)
                      </span>
                      <span className="text-slate-500 text-[11px]">
                        Los materiales y operarios se conservan en el inventario/planilla sin
                        galpón asignado, y se limpian los avances del galpón eliminado
                        recalculando el stock.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 p-3 rounded-xl border border-rose-200 bg-rose-50/40 cursor-pointer">
                    <input
                      type="radio"
                      name="deleteStrategyMode"
                      checked={deleteConfirmModal.mode === 'cascade_delete'}
                      onChange={() =>
                        setDeleteConfirmModal({
                          ...deleteConfirmModal,
                          mode: 'cascade_delete'
                        })
                      }
                      className="mt-0.5 accent-rose-600"
                    />
                    <div>
                      <span className="font-bold text-rose-900 block">
                        Eliminar también los materiales y avances vinculados
                      </span>
                      <span className="text-rose-700 text-[11px]">
                        Elimina el {deleteConfirmModal.type === 'sector' ? 'sector' : 'galpón'}{' '}
                        junto con sus partes diarios y materiales asignados, y desvincula a los
                        operarios.
                      </span>
                    </div>
                  </label>
                </div>
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
                className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs"
              >
                Confirmar Eliminación
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}