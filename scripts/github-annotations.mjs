// A test reporter for GitHub Actions (node --test --test-reporter=./scripts/github-annotations.mjs): each failing test
// becomes an error annotation with its name, file and error. GitHub shows them on the run's page and gives them through
// its API without a login, where a job's log needs one.
import path from 'node:path';

const data = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// A suite fails when a test in it fails, and the tests after a failed hook or a timeout are cancelled: only the failure
// itself is reported, since GitHub keeps ten error annotations a step.
const FOLLOWS = new Set(['subtestsFailed', 'cancelledByParent']);

export default async function* annotations(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:fail') continue;
    const d = ev.data;
    const err = d.details && d.details.error;
    if (err && FOLLOWS.has(err.failureType)) continue;
    const cause = (err && err.cause) || err;
    const text = cause ? cause.stack || cause.message || String(cause) : 'failed';
    const file = d.file ? path.relative(process.cwd(), d.file).split(path.sep).join('/') : '';
    yield `::error file=${prop(file)},line=${d.line || 1},title=${prop(d.name)}::${data(text.slice(0, 4000))}\n`;
  }
}
