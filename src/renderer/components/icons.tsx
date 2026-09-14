import type { ComponentType } from 'react';
import {
  Armchair,
  ArrowLeft,
  ArrowRight,
  Banknote,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  Calendar,
  Check,
  ChefHat,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  ClipboardList,
  Clock,
  CloudDownload,
  Copy,
  CreditCard,
  Download,
  Flame,
  GripVertical,
  Heart,
  Info,
  Layers,
  LayoutGrid,
  List,
  ListFilter,
  Lock,
  LogOut,
  Merge,
  Minus,
  Monitor,
  MoreHorizontal,
  MoreVertical,
  MousePointer2,
  Package,
  Pencil,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  Search,
  Settings,
  ShoppingCart,
  SlidersHorizontal,
  Split,
  Ticket,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Upload,
  User,
  Users,
  Utensils,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';

type LucideIcon = ComponentType<{
  className?: string;
  strokeWidth?: number;
  'aria-hidden'?: boolean | 'true';
}>;

/**
 * Lucide icons, same names the app already imports. One stroke weight so
 * waiter, reservations, and admin stay optically consistent.
 */
type P = { className?: string };

function glyph(Icon: LucideIcon) {
  return function PosIcon({ className }: P) {
    return (
      <Icon
        className={className ?? 'pos-icon'}
        strokeWidth={1.75}
        aria-hidden
      />
    );
  };
}

export const IconTables = glyph(LayoutGrid);
export const IconCart = glyph(ShoppingCart);
export const IconReports = glyph(BarChart3);
export const IconOrders = glyph(ClipboardList);
export const IconClock = glyph(Clock);
export const IconLogout = glyph(LogOut);
export const IconBell = glyph(Bell);
export const IconClose = glyph(X);
export const IconSearch = glyph(Search);
export const IconCopy = glyph(Copy);
export const IconPlus = glyph(Plus);
export const IconMinus = glyph(Minus);
export const IconCheck = glyph(Check);
export const IconTrash = glyph(Trash2);
export const IconEdit = glyph(Pencil);
export const IconSettings = glyph(Settings);
export const IconUsers = glyph(Users);
export const IconUser = glyph(User);
export const IconPrinter = glyph(Printer);
export const IconChart = glyph(TrendingUp);
export const IconList = glyph(List);
export const IconGrid = glyph(LayoutGrid);
export const IconRefresh = glyph(RefreshCw);
export const IconCalendar = glyph(Calendar);
export const IconFilter = glyph(ListFilter);
export const IconChevronLeft = glyph(ChevronLeft);
export const IconChevronRight = glyph(ChevronRight);
export const IconChevronDown = glyph(ChevronDown);
export const IconChevronUp = glyph(ChevronUp);
export const IconArrowLeft = glyph(ArrowLeft);
export const IconAlert = glyph(TriangleAlert);
export const IconInfo = glyph(Info);
export const IconCard = glyph(CreditCard);
export const IconCash = glyph(Banknote);
export const IconBox = glyph(Package);
export const IconTicket = glyph(Ticket);
export const IconMenuBook = glyph(BookOpen);
export const IconKitchen = glyph(ChefHat);
export const IconSplit = glyph(Split);
export const IconMerge = glyph(Merge);
export const IconGrip = glyph(GripVertical);
export const IconMore = glyph(MoreHorizontal);
export const IconMoreVertical = glyph(MoreVertical);
export const IconKebab = IconMoreVertical;
export const IconLock = glyph(Lock);
export const IconWifiOff = glyph(WifiOff);
export const IconWifi = glyph(Wifi);
export const IconDownload = glyph(Download);
export const IconUpload = glyph(Upload);
export const IconMoveRight = glyph(ArrowRight);
export const IconOrderDefault = glyph(MousePointer2);
export const IconOrderCourse = glyph(Layers);
export const IconOrderSeat = glyph(Armchair);
export const IconReceipt = glyph(Receipt);
export const IconCovers = glyph(Utensils);
export const IconMoney = glyph(CircleDollarSign);
export const IconMonitor = glyph(Monitor);
export const IconSliders = glyph(SlidersHorizontal);
export const IconCloudDown = glyph(CloudDownload);
export const IconBuilding = glyph(Building2);
export const IconFlame = glyph(Flame);
export const IconHeart = glyph(Heart);
