/**
 * Extracts every word spoken in this project's conversation into one file.
 *
 * "Spoken" means what a person would have read on the screen: your messages and
 * my replies. Tool calls, their outputs, and file contents are counted but not
 * reproduced — they would bury the conversation under about thirty megabytes of
 * command output. Reasoning blocks are not in the transcript at all: the log
 * stores their signatures and not their text, so there is nothing to recover.
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const SOURCE = '/root/.claude/projects/-home-user-V4/ed1adce9-e789-5018-bd2c-99e856489d0c.jsonl';
const OUT = process.argv[2] ?? 'docs/conversation-transcript.md';

/** Where each phase of the §18 delivery plan begins. */
/** Nothing before this is in the file. */
const FROM = '2026-08-11T00:00:00Z';

const PHASES = [
  ['2026-08-11T00:00:00Z', 'The run-up — the directive arrives', 'The credibility audit that ended the old discovery model, the visual identity work, the demand engine built from the directive, and the caller workflow. Everything on 11 August and the small hours of the 12th, before the seven phases were named.'],
  ['2026-08-12T03:34:00Z', 'Phase 0 — Name where the machine is stopped', 'Chain health, the production-wiring guard, and an honest account of which stages did not exist.'],
  ['2026-08-12T04:02:00Z', 'Phase 1 — Give callers an identity, a packet, and one call at a time', 'Caller identity, work packets, the after-call gate, incidents that are ours rather than theirs.'],
  ['2026-08-12T06:45:00Z', 'Phase 2 — Carry a deal from what the buyer said to money that arrived', 'Buyer requirement, provider workstream, quote economics, commitment, delivery, payment.'],
  ['2026-08-12T08:04:00Z', 'Phase 3 — A page worth sending, and an honest record of what they did with it', 'The Deal Room, the proof-step ladder, grounded email, follow-up promises.'],
  ['2026-08-12T08:40:00Z', 'Phase 4 — Measure to money that arrived, and refuse to guess', 'The funnel, Wilson intervals, stable experiments, versioned processes.'],
  ['2026-08-12T09:11:00Z', 'Phase 5 — Never manufacture a recording row that implies audio exists', 'Consent by jurisdiction, recording that fails safely, analysis with evidence links, review sampling.'],
  ['2026-08-12T20:19:00Z', 'Phase 6 — Check whether the system broke before asking whether a person did', 'Readiness, circuit breakers, evidence consistency, coaching, restoration, manager briefs.'],
];

const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/**
 * Content the harness injected into a user turn rather than something typed.
 *
 * Kept, because the instruction was every word, but labelled — a compaction
 * summary is machine-written and reading it as your voice would misattribute
 * about a hundred and twenty thousand words.
 */
function classify(text) {
  const t = text.trimStart();
  if (t.startsWith('This session is being continued from a previous conversation')) return 'summary';
  if (t.startsWith('<system-reminder>') || t.startsWith('<command-name>')) return 'injected';
  if (t.startsWith('[Request interrupted')) return 'interrupt';
  if (t.startsWith('Stop hook feedback:')) return 'hook';
  if (t.startsWith('Caveat: The messages below')) return 'injected';
  return 'said';
}

const LABEL = {
  said: 'You',
  summary: 'You — automatic conversation summary (written by the system, not typed)',
  injected: 'You — system-injected note (not typed)',
  interrupt: 'You — interrupted the run',
  hook: 'You — automated hook message (not typed)',
};

const turns = [];
let toolCalls = 0;
let toolResults = 0;

const rl = createInterface({ input: createReadStream(SOURCE), crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  const message = row.message;
  if (!message) continue;
  if (String(row.timestamp ?? '') < FROM) continue;

  if (row.type === 'user') {
    const content = message.content;
    let text = null;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      if (content.some((b) => b.type === 'tool_result')) { toolResults += 1; continue; }
      text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    }
    if (text && text.trim()) {
      turns.push({ at: row.timestamp, who: 'user', kind: classify(text), text: text.trim() });
    }
  } else if (row.type === 'assistant') {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'text' && block.text.trim()) {
        turns.push({ at: row.timestamp, who: 'claude', kind: 'said', text: block.text.trim() });
      } else if (block.type === 'tool_use') {
        toolCalls += 1;
      }
    }
  }
}

turns.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));

// ---------------------------------------------------------------------------
// Split into phases
// ---------------------------------------------------------------------------
const sections = PHASES.map(([start, title, blurb]) => ({
  start, title, blurb, turns: [], words: 0, yours: 0, mine: 0,
}));

for (const turn of turns) {
  const at = String(turn.at ?? '');
  let index = 0;
  for (let i = 0; i < sections.length; i += 1) {
    if (at >= sections[i].start) index = i;
  }
  const section = sections[index];
  section.turns.push(turn);
  const n = words(turn.text);
  section.words += n;
  if (turn.who === 'user') section.yours += n; else section.mine += n;
}

const totalWords = sections.reduce((a, s) => a + s.words, 0);
const totalYours = sections.reduce((a, s) => a + s.yours, 0);
const totalMine = sections.reduce((a, s) => a + s.mine, 0);
const spoken = turns.filter((t) => t.kind === 'said');
const typedByYou = spoken.filter((t) => t.who === 'user');

const stamp = (at) => (at ? at.slice(0, 16).replace('T', ' ') + ' UTC' : 'no timestamp');
const n = (x) => x.toLocaleString('en-US');

const lines = [];

lines.push('# V4 Deal Dispatch — the complete conversation');
lines.push('');
lines.push('Every word said between us from 11 August 2026 to 12 August 2026 — the stretch in which the seven-phase directive arrived and all seven phases were built.');
lines.push('');
lines.push(`**${n(totalWords)} words** across **${n(turns.length)} turns**, ${stamp(turns[0]?.at)} to ${stamp(turns[turns.length - 1]?.at)}.`);
lines.push(`You wrote ${n(totalYours)}, I wrote ${n(totalMine)}. Of your total, ${n(typedByYou.reduce((a, t) => a + words(t.text), 0))} words across ${n(typedByYou.length)} messages were actually typed by you — the rest is automatic conversation summaries and system notes that arrive in your voice and are labelled as such below.`);
lines.push('');
lines.push('## What is in this file, and what is not');
lines.push('');
lines.push('**In it:** every message you sent and every reply I wrote, in order, complete and unedited.');
lines.push('');
lines.push(`**Not in it:** ${n(toolCalls)} tool calls and ${n(toolResults)} tool results — the commands I ran, the files I read and wrote, and their output. That material is about thirty-five megabytes and is not conversation; the work it produced is in the repository, and the summary of it is in what I said afterwards.`);
lines.push('');
lines.push('**Not recoverable:** my reasoning between turns. The transcript stores a cryptographic signature for each reasoning block and not its text, so there is nothing on disk to extract. Six hundred and four of them exist as empty strings.');
lines.push('');
lines.push('## The sections');
lines.push('');
lines.push('| Section | Started | Turns | Words |');
lines.push('| --- | --- | ---: | ---: |');
for (const section of sections) {
  lines.push(`| ${section.title} | ${stamp(section.start)} | ${n(section.turns.length)} | ${n(section.words)} |`);
}
lines.push('');
lines.push('---');
lines.push('');

for (const section of sections) {
  lines.push(`# ${section.title}`);
  lines.push('');
  lines.push(`*${section.blurb}*`);
  lines.push('');
  lines.push(`*${n(section.turns.length)} turns, ${n(section.words)} words — ${n(section.yours)} yours, ${n(section.mine)} mine.*`);
  lines.push('');

  for (const turn of section.turns) {
    const label = turn.who === 'claude' ? 'Claude' : LABEL[turn.kind];
    lines.push(`### ${label} · ${stamp(turn.at)}`);
    lines.push('');
    lines.push(turn.text);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
}

writeFileSync(OUT, lines.join('\n'));
console.log(`${OUT}: ${n(totalWords)} words, ${n(turns.length)} turns, ${n(lines.join('\n').length)} characters.`);
