import { beforeEach, describe, expect, it, vi } from 'vitest';

// The webhook state machine (review 2026-10, phase 1). Mercado Pago and the
// notices are mocked; the database is a small in-memory fake that runs the
// same filters the code chains, plus a JS twin of billing_register_payment
// (migration 122) so the idempotency rules are exercised end to end.

const mp = vi.hoisted(() => ({
  getOrder: vi.fn(),
  getPreapproval: vi.fn(),
  getAuthorizedPayment: vi.fn(),
}));
const notify = vi.hoisted(() => ({ notifyBilling: vi.fn() }));

vi.mock('./mercadopago', () => ({
  MercadoPagoError: class MercadoPagoError extends Error {
    status = 0;
  },
  ...mp,
}));
vi.mock('./notify', () => notify);

import { applyNotification } from './apply';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function fakeDb(tables: Tables, opts: { failRpcOnce?: boolean } = {}) {
  let failRpc = !!opts.failRpcOnce;

  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let patch: Row = {};
    let inserted: Row | null = null;
    let wantRows = true;
    const rows = () => (tables[table] ??= []);
    const run = () => {
      if (op === 'insert') {
        rows().push(inserted as Row);
        return { data: [inserted], error: null };
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op === 'update') hit.forEach((r) => Object.assign(r, patch));
      return { data: wantRows ? hit.map((r) => ({ ...r })) : null, error: null };
    };
    const q = {
      select: () => q,
      update: (p: Row) => ((op = 'update'), (patch = p), (wantRows = false), q),
      insert: (r: Row) => ((op = 'insert'), (inserted = { ...r }), q),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), q),
      order: () => q,
      limit: () => q,
      maybeSingle: async () => {
        wantRows = true;
        const { data } = run();
        return { data: (data as Row[])[0] ?? null, error: null };
      },
      single: async () => {
        wantRows = true;
        const { data } = run();
        return { data: (data as Row[])[0] ?? null, error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        // `.update(...).select(...)` returns the changed rows.
        return Promise.resolve(run()).then(res, rej);
      },
    };
    // `.select()` after an update asks for the rows back.
    const origSelect = q.select;
    q.select = () => {
      if (op === 'update') wantRows = true;
      return origSelect();
    };
    return q;
  }

  return {
    tables,
    from: (t: string) => query(t),
    rpc: async (name: string, a: Row) => {
      if (name !== 'billing_register_payment') throw new Error(name);
      if (failRpc) {
        failRpc = false;
        return { data: null, error: { message: 'timeout' } };
      }
      const payments = (tables.billing_payments ??= []);
      if (payments.some((p) => p.method === a.p_method && p.provider_ref === a.p_provider_ref)) {
        return { data: { inserted: false }, error: null };
      }
      payments.push({ method: a.p_method, provider_ref: a.p_provider_ref, account_id: a.p_account_id });
      const s = (tables.billing_subscriptions ?? []).find((r) => r.account_id === a.p_account_id);
      if (!s) return { data: { inserted: true, subscription: false }, error: null };
      const paidAt = new Date(a.p_paid_at as string);
      const curEnd = s.current_period_end ? new Date(s.current_period_end as string) : null;
      const base = a.p_method === 'card' ? paidAt : curEnd && curEnd > paidAt ? curEnd : paidAt;
      const end = new Date(base);
      end.setUTCMonth(end.getUTCMonth() + 1);
      const charges = (s.charges_paid as number) + 1;
      const done = s.charges_total !== null && charges >= (s.charges_total as number);
      const status = s.status === 'canceled' || done ? 'canceled' : 'active';
      Object.assign(s, { charges_paid: charges, current_period_end: end.toISOString(), status, grace_until: null });
      const acc = (tables.accounts ?? []).find((r) => r.id === a.p_account_id);
      if (acc && acc.subscription_status !== 'exempt') acc.subscription_status = 'active';
      return { data: { inserted: true, subscription: true, period_end: end.toISOString(), done, status }, error: null };
    },
  };
}

const ACC = 'acc-1';
const SUB_ID = '11111111-1111-4111-8111-111111111111';

function baseTables(sub: Row, account: Row = {}): Tables {
  return {
    accounts: [{ id: ACC, subscription_status: 'pending', ...account }],
    billing_subscriptions: [
      {
        id: SUB_ID,
        account_id: ACC,
        method: 'pix',
        status: 'pending',
        amount_cents: 19700,
        charges_paid: 0,
        charges_total: null,
        current_period_end: null,
        grace_until: null,
        mp_preapproval_id: null,
        ...sub,
      },
    ],
    billing_pix_orders: [],
    billing_payments: [],
    billing_events: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Pix order notifications', () => {
  function pixTables(order: Row = {}) {
    const t = baseTables({});
    t.billing_pix_orders.push({
      id: 'o1',
      account_id: ACC,
      external_reference: 'ref-1',
      mp_order_id: 'MP1',
      amount_cents: 19700,
      status: 'pending',
      ...order,
    });
    return t;
  }
  const paidOrder = { id: 'MP1', external_reference: 'ref-1', status: 'processed', total_amount: '197.00' };

  it('credits a paid order once and notifies once', async () => {
    const db = fakeDb(pixTables());
    mp.getOrder.mockResolvedValue(paidOrder);
    expect(await applyNotification(db as never, 'pix', 'order', 'MP1')).toBe('applied');
    expect(await applyNotification(db as never, 'pix', 'order', 'MP1')).toBe('already_applied');
    expect(db.tables.billing_payments).toHaveLength(1);
    expect(db.tables.billing_subscriptions[0].status).toBe('active');
    expect(db.tables.billing_subscriptions[0].charges_paid).toBe(1);
    expect(db.tables.accounts[0].subscription_status).toBe('active');
    expect(notify.notifyBilling).toHaveBeenCalledTimes(1);
  });

  it('a failure halfway is credited on the redelivery (B1)', async () => {
    const db = fakeDb(pixTables(), { failRpcOnce: true });
    mp.getOrder.mockResolvedValue(paidOrder);
    await expect(applyNotification(db as never, 'pix', 'order', 'MP1')).rejects.toBeTruthy();
    // the order row already says paid, but nothing was credited yet
    expect(db.tables.billing_pix_orders[0].status).toBe('paid');
    expect(db.tables.billing_payments).toHaveLength(0);
    expect(await applyNotification(db as never, 'pix', 'order', 'MP1')).toBe('applied');
    expect(db.tables.billing_payments).toHaveLength(1);
    expect(db.tables.accounts[0].subscription_status).toBe('active');
  });

  it('credits a replaced (cancelled) order that was paid anyway (B5)', async () => {
    const db = fakeDb(pixTables({ status: 'canceled' }));
    mp.getOrder.mockResolvedValue(paidOrder);
    expect(await applyNotification(db as never, 'pix', 'order', 'MP1')).toBe('applied');
    expect(db.tables.billing_payments).toHaveLength(1);
  });

  it('rejects an amount that does not match our order', async () => {
    const db = fakeDb(pixTables());
    mp.getOrder.mockResolvedValue({ ...paidOrder, total_amount: '1.00' });
    expect(await applyNotification(db as never, 'pix', 'order', 'MP1')).toBe('amount_mismatch');
    expect(db.tables.billing_payments).toHaveLength(0);
  });

  it('ignores an order that is not ours', async () => {
    const db = fakeDb(pixTables());
    mp.getOrder.mockResolvedValue({ ...paidOrder, external_reference: 'someone-else' });
    expect(await applyNotification(db as never, 'pix', 'order', 'MP1')).toBe('unknown_resource');
  });
});

describe('card notifications', () => {
  const cardSub = { method: 'card', mp_preapproval_id: 'PRE1' };

  it('authorised is not paid: a pending subscription stays pending (B6)', async () => {
    const db = fakeDb(baseTables(cardSub));
    mp.getPreapproval.mockResolvedValue({
      id: 'PRE1',
      status: 'authorized',
      auto_recurring: { transaction_amount: 197 },
      next_payment_date: '2026-11-09T00:00:00Z',
    });
    expect(await applyNotification(db as never, 'subs', 'subscription_preapproval', 'PRE1')).toBe('applied');
    expect(db.tables.billing_subscriptions[0].status).toBe('pending');
    expect(db.tables.accounts[0].subscription_status).toBe('pending');
    expect(db.tables.billing_subscriptions[0].current_period_end).toBe('2026-11-09T00:00:00.000Z');
  });

  it('a processed charge activates, one month from the charge (B8)', async () => {
    const db = fakeDb(baseTables({ ...cardSub, current_period_end: '2026-11-09T00:00:00.000Z' }));
    mp.getAuthorizedPayment.mockResolvedValue({
      id: 99,
      preapproval_id: 'PRE1',
      status: 'processed',
      transaction_amount: 197,
    });
    const before = Date.now();
    expect(
      await applyNotification(db as never, 'subs', 'subscription_authorized_payment', '99')
    ).toBe('applied');
    const end = new Date(db.tables.billing_subscriptions[0].current_period_end as string).getTime();
    // ~1 month after now, not ~1 month after the seeded 2026-11-09
    expect(end - before).toBeLessThan(32 * 86_400_000);
    expect(db.tables.billing_subscriptions[0].status).toBe('active');
    expect(
      await applyNotification(db as never, 'subs', 'subscription_authorized_payment', '99')
    ).toBe('already_applied');
  });

  it('grace starts once, not on every retry (B7), and notifies once', async () => {
    const db = fakeDb(baseTables({ ...cardSub, status: 'active' }, { subscription_status: 'active' }));
    mp.getAuthorizedPayment.mockResolvedValue({ id: 7, preapproval_id: 'PRE1', status: 'recycling' });
    await applyNotification(db as never, 'subs', 'subscription_authorized_payment', '7');
    const grace = db.tables.billing_subscriptions[0].grace_until;
    expect(db.tables.billing_subscriptions[0].status).toBe('past_due');
    expect(db.tables.accounts[0].subscription_status).toBe('past_due');
    await new Promise((r) => setTimeout(r, 5));
    mp.getAuthorizedPayment.mockResolvedValue({ id: 8, preapproval_id: 'PRE1', status: 'recycling' });
    await applyNotification(db as never, 'subs', 'subscription_authorized_payment', '8');
    expect(db.tables.billing_subscriptions[0].grace_until).toBe(grace);
    expect(notify.notifyBilling).toHaveBeenCalledTimes(1);
  });

  it('a decline on a pending subscription opens no grace (B6)', async () => {
    const db = fakeDb(baseTables(cardSub));
    mp.getAuthorizedPayment.mockResolvedValue({ id: 5, preapproval_id: 'PRE1', status: 'rejected' });
    await applyNotification(db as never, 'subs', 'subscription_authorized_payment', '5');
    expect(db.tables.billing_subscriptions[0].status).toBe('pending');
    expect(db.tables.accounts[0].subscription_status).toBe('pending');
  });

  it('a late charge keeps a cancelled subscription cancelled (B9)', async () => {
    const db = fakeDb(
      baseTables({ ...cardSub, status: 'canceled', current_period_end: new Date(Date.now() + 86_400_000).toISOString() }, { subscription_status: 'active' })
    );
    mp.getAuthorizedPayment.mockResolvedValue({ id: 3, preapproval_id: 'PRE1', status: 'processed', transaction_amount: 197 });
    await applyNotification(db as never, 'subs', 'subscription_authorized_payment', '3');
    expect(db.tables.billing_subscriptions[0].status).toBe('canceled');
  });

  it('an unknown preapproval status changes nothing (B12)', async () => {
    const db = fakeDb(baseTables({ ...cardSub, status: 'active' }, { subscription_status: 'active' }));
    mp.getPreapproval.mockResolvedValue({ id: 'PRE1', status: 'finished', auto_recurring: { transaction_amount: 197 } });
    expect(await applyNotification(db as never, 'subs', 'subscription_preapproval', 'PRE1')).toBe('ignored_topic');
    expect(db.tables.billing_subscriptions[0].status).toBe('active');
  });

  it('cancelled with no paid period left closes the account now', async () => {
    const db = fakeDb(baseTables({ ...cardSub, status: 'active' }, { subscription_status: 'active' }));
    mp.getPreapproval.mockResolvedValue({ id: 'PRE1', status: 'cancelled', auto_recurring: { transaction_amount: 197 } });
    await applyNotification(db as never, 'subs', 'subscription_preapproval', 'PRE1');
    expect(db.tables.billing_subscriptions[0].status).toBe('canceled');
    expect(db.tables.accounts[0].subscription_status).toBe('canceled');
  });

  it('never touches an exempt account', async () => {
    const db = fakeDb(baseTables({ ...cardSub, status: 'active' }, { subscription_status: 'exempt' }));
    mp.getAuthorizedPayment.mockResolvedValue({ id: 4, preapproval_id: 'PRE1', status: 'recycling' });
    await applyNotification(db as never, 'subs', 'subscription_authorized_payment', '4');
    expect(db.tables.accounts[0].subscription_status).toBe('exempt');
  });
});
