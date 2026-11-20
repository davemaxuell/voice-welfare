const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Arch } = require('electron-builder');

// Native Python wheels, Chromium and Electron must all match the target machine.
exports.default = ({ packager, appOutDir, electronPlatformName, arch }) => {
  if (electronPlatformName !== process.platform || Arch[arch] !== process.arch) {
    throw new Error('Build the installer on a machine matching the target OS and architecture.');
  }
  const root = path.resolve(__dirname, '../../..');
  const runtime = path.join(packager.getResourcesDir(appOutDir), 'runtime');
  execFileSync('uv', [
    'run', '--isolated', '--no-project', '--managed-python', '--python', '3.12',
    'python', path.join(__dirname, 'runtime.py'), runtime, process.arch,
  ], { cwd: root, stdio: 'inherit', windowsHide: true });
};
