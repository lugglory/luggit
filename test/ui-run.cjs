const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'luggit-ui-'));
const result = spawnSync(require('electron'), [path.join(__dirname, 'ui-electron.cjs'), '--user-data-dir=' + profile], {
  windowsHide: true, stdio: 'inherit', timeout: 60000,
});
if (path.dirname(path.resolve(profile)) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('luggit-ui-')) throw new Error('Unexpected cleanup path');
fs.rmSync(profile, { recursive: true, force: true });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
