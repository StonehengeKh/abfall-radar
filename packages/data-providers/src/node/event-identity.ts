import { createHash } from 'node:crypto';
import type { WasteType } from '@abfall-radar/domain';

/**
 * Deterministic identity for an official collection event.
 *
 * An event is identified by *what it is*, not by where it sits in a calendar file. An upstream `UID`
 * is never an input: one upstream entry can produce two events, and an upstream identifier can change
 * between refreshes.
 */

export const IDENTITY_DIGEST_LENGTH = 16;

export type TimingKind = 'all_day' | 'time_window';

/**
 * The nine identity members, in the fixed order they are serialized in. `collectionMode` is
 * deliberately absent: the closed variant set makes it a function of `timingKind`, so including it
 * could only restate what that member already fixes.
 */
export interface EventIdentity {
  readonly providerId: string;
  readonly serviceAreaId: string;
  readonly wasteType: WasteType;
  readonly date: string;
  readonly timingKind: TimingKind;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly timeZone: string | null;
  readonly locationName: string | null;
}

/**
 * A JSON array rather than a delimiter join: official text is arbitrary, and a location name that
 * itself contains the delimiter could otherwise forge a member boundary and collide on purpose.
 */
export const buildCanonicalIdentity = (identity: EventIdentity): string =>
  JSON.stringify([
    identity.providerId,
    identity.serviceAreaId,
    identity.wasteType,
    identity.date,
    identity.timingKind,
    identity.startsAt,
    identity.endsAt,
    identity.timeZone,
    identity.locationName,
  ]);

export type DigestFn = (canonical: string) => string;

export const sha256Digest: DigestFn = (canonical) =>
  createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, IDENTITY_DIGEST_LENGTH);

/**
 * A readable `providerId-serviceAreaId-wasteType-date` prefix for operators, followed by a truncated
 * digest of the canonical identity. The whole value is opaque: clients must not parse it.
 *
 * `digest` is a parameter with the real implementation as its default, so a test can force a collision
 * deterministically without a global, an environment variable, or a production-only branch.
 */
export const createEventId = (identity: EventIdentity, digest: DigestFn = sha256Digest): string =>
  `${identity.providerId}-${identity.serviceAreaId}-${identity.wasteType}-${identity.date}-${digest(
    buildCanonicalIdentity(identity),
  )}`;

/** One UTC form for every instant, so the same moment cannot canonicalize two ways. */
export const toUtcInstant = (value: Date): string => {
  const iso = value.toISOString();

  return iso.endsWith('.000Z') ? `${iso.slice(0, -'.000Z'.length)}Z` : iso;
};

/**
 * Trimmed, internal whitespace collapsed, then NFC. Without the normalization the same official name
 * hashes differently depending on how the source happened to encode its diacritics, and a purely
 * cosmetic upstream edit would look like a different place.
 */
export const normalizeLocationName = (raw: string): string =>
  raw.trim().replace(/\s+/g, ' ').normalize('NFC');
