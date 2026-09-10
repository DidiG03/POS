/**
 * First-run / re-pair screen for the standalone "OneTap KDS" app.
 *
 * Scan the Wi-Fi for POS tills, then tap one (name + IP) to connect.
 */
import { useTranslation } from 'react-i18next';
import { BrandMark } from '../../components/BrandMark';
import { PosServerScanPanel } from '../components/PosServerScan';

export default function KdsSetupPage() {
  const { t } = useTranslation();

  return (
    <div className="min-h-dvh flex items-center justify-center pos-app pos-app--auth text-gray-100 px-6">
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
