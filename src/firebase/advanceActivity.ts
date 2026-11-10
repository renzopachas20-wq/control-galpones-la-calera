type Activity = { id: string; code?: string };
type Structure = { activities?: Activity[] };
type Barn = { id: string; areas?: { hasSistemas?: boolean; sistemas?: { structures?: Structure[] }[]; structures?: Structure[] }[] };

export function barnResponsible(barn?: { responsible?: unknown; supervisors?: unknown } | null): string {
  if (typeof barn?.responsible === 'string') return barn.responsible;
  return Array.isArray(barn?.supervisors) ? barn.supervisors.filter(name => typeof name === 'string').join(', ') : '';
}

export function ganttPlannedActivities<T extends Activity>(activities: T[], excludedIds?: string[]): T[] {
  if (!Array.isArray(excludedIds) || !excludedIds.length) return activities;
  const excluded = new Set(excludedIds);
  return activities.filter(activity => !excluded.has(activity.id));
}

export function barnActivities(barn: Barn | null | undefined): Activity[] {
  const array = <T>(items?: T[]): T[] => Array.isArray(items) ? items : [];
  return array(barn?.areas).flatMap(area => {
    const structures = area?.hasSistemas ? array(area.sistemas).flatMap(system => array(system?.structures)) : array(area?.structures);
    return structures.flatMap(structure => array(structure?.activities).filter(Boolean));
  });
}

export function findAdvanceActivity<T extends Activity>(activities: T[], activityId?: string, activityCode?: string): T | undefined {
  if (!activityId && !activityCode) return undefined;
  const matches = activities.filter(activity => activityId ? activity.id === activityId : activity.code === activityCode);
  return matches.length === 1 ? matches[0] : undefined;
}

export function ambiguousActivityCodes(activities: Activity[]) {
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const { code } of activities) {
    if (!code) continue;
    if (seen.has(code)) duplicates.add(code);
    seen.add(code);
  }
  return duplicates;
}
