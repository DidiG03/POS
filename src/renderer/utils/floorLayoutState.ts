/** `null` means the area layout is still loading. `[]` is a saved empty area. */
export function isFloorLayoutPending(
  nodes: readonly unknown[] | null,
): boolean {
  return nodes == null;
}

export function isFloorLayoutVacant(nodes: readonly unknown[] | null): boolean {
  return Array.isArray(nodes) && nodes.length === 0;
}
