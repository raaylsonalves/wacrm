'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

/**
 * The owner's WhatsApp for billing notices (lib/billing/whatsapp-notify).
 * Kept in the owner's own user metadata (`whatsapp_phone`), the same key
 * the sign-up form fills, so the user edits only their own number.
 */
export function BillingPhone() {
  const t = useTranslations('Settings.billing');
  const [phone, setPhone] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!alive) return;
        const v = data.user?.user_metadata?.whatsapp_phone;
        const s = typeof v === 'string' ? v : '';
        setPhone(s);
        setSaved(s);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    const digits = phone.replace(/\D/g, '');
    if (digits && (digits.length < 10 || digits.length > 15)) {
      toast.error(t('phoneInvalid'));
      return;
    }
    setSaving(true);
    const { error } = await createClient().auth.updateUser({
      data: { whatsapp_phone: phone.trim() },
    });
    setSaving(false);
    if (error) {
      toast.error(t('phoneSaveFailed'));
      return;
    }
    setSaved(phone.trim());
    toast.success(t('phoneSaved'));
  }

  return (
    <div className="border-border space-y-2 rounded-2xl border p-5">
      <Label htmlFor="billing-phone" className="text-foreground">
        {t('phoneLabel')}
      </Label>
      <p className="text-muted-foreground text-sm">{t('phoneHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Input
          id="billing-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="(11) 98765-4321"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="max-w-xs"
        />
        <Button
          variant="outline"
          disabled={saving || phone.trim() === saved}
          onClick={save}
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {t('phoneSave')}
        </Button>
      </div>
    </div>
  );
}
