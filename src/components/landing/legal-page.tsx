import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './landing.css';

// Shared shell of the public legal pages (/termos, /privacidade). Server
// component: no state, nothing here needs the browser.

const SITE_URL = 'https://nordiatech.com.br';
const SALES_WHATSAPP = (process.env.NEXT_PUBLIC_SALES_WHATSAPP ?? '').replace(
  /\D/g,
  ''
);
const CNPJ = process.env.NEXT_PUBLIC_COMPANY_CNPJ ?? '';

export const LEGAL_UPDATED = '6 de outubro de 2026';

export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="lp lp-legal">
      <header className="lp-legal-head">
        <Link href="/" aria-label="Nordia CRM">
          <Image
            src="/landing/nordia-logo.png"
            alt="Nordia"
            width={120}
            height={30}
            style={{ height: 30, width: 'auto' }}
          />
        </Link>
        <Link href="/" className="lp-btn lp-btn-line" style={{ minHeight: 40 }}>
          Voltar ao site
        </Link>
      </header>
      <main className="lp-legal-body">
        <h1>{title}</h1>
        <p className="lp-legal-meta">Atualizado em {LEGAL_UPDATED}</p>
        <p className="lp-legal-intro">{intro}</p>
        {children}
        <section>
          <h2>Contato</h2>
          <p>
            Dúvidas, pedidos de titulares de dados e cancelamentos: fale com a
            Nordia Tech pelo{' '}
            {SALES_WHATSAPP ? (
              <a
                href={`https://wa.me/${SALES_WHATSAPP}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                WhatsApp
              </a>
            ) : (
              'WhatsApp'
            )}{' '}
            ou pelo site{' '}
            <a href={SITE_URL} target="_blank" rel="noopener noreferrer">
              nordiatech.com.br
            </a>
            .{CNPJ ? ` CNPJ ${CNPJ}.` : ''}
          </p>
        </section>
      </main>
    </div>
  );
}
