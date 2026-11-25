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

/** The script that starts the engine with its token, for the platform it was installed on. */
export function engineLauncher({ platform, installDir, exeRelative, token }) {
  const exe = path.join(installDir, exeRelative);
  if (platform === 'win32') {
    return {
      name: 'start-engine.cmd',
      text: `@echo off\r\nrem Starts the Echlon Engine on 127.0.0.1:3737. Keep this file private: it holds the engine's access token.\r\nset "ECHLON_MCP_TOKEN=${token}"\r\n"${exe}" --http\r\n`,
    };
  }
  return {
    name: 'start-engine.sh',
    text: `#!/bin/sh\n# Starts the Echlon Engine on 127.0.0.1:3737. Keep this file private: it holds the engine's access token.\nECHLON_MCP_TOKEN=${shq(token)}\nexport ECHLON_MCP_TOKEN\nexec ${shq(exe)} --http\n`,
  };
}

/** The script that starts the UI from its installed folder, with its data kept outside the versioned folder so an update keeps it. */
export function uiLauncher({ platform, versionDir, startRelative, dataDir }) {
  const start = path.join(versionDir, startRelative);
  if (platform === 'win32') {
    return {
      name: 'start-ui.cmd',
      text: `@echo off\r\nrem Starts the Echlon UI.\r\nset "ECHLON_DATA_DIR=${dataDir}"\r\ncd /d "${versionDir}"\r\ncall "${start}"\r\n`,
    };
  }
  return {
    name: 'start-ui.sh',
    text: `#!/bin/sh\n# Starts the Echlon UI.\nECHLON_DATA_DIR=${shq(dataDir)}\nexport ECHLON_DATA_DIR\ncd ${shq(versionDir)} || exit 1\nexec ${shq(start)}\n`,
  };
}

export function writeLauncher(installDir, launcher) {
  const file = path.join(installDir, launcher.name);
  writePrivate(file, launcher.text);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o700);
  return file;
}
