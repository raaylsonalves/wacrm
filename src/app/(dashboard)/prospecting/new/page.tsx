'use client';

import { RequireRole } from '@/components/auth/require-role';
import { CampaignWizard } from '@/components/prospecting/campaign-wizard';

/** New prospecting campaign — the four-step wizard (admin+, like the API). */
export default function NewProspectingCampaignPage() {
  return (
    <RequireRole min="admin">
      <CampaignWizard />
    </RequireRole>
  );
}
