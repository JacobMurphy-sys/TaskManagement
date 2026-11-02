#!/usr/bin/env node
'use strict';
// Refreshes the commits-per-day on the timeline page (docs/data.js) from this repository's git
// history:   node scripts/timeline-activity.js
// (A shallow clone only knows its recent commits: run `git fetch --unshallow` first.)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const counts = {};
for (const d of execSync('git log --format=%ad --date=short', { encoding: 'utf8' }).split('\n').filter(Boolean)) counts[d] = (counts[d] || 0) + 1;
const sorted = Object.fromEntries(Object.keys(counts).sort().map((d) => [d, counts[d]]));
const file = path.join(__dirname, '..', 'docs', 'data.js');
const src = fs.readFileSync(file, 'utf8');
const out = src.replace(/\/\*activity\*\/[\s\S]*?\/\*end\*\//, `/*activity*/${JSON.stringify(sorted)}/*end*/`);
fs.writeFileSync(file, out);
console.log(`${Object.values(sorted).reduce((a, b) => a + b, 0)} commits over ${Object.keys(sorted).length} days written to docs/data.js`);
