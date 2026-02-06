export type DateRangePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';

export function computeDateRange(
  range: DateRangePreset,
  customStart: string,
  customEnd: string,
): { startIso: string | undefined; endIso: string | undefined } {
  let startIso: string | undefined;
  let endIso: string | undefined;

  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (range === 'today') {
    startIso = startOfDay(now).toISOString();
    endIso = new Date().toISOString();
  } else if (range === 'yesterday') {
    const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    startIso = startOfDay(y).toISOString();
    endIso = startOfDay(now).toISOString();
  } else if (range === 'last7') {
    const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    startIso = d.toISOString();
    endIso = now.toISOString();
  } else if (range === 'last30') {
    const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    startIso = d.toISOString();
    endIso = now.toISOString();
  } else if (range === 'custom') {
    startIso = customStart ? new Date(customStart).toISOString() : undefined;
    endIso = customEnd ? new Date(customEnd).toISOString() : undefined;
  }

  return { startIso, endIso };
}

