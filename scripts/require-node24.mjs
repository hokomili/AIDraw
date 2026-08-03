import process from 'node:process';

const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  process.stderr.write([
    `AIDraw requires Node 24.x for packaging and formal QA; current runtime is ${process.version}.`,
    'Electron Packager can terminate during extraction with a misleading exit code 0 under unsupported Node releases.',
    'Activate the version pinned in .nvmrc, then rerun the command.',
    '',
  ].join('\n'));
  process.exitCode = 1;
} else {
  process.stdout.write(`AIDraw runtime preflight: ${process.version}\n`);
}
