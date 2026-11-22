// Metadata checks run on startup and daily. Both downloading and restarting require a choice.
import type { MessageBoxOptions } from "electron";
import type { Lang } from "../../../src/core/turn.ts";
import { desktopText } from "./text.ts";
import electronUpdater from "electron-updater";

export const { NsisUpdater } = electronUpdater;
export const appUpdater = () => electronUpdater.autoUpdater;

interface UpdateCheck {
  isUpdateAvailable: boolean;
  updateInfo: { version: string; files?: ReadonlyArray<{ size?: number }> };
}

export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: "error", listener: () => void): unknown;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  checkForUpdates(): Promise<UpdateCheck | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

export interface Prompter {
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>;
}

type Phase = "idle" | "checking" | "prompt" | "downloading" | "installing";

export interface UpdateMenuItem {
  label: string;
  enabled: boolean;
  click: () => Promise<void>;
}

export interface Updates {
  check(manual?: boolean): Promise<void>;
  menuItem(): UpdateMenuItem;
}

export function createUpdates(
  updater: Updater, dialog: Prompter, refreshTray: () => void, quitting: () => boolean,
  language: () => Lang = () => "ko",
): Updates {
  const copy = () => desktopText[language()];
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  let phase: Phase = "idle";
  let progress = 0;
  let readyVersion = "";
  let deferred = "";

  function setPhase(value: Phase) {
    phase = value;
    refreshTray();
  }

  const message = (options: MessageBoxOptions) => dialog.showMessageBox({ title: copy().updateTitle, ...options });
  const reportFailure = () =>
    message({
      type: "error",
      message: copy().updateFailed,
      detail: copy().updateRetry,
    });
  updater.on("error", () => {
    // Check/download errors reject the awaited operation. Install errors arrive as events.
    if (phase === "installing" && !quitting()) {
      setPhase("idle");
      void reportFailure();
    }
  });
  updater.on("download-progress", ({ percent }) => {
    const next = Math.floor(percent);
    if (next !== progress) {
      progress = next;
      refreshTray();
    }
  });

  async function offerInstall() {
    setPhase("prompt");
    const { response } = await message({
      type: "question",
      message: copy().installReady(readyVersion),
      detail: copy().installDetail,
      buttons: [copy().later, copy().installNow],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1 && !quitting()) {
      setPhase("installing");
      updater.quitAndInstall(true, true);
    }
  }

  // A function keeps TypeScript from narrowing phase for the rest of check(); the awaited steps change it.
  const idle = () => phase === "idle";

  async function check(manual = true) {
    if (!idle() || quitting()) return;
    try {
      if (readyVersion !== "") {
        if (manual) await offerInstall();
        return;
      }
      setPhase("checking");
      const result = await updater.checkForUpdates();
      if (quitting()) return;
      if (result?.isUpdateAvailable !== true) {
        if (manual) await message({ message: copy().upToDate });
        return;
      }
      const { version, files } = result.updateInfo;
      if (!manual && deferred === version) return;
      setPhase("prompt");
      const size = files?.[0]?.size;
      const { response } = await message({
        type: "question",
        message: copy().downloadQuestion(version),
        detail: copy().downloadDetail(size !== undefined && size > 0 ? copy().size(Math.ceil(size / 1_000_000)) : ""),
        buttons: [copy().later, copy().download],
        defaultId: 0,
        cancelId: 0,
      });
      if (response !== 1 || quitting()) {
        deferred = version;
        return;
      }
      progress = 0;
      setPhase("downloading");
      await updater.downloadUpdate();
      readyVersion = version;
      if (!quitting()) await offerInstall();
    } catch (error) {
      const visible = manual || phase === "downloading" || phase === "installing";
      if (phase === "installing") setPhase("idle");
      if (!quitting() && visible) {
        if (error instanceof Error && "code" in error && error.code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS") {
          await message({ message: copy().noReleases });
        } else await reportFailure();
      }
    } finally {
      if (phase !== "installing") setPhase("idle");
    }
  }

  function menuItem(): UpdateMenuItem {
    const status: Partial<Record<Phase, string>> = {
      checking: copy().checking,
      downloading: copy().downloading(progress),
      installing: copy().installing,
    };
    return {
      label: status[phase] ?? (readyVersion !== "" ? copy().installVersion(readyVersion) : copy().checkUpdates),
      enabled: phase === "idle",
      click: () => check(),
    };
  }
  return { check, menuItem };
}
