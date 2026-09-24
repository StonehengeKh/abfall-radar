import { createHash } from 'node:crypto';
import type {
  HouseholdCollectionRules,
  HouseholdRuleChecks,
  RuleVerification,
} from '@abfall-radar/domain';
import type { SourceOrigin } from '../../source';
import type { Clock, FetchLike } from '../dependencies';
import { systemClock, systemFetch } from '../dependencies';
import {
  KOBLENZ_HOUSEHOLD_RULES,
  KOBLENZ_HOUSEHOLD_TABLE_DIGEST,
  KOBLENZ_HOUSEHOLD_TABLE_URL,
  KOBLENZ_PARITY_CLAIM_DIGEST,
  KOBLENZ_SCHEDULE_PAGE_URL,
} from './household-rules';

/**
 * What can be checked automatically, and — just as importantly — what cannot.
 *
 * The rules are a maintained transcription of two published documents: a sentence on the schedule page
 * and an image linked from it. Three things about those documents can be checked by a machine, and they
 * are checked separately because they fail separately:
 *
 * 1. **the table** — the linked image is byte-for-byte the one that was transcribed;
 * 2. **the parity claim** — the page still says brown in even weeks, grey in odd, *for the same year*;
 * 3. **the link** — the page still points at that same table, rather than at a new year's.
 *
 * Each document's **representation** is checked before any of that: an image for the table, HTML for the
 * page. A digest establishes only that bytes match, so without this a response of the wrong type that
 * happened to carry the pinned bytes — from a proxy, an error endpoint, or a changed origin — would be
 * reported as a freshly verified schedule.
 *
 * Checking only the first would have been misleading in two ways a reviewer named exactly: the operator
 * could change the parity sentence while the image stayed put, or publish
 * `feiertagsverlegungen-2027.jpg` and leave the 2026 file exactly where it is — and a digest check of a
 * URL nobody links any more would keep answering "verified" about a document nobody is being shown.
 *
 * **What is not checked at all: later announcements.** The operator publishes per-holiday notices that
 * restate, and could in principle amend, a row of the annual table. They are free prose on a news page,
 * and a parser guessing at them would be a machine inventing collection dates. They are a documented
 * human responsibility, and the transcription records how far they have been reviewed.
 */

/** The same deadline the calendar retrieval uses; a slow check must not hold a request open. */
export const VERIFICATION_DEADLINE_MS = 5_000;

/** A published image is small; anything larger is not the table and is refused before it is read. */
export const MAX_TABLE_BYTES = 4 * 1024 * 1024;

/** The schedule page is a page; a response far larger than one is not it. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * The representations each document may arrive as.
 *
 * Checked **before** anything is hashed or parsed, because a digest proves only that some bytes match —
 * not that they are the document they were taken from. A proxy, an error page or a changed origin can
 * serve a representation that happens to contain the pinned bytes or the expected phrases, and calling
 * that "verified" would describe the transcription as freshly checked against something it never saw.
 *
 * `image/jpg` is not a registered type, but it is common enough in the wild that refusing it would report
 * a source change where there is none; both name the same representation.
 */
export const TABLE_MEDIA_TYPES = ['image/jpeg', 'image/jpg'] as const;

export const PAGE_MEDIA_TYPES = ['text/html', 'application/xhtml+xml'] as const;

/**
 * The media type alone: lower-cased, with parameters and whitespace removed.
 *
 * `Content-Type: TEXT/HTML; charset=UTF-8` and `text/html` are the same representation, and a check that
 * treated them differently would fail on an ordinary server rather than on a wrong one. A header that is
 * absent entirely yields `null`, which is never accepted: a response that does not say what it is has not
 * established what it is.
 */
export const mediaTypeOf = (response: Response): string | null => {
  const header = response.headers.get('content-type');

  if (header === null) {
    return null;
  }

  const type = header.split(';')[0]?.trim().toLowerCase() ?? '';

  return type === '' ? null : type;
};

/**
 * The one origin this module may contact, pinned the way every other municipal fetch is: scheme,
 * hostname and effective port, so neither a downgrade nor a different port on the same name is reachable.
 */
const KOBLENZ_ORIGIN: SourceOrigin = {
  scheme: 'https',
  hostname: 'servicebetrieb.koblenz.de',
  port: 443,
};

const isApprovedOrigin = (url: URL): boolean =>
  url.protocol === `${KOBLENZ_ORIGIN.scheme}:` &&
  url.hostname === KOBLENZ_ORIGIN.hostname &&
  (url.port === '' ? 443 : Number(url.port)) === KOBLENZ_ORIGIN.port;

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value))
    .digest('hex');

interface Retrieved {
  readonly ok: true;
  readonly body: ArrayBuffer;
}

type Retrieval = Retrieved | { readonly ok: false };

/**
 * One bounded, origin-pinned retrieval.
 *
 * Every failure is the same answer — it could not be read — because that is all a failed fetch says. It
 * is never an assertion about the document's content.
 */
const retrieve = async (
  url: string,
  fetchImpl: FetchLike,
  maxBytes: number,
  accepted: readonly string[],
): Promise<Retrieval> => {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return { ok: false };
  }

  if (!isApprovedOrigin(parsed)) {
    // These URLs are constants in this repository, so reaching here means a constant is wrong. Refusing
    // is the only safe answer: it must never fetch an origin nobody approved.
    return { ok: false };
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
  }, VERIFICATION_DEADLINE_MS);

  try {
    const response = await fetchImpl(parsed.toString(), {
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);

      return { ok: false };
    }

    const mediaType = mediaTypeOf(response);

    if (mediaType === null || !accepted.includes(mediaType)) {
      /*
       * Not the document this check is about. Refused before the body is read, and reported as "could
       * not be checked" rather than as a change: a wrong representation says nothing about whether the
       * operator altered the rules, only that this response did not establish anything.
       */
      await response.body?.cancel().catch(() => undefined);

      return { ok: false };
    }

    const body = await response.arrayBuffer();

    return body.byteLength > maxBytes ? { ok: false } : { ok: true, body };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(deadline);
  }
};

/**
 * The operator's parity claim, reduced to the three facts it makes.
 *
 * Deliberately **not** a digest of the page: a page carries navigation, campaigns and cookie notices
 * that change weekly, and a fingerprint of all that would cry wolf until nobody looked. This extracts
 * the year the rule is stated for and which bin each week parity carries, and fingerprints only those.
 * A cosmetic edit leaves it identical; changing the rule, or the year it applies to, does not.
 */
export const parityClaimOf = (pageHtml: string): string | null => {
  const text = pageHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .join(' ');

  const years = [...text.matchAll(/gilt für (\d{4})/g)].map((match) => `gilt-fuer:${match[1]}`);
  const parity = [
    ...text.matchAll(
      /in (geraden|ungeraden) kalenderwochen:\s*abfuhr(?: der)? (braune|grauen) tonne/g,
    ),
  ].map((match) => `${match[1]}:${match[2]}`);

  // Both halves of the rule must be found, or the page no longer states what was transcribed from it.
  return parity.length < 2 ? null : [...years, ...parity].join('|');
};

/** Every `feiertagsverlegungen-*.jpg` the page links, so a new year's table is visible as a new URL. */
export const linkedTableUrlsOf = (pageHtml: string): string[] => [
  ...new Set(
    [...pageHtml.matchAll(/https:\/\/[^"'\s<>]*feiertagsverlegungen[^"'\s<>]*/gi)].map(
      (match) => match[0],
    ),
  ),
];

export interface VerifyHouseholdRuleSourceOptions {
  readonly fetch?: FetchLike;
  readonly expectedTableDigest?: string;
  readonly expectedParityDigest?: string;
  readonly tableUrl?: string;
  readonly pageUrl?: string;
}

/**
 * Runs the three checks and reports each one.
 *
 * Deliberately total: no failure throws. The caller is answering a request for rules that were already
 * transcribed, and being unable to *check* a source is not a reason to withhold them — it is a reason to
 * say they could not be checked.
 */
export const verifyHouseholdRuleSource = async ({
  fetch: fetchImpl = systemFetch,
  expectedTableDigest = KOBLENZ_HOUSEHOLD_TABLE_DIGEST,
  expectedParityDigest = KOBLENZ_PARITY_CLAIM_DIGEST,
  tableUrl = KOBLENZ_HOUSEHOLD_TABLE_URL,
  pageUrl = KOBLENZ_SCHEDULE_PAGE_URL,
}: VerifyHouseholdRuleSourceOptions = {}): Promise<HouseholdRuleChecks> => {
  const [table, page] = await Promise.all([
    retrieve(tableUrl, fetchImpl, MAX_TABLE_BYTES, TABLE_MEDIA_TYPES),
    retrieve(pageUrl, fetchImpl, MAX_PAGE_BYTES, PAGE_MEDIA_TYPES),
  ]);

  const tableCheck: RuleVerification = !table.ok
    ? 'unverified'
    : sha256(new Uint8Array(table.body)) === expectedTableDigest
      ? 'verified'
      : 'changed';

  if (!page.ok) {
    return { table: tableCheck, parityRule: 'unverified', tableLink: 'unverified' };
  }

  const html = new TextDecoder('utf-8').decode(page.body);
  const claim = parityClaimOf(html);
  const linked = linkedTableUrlsOf(html);

  return {
    table: tableCheck,
    /*
     * A page that no longer states the rule at all is `changed`, not `unverified`: it was read, and what
     * was transcribed from it is not there any more.
     */
    parityRule:
      claim === null ? 'changed' : sha256(claim) === expectedParityDigest ? 'verified' : 'changed',
    /*
     * The transcribed table must still be the one the page offers. A page linking a different table —
     * next year's, typically — has moved on, whatever the old file still contains.
     */
    tableLink: linked.length === 0 ? 'changed' : linked.includes(tableUrl) ? 'verified' : 'changed',
  };
};

/**
 * One word for the three checks, for a client that shows a single state.
 *
 * `changed` dominates, because one changed document is enough to make the transcription out of date, and
 * `verified` requires all three: saying "verified" while one check could not run would describe the
 * schedule as freshly verified when only part of it was.
 */
export const overallVerification = (checks: HouseholdRuleChecks): RuleVerification => {
  const states = [checks.table, checks.parityRule, checks.tableLink];

  if (states.includes('changed')) {
    return 'changed';
  }

  return states.every((state) => state === 'verified') ? 'verified' : 'unverified';
};

export interface HouseholdRulesOptions {
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
}

/**
 * The Koblenz household rules with the verification state established at read time.
 *
 * `checkedAt` is the moment the checks ran, not the moment the transcription was made: a client showing
 * "checked at" is saying how current the *check* is. How current the reading is, is the revision and the
 * date through which announcements were reviewed.
 */
export const getKoblenzHouseholdRules = async ({
  fetch: fetchImpl = systemFetch,
  clock = systemClock,
}: HouseholdRulesOptions = {}): Promise<HouseholdCollectionRules> => {
  const checks = await verifyHouseholdRuleSource({ fetch: fetchImpl });

  return {
    ...KOBLENZ_HOUSEHOLD_RULES,
    checkedAt: clock.now().toISOString(),
    checks,
    verification: overallVerification(checks),
  };
};
