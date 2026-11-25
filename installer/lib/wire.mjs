import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PackError } from './errors.mjs';

/**
 * Joining the two products: the engine gets a fresh access token made here on this machine, and the UI
 * is told to use it. The customer never sees it or types it. It is written to the two places that need
 * it, both under the install folder, and is never printed.
 */
export const ENGINE_NAME = 'Echlon Engine';
export const ENGINE_ADDRESS = 'http://127.0.0.1:3737';

export const newEngineToken = () => randomBytes(24).toString('hex');

/** A string as one shell word: single-quoted, with any single quote inside it closed, escaped and reopened. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A folder the scripts written here can name safely. Windows batch files cannot hold these characters in a path. */
export function checkInstallDir(dir, platform = process.platform) {
  if (platform === 'win32' && /["%^&|<>]/.test(dir)) {
    throw new PackError('The install folder name has a character (such as % or &) that Windows start scripts cannot hold. Choose another folder.');
  }
}

/** The UI's settings with an Echlon Engine connection in them; any other settings or connections stay. */
export function withEngineConnection(settings, token, address = ENGINE_ADDRESS) {
  const connections = (settings.connections ?? []).filter((c) => c.vendor !== 'echlon-engine');
  connections.push({
    id: 'echlon-engine:pack',
    vendor: 'echlon-engine',
    label: ENGINE_NAME,
    active: true,
    secrets: { apiKey: token },
    config: { baseUrl: address },
  });
  return { ...settings, connections };
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

/**
 * The customer's licence key, kept where the UI reads it, so it can renew its licence and lock itself when the
 * licence ends. It is the one place the installer keeps the key: only for a package that says it is licensed,
 * owner-only, inside the data folder (so an update keeps it), and never printed.
 */
export function writeLicenceKey(dataDir, key) {
  const file = path.join(dataDir, 'licence.key');
  writePrivate(file, `${key}
`);
  return file;
}

export function writeUiSettings(dataDir, token) {
  const file = path.join(dataDir, 'echlon.settings.json');
  let current = {};
  if (fs.existsSync(file)) {
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // Kept, not overwritten: an unreadable settings file may hold something the customer typed.
      fs.copyFileSync(file, `${file}.unreadable-${Date.now()}`);
    }
  }
  writePrivate(file, `${JSON.stringify(withEngineConnection(current, token), null, 2)}\n`);
  return file;
}

/**
 * The scripts that run the engine, for the platform it was installed on.
 *
 * `name`/`text` is the one a person starts the engine with. `extras` are the others written beside it: on Windows the
 * engine runs with no window (a console that must stay open is not a service), so the start script hands over to a
 * hidden launcher that holds the token and logs to engine.log, and there is a stop script; on both, `echlon-op`
 * opens the operator session. Only a process started with --http is stopped by the stop script, because the same
 * program is also what an AI tool launches for itself.
 */
export function engineLauncher({ platform, installDir, exeRelative, token }) {
  const exe = (platform === 'win32' ? path.win32 : path.posix).join(installDir, exeRelative);
  if (platform === 'win32') {
    const log = path.win32.join(installDir, 'engine.log');
    const image = path.win32.basename(exe);
    return {
      name: 'start-engine.cmd',
      text: `@echo off\r\nrem Starts the Echlon Engine on 127.0.0.1:3737 in the background, with no window. Output goes to engine.log.\r\nwscript.exe //nologo "%~dp0start-engine.vbs"\r\n`,
      extras: [
        {
          name: 'start-engine.vbs',
          text: `' Starts the Echlon Engine with no window. Keep this file private: it holds the engine's access token.\r\nSet shell = CreateObject("WScript.Shell")\r\nq = Chr(34)\r\nshell.Environment("Process")("ECHLON_MCP_TOKEN") = "${token}"\r\nshell.Run "cmd /c " & q & q & "${exe}" & q & " --http >> " & q & "${log}" & q & " 2>&1" & q, 0, False\r\n`,
        },
        {
          name: 'stop-engine.cmd',
          text: `@echo off\r\nrem Stops the Echlon Engine started by start-engine.cmd. An engine an AI tool started for itself is left alone.\r\npowershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${image}' -and $_.CommandLine -match '--http' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"\r\n`,
        },
        { name: 'echlon-op.cmd', text: `@echo off\r\nrem Opens an operator session: Claude Code holding only the Echlon tools.\r\n"${exe}" op %*\r\n` },
      ],
    };
  }
  return {
    name: 'start-engine.sh',
    text: `#!/bin/sh\n# Starts the Echlon Engine on 127.0.0.1:3737. Keep this file private: it holds the engine's access token.\nECHLON_MCP_TOKEN=${shq(token)}\nexport ECHLON_MCP_TOKEN\nexec ${shq(exe)} --http\n`,
    extras: [{ name: 'echlon-op', text: `#!/bin/sh\n# Opens an operator session: Claude Code holding only the Echlon tools.\nexec ${shq(exe)} op "$@"\n` }],
  };
}

/** The script that starts the UI from its installed folder, with its data kept outside the versioned folder so an update keeps it. */
export function uiLauncher({ platform, versionDir, startRelative, dataDir, binDir }) {
  const start = (platform === 'win32' ? path.win32 : path.posix).join(versionDir, startRelative);
  if (platform === 'win32') {
    // `binDir` is the folder of the Node Echlon downloaded for it, when this computer's own was too old: it goes first.
    const node = binDir ? `rem The Node Echlon downloaded for it comes first.\r\nset "PATH=${binDir};%PATH%"\r\n` : '';
    return {
      name: 'start-ui.cmd',
      text: `@echo off\r\nrem Starts the Echlon UI.\r\n${node}set "ECHLON_DATA_DIR=${dataDir}"\r\ncd /d "${versionDir}"\r\ncall "${start}"\r\n`,
    };
  }
  const node = binDir ? `# The Node Echlon downloaded for it comes first.\nPATH=${shq(binDir)}:"$PATH"\nexport PATH\n` : '';
  return {
    name: 'start-ui.sh',
    text: `#!/bin/sh\n# Starts the Echlon UI.\n${node}ECHLON_DATA_DIR=${shq(dataDir)}\nexport ECHLON_DATA_DIR\ncd ${shq(versionDir)} || exit 1\nexec ${shq(start)}\n`,
  };
}

export function writeLauncher(installDir, launcher) {
  for (const extra of launcher.extras ?? []) {
    const f = path.join(installDir, extra.name);
    writePrivate(f, extra.text);
    if (process.platform !== 'win32') fs.chmodSync(f, 0o700);
  }
  const file = path.join(installDir, launcher.name);
  writePrivate(file, launcher.text);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o700);
  return file;
}
