/** `null` means the area layout is still loading. `[]` is a saved empty area. */
export function isFloorLayoutPending(
  nodes: readonly unknown[] | null,
): boolean {
  return nodes == null;
}

export function isFloorLayoutVacant(nodes: readonly unknown[] | null): boolean {
  return Array.isArray(nodes) && nodes.length === 0;
}

/**
 * Auto-fit needs a real canvas box. `{w:0,h:0}` is the first React render
 * before the wrapper is measured — painting tables then would show them
 * clustered at saved coordinates, then spread when the scale lands.
 */
export function isFloorCanvasFitReady(size: { w: number; h: number }): boolean {
  return size.w > 0 && size.h > 0;
}
