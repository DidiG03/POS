/**
 * Where the seat count sits, bottom-right inside the table's shape. The
 * surface clips to the shape, so on a round table the corner of the box
 * is outside it and the count was cut off (QA v0.2.104, #15): on a circle
 * it goes to the corner of the square inscribed in it, (1 - 1/√2) / 2 of
 * the size in from each side, plus a little margin.
 */
export function seatBadgeInset(
  shape: 'circle' | 'square' | 'rect',
  w: number,
  h: number,
): { right: number; bottom: number } {
  if (shape !== 'circle') return { right: 4, bottom: 3 };
  const k = (1 - Math.SQRT1_2) / 2;
  return {
    right: Math.max(4, Math.round(w * k) + 2),
    bottom: Math.max(3, Math.round(h * k) + 2),
  };
}
