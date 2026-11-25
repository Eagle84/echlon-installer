import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { addToPath, onPath } from '../installer/lib/pathenv.mjs';
import { tmpDir } from './helpers.mjs';

describe('finding a folder on the PATH', () => {
  it('compares the way the system does: Windows ignores case and a trailing slash, Linux does neither', () => {
    assert.equal(onPath('C:\\Echlon', 'C:\\Windows;c:\\echlon\\', 'win32'), true);
    assert.equal(onPath('C:\\Echlon', 'C:\\Windows', 'win32'), false);
    assert.equal(onPath('/opt/echlon', '/usr/bin:/opt/echlon/', 'linux'), true);
    assert.equal(onPath('/opt/echlon', '/usr/bin:/opt/Echlon', 'linux'), false);
    assert.equal(onPath('/x', undefined, 'linux'), false);
  });
});

describe('making echlon-op available from any terminal (Linux)', () => {
  const make = () => {
    const dir = tmpDir('echlon-pathenv-');
    fs.writeFileSync(path.join(dir, 'echlon-op'), '#!/bin/sh\n');
    return { dir, home: tmpDir('echlon-home-') };
  };

  it('links the command into ~/.local/bin and says so', (t) => {
    if (process.platform === 'win32') return t.skip('symlinks need a privilege on Windows');
    const { dir, home } = make();
    const said = addToPath({ dir, platform: 'linux', env: { PATH: `/usr/bin:${path.join(home, '.local', 'bin')}` }, home });
    assert.equal(fs.readlinkSync(path.join(home, '.local', 'bin', 'echlon-op')), path.join(dir, 'echlon-op'));
    assert.match(said, /is linked into/);
    assert.ok(!/not on your PATH/.test(said));
  });

  it('says when ~/.local/bin is not searched, and does not link twice', (t) => {
    if (process.platform === 'win32') return t.skip('symlinks need a privilege on Windows');
    const { dir, home } = make();
    addToPath({ dir, platform: 'linux', env: { PATH: '/usr/bin' }, home });
    const again = addToPath({ dir, platform: 'linux', env: { PATH: '/usr/bin' }, home });
    assert.match(again, /not on your PATH yet/);
    assert.equal(fs.readdirSync(path.join(home, '.local', 'bin')).length, 1);
  });
});
