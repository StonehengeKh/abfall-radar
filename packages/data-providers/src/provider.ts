import type { CollectionEvent, District } from '@abfall-radar/domain';

export interface ScheduleProvider {
  readonly id: string;
  readonly name: string;
  getDistricts(): Promise<District[]>;
  getSchedule(districtId: string, referenceDate?: Date): Promise<CollectionEvent[]>;
}
