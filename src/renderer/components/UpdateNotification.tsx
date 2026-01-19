import React, { useEffect, useState } from 'react';
import type { UpdateStatusDTO } from '@shared/ipc';

interface UpdateEvent {
  event: string;
  data?: any;
}

export function UpdateNotification() {
  const [status, setStatus] = useState<UpdateStatusDTO | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Load initial status
    loadStatus();

    // Listen for updater events
    const handleEvent = (e: CustomEvent<UpdateEvent>) => {
      const { event, data } = e.detail;
      switch (event) {
        case 'checking':
          setIsChecking(true);
          setError(null);
          break;
        case 'update-available':
          setIsChecking(false);
          setError(null);
          loadStatus();
          break;
        case 'update-not-available':
          setIsChecking(false);
          loadStatus();
          break;
        case 'download-progress':
          setDownloadProgress(data?.percent || null);
          break;
        case 'update-downloaded':
          setDownloadProgress(null);
          loadStatus();
          break;
        case 'error':
          setIsChecking(false);
          setError(data?.message || 'Update error');
          break;
      }
    };

    window.addEventListener('updater:event', handleEvent as EventListener);
    return () => window.removeEventListener('updater:event', handleEvent as EventListener);
  }, []);

  const loadStatus = async () => {
    try {
      const s = await window.api.updater.getUpdateStatus();
      setStatus(s);
    } catch (e) {
      // Ignore errors (updater might not be available)
    }
  };

  const handleCheckForUpdates = async () => {
    setIsChecking(true);
    setError(null);
    try {
      const result = await window.api.updater.checkForUpdates();
      if (result.error) {
        setError(result.error);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to check for updates');
    } finally {
      setIsChecking(false);
    }
  };

  const handleDownload = async () => {
    setError(null);
    try {
      const result = await window.api.updater.downloadUpdate();
      if (result.error) {
        setError(result.error);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to download update');
    }
  };

  const handleInstall = async () => {
    if (!confirm('The app will restart to install the update. Continue?')) {
      return;
    }
    try {
      await window.api.updater.installUpdate();
    } catch (e: any) {
      setError(e?.message || 'Failed to install update');
    }
  };

  // Don't show anything if no update and not checking
  if (!status && !isChecking) {
    return null;
  }

  // Show update available notification
  if (status?.hasUpdate && !status.downloaded) {
    return (
      <div className="fixed bottom-4 right-4 bg-blue-600 text-white rounded-lg shadow-lg p-4 max-w-md z-50">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h3 className="font-semibold mb-1">Update Available</h3>
            <p className="text-sm text-blue-100 mb-2">
              Version {status.updateInfo?.version} is available
            </p>
            {status.updateInfo?.releaseNotes && (
              <details className="text-xs text-blue-100 mb-2">
                <summary className="cursor-pointer hover:text-white">Release notes</summary>
                <div className="mt-2 whitespace-pre-wrap">{status.updateInfo.releaseNotes}</div>
              </details>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleDownload}
                className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 rounded text-sm font-medium"
              >
                Download
              </button>
              <button
                onClick={() => setStatus(null)}
                className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 rounded text-sm"
              >
                Later
              </button>
            </div>
          </div>
        </div>
        {error && (
          <div className="mt-2 text-xs text-red-200 bg-red-900/30 rounded p-2">{error}</div>
        )}
      </div>
    );
  }

  // Show download progress
  if (downloadProgress !== null) {
    return (
      <div className="fixed bottom-4 right-4 bg-blue-600 text-white rounded-lg shadow-lg p-4 max-w-md z-50">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <h3 className="font-semibold mb-1">Downloading Update</h3>
            <div className="w-full bg-blue-700 rounded-full h-2 mb-2">
              <div
                className="bg-blue-300 h-2 rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
            <p className="text-xs text-blue-100">{Math.round(downloadProgress)}%</p>
          </div>
        </div>
      </div>
    );
  }

  // Show update downloaded notification
  if (status?.downloaded) {
    return (
      <div className="fixed bottom-4 right-4 bg-green-600 text-white rounded-lg shadow-lg p-4 max-w-md z-50">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h3 className="font-semibold mb-1">Update Ready to Install</h3>
            <p className="text-sm text-green-100 mb-3">
              Version {status.updateInfo?.version} has been downloaded. The app will restart to install.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleInstall}
                className="px-4 py-2 bg-green-700 hover:bg-green-800 rounded font-medium"
              >
                Install & Restart
              </button>
              <button
                onClick={() => setStatus(null)}
                className="px-4 py-2 bg-green-500 hover:bg-green-600 rounded"
              >
                Later
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show checking indicator (optional, can be hidden)
  if (isChecking) {
    return (
      <div className="fixed bottom-4 right-4 bg-gray-700 text-white rounded-lg shadow-lg p-3 max-w-sm z-50">
        <div className="flex items-center gap-2">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
          <span className="text-sm">Checking for updates...</span>
        </div>
      </div>
    );
  }

  return null;
}
