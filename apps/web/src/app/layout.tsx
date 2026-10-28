import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'AI BRAIN',
    template: '%s · AI BRAIN',
  },
  description:
    'An open-source, local-first personal intelligence operating system. Your projects, knowledge and resources in one place you own.',
  applicationName: 'AI BRAIN',
  // A personal data system should not ask search engines to index itself.
  robots: { index: false, follow: false },
  icons: {
    icon: [
      {
        url:
          'data:image/svg+xml,' +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#080b10"/><circle cx="16" cy="16" r="6.5" fill="none" stroke="#61d7e8" stroke-width="2"/><circle cx="16" cy="16" r="2" fill="#61d7e8"/><path d="M16 3v6M16 23v6M3 16h6M23 16h6" stroke="#26323d" stroke-width="2"/></svg>`,
          ),
        type: 'image/svg+xml',
      },
    ],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#080b10',
  colorScheme: 'dark light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Applies the stored theme before first paint, so a user on the light
          theme never sees a dark flash. Inline because it must run before the
          document renders.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('ai-brain-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body>
        <a href="#main" className="skip-link">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
