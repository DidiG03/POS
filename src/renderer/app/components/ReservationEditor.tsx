import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReservationDTO, ReservationStatus } from '@shared/ipc';
import { reservationStatusLabel } from '../../utils/reservationLabels';
import {
  DEFAULT_RESERVATION_DURATION_MIN,
  distinctSeatedAt,
  effectiveReservationStatus,
  formatReservationClock,
} from '@shared/reservationDuration';
import { ReservationDurationPicker } from './ReservationDurationPicker';
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from '../../components/ui';
import { occupancyOverlapsInstant } from '@shared/tableOccupancy';

export type ReservationEditorProps = {
  open: boolean;
  onClose: () => void;
  // Either an existing reservation (edit mode) or initial seed values for create mode.
  initial?: Partial<ReservationDTO> | null;
  /** Areas configured in Admin (settings.tableAreas). */
  areas: { name: string; count?: number }[];
  /**
   * Header / floor selection — default area when creating unless `initial.area`
   * is set (e.g. tap-to-edit from floor canvas).
   */
  defaultArea: string;
  /** Resolve TABLE labels from the saved layout for the picked area. */
  getTableLabelsForArea: (areaName: string) => Promise<string[]>;
  /** True when the table has a live occupying reservation. */
  isTableBusy?: (areaName: string, label: string) => boolean;
  /** True when a waiter ticket is unpaid on the table (still bookable later). */
  isTableOpenTicket?: (areaName: string, label: string) => boolean;
  actorId: number;
  onSaved: (r: ReservationDTO) => void;
  onDeleted?: (id: number) => void;
};

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toDateInputValue(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function dateFromInputValue(v: string): Date {
  const [y, m, d] = v.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d))
    return startOfLocalDay(new Date());
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** Local wall-clock HH:mm for `min` on `<input type="time">`. */
function localTimeHHMM(when: Date = new Date()): string {
  return (
    String(when.getHours()).padStart(2, '0') +
    ':' +
    String(when.getMinutes()).padStart(2, '0')
  );
}

function isoFromLocalDateAndTime(date: Date, time: string): string {
  // time is "HH:mm"
  const [hh, mm] = time.split(':').map((s) => Number(s));
  const d = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Number.isFinite(hh) ? hh : 19,
    Number.isFinite(mm) ? mm : 0,
    0,
    0,
  );
  return d.toISOString();
}

function timeFromIso(iso: string): string {
  const d = new Date(iso);
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0')
  );
}

// Electron's ipcRenderer wraps thrown main-process errors with a verbose
// prefix like `Error invoking remote method 'reservations:create': Error: …`.
// Strip it so the user only sees our friendly message text.
function cleanErrorMessage(e: any, fallback: string): string {
  const raw = String(e?.message || e || '').trim();
  if (!raw) return fallback;
  const m = raw.match(
    /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s,
  );
  return (m ? m[1] : raw).trim() || fallback;
}

function mapReservationConflict(
  raw: string,
  t: (key: string, opts?: Record<string, string>) => string,
): string {
  if (/open ticket/i.test(raw) || /TABLE_OPEN_TICKET/i.test(raw)) {
    const m = raw.match(/Table\s+(\S+)/i);
    const label = (m?.[1] || '').replace(/[.,]$/, '');
    return t('reservations.tableOpenTicketConflict', { label });
  }
  return raw;
}

export default function ReservationEditor({
  open,
  onClose,
  initial,
  areas,
  defaultArea,
  getTableLabelsForArea,
  isTableBusy,
  isTableOpenTicket,
  actorId,
  onSaved,
  onDeleted,
}: ReservationEditorProps) {
  const { t } = useTranslation();
  const isEdit = Boolean(initial?.id);
  const seatedClock = distinctSeatedAt(
    initial?.startsAt || '',
    initial?.seatedAt,
  );
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [partySize, setPartySize] = useState<number>(2);
  const [reservationDay, setReservationDay] = useState<Date>(() =>
    startOfLocalDay(new Date()),
  );
  const [time, setTime] = useState<string>('19:00');
  const [durationMin, setDurationMin] = useState<number>(
    DEFAULT_RESERVATION_DURATION_MIN,
  );
  const [formArea, setFormArea] = useState<string>('');
  const [tableLabel, setTableLabel] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [layoutLabels, setLayoutLabels] = useState<string[]>([]);
  const [editNowMs, setEditNowMs] = useState(() => Date.now());
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open || !isEdit) return;
    setEditNowMs(Date.now());
    const id = window.setInterval(() => setEditNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [open, isEdit]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setConfirmDelete(false);
    const nowWall = new Date();
    const today = startOfLocalDay(nowWall);

    let day: Date;
    if (initial?.id && initial?.startsAt) {
      day = startOfLocalDay(new Date(initial.startsAt));
    } else if (!initial?.id && initial?.startsAt) {
      const seed = startOfLocalDay(new Date(initial.startsAt));
      day = seed >= today ? seed : today;
    } else {
      day = today;
    }
    setReservationDay(day);

    let nextTime =
      initial?.startsAt != null && String(initial.startsAt).trim() !== ''
        ? timeFromIso(String(initial.startsAt))
        : '19:00';
    if (isSameLocalDay(day, today)) {
      const minT = localTimeHHMM(nowWall);
      if (nextTime < minT) nextTime = minT;
    }
    setTime(nextTime);

    const seedArea =
      (initial?.area && String(initial.area).trim()) ||
      (defaultArea && String(defaultArea).trim()) ||
      (areas[0]?.name ? String(areas[0].name) : '');
    setFormArea(seedArea);
    if (initial && initial.id) {
      setCustomerName(initial.customerName || '');
      setCustomerPhone(initial.customerPhone || '');
      setPartySize(Number(initial.partySize || 2));
      setDurationMin(
        Number(initial.durationMin || DEFAULT_RESERVATION_DURATION_MIN),
      );
      setTableLabel(initial.tableLabel || '');
      setNote(initial.note || '');
    } else {
      setCustomerName(initial?.customerName || '');
      setCustomerPhone(initial?.customerPhone || '');
      setPartySize(Number(initial?.partySize || 2));
      setDurationMin(
        Number(initial?.durationMin || DEFAULT_RESERVATION_DURATION_MIN),
      );
      setTableLabel(initial?.tableLabel || '');
      setNote(initial?.note || '');
    }
  }, [open, initial, defaultArea, areas]);

  useEffect(() => {
    if (!open || !formArea) {
      setLayoutLabels([]);
      setLabelsLoading(false);
      return;
    }
    let cancelled = false;
    setLabelsLoading(true);
    getTableLabelsForArea(formArea)
      .then((labels) => {
        if (!cancelled) setLayoutLabels(Array.isArray(labels) ? labels : []);
      })
      .catch(() => {
        if (!cancelled) setLayoutLabels([]);
      })
      .finally(() => {
        if (!cancelled) setLabelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, formArea, getTableLabelsForArea]);

  const tableOptions = useMemo(() => {
    const set = new Set<string>(layoutLabels);
    // Editing an existing row: keep the assigned table visible even if the
    // layout JSON lagged or the label was removed from the floor plan.
    if (
      initial?.tableLabel &&
      initial.area &&
      String(initial.area) === String(formArea)
    ) {
      set.add(initial.tableLabel);
    }
    return Array.from(set).sort((a, b) => {
      // Natural sort: T1, T2, T10
      const an = Number((a.match(/\d+/) || ['0'])[0]);
      const bn = Number((b.match(/\d+/) || ['0'])[0]);
      if (an !== bn) return an - bn;
      return a.localeCompare(b);
    });
  }, [layoutLabels, initial?.tableLabel, initial?.area, formArea]);

  const wallClock = new Date();
  const todayStart = startOfLocalDay(wallClock);
  /** New bookings only — editing keeps historical dates visible. */
  const minDateStrForPicker = !isEdit
    ? toDateInputValue(todayStart)
    : undefined;
  const isReservationToday = isSameLocalDay(reservationDay, todayStart);
  const minTimeToday = isReservationToday
    ? localTimeHHMM(wallClock)
    : undefined;

  const shownStatus = (
    isEdit
      ? effectiveReservationStatus(
          {
            status: initial?.status || 'BOOKED',
            startsAt: initial?.startsAt || new Date().toISOString(),
            durationMin: initial?.durationMin ?? durationMin,
          },
          editNowMs,
        )
      : 'BOOKED'
  ) as ReservationStatus;

  if (!open) return null;

  async function save() {
    setError(null);
    const name = customerName.trim();
    if (!name) {
      setError(t('reservations.customerNameRequired'));
      return;
    }
    if (!formArea) {
      setError(t('reservations.chooseArea'));
      return;
    }
    const keepCurrent =
      Boolean(isEdit && initial?.id) &&
      String(initial?.area || '') === formArea &&
      String(initial?.tableLabel || '') === tableLabel;
    const startsAtIso = isoFromLocalDateAndTime(reservationDay, time);
    if (tableLabel && isTableBusy?.(formArea, tableLabel) && !keepCurrent) {
      setError(
        t('reservations.tableOpenTicketConflict', { label: tableLabel }),
      );
      return;
    }
    if (
      tableLabel &&
      isTableOpenTicket?.(formArea, tableLabel) &&
      !keepCurrent &&
      occupancyOverlapsInstant(startsAtIso, durationMin, Date.now())
    ) {
      setError(
        t('reservations.tableOpenTicketConflict', { label: tableLabel }),
      );
      return;
    }
    const proposedMs = new Date(startsAtIso).getTime();
    if (!isEdit) {
      if (startOfLocalDay(reservationDay).getTime() < todayStart.getTime()) {
        setError(t('reservations.pastDate'));
        return;
      }
      const slackMs = 45_000;
      if (proposedMs < Date.now() - slackMs) {
        setError(t('reservations.futureTime'));
        return;
      }
    }
    setBusy(true);
    try {
      let r: ReservationDTO;
      if (isEdit && initial?.id) {
        r = await window.api.reservations.update({
          id: initial.id,
          actorId,
          area: formArea,
          tableLabel: tableLabel || null,
          customerName: name,
          customerPhone: customerPhone.trim() || null,
          partySize,
          startsAtIso,
          durationMin,
          note: note.trim() || null,
        });
      } else {
        r = await window.api.reservations.create({
          area: formArea,
          tableLabel: tableLabel || null,
          customerName: name,
          customerPhone: customerPhone.trim() || null,
          partySize,
          startsAtIso,
          durationMin,
          note: note.trim() || null,
          createdById: actorId,
        });
      }
      onSaved(r);
      onClose();
    } catch (e: any) {
      setError(
        mapReservationConflict(
          cleanErrorMessage(e, t('reservations.saveFailed')),
          t,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!initial?.id) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.reservations.delete({ id: initial.id, actorId });
      setConfirmDelete(false);
      onDeleted?.(initial.id);
      onClose();
    } catch (e: any) {
      setError(cleanErrorMessage(e, t('reservations.deleteFailed')));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="lg"
        title={
          isEdit
            ? t('reservations.editReservation')
            : t('reservations.newReservationTitleShort')
        }
        footer={
          <>
            {isEdit ? (
              <Button
                variant="danger"
                className="mr-auto max-sm:mr-0 max-sm:flex-1"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                {t('reservations.delete')}
              </Button>
            ) : null}
            <Button
              variant="primary"
              className="max-sm:flex-1"
              loading={busy}
              onClick={save}
            >
              {isEdit
                ? t('reservations.saveChanges')
                : t('reservations.createReservation')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {isEdit ? (
            <div className="flex items-center gap-2">
              <span className="pos-label m-0">
                {t('reservations.statusLabel')}
              </span>
              <Badge>{reservationStatusLabel(t, shownStatus)}</Badge>
            </div>
          ) : null}

          <Field label={t('reservations.customerName')}>
            <Input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder={t('reservations.customerNamePlaceholder')}
              autoFocus
              className="text-base"
              disabled={busy}
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('reservations.phoneOptional')}>
              <Input
                type="tel"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="+355 ..."
                inputMode="tel"
                className="text-base"
                disabled={busy}
              />
            </Field>
            <Field label={t('reservations.partySize')}>
              <Input
                type="number"
                min={1}
                max={200}
                value={partySize}
                onChange={(e) => setPartySize(Number(e.target.value || 0))}
                inputMode="numeric"
                className="text-base"
                disabled={busy}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('reservations.date')}>
              <Input
                type="date"
                value={toDateInputValue(reservationDay)}
                min={minDateStrForPicker}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  let picked = dateFromInputValue(v);
                  const t0 = startOfLocalDay(new Date());
                  if (!isEdit && picked.getTime() < t0.getTime()) {
                    picked = t0;
                  }
                  setReservationDay(picked);
                  if (isSameLocalDay(picked, startOfLocalDay(new Date()))) {
                    const minT = localTimeHHMM(new Date());
                    setTime((cur) => (cur < minT ? minT : cur));
                  }
                }}
                className="text-base"
              />
            </Field>
            <Field
              label={t('reservations.time')}
              hint={
                seatedClock
                  ? `${t('reservations.timeSeated')}: ${formatReservationClock(seatedClock)}`
                  : undefined
              }
            >
              <Input
                type="time"
                value={time}
                min={minTimeToday}
                disabled={busy}
                onChange={(e) => {
                  let v = e.target.value;
                  if (minTimeToday && v < minTimeToday) v = minTimeToday;
                  setTime(v);
                }}
                className="text-base"
              />
            </Field>
          </div>

          <Field label={t('reservations.duration')}>
            <ReservationDurationPicker
              value={durationMin}
              onChange={setDurationMin}
              disabled={busy}
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t('reservations.area')}
              hint={
                labelsLoading
                  ? t('reservations.loadingTables')
                  : !labelsLoading &&
                      formArea &&
                      tableOptions.length === 0 &&
                      areas.length > 0
                    ? t('reservations.noTablesOnFloor')
                    : undefined
              }
            >
              <Select
                value={formArea}
                onChange={(e) => {
                  setFormArea(e.target.value);
                  setTableLabel('');
                }}
                disabled={areas.length === 0 || busy}
                className="text-base"
              >
                {areas.length === 0 ? (
                  <option value="">
                    {t('reservations.noAreasConfigured')}
                  </option>
                ) : (
                  areas.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))
                )}
              </Select>
            </Field>
            <Field label={t('common.table')}>
              <Select
                value={tableLabel}
                onChange={(e) => setTableLabel(e.target.value)}
                disabled={!formArea || busy}
                className="text-base"
              >
                <option value="">{t('reservations.noSpecificTable')}</option>
                {tableOptions.map((l) => {
                  const occupying = Boolean(isTableBusy?.(formArea, l));
                  const ticketOpen = Boolean(isTableOpenTicket?.(formArea, l));
                  const keepCurrent =
                    isEdit &&
                    String(initial?.area || '') === formArea &&
                    String(initial?.tableLabel || '') === l;
                  return (
                    <option
                      key={l}
                      value={l}
                      disabled={occupying && !keepCurrent}
                    >
                      {l}
                      {occupying || ticketOpen
                        ? t('reservations.tableBusySuffix')
                        : ''}
                    </option>
                  );
                })}
              </Select>
            </Field>
          </div>

          <Field label={t('common.note')}>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('reservations.notePlaceholder')}
              rows={3}
              className="text-base"
              disabled={busy}
            />
          </Field>

          {error ? (
            <div className="text-[13px] text-rose-300">{error}</div>
          ) : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title={t('reservations.delete')}
        body={t('reservations.deleteConfirm')}
        confirmLabel={t('reservations.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
