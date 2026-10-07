import type { Metadata } from 'next';
import Link from 'next/link';
import { Newsreader } from 'next/font/google';
import { LegalPage } from '@/components/landing/legal-page';

const serif = Newsreader({
  subsets: ['latin'],
  variable: '--font-landing-serif',
});

export const metadata: Metadata = {
  title: 'Termos de uso — Nordia CRM',
  description:
    'Condições de uso, planos, cobrança e cancelamento do Nordia CRM.',
  robots: { index: true, follow: true },
};

export default function TermosPage() {
  return (
    <div className={serif.variable}>
      <LegalPage
        title="Termos de uso"
        intro="Estes termos regulam o uso do Nordia CRM, serviço da Nordia Tech de atendimento, agenda e vendas pelo WhatsApp. Ao criar uma conta ou assinar um plano, você concorda com eles."
      >
        <section>
          <h2>1. O serviço</h2>
          <p>
            O Nordia CRM reúne caixa de entrada, agenda, funil de negócios,
            prospecção, disparos, automações e agentes de IA sobre o WhatsApp. O
            serviço é entregue pela internet, sem instalação, e evolui com o
            tempo: funcionalidades podem ser criadas, alteradas ou
            descontinuadas, com aviso prévio razoável quando a mudança afetar o
            que você já usa.
          </p>
        </section>
        <section>
          <h2>2. Conta e responsabilidades</h2>
          <ul>
            <li>
              Você informa dados verdadeiros e mantém a senha em sigilo. Tudo o
              que acontece na conta, inclusive pelos usuários que você convida,
              é de sua responsabilidade.
            </li>
            <li>
              Você declara ter base legal para falar com cada contato que
              cadastra, importa ou aborda, e responde pelo conteúdo das
              mensagens que envia.
            </li>
            <li>
              É proibido usar o serviço para spam, golpes, conteúdo ilegal,
              assédio ou para violar as políticas do WhatsApp e da Meta.
            </li>
          </ul>
        </section>
        <section>
          <h2>3. WhatsApp e Meta</h2>
          <p>
            O CRM se conecta ao WhatsApp pela API oficial da Meta ou, a seu
            critério, por um número próprio lido por QR code. As mensagens da
            API oficial são cobradas pela Meta, direto na sua conta, conforme a
            tabela dela. A Nordia Tech não controla as regras da Meta e não
            responde por bloqueios, limites ou suspensões aplicados ao seu
            número, mas orienta o uso para reduzir esse risco. WhatsApp é marca
            da Meta Platforms, Inc.
          </p>
        </section>
        <section>
          <h2>4. Inteligência artificial</h2>
          <p>
            Os agentes de IA respondem dentro das regras que você define e
            funcionam com a chave de um provedor de IA (OpenAI ou Anthropic) que
            você mesmo cadastra. As respostas podem conter erros; cabe a você
            revisar as instruções, os limites e a passagem para a equipe. O
            custo de uso do provedor é seu, direto com ele.
          </p>
        </section>
        <section>
          <h2>5. Planos e preços</h2>
          <p>
            Os planos e valores vigentes estão na seção{' '}
            <Link href="/#planos">Planos</Link> do site. Reajustes só valem para
            as cobranças seguintes e são comunicados com antecedência. Projetos
            sob medida têm orçamento e contrato próprios.
          </p>
        </section>
        <section>
          <h2>6. Cobrança</h2>
          <ul>
            <li>
              <b>Mensal:</b> cobrança todo mês, no Pix recorrente ou no cartão
              de crédito.
            </li>
            <li>
              <b>Anual:</b> equivale a 10 meses de mensalidade distribuídos em
              12 meses, cobrados mensalmente, no Pix ou no cartão. Não há
              pagamento do ano adiantado.
            </li>
            <li>
              Os pagamentos são processados pelo Mercado Pago. A Nordia Tech não
              recebe nem armazena número de cartão.
            </li>
            <li>
              <b>Pix:</b> o Pix de cada mês fica disponível na tela de Cobrança
              3 dias antes do vencimento. Se o vencimento passar sem pagamento,
              a conta fica em atraso por mais 3 dias, com acesso normal, para
              você pagar.
            </li>
            <li>
              <b>Cartão:</b> se a cobrança for recusada, o Mercado Pago tenta de
              novo automaticamente nos dias seguintes. A conta fica em atraso,
              com acesso normal, por até 7 dias, e você pode trocar o cartão na
              tela de Cobrança nesse período.
            </li>
            <li>
              Terminado esse prazo sem pagamento, o acesso ao CRM é suspenso. Os
              dados ficam preservados por 30 dias para você regularizar; ao
              pagar, o acesso volta na hora.
            </li>
          </ul>
        </section>
        <section>
          <h2>7. Teste gratuito</h2>
          <p>
            Não há teste gratuito automático no cadastro. Quem tiver interesse
            pode pedir uma demonstração pelo WhatsApp da Nordia Tech, que libera
            um ambiente de teste por período combinado, sem cobrança.
          </p>
        </section>
        <section>
          <h2>8. Cancelamento e reembolso</h2>
          <ul>
            <li>
              Você cancela quando quiser, nos planos mensal e anual. O
              cancelamento interrompe as cobranças seguintes e o acesso continua
              até o fim do período já pago.
            </li>
            <li>
              Na primeira contratação feita pela internet por pessoa física
              consumidora, vale o direito de arrependimento de 7 dias, com
              devolução do valor pago (art. 49 do Código de Defesa do
              Consumidor).
            </li>
            <li>
              Para pedir o reembolso, fale com a Nordia Tech pelo WhatsApp ou
              pelo e-mail de contato dentro desses 7 dias. A devolução é feita
              pelo Mercado Pago, no mesmo meio de pagamento: no Pix, para a
              conta que pagou; no cartão, como estorno na fatura, conforme o
              prazo do emissor do cartão.
            </li>
            <li>
              Fora isso, não há reembolso de períodos já utilizados nem
              devolução proporcional ao cancelar. Cobranças em duplicidade ou
              feitas por erro nosso são sempre devolvidas.
            </li>
          </ul>
        </section>
        <section>
          <h2>9. Seus dados</h2>
          <p>
            Os dados da sua conta, dos seus contatos e das conversas são seus. A
            Nordia Tech os trata apenas para prestar o serviço, conforme a{' '}
            <Link href="/privacidade">Política de privacidade</Link>. Ao
            cancelar, você pode exportar seus dados; depois de 30 dias do
            encerramento eles são apagados, salvo o que a lei exigir guardar.
          </p>
        </section>
        <section>
          <h2>10. Disponibilidade e limite de responsabilidade</h2>
          <p>
            Trabalhamos para manter o serviço no ar, mas ele depende de
            terceiros (Meta, provedores de nuvem e de IA) e pode ter
            interrupções. A responsabilidade da Nordia Tech fica limitada ao
            valor pago pelo serviço nos 12 meses anteriores ao fato, salvo onde
            a lei não permita essa limitação.
          </p>
        </section>
        <section>
          <h2>11. Mudanças e foro</h2>
          <p>
            Podemos atualizar estes termos; a versão vigente fica sempre nesta
            página, com a data de atualização. Se a mudança for relevante,
            avisamos por e-mail ou dentro do CRM. Fica eleito o foro do
            domicílio do consumidor ou, em contratos entre empresas, o da
            comarca de Fortaleza, CE.
          </p>
        </section>
      </LegalPage>
    </div>
  );
}
