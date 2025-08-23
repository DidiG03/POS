export const api = {
  auth: {
    async loginWithPin(_pin: string, _userId?: number) {
      return { id: 1, displayName: 'Demo User', role: 'STAFF' };
    },
    async syncStaffFromApi() {},
    async listUsers() {
      return [] as any[];
    },
    async login() {},
    async logout() {},
  },
  shifts: {
    async getOpen(_userId: number) {
      return null;
    },
    async listOpen() {
      return [] as number[];
    },
    async clockIn(_userId: number) {},
    async clockOut(_userId: number) {},
  },
  notifications: {
    async list(_userId: number, _onlyUnread?: boolean) {
      return [] as any[];
    },
    async markAllRead(_userId: number) {},
  },
  admin: {
    async listNotifications(_opts: any) {
      return [] as any[];
    },
    async markAllNotificationsRead() {},
    async getOverview() {
      return {} as any;
    },
    async listShifts() {
      return [] as any[];
    },
    async getTopSellingToday() {
      return [] as any[];
    },
    async getSalesTrends(_opts: any) {
      return [] as any[];
    },
    async listTicketsByUser(_userId: number, _range: any) {
      return [] as any[];
    },
    async listTicketCounts(_range: any) {
      return [] as any[];
    },
    async openWindow() {},
  },
  menu: {
    async listCategoriesWithItems() {
      return [] as any[];
    },
    async syncFromUrl(_opts: any) {},
  },
  tickets: {
    async voidTicket(_opts: any) {},
    async log(_opts: any) {},
    async getLatestForTable(_area: string, _label: string) {
      return null;
    },
    async voidItem(_opts: any) {},
  },
  covers: {
    async getLast(_area: string, _label: string) {
      return 0;
    },
    async save(_area: string, _label: string, _num: number) {},
  },
  settings: {
    async get() {
      return {} as any;
    },
    async update(_opts: any) {},
    async testPrint() {},
  },
  tables: {
    async setOpen(_area: string, _label: string, _open: boolean) {},
  },
  layout: {
    async get(_userId: number, _area: string) {
      return null;
    },
    async save(_userId: number, _area: string, _nodes: any) {},
  },
};
