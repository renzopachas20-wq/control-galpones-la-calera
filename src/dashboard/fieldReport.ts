type Location = { galponId?: string; sectorId?: string };
type Barn = { id: string; code?: string; name?: string; projectCode?: string };
type Sector = { id: string; code?: string; name?: string; projectName?: string; galpones?: Barn[] };
type ActivityRow = { galponId: string };
type Material = Location & { usedQty?: number; totalQty?: number };
type Worker = Location & { id: string };

function byLocation<T extends Location>(items: T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    if (!item.galponId) continue;
    const group = groups.get(item.galponId);
    if (group) group.push(item);
    else groups.set(item.galponId, [item]);
  }
  return groups;
}

export function fieldReport(sectors: Sector[], activityRows: ActivityRow[], materials: Material[], workers: Worker[],
  attendance: Record<string, string>, filters: { project: string; sector: string; galpon: string; activityFiltered: boolean }) {
  const byBarn = new Map<string, number>();
  const workersByBarn = byLocation(workers), materialsByBarn = byLocation(materials);
  for (const row of activityRows) byBarn.set(row.galponId, (byBarn.get(row.galponId) ?? 0) + 1);
  return sectors.flatMap(sector => {
    if (filters.sector !== 'ALL' && sector.id !== filters.sector) return [];
    return (sector.galpones ?? []).flatMap(barn => {
      const project = barn.projectCode || sector.projectName || sector.code || sector.name || 'Proyecto La Calera';
      if ((filters.project !== 'ALL' && filters.project !== project) ||
          (filters.galpon !== 'ALL' && filters.galpon !== barn.id) ||
          (filters.activityFiltered && !byBarn.has(barn.id))) return [];
      const belongs = (item: Location) => !item.sectorId || item.sectorId === sector.id;
      const staff = (workersByBarn.get(barn.id) ?? []).filter(belongs);
      const stock = (materialsByBarn.get(barn.id) ?? []).filter(belongs);
      return [{
        id: barn.id, project, sector: sector.name ?? sector.id, galpon: barn.code ?? barn.name ?? barn.id,
        activities: byBarn.get(barn.id) ?? 0, personnel: staff.length,
        present: staff.filter(worker => attendance[worker.id] === 'Asistió').length,
        registered: staff.filter(worker => !!attendance[worker.id]).length,
        materials: stock.length, outOfStock: stock.filter(item => (item.usedQty ?? 0) >= (item.totalQty ?? 0)).length
      }];
    });
  });
}
