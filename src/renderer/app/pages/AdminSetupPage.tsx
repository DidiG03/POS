/**
 * First-run / re-pair screen for the standalone "OneTap Admin" app.
 *
 * Scan the Wi-Fi for POS tills, then tap one to connect.
 */
import { useTranslation } from 'react-i18next';
import { BrandMark } from '../../components/BrandMark';
import { DocumentMeta } from '../../components/DocumentMeta';
import { PosServerScanPanel } from '../components/PosServerScan';

export default function AdminSetupPage() {
  const { t } = useTranslation();

  return (
    <div className="min-h-dvh flex items-center justify-center pos-app pos-app--auth text-gray-100 px-6">
      <DocumentMeta title={t('adminLayout.panelTitle')} />
      <div className="flex w-full max-w-md flex-col items-center gap-5">
        <BrandMark size="lg" />
        <div className="text-sm text-gray-300 text-center">
          {t('boot.cannotReachDetail')}
        </div>
        <PosServerScanPanel />
      </div>
    </div>
  );
}
