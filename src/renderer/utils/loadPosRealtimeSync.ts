/** Load the ticket/table live-sync graph only after staff are past Select Staff. */
export function loadPosRealtimeSync(): Promise<void> {
  return import('./posRealtimeSync').then((m) => {
    m.installPosRealtimeSync();
  });
}
