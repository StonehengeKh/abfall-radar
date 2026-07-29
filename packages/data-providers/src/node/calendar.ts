import { sync } from 'node-ical';
import { type CollectionSourceManifest, SourceFailureError } from '../source';

/**
 * RFC 5545 parsing and calendar-level attestation.
 *
 * Only `node-ical`'s string-parsing API is used. Its URL-fetching helpers are deliberately avoided,
 * because retrieval has to stay inside the bounded, allowlisted boundary in `./retrieval`.
 *
 * The parse result is narrowed with explicit runtime guards rather than trusted through the library's
 * type declarations: it is untrusted third-party output describing untrusted third-party input.
 */

/** One upstream `VEVENT`, reduced to the members normalization is allowed to see. */
export interface CalendarEntry {
  readonly summary: string;
  readonly location: string | undefined;
  /** `true` for a `VALUE=DATE` entry. This is the timing-form discriminator. */
  readonly isDateOnly: boolean;
  readonly start: Date;
  /**
   * Beware: `node-ical` synthesizes `end === start` for an entry with no `DTEND`, so a present value
   * does not mean the source attested one. Normalization requires a positive window rather than a
   * merely defined `end`.
   */
  readonly end: Date | undefined;
  /** Kept for untrusted-source logging only. It is never an identity input and never leaves the adapter. */
  readonly uid: string;
}

export interface ParsedCalendar {
  /** The zone the calendar itself attested, already checked against the manifest. */
  readonly timeZone: string;
  readonly entries: readonly CalendarEntry[];
}

const ZONE_DECLARATION = /^X-WR-TIMEZONE[;:]/i;

const VEVENT_BEGIN = /^BEGIN:VEVENT\s*$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A `TextDecoder` already strips a byte-order mark, but a calendar handed over as a string can still
 * carry one as a literal character, which would make the first property name unrecognizable.
 */
const stripBom = (body: string): string => (body.startsWith('﻿') ? body.slice(1) : body);

/**
 * Joins RFC 5545 folded continuation lines, which begin with a space or a tab. Needed so a property
 * split across lines is counted once and recognized at all.
 */
const unfold = (body: string): string[] => {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const unfolded: string[] = [];

  for (const line of lines) {
    const previous = unfolded.at(-1);

    if ((line.startsWith(' ') || line.startsWith('\t')) && previous !== undefined) {
      unfolded[unfolded.length - 1] = previous + line.slice(1);
      continue;
    }

    unfolded.push(line);
  }

  return unfolded;
};

const countMatches = (lines: readonly string[], pattern: RegExp): number =>
  lines.filter((line) => pattern.test(line)).length;

/** `SUMMARY`/`LOCATION` arrive as a plain string, or as `{ params, val }` when parameters are present. */
const unwrapText = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }

  if (isRecord(value) && typeof value.val === 'string') {
    return value.val;
  }

  return undefined;
};

const isUsableDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

const readDeclaredZone = (parsed: Record<string, unknown>): string | undefined => {
  const calendar = parsed.vcalendar;

  if (!isRecord(calendar)) {
    return undefined;
  }

  return unwrapText(calendar['WR-TIMEZONE'])?.trim();
};

const toEntry = (event: Record<string, unknown>): CalendarEntry => {
  // The verified source contains no recurrence. Rather than half-support `RRULE`, an entry carrying
  // one fails: expanding it wrongly would invent collection dates.
  if (event.rrule !== undefined || event.recurrences !== undefined) {
    throw new SourceFailureError('recurrence-unsupported');
  }

  const summary = unwrapText(event.summary)?.trim();
  const datetype = event.datetype;
  const start = event.start;
  const end = event.end;

  if (
    summary === undefined ||
    summary === '' ||
    (datetype !== 'date' && datetype !== 'date-time') ||
    !isUsableDate(start) ||
    (end !== undefined && !isUsableDate(end)) ||
    typeof event.uid !== 'string'
  ) {
    throw new SourceFailureError('event-invalid');
  }

  return {
    summary,
    location: unwrapText(event.location),
    isDateOnly: datetype === 'date',
    start,
    end: isUsableDate(end) ? end : undefined,
    uid: event.uid,
  };
};

/**
 * Parses a calendar and attests its declared zone before any entry is returned, so a file with a bad
 * zone yields no event at all rather than a plausible-looking date derived under the wrong assumption.
 */
export const parseCalendar = (
  rawBody: string,
  manifest: CollectionSourceManifest,
): ParsedCalendar => {
  const body = stripBom(rawBody);
  const lines = unfold(body);

  // Counted from the raw text because `node-ical` collapses a repeated property into a single key, so
  // a duplicated declaration is invisible in the parsed object. Two conflicting declarations mean the
  // file does not actually attest one zone, and picking either would be a guess.
  const declarations = countMatches(lines, ZONE_DECLARATION);

  if (declarations === 0) {
    throw new SourceFailureError('zone-missing');
  }

  if (declarations > 1) {
    throw new SourceFailureError('zone-duplicated');
  }

  let parsed: unknown;

  try {
    parsed = sync.parseICS(body);
  } catch {
    throw new SourceFailureError('parse-failed');
  }

  if (!isRecord(parsed)) {
    throw new SourceFailureError('parse-failed');
  }

  const timeZone = readDeclaredZone(parsed);

  // Equality against the manifest, never substitution of it. Falling back to the manifest zone would
  // apply an assumption the source has stopped supporting, which is how every timed date in a
  // schedule shifts by a day with nothing to signal it.
  if (timeZone === undefined || timeZone === '' || timeZone !== manifest.timeZone) {
    throw new SourceFailureError('zone-mismatch');
  }

  const entries: CalendarEntry[] = [];

  for (const value of Object.values(parsed)) {
    if (isRecord(value) && value.type === 'VEVENT') {
      entries.push(toEntry(value));
    }
  }

  // The parse result is keyed by `UID`, so two entries sharing a `UID` would silently collapse into
  // one and shorten the schedule. Comparing against the raw block count makes that loud.
  if (entries.length !== countMatches(lines, VEVENT_BEGIN)) {
    throw new SourceFailureError('parse-failed');
  }

  return { timeZone, entries };
};
