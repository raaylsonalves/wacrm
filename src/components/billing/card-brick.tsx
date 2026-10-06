'use client';

import { useEffect, useRef, useState } from 'react';

// Mercado Pago's Card Payment Brick: the card form lives in an iframe
// served by Mercado Pago, so the card number never reaches our page or our
// server. We only receive a short-lived token in onSubmit.

interface BrickController {
  unmount: () => void;
}
interface MercadoPagoInstance {
  bricks: () => {
    create: (
      type: 'cardPayment',
      containerId: string,
      settings: unknown
    ) => Promise<BrickController>;
  };
}
declare global {
  interface Window {
    MercadoPago?: new (
      publicKey: string,
      options?: { locale: string }
    ) => MercadoPagoInstance;
  }
}

const SDK_URL = 'https://sdk.mercadopago.com/js/v2';
let sdkPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (window.MercadoPago) return Promise.resolve();
  sdkPromise ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SDK_URL;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      sdkPromise = null;
      reject(new Error('sdk'));
    };
    document.head.appendChild(el);
  });
  return sdkPromise;
}

export interface CardSubmit {
  token: string;
  payerEmail: string | null;
}

export function CardBrick({
  publicKey,
  amount,
  onSubmit,
  onFailed,
}: {
  publicKey: string;
  /** Monthly charge in reais; shown by the brick, never trusted by us. */
  amount: number;
  /** Resolve to close the brick's spinner; reject to let the user retry. */
  onSubmit: (data: CardSubmit) => Promise<void>;
  onFailed: () => void;
}) {
  const [ready, setReady] = useState(false);
  // Latest callbacks, kept in refs so a new closure from the parent never
  // re-mounts the brick (which would wipe what the user typed).
  const submitRef = useRef(onSubmit);
  const failedRef = useRef(onFailed);
  useEffect(() => {
    submitRef.current = onSubmit;
    failedRef.current = onFailed;
  });

  useEffect(() => {
    let controller: BrickController | null = null;
    let cancelled = false;

    (async () => {
      try {
        await loadSdk();
        if (cancelled || !window.MercadoPago) return;
        const mp = new window.MercadoPago(publicKey, { locale: 'pt-BR' });
        controller = await mp.bricks().create('cardPayment', 'card-brick', {
          initialization: { amount },
          customization: {
            paymentMethods: { maxInstallments: 1 },
            visual: { hidePaymentButton: false },
          },
          callbacks: {
            onReady: () => setReady(true),
            onSubmit: (form: {
              token?: string;
              payer?: { email?: string };
            }) => {
              if (!form.token) return Promise.reject();
              return submitRef.current({
                token: form.token,
                payerEmail: form.payer?.email ?? null,
              });
            },
            onError: () => failedRef.current(),
          },
        });
        if (cancelled) controller.unmount();
      } catch {
        failedRef.current();
      }
    })();

    return () => {
      cancelled = true;
      controller?.unmount();
    };
  }, [publicKey, amount]);

  return (
    <div>
      {!ready && (
        <div className="bg-muted h-40 animate-pulse rounded-xl" aria-hidden />
      )}
      <div id="card-brick" />
    </div>
  );
}
