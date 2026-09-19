import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/src/app/app';
import { ThemeProvider } from '@/src/app/theme';
import { LocaleProvider } from '@/src/i18n/context';
import '@/src/app/styles.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('The #root element is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <LocaleProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </LocaleProvider>
  </StrictMode>,
);
