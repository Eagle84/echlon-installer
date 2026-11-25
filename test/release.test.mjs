import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A Windows checkout turns line endings into CRLF, so the file is read as the workflow means it.
const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');

describe('the release workflow', () => {
  it('runs only for a version tag, and holds no write permission except in the publishing job', () => {
    assert.match(workflow, /tags: \['v\*'\]/);
    assert.match(workflow, /^permissions:\n {2}contents: read$/m);
    assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
    assert.ok(workflow.indexOf('contents: write') > workflow.indexOf('jobs:'));
  });

  it('tests first and refuses to publish with the placeholder release key', () => {
    assert.ok(workflow.indexOf('npm test') < workflow.indexOf('Refuse to publish') && workflow.indexOf('Refuse to publish') < workflow.indexOf('gh release create'));
    assert.match(workflow, /grep -q REPLACE_WITH_RELEASE_PUBKEY release-pubkey\.txt/);
  });

  it('zips only files that exist, and nothing from the tests or the repository history', () => {
    const line = /zip -r echlon-installer\.zip ([^\n]+)/.exec(workflow)?.[1].split(' ') ?? [];
    assert.ok(line.length > 5);
    for (const entry of line) assert.ok(fs.existsSync(path.join(ROOT, entry)), `${entry} is named in the zip but is not in the repository`);
    assert.ok(!line.some((e) => /test|\.git|node_modules|\.github/.test(e)));
    for (const needed of ['install.bat', 'install.ps1', 'install.sh', 'installer', 'products.json', 'service.txt', 'release-pubkey.txt']) assert.ok(line.includes(needed), `${needed} would be missing from the zip`);
  });

  it('keeps install.sh runnable in the zip and names the asset the website link points at', () => {
    assert.match(workflow, /chmod \+x install\.sh/);
    assert.match(workflow, /releases\/latest\/download\/echlon-installer\.zip/);
    assert.match(workflow, /gh release create "\$GITHUB_REF_NAME" echlon-installer\.zip/);
  });

  it('does not use a secret: the publish step has only the run token', () => {
    assert.ok(!/secrets\./.test(workflow));
  });
});
