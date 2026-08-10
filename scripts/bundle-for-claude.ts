/**
 * Build the Claude Project knowledge bundle in `claude-project/`.
 *
 * A Claude Project has no repo access, so it needs the code pasted in. Doing
 * that by hand goes stale on the first commit, which is worse than not doing it
 * — a confidently wrong answer sourced from a three-week-old `guards.ts` is
 * harder to catch than no answer.
 *
 * Run: npx tsx scripts/bundle-for-claude.ts
 *
 * The hand-written files (00, 01, 02, 03) are NOT generated. Only the source
 * bundles are, and each one stamps the commit it came from.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = 'claude-project';

/** Source bundles: one output file per area, in the order a reader needs them. */
const BUNDLES: Array<{ file: string; title: string; blurb: string; paths: string[] }> = [
  {
    file: '10-source-core-and-db.md',
    title: 'Source — core types, guards, persistence',
    blurb:
      'The trading invariants and the two SQLite stores. `guards.ts` is where the ' +
      'entry/exit asymmetry lives and is the single most important file in the repo. ' +
      '`cursors.ts` holds the gap-fill barrier added in session 25.',
    paths: [
      'src/core/types.ts',
      'src/core/broker.ts',
      'src/core/guards.ts',
      'src/core/config.ts',
      'src/db/cursors.ts',
      'src/db/ledger.ts',
    ],
  },
  {
    file: '11-source-stream-and-parser.md',
    title: 'Source — the feed',
    blurb:
      'How swaps get from the chain into the system. `walletStream.ts` owns the ' +
      'socket, the gap fill, the reconnect chain and the dedupe; `swapParser.ts` ' +
      'turns a transaction into a swap or a reason code.',
    paths: ['src/adapters/walletStream.ts', 'src/adapters/swapParser.ts'],
  },
  {
    file: '12-source-services.md',
    title: 'Source — tracker, digest, recorder',
    blurb:
      '`tracker.ts` is the orchestrator and holds the guard backstop. `soak.ts` is ' +
      'the digest — every alarm threshold in the system is in it. `recorder.ts` ' +
      'writes the session files that every measurement is made from.',
    paths: ['src/services/tracker.ts', 'src/services/soak.ts', 'src/services/recorder.ts'],
  },
  {
    file: '13-source-strategy-and-cli.md',
    title: 'Source — strategy and entry points',
    blurb: 'The only strategy that exists, and how a soak is actually launched.',
    paths: ['src/strategies/mirror.ts', 'src/cli/soak.ts', 'src/cli/orphans.ts'],
  },
];

const commit = execSync('git rev-parse --short HEAD').toString().trim();
const subject = execSync('git log -1 --format=%s').toString().trim();
const stamped = new Date().toISOString().slice(0, 10);

mkdirSync(OUT, { recursive: true });

for (const bundle of BUNDLES) {
  const parts: string[] = [
    `# ${bundle.title}`,
    '',
    `> Generated from commit \`${commit}\` (${subject}) on ${stamped}.`,
    `> Regenerate with \`npx tsx scripts/bundle-for-claude.ts\`. Do not edit by hand.`,
    '',
    bundle.blurb,
    '',
    '## Files in this bundle',
    '',
    ...bundle.paths.map((p) => `- \`${p}\``),
    '',
  ];

  for (const path of bundle.paths) {
    let body: string;
    try {
      body = readFileSync(path, 'utf8');
    } catch {
      parts.push(`---\n\n## \`${path}\`\n\n_missing at generation time_\n`);
      continue;
    }
    parts.push('---', '', `## \`${path}\``, '', '```typescript', body.trimEnd(), '```', '');
  }

  writeFileSync(`${OUT}/${bundle.file}`, parts.join('\n'));
  const lines = parts.join('\n').split('\n').length;
  console.log(`${OUT}/${bundle.file}  ${lines} lines  [${bundle.paths.length} files]`);
}

// A manifest, so a reader can tell at a glance what is NOT in the bundle.
const allSource = execSync("find src -name '*.ts' -not -name '._*' | sort").toString().trim().split('\n');
const included = new Set(BUNDLES.flatMap((b) => b.paths));
const omitted = allSource.filter((p) => !included.has(p));

writeFileSync(
  `${OUT}/14-source-manifest.md`,
  [
    '# Source manifest — what is and is not in this Project',
    '',
    `> Generated from commit \`${commit}\` on ${stamped}.`,
    '',
    'The repo is ~14,000 lines of TypeScript. Bundling all of it would crowd out the',
    'documents that actually explain the system, so the bundle is curated. If a',
    'question turns on a file listed as omitted below, **say so rather than guessing**',
    "— the answer is to ask for that file, not to infer it from its name.",
    '',
    `## Included (${included.size} files)`,
    '',
    ...[...included].sort().map((p) => `- \`${p}\``),
    '',
    `## Omitted (${omitted.length} files)`,
    '',
    ...omitted.map((p) => `- \`${p}\``),
    '',
    '## Tests',
    '',
    'No test files are bundled. There are ~19,700 lines of them and 923 passing tests.',
    'The ones most likely to matter in conversation:',
    '',
    '- `tests/guards.test.ts` — the entry/exit asymmetry',
    '- `tests/walletStream.test.ts` — dedupe, cursor barrier, reconnect',
    '- `tests/deathInjection.test.ts` — socket-death recovery, barrier preconditions',
    '- `tests/soak.test.ts` — the digest and its thresholds',
    '- `tests/replay.test.ts` — byte-identical replay of recorded sessions',
    '',
  ].join('\n'),
);
console.log(`${OUT}/14-source-manifest.md  [${included.size} included, ${omitted.length} omitted]`);
