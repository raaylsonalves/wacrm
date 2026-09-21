import { describe, it, expect } from 'vitest';
import { isOptOutMessage } from './opt-out';

describe('isOptOutMessage', () => {
  it('matches an isolated stop word, nothing else', () => {
    expect(isOptOutMessage('parar')).toBe(true);
    expect(isOptOutMessage('Pare')).toBe(true);
    expect(isOptOutMessage('STOP')).toBe(true);
    expect(isOptOutMessage('sair')).toBe(true);
    expect(isOptOutMessage('  cancelar  ')).toBe(true);
    expect(isOptOutMessage('parar!')).toBe(true);
    expect(isOptOutMessage('stop.')).toBe(true);
  });

  it('is accent-insensitive', () => {
    expect(isOptOutMessage('cancelár')).toBe(true);
    expect(isOptOutMessage('descadastrar')).toBe(true);
  });

  it('matches a cessation verb with a communication object', () => {
    expect(isOptOutMessage('parar de me mandar mensagens')).toBe(true);
    expect(isOptOutMessage('quero sair da lista')).toBe(true);
    expect(isOptOutMessage('no me escribas más')).toBe(true);
    expect(isOptOutMessage('remove me from the list')).toBe(true);
    expect(isOptOutMessage('cancele o envio de propaganda')).toBe(true);
  });

  it('does not match a stop word used mid-sentence without an object', () => {
    expect(isOptOutMessage('tem como parar a dor?')).toBe(false);
    expect(isOptOutMessage('quanto custa para cancelar a consulta?')).toBe(
      false
    );
    expect(isOptOutMessage('vou parar de fumar')).toBe(false);
  });

  it('does not match ordinary conversation', () => {
    expect(isOptOutMessage('bom dia, gostaria de agendar um horário')).toBe(
      false
    );
    expect(isOptOutMessage('')).toBe(false);
    expect(isOptOutMessage('   ')).toBe(false);
  });
});
