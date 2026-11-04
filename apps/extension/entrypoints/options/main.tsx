import { createRoot } from 'react-dom/client';
import { SettingsPage } from '@/components/SettingsPage';
import '@/styles/globals.css';

createRoot(document.getElementById('root') as HTMLElement).render(<SettingsPage />);
