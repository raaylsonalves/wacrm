'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { isPlanId, PLAN_MONTHLY_BRL, type PlanId } from '@/lib/billing/plans';
import {
  CHANNELS,
  GOALS,
  SEGMENTS,
  TEAM_SIZES,
  TONES,
  VOLUMES,
  sanitizeProfile,
  suggestPlan,
  type BusinessProfile,
} from '@/lib/onboarding/profile';
import { useOnboarding } from '../onboarding-context';
import { StepFooter } from '../step-footer';

/**
 * Optional "about your business" step. Nothing here is required: the
 * answers seed the AI assistant's context (next steps) and drive the plan
 * suggestion below. Chips use the CRM's pastel tone tokens.
 */

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1.5 text-sm transition-colors',
        selected
          ? 'border-tone-lilac bg-tone-lilac-soft text-tone-lilac-ink font-medium'
          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function Question({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div>
        <Label>{label}</Label>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export default function OnboardingProfilePage() {
  const t = useTranslations('Onboarding.profile');
  const router = useRouter();
  const { state, markDone, markSkipped } = useOnboarding();
  const [profile, setProfile] = useState<BusinessProfile>(() =>
    sanitizeProfile(state.profile?.profile)
  );
  const [chosenPlan, setChosenPlan] = useState<PlanId | null>(null);
  const [saving, setSaving] = useState(false);

  // The plan picked on the marketing page travels in the signup metadata.
  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        const p = data.user?.user_metadata?.selected_plan;
        if (isPlanId(p)) setChosenPlan(p);
      });
  }, []);

  const set = <K extends keyof BusinessProfile>(
    key: K,
    value: BusinessProfile[K]
  ) =>
    setProfile((p) => ({
      ...p,
      // Tapping the selected chip again clears the answer.
      [key]: p[key] === value ? undefined : value,
    }));

  const toggleGoal = (g: (typeof GOALS)[number]) =>
    setProfile((p) => {
      const cur = p.goals ?? [];
      const next = cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g];
      return { ...p, goals: next.length ? next : undefined };
    });

  const suggestion = suggestPlan(profile);

  async function handleContinue() {
    setSaving(true);
    try {
      await markDone('profile', { profile: sanitizeProfile(profile) });
      router.push('/onboarding');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleSkip() {
    await markSkipped('profile');
    router.push('/onboarding');
  }

  return (
    <div>
      <div className="bg-tone-lilac-soft text-tone-lilac-ink flex size-10 items-center justify-center rounded-full">
        <Sparkles className="size-5" />
      </div>
      <h1 className="text-foreground mt-4 text-xl font-semibold">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="mt-6 space-y-6">
        <Question label={t('q.segment')}>
          {SEGMENTS.map((s) => (
            <Chip
              key={s}
              selected={profile.segment === s}
              onClick={() => set('segment', s)}
            >
              {t(`segment.${s}`)}
            </Chip>
          ))}
        </Question>

        <Question label={t('q.goals')} hint={t('q.goalsHint')}>
          {GOALS.map((g) => (
            <Chip
              key={g}
              selected={profile.goals?.includes(g) ?? false}
              onClick={() => toggleGoal(g)}
            >
              {t(`goal.${g}`)}
            </Chip>
          ))}
        </Question>

        <Question label={t('q.team')}>
          {TEAM_SIZES.map((s) => (
            <Chip
              key={s}
              selected={profile.team === s}
              onClick={() => set('team', s)}
            >
              {t(`team.${s}`)}
            </Chip>
          ))}
        </Question>

        <Question label={t('q.volume')}>
          {VOLUMES.map((v) => (
            <Chip
              key={v}
              selected={profile.volume === v}
              onClick={() => set('volume', v)}
            >
              {t(`volume.${v}`)}
            </Chip>
          ))}
        </Question>

        <Question label={t('q.channel')}>
          {CHANNELS.map((c) => (
            <Chip
              key={c}
              selected={profile.channel === c}
              onClick={() => set('channel', c)}
            >
              {t(`channel.${c}`)}
            </Chip>
          ))}
        </Question>

        <Question label={t('q.tone')} hint={t('q.toneHint')}>
          {TONES.map((v) => (
            <Chip
              key={v}
              selected={profile.tone === v}
              onClick={() => set('tone', v)}
            >
              {t(`tone.${v}`)}
            </Chip>
          ))}
        </Question>

        <div className="space-y-1.5">
          <Label htmlFor="profile-about">{t('q.about')}</Label>
          <Textarea
            id="profile-about"
            rows={3}
            maxLength={600}
            value={profile.about ?? ''}
            onChange={(e) =>
              setProfile((p) => ({ ...p, about: e.target.value }))
            }
            placeholder={t('aboutPlaceholder')}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="profile-hours">{t('q.hours')}</Label>
          <Textarea
            id="profile-hours"
            rows={2}
            maxLength={300}
            value={profile.hours ?? ''}
            onChange={(e) =>
              setProfile((p) => ({ ...p, hours: e.target.value }))
            }
            placeholder={t('hoursPlaceholder')}
          />
        </div>

        {(suggestion || chosenPlan) && (
          <div
            className="bg-tone-mint-soft text-tone-mint-ink rounded-xl p-4 text-sm"
            role="status"
          >
            {suggestion && (
              <>
                <p className="font-semibold">
                  {suggestion.plan === 'custom'
                    ? t('suggest.custom')
                    : t('suggest.title', {
                        plan: t(`suggest.plan.${suggestion.plan}`),
                        price: PLAN_MONTHLY_BRL[suggestion.plan],
                      })}
                </p>
                {suggestion.reasons.length > 0 && (
                  <p className="mt-1">
                    {suggestion.reasons
                      .map((r) => t(`suggest.why.${r}`))
                      .join(' ')}
                  </p>
                )}
              </>
            )}
            {chosenPlan && (
              <p className={cn(suggestion && 'mt-2', 'opacity-80')}>
                {t('suggest.chosen', {
                  plan: t(`suggest.plan.${chosenPlan}`),
                })}
              </p>
            )}
          </div>
        )}
      </div>

      <StepFooter
        onContinue={handleContinue}
        onSkip={handleSkip}
        continueDisabled={saving}
      />
    </div>
  );
}
