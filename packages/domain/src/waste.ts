import { z } from 'zod';

export const WasteTypeSchema = z.enum([
  'residual',
  'bio',
  'paper',
  'yellow_bag',
  'green_waste',
  'christmas_tree',
  'hazardous',
  'small_electronics',
]);

export type WasteType = z.infer<typeof WasteTypeSchema>;

export const CollectionEventSchema = z.object({
  id: z.string().min(1),
  districtId: z.string().min(1),
  type: WasteTypeSchema,
  date: z.iso.date(),
  title: z.string().min(1),
  source: z.enum(['demo', 'municipal_ics', 'user_rule']),
});

export type CollectionEvent = z.infer<typeof CollectionEventSchema>;

export const DistrictSchema = z.object({
  id: z.string().min(1),
  city: z.string().min(1),
  name: z.string().min(1),
  providerId: z.string().min(1),
});

export type District = z.infer<typeof DistrictSchema>;

export const wasteLabels: Record<WasteType, string> = {
  residual: 'Restabfall',
  bio: 'Biotonne',
  paper: 'Altpapier',
  yellow_bag: 'Gelber Sack',
  green_waste: 'Grünschnitt',
  christmas_tree: 'Weihnachtsbaum',
  hazardous: 'Schadstoffe',
  small_electronics: 'Elektrokleinteile',
};

export const wasteDescriptions: Record<WasteType, string> = {
  residual: 'Graue Tonne',
  bio: 'Braune Tonne',
  paper: 'Papier und Karton',
  yellow_bag: 'Leichtverpackungen',
  green_waste: 'Gartenabfälle',
  christmas_tree: 'Saisonale Sammlung',
  hazardous: 'Mobile Sammlung',
  small_electronics: 'Kleine Elektrogeräte',
};
