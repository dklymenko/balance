import {
  app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, safeStorage,
  protocol, session, shell, systemPreferences,
} from "electron";
import path from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { scrapeAmazonOrders } from "./scraper";
import { parseScrapeWindow } from "./scrapeWindow";
import { AMAZON_PARTITION, CLOUD_AUTH_PARTITION, LOCAL_PARTITION } from "./partitions";
import {
  cloudAvailable, cloudEndpoint, readConfig, reconcileConfigWithSyncMode, writeConfig,
  type AppConfig, type AppMode,
} from "./config";
import { formatLastBackup, lastBackup, purgePlaintextBackups } from "./backups";
import { resolvePackageRoot, resolveServerEntry, startLocalServer, type LocalServer } from "./localServer";
import { createVerifier, verifyPassword } from "./passlock";
import { isLockEnabled, readLock, removeLock, writeLock, type LockCodec } from "./lockStore";
import { canUseTouchIdForProfile, recoverLockVerifierFromPassphrase } from "./lockRecovery";
import {
  addPassphraseWrap, backupKeyFile, beginPassphraseRotation, createKeyFile, dropPassphraseWrap,
  finishPassphraseRotation, hasKeyFile, readKeyFile, removeKeyFile, restoreKeyFileFromBackup,
  unwrapWithPassphrase, unwrapWithSafeStorage,
} from "./keyStore";
import {
  canDiscardEncryptionKeyAfterFailure, encryptDbInPlace, isPlaintextSqlite,
  recoverInterruptedEncryption, type SqliteCtor,
} from "./rekey";
import { checkForUpdate, UPDATE_REPO } from "./updater";
import {
  desktopAuthCode,
  externalHttpsUrl,
  isAllowedShellNavigation,
  loadUrlWithRetry,
} from "./navigation";
import { secureStorageCodec, unwrapSecret, wrapSecret } from "./secureStorage";
import { shouldRestoreMainWindow } from "./windowLifecycle";

// One app, two modes (userData/config.json decides). Both boot the embedded
// server in a utilityProcess against the local database. The file is plaintext
// until the user opts into encryption; cloud mode adds background sync.

const SHELL_SCHEME = "balance-shell";

// The chooser and App Lock are tiny packaged pages. Serve them through a
// private, standard URL scheme so renderers never need file:// privileges.
// This must be registered before app.ready; the handler itself is installed
// during boot after Electron is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: SHELL_SCHEME, privileges: { standard: true, secure: true } },
]);

// Menu and dialog labels ("About Balance", "Quit Balance"). The packaged
// CFBundleName is left aligned with Electron's helper-bundle names; changing
// that plist value independently prevents packaged apps from launching.
app.setName("Balance");

// The profile directory is pinned by id, not display name -- app.setName and
// productName changes must never orphan existing data.
app.setPath("userData", path.join(app.getPath("appData"), "balance-desktop"));

// Dev/test hook: point the whole profile (config, DB, backups) at a scratch
// dir so packaged builds can be exercised against a fresh machine profile.
if (process.env.BALANCE_USER_DATA) {
  app.setPath("userData", process.env.BALANCE_USER_DATA);
}

let config: AppConfig | null = null;
let localServer: LocalServer | null = null;
let appUrl = "";    // what the main window loads
let appOrigin = ""; // the only web origin trusted for navigation + IPC
const localApiToken = randomBytes(32).toString("hex");

// See cloudAvailable() in config.ts for why cloud is gated and how to turn it
// back on. Bound here so call sites read the live config.
const cloudEnabled = (): boolean => cloudAvailable(process.env, config);

const saasUrl = (): string => cloudEndpoint(process.env, config) ?? "";
const saasOrigin = (): string => {
  const endpoint = saasUrl();
  return endpoint ? new URL(endpoint).origin : "";
};
const configPath = (): string => path.join(app.getPath("userData"), "config.json");
const dbPath = (): string => path.join(app.getPath("userData"), "balance.db");
const backupDir = (): string => path.join(app.getPath("userData"), "backups");

// Strip the Electron and app tokens from the default UA so non-shell
// requests (e.g. the Amazon scrape window) look like plain Chrome. The app
// token is "balance-desktop/x" in dev and "Balance-Desktop/x" when packaged.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|balance[- ]desktop)\/\S+/gi, "");

let mainWindow: BrowserWindow | null = null;
let signInWindow: BrowserWindow | null = null;
let lockWindow: BrowserWindow | null = null;
let uiLocked = false;
// Resolved database key for this session (needed to re-wrap when App Lock is
// enabled/changed) and the last successful unlock password (transient; lets
// boot unwrap the passphrase wrap when the Keychain wrap is unavailable).
let sessionDbKey: string | null = null;
let lastUnlockPassword: string | null = null;

// Two instances would run two embedded servers against the same SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// The shell may navigate to the active app origin, the configured sync origin,
// and Google's sign-in pages during OAuth. Other HTTPS links open in the
// system browser.
function applyNavigationRules(win: BrowserWindow, allowSyncAuth = false): void {
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (!isAllowedShellNavigation(url, appOrigin, saasOrigin(), allowSyncAuth)) {
      event.preventDefault();
      const external = externalHttpsUrl(url);
      if (external) void shell.openExternal(external);
    }
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);
  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalHttpsUrl(url);
    if (external && !isAllowedShellNavigation(url, appOrigin, saasOrigin(), allowSyncAuth)) void shell.openExternal(external);
    return { action: "deny" };
  });
}

function createMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    title: "Balance",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      partition: LOCAL_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame) {
      console.error(`[shell] main-frame load failed (${errorCode} ${errorDescription}): ${validatedUrl}`);
    }
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[shell] preload failed (${preloadPath}):`, error);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("[shell] renderer process exited:", details);
  });

  applyNavigationRules(win);

  void loadUrlWithRetry(() => win.loadURL(appUrl)).catch((err) => {
    console.error("[shell] could not load the local interface:", err);
    dialog.showErrorBox(
      "Balance could not load its interface",
      `${err instanceof Error ? err.message : String(err)}\n\nQuit and reopen Balance. Your data file is untouched.`,
    );
    app.quit();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
}

function authenticateLocalRequests(target: Electron.Session, origin: string, token: string): void {
  target.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Authorization: `Bearer ${token}`,
        },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// App lock (financial data behind a password / Touch ID)
//
// App Lock adds a password gate. When database encryption is enabled, it also
// provides a portable password-wrapped copy of the database key; its verifier
// is sealed with safeStorage. At launch the lock gates boot entirely.

type LockMode = "unlock" | "setup" | "change" | "disable";
let lockMode: LockMode = "unlock";
let lockQuitOnClose = false;
let lockResolve: ((ok: boolean) => void) | null = null;

const userDataDir = (): string => app.getPath("userData");

function lockCodec(): LockCodec {
  return secureStorageCodec(safeStorage);
}

function canTouchId(): boolean {
  return process.platform === "darwin" && systemPreferences.canPromptTouchID();
}

function installShellProtocol(): void {
  const pages = new Map([
    ["/chooser.html", "chooser.html"],
    ["/lock.html", "lock.html"],
  ]);
  protocol.handle(SHELL_SCHEME, (request) => {
    const url = new URL(request.url);
    const file = url.hostname === "app" && request.method === "GET"
      ? pages.get(url.pathname)
      : undefined;
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(readFileSync(path.join(__dirname, file))), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

// Shows the lock window in the given mode; resolves true when the operation
// succeeded (unlocked / password set / changed / removed), false when the
// user backed out.
function showLockWindow(mode: LockMode, quitOnClose = false): Promise<boolean> {
  if (lockWindow) {
    lockWindow.focus();
    return Promise.resolve(false);
  }
  lockMode = mode;
  lockQuitOnClose = quitOnClose;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (!settled) { settled = true; resolve(ok); }
    };
    lockResolve = settle;
    lockWindow = new BrowserWindow({
      width: 420,
      height: 400,
      resizable: false,
      minimizable: false,
      fullscreenable: false,
      title: "Balance",
      webPreferences: {
        preload: path.join(__dirname, "lockPreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: !app.isPackaged,
      },
    });
    lockWindow.on("closed", () => {
      lockWindow = null;
      lockResolve = null;
      settle(false);
    });
    void lockWindow.loadURL(`${SHELL_SCHEME}://app/lock.html`);
  });
}

function assertLockSender(event: Electron.IpcMainInvokeEvent): void {
  if (!lockWindow || event.sender !== lockWindow.webContents) {
    throw new Error("Unauthorized sender");
  }
}

function finishLockWindow(ok: boolean): void {
  const resolve = lockResolve;
  lockResolve = null; // detach before close so the closed handler can't double-settle
  lockWindow?.close();
  lockWindow = null;
  resolve?.(ok);
}

ipcMain.handle("lock:info", (event) => {
  assertLockSender(event);
  return { mode: lockMode, touchId: lockMode === "unlock" && canTouchId(), quitOnClose: lockQuitOnClose };
});

ipcMain.handle("lock:submit", (event, raw: unknown) => {
  assertLockSender(event);
  const { current, next } = (typeof raw === "object" && raw !== null ? raw : {}) as
    { current?: unknown; next?: unknown };
  const currentPw = typeof current === "string" ? current : "";
  const nextPw = typeof next === "string" ? next : "";

  if (lockMode === "setup") {
    if (nextPw.length < 12) return { ok: false, error: "Password must be at least 12 characters." };
    try {
      // Write the portable key wrap before enabling the gate. A crash can then
      // leave only an extra recovery method, never a lock whose password cannot
      // recover the encrypted ledger on another Mac.
      if (sessionDbKey) addPassphraseWrap(userDataDir(), sessionDbKey, nextPw);
      writeLock(userDataDir(), createVerifier(nextPw), lockCodec());
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (sessionDbKey) {
      try { backupKeyFile(userDataDir()); }
      catch (err) { console.error("[shell] could not refresh the wrapped-key backup:", err); }
    }
    finishLockWindow(true);
    return { ok: true };
  }

  const codec = lockCodec();
  const verifier = readLock(userDataDir(), codec);
  if (!verifier) {
    if (lockMode === "unlock" && recoverLockVerifierFromPassphrase(userDataDir(), currentPw, codec)) {
      lastUnlockPassword = currentPw;
      finishLockWindow(true);
      return { ok: true };
    }
    // Unreadable lock file (e.g. restored onto a different machine where the
    // Keychain key does not exist). An encrypted profile with an App Lock
    // passphrase recovers above; otherwise only manual reset is possible.
    return { ok: false, error: "The lock file is unreadable on this Mac. Enter the App Lock password used for this profile, or remove lock.dat from the app data folder to reset a lock that has no encrypted ledger." };
  }
  if (!verifyPassword(currentPw, verifier)) {
    return { ok: false, error: "Incorrect password." };
  }

  if (lockMode === "change") {
    if (nextPw.length < 12) return { ok: false, error: "Password must be at least 12 characters." };
    try {
      // The in-flight key file accepts both passwords. Once lock.dat commits,
      // only the new password is needed; cleanup of the temporary old wrap is
      // safe to retry after any crash.
      if (sessionDbKey) beginPassphraseRotation(userDataDir(), sessionDbKey, currentPw, nextPw);
      writeLock(userDataDir(), createVerifier(nextPw), lockCodec());
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (sessionDbKey) {
      try {
        finishPassphraseRotation(userDataDir());
        backupKeyFile(userDataDir());
      } catch (err) {
        // The new verifier and primary new-password wrap are already valid.
        // Retaining the old wrap temporarily is recoverable and safer than
        // reporting a failed change that actually committed.
        console.error("[shell] could not finalize App Lock key rotation:", err);
      }
    }
  } else if (lockMode === "disable") {
    removeLock(userDataDir());
    dropPassphraseWrap(userDataDir());
    if (sessionDbKey) backupKeyFile(userDataDir());
  } else if (lockMode === "unlock") {
    // Transient: boot uses it to unwrap the passphrase wrap when the
    // Keychain wrap is unavailable (profile restored on another machine).
    lastUnlockPassword = currentPw;
  }
  finishLockWindow(true);
  return { ok: true };
});

ipcMain.handle("lock:touchid", async (event) => {
  assertLockSender(event);
  if (lockMode !== "unlock" || !canTouchId()) throw new Error("Touch ID unavailable");
  await systemPreferences.promptTouchID("unlock Balance");
  const encryptedLedger = existsSync(dbPath()) && !isPlaintextSqlite(dbPath());
  if (!canUseTouchIdForProfile(userDataDir(), lockCodec(), encryptedLedger)) {
    throw new Error("Use the App Lock password to recover this profile on this Mac");
  }
  finishLockWindow(true);
});

ipcMain.handle("lock:cancel", (event) => {
  assertLockSender(event);
  if (lockQuitOnClose) {
    app.quit();
    return;
  }
  finishLockWindow(false);
});

// Relock: tear the app windows down and require an unlock to continue. The
// embedded server keeps running (the OS user already has file access; this
// gate is about the UI, see the header comment).
function relock(): void {
  if (!isLockEnabled(userDataDir()) || uiLocked || !appUrl) return;
  uiLocked = true;
  for (const win of [mainWindow, signInWindow]) win?.close();
  buildMenu();
  void showLockWindow("unlock", false).then((ok) => {
    if (ok) {
      uiLocked = false;
      buildMenu();
      if (shouldRestoreMainWindow(mainWindow)) createMainWindow();
    }
    // Backed out: stay locked and windowless; the dock icon (activate)
    // brings the lock screen back.
  });
}

// The web Settings page (Security section) drives the lock through the
// desktop bridge. Same trust boundary as amazon:scrape: only the app loaded
// in our own shell may call these -- and password entry itself still happens
// exclusively in the native lock window.
function assertAppSender(event: Electron.IpcMainInvokeEvent): void {
  if (!event.senderFrame || new URL(event.senderFrame.url).origin !== appOrigin) {
    throw new Error("Unauthorized sender");
  }
}

function lockStatus(): { enabled: boolean; touchId: boolean } {
  return { enabled: isLockEnabled(userDataDir()), touchId: canTouchId() };
}

ipcMain.handle("applock:status", (event) => {
  assertAppSender(event);
  return lockStatus();
});

ipcMain.handle("applock:setup", async (event) => {
  assertAppSender(event);
  if (!isLockEnabled(userDataDir())) await showLockWindow("setup", false);
  buildMenu();
  return lockStatus();
});

ipcMain.handle("applock:change", async (event) => {
  assertAppSender(event);
  if (isLockEnabled(userDataDir())) await showLockWindow("change", false);
  return lockStatus();
});

ipcMain.handle("applock:disable", async (event) => {
  assertAppSender(event);
  if (isLockEnabled(userDataDir())) await showLockWindow("disable", false);
  buildMenu();
  return lockStatus();
});

ipcMain.handle("applock:lock-now", (event) => {
  assertAppSender(event);
  if (isLockEnabled(userDataDir())) setTimeout(() => relock(), 50); // let the invoke resolve first
  return lockStatus();
});

ipcMain.handle("cloud:status", (event) => {
  assertAppSender(event);
  return {
    mode: config?.mode === "cloud" ? "cloud" : "local",
    connecting: config?.cloudTransition === "connecting",
  };
});

// ---------------------------------------------------------------------------
// Database key resolution (see keyStore.ts for the wrap model)

function resolveDbKey(): { key: string | null; fatal?: string } {
  const dir = userDataDir();
  const encryptedAlready = existsSync(dbPath()) && !isPlaintextSqlite(dbPath());
  let file = hasKeyFile(dir) ? readKeyFile(dir) : null;

  // A validated wrapped-key copy lives beside the encrypted snapshots. Use it
  // automatically when the primary was lost or truncated.
  if (!file && restoreKeyFileFromBackup(dir)) {
    file = readKeyFile(dir);
  }

  if (!file) {
    if (encryptedAlready) {
      return { key: null, fatal: `The database key file is missing or corrupt (${dir}/dbkey.json), and no valid key backup was found. Restore the database and dbkey.json together from a matching backup.` };
    }
    // Encryption is opt-in. A profile with no key file has either not been
    // offered encryption yet or has declined it, so run unencrypted rather
    // than minting a key at startup -- that is what used to raise a Keychain
    // prompt before the user had been told anything about it. The offer is
    // made after onboarding, and Settings can turn it on at any time.
    //
    // Note the early return: safeStorage is deliberately NOT consulted above.
    // On macOS even asking whether it is available reaches into the Keychain
    // and can raise a permission prompt, which is the thing this path exists
    // to avoid. This database-key path never touches the Keychain until there
    // is a key to unwrap; App Lock and private Cloud sign-in are separate,
    // explicit Keychain-backed features.
    return { key: null };
  }

  const codec = lockCodec();

  // Normal path: Keychain unwrap. Fallback: the App Lock password typed at
  // the boot gate unwraps the passphrase wrap (profile moved to a new Mac).
  const viaSafe = unwrapWithSafeStorage(file, codec);
  if (viaSafe) return { key: viaSafe };
  const viaPass = lastUnlockPassword ? unwrapWithPassphrase(file, lastUnlockPassword) : null;
  if (viaPass) return { key: viaPass };

  if (!encryptedAlready) {
    // A key exists but nothing opens it, and the data is still plaintext, so
    // an opt-in was interrupted before it encrypted anything. Drop the unusable
    // key and stay unencrypted; the user can opt in again from Settings, which
    // mints a fresh key. Encrypting into a lock nobody holds would destroy the
    // ledger.
    removeKeyFile(dir);
    return { key: null };
  }
  return {
    key: null,
    fatal: file.pass
      ? "Neither this Mac's Keychain nor the App Lock password can unlock the database key. If the App Lock password was recently changed elsewhere, use it; otherwise restore the database and dbkey.json together from a matching backup."
      : "This Mac's Keychain cannot unlock the database key (profile restored from another machine?). Restore the database and dbkey.json together from a matching backup, or reconnect to Balance Cloud to re-download your data.",
  };
}

// ---------------------------------------------------------------------------
// At-rest encryption (opt-in)
//
// A new profile runs unencrypted so that nothing touches the Keychain before
// the user has been told what it is for. The app offers encryption once
// onboarding is done, and Settings can turn it on later. Turning it on is the
// only path that mints a key, so the macOS permission prompt always arrives
// immediately after an explicit click.
//
// The database file is the authority on whether the ledger is encrypted
// (isPlaintextSqlite); config only records that the offer was declined.

export interface EncryptionStatus {
  encrypted: boolean;
  declined: boolean;
}

// Deliberately does not probe safeStorage. On macOS, even asking whether it is
// available reaches into the Keychain and can raise a permission prompt -- and
// this handler runs as soon as the app's UI loads, so probing here would put
// that prompt right back at startup. Whether secure storage actually works is
// discovered when the user opts in, and reported as an error from there.
function encryptionStatus(): EncryptionStatus {
  return {
    encrypted: sessionDbKey !== null,
    declined: config?.encryptionDeclined === true,
  };
}

type EnableEncryptionResult = { ok: boolean; error?: string };
let encryptionInFlight: Promise<EnableEncryptionResult> | null = null;

async function performEnableEncryption(): Promise<EnableEncryptionResult> {
  if (sessionDbKey) return { ok: true };
  if (!localServer) return { ok: false, error: "The local server is not running." };

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Encrypt My Ledger", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: "Encrypt this Mac's ledger?",
    detail:
      "Balance will encrypt balance.db and keep the key in your macOS Keychain.\n\n" +
      "macOS will ask for permission on the next screen. " +
      "Choose Always Allow to minimize repeat prompts. Unsigned source-built versions may ask again " +
      "after a rebuild because macOS can treat the rebuilt binary as a different app.\n\n" +
      "Existing unencrypted snapshots are replaced with an encrypted one. " +
      "If you lose the Keychain entry and have no App Lock password, the ledger cannot be recovered, " +
      "so export an archive first if you want a copy you can always read.",
  });
  if (response !== 0) return { ok: false };

  // Constructing the adapter is inert. Its first Keychain operation happens
  // below, after the user has approved Balance's own confirmation dialog.
  const codec = lockCodec();

  // With App Lock already on, capture the password so the key gets its
  // passphrase wrap too. Without it the Keychain would be the only way in.
  let passphrase: string | null = null;
  if (isLockEnabled(userDataDir())) {
    const unlocked = await showLockWindow("unlock", false);
    if (!unlocked) return { ok: false };
    passphrase = lastUnlockPassword;
    lastUnlockPassword = null;
  }

  // The server holds the ledger open; the rekey needs exclusive access.
  const serverToStop = localServer;
  if (!serverToStop) return { ok: false, error: "The local server is not running." };
  try {
    await serverToStop.stop();
  } catch (err) {
    // Never rekey while termination is uncertain. The old process may exit
    // after the timeout; starting a second process could leave two writers on
    // the same file. A relaunch is the only unambiguous recovery.
    return {
      ok: false,
      error: `${err instanceof Error ? err.message : String(err)} Quit and reopen Balance before trying again.`,
    };
  }
  localServer = null;

  let key: string | null = null;
  try {
    key = createKeyFile(userDataDir(), codec);
    if (!key) throw new Error("Balance could not create a protected database key.");
    // When App Lock is already enabled, make its portable recovery path part
    // of the key file before ciphertext exists. Failure here leaves the ledger
    // plaintext and lets the catch block discard the unused key safely.
    if (passphrase) addPassphraseWrap(userDataDir(), key, passphrase);
    const Driver = require("better-sqlite3-multiple-ciphers") as SqliteCtor;
    encryptDbInPlace(dbPath(), key, Driver);
  } catch (err) {
    // Discard the key only after positively proving recovery left plaintext.
    // A double failure can leave ciphertext behind; deleting its only wrapped
    // key would turn a recoverable fault into permanent data loss.
    if (canDiscardEncryptionKeyAfterFailure(dbPath())) {
      removeKeyFile(userDataDir());
      sessionDbKey = null;
    } else {
      sessionDbKey = key;
      try { backupKeyFile(userDataDir()); } catch { /* primary key file remains authoritative */ }
    }
    try { await restartLocalServer(); } catch { /* a normal relaunch retries recovery */ }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Past this point the ledger IS encrypted, so the key file must survive even
  // if the follow-up bookkeeping fails.
  sessionDbKey = key;
  try {
    backupKeyFile(userDataDir());
  } catch (err) {
    console.error("[shell] could not write the wrapped key backup:", err);
  }
  if (config?.encryptionDeclined) {
    const { encryptionDeclined: _declined, ...enabledConfig } = config;
    void _declined;
    writeConfig(configPath(), enabledConfig);
    config = readConfig(configPath());
  }
  let restarted: LocalServer;
  try {
    restarted = await restartLocalServer();
  } catch (err) {
    // The ledger is encrypted and its key is stored, so a normal relaunch will
    // open it: only this session is left without a server. Say so plainly
    // rather than leaving a dead window and a generic renderer error.
    dialog.showErrorBox(
      "Balance encrypted your ledger but could not restart",
      `${err instanceof Error ? err.message : String(err)}\n\n` +
      `Your data is encrypted and intact at:\n${dbPath()}\n\n` +
      "Quit and reopen Balance to continue.",
    );
    return { ok: true };
  }
  try {
    // Replace the plaintext snapshots only once an encrypted one exists, so
    // there is never a window with no recoverable copy of the ledger.
    await restarted.requestBackup();
    backupKeyFile(userDataDir());
    purgePlaintextBackups(backupDir());
  } catch (err) {
    console.error("[shell] could not refresh backups after encrypting:", err);
  }
  buildMenu();
  return { ok: true };
}

function enableEncryption(): Promise<EnableEncryptionResult> {
  if (encryptionInFlight) return encryptionInFlight;
  const attempt = performEnableEncryption().finally(() => {
    if (encryptionInFlight === attempt) encryptionInFlight = null;
  });
  encryptionInFlight = attempt;
  return attempt;
}

ipcMain.handle("encryption:status", (event) => {
  assertAppSender(event);
  return encryptionStatus();
});

ipcMain.handle("encryption:enable", async (event) => {
  assertAppSender(event);
  const result = await enableEncryption();
  return { ...result, status: encryptionStatus() };
});

ipcMain.handle("encryption:decline", (event) => {
  assertAppSender(event);
  if (config && !config.encryptionDeclined) {
    writeConfig(configPath(), { ...config, encryptionDeclined: true });
    config = readConfig(configPath());
  }
  return encryptionStatus();
});

// ---------------------------------------------------------------------------
// Balance Cloud: sign-in (PKCE through the server's device flow), enrollment,
// sync status, disconnect. Control messages ride the utilityProcess
// parentPort -- never reachable from web content.

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function wrapSyncToken(token: string): string | null {
  return wrapSecret(safeStorage, token);
}

function unwrappedSyncToken(): string | null {
  const wrapped = config?.syncToken;
  return wrapped ? unwrapSecret(safeStorage, wrapped) : null;
}

// The server finishes sign-in on a balance-desktop:// redirect carrying a
// 60s PKCE exchange code, which we intercept in-window -- no OS protocol
// registration needed.
function signInToCloud(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signInWindow) {
      signInWindow.focus();
      return reject(new Error("A sign-in window is already open"));
    }
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());

    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      title: "Sign in to Balance Cloud",
      webPreferences: {
        partition: CLOUD_AUTH_PARTITION,
        contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged,
      },
    });
    signInWindow = win;
    applyNavigationRules(win, true);

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      if (!win.isDestroyed()) win.close();
    };

    const tryIntercept = (event: Electron.Event, url: string) => {
      const code = desktopAuthCode(url);
      if (!code) return;
      event.preventDefault();
      void (async () => {
        try {
          const res = await fetch(new URL("/auth/device/exchange", saasUrl()).toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, code_verifier: verifier }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error(`Sign-in exchange failed (${res.status})`);
          const contentLength = Number(res.headers.get("content-length"));
          if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
            throw new Error("Sign-in exchange response was too large");
          }
          const raw = await res.text();
          if (raw.length > 1_000_000) throw new Error("Sign-in exchange response was too large");
          let payload: unknown;
          try { payload = JSON.parse(raw); }
          catch { throw new Error("Sign-in exchange returned an invalid response"); }
          const token = (payload as { token?: unknown } | null)?.token;
          if (typeof token !== "string" || token.length === 0 || token.length > 65_536) {
            throw new Error("Sign-in exchange returned no valid token");
          }
          settle(() => resolve(token));
        } catch (err) {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      })();
    };
    win.webContents.on("will-redirect", tryIntercept);
    win.webContents.on("will-navigate", tryIntercept);
    win.on("closed", () => {
      signInWindow = null;
      if (!settled) {
        settled = true;
        reject(new Error("Sign-in was cancelled"));
      }
    });

    const authUrl = new URL("/auth/google", saasUrl());
    authUrl.searchParams.set("client", "desktop");
    authUrl.searchParams.set("code_challenge", challenge);
    void win.loadURL(authUrl.toString());
  });
}

async function ensureSignedIn(): Promise<string> {
  const existing = unwrappedSyncToken();
  if (existing && localServer) return existing;
  const token = await signInToCloud();
  const wrapped = wrapSyncToken(token);
  writeConfig(configPath(), { ...(config as AppConfig), syncToken: wrapped ?? undefined });
  config = readConfig(configPath());
  await localServer?.request("set-token", { token });
  return token;
}

interface SyncStatusPayload {
  mode: "local" | "cloud";
  cursor: number;
  engine: { state: string; lastSyncAt: string | null; pending: number; message?: string };
  pending: number;
  conflicts: number;
  hasToken: boolean;
  saasUrl: string;
}

async function fetchSyncStatus(): Promise<SyncStatusPayload | null> {
  if (!localServer) return null;
  try {
    return await localServer.request("sync-status") as SyncStatusPayload;
  } catch {
    return null;
  }
}

// Enrollment: sign in, then migrate the local ledger up (empty
// household), hydrate an empty replica, or -- with the user's explicit choice
// -- replace local data with the cloud copy. No merge, by design.
function persistReconciledSyncMode(mode: AppMode): void {
  if (!config) return;
  writeConfig(configPath(), reconcileConfigWithSyncMode(config, mode));
  config = readConfig(configPath());
}

function abandonCloudConnection(): void {
  if (!config) return;
  const { cloudTransition: _transition, syncToken: _token, ...rest } = config;
  void _transition;
  void _token;
  writeConfig(configPath(), { ...rest, mode: "local" });
  config = readConfig(configPath());
}

let cloudConnectionInFlight = false;
async function connectToCloud(): Promise<void> {
  if (!localServer || cloudConnectionInFlight) return;
  cloudConnectionInFlight = true;
  try {
    const endpoint = saasUrl();
    if (!endpoint || !config) throw new Error("No Balance Cloud endpoint is configured");
    // Journal the cross-process transition before either side changes. If the
    // app exits at any later instruction, boot can tell whether to resume the
    // connection or accept the database's committed cloud mode.
    writeConfig(configPath(), {
      ...config,
      mode: "local",
      saasUrl: endpoint,
      cloudTransition: "connecting",
    });
    config = readConfig(configPath());
    await ensureSignedIn();
    // Enrollment can replace the local ledger. A recoverable snapshot and its
    // matching wrapped key are therefore mandatory, not best-effort.
    await localServer.requestBackup();
    if (sessionDbKey) backupKeyFile(userDataDir());
    try {
      await localServer.request("enroll", undefined, 300_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/empty household|already contains data/i.test(message)) {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          buttons: ["Replace This Mac's Data", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: "Your cloud household already has data",
          detail: "There is no merge: this Mac's ledger can be replaced with the cloud data (a local backup was just taken), or you can reset the cloud household from the web app first.",
        });
        if (response !== 0) {
          abandonCloudConnection();
          buildMenu();
          return;
        }
        await localServer.request("enroll-replace", undefined, 300_000);
      } else {
        throw err;
      }
    }
    persistReconciledSyncMode("cloud");
    buildMenu();
    mainWindow?.reload();
    void dialog.showMessageBox({
      type: "info",
      message: "Connected to Balance Cloud",
      detail: "This Mac now keeps a full offline copy and syncs with your household in the background.",
    });
  } catch (err) {
    // An RPC timeout is ambiguous: enrollment may have committed just before
    // the reply was lost. Ask the database when possible; otherwise retain the
    // transition marker so the next boot can recover it. A deliberate sign-in
    // cancellation abandons the attempt and removes the unused token.
    if (/cancelled/i.test(err instanceof Error ? err.message : String(err))) {
      abandonCloudConnection();
    } else {
      const status = await fetchSyncStatus();
      if (status) persistReconciledSyncMode(status.mode);
    }
    buildMenu();
    dialog.showErrorBox("Could not connect to Balance Cloud", err instanceof Error ? err.message : String(err));
  } finally {
    cloudConnectionInFlight = false;
  }
}

async function disconnectFromCloud(): Promise<void> {
  if (!localServer) return;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Disconnect", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Disconnect from Balance Cloud?",
    detail: "All data stays on this Mac and keeps working offline. Reconnecting later means replacing either this Mac's data or the cloud household -- there is no merge.",
  });
  if (response !== 0) return;
  if (!config) return;
  writeConfig(configPath(), { ...config, cloudTransition: "disconnecting" });
  config = readConfig(configPath());
  try {
    await localServer.request("disconnect", undefined, 120_000);
  } catch (err) {
    // As with enrollment, a lost reply can arrive after the database committed
    // the mode switch. Reconcile immediately when the server still answers;
    // otherwise leave the journal for boot recovery.
    const status = await fetchSyncStatus();
    if (status) persistReconciledSyncMode(status.mode);
    buildMenu();
    dialog.showErrorBox("Disconnect failed", err instanceof Error ? err.message : String(err));
    return;
  }
  persistReconciledSyncMode("local");
  buildMenu();
  mainWindow?.reload();
}

async function showSyncStatus(): Promise<void> {
  const status = await fetchSyncStatus();
  if (!status) {
    dialog.showErrorBox("Sync status unavailable", "The embedded server did not respond.");
    return;
  }
  const engineLine = status.engine.state === "auth_required"
    ? "Signed out -- sign in to resume sync"
    : status.engine.state === "idle"
      ? `Synced${status.engine.lastSyncAt ? ` (last: ${new Date(status.engine.lastSyncAt).toLocaleString()})` : ""}`
      : status.engine.state;
  const buttons = status.engine.state === "auth_required" ? ["Sign In", "Sync Now", "Close"] : ["Sync Now", "Close"];
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    message: "Balance Cloud sync",
    detail: [
      `Status: ${engineLine}`,
      `Pending changes to push: ${status.pending}`,
      `Recorded conflicts: ${status.conflicts}`,
      `Sync cursor: ${status.cursor}`,
      `Server: ${status.saasUrl}`,
    ].join("\n"),
  });
  const picked = buttons[response];
  if (picked === "Sign In") {
    try {
      await ensureSignedIn();
      await localServer?.request("sync-now", undefined, 300_000);
    } catch (err) {
      dialog.showErrorBox("Sign-in failed", err instanceof Error ? err.message : String(err));
    }
  } else if (picked === "Sync Now") {
    try {
      await localServer?.request("sync-now", undefined, 300_000);
    } catch (err) {
      dialog.showErrorBox("Sync failed", err instanceof Error ? err.message : String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// First-run chooser

function showChooser(): Promise<AppMode> {
  return new Promise((resolve) => {
    let chosen: AppMode | null = null;
    const win = new BrowserWindow({
      width: 760,
      height: 500,
      resizable: false,
      title: "Balance",
      webPreferences: {
        preload: path.join(__dirname, "chooserPreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: !app.isPackaged,
      },
    });
    // The page asks whether to offer cloud at all; the answer also guards the
    // choice itself, so a tampered renderer cannot select a hidden mode.
    ipcMain.handle("setup:cloud-enabled", (event) => {
      if (event.sender !== win.webContents) throw new Error("Unauthorized sender");
      return cloudEnabled();
    });
    ipcMain.handle("setup:choose-mode", (event, mode: unknown) => {
      if (event.sender !== win.webContents) throw new Error("Unauthorized sender");
      if (mode !== "local" && mode !== "cloud") throw new Error("Invalid mode");
      if (mode === "cloud" && !cloudEnabled()) throw new Error("Balance Cloud is not available yet");
      chosen = mode;
      win.close();
    });
    win.on("closed", () => {
      ipcMain.removeHandler("setup:choose-mode");
      ipcMain.removeHandler("setup:cloud-enabled");
      if (chosen) resolve(chosen);
      else app.quit(); // closed without choosing: nothing to run yet
    });
    void win.loadURL(`${SHELL_SCHEME}://app/chooser.html`);
  });
}

// ---------------------------------------------------------------------------
// Boot

// Dock icon for source installs. A packaged .app takes its icon from the
// bundle, but people who clone and run "npm start" launch the plain Electron
// binary and would otherwise see the Electron logo in the Dock. Setting it at
// runtime gives them the real icon. The file is optional: no icon committed
// yet simply means the default is kept, which is not an error.
function applyDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock) return;
  const icon = path.join(__dirname, "..", "build", "icon.png");
  if (existsSync(icon)) app.dock.setIcon(icon);
}

// Single source of truth for how the embedded server is launched, so the
// restart after opting into encryption cannot drift from the boot path.
function serverOptions() {
  const endpoint = saasUrl();
  const syncToken = unwrappedSyncToken();
  return {
    entry: resolveServerEntry(),
    dbPath: dbPath(),
    backupDir: backupDir(),
    localAuthToken: localApiToken,
    // The cipher-capable driver is used in every case, keyed or not: it opens
    // plaintext files exactly like stock better-sqlite3, and pinning one
    // driver here keeps stock better-sqlite3 free to stay a Node-ABI build
    // for the server's own test runs. Only the key is conditional.
    sqliteDriverPath: resolvePackageRoot("better-sqlite3-multiple-ciphers"),
    ...(sessionDbKey ? { dbKey: sessionDbKey } : {}),
    ...(endpoint ? { saasUrl: endpoint } : {}),
    ...(syncToken ? { syncToken } : {}),
  };
}

// Bring the embedded server back up after the ledger file changed underneath
// it. The kernel assigns a fresh port, so the trusted origin, the bearer-header
// injection, and the loaded page all have to follow it.
async function restartLocalServer(): Promise<LocalServer> {
  const started = await startLocalServer(serverOptions());
  localServer = started;
  appOrigin = started.origin;
  appUrl = started.origin;
  authenticateLocalRequests(session.fromPartition(LOCAL_PARTITION), appOrigin, localApiToken);
  if (mainWindow) await loadUrlWithRetry(() => mainWindow!.loadURL(appUrl));
  return started;
}

async function boot(): Promise<void> {
  applyDockIcon();
  installShellProtocol();

  try {
    mkdirSync(userDataDir(), { recursive: true, mode: 0o700 });
    chmodSync(userDataDir(), 0o700);
  } catch (err) {
    dialog.showErrorBox(
      "Balance cannot protect its data folder",
      err instanceof Error ? err.message : String(err),
    );
    app.exit(1);
    return;
  }

  // Balance does not require camera, microphone, location, notifications, or
  // other Chromium permissions. Deny them in both local and Amazon sessions.
  for (const target of [
    session.defaultSession,
    session.fromPartition(LOCAL_PARTITION),
    session.fromPartition(AMAZON_PARTITION),
    session.fromPartition(CLOUD_AUTH_PARTITION),
  ]) {
    target.setPermissionCheckHandler(() => false);
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  }

  // The lock gates everything: no config, no server, no data until unlocked.
  if (isLockEnabled(userDataDir())) {
    const ok = await showLockWindow("unlock", true);
    if (!ok) {
      app.quit();
      return;
    }
  }

  // Relock whenever the machine sleeps or the OS session locks.
  powerMonitor.on("suspend", relock);
  powerMonitor.on("lock-screen", relock);

  config = readConfig(configPath());
  if (!config) {
    const mode = await showChooser();
    const endpoint = cloudEndpoint(process.env, null);
    config = mode === "cloud" && endpoint
      ? { mode: "local", saasUrl: endpoint, cloudTransition: "connecting" }
      : { mode: "local" };
    writeConfig(configPath(), config);
  }

  // ---- optional at-rest encryption ----
  // Recover any interrupted migration, then resolve an existing wrapped key
  // before the server opens the file. Fresh profiles intentionally remain
  // plaintext until the user opts in. Once a ledger is encrypted, startup
  // fails closed if neither the Keychain nor an App Lock wrap can unlock it.
  try {
    if (recoverInterruptedEncryption(dbPath())) {
      console.warn("[shell] restored a crash-interrupted database encryption migration");
    }
  } catch (err) {
    dialog.showErrorBox(
      "Balance could not recover its database",
      err instanceof Error ? err.message : String(err),
    );
    app.exit(1);
    return;
  }
  const keyResolution = resolveDbKey();
  lastUnlockPassword = null; // used once; never kept around
  if (keyResolution.fatal) {
    dialog.showErrorBox("Balance cannot unlock its database", keyResolution.fatal);
    app.exit(1);
    return;
  }
  sessionDbKey = keyResolution.key;
  if (sessionDbKey) {
    try {
      backupKeyFile(userDataDir());
    } catch (err) {
      console.error("[shell] could not back up wrapped database key:", err);
    }
  }
  if (sessionDbKey && isPlaintextSqlite(dbPath())) {
    try {
      const Driver = require("better-sqlite3-multiple-ciphers") as SqliteCtor;
      const result = encryptDbInPlace(dbPath(), sessionDbKey, Driver);
      if (result.rekeyed) {
        console.log(`[shell] encrypted ${dbPath()} in place`);
      }
    } catch (err) {
      dialog.showErrorBox(
        "Balance could not encrypt its database",
        `${err instanceof Error ? err.message : String(err)}\n\nThe original database was restored unchanged. Balance will close rather than continue with an unencrypted ledger.`,
      );
      sessionDbKey = null;
      app.exit(1);
      return;
    }
  }

  try {
    localServer = await startLocalServer(serverOptions());
    appOrigin = localServer.origin;
    appUrl = localServer.origin;
    const localSession = session.fromPartition(LOCAL_PARTITION);
    authenticateLocalRequests(localSession, appOrigin, localApiToken);
    // Earlier local builds shipped the client as a PWA; a leftover service
    // worker would keep serving stale cached assets after an update. The
    // local client no longer registers one, so drop any stale registrations
    // (cookies and localStorage are untouched).
    await localSession.clearStorageData({ storages: ["serviceworkers", "cachestorage"] });

    // The database commits its sync mode atomically with enrollment/disconnect,
    // while the shell config carries a small transition journal. Reconcile on
    // every boot so all crash points converge and local mode never retains an
    // obsolete Cloud session token.
    const status = await fetchSyncStatus();
    if (status && config) {
      const reconciled = reconcileConfigWithSyncMode(config, status.mode);
      if (JSON.stringify(reconciled) !== JSON.stringify(config)) {
        writeConfig(configPath(), reconciled);
        config = readConfig(configPath());
      }
    }
  } catch (err) {
    dialog.showErrorBox(
      "Balance could not start its local server",
      `${err instanceof Error ? err.message : String(err)}\n\nYour data file is untouched at:\n${dbPath()}`,
    );
    app.exit(1);
    return;
  }

  createMainWindow();

  // A first run chose Cloud, or a previous connection was interrupted before
  // its database commit: resume the explicit enrollment transition.
  if (config?.cloudTransition === "connecting") {
    void connectToCloud();
  }
  buildMenu();

}

// ---------------------------------------------------------------------------
// Menu

function buildMenu(): void {
  // While relocked, expose nothing but the essentials (Edit stays so the
  // password field accepts paste).
  if (uiLocked) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" },
    ]));
    return;
  }

  // Lock management lives in the app's Settings page (Security section);
  // the menu keeps only the quick action.
  const lockItems: Electron.MenuItemConstructorOptions[] = isLockEnabled(userDataDir())
    ? [
        { type: "separator" },
        { label: "Lock Balance", accelerator: "CmdOrCtrl+L", click: () => relock() },
      ]
    : [];

  const mode = config?.mode ?? "local";
  // The local server (and its backups) runs in both modes now.
  const backupItems: Electron.MenuItemConstructorOptions[] = [
    { type: "separator" },
    { label: formatLastBackup(lastBackup(backupDir()), Date.now()), enabled: false },
    { label: "Back Up Now", click: () => void backupNow() },
    { label: "Open Backups Folder", click: () => void shell.openPath(backupDir()) },
  ];
  const cloudItems: Electron.MenuItemConstructorOptions[] = mode === "cloud"
    ? [
        {
          label: "Sync Now",
          accelerator: "CmdOrCtrl+R",
          click: () => void localServer?.request("sync-now", undefined, 300_000)
            .then(() => buildMenu())
            .catch((err) => dialog.showErrorBox("Sync failed", err instanceof Error ? err.message : String(err))),
        },
        { label: "Sync Status…", click: () => void showSyncStatus() },
        { label: "Disconnect from Balance Cloud…", click: () => void disconnectFromCloud() },
      ]
    : cloudEnabled()
      ? [{ label: "Connect to Balance Cloud…", click: () => void connectToCloud() }]
      : [{ label: "Balance Cloud: coming soon", enabled: false }];

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates…",
          click: () => void checkForUpdates(false),
        },
        { type: "separator" },
        { label: `Version ${app.getVersion()}`, enabled: false },
        { label: mode === "cloud" ? "Mode: Cloud (synced household)" : "Mode: Local (this computer)", enabled: false },
        ...cloudItems,
        ...backupItems,
        ...lockItems,
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function backupNow(): Promise<void> {
  if (!localServer) return;
  try {
    const dest = await localServer.requestBackup();
    if (sessionDbKey) backupKeyFile(userDataDir());
    buildMenu(); // refresh the "Last backup" label
    void dialog.showMessageBox({ type: "info", message: "Backup complete", detail: dest });
  } catch (err) {
    dialog.showErrorBox("Backup failed", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Updates are informational. Balance never changes the user's checkout or
// executes package installation commands. The repository owner remains in
// control of reviewing and applying source changes.

async function checkForUpdates(silent: boolean): Promise<void> {
  const check = await checkForUpdate(app.getVersion());
  if (!check.updateAvailable || !check.latest) {
    if (!silent) {
      void dialog.showMessageBox({
        type: "info",
        message: `Balance ${app.getVersion()} is up to date`,
        detail: check.latest
          ? `The newest published version is ${check.latest.tag}.`
          : "Could not reach GitHub to check. Try again later.",
        buttons: ["OK"],
      });
    }
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: `Balance ${check.latest.tag} source is available`,
    detail:
      "Quit Balance, review the new version in the repository, update your source checkout, " +
      "then run npm ci, npm run verify, and npm run start. Balance will not change your checkout automatically.",
    buttons: ["Open Version Page", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    void shell.openExternal(check.latest.url);
  }
}

// ---------------------------------------------------------------------------
// Amazon scrape bridge (mode-agnostic: both web clients call it the same way)

// One scrape at a time: the flow is interactive (the user may be signing in
// to Amazon in the scrape window), so a second concurrent run makes no sense.
let scrapeInFlight = false;

ipcMain.handle("amazon:scrape", async (event, rawWindow: unknown) => {
  // Only the Balance app loaded in our own shell may drive the scraper. The
  // sender must match the active app origin.
  if (!event.senderFrame || new URL(event.senderFrame.url).origin !== appOrigin) {
    throw new Error("Unauthorized sender");
  }
  const scrapeWindow = parseScrapeWindow(rawWindow);
  if (!scrapeWindow) {
    throw new Error("scrapeAmazon expects real YYYY-MM-DD dates with oldestIso no later than newestIso");
  }
  if (scrapeInFlight) {
    throw new Error("An Amazon sync is already running");
  }
  scrapeInFlight = true;
  try {
    return await scrapeAmazonOrders(scrapeWindow);
  } finally {
    scrapeInFlight = false;
  }
});

// ---------------------------------------------------------------------------
// Lifecycle

void app.whenReady().then(boot);

app.on("activate", () => {
  if (uiLocked) {
    // Locked and windowless (user closed the lock screen): bring it back.
    if (!lockWindow) {
      void showLockWindow("unlock", false).then((ok) => {
        if (ok) {
          uiLocked = false;
          buildMenu();
          createMainWindow();
        }
      });
    }
    return;
  }
  if (appUrl && BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

// In local mode, snapshot the DB on the way out (bounded so a stuck backup
// can never wedge quit).
let quitBackupDone = false;
app.on("before-quit", (event) => {
  if (!localServer || quitBackupDone) return;
  event.preventDefault();
  const finish = async () => {
    quitBackupDone = true;
    try { await localServer?.stop(); } finally { app.quit(); }
  };
  Promise.race([
    localServer.requestBackup().then(() => {
      if (sessionDbKey) backupKeyFile(userDataDir());
    }),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]).then(() => void finish(), () => void finish());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
