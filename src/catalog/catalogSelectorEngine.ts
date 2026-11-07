export type ProgressModality = 'quantity' | 'percentage';

export const NO_SISTEMA_VALUE = '__SIN_SISTEMA__';
export const NO_SISTEMA_LABEL = 'General (Aplicación directa en Área)';

export interface MasterCatalogRecord {
  id: string;
  technology?: string;
  code: string;
  name: string;
  areaName: string;
  locationType?: string;
  sistemaName?: string | null;
  structureName: string;
  progressMode?: ProgressModality;
  targetUnits?: number;
  unit?: string;
  weight?: number;
  plannedHH?: number;
  durationDays?: number;
  deleted?: boolean;
  isDeleted?: boolean;
  deletedAt?: string | null;
  active?: boolean;
  [key: string]: any;
}

export interface CatalogSystemOption {
  value: string;
  label: string;
  locationType: string;
}

export interface CatalogAssignmentFormState {
  useCatalog: boolean;
  targetGalponId: string;
  sharedWithGalponId: string;
  catalogItemId: string;
  selectedCatalogItemIds: string[];
  code: string;
  name: string;
  progressMode: ProgressModality;
  areaName: string;
  locationType: string;
  sistemaName: string;
  customSistemaName: string;
  structureName: string;
  customStructureName: string;
  targetUnits: string;
  unit: string;
  weight: string;
  plannedHH: string;
  startDate: string;
  dueDate: string;
}

export function normalizeCatalogProgressMode(raw: unknown): ProgressModality {
  if (
    raw === 'percentage' ||
    raw === 'porcentaje' ||
    raw === 'percent' ||
    raw === '%'
  ) {
    return 'percentage';
  }
  return 'quantity';
}

/**
 * Determina si un registro del Catálogo Maestro está activo y es válido.
 * Excluye registros marcados con baja lógica (deleted, isDeleted, deletedAt, active === false)
 * o registros incompletos/huérfanos sin identificador, código, nombre, área o estructura.
 */
export function isCatalogItemActive(item: any): item is MasterCatalogRecord {
  if (!item || typeof item !== 'object') return false;
  if (item.deleted === true || item.isDeleted === true) return false;
  if (item.active === false) return false;
  if (item.deletedAt !== undefined && item.deletedAt !== null && item.deletedAt !== '') {
    return false;
  }
  const id = String(item.id || '').trim();
  const code = String(item.code || '').trim();
  const name = String(item.name || '').trim();
  const areaName = String(item.areaName || '').trim();
  const structureName = String(item.structureName || '').trim();
  if (!id || !code || !name || !areaName || !structureName) return false;
  return true;
}

/**
 * Devuelve únicamente las actividades maestras vigentes del Catálogo Maestro,
 * deduplicadas por ID y excluyendo cualquier ID eliminado o inactivo.
 */
export function getActiveMasterCatalog(
  rawCatalog: any[],
  excludedIds?: Set<string> | string[]
): MasterCatalogRecord[] {
  if (!Array.isArray(rawCatalog)) return [];
  const excludedSet =
    excludedIds instanceof Set
      ? excludedIds
      : Array.isArray(excludedIds)
      ? new Set(excludedIds)
      : null;

  const byId = new Map<string, MasterCatalogRecord>();
  for (const raw of rawCatalog) {
    if (!isCatalogItemActive(raw)) continue;
    const cleanId = String(raw.id).trim();
    if (excludedSet && excludedSet.has(cleanId)) continue;
    byId.set(cleanId, {
      ...raw,
      id: cleanId,
      code: String(raw.code).trim().toUpperCase(),
      name: String(raw.name).trim(),
      areaName: String(raw.areaName).trim(),
      structureName: String(raw.structureName).trim(),
      sistemaName: raw.sistemaName ? String(raw.sistemaName).trim() : null,
      locationType: raw.locationType ? String(raw.locationType).trim() : 'Interno',
      progressMode: normalizeCatalogProgressMode(raw.progressMode)
    });
  }
  return Array.from(byId.values());
}

/**
 * Paso 1: Obtiene únicamente las Áreas que tienen actividades activas en el Catálogo Maestro.
 */
export function getCatalogAreas(
  rawCatalog: any[],
  canonicalAreasOrder?: string[]
): string[] {
  const active = getActiveMasterCatalog(rawCatalog);
  const areaSet = new Set<string>();
  for (const item of active) {
    if (item.areaName) areaSet.add(item.areaName);
  }
  if (!canonicalAreasOrder || canonicalAreasOrder.length === 0) {
    return Array.from(areaSet);
  }
  const ordered: string[] = [];
  for (const canonical of canonicalAreasOrder) {
    if (areaSet.has(canonical)) {
      ordered.push(canonical);
      areaSet.delete(canonical);
    }
  }
  const remaining = Array.from(areaSet).sort((a, b) => a.localeCompare(b, 'es'));
  return [...ordered, ...remaining];
}

/**
 * Paso 2: Obtiene únicamente los Sistemas activos del Catálogo Maestro que pertenecen al Área seleccionada.
 * Si el área tiene actividades sin sistema (ej. Obra Civil), expone la opción NO_SISTEMA_VALUE.
 */
export function getCatalogSystemsByArea(
  rawCatalog: any[],
  areaName: string
): CatalogSystemOption[] {
  const cleanArea = String(areaName || '').trim();
  if (!cleanArea) return [];

  const active = getActiveMasterCatalog(rawCatalog).filter(
    (item) => item.areaName.toLowerCase() === cleanArea.toLowerCase()
  );

  const systemMap = new Map<string, CatalogSystemOption>();
  let hasNoSistemaItems = false;

  for (const item of active) {
    const sisName = String(item.sistemaName || '').trim();
    if (!sisName) {
      hasNoSistemaItems = true;
      continue;
    }
    const key = sisName.toLowerCase();
    if (!systemMap.has(key)) {
      systemMap.set(key, {
        value: sisName,
        label: sisName,
        locationType: item.locationType || 'Interno'
      });
    }
  }

  const result = Array.from(systemMap.values());
  if (hasNoSistemaItems) {
    result.push({
      value: NO_SISTEMA_VALUE,
      label: NO_SISTEMA_LABEL,
      locationType: 'Interno'
    });
  }
  return result;
}

/**
 * Verifica si un registro del catálogo coincide con el sistema seleccionado.
 */
export function matchesCatalogSystem(
  itemSistemaName: string | null | undefined,
  selectedSistema: string
): boolean {
  const cleanSelected = String(selectedSistema || '').trim();
  if (!cleanSelected) return false;
  const cleanItemSis = String(itemSistemaName || '').trim();
  if (cleanSelected === NO_SISTEMA_VALUE) {
    return cleanItemSis === '';
  }
  return cleanItemSis.toLowerCase() === cleanSelected.toLowerCase();
}

/**
 * Paso 3: Obtiene únicamente las Estructuras activas en el Catálogo Maestro que pertenecen
 * al Área y Sistema seleccionados. Nunca consulta estructuras históricas de galpones ni materiales.
 */
export function getCatalogStructuresByAreaAndSystem(
  rawCatalog: any[],
  areaName: string,
  sistemaName: string
): string[] {
  const cleanArea = String(areaName || '').trim();
  const cleanSistema = String(sistemaName || '').trim();
  if (!cleanArea || !cleanSistema) return [];

  const active = getActiveMasterCatalog(rawCatalog);
  const structureMap = new Map<string, string>();

  for (const item of active) {
    if (item.areaName.toLowerCase() !== cleanArea.toLowerCase()) continue;
    if (!matchesCatalogSystem(item.sistemaName, cleanSistema)) continue;
    const strName = String(item.structureName || '').trim();
    if (!strName) continue;
    const key = strName.toLowerCase();
    if (!structureMap.has(key)) {
      structureMap.set(key, strName);
    }
  }

  return Array.from(structureMap.values());
}

/**
 * Obtiene las estructuras activas en el Catálogo Maestro para el formulario de creación/edición
 * del Catálogo Maestro según el Área y (opcionalmente) el Sistema seleccionados.
 */
export function getMasterCatalogStructuresForEditor(
  rawCatalog: any[],
  areaName?: string,
  sistemaName?: string
): string[] {
  const active = getActiveMasterCatalog(rawCatalog);
  const cleanArea = String(areaName || '').trim();
  const cleanSistema = String(sistemaName || '').trim();
  const structureMap = new Map<string, string>();

  for (const item of active) {
    if (cleanArea && item.areaName.toLowerCase() !== cleanArea.toLowerCase()) {
      continue;
    }
    if (
      cleanSistema &&
      cleanSistema !== '__NEW__' &&
      cleanSistema !== NO_SISTEMA_VALUE
    ) {
      const itemSis = String(item.sistemaName || '').trim();
      if (itemSis && itemSis.toLowerCase() !== cleanSistema.toLowerCase()) {
        continue;
      }
    }
    const strName = String(item.structureName || '').trim();
    if (!strName) continue;
    const key = strName.toLowerCase();
    if (!structureMap.has(key)) {
      structureMap.set(key, strName);
    }
  }

  return Array.from(structureMap.values());
}

/**
 * Paso 4: Obtiene únicamente las Actividades Maestras activas del Catálogo Maestro
 * que pertenecen al Área, Sistema y Estructura seleccionados.
 */
export function getCatalogActivitiesByHierarchy(
  rawCatalog: any[],
  areaName: string,
  sistemaName: string,
  structureName: string
): MasterCatalogRecord[] {
  const cleanArea = String(areaName || '').trim();
  const cleanSistema = String(sistemaName || '').trim();
  const cleanStructure = String(structureName || '').trim();
  if (!cleanArea || !cleanSistema || !cleanStructure) return [];

  const active = getActiveMasterCatalog(rawCatalog);
  return active.filter((item) => {
    if (item.areaName.toLowerCase() !== cleanArea.toLowerCase()) return false;
    if (!matchesCatalogSystem(item.sistemaName, cleanSistema)) return false;
    if (item.structureName.toLowerCase() !== cleanStructure.toLowerCase()) return false;
    return true;
  });
}

/**
 * Elimina del Catálogo Maestro todas las actividades pertenecientes a una estructura específica
 * dentro de un Área (y Sistema opcional), garantizando que no queden actividades huérfanas.
 */
export function deleteStructureFromMasterCatalog(
  rawCatalog: any[],
  params: {
    areaName: string;
    sistemaName?: string | null;
    structureName: string;
  }
): {
  remainingCatalog: MasterCatalogRecord[];
  removedItems: MasterCatalogRecord[];
} {
  const active = getActiveMasterCatalog(rawCatalog);
  const cleanArea = String(params.areaName || '').trim().toLowerCase();
  const cleanStructure = String(params.structureName || '').trim().toLowerCase();
  const hasSistemaFilter =
    params.sistemaName !== undefined &&
    params.sistemaName !== null &&
    String(params.sistemaName).trim() !== '';

  const remainingCatalog: MasterCatalogRecord[] = [];
  const removedItems: MasterCatalogRecord[] = [];

  for (const item of active) {
    const sameArea = item.areaName.toLowerCase() === cleanArea;
    const sameStructure = item.structureName.toLowerCase() === cleanStructure;
    const sameSistema = hasSistemaFilter
      ? matchesCatalogSystem(item.sistemaName, String(params.sistemaName))
      : true;

    if (sameArea && sameStructure && sameSistema) {
      removedItems.push(item);
    } else {
      remainingCatalog.push(item);
    }
  }

  return { remainingCatalog, removedItems };
}

/**
 * Transiciones en cascada del selector progresivo (Área -> Sistema -> Estructura -> Actividad).
 */
export function applyCatalogStepAreaChange(
  state: CatalogAssignmentFormState,
  newAreaName: string,
  rawCatalog?: any[]
): CatalogAssignmentFormState {
  const cleanArea = String(newAreaName || '').trim();
  let autoSistema = '';
  let autoLocation = '';

  if (cleanArea && Array.isArray(rawCatalog)) {
    const systems = getCatalogSystemsByArea(rawCatalog, cleanArea);
    if (systems.length === 1 && systems[0].value === NO_SISTEMA_VALUE) {
      autoSistema = NO_SISTEMA_VALUE;
      autoLocation = systems[0].locationType || 'Interno';
    }
  }

  return {
    ...state,
    areaName: cleanArea,
    locationType: autoLocation,
    sistemaName: autoSistema,
    customSistemaName: '',
    structureName: '',
    customStructureName: '',
    selectedCatalogItemIds: [],
    catalogItemId: '',
    code: '',
    name: '',
    progressMode: 'quantity',
    targetUnits: '',
    unit: '',
    weight: '',
    plannedHH: ''
  };
}

export function applyCatalogStepSistemaChange(
  state: CatalogAssignmentFormState,
  newSistemaName: string,
  rawCatalog?: any[]
): CatalogAssignmentFormState {
  const cleanSistema = String(newSistemaName || '').trim();
  let resolvedLocation = state.locationType || 'Interno';

  if (cleanSistema && state.areaName && Array.isArray(rawCatalog)) {
    const systems = getCatalogSystemsByArea(rawCatalog, state.areaName);
    const matched = systems.find(
      (s) => s.value.toLowerCase() === cleanSistema.toLowerCase()
    );
    if (matched) {
      resolvedLocation = matched.locationType || 'Interno';
    }
  }

  return {
    ...state,
    sistemaName: cleanSistema,
    locationType: cleanSistema ? resolvedLocation : '',
    customSistemaName: '',
    structureName: '',
    customStructureName: '',
    selectedCatalogItemIds: [],
    catalogItemId: '',
    code: '',
    name: '',
    progressMode: 'quantity',
    targetUnits: '',
    unit: '',
    weight: '',
    plannedHH: ''
  };
}

export function applyCatalogStepEstructuraChange(
  state: CatalogAssignmentFormState,
  newStructureName: string
): CatalogAssignmentFormState {
  const cleanStructure = String(newStructureName || '').trim();
  return {
    ...state,
    structureName: cleanStructure,
    customStructureName: '',
    selectedCatalogItemIds: [],
    catalogItemId: '',
    code: '',
    name: '',
    progressMode: 'quantity',
    targetUnits: '',
    unit: '',
    weight: '',
    plannedHH: ''
  };
}

function syncPrimaryActivityFields(
  state: CatalogAssignmentFormState,
  selectedIds: string[],
  availableActivities: MasterCatalogRecord[]
): CatalogAssignmentFormState {
  const selectedItems = availableActivities.filter((a) => selectedIds.includes(a.id));
  const primary = selectedItems[0];
  if (!primary) {
    return {
      ...state,
      selectedCatalogItemIds: [],
      catalogItemId: '',
      code: '',
      name: '',
      progressMode: 'quantity',
      targetUnits: '',
      unit: '',
      weight: '',
      plannedHH: ''
    };
  }

  const mode = normalizeCatalogProgressMode(primary.progressMode);
  return {
    ...state,
    selectedCatalogItemIds: selectedIds,
    catalogItemId: primary.id,
    code: primary.code,
    name: primary.name,
    progressMode: mode,
    locationType: primary.locationType || state.locationType || 'Interno',
    targetUnits: mode === 'percentage' ? '100' : String(primary.targetUnits ?? ''),
    unit: mode === 'percentage' ? '%' : String(primary.unit || ''),
    weight: String(primary.weight ?? '1'),
    plannedHH: String(primary.plannedHH ?? '0')
  };
}

export function applyCatalogStepActivityToggle(
  state: CatalogAssignmentFormState,
  activityId: string,
  availableActivities: MasterCatalogRecord[]
): CatalogAssignmentFormState {
  const cleanId = String(activityId || '').trim();
  if (!cleanId) return state;
  const validIds = new Set(availableActivities.map((a) => a.id));
  if (!validIds.has(cleanId)) return state;

  const currentSet = new Set(
    (state.selectedCatalogItemIds || []).filter((id) => validIds.has(id))
  );
  if (currentSet.has(cleanId)) {
    currentSet.delete(cleanId);
  } else {
    currentSet.add(cleanId);
  }

  const orderedSelectedIds = availableActivities
    .filter((a) => currentSet.has(a.id))
    .map((a) => a.id);

  return syncPrimaryActivityFields(state, orderedSelectedIds, availableActivities);
}

export function applyCatalogStepSelectAllActivities(
  state: CatalogAssignmentFormState,
  availableActivities: MasterCatalogRecord[],
  selectAll: boolean
): CatalogAssignmentFormState {
  const orderedSelectedIds = selectAll ? availableActivities.map((a) => a.id) : [];
  return syncPrimaryActivityFields(state, orderedSelectedIds, availableActivities);
}

/**
 * Asigna una o varias actividades seleccionadas del Catálogo Maestro al galpón destino
 * (y opcionalmente a un galpón compartido), sin modificar los demás galpones y sin generar duplicados.
 */
export function assignCatalogActivitiesToSectors(params: {
  sectors: any[];
  catalogItemsToAssign: MasterCatalogRecord[];
  targetGalponIds: string[];
  startDate: string;
  dueDate: string;
  updatedBy: string;
  nowIso: string;
  allAreas: string[];
  areasWithSistemas: string[];
  generateIdFn: (prefix: string) => string;
  singleItemOverrides?: {
    code?: string;
    name?: string;
    progressMode?: ProgressModality;
    targetUnits?: number | string;
    unit?: string;
    weight?: number | string;
    plannedHH?: number | string;
    locationType?: string;
  };
}): {
  updatedSectors: any[];
  addedCount: number;
  skippedDuplicatesCount: number;
  assignedActivities: MasterCatalogRecord[];
} {
  const {
    sectors,
    catalogItemsToAssign,
    targetGalponIds,
    startDate,
    dueDate,
    updatedBy,
    nowIso,
    allAreas,
    areasWithSistemas,
    generateIdFn,
    singleItemOverrides
  } = params;

  const validTargetGalponIds = Array.from(
    new Set((targetGalponIds || []).map((id) => String(id || '').trim()).filter(Boolean))
  );
  const activeItems = getActiveMasterCatalog(catalogItemsToAssign);

  if (validTargetGalponIds.length === 0 || activeItems.length === 0) {
    return {
      updatedSectors: sectors,
      addedCount: 0,
      skippedDuplicatesCount: 0,
      assignedActivities: []
    };
  }

  let addedCount = 0;
  let skippedDuplicatesCount = 0;

  const preparedItems: MasterCatalogRecord[] = activeItems.map((item, idx) => {
    const isSingleWithOverride = activeItems.length === 1 && idx === 0 && singleItemOverrides;
    const mode = normalizeCatalogProgressMode(
      isSingleWithOverride && singleItemOverrides?.progressMode
        ? singleItemOverrides.progressMode
        : item.progressMode
    );
    const code = String(
      isSingleWithOverride && singleItemOverrides?.code
        ? singleItemOverrides.code
        : item.code
    )
      .trim()
      .toUpperCase();
    const name = String(
      isSingleWithOverride && singleItemOverrides?.name
        ? singleItemOverrides.name
        : item.name
    ).trim();
    const rawTargetUnits =
      isSingleWithOverride && singleItemOverrides?.targetUnits !== undefined
        ? Number(singleItemOverrides.targetUnits)
        : Number(item.targetUnits);
    const rawUnit =
      isSingleWithOverride && singleItemOverrides?.unit !== undefined
        ? String(singleItemOverrides.unit).trim()
        : String(item.unit || '').trim();
    const rawWeight =
      isSingleWithOverride && singleItemOverrides?.weight !== undefined
        ? Number(singleItemOverrides.weight)
        : Number(item.weight);
    const rawPlannedHH =
      isSingleWithOverride && singleItemOverrides?.plannedHH !== undefined
        ? Number(singleItemOverrides.plannedHH)
        : Number(item.plannedHH);
    const locType =
      isSingleWithOverride && singleItemOverrides?.locationType
        ? singleItemOverrides.locationType
        : item.locationType || 'Interno';

    return {
      ...item,
      code,
      name,
      progressMode: mode,
      locationType: locType,
      targetUnits: mode === 'percentage' ? 100 : rawTargetUnits || 0,
      unit: mode === 'percentage' ? rawUnit || '%' : rawUnit,
      weight: rawWeight || 1.0,
      plannedHH: rawPlannedHH || 0
    };
  });

  const updatedSectors = (sectors || []).map((sec) => {
    const hasTargetInSector = (sec.galpones || []).some((g: any) =>
      validTargetGalponIds.includes(g.id)
    );
    if (!hasTargetInSector) return sec;

    return {
      ...sec,
      galpones: (sec.galpones || []).map((g: any) => {
        if (!validTargetGalponIds.includes(g.id)) return g;

        const baseAreas =
          Array.isArray(g.areas) && g.areas.length > 0
            ? g.areas.map((a: any) => ({ ...a }))
            : allAreas.map((aName, idx) => ({
                id: generateIdFn(`area_${idx}`),
                name: aName,
                hasSistemas: areasWithSistemas.includes(aName),
                sistemas: [],
                structures: []
              }));

        for (const catItem of preparedItems) {
          const cleanSistemaName = String(catItem.sistemaName || '').trim();
          const areaHasSistemas =
            Boolean(cleanSistemaName) && cleanSistemaName !== NO_SISTEMA_VALUE;

          let areaIdx = baseAreas.findIndex(
            (a: any) =>
              String(a.name || '').trim().toLowerCase() ===
              catItem.areaName.toLowerCase()
          );
          if (areaIdx < 0) {
            baseAreas.push({
              id: generateIdFn('area'),
              name: catItem.areaName,
              hasSistemas: areaHasSistemas || areasWithSistemas.includes(catItem.areaName),
              sistemas: [],
              structures: []
            });
            areaIdx = baseAreas.length - 1;
          }

          const areaObj = { ...baseAreas[areaIdx] };
          const resolvedEndDate =
            dueDate ||
            (() => {
              const d = new Date(startDate);
              if (Number.isNaN(d.getTime())) return startDate;
              d.setDate(d.getDate() + (Number(catItem.durationDays) || 1));
              return d.toISOString().split('T')[0];
            })();

          const newActRecord = {
            id: generateIdFn('act'),
            catalogItemId: catItem.id,
            code: catItem.code,
            name: catItem.name,
            progressMode: catItem.progressMode,
            locationType: areaHasSistemas
              ? catItem.locationType || 'Interno'
              : 'Interno',
            sistemaName: areaHasSistemas ? catItem.sistemaName || null : null,
            structureName: catItem.structureName,
            targetUnits: catItem.targetUnits,
            unit: catItem.unit,
            weight: catItem.weight,
            plannedHH: catItem.plannedHH,
            startDate,
            dueDate: resolvedEndDate,
            status: 'Pendiente',
            createdAt: nowIso,
            updatedAt: nowIso,
            updatedBy
          };

          if (areaHasSistemas) {
            const sisList = [...(areaObj.sistemas || [])];
            const targetSisName = String(catItem.sistemaName || '').trim();
            const targetLoc = catItem.locationType || 'Interno';
            let sisIdx = sisList.findIndex(
              (sis: any) =>
                String(sis.name || '').trim().toLowerCase() ===
                  targetSisName.toLowerCase() &&
                (sis.locationType || 'Interno') === targetLoc
            );
            let sisObj =
              sisIdx >= 0
                ? { ...sisList[sisIdx] }
                : {
                    id: generateIdFn('sis'),
                    name: targetSisName,
                    locationType: targetLoc,
                    structures: []
                  };

            const strList = [...(sisObj.structures || [])];
            let strIdx = strList.findIndex(
              (st: any) =>
                String(st.name || '').trim().toLowerCase() ===
                catItem.structureName.toLowerCase()
            );

            if (strIdx < 0) {
              strList.push({
                id: generateIdFn('str'),
                name: catItem.structureName,
                activities: [{ ...newActRecord, sistemaName: targetSisName }]
              });
              addedCount++;
            } else {
              const strObj = { ...strList[strIdx] };
              const existingActs = Array.isArray(strObj.activities)
                ? strObj.activities
                : [];
              const alreadyExists = existingActs.some(
                (ex: any) =>
                  (ex.catalogItemId && ex.catalogItemId === catItem.id) ||
                  String(ex.code || '').trim().toUpperCase() === catItem.code
              );
              if (alreadyExists) {
                skippedDuplicatesCount++;
              } else {
                strObj.activities = [
                  ...existingActs,
                  { ...newActRecord, sistemaName: targetSisName }
                ];
                strList[strIdx] = strObj;
                addedCount++;
              }
            }

            sisObj = { ...sisObj, structures: strList };
            if (sisIdx >= 0) {
              sisList[sisIdx] = sisObj;
            } else {
              sisList.push(sisObj);
            }
            areaObj.hasSistemas = true;
            areaObj.sistemas = sisList;
          } else {
            const strList = [...(areaObj.structures || [])];
            let strIdx = strList.findIndex(
              (st: any) =>
                String(st.name || '').trim().toLowerCase() ===
                catItem.structureName.toLowerCase()
            );

            if (strIdx < 0) {
              strList.push({
                id: generateIdFn('str'),
                name: catItem.structureName,
                activities: [newActRecord]
              });
              addedCount++;
            } else {
              const strObj = { ...strList[strIdx] };
              const existingActs = Array.isArray(strObj.activities)
                ? strObj.activities
                : [];
              const alreadyExists = existingActs.some(
                (ex: any) =>
                  (ex.catalogItemId && ex.catalogItemId === catItem.id) ||
                  String(ex.code || '').trim().toUpperCase() === catItem.code
              );
              if (alreadyExists) {
                skippedDuplicatesCount++;
              } else {
                strObj.activities = [...existingActs, newActRecord];
                strList[strIdx] = strObj;
                addedCount++;
              }
            }
            areaObj.hasSistemas = false;
            areaObj.structures = strList;
          }

          baseAreas[areaIdx] = areaObj;
        }

        return {
          ...g,
          updatedAt: nowIso,
          areas: baseAreas
        };
      })
    };
  });

  return {
    updatedSectors,
    addedCount,
    skippedDuplicatesCount,
    assignedActivities: preparedItems
  };
}
