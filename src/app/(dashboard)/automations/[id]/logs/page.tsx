import { redirect } from 'next/navigation';

// Runs now live inside the builder ("Execuções" tab). Kept as a redirect
// so existing links and bookmarks still land somewhere useful.
export default async function AutomationLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/automations/${id}/edit?tab=runs`);
}
