// Excerpt from the private production repository, included for illustration.
// It is not runnable on its own: imports refer to modules that are not published here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

async function tsFilesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFilesUnder(full)));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g;

async function importsOf(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8');
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1]!);
}

/**
 * The Android seam (LOYALTY_PROJECT.md §6).
 *
 * Google Wallet shares almost no code with Apple's model, so the port stays
 * cheap only while domain logic is ignorant of .pkpass files. That is easy to
 * violate by accident and invisible in review, so it is asserted instead of
 * merely agreed.
 */
describe('module boundaries', () => {
  it('domain code never imports Apple- or Google-specific modules', async () => {
    const domainFiles = await tsFilesUnder(path.join(SRC, 'domain'));
    const offences: string[] = [];

    for (const file of domainFiles) {
      for (const spec of await importsOf(file)) {
        const resolved = spec.startsWith('.')
          ? path.resolve(path.dirname(file), spec)
          : spec;
        const looksPlatform =
          resolved.includes(path.join(SRC, 'apple')) ||
          resolved.includes(path.join(SRC, 'google')) ||
          /passkit-generator|node-forge|(^|\/)(apple|google)\//.test(spec);
        if (looksPlatform) {
          offences.push(`${path.relative(SRC, file)} imports ${spec}`);
        }
      }
    }

    assert.deepEqual(
      offences,
      [],
      `Domain code must go through the WalletProvider interface:\n  ${offences.join('\n  ')}`,
    );
  });

  it('the WalletProvider interface stays free of platform types', async () => {
    const provider = path.join(SRC, 'wallet', 'provider.ts');
    for (const spec of await importsOf(provider)) {
      assert.ok(
        !/apple|passkit|pkpass|google/i.test(spec),
        `wallet/provider.ts must not import ${spec}`,
      );
    }
  });
});

/**
 * Node runs this service's TypeScript by stripping types, never by compiling
 * them, so any syntax that *emits* code is unusable — parameter properties,
 * `enum`, namespaces, decorators, `import =`.
 *
 * These fail only at runtime, on the file that happens to be imported first,
 * with a message that points at the syntax rather than at the rule. Cheaper to
 * catch here.
 */
describe('runtime-strippable TypeScript', () => {
  const OFFENDERS: Array<{ name: string; re: RegExp }> = [
    // constructor(private x: T) / (readonly x: T) / (public x: T)
    { name: 'parameter property', re: /constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w+\s*[?:]/s },
    { name: 'enum declaration', re: /^\s*(export\s+)?(const\s+)?enum\s+\w+/m },
    { name: 'namespace declaration', re: /^\s*(export\s+)?namespace\s+\w+/m },
    { name: 'import assignment', re: /^\s*import\s+\w+\s*=\s*require\(/m },
    { name: 'decorator', re: /^\s*@[A-Za-z_]\w*\s*\(/m },
  ];

  it('uses no TypeScript syntax that requires a compile step', async () => {
    const files = [
      ...(await tsFilesUnder(SRC)),
      ...(await tsFilesUnder(path.resolve(SRC, '..', 'scripts'))),
    ];
    const offences: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const { name, re } of OFFENDERS) {
        if (re.test(source)) offences.push(`${path.relative(SRC, file)}: ${name}`);
      }
    }

    assert.deepEqual(offences, [], `Not strippable by Node:\n  ${offences.join('\n  ')}`);
  });
});
