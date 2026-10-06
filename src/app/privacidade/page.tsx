import type { Metadata } from 'next';
import { Newsreader } from 'next/font/google';
import { LegalPage } from '@/components/landing/legal-page';

const serif = Newsreader({
  subsets: ['latin'],
  variable: '--font-landing-serif',
});

export const metadata: Metadata = {
  title: 'Privacidade e LGPD — Nordia CRM',
  description:
    'Como a Nordia Tech trata dados pessoais no Nordia CRM, e os direitos do titular.',
  robots: { index: true, follow: true },
};

export default function PrivacidadePage() {
  return (
    <div className={serif.variable}>
      <LegalPage
        title="Privacidade e LGPD"
        intro="Esta política explica quais dados a Nordia Tech trata no Nordia CRM, para quê, com quem compartilha e como você exerce seus direitos pela Lei Geral de Proteção de Dados (Lei 13.709/2018)."
      >
        <section>
          <h2>1. Quem é quem</h2>
          <ul>
            <li>
              A <b>Nordia Tech</b> é <b>controladora</b> dos dados de quem cria
              a conta e contrata o serviço (nome, e-mail, dados de cobrança).
            </li>
            <li>
              Sobre os contatos e as conversas que você coloca no CRM, a Nordia
              Tech é <b>operadora</b>: trata esses dados só para prestar o
              serviço e seguindo as suas instruções. A controladora desses dados
              é a sua empresa.
            </li>
          </ul>
        </section>
        <section>
          <h2>2. Dados que tratamos</h2>
          <ul>
            <li>
              <b>Conta:</b> nome, e-mail, senha (guardada com hash) e papel do
              usuário.
            </li>
            <li>
              <b>Contratação e cobrança:</b> plano, ciclo, forma de pagamento e
              o status das cobranças. Dados de cartão e do Pix ficam com o
              Mercado Pago; não os armazenamos.
            </li>
            <li>
              <b>Uso do CRM:</b> contatos, conversas, mídias, agenda, negócios e
              registros de campanhas que você cria ou recebe pelo WhatsApp.
            </li>
            <li>
              <b>Formulário do site:</b> nome, WhatsApp e o serviço de
              interesse, usados só para retornar o seu contato.
            </li>
            <li>
              <b>Técnicos:</b> endereço IP, navegador e registros de acesso,
              para segurança e prevenção de abuso.
            </li>
          </ul>
        </section>
        <section>
          <h2>3. Para que usamos</h2>
          <p>
            Prestar o serviço contratado, cobrar, dar suporte, manter a
            segurança, cumprir obrigações legais e responder a quem nos procura.
            As bases legais são a execução de contrato, o cumprimento de
            obrigação legal, o legítimo interesse (segurança e prevenção a
            fraudes) e, quando for o caso, o consentimento. Não vendemos dados.
          </p>
        </section>
        <section>
          <h2>4. Com quem compartilhamos</h2>
          <ul>
            <li>
              Meta (WhatsApp Business Platform), para enviar e receber
              mensagens.
            </li>
            <li>
              Supabase e Vercel, para banco de dados, arquivos e hospedagem.
            </li>
            <li>Mercado Pago, para processar Pix e cartão.</li>
            <li>
              OpenAI ou Anthropic, <b>apenas se você ativar a IA</b> com a sua
              própria chave; o conteúdo das conversas atendidas pela IA é
              enviado ao provedor escolhido.
            </li>
          </ul>
          <p>
            Alguns desses fornecedores operam fora do Brasil; a transferência
            acontece com as garantias previstas no art. 33 da LGPD.
          </p>
        </section>
        <section>
          <h2>5. Quem a sua empresa contata</h2>
          <p>
            Como controladora dos contatos, a sua empresa precisa de base legal
            para abordá-los. O CRM ajuda: cada campanha registra a base legal e
            a origem, quem pede para sair deixa de receber mensagens e é
            possível anonimizar um contato a qualquer momento.
          </p>
        </section>
        <section>
          <h2>6. Quanto tempo guardamos</h2>
          <p>
            Enquanto a conta estiver ativa. Após o encerramento, apagamos os
            dados em até 30 dias, exceto o que a lei exigir guardar (por
            exemplo, registros fiscais e de acesso por 6 meses, conforme o Marco
            Civil da Internet).
          </p>
        </section>
        <section>
          <h2>7. Segurança</h2>
          <p>
            Isolamento de dados por conta, senhas com hash, chaves de integração
            criptografadas, tráfego protegido por HTTPS e controle de acesso por
            papéis. Nenhum sistema é infalível; em caso de incidente relevante,
            avisamos os afetados e a ANPD, nos termos da lei.
          </p>
        </section>
        <section>
          <h2>8. Seus direitos</h2>
          <p>
            Você pode pedir confirmação do tratamento, acesso, correção,
            anonimização, portabilidade, eliminação, informação sobre
            compartilhamentos e revogação de consentimento (art. 18 da LGPD). Se
            o seu dado está no CRM de um cliente nosso, o pedido deve ir
            primeiro à empresa que falou com você; nós a ajudamos a atender.
          </p>
        </section>
        <section>
          <h2>9. Cookies</h2>
          <p>
            Usamos apenas cookies essenciais, para manter você conectado e
            lembrar preferências de tema. Não usamos cookies de publicidade.
          </p>
        </section>
        <section>
          <h2>10. Mudanças</h2>
          <p>
            Esta política pode ser atualizada. A versão vigente fica sempre
            aqui, com a data da última revisão.
          </p>
        </section>
      </LegalPage>
    </div>
  );
}
