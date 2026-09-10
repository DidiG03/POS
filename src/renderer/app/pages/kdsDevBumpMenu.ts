export const KDS_DEV_BUMP_MENU = Boolean(import.meta.env.DEV);

export function kdsItemIsBumpable(
  it:
    | {
        name?: string;
        voided?: boolean;
        locked?: boolean;
        bumped?: boolean;
        cookerBumped?: boolean;
      }
    | undefined,
  cooker: boolean,
): boolean {
  if (!it || it.voided || it.locked) return false;
  if (cooker) return !it.cookerBumped;
  return !it.bumped;
}

export function clampKdsDevMenuPos(
  x: number,
  y: number,
  menuW = 220,
  menuH = 132,
  viewport?: { width: number; height: number },
): { x: number; y: number } {
  const pad = 8;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const maxX = Math.max(pad, width - menuW - pad);
  const maxY = Math.max(pad, height - menuH - pad);
  return {
    x: Math.min(Math.max(pad, x), maxX),
    y: Math.min(Math.max(pad, y), maxY),
  };
}
