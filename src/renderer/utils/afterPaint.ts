/**
 * Run `cb` after the browser has painted the current React commit.
 * Double rAF is "after layout + paint", not a wall-clock timeout — slow
 * networks keep the spinner up until the fetch finishes; fast ones drop
 * it on the next frames.
 */
export function afterPaint(cb: () => void): () => void {
  let inner = 0;
  const outer = requestAnimationFrame(() => {
    inner = requestAnimationFrame(cb);
  });
  return () => {
    cancelAnimationFrame(outer);
    if (inner) cancelAnimationFrame(inner);
  };
}

export function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    const cancel = afterPaint(() => resolve());
    void cancel;
  });
}
