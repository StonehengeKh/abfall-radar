import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  autoIcons: {
    baseIconPath: 'assets/icon.svg',
    developmentIndicator: 'overlay',
  },
  manifest: {
    name: 'AbfallRadar',
    description: 'Never miss the next waste collection.',
    permissions: ['alarms', 'notifications', 'storage'],
    action: {
      default_title: 'AbfallRadar',
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
