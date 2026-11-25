import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PackError } from './errors.mjs';
import { sha256OfFile, verifyManifest } from './verify.mjs';
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
export async function installProduct({ id, def, feed, dir, target, pubkey, log = () => {}, nodeMajor, runCommand = runStep }) {
  const release = await feed.latest(def.repo, def.name);
  const manifestName = def.manifest.replace('{target}', target);
  const manifestAsset = release.assets.find((a) => a.name === manifestName);
  if (!manifestAsset) throw new PackError(`No build of ${def.name} for this computer (${target}) has been published yet.`);

  const signed = verifyManifest(await feed.json(manifestAsset, def.name), pubkey);
  const artifactName = assetNameOf(signed.url);
  const artifact = release.assets.find((a) => a.name === artifactName);
  if (!artifact) throw new PackError(`The release for ${def.name} names a file that is not in it (${artifactName}).`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'echlon-pack-'));
  try {
    const file = path.join(work, artifactName);
    await feed.download(artifact, file, def.name);
    const actual = await sha256OfFile(file);
    if (actual !== signed.sha256.toLowerCase()) {
      throw new PackError(`The download of ${def.name} does not match what was signed, so it was not installed. Nothing was changed.`);
    }

    const productDir = path.join(dir, id);
    const dest = path.join(productDir, signed.version);
    const staging = `${dest}.partial`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    let pack = null;
    if (artifactName.toLowerCase().endsWith('.zip')) {
      extractZip(file, staging);
      const manifestFile = path.join(staging, 'echlon-pack.json');
      if (fs.existsSync(manifestFile)) pack = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (pack) {
        checkNode(pack.requires, nodeMajor, def.name);
        const steps = checkPostInstall(pack.postInstall);
        if (steps.length) log(`Setting up ${def.name} (this downloads its dependencies and can take a few minutes)`);
        for (const step of steps) runCommand(step, staging);
      }
    } else {
      fs.copyFileSync(file, path.join(staging, artifactName));
      if (process.platform !== 'win32') fs.chmodSync(path.join(staging, artifactName), 0o755);
    }

    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
    fs.writeFileSync(path.join(productDir, 'current.json'), `${JSON.stringify({ version: signed.version, file: artifactName }, null, 2)}\n`);
    log(`Installed ${def.name} ${signed.version}`);
    return { version: signed.version, dest, file: artifactName, kind: pack ? 'package' : 'file', pack };
  } finally {
    fs.rmSync(`${path.join(dir, id, signed.version)}.partial`, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
}
