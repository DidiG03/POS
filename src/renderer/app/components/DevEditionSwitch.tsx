import { Segmented } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import { useLicenseCapabilities } from '../../stores/licenseCapabilities';
import type { LicenseEdition } from '@shared/ipc';

export function DevEditionSwitch({ allowed }: { allowed: boolean }) {
  const { t } = useTranslation();
  const edition = useLicenseCapabilities((s) => s.edition);
  const value: LicenseEdition = edition === 'STORE' ? 'STORE' : 'RESTAURANT';
  if (!allowed) return null;
  if (typeof window.api.license.setDevEdition !== 'function') return null;

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-amber-200/80">
        {t('login.devEdition')}
      </div>
      <Segmented
        block
        size="sm"
        ariaLabel={t('login.devEdition')}
        value={value}
        onChange={(next) => {
          void window.api.license
            .setDevEdition?.({ edition: next })
            .then((r) => {
              if (r?.ok && r.edition) {
                useLicenseCapabilities.getState().setEdition(r.edition);
              }
            });
        }}
        options={[
          { value: 'RESTAURANT', label: t('login.devRestaurant') },
          { value: 'STORE', label: t('login.devStore') },
        ]}
      />
    </div>
  );
}
