type Advance = { galponId?: string; activityId?: string; activityCode?: string };

export function indexActivityAdvances<T extends Advance>(advances: T[], ambiguousCodes = new Map<string, Set<string>>()) {
  const records = new Map<string, T[]>();
  const key = (galponId: string, type: 'id' | 'legacy', activity: string) => JSON.stringify([galponId, type, activity]);
  for (const item of advances) {
    if (!item?.galponId || (!item.activityId && !item.activityCode)) continue;
    const id = key(item.galponId, item.activityId ? 'id' : 'legacy', item.activityId || item.activityCode!);
    const logs = records.get(id);
    if (logs) logs.push(item);
    else records.set(id, [item]);
  }
  return (galponId: string, activityId?: string, activityCode?: string): T[] => [
    ...(activityId ? records.get(key(galponId, 'id', activityId)) ?? [] : []),
    ...(activityCode && !ambiguousCodes.get(galponId)?.has(activityCode)
      ? records.get(key(galponId, 'legacy', activityCode)) ?? [] : [])
  ];
}
