import { create } from 'zustand';
import type { LicenseEdition } from '@shared/ipc';
import {
  editionHasKds,
  editionHasReservations,
  editionHasTables,
  normalizeLicenseEdition,
} from '@shared/editionCapabilities';

type LicenseCapabilitiesState = {
  edition?: LicenseEdition;
  hydrated: boolean;
  hasReservations: boolean;
  hasTables: boolean;
  hasKds: boolean;
  setEdition: (raw?: string | null) => void;
};

export const useLicenseCapabilities = create<LicenseCapabilitiesState>(
  (set) => ({
    hydrated: false,
    hasReservations: true,
    hasTables: true,
    hasKds: true,
    setEdition: (raw) => {
      const edition = normalizeLicenseEdition(raw);
      set({
        edition,
        hydrated: true,
        hasReservations: editionHasReservations(edition),
        hasTables: editionHasTables(edition),
        hasKds: editionHasKds(edition),
      });
    },
  }),
);
