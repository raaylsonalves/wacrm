import type { Metadata } from 'next';
import { Newsreader } from 'next/font/google';
import { redirect } from 'next/navigation';
import { Landing } from '@/components/landing/landing';

// "/" is the app's front door. By default it goes straight to the
// dashboard (the middleware turns that into /login for visitors). A
// deployment that also serves its own storefront sets
// NEXT_PUBLIC_LANDING_PAGE=on: visitors then get the marketing page and
// signed-in users still skip it (middleware redirects "/" for them).
// Off by default so other installs of this template never show it.
const LANDING_ON = process.env.NEXT_PUBLIC_LANDING_PAGE === 'on';

const serif = Newsreader({
  variable: '--font-landing-serif',
  subsets: ['latin'],
  weight: ['400', '500'],
  style: ['normal', 'italic'],
});

export const metadata: Metadata = LANDING_ON
  ? {
      title: {
        absolute:
          'Nordia CRM — atendimento, agenda e vendas no WhatsApp com IA',
      },
      description:
        'A IA responde seus clientes no WhatsApp, marca horários e qualifica leads. Sua equipe assume quando precisa, com todo o histórico no CRM.',
      robots: { index: true, follow: true },
    }
  : {};

export default function RootPage() {
  if (!LANDING_ON) redirect('/dashboard');
  return (
    <div className={serif.variable}>
      <Landing />
    </div>
  );
}
