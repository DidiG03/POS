import { useEffect, useMemo, useRef, useState } from 'react';
import { useTicketStore } from '../../stores/ticket';
import { useOrderContext } from '../../stores/orderContext';
import { useTableStatus } from '../../stores/tableStatus';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../../stores/session';
import { logTicket } from '../../api';
import { useFavourites } from '../../stores/favourites';

type MenuItemDTO = {
  id: number;
  name: string;
  sku: string;
  price: number;
  vatRate: number;
  active: boolean;
  categoryId: number;
};
type MenuCategoryDTO = {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  items: MenuItemDTO[];
};

export default function OrderPage() {
  const [categories, setCategories] = useState<MenuCategoryDTO[]>([]);
  const [selectedCatId, setSelectedCatId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const { lines, addItem, increment, decrement, setLineNote, orderNote, setOrderNote, clear, removeLine } = useTicketStore();
  const [weightModal, setWeightModal] = useState<{ sku: string; name: string; unitPrice: number; vatRate: number } | null>(null);
  const [weightInput, setWeightInput] = useState<string>('');
  const { selectedTable, setPendingAction } = useOrderContext();
  const { setOpen, isOpen, openMap: _openMap } = useTableStatus();
  const [showCovers, setShowCovers] = useState(false);
  const [coversValue, setCoversValue] = useState('');
  const [voidTarget, setVoidTarget] = useState<{
    id: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate: number;
    note?: string;
  } | null>(null);
  const navigate = useNavigate();
  const { user } = useSessionStore();
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const suppressFreeOnEmptyRef = useRef(false);
  const initialRenderRef = useRef(true);
  const [requestLocked, setRequestLocked] = useState(false);

  const fav = useFavourites();
  const favouriteSkus = fav.list(user?.id || null);
  const selected = useMemo(() => {
    // Virtual Favourites category id: -1
    if (selectedCatId === -1) {
      const items = categories.flatMap((c) => c.items).filter((i) => favouriteSkus.includes(i.sku));
      return { id: -1, name: 'Favourites', sortOrder: -999, active: true, items } as any;
    }
    return categories.find((c) => c.id === selectedCatId) ?? categories[0];
  }, [categories, selectedCatId, favouriteSkus]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    // If there is a search query, search across all categories' items
    if (q) {
      return categories.flatMap((c) => c.items).filter(
        (i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q)
      );
    }
    // Otherwise, show items from the selected category (or first category)
    return selected ? selected.items : categories.flatMap((c) => c.items);
  }, [categories, selected, query]);

  const loadMenu = async () => {
    const data = await window.api.menu.listCategoriesWithItems();
    try {
      // Debug: log a few items that are marked isKg either directly or via tags
      const kgSamples = (data || [])
        .flatMap((c: any) => (Array.isArray(c?.items) ? c.items : []))
        .filter((it: any) => Boolean((it as any)?.isKg) || Boolean((it as any)?.tags?.isKg))
        .slice(0, 5)
        .map((it: any) => ({ name: it?.name, sku: it?.sku, isKg: (it as any)?.isKg, tags: (it as any)?.tags }));
      console.log('[menu]  :', kgSamples);
      if (!kgSamples.length) {
        const first = (data?.[0]?.items?.[0]) || null;
        console.log('[menu] first item example:', first);
      }
    } catch {}
    setCategories(data);
    if (data.length && !selectedCatId) setSelectedCatId(data[0].id);
  };

  useEffect(() => {
    loadMenu();
  }, []);

  // Determine owner of the currently selected open table
  useEffect(() => {
    (async () => {
      if (!selectedTable) {
        setOwnerId(null);
        return;
      }
      if (!isOpen(selectedTable.area, selectedTable.label)) {
        setOwnerId(null);
        return;
      }
      try {
        const data = await window.api.tickets.getLatestForTable(selectedTable.area, selectedTable.label);
        setOwnerId(data?.userId ?? null);
      } catch {
        setOwnerId(null);
      }
    })();
  }, [selectedTable?.area, selectedTable?.label, isOpen(selectedTable?.area || '', selectedTable?.label || '')]);

  // Hydrate lines from server when selecting a table or on refresh
  useEffect(() => {
    (async () => {
      if (!selectedTable) return;
      // Only hydrate for tables currently marked as open
      if (!isOpen(selectedTable.area, selectedTable.label)) return;
      try {
        const latest = await window.api.tickets.getLatestForTable(selectedTable.area, selectedTable.label);
        const items = Array.isArray(latest?.items) ? latest!.items : [];
        const remaining = items.filter((it: any) => !it.voided);
        if (remaining.length) {
          useTicketStore.getState().hydrate({ items: remaining as any, note: latest?.note || '' });
        }
      } catch {}
    })();
  }, [selectedTable?.area, selectedTable?.label, isOpen(selectedTable?.area || '', selectedTable?.label || '')]);

  // If an open table's ticket becomes empty due to voids, free the table (turn green) after server check
  useEffect(() => {
    if (initialRenderRef.current) {
      initialRenderRef.current = false;
      return;
    }
    if (!selectedTable) return;
    if (!isOpen(selectedTable.area, selectedTable.label)) return;
    if (lines.length === 0) {
      if (suppressFreeOnEmptyRef.current) return;
      (async () => {
        try {
          const latest = await window.api.tickets.getLatestForTable(selectedTable.area, selectedTable.label);
          const items = Array.isArray(latest?.items) ? latest!.items : [];
          const remaining = items.filter((it: any) => !it.voided);
          if (remaining.length) {
            // Rehydrate and keep table open
            useTicketStore.getState().hydrate({ items: remaining as any, note: latest?.note || '' });
            setOpen(selectedTable.area, selectedTable.label, true);
            return;
          }
        } catch {}
        setOpen(selectedTable.area, selectedTable.label, false);
        window.api.tables.setOpen(selectedTable.area, selectedTable.label, false).catch(() => {});
      })();
    }
  }, [lines.length, selectedTable]);

  // const syncMenu = async () => {
  //   setSyncing(true);
  //   try {
  //     const url = (window as any).MENU_API_URL || undefined;
  //     await window.api.menu.syncFromUrl({ url: url || 'https://ullishtja-agroturizem.com/api/pos-menu?lang=en' });
  //     await loadMenu();
  //   } finally {
  //     setSyncing(false);
  //   }
  // };

  // Owner: poll for approved requests for current table and apply to ticket
  useEffect(() => {
    if (!user || !selectedTable) return;
    if (!isOpen(selectedTable.area, selectedTable.label)) return;
    if (ownerId == null || Number(ownerId) !== Number(user.id)) return;
    let timer: any;
    const tick = async () => {
      try {
        const rows = await window.api.requests.pollApprovedForTable(user.id, selectedTable.area, selectedTable.label);
        if (Array.isArray(rows) && rows.length) {
          // Merge items into current ticket
          for (const r of rows) {
            const items = Array.isArray(r.items) ? r.items : [];
            for (const it of items) {
              addItem({ sku: String(it.name), name: String(it.name), unitPrice: Number(it.unitPrice || 0), vatRate: Number(it.vatRate || 0) });
              // adjust quantity if >1
              const times = Math.max(1, Number(it.qty || 1)) - 1;
              for (let i = 0; i < times; i++) {
                const last = useTicketStore.getState().lines.slice(-1)[0];
                if (last) useTicketStore.getState().increment(last.id);
              }
            }
          }
          await window.api.requests.markApplied(rows.map((r: any) => r.id));
        }
      } finally {
        timer = setTimeout(tick, 4000);
      }
    };
    tick();
    return () => clearTimeout(timer);
  }, [user?.id, selectedTable?.area, selectedTable?.label, ownerId]);

  return (
    <div style={{ height: 'calc(100vh - 100px)' }} className="grid grid-cols-3 gap-4 min-h-0">
      <div className="col-span-2 min-h-full overflow-auto">
        <div className="flex gap-2 mb-3">
          <input
            placeholder="Kërko në Menu..."
            className="w-full p-2 bg-gray-700 rounded"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          {/* Favourites tab */}
          <button
            key={-1}
            onClick={() => setSelectedCatId(-1)}
            className={`py-7 px-2 border border-gray-700 hover:bg-gray-800 cursor-pointer rounded ${selected?.id === -1 ? 'bg-gray-800' : 'bg-gray-900'}`}
          >
            Të Preferuarat
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedCatId(c.id)}
              className={`py-7 px-2 border border-gray-700 hover:bg-gray-800 cursor-pointer rounded ${selected?.id === c.id ? 'bg-gray-800' : 'bg-gray-900'}`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {filteredItems.map((i: MenuItemDTO) => {
            const isFav = fav.isFav(user?.id || null, i.sku);
            return (
              <div key={i.id} className="relative">
                <button
                  className="bg-emerald-800 hover:bg-emerald-700 py-4 rounded text-left px-3 cursor-pointer w-full"
                  onClick={() => {
                    // If isKg, open weight keypad; otherwise add normally
                    const isKg = Boolean((i as any)?.isKg) || Boolean((i as any)?.tags?.isKg);
                    console.log('[click item]', { name: i.name, sku: i.sku, isKg, raw: i });
                    if (isKg) {
                      setWeightModal({ sku: i.sku, name: i.name, unitPrice: i.price, vatRate: i.vatRate });
                      setWeightInput('');
                    } else {
                      addItem({ sku: i.sku, name: i.name, unitPrice: i.price, vatRate: i.vatRate });
                    }
                  }}
                >
                  <div className="font-medium pr-6">{i.name}</div>
                  <div className="text-sm">{i.price}</div>
                </button>
                <button
                  className={`absolute top-1 right-1 text-xs px-2 py-1 rounded ${isFav ? 'bg-pink-700' : 'bg-emerald-700'} cursor-pointer`}
                  onClick={(e) => { e.stopPropagation(); if (user?.id) fav.toggle(user.id, i.sku); }}
                  title={isFav ? 'Remove from favourites' : 'Add to favourites'}
                >
                  {isFav ? '♥' : '♡'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="bg-gray-800 p-3 rounded flex flex-col h-full min-h-0">
        <div className="font-semibold mb-2">Ticket {selectedTable ? `- ${selectedTable.label}` : ''}</div>
          <div className="flex-1 overflow-auto space-y-2">
          {lines.length === 0 ? (
            <div className="text-sm opacity-60">Zgjidhni elementet për të shtuar…</div>
          ) : (
            lines.map((l) => {
              const showRequestOnly = Boolean(
                selectedTable &&
                isOpen(selectedTable.area, selectedTable.label) &&
                ownerId &&
                user?.id != null && Number(ownerId) !== Number(user.id)
              );
              const isTableOpen = Boolean(selectedTable && isOpen(selectedTable.area, selectedTable.label));
              const dimmed = isTableOpen && !l.staged; // darker when already sent
              return (
              <div key={l.id} className="bg-gray-700 rounded px-2 py-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className={`${dimmed ? 'text-gray-400' : 'text-white'} font-medium`}>{l.name}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedTable && isOpen(selectedTable.area, selectedTable.label) && !showRequestOnly && l.staged ? (
                      <>
                        <button 
                          className="bg-gray-600 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                          style={{ width: '28px', height: '28px', minWidth: '28px', minHeight: '28px', padding: 0 }}
                          onClick={() => decrement(l.id)}
                          disabled={l.qty === 1}
                        >
                          -
                        </button>
                        <div className="w-6 text-center">{l.qty}</div>
                        <button 
                          className="bg-gray-600 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                          style={{ width: '28px', height: '28px', minWidth: '28px', minHeight: '28px', padding: 0 }}
                          onClick={() => increment(l.id)} 
                          disabled={l.qty >= 100}
                          >
                            +
                          </button>
                      </>
                    ) : (<div className="w-6 text-center text-gray-400">QTY:{l.qty}</div>)}
                    <div className={`w-20 text-right ${dimmed ? 'text-gray-400' : 'text-white'}`}>{(l.unitPrice * l.qty)}</div>
                    {/* When table is open (sent), owner can void already-sent lines; staged (unsent) lines can be removed */}
                    {selectedTable && isTableOpen && !showRequestOnly ? (
                      l.staged ? (
                        <button
                          className="bg-gray-600 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                          style={{ width: '28px', height: '28px', minWidth: '28px', minHeight: '28px', padding: 0 }}
                          onClick={() => removeLine(l.id)}
                        >
                          X
                        </button>
                      ) : (
                        <button
                          className="bg-red-700 hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                          style={{ width: '28px', height: '28px', minWidth: '28px', minHeight: '28px', padding: 0 }}
                          onClick={() =>
                            setVoidTarget({
                              id: l.id,
                              name: l.name,
                              qty: l.qty,
                              unitPrice: l.unitPrice,
                              vatRate: l.vatRate,
                              note: l.note,
                            })
                          }
                          title="Void"
                        >
                          A
                        </button>
                      )
                    ) : (
                      // For non-owners or not-open tables: allow removing; if in request-only mode, only staged lines are allowed
                      <button
                        className="bg-gray-600 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer rounded-full text-xs flex items-center justify-center"
                        style={{ width: '28px', height: '28px', minWidth: '28px', minHeight: '28px', padding: 0 }}
                        disabled={showRequestOnly && !l.staged}
                        onClick={() => removeLine(l.id)}
                      >
                        X
                      </button>
                    )}
                  </div>
                </div>
                <input
                  className={`mt-2 w-full rounded px-2 py-1 text-sm placeholder:text-gray-300 ${dimmed && !(showRequestOnly && l.staged) ? 'bg-gray-700 opacity-60 cursor-not-allowed' : 'bg-gray-600'}`}
                  placeholder="Add note (e.g., No onion, extra cheese)"
                  value={l.note ?? ''}
                  disabled={Boolean(isTableOpen && !(showRequestOnly && l.staged))}
                  onChange={(e) => setLineNote(l.id, e.target.value)}
                />
              </div>
            );
          })
        )}
        </div>
        <div className="border-t border-gray-700 mt-3 pt-3 space-y-1 text-sm">
          <div className="mb-3">
            <label className="block text-xs mb-1 opacity-70">Shënime për porosinë</label>
            {(() => {
              const requestOnly = Boolean(
                selectedTable &&
                isOpen(selectedTable.area, selectedTable.label) &&
                ownerId &&
                user?.id != null && Number(ownerId) !== Number(user.id)
              );
              const ticketOpen = Boolean(selectedTable && isOpen(selectedTable.area, selectedTable.label));
              // Disable order note both when ticket is open and in request-only mode; notes should only be on staged items
              const disabled = ticketOpen || requestOnly;
              return (
                <textarea
                  className={`w-full rounded px-2 py-2 text-sm ${disabled ? 'bg-gray-700 opacity-60 cursor-not-allowed' : 'bg-gray-700'}`}
                  rows={2}
                  placeholder="e.g., Alergji, shënime daljeje, shënime tavoline"
                  value={orderNote}
                  disabled={disabled}
                  onChange={(e) => setOrderNote(e.target.value)}
                />
              );
            })()}
          </div>
          <TicketTotals />
        </div>
        <div className="mt-3 flex gap-2">
          {(() => {
            const showRequestOnly = Boolean(
              selectedTable &&
              isOpen(selectedTable.area, selectedTable.label) &&
              ownerId &&
              user?.id != null && Number(ownerId) !== Number(user.id)
            );
            if (showRequestOnly) {
              return (
                <button
                  className="flex-1 bg-amber-700 hover:bg-amber-600 py-2 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                  disabled={lines.length === 0 || requestLocked}
                  onClick={async () => {
                    if (!selectedTable || !user?.id || !ownerId) return;
                    if (lines.length === 0) {
                      alert('Shtoni elemente para se të dërgoni një kërkesë');
                      return;
                    }
                    const items = lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, vatRate: l.vatRate, note: l.note }));
                    await window.api.requests.create({
                      requesterId: user.id,
                      ownerId,
                      area: selectedTable.area,
                      tableLabel: selectedTable.label,
                      items,
                      note: orderNote || null,
                    });
                    setRequestLocked(true);
                    alert('Kërkesa është dërguar te zhvilluesi');
                  }}
                >
                  Kërkesa për të shtuar në porosi
                </button>
              );
            }
            return (
              <>
                <button
                  className="flex-1 bg-red-600 hover:bg-red-700 py-2 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                  disabled={lines.length === 0}
                  onClick={async () => {
                    if (selectedTable && isOpen(selectedTable.area, selectedTable.label)) {
                      if (!user?.id) return;
                      await window.api.tickets.voidTicket({
                        userId: user.id,
                        area: selectedTable.area,
                        tableLabel: selectedTable.label,
                        reason: orderNote || undefined,
                      });
                      // Free table when fully voided
                      setOpen(selectedTable.area, selectedTable.label, false);
                    }
                    clear();
                    setOrderNote('');
                  }}
                >
                  {selectedTable && isOpen(selectedTable.area, selectedTable.label) ? 'Anullo Faturën' : 'Pastro'}
                </button>
                <button
                  className="flex-1 bg-blue-600 hover:bg-blue-700 py-2 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                  disabled={lines.length === 0}
                  onClick={async () => {
                    if (!selectedTable) {
                      setPendingAction('send');
                      navigate('/app/tables');
                      return;
                    }
                    // Ask for covers only if table is not marked as open (green)
                    if (!isOpen(selectedTable.area, selectedTable.label)) {
                      setCoversValue('');
                      setShowCovers(true);
                      return;
                    }
                    // Enrich log with details (table, order lines, notes, covers)
                    const lastCovers = await window.api.covers.getLast(selectedTable.area, selectedTable.label);
                    const details = {
                      table: selectedTable.label,
                      area: selectedTable.area,
                      covers: lastCovers ?? null,
                      orderNote,
                      lines: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, vatRate: l.vatRate, note: l.note })),
                    };
                    console.log('ticket sent', details);
                    if (!user?.id) return; // require logged-in user to log ticket
                    await logTicket({
                      userId: user.id,
                      area: selectedTable.area,
                      tableLabel: selectedTable.label,
                      covers: lastCovers ?? null,
                      items: details.lines,
                      note: orderNote,
                    });
                    // Immediately dim and lock qty by marking all as sent (optimistic)
                    useTicketStore.getState().markAllAsSent();
                    await window.api.tickets.print({
                      area: selectedTable.area,
                      tableLabel: selectedTable.label,
                      covers: lastCovers ?? null,
                      items: details.lines,
                      note: orderNote,
                      userName: user.displayName,
                    });
                    // Mark table open optimistically (server poll merges, but we protect optimistic state for a short TTL)
                    setOpen(selectedTable.area, selectedTable.label, true);
                    await window.api.tables.setOpen(selectedTable.area, selectedTable.label, true).catch(() => {});
                  }}
                >
                  {lines.some((l) => l.staged) ? 'Dërgo Porosinë' : 'Printo Faturën'}
                </button>
                <button
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                  disabled={lines.length === 0}
                  onClick={() => {
                    if (!selectedTable) {
                      setPendingAction('pay');
                      navigate('/app/tables');
                      return;
                    }
                    console.log(`ticket - ${selectedTable.label} paid`);
                    setOpen(selectedTable.area, selectedTable.label, false);
                    window.api.tables.setOpen(selectedTable.area, selectedTable.label, false).catch(() => {});
                    clear();
                    setOrderNote('');
                  }}
                >
                  Paguaj
                </button>
              </>
            );
          })()}
        </div>
      </div>
      {showCovers && selectedTable && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">Persona për tavolinën {selectedTable.label}</h3>
            <input
              autoFocus
              type="number"
              min={1}
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={coversValue}
              onChange={(e) => setCoversValue(e.target.value)}
            />
            <div className="flex gap-2 mt-4">
              <button className="flex-1 bg-gray-600 py-2 rounded" onClick={() => setShowCovers(false)}>Anullo</button>
              <button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded"
                onClick={async () => {
                  const num = Number(coversValue);
                  if (!Number.isFinite(num) || num <= 0) return;
                  await window.api.covers.save(selectedTable.area, selectedTable.label, num);
                  setOpen(selectedTable.area, selectedTable.label, true);
                  setShowCovers(false);
                  const details = {
                    table: selectedTable.label,
                    area: selectedTable.area,
                    covers: num,
                    orderNote,
                    lines: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, vatRate: l.vatRate, note: l.note })),
                  };
                  console.log('ticket sent', details);
                  if (!user?.id) return;
                  await logTicket({
                    userId: user.id,
                    area: selectedTable.area,
                    tableLabel: selectedTable.label,
                    covers: num,
                    items: details.lines,
                    note: orderNote,
                  });
                  // Immediately dim and lock qty by marking all as sent (optimistic)
                  useTicketStore.getState().markAllAsSent();
                  await window.api.tickets.print({
                    area: selectedTable.area,
                    tableLabel: selectedTable.label,
                    covers: num,
                    items: details.lines,
                    note: orderNote,
                    userName: user.displayName,
                  });
                  await window.api.tables.setOpen(selectedTable.area, selectedTable.label, true).catch(() => {});
                }}
              >
                Konfirmo
              </button>
            </div>
          </div>
        </div>
      )}

      {voidTarget && selectedTable && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">Anullo elementin?</h3>
            <p className="text-sm opacity-80 text-center mb-4">
              {voidTarget.name} ×{voidTarget.qty} on {selectedTable.area} • {selectedTable.label}
            </p>
            <div className="flex gap-2 mt-2">
              <button className="flex-1 bg-gray-600 py-2 rounded" onClick={() => setVoidTarget(null)}>Anullo</button>
              <button
                className="flex-1 bg-red-700 hover:bg-red-800 py-2 rounded"
                onClick={async () => {
                  if (!user?.id) return;
                  await window.api.tickets.voidItem({
                    userId: user.id,
                    area: selectedTable.area,
                    tableLabel: selectedTable.label,
                    item: {
                      name: voidTarget.name,
                      qty: voidTarget.qty,
                      unitPrice: voidTarget.unitPrice,
                      vatRate: voidTarget.vatRate,
                      note: voidTarget.note,
                    },
                  });
                  removeLine(voidTarget.id);
                  setVoidTarget(null);
                }}
              >
                Konfirmo Anullimin
              </button>
            </div>
          </div>
        </div>
      )}

      {weightModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
            <h3 className="text-center mb-2">Vendos peshën (kg ose g)</h3>
            <div className="mb-2 text-center opacity-80">{weightModal.name}</div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {[...'123456789'].map((d) => (
                <button key={d} className="bg-gray-700 py-2 rounded" onClick={() => setWeightInput((v) => v + d)}>{d}</button>
              ))}
              <button className="bg-gray-700 py-2 rounded" onClick={() => setWeightInput((v) => v + '0')}>0</button>
              <button className="bg-gray-700 py-2 rounded" onClick={() => setWeightInput((v) => (v.includes('.') ? v : v + '.'))}>.</button>
              <button className="bg-gray-700 py-2 rounded" onClick={() => setWeightInput('')}>Pastro</button>
            </div>
            <div className="flex gap-2 mb-3">
              <button className="flex-1 bg-gray-700 py-2 rounded" onClick={() => setWeightInput((v) => v + ' kg')}>kg</button>
              <button className="flex-1 bg-gray-700 py-2 rounded" onClick={() => setWeightInput((v) => v + ' g')}>g</button>
            </div>
            <input className="w-full bg-gray-700 rounded px-2 py-2 text-center mb-3" placeholder="e.g., 0.35 kg or 350 g" value={weightInput} onChange={(e) => setWeightInput(e.target.value)} />
            <div className="flex gap-2">
              <button className="flex-1 bg-gray-600 py-2 rounded" onClick={() => setWeightModal(null)}>Anullo</button>
              <button className="flex-1 bg-emerald-600 hover:bg-emerald-700 py-2 rounded" onClick={() => {
                if (!weightModal) return;
                const raw = weightInput.trim().toLowerCase();
                if (!raw) return;
                let qty = 0;
                if (raw.endsWith('kg')) qty = Number(raw.replace('kg','').trim());
                else if (raw.endsWith('g')) qty = Number(raw.replace('g','').trim()) / 1000;
                else qty = Number(raw);
                if (!Number.isFinite(qty) || qty <= 0) return;
                addItem({ sku: weightModal.sku, name: weightModal.name, unitPrice: weightModal.unitPrice, vatRate: weightModal.vatRate, qty });
                setWeightModal(null);
                setWeightInput('');
              }}>Konfirmo</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TicketTotals() {
  const { lines } = useTicketStore();
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const vat = lines.reduce((s, l) => s + l.unitPrice * l.qty * l.vatRate, 0);
  const total = subtotal + vat;
  return (
    <>
      <div className="flex justify-between"><span>Subtotal</span><span>  {subtotal.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}</span></div>
      <div className="flex justify-between"><span>VAT</span><span>  {vat.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}</span></div>
      <div className="flex justify-between font-semibold"><span>Total</span><span>  {total.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}</span></div>
    </>
  );
}


