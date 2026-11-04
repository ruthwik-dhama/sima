import { createRoot } from 'react-dom/client';
import { App } from '@/components/panel/App';
import '@/styles/globals.css';

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
