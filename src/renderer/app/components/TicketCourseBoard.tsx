import { memo, type ReactNode, useMemo, useState } from 'react';
import {
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import { partitionCourseBoardLines } from '@shared/ticketCourses';
import {
  isImmediateFireStation,
  linesForCourseFire,
} from '@shared/ticketCourseFire';
import {
  groupLinesBySeat,
  isBillableLine,
  seatLabel,
} from '@shared/ticketSeats';
import {
  IconEdit,
  IconGrip,
  IconPrinter,
  IconTrash,
} from '../../components/icons';
import { useTicketStore, type TicketLine } from '../../stores/ticket';

const GROUP_PREFIX = 'group:';

const DND_MEASURING = {
  droppable: { strategy: MeasuringStrategy.BeforeDragging },
};

const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const VERTICAL_MODIFIERS = [restrictToVerticalAxis];

const DND_AUTO_SCROLL = { layoutShiftCompensation: false };

function groupSortableId(groupId: string): string {
  return `${GROUP_PREFIX}${groupId}`;
}

function parseGroupSortableId(id: UniqueIdentifier): string | null {
  const s = String(id);
  return s.startsWith(GROUP_PREFIX) ? s.slice(GROUP_PREFIX.length) : null;
}

function sortableStyle(
  transform: { x: number; y: number; scaleX: number; scaleY: number } | null,
  transition: string | undefined,
  isDragging: boolean,
  draggingOpacity: number,
) {
  return {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? draggingOpacity : 1,
    willChange: transform ? ('transform' as const) : undefined,
  };
}

function SortableGroup({
  groupId,
  title,
  activeHint,
  active,
  canEdit,
  canDrop,
  canRemove,
  canFire,
  fireDisabled,
  onFire,
  fireLabel,
  canPrint,
  printDisabled,
  onPrint,
  printLabel,
  canRename,
  renameLabel,
  renamePlaceholder,
  onRename,
  reorderLabel,
  removeLabel,
  onActivate,
  onRemove,
  children,
}: {
  groupId: string;
  title: string;
  activeHint: string;
  active: boolean;
  canEdit: boolean;
  canDrop: boolean;
  canRemove: boolean;
  canFire: boolean;
  fireDisabled?: boolean;
  onFire?: () => void;
  fireLabel: string;
  canPrint: boolean;
  printDisabled?: boolean;
  onPrint?: () => void;
  printLabel: string;
  canRename?: boolean;
  renameLabel?: string;
  renamePlaceholder?: string;
  onRename?: (name: string) => void;
  reorderLabel: string;
  removeLabel: string;
  onActivate: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(title);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: groupSortableId(groupId),
    disabled: !canEdit,
    data: { type: 'group', groupId },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop:${groupId}`,
    data: { type: 'group-drop', groupId },
    disabled: !canDrop,
  });

  function commitRename() {
    if (!renaming) return;
    setRenaming(false);
    onRename?.(draftName);
  }

  return (
    <div
      ref={setNodeRef}
      style={sortableStyle(transform, transition, isDragging, 0.55)}
      className="space-y-1.5"
    >
      <div
        className={`flex flex-wrap items-center gap-1 rounded-md border px-1.5 py-1 ${
          active
            ? 'border-[var(--pos-accent)] bg-[var(--pos-accent-soft)]'
            : 'border-[var(--pos-border)] bg-[var(--pos-surface-2)]'
        }`}
        onPointerDown={(e) => {
          if (renaming) return;
          if ((e.target as HTMLElement).closest('button, input')) return;
          onActivate();
        }}
      >
        {canEdit ? (
          <button
            type="button"
            className="pos-icon-btn !w-8 !h-8 cursor-grab touch-none active:cursor-grabbing shrink-0"
            aria-label={reorderLabel}
            {...attributes}
            {...listeners}
          >
            <IconGrip />
          </button>
        ) : null}
        {renaming ? (
          <input
            autoFocus
            className="pos-input min-w-[6.5rem] flex-1 text-sm font-semibold"
            value={draftName}
            maxLength={24}
            placeholder={renamePlaceholder}
            aria-label={renameLabel}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDraftName(title);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 text-left text-sm font-semibold py-1 px-1 rounded"
            onPointerDown={(e) => {
              e.stopPropagation();
              onActivate();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onActivate();
            }}
          >
            {title}
            {active ? (
              <span className="block text-[11px] font-normal text-gray-400">
                {activeHint}
              </span>
            ) : null}
          </button>
        )}
        {canRename && !renaming ? (
          <button
            type="button"
            className="pos-icon-btn !w-8 !h-8 shrink-0 ml-0.5 mr-1"
            title={renameLabel}
            aria-label={renameLabel}
            onClick={(e) => {
              e.stopPropagation();
              setDraftName(title);
              setRenaming(true);
            }}
          >
            <IconEdit />
          </button>
        ) : null}
        <div className="flex-1 min-w-0" />
        {canFire ? (
          <button
            type="button"
            className="shrink-0 text-xs font-semibold px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
            disabled={fireDisabled}
            onClick={(e) => {
              e.stopPropagation();
              onFire?.();
            }}
          >
            {fireLabel}
          </button>
        ) : null}
        {canPrint ? (
          <button
            type="button"
            className="pos-icon-btn !w-8 !h-8 shrink-0"
            title={printLabel}
            aria-label={printLabel}
            disabled={printDisabled}
            onClick={(e) => {
              e.stopPropagation();
              onPrint?.();
            }}
          >
            <IconPrinter />
          </button>
        ) : null}
        {canEdit && canRemove ? (
          <button
            type="button"
            className="pos-icon-btn !w-8 !h-8 shrink-0"
            title={removeLabel}
            aria-label={removeLabel}
            onClick={onRemove}
          >
            <IconTrash />
          </button>
        ) : null}
      </div>
      <div
        ref={setDropRef}
        className={`space-y-2 min-h-[2.25rem] rounded-md ${
          isOver ? 'ring-1 ring-[var(--pos-accent)]' : ''
        }`}
        onPointerDown={() => onActivate()}
      >
        {children}
      </div>
    </div>
  );
}

function SortableLine({
  line,
  canEdit,
  children,
}: {
  line: TicketLine;
  canEdit: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: line.id,
    disabled: !canEdit,
    data: {
      type: 'line',
      courseId: line.courseId,
      seatId: line.seatId,
      lineId: line.id,
    },
  });
  return (
    <div
      ref={setNodeRef}
      style={sortableStyle(transform, transition, isDragging, 0.45)}
      className="flex items-stretch gap-1"
    >
      {canEdit ? (
        <button
          type="button"
          className="pos-icon-btn !w-8 shrink-0 self-start mt-2 cursor-grab touch-none active:cursor-grabbing"
          aria-label={t('order.reorderItem')}
          {...attributes}
          {...listeners}
        >
          <IconGrip />
        </button>
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export const TicketCourseBoard = memo(function TicketCourseBoard({
  mode = 'course',
  canEdit,
  canAddCourse,
  fireDisabled,
  onFireCourse,
  onPrintSeat,
  printDisabled,
  renderLine,
}: {
  mode?: 'course' | 'seat';
  canEdit: boolean;
  canAddCourse?: boolean;
  fireDisabled?: boolean;
  onFireCourse?: (courseId: string) => void;
  onPrintSeat?: (seatId: string) => void;
  printDisabled?: boolean;
  renderLine: (line: TicketLine) => ReactNode;
}) {
  const { t } = useTranslation();
  const lines = useTicketStore((s) => s.lines);
  const courses = useTicketStore((s) => s.courses);
  const seats = useTicketStore((s) => s.seats);
  const activeCourseId = useTicketStore((s) => s.activeCourseId);
  const activeSeatId = useTicketStore((s) => s.activeSeatId);
  const addCourse = useTicketStore((s) => s.addCourse);
  const addSeat = useTicketStore((s) => s.addSeat);
  const removeCourse = useTicketStore((s) => s.removeCourse);
  const removeSeat = useTicketStore((s) => s.removeSeat);
  const setActiveCourseId = useTicketStore((s) => s.setActiveCourseId);
  const setActiveSeatId = useTicketStore((s) => s.setActiveSeatId);
  const reorderCourses = useTicketStore((s) => s.reorderCourses);
  const reorderSeats = useTicketStore((s) => s.reorderSeats);
  const moveLineToCourse = useTicketStore((s) => s.moveLineToCourse);
  const moveLineToSeat = useTicketStore((s) => s.moveLineToSeat);
  const renameSeat = useTicketStore((s) => s.renameSeat);
  const seatMode = mode === 'seat';

  const { drinks, groups } = useMemo(() => {
    if (seatMode) {
      return {
        drinks: [] as TicketLine[],
        groups: groupLinesBySeat(seats, lines).map((g) => ({
          id: g.seat.id,
          lines: g.lines,
        })),
      };
    }
    const partitioned = partitionCourseBoardLines(courses, lines);
    return {
      drinks: partitioned.drinks,
      groups: partitioned.groups.map((g) => ({
        id: g.course.id,
        lines: g.lines,
      })),
    };
  }, [seatMode, seats, courses, lines]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const groupIds = useMemo(
    () => groups.map((g) => groupSortableId(g.id)),
    [groups],
  );
  const groupList = seatMode ? seats : courses;
  const activeId = seatMode ? activeSeatId : activeCourseId;

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const activeType = active.data.current?.type;
    const overType = over.data.current?.type;
    const overId = String(over.id);

    if (activeType === 'group') {
      const fromId = parseGroupSortableId(active.id);
      const toId =
        parseGroupSortableId(over.id) ||
        (overType === 'group-drop'
          ? String(over.data.current?.groupId || '')
          : null);
      if (!fromId || !toId || fromId === toId) return;
      const from = groupList.findIndex((g) => g.id === fromId);
      const to = groupList.findIndex((g) => g.id === toId);
      if (seatMode) reorderSeats(from, to);
      else reorderCourses(from, to);
      return;
    }

    if (activeType !== 'line') return;
    const line = lines.find((l) => l.id === event.active.id);
    if (!seatMode && line && isImmediateFireStation(line.station)) return;
    const lineId = String(active.id);
    let toGroupId: string | null = null;
    let toIndex = 0;

    if (overType === 'group' || overType === 'group-drop') {
      toGroupId = String(
        over.data.current?.groupId || parseGroupSortableId(over.id) || '',
      );
      const dest = groups.find((g) => g.id === toGroupId);
      toIndex = dest?.lines.length ?? 0;
    } else {
      const overLine = lines.find((l) => l.id === overId);
      toGroupId = String(
        (seatMode ? overLine?.seatId : overLine?.courseId) ||
          over.data.current?.groupId ||
          '',
      );
      const dest = groups.find((g) => g.id === toGroupId);
      const overIndex = dest?.lines.findIndex((l) => l.id === overId) ?? 0;
      toIndex = Math.max(0, overIndex);
    }
    if (!toGroupId) return;
    if (seatMode) moveLineToSeat(lineId, toGroupId, toIndex);
    else moveLineToCourse(lineId, toGroupId, toIndex);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={DND_MEASURING}
      modifiers={VERTICAL_MODIFIERS}
      autoScroll={DND_AUTO_SCROLL}
      onDragEnd={onDragEnd}
    >
      <div className="space-y-3">
        {drinks.length ? (
          <div className="space-y-1.5">
            <div className="rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface-2)] px-1.5 py-1">
              <div className="text-sm font-semibold py-1 px-1">
                {t('order.drinksSection')}
              </div>
              <div className="text-[11px] font-normal text-gray-400 px-1 pb-1">
                {t('order.drinksSectionHint')}
              </div>
            </div>
            <div className="space-y-2">
              {drinks.map((line) => (
                <div key={line.id}>{renderLine(line)}</div>
              ))}
            </div>
          </div>
        ) : null}
        <SortableContext
          items={groupIds}
          strategy={verticalListSortingStrategy}
        >
          {groups.map((g, i) => {
            const billable = g.lines.filter(
              (l) => isBillableLine(l) && l.staged !== true,
            );
            const fallback = t(seatMode ? 'order.seatN' : 'order.courseN', {
              n: i + 1,
            });
            return (
              <SortableGroup
                key={g.id}
                groupId={g.id}
                title={seatMode ? seatLabel(seats, g.id, fallback) : fallback}
                activeHint={t(
                  seatMode ? 'order.seatActiveHint' : 'order.courseActiveHint',
                )}
                active={activeId === g.id}
                canEdit={canEdit}
                canDrop={canEdit || lines.some((l) => l.staged === true)}
                canRemove={canEdit && groupList.length > 1}
                canRename={seatMode}
                renameLabel={t('order.renameSeat')}
                renamePlaceholder={t('order.renameSeatPlaceholder')}
                onRename={
                  seatMode ? (name) => renameSeat(g.id, name) : undefined
                }
                canFire={
                  !seatMode &&
                  Boolean(onFireCourse) &&
                  linesForCourseFire(lines, g.id).length > 0
                }
                fireDisabled={fireDisabled}
                onFire={onFireCourse ? () => onFireCourse(g.id) : undefined}
                fireLabel={t('order.fireCourse')}
                canPrint={
                  seatMode && Boolean(onPrintSeat) && billable.length > 0
                }
                printDisabled={printDisabled}
                onPrint={onPrintSeat ? () => onPrintSeat(g.id) : undefined}
                printLabel={t('order.printSeatBill')}
                reorderLabel={t(
                  seatMode ? 'order.reorderSeat' : 'order.reorderCourse',
                )}
                removeLabel={t(
                  seatMode ? 'order.removeSeat' : 'order.removeCourse',
                )}
                onActivate={() =>
                  seatMode ? setActiveSeatId(g.id) : setActiveCourseId(g.id)
                }
                onRemove={() =>
                  seatMode ? removeSeat(g.id) : removeCourse(g.id)
                }
              >
                <SortableContext
                  items={g.lines.map((l) => l.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {g.lines.length ? (
                    g.lines.map((line) => (
                      <SortableLine
                        key={line.id}
                        line={line}
                        canEdit={
                          line.voided !== true &&
                          line.paid !== true &&
                          (canEdit || line.staged === true)
                        }
                      >
                        {renderLine(line)}
                      </SortableLine>
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed border-[var(--pos-border-strong)] px-2 py-3 text-xs text-[color:var(--pos-fg-muted)]">
                      {t('order.courseDropHere')}
                    </div>
                  )}
                </SortableContext>
              </SortableGroup>
            );
          })}
        </SortableContext>
        {canEdit || canAddCourse ? (
          <button
            type="button"
            className="w-full rounded-[var(--pos-btn-radius)] border border-dashed border-[var(--pos-border-strong)] py-2 text-sm text-[color:var(--pos-fg)] hover:bg-[var(--pos-hover)]"
            onClick={() => (seatMode ? addSeat() : addCourse())}
          >
            {t(seatMode ? 'order.addSeat' : 'order.addCourse')}
          </button>
        ) : null}
      </div>
    </DndContext>
  );
});
