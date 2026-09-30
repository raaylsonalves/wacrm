import { describe, it, expect } from 'vitest';
import { parseSummary, summaryPromptSection } from './summary';

describe('parseSummary', () => {
  it('reads the two sections', () => {
    const r = parseSummary(
      'RESUMO:\nMaria quer simular um consignado.\nJá enviamos a taxa.\nPROXIMO_PASSO:\nEnviar a simulação de 24x.'
    );
    expect(r).toEqual({
      summary: 'Maria quer simular um consignado.\nJá enviamos a taxa.',
      next_step: 'Enviar a simulação de 24x.',
    });
  });

  it('tolerates markdown bold, accents and inline headings', () => {
    const r = parseSummary(
      '**RESUMO:** Cliente pediu preço.\n**PRÓXIMO PASSO:** Ligar amanhã.'
    );
    expect(r?.summary).toBe('Cliente pediu preço.');
    expect(r?.next_step).toBe('Ligar amanhã.');
  });

  it('keeps a summary even when the next step is missing', () => {
    expect(parseSummary('RESUMO:\nSó isso.')).toEqual({
      summary: 'Só isso.',
      next_step: '',
    });
  });

  it('returns null when there is no summary at all', () => {
    expect(parseSummary('Claro! Aqui vai uma resposta solta.')).toBeNull();
  });

  it('prompt states the output contract', () => {
    expect(summaryPromptSection()).toContain('PROXIMO_PASSO:');
  });
});
