import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DemoCertificates {
  readonly directory: string;
  readonly ca: string;
  readonly key: string;
  readonly certificate: string;
}

/** Fresh synthetic CA and leaf, never installed in an OS trust store. */
export function demoCertificates(root: string): DemoCertificates {
  const directory = mkdtempSync(join(root, 'tls-'));
  const bundled = 'C:/Program Files/Git/usr/bin/openssl.exe';
  const executable = existsSync(bundled) ? bundled : 'openssl';
  const run = (...args: string[]) =>
    execFileSync(executable, args, {
      cwd: directory,
      stdio: 'pipe',
      windowsHide: true,
    });
  writeFileSync(
    join(directory, 'ca.cnf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Don Gaston Synthetic Test CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n',
    { mode: 0o600 },
  );
  writeFileSync(
    join(directory, 'leaf.cnf'),
    '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=don-gaston.test\n[server]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:don-gaston.test\n',
    { mode: 0o600 },
  );
  run(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '2',
    '-config',
    'ca.cnf',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
  );
  run(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-config',
    'leaf.cnf',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr',
  );
  run(
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    'leaf.cnf',
    '-extensions',
    'server',
    '-out',
    'leaf.pem',
  );
  return {
    directory,
    ca: readFileSync(join(directory, 'ca.pem'), 'utf8'),
    key: readFileSync(join(directory, 'leaf.key'), 'utf8'),
    certificate: readFileSync(join(directory, 'leaf.pem'), 'utf8'),
  };
}
