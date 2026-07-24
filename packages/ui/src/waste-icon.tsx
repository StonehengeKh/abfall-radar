import {
  BatteryCharging,
  FileText,
  Leaf,
  type LucideIcon,
  PackageOpen,
  Recycle,
  Trash2,
  TreePine,
  TriangleAlert,
} from 'lucide-react';
import type { WasteType } from '@abfall-radar/domain';

const icons: Record<WasteType, LucideIcon> = {
  residual: Trash2,
  bio: Leaf,
  paper: FileText,
  yellow_bag: PackageOpen,
  green_waste: TreePine,
  christmas_tree: TreePine,
  hazardous: TriangleAlert,
  small_electronics: BatteryCharging,
};

const colorClasses: Record<WasteType, string> = {
  residual: 'bg-ar-waste-residual-surface text-ar-waste-residual-text',
  bio: 'bg-ar-waste-bio-surface text-ar-waste-bio-text',
  paper: 'bg-ar-waste-paper-surface text-ar-waste-paper-text',
  yellow_bag: 'bg-ar-waste-packaging-surface text-ar-waste-packaging-text',
  green_waste: 'bg-ar-waste-green-surface text-ar-waste-green-text',
  christmas_tree: 'bg-ar-waste-green-surface text-ar-waste-green-text',
  hazardous: 'bg-ar-waste-hazardous-surface text-ar-waste-hazardous-text',
  small_electronics: 'bg-ar-waste-electronics-surface text-ar-waste-electronics-text',
};

interface WasteIconProps {
  type: WasteType;
  inverted?: boolean;
}

export const WasteIcon = ({ type, inverted = false }: WasteIconProps) => {
  const Icon = icons[type] ?? Recycle;

  return (
    <div
      className={[
        'grid size-10 shrink-0 place-items-center rounded-2xl',
        inverted ? 'bg-ar-on-brand/15 text-ar-on-brand' : colorClasses[type],
      ].join(' ')}
      aria-hidden="true"
    >
      <Icon size={20} strokeWidth={2} />
    </div>
  );
};
