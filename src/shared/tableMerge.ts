export type TableMergeGroup = {
  id: string;
  labels: string[];
  x: number;
  y: number;
};

export type MergeTableFootprint = {
  x: number;
  y: number;
  w?: number;
  h?: number;
};

export function compareTableLabels(a: string, b: string): number {
  const pa = String(a).match(/^(.*?)(\d+)$/);
  const pb = String(b).match(/^(.*?)(\d+)$/);
  if (pa && pb && pa[1] === pb[1]) return Number(pa[2]) - Number(pb[2]);
  return String(a).localeCompare(String(b));
}

export function sanitizeMergeGroups(input: unknown): TableMergeGroup[] {
  if (!Array.isArray(input)) return [];
  const used = new Set<string>();
  const out: TableMergeGroup[] = [];
  for (const raw of input as any[]) {
    const rawLabels: unknown[] = Array.isArray(raw?.labels) ? raw.labels : [];
    const labels = [
      ...new Set(
        rawLabels
          .map((s) => String(s || '').trim())
          .filter((s) => s.length > 0),
      ),
    ].sort(compareTableLabels);
    if (labels.length < 2) continue;
    if (labels.some((l) => used.has(l))) continue;
    for (const l of labels) used.add(l);
    const x = Number(raw?.x);
    const y = Number(raw?.y);
    out.push({
      id: String(raw?.id || `m${out.length + 1}`),
      labels,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    });
  }
  return out;
}

export function formatMergeLabel(labels: string[]): string {
  return [...labels].sort(compareTableLabels).join('+');
}

export function pruneMergeGroups(
  groups: TableMergeGroup[],
  knownLabels: Iterable<string>,
): TableMergeGroup[] {
  const known = new Set(
    [...knownLabels].map((s) => String(s || '').trim()).filter(Boolean),
  );
  return sanitizeMergeGroups(
    groups.map((g) => ({
      ...g,
      labels: g.labels.filter((l) => known.has(l)),
    })),
  );
}

export function mergeMembersFor(
  groups: TableMergeGroup[],
  label: string,
): string[] {
  const g = groups.find((x) => x.labels.includes(label));
  return g ? [...g.labels] : [label];
}

export function mergeTableGroups(
  groups: TableMergeGroup[],
  labelsA: string[],
  labelsB: string[],
  x: number,
  y: number,
): TableMergeGroup[] {
  const all = [...new Set([...labelsA, ...labelsB].map((s) => s.trim()))]
    .filter(Boolean)
    .sort(compareTableLabels);
  if (all.length < 2) return sanitizeMergeGroups(groups);
  const rest = groups.filter((g) => !g.labels.some((l) => all.includes(l)));
  return sanitizeMergeGroups([
    ...rest,
    {
      id: `m${Date.now().toString(36)}`,
      labels: all,
      x,
      y,
    },
  ]);
}

export function separateTableGroup(
  groups: TableMergeGroup[],
  label: string,
): TableMergeGroup[] {
  return sanitizeMergeGroups(groups.filter((g) => !g.labels.includes(label)));
}

export function tablesTouching(
  a: MergeTableFootprint,
  b: MergeTableFootprint,
): boolean {
  const aw = Math.max(36, Number(a.w) || 64);
  const ah = Math.max(36, Number(a.h) || 64);
  const bw = Math.max(36, Number(b.w) || 64);
  const bh = Math.max(36, Number(b.h) || 64);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const thresh = (Math.max(aw, ah) + Math.max(bw, bh)) * 0.38;
  return dx * dx + dy * dy <= thresh * thresh;
}
