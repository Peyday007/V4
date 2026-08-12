import type { ProcessKind, ProcessVersion } from '@prisma/client';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';

/**
 * Versions of the things that influence how work is done.
 *
 * Scripts, outreach copy, proof-step policy, prompts. The rule the whole file
 * exists to serve: whatever influenced a piece of work is knowable six weeks
 * later, exactly, without reconstructing it from a changelog. So versions are
 * written and retired rather than edited, and the version in force is recorded
 * on the work at the time.
 *
 * Two hard limits on what an editable version may contain:
 *
 *   It cannot change a compliance or authority rule. Calling hours, consent,
 *   do-not-contact, approval thresholds and permission checks live in code,
 *   are not variables, and nothing here is consulted for them. An owner
 *   editing copy must not be able to edit their way past a gate.
 *
 *   It cannot reference a variable nobody declared. An unknown variable is
 *   rejected at save time, because the alternative is discovering it as an
 *   empty string in a message already sent to a buyer.
 */

/**
 * Words that would change what the system is allowed to do rather than what it
 * says. Present in a body, the save is refused.
 *
 * Crude on purpose. This is a backstop, not the control — the control is that
 * none of these rules reads from `ProcessVersion` at all. It exists to catch
 * the case where somebody writes an instruction believing it will be obeyed,
 * so they find out at save time rather than assuming a rule changed.
 */
const AUTHORITY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(ignore|bypass|skip|override|disable)\b[^.]{0,40}\b(compliance|consent|dnc|do.not.contact|approval|permission|calling hours|suppression)\b/i,
    'It asks to bypass a compliance or authority rule.'],
  [/\b(call|contact|dial)\b[^.]{0,30}\b(any ?time|24\/7|outside (business )?hours|at night)\b/i,
    'It asks for contact outside the calling window.'],
  [/\bguarantee(d)?\b[^.]{0,40}\b(price|saving|result|outcome|delivery)\b/i,
    'It makes a guarantee the system cannot stand behind.'],
  [/\bapprove\b[^.]{0,30}\b(automatically|without|yourself)\b/i,
    'It asks for an approval to be granted without a person.'],
];

export type VersionRefusal = {
  ok: false;
  kind: 'unknown_variable' | 'authority' | 'not_found' | 'no_change';
  message: string;
  detail: string[];
};

export type VersionSuccess = { ok: true; version: ProcessVersion };
export type VersionResult = VersionSuccess | VersionRefusal;

/** `{{ variableName }}`, the only interpolation this supports. */
const VARIABLE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function variablesUsed(body: string): string[] {
  return Array.from(new Set(Array.from(body.matchAll(VARIABLE), (m) => m[1])));
}

/**
 * Everything wrong with a proposed body, or nothing.
 *
 * Returns all the problems rather than the first, because an owner fixing one
 * typo at a time through four save attempts stops reading the messages.
 */
export function validateBody(body: string, declared: string[]): string[] {
  const problems: string[] = [];

  const used = variablesUsed(body);
  const unknown = used.filter((name) => !declared.includes(name));
  if (unknown.length > 0) {
    problems.push(
      `Uses ${unknown.length === 1 ? 'a variable' : 'variables'} nobody declared: ${unknown.join(', ')}. `
      + 'An undeclared variable renders as nothing at all, in front of whoever receives it.',
    );
  }

  for (const [pattern, why] of AUTHORITY_PATTERNS) {
    if (pattern.test(body)) problems.push(`${why} Rules like that live in code and are not editable here.`);
  }

  if (body.trim().length === 0) problems.push('It is empty.');

  return problems;
}

/**
 * Render with labelled example data.
 *
 * The labelling is deliberate: a preview filled with plausible-looking fake
 * values is indistinguishable from a real one, and somebody will eventually
 * approve copy believing they saw real data in it. Every substituted value
 * announces itself.
 */
export function preview(body: string, examples: Record<string, string> = {}): string {
  return body.replace(VARIABLE, (_match, name: string) => {
    const value = examples[name];
    return value ? `[${name}: ${value}]` : `[${name}: example value]`;
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function publishVersion(options: {
  orgId: string;
  kind: ProcessKind;
  key: string;
  label: string;
  body: string;
  declaredVariables: string[];
  notes?: string | null;
  actorId?: string | null;
  /** Make it live immediately. Otherwise it is written and left inactive. */
  activate?: boolean;
}): Promise<VersionResult> {
  const problems = validateBody(options.body, options.declaredVariables);
  if (problems.length > 0) {
    return {
      ok: false,
      kind: problems.some((p) => p.includes('live in code')) ? 'authority' : 'unknown_variable',
      message: 'This version was not saved.',
      detail: problems,
    };
  }

  const created = await prisma.$transaction(async (tx) => {
    const highest = await tx.processVersion.findFirst({
      where: { orgId: options.orgId, kind: options.kind, key: options.key },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, isActive: true },
    });

    // Retire the incumbent first: the partial unique index on `isActive` is
    // checked at the end of each statement, so creating an active row while
    // another is still active fails on the index rather than being tidied up.
    if (options.activate && highest?.isActive) {
      await tx.processVersion.update({
        where: { id: highest.id },
        data: { isActive: false, retiredAt: new Date() },
      });
    }

    const row = await tx.processVersion.create({
      data: {
        orgId: options.orgId,
        kind: options.kind,
        key: options.key,
        version: (highest?.version ?? 0) + 1,
        label: options.label,
        body: options.body,
        declaredVariables: options.declaredVariables,
        notes: options.notes ?? null,
        isActive: options.activate ?? false,
        createdById: options.actorId ?? null,
      },
    });

    if (highest && options.activate) {
      await tx.processVersion.update({ where: { id: highest.id }, data: { supersededById: row.id } });
    }

    return row;
  });

  await audit({
    orgId: options.orgId,
    userId: options.actorId,
    action: options.activate ? 'process.version_published' : 'process.version_drafted',
    entityType: 'ProcessVersion',
    entityId: created.id,
    metadata: { kind: options.kind, key: options.key, version: created.version },
  });

  return { ok: true, version: created };
}

/**
 * Put an earlier version back in force.
 *
 * A rollback creates no new version and rewrites nothing: the earlier row
 * becomes active again and the history still shows the version that was in
 * force in between. A rollback that erased the mistake would also erase the
 * evidence of which work it affected.
 */
export async function rollbackTo(options: {
  orgId: string;
  versionId: string;
  actorId?: string | null;
}): Promise<VersionResult> {
  const target = await prisma.processVersion.findFirst({
    where: { id: options.versionId, orgId: options.orgId },
  });
  if (!target) {
    return { ok: false, kind: 'not_found', message: 'That version is not on this account.', detail: [] };
  }
  if (target.isActive) {
    return { ok: false, kind: 'no_change', message: 'That version is already in force.', detail: [] };
  }

  const restored = await prisma.$transaction(async (tx) => {
    await tx.processVersion.updateMany({
      where: { orgId: options.orgId, kind: target.kind, key: target.key, isActive: true },
      data: { isActive: false, retiredAt: new Date() },
    });
    return tx.processVersion.update({
      where: { id: target.id },
      data: { isActive: true, retiredAt: null },
    });
  });

  await audit({
    orgId: options.orgId,
    userId: options.actorId,
    action: 'process.rolled_back',
    entityType: 'ProcessVersion',
    entityId: restored.id,
    metadata: { kind: target.kind, key: target.key, version: target.version },
  });

  return { ok: true, version: restored };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ResolvedVersion = {
  version: ProcessVersion | null;
  body: string;
  /** 'active' | 'fallback' | 'code_default' */
  source: 'active' | 'fallback' | 'code_default';
  /** Recorded on whatever work this influenced. Null for the code default. */
  versionId: string | null;
};

/**
 * The version in force, with a safe fallback behind it.
 *
 * Three tiers, and the third is why this never returns nothing: the active
 * version, then the shipped fallback, then a default passed in from code. A
 * caller reaching for a script must always get one — a blank screen mid-call
 * because somebody retired a version is a worse failure than slightly stale
 * copy.
 */
export async function resolveVersion(params: {
  orgId: string;
  kind: ProcessKind;
  key: string;
  codeDefault: string;
}): Promise<ResolvedVersion> {
  const active = await prisma.processVersion.findFirst({
    where: { orgId: params.orgId, kind: params.kind, key: params.key, isActive: true },
  });
  if (active) return { version: active, body: active.body, source: 'active', versionId: active.id };

  const fallback = await prisma.processVersion.findFirst({
    where: { orgId: params.orgId, kind: params.kind, key: params.key, isFallback: true },
  });
  if (fallback) return { version: fallback, body: fallback.body, source: 'fallback', versionId: fallback.id };

  return { version: null, body: params.codeDefault, source: 'code_default', versionId: null };
}

export async function versionHistory(params: {
  orgId: string;
  kind: ProcessKind;
  key: string;
}): Promise<ProcessVersion[]> {
  return prisma.processVersion.findMany({
    where: { orgId: params.orgId, kind: params.kind, key: params.key },
    orderBy: { version: 'desc' },
  });
}
