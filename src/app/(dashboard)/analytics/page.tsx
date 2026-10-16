'use client';

// The service report lives in the Painel's "Atendimento" tab now
// (specs/painel-gestor.md); this route keeps old links working.
import { ServiceReport } from '@/components/analytics/service-report';

export default function AnalyticsPage() {
  return <ServiceReport />;
}
