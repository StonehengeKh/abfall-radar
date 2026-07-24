import { addDays, format } from 'date-fns';
import type { CollectionEvent, District, WasteType } from '@abfall-radar/domain';
import type { ScheduleProvider } from './provider';

export const demoDistricts: District[] = [
  {
    id: 'koblenz-stadtmitte',
    city: 'Koblenz',
    name: 'Stadtmitte',
    providerId: 'demo',
  },
  {
    id: 'koblenz-metternich-1',
    city: 'Koblenz',
    name: 'Metternich 1',
    providerId: 'demo',
  },
  {
    id: 'koblenz-karthause-2',
    city: 'Koblenz',
    name: 'Karthause 2',
    providerId: 'demo',
  },
];

const scheduleTemplate: Array<{
  offset: number;
  type: WasteType;
}> = [
  { offset: 1, type: 'yellow_bag' },
  { offset: 4, type: 'paper' },
  { offset: 7, type: 'bio' },
  { offset: 11, type: 'green_waste' },
  { offset: 15, type: 'residual' },
  { offset: 22, type: 'small_electronics' },
];

export const createDemoSchedule = (
  districtId: string,
  referenceDate = new Date(),
): CollectionEvent[] =>
  scheduleTemplate.map(({ offset, type }) => {
    const date = format(addDays(referenceDate, offset), 'yyyy-MM-dd');

    return {
      id: `demo-${districtId}-${type}-${date}`,
      districtId,
      type,
      date,
      title: type,
      source: 'demo',
    };
  });

export const demoScheduleProvider: ScheduleProvider = {
  id: 'demo',
  name: 'Demo provider',
  async getDistricts() {
    return demoDistricts;
  },
  async getSchedule(districtId, referenceDate) {
    return createDemoSchedule(districtId, referenceDate);
  },
};
