// Metadata checks run on startup and daily. Both downloading and restarting require a choice.
function createUpdates(updater, dialog, refreshTray, quitting) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  let phase = 'idle';
  let progress = 0;
  let readyVersion = '';
  let deferred = '';

  function setPhase(value) {
    phase = value;
    refreshTray();
  }

  const message = (options) => dialog.showMessageBox({ title: '청음 업데이트', ...options });
  const reportFailure = () => message({
    type: 'error', message: '업데이트를 완료할 수 없어요.',
    detail: '현재 버전은 계속 사용할 수 있어요. 인터넷 연결을 확인하고 트레이에서 다시 시도해 주세요.',
  });
  updater.on('error', () => {
    // Check/download errors reject the awaited operation. Install errors arrive as events.
    if (phase === 'installing' && !quitting()) {
      setPhase('idle');
      void reportFailure();
    }
  });
  updater.on('download-progress', ({ percent }) => {
    const next = Math.floor(percent);
    if (next !== progress) {
      progress = next;
      refreshTray();
    }
  });

  async function offerInstall() {
    setPhase('prompt');
    const { response } = await message({
      type: 'question', message: `청음 ${readyVersion} 설치 준비가 끝났어요.`,
      detail: '지금 설치하면 열린 청음 작업을 종료하고 앱을 다시 시작합니다.',
      buttons: ['나중에', '지금 설치하고 다시 시작'], defaultId: 0, cancelId: 0,
    });
    if (response === 1 && !quitting()) {
      setPhase('installing');
      updater.quitAndInstall(true, true);
    }
  }

  async function check(manual = true) {
    if (phase !== 'idle' || quitting()) return;
    try {
      if (readyVersion) {
        if (manual) await offerInstall();
        return;
      }
      setPhase('checking');
      const result = await updater.checkForUpdates();
      if (quitting()) return;
      if (!result?.isUpdateAvailable) {
        if (manual) await message({ message: '사용할 수 있는 새 버전이 없어요.' });
        return;
      }
      const { version, files } = result.updateInfo;
      if (!manual && deferred === version) return;
      setPhase('prompt');
      const size = files?.[0]?.size;
      const { response } = await message({
        type: 'question', message: `새 버전 청음 ${version}을 다운로드할까요?`,
        detail: `GitHub Releases에서 받습니다${size ? ` (약 ${Math.ceil(size / 1_000_000)} MB)` : ''}. 받은 뒤 설치 시점을 선택할 수 있어요.`,
        buttons: ['나중에', '다운로드'], defaultId: 0, cancelId: 0,
      });
      if (response !== 1 || quitting()) {
        deferred = version;
        return;
      }
      progress = 0;
      setPhase('downloading');
      await updater.downloadUpdate();
      readyVersion = version;
      if (!quitting()) await offerInstall();
    } catch (error) {
      const visible = manual || phase === 'downloading' || phase === 'installing';
      if (phase === 'installing') setPhase('idle');
      if (!quitting() && visible) {
        if (error.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') await message({ message: '아직 공개된 릴리스가 없어요.' });
        else await reportFailure();
      }
    } finally {
      if (phase !== 'installing') setPhase('idle');
    }
  }

  function menuItem() {
    const status = {
      checking: '업데이트 확인 중…', downloading: `업데이트 다운로드 중 (${progress}%)`, installing: '업데이트 설치 중…',
    };
    return {
      label: status[phase] || (readyVersion ? `청음 ${readyVersion} 설치…` : '업데이트 확인…'),
      enabled: phase === 'idle', click: () => check(),
    };
  }
  return { check, menuItem };
}

module.exports = { createUpdates };
