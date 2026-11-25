import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PackError } from './errors.mjs';
import { sha256OfFile, verifyManifest } from './verify.mjs';
import { quietProgress } from './progress.mjs';
import { SealedError, openFile } from './sealed.mjs';
import { checkNode, checkPostInstall, runStep } from './setup.mjs';
import { extractZip } from './zip.mjs';

/** The file name a release points at: the last part of its url. */
export function assetNameOf(url) {
  const tail = (() => {
    try {
      return new URL(url).pathname.split('/').pop() ?? '';
    } catch {
      return String(url).split('/').pop() ?? '';
    }
  })();
  return decodeURIComponent(tail);
}

/**
 * One product, from the feed to a folder: find the newest release, check its signature, download the
 * artifact, check it is the one that was signed, and only then unpack it. Anything that fails leaves the
 * installed version exactly as it was.
 */
export async function installProduct({ id, def, feed, dir, target, pubkey, log = () => {}, nodeMajor, nodeBin, runCommand = runStep, progress = quietProgress }) {
  log(`Checking your key for ${def.name}`);
  const { manifest, artifactFor, contentKey } = await feed.release({ id, def, target });

  const signed = verifyManifest(manifest, pubkey);
  const artifactName = assetNameOf(signed.url);
  const artifact = artifactFor(artifactName);
  if (!artifact) throw new PackError(`The release for ${def.name} names a file that is not in it (${artifactName}).`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'echlon-pack-'));
  try {
    const file = path.join(work, artifactName);
    log(`Downloading ${def.name} ${signed.version}`);
    const bar = progress.start(`${def.name} ${signed.version}`);
    await artifact.save(file, bar.update);
    bar.finish();
    log('Checking the download is exactly what Echlon signed');
    const actual = await sha256OfFile(file);
    if (actual !== signed.sha256.toLowerCase()) {
      throw new PackError(`The download of ${def.name} does not match what was signed, so it was not installed. Nothing was changed.`);
    }

    // A sealed release is encrypted; the service gave the key for it along with the manifest, only because the licence
    // key was valid. What comes out must be exactly what was signed to be inside, or nothing is installed.
    let installName = artifactName;
    let installFile = file;
    if (signed.sealed) {
      if (!contentKey || contentKey.length !== 32) {
        throw new PackError(`${def.name} is sealed, and only a licence key can open it. Nothing was installed.`);
      }
      installName = signed.sealed.name;
      installFile = path.join(work, `unsealed-${installName}`);
      log(`Unsealing ${def.name}`);
      const unseal = progress.start(`Unsealing ${def.name}`);
      let opened;
      try {
        opened = await openFile(file, installFile, contentKey, { onProgress: unseal.update });
      } catch (e) {
        if (e instanceof SealedError) throw new PackError(`${def.name} could not be unsealed: ${e.message} Nothing was installed.`);
        throw e;
      } finally {
        contentKey.fill(0);
      }
      unseal.finish();
      if (opened.sha256 !== signed.sealed.sha256 || opened.size !== signed.sealed.size) {
        throw new PackError(`What was inside ${def.name} does not match what was signed, so it was not installed. Nothing was changed.`);
      }
    }

    const productDir = path.join(dir, id);
    const dest = path.join(productDir, signed.version);
    const staging = `${dest}.partial`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    let pack = null;
    let exe;
    if (installName.toLowerCase().endsWith('.zip')) {
      log(`Unpacking ${def.name}`);
      extractZip(installFile, staging);
      const manifestFile = path.join(staging, 'echlon-pack.json');
      if (fs.existsSync(manifestFile)) pack = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (pack) {
        checkNode(pack.requires, nodeMajor, def.name);
        const steps = checkPostInstall(pack.postInstall);
        // The program the package says to run, for this system. It becomes a launcher and an AI-tool entry, so it is
        // checked: a plain path inside the package, present, and (on Linux) made runnable, since a zip does not carry that.
        const declared = pack.exe?.[process.platform === 'win32' ? 'win32' : 'posix'];
        if (pack.exe && declared === undefined) throw new PackError(`This build of ${def.name} is not for this computer.`);
        if (declared !== undefined) {
          const safe = typeof declared === 'string' && declared.length > 0 && !path.isAbsolute(declared) && !declared.split(/[\\/]/).includes('..');
          if (!safe) throw new PackError(`${def.name} names a program that is not a plain path inside the package, so it was not installed.`);
          if (!fs.existsSync(path.join(staging, declared))) throw new PackError(`${def.name} names a program that is not in the package (${declared}), so it was not installed.`);
          if (process.platform !== 'win32') fs.chmodSync(path.join(staging, declared), 0o755);
          exe = declared;
        }
        for (const step of steps) await progress.working(`Setting up ${def.name} (installing its dependencies; this can take a few minutes)`, Promise.resolve(runCommand(step, staging, { binDir: nodeBin })));
      }
    } else {
      fs.copyFileSync(installFile, path.join(staging, installName));
      if (process.platform !== 'win32') fs.chmodSync(path.join(staging, installName), 0o755);
    }

    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
    fs.writeFileSync(path.join(productDir, 'current.json'), `${JSON.stringify({ version: signed.version, file: installName }, null, 2)}\n`);
    log(`Installed ${def.name} ${signed.version}`);
    return { version: signed.version, dest, file: installName, exe, kind: pack ? 'package' : 'file', pack };
  } finally {
    fs.rmSync(`${path.join(dir, id, signed.version)}.partial`, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
}
