// ------------------------------------------------------------
// Dry run of an automation for one contact — the builder's "Simular".
//
// Nothing here talks to Supabase or Meta: the caller loads the contact's
// facts (row + tag ids) once, and this walks the step tree the way the
// engine would, following each condition into the branch it would take.
// The comparison rules (`conditionHolds`) and the variable rules
// (`interpolateVars`) are the engine's own — engine.ts calls these same
// functions — so a simulation can't drift from what a real run does.
// ------------------------------------------------------------

import type { ConditionStepConfig } from '@/types';

export interface ConditionFacts {
  /** Tag ids on the contact. */
  tagIds: string[];
  /** The contact row (any column a contact_field condition may read). */
  contact: Record<string, unknown> | null;
  /** The inbound message that fired the automation, if any. */
  messageText: string;
  now: Date;
}

/** The engine's condition rules, minus the database reads. */
export function conditionHolds(
  cfg: ConditionStepConfig,
  facts: ConditionFacts
): boolean {
  switch (cfg.subject) {
    case 'tag_presence':
      return !!cfg.operand && facts.tagIds.includes(cfg.operand);
    case 'contact_field': {
      if (!cfg.operand) return false;
      const v = facts.contact?.[cfg.operand];
      return v != null && String(v) === String(cfg.value ?? '');
    }
    case 'message_content':
      return facts.messageText
        .toLowerCase()
        .includes((cfg.value ?? '').toLowerCase());
    case 'time_of_day': {
      // operand "HH:mm-HH:mm"; over-midnight ranges like "18:00-09:00".
      const [from, to] = (cfg.operand ?? '').split('-');
      if (!from || !to) return false;
      const mins = facts.now.getHours() * 60 + facts.now.getMinutes();
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
      };
      const f = parse(from);
      const t = parse(to);
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t;
    }
    default:
      return false;
  }
}

/** `{{ message.text }}` and `{{ vars.x }}`; anything else renders empty. */
export function interpolateVars(
  s: string,
  ctx: { messageText?: string; vars?: Record<string, unknown> }
): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.');
    if (ns === 'message' && prop === 'text')
      return String(ctx.messageText ?? '');
    if (ns === 'vars' && prop) return String(ctx.vars?.[prop] ?? '');
    return '';
  });
}

export interface SimStepInput {
  cid: string;
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes: SimStepInput[]; no: SimStepInput[] };
}

export interface SimResult {
  cid: string;
  step_type: string;
  /** Rendered message text, for send_message. */
  text?: string;
  /** For a condition: which branch the run follows. */
  branch?: 'yes' | 'no';
  /** Nesting depth (0 = top level), for indenting the timeline. */
  depth: number;
}

/**
 * Steps the run would go through, in order. Like the engine, a condition
 * runs only the branch it takes, then the run continues after it.
 */
export function simulate(
  steps: SimStepInput[],
  facts: ConditionFacts,
  depth = 0
): SimResult[] {
  const out: SimResult[] = [];
  for (const step of steps) {
    if (step.step_type === 'condition') {
      const taken = conditionHolds(
        step.step_config as unknown as ConditionStepConfig,
        facts
      );
      const branch = taken ? 'yes' : 'no';
      out.push({ cid: step.cid, step_type: step.step_type, branch, depth });
      out.push(...simulate(step.branches?.[branch] ?? [], facts, depth + 1));
      continue;
    }
    const r: SimResult = { cid: step.cid, step_type: step.step_type, depth };
    if (step.step_type === 'send_message') {
      r.text = interpolateVars(String(step.step_config.text ?? ''), {
        messageText: facts.messageText,
      });
    }
    out.push(r);
  }
  return out;
}
