import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 当前文件：从 android/img 的三张源图重复生成 Android 图标和浅色/深色启动资源。

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(projectRoot, 'android', 'img');
const stagingRoot = join(projectRoot, 'android', '.asset-staging');
const iconStage = join(stagingRoot, 'icon');
const splashStage = join(stagingRoot, 'splash');
const assetsCli = join(
  projectRoot,
  'node_modules',
  '@capacitor',
  'assets',
  'bin',
  'capacitor-assets',
);

const sourceFiles = {
  icon: join(sourceDir, 'icon.png'),
  splashLight: join(sourceDir, 'splash-light.png'),
  splashDark: join(sourceDir, 'splash-dark.png'),
};

// Runs one deterministic Capacitor Assets pass and forwards its output to the caller.
const runAssets = (assetPath, extraArgs = []) => {
  const result = spawnSync(
    process.execPath,
    [assetsCli, 'generate', '--android', '--assetPath', assetPath, ...extraArgs],
    {
      cwd: projectRoot,
      stdio: 'inherit',
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Capacitor Assets exited with code ${result.status ?? 'unknown'}.`);
  }
};

const main = async () => {
  await Promise.all(Object.values(sourceFiles).map((file) => access(file)));
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(iconStage, { recursive: true });
  await mkdir(splashStage, { recursive: true });

  try {
    await Promise.all([
      copyFile(sourceFiles.icon, join(iconStage, 'logo.png')),
      copyFile(sourceFiles.splashLight, join(splashStage, 'splash.png')),
      copyFile(sourceFiles.splashDark, join(splashStage, 'splash-dark.png')),
    ]);

    runAssets(relative(projectRoot, iconStage), [
      '--iconBackgroundColor', '#efedf8',
      '--iconBackgroundColorDark', '#11142b',
      '--splashBackgroundColor', '#efedf8',
      '--splashBackgroundColorDark', '#11142b',
    ]);
    runAssets(relative(projectRoot, splashStage));
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
};

await main();
