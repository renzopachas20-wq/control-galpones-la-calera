import React, { useMemo, useState } from 'react';
import { computeWeightedProgress } from './dashboardSelectors';

export type PortfolioRow = {
  projectName: string;
  sectorId: string;
  sectorName: string;
  galponId: string;
  galponCode: string;
  galponName: string;
  areaName: string;
  sistemaName: string;
  activityName: string;
  weight: number;
  progressPercent: number;
  computedStatus: string;
};

const groups = { projectName: 'Proyecto', sectorName: 'Sector', galponName: 'Galpón', areaName: 'Área', sistemaName: 'Sistema' } as const;

export function PortfolioOverview({ rows, onExport }: { rows: PortfolioRow[]; onExport?: (visible: PortfolioRow[]) => void }) {
  const [project, setProject] = useState('');
  const [sector, setSector] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [group, setGroup] = useState<keyof typeof groups>('projectName');
  const projects = useMemo(() => [...new Set(rows.map(row => row.projectName))].sort(), [rows]);
  const inProject = useMemo(() => rows.filter(row => !project || project === row.projectName), [rows, project]);
  const sectors = useMemo(() => [...new Map(inProject.map(row => [row.sectorId, row.sectorName || row.sectorId]))], [inProject]);
  const inSector = useMemo(() => inProject.filter(row => !sector || row.sectorId === sector), [inProject, sector]);
  const barns = useMemo(() => [...new Map(inSector.map(row => [row.galponId, row.galponCode || row.galponName]))], [inSector]);
  const visible = useMemo(() => inSector.filter(row => !selected.length || selected.includes(row.galponId)), [inSector, selected]);
  const summaries = useMemo(() => {
    const byGroup = new Map<string, PortfolioRow[]>();
    for (const row of visible) {
      const key = group === 'sectorName' ? row.sectorId : group === 'galponName' ? row.galponId : row[group];
      const subset = byGroup.get(key);
      if (subset) subset.push(row);
      else byGroup.set(key, [row]);
    }
    return [...byGroup.entries()].map(([key, subset]) => ({
      key, label: group === 'galponName' ? subset[0].galponCode + ' · ' + subset[0].galponName : subset[0][group] || key,
      count: subset.length, progress: computeWeightedProgress(subset),
      delayed: subset.filter(row => row.computedStatus === 'Atrasado').length
    }));
  }, [visible, group]);
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby="portfolio-title">
      <h2 id="portfolio-title" className="font-bold text-slate-900">Avance de proyectos y galpones</h2>
      <div className="my-3 flex flex-wrap gap-3 text-xs">
        <label>Proyecto <select value={project} className="rounded border p-1"
          onChange={event => { setProject(event.target.value); setSector(''); setSelected([]); }}>
          <option value="">Todos</option>
          {projects.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label>Sector <select value={sector} className="rounded border p-1"
          onChange={event => { setSector(event.target.value); setSelected([]); }}>
          <option value="">Todos</option>
          {sectors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label>Agrupar por <select value={group} className="rounded border p-1"
          onChange={event => setGroup(event.target.value as keyof typeof groups)}>
          {Object.entries(groups).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        {onExport && <button type="button" disabled={!visible.length} onClick={() => onExport(visible)}
          className="rounded border px-2 py-1 font-semibold disabled:opacity-40">
          Exportar avance CSV
        </button>}
      </div>
      <details className="mb-3 text-xs">
        <summary>Galpones {selected.length ? '(' + selected.length + ')' : '(todos)'}</summary>
        <div className="mt-2 flex flex-wrap gap-3">
          {barns.map(([id, label]) => <label key={id}>
            <input type="checkbox" checked={selected.includes(id)} onChange={() => setSelected(ids =>
              ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id])} /> {label}
          </label>)}
        </div>
      </details>
      <p className="mb-2 text-sm font-bold">Avance ponderado {computeWeightedProgress(visible).toFixed(1)}% · {visible.length} actividades</p>
      {summaries.length ? <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead><tr><th>{groups[group]}</th><th>Avance</th><th>Actividades</th><th>Atrasadas</th></tr></thead>
          <tbody>{summaries.map(row => <tr key={row.key} className="border-t border-slate-100">
            <th className="py-2 font-medium">{row.label}</th><td>{row.progress.toFixed(1)}%</td><td>{row.count}</td><td>{row.delayed}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="text-sm text-slate-500">No hay actividades para este alcance.</p>}
    </section>
  );
}
