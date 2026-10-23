import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/space-grotesk/latin-700.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '../styles.css';

export const metadata: Metadata = {
  title: 'Keel · Deploy watch',
  description: 'Read-only local incident evidence and recovery timeline.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
